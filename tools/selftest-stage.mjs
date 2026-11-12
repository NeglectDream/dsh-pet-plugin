/**
 * Stage regression without a browser.
 *
 * WHY A SECOND STAGE TEST
 * `tools/preview.mjs` proves what only a browser can prove — a real decoder, real
 * layout, real pointer capture. Everything else about the stage is ordinary logic
 * with a clock and a random source, and driving that in Chrome makes failures slow,
 * flaky and hard to bisect. This harness runs the *real* `ui/stage.js` (and the real
 * `ui/sdk.js` preamble) inside `node:vm` with:
 *
 *   - a virtual clock shared by `performance.now`, `setTimeout` and rAF;
 *   - a deterministic `Math.random`;
 *   - a minimal DOM whose `<img>.decode()` resolves on that virtual clock, so the
 *     double-buffered player's async ordering is exercised rather than skipped;
 *   - a stub `narrafork` bridge that serves fabricated animated-WebP bytes through
 *     the same chunked `pet-clip` envelope the backend uses.
 *
 * The boot call at the end of the source is stripped, and this file appends its own
 * export block. That keeps the production source free of test hooks — there is no
 * `if (TEST)` branch in the shipped bundle — while still exercising the exact
 * functions boot uses (`layout`, `applyConfig`, `frame`, `resolveCollisions`).
 *
 * WHAT IT CANNOT COVER
 * Real WebP decoding and alpha, CSS hit-testing/paint order, AudioContext state,
 * the host's CSP/sandbox, and anything the host itself does with `setBounds`.
 * Those stay in `tools/preview.mjs` and the in-panel self-check.
 *
 * USAGE
 *   node tools/selftest-stage.mjs [--filter=lifecycle]
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { PLUGIN_DIR } from "./paths.mjs";

const ANIM_GROUPS = ["idle", "turn", "drag", "click", "move", "small", "play", "eat", "season", "text"];
const STAGE_WIDTH = 1000;
const STAGE_HEIGHT = 620;
const CLIP_WIDTH = 384;
const CLIP_HEIGHT = 216;
const BOOT_MARKERS = [/\n\s*boot\(\)\.catch\(/, /\n\s*void boot\(\);/, /\n\s*boot\(\);/, /\n\s*boot\(\)\s*$/];

/* -------------------------------------------------------------------------- */
/* Assertions and the test runner                                             */
/* -------------------------------------------------------------------------- */

const results = [];
let currentTest;

function brief(error) {
	const text = error && error.stack ? error.stack : String(error);
	return text.split("\n").slice(0, 6).join("\n    ");
}

async function test(name, fn) {
	if (filter && !name.toLowerCase().includes(filter)) return;
	currentTest = name;
	const startedAt = Date.now();
	try {
		await fn();
		results.push({ name, ok: true });
		process.stdout.write(`✓ ${name}\n`);
	} catch (error) {
		results.push({ name, ok: false, error });
		process.stdout.write(`✗ ${name}\n    ${brief(error)}\n`);
	}
	currentTest = undefined;
	void startedAt;
}

