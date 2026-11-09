/**
 * Plugin entry point.
 *
 * This file is the only place that knows both halves: it turns the transport's
 * `commands.invoke` into a dispatch table over the manifest's command ids, and it
 * is where every handler is wrapped so that one broken command cannot take the
 * runtime down. Everything below it (`rpc.js`, `config.js`, `balance/*`) is
 * transport-, settings- or provider-shaped and knows nothing about the others.
 *
 * THE UI ↔ BACKEND CONTRACT, IN ONE PLACE
 * A plugin view can only reach its own backend through `commands.execute(<id>)`
 * (`PluginCommandRegistry.find(commandId, pluginId)`), and the reply must be a
 * `commandsInvokeResult`-shaped object — only `output` reaches the iframe.
 * So `HANDLERS` below is the complete surface: seven ids, no dynamic
 * registration, no callback the host could call out of band.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { log, installCrashHandlers } from "./log.js";
import { createRpc, ERROR_CODES, RpcError } from "./rpc.js";
import { resolveHostHome } from "./host-home.js";
import {
	CONFIG_SCOPE,
	DEFAULT_CONFIG,
	CONFIG_KEY,
	mergeConfig,
	readConfig,
	sanitizeConfig,
	writeConfig,
} from "./config.js";
import { readSnapshot, refreshBalance } from "./balance/index.js";
import { providerCatalogue } from "./balance/providers.js";

const PLUGIN_ID = "cn.mcd7.neglectdream.dsh-pet";
const PLUGIN_VERSION = "2.0.0";
const PACKAGE_DIGEST = process.env.NF_PLUGIN_PACKAGE_DIGEST;

/**
 * How much of one clip travels per `pet-clip` call.
 *
 * Two hard ceilings bound this: the JSON-RPC frame limit is 1 MiB in both
 * directions, and base64 inflates by 4/3 — so 512 KiB of payload becomes ~683 KB
 * on the wire, leaving room for the envelope. Bigger chunks would fail to frame;
 * smaller ones just add round trips for a 1.5 MB clip.
 */
const CLIP_CHUNK_BYTES = 512 * 1024;


installCrashHandlers();

/* -------------------------------------------------------------------------- */
/* UI report sink                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Persist what the panel reports about itself.
 *
 * A plugin iframe is an opaque origin with no console the user can open, and the
 * host keeps backend stderr in an in-memory ring buffer — so when the panel says
 * "nothing is drawn", the evidence exists only inside that frame. The panel
 * therefore pushes its own diagnostic snapshot here, and this sink writes it to a
 * file under the plugin's data directory where it can simply be read afterwards.
 *
 * It is deliberately a log, not state: capped, appended, never read back by the
 * plugin, and its absence is meaningless.
 */
const UI_REPORT_FILE = "ui-report.log";
const UI_REPORT_MAX_BYTES = 256 * 1024;

let uiReportFilePromise;
function uiReportFile() {
	uiReportFilePromise ??= (async () => {
		const home = await resolveHostHome();
		if (!home) return undefined;
		const directory = path.join(home, "plugins", "data", PLUGIN_ID);
		await fs.mkdir(directory, { recursive: true });
		return path.join(directory, UI_REPORT_FILE);
	})().catch(() => undefined);
	return uiReportFilePromise;
}

async function appendUiReport(level, message, detail) {
	try {
		const file = await uiReportFile();
		if (!file) return;
		await fs.appendFile(file, `${JSON.stringify({ ts: new Date().toISOString(), level, message, detail })}\n`, "utf8");
		const stat = await fs.stat(file);
		if (stat.size > UI_REPORT_MAX_BYTES) {
			// Keep the tail: the newest report is the one that matters, and a log that
			// grows without bound inside the host's data directory is rude.
			const text = await fs.readFile(file, "utf8");
			await fs.writeFile(file, text.slice(-Math.floor(UI_REPORT_MAX_BYTES / 2)), "utf8");
		}
	} catch {
		// Diagnostics must never be the thing that fails.
	}
}

