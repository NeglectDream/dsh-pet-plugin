/**
 * Pure amount helpers for the single user-configured balance API.
 *
 * WHY THIS FILE EXISTS (AND WHY IT HAS NO IMPORTS)
 * These three functions used to live in `balance/host.js`, the adapter that read
 * NarraFork's own `provider-balances.json`. That adapter is gone — the plugin no
 * longer reads any host balance file — but the *arithmetic* is still wanted: strict
 * numeric parsing (no invented zero), raw-amount retention, and the one place that
 * decides what a percentage means.
 *
 * Keeping them here means the pure functions survive the adapter's deletion and
 * stay reachable from config sanitising, the custom adapter and the snapshot
 * builder without dragging in any file I/O.
 */

/**
 * Currencies the plugin is willing to call "money".
 *
 * This is an allowlist rather than "any three-letter code" because `shape` decides
 * whether the observation ledger treats a number as spend. A typo such as `POINT`
 * or `USDT` must not silently become a currency with a budget; it degrades to
 * points, which is displayed but never accounted.
 */
export const MONEY_CURRENCIES = new Set([
	"CNY", "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "HKD", "SGD",
	"KRW", "INR", "TWD", "NZD", "RUB", "BRL",
]);

/** The unit used when the API's number is not a currency (credits, points, unknown). */
export const POINTS_CURRENCY = "POINTS";

export function isMoneyCurrency(value) {
	return typeof value === "string" && MONEY_CURRENCIES.has(value.toUpperCase());
}

/** Read `value` as a finite number, accepting plain decimal strings. */
export function finiteNumber(value) {
	if (typeof value !== "number" && typeof value !== "string") return null;
	if (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Keep the API's own representation (string or number) when it is usable. */
export function rawAmount(value) {
	return finiteNumber(value) === null ? null : value;
}

/**
 * Measure a remaining/used pair.
 *
 * `percent` always means USED. When the API supplies a used amount, the quota is
 * `remaining + used` — a real total, not a guessed reference. When it does not,
 * `percent` is `null`: inventing a reference balance would turn "unknown" into a
 * confident "80% left" for an API the plugin knows nothing about.
 */
export function measureAmount({ remaining, total, used, unlimited, percent }) {
	if (unlimited === true) return { percent: 0, remainingPercent: null, percentBasis: "unlimited" };
	const r = finiteNumber(remaining);
	const t = finiteNumber(total);
	const u = finiteNumber(used);
	let measured = null;
	let remainingPercent = null;
	let percentBasis = "unknown";
	if (t !== null && t > 0 && (r !== null || u !== null)) {
		measured = r !== null ? ((t - r) / t) * 100 : (u / t) * 100;
		remainingPercent = r !== null ? (r / t) * 100 : 100 - measured;
		percentBasis = "quota";
	} else if (r !== null && u !== null && r + u > 0) {
		measured = (u / (r + u)) * 100;
		remainingPercent = (r / (r + u)) * 100;
		percentBasis = "quota";
	} else if (finiteNumber(percent) !== null) {
		measured = finiteNumber(percent);
		percentBasis = "reported";
	}
	return {
		percent: measured === null ? null : Math.max(0, Math.min(100, measured)),
		remainingPercent: Number.isFinite(remainingPercent) ? remainingPercent : null,
		percentBasis,
	};
}
