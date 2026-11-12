/**
 * Dependency-free pet stage for panel DOM input and the existing overlay relay.
 *
 * The sandbox cannot fetch animation files. Build-time index, measured alpha
 * bounds and the original click sound are inlined; clip bytes arrive through
 * pet-clip RPC and are kept in a bounded LRU. Every playback owns a fresh Blob
 * URL so animated WebP one-shots restart independently and stop after one loop.
 * Decoding precedes action/travel timers; cancellation invalidates every older
 * async result while preserving the last visible image.
 *
 * The full canvas is visual only. Compact hit targets follow each clip's bounds,
 * while physics uses a stable idle-body baseline unaffected by click squash.
 */

/* -------------------------------------------------------------------------- */
/* Boot diagnostics                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The stage doubles as its own acceptance report.
 *
 * A desktop pet that silently does nothing is indistinguishable from a broken
 * install, and the user cannot open devtools comfortably in a sandboxed iframe.
 * So every assumption this file depends on gets a named, visible check.
 */
const diagnostics = [];
const diagnosticById = new Map();

function record(id, label, status, detail) {
	const previous = diagnosticById.get(id);
	const entry = { id, label, status, detail: detail === undefined ? previous?.detail : detail };
	if (previous) Object.assign(previous, entry);
	else {
		diagnosticById.set(id, entry);
		diagnostics.push(entry);
	}
	if (state.hud) renderDiagnostics();
	// A failing check is worth a stderr line: the panel may be the only place the
	// user looks, but the host's diagnostic view is where a maintainer looks.
	if (status === "fail") SDK.report("error", `自检失败：${label}`, { id, detail: String(detail ?? "") });
	return entry;
}

/* -------------------------------------------------------------------------- */
/* Inlined build data                                                         */
/* -------------------------------------------------------------------------- */

const INDEX = PET_ANIM_INDEX;
const CLIP_BY_ID = new Map(INDEX.clips.map((clip) => [clip.id, clip]));
const PLUGIN_ID = "cn.mcd7.neglectdream.dsh-pet";
const SETTINGS_VIEW_ID = "pet-settings";

/* -------------------------------------------------------------------------- */
/* Animation WebP duration fallback                                          */
/* -------------------------------------------------------------------------- */

/** WebP has no ended event; build-index measured each clip's total duration. */
function clipDurationMs(clip) {
	if (typeof clip?.durationMs === "number" && clip.durationMs > 0) return clip.durationMs;
	return undefined;
}

/* -------------------------------------------------------------------------- */
/* Clip bytes → Blob URLs                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Animation data does not come from the asset route, and cannot.
 *
 * `PluginUiAssetService.readAsset` serves only paths the manifest declares — the
 * UI entry, each view's `entry`/`style`, and theme images — and answers every
 * other path under the same asset prefix with 404. A browser reports that as
 * `decode()` → "The source image cannot be decoded", with nothing pointing at the
 * cause. Declaring 114 fake views just to whitelist 114 files would abuse the
 * contribution schema and pollute the admin contribution list, so the bytes come
 * through the plugin's own command channel instead, and this module turns them
 * into `blob:` URLs (`img-src` allows `blob:`).
 *
 * The bounded cache retains immutable bytes. Instance URLs belong to the player,
 * not the cache: unique URLs restart one-shots and are revoked on every exit path.
 */
// Cache source bytes, not playback URLs: each playback has an independent clock.
const CLIP_URL_CACHE_MAX = 24;
const clipBytesCache = new Map();
const clipInflight = new Map();

