/**
 * Structured snapshots for the single user-configured balance API.
 *
 * ONE SOURCE, ISOLATED CACHES
 * Every snapshot is scoped by a context key derived from the endpoint URL, the two
 * response paths, the unit, the secret's fingerprint and the accounting time zone.
 * Switching any of those therefore starts a *new* account: the previous numbers
 * can never be shown as the new API's balance, and the ledger keeps them under
 * their own identity instead of mixing units.
 *
 * FAILURE IS NOT ZERO
 * A failed request preserves this context's last successful numbers and marks them
 * `stale` so the panel can say "旧数据". A context that never succeeded stays
 * empty. Nothing here reads a host balance file, a log or a database.
 */

import { createHash } from "node:crypto";
import { log } from "../log.js";
import { accountIdentity, createAccounting } from "../accounting.js";
import { customProvider, CUSTOM_SECRET_KEY, REQUEST_DEADLINE_MS } from "./providers.js";
import { POINTS_CURRENCY, isMoneyCurrency, measureAmount } from "./amounts.js";

export const BALANCE_KEY = "balance.snapshot";
export const BALANCE_SCOPE = { type: "global" };
/** Internal identity only: the ledger schema is v1 and keeps providerId per account. */
export const PROVIDER_ID = "custom";
export const DEFAULT_THRESHOLDS = [20, 40, 60, 80, 100];
const NOT_CONFIGURED_MESSAGE = "请配置第三方余额 API 和密钥";
const REFRESH_SERIAL = Symbol.for("cn.mcd7.neglectdream.dsh-pet.balance.serial.v2");

/** One shared rule: thresholds are inclusive starts, 100 is always exhausted. */
export function balanceEventIndex(percent, thresholds = DEFAULT_THRESHOLDS) {
	if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
	const clamped = Math.max(0, Math.min(100, percent));
	return thresholds.filter((threshold) => clamped >= threshold).length;
}

