/**
 * Static verification of the plugin package.
 *
 * WHY RE-IMPLEMENT THE MANIFEST RULES
 * The host validates a manifest on install (`server/lib/plugins/manifest.ts`) and
 * refuses the whole package on the first violation — with a message in a UI the
 * author is not looking at. Re-stating the rules here turns "installation failed"
 * into a local, itemised report *before* an archive exists. The rules below were
 * transcribed from that schema; where they diverge the host wins, which is what
 * the end-to-end install in the release checklist is for.
 *
 * It also checks the things the host cannot: that every file a manifest names is
 * actually in the package, that the animation index agrees with the WebP bytes on
 * disk, and that no credential-shaped string was baked into a shipped file.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ANIM_DIR, DIST_DIR, PLUGIN_DIR, REPO_DIR, formatBytes, posix } from "./paths.mjs";
import { readAnimatedWebpInfo, readFrameDurations } from "./webp.mjs";

const failures = [];
const warnings = [];
const notes = [];

function fail(message) {
	failures.push(message);
}
function warn(message) {
	warnings.push(message);
}

/* -------------------------------------------------------------------------- */
/* Patterns transcribed from the host manifest schema                         */
/* -------------------------------------------------------------------------- */

const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const CONTRIBUTION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SEMVER_PATTERN =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ACTIVATION_EVENT_PATTERN = /^(onStartup|onCommand|onView|onProvider|onTool|onEvent|onSchedule)(?::(.+))?$/;
const CAPABILITY_PATTERN = /^(?:\*|[a-zA-Z][a-zA-Z0-9_]*(?:\.(?:\*|[a-zA-Z][a-zA-Z0-9_]*))*)$/;

const VIEW_SURFACES = ["workspace", "director", "focus", "settings", "provider-settings", "overlay"];
const INSTANCE_MODES = ["singleton", "singleton-per-workspace", "singleton-per-narrator", "multiple"];
const VIEW_SCOPES = ["workspace", "narrator", "project", "global"];
const DEFAULT_POSITIONS = ["main", "side", "bottom", "director"];
/**
 * Which view scopes each surface's panel picker will actually list.
 *
 * Transcribed from `SURFACE_ALLOWED_SCOPES` in
 * `frontend/components/plugins/PluginContributionPicker.tsx`. A mismatch does not
 * fail the install — the plugin enables and runs, and the view is simply absent
 * from the surface's add-panel list, which reads as "the plugin does nothing".
 */
const SURFACE_ALLOWED_SCOPES = {
	focus: ["global", "narrator"],
	workspace: ["global", "workspace"],
	director: ["global", "workspace"],
	settings: ["global"],
	"provider-settings": ["global"],
	overlay: ["global"],
};
const RUNTIMES = ["bun", "node", "python", "binary"];
const OS = ["linux", "darwin", "win32"];
const ARCH = ["x64", "arm64", "ia32"];
const SECRET_SCOPES = ["user", "workspace", "project"];
const SECRET_USAGES = ["outbound-network", "provider", "command", "other"];
const SECRET_INJECTS = ["ephemeral-reference", "rpc-opaque-reference"];

/** Top-level keys the schema accepts. `z.strict()` means an extra key is fatal. */
const MANIFEST_KEYS = new Set([
	"schemaVersion",
	"pluginId",
	"version",
	"displayName",
	"description",
	"publisher",
	"license",
	"engine",
	"server",
	"ui",
	"activationEvents",
	"contributes",
	"configuration",
	"permissions",
	"secrets",
	"dependencies",
]);

/** `contributes` keys, likewise. */
const CONTRIBUTES_KEYS = new Set([
	"providers",
	"searchProviders",
	"tools",
	"commands",
	"events",
	"views",
	"themes",
	"configuration",
]);

