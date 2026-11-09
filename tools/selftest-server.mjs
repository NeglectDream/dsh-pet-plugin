/**
 * Drive `server/index.js` over its real stdio protocol, acting as the host.
 *
 * WHY A FAKE HOST IS THE RIGHT TEST
 * The plugin backend's entire contract is `narrafork.rpc/1` over stdio plus the
 * sixteen host methods it may call back. Both halves are ordinary messages, so a
 * few hundred lines of test harness can exercise the real handshake, the real
 * dispatch table and the real storage/secret round trips — without NarraFork, an
 * installed plugin, an admin session or ffmpeg. What it cannot cover is the UI
 * iframe, which is what the in-panel self-check is for.
 *
 * Every assertion prints one line, so a failure names the exact protocol step that
 * broke rather than "the plugin did not work".
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, "..");
const ENTRY = path.join(PLUGIN_DIR, "server", "index.js");
const PLUGIN_ID = "cn.mcd7.neglectdream.dsh-pet";
const PLUGIN_VERSION = "2.0.0";
const PROTOCOL = "narrafork.rpc/1";

let passed = 0;
const failures = [];

function check(label, condition, detail) {
	if (condition) {
		passed += 1;
		process.stdout.write(`  ✓ ${label}\n`);
		return true;
	}
	failures.push(`${label}${detail === undefined ? "" : ` — ${detail}`}`);
	process.stdout.write(`  ✕ ${label}${detail === undefined ? "" : ` — ${detail}`}\n`);
	return false;
}

/* -------------------------------------------------------------------------- */
/* Frame transport                                                            */
/* -------------------------------------------------------------------------- */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function encodeFrame(message) {
	const body = encoder.encode(JSON.stringify(message));
	return Buffer.concat([
		Buffer.from(`Content-Length: ${body.byteLength}\r\nContent-Type: application/json\r\n\r\n`, "utf8"),
		Buffer.from(body),
	]);
}

/** Incremental frame reader: chunks arrive at arbitrary boundaries. */
class FrameReader {
	constructor() {
		this.buffer = Buffer.alloc(0);
	}

	push(chunk) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		const messages = [];
		for (;;) {
			const delimiter = this.buffer.indexOf("\r\n\r\n");
			if (delimiter < 0) break;
			const header = decoder.decode(this.buffer.subarray(0, delimiter));
			const match = /content-length:\s*(\d+)/i.exec(header);
			if (!match) throw new Error(`frame without Content-Length: ${header}`);
			const length = Number(match[1]);
			const start = delimiter + 4;
			if (this.buffer.byteLength < start + length) break;
			const body = decoder.decode(this.buffer.subarray(start, start + length));
			this.buffer = this.buffer.subarray(start + length);
			messages.push(JSON.parse(body));
		}
		return messages;
	}
}

/* -------------------------------------------------------------------------- */
/* Fake host                                                                  */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Fake host                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A throwaway `<home>` so the host-balance path is exercised against a fixture
 * instead of this machine's real `provider-balances.json`.
 *
 * `resolveHostHome()` prefers `NARRAFORK_HOME` only when the directory looks like
 * a NarraFork home (it has a `plugins/` child), so the fixture has to reproduce
 * that shape — which is also what makes this a genuine test of the discovery
 * logic rather than of a magic environment variable.
 */
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-pet-selftest-"));
fs.mkdirSync(path.join(FAKE_HOME, "plugins"), { recursive: true });
const FIXTURE_FETCHED_AT = Date.now() - 60_000;
fs.writeFileSync(
	path.join(FAKE_HOME, "provider-balances.json"),
	JSON.stringify({
		version: 1,
		salt: "0123456789abcdef0123456789abcdef",
		entries: {
			"relay-primary": {
				fingerprint: "fixture",
				savedAt: FIXTURE_FETCHED_AT,
				value: {
					status: "supported",
					endpoint: { adapter: "new-api", root: "https://relay.invalid" },
					balance: {
						scope: "wallet",
						unlimited: false,
						// 1.25 of 5.00 left → 75 % used → tier 3.
						amounts: [{ unit: "USD", remaining: 1.25, total: 5 }],
					},
					fetchedAt: FIXTURE_FETCHED_AT,
					attemptedAt: FIXTURE_FETCHED_AT,
				},
			},
		},
	}),
	"utf8",
);