function base64ToBytes(text) {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

async function withTimeout(promise, milliseconds, label) {
	let timer;
	try {
		return await Promise.race([promise, new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} timeout`)), Math.max(1, milliseconds));
		})]);
	} finally { clearTimeout(timer); }
}
async function fetchClipBytes(index) {
	const parts = [];
	let offset = 0;
	let total;
	const deadline = performance.now() + 15000;
	for (let guard = 0; guard < 32; guard += 1) {
		if (performance.now() >= deadline) throw new Error("pet-clip timeout");
		const result = await withTimeout(SDK.callSafe("pet-clip", { index, offset }), deadline - performance.now(), "pet-clip");
		if (!result.ok) throw new Error(result.error.message);
		const value = result.value ?? {};
		if (!Number.isSafeInteger(value.total) || value.total <= 0 || value.total > 16 * 1024 * 1024 ||
			value.offset !== offset || (total !== undefined && total !== value.total)) {
			throw new Error("invalid clip chunk envelope");
		}
		total = value.total;
		const bytes = base64ToBytes(String(value.data ?? ""));
		if (bytes.byteLength === 0 || offset + bytes.byteLength > total) throw new Error("invalid clip chunk length");
		parts.push(bytes);
		offset += bytes.byteLength;
		if (offset === total) break;
		if (value.done === true) throw new Error("truncated clip data");
	}
	if (offset !== total) throw new Error("incomplete clip data");
	const merged = new Uint8Array(total);
	let at = 0;
	for (const part of parts) { merged.set(part, at); at += part.byteLength; }
	return merged;
}

async function clipBytes(index) {
	const cached = clipBytesCache.get(index);
	if (cached) {
		clipBytesCache.delete(index);
		clipBytesCache.set(index, cached);
		return cached;
	}
	if (clipInflight.has(index)) return clipInflight.get(index);
	const task = fetchClipBytes(index).then((bytes) => {
		clipBytesCache.set(index, bytes);
		while (clipBytesCache.size > CLIP_URL_CACHE_MAX) clipBytesCache.delete(clipBytesCache.keys().next().value);
		return bytes;
	});
	clipInflight.set(index, task);
	try { return await task; }
	finally { clipInflight.delete(index); }
}

/** Validate RIFF chunk boundaries before changing ANIM's uint16 loop count.
 *  0 = forever; 1 = exactly one playback. Never mutate the shared source bytes.
 */
function webpWithLoopCount(bytes, loopCount) {
	if (loopCount !== 0 && loopCount !== 1) throw new Error("invalid loop count");
	if (bytes.length < 12) throw new Error("truncated WebP header");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const fourCC = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
	if (fourCC(0) !== "RIFF" || fourCC(8) !== "WEBP" || view.getUint32(4, true) + 8 !== bytes.length) {
		throw new Error("invalid WebP RIFF size or signature");
	}
	let loopOffset = -1;
	let animated = false;
	let frames = 0;
	for (let offset = 12; offset < bytes.length;) {
		if (offset + 8 > bytes.length) throw new Error("truncated WebP chunk header");
		const type = fourCC(offset);
		const size = view.getUint32(offset + 4, true);
		const start = offset + 8;
		const end = start + size + (size & 1);
		if (end > bytes.length) throw new Error("truncated WebP chunk payload");
		if (type === "VP8X") {
			if (size !== 10) throw new Error("invalid VP8X chunk");
			animated = Boolean(bytes[start] & 2);
		} else if (type === "ANIM") {
			if (size !== 6 || loopOffset !== -1 || !animated || frames) throw new Error("invalid ANIM chunk");
			loopOffset = start + 4;
		} else if (type === "ANMF") {
			if (size < 16 || loopOffset < 0) throw new Error("invalid ANMF chunk");
			frames += 1;
		}
		offset = end;
	}
	if (!animated || loopOffset < 0 || !frames) throw new Error("not an animated WebP");
	const copy = bytes.slice();
	new DataView(copy.buffer).setUint16(loopOffset, loopCount, true);
	return copy;
}

/** Caller owns the URL and must revoke it on replacement/cancellation/disposal. */
async function clipUrl(index, { loop = true } = {}) {
	const bytes = webpWithLoopCount(await clipBytes(index), loop ? 0 : 1);
	return URL.createObjectURL(new Blob([bytes], { type: "image/webp" }));
}

/* -------------------------------------------------------------------------- */
/* Clip player: one double-buffered slot per pet                             */
/* -------------------------------------------------------------------------- */

class ClipPlayer {
	constructor(element) {
		this.element = element;
		this.layers = [document.createElement("img"), document.createElement("img")];
		this.urls = [undefined, undefined];
		this.layerClips = [undefined, undefined];
		for (const layer of this.layers) {
			layer.className = "pet-frame";
			layer.alt = "";
			layer.decoding = "async";
			layer.draggable = false;
			layer.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none";
			element.append(layer);
		}
		this.front = 0;
		this.layers[0].classList.add("is-front");
		this.layers[0].style.opacity = "1";
		this.layers[1].style.opacity = "0";
		this.clipId = undefined;
		this.token = 0;
		this.facing = 1;
		this.loop = false;
		this.disposed = false;
	}

	isMirrored(clip = CLIP_BY_ID.get(this.clipId)) {
		if (clip?.noMirror || clip?.sourceFacing === 0) return false;
		return this.facing !== (clip?.sourceFacing ?? 1);
	}

	updateFacing() {
		for (let index = 0; index < this.layers.length; index += 1) {
			this.layers[index].style.transform = this.isMirrored(this.layerClips[index]) ? "scaleX(-1)" : "none";
		}
	}

	setFacing(facing) {
		this.facing = facing < 0 ? -1 : 1;
		this.updateFacing();
	}

	releaseLayer(index) {
		this.layers[index].removeAttribute("src");
		if (this.urls[index]) URL.revokeObjectURL(this.urls[index]);
		this.urls[index] = undefined;
		this.layerClips[index] = undefined;
	}

	cancelPending() {
		this.token += 1;
		this.cancelDecode?.();
		this.cancelDecode = undefined;
		this.releaseLayer(1 - this.front);
	}

	async show(clipId, { loop = false } = {}) {
		if (this.disposed) return false;
		this.cancelPending();
		const token = this.token;
		const clip = CLIP_BY_ID.get(clipId);
		if (!clip) {
			record("clip-missing", `动画缺失：${clipId}`, "warn", "index 中没有这个 id");
			return false;
		}
		// Only a continuous loop may reuse its clock. Repeated one-shots always
		// receive a fresh URL, even if two pets request the same source at once.
		if (loop && this.loop && this.clipId === clipId) return true;
		let url;
		try { url = await clipUrl(clip.index, { loop }); }
		catch (error) {
			if (token === this.token) record("clip-bytes", `动画数据读取失败：${clipId}`, "fail", String(error?.message ?? error));
			return false;
		}
		if (token !== this.token || this.disposed) { URL.revokeObjectURL(url); return false; }
		const backIndex = 1 - this.front;
		const back = this.layers[backIndex];
		this.urls[backIndex] = url;
		this.layerClips[backIndex] = clip;
		this.updateFacing();
		back.src = url;
		let timeout;
		try {
			const decoded = await Promise.race([
				back.decode().then(() => true),
				new Promise((resolve) => { this.cancelDecode = () => resolve(false); }),
				new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("decode timeout")), 8000); }),
			]);
			if (!decoded || token !== this.token || this.disposed) return false;
		} catch (error) {
			if (token === this.token) {
				this.releaseLayer(backIndex);
				record("clip-decode", `动画解码失败：${clipId}`, "fail", `${clip.file}: ${error?.message ?? error}`);
			}
			return false;
		} finally {
			clearTimeout(timeout);
			if (token === this.token) this.cancelDecode = undefined;
		}
		const previous = this.front;
		back.classList.add("is-front");
		this.layers[previous].classList.remove("is-front");
		back.style.opacity = "1";
		this.layers[previous].style.opacity = "0";
		this.front = backIndex;
		this.clipId = clipId;
		this.loop = loop;
		this.releaseLayer(previous);
		record("clip-decode", "动画解码", "ok", `${clipId} ${clip.width}×${clip.height} ${clip.durationMs}ms`);
		return true;
	}

	dispose() {
		this.disposed = true;
		this.cancelPending();
		this.releaseLayer(this.front);
		this.clipId = undefined;
	}
}

/* -------------------------------------------------------------------------- */
/* A single pet                                                              */
/* -------------------------------------------------------------------------- */

const GRAVITY = 2600; // px/s² at gravity multiplier 1
const MAX_SPEED = 4200;
const DRAG_STIFFNESS = 26;
const RELEASE_BOOST = 1.15;

const BODY_BOUNDS = INDEX.bodyBounds ?? { left: 0.30, top: 0.15, right: 0.68, bottom: 0.95 };
const IDLE_CLIP = INDEX.pools.idle[0];
const clamp = (value, min, max) => max < min ? (min + max) / 2 : Math.min(max, Math.max(min, value));

function randomIdleDelay(config = {}) {
	const min = Number.isFinite(config.idleMinMs) ? Math.max(0, config.idleMinMs) : 4000;
	const max = Number.isFinite(config.idleMaxMs) ? Math.max(min, config.idleMaxMs) : Math.max(min, 9000);
	return min + Math.random() * (max - min);
}
/** WebAudio stays entirely in the plugin. Relay messages are NOT user gestures. */
class ClickSound {
	constructor() {
		this.voices = new Set();
		this.lastPlayAt = -Infinity;
		this.epoch = 0;
		this.playToken = 0;
		this.resumeToken = 0;
	}

	describeOverlay() {
		if (diagnosticById.has("sound-overlay")) return;
		record("sound-overlay", "浮层音效限制", "info", "当前宿主仅支持指针中继，无法可靠解锁音频；面板内真实点击可播放原版鸭叫。");
	}

	prepare() {
		if (state.surface === "overlay") { this.describeOverlay(); return; }
		if (state.config?.sound?.enabled === false || this.context || this.failed) return;
		const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
		if (!AudioContext) { this.failed = true; record("sound", "点击音效", "warn", "浏览器不支持 WebAudio"); return; }
		try {
			this.context = new AudioContext();
			document.addEventListener("visibilitychange", () => { if (document.hidden) this.cancelPending(); });
			this.gain = this.context.createGain();
			this.analyser = this.context.createAnalyser();
			this.analyser.fftSize = 256;
			this.gain.connect(this.analyser);
			this.analyser.connect(this.context.destination);
			this.applyVolume();
			const epoch = this.epoch;
			void this.context.decodeAudioData(base64ToBytes(PET_CLICK_SOUND_BASE64).buffer).then((buffer) => {
				if (epoch !== this.epoch) return;
				this.buffer = buffer;
				let peak = 0;
				for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
					for (const sample of buffer.getChannelData(channel)) peak = Math.max(peak, Math.abs(sample));
				}
				this.decodedPeak = peak;
				record("sound", "点击音效", "info", `原版鸭叫已解码（${buffer.duration.toFixed(2)}s），等待面板真实点击`);
			}).catch((error) => this.fail(error));
		} catch (error) { this.fail(error); }
	}

	fail(error) {
		if (this.failed) return;
		this.failed = true;
		record("sound", "点击音效", "warn", String(error?.message ?? error));
	}

	applyVolume() {
		const enabled = state.config?.sound?.enabled !== false;
		const volume = clamp(state.config?.sound?.volume ?? 0.6, 0, 1);
		if (this.gain) this.gain.gain.value = enabled ? volume * 0.5 : 0;
		if (!enabled || volume <= 0) {
			this.cancelPending();
			for (const voice of this.voices) { try { voice.stop(); } catch { /* already ended */ } }
			this.voices.clear();
		}
	}

	unlock(event) {
		if (state.surface === "overlay") { this.describeOverlay(); return; }
		if (!event?.isTrusted || document.hidden || state.config?.sound?.enabled === false) return;
		this.prepare();
		this.applyVolume();
		if (!this.context || this.context.state === "running" || this.resuming) return;
		const token = ++this.resumeToken;
		this.resuming = true;
		try {
			// A blocked browser can leave resume pending forever. Bound this attempt;
			// only a future real gesture may retry, never a timer-driven autoplay loop.
			void withTimeout(this.context.resume(), 400, "audio resume").catch((error) => {
				if (token === this.resumeToken) record("sound", "点击音效", "info", `音频仍挂起，等待下一次真实点击：${error?.message ?? error}`);
			}).finally(() => { if (token === this.resumeToken) this.resuming = false; });
		} catch (error) { this.resuming = false; this.fail(error); }
	}

	play(event) {
		this.cancelPending();
		this.unlock(event);
		if (state.surface === "overlay" || !event?.isTrusted || document.hidden || state.paused ||
			state.config?.sound?.enabled === false || (state.config?.sound?.volume ?? 0.6) <= 0 || !this.context) return false;
		const token = this.playToken;
		const deadline = performance.now() + 180;
		const attempt = () => {
			this.pendingTimer = undefined;
			if (token !== this.playToken || document.hidden || state.paused || state.config?.sound?.enabled === false ||
				(state.config?.sound?.volume ?? 0.6) <= 0 || performance.now() > deadline) return false;
			if (this.buffer && this.context.state === "running") return this.startVoice();
			// One bounded slot, not a queue: resolve a quick first-click unlock/decode,
			// but discard it if permissions/focus return after this gesture is stale.
			this.pendingTimer = setTimeout(attempt, Math.min(16, Math.max(1, deadline - performance.now() + 1)));
			return false;
		};
		return attempt();
	}

	cancelPending() {
		this.playToken += 1;
		clearTimeout(this.pendingTimer);
		this.pendingTimer = undefined;
	}

	startVoice() {
		const now = performance.now();
		if (now - this.lastPlayAt < 60 || this.voices.size >= 2) return false;
		const voice = this.context.createBufferSource();
		voice.buffer = this.buffer;
		voice.connect(this.gain);
		voice.onended = () => { this.voices.delete(voice); voice.disconnect(); };
		try {
			voice.start();
			this.voices.add(voice);
			this.lastPlayAt = now;
			record("sound", "点击音效", "ok", `AudioContext running；原版鸭叫输出已启动（音量 ${state.config?.sound?.volume ?? 0.6}）`);
			return true;
		} catch (error) { voice.disconnect(); this.fail(error); return false; }
	}

	dispose() {
		this.cancelPending();
		this.epoch += 1;
		this.resumeToken += 1;
		for (const voice of this.voices) { try { voice.stop(); } catch { /* already ended */ } }
		this.voices.clear();
		void this.context?.close()?.catch?.(() => {});
	}
}
const clickSound = new ClickSound();
class Pet {
	constructor(stage, index) {
		this.stage = stage;
		this.index = index;
		this.element = document.createElement("div");
		this.element.className = "pet";
		this.element.style.cssText = `position:absolute;left:0;top:0;pointer-events:none;transform-origin:50% ${BODY_BOUNDS.bottom * 100}%`;
		this.player = new ClipPlayer(this.element);
		this.hitElement = document.createElement("div");
		this.hitElement.className = "pet-hit";
		this.hitElement.style.cssText = "position:absolute;left:0;top:0;pointer-events:auto;touch-action:none";
		this.hitElement.setAttribute("aria-label", `桌宠 ${index + 1}`);
		stage.layers.pets.append(this.element, this.hitElement);
		this.w = 120;
		this.h = 68;
		this.x = 0;
		this.y = 0;
		this.vx = 0;
		this.vy = 0;
		this.squash = 0;
		this.squashVelocity = 0;
		this.facing = 1;
		this.dragging = false;
		this.airborne = false;
		this.dragTarget = { x: 0, y: 0 };
		this.mode = "idle";
		this.clipEndsAt = 0;
		this.behaviorToken = 0;
		this.loading = false;
		this.initialized = false;
		this.disposed = false;
	}

	get config() { return this.stage.config; }
	get isAsleep() { return this.sleepPhase !== undefined; }
	get isUserBusy() { return this.dragging || this.airborne; }

	initialize() {
		if (this.initialized || !this.config || this.disposed) return;
		this.initialized = true;
		this.enterIdle();
	}

	resize(stageWidth, stageHeight, scale) {
		const base = Math.min(Math.max(stageWidth * 0.26, 96), 300);
		this.w = base * scale;
		this.h = this.w / (INDEX.canvas.width / INDEX.canvas.height);
		this.element.style.width = `${this.w}px`;
		this.element.style.height = `${this.h}px`;
		this.clampPosition();
		if (this.travel) {
			const limits = this.limits();
			this.travel.fromX = clamp(this.travel.fromX, limits.left, limits.right);
			this.travel.toX = clamp(this.travel.toX, limits.left, limits.right);
		}
		if (this.dragging) this.dragTarget = { x: this.x, y: this.y };
		this.render();
	}

	/** Full canvas is painted; only these transformed visible bounds are interactive. */
	bounds(kind = "hit") {
		const clip = CLIP_BY_ID.get(this.player.clipId);
		const box = kind === "body" ? BODY_BOUNDS : (clip?.bounds ?? BODY_BOUNDS);
		// Squash is visual feedback, not a growing rigid body that pushes neighbours
		// or permanently nudges x away from a wall on every click. The physical
		// baseline follows world facing, never a temporary text/action clip's flip.
		const mirror = kind === "body" ? this.facing < 0 : this.player.isMirrored(clip);
		const left = mirror ? 1 - box.right : box.left;
		const right = mirror ? 1 - box.left : box.right;
		const { scaleX, scaleY } = kind === "body" ? { scaleX: 1, scaleY: 1 } : this.scales();
		const originY = this.y + (BODY_BOUNDS.bottom - 0.5) * this.h;
		const result = {
			left: this.x + (left - 0.5) * this.w * scaleX,
			right: this.x + (right - 0.5) * this.w * scaleX,
			top: originY + (box.top - BODY_BOUNDS.bottom) * this.h * scaleY,
			bottom: originY + (box.bottom - BODY_BOUNDS.bottom) * this.h * scaleY,
		};
		return { ...result, width: result.right - result.left, height: result.bottom - result.top };
	}

	scales() {
		return { scaleX: clamp(1 - this.squash * 0.5, 0.65, 1.5), scaleY: clamp(1 + this.squash, 0.35, 1.5) };
	}

	limits() {
		const body = this.bounds("body");
		return { left: this.x - body.left, right: this.stage.width + this.x - body.right,
			top: this.y - body.top, bottom: this.stage.height + this.y - body.bottom };
	}

	clampPosition() {
		const limits = this.limits();
		this.x = clamp(this.x, limits.left, limits.right);
		this.y = clamp(this.y, limits.top, limits.bottom);
	}

	enabledGroups() { return this.config?.animationGroups ?? {}; }
	groupAllowed(group) { return this.enabledGroups()[group] !== false; }
	pick(list = []) {
		const candidates = list.filter((id) => id !== this.lastClipId);
		const pool = candidates.length > 0 ? candidates : list;
		return pool[Math.floor(Math.random() * pool.length)];
	}

	/** All interruptions use one cancellation path; no old callback owns x later. */
	clearBehavior({ wake = true } = {}) {
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		this.behaviorToken += 1;
		this.player.cancelPending();
		this.clipEndsAt = 0;
		this.pendingEndAction = undefined;
		this.travel = undefined;
		this.loading = false;
		if (wake) { this.sleepPhase = undefined; this.sleepSuite = undefined; }
	}

	async playOnce(clipId, onEnd = () => this.enterIdle(), onShown) {
		if (this.disposed) return false;
		if (!CLIP_BY_ID.has(clipId)) { this.enterIdle(); return false; }
		this.clearBehavior({ wake: false });
		const token = this.behaviorToken;
		this.mode = this.isAsleep ? "sleep" : "action";
		this.loading = true;
		this.lastClipId = clipId;
		const shown = await this.player.show(clipId, { loop: false });
		if (token !== this.behaviorToken || this.disposed) return false;
		this.loading = false;
		if (!shown) { this.enterIdle(); return false; }
		// The action and travel clocks start AFTER the incoming image is decoded.
		this.clipEndsAt = performance.now() + (clipDurationMs(CLIP_BY_ID.get(clipId)) ?? 1200);
		this.pendingEndAction = onEnd;
		onShown?.();
		this.render();
		return true;
	}

	async playLoop(clipId) {
		if (this.disposed || !clipId) return false;
		this.clearBehavior({ wake: false });
		const token = this.behaviorToken;
		this.loading = true;
		this.lastClipId = clipId;
		const shown = await this.player.show(clipId, { loop: true });
		if (token !== this.behaviorToken || this.disposed) return false;
		this.loading = false;
		this.render();
		return shown;
	}

	enterIdle() {
		if (this.disposed) return;
		this.clearBehavior();
		this.mode = "idle";
		// The baseline is not a random performance. Even with the idle category
		// disabled there must be a visible, breathing pet between other actions.
		const playback = this.playLoop(IDLE_CLIP);
		const token = this.behaviorToken;
		void playback.then(() => {
			if (token === this.behaviorToken && this.mode === "idle" && !this.disposed) this.scheduleAmbient();
		});
	}

	scheduleAmbient() {
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		if (this.disposed || this.mode !== "idle" || this.loading) return;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			this.ambientTick();
		}, randomIdleDelay(this.config));
	}

	ambientTick() {
		if (this.disposed || this.mode !== "idle" || this.loading || this.clipEndsAt || this.isUserBusy) return;
		if (!this.player.clipId) { this.enterIdle(); return; }
		if (this.config?.bubbles?.autoChat !== false && !state.paused && (!this.bubble || this.bubble.hidden)) {
			ensureBubble(this)?.show(BubbleContent.random(this.config?.bubbles?.overrides, Math.random, this.lastAmbientText), { priority: 0, automatic: true });
			this.lastAmbientText = this.bubbleController?.content?.text ?? this.lastAmbientText;
		}
		const chain = INDEX.chain;
		const roll = Math.random() * 100;
		if (roll < chain.idle) { this.scheduleAmbient(); return; }
		if (roll < chain.idle + chain.turn) {
			if (this.groupAllowed("turn") && INDEX.pools.turn.length) this.playFlipOnce(this.pick(INDEX.pools.turn));
			else this.scheduleAmbient();
			return;
		}
		if (roll < chain.idle + chain.turn + chain.move) {
			if (this.config?.roam !== false && this.groupAllowed("move") && INDEX.pools.move.length) this.startTravel(this.pick(INDEX.pools.move));
			else this.scheduleAmbient();
			return;
		}
		const categories = INDEX.pools.categories.filter((category) => this.groupAllowed(category.group) && category.clipIds.length);
		const total = categories.reduce((sum, category) => sum + category.weight, 0);
		if (total <= 0) { this.scheduleAmbient(); return; }
		let target = Math.random() * total;
		for (const category of categories) {
			target -= category.weight;
			if (target > 0) continue;
			this.playOnce(this.pick(category.clipIds));
			return;
		}
		this.scheduleAmbient();
	}

	startTravel(clipId) {
		if (this.isUserBusy || this.disposed) return;
		this.sleepPhase = undefined;
		this.sleepSuite = undefined;
		const params = { ...(INDEX.moveDefaults ?? {}), ...(INDEX.moveParams?.[clipId] ?? {}) };
		const scale = this.w / 462;
		const minDist = (params.minDist ?? 60) * scale;
		const maxDist = (params.maxDist ?? 240) * scale;
		const distance = minDist + Math.random() * Math.max(0, maxDist - minDist);
		const body = this.bounds("body");
		const margin = (params.margin ?? 20) * scale;
		const roomRight = Math.max(0, this.stage.width - margin - body.right);
		const roomLeft = Math.max(0, body.left - margin);
		let direction = Math.random() < 0.5 ? -1 : 1;
		if (roomRight < distance && roomLeft > roomRight) direction = -1;
		else if (roomLeft < distance && roomRight > roomLeft) direction = 1;
		const reachable = Math.max(0, Math.min(distance, direction < 0 ? roomLeft : roomRight));
		this.setFacing(direction);
		this.vx = 0;
		this.playOnce(clipId, () => this.enterIdle(), () => {
			if (reachable < 8) return;
			const limits = this.limits();
			this.travel = { fromX: this.x, toX: clamp(this.x + direction * reachable, limits.left, limits.right),
				startedAt: performance.now(), durationMs: clipDurationMs(CLIP_BY_ID.get(clipId)) ?? 2000,
				leadMs: (params.leadSec ?? 2) * 1000, tailMs: (params.tailSec ?? 2) * 1000 };
		});
	}

	playFlipOnce(clipId) {
		this.playOnce(clipId, () => { this.setFacing(-this.facing); this.enterIdle(); });
	}
	setFacing(facing) {
		this.facing = facing < 0 ? -1 : 1;
		this.player.setFacing(this.facing);
	}

	onPointerDown(event) {
		if (this.disposed || this.dragging || (event.button !== undefined && event.button !== 0)) return;
		clickSound.unlock(event);
		this.clearBehavior();
		this.airborne = false;
		this.dragging = true;
		this.dragPointerId = event.pointerId;
		this.pressedAt = performance.now();
		this.pressedPoint = { x: event.clientX, y: event.clientY };
		this.maxDragDistance = 0;
		this.pointerSamples = [{ x: event.clientX, y: event.clientY, time: this.pressedAt }];
		this.lastMovedAt = this.pressedAt;
		const rect = this.stage.root.getBoundingClientRect();
		this.dragOffset = { x: event.clientX - rect.left - this.x, y: event.clientY - rect.top - this.y };
		this.dragTarget = { x: this.x, y: this.y };
		try { this.hitElement.setPointerCapture?.(event.pointerId); } catch { /* relayed or cancelled pointer */ }
		this.element.classList.add("is-dragging");
		this.hitElement.classList.add("is-dragging");
		this.mode = "drag";
		const clip = this.groupAllowed("drag") ? this.pick(INDEX.pools.drag) : IDLE_CLIP;
		void this.playLoop(clip || IDLE_CLIP);
		this.vx = 0;
		this.vy = 0;
	}

	onPointerMove(event) {
		if (!this.dragging || event.pointerId !== this.dragPointerId) return;
		const now = performance.now();
		const previous = this.pointerSamples.at(-1);
		if (!previous || event.clientX !== previous.x || event.clientY !== previous.y) this.lastMovedAt = now;
		this.pointerSamples.push({ x: event.clientX, y: event.clientY, time: now });
		this.pointerSamples = this.pointerSamples.filter((sample) => now - sample.time <= 120).slice(-32);
		this.maxDragDistance = Math.max(this.maxDragDistance, Math.hypot(event.clientX - this.pressedPoint.x, event.clientY - this.pressedPoint.y));
		if (this.maxDragDistance >= 6 && !this.grabBubbleShown) {
			this.grabBubbleShown = true;
			this.bubbleController?.close();
			showBubble("被你抓住啦！", { pet: this, durationMs: 1800 });
		}
		const rect = this.stage.root.getBoundingClientRect();
		const limits = this.limits();
		this.dragTarget = {
			x: clamp(event.clientX - rect.left - this.dragOffset.x, limits.left, limits.right),
			y: clamp(event.clientY - rect.top - this.dragOffset.y, limits.top, limits.bottom),
		};
	}

	finishPointer() {
		this.dragging = false;
		try { this.hitElement.releasePointerCapture?.(this.dragPointerId); } catch { /* not captured */ }
		this.dragPointerId = undefined;
		this.grabBubbleShown = false;
		this.element.classList.remove("is-dragging");
		this.hitElement.classList.remove("is-dragging");
		if (state.overlayPet === this) state.overlayPet = undefined;
		this.mode = "idle";
	}

	onPointerUp(event) {
		if (!this.dragging || event.pointerId !== this.dragPointerId) return;
		this.onPointerMove(event);
		const now = performance.now();
		this.finishPointer();
		if (this.maxDragDistance < 6 && now - this.pressedAt < 400) {
			this.vx = 0;
			this.vy = 0;
			this.handleClick(event);
			return;
		}
		this.x = this.dragTarget.x;
		this.y = this.dragTarget.y;
		const first = this.pointerSamples[0];
		const last = this.pointerSamples.at(-1);
		const seconds = Math.max(0.025, (last.time - first.time) / 1000);
		const moving = this.maxDragDistance >= 12 && now - this.lastMovedAt < 80;
		this.vx = moving ? clamp((last.x - first.x) / seconds * RELEASE_BOOST, -MAX_SPEED, MAX_SPEED) : 0;
		this.vy = moving ? clamp((last.y - first.y) / seconds * RELEASE_BOOST, -MAX_SPEED, MAX_SPEED) : 0;
		this.airborne = moving || this.y < this.limits().bottom - 1;
		this.enterIdle();
		showBubble(moving ? "出发！" : "稳稳放好。", { pet: this, durationMs: 2000 });
	}

	onPointerCancel(event) {
		if (!this.dragging || (event?.pointerId !== undefined && event.pointerId !== this.dragPointerId)) return;
		this.finishPointer();
		this.vx = 0;
		this.vy = 0;
		this.airborne = false;
		this.enterIdle();
	}

	handleClick(event) {
		this.clearBehavior();
		this.mode = "idle";
		this.squash = -Math.max(0.1, this.config?.clickSquash ?? 0.35);
		this.squashVelocity = 0;
		const bubble = ensureBubble(this);
		const view = currentBalanceView();
		bubble?.updateData(view.snapshot, view.ledger);
		const repeatedHomeClick = this.config?.bubbles?.clickMode === "home" && this.lastHomeClickAt !== undefined && performance.now() - this.lastHomeClickAt < 320;
		this.lastHomeClickAt = performance.now();
		if (repeatedHomeClick) bubble?.close();
		else bubble?.interact();
		void refreshBalance(false);
		clickSound.play(event);
		const pool = this.groupAllowed("click") ? INDEX.pools.click : [];
		if (pool.length) this.playOnce(this.pick(pool));
		else this.enterIdle();
	}

	setSleeping(sleeping) {
		if (this.isUserBusy) return;
		const endPool = this.sleepSuite?.end ?? [];
		const wasAsleep = this.isAsleep;
		this.clearBehavior();
		if (!sleeping) {
			if (wasAsleep && endPool.length) this.playOnce(this.pick(endPool));
			else this.enterIdle();
			return;
		}
		const suites = INDEX.pools.sleep ?? [];
		const suite = suites[Math.floor(Math.random() * suites.length)];
		if (!suite) { this.enterIdle(); return; }
		this.sleepSuite = suite;
		this.sleepPhase = "start";
		this.mode = "sleep";
		if (suite.start?.length) this.playOnce(this.pick(suite.start), () => this.beginSleepLoop());
		else this.beginSleepLoop();
	}

	beginSleepLoop() {
		this.sleepPhase = "loop";
		this.mode = "sleep";
		void this.playLoop(this.pick(this.sleepSuite?.loop) || IDLE_CLIP);
	}

	update(dt) {
		const config = this.config;
		const gravity = GRAVITY * (config?.gravity ?? 1);
		const bounce = config?.bounce ?? 0.55;
		const friction = config?.friction ?? 0.9;
		this.applySquashSpring(dt);
		if (this.dragging) {
			const alpha = Math.min(1, DRAG_STIFFNESS * dt);
			this.x += (this.dragTarget.x - this.x) * alpha;
			this.y += (this.dragTarget.y - this.y) * alpha;
			this.clampPosition();
			return;
		}
		if (this.travel) {
			const { leadMs, tailMs, durationMs, fromX, toX, startedAt } = this.travel;
			const progress = clamp((performance.now() - startedAt - leadMs) / Math.max(1, durationMs - leadMs - tailMs), 0, 1);
			const eased = progress < 0.5 ? 2 * progress * progress : 1 - 2 * (1 - progress) ** 2;
			this.x = fromX + (toX - fromX) * eased;
			this.vx = 0;
		} else this.x += this.vx * dt;
		this.vy += gravity * dt;
		this.y += this.vy * dt;
		const limits = this.limits();
		if (this.y >= limits.bottom) {
			this.y = limits.bottom;
			this.vy = Math.abs(this.vy) > 90 ? -Math.abs(this.vy) * bounce : 0;
			this.vx *= Math.pow(friction, dt * 60);
			if (Math.abs(this.vx) < 4) this.vx = 0;
		}
		if (this.y < limits.top) { this.y = limits.top; this.vy = Math.abs(this.vy) * bounce; }
		if (this.x < limits.left) { this.x = limits.left; this.vx = Math.abs(this.vx) * bounce; }
		if (this.x > limits.right) { this.x = limits.right; this.vx = -Math.abs(this.vx) * bounce; }
		this.clampPosition();
		if (this.airborne && Math.abs(this.vx) < 4 && Math.abs(this.vy) < 4) {
			this.airborne = false;
			if (this.mode === "idle") this.scheduleAmbient();
		}
	}

	applySquashSpring(dt) {
		this.squashVelocity += (-260 * this.squash - 18 * this.squashVelocity) * dt;
		this.squash += this.squashVelocity * dt;
	}

	tickClipTimer(now) {
		if (this.dragging || this.sleepPhase === "loop" || !this.clipEndsAt || now < this.clipEndsAt) return;
		const action = this.pendingEndAction;
		this.clipEndsAt = 0;
		this.pendingEndAction = undefined;
		this.travel = undefined;
		action?.();
	}

	render() {
		const { scaleX, scaleY } = this.scales();
		this.element.style.transform = `translate3d(${this.x - this.w / 2}px, ${this.y - this.h / 2}px, 0) scale(${scaleX}, ${scaleY})`;
		const hit = this.bounds();
		this.hitElement.style.transform = `translate3d(${hit.left}px, ${hit.top}px, 0)`;
		this.hitElement.style.width = `${hit.width}px`;
		this.hitElement.style.height = `${hit.height}px`;
		positionBubble(this);
	}

	dispose() {
		this.disposed = true;
		this.finishPointer();
		this.clearBehavior();
		this.player.dispose();
		this.bubbleController?.destroy();
		this.bubbleController = undefined;
		this.bubble = undefined;
		this.hitElement.remove();
		this.element.remove();
	}
}

/* -------------------------------------------------------------------------- */
/* Stage                                                                      */
/* -------------------------------------------------------------------------- */

const state = {
	config: undefined,
	balance: undefined,
	ledger: undefined,
	balanceApiStatus: "loading",
	activeAccountIds: [],
	localNotices: [],
	stopped: false,
	hud: undefined,
	ready: false,
	paused: false,
	lastFrameAt: 0,
	frameCount: 0,
	fps: 0,
	balanceTier: undefined,
	/** Surface and overlay pointer relay remain unrelated to balance acquisition. */
	surface: "panel",
	overlayApi: undefined,
	overlayPet: undefined,
};

const stage = {
	get config() { return state.config; },
	refresh: () => fetchState(),
	sound: clickSound,
	root: undefined,
	layers: {},
	pets: [],
	width: 0,
	height: 0,
	menu: undefined,
	rafId: 0,
	emergencyStop: false,
};

/* -------------------------------------------------------------------------- */
/* DOM construction                                                          */
/* -------------------------------------------------------------------------- */

function buildDom() {
	// Everything below is about one thing: this document must be transparent.
	//
	// In an overlay surface this frame covers the entire application, so an opaque
	// canvas is not cosmetic — it is a white sheet over the whole UI. Three
	// independent things can paint it, and all three are handled here because only one
	// of them being wrong is enough to blank the app:
	//
	//   1. the host shell's loading splash (`position: fixed; inset: 0` filled with the
	//      theme's body colour). It is supposed to be removed when the entry script
	//      loads; in a panel nobody notices if it is not, but stretched over the whole
	//      viewport it *is* the white screen. Removed explicitly rather than assumed.
	//   2. `html`/`body` backgrounds from any stylesheet, including one that loads
	//      after this script — hence `!important` through CSSOM, which cannot be lost
	//      to load order the way a plain rule can.
	//   3. the used `color-scheme`, which decides the colour of the canvas when the
	//      root has no background at all — and which additionally has to MATCH the
	//      embedder. Chromium gives a frame whose scheme disagrees with its parent's an
	//      opaque canvas, however transparent its own root is; the app shell is dark, so
	//      declaring `normal` (light) here is itself a cause of the white sheet. Mirror
	//      the host's own scheme, which the host shell writes onto `<html>`.
	document.getElementById("plugin-shell-splash")?.remove();
	const hostColorScheme =
		document.documentElement.getAttribute("data-mantine-color-scheme") === "light"
			? "light"
			: "dark";
	for (const element of [document.documentElement, document.body]) {
		element.style.setProperty("background", "transparent", "important");
		element.style.setProperty("color-scheme", hostColorScheme, "important");
	}
	document.body.style.setProperty("margin", "0", "important");
	// Dragging must not start a text selection or leave an insertion point blinking in
	// the frame; the stage is a canvas, not a document.
	for (const element of [document.documentElement, document.body]) {
		element.style.setProperty("user-select", "none", "important");
		element.style.setProperty("-webkit-user-select", "none", "important");
		element.style.setProperty("caret-color", "transparent", "important");
	}

	const root = document.createElement("div");
	root.className = "pet-stage";
	// The stage must fill the iframe with or without `stage.css`. Without this floor,
	// a stylesheet that 404s or arrives after the script leaves the stage at whatever
	// height its emptied body has — which is zero, and zero is silent.
	root.style.cssText = "position:relative;width:100%;height:100%;overflow:hidden;pointer-events:none";

	const background = document.createElement("div");
	background.className = "pet-background";
	background.setAttribute("aria-hidden", "true");
	background.style.cssText = "position:absolute;inset:0;pointer-events:none";

	const pets = document.createElement("div");
	pets.className = "pet-layer";
	pets.style.cssText = "position:absolute;inset:0;pointer-events:none";

	const hud = document.createElement("div");
	hud.className = "pet-hud";
	hud.hidden = true;
	hud.style.position = "absolute";

	root.append(background, pets, hud);
	document.body.replaceChildren(root);
	stage.root = root;
	stage.layers = { background, pets, hud };
	return root;
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                    */
/* -------------------------------------------------------------------------- */

function layout() {
	const rect = stage.root.getBoundingClientRect();
	const previousWidth = stage.width;
	const previousHeight = stage.height;
	stage.width = Math.max(1, Math.floor(rect.width));
	stage.height = Math.max(1, Math.floor(rect.height));
	const config = state.config ?? {};
	const target = clamp(Math.floor(config.count ?? 1), 1, 6);
	while (stage.pets.length < target) {
		const pet = new Pet(stage, stage.pets.length);
		stage.pets.push(pet);
		bindPet(pet);
	}
	while (stage.pets.length > target) stage.pets.pop().dispose();
	for (const [index, pet] of stage.pets.entries()) {
		if (pet.placed && previousWidth > 0 && previousHeight > 0 &&
			(previousWidth !== stage.width || previousHeight !== stage.height)) {
			pet.x = pet.x / previousWidth * stage.width;
			pet.y = pet.y / previousHeight * stage.height;
		}
		pet.resize(stage.width, stage.height, config.scale ?? 1);
		if (!pet.placed) {
			pet.x = stage.width * (index + 1) / (target + 1);
			pet.y = pet.limits().bottom;
			pet.placed = Boolean(state.config);
			pet.clampPosition();
		}
		pet.initialize();
		pet.render();
	}
	record("size", "舞台尺寸", stage.width > 32 && stage.height > 32 ? "ok" : "warn",
		`${stage.width}×${stage.height}（视口 ${window.innerWidth}×${window.innerHeight}）`);
	publishOverlayBounds(true);
}

function bindPet(pet) {
	if (state.surface === "overlay") return;
	pet.hitElement.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		pet.onPointerDown(event);
	});
	pet.hitElement.addEventListener("lostpointercapture", (event) => pet.onPointerCancel(event));
	pet.hitElement.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openMenu(event.clientX, event.clientY, pet);
	});
}

function cancelPointers() {
	clickSound.cancelPending();
	for (const pet of stage.pets) pet.onPointerCancel();
	state.overlayPet = undefined;
}

function installPointerEvents() {
	if (state.surface !== "overlay") {
		// Window listeners also cover browsers where pointer capture failed. Only
		// the owner of this pointer id reacts, even when the pointer leaves its hit box.
		window.addEventListener("pointermove", (event) => { for (const pet of stage.pets) pet.onPointerMove(event); });
		window.addEventListener("pointerup", (event) => { for (const pet of stage.pets) pet.onPointerUp(event); });
		window.addEventListener("pointercancel", (event) => { for (const pet of stage.pets) pet.onPointerCancel(event); });
	}
	window.addEventListener("blur", cancelPointers);
	window.addEventListener("pagehide", () => {
		stopLoop();
		for (const pet of stage.pets) pet.dispose();
		clickSound.dispose();
	});
}

/* -------------------------------------------------------------------------- */
/* Frame loop                                                                */
/* -------------------------------------------------------------------------- */

function startLoop() {
	if (stage.rafId || stage.emergencyStop) return;
	state.lastFrameAt = performance.now();
	stage.rafId = requestAnimationFrame(frame);
}

function stopLoop() {
	if (!stage.rafId) return;
	cancelAnimationFrame(stage.rafId);
	stage.rafId = 0;
}

function frame(now) {
	stage.rafId = 0;
	if (state.paused || stage.emergencyStop) return;
	const last = state.lastFrameAt || now;
	// Clamp dt: a background tab returns a multi-second delta, which would fling
	// every pet through a wall in one step.
	const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
	state.lastFrameAt = now;

	for (const pet of stage.pets) {
		pet.tickClipTimer(now);
		pet.update(dt);
	}
	resolveCollisions();
	for (const pet of stage.pets) pet.render();
	if (state.pendingBalance) maybePlayBalance();
	// Keeps the host's hit rectangle following the pets. Self-throttling, so calling it
	// every frame costs a few comparisons rather than a bridge round trip per frame.
	publishOverlayBounds();

	state.frameCount += 1;
	if (now - (state.fpsWindowAt ?? 0) > 1000) {
		state.fps = Math.round((state.frameCount * 1000) / (now - (state.fpsWindowAt ?? now - 1000)));
		state.frameCount = 0;
		state.fpsWindowAt = now;
		if (state.hud) renderHud();
		// A report raised while the images were still loading repairs itself once the
		// stage is actually drawing, so a slow first frame does not leave a permanent
		// error banner over a working pet.
		if (document.getElementById(FAULT_REPORT_ID) && !stageLooksPainted()) {
			/* keep it */
		} else if (document.getElementById(FAULT_REPORT_ID)) {
			clearFaultReport();
		}
	}
	stage.rafId = requestAnimationFrame(frame);
}

function resolveCollisions() {
	if (!state.config?.collisions || stage.pets.length < 2) return;
	for (let a = 0; a < stage.pets.length; a += 1) {
		for (let b = a + 1; b < stage.pets.length; b += 1) {
			const first = stage.pets[a];
			const second = stage.pets[b];
			if (first.dragging || second.dragging) continue;
			const one = first.bounds("body");
			const two = second.bounds("body");
			const overlapX = Math.min(one.right, two.right) - Math.max(one.left, two.left);
			const overlapY = Math.min(one.bottom, two.bottom) - Math.max(one.top, two.top);
			if (overlapX <= 0 || overlapY <= 0) continue;
			const horizontal = overlapX < overlapY;
			const axis = horizontal ? "x" : "y";
			const velocity = horizontal ? "vx" : "vy";
			const diff = horizontal ? (two.left + two.right - one.left - one.right) : (two.top + two.bottom - one.top - one.bottom);
			const sign = diff < 0 ? -1 : 1;
			const push = (horizontal ? overlapX : overlapY) / 2 * sign;
			const firstX = first.x;
			const secondX = second.x;
			first[axis] -= push;
			second[axis] += push;
			const average = (first[velocity] + second[velocity]) / 2;
			const impulse = Math.abs(first[velocity] - second[velocity]) * 0.2;
			first[velocity] = average - impulse * sign;
			second[velocity] = average + impulse * sign;
			first.clampPosition();
			second.clampPosition();
			// A collision must not be undone by next frame's absolute travel curve.
			for (const [pet, oldX] of [[first, firstX], [second, secondX]]) {
				if (!pet.travel) continue;
				const limits = pet.limits();
				pet.travel.fromX = clamp(pet.travel.fromX + pet.x - oldX, limits.left, limits.right);
				pet.travel.toX = clamp(pet.travel.toX + pet.x - oldX, limits.left, limits.right);
			}
		}
	}
}

/* -------------------------------------------------------------------------- */
/* Bubble                                                                    */
/* -------------------------------------------------------------------------- */

function currentBalanceView() {
	const snapshot = state.balance;
	const custom = state.config?.balance?.custom ?? {};
	if (!snapshot) {
		const configured = typeof custom.url === "string" && custom.url.length > 0;
		return { snapshot: { status: configured ? "loading" : "unconfigured", loading: configured,
			message: configured ? "正在查询第三方余额 API…" : "请先填写第三方余额 API 地址与 API Key。",
			ok: false, stale: false, accounts: [], balances: [] }, ledger: { accounts: [] } };
	}
	const currency = typeof custom.currency === "string" ? custom.currency : "POINTS";
	const sourceAccounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
	const account = sourceAccounts[0];
	if (!account) {
		return { snapshot: { ...snapshot, label: undefined, providerId: undefined,
			shape: currency === "POINTS" ? "points" : "money", accounts: [], balances: [] }, ledger: { accounts: [] } };
	}
	const selected = {
		accountId: account.accountId,
		currency,
		shape: currency === "POINTS" ? "points" : "money",
		remaining: account.remaining ?? account.totalBalance,
		used: account.used ?? null,
	};
	return {
		snapshot: {
			ok: snapshot.ok,
			stale: snapshot.stale === true,
			error: snapshot.error,
			fetchedAt: snapshot.fetchedAt,
			shape: selected.shape,
			accounts: [selected],
			balances: [selected],
		},
		ledger: currency === "POINTS" ? { accounts: [] } : ledgerForAccounts([selected]),
	};
}

function ledgerForAccounts(accounts) {
	const ids = new Set(state.activeAccountIds);
	return { ...(state.ledger ?? {}), accounts: (state.ledger?.accounts ?? []).filter((entry) => ids.has(entry.accountId)) };
}

function updateBubbleBalanceViews() {
	const view = currentBalanceView();
	for (const pet of stage.pets) pet.bubbleController?.updateData(view.snapshot, view.ledger);
}

function ensureBubble(pet) {
	if (!pet || pet.disposed || typeof PetBubble === "undefined") return undefined;
	if (!pet.bubbleController) {
		const view = currentBalanceView();
		pet.bubbleController = new PetBubble({ container: stage.root,
			body: () => pet.bounds("body"), viewport: () => ({ width: stage.width, height: stage.height }),
			config: state.config?.bubbles ?? {}, snapshot: view.snapshot, ledger: view.ledger, surface: state.surface,
			onChange: (bubble, reason) => {
				if (pet.activeNotice && (reason === "close" || bubble.contentId !== pet.activeNotice)) {
					const id = pet.activeNotice; pet.activeNotice = undefined;
					state.taskEvents?.dismiss(id);
				}
			},
		});
		pet.bubble = pet.bubbleController.element;
		pet.bubbleController.setVisible(!state.paused);
	}
	return pet.bubbleController;
}

/** One finite, newest-per-id UI queue; it never changes a pet's physics. */
function queueNotice(notice) {
	if (!notice?.id || state.config?.bubbles?.enabled === false) return;
	state.localNotices = state.localNotices.filter((item) => item.id !== notice.id && item.expiresAt > Date.now());
	state.localNotices.push({ ...notice, expiresAt: notice.expiresAt ?? Date.now() + 60_000 });
	state.localNotices.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
	state.localNotices = state.localNotices.slice(0, 12);
}

async function startTaskEvents() {
	if (typeof TaskEvents === "undefined" || state.stopped) return;
	state.taskEvents = new TaskEvents({ config: state.config?.tasks ?? { enabled: true },
		onNotice: (notice) => queueNotice({ ...notice, priority: notice.kind === "permission" ? 90 : 40,
			durationMs: state.config?.bubbles?.noticeDurationMs ?? 8000,
			expiresAt: Date.now() + (notice.kind === "permission" ? 120_000 : 30_000) }),
		onClear: clearNotice,
		onState: (status) => { state.taskState = status; renderTaskBindings(); },
	});
	await state.taskEvents.start();
	state.taskEvents.setVisible(!state.paused);
}

function renderTaskBindings() {
	const node = stage.taskStatus;
	if (!node) return;
	const status = state.taskEvents?.getState() ?? state.taskState;
	node.textContent = `能力：${status?.capability ?? "检查中"}。${status?.error?.message ?? ""}\n` +
		`当前范围：${status?.scope?.map((item) => `${item.alias || "当前对话"} (${item.narratorId})`).join("、") || "未关联，不订阅任何任务"}\n` +
		"宿主未提供逐轮费用；当前接口不能可靠确认等待回答。关联只对本视图生效，不读取对话正文。";
}

function openTaskBindings() {
	if (state.surface === "overlay") {
		showBubble("浮层仅跟随宿主明确提供的当前对话；请在面板视图中设置该面板自己的任务关联。", { durationMs: 8000 });
		return;
	}
	stage.taskPanel?.remove();
	const panel = SDK.el("section", { class: "pet-task-bindings", role: "dialog", "aria-label": "本视图任务关联" });
	const status = SDK.el("p", { class: "pet-task-status" });
	stage.taskStatus = status;
	const fields = [];
	const scopes = state.taskEvents?.getState()?.scope ?? [];
	for (let index = 0; index < 3; index++) {
		const id = SDK.el("input", { placeholder: "已知 narratorId（不扫描列表）", maxlength: 160, "aria-label": `对话 ID ${index + 1}` });
		const alias = SDK.el("input", { placeholder: "显示别名（可选）", maxlength: 60, "aria-label": `别名 ${index + 1}` });
		id.value = scopes[index]?.narratorId ?? ""; alias.value = scopes[index]?.alias ?? "";
		fields.push({ id, alias });
		panel.append(SDK.el("div", { class: "pet-task-binding-row" }, [id, alias]));
	}
	const result = SDK.el("p", { role: "status" });
	const apply = SDK.el("button", { type: "button", text: "应用本视图关联", onclick: () => {
		const reply = state.taskEvents?.setAssociations(fields.filter((field) => field.id.value.trim()).map((field) => ({ narratorId: field.id.value.trim(), alias: field.alias.value.trim() })));
		result.textContent = reply?.ok ? "已更新；清空三行并应用可全部取消关联。" : String(reply?.error?.message ?? reply?.error ?? "事件模块不可用");
		renderTaskBindings();
	} });
	const retry = SDK.el("button", { type: "button", text: "重新检测授权", onclick: () => void state.taskEvents?.retry() });
	const close = SDK.el("button", { type: "button", text: "关闭", onclick: () => { panel.remove(); stage.taskPanel = undefined; stage.taskStatus = undefined; } });
	panel.prepend(SDK.el("h3", { text: "本视图任务关联" }), status);
	panel.append(result, apply, retry, close);
	panel.addEventListener("pointerdown", (event) => event.stopPropagation());
	stage.root.append(panel); stage.taskPanel = panel; renderTaskBindings();
}
function clearNotice(id) {
	state.localNotices = state.localNotices.filter((item) => item.id !== id);
	for (const pet of stage.pets) {
		if (pet.activeNotice === id) { pet.bubbleController?.close(); pet.activeNotice = undefined; }
	}
}

function noticePet(priority = 30) {
	return stage.pets.find((pet) => !pet.disposed && !pet.isUserBusy && !pet.isAsleep &&
		(!pet.bubbleController || pet.bubble?.hidden || (!pet.bubbleController.scene?.startsWith?.("manual") &&
		 !["balance", "random"].includes(pet.bubbleController.scene) && (pet.bubbleController.priority ?? 0) < priority)));
}

function deliverLocalNotices() {
	if (state.paused || state.stopped || state.config?.bubbles?.enabled === false) return;
	state.localNotices = state.localNotices.filter((item) => item.expiresAt > Date.now());
	const notice = state.localNotices[0];
	if (!notice) return;
	const pet = noticePet(notice.priority);
	if (!pet) return;
	state.localNotices.shift();
	const controller = ensureBubble(pet);
	if (!controller) return;
	const displayed = controller.show(notice.content ?? notice.text, { id: notice.id, priority: notice.priority ?? 30,
		durationMs: notice.durationMs ?? state.config?.bubbles?.noticeDurationMs ?? 8000,
		expiresAt: notice.expiresAt, automatic: true });
	if (displayed !== false) pet.activeNotice = notice.id;
}

async function pollPersistedNotice() {
	if (state.noticePolling || state.paused || state.stopped || state.config?.bubbles?.enabled === false || state.config?.alerts?.enabled !== true) return;
	const accountIds = Array.isArray(state.activeAccountIds) ? state.activeAccountIds.filter((id) => typeof id === "string") : [];
	if (!accountIds.length || !noticePet(80)) return;
	state.noticePolling = true;
	try {
		const reply = await SDK.callSafe("pet-notices", { action: "claim", consumerId: state.noticeOwner, limit: 5, accountIds: accountIds.slice(0, 32) });
		if (!reply.ok || state.paused || state.stopped || state.config?.bubbles?.enabled === false) return;
		const notice = (reply.value?.notices ?? []).find((entry) => Date.parse(entry.expiresAt) > Date.now() && Date.parse(entry.leaseUntil) > Date.now());
		if (!notice) return;
		const priority = notice.kind === "budget" ? 80 : 70;
		const target = noticePet(priority);
		if (!target) return;
		const controller = ensureBubble(target);
		if (!controller) return;
		const text = notice.kind === "budget" ? `今日已观测消费达到预算提醒阈值（${notice.currency}）` : `余额达到提醒条件（${notice.currency}）`;
		const shown = controller.show(text, { id: notice.id, priority, automatic: true,
			durationMs: state.config?.bubbles?.noticeDurationMs ?? 8000, expiresAt: Date.parse(notice.expiresAt) });
		if (shown === false) { controller.queue = controller.queue.filter((entry) => entry.id !== notice.id); return; }
		target.activeNotice = notice.id;
		await new Promise((resolve) => setTimeout(resolve, 450));
		if (state.paused || state.stopped || controller.element?.hidden || controller.deferred || controller.contentId !== notice.id || target.activeNotice !== notice.id) {
			if (target.activeNotice === notice.id) controller.close();
			return;
		}
		const ack = await SDK.callSafe("pet-notices", { action: "ack", consumerId: state.noticeOwner, id: notice.id, leaseToken: notice.leaseToken });
		if ((!ack.ok || !ack.value?.acked) && target.activeNotice === notice.id) controller.close();
	} finally { state.noticePolling = false; }
}
function showBubble(text, options = {}) {
	const pet = options.pet ?? stage.pets.find((item) => !item.isUserBusy) ?? stage.pets[0];
	if (!pet || pet.disposed) return false;
	const controller = ensureBubble(pet);
	if (!controller) return false;
	if (!text) { controller.close(); return false; }
	return controller.show(text, { id: options.id, priority: options.priority ?? 30,
		durationMs: options.sticky ? 0 : options.durationMs,
		automatic: options.automatic ?? false, expiresAt: options.expiresAt });
}

function positionBubble(pet) {
	if (!pet.bubbleController) return;
	const others = stage.pets.filter((other) => other !== pet && other.bubbleController?.rect && !other.bubble?.hidden)
		.map((other) => other.bubbleController.rect);
	pet.bubbleController.position(pet.bounds("body"), { width: stage.width, height: stage.height }, others);
}

/* -------------------------------------------------------------------------- */
/* Context menu                                                              */
/* -------------------------------------------------------------------------- */

function closeMenu() {
	stage.menuDismiss?.();
	stage.menuDismiss = undefined;
	stage.menu?.remove();
	stage.menu = undefined;
}

function openMenu(clientX, clientY, pet) {
	closeMenu();
	const rect = stage.root.getBoundingClientRect();
	const menu = document.createElement("div");
	menu.className = "pet-menu";

	// `pet` is optional: the menu is also opened for a right-click on empty stage, and
	// reading `pet.isAsleep` unguarded threw before a single node was appended — the menu
	// simply never appeared.
	const asleep = Boolean(pet?.isAsleep);
	const items = [
		{ label: "换个动作", run: () => randomAction(pet) },
		{ label: "刷新余额", run: () => void refreshBalance(true, { feedback: true, pet }) },
		{ label: "关闭气泡", run: () => {
			if (pet?.activeNotice) state.taskEvents?.dismiss(pet.activeNotice);
			pet?.bubbleController?.close();
		} },
		{ label: "本视图任务关联", run: () => openTaskBindings() },
		{
			label: asleep ? "叫醒它" : "让它睡觉",
			run: () => pet?.setSleeping(!asleep),
		},
		{ label: "全部复位", run: () => resetPets() },
		{ separator: true },
		{ label: "桌宠设置", run: () => openSettings() },
		{ label: "自检信息", run: () => toggleHud(true) },
	];
	for (const item of items) {
		if (item.separator) {
			const line = document.createElement("div");
			line.className = "pet-menu-separator";
			menu.append(line);
			continue;
		}
		const button = document.createElement("button");
		button.type = "button";
		button.className = "pet-menu-item";
		button.textContent = item.label;
		button.addEventListener("click", () => {
			closeMenu();
			item.run();
		});
		menu.append(button);
	}

	stage.menu = menu;
	stage.root.append(menu);
	const bounds = menu.getBoundingClientRect();
	menu.style.left = `${Math.min(clientX - rect.left, Math.max(0, stage.width - bounds.width - 4))}px`;
	menu.style.top = `${Math.min(clientY - rect.top, Math.max(0, stage.height - bounds.height - 4))}px`;

	const dismiss = (event) => {
		if (!menu.contains(event.target)) closeMenu();
	};
	// Register after the opening gesture; closing/replacing the menu also cancels
	// this deferred registration and its listener instead of leaking old menus.
	const timer = setTimeout(() => document.addEventListener("pointerdown", dismiss, true), 0);
	stage.menuDismiss = () => {
		clearTimeout(timer);
		document.removeEventListener("pointerdown", dismiss, true);
	};
}

function randomAction(pet) {
	if (!pet || pet.isUserBusy) return;
	pet.clearBehavior();
	const categories = INDEX.pools.categories.filter((category) => pet.groupAllowed(category.group));
	const pool = categories.flatMap((category) => category.clipIds);
	if (pool.length === 0) { pet.enterIdle(); return; }
	pet.playOnce(pet.pick(pool), () => pet.enterIdle());
}

function resetPets() {
	cancelPointers();
	for (const [index, pet] of stage.pets.entries()) {
		pet.clearBehavior();
		pet.vx = 0;
		pet.vy = 0;
		pet.airborne = false;
		pet.x = stage.width * (index + 1) / (stage.pets.length + 1);
		pet.y = pet.limits().bottom;
		pet.setFacing(1);
		pet.clampPosition();
		pet.enterIdle();
		pet.render();
	}
	showBubble("都回到原位啦", { durationMs: 2000 });
}

async function openSettings() {
	try {
		const api = SDK.bridge();
		await api.panel.open({ pluginId: PLUGIN_ID, contributionId: SETTINGS_VIEW_ID });
		closeMenu();
	} catch (error) {
		showBubble("打不开设置面板，请从设置页进入「桌宠设置」", { tone: "warn", durationMs: 6000 });
		SDK.report("warn", "panel.open failed", { message: String(error?.message ?? error) });
	}
}

/* -------------------------------------------------------------------------- */
/* HUD / diagnostics                                                         */
/* -------------------------------------------------------------------------- */

function toggleHud(force) {
	state.hud = force ?? !state.hud;
	stage.layers.hud.hidden = !state.hud;
	if (state.hud) {
		renderDiagnostics();
		renderHud();
	}
}

function renderDiagnostics() {
	if (!state.hud) return;
	const hud = stage.layers.hud;
	hud.replaceChildren();
	const title = document.createElement("div");
	title.className = "pet-hud-title";
	title.textContent = "桌宠自检";
	const close = document.createElement("button");
	close.type = "button";
	close.className = "pet-hud-close";
	close.textContent = "×";
	close.addEventListener("click", () => toggleHud(false));
	title.append(close);
	hud.append(title);

	const list = document.createElement("div");
	list.className = "pet-hud-list";
	for (const entry of diagnostics) {
		const row = document.createElement("div");
		row.className = `pet-hud-row is-${entry.status}`;
		const label = document.createElement("span");
		label.className = "pet-hud-label";
		label.textContent = entry.label;
		const detail = document.createElement("span");
		detail.className = "pet-hud-detail";
		detail.textContent = entry.detail ?? "";
		row.append(label, detail);
		list.append(row);
	}
	hud.append(list);
}

function renderHud() {
	if (!state.hud) return;
	const hud = stage.layers.hud;
	let stats = hud.querySelector(".pet-hud-stats");
	if (!stats) {
		stats = document.createElement("div");
		stats.className = "pet-hud-stats";
		hud.append(stats);
	}
	const pet = stage.pets[0];
	stats.textContent = [
		`${state.fps} fps`,
		`${stage.pets.length} 只`,
		pet ? `clipplay ${pet.lastClipId ?? "-"}` : "",
		`${stage.width}×${stage.height}`,
		state.balance?.ok ? `${Math.round(state.balance.percent ?? 0)}% 档${state.balance.tier}` : "",
	]
		.filter(Boolean)
		.join(" · ");
}

/* -------------------------------------------------------------------------- */
/* Self-describing failure report                                             */
/* -------------------------------------------------------------------------- */

/**
 * When nothing appears, the panel has to say why.
 *
 * A desktop pet that renders nothing is indistinguishable from a plugin that
 * failed to load, a panel that was never enabled, and a stylesheet that 404'd —
 * and the user has no console to check, because this is a sandboxed iframe they
 * cannot inspect. So if the stage is still not visibly painted a few seconds in,
 * it draws its own diagnosis on top of everything, with inline styles that cannot
 * themselves be broken by a missing stylesheet.
 */
const FAULT_REPORT_ID = "pet-fault-report";

function faultFacts(trigger) {
	const rect = stage.root?.getBoundingClientRect();
	const body = document.body.getBoundingClientRect();
	let sheets;
	try {
		sheets = [...document.styleSheets].map((sheet) => sheet.href ?? "inline").join(", ");
	} catch (error) {
		sheets = `读取失败：${error?.message ?? error}`;
	}
	const stagePosition = stage.root ? getComputedStyle(stage.root).position : "缺失";
	const lines = [
		`桌宠没有正常绘制（${trigger}）`,
		"",
		`iframe 视口    ${window.innerWidth}×${window.innerHeight}  dpr=${window.devicePixelRatio}`,
		`body           ${Math.round(body.width)}×${Math.round(body.height)}`,
		`舞台 rect      ${rect ? `${Math.round(rect.width)}×${Math.round(rect.height)} @ ${Math.round(rect.left)},${Math.round(rect.top)}` : "缺失"}`,
		`舞台 position  ${stagePosition}${stagePosition === "relative" ? "" : "   ← 样式表可能没有生效"}`,
		`样式表         ${sheets || "(无)"}`,
		`动画索引       ${INDEX.clips.length} 段 / ${INDEX.profile}`,
		`宠物           ${stage.pets.length} 只`,
		...stage.pets.map((pet, index) => {
			const box = pet.element.getBoundingClientRect();
			const frame = pet.player.layers[pet.player.front];
			return `  #${index} ${Math.round(box.width)}×${Math.round(box.height)} @ ${Math.round(box.left)},${Math.round(box.top)} clip=${pet.lastClipId ?? "none"} img=${frame.naturalWidth}×${frame.naturalHeight} src=${(frame.currentSrc || "").split("/").pop() || "(空)"}`;
		}),
		"",
		"自检：",
		...diagnostics.map((entry) => `  [${entry.status}] ${entry.label}: ${entry.detail ?? ""}`),
	];
	return lines.join("\n");
}

