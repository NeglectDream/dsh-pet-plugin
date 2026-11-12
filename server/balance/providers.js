/**
 * The one balance source: a user-configured HTTPS JSON API.
 *
 * WHAT CHANGED, AND WHY
 * This file used to hold four adapters (DeepSeek official, OpenCode Zen, Command
 * Code, custom) plus a POST/header-capable custom request. The product is now a
 * single API the user names themselves: fixed `GET`, fixed
 * `Authorization: Bearer <customApiKey>`, no provider directory, no method or
 * header configuration. The three built-in adapters are deleted on purpose — an
 * "old provider selection" must not be able to reach a hard-coded API domain.
 *
 * WHAT AN ADAPTER MUST NOT DO
 * Invent a zero, and leak the request. A missing path, `null`, a boolean or a
 * non-numeric string is a `shape_mismatch`, never `0` — a zero triggers the
 * "completely broke" animation, so a parse failure must not declare bankruptcy.
 * Error messages never contain the URL, the key or the response body: they travel
 * to the pet's iframe, and the URL alone can be sensitive.
 */

import { POINTS_CURRENCY, isMoneyCurrency, rawAmount } from "./amounts.js";

/** Vault secret name. Kept stable so an existing user does not have to re-enter it. */
export const CUSTOM_SECRET_KEY = "customApiKey";
/** Hard response-body ceiling. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;
/** Per-request deadline. */
export const REQUEST_DEADLINE_MS = 6000;

/** Read `value` as a finite number, accepting numeric strings. */
export function num(value, label) {
	const parsed = (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) ? Number(value) : Number.NaN;
	if (!Number.isFinite(parsed)) {
		const error = new Error(`字段 ${label} 不是数字`);
		error.kind = "shape_mismatch";
		throw error;
	}
	return parsed;
}

/** Read `value` as a finite number, or `undefined` when it is absent/garbage. */
export function looseNum(value) {
	if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && value.trim() === "")) return undefined;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function obj(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function kindError(kind, message) {
	const error = new Error(message);
	error.kind = kind;
	return error;
}

function shapeError(message) {
	return kindError("shape_mismatch", message);
}

/** Walk a dot path (`data.balance`). Missing segments are `undefined`, never `{}`. */
export function readPath(body, path) {
	if (typeof path !== "string" || path.length === 0) return undefined;
	let cursor = body;
	for (const segment of path.split(".")) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = cursor[segment];
	}
	return cursor;
}

function pickNumber(body, path) {
	const value = readPath(body, path);
	if (value === undefined) return undefined;
	return looseNum(value);
}

async function readCappedText(response, limit) {
	const declared = Number(response.headers?.get?.("content-length"));
	if (Number.isFinite(declared) && declared > limit) throw kindError("response_too_large", "响应超过 1 MiB 上限");
	const body = response.body;
	if (body && typeof body.getReader === "function") {
		const reader = body.getReader();
		const chunks = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				try { await reader.cancel(); } catch { /* the size error is the real one */ }
				throw kindError("response_too_large", "响应超过 1 MiB 上限");
			}
			chunks.push(Buffer.from(value));
		}
		return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
	}
	const text = String(await response.text?.() ?? "");
	if (Buffer.byteLength(text, "utf8") > limit) throw kindError("response_too_large", "响应超过 1 MiB 上限");
	return text;
}

/**
 * One GET request with a caller signal, a 6s deadline and `redirect: "error"`.
 *
 * `redirect: "error"` is deliberate: following a redirect would replay the
 * `Authorization` header to a host the user never configured.
 */
async function httpJson(url, { key, signal, deadlineMs, fetchImpl }) {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadlineMs);
	const onAbort = () => controller.abort();
	signal?.addEventListener?.("abort", onAbort, { once: true });
	try {
		const response = await fetchImpl(url, {
			method: "GET",
			headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
			signal: controller.signal,
			redirect: "error",
		});
		if (response.status === 401 || response.status === 403) throw kindError("auth_failed", `鉴权失败（HTTP ${response.status}）`);
		if (response.status >= 300 && response.status < 400) throw kindError("redirect", "余额 API 返回了重定向（已拒绝）");
		if (!response.ok) throw kindError("http", `HTTP ${response.status}`);
		const text = await readCappedText(response, MAX_RESPONSE_BYTES);
		try {
			return JSON.parse(text);
		} catch {
			throw shapeError("响应不是合法 JSON");
		}
	} catch (error) {
		if (error?.kind) throw error;
		if (timedOut) throw kindError("timeout", "请求超时");
		if (signal?.aborted) throw kindError("network", "请求已取消");
		// Never forward `error.message`: it can contain the hostname or an internal cause.
		throw kindError("network", "网络请求失败");
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener?.("abort", onAbort);
	}
}

export const customProvider = {
	id: "custom",
	label: "余额 API",
	secretKey: CUSTOM_SECRET_KEY,
	description: "你填写的 HTTPS 余额接口，固定 GET + Bearer；用字段路径取出剩余金额与可选的已用金额。",
	async fetch({ key, signal, custom, deadlineMs = REQUEST_DEADLINE_MS, fetchImpl = globalThis.fetch }) {
		const settings = custom ?? {};
		if (typeof settings.url !== "string" || settings.url.length === 0) throw kindError("not_configured", "未配置余额 API 地址");
		let parsed;
		try { parsed = new URL(settings.url); } catch { throw shapeError("余额 API 地址无效"); }
		if (parsed.protocol !== "https:") throw kindError("not_configured", "余额 API 必须使用 HTTPS 地址");
		const totalPath = typeof settings.totalPath === "string" ? settings.totalPath : "";
		if (totalPath.length === 0) throw shapeError("未填写余额字段路径");
		const body = await httpJson(parsed.toString(), { key, signal, deadlineMs, fetchImpl });
		const remaining = pickNumber(body, totalPath);
		if (remaining === undefined) throw shapeError(`字段路径 ${totalPath} 没有取到数字`);
		const usedPath = typeof settings.usedPath === "string" ? settings.usedPath : "";
		const used = usedPath ? pickNumber(body, usedPath) : undefined;
		const currency = isMoneyCurrency(settings.currency) ? settings.currency.toUpperCase() : POINTS_CURRENCY;
		return {
			shape: currency === POINTS_CURRENCY ? "points" : "money",
			currency,
			remaining: rawAmount(remaining),
			// `null` (not 0) means "the API did not say" — the quota stays unknown.
			used: used === undefined ? null : rawAmount(used),
		};
	},
};

export const PROVIDERS = [customProvider];

export function findProvider(id) {
	return PROVIDERS.find((provider) => provider.id === id);
}