/** In-memory stand-in for the host's storage + vault. */
const storage = new Map();
const secrets = new Map();
const hostCalls = [];

/**
 * Features the plugin negotiated in its `hello`, which the host uses to decide
 * whether a plugin→host method is callable at all.
 *
 * `PluginRuntime` opens the connection with `enforceFeatureNegotiation: true` and
 * derives this set from the hello frame *only*; `PLUGIN_TO_HOST_METHOD_REQUIRED_FEATURES`
 * then requires `host_api.requests` for every outbound method. Modelling that here
 * is the difference between a test that exercises the protocol and one that
 * exercises a convenient fiction — a plugin that launches with `features: []`
 * still passes a permissive harness and then fails on every command in the host.
 */
const negotiatedFeatures = new Set();

/** Mirrors `PLUGIN_TO_HOST_METHOD_REQUIRED_FEATURES` for the methods we call. */
const REQUIRED_FEATURES = {
	"queries.execute": ["host_api.requests"],
	"commands.execute": ["host_api.requests"],
	"events.subscribe": ["host_api.requests"],
	"events.unsubscribe": ["host_api.requests"],
	"events.poll": ["host_api.requests", "events.poll"],
	"storage.get": ["host_api.requests"],
	"storage.set": ["host_api.requests"],
	"storage.delete": ["host_api.requests"],
	"storage.list": ["host_api.requests"],
	"config.get": ["host_api.requests"],
	"secrets.get": ["host_api.requests"],
	"secrets.set": ["host_api.requests"],
	"secrets.delete": ["host_api.requests"],
	"secrets.list": ["host_api.requests"],
	"diagnostics.getOwn": ["host_api.requests"],
};

const child = spawn(process.execPath, [ENTRY], {
	cwd: PLUGIN_DIR,
	env: { ...process.env, NF_PLUGIN_PACKAGE_DIGEST: "selftest-digest", NARRAFORK_HOME: FAKE_HOME },
	stdio: ["pipe", "pipe", "pipe"],
});

/**
 * Captured at spawn time, not on demand.
 *
 * The plugin answers `shutdown` and then exits immediately; awaiting the response
 * first and attaching an `exit` listener afterwards loses the race whenever the
 * process is already gone, which showed up as a spurious "shutdown timeout".
 */
const exited = new Promise((resolve) => {
	child.on("exit", (code) => resolve(code));
});

const reader = new FrameReader();
const inbound = [];
const stderrLines = [];

child.stdout.on("data", (chunk) => {
	for (const message of reader.push(chunk)) {
		if (typeof message.method === "string" && message.id !== undefined) {
			hostCalls.push(message.method);
			answerHostCall(message);
		} else {
			inbound.push(message);
		}
	}
});

child.stderr.on("data", (chunk) => {
	for (const line of String(chunk).split("\n")) if (line.trim()) stderrLines.push(line);
});

/**
 * Answer the plugin's outbound requests exactly as `PluginHostServices` would.
 *
 * Scope checks mirror the host's `assertStorageScopeBound`: a non-global scope
 * with no id is a permission error, which is precisely the failure mode that
 * would appear at runtime if this plugin picked the wrong scope.
 */
