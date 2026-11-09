/**
 * Compile `anim/index.json`: what the stage needs to know about each clip.
 *
 * WHY THE GROUPING IS DERIVED AND NOT HAND-WRITTEN
 * The 114 clips are already catalogued in `dsh-pet/assets/config.jsonc` — which
 * clip is the idle loop, which five respond to a click, the per-category weights
 * of the random chain, the six balance tiers in order, the three-part sleep
 * suite, the five `baifan` beats. Re-typing that by hand into a second file
 * would create two catalogues that disagree the first time a clip is added, so
 * this tool *reads the original* and fails loudly if a clip referenced there has
 * no transcoded output.
 *
 * The reverse check matters just as much: a transcoded clip that appears in no
 * pool would ship as dead weight. Both directions are asserted below.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ANIM_DIR, ASSETS_DIR, PLUGIN_DIR, formatBytes, posix } from "./paths.mjs";

const CONFIG_FILE = path.join(ASSETS_DIR, "config.jsonc");
const OUTPUT_FILE = path.join(ANIM_DIR, "index.json");

/**
 * Category ids in `config.jsonc` are Chinese and its weights are on the category.
 * The stage only needs ASCII keys (they are the names in `animationGroups`), so
 * the mapping is explicit — an unknown category is a build error rather than a
 * silently unplayable pool.
 */
const CATEGORY_GROUPS = {
	小动作: "small",
	玩耍: "play",
	吃什么: "eat",
	时节: "season",
	文字: "text",
};

/**
 * Strip `//` and `/* *\/` comments from JSONC.
 *
 * Hand-written rather than regex-based because the file contains `https://…`
 * inside string values: a regex pass would truncate those lines and produce JSON
 * that parses into something subtly wrong instead of failing.
 */
export function stripJsonc(text) {
	let out = "";
	let index = 0;
	let inString = false;
	let quote = "";
	while (index < text.length) {
		const character = text[index];
		const next = text[index + 1];
		if (inString) {
			out += character;
			if (character === "\\") {
				out += next ?? "";
				index += 2;
				continue;
			}
			if (character === quote) inString = false;
			index += 1;
			continue;
		}
		if (character === '"' || character === "'") {
			inString = true;
			quote = character;
			out += character;
			index += 1;
			continue;
		}
		if (character === "/" && next === "/") {
			while (index < text.length && text[index] !== "\n") index += 1;
			continue;
		}
		if (character === "/" && next === "*") {
			index += 2;
			while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
			index += 2;
			continue;
		}
		out += character;
		index += 1;
	}
	return out;
}

async function readJson(file) {
	return JSON.parse(await fs.readFile(file, "utf8"));
}

