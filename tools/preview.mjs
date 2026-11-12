/**
 * Dev-only preview host: run the real UI bundle in a real browser.
 *
 * WHY THIS EXISTS
 * The plugin's two halves fail in completely different ways. The backend can be
 * driven over stdio from Node (`selftest-server.mjs`). The stage cannot: it needs
 * a DOM, a layout engine, an image decoder and `requestAnimationFrame`. Its
 * interesting bugs — an animated WebP that will not decode, alpha lost in
 * transcoding, a transform that puts the pet outside the panel — are only
 * observable in a browser.
 *
 * So this serves the package directory over HTTP with a faithful stub of
 * `globalThis.narrafork` and loads `ui/stage.iife.js` exactly as the shell would:
 * one classic `<script src>`, no bundler, no module loader.
 *
 * WHAT THIS HARNESS DELIBERATELY DOES NOT SIMULATE
 * The host's CSP, the asset-token URL, the sandbox/opaque origin, permission
 * prompts and the shell's own runtime. Those are the host's job and are covered by
 * the in-panel self-check. Nothing here should ever be read as "the plugin passes
 * the host's CSP": the page states that explicitly and installs no CSP of its own.
 * `window.__previewFidelity` records the same thing for automated checks.
 *
 * NEW: CONTROL INTERFACE (window.__preview)
 * Query parameters configure the first state, and `window.__preview` reconfigures
 * it at runtime so a regression can be reproduced without reloading:
 *
 *   ?surface=overlay        mount the stage on the overlay surface (relay + setBounds)
 *   ?count=1..6             pet count
 *   ?idleMinMs= &idleMaxMs= wait range (clamped like the backend: >= 800)
 *   ?roam=0|1               disable/enable wandering
 *   ?groups=idle,click      enable ONLY these animation groups
 *   ?off=small,play         disable these animation groups
 *   ?roam=0|1               disable/enable wandering (listed above for grouping)
 *   ?clipDelayMs=1500       delay every `pet-clip` response (async-load regression)
 *   ?diagnostics=1          open the stage HUD
 *   ?nocss=1                omit stage.bundle.css (stylesheet-missing regression)
 *   ?clean=1                hide debug overlays, keep the pure-example label
 *   ?narratorId=known-id     explicit mocked context narrator (empty = unbound)
 *
 *   await __preview.configure({ count: 6, idleMinMs: 1000, idleMaxMs: 1000 })
 *   __preview.relay({ type: "down", x: 120, y: 80 })
 *   __preview.bounds()        // last rectangle published via overlay.setBounds
 *   __preview.pets()          // per-pet hit/body rectangles (when the stage exposes them)
 *   __preview.hitTest(x, y)   // "pet" | "dead" | "background" without clicking
 *   __preview.clicks()        // what the background/hit detector saw
 *   await __preview.balance(snapshot) // replace the pure-example command response
 *   await __preview.sample("money" | "points" | "windows" | "stale" | "error")
 *   __preview.events.push(envelope)   // full pinned PublicEvent, scoped local queue
 *   __preview.events.sample("permission" | "resolved" | "done" | "error" | "working")
 *   __preview.events.mode("PERMISSION_DENIED") // simulated response, no authorization
 *   __preview.clock.advance(6000)     // wall-clock/lease tick; browser timers stay real
 *
 * `configure` does NOT poke a Pet's fields. It calls the same `pet-config-set`
 * command the settings panel calls and then triggers the stage's own 12 s state
 * poll, so the new config arrives through `pet-state` exactly as it would live.
 * That is the difference between a test that proves the config path and one that
 * proves a test-only shortcut.
 *
 * Pass `--headless-check` to drive it without the interactive browser tool: the
 * harness opens the page with Chrome's remote debugging endpoint and prints the
 * collected console output.
 *
 * USAGE
 *   node tools/preview.mjs [--port=7311] [--keep]
 */

import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { PLUGIN_DIR, posix } from "./paths.mjs";

const argv = process.argv.slice(2);
const port = Number(argv.find((item) => item.startsWith("--port="))?.split("=")[1] ?? 7311);
const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webp": "image/webp",
	".gif": "image/gif",
	".png": "image/png",
	".wav": "audio/wav",
	".mp3": "audio/mpeg",
	".md": "text/markdown; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
};

const ANIMATION_GROUPS = ["idle", "turn", "drag", "click", "move", "small", "play", "eat", "season", "text"];

/** Mirrors `server/config.js` defaults; the preview must start from a real state. */
const DEFAULT_CONFIG = {
	version: 2,
	count: 1,
	scale: 1,
	gravity: 1,
	bounce: 0.55,
	friction: 0.9,
	collisions: true,
	clickSquash: 0.35,
	roam: true,
	animationGroups: Object.fromEntries(ANIMATION_GROUPS.map((group) => [group, true])),
	idleMinMs: 4000,
	idleMaxMs: 9000,
	balance: {
		refreshMinutes: 30,
		thresholds: [20, 40, 60, 80, 100],
		custom: { url: "https://api.example.invalid/balance", totalPath: "data.remaining", usedPath: "data.used", currency: "CNY" },
	},
	sound: { enabled: true, volume: 0.6 },
	bubbles: { enabled: true, scale: 1, durationMs: 5000, noticeDurationMs: 8000, clickMode: "advance", autoChat: true, overrides: [] },
	tasks: { enabled: true },
	diagnostics: false,
};

const number = (value, fallback, min, max) => {
	// Number(null) and Number("") are 0, which would silently clamp a missing query
	// parameter to the minimum instead of leaving the backend default in place.
	if (value === null || value === undefined || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(parsed, min), max);
};