/** The dispatch table. Key = manifest `commands[].id`, value = handler. */
const HANDLERS = {
	"pet-state": ({ callHost, signal }) => readState({ callHost, signal }),

	"pet-config-get": async ({ callHost }) => {
		const { config, warnings, stored } = await readConfig(callHost);
		return { config, warnings, stored };
	},

	"pet-config-set": async ({ callHost, input }) => {
		const patch = input && typeof input === "object" ? input : {};
		// `reset: true` is the "restore defaults" button. It rewrites the stored config
		// rather than deleting the key, so a failed write is visible instead of looking
		// like a successful reset that silently came back from defaults on read.
		const base = patch.reset === true ? DEFAULT_CONFIG : (await readConfig(callHost)).config;
		const merged = patch.reset === true ? { ...DEFAULT_CONFIG } : mergeConfig(base, patch.patch ?? {});
		const { config, warnings } = sanitizeConfig(merged);
		await writeConfig(callHost, config);
		log.info("config updated", {
			keys: Object.keys(patch.patch ?? {}),
			reset: patch.reset === true,
		});
		return { config, warnings };
	},

	"pet-balance-refresh": async ({ callHost, input, signal }) => {
		const { config } = await readConfig(callHost);
		const providerId = typeof input?.providerId === "string" ? input.providerId : undefined;
		const force = input?.force !== false;
		const result = await refreshBalance({ callHost, config, providerId, signal, force });
		return {
			snapshot: result.snapshot,
			cached: result.cached === true,
			skipped: result.skipped,
		};
	},

	"pet-clip": async ({ input }) => {
		// Clip bytes come through the command channel rather than the asset route.
		//
		// `PluginUiAssetService.readAsset` only serves paths the manifest declares
		// (`ui.entry`, each view's `entry`/`style`, theme images): an undeclared file
		// under the same asset prefix is a 404, which a browser reports as "The source
		// image cannot be decoded" with nothing to say about why. So the 114 clips —
		// which cannot be declared without inventing a hundred fake views — are read
		// here, a chunk at a time, and the UI assembles them into Blob URLs.
		const index = Number(input?.index);
		if (!Number.isInteger(index) || index < 0 || index > 999) {
			throw new RpcError(ERROR_CODES.INVALID_PARAMS, "pet-clip 需要合法的 index", {
				code: "INVALID_PARAMS",
			});
		}
		const offset = Number.isInteger(input?.offset) && input.offset > 0 ? input.offset : 0;
		const requested = Number.isInteger(input?.length) ? input.length : CLIP_CHUNK_BYTES;
		const length = Math.min(Math.max(requested, 1), CLIP_CHUNK_BYTES);
		const file = path.join(process.cwd(), "anim", "webp", `${String(index).padStart(3, "0")}.webp`);
		let bytes;
		try {
			bytes = await fs.readFile(file);
		} catch (error) {
			throw new RpcError(ERROR_CODES.INVALID_PARAMS, `读取动画 ${index} 失败：${error?.code ?? error}`, {
				code: "INVALID_PARAMS",
			});
		}
		const slice = bytes.subarray(offset, offset + length);
		return {
			index,
			offset,
			total: bytes.byteLength,
			// base64 rather than an ArrayBuffer: the RPC framing is JSON, and the same
			// value then survives the second hop (host → iframe) unchanged.
			data: slice.toString("base64"),
			done: offset + slice.byteLength >= bytes.byteLength,
		};
	},

	"pet-balance-providers": async () => ({
		// Two sources, not four providers: the default reuses the host's own
		// relay-station balance, and the manual list is the fallback for services the
		// host does not track.
		sources: [
			{
				id: "host",
				label: "跟随 NarraFork 中转站余额",
				description: "直接读取宿主已经查到的中转站余额，无需再填一次密钥。",
			},
			{
				id: "manual",
				label: "手动配置服务商",
				description: "由本插件自己请求某个服务商的余额接口，需要单独填 API Key。",
			},
		],
		providers: providerCatalogue(),
	}),

	"pet-secrets-list": async ({ callHost }) => {
		// Two sources of truth on purpose: which keys exist (the vault's own list) and
		// which keys the plugin knows how to use (the provider catalogue). The settings
		// panel needs the union, so a key the user set for a provider that has since
		// been removed still shows up and can be cleared.
		const configured = new Set();
		try {
			const listed = await callHost("secrets.list", {});
			for (const entry of listed?.secrets ?? []) {
				if (typeof entry?.key === "string") configured.add(entry.key);
			}
		} catch (error) {
			log.warn("secrets.list failed", error);
		}
		const known = providerCatalogue().map((provider) => provider.secretKey);
		const keys = [...new Set([...known, ...configured])].map((key) => ({
			key,
			configured: configured.has(key),
			known: known.includes(key),
		}));
		return { keys };
	},

	"pet-log": async ({ input }) => {
		const level = ["info", "warn", "error"].includes(input?.level) ? input.level : "info";
		const message = typeof input?.message === "string" ? input.message.slice(0, 2000) : "(empty)";
		const detail = input?.detail === undefined ? undefined : { source: "ui", ...input.detail };
		log[level](`ui: ${message}`, detail);
		// Fire and forget, and never awaited: the panel's logging must not be able to
		// make a command slow or fail.
		void appendUiReport(level, message, detail);
		return { ok: true };
	},
};

