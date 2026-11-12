/**
 * Produce the two single-file UI bundles.
 *
 * WHAT IT DOES, AND WHY IT IS NOT A BUNDLER
 * The iframe shell loads exactly one script per view (`format: "iife"`), and its
 * `connect-src 'none'` forbids loading data at runtime. So:
 *
 *  1. `ui/sdk.js` is concatenated in front of each entry, because two views need
 *     the same ~200 lines of bridge/asset/error plumbing and the shell offers no
 *     way to share them at runtime;
 *  2. `anim/index.json` is inlined into the stage, because `fetch()` is blocked —
 *     this is the difference between a player that starts instantly and one that
 *     cannot start at all;
 *  3. `anim/bounds.json` (measured by `tools/measure-bounds.py`) is projected onto
 *     each inlined clip, because the stage cannot read the WebP pixels back and so
 *     has no other way to know where the pet is drawn;
 *  4. the original click sound is inlined as base64, because the iframe's
 *     `media-src 'none'` rules out `<audio>` and `fetch()` — the only remaining
 *     route to a sample is a WebAudio buffer decoded from memory.
 *
 * No transpiling, no tree shaking, no minification. The source is the artefact;
 * a build step that rewrote it would make the shipped code unreadable to anyone
 * auditing a plugin that can read their API keys.
 *
 * Outputs go to `ui/*.iife.js` inside the plugin package, next to a small
 * `.build.json` recording what was inlined (including content hashes), so
 * `verify.mjs` can prove the bundle matches the files it was built from.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { ANIM_DIR, PLUGIN_DIR, formatBytes, posix } from "./paths.mjs";

const UI_DIR = path.join(PLUGIN_DIR, "ui");
const INDEX_FILE = path.join(ANIM_DIR, "index.json");
const BOUNDS_FILE = path.join(ANIM_DIR, "bounds.json");
/**
 * The original upstream click sample (`PC2005-cloud/dsh-pet`, MIT, taken from
 * `dsh-pet/assets/sound/click-duck.wav`). Re-fetching it is documented by its
 * SHA-256 in `.build.json`; nothing here re-encodes or trims it.
 */
const CLICK_SOUND_FILE = path.join(PLUGIN_DIR, "assets", "sound", "click-duck.wav");
const BOX_FIELDS = ["left", "top", "right", "bottom"];
const FACINGS = new Set([-1, 0, 1]);


/**
 * Entries and what each one needs inlined.
 *
 * Keeping this a table rather than per-file command-line flags means the build's
 * inputs are readable in one place — the same reason the transcode ladder is a
 * constant table.
 */
const ENTRIES = [
	{
		name: "stage",
		source: "stage.js",
		output: "stage.iife.js",
		needsIndex: true,
		// The stage is the only view that draws the pet, so only it needs the
		// measured boxes and the click sample.
		needsBounds: true,
		needsClickSound: true,
	},
	{
		name: "settings",
		source: "settings.js",
		output: "settings.iife.js",
		needsIndex: false,
		needsProbes: false,
	},
];

/** Embed a value as a JS literal that cannot terminate the surrounding script. */
function literal(value) {
	return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function sha256(buffer) {
	return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function readJsonFile(file, label, hint) {
	let text;
	try {
		text = await fs.readFile(file, "utf8");
	} catch {
		throw new Error(`missing ${label}${hint ? ` — ${hint}` : ""}`);
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`${label} 不是合法 JSON：${error.message}`);
	}
}

/**
 * Validate one normalised box.
 *
 * Everything the stage multiplies by a display size has to be inside 0–1 and
 * non-degenerate; a box that is inverted or out of range would silently produce a
 * hit area that never matches, which looks exactly like "clicks stopped working".
 */
function assertBox(box, where) {
	if (!box || typeof box !== "object") throw new Error(`${where} 不是对象`);
	const out = {};
	for (const field of BOX_FIELDS) {
		const value = box[field];
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
			throw new Error(`${where}.${field} 必须是 0–1 的归一化数值，实际 ${JSON.stringify(value)}`);
		}
		out[field] = value;
	}
	if (!(out.left < out.right)) throw new Error(`${where}.left 必须小于 right`);
	if (!(out.top < out.bottom)) throw new Error(`${where}.top 必须小于 bottom`);
	return out;
}

/**
 * Load `anim/bounds.json` and prove it describes exactly the clips in the index.
 *
 * Both directions are checked: a clip without a box would render unclickable, and
 * a box for a clip the index does not know is stale output from an older transcode
 * — in either case the artefact would ship with numbers nobody verified.
 */
async function loadBounds(index) {
	const bounds = await readJsonFile(BOUNDS_FILE, "anim/bounds.json", "run tools/measure-bounds.py first");
	if (bounds.version !== 1) throw new Error(`anim/bounds.json version 应为 1，实际 ${bounds.version}`);
	if (!bounds.clips || typeof bounds.clips !== "object") throw new Error("anim/bounds.json 缺少 clips");
	const known = new Set(index.clips.map((clip) => clip.id));
	const extra = Object.keys(bounds.clips).filter((id) => !known.has(id));
	if (extra.length > 0) {
		throw new Error(
			`anim/bounds.json 含 index 里没有的 clip（重新跑 measure）：${extra.slice(0, 5).join("、")}` +
				(extra.length > 5 ? " …" : ""),
		);
	}
	return {
		alphaThreshold: bounds.alphaThreshold,
		paddingPx: bounds.paddingPx,
		bodyClip: bounds.bodyClip,
		bodyBounds: assertBox(bounds.bodyBounds, "anim/bounds.json bodyBounds"),
		clips: bounds.clips,
	};
}