/** Package-relative path rules from `manifestPathSchema`. */
function checkPath(value, where) {
	if (typeof value !== "string" || value.length === 0) {
		fail(`${where}: 路径必须是非空字符串`);
		return false;
	}
	if (value.length > 4096) fail(`${where}: 路径过长`);
	if (/[\u0000-\u001f\u007f]/.test(value)) fail(`${where}: 路径包含控制字符`);
	if (value.includes("\\")) fail(`${where}: 路径必须用 / 分隔`);
	if (value.startsWith("/")) fail(`${where}: 不允许绝对路径`);
	if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) fail(`${where}: 不允许 Windows 绝对路径`);
	if (value.split("/").some((segment) => segment === ".." || segment === ".")) fail(`${where}: 不允许路径穿越`);
	if (/[?#]/.test(value)) fail(`${where}: 路径不能带查询串或片段`);
	if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(value)) fail(`${where}: 不允许 URL scheme`);
	if (value.startsWith("//")) fail(`${where}: 不允许网络路径`);
	return true;
}

function checkContributionId(value, where) {
	if (typeof value !== "string" || !CONTRIBUTION_ID_PATTERN.test(value)) {
		fail(`${where}: 贡献 id 非法（${JSON.stringify(value)}）`);
	}
}

/* -------------------------------------------------------------------------- */
/* Manifest                                                                   */
/* -------------------------------------------------------------------------- */

