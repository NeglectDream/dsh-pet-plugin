/**
 * Shared UI preamble — concatenated into each `ui/*.iife.js` by `tools/build-ui.mjs`.
 *
 * WHY A CONCATENATION INSTEAD OF A MODULE
 * The iframe shell injects exactly two scripts: an optional host runtime and the
 * view's single `entry` file. Its CSP is `script-src <origin>`, so a second
 * `<script src>` would load, but nothing in the manifest can declare one and the
 * shell will not fetch a file a plugin names at runtime. `format: "iife"` means
 * one file, so sharing code between the stage and the settings panel has to
 * happen at build time. That is the entire reason this file exists.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * No framework, no state container, no DOM diffing. The stage redraws at 60 fps
 * via transforms, and the settings panel borrows the host's React. A third
 * abstraction layer between them would only add a thing to debug.
 */

const SDK = (() => {
	/**
	 * `document.currentScript` is only set while a *classic* script executes, which
	 * is exactly how the shell loads this file (`<script>` with `async = false`).
	 * Captured here, at the top, because it is null by the time any callback runs.
	 */
	const selfScript = document.currentScript;
	const selfSrc = selfScript && typeof selfScript.src === "string" ? selfScript.src : undefined;

	/**
	 * Asset URLs are derived from this file's own URL rather than injected by the
	 * host.
	 *
	 * The host's asset route is
	 *   /api/plugins/ui/<pluginId>/<version>/<hash>/asset/<sessionId>/<assetToken>/<path>
	 * and its token is bound to the *(pluginId, version, hash)* triple, never to an
	 * individual file — so any sibling path under the same prefix is servable. That
	 * makes `<this file's directory>/../<anything>` a valid, already-authorised URL,
	 * with no manifest field, no host call and no session id to thread through.
	 */
	const rootUrl = (() => {
		if (!selfSrc) return undefined;
		try {
			// `ui/stage.iife.js` → `ui/` → package root.
			return new URL("../", selfSrc);
		} catch {
			return undefined;
		}
	})();

	function asset(relativePath) {
		if (!rootUrl) {
			throw new Error("无法推导插件资源根路径（document.currentScript 不可用）");
		}
		// Strip any leading slash so callers can write either form.
		return new URL(String(relativePath).replace(/^\/+/, ""), rootUrl).href;
	}

	/** The host-injected bridge. Absent only if the shell failed to install it. */
	function bridge() {
		const api = globalThis.narrafork;
		if (!api) throw new Error("plugin UI bridge 未注入（globalThis.narrafork 缺失）");
		return api;
	}

	function describeError(error) {
		if (!error) return { message: "未知错误" };
		return {
			message: typeof error.message === "string" ? error.message : String(error),
			code: typeof error.code === "string" ? error.code : undefined,
			data: error.data,
		};
	}

	/**
	 * Strip values the bridge refuses before they are sent.
	 *
	 * The host validates every request with its own `validJson`, which rejects a key
	 * whose value is `undefined` — and this plugin builds payloads from optional data
	 * all the time (`environment()` has half a dozen optional fields). One missing
	 * field silently rejected the whole `pet-log` call, which is why the diagnostic
	 * channel produced nothing at all. Sanitising here makes that impossible to
	 * reintroduce from any call site.
	 */
	function jsonSafe(value, depth = 0) {
		if (depth > 12 || value === undefined || typeof value === "function") return undefined;
		if (value === null || typeof value === "string" || typeof value === "boolean") return value;
		if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
		if (Array.isArray(value)) {
			return value.map((item) => {
				const safe = jsonSafe(item, depth + 1);
				return safe === undefined ? null : safe;
			});
		}
		if (typeof value !== "object") return undefined;
		const out = {};
		for (const [key, item] of Object.entries(value)) {
			if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
			const safe = jsonSafe(item, depth + 1);
			if (safe !== undefined) out[key] = safe;
		}
		return out;
	}

	/**
	 * Call one of this plugin's own backend commands.
	 *
	 * The bridge serialises `{ commandId, input }` and forwards it to
	 * `PluginCommandRegistry.find(commandId, pluginId)`, so the id is the bare one
	 * from the manifest — no plugin prefix. A host command with a colliding id wins
	 * over ours, which is why every id here is `pet-*`.
	 *
	 * ⚠️ THE ARGUMENT MUST ALWAYS BE A JSON VALUE, SO `undefined` IS NEVER SENT.
	 * The bridge validates every request with its own `validJson`, which returns
	 * false for `undefined` — and `api.commands.execute(id)` builds
	 * `{ commandId, input: undefined }`, whose `input` key exists and is therefore
	 * inspected. The whole call is rejected with "Plugin UI params must be JSON"
	 * *before* it reaches the host, so an omitted argument is not a harmless
	 * omission: it fails every command that takes none.
	 */
	async function call(commandId, input) {
		const api = bridge();
		const result = await api.commands.execute(commandId, jsonSafe(input ?? {}) ?? {});
		// `commands.execute` reduces a plugin command's reply to `{ output }`; older
		// shapes returned the payload directly, so both are accepted.
		if (result && typeof result === "object" && "output" in result) return result.output;
		return result;
	}

	/** `call`, but a failure becomes a value. The stage must never show a blank frame. */
	async function callSafe(commandId, input) {
		try {
			return { ok: true, value: await call(commandId, input) };
		} catch (error) {
			return { ok: false, error: describeError(error) };
		}
	}

	/**
	 * Report a UI-side problem to the backend so it lands in the host's diagnostic
	 * log next to the backend's own lines. Deliberately fire-and-forget: a logging
	 * path that can itself throw turns one bug into a cascade.
	 *
	 * `detail` is only included when it is a real value, and the whole payload is run
	 * through `call` (which sanitises) — the bridge rejects a present-but-`undefined`
	 * key, so an eagerly built `detail: undefined` would make every log call fail
	 * silently, which is exactly what happened before this was fixed.
	 */
	function report(level, message, detail) {
		try {
			bridge();
		} catch {
			return;
		}
		Promise.resolve()
			.then(() => call("pet-log", { level, message, detail }))
			.catch(() => {});
	}

	/** Minimal element factory: this plugin ships no DOM helper library. */
	function el(tag, props, children) {
		const node = document.createElement(tag);
		if (props) {
			for (const [key, value] of Object.entries(props)) {
				if (value === undefined || value === null || value === false) continue;
				if (key === "class") node.className = value;
				else if (key === "text") node.textContent = value;
				else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
				else if (key.startsWith("on") && typeof value === "function") {
					node.addEventListener(key.slice(2).toLowerCase(), value);
				} else if (key === "dataset" && typeof value === "object") Object.assign(node.dataset, value);
				else node.setAttribute(key, value === true ? "" : String(value));
			}
		}
		for (const child of children ?? []) {
			if (child === undefined || child === null || child === false) continue;
			node.append(typeof child === "string" || typeof child === "number" ? String(child) : child);
		}
		return node;
	}

	/** Diagnostics the stage and the settings panel both display. */
	function environment() {
		return {
			hasBridge: Boolean(globalThis.narrafork),
			hasHostRuntime: Boolean(globalThis.__nfPluginRuntime),
			hostRuntimeVersion: globalThis.__nfPluginRuntime?.version,
			selfSrc,
			assetRoot: rootUrl ? rootUrl.href : undefined,
			secureContext: globalThis.isSecureContext,
			locale: globalThis.narrafork?.i18n?.locale,
			userAgent: navigator.userAgent,
		};
	}

	/**
	 * The overlay surface's interactive-rectangle channel, when the host has one.
	 *
	 * Feature-detected rather than assumed: `overlay.setBounds` is a newer host-local
	 * method, and a view that declares the `overlay` surface may still be mounted by a
	 * host too old to expose it. Returning `undefined` lets the stage degrade to
	 * "visible but not clickable" instead of throwing on the first frame.
	 */
	function overlay() {
		try {
			const api = bridge();
			return typeof api?.overlay?.setBounds === "function" ? api.overlay : undefined;
		} catch {
			return undefined;
		}
	}

	/** Host → plugin notifications (the only channel the host can push over). */
	function onNotification(listener) {
		try {
			const api = bridge();
			return typeof api.onNotification === "function" ? api.onNotification(listener) : () => {};
		} catch {
			return () => {};
		}
	}

	return { asset, call, callSafe, report, el, environment, bridge, overlay, onNotification };
})();
