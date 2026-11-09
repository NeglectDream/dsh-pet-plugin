/**
 * Balance from the host's own provider-balance subsystem.
 *
 * WHY THIS READS A FILE
 * NarraFork already knows the balance of the configured relay station: it probes
 * `sub2api` / `new-api` endpoints, normalises them into `ProviderBalanceData`, and
 * caches the result in `<narrafork home>/provider-balances.json`
 * (`server/lib/provider-balance-cache.ts` → `createPersistedCredentialCache`).
 * A plugin cannot ask for it: the public query surface is seven queries and none
 * of them is a balance, `config.get` returns only a plugin's *provider*
 * contribution config, and `secrets.get` is namespaced to the plugin's own keys —
 * so the relay's API key and base URL in `settings.json` are both out of reach.
 *
 * That leaves the cache file, which is the host's own published state on disk. It
 * is a deliberately narrow dependency:
 *
 *  - read-only, one file, no keys in it (the values are amounts and units);
 *  - every field is validated, and an unrecognised shape degrades to a readable
 *    "宿主余额不可用" instead of guessing;
 *  - nothing else in the plugin depends on it, so a host that renames the file or
 *    changes its schema costs the balance animation and nothing else.
 *
 * The alternative — asking the user to paste the same relay key a second time —
 * is what this replaces. The manual provider path still exists for services the
 * host does not track (for example a DeepSeek official API key).
 */

import fs from "node:fs/promises";
import path from "node:path";

import { resolveHostHome } from "../host-home.js";
import { log } from "../log.js";

/** The host writes `{ version: 1, salt, entries: { [providerId]: { value } } }`. */
const CACHE_FILE = "provider-balances.json";
const CACHE_VERSION = 1;

/**
 * Reference amounts used only for a bare wallet that reports a remaining amount
 * but no ceiling.
 *
 * A relay wallet ("$12.34 left") carries no notion of "how much is a lot", so a
 * percentage has to come from somewhere. These are the same references the
 * DeepSeek adapter uses, which keeps the six tiers meaning the same thing across
 * both balance sources. They are guesses about scale, not about money: the
 * animation only needs to know roughly how depleted the account is.
 */
