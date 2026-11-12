/** Fixed-point observation ledger. Only successful storage.set commits a draft.
 * All instances in this backend share one queue; storage has no cross-process CAS.
 * No secret, provider response, narrator binding or parsed summary is persisted here.
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { acknowledgeNotice, claimNotices, evaluateAlerts, pruneNotices, discardDisabledNotices, NOTICE_LIMIT } from "./notices.js";

export const LEDGER_KEY = "pet.accounting.v1";
export const LEDGER_SCOPE = { type: "global" };
export const MAX_ACCOUNTS = 32;
export const MAX_DAYS = 31;
export const MAX_AUDIT = 16;
const MAX_ATOMS = BigInt(Number.MAX_SAFE_INTEGER);
const SERIAL = Symbol.for("cn.mcd7.neglectdream.dsh-pet.accounting.serial.v1");

export class AccountingError extends Error {
	constructor(kind, message) { super(message); this.name = "AccountingError"; this.kind = kind; }
}

/** Parse decimal text once, rounding ties away from zero at exactly eight places. */
export function toAtoms(value) {
	if ((typeof value !== "string" && typeof value !== "number") ||
		(typeof value === "number" && !Number.isFinite(value))) throw new AccountingError("INVALID_PARAMS", "金额必须是有限数字或十进制字符串");
	const text = String(value).trim();
	if (!text || text.length > 160 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
		throw new AccountingError("INVALID_PARAMS", "金额格式非法");
	}
	const negative = text.startsWith("-");
	const [mantissa, exponentText = "0"] = text.replace(/^[+-]/, "").toLowerCase().split("e");
	const [whole, fraction = ""] = mantissa.split(".");
	const digits = (whole + fraction).replace(/^0+/, "") || "0";
	if (digits === "0") return 0;
	const exponent = Number(exponentText);
	if (exponent < -400) return 0;
	if (exponent > 400) throw new AccountingError("AMOUNT_OVERFLOW", "金额超出八位定点安全范围");
	const shift = exponent + 8 - fraction.length;
	let atoms;
	if (shift >= 0) {
		if (digits.length + shift > 16) throw new AccountingError("AMOUNT_OVERFLOW", "金额超出八位定点安全范围");
		atoms = BigInt(digits) * (10n ** BigInt(shift));
	} else {
		const cut = digits.length + shift;
		const kept = cut > 0 ? digits.slice(0, cut) : "0";
		const rounded = cut >= 0 && Number(digits[cut] ?? "0") >= 5;
		atoms = BigInt(kept) + (rounded ? 1n : 0n);
	}
	if (atoms > MAX_ATOMS) throw new AccountingError("AMOUNT_OVERFLOW", "金额超出八位定点安全范围");
	return Number(negative ? -atoms : atoms);
}

export function fromAtoms(value) {
	if (value === null || value === undefined) return null;
	if (!Number.isSafeInteger(value)) throw new AccountingError("AMOUNT_OVERFLOW", "非安全定点整数");
	const negative = value < 0;
	const digits = String(Math.abs(value)).padStart(9, "0");
	return `${negative ? "-" : ""}${digits.slice(0, -8)}.${digits.slice(-8)}`;
}

function safeSum(...values) {
	const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
	if (total > MAX_ATOMS || total < -MAX_ATOMS) throw new AccountingError("AMOUNT_OVERFLOW", "账本累计超出安全整数范围，未写入本次变化");
	return Number(total);
}

export function dayFor(value, timeZone) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone, year: "numeric", month: "2-digit", day: "2-digit",
	}).formatToParts(new Date(value));
	const part = (name) => parts.find((item) => item.type === name).value;
	return `${part("year")}-${part("month")}-${part("day")}`;
}

