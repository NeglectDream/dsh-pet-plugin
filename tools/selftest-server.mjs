/**
 * Drive `server/index.js` over its real stdio protocol, acting as the host.
 *
 * WHY A FAKE HOST IS THE RIGHT TEST
 * The plugin backend's entire contract is `narrafork.rpc/1` over stdio plus the
 * host methods it may call back. Both halves are ordinary messages, so a few
 * hundred lines of test harness can exercise the real handshake, the real
 * dispatch table and the real storage/secret round trips — without NarraFork, an
 * installed plugin, an admin session or ffmpeg. What it cannot cover is the UI
 * iframe, which is what the in-panel self-check is for.
 *
 * THE BALANCE API IS MOCKED, NOT CONTACTED
 * The plugin queries one HTTPS endpoint. The child process is started with
 * `--import <temp module>` which replaces `globalThis.fetch` with a router that
 * asserts the request shape (GET, `redirect: "error"`, `Authorization: Bearer`,
 * `Accept: application/json`) and answers per path with fixtures: success, 401,
 * 500, 3xx, 1 MiB+ body, invalid JSON, missing field, timeout. No test ever opens a
 * socket, and the real provider code path — including the 6 s deadline and the
 * response cap — is what runs.
 *
 * Every assertion prints one line, so a failure names the exact protocol step that
 * broke rather than "the plugin did not work".
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, "..");
const ENTRY = path.join(PLUGIN_DIR, "server", "index.js");
const PLUGIN_ID = "cn.mcd7.neglectdream.dsh-pet";
const PLUGIN_VERSION = "2.2.0";
const PROTOCOL = "narrafork.rpc/1";
const BASE_KEY = "selftest-key-one";

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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
/* Mock balance API (installed into the child via --import)                    */
/* -------------------------------------------------------------------------- */

const MOCK_MODULE = `
const KEY = process.env.SELFTEST_BALANCE_KEY || "selftest-key-one";
let moneyCalls = 0;
function json(body, status, headers) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: status === undefined ? 200 : status,
    headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
  });
}
globalThis.fetch = async function selftestFetch(input, init) {
  init = init || {};
  const url = new URL(typeof input === "string" ? input : String(input && input.url));
  if (init.method !== "GET") return json({ error: "method" }, 400);
  if (init.redirect !== "error") return json({ error: "redirect" }, 400);
  const headers = init.headers || {};
  if (headers.Accept !== "application/json") return json({ error: "accept" }, 400);
  if (headers.Authorization !== "Bearer " + KEY) return json({ error: "unauthorized" }, 401);
  switch (url.pathname) {
    case "/ok": return json({ data: { remaining: "10" } });
    case "/dropped": return json({ data: { remaining: "1" } });
    case "/money": return json({ data: { remaining: "10", used: "30" } });
    case "/money-down": return json({ data: { remaining: "8", used: "32" } });
    case "/money-var":
      moneyCalls += 1;
      return moneyCalls === 1 ? json({ data: { remaining: "10", used: "30" } }) : json({ data: { remaining: "8", used: "32" } });
    case "/zero": return json({ data: { remaining: 0 } });
    case "/negative": return json({ data: { remaining: -2.5 } });
    case "/unknown": return json({ data: {} });
    case "/null": return json({ data: { remaining: null } });
    case "/invalid": return json("not json at all", 200);
    case "/big": return json({ data: { remaining: 1, padding: "x".repeat(1024 * 1024 + 4096) } });
    case "/401": return json({ error: "unauthorized" }, 401);
    case "/403": return json({ error: "forbidden" }, 403);
    case "/500": return json({ error: "server" }, 500);
    case "/redirect": return json({}, 302, { Location: "https://elsewhere.invalid/balance" });
    case "/slow":
      return new Promise(function (resolve, reject) {
        init.signal.addEventListener("abort", function () { reject(new Error("aborted")); }, { once: true });
      });
    default: return json({ error: "not found" }, 404);
  }
};
`;

const MOCK_FILE = path.join(os.tmpdir(), `dsh-pet-fetch-mock-${process.pid}.mjs`);
fs.writeFileSync(MOCK_FILE, MOCK_MODULE, "utf8");
const MOCK_URL = pathToFileURL(MOCK_FILE).href;

/* -------------------------------------------------------------------------- */
/* Fake host                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A throwaway `<home>` with a `plugins/` child, so `resolveHostHome()` finds it.
 * The backend uses it only for its diagnostic UI report log — the balance path no
 * longer reads any host file at all.
 */
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-pet-selftest-"));
fs.mkdirSync(path.join(FAKE_HOME, "plugins"), { recursive: true });