function showFaultReport(reason) {
	let report = document.getElementById(FAULT_REPORT_ID);
	if (!report) {
		report = document.createElement("pre");
		report.id = FAULT_REPORT_ID;
		report.style.cssText = [
			"position:fixed",
			"inset:8px",
			"z-index:2147483647",
			"margin:0",
			"padding:10px 12px",
			"overflow:auto",
			"white-space:pre-wrap",
			"font:11px/1.55 ui-monospace,Consolas,monospace",
			"color:#ffd7d7",
			"background:rgba(24,12,14,.95)",
			"border:1px solid #b03040",
			"border-radius:8px",
		].join(";");
		document.body.append(report);
	}
	report.textContent = faultFacts(reason);
	SDK.report("error", `stage not painted: ${reason}`, { report: report.textContent.slice(0, 1200) });
}

function clearFaultReport() {
	document.getElementById(FAULT_REPORT_ID)?.remove();
}

/** A stage that is sized and has at least one decoded frame is considered drawn. */
function stageLooksPainted() {
	const rect = stage.root?.getBoundingClientRect();
	if (!rect || rect.width < 32 || rect.height < 32) return "舞台尺寸为 0";
	const painted = stage.pets.some((pet) => {
		const layer = pet.player.layers[pet.player.front];
		return layer.complete && layer.naturalWidth > 0;
	});
	return painted ? undefined : "没有任何一帧动画解码成功";
}