export function accountIdentity(account, timeZone) {
	return `acct_${createHash("sha256").update(JSON.stringify([
		account.source, account.providerId, account.keyFingerprint, account.currency,
		timeZone, account.scope ?? account.shape, account.window ?? null, account.slot ?? null,
	])).digest("hex").slice(0, 40)}`;
}

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value) => Number.isSafeInteger(value);
const nonnegative = (value) => integer(value) && value >= 0;
const nullableInteger = (value) => value === null || integer(value);
const isoDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
const id = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(value);
const accountId = (value) => typeof value === "string" && /^acct_[a-f0-9]{40}$/.test(value);
const timestamp = (value) => nonnegative(value) && value <= 8_640_000_000_000_000;
const nullableTime = (value) => value === null || timestamp(value);
const boundedText = (value, max) => typeof value === "string" && value.length <= max;
const validZone = (zone) => { try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(); return typeof zone === "string" && zone.length <= 80; } catch { return false; } };

function freshState() {
	return { schemaVersion: 1, revision: 0, salt: randomBytes(32).toString("hex"), accounts: [], notices: [], latches: [] };
}

function validCorrectionValues(value) {
	return record(value) && (value.confirmedTopUp === null || nonnegative(value.confirmedTopUp)) && nonnegative(value.nonUsageDebit);
}

/** Fail closed: a corrupted record is never partially repaired or overwritten. */
export function validateLedger(state) {
	if (!record(state) || state.schemaVersion !== 1 || !nonnegative(state.revision) ||
		!/^[a-f0-9]{64}$/.test(state.salt ?? "") || !Array.isArray(state.accounts) || state.accounts.length > MAX_ACCOUNTS ||
		!Array.isArray(state.notices) || state.notices.length > NOTICE_LIMIT || !Array.isArray(state.latches) || state.latches.length > 128 ||
		Buffer.byteLength(JSON.stringify(state), "utf8") > 768 * 1024) return false;
	const ids = new Set();
	for (const a of state.accounts) {
		if (!record(a) || !accountId(a.accountId) || ids.has(a.accountId) || !["host", "manual"].includes(a.source) ||
			!boundedText(a.providerId, 128) || !boundedText(a.label, 120) || !/^[A-Z][A-Z0-9_-]{0,15}$/.test(a.currency ?? "") ||
			!validZone(a.timeZone) || !["money", "windows", "points"].includes(a.shape) || typeof a.eligible !== "boolean" ||
			typeof a.stale !== "boolean" || !nullableInteger(a.balance) || !nullableInteger(a.openingBalance) ||
			!nullableTime(a.sampledAt) || !nullableTime(a.observedFrom) || !nullableTime(a.observedTo) ||
			![a.observedSpend, a.observedRise, a.nonUsageDebit, a.unallocatedSpend, a.unallocatedRise].every(nonnegative) ||
			!(a.confirmedTopUp === null || nonnegative(a.confirmedTopUp)) ||
			!(a.remainingPercent === null || (typeof a.remainingPercent === "number" && Number.isFinite(a.remainingPercent))) ||
			!Array.isArray(a.incompleteReasons) || a.incompleteReasons.length > 12 || !a.incompleteReasons.every((v) => boundedText(v, 120)) ||
			!Array.isArray(a.days) || a.days.length > MAX_DAYS || !Array.isArray(a.audit) || a.audit.length > MAX_AUDIT) return false;
		ids.add(a.accountId);
		const dates = new Set();
		for (const d of a.days) {
			if (!record(d) || !isoDate(d.date) || dates.has(d.date) || !nonnegative(d.spend) || !nonnegative(d.rise)) return false;
			dates.add(d.date);
		}
		const audits = new Set();
		for (const event of a.audit) {
			if (!record(event) || !id(event.id) || audits.has(event.id) || !["set", "undo"].includes(event.action) || !timestamp(event.at) ||
				!boundedText(event.note, 300) || !nonnegative(event.observedRise) || !validCorrectionValues(event.before) || !validCorrectionValues(event.after) ||
				!(event.undoneBy === null || id(event.undoneBy)) || !(event.undoOf === null || id(event.undoOf))) return false;
			audits.add(event.id);
		}
	}
	for (const n of state.notices) {
		if (!record(n) || !id(n.id) || !/^[a-f0-9]{64}$/.test(n.ruleKey ?? "") || !accountId(n.accountId) || !ids.has(n.accountId) ||
			!["balance", "budget"].includes(n.kind) || !boundedText(n.currency, 16) || !boundedText(n.text, 500) ||
			!timestamp(n.createdAt) || !timestamp(n.expiresAt) || n.expiresAt <= n.createdAt || !validZone(n.timeZone) ||
			!(n.day === null || isoDate(n.day)) || !(n.lease === null || (record(n.lease) && id(n.lease.consumerId) && id(n.lease.token) && timestamp(n.lease.until)))) return false;
	}
	return state.latches.every((l) => record(l) && /^[a-f0-9]{64}$/.test(l.key ?? "") && id(l.ruleId) && typeof l.fired === "boolean" && timestamp(l.at));
}