function answerHostCall(message) {
	const { id, method, params } = message;
	const respond = (result) => child.stdin.write(encodeFrame({ jsonrpc: "2.0", id, result }));
	const reject = (code, text) =>
		child.stdin.write(encodeFrame({ jsonrpc: "2.0", id, error: { code, message: text } }));

	// The gate the host really applies, checked before dispatch.
	const missing = (REQUIRED_FEATURES[method] ?? []).filter((feature) => !negotiatedFeatures.has(feature));
	if (missing.length > 0) {
		return reject(-32601, `PLUGIN_FEATURE_NOT_NEGOTIATED: ${method} requires ${missing.join(", ")}`);
	}

	if (method.startsWith("storage.")) {
		const scope = params?.scope;
		if (!scope || typeof scope.type !== "string") return reject(-32602, "Storage scope is invalid");
		if (scope.type !== "global" && !scope.id) return reject(-32603, "Storage scope is outside the bound backend context");
		const key = `${scope.type}/${params.key}`;
		if (method === "storage.get") return respond(storage.has(key) ? { key: params.key, value: storage.get(key), revision: 1 } : null);
		if (method === "storage.set") {
			storage.set(key, params.value);
			return respond({ key: params.key, revision: 1, stored: true });
		}
		if (method === "storage.delete") {
			storage.delete(key);
			return respond({ key: params.key, deleted: true });
		}
		if (method === "storage.list") {
			return respond({
				entries: [...storage.entries()]
					.filter(([name]) => name.startsWith(`${scope.type}/`))
					.map(([name, value]) => ({ key: name.slice(scope.type.length + 1), value })),
			});
		}
	}
	if (method === "secrets.get") return respond({ key: params.key, value: secrets.get(params.key) ?? null });
	if (method === "secrets.list") {
		return respond({ secrets: [...secrets.keys()].map((key) => ({ key, configured: true })) });
	}
	if (method === "secrets.set") {
		secrets.set(params.key, params.value);
		return respond({ key: params.key, stored: true });
	}
	if (method === "secrets.delete") {
		secrets.delete(params.key);
		return respond({ key: params.key, deleted: true });
	}
	if (method === "config.get") return respond({});
	return reject(-32601, `Unknown method: ${method}`);
}

let requestSequence = 0;
const pending = new Map();

function send(message) {
	child.stdin.write(encodeFrame(message));
}

/** Send a request and resolve with the matching response (or the error). */
function request(method, params, timeoutMs = 15_000) {
	requestSequence += 1;
	const id = `h${requestSequence}`;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`timed out waiting for ${method}`));
		}, timeoutMs);
		pending.set(id, {
			resolve: (message) => {
				clearTimeout(timer);
				resolve(message);
			},
		});
		send({ jsonrpc: "2.0", id, method, params });
	});
}

/** Invoke one of the plugin's own commands the way `commands.invoke` does. */
async function invoke(contributionId, input) {
	const response = await request("commands.invoke", {
		contributionId,
		...(input === undefined ? {} : { input }),
		context: { requestId: `req-${requestSequence}` },
	});
	return response;
}

/* -------------------------------------------------------------------------- */
/* Response plumbing                                                          */
/* -------------------------------------------------------------------------- */

// Resolve requests from the inbound queue as messages arrive.
setInterval(() => {
	for (let index = inbound.length - 1; index >= 0; index -= 1) {
		const message = inbound[index];
		if (message.id === undefined) continue;
		const entry = pending.get(message.id);
		if (!entry) continue;
		inbound.splice(index, 1);
		pending.delete(message.id);
		entry.resolve(message);
	}
}, 5).unref?.();

function waitForHello(timeoutMs = 10_000) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const poll = setInterval(() => {
			const index = inbound.findIndex((message) => message.method === "hello");
			if (index >= 0) {
				clearInterval(poll);
				resolve(inbound.splice(index, 1)[0]);
				return;
			}
			if (Date.now() - started > timeoutMs) {
				clearInterval(poll);
				reject(new Error("no hello frame from the plugin"));
			}
		}, 10);
	});
}

/* -------------------------------------------------------------------------- */
/* Scenario                                                                   */
/* -------------------------------------------------------------------------- */

function outputOf(response) {
	return response.result?.output;
}

