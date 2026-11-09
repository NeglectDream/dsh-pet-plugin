/**
 * Balance sources: one entry per service the pet can read a number from.
 *
 * PORTED, NOT REINVENTED
 * Endpoint paths, response field names and the "which number means spent"
 * decisions come from dsh-pet's `src/host/balance/providers/*`. Those were
 * derived against the real APIs; re-deriving them here would just be a chance to
 * get a field name wrong.
 *
 * WHAT WAS DROPPED
 * `deepseek-account.ts` (the "sign in with a DSH account" route) has no
 * counterpart: there is no credential service to borrow a session from, and the
 * plugin can only hold its own secrets. So balance here is API-key-only.
 *
 * WHAT EVERY ADAPTER MUST NOT DO
 * Invent a zero. A missing field or an unusable response is an error, never
 * `0` — a balance of zero triggers the "completely broke" animation, and a
 * transient parse failure must not make the pet declare bankruptcy.
 */

/** Read `value` as a finite number, accepting numeric strings. */
export function num(value, label) {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) {
		const error = new Error(`字段 ${label} 不是数字`);
		error.kind = "shape_mismatch";
		throw error;
	}
	return parsed;
}

/** Read `value` as a finite number, or `undefined` when it is absent/garbage. */
export function looseNum(value) {
	if (value === undefined || value === null || value === "") return undefined;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function obj(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

export function str(value, label) {
	if (typeof value !== "string" || value.length === 0) {
		const error = new Error(`字段 ${label} 缺失`);
		error.kind = "shape_mismatch";
		throw error;
	}
	return value;
}

function shapeError(message) {
	const error = new Error(message);
	error.kind = "shape_mismatch";
	return error;
}

/**
 * DeepSeek's tier reference per currency.
 *
 * There is no FX conversion here on purpose: a percentage is dimensionless, but
 * an *amount* is not, so each wallet is measured against its own currency's
 * reference and the resulting ratios are averaged. CNY 20 / USD 5 are "clearly
 * still funded" amounts for this author's usage, matching dsh-pet's config.
 */
const DEEPSEEK_FULL_BALANCE = { CNY: 20, USD: 5 };

/**
 * Peak/off-peak pricing window (Asia/Shanghai).
 *
 * Computed here rather than in the UI because it is a *provider* fact: the panel
 * has no business knowing DeepSeek's discount hours, and a second copy of this
 * rule in the plugin's frontend would be free to drift from the backend's.
 */
function deepseekPricingTier(now = new Date()) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "Asia/Shanghai",
		weekday: "short",
		hour: "2-digit",
		hourCycle: "h23",
	}).formatToParts(now);
	const pick = (type) => parts.find((part) => part.type === type)?.value;
	const weekday = pick("weekday");
	const hour = Number(pick("hour"));
	if (weekday === "Sat" || weekday === "Sun") return "idle";
	return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) ? "peak" : "idle";
}

/** A short-lived HTTP client: caller-supplied signal + a per-request deadline. */
async function httpJson(url, { key, signal, headers, deadlineMs, method = "GET" }) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("timeout")), deadlineMs);
	const onAbort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const response = await fetch(url, {
			method,
			headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers },
			signal: controller.signal,
			redirect: "follow",
		});
		if (response.status === 401 || response.status === 403) {
			const error = new Error(`鉴权失败（HTTP ${response.status}）`);
			error.kind = "auth_failed";
			throw error;
		}
		if (!response.ok) {
			const error = new Error(`HTTP ${response.status}`);
			error.kind = "http";
			throw error;
		}
		try {
			return await response.json();
		} catch {
			throw shapeError("响应不是合法 JSON");
		}
	} catch (error) {
		if (error?.kind) throw error;
		if (error?.name === "AbortError" || String(error?.message).includes("timeout")) {
			const timeout = new Error("请求超时");
			timeout.kind = "network";
			throw timeout;
		}
		const wrapped = new Error(`网络异常：${error?.message ?? error}`);
		wrapped.kind = "network";
		throw wrapped;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener?.("abort", onAbort);
	}
}

function queryString(params) {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
	}
	const text = search.toString();
	return text ? `?${text}` : "";
}

/**
 * DeepSeek official API key → account balance, per currency.
 *
 * `balance_infos` is an array and all of it is kept: taking only the first entry
 * would silently hide a second currency the account holds.
 */