function serialize(task) {
	const previous = globalThis[SERIAL] ?? Promise.resolve();
	const running = previous.then(task, task);
	globalThis[SERIAL] = running.catch(() => {});
	return running;
}

function addReason(account, text) {
	if (!account.incompleteReasons.includes(text) && account.incompleteReasons.length < 12) account.incompleteReasons.push(text);
}

function trimDays(account, now) {
	const today = dayFor(now, account.timeZone);
	const earliest = new Date(Date.parse(`${today}T00:00:00Z`) - (MAX_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
	account.days = account.days.filter((entry) => entry.date >= earliest && entry.date <= today).sort((a, b) => a.date.localeCompare(b.date)).slice(-MAX_DAYS);
}

function createAccount(raw, timeZone) {
	return {
		accountId: accountIdentity(raw, timeZone), source: raw.source, providerId: raw.providerId,
		label: String(raw.label ?? raw.providerId).slice(0, 120), currency: raw.currency, timeZone, shape: raw.shape,
		eligible: raw.shape === "money" && raw.unlimited !== true && raw.accountingEligible !== false, balance: null, openingBalance: null,
		observedSpend: 0, observedRise: 0, confirmedTopUp: null, nonUsageDebit: 0,
		unallocatedSpend: 0, unallocatedRise: 0, sampledAt: null, observedFrom: null, observedTo: null,
		remainingPercent: null, stale: true, incompleteReasons: ["首次观测之前的消费未知"], days: [], audit: [],
	};
}

/**
 * Make room for a new current account when the ledger is full.
 *
 * Historical accounts are normally kept forever, but the store is capped at
 * MAX_ACCOUNTS and a user who rotates URL/key/unit many times can fill it — at
 * which point refusing the *current* balance would be worse than dropping the
 * coldest history. Stale accounts go first, then the oldest sample. The victim's
 * queued notices go with it, because the validator requires every notice to
 * reference a stored account.
 */
function evictForCapacity(state) {
	const candidates = [...state.accounts].sort((a, b) =>
		(Number(b.stale) - Number(a.stale)) || ((a.sampledAt ?? 0) - (b.sampledAt ?? 0)));
	const victim = candidates[0];
	if (!victim) return false;
	state.accounts = state.accounts.filter((account) => account !== victim);
	state.notices = state.notices.filter((notice) => notice.accountId !== victim.accountId);
	return true;
}

function ingestOne(state, raw, config, now) {
	const timeZone = config.accounting.timeZone;
	const identity = accountIdentity(raw, timeZone);
	let account = state.accounts.find((entry) => entry.accountId === identity);
	if (!account) {
		if (state.accounts.length >= MAX_ACCOUNTS && !evictForCapacity(state)) {
			throw new AccountingError("ACCOUNT_LIMIT", "账户数达到32个上限，未覆盖已有账本");
		}
		account = createAccount(raw, timeZone);
		state.accounts.push(account);
	}
	const before = JSON.stringify(account);
	trimDays(account, now);
	account.label = String(raw.label ?? raw.providerId).slice(0, 120);
	const sampledAt = typeof raw.sampledAt === "number" ? raw.sampledAt : Date.parse(raw.sampledAt);
	if (!timestamp(sampledAt) || sampledAt > now + 60_000) {
		account.stale = true;
		addReason(account, "样本时间缺失或在未来");
		return { account, changed: before !== JSON.stringify(account), accepted: false };
	}
	if (raw.stale || raw.ok === false) {
		account.stale = true;
		addReason(account, "查询失败或宿主缓存过期，保留旧值");
		return { account, changed: before !== JSON.stringify(account), accepted: false };
	}
	if (account.sampledAt !== null && sampledAt < account.sampledAt) return { account, changed: before !== JSON.stringify(account), accepted: false };
	if (account.sampledAt === sampledAt) {
		// A duplicate can revalidate freshness but cannot change its amount or totals.
		account.stale = false;
		return { account, changed: before !== JSON.stringify(account), accepted: false };
	}
	let amount = null;
	try { if (raw.remaining !== null && raw.remaining !== undefined) amount = toAtoms(raw.remaining); }
	catch { addReason(account, "余额超出八位定点安全范围"); }
	account.remainingPercent = typeof raw.remainingPercent === "number" && Number.isFinite(raw.remainingPercent) ? raw.remainingPercent : null;
	const wasEligible = account.eligible;
	account.eligible = raw.shape === "money" && raw.unlimited !== true && raw.accountingEligible !== false;
	if (wasEligible !== account.eligible) addReason(account, "账户额度类型变化，期间消费未知");
	if (amount === null && account.eligible) {
		account.stale = true;
		addReason(account, "原始余额未知，未记账");
		return { account, changed: before !== JSON.stringify(account), accepted: false };
	}
	if (amount !== null && account.balance !== null && account.sampledAt !== null && account.eligible && wasEligible) {
		const delta = safeSum(amount, -account.balance);
		const spend = delta < 0 ? -delta : 0;
		const rise = delta > 0 ? delta : 0;
		account.observedSpend = safeSum(account.observedSpend, spend);
		account.observedRise = safeSum(account.observedRise, rise);
		if (rise > 0) addReason(account, "余额上涨无法自动判定为充值");
		const sameDay = dayFor(account.sampledAt, timeZone) === dayFor(sampledAt, timeZone);
		const shortGap = sampledAt - account.sampledAt <= config.accounting.maxGapMinutes * 60_000;
		if (sameDay && shortGap) {
			const date = dayFor(sampledAt, timeZone);
			let daily = account.days.find((entry) => entry.date === date);
			if (!daily) { daily = { date, spend: 0, rise: 0 }; account.days.push(daily); }
			daily.spend = safeSum(daily.spend, spend);
			daily.rise = safeSum(daily.rise, rise);
		} else {
			account.unallocatedSpend = safeSum(account.unallocatedSpend, spend);
			account.unallocatedRise = safeSum(account.unallocatedRise, rise);
			if (!sameDay) addReason(account, "跨日变化未分配到今日");
			if (!shortGap) addReason(account, "采样间隔过长");
		}
	}
	account.balance = amount;
	account.openingBalance ??= amount;
	account.sampledAt = sampledAt;
	account.observedFrom ??= sampledAt;
	account.observedTo = sampledAt;
	account.stale = false;
	trimDays(account, now);
	return { account, changed: true, accepted: true };
}

/** `options.accountIds` restricts the projection to the current balance API's accounts. */
function currentAccountIds(options) {
	return Array.isArray(options?.accountIds) ? new Set(options.accountIds) : null;
}

function publicLedger(state, config, now, options = {}) {
	const allowed = currentAccountIds(options);
	const accounts = state.accounts.filter((a) => (!allowed || allowed.has(a.accountId)) &&
		(!options.accountId || a.accountId === options.accountId)).map((a) => {
		const today = dayFor(now, a.timeZone);
		const earliest = new Date(Date.parse(`${today}T00:00:00Z`) - (MAX_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
		const recentDays = a.days.filter((entry) => entry.date >= earliest && entry.date <= today);
		const daily = recentDays.find((entry) => entry.date === today);
		let correctedSpend = null;
		if (a.eligible && a.confirmedTopUp !== null && a.openingBalance !== null && a.balance !== null) {
			try { correctedSpend = fromAtoms(safeSum(a.openingBalance, a.confirmedTopUp, -a.balance, -a.nonUsageDebit)); }
			catch { /* Derived net overflow is unknown, never a fabricated amount. */ }
		}
		const lastCorrection = [...a.audit].reverse().find((event) => event.action === "set" && !event.undoneBy);
		const result = {
			needsReview: a.observedRise > (lastCorrection?.observedRise ?? 0) || (correctedSpend !== null && correctedSpend.startsWith("-")),
			accountId: a.accountId, source: a.source, providerId: a.providerId, label: a.label, currency: a.currency,
			timeZone: a.timeZone, shape: a.shape, eligible: a.eligible,
			balance: fromAtoms(a.balance), openingBalance: fromAtoms(a.openingBalance),
			observedSpend: fromAtoms(a.observedSpend), observedRise: fromAtoms(a.observedRise),
			estimatedSpend: a.eligible ? fromAtoms(a.observedSpend) : null, correctedSpend,
			confirmedTopUp: fromAtoms(a.confirmedTopUp), nonUsageDebit: fromAtoms(a.nonUsageDebit),
			unallocatedSpend: fromAtoms(a.unallocatedSpend), unallocatedRise: fromAtoms(a.unallocatedRise),
			sampledAt: a.sampledAt === null ? null : new Date(a.sampledAt).toISOString(),
			observedFrom: a.observedFrom === null ? null : new Date(a.observedFrom).toISOString(),
			observedTo: a.observedTo === null ? null : new Date(a.observedTo).toISOString(),
			stale: a.stale || a.sampledAt === null || now - a.sampledAt > config.accounting.maxGapMinutes * 60_000,
			remainingPercent: a.remainingPercent, incompleteReasons: [...a.incompleteReasons],
			today: { date: today, spend: fromAtoms(daily?.spend ?? 0), rise: fromAtoms(daily?.rise ?? 0) },
		};
		if (!options.light) result.days = recentDays.slice(-(options.days ?? MAX_DAYS)).map((d) => ({ date: d.date, spend: fromAtoms(d.spend), rise: fromAtoms(d.rise) }));
		if (options.audit) result.audit = a.audit.map((event) => ({ ...event, at: new Date(event.at).toISOString(), observedRise: fromAtoms(event.observedRise),
			before: { confirmedTopUp: fromAtoms(event.before.confirmedTopUp), nonUsageDebit: fromAtoms(event.before.nonUsageDebit) },
			after: { confirmedTopUp: fromAtoms(event.after.confirmedTopUp), nonUsageDebit: fromAtoms(event.after.nonUsageDebit) },
		}));
		// Raw host cache keys stay in the private ledger only for identity/accounting;
		// they are not part of the public UI projection. Manual IDs are catalogue IDs.
		if (a.source === "host") {
			delete result.providerId;
			if (result.label === a.providerId) result.label = "宿主余额账户";
		}
		return result;
	});
	return { schemaVersion: 1, revision: state.revision, status: "ready", timeZone: config.accounting.timeZone, accounts };
}

export function createAccounting({ callHost, now = Date.now } = {}) {
	async function load() {
		const entry = await callHost("storage.get", { scope: LEDGER_SCOPE, key: LEDGER_KEY });
		if (!entry || !Object.prototype.hasOwnProperty.call(entry, "value") || entry.value === undefined) return { state: freshState(), missing: true };
		if (!validateLedger(entry.value)) throw new AccountingError("LEDGER_CORRUPT", "账本存储损坏或版本未知：已保留原始数据并停止写入");
		return { state: structuredClone(entry.value), missing: false };
	}
	async function transaction(operation) {
		return serialize(async () => {
			const { state, missing } = await load();
			const { result, changed = false } = await operation(state, now(), missing);
			if (changed) {
				if (!validateLedger(state)) throw new AccountingError("LEDGER_INVALID", "账本校验失败，未写入");
				const written = await callHost("storage.set", { scope: LEDGER_SCOPE, key: LEDGER_KEY, value: state });
				if (written?.stored === false) throw new AccountingError("STORAGE_WRITE_FAILED", "宿主拒绝持久化，账本草稿未提交");
			}
			return result;
		});
	}
	return {
		async fingerprint(secret, context = "") {
			return transaction((state, time, missing) => ({ changed: missing,
				result: createHmac("sha256", state.salt).update(JSON.stringify([context, secret])).digest("hex") }));
		},
		async read(config, options = {}) {
			try { return await transaction((state, time) => ({ result: publicLedger(state, config, time, options) })); }
			catch (error) { return { schemaVersion: 1, revision: null, status: error.kind === "LEDGER_CORRUPT" ? "corrupt" : "unavailable", error: error.message, accounts: [] }; }
		},
		async ingest(rawAccounts, config, options = {}) {
			return transaction((state, time) => {
				let changed = pruneNotices(state, time, dayFor);
				let observed = false;
				const active = [];
				for (const raw of rawAccounts) {
					const outcome = ingestOne(state, raw, config, time);
					changed ||= outcome.changed;
					observed ||= outcome.changed;
					if (!raw.stale && raw.ok !== false) active.push(outcome.account);
				}
				changed = evaluateAlerts(state, active, config, time, { toAtoms, fromAtoms, dayFor }) || changed;
				if (observed) state.revision = safeSum(state.revision, 1);
				return { changed, result: publicLedger(state, config, time, { light: true, accountIds: options.accountIds }) };
			});
		},
		async markStale(ids) {
			return transaction((state) => {
				let changed = false;
				for (const account of state.accounts) if (ids.includes(account.accountId) && !account.stale) { account.stale = true; changed = true; }
				if (changed) state.revision = safeSum(state.revision, 1);
				return { changed, result: null };
			});
		},
		/** Alerts only consider the current balance API's accounts; old ones stay silent. */
		async evaluate(config, options = {}) {
			return transaction((state, time) => {
				const allowed = currentAccountIds(options);
				const accounts = allowed ? state.accounts.filter((account) => allowed.has(account.accountId)) : state.accounts;
				let changed = pruneNotices(state, time, dayFor);
				changed = evaluateAlerts(state, accounts, config, time, { toAtoms, fromAtoms, dayFor }) || changed;
				return { changed, result: publicLedger(state, config, time, { light: true, accountIds: options.accountIds }) };
			});
		},
		async correct(input, config, options = {}) {
			input = validateCorrection(input);
			return transaction((state, time) => {
				if (input.revision !== state.revision) throw new AccountingError("REVISION_CONFLICT", "账本已变化，请刷新数据后重新确认");
				const allowed = currentAccountIds(options);
				if (allowed && !allowed.has(input.accountId)) throw new AccountingError("INVALID_PARAMS", "账户不属于当前余额 API，未校正");
				const account = state.accounts.find((a) => a.accountId === input.accountId);
				if (!account || !account.eligible || account.openingBalance === null) throw new AccountingError("INVALID_PARAMS", "账户不存在或不是可校正的货币账户");
				const before = { confirmedTopUp: account.confirmedTopUp, nonUsageDebit: account.nonUsageDebit };
				let after;
				const correctionId = randomUUID();
				if (input.action === "undo") {
					const latest = [...account.audit].reverse().find((event) => event.action === "set" && !event.undoneBy);
					if (!latest || latest.id !== input.correctionId) throw new AccountingError("UNDO_CONFLICT", "只能撤销最新且尚未撤销的校正");
					after = { ...latest.before };
					latest.undoneBy = correctionId;
				} else after = { confirmedTopUp: toAtoms(input.confirmedTopUp), nonUsageDebit: toAtoms(input.nonUsageDebit) };
				if (!validCorrectionValues(after)) throw new AccountingError("INVALID_PARAMS", "累计到账和非调用扣减不能为负");
				if (after.confirmedTopUp !== null) safeSum(account.openingBalance, after.confirmedTopUp, -account.balance, -after.nonUsageDebit);
				Object.assign(account, after);
				account.audit.push({ id: correctionId, action: input.action, at: time, note: input.note,
					before, after, observedRise: account.observedRise, undoOf: input.action === "undo" ? input.correctionId : null, undoneBy: null });
				account.audit = account.audit.slice(-MAX_AUDIT);
				state.revision = safeSum(state.revision, 1);
				return { changed: true, result: { ledger: publicLedger(state, config, time, { audit: true, accountIds: options.accountIds }), correctionId } };
			});
		},
		async notices(input, config, options = {}) {
			input = validateNoticeInput(input);
			return transaction((state, time) => {
				const discarded = config ? discardDisabledNotices(state, config, time, { dayFor, toAtoms }) : false;
				let pruned = false;
				let outcome;
				const allowed = input.accountIds !== undefined ? new Set(input.accountIds) : currentAccountIds(options);
				if (input.action === "claim" && allowed) {
					pruned = pruneNotices(state, time, dayFor);
					const scopedState = { ...state, notices: state.notices.filter((notice) => allowed.has(notice.accountId)) };
					outcome = claimNotices(scopedState, input, time, dayFor);
				} else if (input.action === "ack" && allowed) {
					// An already-claimed notice for an account that is no longer current is
					// left alone; it expires on its own instead of being acknowledged blind.
					const target = state.notices.find((notice) => notice.id === input.id);
					outcome = target && !allowed.has(target.accountId)
						? { changed: false, result: { acked: false } }
						: acknowledgeNotice(state, input, time, dayFor);
				} else {
					outcome = input.action === "claim" ? claimNotices(state, input, time, dayFor) : acknowledgeNotice(state, input, time, dayFor);
				}
				return { ...outcome, changed: discarded || pruned || outcome.changed };
			});
		},
	};
}

function inputObject(input, allowed) {
	const value = input === undefined ? {} : input;
	if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new AccountingError("INVALID_PARAMS", "命令包含未知字段或参数不是对象");
	return value;
}

export function validateLedgerGet(input) {
	const value = inputObject(input, ["accountId", "days", "audit"]);
	if (value.accountId !== undefined && !accountId(value.accountId)) throw new AccountingError("INVALID_PARAMS", "accountId 非法");
	if (value.days !== undefined && (!Number.isInteger(value.days) || value.days < 1 || value.days > 31)) throw new AccountingError("INVALID_PARAMS", "days 必须是1到31的整数");
	if (value.audit !== undefined && typeof value.audit !== "boolean") throw new AccountingError("INVALID_PARAMS", "audit 必须为布尔值");
	return value;
}

export function validateCorrection(input) {
	const value = inputObject(input, ["accountId", "revision", "confirmed", "action", "confirmedTopUp", "nonUsageDebit", "correctionId", "note"]);
	if (!accountId(value.accountId) || !nonnegative(value.revision) || value.confirmed !== true ||
		!["set", "undo"].includes(value.action) || typeof value.note !== "string" || !value.note.trim() || value.note.length > 300 || /[\u0000-\u001f\u007f<>]/.test(value.note)) {
		throw new AccountingError("INVALID_PARAMS", "校正需要合法账户、revision、明确确认与纯文本说明");
	}
	if (value.action === "set") {
		if (value.correctionId !== undefined || toAtoms(value.confirmedTopUp) < 0 || toAtoms(value.nonUsageDebit) < 0) throw new AccountingError("INVALID_PARAMS", "累计校正字段非法");
	} else if (!id(value.correctionId) || value.confirmedTopUp !== undefined || value.nonUsageDebit !== undefined) throw new AccountingError("INVALID_PARAMS", "撤销需要correctionId且不能携带金额");
	return { ...value, note: value.note.trim() };
}

export function validateNoticeInput(input) {
	const value = inputObject(input, ["action", "consumerId", "limit", "id", "leaseToken", "accountIds"]);
	if (!["claim", "ack"].includes(value.action) || !id(value.consumerId)) throw new AccountingError("INVALID_PARAMS", "通知操作及consumerId非法");
	if (value.action === "claim") {
		if (value.id !== undefined || value.leaseToken !== undefined || (value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 5))) throw new AccountingError("INVALID_PARAMS", "claim只接受1到5的limit");
		if (value.accountIds !== undefined && (!Array.isArray(value.accountIds) || value.accountIds.length > 32 ||
			value.accountIds.some((candidate) => !accountId(candidate)) || new Set(value.accountIds).size !== value.accountIds.length)) {
			throw new AccountingError("INVALID_PARAMS", "accountIds必须是最多32个不重复的合法账户ID");
		}
	} else if (!id(value.id) || !id(value.leaseToken) || value.limit !== undefined || value.accountIds !== undefined) throw new AccountingError("INVALID_PARAMS", "ack需要id和leaseToken且不能携带accountIds");
	return value;
}