async function main() {
	process.stdout.write(`[selftest] ${path.relative(process.cwd(), ENTRY)}\n`);

	/* -- 1. handshake ---------------------------------------------------- */
	const hello = await waitForHello();
	check("hello：pluginId", hello.params?.pluginId === PLUGIN_ID, hello.params?.pluginId);
	check("hello：version", hello.params?.version === PLUGIN_VERSION, hello.params?.version);
	check("hello：rpcProtocol", hello.params?.rpcProtocol === PROTOCOL, hello.params?.rpcProtocol);
	check("hello：透传 packageDigest", hello.params?.packageDigest === "selftest-digest", hello.params?.packageDigest);
	check(
		"hello：协商 host_api.requests",
		Array.isArray(hello.params?.features) && hello.params.features.includes("host_api.requests"),
		JSON.stringify(hello.params?.features),
	);
	for (const feature of hello.params?.features ?? []) negotiatedFeatures.add(feature);

	/* -- 2. identity checks ---------------------------------------------- */
	const wrongIdentity = await request("initialize", { protocol: PROTOCOL, pluginId: "com.example.other" });
	check("initialize：身份不符被拒绝", wrongIdentity.error?.code === -32602, JSON.stringify(wrongIdentity.error));

	const wrongProtocol = await request("initialize", { protocol: "narrafork.rpc/2", pluginId: PLUGIN_ID });
	check("initialize：协议不符被拒绝", wrongProtocol.error?.code === -32602, JSON.stringify(wrongProtocol.error));

	const premature = await invoke("pet-state");
	check("activate 前调用命令 → PLUGIN_UNAVAILABLE", premature.error?.data?.code === "PLUGIN_UNAVAILABLE", JSON.stringify(premature.error));

	/* -- 3. activate ----------------------------------------------------- */
	const initialized = await request("initialize", {
		protocol: PROTOCOL,
		pluginId: PLUGIN_ID,
		runtimeId: "selftest-runtime",
		generation: 1,
	});
	check("initialize：握手成功", initialized.result?.initialized === true, JSON.stringify(initialized.result));

	const activated = await request("activate", { reason: "onView:pet-stage" });
	check("activate 成功", activated.result?.activated === true, JSON.stringify(activated.result));

	const health = await request("health");
	check("health：healthy", health.result?.healthy === true, JSON.stringify(health.result));
	check("health：状态 ready", health.result?.status === "ready", health.result?.status);

	/* -- 4. command dispatch -------------------------------------------- */
	const providers = await invoke("pet-balance-providers");
	const providerList = outputOf(providers)?.providers ?? [];
	check("pet-balance-providers：返回 4 个服务商", providerList.length === 4, String(providerList.length));
	check(
		"pet-balance-providers：包含 custom",
		providerList.some((entry) => entry.id === "custom"),
		providerList.map((entry) => entry.id).join(","),
	);

	const fresh = await invoke("pet-config-get");
	const freshConfig = outputOf(fresh)?.config;
	check("pet-config-get：未写入时返回默认值", freshConfig?.count === 1 && freshConfig?.version === 1);
	check("pet-config-get：stored=false", outputOf(fresh)?.stored === false);
	check("storage.get 走的是 global 作用域", [...storage.keys()].every((key) => key.startsWith("global/")) || storage.size === 0);

	/* -- 5. writes are clamped, not rejected ---------------------------- */
	const clamped = await invoke("pet-config-set", { patch: { count: 99, scale: 9, gravity: -3 } });
	const clampedConfig = outputOf(clamped)?.config;
	check("pet-config-set：count 夹到 6", clampedConfig?.count === 6, String(clampedConfig?.count));
	check("pet-config-set：scale 夹到 3", clampedConfig?.scale === 3, String(clampedConfig?.scale));
	check("pet-config-set：gravity 夹到 0", clampedConfig?.gravity === 0, String(clampedConfig?.gravity));
	check("pet-config-set：返回夹取说明", Array.isArray(outputOf(clamped)?.warnings) && outputOf(clamped).warnings.length > 0, JSON.stringify(outputOf(clamped)?.warnings));
	check("pet-config-set：写进了 storage", storage.has("global/pet.config"));

	const roundTrip = await invoke("pet-config-get");
	check("pet-config-get：写入后可读回", outputOf(roundTrip)?.config?.count === 6, String(outputOf(roundTrip)?.config?.count));

	/* -- 6. animation groups cannot be fully disabled ------------------- */
	const allOff = await invoke("pet-config-set", {
		patch: { animationGroups: Object.fromEntries(["idle", "turn", "drag", "click", "move", "small", "play", "eat", "season", "text"].map((group) => [group, false])) },
	});
	check("pet-config-set：全关动画后强制保留 idle", outputOf(allOff)?.config?.animationGroups?.idle === true);
	check("pet-config-set：给出提示", (outputOf(allOff)?.warnings ?? []).some((text) => text.includes("idle")));

	/* -- 7. state + host-sourced balance -------------------------------- */
	const state = await invoke("pet-state");
	const stateOutput = outputOf(state);
	check("pet-state：带 version", stateOutput?.version === PLUGIN_VERSION, stateOutput?.version);
	check("pet-state：带 config", stateOutput?.config?.count === 6);
	check(
		"pet-config-get：默认余额来源是 host",
		stateOutput?.config?.balance?.source === "host",
		String(stateOutput?.config?.balance?.source),
	);
	check(
		"pet-state：读取宿主缓存的余额（75% → 档位 3）",
		stateOutput?.balance?.ok === true &&
			Math.round(stateOutput.balance.percent) === 75 &&
			stateOutput.balance.tier === 3,
		JSON.stringify({ ok: stateOutput?.balance?.ok, percent: stateOutput?.balance?.percent, tier: stateOutput?.balance?.tier }),
	);
	check(
		"pet-state：宿主余额无需任何密钥配置",
		[...secrets.keys()].length === 0,
		[...secrets.keys()].join(","),
	);

	const hostRefresh = await invoke("pet-balance-refresh", { force: true });
	check(
		"pet-balance-refresh：host 来源可强制刷新",
		outputOf(hostRefresh)?.snapshot?.ok === true,
		JSON.stringify(outputOf(hostRefresh)?.snapshot?.error),
	);
	check(
		"pet-balance-providers：同时给出两种来源",
		(outputOf(await invoke("pet-balance-providers"))?.sources ?? []).length === 2,
	);

	/* -- 8. manual source: missing secret ------------------------------- */
	await invoke("pet-config-set", { patch: { balance: { source: "manual", providerId: "deepseek-official" } } });
	const noSecret = await invoke("pet-balance-refresh", { force: true });
	const noSecretSnapshot = outputOf(noSecret)?.snapshot;
	check(
		"pet-balance-refresh：手动来源缺密钥 → missing_secret",
		noSecretSnapshot?.error?.kind === "missing_secret",
		JSON.stringify(noSecretSnapshot?.error),
	);
	check("pet-balance-refresh：失败也写快照", storage.has("global/balance.snapshot"));
	check("pet-balance-refresh：调用了 secrets.get", hostCalls.includes("secrets.get"));

	/* -- 9. balance: bad key is a classified error, not a zero ----------- */
	secrets.set("deepseekApiKey", "sk-selftest-invalid-key");
	const badKey = await invoke("pet-balance-refresh", { force: true });
	const badSnapshot = outputOf(badKey)?.snapshot;
	check(
		"pet-balance-refresh：无效密钥不进 ok 分支",
		badSnapshot?.ok === false && typeof badSnapshot?.error?.kind === "string",
		JSON.stringify(badSnapshot?.error),
	);
	check(
		"pet-balance-refresh：错误分类可读",
		["auth_failed", "network", "http", "shape_mismatch", "unknown"].includes(badSnapshot?.error?.kind),
		badSnapshot?.error?.kind,
	);
	check("pet-balance-refresh：没有把失败伪装成 0%", badSnapshot?.percent === undefined, String(badSnapshot?.percent));

	/* -- 10. secrets list never leaks values ---------------------------- */
	const secretList = await invoke("pet-secrets-list");
	const keys = outputOf(secretList)?.keys ?? [];
	check("pet-secrets-list：列出已配置的键", keys.some((entry) => entry.key === "deepseekApiKey" && entry.configured === true));
	check("pet-secrets-list：列出未配置的内置键", keys.some((entry) => entry.key === "opencodeZenApiKey" && entry.configured === false));
	check(
		"pet-secrets-list：不含任何值",
		!JSON.stringify(secretList).includes("sk-selftest-invalid-key"),
	);

	/* -- 11. logging ---------------------------------------------------- */
	const logged = await invoke("pet-log", { level: "warn", message: "selftest marker", detail: { from: "selftest" } });
	check("pet-log：返回 ok", outputOf(logged)?.ok === true);
	await new Promise((resolve) => setTimeout(resolve, 120));
	check("pet-log：落到 stderr", stderrLines.some((line) => line.includes("selftest marker")), String(stderrLines.length));

	/* -- 11. clip bytes (the animation data channel) --------------------- */
	// This is the replacement for the asset route, which serves only paths the
	// manifest declares. If chunking or the framing regresses, every animation in
	// the UI silently becomes "The source image cannot be decoded", so the whole
	// path is exercised here: first chunk, sizes, concatenation, magic bytes.
	const clipFile = path.join(PLUGIN_DIR, "anim", "webp", "000.webp");
	const clipSize = fs.statSync(clipFile).size;
	const headChunk = outputOf(await invoke("pet-clip", { index: 0 }));
	check("pet-clip：返回第一片", typeof headChunk?.data === "string" && headChunk.data.length > 0);
	check("pet-clip：total 等于文件大小", headChunk?.total === clipSize, `${headChunk?.total} vs ${clipSize}`);
	const headBytes = Buffer.from(headChunk?.data ?? "", "base64");
	check("pet-clip：单片不超过 512 KiB", headBytes.byteLength <= 512 * 1024, String(headBytes.byteLength));
	check("pet-clip：未读完时 done=false", headChunk?.done === (headBytes.byteLength >= clipSize), String(headChunk?.done));

	let offset = 0;
	let assembled = 0;
	let magic;
	for (let guard = 0; guard < 8 && offset < clipSize; guard += 1) {
		const value = outputOf(await invoke("pet-clip", { index: 0, offset }));
		const chunk = Buffer.from(value?.data ?? "", "base64");
		if (magic === undefined) magic = chunk.subarray(0, 4).toString("latin1");
		assembled += chunk.byteLength;
		offset += chunk.byteLength;
		if (value?.done === true) break;
	}
	check("pet-clip：分片拼回完整文件", assembled === clipSize, `${assembled} vs ${clipSize}`);
	check("pet-clip：拼回后是 RIFF/WebP", magic === "RIFF", String(magic));
	const outOfRange = await invoke("pet-clip", { index: 999 });
	check("pet-clip：越界 index 结构化报错", outOfRange.error?.code === -32602, JSON.stringify(outOfRange.error));

	/* -- 12. protocol errors -------------------------------------------- */
	const unknownCommand = await invoke("pet-does-not-exist");
	check("未知命令贡献 → INVALID_PARAMS", unknownCommand.error?.code === -32602, JSON.stringify(unknownCommand.error));

	const unknownMethod = await request("does.not.exist", {});
	check("未知方法 → METHOD_NOT_FOUND", unknownMethod.error?.code === -32601, JSON.stringify(unknownMethod.error));

	/* -- 13. reset ------------------------------------------------------- */
	const reset = await invoke("pet-config-set", { reset: true });
	check("pet-config-set：reset 恢复默认", outputOf(reset)?.config?.count === 1, String(outputOf(reset)?.config?.count));

	/* -- 14. shutdown ---------------------------------------------------- */
	const shutdown = await request("shutdown");
	check("shutdown：返回 shutdown:true", shutdown.result?.shutdown === true, JSON.stringify(shutdown.result));
	const exitCode = await Promise.race([
		exited,
		new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000)),
	]);
	check("shutdown：进程自行退出", exitCode === 0, String(exitCode));

	/* -- report --------------------------------------------------------- */
	process.stdout.write(`\n[selftest] ${passed} 通过，${failures.length} 失败\n`);
	if (failures.length > 0) {
		for (const failure of failures) process.stdout.write(`  ✕ ${failure}\n`);
		process.exitCode = 1;
	}
}

main().catch((error) => {
	process.stdout.write(`\n[selftest] 崩溃：${error?.stack ?? error}\n`);
	process.stdout.write(`[selftest] stderr 摘要：\n${stderrLines.slice(-10).join("\n")}\n`);
	child.kill();
	process.exitCode = 1;
});
