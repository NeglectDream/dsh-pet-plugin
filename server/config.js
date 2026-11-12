/**
 * The pet's settings: defaults, merge, validation, persistence.
 *
 * WHERE SETTINGS LIVE, AND WHY NOT IN THE MANIFEST
 * NarraFork's `config.get` returns *provider* config and is empty for a plugin
 * that contributes no provider (`plugin-host-services.ts` → `providerConfigReader`).
 * A `contributes.configuration` block would install a form nobody reads. So the
 * pet keeps its own config in plugin storage — namespaced by plugin id, already
 * quota-limited, and readable from both the settings panel and the stage.
 *
 * `scope: { type: "global" }` is deliberate. `storageScopeFromParams` +
 * `assertStorageScopeBound` reject any non-global scope whose id does not match
 * the host-bound context, and a `plugin_background` binding has an empty scope —
 * so `user`/`workspace` scopes are unreachable from the backend. Storage is
 * already partitioned per plugin, so "global" here means "this plugin, one copy",
 * which is exactly the intent (the pet is a single user's desktop toy, and the
 * stage and the settings panel must agree on one config).
 *
 * VALIDATION IS NOT DEFENSIVE THEATRE
 * This config arrives from JSON that a user can hand-edit and that a future
 * version of this plugin may have written with different fields. Every numeric
 * field is clamped, every unknown field is dropped, and a missing field falls
 * back to its default — so a corrupt config degrades to "the pet looks normal"
 * instead of "the stage throws on the first frame and shows nothing".
 */

import { fromAtoms, toAtoms } from "./accounting.js";
import { POINTS_CURRENCY, isMoneyCurrency } from "./balance/amounts.js";

export const CONFIG_KEY = "pet.config";
export const CONFIG_SCOPE = { type: "global" };
/** Bumped when the balance schema changed to a single API. Stored so the migration warning appears once. */
export const CONFIG_VERSION = 2;
export const DEFAULT_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Groups a user can switch off. Keys match the `group` field in `anim/index.json`. */
export const ANIMATION_GROUPS = [
	"idle",
	"turn",
	"drag",
	"click",
	"move",
	"small",
	"play",
	"eat",
	"season",
	"text",
];

export const DEFAULT_CONFIG = Object.freeze({
	version: CONFIG_VERSION,
	/** How many pets share the stage. Each is independent (position, velocity, facing). */
	count: 1,
	/** Multiplier on the pet's baseline on-screen width. */
	scale: 1,
	/** Multiplier on gravity. 0 makes the pet float. */
	gravity: 1,
	/** Restitution on the floor/ceiling bounce. */
	bounce: 0.55,
	/** Horizontal damping applied while touching the floor. */
	friction: 0.9,
	/** Pets push each other apart instead of passing through. */
	collisions: true,
	/** How far a click squashes the pet, as a fraction of its height. */
	clickSquash: 0.35,
	/** Random wandering, using the `move` animation group. */
	roam: true,
	animationGroups: Object.freeze(
		Object.fromEntries(ANIMATION_GROUPS.map((group) => [group, true])),
	),
	/** Bounds of the wait between two ambient actions, in milliseconds. */
	idleMinMs: 4000,
	idleMaxMs: 9000,
	balance: Object.freeze({
		/**
		 * The pet has exactly one balance source: the HTTPS API the user configures
		 * below. There is no host/manual switch and no provider directory — an old
		 * provider selection must not be able to reach a built-in API domain.
		 */
		refreshMinutes: 30,
		/** Percentage cut-offs for the six balance animations, ascending, last must be 100. */
		thresholds: Object.freeze([20, 40, 60, 80, 100]),
		custom: Object.freeze({
			/** HTTPS endpoint queried with GET + `Authorization: Bearer <customApiKey>`. */
			url: "",
			/** Dot path to the remaining amount, e.g. `data.balance`. */
			totalPath: "",
			/** Optional dot path to the spent amount; when valid, quota = remaining + used. */
			usedPath: "",
			/**
			 * `POINTS` means "a number without a currency" — displayed, never turned
			 * into spend or a money budget. A supported ISO code makes it `money`.
			 */
			currency: POINTS_CURRENCY,
		}),
	}),
	/** Show the diagnostic HUD on the stage. Handy while tuning, off by default. */
	diagnostics: false,
	/**
	 * Click sound.
	 *
	 * `enabled` is deliberately a real switch rather than a volume of zero: the
	 * stage only creates its `AudioContext` when the sound is on at all, and the
	 * config is the user's record of "I turned this off", which a zero volume
	 * cannot express once they start dragging the slider again.
	 *
	 * `volume` is a plain gain factor (0–1) applied to the inlined sample, not a
	 * percentage — the panel formats it.
	 */
	sound: Object.freeze({ enabled: true, volume: 0.6 }),
	bubbles: Object.freeze({ enabled: true, scale: 1, durationMs: 5000, noticeDurationMs: 8000,
		clickMode: "advance", autoChat: true, overrides: Object.freeze([]) }),
	tasks: Object.freeze({ enabled: true }),
	accounting: Object.freeze({ timeZone: DEFAULT_TIME_ZONE, maxGapMinutes: 180 }),
	alerts: Object.freeze({ enabled: false, rules: Object.freeze([]) }),
});