/** Build the first config from the query string, with the backend's own clamps. */
function configFromQuery(params) {
	const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
	config.count = Math.round(number(params.get("count"), config.count, 1, 6));
	config.idleMinMs = Math.round(number(params.get("idleMinMs"), config.idleMinMs, 800, 120_000));
	config.idleMaxMs = Math.round(number(params.get("idleMaxMs"), config.idleMaxMs, config.idleMinMs, 120_000));
	if (params.has("roam")) config.roam = params.get("roam") !== "0" && params.get("roam") !== "false";
	if (params.has("scale")) config.scale = number(params.get("scale"), config.scale, 0.35, 3);
	if (params.has("diagnostics")) config.diagnostics = params.get("diagnostics") === "1";
	if (params.has("collisions")) config.collisions = params.get("collisions") !== "0";
	const only = params.get("groups");
	if (only) {
		const wanted = new Set(only.split(",").map((item) => item.trim()).filter(Boolean));
		for (const group of ANIMATION_GROUPS) config.animationGroups[group] = wanted.has(group);
	}
	const off = params.get("off");
	if (off) for (const group of off.split(",").map((item) => item.trim())) {
		if (ANIMATION_GROUPS.includes(group)) config.animationGroups[group] = false;
	}
	return config;
}

const previewSettings = (params) => {
	const narratorId = (params.get("narratorId") ?? "preview-narrator").trim().slice(0, 128);
	const config = configFromQuery(params);
	return {
		surface: params.get("surface") === "overlay" ? "overlay" : "workspace",
		config,
		clipDelayMs: Math.round(number(params.get("clipDelayMs"), 0, 0, 30_000)),
		nocss: params.get("nocss") === "1",
		clean: params.get("clean") === "1",
		narratorId,
	};
};

/**
 * The page shell.
 *
 * The stub mimics the shape the real shell installs, including the essential
 * detail that easy to get wrong: `commands.execute` resolves `{ output }`, and the
 * asset base comes from the script's own URL rather than anything injected.
 *
 * NOTE ON THE HARNESS ELEMENTS: the stage takes over `document.body` wholesale
 * (`replaceChildren`), exactly as the real shell expects — the shell's own splash
 * is inside that body. So the harness must re-attach its own overlays after the
 * bundle has run instead of assuming they survive. Getting this wrong once already
 * produced a "Cannot set properties of null" that looked like a plugin bug.
 */
