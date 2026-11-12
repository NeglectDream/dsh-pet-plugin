/** Pure persisted notice operations. The accounting transaction is the sole writer. */
import { createHash, randomUUID } from "node:crypto";

export const NOTICE_LIMIT = 64;
export const NOTICE_LEASE_MS = 60_000;
export const NOTICE_TTL_MS = 6 * 60 * 60_000;

export function pruneNotices(state, now, dayFor) {
	const before = state.notices.length;
	state.notices = state.notices.filter((notice) =>
		notice.expiresAt > now &&
		(!notice.day || notice.day === dayFor(now, notice.timeZone)),
	).slice(-NOTICE_LIMIT);
	return before !== state.notices.length;
}

function ruleKeyFor(rule, day, toAtoms) {
	return createHash("sha256").update(JSON.stringify([rule.id, rule.accountId, rule.currency, rule.kind, rule.metric,
		rule.version, toAtoms(rule.threshold), toAtoms(rule.hysteresis), rule.kind === "budget" ? day : null])).digest("hex");
}

export function discardDisabledNotices(state, config, now, { dayFor, toAtoms }) {
	const allowed = new Set(config.alerts.enabled ? config.alerts.rules.filter((rule) => rule.enabled)
		.map((rule) => ruleKeyFor(rule, dayFor(now, config.accounting.timeZone), toAtoms)) : []);
	const count = state.notices.length;
	state.notices = state.notices.filter((notice) => allowed.has(notice.ruleKey));
	return count !== state.notices.length;
}

/** Rule identity includes the actual threshold, not merely the UI version counter. */
export function evaluateAlerts(state, accounts, config, now, helpers) {
	if (!config.alerts?.enabled) return false;
	let changed = false;
	const { toAtoms, fromAtoms, dayFor } = helpers;
	for (const rule of config.alerts.rules ?? []) {
		if (!rule.enabled) continue;
		const account = accounts.find((item) => item.accountId === rule.accountId && item.currency === rule.currency);
		if (!account || account.stale || account.timeZone !== config.accounting.timeZone ||
			(rule.metric !== "remainingPercent" && !account.eligible) ||
			(rule.metric === "remainingPercent" && account.remainingPercent === null)) continue;
		const today = dayFor(now, account.timeZone);
		// Old cached provider data must not create today's alerts.
		if (!account.sampledAt || now - account.sampledAt > config.accounting.maxGapMinutes * 60_000 || dayFor(account.sampledAt, account.timeZone) !== today) continue;
		const threshold = toAtoms(rule.threshold);
		const hysteresis = toAtoms(rule.hysteresis);
		const ruleKey = ruleKeyFor(rule, today, toAtoms);
		let latch = state.latches.find((entry) => entry.key === ruleKey);
		let value;
		try { value = rule.kind === "budget"
			? (account.days.find((entry) => entry.date === today)?.spend ?? 0)
			: rule.metric === "remainingPercent" ? toAtoms(account.remainingPercent) : account.balance; }
		catch { continue; }
		if (!Number.isSafeInteger(value)) continue;
		const hit = rule.kind === "budget" ? value >= threshold : value <= threshold;
		if (!latch && !hit) continue;
		if (!latch) {
			latch = { key: ruleKey, ruleId: rule.id, fired: false, at: now };
			state.latches.push(latch);
			changed = true;
		}
		if (rule.kind === "balance" && latch.fired && BigInt(value) > BigInt(threshold) + BigInt(hysteresis)) {
			latch.fired = false;
			latch.at = now;
			changed = true;
		}
		if (!hit || latch.fired) continue;
		latch.fired = true;
		latch.at = now;
		const label = account.label || account.providerId;
		state.notices.push({
			id: randomUUID(), ruleKey, kind: rule.kind, accountId: account.accountId, currency: account.currency,
			text: rule.kind === "budget"
				? `${label} 今日已观察消费 ${fromAtoms(value)} ${account.currency}，达到预算阈值 ${fromAtoms(threshold)}。`
				: `${label} ${rule.metric === "remainingPercent" ? "剩余比例" : "余额"} ${fromAtoms(value)} ${rule.metric === "remainingPercent" ? "%" : account.currency}，已低于或等于提醒阈值 ${fromAtoms(threshold)}。`,
			createdAt: now, expiresAt: now + NOTICE_TTL_MS,
			timeZone: account.timeZone, day: rule.kind === "budget" ? today : null,
			lease: null,
		});
		changed = true;
	}
	state.notices = state.notices.slice(-NOTICE_LIMIT);
	state.latches.sort((a, b) => b.at - a.at);
	state.latches = state.latches.slice(0, 128);
	return changed;
}

export function claimNotices(state, { consumerId, limit = 1 }, now, dayFor) {
	let changed = pruneNotices(state, now, dayFor);
	const notices = [];
	const candidates = [...state.notices].sort((a, b) => (a.kind === "budget" ? 0 : 1) - (b.kind === "budget" ? 0 : 1) || a.createdAt - b.createdAt);
	for (const notice of candidates) {
		if (notices.length >= limit) break;
		if (notice.lease && notice.lease.until > now) continue;
		notice.lease = { consumerId, token: randomUUID(), until: Math.min(now + NOTICE_LEASE_MS, notice.expiresAt) };
		const { lease, timeZone, day, ruleKey, ...publicNotice } = notice;
		notices.push({
			...publicNotice, createdAt: new Date(notice.createdAt).toISOString(),
			expiresAt: new Date(notice.expiresAt).toISOString(), leaseToken: lease.token,
			leaseUntil: new Date(lease.until).toISOString(),
		});
		changed = true;
	}
	return { changed, result: { notices } };
}

export function acknowledgeNotice(state, { consumerId, id, leaseToken }, now, dayFor) {
	let changed = pruneNotices(state, now, dayFor);
	const index = state.notices.findIndex((notice) => notice.id === id && notice.lease?.consumerId === consumerId &&
		notice.lease?.token === leaseToken && notice.lease.until > now);
	if (index < 0) return { changed, result: { acked: false } };
	state.notices.splice(index, 1);
	return { changed: true, result: { acked: true } };
}