const MAX_COUNT = 6;
const MAX_URL_CHARS = 500;
const MAX_PATH_CHARS = 200;

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampNumber(value, fallback, min, max) {
	const parsed = typeof value === "number" || (typeof value === "string" && value.trim() !== "") ? Number(value) : Number.NaN;
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(parsed, min), max);
}

function clampInteger(value, fallback, min, max) {
	return Math.round(clampNumber(value, fallback, min, max));
}

function clampString(value, fallback, maxChars) {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	if (trimmed.length === 0) return fallback;
	return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

/**
 * Warnings for a stored config written by a version that still had a host source,
 * built-in provider selection or narrator bindings. Reported (not thrown), and only
 * until the first save writes `version: 2` back — after that the migration is
 * complete and the note disappears on its own.
 */
function migrationWarnings(source, warnings) {
	if (source.version !== CONFIG_VERSION) {
		warnings.push("配置已升级到版本 2：余额只使用你填写的单一 HTTPS API");
	}
	if (source.narratorBalances !== undefined) {
		warnings.push("已移除叙述者余额关联：余额不再按叙述者绑定");
	}
	const balance = isPlainObject(source.balance) ? source.balance : {};
	if (balance.source !== undefined) {
		warnings.push("已移除余额来源选择（host/manual）：不再读取宿主余额");
	}
	if (balance.providerId !== undefined) {
		warnings.push("已移除内置服务商选择：请填写唯一的余额 API 地址与密钥");
	}
}

/**
 * Deep-merge a patch onto a base config.
 *
 * Arrays replace wholesale rather than merging element-wise: `thresholds` and any
 * future list have ordered meaning, and a merged list would let a stale entry
 * survive a deliberate reset. `null` is treated as "unset" for object fields so a
 * client can clear `balance.custom.url` without knowing the object shape.
 */
export function mergeConfig(base, patch) {
	if (!isPlainObject(patch)) return base;
	const result = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined || ["__proto__", "prototype", "constructor"].includes(key)) continue;
		if (isPlainObject(value) && isPlainObject(base[key])) {
			result[key] = mergeConfig(base[key], value);
		} else {
			result[key] = value;
		}
	}
	return result;
}

/**
 * Coerce arbitrary input into a valid config.
 *
 * Returns the config plus a list of human-readable warnings, because "your value
 * was ignored" is the one thing a settings UI must be able to say. Values are
 * clamped rather than rejected: a user who types 999 for the pet count gets six
 * pets and a note, not an error page.
 */