function installVisibilityWatchdog() {
	setTimeout(() => {
		const reason = stageLooksPainted();
		if (reason) showFaultReport(reason);
	}, 3200);
}

/* -------------------------------------------------------------------------- */
/* Overlay surface: pointer relay + interactive rectangle                      */
/* -------------------------------------------------------------------------- */

/**
 * Where this view was mounted, and whether the host can relay pointer input.
 *
 * `context.get` is a host-local method: it answers from the same snapshot as the
 * handshake, so `surface.kind` is authoritative and available before the first
 * frame. A host that predates the overlay surface simply reports a dock surface,
 * and nothing here changes.
 */
async function detectSurface() {
	let kind;
	try {
		const context = await SDK.bridge().getContext();
		kind = context?.surface?.kind;
	} catch {
		kind = undefined;
	}
	state.surface = kind === "overlay" ? "overlay" : "panel";
	state.overlayApi = state.surface === "overlay" ? SDK.overlay() : undefined;
	return kind;
}

function petAtPoint(x, y) {
	const rect = stage.root.getBoundingClientRect();
	x -= rect.left;
	y -= rect.top;
	for (let index = stage.pets.length - 1; index >= 0; index -= 1) {
		const pet = stage.pets[index];
		const hit = pet.bounds();
		if (x >= hit.left && x <= hit.right && y >= hit.top && y <= hit.bottom) return pet;
	}
	return undefined;
}

