/*
 * Standalone, dependency-free bubble renderer. Presets are build-time JSON.
 * Artwork/text provenance is recorded in bubble-presets.json and the source audit.
 * This file does not fetch, import, evaluate markup, or observe pet physics.
 */
const BubbleKit = (() => {
	"use strict";
	const presets = typeof __PET_BUBBLE_PRESETS__ === "object" ? __PET_BUBBLE_PRESETS__ : { random: [], history: [], templates: [], geometry: {} };
	const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
	const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
	const decimal = (value) => (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) ? String(value) : null;
	const plain = (value) => typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
	const gradients = new Set(["indigo", "candy", "macaron", "galaxy", "rouge", "bamboo", "champagne"]);
	const PRIORITY = Object.freeze({ chat: 10, info: 40, task: 60, balance: 70, budget: 80, permission: 90, manual: 100 });
	const DEFAULT_CONFIG = Object.freeze({ enabled: true, scale: 1, durationMs: 5000, noticeDurationMs: 8000, clickMode: "advance", autoChat: true, overrides: [] });
	function normalizeConfig(value = {}) {
		value = value?.bubbles ?? value ?? {};
		return { enabled: value.enabled !== false, scale: clamp(number(value.scale) ?? 1, 0.75, 1.4),
			durationMs: clamp(number(value.durationMs) ?? 5000, 0, 120000), noticeDurationMs: clamp(number(value.noticeDurationMs) ?? 8000, 0, 120000),
			clickMode: value.clickMode === "home" ? "home" : "advance", autoChat: value.autoChat !== false,
			overrides: Array.isArray(value.overrides) ? value.overrides.slice(0, 120) : [] };
	}
	function safeStyle(style = {}) {
		const fontUnit = ["source-level", "source-u"].includes(style.fontUnit) ? style.fontUnit : "px";
		return { fontSize: clamp(number(style.fontSize) ?? 24, fontUnit === "px" ? 12 : 1, fontUnit === "source-u" ? 240 : fontUnit === "source-level" ? 50 : 80),
			fontUnit, bold: style.bold === true, italic: style.italic === true, underline: style.underline === true,
			gradient: gradients.has(style.gradient) ? style.gradient : null };
	}
	function interpolate(text, values = {}) {
		return String(text ?? "").replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_, key) =>
			Object.prototype.hasOwnProperty.call(values, key) ? plain(values[key]) : "—");
	}
	function randomPool(overrides = []) {
		const changes = new Map((Array.isArray(overrides) ? overrides : []).filter((item) => item && typeof item.id === "string").map((item) => [item.id, item]));
		return (presets.random ?? []).map((entry) => {
			const override = changes.get(entry.id);
			return { ...entry, kind: "text", text: typeof override?.text === "string" && override.text.trim() ? override.text.slice(0, 300) : entry.text,
				weight: number(override?.weight) === null ? entry.weight : clamp(override.weight, 0, 100), style: safeStyle(entry.style) };
		}).filter((entry) => typeof entry.text === "string" && entry.text.trim() && entry.weight > 0);
	}
	function pickRandom(overrides = [], rng = Math.random, previousText = "") {
		const pool = randomPool(overrides);
		const candidates = pool.filter((entry) => entry.text !== previousText);
		// A deliberately single-sentence pool may repeat; all-zero pools stay silent.
		const available = candidates.length ? candidates : pool;
		const total = available.reduce((sum, entry) => sum + entry.weight, 0);
		if (!total) return null;
		let ticket = clamp(Number(rng()) || 0, 0, 1 - Number.EPSILON) * total;
		return available.find((entry) => (ticket -= entry.weight) < 0) ?? available.at(-1);
	}
	function template(id, values = {}) {
		const entry = (presets.templates ?? []).find((item) => item.id === id);
		if (!entry) return { id, kind: "text", text: "暂无可用数据", style: safeStyle() };
		return { ...entry, kind: "text", text: interpolate(entry.text, values), style: safeStyle(entry.style) };
	}
	function formatAmount(value, currency = "") {
		const amount = decimal(value);
		if (amount === null) return "—";
		const [integer, fraction = ""] = amount.split(".");
		// Formatting never converts server fixed-point strings to binary floats.
		const trimmed = fraction.replace(/0+$/, "");
		const formatted = `${integer}${trimmed ? `.${trimmed}` : ""}`;
		return currency ? `${formatted} ${currency}` : formatted;
	}
	function displayAmount(value, currency = "") {
		const raw = decimal(value);
		if (raw === null) return "—";
		if (!/^(?:USD|CNY|RMB|EUR|GBP|JPY|AUD|CAD|CHF|HKD|SGD|KRW|INR|TWD|NZD|RUB|BRL)$/.test(currency)) return formatAmount(raw);
		const negative = raw.startsWith("-"), unsigned = negative ? raw.slice(1) : raw;
		const [whole, fraction = ""] = unsigned.split(".");
		const digits = fraction.padEnd(3, "0");
		let cents = BigInt(whole) * 100n + BigInt(digits.slice(0, 2));
		if (digits[2] >= "5") cents += 1n;
		const out = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
		return negative && cents !== 0n ? `-${out}` : out;
	}
	function amountModule(key, label, value, currency, options = {}) {
		return { key, label, value: options.unlimited ? "不限" : displayAmount(value, currency), unit: decimal(value) === null || options.unlimited ? "" : currency,
			numeric: options.unlimited ? null : decimal(value), ...options };
	}
	function balance(snapshot, ledger) {
		const result = { id: "balance", kind: "balance", title: "余额", status: "ok", modules: [], style: safeStyle({ fontSize: 24, bold: true, gradient: "indigo" }) };
		if (snapshot?.status === "unconfigured") {
			result.status = "unconfigured";
			result.modules.push({ key: "setup", label: "", value: String(snapshot.message ?? "请先配置第三方余额 API。"), unit: "" });
			return result;
		}
		if (!snapshot || snapshot.loading === true || snapshot.status === "loading") {
			result.status = snapshot ? "loading" : "missing";
			result.modules.push({ key: "status", label: "", value: snapshot ? "正在查询第三方余额 API…" : "暂无余额数据", unit: "" });
			return result;
		}
		if (snapshot.stale === true || snapshot.ok === false) {
			result.status = snapshot.stale ? "stale" : "error";
			result.modules.push({ key: "freshness", label: snapshot.stale ? "旧数据" : "查询失败", value: plain(snapshot.error?.message ?? snapshot.error ?? "余额暂不可用"), unit: "", detail: true });
			if (snapshot.fetchedAt) result.modules.push({ key: "asof", label: "更新于", value: String(snapshot.fetchedAt), unit: "", detail: true });
		}
		let accounts = snapshot.accounts ?? snapshot.balances;
		if (!Array.isArray(accounts)) accounts = Array.isArray(snapshot.amounts) ? snapshot.amounts : [];
		if (!accounts.length && (snapshot.remaining !== undefined || snapshot.totalBalance !== undefined)) accounts = [snapshot];
		accounts = accounts.slice(0, 1);
		accounts.forEach((account, index) => {
			const prefix = String(account.accountId ?? account.id ?? index);
			const currency = typeof account.currency === "string" ? account.currency : account.shape === "points" || snapshot.shape === "points" ? "POINTS" : "";
			const remaining = account.remaining ?? account.totalBalance;
			result.modules.push(amountModule(`${prefix}:remaining`, "余额", remaining, currency, { main: true }));
			if (decimal(account.used) !== null) result.modules.push(amountModule(`${prefix}:used`, "已用", account.used, currency));
		});
		if (!accounts.length) result.modules.push({ key: "empty", label: "", value: snapshot.ok === false ? "未取得可用余额" : "余额 API 未返回可用余额", unit: "" });
		const ledgers = Array.isArray(ledger?.accounts) ? ledger.accounts : [];
		const currentAccounts = new Map(accounts.filter((entry) => typeof entry.accountId === "string").map((entry) => [entry.accountId, entry]));
		const filterLedger = currentAccounts.size === accounts.length;
		for (const entry of ledgers) {
			if (entry.eligible === false || filterLedger && (!currentAccounts.has(entry.accountId) || currentAccounts.get(entry.accountId).currency !== entry.currency)) continue;
			const observed = entry.today?.spend ?? entry.today?.observedSpend ?? entry.day?.spend;
			if (decimal(observed) === null) continue;
			const prefix = `ledger:${entry.accountId ?? entry.id ?? result.modules.length}`;
			const ledgerLabel = "今日观测";
			if (entry.observedFrom === null) {
				result.modules.push({ key: prefix, label: ledgerLabel, value: "尚未建立观测基线", unit: "", detail: true }); continue;
			}
			result.modules.push(amountModule(prefix, `今日已观测消费${entry.stale ? "（旧观测）" : ""}`, observed, entry.currency ?? "", { detail: true }));
			if (entry.incompleteReasons?.length) result.modules.push({ key: `${prefix}:incomplete`, label: ledgerLabel, value: "观测不完整，不代表完整账单", unit: "", detail: true });
			const from = entry.observedFrom ?? entry.firstObservedAt ?? entry.today?.observedFrom;
			const to = entry.observedTo ?? entry.lastObservedAt ?? entry.today?.observedTo;
			if (from || to) result.modules.push({ key: `${prefix}:window`, label: "观测区间", value: `${from ?? "—"} → ${to ?? "—"}`, unit: "", detail: true });
		}
		return result;
	}
	function normalizeContent(content) {
		if (typeof content === "string") return content.trim() ? { kind: "text", text: content, style: safeStyle() } : null;
		if (!content || typeof content !== "object") return null;
		if (content.kind === "balance" && Array.isArray(content.modules)) return { ...content, style: safeStyle(content.style) };
		if (typeof content.text !== "string" || !content.text.trim()) return null;
		return { ...content, kind: "text", text: content.text, style: safeStyle(content.style) };
	}
	function graphemes(text) {
		if (typeof Intl?.Segmenter === "function") return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment);
		return Array.from(text);
	}
	function tokens(text) {
		const result = [];
		// Keep monetary/percentage values and their unit together on every page.
		const pattern = /(?:[¥￥$€£]\s*)?-?\d[\d,]*(?:\.\d+)?(?:\s?(?:USD|CNY|RMB|EUR|GBP|JPY|POINTS|tokens?|点|元|%))?/gi;
		let offset = 0;
		for (const match of text.matchAll(pattern)) {
			result.push(...graphemes(text.slice(offset, match.index)), match[0]);
			offset = match.index + match[0].length;
		}
		result.push(...graphemes(text.slice(offset)));
		return result;
	}
	function estimateWidth(text, fontSize) {
		return graphemes(text).reduce((sum, char) => sum + (/^[ .,;:!|'ilI]$/.test(char) ? 0.34 : /^[MW@%]$/.test(char) ? 0.94 : /^[\x00-\x7f]$/.test(char) ? 0.64 : 1.02) * fontSize, 0);
	}
	function paginateText(text, { width = 160, height = 80, fontSize = 16, lineHeight = 1.25, measure = estimateWidth } = {}) {
		text = String(text ?? "");
		const rows = Math.max(1, Math.floor(height / (fontSize * lineHeight)));
		const lines = [];
		let line = "";
		for (const token of tokens(text)) {
			if (token === "\n") { lines.push(`${line}\n`); line = ""; continue; }
			if (line && measure(line + token, fontSize) > width) { lines.push(line); line = ""; }
			line += token;
		}
		if (line || !lines.length) lines.push(line);
		const pages = [];
		for (let i = 0; i < lines.length; i += rows) pages.push({ text: lines.slice(i, i + rows).join(""), lines: lines.slice(i, i + rows) });
		return pages;
	}
	function rect(value = {}) {
		const left = number(value.left) ?? number(value.x) ?? 0, top = number(value.top) ?? number(value.y) ?? 0;
		const width = Math.max(0, number(value.width) ?? ((number(value.right) ?? left) - left));
		const height = Math.max(0, number(value.height) ?? ((number(value.bottom) ?? top) - top));
		return { left, top, width, height, right: left + width, bottom: top + height };
	}
	function intersect(a, b) { return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)); }
	function layout(body, viewport, config, content) {
		body = rect(body); viewport = rect(viewport);
		const availableWidth = Math.max(1, viewport.width - 8), availableHeight = Math.max(1, viewport.height - 8);
		// The *visible main ellipse* (746 SVG units), not the padded viewBox,
		// is about 1.35 times the supplied visible pet body width.
		const desired = Math.max(196, body.width * 1.35 * config.scale * 1026 / 746);
		const width = Math.min(availableWidth, availableHeight * 1026 / 700, desired);
		const height = width * 700 / 1026;
		const textWidth = Math.max(24, width * 0.62);
		const textHeight = Math.max(16, height * 0.48 - 12);
		const compact = width < 196 || content?.kind === "balance" && textHeight < 64;
		const originalSize = content?.style?.fontSize ?? 24;
		const units = content?.style?.fontUnit;
		const preferred = units === "source-level" ? Math.round(40 + (originalSize - 1) * 200 / 49) * width / 1026 : units === "source-u" ? originalSize * width / 1026 : originalSize;
		const fontSize = compact && content?.kind === "balance" ? 12 : Math.max(12, Math.min(preferred, width * 0.16));
		return { width, height, textWidth, textHeight, fontSize, compact };
	}
	function place(body, viewport, size, avoid = []) {
		body = rect(body); viewport = rect(viewport);
		const gap = 3, padding = 4, cx = (body.left + body.right) / 2;
		const clampPoint = (x, y) => rect({ left: clamp(x, viewport.left + padding, Math.max(viewport.left + padding, viewport.right - size.width - padding)),
			top: clamp(y, viewport.top + padding, Math.max(viewport.top + padding, viewport.bottom - size.height - padding)), width: size.width, height: size.height });
		const candidates = [
			[cx - size.width * 0.65, body.top - size.height + 8, false, false],
			[cx - size.width * 0.35, body.top - size.height + 8, true, false],
			[cx - size.width * 0.65, body.bottom - 8, false, true],
			[cx - size.width * 0.35, body.bottom - 8, true, true],
			[body.left - size.width - gap, body.top - size.height * 0.35, true, false],
			[body.right + gap, body.top - size.height * 0.35, false, false],
		].map(([x, y, flipX, flipY], index) => {
			const candidate = clampPoint(x, y);
			const overlap = avoid.slice(0, 16).reduce((sum, other) => sum + intersect(candidate, rect(other)), 0);
			const own = intersect({ ...candidate, bottom: candidate.top + candidate.height * 0.77 }, body);
			return { ...candidate, flipX, flipY, overlap, score: overlap * 4 + own * 2 + Math.abs(candidate.left - x) + Math.abs(candidate.top - y) + index * 0.001 };
		});
		return candidates.reduce((best, current) => current.score < best.score ? current : best);
	}
	function clockAdapter(clock = {}) {
		const now = typeof clock === "function" ? clock : typeof clock.now === "function" ? clock.now.bind(clock) : () => Date.now();
		return { now, setTimeout: typeof clock.setTimeout === "function" ? clock.setTimeout.bind(clock) : globalThis.setTimeout.bind(globalThis),
			clearTimeout: typeof clock.clearTimeout === "function" ? clock.clearTimeout.bind(clock) : globalThis.clearTimeout.bind(globalThis),
			requestAnimationFrame: clock.requestAnimationFrame?.bind(clock) ?? globalThis.requestAnimationFrame?.bind(globalThis) ?? ((fn) => globalThis.setTimeout(() => fn(now()), 16)),
			cancelAnimationFrame: clock.cancelAnimationFrame?.bind(clock) ?? globalThis.cancelAnimationFrame?.bind(globalThis) ?? globalThis.clearTimeout.bind(globalThis) };
	}

	/* Pure lifecycle controller, also used by the DOM adapter and deterministic tests. */
	class Session {
		constructor({ config, snapshot, ledger, clock, rng = Math.random, onChange, onHome } = {}) {
			this.config = normalizeConfig(config); this.snapshot = snapshot; this.ledger = ledger; this.clock = clockAdapter(clock);
			this.rng = rng; this.onChange = onChange; this.onHome = onHome; this.generation = 0; this.scene = "closed";
			this.content = null; this.pageIndex = 0; this.pageCount = 1; this.deadline = 0; this.queue = []; this.previousRandom = "";
			this.priority = 0; this.visible = true; this.destroyed = false; this.automatic = false; this.timer = null; this.contentId = null; this.lastClosedId = null;
		}
		_notify(reason) {
			this.generation += 1;
			if (this.timer !== null) this.clock.clearTimeout(this.timer);
			this.timer = null;
			const generation = this.generation;
			if (this.content && this.deadline && this.visible) this.timer = this.clock.setTimeout(() => {
				if (generation !== this.generation || this.destroyed) return;
				this.tick();
			}, Math.max(0, this.deadline - this.clock.now()));
			this.onChange?.(this, reason);
		}
		_activate(content, { scene = "notice", priority = PRIORITY.info, durationMs = this.config.noticeDurationMs, automatic = false, expiresAt = 0 } = {}) {
			if (!this.config.enabled || this.destroyed || !content) return false;
			this.content = content; this.contentId = content.id ?? null; this.scene = scene; this.priority = priority; this.automatic = automatic; this.pageIndex = 0; this.pageCount = 1;
			this.deadline = durationMs === 0 ? 0 : this.clock.now() + durationMs;
			if (expiresAt) this.deadline = this.deadline ? Math.min(this.deadline, expiresAt) : expiresAt;
			this._notify("content"); return true;
		}
		show(content, options = {}) {
			content = normalizeContent(content);
			if (!content || this.destroyed || !this.config.enabled) return false;
			const automatic = options.automatic === true;
			const priority = number(options.priority) ?? (automatic ? PRIORITY.chat : PRIORITY.info);
			const chatter = automatic && priority <= PRIORITY.chat;
			if (chatter && (!this.config.autoChat || !this.visible)) return false;
			if (options.id) content = { ...content, id: options.id };
			const expiresAt = number(options.expiresAt) ?? (this.clock.now() + (chatter ? this.config.durationMs || 5000 : 30000));
			if (expiresAt && expiresAt <= this.clock.now()) return false;
			if (this.content && priority < this.priority || !this.visible) {
				const entry = { content, options: { ...options, priority, automatic, expiresAt }, id: options.id ?? content.id };
				this.queue = this.queue.filter((old) => !entry.id || old.id !== entry.id);
				this.queue.push(entry); this.queue.sort((a, b) => b.options.priority - a.options.priority); this.queue = this.queue.slice(0, 8); return false;
			}
			return this._activate(content, { ...options, automatic, priority, durationMs: options.durationMs ?? (chatter ? this.config.durationMs : this.config.noticeDurationMs), expiresAt: options.expiresAt ?? 0 });
		}
		home() {
			if (!this.config.enabled || this.destroyed) return false;
			this.onHome?.();
			return this._activate(balance(this.snapshot, this.ledger), { scene: "balance", priority: PRIORITY.manual, durationMs: this.config.durationMs });
		}
		interact() { return this.config.clickMode === "home" ? this.home() : this.advance(); }
		advance() {
			if (!this.config.enabled || this.destroyed) return false;
			if (!this.content) return this.home();
			if (this.pageIndex + 1 < this.pageCount) {
				this.pageIndex += 1; this.deadline = this.config.durationMs === 0 ? 0 : this.clock.now() + this.config.durationMs;
				this._notify("page"); return true;
			}
			if (this.scene === "balance") {
				const choice = pickRandom(this.config.overrides, this.rng, this.previousRandom);
				if (!choice) { this.close(); return false; }
				this.previousRandom = choice.text;
				return this._activate(choice, { scene: "random", priority: PRIORITY.manual, durationMs: this.config.durationMs });
			}
			this.close(); return false;
		}
		updateData(snapshot, ledger = this.ledger) {
			this.snapshot = snapshot; this.ledger = ledger;
			if (this.scene === "balance" && this.content) {
				const next = balance(snapshot, ledger);
				if (JSON.stringify(next) !== JSON.stringify(this.content)) { this.content = next; this._notify("data"); }
			}
		}
		setConfig(config) {
			const previous = this.config;
			this.config = normalizeConfig(config);
			if (!this.config.enabled) { this.queue = []; this.close(); }
			else if (!this.config.autoChat && this.automatic && this.priority <= PRIORITY.chat) {
				this.queue = this.queue.filter((entry) => !entry.options.automatic || entry.options.priority > PRIORITY.chat);
				this.close({ drain: true });
			} else {
				if (!this.config.autoChat) this.queue = this.queue.filter((entry) => !entry.options.automatic || entry.options.priority > PRIORITY.chat);
				const durationKey = this.scene === "notice" && (!this.automatic || this.priority > PRIORITY.chat) ? "noticeDurationMs" : "durationMs";
				if (this.content && previous[durationKey] !== this.config[durationKey]) this.deadline = this.config[durationKey] === 0 ? 0 : this.clock.now() + this.config[durationKey];
				this._notify("config");
			}
		}
		setVisible(visible) {
			this.visible = visible !== false;
			if (!this.visible) {
				this.queue = this.queue.filter((entry) => !entry.options.automatic || entry.options.priority > PRIORITY.chat);
				if (this.automatic && this.priority <= PRIORITY.chat) { this.close({ drain: true }); return; }
				this._notify("hidden"); return;
			}
			this.tick();
			if (this.content) this._notify("visible"); else this._drain();
		}
		tick() {
			const now = this.clock.now();
			this.queue = this.queue.filter((entry) => !entry.options.expiresAt || entry.options.expiresAt > now);
			if (this.content && this.deadline && now >= this.deadline) this.close({ drain: true });
		}
		_drain() {
			if (!this.visible || this.destroyed || !this.config.enabled || this.content) return;
			const now = this.clock.now();
			this.queue = this.queue.filter((entry) => !entry.options.expiresAt || entry.options.expiresAt > now);
			const next = this.queue.shift(); if (next) this.show(next.content, next.options);
		}
		close({ drain = false } = {}) {
			this.lastClosedId = this.contentId; this.contentId = null;
			this.content = null; this.scene = "closed"; this.deadline = 0; this.pageIndex = 0; this.pageCount = 1; this.priority = 0;
			if (!drain) this.queue = [];
			this._notify("close"); if (drain) this._drain();
		}
		destroy() { if (this.destroyed) return; this.destroyed = true; this.queue = []; this.close(); this.onChange = null; this.onHome = null; }
	}
	return Object.freeze({ presets, PRIORITY, DEFAULT_CONFIG, Session, safeStyle, interpolate, randomPool, pickRandom, template, balance, formatAmount,
		normalizeContent, normalizeConfig, paginateText, layout, place, rect, tokens, estimateWidth, clockAdapter, displayAmount });
})();

