/**
 * Balance orchestration: percent semantics, tier index, cache, error classes.
 *
 * THE ONE NUMBER THE PET NEEDS
 * Everything visual about balance reduces to `percent` — how much of the
 * allowance has been *used*, 0 meaning untouched and 100 meaning nothing left.
 * Turning a provider's raw response into that single number is what these shape
 * handlers do, and doing it here (not in the UI) keeps one copy of the rules:
 *
 *  - `money`   — an account balance. Each wallet is divided by its currency's
 *                reference amount, so several currencies can be averaged without
 *                inventing an exchange rate.
 *  - `windows` — rolling / weekly / monthly usage percentages. The worst window
 *                wins: an almost-exhausted 5-hour window matters even when the
 *                monthly allowance is untouched.
 *  - `points`  — a bare remaining count with no ceiling. This shape *cannot*
 *                produce a percentage, and deliberately returns `undefined`
 *                rather than scaling against a made-up maximum.
 *
 * RETRY LIVES IN THE POLLER, NOT IN THE REQUEST
 * dsh-pet retried inside the request with 1s/4s/16s backoff. Here every read is
 * triggered by a UI `commands.execute`, whose bridge timeout is 10 s
 * (`PLUGIN_UI_DEFAULT_TIMEOUT_MS`) — a 21-second backoff inside one command
 * would guarantee a timeout instead of a retry. So one call is one attempt, the
 * stage re-calls on its own schedule, and a failure is *reported* rather than
 * hidden. That is the same recovery behaviour with a much better failure mode.
 */

import { log } from "../log.js";
import { readHostBalanceSnapshot } from "./host.js";
import { findProvider } from "./providers.js";

export const BALANCE_KEY = "balance.snapshot";
export const BALANCE_SCOPE = { type: "global" };

/** One read attempt must finish well inside the UI bridge's 10 s ceiling. */
export const DEFAULT_DEADLINE_MS = 6000;

/** Tier boundaries are 20 % apart; index 5 is reserved for "exactly exhausted". */
export function balanceEventIndex(percent) {
	if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
	const clamped = Math.max(0, Math.min(100, percent));
	if (clamped === 100) return 5;
	const index = Math.floor(clamped / 20);
	return index < 5 ? index : 4;
}

function moneyPercent(data) {
	let remaining = 0;
	let based = 0;
	for (const wallet of data.wallets ?? []) {
		const total = Number(wallet.total);
		const full = Number(wallet.fullBalance);
		// A currency with no reference amount is skipped, not guessed. An overdrawn
		// wallet contributes a negative ratio, which is exactly right: it should pull
		// the result to "completely used".
		if (!Number.isFinite(total) || !Number.isFinite(full) || full <= 0) continue;
		remaining += total / full;
		based += 1;
	}
	if (based === 0) return undefined;
	return Math.max(0, Math.min(100, 100 - remaining * 100));
}

function windowsPercent(data) {
	const values = [data.rolling, data.weekly, data.monthly].filter(
		(value) => typeof value === "number" && Number.isFinite(value),
	);
	if (values.length === 0) return undefined;
	return Math.max(0, Math.min(100, Math.max(...values)));
}

function pointsPercent(data) {
	// No ceiling in the data means no percentage; see the module comment.
	if (typeof data.total === "number" && data.total > 0 && typeof data.remaining === "number") {
		return Math.max(0, Math.min(100, 100 - (data.remaining / data.total) * 100));
	}
	return undefined;
}

const SHAPES = {
	money: { percent: moneyPercent, summary: summarizeMoney },
	windows: { percent: windowsPercent, summary: summarizeWindows },
	points: { percent: pointsPercent, summary: summarizePoints },
};

function summarizeMoney(data) {
	const visible = (data.wallets ?? [])
		.filter((wallet) => Number(wallet.total) !== 0)
		.sort((a, b) => (a.currency === "CNY" ? 0 : 1) - (b.currency === "CNY" ? 0 : 1));
	const amount =
		visible.length > 0
			? visible.map((wallet) => (wallet.currency === "USD" ? "$" : "¥") + wallet.total).join(" / ")
			: "¥0.00";
	const tierLabel = data.tier === "peak" ? "峰" : data.tier === "idle" ? "谷" : undefined;
	return tierLabel ? `余额（${tierLabel}）${amount}` : `余额 ${amount}`;
}

function summarizeWindows(data) {
	const rows = [];
	if (typeof data.rolling === "number") rows.push(`${data.rollingLabel ?? "5h"} ${Math.round(data.rolling)}%`);
	if (typeof data.weekly === "number") rows.push(`周 ${Math.round(data.weekly)}%`);
	if (typeof data.monthly === "number") rows.push(`月 ${Math.round(data.monthly)}%`);
	return rows.length > 0 ? `已用 ${rows.join(" · ")}` : "用量未知";
}

function summarizePoints(data) {
	return typeof data.remaining === "number" ? `剩余 ${data.remaining}` : "余额未知";
}

/** Normalise a raw provider view into the small shape both backends and UI consume. */
export function describeView(view) {
	const handler = SHAPES[view.shape];
	if (!handler) return { shape: view.shape, percent: undefined, summary: "未知响应形态" };
	return {
		shape: view.shape,
		percent: handler.percent(view.data),
		summary: handler.summary(view.data),
	};
}