export async function readSnapshot(callHost) {
	const entry = await callHost("storage.get", { scope: BALANCE_SCOPE, key: BALANCE_KEY });
	const value = entry && typeof entry === "object" ? entry.value : null;
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

async function writeSnapshot(callHost, snapshot) {
	const written = await callHost("storage.set", { scope: BALANCE_SCOPE, key: BALANCE_KEY, value: snapshot });
	if (written?.stored === false) throw new Error("宿主拒绝保存余额快照");
	return snapshot;
}

function settingsOf(config) {
	const custom = config?.balance?.custom ?? {};
	return {
		url: typeof custom.url === "string" ? custom.url : "",
		totalPath: typeof custom.totalPath === "string" ? custom.totalPath : "",
		usedPath: typeof custom.usedPath === "string" ? custom.usedPath : "",
		currency: isMoneyCurrency(custom.currency) ? custom.currency.toUpperCase() : POINTS_CURRENCY,
	};
}

function thresholdsOf(config) {
	const thresholds = config?.balance?.thresholds;
	return Array.isArray(thresholds) && thresholds.length ? thresholds : DEFAULT_THRESHOLDS;
}

function endpointKey(settings, timeZone) {
	return createHash("sha256").update(JSON.stringify([
		PROVIDER_ID, settings.url, settings.totalPath, settings.usedPath, settings.currency, timeZone,
	])).digest("hex");
}

async function readSecret(callHost) {
	try {
		const result = await callHost("secrets.get", { key: CUSTOM_SECRET_KEY });
		return typeof result?.value === "string" && result.value.length > 0 ? result.value : undefined;
	} catch {
		return undefined;
	}
}

/** The ledger identity this configuration and key produce, and the fetch inputs. */
async function accountsFor({ callHost, config, accounting }) {
	const settings = settingsOf(config);
	const timeZone = config?.accounting?.timeZone ?? "UTC";
	const configKey = endpointKey(settings, timeZone);
	if (!settings.url) {
		return { accountIds: [], settings, timeZone, configKey, contextKey: null, configured: false, reason: "not_configured" };
	}
	const secret = await readSecret(callHost);
	if (!secret) {
		return { accountIds: [], settings, timeZone, configKey, contextKey: null, configured: false, reason: "missing_secret" };
	}
	let keyFingerprint;
	try {
		keyFingerprint = await accounting.fingerprint(secret, configKey);
	} catch (error) {
		return { accountIds: [], settings, timeZone, configKey, contextKey: null, configured: false, reason: "ledger_error", error };
	}
	const contextKey = createHash("sha256").update(JSON.stringify([configKey, keyFingerprint])).digest("hex");
	const shape = settings.currency === POINTS_CURRENCY ? "points" : "money";
	const account = { source: "manual", providerId: PROVIDER_ID, keyFingerprint, currency: settings.currency, shape, scope: shape, window: null, slot: 0 };
	return { accountIds: [accountIdentity(account, timeZone)], settings, timeZone, configKey, contextKey, configured: true, keyFingerprint, secret };
}

/**
 * Which ledger accounts belong to the *current* configuration/key.
 *
 * Used by the RPC layer to scope ledger reads, corrections and notice claims
 * without performing a network request; the key fingerprint is a read-only HMAC.
 */
export async function activeAccounts(options) {
	const active = await accountsFor(options);
	return { accountIds: active.accountIds, configKey: active.configKey, contextKey: active.contextKey,
		configured: active.configured, reason: active.reason, timeZone: active.timeZone, settings: active.settings };
}

function exposeAccount(raw, config) {
	// No key fingerprint, slot, provider id or label reaches the UI: one account is
	// the whole point of this design, and its identity is `accountId` alone.
	const { keyFingerprint, slot, label, providerId, ...rest } = raw;
	return { ...rest, accountId: accountIdentity(raw, config.accounting.timeZone), timeZone: config.accounting.timeZone };
}

function summaryFor({ remaining, used, total, currency }) {
	if (remaining === null) return "余额未知";
	return used !== null && total !== null
		? `${remaining} / ${total} ${currency}`
		: `${remaining} ${currency}`;
}

function unconfiguredSnapshot(reason) {
	return {
		source: "manual", configKey: null, contextKey: null,
		ok: false, stale: true, accounts: [], balances: [],
		percent: null, remainingPercent: null, summary: "余额未知",
		fetchedAt: null, attemptedAt: new Date().toISOString(),
		error: { kind: reason ?? "not_configured", message: NOT_CONFIGURED_MESSAGE },
	};
}

async function readLedger(accounting, config, accountIds) {
	try {
		return await accounting.read(config, { light: true, accountIds });
	} catch (error) {
		return { schemaVersion: 1, revision: null, status: "unavailable", error: String(error?.message ?? error), accounts: [] };
	}
}

/**
 * A failed attempt: keep this context's last successful numbers, explicitly stale.
 *
 * Two distinct reuse rules, because they answer different questions:
 *  - a request with the current key failed → reuse only this exact context's data;
 *  - the key was *removed* → reuse this endpoint's last success, since the numbers
 *    were produced by this endpoint and the user has not replaced them with
 *    another key's data.
 * A *replaced* key therefore never inherits the previous key's numbers.
 */
async function failSnapshot({ callHost, old, active, error, config, accounting }) {
	const sameContext = active.configured && old?.contextKey === active.contextKey;
	const sameEndpointSuccess = old?.configKey === active.configKey && old?.ok === true;
	const reusable = sameContext && Array.isArray(old?.accounts) && old.accounts.length > 0
		? old.accounts
		: active.reason === "missing_secret" && sameEndpointSuccess && Array.isArray(old?.accounts) && old.accounts.length > 0
			? old.accounts
			: [];
	const accounts = reusable.map((account) => ({ ...account, stale: true, ok: false }));
	const percent = reusable.length ? (old.percent ?? null) : null;
	const snapshot = {
		source: "manual",
		configKey: active.configKey,
		contextKey: active.configured ? active.contextKey : reusable.length ? old.contextKey ?? null : null,
		currency: active.settings.currency,
		ok: false, stale: true,
		accounts, balances: accounts,
		percent,
		remainingPercent: reusable.length ? (old.remainingPercent ?? null) : null,
		summary: reusable.length ? `${old.summary ?? "余额未知"}（旧数据）` : "余额未知",
		tier: balanceEventIndex(percent, thresholdsOf(config)),
		fetchedAt: reusable.length ? (old.fetchedAt ?? null) : null,
		attemptedAt: new Date().toISOString(),
		error,
	};
	// A failure only marks freshness; numeric baselines are untouched.
	try { if (accounts.length) await accounting.markStale(accounts.map((account) => account.accountId)); } catch { /* corrupt ledgers stay untouched */ }
	return writeSnapshot(callHost, snapshot);
}

async function recordAccounts(accounting, rawAccounts, config, accountIds) {
	try { return { ledger: await accounting.ingest(rawAccounts, config, { accountIds }) }; }
	catch (error) {
		log.warn("ledger observation not committed", error?.kind ?? error?.message);
		return { ledgerError: { kind: error?.kind ?? "STORAGE_ERROR", message: String(error?.message ?? error) } };
	}
}

async function refresh({ callHost, config, signal, force, accounting }) {
	const old = await readSnapshot(callHost);
	const active = await accountsFor({ callHost, config, accounting });
	const refreshMs = Math.max(1, Number(config?.balance?.refreshMinutes) || 30) * 60_000;
	const age = Date.now() - Date.parse(old?.attemptedAt ?? old?.fetchedAt ?? "");
	const fresh = !force && Number.isFinite(age) && age >= 0 && age < refreshMs;
	if (!active.configured && active.reason === "not_configured") {
		return { snapshot: unconfiguredSnapshot("not_configured"), skipped: "not_configured",
			ledger: await readLedger(accounting, config, []), activeAccountIds: [] };
	}
	if (!active.configured && active.reason === "ledger_error") {
		const snapshot = await failSnapshot({ callHost, old, active, config, accounting,
			error: { kind: active.error?.kind ?? "LEDGER_CORRUPT", message: "账本存储不可用，未查询余额" } });
		return { snapshot, ledger: await readLedger(accounting, config, []), activeAccountIds: [] };
	}
	if (!active.configured) {
		// Do not rewrite the snapshot on every stage poll while the key is missing:
		// an explicit force still records the attempt for "旧数据" freshness.
		if (fresh && old?.configKey === active.configKey && old?.error?.kind === "missing_secret" && Array.isArray(old.accounts)) {
			return { snapshot: old, cached: true, ledger: await readLedger(accounting, config, []), activeAccountIds: [] };
		}
		const snapshot = await failSnapshot({ callHost, old, active, config, accounting,
			error: { kind: "missing_secret", message: "未配置余额 API 密钥" } });
		return { snapshot, ledger: await readLedger(accounting, config, []), activeAccountIds: [] };
	}
	const { accountIds, contextKey, keyFingerprint, settings } = active;
	// `missing_secret` snapshots are deliberately not served as cached: a key that
	// was just re-entered must be used immediately instead of waiting for the
	// refresh interval to expire.
	if (fresh && old?.contextKey === contextKey && old?.error?.kind !== "missing_secret") {
		let ledger;
		try { ledger = await accounting.evaluate(config, { accountIds }); }
		catch { ledger = await readLedger(accounting, config, accountIds); }
		return { snapshot: { ...old, tier: balanceEventIndex(old.percent, thresholdsOf(config)) }, cached: true, ledger, activeAccountIds: accountIds };
	}
	const startedAt = Date.now();
	let view;
	try {
		view = await customProvider.fetch({ key: active.secret, signal, deadlineMs: REQUEST_DEADLINE_MS, custom: settings });
	} catch (error) {
		const kind = typeof error?.kind === "string" ? error.kind : "unknown";
		// Provider messages are constructed locally and never contain the URL, key or body.
		const message = typeof error?.message === "string" && error.message.length ? error.message.slice(0, 160) : "余额查询失败";
		log.warn("balance custom failed", kind);
		const snapshot = await failSnapshot({ callHost, old, active, config, accounting, error: { kind, message } });
		return { snapshot, ledger: await readLedger(accounting, config, accountIds), activeAccountIds: accountIds };
	}
	const sampledAt = new Date(startedAt).toISOString();
	const remaining = view.remaining;
	const used = view.used;
	const total = remaining !== null && used !== null ? Number(remaining) + Number(used) : null;
	const measured = measureAmount({ remaining, used });
	const raw = {
		source: "manual", providerId: PROVIDER_ID, label: "余额 API",
		shape: view.shape, scope: view.shape, currency: view.currency,
		remaining, total, used, unlimited: false, window: null, slot: 0,
		keyFingerprint, sampledAt, stale: false, ok: true,
		accountingEligible: view.shape === "money",
		remainingPercent: measured.remainingPercent,
	};
	const accounts = [exposeAccount({ ...raw, percent: measured.percent, percentBasis: measured.percentBasis }, config)];
	const observed = await recordAccounts(accounting, [raw], config, accountIds);
	const snapshot = {
		source: "manual", configKey: active.configKey, contextKey,
		shape: view.shape, currency: view.currency,
		ok: true, stale: false,
		accounts, balances: accounts,
		percent: measured.percent,
		remainingPercent: measured.remainingPercent,
		summary: summaryFor(raw),
		tier: balanceEventIndex(measured.percent, thresholdsOf(config)),
		elapsedMs: Date.now() - startedAt,
		fetchedAt: sampledAt,
		attemptedAt: new Date().toISOString(),
	};
	return { snapshot: await writeSnapshot(callHost, snapshot), activeAccountIds: accountIds, ...observed };
}

export function refreshBalance(options) {
	const accounting = options.accounting ?? createAccounting({ callHost: options.callHost });
	const previous = globalThis[REFRESH_SERIAL] ?? Promise.resolve();
	const running = previous.then(() => refresh({ force: true, ...options, accounting }));
	globalThis[REFRESH_SERIAL] = running.catch(() => {});
	return running;
}