/** In-memory stand-in for the host's storage + vault. */
const storage = new Map();
const secrets = new Map();
const hostCalls = [];
let failNextStorageKey = null;

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

const child = spawn(process.execPath, ["--import", MOCK_URL, ENTRY], {
	cwd: PLUGIN_DIR,
	env: { ...process.env, NF_PLUGIN_PACKAGE_DIGEST: "selftest-digest", NARRAFORK_HOME: FAKE_HOME, SELFTEST_BALANCE_KEY: BASE_KEY },
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
			if (failNextStorageKey === params.key) { failNextStorageKey = null; return reject(-32603, "injected storage write failure"); }
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
async function invoke(contributionId, input, timeoutMs = 15_000) {
	const response = await request("commands.invoke", {
		contributionId,
		...(input === undefined ? {} : { input }),
		context: { requestId: `req-${requestSequence}` },
	}, timeoutMs);
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
const INVALID = -32602;

/** Configure the single API. `custom` is merged, so partial patches are fine. */
async function setBalance(custom, extra = {}) {
	return outputOf(await invoke("pet-config-set", { patch: { ...extra, balance: { custom } } }));
}

async function refresh(force = true, timeoutMs = 15_000) {
	return outputOf(await invoke("pet-balance-refresh", force === undefined ? undefined : { force }, timeoutMs));
}

async function main() {
	process.stdout.write(`[selftest] ${path.relative(process.cwd(), ENTRY)}\n`);

	/* -- 1. handshake ---------------------------------------------------- */
	const hello = await waitForHello();
	check("hello：pluginId", hello.params?.pluginId === PLUGIN_ID, hello.params?.pluginId);
	check("hello：version", hello.params?.version === PLUGIN_VERSION, hello.params?.version);
	check("hello：rpcProtocol", hello.params?.rpcProtocol === PROTOCOL, hello.params?.rpcProtocol);
	check("hello：透传 packageDigest", hello.params?.packageDigest === "selftest-digest", hello.params?.packageDigest);
	check("hello：协商 host_api.requests", Array.isArray(hello.params?.features) && hello.params.features.includes("host_api.requests"), JSON.stringify(hello.params?.features));
	for (const feature of hello.params?.features ?? []) negotiatedFeatures.add(feature);

	/* -- 2. identity checks ---------------------------------------------- */
	const wrongIdentity = await request("initialize", { protocol: PROTOCOL, pluginId: "com.example.other" });
	check("initialize：身份不符被拒绝", wrongIdentity.error?.code === INVALID, JSON.stringify(wrongIdentity.error));

	const wrongProtocol = await request("initialize", { protocol: "narrafork.rpc/2", pluginId: PLUGIN_ID });
	check("initialize：协议不符被拒绝", wrongProtocol.error?.code === INVALID, JSON.stringify(wrongProtocol.error));

	const premature = await invoke("pet-state");
	check("activate 前调用命令 → PLUGIN_UNAVAILABLE", premature.error?.data?.code === "PLUGIN_UNAVAILABLE", JSON.stringify(premature.error));

	/* -- 3. activate ----------------------------------------------------- */
	const initialized = await request("initialize", { protocol: PROTOCOL, pluginId: PLUGIN_ID, runtimeId: "selftest-runtime", generation: 1 });
	check("initialize：握手成功", initialized.result?.initialized === true, JSON.stringify(initialized.result));

	const activated = await request("activate", { reason: "onView:pet-stage" });
	check("activate 成功", activated.result?.activated === true, JSON.stringify(activated.result));

	const health = await request("health");
	check("health：healthy", health.result?.healthy === true, JSON.stringify(health.result));
	check("health：状态 ready", health.result?.status === "ready", health.result?.status);

	/* -- 4. config: one balance schema, version 2 ------------------------ */
	const fresh = await invoke("pet-config-get");
	const freshConfig = outputOf(fresh)?.config;
	check("pet-config-get：默认 version 2", freshConfig?.version === 2, String(freshConfig?.version));
	check("pet-config-get：stored=false", outputOf(fresh)?.stored === false);
	check("pet-config-get：单一 API 默认空配置", JSON.stringify(freshConfig?.balance) === JSON.stringify({ refreshMinutes: 30, thresholds: [20, 40, 60, 80, 100], custom: { url: "", totalPath: "", usedPath: "", currency: "POINTS" } }), JSON.stringify(freshConfig?.balance));
	check("pet-config-get：不再有来源/服务商/叙述者绑定", !Object.hasOwn(freshConfig?.balance ?? {}, "source") && !Object.hasOwn(freshConfig?.balance ?? {}, "providerId") && !Object.hasOwn(freshConfig ?? {}, "narratorBalances"));
	check("pet-config-get：默认开启点击音效", freshConfig?.sound?.enabled === true && freshConfig.sound.volume === 0.6, JSON.stringify(freshConfig?.sound));

	const providersGone = await invoke("pet-balance-providers");
	check("pet-balance-providers：命令已移除", providersGone.error?.code === INVALID, JSON.stringify(providersGone.error));

	/* -- 4b. legacy config migration ------------------------------------ */
	storage.set("global/pet.config", {
		version: 1,
		count: 2,
		narratorBalances: [{ narratorId: "narrator_legacy", providerId: `hp_${"a".repeat(64)}`, alias: "旧绑定" }],
		balance: {
			source: "manual", providerId: "deepseek-official", refreshMinutes: 45,
			custom: { url: "https://balance.test/ok", totalPath: "data.remaining", usedPath: "data.used", method: "POST", headers: { Authorization: "legacy" } },
		},
	});
	const migrated = outputOf(await invoke("pet-config-get"));
	check("迁移：版本升到 2 且保留 URL/路径", migrated?.config?.version === 2 && migrated.config.balance.custom.url === "https://balance.test/ok" &&
		migrated.config.balance.custom.totalPath === "data.remaining" && migrated.config.balance.custom.usedPath === "data.used", JSON.stringify(migrated?.config?.balance));
	check("迁移：移除来源/服务商/叙述者绑定", !Object.hasOwn(migrated?.config?.balance ?? {}, "source") && !Object.hasOwn(migrated?.config?.balance ?? {}, "providerId") &&
		!Object.hasOwn(migrated?.config ?? {}, "narratorBalances"));
	check("迁移：旧 method/headers 不再保留", !Object.hasOwn(migrated?.config?.balance?.custom ?? {}, "method") && !Object.hasOwn(migrated?.config?.balance?.custom ?? {}, "headers"));
	const migrationText = (migrated?.warnings ?? []).join("|");
	check("迁移：明确警告来源/服务商/请求方法/请求头", ["版本 2", "来源选择", "内置服务商", "请求方法", "请求头"].every((text) => migrationText.includes(text)), migrationText);
	check("迁移：未保存前存储仍是旧记录", storage.get("global/pet.config")?.version === 1);
	const migratedSave = outputOf(await invoke("pet-config-set", { patch: { count: 1 } }));
	check("迁移：保存后 version 2 持久且警告消失", storage.get("global/pet.config")?.version === 2 && (migratedSave?.warnings ?? []).length === 0, JSON.stringify(migratedSave?.warnings));

	/* -- 5. writes are clamped, not rejected ---------------------------- */
	const clamped = await invoke("pet-config-set", { patch: { count: 99, scale: 9, gravity: -3 } });
	const clampedConfig = outputOf(clamped)?.config;
	check("pet-config-set：count 夹到 6", clampedConfig?.count === 6, String(clampedConfig?.count));
	check("pet-config-set：scale 夹到 3", clampedConfig?.scale === 3, String(clampedConfig?.scale));
	check("pet-config-set：gravity 夹到 0", clampedConfig?.gravity === 0, String(clampedConfig?.gravity));
	check("pet-config-set：返回夹取说明", (outputOf(clamped)?.warnings ?? []).length > 0, JSON.stringify(outputOf(clamped)?.warnings));

	const loud = await invoke("pet-config-set", { patch: { sound: { volume: 4 } } });
	check("pet-config-set：sound.volume 夹到 1", outputOf(loud)?.config?.sound?.volume === 1, String(outputOf(loud)?.config?.sound?.volume));
	const muted = await invoke("pet-config-set", { patch: { sound: { enabled: false } } });
	check("pet-config-set：显式关闭音效被保留且不动音量", outputOf(muted)?.config?.sound?.enabled === false && outputOf(muted).config.sound.volume === 1);

	const allOff = await invoke("pet-config-set", { patch: { animationGroups: Object.fromEntries(["idle", "turn", "drag", "click", "move", "small", "play", "eat", "season", "text"].map((group) => [group, false])) } });
	check("pet-config-set：全关动画后强制保留 idle", outputOf(allOff)?.config?.animationGroups?.idle === true);
	const bubbleConfig = outputOf(await invoke("pet-config-set", { patch: { bubbles: { scale: 9, durationMs: 0, noticeDurationMs: 0, clickMode: "home",
		overrides: [{ id: "example.safe", text: "<b>普通文字</b>", weight: 500 }] }, tasks: { enabled: false, narratorId: "must-not-persist" } } }))?.config;
	check("config：保持型气泡与home点击模式", bubbleConfig?.bubbles?.durationMs === 0 && bubbleConfig.bubbles.noticeDurationMs === 0 && bubbleConfig.bubbles.clickMode === "home");
	check("config：覆盖仅纯文本并约束范围", bubbleConfig?.bubbles?.scale === 1.4 && bubbleConfig.bubbles.overrides[0]?.text === "普通文字" && bubbleConfig.bubbles.overrides[0]?.weight === 100);
	check("config：任务关联不进入全局配置", bubbleConfig?.tasks?.enabled === false && !JSON.stringify(bubbleConfig).includes("must-not-persist"));
	check("config：预警默认关闭", bubbleConfig?.alerts?.enabled === false);
	await invoke("pet-config-set", { patch: { balance: { custom: { url: "", totalPath: "", usedPath: "", currency: "POINTS" } }, count: 1 } });

	/* -- 6. no configuration: explicit message, no invented state -------- */
	const unconfiguredState = outputOf(await invoke("pet-state"));
	check("pet-state：带 version/config/ledger/activeAccountIds", unconfiguredState?.version === PLUGIN_VERSION && Boolean(unconfiguredState?.config) &&
		Boolean(unconfiguredState?.ledger) && Array.isArray(unconfiguredState?.activeAccountIds));
	check("pet-state：无配置时明确提示且不含旧宿主投影", unconfiguredState?.balance?.ok === false && unconfiguredState.balance.error?.kind === "not_configured" &&
		!Object.hasOwn(unconfiguredState, "hostProviders") && !Object.hasOwn(unconfiguredState, "hostProvidersStatus"));
	check("pet-state：无配置不伪造余额账户", unconfiguredState?.balance?.accounts?.length === 0 && unconfiguredState.activeAccountIds.length === 0);
	check("pet-state：无配置不写余额快照", !storage.has("global/balance.snapshot"));
	check("pet-balance-refresh：refresh 只接受 force", (await invoke("pet-balance-refresh", { providerId: "custom" })).error?.code === INVALID &&
		(await invoke("pet-balance-refresh", { force: "yes" })).error?.code === INVALID &&
		(await invoke("pet-balance-refresh", { extra: 1 })).error?.code === INVALID);

	/* -- 7. points: single account, no derived percentage ---------------- */
	const refusedHttp = await invoke("pet-config-set", { patch: { balance: { custom: { url: "http://balance.test/ok", totalPath: "data.remaining" } } } });
	check("config：http URL 被拒绝并警告", outputOf(refusedHttp)?.config?.balance?.custom?.url === "" && (outputOf(refusedHttp)?.warnings ?? []).some((text) => text.includes("HTTPS")));
	await setBalance({ url: "https://balance.test/ok", totalPath: "data.remaining", usedPath: "", currency: "POINTS" });
	secrets.delete("customApiKey");
	const missingKey = await refresh(true);
	check("pet-balance-refresh：缺密钥 → missing_secret", missingKey?.snapshot?.error?.kind === "missing_secret", JSON.stringify(missingKey?.snapshot?.error));
	check("pet-balance-refresh：缺密钥也保存尝试快照", storage.has("global/balance.snapshot"));

	secrets.set("customApiKey", BASE_KEY);
	const points = await refresh(true);
	const pointsSnapshot = points?.snapshot;
	const pointsAccountId = points?.activeAccountIds?.[0];
	check("余额：GET+Bearer+redirect:error+Accept 通过 mock 校验", pointsSnapshot?.ok === true, JSON.stringify(pointsSnapshot?.error));
	check("余额：剩余金额与单位", pointsSnapshot?.accounts?.length === 1 && pointsSnapshot.accounts[0].remaining === 10 && pointsSnapshot.accounts[0].currency === "POINTS");
	check("余额：未提供 used 时百分比未知而不是 0", pointsSnapshot?.percent === null && pointsSnapshot.accounts[0].percent === null);
	check("余额：公共账户不含 key 指纹/内部身份/label", !Object.hasOwn(pointsSnapshot.accounts[0], "keyFingerprint") && !Object.hasOwn(pointsSnapshot.accounts[0], "providerId") &&
		!Object.hasOwn(pointsSnapshot.accounts[0], "label") && !JSON.stringify(points).includes(BASE_KEY));
	check("余额：返回 activeAccountIds 与账本", Array.isArray(points.activeAccountIds) && points.activeAccountIds.length === 1 &&
		points.ledger?.accounts?.length === 1 && points.ledger.accounts[0].accountId === points.activeAccountIds[0]);
	check("余额：points 不是货币消费", points.ledger.accounts[0].eligible === false && points.ledger.accounts[0].estimatedSpend === null);
	const cached = await refresh(false);
	check("余额：刷新周期内命中缓存", cached?.cached === true, JSON.stringify(cached?.cached));

	/* -- 8. money: quota ratio, spend accounting, ledger ----------------- */
	await setBalance({ url: "https://balance.test/money-var", totalPath: "data.remaining", usedPath: "data.used", currency: "USD" });
	const money = await refresh(true);
	const moneyAccountId = money?.activeAccountIds?.[0];
	check("余额：used 有效时按 remaining+used 计算真实额度", money?.snapshot?.percent === 75 && money.snapshot.accounts[0].remaining === 10 && money.snapshot.accounts[0].total === 40);
	check("余额：money 账户可记账", money?.ledger?.accounts?.[0]?.eligible === true);
	await delay(10);
	const moneySpent = await refresh(true);
	check("余额：同一账户记录观测消费", moneySpent?.ledger?.accounts?.[0]?.observedSpend === "2.00000000", moneySpent?.ledger?.accounts?.[0]?.observedSpend);
	check("余额：同一 endpoint 的账户身份稳定", moneySpent.activeAccountIds[0] === moneyAccountId);
	check("余额：已用比例随新样本更新", moneySpent.snapshot.percent === 80 && moneySpent.snapshot.accounts[0].remaining === 8);
	const currentLedger = moneySpent.activeAccountIds[0];

	const ledgerRead = outputOf(await invoke("pet-ledger-get", { audit: true }))?.ledger;
	check("ledger-get：只返回当前API账户", ledgerRead?.status === "ready" && ledgerRead.accounts.length === 1 && ledgerRead.accounts[0].accountId === currentLedger);
	const storedAccounts = storage.get("global/pet.accounting.v1")?.accounts ?? [];
	check("ledger-get：历史账户仍保存在存储中", storedAccounts.some((account) => account.accountId === pointsAccountId) &&
		storedAccounts.some((account) => account.accountId === currentLedger), String(storedAccounts.length));
	check("ledger-get：拒绝未知字段/非整数days", (await invoke("pet-ledger-get", { extra: true })).error?.code === INVALID &&
		(await invoke("pet-ledger-get", { days: "31" })).error?.code === INVALID);
	check("ledger-get：旧账户无法按 accountId 读取", outputOf(await invoke("pet-ledger-get", { accountId: pointsAccountId }))?.ledger?.accounts?.length === 0);
	check("ledger-correct：旧账户校正被拒绝", (await invoke("pet-ledger-correct", { accountId: pointsAccountId, revision: ledgerRead.revision, confirmed: true,
		action: "set", confirmedTopUp: "1", nonUsageDebit: "0", note: "旧账户校正" })).error?.code === INVALID);

	const correction = { accountId: currentLedger, revision: ledgerRead.revision, confirmed: true, action: "set", confirmedTopUp: "5", nonUsageDebit: "1", note: "本地回归校正" };
	check("ledger-correct：必须明确确认", (await invoke("pet-ledger-correct", { ...correction, confirmed: false })).error?.code === INVALID);
	const corrected = outputOf(await invoke("pet-ledger-correct", correction));
	check("ledger-correct：累计到账减非调用扣减", corrected?.ledger?.accounts[0]?.correctedSpend === "6.00000000", corrected?.ledger?.accounts[0]?.correctedSpend);
	check("ledger-correct：过期revision冲突", (await invoke("pet-ledger-correct", correction)).error?.data?.cause === "REVISION_CONFLICT");
	const undo = outputOf(await invoke("pet-ledger-correct", { accountId: currentLedger, revision: corrected.ledger.revision, confirmed: true,
		action: "undo", correctionId: corrected.correctionId, note: "撤销回归校正" }));
	check("ledger-correct：撤销恢复未确认状态", undo?.ledger?.accounts[0]?.confirmedTopUp === null && undo.ledger.accounts[0].audit.length === 2);
	const preserved = JSON.stringify(storage.get("global/pet.accounting.v1"));
	failNextStorageKey = "pet.accounting.v1";
	const rejectedWrite = await invoke("pet-ledger-correct", { ...correction, revision: undo.ledger.revision });
	check("ledger-correct：写失败不报成功且完整回滚", Boolean(rejectedWrite.error) && JSON.stringify(storage.get("global/pet.accounting.v1")) === preserved);
	storage.set("global/pet.accounting.v1", { schemaVersion: 999, valuable: "preserve me" });
	const corrupt = outputOf(await invoke("pet-ledger-get"));
	await invoke("pet-ledger-correct", correction);
	check("ledger：损坏状态可读且绝不覆盖原记录", corrupt?.ledger?.status === "corrupt" && storage.get("global/pet.accounting.v1")?.valuable === "preserve me");
	storage.set("global/pet.accounting.v1", JSON.parse(preserved));

	/* -- 9. notices are scoped to the current API ----------------------- */
	await invoke("pet-config-set", { patch: { alerts: { enabled: true, rules: [
		{ id: "test.balance", enabled: true, accountId: currentLedger, currency: "USD", kind: "balance", threshold: "9", hysteresis: "1", version: 1 },
	] } } });
	const fired = await refresh(true);
	check("预警：当前账户低于阈值生成通知", fired?.snapshot?.ok === true && storage.get("global/pet.accounting.v1")?.notices?.length === 1,
		String(storage.get("global/pet.accounting.v1")?.notices?.length));
	const malformedClaims = await Promise.all([
		invoke("pet-notices", {}),
		invoke("pet-notices", { action: "claim", consumerId: "bad-duplicate", accountIds: [currentLedger, currentLedger] }),
		invoke("pet-notices", { action: "claim", consumerId: "bad-id", accountIds: ["raw-key"] }),
		invoke("pet-notices", { action: "claim", consumerId: "too-many", accountIds: Array.from({ length: 33 }, (_, index) => `acct_${String(index).padStart(40, "0")}`) }),
		invoke("pet-notices", { action: "ack", consumerId: "bad-ack", id: "notice", leaseToken: "token", accountIds: [currentLedger] }),
	]);
	check("notices：严格拒绝缺参数/重复/非法/超限", malformedClaims.every((response) => response.error?.code === INVALID), malformedClaims.map((response) => response.error?.code).join(","));
	await setBalance({ url: "https://balance.test/dropped", totalPath: "data.remaining", usedPath: "", currency: "USD" });
	const switched = await refresh(true);
	const foreignClaim = outputOf(await invoke("pet-notices", { action: "claim", consumerId: "filtered-view", limit: 5 }));
	check("notices：切换到新API后旧账户通知不被领取", switched.activeAccountIds[0] !== currentLedger && foreignClaim?.notices?.length === 0,
		JSON.stringify(foreignClaim?.notices?.map((notice) => notice.accountId)));
	await setBalance({ url: "https://balance.test/money-var", totalPath: "data.remaining", usedPath: "data.used", currency: "USD" });
	await refresh(true);
	const claim = outputOf(await invoke("pet-notices", { action: "claim", consumerId: "filtered-view", limit: 5 }))?.notices ?? [];
	check("notices：切回原API后旧账户通知仍可领取", claim.length === 1 && claim[0].accountId === currentLedger);
	if (claim[0]) {
		check("notices：错误租约不能确认", outputOf(await invoke("pet-notices", { action: "ack", consumerId: "filtered-view", id: claim[0].id, leaseToken: "wrong" }))?.acked === false);
		check("notices：展示后确认持久成功", outputOf(await invoke("pet-notices", { action: "ack", consumerId: "filtered-view", id: claim[0].id, leaseToken: claim[0].leaseToken }))?.acked === true);
	}
	check("notices：已确认提醒不再领取", outputOf(await invoke("pet-notices", { action: "claim", consumerId: "view-c" }))?.notices?.length === 0);
	await invoke("pet-config-set", { patch: { alerts: { enabled: false, rules: [] } } });

	/* -- 10. failure classifications: no zero, no leakage ---------------- */
	const cases = [
		["/401", "auth_failed"], ["/403", "auth_failed"], ["/500", "http"], ["/redirect", "redirect"],
		["/invalid", "shape_mismatch"], ["/unknown", "shape_mismatch"], ["/null", "shape_mismatch"], ["/big", "response_too_large"],
	];
	for (const [route, kind] of cases) {
		await setBalance({ url: `https://balance.test${route}`, totalPath: "data.remaining", usedPath: "", currency: "USD" });
		const failed = await refresh(true);
		check(`失败分类 ${route} → ${kind}`, failed?.snapshot?.error?.kind === kind, JSON.stringify(failed?.snapshot?.error));
		check(`失败 ${route}：不伪造余额/百分比`, failed?.snapshot?.accounts?.length === 0 && failed.snapshot.percent === null);
		check(`失败 ${route}：错误不含URL/密钥`, !JSON.stringify(failed?.snapshot).includes("balance.test") && !JSON.stringify(failed?.snapshot).includes(BASE_KEY));
	}
	await setBalance({ url: "https://balance.test/zero", totalPath: "data.remaining", usedPath: "", currency: "POINTS" });
	const zero = await refresh(true);
	check("余额：真实 0 被保留且 points 无百分比", zero?.snapshot?.ok === true && zero.snapshot.accounts[0].remaining === 0 && zero.snapshot.percent === null);
	check("余额：0 写入八位定点", zero?.ledger?.accounts?.[0]?.balance === "0.00000000", zero?.ledger?.accounts?.[0]?.balance);
	await setBalance({ url: "https://balance.test/negative", totalPath: "data.remaining", usedPath: "", currency: "USD" });
	const negative = await refresh(true);
	check("余额：负余额保留而不是报错", negative?.snapshot?.ok === true && negative.snapshot.accounts[0].remaining === -2.5);

	/* -- 11. one endpoint's failure keeps its own last success ----------- */
	await setBalance({ url: "https://balance.test/ok", totalPath: "data.remaining", usedPath: "", currency: "USD" });
	const good = await refresh(true);
	await setBalance({ url: "https://balance.test/401", totalPath: "data.remaining", usedPath: "", currency: "USD" });
	const badAfterGood = await refresh(true);
	check("失败：不同 endpoint 不继承之前的余额", badAfterGood?.snapshot?.accounts?.length === 0 && badAfterGood.snapshot.error.kind === "auth_failed");
	await setBalance({ url: "https://balance.test/ok", totalPath: "data.remaining", usedPath: "", currency: "USD" });
	const again = await refresh(false);
	check("失败：切回原 endpoint 仍可用原上下文", again?.snapshot?.ok === true && again.snapshot.accounts[0].accountId === good.snapshot.accounts[0].accountId);

	secrets.delete("customApiKey");
	const removed = await refresh(true);
	check("失败：密钥移除保留同endpoint最后成功余额并标旧", removed?.snapshot?.error?.kind === "missing_secret" &&
		removed.snapshot.ok === false && removed.snapshot.accounts[0]?.remaining === 10 && removed.snapshot.accounts[0].stale === true,
		JSON.stringify({ kind: removed?.snapshot?.error?.kind, accounts: removed?.snapshot?.accounts?.length }));
	check("失败：密钥移除时无法确认账户身份", removed.activeAccountIds.length === 0);
	secrets.set("customApiKey", "selftest-key-two");
	await setBalance({ url: "https://balance.test/ok", totalPath: "data.remaining", usedPath: "", currency: "POINTS" });
	const replaced = await refresh(true);
	check("失败：换密钥后从未成功不得沿用旧余额", replaced?.snapshot?.accounts?.length === 0 && replaced.snapshot.error.kind === "auth_failed");
	check("失败：换密钥后账户身份随密钥变化", replaced.activeAccountIds.length === 1 && replaced.activeAccountIds[0] !== good.activeAccountIds[0]);
	secrets.set("customApiKey", BASE_KEY);

	/* -- 12. concurrent refreshes cannot cross contexts ------------------ */
	await setBalance({ url: "https://balance.test/ok", totalPath: "data.remaining", usedPath: "", currency: "USD" });
	const firstRefresh = invoke("pet-balance-refresh", { force: true });
	await setBalance({ url: "https://balance.test/dropped", totalPath: "data.remaining", usedPath: "", currency: "USD" });
	const secondRefresh = invoke("pet-balance-refresh", { force: true });
	const [firstOut, secondOut] = (await Promise.all([firstRefresh, secondRefresh])).map(outputOf);
	const snapshots = [firstOut?.snapshot, secondOut?.snapshot].filter(Boolean);
	const remainingByKey = new Map(snapshots.map((snapshot) => [snapshot.configKey, snapshot.accounts[0]?.remaining]));
	check("并发：每次刷新快照与自身配置一致", snapshots.length === 2 && snapshots.every((snapshot) => snapshot.accounts[0]?.remaining === remainingByKey.get(snapshot.configKey)) &&
		remainingByKey.size === 2, JSON.stringify([...remainingByKey.values()]));
	check("并发：存储中的快照是最后完成的一次", storage.get("global/balance.snapshot")?.configKey === (secondOut?.snapshot?.configKey ?? firstOut?.snapshot?.configKey));

	/* -- 13. secrets: only the one key, old vault keys untouched --------- */
	secrets.set("deepseekApiKey", "legacy-deepseek-canary");
	secrets.set("opencodeZenApiKey", "legacy-opencode-canary");
	const secretList = outputOf(await invoke("pet-secrets-list"));
	check("pet-secrets-list：只列 customApiKey", JSON.stringify(secretList?.keys?.map((entry) => entry.key)) === JSON.stringify(["customApiKey"]), JSON.stringify(secretList));
	check("pet-secrets-list：报告已配置但不回显值", secretList?.keys?.[0]?.configured === true && !JSON.stringify(secretList).includes(BASE_KEY));
	check("pet-secrets-list：旧 vault key 不删除也不列出", secrets.get("deepseekApiKey") === "legacy-deepseek-canary" &&
		secrets.get("opencodeZenApiKey") === "legacy-opencode-canary" && !JSON.stringify(secretList).includes("deepseekApiKey"));

	/* -- 14. logging and clip bytes ------------------------------------- */
	const logged = await invoke("pet-log", { level: "warn", message: "selftest marker", detail: { from: "selftest" } });
	check("pet-log：返回 ok", outputOf(logged)?.ok === true);
	await delay(120);
	check("pet-log：落到 stderr", stderrLines.some((line) => line.includes("selftest marker")), String(stderrLines.length));

	const clipFile = path.join(PLUGIN_DIR, "anim", "webp", "000.webp");
	const clipSize = fs.statSync(clipFile).size;
	const headChunk = outputOf(await invoke("pet-clip", { index: 0 }));
	check("pet-clip：返回第一片", typeof headChunk?.data === "string" && headChunk.data.length > 0);
	check("pet-clip：total 等于文件大小", headChunk?.total === clipSize, `${headChunk?.total} vs ${clipSize}`);
	const headBytes = Buffer.from(headChunk?.data ?? "", "base64");
	check("pet-clip：单片不超过 512 KiB", headBytes.byteLength <= 512 * 1024, String(headBytes.byteLength));
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
	check("pet-clip：越界 index 结构化报错", outOfRange.error?.code === INVALID, JSON.stringify(outOfRange.error));

	/* -- 15. timeout: the real 6s deadline ------------------------------ */
	await setBalance({ url: "https://balance.test/slow", totalPath: "data.remaining", usedPath: "", currency: "USD" });
	const started = Date.now();
	const timedOut = await refresh(true, 25_000);
	const elapsed = Date.now() - started;
	check("余额：请求超时按 network/timeout 分类", timedOut?.snapshot?.error?.kind === "timeout", JSON.stringify(timedOut?.snapshot?.error));
	check("余额：超时发生在 6 秒截止时间", elapsed >= 5_500 && elapsed < 9_000, String(elapsed));

	/* -- 16. protocol errors, reset, shutdown --------------------------- */
	const unknownCommand = await invoke("pet-does-not-exist");
	check("未知命令贡献 → INVALID_PARAMS", unknownCommand.error?.code === INVALID, JSON.stringify(unknownCommand.error));
	const unknownMethod = await request("does.not.exist", {});
	check("未知方法 → METHOD_NOT_FOUND", unknownMethod.error?.code === -32601, JSON.stringify(unknownMethod.error));

	const reset = await invoke("pet-config-set", { reset: true });
	check("pet-config-set：reset 恢复默认", outputOf(reset)?.config?.count === 1 && outputOf(reset).config.balance.custom.url === "" && outputOf(reset).config.balance.custom.currency === "POINTS");

	const shutdown = await request("shutdown");
	check("shutdown：返回 shutdown:true", shutdown.result?.shutdown === true, JSON.stringify(shutdown.result));
	const exitCode = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000))]);
	check("shutdown：进程自行退出", exitCode === 0, String(exitCode));

	/* -- report --------------------------------------------------------- */
	process.stdout.write(`\n[selftest] ${passed} 通过，${failures.length} 失败\n`);
	if (failures.length > 0) {
		for (const failure of failures) process.stdout.write(`  ✕ ${failure}\n`);
		process.exitCode = 1;
	}
	try { fs.unlinkSync(MOCK_FILE); } catch { /* temp file */ }
}

main().catch((error) => {
	process.stdout.write(`\n[selftest] 崩溃：${error?.stack ?? error}\n`);
	process.stdout.write(`[selftest] stderr 摘要：\n${stderrLines.slice(-10).join("\n")}\n`);
	child.kill();
	try { fs.unlinkSync(MOCK_FILE); } catch { /* temp file */ }
	process.exitCode = 1;
});