function classify(error) {
	if (error?.kind) return error.kind;
	const message = String(error?.message ?? "");
	if (message.includes("鉴权")) return "auth_failed";
	if (message.includes("超时") || message.includes("网络")) return "network";
	return "unknown";
}

/**
 * Read the cached snapshot.
 *
 * A snapshot is a cache of the *last attempt*, success or failure, so the stage
 * can render "auth failed" persistently instead of only for the one frame where
 * a request happened to be in flight.
 */
export async function readSnapshot(callHost) {
	const entry = await callHost("storage.get", { scope: BALANCE_SCOPE, key: BALANCE_KEY });
	const value = entry && typeof entry === "object" && "value" in entry ? entry.value : undefined;
	if (!value || typeof value !== "object") return null;
	return value;
}

async function writeSnapshot(callHost, snapshot) {
	await callHost("storage.set", { scope: BALANCE_SCOPE, key: BALANCE_KEY, value: snapshot });
	return snapshot;
}

/**
 * Query one balance source once and cache the outcome.
 *
 * Two sources, one output shape:
 *
 *  - `host`   — reuse the relay-station balance NarraFork already fetched and
 *               cached. Zero configuration, and it is the number the user is
 *               actually watching in the host UI.
 *  - `manual` — query a service directly with a key the user pasted. Needed for
 *               anything the host does not track (a DeepSeek official key, a
 *               bespoke endpoint).
 *
 * `providerId` may be omitted, in which case the configured provider is used. The
 * provider is resolved from *config*, never from the caller's parameters beyond
 * the id — so a UI cannot ask this backend to spend a secret on a service the
 * user has not configured.
 */
export async function refreshBalance({ callHost, config, providerId, signal, force = true }) {
	const snapshot = await readSnapshot(callHost);

	// A non-forced call reuses a snapshot younger than the configured interval,
	// which is what keeps a stage that polls every few seconds from hammering the
	// upstream API (and its rate limits).
	if (!force && snapshot?.fetchedAt && snapshot.source === config.balance.source) {
		const ageMs = Date.now() - Date.parse(snapshot.fetchedAt);
		if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < config.balance.refreshMinutes * 60_000) {
			return { snapshot, cached: true };
		}
	}

	if (config.balance.source === "host") {
		const host = await readHostBalanceSnapshot();
		if (!host.ok) {
			return {
				snapshot: await writeSnapshot(callHost, {
					source: "host",
					ok: false,
					error: host.error,
					fetchedAt: new Date().toISOString(),
				}),
			};
		}
		const written = await writeSnapshot(callHost, {
			...host,
			source: "host",
			tier: balanceEventIndex(host.percent),
		});
		return { snapshot: written };
	}

	const targetId = providerId ?? config.balance.providerId;
	if (!targetId) {
		return { snapshot: null, skipped: "not_configured" };
	}
	const provider = findProvider(targetId);
	if (!provider) {
		return {
			snapshot: await writeSnapshot(callHost, {
				source: "manual",
				providerId: targetId,
				ok: false,
				error: { kind: "unknown_provider", message: `未知服务商：${targetId}` },
				fetchedAt: new Date().toISOString(),
			}),
		};
	}

	let secret;
	try {
		const result = await callHost("secrets.get", { key: provider.secretKey });
		secret = typeof result?.value === "string" && result.value.length > 0 ? result.value : undefined;
	} catch (error) {
		log.warn("secrets.get failed", error);
		secret = undefined;
	}
	if (!secret) {
		return {
			snapshot: await writeSnapshot(callHost, {
				source: "manual",
				providerId: targetId,
				ok: false,
				error: { kind: "missing_secret", message: `未配置 ${provider.label} 的 API Key` },
				fetchedAt: new Date().toISOString(),
			}),
		};
	}

	const startedAt = Date.now();
	try {
		const view = await provider.fetch({
			key: secret,
			signal,
			deadlineMs: DEFAULT_DEADLINE_MS,
			custom: config.balance.custom,
		});
		const described = describeView(view);
		const written = await writeSnapshot(callHost, {
			source: "manual",
			providerId: targetId,
			label: provider.label,
			ok: true,
			shape: described.shape,
			percent: described.percent,
			summary: described.summary,
			tier: balanceEventIndex(described.percent),
			detail: view.data,
			elapsedMs: Date.now() - startedAt,
			fetchedAt: new Date().toISOString(),
		});
		return { snapshot: written };
	} catch (error) {
		// The message is kept verbatim: "HTTP 500" and "响应缺少 balance_infos" call
		// for very different user actions, and collapsing them into "查询失败" is how
		// a settings panel becomes useless.
		const kind = classify(error);
		log.warn(`balance ${targetId} failed`, `${kind}: ${error?.message ?? error}`);
		const written = await writeSnapshot(callHost, {
			source: "manual",
			providerId: targetId,
			label: provider.label,
			ok: false,
			error: { kind, message: String(error?.message ?? error) },
			elapsedMs: Date.now() - startedAt,
			fetchedAt: new Date().toISOString(),
		});
		return { snapshot: written };
	}
}