/** Project the measured boxes onto the fields the stage actually reads. */
function projectClips(index, bounds) {
	return index.clips.map((clip) => {
		const measured = bounds.clips[clip.id];
		if (!measured) {
			throw new Error(`anim/bounds.json 缺少「${clip.id}」的边界 — 重跑 tools/measure-bounds.py`);
		}
		if (!FACINGS.has(measured.sourceFacing)) {
			throw new Error(`anim/bounds.json「${clip.id}」的 sourceFacing 必须是 -1/0/1，实际 ${measured.sourceFacing}`);
		}
		return {
			id: clip.id,
			// The numeric clip index is how the UI asks its backend for bytes, so it
			// must survive this projection — dropping it makes every `pet-clip` call
			// carry `index: undefined`, which the bridge rejects as non-JSON.
			index: clip.index,
			file: clip.file,
			group: clip.group,
			mode: clip.mode,
			durationMs: clip.durationMs,
			width: clip.width,
			height: clip.height,
			noMirror: clip.noMirror || undefined,
			bounds: assertBox(measured.bounds, `anim/bounds.json clips["${clip.id}"].bounds`),
			sourceFacing: measured.sourceFacing,
		};
	});
}

/**
 * Read the click sample as base64 for inlining.
 *
 * Only a WAV passes: WebAudio's `decodeAudioData` is the sole playback route here,
 * and a mislabelled or truncated file would fail at click time in a user's session
 * rather than at build time in this one.
 */
async function loadClickSound() {
	let bytes;
	try {
		bytes = await fs.readFile(CLICK_SOUND_FILE);
	} catch {
		throw new Error("missing assets/sound/click-duck.wav — 恢复原版点击音效后再构建");
	}
	if (bytes.length <= 44 || bytes.subarray(0, 4).toString("latin1") !== "RIFF" || bytes.subarray(8, 12).toString("latin1") !== "WAVE") {
		throw new Error("assets/sound/click-duck.wav 不是 WAV（RIFF/WAVE）");
	}
	return { bytes, base64: bytes.toString("base64"), sha256: sha256(bytes) };
}

/**
 * Last-resort failure painter.
 *
 * Everything else in this plugin reports failures *from inside* its own boot, which
 * assumes boot gets that far. A syntax error, a missing inlined constant or a throw
 * at module scope would leave the iframe blank with nothing anywhere — no bootstrap
 * handler, no stderr line, no panel text. Since the iframe is an opaque origin the
 * user cannot open a console in, that state is indistinguishable from "the plugin
 * was never enabled".
 *
 * So the entry is wrapped: an `error` listener is installed first, the real body
 * runs second, and either failure draws an inline-styled message that cannot itself
 * depend on the stylesheet.
 */
const GUARD_PRELUDE = `
const __petFatal = (label, error) => {
  try {
    const text = "桌宠启动失败（" + label + "）\\n\\n" + String(error && (error.stack || error.message) || error).slice(0, 2000);
    let node = document.getElementById("pet-fatal-report");
    if (!node) {
      node = document.createElement("pre");
      node.id = "pet-fatal-report";
      node.style.cssText = "position:fixed;left:8px;right:8px;bottom:8px;max-height:45%;overflow:auto;z-index:2147483647;margin:0;padding:10px 12px;white-space:pre-wrap;font:11px/1.5 ui-monospace,Consolas,monospace;color:#ffd7d7;background:rgba(24,12,14,.95);border:1px solid #b03040;border-radius:8px";
      document.body.appendChild(node);
    }
    node.textContent = text;
  } catch {}
  try { globalThis.narrafork?.commands?.execute?.("pet-log", { level: "error", message: "fatal: " + label, detail: { error: String(error && (error.stack || error.message) || error).slice(0, 2000) } }); } catch {}
};
window.addEventListener("error", (event) => __petFatal("未捕获异常", event.error || event.message));
window.addEventListener("unhandledrejection", (event) => __petFatal("未处理的 Promise", event.reason));
`;