const previewPage = (options = {}) => `<!doctype html>
<html data-mantine-color-scheme="dark">
<head>
<meta charset="utf-8">
<title>DSH Pet — stage preview</title>
<!--
  The real shell injects the view's stylesheet as a link element before the entry
  script. This harness must do the same, or it verifies a document the host never
  produces: without it every measurement below is taken against an unstyled page.
  ?nocss=1 deliberately omits it, which is how the "stylesheet missing" self-check
  row gets exercised.

  Deliberately NO Content-Security-Policy meta tag: installing one here would make
  this page look like a CSP test while enforcing rules the host does not enforce.
-->
${options.nocss ? "" : '<link rel="stylesheet" href="/ui/stage.bundle.css">'}
<style>
  html, body { margin: 0; height: 100%; background: #14151a; }
  /* A magenta/green checker is the only reliable way to see whether a transparent
     animation really kept its alpha: a single flat colour cannot distinguish
     "transparent" from "painted the same colour as the background". */
  #harness { position: fixed; inset: 0; z-index: 0;
    background-image:
      linear-gradient(45deg, #ff00ff 25%, transparent 25%, transparent 75%, #ff00ff 75%),
      linear-gradient(45deg, #ff00ff 25%, #00ff88 25%, #00ff88 75%, #ff00ff 75%);
    background-size: 32px 32px;
    background-position: 0 0, 16px 16px; }
  #probe { position: fixed; left: 8px; bottom: 8px; z-index: 99; color: #fff;
    font: 11px ui-monospace, monospace; background: rgba(0,0,0,.78); padding: 6px 8px;
    border-radius: 6px; max-width: 70vw; white-space: pre-wrap; max-height: 45vh; overflow: auto;
    /* The probe must never become the click target: it sits over exactly the area where
       a pet stands, and swallowing a pointerdown there would fake a compact-hit failure. */
    pointer-events: none; }
  /* The overlay surface's real host captures pointer input in its own transparent
     layer, not in the iframe. This rectangle stands in for it: it is only as large
     as the last setBounds() rectangle, so a click outside it reaches the checker
     background — which is what the compact-hit test measures. */
  #overlay-capture { position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 50;
    background: transparent; touch-action: none; pointer-events: none; }
  #overlay-capture.on { pointer-events: auto; }
  #preview-example-label { position:fixed; left:8px; top:8px; z-index:1000; pointer-events:none;
    padding:3px 7px; border-radius:5px; font:11px system-ui; color:#fff; background:#584224; }
  ${options.settings?.clean ? '#toolbar, #probe, .pet-hud { display:none !important; }' : ''}
</style>
</head>
<body>
<div id="harness"></div>
<div id="probe">booting…</div>
<script>
(() => {
  "use strict";
  // The query-derived first state. Everything below mutates copies, never this object.
  const settings = ${JSON.stringify(options.settings).replaceAll("<", "\\u003c")};
  const lines = [];
  window.__previewLog = lines;
  window.__previewFidelity = {
    csp: false,
    assetToken: false,
    sandbox: false,
    hostAudio: false,
    realPermissions: false,
    examplesOnly: true,
    note: "纯离线示例：余额/任务事件均为注入数据，不代表真实授权；不模拟宿主 CSP / asset token / sandbox / 浮层音频能力",
  };
  // Resilient on purpose: the stage replaces body's children, so the probe element
  // can be gone between two log lines.
  const record = (text) => {
    lines.push(text);
    if (lines.length > 600) lines.splice(0, lines.length - 600);
    const probe = document.getElementById("probe");
    if (probe) probe.textContent = lines.join("\\n");
  };

  /* ---------------------------------------------------------------------- */
  /* Config: a private store plus the same merge/clamp rules as the backend  */
  /* ---------------------------------------------------------------------- */

  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

  const isPlainObject = (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  };

  /** Deep merge; arrays and scalars replace. Matches mergeConfig in server/config.js. */
  const mergeConfig = (base, patch) => {
    if (!isPlainObject(patch)) return clone(base);
    const out = clone(base) ?? {};
    for (const [key, value] of Object.entries(patch)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
      if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeConfig(out[key], value);
      else if (value !== undefined && value !== null) out[key] = clone(value);
    }
    return out;
  };

  const clampInteger = (value, fallback, min, max) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.round(Math.min(Math.max(parsed, min), max));
  };

  /** The validation that matters to the stage; the real backend still owns the rest. */
  const normalizeConfig = (source) => {
    const config = mergeConfig(${JSON.stringify(DEFAULT_CONFIG)}, source);
    config.count = clampInteger(config.count, 1, 1, 6);
    config.idleMinMs = clampInteger(config.idleMinMs, 4000, 800, 120_000);
    config.idleMaxMs = clampInteger(config.idleMaxMs, config.idleMinMs, config.idleMinMs, 120_000);
    config.roam = config.roam !== false;
    config.collisions = config.collisions !== false;
    config.diagnostics = config.diagnostics === true;
    const groups = isPlainObject(source && source.animationGroups) ? source.animationGroups : {};
    config.animationGroups = {};
    for (const group of ${JSON.stringify(ANIMATION_GROUPS)}) {
      config.animationGroups[group] = groups[group] === undefined ? true : Boolean(groups[group]);
    }
    if (!Object.values(config.animationGroups).some(Boolean)) config.animationGroups.idle = true;
    return config;
  };

  let config = normalizeConfig(settings.config);
  let clipDelayMs = settings.clipDelayMs;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Every command response is copied, exactly as the host's JSON-RPC round trip
   * copies it. Handing the same object to the config writer and to the stage was a
   * harness bug: a later count change then looked applied even when the stage had
   * never re-fetched it (the two ends shared one reference).
   */
  const handle = async (commandId, input) => {
    record("→ " + commandId + (commandId === "pet-clip" && input ? " " + input.index + "@" + input.offset : ""));
    switch (commandId) {
      case "pet-clip": {
        // Mirrors the backend: read the clip, return one 512 KiB base64 chunk.
        if (clipDelayMs > 0) await sleep(clipDelayMs);
        const index = Number(input && input.index) || 0;
        const offset = Number(input && input.offset) || 0;
        const chunk = 512 * 1024;
        const response = await fetch("/anim/webp/" + String(index).padStart(3, "0") + ".webp");
        if (!response.ok) throw new Error("clip " + index + " HTTP " + response.status);
        const buffer = new Uint8Array(await response.arrayBuffer());
        const slice = buffer.subarray(offset, Math.min(buffer.length, offset + chunk));
        let binary = "";
        for (let i = 0; i < slice.length; i += 1) binary += String.fromCharCode(slice[i]);
        return { index, offset, total: buffer.length, data: btoa(binary), done: offset + slice.length >= buffer.length };
      }
      case "pet-state": return { version: "preview-example", config: clone(config), configWarnings: [], configStored: true, balance: clone(snapshot), ledger: clone(ledger), activeAccountIds: snapshot?.accounts?.map((entry) => entry.accountId) ?? [] };
      case "pet-config-get": return { config: clone(config), warnings: [], stored: true };
      case "pet-config-set":
        config = normalizeConfig(mergeConfig(config, input && input.patch ? input.patch : {}));
        return { config: clone(config), warnings: [] };
      case "pet-balance-refresh":
        if (balanceFailure) throw Object.assign(new Error(balanceFailure.message), { code: balanceFailure.code });
        return { snapshot: clone(snapshot), ledger: clone(ledger), activeAccountIds: snapshot?.accounts?.map((entry) => entry.accountId) ?? [], cached: false };
      case "pet-ledger-get": return { ledger: clone(ledger), examplesOnly: true };
      case "pet-notice-claim": return { notice: null, examplesOnly: true };
      case "pet-notice-ack": return { acknowledged: true, examplesOnly: true };
      case "pet-secrets-list": return { keys: [{ key: "customApiKey", configured: true, known: true }] };
      case "pet-log": record("  log[" + (input && input.level) + "] " + (input && input.message)); return { ok: true };
      default: throw Object.assign(new Error("unknown command " + commandId), { code: "INVALID_PARAMS" });
    }
  };

  const storage = new Map();
  const secrets = new Map();
  /**
   * Verbatim copy of the shell bridge's validator. Not simplified on purpose: the
   * rule this harness exists to enforce is the one a simplification would erase —
   * a key whose value is \`undefined\` is invalid, and so is a non-finite number or
   * a class instance.
   */
  const validJson = (value, depth = 0, seen = new Set()) => {
    if (depth > 32 || value === undefined || typeof value === "function") return false;
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.every((item) => validJson(item, depth + 1, seen));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    return Object.entries(value).every(([key, item]) =>
      !["__proto__", "prototype", "constructor"].includes(key) && validJson(item, depth + 1, seen));
  };
  const samples = {
    money: { ok: true, shape: "money", currency: "CNY", percent: 63, tier: 3,
      accounts: [{ accountId: "custom-api:CNY", currency: "CNY", shape: "money", remaining: "7.40", granted: "1.40", toppedUp: "6.00", used: "12.60", total: "20.00", percent: 63 }], fetchedAt: new Date().toISOString() },
    points: { ok: true, shape: "points", currency: "POINTS",
      accounts: [{ accountId: "custom-api:POINTS", currency: "POINTS", remaining: "1250", shape: "points" }], fetchedAt: new Date().toISOString() },
    windows: { ok: true, shape: "windows", currency: "USD",
      accounts: [{ accountId: "custom-api:weekly", window: "weekly", currency: "USD", remaining: "40.00", used: "10.00", total: "50.00", percent: 20, resetsAt: "示例下周重置" }], fetchedAt: new Date().toISOString() },
    error: { ok: false, shape: "points", currency: "POINTS", error: { kind: "network", message: "示例 API 查询失败，不涉及真实服务" }, fetchedAt: new Date().toISOString() },
  };
  samples.stale = { ...clone(samples.money), ok: false, stale: true, error: { code: "EXAMPLE_STALE", message: "示例旧数据，请勿作为真实余额" } };
  let snapshot = clone(samples.money), ledger = { accounts: [] }, balanceFailure = null;

  // Pinned public protocol, implemented locally. No host query, network, or
  // permission approval is performed. A denied mode only demonstrates UI fallback.
  const eventSubscriptions = new Map();
  let nextSubscription = 0, nextEvent = 0, eventFailure = null;
  const demoId = () => settings.narratorId || "preview-narrator";
  const eventError = (code, message = code) => Object.assign(new Error(message), { code });
  const makeEvent = (topic, data, extra = {}) => ({ schema: "narrafork.public-event", schemaVersion: 1,
    eventId: "example-event-" + (++nextEvent), occurredAt: new Date().toISOString(),
    topic, eventClass: topic.endsWith("lifecycle") ? "lifecycle" : topic.includes("tool") ? "state" : "attention",
    redaction: "user_scoped", ...(data.narratorId ? { resource: { type: "narrator", id: data.narratorId, narratorId: data.narratorId } } : {}), data, ...extra });
  const pushEvent = (envelope) => {
    if (!validJson(envelope) || envelope.schema !== "narrafork.public-event" || envelope.schemaVersion !== 1) throw eventError("INVALID_PARAMS", "请传完整的示例PublicEvent envelope");
    let delivered = 0;
    for (const [subscriptionId, entry] of eventSubscriptions) {
      const control = ["narrafork.events.overflow", "narrafork.events.resync_required"].includes(envelope.topic) && envelope.data.subscriptionId === subscriptionId;
      const match = entry.input.topics.includes(envelope.topic) && envelope.data.narratorId === entry.input.scope.narratorId && entry.input.filter.narratorIds.includes(envelope.data.narratorId);
      if (!control && !match) continue;
      entry.sequence = Math.max(entry.sequence + 1, envelope.deliverySeq ?? 0);
      entry.queue.push({ ...clone(envelope), deliverySeq: envelope.deliverySeq ?? entry.sequence }); delivered += 1;
      if (entry.queue.length > 200) entry.queue = [{ ...makeEvent("narrafork.events.overflow", { subscriptionId }, { eventClass: "audit", redaction: "public" }), deliverySeq: ++entry.sequence }];
    }
    record("示例事件入队 " + envelope.topic + " ×" + delivered);
    return { examplesOnly: true, delivered };
  };
  const eventBridge = Object.freeze({
    subscribe: async (input) => {
      if (eventFailure) throw eventError(eventFailure);
      if (!validJson(input) || !input.scope?.narratorId || input.filter?.narratorIds?.length !== 1 || input.filter.narratorIds[0] !== input.scope.narratorId || !Array.isArray(input.topics)) throw eventError("INVALID_PARAMS");
      const subscriptionId = "example-sub-" + (++nextSubscription);
      eventSubscriptions.set(subscriptionId, { input: clone(input), queue: [], sequence: 0 });
      return { subscriptionId, mode: "live", delivery: { maxFrameBytes: 65536, queueEvents: 200, queueBytes: 131072, maxRatePerSecond: 50 } };
    },
    poll: async (input) => {
      if (eventFailure) throw eventError(eventFailure);
      if (!validJson(input) || !Number.isInteger(input.limit ?? 100) || (input.limit ?? 100) < 1 || (input.limit ?? 100) > 100) throw eventError("INVALID_PARAMS");
      const entry = eventSubscriptions.get(input.subscriptionId);
      if (!entry) throw eventError("NOT_FOUND");
      return clone(entry.queue.splice(0, input.limit ?? 100));
    },
    unsubscribe: async (input) => {
      if (!validJson(input) || typeof input.subscriptionId !== "string") throw eventError("INVALID_PARAMS");
      return { unsubscribed: eventSubscriptions.delete(input.subscriptionId) };
    },
  });

  /* ---------------------------------------------------------------------- */
  /* Host -> plugin notifications (overlay pointer relay)                    */
  /* ---------------------------------------------------------------------- */

  const listeners = new Set();
  const notify = (message) => {
    for (const listener of [...listeners]) {
      try { listener(message); } catch (error) { record("✕ notification listener: " + (error && error.message)); }
    }
  };

  let publishedBounds = null;
  let boundsCalls = 0;
  const onBounds = (rect) => {
    if (!rect) return;
    publishedBounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    boundsCalls += 1;
    const capture = document.getElementById("overlay-capture");
    if (capture) {
      capture.style.left = publishedBounds.x + "px";
      capture.style.top = publishedBounds.y + "px";
      capture.style.width = publishedBounds.width + "px";
      capture.style.height = publishedBounds.height + "px";
      capture.classList.add("on");
    }
    if (boundsCalls <= 3 || boundsCalls % 50 === 0) {
      record("bounds " + [rect.x, rect.y, rect.width, rect.height].join(","));
    }
    return { bounds: publishedBounds, viewport: { width: window.innerWidth, height: window.innerHeight } };
  };

  globalThis.narrafork = Object.freeze({
    // The real bridge validates every request's params with its own validator
    // before posting it (asset-shell.ts), and that check rejects a *present*
    // undefined value. Reproducing it here is the whole point of this harness:
    // an earlier version of this stub did not, and the settings panel shipped a
    // commands.execute(id) with no argument whose { commandId, input: undefined }
    // params were rejected by the host with "Plugin UI params must be JSON".
    commands: Object.freeze({
      execute: async (commandId, input) => {
        if (!validJson({ commandId, input })) throw new Error("Plugin UI params must be JSON");
        // Copy on the way out: the host serialises, so the caller must never share
        // an object with the store above.
        return { output: clone(await handle(commandId, input)) };
      },
    }),
    storage: Object.freeze({
      get: async ({ key }) => (storage.has(key) ? { key, value: clone(storage.get(key)), revision: 1 } : null),
      set: async ({ key, value }) => { storage.set(key, clone(value)); return { key, revision: 1, stored: true }; },
      delete: async ({ key }) => { storage.delete(key); return { key, deleted: true }; },
      list: async () => ({ entries: [...storage.entries()].map(([key, value]) => ({ key, value: clone(value) })) }),
    }),
    config: Object.freeze({ get: async () => ({}) }),
    secrets: Object.freeze({
      get: async (key) => ({ key, value: secrets.get(key) ?? null }),
      set: async (key, value) => { secrets.set(key, value); return { key, stored: true }; },
      delete: async (key) => { secrets.delete(key); return { key, deleted: true }; },
      list: async () => ({ secrets: [...secrets.keys()].map((key) => ({ key, configured: true })) }),
    }),
    panel: Object.freeze({ open: async (input) => { record("panel.open " + JSON.stringify(input)); return { accepted: true }; } }),
    notifications: Object.freeze({ show: async (input) => { record("notify: " + input.message); return { ok: true }; } }),
    ui: Object.freeze({ openExternal: async () => ({ ok: true }) }),
    events: eventBridge,
    i18n: Object.freeze({ locale: "zh-CN", t: (tables, key) => key, onChange: () => () => {} }),
    /**
     * The host's notification channel. SDK.onNotification calls this and keeps the
     * returned function as the unsubscribe handle, so it must return one.
     */
    onNotification: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /**
     * The overlay surface's only interaction API on the branch this plugin targets:
     * setBounds(rect). It is absent on the dock surface, exactly like an older
     * host, which keeps the stage's feature-detection path honest.
     */
    ...(settings.surface === "overlay"
      ? { overlay: Object.freeze({ setBounds: async (rect) => onBounds(rect) }) }
      : {}),
    getContext: async () => ({
      contextVersion: 1,
      host: { appVersion: "preview", locale: "zh-CN", colorScheme: "dark", platform: "windows" },
      plugin: { id: "cn.mcd7.neglectdream.dsh-pet", version: "preview", contributionId: "pet-stage", panelInstanceId: "preview" },
      // The real host reports the surface this view was mounted on; the stage uses it
      // to choose between DOM pointer events and the overlay relay.
      surface: { kind: settings.surface, active: true, visible: true },
      ...(settings.narratorId ? { narrator: { id: settings.narratorId } } : {}),
    }),
  });

  window.addEventListener("error", (event) => record("✕ script error: " + event.message));
  window.addEventListener("unhandledrejection", (event) => record("✕ rejection: " + (event.reason && event.reason.message)));

  /* ---------------------------------------------------------------------- */
  /* Background / dead-zone click detector                                   */
  /* ---------------------------------------------------------------------- */

  const clicks = [];
  const stageRoot = () => document.querySelector(".pet-stage");
  const stageOrigin = () => {
    const root = stageRoot();
    const rect = root ? root.getBoundingClientRect() : { left: 0, top: 0 };
    return { left: rect.left, top: rect.top };
  };
  const pets = () => {
    const stage = window.__dshPetStage || (window.__dshPet && window.__dshPet.stage);
    return stage && Array.isArray(stage.pets) ? stage.pets : [];
  };

  /** A pet rectangle in client coordinates, using the real API when it exists. */
  const petRect = (pet, kind) => {
    if (pet && typeof pet.bounds === "function") {
      const rect = pet.bounds(kind);
      if (rect) {
        const origin = stageOrigin();
        return {
          x: rect.left !== undefined ? rect.left + origin.left : rect.x + origin.left,
          y: rect.top !== undefined ? rect.top + origin.top : rect.y + origin.top,
          width: rect.right !== undefined ? rect.right - rect.left : rect.width,
          height: rect.bottom !== undefined ? rect.bottom - rect.top : rect.height,
        };
      }
    }
    const origin = stageOrigin();
    if (pet && typeof pet.w === "number" && typeof pet.h === "number") {
      return { x: origin.left + pet.x - pet.w / 2, y: origin.top + pet.y - pet.h / 2, width: pet.w, height: pet.h };
    }
    return null;
  };

  const hitTest = (clientX, clientY) => {
    const inside = publishedBounds
      ? clientX >= publishedBounds.x && clientX <= publishedBounds.x + publishedBounds.width &&
        clientY >= publishedBounds.y && clientY <= publishedBounds.y + publishedBounds.height
      : false;
    let petIndex = -1;
    pets().forEach((pet, index) => {
      if (petIndex >= 0) return;
      const rect = petRect(pet, "hit");
      if (!rect) return;
      if (clientX >= rect.x && clientX <= rect.x + rect.width && clientY >= rect.y && clientY <= rect.y + rect.height) {
        petIndex = index;
      }
    });
    const capture = document.elementFromPoint(clientX, clientY);
    const kind = petIndex >= 0 ? "pet" : inside ? "dead" : "background";
    return { kind, petIndex, insidePublishedBounds: inside, target: capture && (capture.id || capture.className || capture.tagName) };
  };

  const classify = (event, source) => {
    if (!event || (event.isPrimary === false)) return;
    // The document capture listener runs first, the overlay capture's own listener
    // second. Classify a physical pointerdown once, not twice.
    if (event.__previewClassified) return event.__previewClassified;
    const root = stageRoot();
    const origin = stageOrigin();
    const insideStage = Boolean(root && document.elementFromPoint(event.clientX, event.clientY) &&
      (root === document.elementFromPoint(event.clientX, event.clientY) ||
       root.contains(document.elementFromPoint(event.clientX, event.clientY))));
    const point = hitTest(event.clientX, event.clientY);
    const target = event.target;
    const onPet = Boolean(target && target.closest && target.closest(".pet"));
    const kind = onPet || point.kind === "pet" ? "pet" : point.kind;
    const entry = {
      at: Date.now(),
      source: source || "document",
      x: Math.round(event.clientX - origin.left),
      y: Math.round(event.clientY - origin.top),
      kind,
      insideStage,
      insidePublishedBounds: point.insidePublishedBounds,
      petIndex: point.petIndex,
      target: point.target,
    };
    clicks.push(entry);
    if (clicks.length > 500) clicks.shift();
    if (kind !== "pet") {
      record("背景点击 " + entry.x + "," + entry.y + " → " + kind + (point.insidePublishedBounds ? "（宿主联合矩形内）" : ""));
    }
    event.__previewClassified = entry;
    return entry;
  };

  document.addEventListener("pointerdown", (event) => classify(event, "document"), true);

  /* ---------------------------------------------------------------------- */
  /* Stage state polling: the real path configure() must go through         */
  /* ---------------------------------------------------------------------- */

  const intervals = [];
  const nativeSetInterval = window.setInterval.bind(window);
  window.setInterval = (callback, delay, ...args) => {
    const id = nativeSetInterval(callback, delay, ...args);
    intervals.push({ id, callback, delay });
    return id;
  };

  let configureChain = Promise.resolve();
  const stageConfig = () => {
    const stage = window.__dshPetStage;
    if (!stage) return undefined;
    // stage.config is the getter the rewritten stage exposes; stage.state.config
    // is the old shape. Both are read so a partially built bundle still reports.
    if (stage.config !== undefined) return stage.config;
    return stage.state && stage.state.config;
  };
  const sameConfig = (a, b) => Boolean(a) && Boolean(b) && JSON.stringify(a) === JSON.stringify(b);

  /**
   * Has the stage applied the new config?
   *
   * The rewritten stage exposes a config getter, which is authoritative. An older
   * bundle only exposes the pets array, so fall back to its observable effect (the
   * pet count) instead of reporting a timeout while the change clearly worked.
   */
  const stageApplied = () => {
    const current = stageConfig();
    if (current) return sameConfig(current, config);
    return pets().length === config.count;
  };

  const triggerStatePoll = () => {
    // The rewritten stage exposes stage.refresh(); calling it is the most direct
    // real path (the same function its own poll and menu use). Older bundles only
    // registered a 12 s interval, so fall back to invoking those callbacks. Either
    // way the patch arrives through pet-state, never through a memory poke.
    const stage = window.__dshPetStage;
    if (stage && typeof stage.refresh === "function") {
      try {
        Promise.resolve(stage.refresh()).catch((error) => record("✕ refresh: " + (error && error.message)));
        return 1;
      } catch (error) {
        record("✕ refresh: " + (error && error.message));
      }
    }
    let ran = 0;
    for (const entry of intervals) {
      try { entry.callback(); ran += 1; } catch (error) { record("✕ interval: " + (error && error.message)); }
    }
    if (ran === 0) record("（尚未注册状态轮询，等启动后自动获取）");
    return ran;
  };

  const waitFor = async (predicate, timeoutMs, label) => {
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      if (predicate()) return true;
      await sleep(25);
    }
    record("✕ 等待超时：" + (label || "条件") + "（" + timeoutMs + "ms）");
    return false;
  };

  const configure = (patch) => {
    const run = async () => {
      const value = patch && typeof patch === "object" ? patch : {};
      // Through the command the settings panel uses. The response is a copy, so the
      // page mirror and the mock store cannot alias each other.
      const result = await globalThis.narrafork.commands.execute("pet-config-set", { patch: value });
      const next = result && result.output && result.output.config ? result.output.config : config;
      config = next;
      triggerStatePoll();
      const applied = await waitFor(stageApplied, 4000, "舞台应用配置");
      return { config: clone(config), applied, stageConfig: clone(stageConfig()) };
    };
    const next = configureChain.then(run, run);
    configureChain = next.catch(() => {});
    return next;
  };

  /* ---------------------------------------------------------------------- */
  /* Overlay surface simulation                                              */
  /* ---------------------------------------------------------------------- */

  let capture = null;
  let relayPointerId = 1;
  const relay = (event) => {
    if (!event) return;
    if (typeof event.method === "string") {
      notify({ method: event.method, params: event.params || {} });
      return;
    }
    notify({
      method: "overlay.pointer",
      params: {
        type: event.type || "down",
        x: Number(event.x),
        y: Number(event.y),
        pointerId: Number.isFinite(event.pointerId) ? event.pointerId : 1,
        buttons: Number.isFinite(event.buttons) ? event.buttons : event.type === "up" ? 0 : 1,
      },
    });
  };

  const installOverlayCapture = () => {
    if (settings.surface !== "overlay") return;
    capture = document.getElementById("overlay-capture");
    if (!capture) {
      capture = document.createElement("div");
      capture.id = "overlay-capture";
      document.body.append(capture);
    }
    if (publishedBounds) onBounds(publishedBounds);
    if (capture.__wired) return;
    capture.__wired = true;
    let dragging = false;
    let last = null;
    const end = (type) => (event) => {
      if (!dragging) return;
      dragging = false;
      const endX = last ? last.x : event.clientX;
      const endY = last ? last.y : event.clientY;
      relay({ type, x: endX, y: endY, pointerId: relayPointerId, buttons: 0 });
      try { capture.releasePointerCapture(event.pointerId); } catch {}
    };
    capture.addEventListener("pointerdown", (event) => {
      classify(event, "overlay-capture");
      if (event.button !== undefined && event.button !== 0) return;
      dragging = true;
      last = { x: event.clientX, y: event.clientY };
      relayPointerId = Number.isFinite(event.pointerId) ? event.pointerId : relayPointerId;
      event.preventDefault();
      relay({ type: "down", x: event.clientX, y: event.clientY, pointerId: relayPointerId, buttons: 1 });
    });
    // The real host owns the pointer, so a gesture keeps arriving after it leaves the
    // published rectangle. Deliberately NOT capture.setPointerCapture: the plugin's
    // own synthetic handlers may call setPointerCapture on a pet element (the iframe
    // shares this document in the preview), which would retarget every later event
    // away from this rectangle and strand the gesture. Document-level listeners keep
    // the relay faithful in both cases.
    document.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      last = { x: event.clientX, y: event.clientY };
      relay({ type: "move", x: event.clientX, y: event.clientY, pointerId: relayPointerId, buttons: event.buttons || 1 });
    }, true);
    document.addEventListener("pointerup", end("up"), true);
    document.addEventListener("pointercancel", end("cancel"), true);
  };

  /* ---------------------------------------------------------------------- */
  /* Harness overlays + readiness                                            */
  /* ---------------------------------------------------------------------- */

  /** Re-add the harness overlays the stage's body takeover removed. */
  const restoreOverlays = () => {
    let harness = document.getElementById("harness");
    if (!harness) {
      harness = document.createElement("div");
      harness.id = "harness";
      document.body.prepend(harness);
    }
    let probe = document.getElementById("probe");
    if (!probe) {
      probe = document.createElement("div");
      probe.id = "probe";
      document.body.append(probe);
      probe.textContent = lines.join("\\n");
    }
    let exampleLabel = document.getElementById("preview-example-label");
    if (!exampleLabel) {
      exampleLabel = document.createElement("div"); exampleLabel.id = "preview-example-label";
      exampleLabel.textContent = "纯离线示例 · 非真实余额/权限"; document.body.append(exampleLabel);
    }
    installOverlayCapture();
  };

  const reportStage = () => {
    const fronts = [...document.querySelectorAll(".pet-frame")].filter((img) => img.classList.contains("is-front"));
    record("front frames: " + (fronts.map((img) => img.naturalWidth + "×" + img.naturalHeight).join(", ") || "none"));
    const list = [...document.querySelectorAll(".pet")];
    record("pets: " + list.length);
    for (const pet of list) record("  " + pet.style.transform);
    record("bubble hidden: " + (document.querySelector(".pet-thought") || {}).hidden);
    const all = pets();
    record("pet clip ids: " + all.map((pet) => pet.player && pet.player.clipId).join(", "));
    record("surface: " + settings.surface + (settings.surface === "overlay" ? "（relay + setBounds 模拟）" : "（DOM 指针事件）"));
    record("fidelity: 不模拟宿主 CSP / asset token / sandbox 权限 / 浮层音频");
    if (publishedBounds) record("published bounds: " + JSON.stringify(publishedBounds));
    restoreOverlays();
  };

  const waitReady = async () => {
    const expected = config.count;
    const ready = await waitFor(() => {
      const root = document.querySelector(".pet-stage");
      const list = pets();
      return Boolean(root) && list.length === expected &&
        list.every((pet) => pet && pet.player && pet.player.clipId);
    }, 12_000, "舞台就绪（" + expected + " 只宠物已显示片段）");
    window.__previewReady = true;
    record(ready ? "stage ready" : "stage ready (degraded: 片段仍在加载)");
    reportStage();
    return ready;
  };

  // Deliberately a wall-clock offset, not a fabricated browser event loop:
  // animation/performance timers stay real; advance ticks existing bubble leases.
  const nativeNow = Date.now.bind(Date);
  let clockOffset = 0;
  Date.now = () => nativeNow() + clockOffset;
  const previewClock = Object.freeze({
    now: () => Date.now(),
    advance: (milliseconds) => {
      if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 86400000) throw new Error("时钟仅允许前进0至86400000ms");
      clockOffset += milliseconds;
      for (const pet of pets()) { pet.bubbleController?.tick(); pet.bubbleController?.position(); }
      return { now: Date.now(), offset: clockOffset, timerMode: "real-browser", examplesOnly: true };
    },
    note: "仅推进示例墙钟和已有气泡到期状态；轮询/rAF仍使用浏览器真实计时器",
  });
  const injectBalance = async (value, nextLedger = ledger) => {
    if (value !== null && (!isPlainObject(value) || !validJson(value))) throw new Error("余额示例必须是JSON对象或null");
    snapshot = clone(value);
    if (snapshot && Array.isArray(snapshot.accounts)) snapshot.balances = clone(snapshot.accounts);
    ledger = clone(nextLedger); balanceFailure = null;
    if (window.__dshPetStage?.refresh) await window.__dshPetStage.refresh();
    else triggerStatePoll();
    return { examplesOnly: true, snapshot: clone(snapshot) };
  };
  const sampleTask = (kind, narratorId = demoId()) => {
    if (kind === "permission") return makeEvent("narrafork.narrator.permission.changed", { narratorId, requestId: "example-request-" + (nextEvent + 1), state: "pending" });
    if (kind === "resolved") return makeEvent("narrafork.narrator.attention", { narratorId, reason: "waiting_permission", state: "resolved" });
    if (["done", "error"].includes(kind)) return makeEvent("narrafork.narrator.attention", { narratorId, reason: kind, state: "raised" });
    if (["idle", "working", "waiting", "archived"].includes(kind)) return makeEvent("narrafork.narrator.lifecycle", { narratorId, status: kind });
    if (kind === "tool-fail") return makeEvent("narrafork.narrator.tool.changed", { narratorId, toolUseId: "example-tool", toolName: "Bash", status: "fail" });
    throw new Error("未知示例事件类型");
  };

  window.__preview = {
    examplesOnly: true,
    configure,
    balance: injectBalance,
    samples: () => clone(samples),
    sample: (name) => { if (!Object.hasOwn(samples, name)) throw new Error("未知余额示例"); return injectBalance(samples[name]); },
    balanceError: async (code = "EXAMPLE_OFFLINE", message = "示例离线错误；非真实服务") => {
      balanceFailure = { code: String(code), message: String(message) };
      snapshot = { ...(snapshot ?? {}), ok: false, stale: Boolean(snapshot?.ok || snapshot?.stale), error: clone(balanceFailure) };
      if (window.__dshPetStage?.refresh) await window.__dshPetStage.refresh();
      else triggerStatePoll();
      return { examplesOnly: true, error: clone(balanceFailure) };
    },
    events: Object.freeze({
      push: pushEvent,
      sample: (kind, narratorId) => pushEvent(sampleTask(kind, narratorId)),
      fixture: sampleTask,
      mode: (code = null) => {
        if (code !== null && !["PERMISSION_DENIED", "METHOD_NOT_FOUND", "HOST_UNAVAILABLE", "TIMEOUT"].includes(code)) throw new Error("未知模拟事件错误");
        eventFailure = code; return { examplesOnly: true, code, note: "仅模拟接口响应，不更改真实权限" };
      },
      subscriptions: () => [...eventSubscriptions].map(([subscriptionId, entry]) => ({ subscriptionId, scope: clone(entry.input.scope), queued: entry.queue.length })),
    }),
    clock: previewClock,
    relay,
    notify: (method, params) => notify({ method, params: params || {} }),
    refresh: async () => {
      triggerStatePoll();
      const applied = await waitFor(stageApplied, 4000, "舞台刷新配置");
      return { applied, config: clone(config) };
    },
    config: () => clone(config),
    stageConfig: () => clone(stageConfig()),
    bounds: () => clone(publishedBounds),
    boundsCalls: () => boundsCalls,
    pets: () => pets().map((pet, index) => ({
      index,
      hit: clone(petRect(pet, "hit")),
      body: clone(petRect(pet, "body")),
      mode: pet.mode,
      facing: pet.facing,
      clipId: pet.player && pet.player.clipId,
      x: pet.x,
      y: pet.y,
    })),
    hitTest,
    clicks: () => clicks.slice(),
    clearClicks: () => { clicks.length = 0; },
    backgroundClicks: () => clicks.filter((entry) => entry.kind !== "pet").length,
    deadClicks: () => clicks.filter((entry) => entry.kind === "dead").length,
    setClipDelay: (ms) => { clipDelayMs = Math.max(0, Number(ms) || 0); return clipDelayMs; },
    clipDelay: () => clipDelayMs,
    /**
     * Click-sound state, for the one part of issue 7 only a browser can answer:
     * whether a real trusted click unlocked WebAudio, decoded the original WAV and
     * actually started a voice. Returns null until the stage exposes its sound.
     */
    sound: () => {
      const sound = window.__dshPetStage && window.__dshPetStage.sound;
      if (!sound) return null;
      return {
        enabled: config.sound ? config.sound.enabled !== false : undefined,
        volume: config.sound ? config.sound.volume : undefined,
        hasContext: Boolean(sound.context),
        state: sound.context ? sound.context.state : undefined,
        failed: Boolean(sound.failed),
        resuming: Boolean(sound.resuming),
        decodedPeak: sound.decodedPeak,
        bufferDuration: sound.buffer ? sound.buffer.duration : undefined,
        voices: sound.voices ? sound.voices.size : undefined,
        lastPlayAt: sound.lastPlayAt,
      };
    },
    intervals: () => intervals.map((entry) => entry.delay),
    waitReady,
    log: () => lines.slice(),
    fidelity: () => window.__previewFidelity,
  };

  const script = document.createElement("script");
  script.src = "/ui/stage.iife.js";
  script.onload = () => {
    restoreOverlays();
    const root = document.querySelector(".pet-stage");
    if (!root) { record("✕ .pet-stage 没有出现"); return; }
    record("stage mounted into body");
    record("提示：?surface=overlay / ?count=1..6 / ?idleMinMs= / ?groups= / ?clipDelayMs=；控制接口 window.__preview");
    // The stage's boot is async (bridge context, clip bytes, pet-state). Poll rather
    // than guessing a single delay: a fixed 2.6 s both passed too early on a cold
    // cache and hid a permanently blank pet behind a "ready" flag.
    void waitReady();
    setTimeout(() => { reportStage(); }, 2600);
  };
  script.onerror = () => record("✕ stage.iife.js 加载失败");
  document.head.append(script);
})();
</script>
</body>
</html>`;

