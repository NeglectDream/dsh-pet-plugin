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
 *  3. the click sound is inlined as base64, because `media-src 'none'` rules out
 *     `<audio>` and the asset route cannot serve `.wav` with a usable MIME type.
 *
 * No transpiling, no tree shaking, no minification. The source is the artefact;
 * a build step that rewrote it would make the shipped code unreadable to anyone
 * auditing a plugin that can read their API keys.
 *
 * Outputs go to `ui/*.iife.js` inside the plugin package, next to a small
 * `.build.json` recording what was inlined, so `verify.mjs` can prove the bundle
 * matches the index it was built from.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ANIM_DIR, ASSETS_DIR, PLUGIN_DIR, formatBytes, posix } from "./paths.mjs";

const UI_DIR = path.join(PLUGIN_DIR, "ui");
const INDEX_FILE = path.join(ANIM_DIR, "index.json");
const SOUND_FILE = path.join(ASSETS_DIR, "sound", "click-duck.wav");

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
		needsSound: true,
	},
	{
		name: "settings",
		source: "settings.js",
		output: "settings.iife.js",
		needsIndex: false,
		needsSound: false,
		needsProbes: false,
	},
];

/** Embed a value as a JS literal that cannot terminate the surrounding script. */
function literal(value) {
	return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
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

	let index;
	try {
		index = JSON.parse(await fs.readFile(INDEX_FILE, "utf8"));
	} catch {
		throw new Error("missing anim/index.json — run tools/transcode.mjs and tools/build-index.mjs first");
	}

	let soundBase64 = "";
	try {
		soundBase64 = (await fs.readFile(SOUND_FILE)).toString("base64");
	} catch {
		process.stderr.write("[build-ui] 注意：找不到点击音效，舞台将静音\n");
	}

	for (const entry of ENTRIES) {
		const body = await fs.readFile(path.join(UI_DIR, entry.source), "utf8");
		const injected = [];
		if (entry.needsIndex) {
			// Strip the fields the stage never reads: byte counts and per-clip sources
			// are build-report data, and every kilobyte here is inlined into a script
			// the panel parses on open.
			const slim = {
				...index,
			clips: index.clips.map((clip) => ({
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
			})),

			};
			injected.push(`const PET_ANIM_INDEX = ${literal(slim)};`);
		}
		if (entry.needsSound) {
			injected.push(`const PET_SOUND_CLICK = ${literal(soundBase64)};`);
		}

		const bundle = [
			`/* ${entry.output} — generated by tools/build-ui.mjs from ui/${entry.source} + ui/sdk.js. Do not edit. */`,
			"(() => {",
			'"use strict";',
			GUARD_PRELUDE,
			...injected,
			"try {",
			sdk,
			body,
			'} catch (error) { __petFatal("初始化", error); }',
			"})();",
			"",
		].join("\n");

		const outputPath = path.join(UI_DIR, entry.output);
		await fs.writeFile(outputPath, bundle, "utf8");
		process.stderr.write(
			`[build-ui] ui/${entry.output} ${formatBytes(Buffer.byteLength(bundle))}` +
				`${entry.needsIndex ? ` (index: ${index.clipCount} clips)` : ""}\n`,
		);
	}

	await fs.writeFile(
		path.join(UI_DIR, ".build.json"),
		`${JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				indexGeneratedAt: index.generatedAt,
				profile: index.profile,
				clipCount: index.clipCount,
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