/**
 * Turn the host's relayed pointer stream into the same handlers the dock surface
 * gets from real DOM events.
 *
 * The events are synthesized, so anything the handlers do that depends on the
 * event being trusted — pointer capture in particular — is already wrapped in a
 * try/catch inside `Pet`, where it is an optimisation rather than a requirement.
 */
function installOverlayRelay() {
	SDK.onNotification((message) => {
		if (message?.method !== "overlay.pointer") return;
		const params = message.params ?? {};
		const x = Number(params.x);
		const y = Number(params.y);
		if (!Number.isFinite(x) || !Number.isFinite(y)) return;
		const event = {
			clientX: x,
			clientY: y,
			pointerId: Number.isFinite(params.pointerId) ? params.pointerId : (state.overlayPet?.dragPointerId ?? 1),
			button: 0,
			buttons: Number.isFinite(params.buttons) ? params.buttons : 0,
			preventDefault() {},
			stopPropagation() {},
		};

		if (params.type === "down") {
			if (state.overlayPet?.dragging) {
				if (event.pointerId !== state.overlayPet.dragPointerId) return;
				// A fresh down for this same pointer proves the old up was lost.
				state.overlayPet.onPointerCancel(event);
			}
			const pet = petAtPoint(x, y);
			if (!pet) return;
			state.overlayPet = pet;
			pet.onPointerDown(event);
			return;
		}
		const pet = state.overlayPet;
		if (!pet) return;
		if (params.type === "move") {
			if (params.buttons === 0) pet.onPointerCancel(event);
			else pet.onPointerMove(event);
			return;
		}
		if (params.type === "up" || params.type === "cancel") {
			if (event.pointerId !== pet.dragPointerId) return;
			if (params.type === "cancel") pet.onPointerCancel(event);
			else pet.onPointerUp(event);
			// The pet has stopped moving, so the host's hit rectangle can tighten right
			// away instead of waiting for the next throttled publish.
			publishOverlayBounds(true);
		}
	});
}