export function sanitizeConfig(raw) {
	const warnings = [];
	const source = isPlainObject(raw) ? raw : {};
	const defaults = DEFAULT_CONFIG;
	const config = { version: CONFIG_VERSION };
	migrationWarnings(source, warnings);

	config.count = clampInteger(source.count, defaults.count, 1, MAX_COUNT);
	if (source.count !== undefined && config.count !== source.count) {
		warnings.push(`count 已调整为 ${config.count}（允许 1–${MAX_COUNT}）`);
	}
	config.scale = clampNumber(source.scale, defaults.scale, 0.35, 3);
	config.gravity = clampNumber(source.gravity, defaults.gravity, 0, 3);
	config.bounce = clampNumber(source.bounce, defaults.bounce, 0, 0.95);
	config.friction = clampNumber(source.friction, defaults.friction, 0.5, 0.995);
	config.collisions = source.collisions === undefined ? defaults.collisions : Boolean(source.collisions);
	config.clickSquash = clampNumber(source.clickSquash, defaults.clickSquash, 0, 1);
	config.roam = source.roam === undefined ? defaults.roam : Boolean(source.roam);
	config.diagnostics =
		source.diagnostics === undefined ? defaults.diagnostics : Boolean(source.diagnostics);

	config.idleMinMs = clampInteger(source.idleMinMs, defaults.idleMinMs, 800, 120_000);
	config.idleMaxMs = clampInteger(source.idleMaxMs, defaults.idleMaxMs, config.idleMinMs, 120_000);

	config.animationGroups = {};
	const groups = isPlainObject(source.animationGroups) ? source.animationGroups : {};
	for (const group of ANIMATION_GROUPS) {
		const value = groups[group];
		config.animationGroups[group] = value === undefined ? true : Boolean(value);
	}
	// An empty selection would leave the pet with no animation to play at all.
	if (!Object.values(config.animationGroups).some(Boolean)) {
		config.animationGroups.idle = true;
		warnings.push("至少需要保留一个动画分组，已重新启用 idle");
	}

	const sound = isPlainObject(source.sound) ? source.sound : {};
	config.sound = {
		// A stored `sound: { enabled: false }` from an older version keeps working;
		// so does a config written before the field existed, which gets the default.
		enabled: sound.enabled === undefined ? defaults.sound.enabled : Boolean(sound.enabled),
		volume: clampNumber(sound.volume, defaults.sound.volume, 0, 1),
	};
	if (sound.volume !== undefined && config.sound.volume !== sound.volume) {
		warnings.push(`sound.volume 已调整为 ${config.sound.volume}（允许 0–1）`);
	}

	const balance = isPlainObject(source.balance) ? source.balance : {};
	config.balance = {
		refreshMinutes: clampInteger(balance.refreshMinutes, defaults.balance.refreshMinutes, 1, 1440),
		thresholds: sanitizeThresholds(balance.thresholds, warnings),
		custom: sanitizeCustom(balance.custom, warnings),
	};

	const bubbles = isPlainObject(source.bubbles) ? source.bubbles : {};
	const overrides = [];
	const seen = new Set();
	for (const entry of (Array.isArray(bubbles.overrides) ? bubbles.overrides : []).slice(0, 120)) {
		if (!isPlainObject(entry) || typeof entry.id !== "string" || !/^[A-Za-z0-9_.:-]{1,80}$/.test(entry.id) || seen.has(entry.id)) continue;
		const text = typeof entry.text === "string" ? entry.text.replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[<>]/g, "").trim().slice(0, 300) : "";
		if (!text) continue;
		seen.add(entry.id);
		overrides.push({ id: entry.id, text, weight: clampNumber(entry.weight, 1, 0, 100) });
	}
	config.bubbles = {
		enabled: typeof bubbles.enabled === "boolean" ? bubbles.enabled : defaults.bubbles.enabled,
		scale: clampNumber(bubbles.scale, 1, 0.75, 1.4),
		durationMs: clampInteger(bubbles.durationMs, 5000, 0, 120_000),
		noticeDurationMs: clampInteger(bubbles.noticeDurationMs, 8000, 0, 120_000),
		clickMode: bubbles.clickMode === "home" ? "home" : "advance",
		autoChat: typeof bubbles.autoChat === "boolean" ? bubbles.autoChat : true,
		overrides,
	};
	config.tasks = { enabled: typeof source.tasks?.enabled === "boolean" ? source.tasks.enabled : true };
	const accounting = isPlainObject(source.accounting) ? source.accounting : {};
	let timeZone = defaults.accounting.timeZone;
	if (typeof accounting.timeZone === "string" && accounting.timeZone.length <= 80) {
		try { new Intl.DateTimeFormat("en", { timeZone: accounting.timeZone }).format(); timeZone = accounting.timeZone; }
		catch { warnings.push(`统计时区无效，已回退本机时区 ${DEFAULT_TIME_ZONE}`); }
	}
	config.accounting = { timeZone, maxGapMinutes: clampInteger(accounting.maxGapMinutes, 180, 1, 1440) };
	config.alerts = sanitizeAlerts(source.alerts, warnings);

	return { config, warnings };
}

function sanitizeAlerts(raw, warnings) {
	const source = isPlainObject(raw) ? raw : {};
	const rules = [];
	const seen = new Set();
	for (const rule of (Array.isArray(source.rules) ? source.rules : []).slice(0, 32)) {
		try {
			if (!isPlainObject(rule) || typeof rule.id !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(rule.id) || seen.has(rule.id) ||
				!/^acct_[a-f0-9]{40}$/.test(rule.accountId ?? "") || !/^[A-Z][A-Z0-9_-]{0,15}$/.test(rule.currency ?? "") ||
				!["balance", "budget"].includes(rule.kind)) throw new Error("规则必须选择精确账户和币种");
			if ((rule.enabled !== undefined && typeof rule.enabled !== "boolean") ||
				(rule.metric !== undefined && !["amount", "remainingPercent"].includes(rule.metric)) ||
				(rule.kind === "budget" && rule.metric === "remainingPercent")) throw new Error("预警开关或度量类型非法");
			const metric = rule.metric === "remainingPercent" ? "remainingPercent" : "amount";
			const threshold = toAtoms(rule.threshold);
			const hysteresis = toAtoms(rule.hysteresis ?? "0");
			if (threshold < 0 || hysteresis < 0 || (metric === "remainingPercent" && (threshold > 10_000_000_000 || hysteresis > 10_000_000_000))) throw new Error("预警阈值或迟滞超出范围");
			rules.push({ id: rule.id, enabled: rule.enabled !== false, accountId: rule.accountId, currency: rule.currency,
				kind: rule.kind, metric, threshold: fromAtoms(threshold), hysteresis: fromAtoms(hysteresis),
				version: clampInteger(rule.version, 1, 1, 1_000_000_000) });
			seen.add(rule.id);
		} catch (error) { warnings.push(`已忽略无效预警规则：${error.message}`); }
	}
	return { enabled: source.enabled === true, rules };
}