function near(actual, expected, tolerance, label) {
	assert.ok(
		Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
		`${label ?? "value"}: expected ${expected} ± ${tolerance}, got ${actual}`,
	);
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

function makeConfig(patch = {}) {
	const config = {
		version: 2,
		count: 1,
		scale: 1,
		gravity: 1,
		bounce: 0.55,
		friction: 0.9,
		collisions: true,
		clickSquash: 0.35,
		roam: true,
		animationGroups: Object.fromEntries(ANIM_GROUPS.map((group) => [group, true])),
		idleMinMs: 4000,
		idleMaxMs: 9000,
		balance: {
			refreshMinutes: 30,
			thresholds: [20, 40, 60, 80, 100],
			custom: { url: "", totalPath: "", usedPath: "", currency: "CNY" },
		},
		sound: { enabled: true, volume: 0.6 },
		bubbles: { enabled: true, scale: 1, durationMs: 5000, noticeDurationMs: 8000, clickMode: "advance", autoChat: true, overrides: [] },
		tasks: { enabled: true },
		diagnostics: false,
	};
	return mergeDeep(config, patch);
}

function mergeDeep(base, patch) {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
	for (const [key, value] of Object.entries(patch)) {
		if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object") {
			base[key] = mergeDeep(base[key], value);
		} else {
			base[key] = value;
		}
	}
	return base;
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/* -------------------------------------------------------------------------- */
/* Animated WebP fixture                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A minimal but structurally valid animated WebP.
 *
 * `webpWithLoopCount` validates RIFF size, the VP8X animation flag, a single ANIM
 * chunk and at least one ANMF frame, so a made-up byte string is not enough — this
 * builds exactly the chunks it checks, with the loop count (0 = forever) at the
 * spec-defined offset (ANIM payload + 4).
 */
function makeAnimatedWebp({ loop = 0, marker = 0 } = {}) {
	const chunks = [];
	const vp8x = Buffer.alloc(10);
	vp8x[0] = 0x02; // animation flag (bit 1 of the VP8X feature byte)
	chunks.push(Buffer.from("VP8X"), uint32(10), vp8x);
	const anim = Buffer.alloc(6);
	anim.writeUInt16LE(loop, 4);
	chunks.push(Buffer.from("ANIM"), uint32(6), anim);
	const anmf = Buffer.alloc(16);
	anmf.writeUInt32LE(marker >>> 0, 0);
	chunks.push(Buffer.from("ANMF"), uint32(16), anmf);
	const body = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
	const header = Buffer.concat([Buffer.from("RIFF"), uint32(body.length), body]);
	return new Uint8Array(header);
}

function uint32(value) {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32LE(value >>> 0, 0);
	return buffer;
}

function animLoopCount(bytes) {
	const buffer = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	for (let offset = 12; offset + 8 <= buffer.length;) {
		const type = buffer.toString("latin1", offset, offset + 4);
		const size = view.getUint32(offset + 4, true);
		if (type === "ANIM") return view.getUint16(offset + 8 + 4, true);
		offset += 8 + size + (size & 1);
	}
	return undefined;
}

/* -------------------------------------------------------------------------- */
/* Virtual clock                                                              */
/* -------------------------------------------------------------------------- */

function createClock() {
	let now = 1_000_000;
	let nextId = 1;
	const timers = new Map();
	const errors = [];
	const raf = new Map();
	let nextRaf = 1;

	const schedule = (callback, delay, args, interval) => {
		const id = nextId++;
		timers.set(id, {
			at: now + Math.max(0, Number(delay) || 0),
			callback,
			args,
			interval: interval ? Math.max(1, Number(delay) || 1) : 0,
			id,
		});
		return id;
	};

	const clock = {
		get now() { return now; },
		timers,
		errors,
		setTimeout: (callback, delay, ...args) => schedule(callback, delay, args, false),
		clearTimeout: (id) => timers.delete(id),
		setInterval: (callback, delay, ...args) => schedule(callback, delay, args, true),
		clearInterval: (id) => timers.delete(id),
		requestAnimationFrame: (callback) => {
			const id = nextRaf++;
			raf.set(id, callback);
			return id;
		},
		cancelAnimationFrame: (id) => raf.delete(id),
		/** Run only the next due timer, so microtasks can schedule timers first. */
		runNextDue(target) {
			let best;
			for (const timer of timers.values()) if (!best || timer.at < best.at) best = timer;
			if (!best || best.at > target) return false;
			now = Math.max(now, best.at);
			if (best.interval) best.at = now + best.interval;
			else timers.delete(best.id);
			try {
				best.callback(...best.args);
			} catch (error) {
				errors.push(error);
			}
			return true;
		},
		setNow(value) {
			now = Math.max(now, value);
		},
		nextAt() {
			let at;
			for (const timer of timers.values()) at = at === undefined ? timer.at : Math.min(at, timer.at);
			return at;
		},
		runFrames(timestamp = now) {
			const callbacks = [...raf.values()];
			raf.clear();
			for (const callback of callbacks) callback(timestamp);
			return callbacks.length;
		},
		hasFrame() {
			return raf.size > 0;
		},
	};
	return clock;
}

const flushMicrotasks = async () => {
	for (let index = 0; index < 60; index += 1) await Promise.resolve();
};

/* -------------------------------------------------------------------------- */
/* Minimal DOM                                                               */
/* -------------------------------------------------------------------------- */

const toCamel = (name) => String(name).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

function makeStyle() {
	const data = {};
	const api = {
		setProperty(name, value) { data[toCamel(name)] = String(value); },
		getPropertyValue(name) { return data[toCamel(name)] ?? ""; },
		removeProperty(name) { delete data[toCamel(name)]; },
	};
	return new Proxy(api, {
		get(target, property) {
			if (property === "cssText") {
				return Object.entries(data).map(([key, value]) => `${key}:${value}`).join(";");
			}
			if (property in target) return target[property];
			return data[property];
		},
		set(target, property, value) {
			if (property === "cssText") {
				for (const key of Object.keys(data)) delete data[key];
				for (const part of String(value).split(";")) {
					const colon = part.indexOf(":");
					if (colon < 0) continue;
					const key = part.slice(0, colon).trim();
					if (!key) continue;
					data[toCamel(key)] = part.slice(colon + 1).trim();
				}
				return true;
			}
			data[property] = value;
			return true;
		},
	});
}

class ElementStub {
	constructor(tag, media) {
		this._tag = String(tag).toLowerCase();
		this.tagName = String(tag).toUpperCase();
		this.media = media;
		this.children = [];
		this.parentNode = null;
		this.attributes = new Map();
		this.dataset = {};
		this.style = makeStyle();
		this._classes = new Set();
		this._listeners = new Map();
		this.hidden = false;
		this.textContent = "";
		this.id = "";
		this.src = "";
		this.naturalWidth = 0;
		this.naturalHeight = 0;
		// Layout is not emulated; tests that care about bubble clamping set these.
		this.offsetWidth = 0;
		this.offsetHeight = 0;
		this._rect = null;
	}

	get textContent() { return this._text + this.children.map((child) => child.textContent ?? "").join(""); }
	set textContent(value) { this._text = String(value ?? ""); for (const child of this.children) child.parentNode = null; this.children = []; }
	get isConnected() { return this._tag === "body" || Boolean(this.parentNode?.isConnected); }
	get className() { return [...this._classes].join(" "); }
	set className(value) { this._classes = new Set(String(value ?? "").split(/\s+/).filter(Boolean)); }
	get classList() {
		return {
			add: (...names) => names.forEach((name) => this._classes.add(name)),
			remove: (...names) => names.forEach((name) => this._classes.delete(name)),
			contains: (name) => this._classes.has(name),
			toggle: (name, force) => {
				const next = force === undefined ? !this._classes.has(name) : Boolean(force);
				if (next) this._classes.add(name);
				else this._classes.delete(name);
				return next;
			},
		};
	}
	append(...nodes) {
		for (const node of nodes.flat()) {
			if (node === undefined || node === null || node === false) continue;
			const child = typeof node === "string" || typeof node === "number" ? textNode(String(node)) : node;
			if (child.parentNode) child.parentNode.removeChild(child);
			child.parentNode = this;
			this.children.push(child);
		}
	}
	prepend(...nodes) {
		const existing = [...this.children];
		this.children = [];
		this.append(...nodes, ...existing);
	}
	replaceChildren(...nodes) {
		this._text = "";
		for (const child of this.children) child.parentNode = null;
		this.children = [];
		this.append(...nodes);
	}
	removeChild(child) {
		const index = this.children.indexOf(child);
		if (index >= 0) this.children.splice(index, 1);
		child.parentNode = null;
		return child;
	}
	remove() {
		this.parentNode?.removeChild(this);
	}
	setAttribute(name, value) {
		this.attributes.set(name, String(value));
		if (name === "id") this.id = String(value);
		if (name === "src") this.src = String(value);
	}
	getAttribute(name) {
		if (name === "src") return this.src || null;
		return this.attributes.has(name) ? this.attributes.get(name) : null;
	}
	removeAttribute(name) {
		this.attributes.delete(name);
		if (name === "src") {
			this.src = "";
			this.naturalWidth = 0;
			this.naturalHeight = 0;
		}
	}
	addEventListener(type, listener) {
		if (!this._listeners.has(type)) this._listeners.set(type, new Set());
		this._listeners.get(type).add(listener);
	}
	removeEventListener(type, listener) {
		this._listeners.get(type)?.delete(listener);
	}
	dispatchEvent(event) {
		event.target = this;
		event.currentTarget = this;
		event.defaultPrevented = false;
		event.preventDefault ??= () => { event.defaultPrevented = true; };
		event.stopPropagation ??= () => {};
		for (const listener of [...(this._listeners.get(event.type) ?? [])]) listener(event);
		return !event.defaultPrevented;
	}
	contains(node) {
		if (node === this) return true;
		return this.children.some((child) => child instanceof ElementStub && child.contains(node));
	}
	closest(selector) {
		if (!selector.startsWith(".")) return null;
		const name = selector.slice(1);
		let node = this;
		while (node) {
			if (node instanceof ElementStub && node._classes.has(name)) return node;
			node = node.parentNode;
		}
		return null;
	}
	querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
	querySelectorAll(selector) {
		const found = [];
		const visit = (node) => {
			for (const child of node.children) {
				if (!(child instanceof ElementStub)) continue;
				if (selector.startsWith(".") ? child._classes.has(selector.slice(1)) : selector.startsWith("#") ? child.id === selector.slice(1) : child._tag === selector.toLowerCase()) found.push(child);
				visit(child);
			}
		};
		visit(this);
		return found;
	}
	getBoundingClientRect() {
		if (this._rect) return this._rect;
		return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
	}
	setPointerCapture() {}
	releasePointerCapture() {}
	hasPointerCapture() { return false; }
	decode() {
		return this.media.decode(this);
	}
}

function textNode(text) {
	return { nodeType: 3, textContent: text, parentNode: null, remove() { this.parentNode?.removeChild(this); } };
}

function createDom(clock, media) {
	const element = (tag) => new ElementStub(tag, media);
	const document = {
		documentElement: element("html"),
		body: element("body"),
		styleSheets: [],
		visibilityState: "visible",
		hidden: false,
		currentScript: { src: "file:///preview/ui/stage.iife.js" },
		createElement: (tag) => element(tag),
		createElementNS: (namespace, tag) => { const node = element(tag); node.namespaceURI = namespace; return node; },
		createTextNode: textNode,
		getElementById(id) {
			const visit = (node) => {
				for (const child of node.children) {
					if (!(child instanceof ElementStub)) continue;
					if (child.id === id) return child;
					const found = visit(child);
					if (found) return found;
				}
				return null;
			};
			return visit(document.body);
		},
		querySelector(selector) {
			if (selector === ".pet-stage") return document.body.children.find((child) => child._classes?.has("pet-stage")) ?? null;
			return null;
		},
		querySelectorAll() { return []; },
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent() { return true; },
	};
	document.documentElement.setAttribute("data-mantine-color-scheme", "dark");
	const context = {
		document,
		Element: ElementStub,
		HTMLElement: ElementStub,
		Image: class ImageStub extends ElementStub { constructor() { super("img", media); } },
		getComputedStyle: () => ({ overflow: "hidden", position: "relative", backgroundColor: "rgba(0, 0, 0, 0)", colorScheme: "dark" }),
		ResizeObserver: class { observe() {} disconnect() {} },
		IntersectionObserver: class { observe() {} disconnect() {} },
		documentListeners: new Map(),
	};
	context.document.addEventListener = (type, listener) => {
		if (!context.documentListeners.has(type)) context.documentListeners.set(type, new Set());
		context.documentListeners.get(type).add(listener);
	};
	context.document.removeEventListener = (type, listener) => context.documentListeners.get(type)?.delete(listener);
	return { document, element, context };
}

/* -------------------------------------------------------------------------- */
/* Stage harness                                                              */
/* -------------------------------------------------------------------------- */

async function loadStageSource() {
	const [stage, sdk, indexText, boundsText, sound, bubbles, tasks, presetText] = await Promise.all([
		fs.readFile(path.join(PLUGIN_DIR, "ui", "stage.js"), "utf8"),
		fs.readFile(path.join(PLUGIN_DIR, "ui", "sdk.js"), "utf8"),
		fs.readFile(path.join(PLUGIN_DIR, "anim", "index.json"), "utf8"),
		fs.readFile(path.join(PLUGIN_DIR, "anim", "bounds.json"), "utf8"),
		fs.readFile(path.join(PLUGIN_DIR, "assets", "sound", "click-duck.wav")),
		fs.readFile(path.join(PLUGIN_DIR, "ui", "bubbles.js"), "utf8"),
		fs.readFile(path.join(PLUGIN_DIR, "ui", "task-events.js"), "utf8"),
		fs.readFile(path.join(PLUGIN_DIR, "ui", "bubble-presets.json"), "utf8"),
	]);
	const index = JSON.parse(indexText);
	const bounds = JSON.parse(boundsText);
	const projected = {
		...index,
		bodyBounds: bounds.bodyBounds,
		clips: index.clips.map((clip) => {
			const measured = bounds.clips?.[clip.id];
			return { ...clip, bounds: measured?.bounds, sourceFacing: measured?.sourceFacing };
		}),
	};
	const marker = BOOT_MARKERS.map((pattern) => stage.search(pattern)).find((at) => at >= 0);
	if (marker === undefined) {
		throw new Error("ui/stage.js 末尾不再有 boot() 调用，更新 selftest 的裁剪标记");
	}
	// Cut at the newline before `boot(...)`, keeping every declaration above it.
	const body = stage.slice(0, marker);
	const exportsBlock = `
;globalThis.__stageTest = {
	Pet, ClipPlayer, stage, state, PetBubble, BubbleContent, BubbleKit, TaskEvents,
	ensureBubble, maybePlayBalance, refreshBalance, fetchState, showBubble, startTaskEvents, deliverLocalNotices, startVisibilityGating,
	INDEX: typeof INDEX !== "undefined" ? INDEX : undefined,
	CLIP_BY_ID: typeof CLIP_BY_ID !== "undefined" ? CLIP_BY_ID : undefined,
	randomIdleDelay: typeof randomIdleDelay === "function" ? randomIdleDelay : undefined,
	buildDom: typeof buildDom === "function" ? buildDom : undefined,
	openMenu, closeMenu,
	layout: typeof layout === "function" ? layout : undefined,
	applyConfig: typeof applyConfig === "function" ? applyConfig : undefined,
	frame: typeof frame === "function" ? frame : undefined,
	resolveCollisions: typeof resolveCollisions === "function" ? resolveCollisions : undefined,
	installPointerEvents: typeof installPointerEvents === "function" ? installPointerEvents : undefined,
	installOverlayRelay: typeof installOverlayRelay === "function" ? installOverlayRelay : undefined,
	withTimeout: typeof withTimeout === "function" ? withTimeout : undefined,
	petAtPoint: typeof petAtPoint === "function" ? petAtPoint : undefined,
	publishOverlayBounds: typeof publishOverlayBounds === "function" ? publishOverlayBounds : undefined,
	webpWithLoopCount: typeof webpWithLoopCount === "function" ? webpWithLoopCount : undefined,
	clipUrl: typeof clipUrl === "function" ? clipUrl : undefined,
	clipBytesCache: typeof clipBytesCache !== "undefined" ? clipBytesCache : undefined,
	clipInflight: typeof clipInflight !== "undefined" ? clipInflight : undefined,
	BODY_BOUNDS: typeof BODY_BOUNDS !== "undefined" ? BODY_BOUNDS : undefined,
	IDLE_CLIP: typeof IDLE_CLIP !== "undefined" ? IDLE_CLIP : undefined,
	clickSound: typeof clickSound !== "undefined" ? clickSound : undefined,
	diagnostics: typeof diagnostics !== "undefined" ? diagnostics : undefined,
	diagnosticById: typeof diagnosticById !== "undefined" ? diagnosticById : undefined,
};
`;
	return {
		script: [
			`const PET_ANIM_INDEX = ${JSON.stringify(projected)};`,
			`const PET_CLICK_SOUND_BASE64 = ${JSON.stringify(sound.toString("base64"))};`,
			`const __PET_BUBBLE_PRESETS__ = ${JSON.stringify(JSON.parse(presetText))};`,
			sdk,
			bubbles,
			tasks,
			body,
			exportsBlock,
		].join("\n"),
		source: stage,
		body,
		index: projected,
		measured: bounds,
		sound,
	};
}

async function createHarness(options = {}) {
	const loaded = await loadStageSource();
	const clock = createClock();
	const random = { value: options.random ?? 0.5 };
	const config = makeConfig(options.config);
	const media = {
		delayMs: options.decodeDelayMs ?? 0,
		/** Number of upcoming decode() calls that must reject (simulated corrupt WebP). */
		failDecodes: 0,
		decode(image) {
			if (!image.src) return Promise.reject(new Error("no src"));
			const src = image.src;
			const fail = media.failDecodes > 0;
			if (fail) media.failDecodes -= 1;
			return new Promise((resolve, reject) => {
				clock.setTimeout(() => {
					if (image.src !== src) return reject(new Error("aborted decode"));
					if (fail) return reject(new Error("simulated decode failure"));
					image.naturalWidth = CLIP_WIDTH;
					image.naturalHeight = CLIP_HEIGHT;
					resolve();
				}, media.delayMs);
			});
		},
	};

	const objectUrls = new Map();
	let urlSeq = 0;
	const urls = {
		create(bytes) {
			const id = `blob:preview/${++urlSeq}`;
			objectUrls.set(id, { bytes, revoked: false });
			return id;
		},
		revoke(id) {
			const entry = objectUrls.get(id);
			if (entry) entry.revoked = true;
		},
		get(id) { return objectUrls.get(id); },
		get size() { return objectUrls.size; },
		get seq() { return urlSeq; },
		latest() { return [...objectUrls.entries()].at(-1); },
		entries() { return [...objectUrls.entries()]; },
		live() { return [...objectUrls.entries()].filter(([, entry]) => !entry.revoked); },
	};

	const clipBuffers = new Map();
	const commandLog = [];
	let clipDelayMs = options.clipDelayMs ?? 0;
	let clipHangs = false;
	const chunkSize = options.chunkSize ?? 64 * 1024;
	const boundsCalls = [];
	const notifications = new Set();
	let balanceSnapshot = clone(options.balance ?? null);
	let balanceLedger = clone(options.ledger ?? null);
	let activeAccountIds = clone(options.activeAccountIds ?? (balanceSnapshot?.accounts ?? []).map((account) => account.accountId).filter((id) => typeof id === "string"));
	const taskSubscriptions = new Map();
	const taskCalls = { subscribe: [], poll: [], unsubscribe: [] };
	let taskSequence = 0;
	let currentNarratorId = options.narratorId;

	const bufferFor = (index) => {
		if (!clipBuffers.has(index)) clipBuffers.set(index, makeAnimatedWebp({ marker: index + 1 }));
		return clipBuffers.get(index);
	};

	const bridge = {
		async execute(commandId, input) {
			commandLog.push({ commandId, input: clone(input) });
			switch (commandId) {
				case "pet-clip": {
					// A promise that never resolves is the only way to prove the request
					// deadline: an instantly-resolved bridge would hide a missing timeout.
					if (clipHangs) return new Promise(() => {});
					if (clipDelayMs > 0) await new Promise((resolve) => clock.setTimeout(resolve, clipDelayMs));
					const index = Number(input?.index) || 0;
					const offset = Number(input?.offset) || 0;
					const bytes = bufferFor(index);
					const slice = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
					return {
						index,
						offset,
						total: bytes.length,
						data: Buffer.from(slice).toString("base64"),
						done: offset + slice.length >= bytes.length,
					};
				}
				case "pet-state": return { version: "selftest", config: clone(config), balance: clone(balanceSnapshot), ledger: clone(balanceLedger), activeAccountIds: clone(activeAccountIds), configWarnings: [] };
				case "pet-config-get": return { config: clone(config), warnings: [], stored: true };
				case "pet-config-set": {
					mergeDeep(config, input?.patch ?? {});
					return { config: clone(config), warnings: [] };
				}
				case "pet-log": return { ok: true };
				case "pet-balance-refresh": return { snapshot: clone(balanceSnapshot), ledger: clone(balanceLedger), activeAccountIds: clone(activeAccountIds), cached: false };
				case "pet-notice-claim": return { notice: null };
				case "pet-notice-ack": return { acknowledged: true };
				default: throw Object.assign(new Error(`unknown command ${commandId}`), { code: "INVALID_PARAMS" });
			}
		},
	};

	const dom = createDom(clock, media);
	const sandbox = {
		console,
		document: dom.document,
		navigator: { userAgent: "node-vm", platform: "win32", language: "zh-CN" },
		location: { href: "file:///preview/ui/stage.iife.html" },
		performance: { now: () => clock.now },
		Date: class extends Date { constructor(...args) { super(...(args.length ? args : [1700000000000 + clock.now])); } static now() { return 1700000000000 + clock.now; } },
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		setInterval: clock.setInterval,
		clearInterval: clock.clearInterval,
		requestAnimationFrame: clock.requestAnimationFrame,
		cancelAnimationFrame: clock.cancelAnimationFrame,
		queueMicrotask: (fn) => Promise.resolve().then(fn),
		URL: class URLStub extends URL {
			static createObjectURL(blob) {
				const bytes = blob && blob.bytes ? blob.bytes : new Uint8Array();
				return urls.create(bytes);
			}
			static revokeObjectURL(id) { urls.revoke(id); }
		},
		Blob: class BlobStub {
			constructor(parts, options = {}) {
				this.parts = parts;
				this.type = options.type;
				this.bytes = parts[0] instanceof Uint8Array ? parts[0] : new Uint8Array(parts[0] ?? []);
			}
		},
		atob: (text) => Buffer.from(String(text), "base64").toString("binary"),
		btoa: (binary) => Buffer.from(String(binary), "binary").toString("base64"),
		narrafork: {
			commands: { execute: async (commandId, input) => ({ output: clone(await bridge.execute(commandId, input)) }) },
			storage: {
				get: async () => null,
				set: async ({ key }) => ({ key, revision: 1, stored: true }),
				delete: async ({ key }) => ({ key, deleted: true }),
				list: async () => ({ entries: [] }),
			},
			config: { get: async () => ({}) },
			secrets: { get: async () => ({ value: null }), set: async () => ({ stored: true }), delete: async () => ({ deleted: true }), list: async () => ({ secrets: [] }) },
			panel: { open: async () => ({ accepted: true }) },
			notifications: { show: async () => ({ ok: true }) },
			ui: { openExternal: async () => ({ ok: true }) },
			events: {
				subscribe: async (input) => {
					taskCalls.subscribe.push(clone(input));
					const subscriptionId = `stage-test-${++taskSequence}`;
					taskSubscriptions.set(subscriptionId, { input: clone(input), queue: [] });
					return { subscriptionId, mode: "live", delivery: { queueEvents: 200, queueBytes: 131072, maxFrameBytes: 65536, maxRatePerSecond: 50 } };
				},
				unsubscribe: async (input) => { taskCalls.unsubscribe.push(clone(input)); taskSubscriptions.delete(input.subscriptionId); return { unsubscribed: true }; },
				poll: async (input) => {
					taskCalls.poll.push(clone(input));
					const sub = taskSubscriptions.get(input.subscriptionId);
					if (!sub) throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
					return sub.queue.splice(0, Math.min(100, input.limit ?? 100));
				},
			},
			i18n: { locale: "zh-CN", t: (tables, key) => key, onChange: () => () => {} },
			onNotification: (listener) => {
				notifications.add(listener);
				return () => notifications.delete(listener);
			},
			overlay: options.surface === "overlay"
				? {
					setBounds: async (rect) => {
						boundsCalls.push(clone(rect));
						return { bounds: clone(rect), viewport: { width: STAGE_WIDTH, height: STAGE_HEIGHT } };
					},
				}
				: undefined,
			getContext: async () => ({
				contextVersion: 1,
				host: { appVersion: "selftest", locale: "zh-CN", colorScheme: "dark", platform: "windows" },
				plugin: { id: "cn.mcd7.neglectdream.dsh-pet", version: "selftest", contributionId: "pet-stage", panelInstanceId: "selftest" },
				surface: { kind: options.surface === "overlay" ? "overlay" : "workspace", active: true, visible: true },
				...(currentNarratorId ? { narrator: { id: currentNarratorId } } : {}),
			}),
		},
		__random: random,
	};
	if (options.audio) {
		const resumeMode = options.audioResume ?? "immediate";
		const decodeDelayMs = Number(options.audioDecodeDelayMs ?? 0);
		sandbox.AudioContext = class AudioContextStub {
			constructor() {
				this.state = "suspended";
				this.destination = {};
				this.sources = [];
				this.closed = false;
				this.resumeCalls = 0;
			}
			createGain() { return { gain: { value: 1 }, connect() {} }; }
			createAnalyser() { return { fftSize: 0, connect() {} }; }
			decodeAudioData(data) {
				const bytes = new Uint8Array(data);
				return new Promise((resolve) => {
					clock.setTimeout(() => {
						this.decodedSignature = String.fromCharCode(...bytes.subarray(0, 4));
						this.decodedLength = bytes.byteLength;
						resolve({
							duration: 0.69,
							numberOfChannels: 1,
							getChannelData: () => new Float32Array([0, 0.5, -0.5, 0.25]),
						});
					}, decodeDelayMs);
				});
			}
			resume() {
				this.resumeCalls += 1;
				if (this.state === "running") return Promise.resolve();
				if (resumeMode === "hang") return new Promise(() => {});
				if (typeof resumeMode === "number") {
					return new Promise((resolve) => {
						clock.setTimeout(() => { this.state = "running"; resolve(); }, resumeMode);
					});
				}
				this.state = "running";
				return Promise.resolve();
			}
			async close() { this.closed = true; }
			createBufferSource() {
				const source = {
					buffer: null,
					onended: null,
					started: false,
					stopped: false,
					connect() {},
					disconnect() {},
					start() { this.started = true; },
					stop() { this.stopped = true; this.onended?.(); },
				};
				this.sources.push(source);
				return source;
			}
		};
		sandbox.webkitAudioContext = sandbox.AudioContext;
	}
	sandbox.window = sandbox;
	const windowListeners = new Map();
	sandbox.addEventListener = (type, listener) => {
		if (!windowListeners.has(type)) windowListeners.set(type, new Set());
		windowListeners.get(type).add(listener);
	};
	sandbox.removeEventListener = (type, listener) => {
		windowListeners.get(type)?.delete(listener);
	};
	sandbox.dispatchEvent = (event) => {
		event.target ??= sandbox;
		event.currentTarget = sandbox;
		event.preventDefault ??= () => { event.defaultPrevented = true; };
		event.stopPropagation ??= () => {};
		for (const listener of [...(windowListeners.get(event.type) ?? [])]) listener(event);
		return !event.defaultPrevented;
	};
	const context = vm.createContext(sandbox);
	vm.runInContext("Math.random = () => __random.value;", context, { filename: "random-shim.js" });
	vm.runInContext(loaded.script, context, { filename: "ui/stage.js" });
	const exports = sandbox.__stageTest;
	if (!exports) throw new Error("stage export block did not run");

	// boot() is stripped, so build the DOM the way it would have, then give the stage
	// its real size. Every getBoundingClientRect call for the root returns this rect.
	exports.buildDom();
	exports.stage.root.getBoundingClientRect = () => ({
		x: 0, y: 0, left: 0, top: 0, right: STAGE_WIDTH, bottom: STAGE_HEIGHT,
		width: STAGE_WIDTH, height: STAGE_HEIGHT,
	});
	// boot() would install these; doing it here exercises the real pointer wiring
	// (window-level move/up/cancel plus hitElement down) instead of calling methods.
	exports.installPointerEvents?.();

	const setVisible = (visible) => {
		dom.document.visibilityState = visible ? "visible" : "hidden";
		dom.document.hidden = !visible;
		for (const listener of [...(dom.context.documentListeners.get("visibilitychange") ?? [])]) {
			listener({ type: "visibilitychange" });
		}
	};

	const settle = async (ms = 0) => {
		const target = clock.now + Math.max(0, ms);
		// Microtasks first: a decode timer must be scheduled at the moment decode() is
		// called, not at the end of the advance — otherwise a 400 ms decode started at
		// t would fire at t+399+400 and look like a deadlock.
		await flushMicrotasks();
		for (let guard = 0; guard < 200; guard += 1) {
			if (clock.runNextDue(target)) {
				await flushMicrotasks();
				continue;
			}
			await flushMicrotasks();
			if (clock.runNextDue(target)) continue;
			break;
		}
		clock.setNow(target);
		await flushMicrotasks();
	};

	const tickFrame = async (ms = 16) => {
		await settle(ms);
		clock.runFrames(clock.now);
		await flushMicrotasks();
	};

	const applyConfig = async (patch) => {
		const next = mergeDeep(clone(config), patch);
		exports.applyConfig(next);
		await settle(0);
		return next;
	};

	const pendingDelay = (pet) => {
		if (pet?.idleTimer === undefined) return undefined;
		const timer = clock.timers.get(pet.idleTimer);
		return timer ? timer.at - clock.now : undefined;
	};

	const fakeStage = () => {
		const fake = {
			config: makeConfig({ count: 1, ...(options.config ?? {}) }),
			width: STAGE_WIDTH,
			height: STAGE_HEIGHT,
			root: exports.stage.root,
			layers: exports.stage.layers,
			pets: [],
		};
		return fake;
	};

	const newPet = (stageOverride = fakeStage()) => {
		const pet = new exports.Pet(stageOverride, stageOverride.pets.length);
		stageOverride.pets.push(pet);
		pet.resize(STAGE_WIDTH, STAGE_HEIGHT, stageOverride.config.scale ?? 1);
		return pet;
	};

	const randomSequence = (values) => {
		const queue = [...values];
		random.value = queue.length ? queue.shift() : 0.5;
		random.next = () => {
			if (queue.length) random.value = queue.shift();
			return random.value;
		};
		// A function-valued `value` is not supported by the shim, so install a direct
		// override for sequences that need more than a constant.
		vm.runInContext("Math.random = () => __random.next ? __random.next() : __random.value;", context);
		return queue;
	};

	const pointer = (pet, type, x, y, extra = {}) => {
		const event = {
			type,
			button: 0,
			buttons: type === "up" || type === "cancel" ? 0 : 1,
			pointerId: 1,
			clientX: x,
			clientY: y,
			isTrusted: false,
			preventDefault() {},
			stopPropagation() {},
			...extra,
		};
		if (type === "down") pet.onPointerDown(event);
		else if (type === "move") pet.onPointerMove(event);
		else if (type === "up") pet.onPointerUp(event);
		else if (type === "cancel") pet.onPointerCancel(event);
		return event;
	};

	const harness = {
		loaded,
		exports,
		config,
		clock,
		random,
		media,
		urls,
		clipBuffers,
		commandLog,
		boundsCalls,
		notifications,
		taskCalls,
		setBalance: (snapshot, ledger = balanceLedger) => {
			balanceSnapshot = clone(snapshot); balanceLedger = clone(ledger);
			activeAccountIds = clone((balanceSnapshot?.accounts ?? []).map((account) => account.accountId).filter((id) => typeof id === "string"));
		},
		pushTask: (envelope) => {
			for (const sub of taskSubscriptions.values()) {
				if (sub.input.scope.narratorId === envelope.data?.narratorId && sub.input.filter.narratorIds.includes(envelope.data.narratorId)) sub.queue.push(clone(envelope));
			}
		},
		settle,
		tickFrame,
		applyConfig,
		pendingDelay,
		fakeStage,
		newPet,
		randomSequence,
		pointer,
		dispatchWindow: (event) => sandbox.dispatchEvent(event),
		setVisible,
		setClipHang: (value) => { clipHangs = Boolean(value); },
		notify: (message) => {
			for (const listener of [...notifications]) listener(message);
		},
		relayPointer: (params) => {
			for (const listener of [...notifications]) listener({ method: "overlay.pointer", params });
		},
		get clipDelayMs() { return clipDelayMs; },
		set clipDelayMs(value) { clipDelayMs = Math.max(0, Number(value) || 0); },
	};
	return harness;
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

const filter = process.argv.find((item) => item.startsWith("--filter="))?.split("=")[1]?.toLowerCase();

await test("metadata: bodyBounds / per-clip bounds / sourceFacing / click sound", async () => {
	const harness = await createHarness();
	const { INDEX } = harness.exports;
	const { measured, sound } = harness.loaded;
	assert.ok(INDEX.bodyBounds, "PET_ANIM_INDEX.bodyBounds 缺失");
	for (const key of ["left", "top", "right", "bottom"]) {
		assert.equal(typeof INDEX.bodyBounds[key], "number", `bodyBounds.${key}`);
		assert.ok(INDEX.bodyBounds[key] >= 0 && INDEX.bodyBounds[key] <= 1, `bodyBounds.${key} 归一化`);
	}
	assert.ok(INDEX.bodyBounds.left < INDEX.bodyBounds.right, "bodyBounds left<right");
	assert.ok(INDEX.bodyBounds.top < INDEX.bodyBounds.bottom, "bodyBounds top<bottom");
	assert.ok(INDEX.bodyBounds.right - INDEX.bodyBounds.left < 0.6, "bodyBounds 宽度应明显小于整张画布");
	let missing = 0;
	let badFacing = 0;
	for (const clip of INDEX.clips) {
		if (!clip.bounds) { missing += 1; continue; }
		if (![-1, 0, 1].includes(clip.sourceFacing)) badFacing += 1;
		assert.ok(clip.bounds.left < clip.bounds.right && clip.bounds.top < clip.bounds.bottom, `${clip.id} bounds 顺序`);
	}
	assert.equal(missing, 0, `有 ${missing} 段动画缺少 bounds`);
	assert.equal(badFacing, 0, `有 ${badFacing} 段动画 sourceFacing 非法`);
	assert.equal(measured.clips ? Object.keys(measured.clips).length : 0, INDEX.clips.length, "bounds.json 覆盖全部 clip");
	assert.ok(sound.length > 44 && sound.toString("latin1", 0, 4) === "RIFF" && sound.toString("latin1", 8, 12) === "WAVE", "点击音效应为 RIFF/WAVE");
});

await test("interface: required stage exports exist", async () => {
	const harness = await createHarness();
	const required = ["Pet", "ClipPlayer", "stage", "state", "randomIdleDelay", "buildDom", "layout", "applyConfig", "frame", "resolveCollisions", "webpWithLoopCount"];
	const missing = required.filter((name) => !harness.exports[name]);
	assert.deepEqual(missing, [], `缺少导出：${missing.join(", ")}`);
	const descriptor = Object.getOwnPropertyDescriptor(harness.exports.stage, "config");
	assert.ok(descriptor && typeof descriptor.get === "function", "stage.config getter 尚未实现");
});

await test("wiring: boot installs pointer/overlay listeners and binds the hit element", async () => {
	const { source } = await loadStageSource();
	const pointerCalls = source.match(/installPointerEvents\s*\(\s*\)/g)?.length ?? 0;
	assert.ok(pointerCalls >= 2, "boot 必须调用 installPointerEvents()（当前只有定义，拖拽抬起/点击/甩出都会失效）");
	const bootStart = source.indexOf("async function boot");
	const bootEnd = source.indexOf("boot().catch");
	assert.ok(bootStart >= 0 && bootEnd > bootStart, "找不到 boot 边界");
	const bootBody = source.slice(bootStart, bootEnd);
	assert.match(bootBody, /installPointerEvents\s*\(\s*\)/, "boot 内必须安装全局指针事件");
	assert.match(bootBody, /installOverlayRelay\s*\(\s*\)/, "overlay 启动时必须安装指针中继");
	const bindStart = source.indexOf("function bindPet");
	const bindBody = source.slice(bindStart, bindStart + 1200);
	assert.match(bindBody, /pet\.hitElement\.addEventListener\("pointerdown"/, "pointerdown 必须绑定在紧凑命中层上，而不是透明画布");
});

await test("wait: randomIdleDelay honours [min,max], min=max and defaults", async () => {
	const harness = await createHarness();
	const delay = harness.exports.randomIdleDelay;
	assert.equal(typeof delay, "function", "randomIdleDelay 缺失");
	harness.random.value = 0;
	assert.equal(delay({ idleMinMs: 1000, idleMaxMs: 2000 }), 1000);
	harness.random.value = 0.5;
	assert.equal(delay({ idleMinMs: 1000, idleMaxMs: 2000 }), 1500);
	harness.random.value = 0.999999;
	const upper = delay({ idleMinMs: 1000, idleMaxMs: 2000 });
	assert.ok(upper <= 2000 && upper > 1999, `上限内取值，实际 ${upper}`);
	assert.equal(delay({ idleMinMs: 1500, idleMaxMs: 1500 }), 1500, "min=max 必须是固定值");
	harness.random.value = 0.5;
	assert.equal(delay({}), 6500, "缺省区间 4000..9000");
	assert.equal(delay({ idleMinMs: 2000, idleMaxMs: 1000 }), 2000, "max<min 退化为 min");
});

await test("config: stage.config is the single source every Pet reads", async () => {
	const harness = await createHarness({ config: { count: 2, idleMinMs: 1000, idleMaxMs: 1000 } });
	const { stage, state } = harness.exports;
	await harness.applyConfig({ count: 2, idleMinMs: 1000, idleMaxMs: 1000 });
	assert.equal(stage.config, state.config, "stage.config 必须就是 state.config");
	assert.equal(state.config.count, 2);
	for (const pet of stage.pets) assert.equal(pet.config, stage.config, "Pet.config 必须读取同一份配置");
	// A fresh state object must be picked up by the getter, not cached in a Pet.
	await harness.applyConfig({ count: 2, idleMinMs: 1200, idleMaxMs: 1200 });
	assert.equal(stage.config.idleMinMs, 1200);
	for (const pet of stage.pets) assert.equal(pet.config.idleMinMs, 1200);
});

await test("lifecycle: initialise 1→6→1→6 without blank pets or leaked timers", async () => {
	const harness = await createHarness({ config: { count: 1, idleMinMs: 1000, idleMaxMs: 1000 } });
	const { stage, state } = harness.exports;

	await harness.applyConfig({ count: 1, idleMinMs: 1000, idleMaxMs: 1000 });
	assert.equal(stage.pets.length, 1, "count=1");
	const first = stage.pets[0];
	assert.equal(first.initialized, true, "第一只宠物必须 initialize");
	await harness.settle(0);
	assert.ok(first.player.clipId, "第一只宠物必须有已显示的 clip");
	assert.ok(harness.pendingDelay(first) !== undefined || first.mode !== "idle", "第一只宠物必须排了待机等待");

	await harness.applyConfig({ count: 6, idleMinMs: 1000, idleMaxMs: 1000 });
	assert.equal(stage.pets.length, 6, "count=6");
	assert.equal(stage.pets[0], first, "已存在的宠物不能被重建");
	for (const [index, pet] of stage.pets.entries()) {
		assert.equal(pet.initialized, true, `第 ${index + 1} 只必须 initialize`);
		await harness.settle(0);
		assert.ok(pet.player.clipId, `第 ${index + 1} 只必须有已显示的 clip（不能空白）`);
		assert.ok(pet.element.parentNode, "宠物元素必须挂载");
		assert.ok(pet.hitElement.parentNode, "命中元素必须挂载");
	}

	const removed = stage.pets.slice(1);
	await harness.applyConfig({ count: 1, idleMinMs: 1000, idleMaxMs: 1000 });
	assert.equal(stage.pets.length, 1, "count 回落到 1");
	for (const pet of removed) {
		assert.equal(pet.disposed, true, "减少的宠物必须 dispose");
		assert.equal(pet.idleTimer, undefined, "dispose 后不能留下 idleTimer");
		assert.equal(pet.player.disposed, true, "dispose 后播放器必须关闭");
		assert.equal(pet.hitElement.parentNode, null, "dispose 后命中元素必须移除");
	}

	await harness.applyConfig({ count: 6, idleMinMs: 1000, idleMaxMs: 1000 });
	assert.equal(stage.pets.length, 6, "再次 count=6");
	for (const [index, pet] of stage.pets.entries()) {
		assert.equal(pet.disposed, false);
		assert.equal(pet.initialized, true, `重建后第 ${index + 1} 只必须 initialize`);
		await harness.settle(0);
		assert.ok(pet.player.clipId, `重建后第 ${index + 1} 只不能空白`);
	}
	assert.equal(state.config.count, 6);
});

await test("wait: ambient wait uses the configured range and retimes on hot update", async () => {
	const harness = await createHarness({ config: { count: 1, idleMinMs: 1000, idleMaxMs: 1000 } });
	const { stage } = harness.exports;
	harness.random.value = 0.5;
	await harness.applyConfig({ count: 1, idleMinMs: 1000, idleMaxMs: 1000 });
	const pet = stage.pets[0];
	await harness.settle(0);
	let delay = harness.pendingDelay(pet);
	assert.ok(delay !== undefined && Math.abs(delay - 1000) <= 2, `初始等待应为 1000ms，实际 ${delay}`);

	// Time spent waiting is not "free": after 400 ms the remaining wait is ~600 ms.
	await harness.settle(400);
	delay = harness.pendingDelay(pet);
	assert.ok(delay !== undefined && Math.abs(delay - 600) <= 4, `400ms 后剩余应为 600ms，实际 ${delay}`);

	// Hot update: only the waiting timer is re-armed. The visible idle clip and mode
	// must not restart, and the new range applies immediately.
	const clipBefore = pet.player.clipId;
	await harness.applyConfig({ count: 1, idleMinMs: 3000, idleMaxMs: 3000 });
	delay = harness.pendingDelay(pet);
	assert.ok(delay !== undefined && Math.abs(delay - 3000) <= 3, `热更新后等待应为 3000ms，实际 ${delay}`);
	assert.equal(pet.mode, "idle");
	assert.equal(pet.player.clipId, clipBefore, "热更新不能重置正在显示的待机片段");
	assert.equal(pet.disposed, false);
});

await test("playback: once/loop clocks start after decode, interruptions win", async () => {
	const harness = await createHarness({ decodeDelayMs: 400 });
	const pet = harness.newPet();
	const clickClip = harness.exports.INDEX.pools.click[0];
	const idleClip = harness.exports.INDEX.pools.idle[0];
	const duration = harness.exports.CLIP_BY_ID.get(clickClip).durationMs;

	const pending = pet.playOnce(clickClip);
	assert.equal(pet.loading, true, "解码期间 loading=true");
	assert.equal(pet.clipEndsAt, 0, "解码完成前不能启动动作计时");
	assert.equal(pet.pendingEndAction, undefined);

	await harness.settle(399);
	assert.equal(pet.clipEndsAt, 0, "399ms 时仍在解码");
	await harness.settle(2);
	assert.equal(await pending, true, "解码完成后 playOnce 返回 true");
	assert.equal(pet.loading, false);
	assert.equal(pet.player.clipId, clickClip);
	near(pet.clipEndsAt, harness.clock.now + duration, 3, "动作计时从解码完成时刻开始");

	// A second request during the first decode cancels the first, and only the last
	// request may write the player/timer state.
	const first = pet.playOnce(clickClip);
	await harness.settle(50);
	const second = pet.playLoop(idleClip);
	await harness.settle(410);
	assert.equal(await first, false, "被取代的 playOnce 必须返回 false");
	assert.equal(await second, true, "后发起的 playLoop 应成功");
	assert.equal(pet.player.clipId, idleClip);
	assert.equal(pet.clipEndsAt, 0, "循环播放不设动作结束时间");

	// clearBehavior during decode cancels cleanly and leaves no callback behind.
	const third = pet.playOnce(clickClip);
	await harness.settle(50);
	pet.clearBehavior();
	await harness.settle(500);
	assert.equal(await third, false, "被 clearBehavior 中断的 playOnce 必须返回 false");
	assert.equal(pet.pendingEndAction, undefined);
	assert.equal(pet.clipEndsAt, 0);
});

await test("loading: delayed chunked pet-clip responses never show a half-loaded clip", async () => {
	const harness = await createHarness({ chunkSize: 16, clipDelayMs: 40, decodeDelayMs: 30 });
	const player = new harness.exports.ClipPlayer(harness.exports.stage.layers.pets);
	const clip = harness.exports.INDEX.pools.idle[0];
	const showing = player.show(clip, { loop: true });
	let settled = false;
	showing.then(() => { settled = true; }, () => { settled = true; });
	await harness.settle(60);
	assert.equal(settled, false, "延迟的 chunk 未到齐前 show 不能完成");
	assert.equal(player.clipId, undefined, "未完成加载时不能把片段当成已显示");
	await harness.settle(400);
	assert.equal(await showing, true, "所有 chunk 到齐并解码后应成功");
	const chunks = harness.commandLog.filter((entry) => entry.commandId === "pet-clip").length;
	assert.ok(chunks >= 3, `应通过多个 chunk 传输，实际 ${chunks} 次`);
	assert.equal(player.clipId, clip, "完成后应显示目标片段");
});

await test("decode failure: keep the old frame, release the failed URL, record a fail", async () => {
	const harness = await createHarness();
	const player = new harness.exports.ClipPlayer(harness.exports.stage.layers.pets);
	const firstClip = harness.exports.INDEX.pools.idle[0];
	const secondClip = harness.exports.INDEX.pools.click?.[0] ?? harness.exports.INDEX.clips.find((item) => item.id !== firstClip)?.id;
	assert.ok(firstClip && secondClip && secondClip !== firstClip, "需要两段不同的片段");
	const good = player.show(firstClip, { loop: true });
	await harness.settle(0);
	assert.equal(await good, true);
	const frontBefore = player.clipId;
	const frontUrl = player.urls[player.front];

	harness.media.failDecodes = 1;
	const bad = player.show(secondClip, { loop: false });
	await harness.settle(0);
	assert.equal(await bad, false, "解码失败必须返回 false");
	assert.equal(player.clipId, frontBefore, "失败不能替换当前已显示的片段");
	assert.equal(player.urls[player.front], frontUrl, "失败不能清理仍在显示的 URL");
	assert.equal(player.urls.includes(undefined), true, "失败的一侧必须被清空");
	const [failedUrl, failedEntry] = harness.urls.latest();
	assert.ok(failedEntry.revoked, "失败解码的 URL 必须释放");
	assert.equal(player.urls[player.front], frontUrl, "旧 URL 仍在使用");
	assert.equal(player.urls.includes(failedUrl), false, "失败 URL 不能留在播放器槽里");
	const diagnostic = harness.exports.diagnosticById?.get("clip-decode");
	assert.equal(diagnostic?.status, "fail", "解码失败必须进入自检诊断");
});

await test("dispose: an in-flight show is cancelled and every URL is released", async () => {
	const harness = await createHarness({ clipDelayMs: 120 });
	harness.clipDelayMs = 120;
	const player = new harness.exports.ClipPlayer(harness.exports.stage.layers.pets);
	const clip = harness.exports.INDEX.pools.idle[0];
	const showing = player.show(clip, { loop: false });
	await harness.settle(40);
	player.dispose();
	player.dispose(); // idempotent: a second dispose must not throw or double-free
	await harness.settle(300);
	assert.equal(await showing, false, "dispose 后 in-flight show 必须返回 false");
	assert.equal(player.disposed, true);
	assert.equal(player.clipId, undefined);
	assert.deepEqual(harness.urls.live(), [], "dispose 后不能留下未释放的 URL");
});

await test("urls: repeated one-shots get independent URLs; RIFF loop patch keeps the cache clean", async () => {
	const harness = await createHarness();
	const player = new harness.exports.ClipPlayer(harness.exports.stage.layers.pets);
	const clip = harness.exports.INDEX.clips.find((item) => item.group === "click");
	const { clipBytesCache, webpWithLoopCount } = harness.exports;

	const before = harness.urls.seq;
	const once = player.show(clip.id, { loop: false });
	await harness.settle(0);
	assert.equal(await once, true);
	const firstUrl = player.urls[player.front];
	const again = player.show(clip.id, { loop: false });
	await harness.settle(0);
	assert.equal(await again, true);
	const secondUrl = player.urls[player.front];
	assert.notEqual(firstUrl, secondUrl, "同一 once 片段连续播放必须使用独立 URL");
	assert.equal(harness.urls.seq, before + 2);
	assert.equal(animLoopCount(harness.urls.get(firstUrl).bytes), 1, "once 播放必须把 ANIM loop count 改为 1");
	assert.equal(animLoopCount(harness.urls.get(secondUrl).bytes), 1);
	assert.equal(harness.urls.get(firstUrl).revoked, true, "被替换的 URL 必须释放");

	const cached = clipBytesCache.get(clip.index);
	assert.ok(cached, "原始字节应保留在 clipBytesCache");
	assert.equal(animLoopCount(cached), 0, "不能修改共享源字节的 loop count");

	// Looping the same clip reuses the current URL instead of burning one per call.
	const seqBeforeLoop = harness.urls.seq;
	const loopFirst = player.show(clip.id, { loop: true });
	await harness.settle(0);
	assert.equal(await loopFirst, true);
	const loopSecond = player.show(clip.id, { loop: true });
	await harness.settle(0);
	assert.equal(await loopSecond, true);
	assert.equal(harness.urls.seq, seqBeforeLoop + 1, "同一 loop 片段重复请求不应生成新 URL");
	const loopUrl = player.urls[player.front];
	assert.equal(animLoopCount(harness.urls.get(loopUrl).bytes), 0, "loop 播放必须保持无限循环（0）");

	// Strict container validation: truncated/garbage input must throw, not patch.
	assert.throws(() => webpWithLoopCount(new Uint8Array(8), 0), /truncated|invalid/i);
	const broken = cached.slice(0, cached.length - 3);
	assert.throws(() => webpWithLoopCount(broken, 1), /truncated|invalid/i);
	assert.throws(() => webpWithLoopCount(cached, 2), /invalid loop count/i);

	// Disposing the player must revoke both live URLs.
	player.dispose();
	for (const url of [firstUrl, secondUrl, loopUrl]) assert.equal(harness.urls.get(url).revoked, true, `${url} 未释放`);
});

await test("facing: sourceFacing + noMirror decide mirroring; travel faces its direction", async () => {
	const harness = await createHarness();
	const { INDEX, ClipPlayer } = harness.exports;
	const player = new ClipPlayer(harness.exports.stage.layers.pets);
	const clips = INDEX.clips;
	const left = clips.find((clip) => clip.sourceFacing === -1 && !clip.noMirror);
	const right = clips.find((clip) => clip.sourceFacing === 1 && !clip.noMirror);
	const front = clips.find((clip) => clip.sourceFacing === 0 && !clip.noMirror);
	const text = clips.find((clip) => clip.noMirror);
	assert.ok(left && right && front && text, "索引需要包含 sourceFacing -1/1/0 与 noMirror 的样本");

	player.setFacing(1);
	assert.equal(player.isMirrored(right), false, "右向素材面向右时不应镜像");
	assert.equal(player.isMirrored(left), true, "左向素材面向右时必须镜像");
	player.setFacing(-1);
	assert.equal(player.isMirrored(left), false, "左向素材面向左时不应镜像");
	assert.equal(player.isMirrored(right), true, "右向素材面向左时必须镜像");
	assert.equal(player.isMirrored(front), false, "正面素材（sourceFacing 0）任何方向都不镜像");
	assert.equal(player.isMirrored(text), false, "noMirror 素材任何方向都不镜像");

	const pet = harness.newPet();
	// The fake stage clamps a new pet to the left wall, where "left" is not reachable
	// and startTravel correctly turns it around. Start from the middle so the random
	// direction is what decides.
	pet.x = STAGE_WIDTH / 2;
	pet.y = STAGE_HEIGHT / 2;
	pet.clampPosition();
	const moveClip = INDEX.pools.move[0];
	// Math.random call order in startTravel: distance, direction (0 => left), pick.
	harness.random.value = 0;
	pet.startTravel(moveClip);
	await harness.settle(0);
	assert.equal(pet.facing, -1, `随机方向向左时宠物必须面向左（random=${harness.random.value}, travel=${JSON.stringify(pet.travel)}, busy=${pet.isUserBusy}, mode=${pet.mode}）`);
	assert.ok(pet.travel, "应有移动轨迹");
	assert.ok(pet.travel.toX < pet.travel.fromX, "向左漫游的 toX 必须小于 fromX");
	assert.equal(pet.player.isMirrored(harness.exports.CLIP_BY_ID.get(moveClip)), pet.facing !== (harness.exports.CLIP_BY_ID.get(moveClip).sourceFacing ?? 1));
});

await test("drag: grabbing a roaming pet cancels travel and a throw never snaps back", async () => {
	const harness = await createHarness({ config: { count: 1, idleMinMs: 60_000, idleMaxMs: 60_000 } });
	const { stage, INDEX } = harness.exports;
	await harness.applyConfig({ count: 1, idleMinMs: 60_000, idleMaxMs: 60_000 });
	const pet = stage.pets[0];
	await harness.settle(0);
	harness.randomSequence([0.9, 0.9, 0.9]);
	pet.startTravel(INDEX.pools.move[0]);
	await harness.settle(0);
	assert.ok(pet.travel, "测试前应有漫游轨迹");
	const travelToX = pet.travel.toX;
	await harness.settle(2600);
	const xBeforeGrab = pet.x;
	assert.ok(Math.abs(pet.x - travelToX) > 1, "漫游应正在移动");

	const downX = pet.x;
	const downY = pet.y;
	harness.pointer(pet, "down", downX, downY);
	assert.equal(pet.dragging, true);
	assert.equal(pet.travel, undefined, "pointerdown 必须取消漫游");

	const dragX = downX + 240;
	const dragY = downY - 60;
	harness.pointer(pet, "move", dragX, dragY);
	// Still inside the 80 ms "recent movement" window at release: this is a throw.
	await harness.settle(16);
	assert.ok(pet.dragTarget.x > downX, "拖拽应跟随指针");
	assert.ok(pet.x > xBeforeGrab || pet.dragTarget.x > xBeforeGrab, "不能回到抓取前的轨迹位置");

	harness.pointer(pet, "up", dragX, dragY);
	assert.equal(pet.dragging, false, "up 必须退出 drag");
	assert.equal(pet.airborne, true);
	assert.ok(pet.vx > 0, "向右甩出必须保留向右速度");
	const thrownX = pet.x;
	await harness.settle(80);
	assert.ok(pet.x >= thrownX - 5, `松手后不能向左回吸，实际 ${thrownX} -> ${pet.x}`);
	assert.equal(pet.travel, undefined, "抛出的宠物不能恢复旧的漫游轨迹");
});

await test("release: fast flick keeps velocity, holding still releases with zero", async () => {
	const harness = await createHarness();
	const pet = harness.newPet();
	harness.pointer(pet, "down", pet.x, pet.y);
	harness.pointer(pet, "move", pet.x + 120, pet.y);
	await harness.settle(16);
	harness.pointer(pet, "move", pet.x + 180, pet.y);
	harness.pointer(pet, "up", pet.x + 180, pet.y);
	assert.ok(pet.vx > 100, `快速甩动应保留向右速度，实际 ${pet.vx}`);
	assert.ok(Math.abs(pet.vy) < 1e-6 || pet.vy === 0, "水平甩动不应给垂直速度");

	const still = harness.newPet();
	harness.pointer(still, "down", still.x, still.y);
	harness.pointer(still, "move", still.x + 120, still.y);
	await harness.settle(300);
	harness.pointer(still, "up", still.x + 120, still.y);
	assert.equal(still.vx, 0, "停住后松手不能沿用旧速度");
	assert.equal(still.vy, 0, "停住后松手不能有垂直速度");
});

await test("drag: out-and-back is not a click; cancel neither clicks nor throws", async () => {
	const harness = await createHarness();
	const pet = harness.newPet();
	const squashBefore = pet.squash;
	harness.pointer(pet, "down", pet.x, pet.y);
	harness.pointer(pet, "move", pet.x + 160, pet.y);
	await harness.settle(16);
	harness.pointer(pet, "move", pet.x, pet.y);
	harness.pointer(pet, "up", pet.x, pet.y);
	assert.equal(pet.squash, squashBefore, "拖出又拖回不能触发点击挤压");
	assert.equal(pet.vx, 0, "回到起点后松手没有速度");

	const cancelled = harness.newPet();
	cancelled.squash = 0;
	harness.pointer(cancelled, "down", cancelled.x, cancelled.y);
	harness.pointer(cancelled, "move", cancelled.x + 120, cancelled.y + 20);
	harness.pointer(cancelled, "cancel", cancelled.x + 120, cancelled.y + 20);
	assert.equal(cancelled.dragging, false);
	assert.equal(cancelled.vx, 0);
	assert.equal(cancelled.vy, 0);
	assert.equal(cancelled.airborne, false);
	assert.equal(cancelled.squash, 0, "cancel 不能触发点击");

	// pointercancel is the window-level path; it must call onPointerCancel, not up.
	// Use a real layout-created pet: only those have bindPet/installPointerEvents.
	const domHarness = await createHarness({ config: { count: 1 } });
	await domHarness.applyConfig({ count: 1 });
	const viaDom = domHarness.exports.stage.pets[0];
	await domHarness.settle(0);
	viaDom.squash = 0;
	domHarness.pointer(viaDom, "down", viaDom.x, viaDom.y);
	domHarness.dispatchWindow({ type: "pointercancel", pointerId: 1, clientX: viaDom.x, clientY: viaDom.y, button: 0, isTrusted: false });
	assert.equal(viaDom.dragging, false, "window pointercancel 必须结束拖拽");
	assert.equal(viaDom.vx, 0);
	assert.equal(viaDom.squash, 0, "pointercancel 不能触发点击");
});

await test("click: repeated clicks squash and react but never launch upward", async () => {
	const harness = await createHarness();
	const pet = harness.newPet();
	await harness.settle(0);
	const y0 = pet.y;
	harness.pointer(pet, "down", pet.x, pet.y);
	harness.pointer(pet, "up", pet.x, pet.y);
	assert.ok(pet.squash < 0, "单击应产生挤压");
	assert.equal(pet.vy, 0, "单击不应设置向上速度");

	// Second click inside the old double-click window: previously a slingshot.
	await harness.settle(80);
	harness.pointer(pet, "down", pet.x, pet.y);
	harness.pointer(pet, "up", pet.x, pet.y);
	assert.equal(pet.vy, 0, "双击不能向上发射");
	assert.equal(pet.vx, 0, "双击不能横向瞬移");
	await harness.settle(32);
	assert.ok(pet.y >= y0 - 2, `点击不能把宠物抛起，y ${y0} -> ${pet.y}`);

	// Five rapid clicks stay reactions, not a loop of launches.
	for (let index = 0; index < 5; index += 1) {
		harness.pointer(pet, "down", pet.x, pet.y);
		harness.pointer(pet, "up", pet.x, pet.y);
	}
	assert.equal(pet.vy, 0);
	assert.equal(pet.vx, 0);
});

await test("groups: disabling click/drag keeps the interaction but falls back to idle", async () => {
	const harness = await createHarness({
		config: { count: 1, idleMinMs: 60_000, idleMaxMs: 60_000, animationGroups: { click: false, drag: false } },
	});
	const { stage, INDEX, IDLE_CLIP } = harness.exports;
	await harness.applyConfig({
		count: 1,
		idleMinMs: 60_000,
		idleMaxMs: 60_000,
		animationGroups: { click: false, drag: false },
	});
	const pet = stage.pets[0];
	await harness.settle(0);

	harness.pointer(pet, "down", pet.x, pet.y);
	harness.pointer(pet, "up", pet.x, pet.y);
	await harness.settle(0);
	assert.ok(pet.squash < 0, "关闭 click 分组后点击反馈仍应存在");
	assert.equal(pet.vy, 0, "点击仍不能上跳");
	assert.ok(INDEX.pools.idle.includes(pet.player.clipId) || pet.player.clipId === IDLE_CLIP,
		`click 关闭时应回到待机片段，实际 ${pet.player.clipId}`);

	harness.pointer(pet, "down", pet.x, pet.y);
	assert.equal(pet.mode, "drag", "拖拽本身不能因分组关闭而失效");
	await harness.settle(0);
	assert.equal(pet.player.clipId, IDLE_CLIP, "drag 关闭时应显示待机片段而不是拖拽片段");
	harness.pointer(pet, "cancel", pet.x, pet.y);
	assert.equal(pet.dragging, false);
});

await test("pointer: a second pointer cannot steal or cancel the active drag", async () => {
	const harness = await createHarness();
	const pet = harness.newPet();
	pet.squash = 0;
	harness.pointer(pet, "down", pet.x, pet.y, { pointerId: 1 });
	const owner = pet.dragPointerId;
	const pressed = { ...pet.pressedPoint };
	const target = { ...pet.dragTarget };

	harness.pointer(pet, "down", pet.x + 80, pet.y + 40, { pointerId: 2 });
	assert.equal(pet.dragPointerId, owner, "第二根手指不能夺走拖拽");
	assert.equal(pet.pressedPoint.x, pressed.x, "按下点 x 不能被第二根手指覆盖");
	assert.equal(pet.pressedPoint.y, pressed.y, "按下点 y 不能被第二根手指覆盖");

	harness.pointer(pet, "move", pet.x + 120, pet.y + 40, { pointerId: 2 });
	assert.equal(pet.dragTarget.x, target.x, "非活动指针的移动必须忽略（x）");
	assert.equal(pet.dragTarget.y, target.y, "非活动指针的移动必须忽略（y）");

	harness.pointer(pet, "up", pet.x + 120, pet.y + 40, { pointerId: 2 });
	assert.equal(pet.dragging, true, "非活动指针抬起不能结束拖拽");
	harness.pointer(pet, "cancel", pet.x + 120, pet.y + 40, { pointerId: 2 });
	assert.equal(pet.dragging, true, "非活动指针取消不能结束拖拽");

	harness.pointer(pet, "cancel", pet.x, pet.y, { pointerId: 1 });
	assert.equal(pet.dragging, false, "活动指针取消必须结束拖拽");
	assert.equal(pet.vx, 0);
	assert.equal(pet.vy, 0);
	assert.equal(pet.squash, 0, "取消不能触发点击");

	// blur is the "no pointerId" cancellation path and must cancel every pet.
	const blurHarness = await createHarness({ config: { count: 2 } });
	await blurHarness.applyConfig({ count: 2 });
	await blurHarness.settle(0);
	const [first, second] = blurHarness.exports.stage.pets;
	blurHarness.pointer(first, "down", first.x, first.y, { pointerId: 1 });
	blurHarness.pointer(second, "down", second.x, second.y, { pointerId: 2 });
	blurHarness.dispatchWindow({ type: "blur" });
	assert.equal(first.dragging, false, "blur 应结束第一只的拖拽");
	assert.equal(second.dragging, false, "blur 应结束第二只的拖拽");
});

await test("bounds: hit/body boxes are tighter than the sprite and mirror correctly", async () => {
	const harness = await createHarness();
	const pet = harness.newPet();
	pet.initialize();
	await harness.settle(0);
	const hit = pet.bounds("hit");
	const body = pet.bounds("body");
	assert.ok(hit.width > 0 && hit.height > 0, "hit bounds 必须有面积");
	assert.ok(hit.width < pet.w * 0.7, `hit 宽度应收紧到画布的 70% 以下，实际 ${hit.width}/${pet.w}`);
	assert.ok(body.width < pet.w * 0.6, `body 宽度应收紧到画布的 60% 以下，实际 ${body.width}/${pet.w}`);
	assert.ok(hit.left > pet.x - pet.w / 2, "hit 左边界应排除左侧透明区域");
	assert.ok(hit.right < pet.x + pet.w / 2, "hit 右边界应排除右侧透明区域");
	assert.ok(hit.top >= pet.y - pet.h / 2 - 0.5, "hit 上边界不能超出精灵框");

	const facingRight = pet.bounds("hit");
	pet.setFacing(-1);
	const facingLeft = pet.bounds("hit");
	near(facingLeft.width, facingRight.width, 1e-6, "镜像后宽度不变");
	near(facingLeft.left + facingRight.right, pet.x * 2, 1e-6, "镜像应围绕宠物中心翻转");

	// A scaled pet must scale its hit box with the sprite.
	pet.resize(STAGE_WIDTH, STAGE_HEIGHT, 2);
	const scaled = pet.bounds("hit");
	near(scaled.width, facingLeft.width * 2, 2, "缩放 2 倍时 hit 宽度约翻倍");
});

await test("hit: petAtPoint ignores the transparent canvas on both facings", async () => {
	const harness = await createHarness({ config: { count: 1, idleMinMs: 60_000, idleMaxMs: 60_000 } });
	const { stage, petAtPoint } = harness.exports;
	if (typeof petAtPoint !== "function") {
		// The overlay relay is the only consumer; if it was renamed, make that visible
		// rather than silently skipping the compact-hit assertion.
		assert.fail("petAtPoint 缺失：浮层命中收紧无法回归");
	}
	await harness.applyConfig({ count: 1, idleMinMs: 60_000, idleMaxMs: 60_000 });
	const pet = stage.pets[0];
	await harness.settle(0);
	const hit = pet.bounds("hit");
	assert.equal(petAtPoint(pet.x, pet.y), pet, "可见主体中心应命中");
	const leftTransparent = pet.x - pet.w / 2 + 1;
	assert.ok(leftTransparent < hit.left - 1, `左侧透明区应存在：${leftTransparent} vs ${hit.left}`);
	assert.equal(petAtPoint(leftTransparent, pet.y), undefined, "左侧透明区不能命中");
	const rightTransparent = pet.x + pet.w / 2 - 1;
	assert.ok(rightTransparent > hit.right + 1, `右侧透明区应存在：${rightTransparent} vs ${hit.right}`);
	assert.equal(petAtPoint(rightTransparent, pet.y), undefined, "右侧透明区不能命中");

	pet.setFacing(-1);
	const mirrored = pet.bounds("hit");
	assert.equal(petAtPoint(mirrored.left + 2, (mirrored.top + mirrored.bottom) / 2), pet, "镜像后可见区域仍应命中");
	assert.ok(mirrored.right < rightTransparent, "镜像后的透明侧应换到另一边");
});

await test("collision: bodies push apart only when the visible bodies overlap", async () => {
	const harness = await createHarness({ config: { count: 2, collisions: true } });
	const { stage, resolveCollisions } = harness.exports;
	await harness.applyConfig({ count: 2, collisions: true, idleMinMs: 60_000, idleMaxMs: 60_000 });
	await harness.settle(0);
	const [first, second] = stage.pets;
	const bodyFirst = first.bounds("body");
	const bodySecond = second.bounds("body");
	const bodyDistance = (bodyFirst.width + bodySecond.width) / 2;
	assert.ok(bodyDistance < (first.w + second.w) / 2, "body 宽度必须小于精灵宽度，否则本测试无意义");

	// Full sprite boxes overlap heavily, visible bodies do not: no push.
	const y = STAGE_HEIGHT - 120;
	first.x = 400; first.y = y;
	second.x = 400 + bodyDistance + 6; second.y = y;
	first.vx = second.vx = 0;
	const before = [first.x, second.x];
	resolveCollisions();
	assert.deepEqual([first.x, second.x], before, "身体未接触时不应被整张画布的重叠推开");

	// Visible bodies overlap: push apart along x.
	second.x = 400 + bodyDistance - 8;
	const [left, right] = [first.x, second.x];
	resolveCollisions();
	assert.ok(first.x < left && second.x > right, "身体重叠时必须相互推开");
	near((second.x - first.x) - (right - left), 8, 2, "修正量应等于重叠量");
});

await test("bounds: floor and walls clamp the visible body, not the transparent canvas", async () => {
	const harness = await createHarness();
	const pet = harness.newPet();
	await harness.settle(0);
	pet.x = -200;
	pet.y = STAGE_HEIGHT + 200;
	pet.update(1 / 60);
	const body = pet.bounds("body");
	assert.ok(body.left >= -0.5, `身体不能被推到左墙外：${body.left}`);
	assert.ok(body.bottom <= STAGE_HEIGHT + 0.5, `身体不能落到地板下：${body.bottom}`);
	assert.ok(pet.bounds("hit").right <= STAGE_WIDTH + 0.5, "hit 也必须在舞台内");

	pet.x = STAGE_WIDTH + 200;
	pet.update(1 / 60);
	assert.ok(pet.bounds("body").right <= STAGE_WIDTH + 0.5, "右墙应夹住可见身体");
});

await test("audio: trusted panel clicks unlock, decode the real WAV and play one voice", async () => {
	const harness = await createHarness({ audio: true, config: { count: 1, sound: { enabled: true, volume: 0.6 } } });
	await harness.applyConfig({ count: 1, sound: { enabled: true, volume: 0.6 } });
	await harness.settle(0);
	const { clickSound, state } = harness.exports;
	const context = clickSound.context;
	assert.ok(context, "面板模式且 sound.enabled=true 时应创建 AudioContext");
	assert.equal(context.decodedSignature, "RIFF", "decodeAudioData 必须收到随包的原版 WAV");
	assert.ok(context.decodedLength > 1000, `WAV 长度异常：${context.decodedLength}`);
	assert.ok(clickSound.buffer, "解码完成后应缓存 AudioBuffer");
	assert.ok(clickSound.decodedPeak > 0, "解码后的样本必须有非零峰值");

	clickSound.unlock({ isTrusted: true });
	await harness.settle(0);
	assert.equal(context.state, "running", "真实手势应解锁 AudioContext");
	assert.equal(clickSound.play({ isTrusted: true }), true, "解锁后应播放");
	assert.equal(clickSound.voices.size, 1);
	assert.equal(clickSound.play({ isTrusted: true }), false, "60ms 内的连点应被限流");
	await harness.settle(70);
	assert.equal(clickSound.play({ isTrusted: true }), true, "限流窗口过后可再播一个声部");
	assert.equal(clickSound.voices.size, 2);
	assert.equal(clickSound.play({ isTrusted: true }), false, "最多两个并发声部");
	for (const voice of [...clickSound.voices]) voice.onended();
	assert.equal(clickSound.voices.size, 0, "声部结束后必须从集合移除");

	await harness.applyConfig({ count: 1, sound: { enabled: false, volume: 0.6 } });
	assert.equal(state.config.sound.enabled, false);
	assert.equal(clickSound.play({ isTrusted: true }), false, "关闭音效后不能播放");
	assert.equal(clickSound.gain.gain.value, 0, "关闭音效后增益必须归零");
	await harness.applyConfig({ count: 1, sound: { enabled: true, volume: 0 } });
	assert.equal(clickSound.play({ isTrusted: true }), false, "音量为 0 时不能播放");
});

await test("audio: untrusted relay input never unlocks or plays; overlay explains the limit", async () => {
	const harness = await createHarness();
	const { clickSound, state, diagnosticById } = harness.exports;
	assert.ok(clickSound, "clickSound 缺失");
	state.config = makeConfig();
	assert.equal(clickSound.play({ isTrusted: false }), false, "不可信事件不能播放");
	assert.equal(clickSound.context, undefined, "不可信事件不能创建 AudioContext");

	state.surface = "overlay";
	clickSound.unlock({ isTrusted: true });
	assert.equal(clickSound.context, undefined, "浮层中即使收到信任事件也不能解锁（中继不是用户手势）");
	assert.ok(diagnosticById?.has("sound-overlay"), "浮层音效限制应有一条去重诊断");
});

await test("wait: the no-op branch also waits inside [min,max]", async () => {
	const harness = await createHarness({ config: { count: 1, idleMinMs: 1000, idleMaxMs: 2000 } });
	const { stage } = harness.exports;
	await harness.applyConfig({ count: 1, idleMinMs: 1000, idleMaxMs: 2000 });
	const pet = stage.pets[0];
	await harness.settle(0);
	// chain.idle is 10%: 0.05 always lands in "do nothing".
	harness.random.value = 0.05;
	pet.ambientTick();
	const delay = harness.pendingDelay(pet);
	assert.ok(delay !== undefined, "no-op 分支也必须重新排等待");
	near(delay, 1000 + 0.05 * 1000, 3, "no-op 分支不能用 idleMinMs 固定值");
	assert.equal(pet.clipEndsAt, 0, "no-op 不应开始一次动作");
});

await test("roam/groups: roam=false and a disabled move group stop travel", async () => {
	const harness = await createHarness({ config: { count: 1, roam: false, idleMinMs: 1000, idleMaxMs: 1000 } });
	const { stage } = harness.exports;
	await harness.applyConfig({ count: 1, roam: false, idleMinMs: 1000, idleMaxMs: 1000 });
	const pet = stage.pets[0];
	await harness.settle(0);
	// 17 lands in the move slot (idle 10 + turn 5, move occupies 15..20).
	harness.random.value = 0.17;
	pet.ambientTick();
	assert.equal(pet.travel, undefined, "roam=false 时不能漫游");
	assert.ok(harness.pendingDelay(pet) !== undefined, "漫游被禁用后应继续等待");

	await harness.applyConfig({ count: 1, roam: true, idleMinMs: 1000, idleMaxMs: 1000, animationGroups: { move: false } });
	harness.random.value = 0.17;
	pet.ambientTick();
	assert.equal(pet.travel, undefined, "move 分组关闭时不能漫游");

	await harness.applyConfig({ count: 1, roam: true, idleMinMs: 1000, idleMaxMs: 1000, animationGroups: { move: true } });
	harness.random.value = 0.17;
	pet.ambientTick();
	await harness.settle(0);
	assert.ok(pet.travel, "roam=true 且 move 开启时应开始漫游");
});

await test("bubble: clicks bubble the right pet, follow it, clamp and expire", async () => {
	const harness = await createHarness({ config: { count: 2, idleMinMs: 60_000, idleMaxMs: 60_000 } });
	const { stage } = harness.exports;
	await harness.applyConfig({ count: 2, idleMinMs: 60_000, idleMaxMs: 60_000 });
	await harness.settle(0);
	const [first, second] = stage.pets;

	// Click the second pet only: the bubble must belong to it, not stage.pets[0].
	harness.pointer(second, "down", second.x, second.y);
	harness.pointer(second, "up", second.x, second.y);
	await harness.settle(20); await flushMicrotasks(); await harness.settle(140);
	assert.ok(second.bubble, "点击的宠物应创建自己的气泡");
	assert.equal(second.bubble.hidden, false);
	assert.ok(first.bubble === undefined || first.bubble.hidden, "未点击的宠物不应显示气泡");
	assert.equal(second.bubble.parentNode, stage.root, "气泡应挂到舞台根节点");

	assert.ok(second.bubble.classList.contains("pet-thought"), "气泡使用独立SVG组件");
	assert.equal(second.bubbleController.svg.namespaceURI, "http://www.w3.org/2000/svg");
	// Layout is owned by PetBubble; inspect its measured rectangle rather than the
	// obsolete legacy .style.left/top and Pet.bubbleTimer fields.
	second.x = 20;
	second.y = 20;
	second.render();
	const initial = second.bubbleController.rect;
	assert.ok(initial.left >= 4 && initial.right <= STAGE_WIDTH - 4, "气泡横向应夹在舞台内");
	assert.ok(initial.top >= 4 && initial.bottom <= STAGE_HEIGHT - 4, "气泡纵向应夹在舞台内");
	second.x = STAGE_WIDTH - 120;
	second.render();
	assert.notEqual(second.bubbleController.rect.left, initial.left, "气泡应跟随宠物移动");

	// Expiry is a per-controller timer and must not leave a stale deadline.
	await harness.settle(5100);
	assert.equal(second.bubble.hidden, true, "气泡到期应隐藏");
	assert.equal(second.bubbleController.timer, null, "到期后应清理计时器");
	assert.equal(second.bubbleController.deadline, 0);
});

await test("bounds: body box is a stable physics frame, hit follows squash", async () => {
	const harness = await createHarness({ config: { count: 1, idleMinMs: 60_000, idleMaxMs: 60_000 } });
	await harness.applyConfig({ count: 1, idleMinMs: 60_000, idleMaxMs: 60_000 });
	const pet = harness.exports.stage.pets[0];
	await harness.settle(0);
	const body0 = pet.bounds("body");
	const hit0 = pet.bounds("hit");

	pet.squash = -0.35;
	pet.squashVelocity = 0;
	const body1 = pet.bounds("body");
	const hit1 = pet.bounds("hit");
	for (const key of ["left", "right", "top", "bottom", "width", "height"]) {
		near(body1[key], body0[key], 0.01, `squash 不应改变 body.${key}`);
	}
	assert.notEqual(hit1.width, hit0.width, "hit 必须跟随 squash 的横向缩放");
	assert.notEqual(hit1.height, hit0.height, "hit 必须跟随 squash 的纵向缩放");
	near((hit1.left + hit1.right) / 2, (hit0.left + hit0.right) / 2, 0.5, "hit 中心不应漂移");
});

await test("bounds: repeated clicks at a wall never leave a permanent x shift", async () => {
	const harness = await createHarness({ config: { count: 1, idleMinMs: 60_000, idleMaxMs: 60_000 } });
	await harness.applyConfig({ count: 1, idleMinMs: 60_000, idleMaxMs: 60_000 });
	const pet = harness.exports.stage.pets[0];
	await harness.settle(0);
	pet.x = STAGE_WIDTH + 200;
	pet.vx = 0;
	pet.vy = 0;
	pet.clampPosition();
	const x0 = pet.x;
	near(pet.bounds("body").right, STAGE_WIDTH, 1, "测试前身体应贴住右墙");

	for (let index = 0; index < 8; index += 1) {
		pet.handleClick({ isTrusted: false, preventDefault() {}, stopPropagation() {} });
		pet.update(1 / 60);
		pet.clampPosition();
		await harness.settle(16);
	}
	pet.squash = 0;
	pet.squashVelocity = 0;
	pet.clampPosition();
	near(pet.x, x0, 0.5, "连续点击贴墙后 x 不能永久漂移");
	assert.ok(pet.bounds("body").right <= STAGE_WIDTH + 0.5, "身体仍在墙内");
});

await test("collision: squash expansion must not push touching bodies apart", async () => {
	const harness = await createHarness({ config: { count: 2, collisions: true } });
	const { stage, resolveCollisions } = harness.exports;
	await harness.applyConfig({ count: 2, collisions: true, idleMinMs: 60_000, idleMaxMs: 60_000 });
	await harness.settle(0);
	const [first, second] = stage.pets;
	const b0 = first.bounds("body");
	const b1 = second.bounds("body");
	first.x = 400;
	first.y = STAGE_HEIGHT - 120;
	second.x = 400 + (b0.width + b1.width) / 2 + 2;
	second.y = STAGE_HEIGHT - 120;
	first.vx = second.vx = 0;
	const before = [first.x, second.x];

	// Negative squash widens the sprite scaling. A stable body frame must ignore it;
	// only a frame derived from the rendered scale would now overlap and push.
	first.squash = -0.35;
	second.squash = -0.35;
	resolveCollisions();
	near(first.x, before[0], 0.01, "squash 不应推开第一只");
	near(second.x, before[1], 0.01, "squash 不应推开第二只");
	first.squash = 0;
	second.squash = 0;
});

await test("throw: 6–12 px gestures move with zero velocity and no click", async () => {
	const harness = await createHarness();
	for (const distance of [6.5, 8, 11.5]) {
		const pet = harness.newPet();
		pet.y = pet.limits().bottom;
		pet.vx = 0;
		pet.vy = 0;
		pet.airborne = false;
		const x0 = pet.x;
		pet.squash = 0;
		harness.pointer(pet, "down", pet.x, pet.y);
		harness.pointer(pet, "move", pet.x + distance, pet.y);
		harness.pointer(pet, "up", pet.x + distance, pet.y);
		assert.equal(pet.squash, 0, `${distance}px 不应算点击`);
		assert.equal(pet.vx, 0, `${distance}px 不应有 x 甩速`);
		assert.equal(pet.vy, 0, `${distance}px 不应有 y 甩速`);
		assert.equal(pet.airborne, false, `${distance}px 在地面上不应进入悬空态`);
		near(pet.x, x0 + distance, 1.5, `${distance}px 仍应跟随移动`);
	}

	// The same tiny gesture made in mid-air may keep airborne=true: that flag also
	// means "do not let the balance poll steal this pet's action", not "was thrown".
	const air = harness.newPet();
	air.y = air.limits().top + 20;
	air.vx = 0;
	air.vy = 0;
	air.airborne = false;
	assert.ok(air.y < air.limits().bottom - 1, "测试前应在悬空位置");
	harness.pointer(air, "down", air.x, air.y);
	harness.pointer(air, "move", air.x + 8, air.y);
	harness.pointer(air, "up", air.x + 8, air.y);
	assert.equal(air.vx, 0);
	assert.equal(air.vy, 0);
	assert.equal(air.airborne, true, "空中轻放可以保留 airborne 标记");

	const thrown = harness.newPet();
	thrown.y = thrown.limits().bottom;
	thrown.vx = 0;
	thrown.vy = 0;
	const x1 = thrown.x;
	harness.pointer(thrown, "down", thrown.x, thrown.y);
	harness.pointer(thrown, "move", thrown.x + 13, thrown.y);
	harness.pointer(thrown, "up", thrown.x + 13, thrown.y);
	assert.ok(thrown.vx > 0, "13px 手势应产生甩速");
	assert.equal(thrown.airborne, true, "13px 手势应进入抛出状态");
	near(thrown.x, x1 + 13, 1.5);

	const tapped = harness.newPet();
	tapped.y = tapped.limits().bottom;
	tapped.squash = 0;
	harness.pointer(tapped, "down", tapped.x, tapped.y);
	harness.pointer(tapped, "move", tapped.x + 3, tapped.y);
	harness.pointer(tapped, "up", tapped.x + 3, tapped.y);
	assert.ok(tapped.squash < 0, "3px 抖动仍应算点击");
	assert.equal(tapped.vx, 0);
	assert.equal(tapped.vy, 0);
	assert.equal(tapped.airborne, false);
});

await test("throw: sampling seconds are clamped to 25 ms", async () => {
	const harness = await createHarness();
	const pet = harness.newPet();
	harness.pointer(pet, "down", pet.x, pet.y);
	await harness.settle(1);
	harness.pointer(pet, "move", pet.x + 40, pet.y);
	await harness.settle(1);
	harness.pointer(pet, "up", pet.x + 40, pet.y);
	near(pet.vx, (40 / 0.025) * 1.15, 180, "2ms 内的 40px 位移应被 25ms 窗口限速");
	assert.ok(pet.vx < 3000, `不能按 8ms 窗口算出 4000+ 的甩速，实际 ${pet.vx}`);
	assert.equal(pet.vy, 0);
});

await test("clip deadline: hanging requests time out, clear inflight, and recover", async () => {
	const harness = await createHarness();
	const player = new harness.exports.ClipPlayer(harness.exports.stage.layers.pets);
	const clip = harness.exports.INDEX.pools.idle[0];
	const index = harness.exports.CLIP_BY_ID.get(clip).index;
	harness.setClipHang(true);
	const showing = player.show(clip, { loop: false });
	let settled = false;
	showing.then(() => { settled = true; }, () => { settled = true; });

	await harness.settle(14_900);
	assert.equal(settled, false, "15 秒 deadline 前不能返回");
	assert.ok(harness.exports.clipInflight.size >= 1, "悬挂请求应记录在 clipInflight");
	await harness.settle(300);
	assert.equal(await showing, false, "悬挂请求必须在 15 秒 deadline 内失败");
	assert.equal(harness.exports.clipInflight.size, 0, "超时后必须清空 clipInflight");
	assert.equal(harness.exports.clipBytesCache.has(index), false, "超时不能污染 clipBytesCache");
	assert.notEqual(player.clipId, clip, "失败不能显示片段");

	harness.setClipHang(false);
	const recovering = player.show(clip, { loop: true });
	await harness.settle(0);
	assert.equal(await recovering, true, "超时后同一片段应能恢复播放");
	assert.equal(player.clipId, clip);
});

await test("withTimeout: resolves fast values and rejects a hanging promise", async () => {
	const harness = await createHarness();
	const { withTimeout } = harness.exports;
	if (typeof withTimeout !== "function") assert.fail("withTimeout 缺失");
	const fast = withTimeout(Promise.resolve(7), 100, "fast");
	await harness.settle(0);
	assert.equal(await fast, 7);

	const hanging = withTimeout(new Promise(() => {}), 50, "clip bytes");
	let rejected = false;
	hanging.catch(() => { rejected = true; });
	await harness.settle(49);
	assert.equal(rejected, false, "deadline 前不能拒绝");
	await harness.settle(2);
	assert.equal(rejected, true, "deadline 后必须拒绝");
	await assert.rejects(hanging, /clip bytes|timeout|超时/i);
});

await test("overlay relay: pointer ids are isolated; stale/missing ids and buttons=0", async () => {
	const harness = await createHarness({ surface: "overlay", config: { count: 2, idleMinMs: 60_000, idleMaxMs: 60_000 } });
	const { state, stage, installOverlayRelay } = harness.exports;
	if (typeof installOverlayRelay !== "function") assert.fail("installOverlayRelay 缺失");
	state.surface = "overlay";
	state.overlayApi = { setBounds: async (rect) => ({ bounds: rect, viewport: { width: STAGE_WIDTH, height: STAGE_HEIGHT } }) };
	await harness.applyConfig({ count: 2, idleMinMs: 60_000, idleMaxMs: 60_000 });
	await harness.settle(0);
	installOverlayRelay();
	await harness.settle(0);
	const [first, second] = stage.pets;
	const center = (pet) => {
		const hit = pet.bounds("hit");
		return { x: Math.round((hit.left + hit.right) / 2), y: Math.round((hit.top + hit.bottom) / 2) };
	};
	const a = center(first);
	const b = center(second);

	// Mismatched pointer ids must not move or end the active gesture.
	harness.relayPointer({ type: "down", x: a.x, y: a.y, pointerId: 7, buttons: 1 });
	assert.equal(first.dragging, true, "down 应命中第一只");
	assert.equal(state.overlayPet, first);
	const target0 = { ...first.dragTarget };
	harness.relayPointer({ type: "move", x: a.x + 100, y: a.y, pointerId: 8, buttons: 1 });
	assert.equal(first.dragTarget.x, target0.x, "另一个 pointer 的 move 不能移动当前宠物");
	harness.relayPointer({ type: "up", x: a.x + 100, y: a.y, pointerId: 8, buttons: 0 });
	assert.equal(first.dragging, true, "另一个 pointer 的 up 不能结束当前拖拽");
	assert.equal(state.overlayPet, first);

	// A missing pointerId up must reuse the gesture's current id (7), not default 1.
	harness.relayPointer({ type: "move", x: a.x + 60, y: a.y, pointerId: 7, buttons: 1 });
	harness.relayPointer({ type: "up", x: a.x + 60, y: a.y, buttons: 0 });
	assert.equal(first.dragging, false, "缺 pointerId 的 up 应结束当前手势");
	assert.equal(state.overlayPet, undefined, "结束后必须清空 overlayPet");

	// move with buttons=0 is an implicit cancel: no click, no throw velocity.
	// Recompute the centre: the previous up moved the pet by the gesture distance.
	const a2 = center(first);
	first.squash = 0;
	harness.relayPointer({ type: "down", x: a2.x, y: a2.y, pointerId: 9, buttons: 1 });
	harness.relayPointer({ type: "move", x: a2.x + 50, y: a2.y, pointerId: 9, buttons: 1 });
	harness.relayPointer({ type: "move", x: a2.x + 60, y: a2.y, pointerId: 9, buttons: 0 });
	assert.equal(first.dragging, false, "buttons=0 的 move 应取消手势");
	assert.equal(first.vx, 0);
	assert.equal(first.vy, 0);
	assert.equal(first.airborne, false);
	assert.equal(first.squash, 0, "取消不能触发点击");
	assert.equal(state.overlayPet, undefined);

	// A new down with the same id after a lost up first cancels the stale gesture and
	// then hit-tests afresh (it must not be swallowed by "already dragging").
	const a3 = center(first);
	const b2 = center(second);
	first.squash = 0;
	harness.relayPointer({ type: "down", x: a3.x, y: a3.y, pointerId: 3, buttons: 1 });
	assert.equal(first.dragging, true);
	harness.relayPointer({ type: "down", x: b2.x, y: b2.y, pointerId: 3, buttons: 1 });
	assert.equal(first.dragging, false, "同 id 新 down 应先取消遗漏 up 的旧手势");
	assert.equal(first.squash, 0, "取消旧手势不能触发点击");
	assert.equal(second.dragging, true, "新 down 应重新命中第二只");
	assert.equal(state.overlayPet, second);
	assert.equal(second.dragPointerId, 3);

	// A plain relayed click still works.
	harness.relayPointer({ type: "up", x: b2.x, y: b2.y, pointerId: 3, buttons: 0 });
	const b3 = center(second);
	second.squash = 0;
	harness.relayPointer({ type: "down", x: b3.x, y: b3.y, pointerId: 4, buttons: 1 });
	harness.relayPointer({ type: "up", x: b3.x, y: b3.y, pointerId: 4, buttons: 0 });
	assert.ok(second.squash < 0, "中继的 down/up 点击仍应生效");
});

await test("audio slot: resume within 180 ms dispatches once; later resume does not", async () => {
	const harness = await createHarness({ audio: true, audioResume: 100, config: { count: 1, sound: { enabled: true, volume: 0.6 } } });
	await harness.applyConfig({ count: 1, sound: { enabled: true, volume: 0.6 } });
	await harness.settle(10);
	const { clickSound } = harness.exports;
	assert.ok(clickSound.buffer, "解码应已就绪");
	clickSound.unlock({ isTrusted: true });
	clickSound.play({ isTrusted: true });
	assert.equal(clickSound.voices.size, 0, "resume 完成前不能发声");
	await harness.settle(99);
	assert.equal(clickSound.voices.size, 0, "180ms 窗口内尚未到 resume 时间");
	// The slot may dispatch when resume resolves or at the 180 ms retry; both are
	// correct, so only require that it happened by the deadline.
	await harness.settle(90);
	assert.equal(clickSound.voices.size, 1, "resume 在 180ms 窗口内成功应补发一次");
});

await test("audio slot: resume after 180 ms never replays the expired click", async () => {
	const harness = await createHarness({ audio: true, audioResume: 300, config: { count: 1, sound: { enabled: true, volume: 0.6 } } });
	await harness.applyConfig({ count: 1, sound: { enabled: true, volume: 0.6 } });
	await harness.settle(10);
	const { clickSound } = harness.exports;
	clickSound.unlock({ isTrusted: true });
	clickSound.play({ isTrusted: true });
	await harness.settle(179);
	assert.equal(clickSound.voices.size, 0);
	await harness.settle(2);
	await harness.settle(200);
	assert.equal(clickSound.voices.size, 0, "180ms 后释放的点击不能在 resume 成功后补播");
	assert.equal(clickSound.pendingClick, undefined, "180ms 后单槽必须释放");
});

await test("audio slot: rapid clicks share one slot; only the latest token plays", async () => {
	const harness = await createHarness({ audio: true, audioResume: 100, config: { count: 1, sound: { enabled: true, volume: 0.6 } } });
	await harness.applyConfig({ count: 1, sound: { enabled: true, volume: 0.6 } });
	await harness.settle(10);
	const { clickSound } = harness.exports;
	clickSound.unlock({ isTrusted: true });
	clickSound.play({ isTrusted: true });
	await harness.settle(20);
	clickSound.play({ isTrusted: true });
	await harness.settle(20);
	clickSound.play({ isTrusted: true });
	await harness.settle(200);
	assert.equal(clickSound.voices.size, 1, "单槽最多补发一次，不能把三次点击都排出去");
});

await test("audio slot: hidden page discards the click; buffer must be ready inside 180 ms", async () => {
	const hidden = await createHarness({ audio: true, audioResume: "immediate", config: { count: 1, sound: { enabled: true, volume: 0.6 } } });
	await hidden.applyConfig({ count: 1, sound: { enabled: true, volume: 0.6 } });
	await hidden.settle(10);
	const hiddenSound = hidden.exports.clickSound;
	hiddenSound.unlock({ isTrusted: true });
	hidden.setVisible(false);
	hiddenSound.play({ isTrusted: true });
	await hidden.settle(80);
	assert.equal(hiddenSound.voices.size, 0, "隐藏页面不能发声");
	hidden.setVisible(true);
	await hidden.settle(200);
	assert.equal(hiddenSound.voices.size, 0, "隐藏时的点击直接丢弃，恢复可见不能补播");

	const ready = await createHarness({ audio: true, audioDecodeDelayMs: 100, config: { count: 1, sound: { enabled: true, volume: 0.6 } } });
	await ready.applyConfig({ count: 1, sound: { enabled: true, volume: 0.6 } });
	await ready.settle(10);
	const readySound = ready.exports.clickSound;
	readySound.unlock({ isTrusted: true });
	readySound.play({ isTrusted: true });
	await ready.settle(180);
	assert.equal(readySound.voices.size, 1, "buffer 在 180ms 内就绪应补发一次");

	const lateBuffer = await createHarness({ audio: true, audioDecodeDelayMs: 250, config: { count: 1, sound: { enabled: true, volume: 0.6 } } });
	await lateBuffer.applyConfig({ count: 1, sound: { enabled: true, volume: 0.6 } });
	await lateBuffer.settle(10);
	const lateSound = lateBuffer.exports.clickSound;
	lateSound.unlock({ isTrusted: true });
	lateSound.play({ isTrusted: true });
	await lateBuffer.settle(180);
	assert.equal(lateSound.voices.size, 0, "buffer 未就绪且超过 180ms 不能发声");
	await lateBuffer.settle(200);
	assert.equal(lateSound.voices.size, 0, "buffer 迟到不能补播过期的点击");
});

await test("audio slot: blur and sound-off cancel a pending click", async () => {
	const blur = await createHarness({ audio: true, audioResume: 100, config: { count: 1, sound: { enabled: true, volume: 0.6 } } });
	await blur.applyConfig({ count: 1, sound: { enabled: true, volume: 0.6 } });
	await blur.settle(10);
	const blurSound = blur.exports.clickSound;
	blurSound.unlock({ isTrusted: true });
	blurSound.play({ isTrusted: true });
	await blur.settle(20);
	blur.dispatchWindow({ type: "blur" });
	await blur.settle(200);
	assert.equal(blurSound.voices.size, 0, "blur 应取消待播点击，resume 后不能补播");

	const off = await createHarness({ audio: true, audioResume: 100, config: { count: 1, sound: { enabled: true, volume: 0.6 } } });
	await off.applyConfig({ count: 1, sound: { enabled: true, volume: 0.6 } });
	await off.settle(10);
	const offSound = off.exports.clickSound;
	offSound.unlock({ isTrusted: true });
	offSound.play({ isTrusted: true });
	await off.settle(20);
	await off.applyConfig({ count: 1, sound: { enabled: false, volume: 0.6 } });
	await off.settle(200);
	assert.equal(offSound.voices.size, 0, "关闭音效应取消待播点击");
	assert.equal(offSound.gain.gain.value, 0, "关闭音效后增益归零");
});

await test("audio slot: unlock retries resume for at most 400 ms and never claims success", async () => {
	const harness = await createHarness({ audio: true, audioResume: "hang", config: { count: 1, sound: { enabled: true, volume: 0.6 } } });
	await harness.applyConfig({ count: 1, sound: { enabled: true, volume: 0.6 } });
	await harness.settle(10);
	const { clickSound } = harness.exports;
	const context = clickSound.context;
	clickSound.unlock({ isTrusted: true });
	await harness.settle(399);
	assert.equal(context.state, "suspended", "resume 未成功前不能假装 running");
	await harness.settle(5);
	assert.equal(clickSound.resuming, false, "400ms 后必须释放 resuming");
	const calls = context.resumeCalls;
	assert.ok(calls >= 1, "至少尝试过一次 resume");
	await harness.settle(500);
	assert.equal(context.resumeCalls, calls, "400ms 后不能无限重试 resume");
	assert.equal(context.state, "suspended");
	assert.notEqual(clickSound.failed, true, "resume 超时是能力受限，不是永久失败");
});

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

await test("menu: one tracked menu closes on action/replacement without leaking listeners", async () => {
	const harness = await createHarness();
	const { stage, openMenu, closeMenu } = harness.exports;
	await harness.applyConfig({ count: 1, animationGroups: Object.fromEntries(ANIM_GROUPS.map((group) => [group, false])) });
	openMenu(120, 100, stage.pets[0]);
	const first = stage.menu;
	assert.ok(first);
	await harness.settle(0);
	openMenu(150, 120, stage.pets[0]);
	assert.equal(first.parentNode, null, "replacement removes old menu");
	assert.equal(stage.root.querySelectorAll(".pet-menu").length, 1);
	const button = stage.menu.children[0];
	button.dispatchEvent({ type: "click" });
	await harness.settle(0);
	assert.equal(stage.menu, undefined);
	assert.equal(stage.menuDismiss, undefined);
	assert.equal(stage.root.querySelectorAll(".pet-menu").length, 0);
	assert.ok(stage.pets[0].idleTimer !== undefined, "empty action categories re-arm idle");
	openMenu(120, 100, stage.pets[0]);
	closeMenu();
	await harness.settle(0);
	assert.equal(stage.menu, undefined);
	assert.equal(stage.menuDismiss, undefined);
});
/* New integration cases exercise the real stage entry points, not Session alone. */
function moneySnapshot(remaining = "12.50", patch = {}) {
	return { ok: true, shape: "money",
		accounts: [{ accountId: "custom-api:CNY", currency: "CNY", shape: "money", remaining, used: null }],
		fetchedAt: "2026-11-10T12:00:00.000Z", ...patch };
}
async function clickBubble(harness, pet) {
	pet.handleClick({ isTrusted: false });
	await harness.settle(20);
	await flushMicrotasks();
	await harness.settle(140);
	await flushMicrotasks();
}
async function allScenePages(harness, pet, scene) {
	const text = [];
	for (let guard = 0; guard < 40 && pet.bubbleController.scene === scene; guard += 1) {
		text.push(pet.bubbleController.textElement.textContent);
		await clickBubble(harness, pet);
	}
	assert.notEqual(pet.bubbleController.scene, scene, `all pages must eventually leave the current scene (mode=${pet.mode}, context=${harness.exports.state.contextStatus}, narrator=${harness.exports.state.narratorId}, text=${pet.bubbleController.textElement?.textContent})`);
	return text.join("\n");
}
async function bubbleHarness(options = {}) {
	const balance = clone(options.balance ?? moneySnapshot());
	const config = mergeDeep({ count: 1, roam: false, idleMinMs: 60000, idleMaxMs: 60000, animationGroups: { click: false } }, options.config ?? {});
	const harness = await createHarness({ ...options, balance, config });
	await harness.applyConfig(harness.config);
	await harness.exports.fetchState();
	await harness.settle(0);
	// Baseline setup has not run the one-second delivery tick. Manual interaction
	// owns the scene; existing status notices are separately tested below.
	return harness;
}

await test("bubble integration: balance pages then random pages then closed", async () => {
	const h = await bubbleHarness(); const pet = h.exports.stage.pets[0];
	await clickBubble(h, pet);
	assert.equal(pet.bubbleController.scene, "balance");
	const balanceText = await allScenePages(h, pet, "balance");
	assert.match(balanceText, /12\.5/); assert.doesNotMatch(balanceText, /赠金|充值|已用|总额度|%/);
	assert.equal(pet.bubbleController.scene, "random");
	const randomText = await allScenePages(h, pet, "random");
	assert.ok(randomText.trim());
	assert.equal(pet.bubbleController.scene, "closed");
	assert.equal(pet.bubble.hidden, true);
	assert.equal(h.commandLog.filter((row) => row.commandId === "pet-balance-refresh").length, 0, "unconfigured API is not queried on bubble interaction");
});

await test("bubble integration: same-tier amount changes update balance without redrawing random", async () => {
	const h = await bubbleHarness(); const pet = h.exports.stage.pets[0];
	await clickBubble(h, pet);
	h.setBalance(moneySnapshot("11.75")); await h.exports.refreshBalance(true); await h.settle(0);
	assert.equal(pet.bubbleController.scene, "balance");
	assert.equal(pet.bubbleController.content.modules.find((row) => row.main).numeric, "11.75");
	await allScenePages(h, pet, "balance");
	assert.equal(pet.bubbleController.scene, "random");
	const before = { text: pet.bubbleController.content.text, page: pet.bubbleController.pageIndex, deadline: pet.bubbleController.deadline };
	h.setBalance(moneySnapshot("11.25")); await h.exports.refreshBalance(true); await h.settle(0);
	assert.equal(pet.bubbleController.content.text, before.text);
	assert.equal(pet.bubbleController.pageIndex, before.page);
	assert.equal(pet.bubbleController.deadline, before.deadline, "background digit updates must not reset manual scene timer");
});

await test("bubble integration: a single API snapshot renders only returned balance fields", async () => {
	const balance = moneySnapshot("12.50", { accounts: [
		{ accountId: "ledger-a", providerSelectionId: "secret-selection", providerId: "internal-relay-secret", label: "Secret Relay Name", currency: "CNY", remaining: "12.50", granted: "2.50", toppedUp: "10.00", used: "7.50", total: "20.00", percent: 37.5 },
		{ accountId: "ledger-b", providerSelectionId: "other-secret", providerId: "other-internal-id", label: "Other Secret Provider", currency: "USD", remaining: "0.25", total: "5", percent: 95 },
	] });
	const h = await bubbleHarness({ balance, config: { balance: { custom: { url: "https://api.example.test/balance", totalPath: "data.remaining", usedPath: "data.used", currency: "CNY" } } } });
	const pet = h.exports.stage.pets[0]; await clickBubble(h, pet);
	const text = await allScenePages(h, pet, "balance");
	assert.match(text, /12\.50|12\.5/); assert.match(text, /CNY/); assert.match(text, /7\.50/);
	assert.equal((text.match(/(?:^|\D)12\.50(?:\D|$)/g) ?? []).length, 1);
	assert.equal((text.match(/(?:^|\D)7\.50(?:\D|$)/g) ?? []).length, 1);
	assert.doesNotMatch(text, /(?:^|\D)2\.50(?:\D|$)|(?:^|\D)10\.00(?:\D|$)|(?:^|\D)20\.00(?:\D|$)|(?:^|\D)37\.5(?:\D|$)|(?:^|\D)0\.25(?:\D|$)|赠金|充值|总额度|%|USD|internal-relay-secret|other-internal-id|Secret Relay Name|Other Secret Provider|provider|accountId/);
});

await test("bubble integration: unconfigured API shows setup guidance without host or narrator language", async () => {
	const h = await bubbleHarness({
		balance: { ok: false, status: "unconfigured", message: "请先填写第三方余额 API 地址与 API Key。", accounts: [] },
		config: { balance: { custom: { url: "", totalPath: "", usedPath: "", currency: "CNY" } } },
	});
	await clickBubble(h, h.exports.stage.pets[0]);
	const text = h.exports.stage.pets[0].bubbleController.textElement.textContent;
	assert.match(text, /请先填写第三方余额 API 地址与 API Key/);
	assert.doesNotMatch(text, /宿主|叙述者|供应商/);
});
await test("bubble integration: points keep units and never invent a percentage", async () => {
	const h = await bubbleHarness({ config: { balance: { custom: { currency: "POINTS" } } }, balance: { ok: true, shape: "points", accounts: [{ accountId: "custom-api:POINTS", currency: "POINTS", remaining: "1250", shape: "points" }] } });
	const pet = h.exports.stage.pets[0]; await clickBubble(h, pet);
	const text = await allScenePages(h, pet, "balance");
	assert.match(text, /1250/); assert.match(text, /POINTS/); assert.doesNotMatch(text, /%|赠金|充值|provider|accountId/);
});

await test("bubble integration: error state preserves stale amounts and explicit unavailable text", async () => {
	const h = await bubbleHarness({ balance: moneySnapshot("9.90", { ok: false, stale: true, error: { message: "示例离线错误" } }) });
	const pet = h.exports.stage.pets[0]; await clickBubble(h, pet);
	const text = await allScenePages(h, pet, "balance");
	assert.match(text, /旧数据/); assert.match(text, /9\.9/); assert.doesNotMatch(text, /provider|accountId|demo:CNY/);
});

await test("bubble integration: disabling bubbles clears current and prevents click notices", async () => {
	const h = await bubbleHarness(); const pet = h.exports.stage.pets[0]; await clickBubble(h, pet);
	await h.applyConfig({ bubbles: { enabled: false } });
	assert.equal(pet.bubble.hidden, true); assert.equal(pet.bubbleController.timer, null);
	await clickBubble(h, pet); assert.equal(pet.bubbleController.scene, "closed");
	assert.equal(h.exports.state.localNotices.length, 0);
});

await test("bubble integration: hidden expired content never returns on visibility", async () => {
	const h = await bubbleHarness({ config: { bubbles: { durationMs: 500 } } });
	h.exports.startVisibilityGating(); const pet = h.exports.stage.pets[0];
	await clickBubble(h, pet); h.setVisible(false); await h.settle(1000);
	assert.equal(pet.bubble.hidden, true);
	h.setVisible(true); await h.settle(0);
	assert.equal(pet.bubbleController.scene, "closed"); assert.equal(pet.bubble.hidden, true);
});

await test("bubble integration: removal destroys controller timers and visual nodes", async () => {
	const h = await bubbleHarness({ config: { count: 2 } }); const removed = h.exports.stage.pets[1];
	await clickBubble(h, removed); const bubble = removed.bubbleController, node = bubble.element;
	await h.applyConfig({ count: 1 }); await h.settle(10000);
	assert.equal(bubble.destroyed, true); assert.equal(bubble.timer, null);
	assert.equal(bubble.frames.size, 0); assert.equal(bubble.transitions.size, 0);
	assert.equal(node.parentNode, null); assert.equal(removed.bubbleController, undefined);
});

await test("bubble integration: six pets retain independent scene page and timer state", async () => {
	const h = await bubbleHarness({ config: { count: 6, bubbles: { durationMs: 0 } } }); const pets = h.exports.stage.pets;
	for (const pet of pets) await clickBubble(h, pet);
	assert.equal(new Set(pets.map((pet) => pet.bubbleController)).size, 6);
	assert.equal(new Set(pets.map((pet) => pet.bubble)).size, 6);
	await allScenePages(h, pets[1], "balance");
	pets[2].bubbleController.close();
	await clickBubble(h, pets[3]);
	assert.equal(pets[0].bubbleController.scene, "balance");
	assert.equal(pets[1].bubbleController.scene, "random");
	assert.equal(pets[2].bubbleController.scene, "closed");
	assert.equal(pets[3].bubbleController.scene, "random");
	assert.equal(pets[4].bubbleController.scene, "balance");
	assert.equal(pets[5].bubbleController.scene, "balance");
	assert.ok(pets.every((pet) => pet.bubbleController.deadline === 0));
});

await test("bubble integration: overlay published compact hit bounds exclude visible bubble", async () => {
	const h = await bubbleHarness({ surface: "overlay" }); const { stage, state, publishOverlayBounds } = h.exports;
	state.surface = "overlay"; const pet = stage.pets[0];
	publishOverlayBounds(true); await h.settle(0); const before = clone(h.boundsCalls.at(-1));
	await clickBubble(h, pet); pet.squash = 0; pet.squashVelocity = 0; pet.render();
	publishOverlayBounds(true); await h.settle(0);
	assert.ok(pet.bubbleController.rect); assert.equal(pet.bubble.dataset.surface, "overlay");
	assert.deepEqual(h.boundsCalls.at(-1), before, "bubble artwork must not enlarge the host input capture");
});

await test("task integration: real scoped pending/resolved reaches then clears stage bubble", async () => {
	const h = await bubbleHarness({ narratorId: "test-narrator" });
	h.exports.state.localNotices = []; await h.exports.startTaskEvents();
	const envelope = (state, seq) => ({ schema: "narrafork.public-event", schemaVersion: 1, eventId: `fixture-${seq}`, occurredAt: "2026-11-10T12:00:00.000Z", deliverySeq: seq,
		topic: "narrafork.narrator.attention", eventClass: "attention", redaction: "user_scoped",
		resource: { type: "narrator", id: "test-narrator", narratorId: "test-narrator" }, data: { narratorId: "test-narrator", reason: "waiting_permission", state } });
	assert.equal(h.taskCalls.subscribe[0].scope.narratorId, "test-narrator");
	h.pushTask(envelope("raised", 1)); await h.settle(1000); h.exports.deliverLocalNotices(); await h.settle(0);
	const pet = h.exports.stage.pets[0]; assert.match(pet.bubbleController.content.text, /授权/);
	h.pushTask(envelope("resolved", 2)); await h.settle(1000);
	assert.equal(pet.bubbleController.scene, "closed");
	assert.equal(h.exports.state.taskState.tasks[0].waitingPermission, false);
	h.exports.state.taskEvents.destroy();
});

await test("preview integration: rendered inline script parses and uses bundled CSS with safe query embedding", async () => {
	const source = await fs.readFile(path.join(PLUGIN_DIR, "tools", "preview.mjs"), "utf8");
	const definitions = source.slice(source.indexOf("const ANIMATION_GROUPS ="), source.indexOf("async function resolveFile"));
	const renderer = vm.createContext({ URLSearchParams });
	vm.runInContext(definitions + '\n globalThis.renderPreview = (query) => { const settings = previewSettings(new URLSearchParams(query)); return previewPage({nocss:settings.nocss,settings}); };', renderer);
	const html = renderer.renderPreview("clean=1&narratorId=demo");
	assert.ok(html.includes('href="/ui/stage.bundle.css"'));
	assert.ok(html.includes("display:none !important"));
	const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
	assert.ok(inline); new vm.Script(inline);
	const injection = renderer.renderPreview("narratorId=" + encodeURIComponent("</script><script>throw 1</script>"));
	assert.equal((injection.match(/<script>/g) ?? []).length, 1, "query narratorId must not close the script tag");
});

await test("preview integration: offline controls provide real-shape scoped events and sample balances", async () => {
	const source = await fs.readFile(path.join(PLUGIN_DIR, "tools", "preview.mjs"), "utf8");
	const definitions = source.slice(source.indexOf("const ANIMATION_GROUPS ="), source.indexOf("async function resolveFile"));
	const renderer = vm.createContext({ URLSearchParams });
	vm.runInContext(definitions + '\n globalThis.html = previewPage({settings:previewSettings(new URLSearchParams("narratorId=demo"))});', renderer);
	const inline = renderer.html.match(/<script>([\s\S]*?)<\/script>/)[1];
	const dom = createDom(createClock(), { decode: async () => {} }); dom.document.head = dom.element("head");
	const browser = { console, document: dom.document, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, removeEventListener() {},
		fetch() { throw new Error("offline preview test must not access network"); } };
	browser.window = browser; vm.createContext(browser); vm.runInContext(inline, browser);
	assert.equal(browser.__previewFidelity.realPermissions, false); assert.equal(browser.__preview.examplesOnly, true);
	assert.equal((await browser.narrafork.getContext()).narrator.id, "demo");
	const subscription = await vm.runInContext('narrafork.events.subscribe({topics:["narrafork.narrator.attention"],scope:{narratorId:"demo"},filter:{narratorIds:["demo"]},mode:"live",delivery:{transport:"poll"}})', browser);
	browser.subscriptionId = subscription.subscriptionId;
	browser.__preview.events.sample("done", "foreign"); browser.__preview.events.sample("done", "demo");
	const rows = await vm.runInContext('narrafork.events.poll({subscriptionId,limit:50})', browser);
	assert.equal(rows.length, 1); assert.equal(rows[0].schema, "narrafork.public-event"); assert.equal(rows[0].data.narratorId, "demo");
	await browser.__preview.sample("points");
	const points = await vm.runInContext('narrafork.commands.execute("pet-balance-refresh",{})', browser);
	assert.equal(points.output.snapshot.accounts[0].currency, "POINTS");
	assert.equal(points.output.snapshot.accounts[0].percent, undefined);
	await browser.__preview.balanceError();
	await assert.rejects(vm.runInContext('narrafork.commands.execute("pet-balance-refresh",{})', browser), /示例/);
	browser.__preview.events.mode("PERMISSION_DENIED");
	await assert.rejects(vm.runInContext('narrafork.events.poll({subscriptionId,limit:50})', browser), /PERMISSION_DENIED/);
	browser.__preview.events.mode(null);
	assert.equal(browser.__preview.clock.advance(500).timerMode, "real-browser");
});

const failed = results.filter((entry) => !entry.ok);
const skipped = results.length === 0;
process.stdout.write(
	`\n[selftest-stage] ${results.length - failed.length}/${results.length} 通过` +
		(skipped ? "（filter 未匹配任何用例）" : "") + "\n",
);
if (failed.length > 0) {
	process.stdout.write(`失败：${failed.map((entry) => entry.name).join(" / ")}\n`);
	process.exitCode = 1;
}