let lastPublishedBounds;
let lastPublishAt = 0;

function publishOverlayBounds(force = false) {
	if (state.surface !== "overlay" || !state.overlayApi || !stage.pets.length) return;
	const now = performance.now();
	// The host captures an active pointer. No large safety blanket is necessary.
	if (!force && now - lastPublishAt < 32) return;
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const pet of stage.pets) {
		const hit = pet.bounds();
		minX = Math.min(minX, hit.left); minY = Math.min(minY, hit.top);
		maxX = Math.max(maxX, hit.right); maxY = Math.max(maxY, hit.bottom);
	}
	if (!Number.isFinite(minX)) return;
	const origin = stage.root.getBoundingClientRect();
	const margin = 6;
	const left = Math.max(0, Math.floor(minX + origin.left - margin));
	const top = Math.max(0, Math.floor(minY + origin.top - margin));
	const right = Math.min(window.innerWidth, Math.ceil(maxX + origin.left + margin));
	const bottom = Math.min(window.innerHeight, Math.ceil(maxY + origin.top + margin));
	const rect = { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
	if (!force && lastPublishedBounds && ["x", "y", "width", "height"].every((key) => Math.abs(rect[key] - lastPublishedBounds[key]) < 2)) return;
	lastPublishedBounds = rect;
	lastPublishAt = now;
	// Existing API accepts one rectangle only: disjoint pets' internal gap remains
	// a host limitation. Do not pretend a rejected hit can be forwarded underneath.
	try { void state.overlayApi.setBounds(rect)?.catch?.(() => {}); }
	catch { /* a disconnected bridge must not break physics */ }
}