function sanitizeThresholds(raw, warnings) {
	const defaults = DEFAULT_CONFIG.balance.thresholds;
	if (!Array.isArray(raw) || raw.length !== defaults.length) {
		if (raw !== undefined) warnings.push("thresholds 必须是 5 个递增的百分比，已回退默认");
		return [...defaults];
	}
	const values = raw.map((value) => clampInteger(value, Number.NaN, 1, 100));
	if (values.some((value) => !Number.isFinite(value))) {
		warnings.push("thresholds 含非法数值，已回退默认");
		return [...defaults];
	}
	for (let index = 1; index < values.length; index += 1) {
		if (values[index] <= values[index - 1]) {
			warnings.push("thresholds 必须严格递增，已回退默认");
			return [...defaults];
		}
	}
	// The last cut-off is what distinguishes "almost out" from "completely out",
	// so it is pinned to 100 rather than clamped: a last value of 90 would make
	// the final animation unreachable.
	values[values.length - 1] = 100;
	return values;
}

/**
 * The one API's settings.
 *
 * HTTPS-only is enforced here rather than in the adapter so a stored config can
 * never contain an `http://` endpoint that a later read would try to use. The old
 * `method`/`headers` fields are dropped with a warning instead of being applied:
 * quietly sending a stored POST body or a stored extra header to the new endpoint
 * would be exactly the "old configuration still works" surprise this change removes.
 */
function sanitizeCustom(raw, warnings) {
	const defaults = DEFAULT_CONFIG.balance.custom;
	const source = isPlainObject(raw) ? raw : {};
	const rawUrl = typeof source.url === "string" ? source.url.trim().slice(0, MAX_URL_CHARS) : "";
	let url = "";
	if (rawUrl) {
		try {
			const parsed = new URL(rawUrl);
			if (parsed.protocol !== "https:") warnings.push("余额 API 必须使用 HTTPS 地址，已忽略该 URL");
			else if (parsed.username || parsed.password) warnings.push("余额 API 地址不能包含账号密码，已忽略该 URL");
			else url = parsed.toString();
		} catch {
			warnings.push("余额 API 地址无效，已忽略");
		}
	}
	if (source.method !== undefined && source.method !== "GET") {
		warnings.push("旧的请求方法已不再使用：余额 API 固定使用 GET");
	}
	if (isPlainObject(source.headers) && Object.keys(source.headers).length > 0) {
		warnings.push("旧的额外请求头已不再使用：只发送 Bearer 密钥");
	}
	return {
		url,
		totalPath: clampString(source.totalPath, defaults.totalPath, MAX_PATH_CHARS),
		usedPath: clampString(source.usedPath, defaults.usedPath, MAX_PATH_CHARS),
		currency: sanitizeCurrency(source.currency, warnings),
	};
}

function sanitizeCurrency(value, warnings) {
	if (value === undefined) return POINTS_CURRENCY;
	if (typeof value !== "string") {
		warnings.push("currency 必须是币种代码或 POINTS，已按积分处理");
		return POINTS_CURRENCY;
	}
	const text = value.trim().toUpperCase();
	if (!text || text === POINTS_CURRENCY) return POINTS_CURRENCY;
	if (!isMoneyCurrency(text)) {
		warnings.push(`currency ${text.slice(0, 16)} 不是受支持的币种，已按积分处理`);
		return POINTS_CURRENCY;
	}
	return text;
}

/** Read the stored config, falling back to defaults for a fresh install. */
export async function readConfig(callHost) {
	const entry = await callHost("storage.get", { scope: CONFIG_SCOPE, key: CONFIG_KEY });
	const value = entry && typeof entry === "object" && "value" in entry ? entry.value : undefined;
	if (value === undefined || value === null) {
		return { config: sanitizeConfig({}).config, warnings: [], stored: false };
	}
	const { config, warnings } = sanitizeConfig(value);
	return { config, warnings, stored: true };
}

export async function writeConfig(callHost, config) {
	const written = await callHost("storage.set", { scope: CONFIG_SCOPE, key: CONFIG_KEY, value: config });
	if (written?.stored === false) throw new Error("宿主拒绝保存配置");
	return config;
}