const BubbleContent = Object.freeze({ balance: BubbleKit.balance, template: BubbleKit.template, random: BubbleKit.pickRandom });

class PetBubble extends BubbleKit.Session {
	constructor(options = {}) {
		super({ ...options, onChange: undefined });
		this.container = options.container; this.bodySource = options.body; this.viewportSource = options.viewport;
		this.surface = options.surface === "overlay" ? "overlay" : "panel"; this.userOnChange = options.onChange;
		this.document = this.container?.ownerDocument ?? globalThis.document;
		this.frames = new Set(); this.transitions = new Set(); this.pages = []; this.amountNodes = new Map(); this.rect = null;
		this.size = null; this.sizeKey = ""; this.avoid = []; this.deferred = false; this.renderedGeneration = -1;
		this.reducedMotion = options.reducedMotion === true || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
		this.onChange = (_, reason) => { this._render(reason); this.userOnChange?.(this, reason); };
		if (!this.document || !this.container) return;
		this._create();
		this.visibilityListener = () => this.setVisible(!this.document.hidden);
		this.document.addEventListener?.("visibilitychange", this.visibilityListener);
		this.visible = !this.document.hidden;
	}
	_create() {
		const doc = this.document, ns = "http://www.w3.org/2000/svg", geometry = BubbleKit.presets.geometry;
		this.element = doc.createElement("div"); this.element.className = "pet-thought"; this.element.hidden = true;
		this.element.dataset.surface = this.surface; this.element.setAttribute("role", "status"); this.element.setAttribute("aria-live", "polite");
		this.svg = doc.createElementNS(ns, "svg"); this.svg.setAttribute("viewBox", geometry.viewBox ?? "0 0 1026 700");
		this.svg.setAttribute("aria-hidden", "true"); this.svg.classList.add("pet-thought-shape");
		this.shapeGroup = doc.createElementNS(ns, "g");
		const paths = geometry.paths ?? [];
		paths.forEach((entry, index) => {
			const path = doc.createElementNS(ns, entry.tag === "ellipse" ? "ellipse" : "path");
			if (entry.tag === "ellipse") for (const attribute of ["cx", "cy", "rx", "ry"]) path.setAttribute(attribute, String(entry[attribute]));
			else path.setAttribute("d", typeof entry === "string" ? entry : entry.d);
			path.setAttribute("fill", "#fff"); path.setAttribute("stroke", "#203170"); path.setAttribute("stroke-width", "18");
			path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round");
			path.classList.add("pet-thought-part", typeof entry === "object" && entry.role ? `pet-thought-${entry.role}` : `pet-thought-part-${index}`);
			this.shapeGroup.append(path);
		});
		this.svg.append(this.shapeGroup);
		this.textElement = doc.createElement("div"); this.textElement.className = "pet-thought-content";
		this.pageElement = doc.createElement("span"); this.pageElement.className = "pet-thought-page";
		this.element.append(this.svg, this.textElement, this.pageElement); this.container.append(this.element);
		this.clickListener = (event) => { if (this.surface === "overlay") return; event.preventDefault(); event.stopPropagation(); this.advance(); };
		this.downListener = (event) => { if (this.surface !== "overlay") event.stopPropagation(); };
		this.svg.addEventListener("click", this.clickListener); this.svg.addEventListener("pointerdown", this.downListener);
	}
	_cancelVisual() {
		for (const frame of this.frames) this.clock.cancelAnimationFrame(frame); this.frames.clear();
		for (const timer of this.transitions) this.clock.clearTimeout(timer); this.transitions.clear();
	}
	_later(callback, delay) {
		const generation = this.generation;
		const id = this.clock.setTimeout(() => { this.transitions.delete(id); if (!this.destroyed && generation === this.generation) callback(); }, delay);
		this.transitions.add(id);
	}
	_frame(callback) {
		const generation = this.generation;
		const id = this.clock.requestAnimationFrame((time) => { this.frames.delete(id); if (!this.destroyed && generation === this.generation) callback(time); });
		this.frames.add(id);
	}
	_body() { return BubbleKit.rect(typeof this.bodySource === "function" ? this.bodySource() : this.bodySource); }
	_viewport() { return BubbleKit.rect(typeof this.viewportSource === "function" ? this.viewportSource() : this.viewportSource); }
	_buildPages() {
		const size = this.size;
		if (this.content.kind !== "balance") {
			this.pages = BubbleKit.paginateText(this.content.text, { width: size.textWidth, height: size.textHeight, fontSize: size.fontSize });
		} else if (size.compact) {
			// Tiny pets/viewports use readable text pages rather than shrink numbers
			// below 12px or crop labels. Monetary tokens stay indivisible.
			const text = this.content.modules.map((module) => `${module.label}${module.label ? "\n" : ""}${module.value}${module.unit ? ` ${module.unit}` : ""}`).join("\n");
			this.pages = BubbleKit.paginateText(text, { width: size.textWidth, height: size.textHeight, fontSize: 12 });
		} else {
			const pages = []; let page = [], height = 20;
			for (const module of this.content.modules) {
				const rowHeight = module.main ? 48 : module.detail ? 30 : 18;
				if (page.length && height + rowHeight > size.textHeight) { pages.push({ modules: page }); page = []; height = 20; }
				// Long error/status details paginate too; amounts remain indivisible.
				if (module.detail && !module.numeric) {
					const chunks = BubbleKit.paginateText(module.value, { width: size.textWidth, height: Math.max(16, size.textHeight - 34), fontSize: 12 });
					for (const chunk of chunks) {
						if (page.length) { pages.push({ modules: page }); page = []; }
						pages.push({ modules: [{ ...module, value: chunk.text }] });
					}
					height = 20; continue;
				}
				page.push(module); height += rowHeight;
			}
			if (page.length) pages.push({ modules: page }); this.pages = pages.length ? pages : [{ modules: [] }];
		}
		this.pageCount = this.pages.length; this.pageIndex = Math.min(this.pageIndex, this.pageCount - 1);
	}
	_render(reason) {
		this._cancelVisual();
		if (!this.element) return;
		if (!this.content || !this.visible || this.destroyed) {
			this.element.hidden = true; this.element.removeAttribute("data-open"); this.rect = null; return;
		}
		const wasOpen = !this.element.hidden;
		const previousAmounts = new Map([...this.amountNodes].map(([key, entry]) => [key, entry.numeric]));
		this.element.hidden = false; this.element.dataset.scene = this.scene;
		this.size = BubbleKit.layout(this._body(), this._viewport(), this.config, this.content);
		this.sizeKey = `${this.size.width}:${this.size.height}:${this.size.fontSize}`;
		this._buildPages(); this.position();
		if (!this.content || this.destroyed) return;
		const draw = () => {
			this._drawPage(reason === "data" ? previousAmounts : new Map());
			if (wasOpen) this.element.dataset.switch = "in";
			else this.element.removeAttribute("data-switch");
		};
		if (wasOpen && (reason === "page" || reason === "content") && !this.reducedMotion) {
			this.element.dataset.switch = "out"; this._later(draw, 120);
		} else draw();
		this.element.dataset.reducedMotion = String(this.reducedMotion);
		if (!wasOpen) { this.element.removeAttribute("data-open"); this._frame(() => { this.element.dataset.open = "true"; }); }
		else this.element.dataset.open = "true";
	}
	_drawPage(previousAmounts) {
		if (!this.content || !this.textElement) return;
		this.textElement.replaceChildren(); this.amountNodes.clear();
		this.textElement.style.fontSize = `${this.size.fontSize}px`;
		this.textElement.style.fontWeight = this.content.style.bold ? "700" : "400";
		this.textElement.style.fontStyle = this.content.style.italic ? "italic" : "normal";
		this.textElement.style.textDecoration = this.content.style.underline ? "underline" : "none";
		this.textElement.dataset.gradient = this.content.style.gradient ?? "none";
		const page = this.pages[this.pageIndex];
		if (page.modules) {
			const title = this.document.createElement("div"); title.className = "pet-thought-title"; title.textContent = this.content.title;
			this.textElement.append(title);
			for (const module of page.modules) {
				const row = this.document.createElement("div"); row.className = `pet-thought-row${module.main ? " is-main" : ""}${module.detail ? " is-detail" : ""}`;
				const label = this.document.createElement("span"); label.className = "pet-thought-label"; label.textContent = module.label;
				const value = this.document.createElement("span"); value.className = "pet-thought-value"; value.textContent = module.value;
				if (module.unit) {
					const amount = this.document.createElement("span"); amount.className = "pet-thought-number";
					const unit = this.document.createElement("span"); unit.className = "pet-thought-unit"; unit.textContent = ` ${module.unit}`;
					amount.append(value, unit); row.append(label, amount);
				} else row.append(label, value);
				this.textElement.append(row);
				this.amountNodes.set(module.key, { node: value, numeric: module.numeric });
				const previous = previousAmounts.get(module.key);
				if (module.numeric !== null && module.numeric !== undefined && previous !== undefined && previous !== module.numeric && !this.reducedMotion) this._animateAmount(value, previous, module.numeric, module.value);
			}
		} else {
			for (const line of page.lines) { const node = this.document.createElement("div"); node.className = "pet-thought-line"; node.textContent = line.replace(/\n$/, "") || "\u00a0"; this.textElement.append(node); }
		}
		this.pageElement.textContent = this.pageCount > 1 ? `${this.pageIndex + 1}/${this.pageCount}` : "";
		this.element.setAttribute("aria-label", page.modules ? `${this.content.title} ${page.modules.map((row) => `${row.label} ${row.value} ${row.unit}`).join("，")}` : page.text);
	}
	_animateAmount(node, from, to, displayValue) {
		const start = Number(from), end = Number(to);
		if (!Number.isFinite(start) || !Number.isFinite(end) || Math.abs(start) > 1e12 || Math.abs(end) > 1e12) return;
		const started = this.clock.now(), target = displayValue ?? BubbleKit.formatAmount(to), pageIndex = this.pageIndex;
		const step = () => {
			if (this.pageIndex !== pageIndex || !node.isConnected) return;
			const progress = Math.min(1, Math.max(0, (this.clock.now() - started) / 280));
			node.textContent = progress === 1 ? target : (start + (end - start) * (1 - (1 - progress) ** 3)).toFixed(2);
			if (progress < 1) this._frame(step);
		};
		this._frame(step);
	}
	position(body, viewport, avoidRects = this.avoid) {
		if (body !== undefined) this.bodySource = body;
		if (viewport !== undefined) this.viewportSource = viewport;
		this.avoid = Array.isArray(avoidRects) ? avoidRects : [];
		if (!this.element || !this.content || !this.visible || this.destroyed) return null;
		this.tick(); if (!this.content) return null;
		const bodyRect = this._body(), viewportRect = this._viewport();
		const nextSize = BubbleKit.layout(bodyRect, viewportRect, this.config, this.content);
		const key = `${nextSize.width}:${nextSize.height}:${nextSize.fontSize}`;
		if (key !== this.sizeKey) { this.size = nextSize; this.sizeKey = key; this._buildPages(); this._cancelVisual(); this._drawPage(new Map()); }
		const placed = BubbleKit.place(bodyRect, viewportRect, this.size, this.avoid);
		this.deferred = this.automatic && this.priority <= BubbleKit.PRIORITY.chat && placed.overlap > this.size.width * this.size.height * 0.15;
		this.element.hidden = this.deferred;
		if (this.deferred) { this.rect = null; return null; }
		this.rect = placed;
		this.element.style.width = `${this.size.width}px`; this.element.style.height = `${this.size.height}px`;
		this.element.style.transform = `translate(${placed.left}px, ${placed.top}px)`;
		this.element.dataset.compact = String(this.size.compact);
		this.shapeGroup.setAttribute("transform", `translate(${placed.flipX ? 1026 : 0} ${placed.flipY ? 700 : 0}) scale(${placed.flipX ? -1 : 1} ${placed.flipY ? -1 : 1})`);
		// Only artwork mirrors. Text always stays upright.
		this.element.dataset.below = String(placed.flipY);
		this.element.dataset.mirrored = String(placed.flipX);
		return placed;
	}
	destroy() {
		if (this.destroyed) return;
		super.destroy(); this._cancelVisual();
		this.document?.removeEventListener?.("visibilitychange", this.visibilityListener);
		this.svg?.removeEventListener("click", this.clickListener); this.svg?.removeEventListener("pointerdown", this.downListener);
		this.element?.remove(); this.element = null; this.rect = null; this.amountNodes.clear();
	}
}
