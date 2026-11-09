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
 * one classic `<script src>`, no bundler, no module loader. What it deliberately
 * cannot reproduce is the host's CSP, the asset-token URL and the real bridge —
 * those are the host's job and are covered by the in-panel self-check.
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
	".md": "text/markdown; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
};

/**
 * The page shell.
 *
 * The stub mimics the shape the real shell installs, including the two details
 * that are easy to get wrong: `commands.execute` resolves `{ output }`, and the
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
-->
${options.nocss ? "" : '<link rel="stylesheet" href="/ui/stage.css">'}
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
    border-radius: 6px; max-width: 70vw; white-space: pre-wrap; }
</style>
</head>
<body>
<div id="harness"></div>
<div id="probe">booting…</div>
<script>
(() => {
  "use strict";
  const lines = [];
  window.__previewLog = lines;
  // Resilient on purpose: the stage replaces body's children, so the probe element
  // can be gone between two log lines.
  const record = (text) => {
    lines.push(text);
    const probe = document.getElementById("probe");
    if (probe) probe.textContent = lines.join("\\n");
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
  const config = {
    version: 1, count: 2, scale: 1, gravity: 1, bounce: 0.55, friction: 0.9,
    collisions: true, clickSquash: 0.35, roam: true, diagnostics: false,
    animationGroups: { idle: true, turn: true, drag: true, click: true, move: true,
      small: true, play: true, eat: true, season: true, text: true },
    idleMinMs: 1800, idleMaxMs: 3200,
    sound: { enabled: false, volume: 0.6 },
    balance: { providerId: "deepseek-official", refreshMinutes: 30,
      thresholds: [20, 40, 60, 80, 100],
      custom: { label: "", url: "", method: "GET", headers: {}, totalPath: "", usedPath: "" } },
  };
  const snapshot = { providerId: "deepseek-official", label: "DeepSeek 官方 API Key", ok: true,
    shape: "money", percent: 63, summary: "余额（谷）¥7.40", tier: 3,
    detail: { wallets: [{ currency: "CNY", total: "7.40", granted: "0", toppedUp: "7.40", fullBalance: 20 }] },
    fetchedAt: new Date().toISOString() };

  const handle = async (commandId, input) => {
    record("→ " + commandId);
    switch (commandId) {
      case "pet-clip": {
        // Mirrors the backend: read the clip, return one 512 KiB base64 chunk.
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
      case "pet-state": return { version: "1.2.0", config, configWarnings: [], configStored: true, balance: snapshot };
      case "pet-config-get": return { config, warnings: [], stored: true };
      case "pet-config-set":
        if (input && input.patch) Object.assign(config, input.patch);
        return { config, warnings: [] };
      case "pet-balance-refresh": return { snapshot, cached: false };
      case "pet-balance-providers": return { providers: [
        { id: "deepseek-official", label: "DeepSeek 官方 API Key", secretKey: "deepseekApiKey", description: "", isCustom: false },
        { id: "custom", label: "自定义服务商", secretKey: "customApiKey", description: "", isCustom: true } ] };
      case "pet-secrets-list": return { keys: [{ key: "deepseekApiKey", configured: true, known: true }] };
      case "pet-log": record("  log[" + (input && input.level) + "] " + (input && input.message)); return { ok: true };
      default: throw Object.assign(new Error("unknown command " + commandId), { code: "INVALID_PARAMS" });
    }
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
        return { output: await handle(commandId, input) };
      },
    }),
    storage: Object.freeze({
      get: async ({ key }) => (storage.has(key) ? { key, value: storage.get(key), revision: 1 } : null),
      set: async ({ key, value }) => { storage.set(key, value); return { key, revision: 1, stored: true }; },
      delete: async ({ key }) => { storage.delete(key); return { key, deleted: true }; },
      list: async () => ({ entries: [...storage.entries()].map(([key, value]) => ({ key, value })) }),
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
    events: Object.freeze({ subscribe: async () => ({}), unsubscribe: async () => ({}), poll: async () => ({ events: [] }) }),
    i18n: Object.freeze({ locale: "zh-CN", t: (tables, key) => key, onChange: () => () => {} }),
    getContext: async () => ({
      contextVersion: 1,
      host: { appVersion: "preview", locale: "zh-CN", colorScheme: "dark", platform: "windows" },
      plugin: { id: "cn.mcd7.neglectdream.dsh-pet", version: "preview", contributionId: "pet-stage", panelInstanceId: "preview" },
      // The real host reports the surface this view was mounted on; the stage uses it
      // to choose between DOM pointer events and the overlay relay. Reporting a dock
      // surface keeps this harness on the dock path it can actually exercise.
      surface: { kind: "workspace", active: true, visible: true },
    }),
  });

  window.addEventListener("error", (event) => record("✕ script error: " + event.message));
  window.addEventListener("unhandledrejection", (event) => record("✕ rejection: " + (event.reason && event.reason.message)));

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
  };

  const script = document.createElement("script");
  script.src = "/ui/stage.iife.js";
  script.onload = () => {
    restoreOverlays();
    const root = document.querySelector(".pet-stage");
    if (!root) { record("✕ .pet-stage 没有出现"); return; }
    record("stage mounted into body");
    setTimeout(() => {
      const fronts = [...document.querySelectorAll(".pet-frame")].filter((img) => img.classList.contains("is-front"));
      record("front frames: " + (fronts.map((img) => img.naturalWidth + "×" + img.naturalHeight).join(", ") || "none"));
      const pets = [...document.querySelectorAll(".pet")];
      record("pets: " + pets.length);
      for (const pet of pets) record("  " + pet.style.transform);
      record("bubble hidden: " + (document.querySelector(".pet-bubble") || {}).hidden);
      restoreOverlays();
      window.__previewReady = true;
    }, 2600);
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
	if (url.startsWith("/preview.html") || url === "/") {
		const html = previewPage({ nocss: url.includes("nocss=1") });
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
	process.stdout.write("[preview] Ctrl-C 结束\n");
});