async function main() {
	const sdk = await fs.readFile(path.join(UI_DIR, "sdk.js"), "utf8");
	const moduleFiles = ["bubbles.js", "task-events.js"];
	const modules = await Promise.all(moduleFiles.map((file) => fs.readFile(path.join(UI_DIR, file), "utf8")));
	const presetsText = await fs.readFile(path.join(UI_DIR, "bubble-presets.json"), "utf8");
	const presets = JSON.parse(presetsText);
	const audit = JSON.parse(await fs.readFile(path.join(PLUGIN_DIR, "tools", "bubble-source-audit.json"), "utf8"));
	const counts = { defaultRecords: presets.random.length, uniqueDefaultTexts: new Set(presets.random.map((entry) => entry.text)).size,
		defaultWeightSum: presets.random.reduce((sum, entry) => sum + entry.weight, 0), historySupplement: presets.history.length,
		systemTemplates: presets.templates.length, excluded: presets.excluded.length };
	if (presets.source?.commit !== audit.commit || JSON.stringify(counts) !== JSON.stringify(audit.counts) ||
		sha256(JSON.stringify(presets.random)) !== audit.randomSha256 || sha256(JSON.stringify(presets.geometry)) !== audit.geometrySha256) {
		throw new Error("气泡默认文案/样式/几何与固定来源清单不一致");
	}
	const bubbleCss = await fs.readFile(path.join(UI_DIR, "bubbles.css"), "utf8");
	const inputFiles = ["sdk.js", ...moduleFiles, "bubble-presets.json", "bubbles.css", "stage.js", "settings.js", "stage.css", "settings.css"];
	const inputs = Object.fromEntries(await Promise.all(inputFiles.map(async (file) => ["ui/" + file, sha256(await fs.readFile(path.join(UI_DIR, file)))])));

	let index;
	try {
		index = JSON.parse(await fs.readFile(INDEX_FILE, "utf8"));
	} catch {
		throw new Error("missing anim/index.json — run tools/transcode.mjs and tools/build-index.mjs first");
	}
	const bounds = await loadBounds(index);
	const clickSound = await loadClickSound();

	for (const entry of ENTRIES) {
		const body = await fs.readFile(path.join(UI_DIR, entry.source), "utf8");
		const injected = [`const __PET_BUBBLE_PRESETS__ = ${literal(presets)};`];
		if (entry.needsIndex) {
			// Strip the fields the stage never reads: byte counts and per-clip sources
			// are build-report data, and every kilobyte here is inlined into a script
			// the panel parses on open. What is added back — `bounds` and
			// `sourceFacing` — is not report data: the stage cannot start without it.
			const slim = {
				...index,
				clips: projectClips(index, bounds),
				bodyBounds: bounds.bodyBounds,
			};
			injected.push(`const PET_ANIM_INDEX = ${literal(slim)};`);
		}
		if (entry.needsClickSound) {
			// One sample, ~40 KiB of base64. Inlined rather than fetched because the
			// iframe forbids both `fetch()` and `<audio>`, and a click sound that
			// arrives a network round-trip late is worse than none.
			injected.push(`const PET_CLICK_SOUND_BASE64 = ${literal(clickSound.base64)};`);
		}

		const bundle = [
			`/* ${entry.output} — generated by tools/build-ui.mjs from ui/${entry.source} + ui/sdk.js. Do not edit. */`,
			"(() => {",
			'"use strict";',
			GUARD_PRELUDE,
			...injected,
			"try {",
			sdk,
			...modules,
			body,
			'} catch (error) { __petFatal("初始化", error); }',
			"})();",
			"",
		].join("\n");

		new vm.Script(bundle, { filename: `ui/${entry.output}` });
		const outputPath = path.join(UI_DIR, entry.output);
		await fs.writeFile(outputPath, bundle, "utf8");
		const css = await fs.readFile(path.join(UI_DIR, `${entry.name}.css`), "utf8");
		await fs.writeFile(path.join(UI_DIR, `${entry.name}.bundle.css`), `${css}\n${bubbleCss}`, "utf8");
		process.stderr.write(
			`[build-ui] ui/${entry.output} ${formatBytes(Buffer.byteLength(bundle))}` +
				`${entry.needsIndex ? ` (index: ${index.clipCount} clips, bounds: ${index.clipCount})` : ""}` +
				`${entry.needsClickSound ? ` (click sound: ${formatBytes(clickSound.bytes.length)})` : ""}\n`,
		);
	}

	await fs.writeFile(
		path.join(UI_DIR, ".build.json"),
		`${JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				inputs,
				bubblePresets: { sha256: sha256(presetsText), source: presets.source, counts: presets.counts },
				modules: moduleFiles,
				indexGeneratedAt: index.generatedAt,
				profile: index.profile,
				clipCount: index.clipCount,
				// Hashes let `verify.mjs` prove the bundle was built from the files
				// currently on disk instead of trusting timestamps.
				bounds: {
					file: "anim/bounds.json",
					sha256: sha256(await fs.readFile(BOUNDS_FILE)),
					alphaThreshold: bounds.alphaThreshold,
					paddingPx: bounds.paddingPx,
					bodyClip: bounds.bodyClip,
					bodyBounds: bounds.bodyBounds,
					clipCount: Object.keys(bounds.clips).length,
				},
				clickSound: {
					file: "assets/sound/click-duck.wav",
					bytes: clickSound.bytes.length,
					sha256: clickSound.sha256,
					base64Length: clickSound.base64.length,
				},
				entries: ENTRIES.map((entry) => ({
					output: posix(path.join("ui", entry.output)),
					source: posix(path.join("ui", entry.source)),
				})),
			},
			null,
			"\t",
		)}\n`,
		"utf8",
	);
}

await main();