function verifyManifest(manifest) {
	for (const key of Object.keys(manifest)) {
		if (!MANIFEST_KEYS.has(key)) fail(`manifest: 未知顶层字段 ${key}（schema 是 strict 的，会导致安装失败）`);
	}

	if (manifest.schemaVersion !== 1) fail(`manifest.schemaVersion 必须是 1，实际 ${JSON.stringify(manifest.schemaVersion)}`);
	if (!PLUGIN_ID_PATTERN.test(manifest.pluginId ?? "")) fail(`manifest.pluginId 非法：${manifest.pluginId}`);
	if (!SEMVER_PATTERN.test(manifest.version ?? "")) fail(`manifest.version 不是 SemVer：${manifest.version}`);
	if (typeof manifest.displayName !== "string" || manifest.displayName.length === 0) fail("manifest.displayName 缺失");
	if (manifest.description !== undefined && manifest.description.length > 4000) fail("manifest.description 超过 4000 字符");

	const engine = manifest.engine ?? {};
	if (!RUNTIMES.includes(engine.runtime)) fail(`engine.runtime 非法：${engine.runtime}`);
	if (typeof engine.hostApi !== "string" || engine.hostApi.length === 0) fail("engine.hostApi 缺失");
	if (engine.rpc !== "narrafork.rpc/1") fail(`engine.rpc 必须是 narrafork.rpc/1，实际 ${engine.rpc}`);
	for (const value of engine.os ?? []) if (!OS.includes(value)) fail(`engine.os 含非法值 ${value}`);
	for (const value of engine.arch ?? []) if (!ARCH.includes(value)) fail(`engine.arch 含非法值 ${value}`);

	if (manifest.server) {
		const server = manifest.server;
		checkPath(server.entry, "server.entry");
		if (server.transport !== undefined && server.transport !== "stdio") fail("server.transport 必须是 stdio");
		if (server.protocol !== "narrafork.rpc/1") fail("server.protocol 必须是 narrafork.rpc/1");
		if (!["package", "pluginData", "pluginTemp"].includes(server.workingDirectory ?? "package")) {
			fail(`server.workingDirectory 非法：${server.workingDirectory}`);
		}
		for (const argument of server.args ?? []) {
			if (typeof argument !== "string" || argument.length > 1024) fail("server.args 只接受 ≤1024 字符的字符串");
		}
	}

	if (manifest.ui) {
		checkPath(manifest.ui.entry, "ui.entry");
		if (manifest.ui.style !== undefined) checkPath(manifest.ui.style, "ui.style");
		if (manifest.ui.format !== undefined && manifest.ui.format !== "iife") {
			fail(`ui.format 只支持 iife，实际 ${manifest.ui.format}`);
		}
	}

	const contributes = manifest.contributes ?? {};
	for (const key of Object.keys(contributes)) {
		if (!CONTRIBUTES_KEYS.has(key)) fail(`contributes: 未知字段 ${key}（strict）`);
	}

	const contributions = {
		providers: contributes.providers ?? [],
		searchProviders: contributes.searchProviders ?? [],
		tools: contributes.tools ?? [],
		commands: contributes.commands ?? [],
		events: contributes.events ?? [],
		views: contributes.views ?? [],
		themes: contributes.themes ?? [],
	};
	const byKind = new Map();
	for (const [kind, list] of Object.entries(contributions)) {
		const ids = new Set();
		for (const item of list) {
			checkContributionId(item?.id, `contributes.${kind}[].id`);
			if (ids.has(item?.id)) fail(`contributes.${kind}: 重复的 id ${item.id}`);
			ids.add(item?.id);
		}
		byKind.set(kind, ids);
	}

	for (const [index, command] of contributions.commands.entries()) {
		const where = `contributes.commands[${index}]`;
		if (typeof command.title !== "string" || command.title.length === 0) fail(`${where}: title 缺失`);
		if (!["server", "ui"].includes(command.handler)) fail(`${where}: handler 必须是 server 或 ui`);
		if (command.inputSchema !== undefined && (typeof command.inputSchema !== "object" || Array.isArray(command.inputSchema))) {
			fail(`${where}: inputSchema 必须是对象`);
		}
		if (command.when !== undefined && !/^[A-Za-z][A-Za-z0-9._-]*(?:\s*(?:==|!=)\s*[A-Za-z0-9._-]+)?$/.test(command.when)) {
			fail(`${where}: when 表达式非法`);
		}
		if (command.handler === "server" && !manifest.server) {
			fail(`${where}: handler 为 server 但 manifest 没有 server`);
		}
	}

	for (const [index, view] of contributions.views.entries()) {
		const where = `contributes.views[${index}]`;
		if (typeof view.title !== "string" || view.title.length === 0) fail(`${where}: title 缺失`);
		checkPath(view.entry, `${where}.entry`);
		if (view.style !== undefined) checkPath(view.style, `${where}.style`);
		if (!Array.isArray(view.surfaces) || view.surfaces.length === 0) fail(`${where}: surfaces 必须是非空数组`);
		for (const surface of view.surfaces ?? []) {
			if (!VIEW_SURFACES.includes(surface)) fail(`${where}: 未知 surface ${surface}`);
			// The host's panel picker filters views by `SURFACE_ALLOWED_SCOPES`
			// (`PluginContributionPicker.tsx`), so a view whose scope is not allowed on
			// one of its own declared surfaces simply never appears in that surface's
			// list — the plugin looks installed and enabled while offering nothing to
			// open. Nothing in the manifest schema rejects this combination, so it is
			// checked here.
			const allowed = SURFACE_ALLOWED_SCOPES[surface];
			if (allowed && !allowed.includes(view.scope)) {
				fail(
					`${where}: scope "${view.scope}" 在 ${surface} 界面不被允许（宿主只允许 ${allowed.join("/")}），该视图不会出现在面板选择器里`,
				);
			}
		}
		if (!VIEW_SCOPES.includes(view.scope)) fail(`${where}: scope 非法 ${view.scope}`);
		if (!INSTANCE_MODES.includes(view.instance)) fail(`${where}: instance 非法 ${view.instance}`);
		if (view.defaultPosition !== undefined && !DEFAULT_POSITIONS.includes(view.defaultPosition)) {
			fail(`${where}: defaultPosition 非法 ${view.defaultPosition}`);
		}
		if (view.runtime !== undefined && view.runtime !== "host-react") fail(`${where}: runtime 只支持 host-react`);
	}

	// Activation events must resolve to a declared contribution; a typo here means
	// the plugin silently never activates.
	const activationEvents = manifest.activationEvents ?? [];
	if (!Array.isArray(activationEvents)) fail("manifest.activationEvents 必须是数组");
	const activationIndex = {
		onCommand: "commands",
		onView: "views",
		onProvider: "providers",
		onTool: "tools",
	};
	for (const event of activationEvents) {
		if (typeof event !== "string" || !ACTIVATION_EVENT_PATTERN.test(event)) {
			fail(`activationEvents: 无法解析 ${event}`);
			continue;
		}
		const [, kind, reference] = ACTIVATION_EVENT_PATTERN.exec(event) ?? [];
		if (kind === "onStartup" || kind === "onSchedule") continue;
		if (kind === "onEvent") continue;
		const collection = activationIndex[kind];
		if (!collection) continue;
		const candidates = byKind.get(collection) ?? new Set();
		// A provider reference may be `provider/model`; only the provider id is checked.
		const id = kind === "onProvider" ? String(reference).split("/")[0] : reference;
		if (!candidates.has(id)) fail(`activationEvents: ${event} 指向不存在的 ${collection} 贡献 ${id}`);
	}

	for (const [index, secret] of (manifest.secrets ?? []).entries()) {
		const where = `secrets[${index}]`;
		checkContributionId(secret.id, `${where}.id`);
		if (typeof secret.label !== "string" || secret.label.length === 0) fail(`${where}: label 缺失`);
		if (!Array.isArray(secret.scope) || secret.scope.length === 0) fail(`${where}: scope 不能为空`);
		for (const scope of secret.scope ?? []) if (!SECRET_SCOPES.includes(scope)) fail(`${where}: scope 非法 ${scope}`);
		if (!SECRET_USAGES.includes(secret.usage)) fail(`${where}: usage 非法 ${secret.usage}`);
		if (!SECRET_INJECTS.includes(secret.inject)) fail(`${where}: inject 非法 ${secret.inject}`);
	}

	const permissions = manifest.permissions ?? { host: [] };
	for (const capability of permissions.host ?? []) {
		if (typeof capability !== "string" || !CAPABILITY_PATTERN.test(capability)) {
			fail(`permissions.host: 非法能力名 ${JSON.stringify(capability)}`);
		}
	}
	const capabilityNames = permissions.host ?? [];
	if (new Set(capabilityNames).size !== capabilityNames.length) {
		fail("permissions.host: 能力名重复");
	}
	// The host does not read these three; say so where the author will see it rather
	// than letting the declaration imply an enforcement that does not exist.
	for (const field of ["network", "filesystem", "process"]) {
		if (permissions[field] === undefined) continue;
		const serialized = JSON.stringify(permissions[field]);
		if (serialized.length > 8192) fail(`permissions.${field} 序列化后超过 8192 字符`);
	}
	if (permissions.network && permissions.network.mode !== "none") {
		notes.push(
			"permissions.network 只是声明：local-process runner 不做网络隔离，插件后端可以访问任意地址（见 README 的「能力与边界」）。",
		);
	}

	/* ---- cross-field rules from `validateManifestCrossFields` ------------- */

	// Easy to miss and fatal at install: any backend contribution requires a
	// `server`, and any view requires a top-level `ui`. Both were transcribed from
	// the schema's superRefine, because a manifest that passes every per-field check
	// can still be rejected here.
	const backendContributions = ["providers", "searchProviders", "tools", "commands", "events"].filter(
		(kind) => (contributions[kind] ?? []).length > 0,
	);
	if (backendContributions.length > 0 && !manifest.server) {
		fail(`contributes.${backendContributions.join("/")} 需要 manifest.server`);
	}
	if ((contributions.views ?? []).length > 0 && !manifest.ui) {
		fail("contributes.views 需要顶层 ui（entry/format/style/shell）");
	}
	if ((engine.features ?? []).length > 0 && !manifest.server) {
		fail("engine.features 需要 manifest.server");
	}
	if (manifest.configuration !== undefined && contributes.configuration !== undefined) {
		fail("顶层 configuration 与 contributes.configuration 只能选一个");
	}
}