/* -------------------------------------------------------------------------- */
/* Backend polling                                                           */
/* -------------------------------------------------------------------------- */

async function fetchState() {
	if (state.fetchPending) return state.fetchPending;
	state.fetchPending = (async () => {
		const result = await SDK.callSafe("pet-state");
		if (state.stopped) return undefined;
		if (!result.ok) {
			record("backend", "后端命令", "fail", result.error.message);
			state.balanceApiStatus = "unavailable";
			if (!state.config) updateBubbleBalanceViews();
			return undefined;
		}
		record("backend", "后端命令", "ok", "pet-state 往返成功");
		const value = result.value ?? {};
		if (value.config) applyConfig(value.config);
		state.balance = value.balance ?? null;
		state.ledger = value.ledger ?? state.ledger;
		state.activeAccountIds = Array.isArray(value.activeAccountIds) ? value.activeAccountIds.filter((id) => typeof id === "string") : [];
		state.balanceApiStatus = state.balance ? state.balance.ok ? "ready" : state.balance.stale ? "stale" : "unavailable"
			: value.config?.balance?.custom?.url ? "loading" : "not-configured";
		updateBubbleBalanceViews();
		maybePlayBalance();
		return value;
	})().finally(() => { state.fetchPending = undefined; });
	return state.fetchPending;
}

function applyConfig(config) {
	const previous = state.config;
	state.config = config;
	if (!previous || previous.count !== config.count || previous.scale !== config.scale) layout();
	for (const pet of stage.pets) {
		pet.initialize();
		if (JSON.stringify(previous?.bubbles) !== JSON.stringify(config.bubbles)) pet.bubbleController?.setConfig(config.bubbles ?? {});
	}
	if (config.bubbles?.enabled === false) state.localNotices = [];
	if (JSON.stringify(previous?.tasks) !== JSON.stringify(config.tasks)) state.taskEvents?.configure(config.tasks ?? { enabled: true });
	const balanceConfigChanged = previous && JSON.stringify(previous.balance?.custom) !== JSON.stringify(config.balance?.custom);
	if (balanceConfigChanged) {
		state.balance = null;
		state.ledger = { ...(state.ledger ?? {}), accounts: [] };
		state.activeAccountIds = [];
		state.balanceTier = undefined;
		state.balanceApiStatus = config.balance?.custom?.url ? "loading" : "not-configured";
	}
	const waitingChanged = previous && (previous.idleMinMs !== config.idleMinMs || previous.idleMaxMs !== config.idleMaxMs ||
		previous.roam !== config.roam || JSON.stringify(previous.animationGroups) !== JSON.stringify(config.animationGroups));
	if (waitingChanged) {
		for (const pet of stage.pets) {
			if (pet.mode === "idle" && !pet.loading && !pet.clipEndsAt && !pet.isUserBusy) pet.scheduleAmbient();
		}
	}
	clickSound.applyVolume();
	clickSound.prepare();
	applyBackground();
	if (balanceConfigChanged) updateBubbleBalanceViews();
}

/** Keep animation tiers global, but never enqueue the host's full provider list as a bubble. */
function maybePlayBalance() {
	const snapshot = state.balance;
	updateBubbleBalanceViews();
	if (!snapshot) return;
	if (!snapshot.ok) { state.balanceTier = "error"; state.pendingBalance = false; return; }
	const tier = Number.isInteger(snapshot.tier) ? snapshot.tier : undefined;
	if (tier === undefined || state.balanceTier === tier) { state.pendingBalance = false; return; }
	const pet = stage.pets.find((item) => !item.disposed && !item.isUserBusy && !item.isAsleep && !item.loading && item.mode !== "action");
	if (!pet) { state.pendingBalance = true; return; }
	state.pendingBalance = false;
	state.balanceTier = tier;
	const clipId = INDEX.pools.balance[tier];
	if (clipId) pet.playOnce(clipId, () => pet.enterIdle());
}