async function main() {
	let files;
	try {
		files = await readJson(path.join(ANIM_DIR, "files.json"));
	} catch {
		throw new Error("missing anim/files.json — run tools/transcode.mjs first");
	}
	const config = JSON.parse(stripJsonc(await fs.readFile(CONFIG_FILE, "utf8")));
	const animations = config.animations ?? {};

	/** id → transcoded file record, built from the transcode report. */
	const byId = new Map();
	for (const record of files.files) {
		if (byId.has(record.id)) throw new Error(`duplicate clip id: ${record.id}`);
		byId.set(record.id, record);
	}

	/** Clips referenced by `config.jsonc`, with the role each one plays. */
	const roles = new Map();
	const assign = (id, role) => {
		if (roles.has(id)) return; // a clip may appear in two pools; the first wins
		roles.set(id, role);
	};
	const mustGet = (id, where) => {
		if (!byId.has(id)) {
			throw new Error(`config.jsonc 引用的动画 ${id} 没有转码产物（${where}）`);
		}
		return byId.get(id);
	};

	const groupsDefinition = [];
	const pushGroup = (group, ids, mode, options = {}) => {
		const clipIds = [];
		for (const id of ids ?? []) {
			mustGet(id, `animations.${group}`);
			assign(id, group);
			clipIds.push(id);
		}
		groupsDefinition.push({ group, mode, clipIds, ...options });
		return clipIds;
	};

	const idleIds = pushGroup("idle", animations.idle, "loop");
	const turnIds = pushGroup("turn", animations.turn, "once");
	const dragIds = pushGroup("drag", animations.drag, "loop");
	const clickIds = pushGroup("click", animations.clicks, "once");

	const moveActions = animations.moves?.actions ?? [];
	const moveIds = [];
	const moveParams = {};
	for (const action of moveActions) {
		mustGet(action.name, "animations.moves");
		assign(action.name, "move");
		moveIds.push(action.name);
		if (action.params) moveParams[action.name] = action.params;
	}
	groupsDefinition.push({ group: "move", mode: "once", clipIds: moveIds, travel: true });

	const categories = [];
	for (const category of animations.categories ?? []) {
		const group = CATEGORY_GROUPS[category.id];
		if (!group) {
			throw new Error(
				`config.jsonc 新增了未分类的动作分类「${category.id}」，请在 build-index.mjs 的 CATEGORY_GROUPS 里登记`,
			);
		}
		const clipIds = [];
		for (const id of category.actions ?? []) {
			mustGet(id, `animations.categories.${category.id}`);
			assign(id, group);
			clipIds.push(id);
		}
		categories.push({ group, label: category.id, weight: category.weight ?? 0, clipIds });
		groupsDefinition.push({ group, mode: "once", clipIds, noMirror: category.noMirror === true });
	}

	// Event pools: not part of the random chain, only played when code asks for them.
	const balanceTiers = [];
	for (const id of animations.events?.balance ?? []) {
		mustGet(id, "animations.events.balance");
		assign(id, "balance");
		balanceTiers.push(id);
	}
	const whisperIds = [];
	for (const id of animations.events?.whisper ?? []) {
		mustGet(id, "animations.events.whisper");
		assign(id, "whisper");
		whisperIds.push(id);
	}
	const workStatusIds = [];
	for (const id of animations.events?.workStatus ?? []) {
		mustGet(id, "animations.events.workStatus");
		assign(id, "work");
		workStatusIds.push(id);
	}
	const baifanIds = [];
	for (const id of animations.baifan ?? []) {
		mustGet(id, "animations.baifan");
		assign(id, "baifan");
		baifanIds.push(id);
	}

	const sleepSuites = (animations.sleep ?? []).map((suite, suiteIndex) => {
		const resolved = {};
		for (const phase of ["start", "loop", "end"]) {
			resolved[phase] = (suite[phase] ?? []).map((id) => {
				mustGet(id, `animations.sleep[${suiteIndex}].${phase}`);
				assign(id, `sleep-${phase}`);
				return id;
			});
		}
		return resolved;
	});

	const unassigned = [...byId.keys()].filter((id) => !roles.has(id));
	if (unassigned.length > 0) {
		throw new Error(
			`${unassigned.length} 段转码产物没有被 config.jsonc 引用（会变成装进包里却永不播放的负担）：` +
				unassigned.slice(0, 8).join("、") +
				(unassigned.length > 8 ? " …" : ""),
		);
	}

	/**
	 * Per-clip weight inside its pool.
	 *
	 * A category's configured weight is split evenly across its clips so that
	 * adding a clip to a category does not silently change how often that category
	 * appears relative to the others.
	 */
	const clips = [];
	for (const [id, role] of roles) {
		const record = byId.get(id);
		const definition = groupsDefinition.find((item) => item.group === role);
		const weight =
			definition && definition.clipIds.length > 0 ? 1 / definition.clipIds.length : 1 / (idleIds.length || 1);
		clips.push({
			id,
			file: record.file,
			// The numeric source index, which is also the asset file's basename. The UI
			// fetches clip bytes by this number through its own backend command (see
			// `ui/stage.js`), so the mapping has to be carried explicitly instead of
			// parsed back out of `file`.
			index: record.index,
			group: role,
			mode: definition?.mode === "loop" ? "loop" : "once",
			weight: Number(weight.toFixed(5)),
			durationMs: record.durationMs,
			frames: record.frames,
			width: record.width,
			height: record.height,
			sourceDurationMs: record.sourceDurationMs,
			bytes: record.bytes,
			noMirror: definition?.noMirror === true,
		});
	}
	clips.sort((a, b) => byId.get(a.id).index - byId.get(b.id).index);

	const weights = config.animationWeights ?? {};
	const chain = {
		idle: weights.idle ?? 10,
		turn: weights.turn ?? 5,
		move: weights.move ?? 5,
		categories: categories.map(({ group, label, weight }) => ({ group, label, weight })),
	};
	const chainTotal =
		chain.idle + chain.turn + chain.move + chain.categories.reduce((sum, item) => sum + item.weight, 0);
	if (Math.abs(chainTotal - 100) > 0.5) {
		process.stderr.write(
			`[build-index] 注意：动作链权重合计 ${chainTotal}（config.jsonc 注释要求 100）\n`,
		);
	}

	const index = {
		version: 1,
		generatedAt: new Date().toISOString(),
		profile: files.profile,
		settings: files.settings,
		canvas: { width: clips[0]?.width ?? 384, height: clips[0]?.height ?? 216 },
		clipCount: clips.length,
		totalBytes: clips.reduce((sum, clip) => sum + clip.bytes, 0),
		clips,
		pools: {
			idle: idleIds,
			turn: turnIds,
			drag: dragIds,
			click: clickIds,
			move: moveIds,
			balance: balanceTiers,
			whisper: whisperIds,
			work: workStatusIds,
			baifan: baifanIds,
			sleep: sleepSuites,
			categories: categories.map(({ group, label, weight, clipIds }) => ({
				group,
				label,
				weight,
				clipIds,
			})),
		},
		moveDefaults: animations.moves?.default ?? {
			minDist: 60,
			maxDist: 240,
			margin: 20,
			leadSec: 2,
			tailSec: 2,
		},
		moveParams,
		chain,
	};

	// A clip's WebP duration must match `frames / fps` from the resolved profile; a
	// mismatch means the encoder dropped or duplicated frames and the player's
	// timers would drift against the actual animation.
	const fps = files.settings?.fps ?? 10;
	const drifted = clips.filter(
		(clip) => Math.abs(clip.durationMs - (clip.frames / fps) * 1000) > 1000 / fps + 1,
	);
	if (drifted.length > 0) {
		process.stderr.write(
			`[build-index] 注意：${drifted.length} 段时长与帧数不符：${drifted
				.slice(0, 5)
				.map((clip) => `${clip.id} ${clip.durationMs}ms/${clip.frames}f`)
				.join("、")}\n`,
		);
	}

	await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(index, null, "\t")}\n`, "utf8");
	process.stderr.write(
		`[build-index] ${clips.length} clips, ${formatBytes(index.totalBytes)}, ` +
			`pools: idle ${idleIds.length} turn ${turnIds.length} drag ${dragIds.length} click ${clickIds.length} ` +
			`move ${moveIds.length} categories ${categories.length} balance ${balanceTiers.length} ` +
			`sleep ${sleepSuites.length} baifan ${baifanIds.length}\n`,
	);
}

await main();