/* -------------------------------------------------------------------------- */
/* Feature negotiation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The gate that silently disables the whole backend when it is missed.
 *
 * `PLUGIN_TO_HOST_METHOD_REQUIRED_FEATURES` requires `host_api.requests` for
 * *every* plugin→host method, and `PluginRuntime` opens the connection with
 * `enforceFeatureNegotiation: true` while deriving the negotiated set from the
 * hello frame alone — `engine.features` is not consulted. So a backend that calls
 * `callHost` without negotiating the feature starts cleanly and then has every
 * outbound request rejected; the symptom arrives one layer up as "the command
 * failed", with nothing pointing here. This check pairs the source against the
 * manifest so the two cannot drift apart again.
 */
async function verifyFeatureNegotiation(manifest) {
	const serverFiles = [
		"server/index.js",
		"server/rpc.js",
		"server/config.js",
		"server/host-home.js",
		"server/balance/index.js",
		"server/balance/providers.js",
		"server/balance/host.js",
	];
	let callsHost = false;
	for (const relative of serverFiles) {
		const source = await fs.readFile(path.join(PLUGIN_DIR, relative), "utf8").catch(() => "");
		if (/\bcallHost\s*\(/.test(source)) callsHost = true;
	}
	if (!callsHost) return;

	const declared = manifest.engine?.features ?? [];
	if (!declared.includes("host_api.requests")) {
		fail('engine.features 必须包含 "host_api.requests"（后端会调用宿主方法）');
	}
	const rpcSource = await fs.readFile(path.join(PLUGIN_DIR, "server", "rpc.js"), "utf8").catch(() => "");
	if (!/NEGOTIATED_FEATURES\s*=\s*\[[^\]]*"host_api\.requests"/.test(rpcSource)) {
		fail('server/rpc.js 的 hello 没有发送 "host_api.requests"（宿主只读 hello，不看 manifest）');
		return;
	}
	// A declared-but-unsent feature is the one that actually broke: the manifest said
	// the right thing while the wire said nothing.
	notes.push("feature 协商：hello 与 manifest.engine.features 都声明 host_api.requests");
}

/* -------------------------------------------------------------------------- */
/* Files referenced by the manifest                                           */
/* -------------------------------------------------------------------------- */

async function verifyReferencedFiles(manifest) {
	const referenced = new Set();
	if (manifest.server?.entry) referenced.add(manifest.server.entry);
	if (manifest.ui?.entry) referenced.add(manifest.ui.entry);
	if (manifest.ui?.style) referenced.add(manifest.ui.style);
	for (const view of manifest.contributes?.views ?? []) {
		referenced.add(view.entry);
		if (view.style) referenced.add(view.style);
	}
	for (const relative of referenced) {
		if (!checkPath(relative, `引用文件 ${relative}`)) continue;
		const stat = await fs.stat(path.join(PLUGIN_DIR, relative)).catch(() => undefined);
		if (!stat?.isFile()) fail(`manifest 引用的 ${relative} 不存在`);
	}
	return referenced;
}

/* -------------------------------------------------------------------------- */
/* Animation index                                                            */
/* -------------------------------------------------------------------------- */

async function verifyAnimIndex() {
	const indexFile = path.join(ANIM_DIR, "index.json");
	let index;
	try {
		index = JSON.parse(await fs.readFile(indexFile, "utf8"));
	} catch {
		fail("anim/index.json 不存在或不是合法 JSON（先跑 transcode + build-index）");
		return;
	}
	if (!Array.isArray(index.clips) || index.clips.length === 0) {
		fail("anim/index.json 没有 clips");
		return;
	}

	let totalBytes = 0;
	let largest = { file: "", bytes: 0 };
	const durationMismatch = [];
	for (const clip of index.clips) {
		const file = path.join(PLUGIN_DIR, clip.file);
		let bytes;
		try {
			bytes = await fs.readFile(file);
		} catch {
			fail(`index 引用的 ${clip.file} 不存在`);
			continue;
		}
		totalBytes += bytes.length;
		if (bytes.length > largest.bytes) largest = { file: clip.file, bytes: bytes.length };
		const info = readAnimatedWebpInfo(bytes);
		if (!info) {
			fail(`${clip.file} 不是动画 WebP`);
			continue;
		}
		if (!info.hasAlpha) fail(`${clip.file} 没有 alpha 通道`);
		if (info.frames !== clip.frames) fail(`${clip.file}: 帧数 ${info.frames} ≠ index ${clip.frames}`);
		if (info.width !== clip.width || info.height !== clip.height) {
			fail(`${clip.file}: 尺寸 ${info.width}×${info.height} ≠ index ${clip.width}×${clip.height}`);
		}
		// Sum of ANMF durations is the truth the player's timers rely on.
		const frameSum = readFrameDurations(bytes).reduce((sum, value) => sum + value, 0);
		if (frameSum !== info.durationMs || Math.abs(info.durationMs - clip.durationMs) > 1) {
			durationMismatch.push(`${clip.file} index=${clip.durationMs} container=${info.durationMs}`);
		}
	}

	if (largest.bytes > 10 * 1024 * 1024) {
		fail(`最大动画 ${largest.file} 是 ${formatBytes(largest.bytes)}，超过 UI 资源 10 MiB 上限`);
	}
	if (durationMismatch.length > 0) {
		// A few milliseconds of rounding is expected from the 1/fps frame quantisation;
		// a systematic mismatch means the index was built against a different profile.
		if (durationMismatch.length > index.clips.length * 0.1) {
			fail(`${durationMismatch.length} 段时长与容器不符，前 3 条：${durationMismatch.slice(0, 3).join("; ")}`);
		} else {
			warn(`${durationMismatch.length} 段时长与容器有偏差：${durationMismatch.slice(0, 3).join("; ")}`);
		}
	}

	notes.push(
		`动画：${index.clips.length} 段，${formatBytes(totalBytes)}，最大 ${largest.file} ${formatBytes(largest.bytes)}，profile ${index.profile}`,
	);
}

/* -------------------------------------------------------------------------- */
/* Shipped sources must not embed credentials                                 */
/* -------------------------------------------------------------------------- */

/**
 * A cheap but effective check: API keys for the three supported providers have
 * recognisable prefixes, and a key baked into a shipped file is unrecoverable once
 * published. Scans only what actually ships.
 */
async function verifyNoSecrets() {
	const suspicious = [/sk-[A-Za-z0-9]{16,}/, /Bearer\s+[A-Za-z0-9._-]{24,}/, /[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}/];
	const files = [
		"manifest.json",
		"server/index.js",
		"server/rpc.js",
		"server/log.js",
		"server/config.js",
		"server/balance/index.js",
		"server/balance/providers.js",
		"ui/stage.iife.js",
		"ui/settings.iife.js",
	];
	for (const relative of files) {
		let text;
		try {
			text = await fs.readFile(path.join(PLUGIN_DIR, relative), "utf8");
		} catch {
			continue;
		}
		for (const pattern of suspicious) {
			if (pattern.test(text)) fail(`${relative} 疑似含有明文凭据（匹配 ${pattern}）`);
		}
	}
	notes.push(`已扫描 ${files.length} 个随包脚本，未发现明文凭据`);
}

/* -------------------------------------------------------------------------- */
/* Package report                                                             */
/* -------------------------------------------------------------------------- */

async function verifyArchive() {
	let entries;
	try {
		entries = await fs.readdir(DIST_DIR);
	} catch {
		return;
	}
	const archives = entries.filter((name) => name.endsWith(".nfplugin"));
	if (archives.length === 0) {
		notes.push("dist/ 里还没有 .nfplugin（运行 tools/pack.mjs 生成）");
		return;
	}
	for (const name of archives) {
		const stat = await fs.stat(path.join(DIST_DIR, name));
		if (stat.size > 100 * 1024 * 1024) fail(`${name} 是 ${formatBytes(stat.size)}，超过 100 MiB 上限`);
		else notes.push(`归档 ${name}：${formatBytes(stat.size)}（上限 100 MiB，余量 ${formatBytes(100 * 1024 * 1024 - stat.size)}）`);
	}
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                      */
/* -------------------------------------------------------------------------- */

async function main() {
	let manifest;
	try {
		manifest = JSON.parse(await fs.readFile(path.join(PLUGIN_DIR, "manifest.json"), "utf8"));
	} catch (error) {
		fail(`manifest.json 无法解析：${error.message}`);
	}

	if (manifest) {
		verifyManifest(manifest);
		await verifyFeatureNegotiation(manifest);
		await verifyReferencedFiles(manifest);
	}
	await verifyAnimIndex();
	await verifyNoSecrets();
	await verifyArchive();

	for (const note of notes) process.stdout.write(`  ·  ${note}\n`);
	for (const warning of warnings) process.stdout.write(`  !  ${warning}\n`);
	if (failures.length > 0) {
		for (const failure of failures) process.stdout.write(`  ✕  ${failure}\n`);
		process.stdout.write(`\n[verify] 失败 ${failures.length} 项\n`);
		process.exitCode = 1;
		return;
	}
	process.stdout.write(`\n[verify] 通过（${warnings.length} 个警告）\n`);
}

await main();
process.stdout.write(`[verify] 工作目录 ${posix(path.relative(REPO_DIR, PLUGIN_DIR))}\n`);