async function refreshBalance(force = false, { feedback = false, pet } = {}) {
	if (state.stopped) return;
	const fingerprint = JSON.stringify(state.config?.balance?.custom ?? {});
	if (!state.refreshPending && (force || Date.now() - state.lastRefreshAt >= 15_000)) {
		state.lastRefreshAt = Date.now();
		state.refreshPending = SDK.callSafe("pet-balance-refresh", { force: force === true }).then((result) => {
			if (state.stopped) return result;
			if (fingerprint !== JSON.stringify(state.config?.balance?.custom ?? {})) return result;
			if (!result.ok) {
				record("balance", "余额查询", "fail", result.error.message);
				state.balance = { ...(state.balance ?? {}), ok: false, stale: Boolean(state.balance?.ok || state.balance?.stale), error: { message: result.error.message } };
				state.balanceApiStatus = state.balance.stale ? "stale" : "unavailable";
			} else {
				state.balance = result.value?.snapshot ?? (result.value?.skipped === "not_configured" ? null : state.balance);
				state.ledger = result.value?.ledger ?? state.ledger;
				state.activeAccountIds = Array.isArray(result.value?.activeAccountIds) ? result.value.activeAccountIds.filter((id) => typeof id === "string") : [];
				state.balanceApiStatus = result.value?.skipped === "not_configured" ? "not-configured"
					: state.balance?.ok ? "ready" : state.balance?.stale ? "stale" : "unavailable";
				record("balance", "余额查询", state.balance?.ok ? "ok" : "warn", "第三方余额 API 查询完成");
			}
			maybePlayBalance();
			return result;
		}).finally(() => { state.refreshPending = undefined; });
	}
	const result = await state.refreshPending;
	if (feedback && !state.stopped) {
		const target = pet ?? stage.pets.find((item) => !item.isUserBusy) ?? stage.pets[0];
		const controller = ensureBubble(target);
		if (controller?.scene !== "random") controller?.home();
		else queueNotice({ id: "balance-refresh-result", text: state.balance?.ok ? "余额已刷新。" : `余额刷新失败：${state.balance?.error?.message ?? "未知错误"}`, priority: 30, expiresAt: Date.now() + 30_000 });
	}
	return result;
}

/* -------------------------------------------------------------------------- */
/* Background image (optional)                                               */
/* -------------------------------------------------------------------------- */

function applyBackground() {
	// The stage is deliberately transparent by default: it sits in a Dockview panel
	// above the app's own background, and painting an opaque rectangle inside a
	// panel looks like a broken theme. A user who wants a scene supplies one later.
	stage.layers.background.style.backgroundImage = "none";
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                      */
/* -------------------------------------------------------------------------- */

function wireGlobalErrorHandlers() {
	window.addEventListener("error", (event) => {
		record("js-error", "脚本异常", "fail", event.message);
	});
	window.addEventListener("unhandledrejection", (event) => {
		record("js-error", "未捕获的 Promise", "fail", String(event.reason?.message ?? event.reason));
	});
	// A CSP violation inside the iframe is otherwise silent until something looks
	// wrong, and the usual cause is this plugin asking for something the shell's
	// policy forbids — worth naming explicitly.
	document.addEventListener("securitypolicyviolation", (event) => {
		record(
			"csp",
			"CSP 违规",
			"fail",
			`${event.violatedDirective} blocked ${String(event.blockedURI).slice(0, 120)}`,
		);
	});
}

function startVisibilityGating() {
	const sync = () => {
		const hidden = document.hidden;
		state.paused = hidden || !state.intersecting;
		for (const pet of stage.pets) pet.bubbleController?.setVisible(!state.paused);
		state.taskEvents?.setVisible(!state.paused);
		if (state.paused) {
			state.localNotices = state.localNotices.filter((notice) => notice.priority >= 70 && notice.expiresAt > Date.now());
			cancelPointers(); stopLoop();
		} else { startLoop(); deliverLocalNotices(); }
	};
	state.intersecting = true;
	document.addEventListener("visibilitychange", sync);
	// Dockview keeps an inactive tab's DOM mounted, so `document.hidden` stays
	// false while the panel is invisible. An IntersectionObserver is the only
	// reliable signal that this panel is actually on screen — and it is what makes
	// the "hidden panel uses no CPU" claim true rather than aspirational.
	if ("IntersectionObserver" in globalThis) {
		const observer = new IntersectionObserver((entries) => {
			state.intersecting = entries.some((entry) => entry.isIntersecting);
			sync();
		});
		observer.observe(stage.root);
	}
}

async function probeAssets() {
	const first = CLIP_BY_ID.get(IDLE_CLIP) ?? INDEX.clips[0];
	if (!first) { record("clip-bytes", "动画数据通道", "fail", "索引为空"); return; }
	const started = performance.now();
	let url, timeout;
	const image = new Image();
	try {
		url = await clipUrl(first.index);
		image.src = url;
		await Promise.race([image.decode(), new Promise((_, reject) => {
			timeout = setTimeout(() => reject(new Error("decode timeout")), 8000);
		})]);
		record("clip-bytes", "动画数据通道", image.naturalWidth > 0 ? "ok" : "fail",
			`${first.id} ${image.naturalWidth}×${image.naturalHeight} ${Math.round(performance.now() - started)}ms`);
	} catch (error) { record("clip-bytes", "动画数据通道", "fail", String(error?.message ?? error)); }
	finally { clearTimeout(timeout); image.removeAttribute("src"); if (url) URL.revokeObjectURL(url); }
}

async function boot() {
	buildDom();
	state.hud = false;
	wireGlobalErrorHandlers();
	startVisibilityGating();

	// Right-clicking the empty part of the panel should reach the same menu as
	// right-clicking a pet; without this the browser's own context menu appears
	// inside the panel and there is no way back to the settings entry.
	document.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		openMenu(event.clientX, event.clientY, stage.pets[0]);
	});

	// Observing the stage element rather than the document catches the case that
	// actually happens: a Dockview panel is resized or re-docked while the window
	// itself never changes size.
	new ResizeObserver(() => {
		if (state.config) layout();
	}).observe(stage.root);

	const env = SDK.environment();
	record("bridge", "UI bridge", env.hasBridge ? "ok" : "fail", env.hasBridge ? "narrafork.* 可用" : "globalThis.narrafork 缺失");
	const surfaceKind = await detectSurface();
	installPointerEvents();
	record(
		"surface",
		"承载界面",
		surfaceKind ? "ok" : "warn",
		state.surface === "overlay"
			? `overlay（${state.overlayApi ? "可交互：命中区域已上报" : "宿主不支持 overlay.setBounds，仅显示"}）`
			: `${surfaceKind ?? "未知"}（面板模式，DOM 指针事件）`,
	);
	record(
		"asset-root",
		"资源根路径",
		env.assetRoot ? "ok" : "fail",
		env.assetRoot ? env.assetRoot.replace(/^https?:\/\/[^/]+/, "") : "document.currentScript 不可用",
	);
	record("index", "动画索引", INDEX.clips.length > 0 ? "ok" : "fail", `${INDEX.clips.length} 段 / ${INDEX.profile}`);

	// Lay out before any network call: the stage geometry should not depend on
	// whether the backend answers, so a dead backend still shows a pet.
	layout();

	// Whether `stage.css` actually took effect.
	//
	// NOT by checking `position: relative` on the stage: that is now also set
	// inline, so it would pass with no stylesheet at all — a self-check that
	// cannot fail is worse than none. `body { overflow: hidden }` comes from the
	// stylesheet alone, so it is the honest probe.
	let sheetCount;
	try {
		sheetCount = document.styleSheets.length;
	} catch {
		sheetCount = -1;
	}
	const bodyOverflow = getComputedStyle(document.body).overflow;
	record(
		"style",
		"样式表",
		bodyOverflow === "hidden" ? "ok" : "warn",
		`${sheetCount} 个样式表，body overflow=${bodyOverflow}${bodyOverflow === "hidden" ? "" : "（stage.css 可能没加载，外观会不正确）"}`,
	);

	await probeAssets();
	const value = await fetchState();
	void startTaskEvents().catch((error) => {
		state.taskState = { capability: "degraded", error: { message: String(error?.message ?? error) } };
	});
	record("ready", "舞台就绪", value ? "ok" : "warn", value ? `v${value.version ?? "?"}` : "后端未响应");

	state.ready = true;
	const failures = diagnostics.filter((entry) => entry.status === "fail");
	// Push the whole self-check to the backend once, regardless of outcome. The
	// panel is an opaque-origin iframe the user cannot inspect, so without this the
	// only record of "what the panel saw" is the panel's own pixels.
	void SDK.callSafe("pet-log", {
		level: failures.length > 0 ? "error" : "info",
		message: "stage boot",
		detail: {
			version: value?.version,
			diagnostics: diagnostics.map((entry) => ({
				id: entry.id,
				status: entry.status,
				detail: entry.detail ?? null,
			})),
			env: SDK.environment(),
			stage: { width: stage.width, height: stage.height, pets: stage.pets.length },
			// The measured result, not the intent: an overlay that reports white here is
			// the white screen, and this line says so without needing devtools.
			backdrop: {
				html: getComputedStyle(document.documentElement).backgroundColor,
				body: getComputedStyle(document.body).backgroundColor,
				colorScheme: getComputedStyle(document.documentElement).colorScheme,
				splashPresent: Boolean(document.getElementById("plugin-shell-splash")),
				bodyChildren: document.body.children.length,
			},
		},
	});
	if (failures.length > 0) toggleHud(true);
	// A `warn` is not cosmetic either: the stylesheet row warns when `stage.css` did
	// not take effect, which on the overlay surface means an opaque canvas over the
	// whole app. Opening the HUD on any non-ok row makes that visible instead of
	// leaving the user with a blank page and no explanation.
	else if (diagnostics.some((entry) => entry.status === "warn")) toggleHud(true);
	else if (state.config?.diagnostics) toggleHud(true);

	startLoop();
	installVisibilityWatchdog();
	if (state.surface === "overlay") {
		installOverlayRelay();
		// Publish once immediately: until the host knows the rectangle, the overlay is
		// purely decorative, and there is no reason to wait for the first frame.
		publishOverlayBounds(true);
	}
	// Slow poll: config changes made in the settings panel should reach the stage
	// without a reload. Balance has its own, much slower, staleness check inside
	// `pet-state`, so this interval is about settings, not about the network.
	state.stateInterval = setInterval(() => {
		if (state.paused) return;
		void fetchState();
	}, 12_000);
	state.noticeInterval = setInterval(() => {
		deliverLocalNotices();
		void pollPersistedNotice();
	}, 1000);
	window.addEventListener("pagehide", () => {
		state.stopped = true;
		clearInterval(state.stateInterval); clearInterval(state.noticeInterval);
		state.taskEvents?.destroy();
		state.localNotices = [];
		cancelPointers(); stopLoop(); closeMenu();
		for (const pet of stage.pets) pet.dispose();
	}, { once: true });

	globalThis.__dshPetDiagnostics = () => diagnostics.slice();
	globalThis.__dshPetStage = stage;
	// Deliberately callable: the fault report is the one part of the stage that has
	// to work when everything else is broken, so it must be possible to raise it
	// without breaking something first.
	globalThis.__dshPetFault = (reason) => showFaultReport(reason ?? "手动触发");
}

// A resize must re-run layout, and `ResizeObserver` also catches the first paint
// (where a `window.resize` listener would miss a panel that opened at a size it
// never changes from).
boot().catch((error) => {
	record("boot", "启动", "fail", String(error?.message ?? error));
	SDK.report("error", "stage boot failed", { message: String(error?.message ?? error) });
	// Even a failed boot must paint something: a blank iframe is indistinguishable
	// from a plugin that never loaded.
	if (!stage.root) buildDom();
	toggleHud(true);
});

/* -------------------------------------------------------------------------- */
/* Inlined build artefacts (replaced by tools/build-ui.mjs)                  */
/* -------------------------------------------------------------------------- */

// PET_ANIM_INDEX (including bounds) and PET_CLICK_SOUND_BASE64 are injected by
// the build; they are declared here as comments only so the dependency is greppable
// from the stage's own source.