const REFERENCE_AMOUNT = { CNY: 20, USD: 5, EUR: 5, TOKENS: 1_000_000, QUOTA: 1_000_000 };

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOrNull(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Turn one normalised balance into a used-percentage plus a human row.
 *
 * The three rules, in the order the host's own adapters favour them:
 *  - a window with both `total` and `remaining` has a real ceiling → exact ratio;
 *  - a key/subscription window with `used` and `remaining` → the same derivation
 *    the Command Code adapter uses (`used / (used + remaining)`);
 *  - a bare wallet with only `remaining` → measured against `REFERENCE_AMOUNT`,
 *    because a percentage is what drives the animation and there is nothing else
 *    to normalise against.
 *
 * `unlimited` short-circuits to 0: an unlimited key never depletes, so it must
 * never trip the "broke" animation.
 */
function measureAmount(amount) {
	const remaining = finiteOrNull(amount.remaining) ?? 0;
	const total = finiteOrNull(amount.total);
	const used = finiteOrNull(amount.used);

	if (total !== null && total > 0 && remaining <= total) {
		return Math.max(0, Math.min(100, ((total - remaining) / total) * 100));
	}
	if (used !== null && used + remaining > 0) {
		return Math.max(0, Math.min(100, (used / (used + remaining)) * 100));
	}
	const reference = REFERENCE_AMOUNT[amount.unit] ?? REFERENCE_AMOUNT.USD;
	if (reference > 0) {
		// An overdrawn wallet (negative remaining) lands at 100, which is correct:
		// the account is out of money, not "0 % used".
		return Math.max(0, Math.min(100, 100 - (remaining / reference) * 100));
	}
	return undefined;
}

function formatAmount(amount) {
	const remaining = finiteOrNull(amount.remaining);
	if (remaining === null) return undefined;
	const symbol =
		amount.unit === "USD" ? "$" : amount.unit === "CNY" ? "¥" : amount.unit === "EUR" ? "€" : "";
	const value = Math.abs(remaining) >= 100 ? remaining.toFixed(0) : remaining.toFixed(2);
	const suffix = symbol ? "" : ` ${amount.unit}`;
	return `${symbol}${value}${suffix}`;
}

/** One provider entry → `{ percent, rows }`. */
function measureEntry(id, value) {
	const balance = isRecord(value?.balance) ? value.balance : undefined;
	if (!balance) return undefined;
	const amounts = Array.isArray(balance.amounts) ? balance.amounts.filter(isRecord) : [];
	if (balance.unlimited === true) {
		return { id, percent: 0, rows: ["额度不限"], scope: balance.scope, fetchedAt: value.fetchedAt };
	}
	const rows = [];
	let percent;
	for (const amount of amounts) {
		const measured = measureAmount(amount);
		// The worst window wins: an exhausted 5-hour quota matters even when the
		// monthly allowance is untouched.
		if (measured !== undefined) percent = percent === undefined ? measured : Math.max(percent, measured);
		const text = formatAmount(amount);
		if (text) rows.push(amount.window ? `${amount.window} ${text}` : text);
	}
	if (percent === undefined) return undefined;
	return {
		id,
		percent,
		rows,
		scope: balance.scope,
		planName: typeof balance.planName === "string" ? balance.planName : undefined,
		fetchedAt: finiteOrNull(value.fetchedAt),
	};
}

/**
 * Read every supported provider balance the host has cached.
 *
 * Returns `{ entries }` on success — possibly empty, which is a normal state (the
 * user has not pressed "查询余额" yet) and is reported as such rather than as an
 * error. Returns `{ error }` only when the file cannot be understood at all.
 */
export async function readHostBalances() {
	const home = await resolveHostHome();
	if (!home) {
		return { error: { kind: "host_balance_unavailable", message: "找不到 NarraFork 数据目录" } };
	}
	const file = path.join(home, CACHE_FILE);
	let raw;
	try {
		raw = JSON.parse(await fs.readFile(file, "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT") {
			return { error: { kind: "host_balance_empty", message: "宿主还没有缓存过任何中转站余额" } };
		}
		return { error: { kind: "host_balance_unreadable", message: `读取 ${CACHE_FILE} 失败：${error?.message ?? error}` } };
	}
	if (!isRecord(raw) || raw.version !== CACHE_VERSION || !isRecord(raw.entries)) {
		return {
			error: {
				kind: "host_balance_unreadable",
				message: `${CACHE_FILE} 结构不符合预期（version/entries）`,
			},
		};
	}

	const entries = [];
	for (const [id, stored] of Object.entries(raw.entries)) {
		const value = isRecord(stored) ? stored.value : undefined;
		if (!isRecord(value)) continue;
		if (value.status !== "supported" && value.status !== "error") continue;
		const measured = measureEntry(id, value);
		if (measured) entries.push(measured);
	}
	// Freshest first: the host refreshes on its own schedule, so the newest entry is
	// the one most likely to describe what is actually configured right now.
	entries.sort((a, b) => (b.fetchedAt ?? 0) - (a.fetchedAt ?? 0));
	return { entries, home };
}

/**
 * Collapse the host cache into the snapshot shape the rest of the plugin uses.
 *
 * When several relays are tracked, the most depleted one drives the animation —
 * the pet's job is to warn before an account runs dry, so the worst number is the
 * useful one, and the bubble names it.
 */
export async function readHostBalanceSnapshot({ now = Date.now() } = {}) {
	const result = await readHostBalances();
	if (result.error) return { ok: false, error: result.error };
	if (result.entries.length === 0) {
		return {
			ok: false,
			error: {
				kind: "host_balance_empty",
				message: "宿主没有可用的中转站余额（在供应商设置里点一次「查询余额」）",
			},
		};
	}

	const worst = result.entries.reduce((max, entry) => (entry.percent > max.percent ? entry : max));
	const rows = worst.rows.length > 0 ? worst.rows.join(" · ") : "余额未知";
	const ageMs = worst.fetchedAt ? now - worst.fetchedAt : undefined;
	if (ageMs !== undefined && ageMs > 30 * 60_000) {
		// Worth saying out loud: a stale number that looks live is worse than no
		// number, because the pet will happily perform "almost broke" on old data.
		log.warn("host balance cache is stale", { ageMinutes: Math.round(ageMs / 60_000) });
	}
	return {
		ok: true,
		providerId: `host:${worst.id}`,
		label: worst.planName ?? "中转站余额",
		shape: worst.scope === "wallet" ? "money" : "windows",
		percent: worst.percent,
		tier: undefined, // filled by the caller, which owns the tier boundaries
		summary: rows,
		detail: {
			source: "host",
			providerCount: result.entries.length,
			tracked: result.entries.map((entry) => ({
				id: entry.id,
				percent: Number(entry.percent.toFixed(2)),
				rows: entry.rows,
				fetchedAt: entry.fetchedAt,
			})),
		},
		fetchedAt: new Date(worst.fetchedAt ?? now).toISOString(),
	};
}