async function resolveFile(urlPath) {
	// Strip the leading slash and normalise; refuse anything that escapes the package.
	const relative = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "");
	const absolute = path.resolve(PLUGIN_DIR, relative);
	if (!absolute.startsWith(PLUGIN_DIR)) return undefined;
	return absolute;
}

const server = http.createServer(async (request, response) => {
	const url = request.url ?? "/";
	const parsed = new URL(url, "http://127.0.0.1");
	if (parsed.pathname === "/preview.html" || parsed.pathname === "/") {
		const settings = previewSettings(parsed.searchParams);
		const html = previewPage({ nocss: settings.nocss, settings });
		response.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
		response.end(html);
		return;
	}
	const file = await resolveFile(url);
	if (!file) {
		response.writeHead(403).end("forbidden");
		return;
	}
	try {
		const body = await fs.readFile(file);
		response.writeHead(200, {
			"Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
			"Content-Length": body.length,
			"Cache-Control": "no-store",
		});
		response.end(body);
	} catch {
		response.writeHead(404).end("not found");
	}
});

server.listen(port, "127.0.0.1", () => {
	process.stdout.write(`[preview] http://127.0.0.1:${port}/preview.html  (root ${posix(PLUGIN_DIR)})\n`);
	process.stdout.write("[preview] overlay: ?surface=overlay  count/waits: ?count=6&idleMinMs=1000&idleMaxMs=1000\n");
	process.stdout.write("[preview] Ctrl-C 结束\n");
});