/**
 * The single snapshot the stage polls.
 *
 * Config and balance travel together because the stage cannot act on one without
 * the other: `animationGroups` decides which clips are playable and the balance
 * tier decides which of them is *wanted*. Two calls would double the polling and
 * let the two halves disagree for a frame.
 */
async function readState({ callHost, signal }) {
	const { config, warnings, stored } = await readConfig(callHost);
	// `host` needs no provider id: it reads whatever the host already cached. Only
	// the manual path can be "not configured".
	const balanceEnabled =
		config.balance.source === "host" ? true : Boolean(config.balance.providerId);
	const balance = balanceEnabled ? await readSnapshot(callHost) : null;

	// Opportunistic refresh: no background timer exists in this process (a plugin
	// that sleeps on a `setInterval` holds a lease it does not need), so the poll
	// that the visible stage already performs is what keeps the number current.
	let refreshed = balance;
	if (balanceEnabled && !signal?.aborted) {
		const ageMs = balance?.fetchedAt ? Date.now() - Date.parse(balance.fetchedAt) : Number.POSITIVE_INFINITY;
		const stale =
			!(ageMs >= 0 && ageMs < config.balance.refreshMinutes * 60_000) ||
			balance?.source !== config.balance.source;
		if (stale) {
			const result = await refreshBalance({
				callHost,
				config,
				providerId: config.balance.providerId,
				signal,
				force: false,
			});
			refreshed = result.snapshot ?? balance;
		}
	}

	return {
		version: PLUGIN_VERSION,
		config,
		configWarnings: warnings,
		configStored: stored,
		balance: refreshed,
		defaults: { config: DEFAULT_CONFIG, configKey: CONFIG_KEY, configScope: CONFIG_SCOPE },
	};
}

const rpc = createRpc({
	pluginId: PLUGIN_ID,
	version: PLUGIN_VERSION,
	packageDigest: PACKAGE_DIGEST,
	handlers: {
		methods: {
			"commands.invoke": async (params, { signal }) => {
				const contributionId = params?.contributionId;
				if (typeof contributionId !== "string" || contributionId.length === 0) {
					throw new RpcError(ERROR_CODES.INVALID_PARAMS, "commands.invoke requires contributionId", {
						code: "INVALID_PARAMS",
					});
				}
				const handler = HANDLERS[contributionId];
				if (!handler) {
					throw new RpcError(ERROR_CODES.INVALID_PARAMS, `Unknown command contribution: ${contributionId}`, {
						code: "INVALID_PARAMS",
					});
				}
				try {
					const output = await handler({
						input: params?.input,
						callHost: rpc.callHost,
						signal,
						context: params?.context,
					});
					return { output: output ?? null };
				} catch (error) {
					// A handler failure is reported with its REAL reason attached.
					//
					// The first version of this replaced every cause with "命令执行失败：
					// <id>", on the theory that internal detail should not leak to an iframe.
					// In practice the detail is the only thing that makes a failure
					// diagnosable: a host-side rejection (`PERMISSION_DENIED`,
					// `PLUGIN_FEATURE_NOT_NEGOTIATED`, `STORAGE_SCOPE_OUTSIDE_BINDING`) is
					// not sensitive and is invisible from the panel otherwise — the operator
					// sees a dead settings page and no lead. The stack still goes to stderr
					// where the host's diagnostics keep it.
					//
					// A handler's own `RpcError` keeps its code: rewriting an explicit
					// `INVALID_PARAMS` into `INTERNAL_ERROR` makes a rejected argument look
					// like a crash, which is exactly the wrong signal for both the UI and
					// the selftest.
					log.error(`command ${contributionId} failed`, error);
					const reason = error instanceof RpcError ? error.message : String(error?.message ?? error);
					const code = error instanceof RpcError ? error.code : ERROR_CODES.INTERNAL_ERROR;
					const cause = error instanceof RpcError ? (error.data?.code ?? "INVALID_PARAMS") : "INTERNAL_ERROR";
					throw new RpcError(code, `${contributionId} 失败：${String(reason).slice(0, 300)}`, { cause });
				}
			},
		},
		onActivate: async () => {
			log.info(`activated v${PLUGIN_VERSION}`, { runtime: process.version });
		},
		onDeactivate: async () => {
			log.info("deactivated");
		},
		onShutdown: async () => {
			log.info("shutdown");
		},
	},
});

log.info(`starting v${PLUGIN_VERSION}`, { pid: process.pid });
rpc.start();
