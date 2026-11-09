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

export const CONFIG_KEY = "pet.config";
export const CONFIG_SCOPE = { type: "global" };

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
	version: 1,
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
		 * `"host"` reuses NarraFork's own relay-station balance (no configuration at
		 * all); `"manual"` queries a provider directly with a key the user pastes in.
		 * Host is the default because making someone enter a key the host already
		 * holds is a worse experience for the same number.
		 */
		source: "host",
		/** Only meaningful when `source` is `"manual"`. */
		providerId: null,
		refreshMinutes: 30,
		/** Percentage cut-offs for the six balance animations, ascending, last must be 100. */
		thresholds: Object.freeze([20, 40, 60, 80, 100]),
		custom: Object.freeze({
			label: "",
			url: "",
			method: "GET",
			headers: Object.freeze({}),
			/** Dot path to the remaining amount, e.g. `data.balance`. */
			totalPath: "",
			/** Optional dot path to the spent amount. When absent the provider reports a ratio. */
			usedPath: "",
		}),
	}),
	/** Show the diagnostic HUD on the stage. Handy while tuning, off by default. */
	diagnostics: false,
});

const MAX_COUNT = 6;
const MAX_NAME_CHARS = 60;
const MAX_URL_CHARS = 500;
const MAX_PATH_CHARS = 200;
const MAX_HEADERS = 8;

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampNumber(value, fallback, min, max) {
	const parsed = typeof value === "number" ? value : Number(value);
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
 * Deep-merge a patch onto a base config.
 *
 * Arrays replace wholesale rather than merging element-wise: `thresholds` and any
 * future list have ordered meaning, and a merged list would let a stale entry
 * survive a deliberate reset. `null` is treated as "unset" for object fields so a
 * client can clear `balance.providerId` without knowing the object shape.
 */
export function mergeConfig(base, patch) {
	if (!isPlainObject(patch)) return base;
	const result = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
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
	const config = { version: 1 };

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

	const balance = isPlainObject(source.balance) ? source.balance : {};
	const providerId = balance.providerId;
	config.balance = {
		source: balance.source === "manual" ? "manual" : "host",
		providerId:
			typeof providerId === "string" && providerId.trim().length > 0
				? clampString(providerId, null, 64)
				: null,
		refreshMinutes: clampInteger(balance.refreshMinutes, defaults.balance.refreshMinutes, 1, 1440),
		thresholds: sanitizeThresholds(balance.thresholds, warnings),
		custom: sanitizeCustom(balance.custom, warnings),
	};

	return { config, warnings };
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

function sanitizeCustom(raw, warnings) {
	const defaults = DEFAULT_CONFIG.balance.custom;
	const source = isPlainObject(raw) ? raw : {};
	const headers = {};
	if (isPlainObject(source.headers)) {
		for (const [key, value] of Object.entries(source.headers).slice(0, MAX_HEADERS)) {
			const name = clampString(key, "", MAX_NAME_CHARS);
			if (!name) continue;
			const headerValue = clampString(value, "", MAX_PATH_CHARS);
			if (!headerValue) continue;
			headers[name] = headerValue;
		}
	}
	const url = clampString(typeof source.url === "string" ? source.url : "", "", MAX_URL_CHARS);
	if (url && !/^https?:\/\//i.test(url)) {
		warnings.push("自定义服务商 URL 必须以 http(s):// 开头，已忽略");
	}
	return {
		label: clampString(source.label, defaults.label, MAX_NAME_CHARS),
		url: /^https?:\/\//i.test(url) ? url : "",
		method: source.method === "POST" ? "POST" : "GET",
		headers,
		totalPath: clampString(source.totalPath, defaults.totalPath, MAX_PATH_CHARS),
		usedPath: clampString(source.usedPath, defaults.usedPath, MAX_PATH_CHARS),
	};
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
	await callHost("storage.set", { scope: CONFIG_SCOPE, key: CONFIG_KEY, value: config });
	return config;
}