const deepseekOfficial = {
	id: "deepseek-official",
	label: "DeepSeek 官方 API Key",
	secretKey: "deepseekApiKey",
	description: "读取 https://api.deepseek.com/user/balance 的账户余额（按币种逐条）。",
	async fetch({ key, signal, deadlineMs }) {
		const body = await httpJson("https://api.deepseek.com/user/balance", { key, signal, deadlineMs });
		const infos = obj(body)?.balance_infos;
		if (!Array.isArray(infos) || infos.length === 0) throw shapeError("响应缺少 balance_infos");
		const wallets = infos.map((raw) => {
			const wallet = obj(raw) ?? {};
			const currency = str(wallet.currency, "currency");
			return {
				currency,
				total: str(wallet.total_balance, "total_balance"),
				granted: str(wallet.granted_balance, "granted_balance"),
				toppedUp: str(wallet.topped_up_balance, "topped_up_balance"),
				fullBalance: DEEPSEEK_FULL_BALANCE[currency],
			};
		});
		return { shape: "money", data: { wallets, tier: deepseekPricingTier() } };
	},
};

/** Per-window quota, in USD. The endpoint does not return these; they are plan constants. */
const OPENCODE_QUOTA_USD = { rolling: 12, weekly: 30, monthly: 60 };

const opencodeZen = {
	id: "opencode-zen",
	label: "OpenCode Zen",
	secretKey: "opencodeZenApiKey",
	description: "读取 opencode.ai/zen/go/v1/usage 的三窗口用量（5 小时 / 周 / 月）。",
	async fetch({ key, signal, deadlineMs }) {
		const body = await httpJson("https://opencode.ai/zen/go/v1/usage", { key, signal, deadlineMs });
		const usage = obj(obj(body)?.usage);
		if (!usage) throw shapeError("响应缺少 usage");
		const read = (name) => {
			const window = obj(usage[name]);
			if (!window) throw shapeError(`响应缺少窗口 ${name}`);
			return {
				percent: num(window.percent, `${name}.percent`),
				resetsAt: typeof window.resetsAt === "string" ? window.resetsAt : undefined,
			};
		};
		const rolling = read("rolling");
		const weekly = read("weekly");
		const monthly = read("monthly");
		return {
			shape: "windows",
			data: {
				rolling: rolling.percent,
				weekly: weekly.percent,
				monthly: monthly.percent,
				rollingCapUsd: OPENCODE_QUOTA_USD.rolling,
				weeklyCapUsd: OPENCODE_QUOTA_USD.weekly,
				monthlyCapUsd: OPENCODE_QUOTA_USD.monthly,
				rollingLabel: "5h",
				rollingResetsAt: rolling.resetsAt,
				weeklyResetsAt: weekly.resetsAt,
				monthlyResetsAt: monthly.resetsAt,
			},
		};
	},
};

const COMMANDCODE_API = "https://api.commandcode.ai";

/**
 * Command Code → three windows plus the period's token/request summary.
 *
 * The monthly percentage is derived as `spent / (spent + remaining)`, because the
 * control-plane endpoint reports credits rather than a percentage. That derivation
 * is the reason a missing `credits` field is a hard error here: with the divisor
 * unknown, the fraction would come out as a confident 100%.
 */
const commandCode = {
	id: "commandcode",
	label: "Command Code",
	secretKey: "commandCodeApiKey",
	description: "读取 commandcode.ai 控制面 /alpha/* 的额度、订阅与用量。",
	async fetch({ key, signal, deadlineMs }) {
		const context = { key, signal, deadlineMs };
		const whoami = obj(await httpJson(`${COMMANDCODE_API}/alpha/whoami${queryString({ limits: "1" })}`, context));
		const orgId = typeof obj(whoami?.org)?.id === "string" ? obj(whoami?.org).id : undefined;

		const creditsBody = await httpJson(
			`${COMMANDCODE_API}/alpha/billing/credits${queryString({ orgId })}`,
			context,
		);
		const credits = obj(obj(creditsBody)?.credits);
		if (!credits) throw shapeError("响应缺少 credits");
		const creditFields = [credits.monthlyCredits, credits.purchasedCredits, credits.freeCredits];
		if (creditFields.every((value) => looseNum(value) === undefined)) {
			throw shapeError("credits 响应缺少额度字段");
		}
		const remaining = creditFields.reduce((sum, value) => sum + Math.max(0, looseNum(value) ?? 0), 0);

		// Optional: a pay-as-you-go account has no subscription, which costs only the
		// monthly reset time. Failing the whole read over a missing reset time would
		// throw away three perfectly good percentages.
		let subscription;
		try {
			subscription = await httpJson(
				`${COMMANDCODE_API}/alpha/billing/subscriptions${queryString({ orgId })}`,
				context,
			);
		} catch {
			subscription = undefined;
		}

		// Deliberately no `since`: the server's default range is the billing period,
		// and passing `since` under-counts both requests and spend.
		const summary = obj(
			await httpJson(`${COMMANDCODE_API}/alpha/usage/summary${queryString({ orgId })}`, context),
		);
		if (summary?.totalCost === undefined || summary?.totalCost === null) {
			throw shapeError("usage 响应缺少 totalCost");
		}
		const spent = Math.max(0, num(summary.totalCost, "totalCost"));
		const pool = spent + remaining;

		const data = { monthly: pool > 0 ? (spent / pool) * 100 : 0, monthlyCapUsd: pool || undefined };
		const periodEnd = obj(obj(subscription)?.data)?.currentPeriodEnd;
		if (typeof periodEnd === "string" && periodEnd.length > 0) data.monthlyResetsAt = periodEnd;

		const limits = obj(obj(creditsBody)?.windowLimits) ?? obj(credits.windowLimits);
		if (limits?.limited === true) {
			const fiveHour = obj(limits.fiveHour);
			if (fiveHour) {
				data.rolling = looseNum(fiveHour.percent);
				data.rollingCapUsd = looseNum(fiveHour.capUsd);
				data.rollingLabel = "5h";
				if (typeof fiveHour.resetsAt === "string") data.rollingResetsAt = fiveHour.resetsAt;
			}
			const weekly = obj(limits.weekly);
			if (weekly) {
				data.weekly = looseNum(weekly.percent);
				data.weeklyCapUsd = looseNum(weekly.capUsd);
				if (typeof weekly.resetsAt === "string") data.weeklyResetsAt = weekly.resetsAt;
			}
		}
		return { shape: "windows", data };
	},
};

/**
 * A provider described entirely by user config: a URL, optional headers, and the
 * dot paths to the numbers.
 *
 * This exists so the balance display is not limited to the three services this
 * author happens to use. It is also the only adapter whose *input* is attacker-
 * controlled by definition, so every field is used strictly as a value — no
 * template expansion, no method other than GET/POST, headers limited to what the
 * config sanitiser already clamped.
 */
const custom = {
	id: "custom",
	label: "自定义服务商",
	secretKey: "customApiKey",
	description: "由你自己填写 URL 与字段路径，适配任意返回 JSON 的余额接口。",
	async fetch({ key, signal, deadlineMs, custom: settings }) {
		if (!settings?.url) throw shapeError("未填写自定义服务商 URL");
		const headers = { ...(settings.headers ?? {}) };
		const method = settings.method === "POST" ? "POST" : "GET";
		if (method === "POST") headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
		const body = await httpJson(settings.url, { key, signal, headers, deadlineMs, method });
		const pick = (path) => {
			if (!path) return undefined;
			let cursor = body;
			for (const segment of path.split(".")) {
				if (cursor === null || typeof cursor !== "object") return undefined;
				cursor = cursor[segment];
			}
			return looseNum(cursor);
		};
		const total = pick(settings.totalPath);
		if (total === undefined) {
			throw shapeError(`字段路径 ${settings.totalPath || "(空)"} 没有取到数字`);
		}
		const used = pick(settings.usedPath);
		if (used !== undefined && used + total > 0) {
			return {
				shape: "windows",
				data: { monthly: (used / (used + total)) * 100, monthlyCapUsd: used + total },
			};
		}
		return { shape: "points", data: { remaining: total } };
	},
};

export const PROVIDERS = [deepseekOfficial, opencodeZen, commandCode, custom];

export function findProvider(id) {
	return PROVIDERS.find((provider) => provider.id === id);
}

/** The catalogue the settings panel renders. Never includes a secret value. */
export function providerCatalogue() {
	return PROVIDERS.map((provider) => ({
		id: provider.id,
		label: provider.label,
		secretKey: provider.secretKey,
		description: provider.description,
		isCustom: provider.id === "custom",
	}));
}
