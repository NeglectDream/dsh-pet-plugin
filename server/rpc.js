/**
 * `narrafork.rpc/1` over stdio: framing, lifecycle, and the outbound half.
 *
 * THE SHAPE OF THIS PROTOCOL
 * Frames are `Content-Length: N\r\n…\r\n\r\n` + a UTF-8 JSON body, LSP-style.
 * Two directions share one pipe pair:
 *
 *  - host → plugin: JSON-RPC *requests* (`initialize`, `activate`, `health`,
 *    `commands.invoke`, `deactivate`, `shutdown`) that this process answers;
 *  - plugin → host: JSON-RPC *requests* the plugin initiates (`storage.get`,
 *    `secrets.get`, …) which the host answers on the same stdout stream.
 *
 * So an inbound message is either a request (has `method` **and** `id`), a
 * *response* to something we asked (has `id`, no `method`), or a notification
 * (has `method`, no `id`). All three arrive interleaved; `handleMessage` is the
 * single demultiplexer.
 *
 * WHY THE REFERENCE PLUGIN'S SKELETON IS REUSED RATHER THAN INVENTED
 * The framing rules here are not ours to choose: the header size ceiling, the
 * 1 MiB frame ceiling that matches `PluginRpcConnection`'s own limit, and the
 * identity check in `initialize` are all enforced host-side. Diverging from a
 * shape the host already accepts would only produce a runtime that starts and
 * then gets quarantined on the first oversized frame.
 */

import { log } from "./log.js";

const RPC_PROTOCOL = "narrafork.rpc/1";

/**
 * Must be at least the host's 1 MiB ceiling, not smaller: the host is allowed to
 * send a frame up to its own limit, and a plugin that rejects a legal frame dies
 * with a protocol error rather than answering it.
 */
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_BUFFER_BYTES = MAX_HEADER_BYTES + MAX_FRAME_BYTES + 4;

/** Host → plugin requests we implement. Anything else is METHOD_NOT_FOUND. */
const LIFECYCLE_METHODS = ["initialize", "activate", "health", "deactivate", "shutdown"];

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function append(left, right) {
	const next = new Uint8Array(left.byteLength + right.byteLength);
	next.set(left);
	next.set(right, left.byteLength);
	return next;
}

function delimiterIndex(bytes) {
	for (let index = 0; index <= bytes.byteLength - 4; index += 1) {
		if (
			bytes[index] === 13 &&
			bytes[index + 1] === 10 &&
			bytes[index + 2] === 13 &&
			bytes[index + 3] === 10
		) {
			return index;
		}
	}
	return -1;
}

function contentLength(header) {
	let length;
	for (const line of header.split("\r\n")) {
		const separator = line.indexOf(":");
		if (separator <= 0) throw new Error("invalid RPC header");
		if (line.slice(0, separator).trim().toLowerCase() !== "content-length") continue;
		if (length !== undefined) throw new Error("duplicate Content-Length header");
		const value = line.slice(separator + 1).trim();
		if (!/^\d+$/.test(value)) throw new Error("invalid Content-Length header");
		length = Number(value);
	}
	if (!Number.isSafeInteger(length)) throw new Error("missing Content-Length header");
	return length;
}

/**
 * JSON-RPC error codes. Only the ones this plugin can actually produce are
 * listed; the host maps them onto `PluginRuntimeError` codes for the UI.
 */
export const ERROR_CODES = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
	PLUGIN_UNAVAILABLE: -32009,
};

/** An error a handler throws to produce a structured JSON-RPC error rather than a stack trace. */
export class RpcError extends Error {
	constructor(code, message, data) {
		super(message);
		this.name = "RpcError";
		this.code = code;
		this.data = data;
	}
}

/**
 * The single feature this plugin negotiates, and why it is not optional.
 *
 * `PLUGIN_TO_HOST_METHOD_REQUIRED_FEATURES` (protocol.ts) lists
 * `host_api.requests` as a prerequisite for **every** plugin→host method —
 * `storage.get`, `secrets.get`, `config.get`, all of them. `PluginRuntime` opens
 * its connection with `enforceFeatureNegotiation: true` and derives the negotiated
 * set from *this hello frame only* (`selectPluginToHostFeatures` reads
 * `params.features`, never `manifest.engine.features`). A `hello` with
 * `features: []` therefore yields an empty negotiated set, and every outbound
 * request is rejected before it reaches the dispatcher — which surfaces at the
 * far end as "the command failed" with no hint of the real cause.
 */
const NEGOTIATED_FEATURES = ["host_api.requests"];

export function createRpc({ pluginId, version, packageDigest, handlers }) {
	/** Inbound requests currently executing, so `$/cancelRequest` can abort them. */
	const inFlight = new Map();
	/** Outbound requests waiting for a host response, keyed by the id we minted. */
	const pending = new Map();
	let outboundSequence = 0;
	let buffer = new Uint8Array(0);
	let initialized = false;
	let active = false;
	let runtimeId;
	let generation;
	let shuttingDown = false;

	function writeFrame(message, callback) {
		const body = encoder.encode(JSON.stringify(message));
		if (body.byteLength > MAX_FRAME_BYTES) {
			// Dropping is the only safe move: a truncated frame desynchronises the
			// stream, and the host would mis-parse every later message.
			log.error("dropped an oversized outbound frame", { bytes: body.byteLength });
			if (callback) callback();
			return;
		}
		const header = encoder.encode(
			`Content-Length: ${body.byteLength}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n`,
		);
		process.stdout.write(append(header, body), callback);
	}

	function respond(id, result) {
		writeFrame({ jsonrpc: "2.0", id, result });
	}

	function reject(id, code, message, data) {
		writeFrame({
			jsonrpc: "2.0",
			id,
			error: { code, message, ...(data === undefined ? {} : { data }) },
		});
	}

	/**
	 * Ask the host something and wait for the answer.
	 *
	 * Every outbound call is bounded: the host's dispatcher also has a deadline,
	 * but a plugin that waits forever on a method the host forgot to answer would
	 * stop servicing its own activation and get killed with no diagnostic.
	 */
	function callHost(method, params, options = {}) {
		const timeoutMs = options.timeoutMs ?? 10_000;
		return new Promise((resolve, rejectPromise) => {
			outboundSequence += 1;
			const id = `p${outboundSequence}`;
			const timer = setTimeout(() => {
				pending.delete(id);
				rejectPromise(new RpcError(ERROR_CODES.INTERNAL_ERROR, `host call timed out: ${method}`));
			}, timeoutMs);
			// `.unref()` so a long timeout never keeps the process alive after shutdown.
			if (typeof timer.unref === "function") timer.unref();
			pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					rejectPromise(error);
				},
				method,
			});
			writeFrame({
				jsonrpc: "2.0",
				id,
				method,
				params: params === undefined ? {} : params,
			});
		});
	}

	/** The answer to something we asked. Unmatched ids are dropped, not answered. */
	function handleResponse(message) {
		const entry = pending.get(message.id);
		if (!entry) return;
		pending.delete(message.id);
		if (message.error) {
			entry.reject(
				new RpcError(
					typeof message.error.code === "number" ? message.error.code : ERROR_CODES.INTERNAL_ERROR,
					String(message.error.message ?? "host call failed"),
					message.error.data,
				),
			);
			return;
		}
		entry.resolve(message.result);
	}

	function handleNotification(message) {
		if (message.method === "$/cancelRequest") {
			const id = message.params?.id;
			const entry = inFlight.get(id);
			if (entry) entry.controller.abort();
			return;
		}
		// `$/credit` and `provider.event` are part of the protocol's streaming
		// half, which this plugin never opts into (`engine.features: []`).
	}

	async function handleRequest(message) {
		const { id, method, params } = message;

		if (method === "initialize") {
			if (params?.protocol !== RPC_PROTOCOL || params.pluginId !== pluginId) {
				reject(id, ERROR_CODES.INVALID_PARAMS, "initialize identity or protocol mismatch", {
					code: "INVALID_PARAMS",
				});
				return;
			}
			runtimeId = typeof params.runtimeId === "string" ? params.runtimeId : undefined;
			generation = typeof params.generation === "number" ? params.generation : undefined;
			initialized = true;
			respond(id, { initialized: true, protocol: RPC_PROTOCOL });
			return;
		}

		if (method === "activate") {
			if (!initialized) {
				reject(id, ERROR_CODES.INTERNAL_ERROR, "Plugin must be initialized before activation");
				return;
			}
			active = true;
			respond(id, { activated: true });
			// Only after the host has its answer: activation work that throws must not
			// turn a successful handshake into a failed one.
			try {
				await handlers.onActivate?.({ reason: params?.reason });
			} catch (error) {
				log.error("activation hook failed", error);
			}
			return;
		}

		if (method === "health") {
			respond(id, {
				healthy: initialized && active,
				status: active ? "ready" : "inactive",
				runtimeId,
				generation,
			});
			return;
		}

		if (method === "deactivate") {
			active = false;
			respond(id, { deactivated: true });
			try {
				await handlers.onDeactivate?.();
			} catch (error) {
				log.error("deactivate hook failed", error);
			}
			return;
		}

		if (method === "shutdown") {
			active = false;
			initialized = false;
			shuttingDown = true;
			// Abort anything still running so its `.then` never writes to a pipe the
			// host has already closed.
			for (const entry of inFlight.values()) entry.controller.abort();
			inFlight.clear();
			for (const entry of pending.values()) {
				entry.reject(new RpcError(ERROR_CODES.PLUGIN_UNAVAILABLE, "plugin is shutting down"));
			}
			pending.clear();
			try {
				await handlers.onShutdown?.();
			} catch (error) {
				log.error("shutdown hook failed", error);
			}
			writeFrame({ jsonrpc: "2.0", id, result: { shutdown: true } }, () => process.exit(0));
			return;
		}

		const handler = handlers.methods[method];
		if (!handler) {
			reject(id, ERROR_CODES.METHOD_NOT_FOUND, `Unknown method: ${method}`, {
				code: "METHOD_NOT_FOUND",
			});
			return;
		}

		if (!active) {
			reject(id, ERROR_CODES.PLUGIN_UNAVAILABLE, "Plugin is not active", {
				code: "PLUGIN_UNAVAILABLE",
			});
			return;
		}

		const controller = new AbortController();
		inFlight.set(id, { controller });
		try {
			const result = await handler(params, { signal: controller.signal });
			if (shuttingDown) return;
			respond(id, result ?? null);
		} catch (error) {
			if (shuttingDown) return;
			if (error instanceof RpcError) {
				reject(id, error.code, error.message, error.data);
			} else {
				log.error(`handler ${method} failed`, error);
				reject(id, ERROR_CODES.INTERNAL_ERROR, "Internal error", {
					code: "INTERNAL_ERROR",
				});
			}
		} finally {
			inFlight.delete(id);
		}
	}

	function handleMessage(message) {
		if (typeof message !== "object" || message === null) return;
		if (message.jsonrpc !== "2.0") return;
		if (typeof message.method !== "string") {
			// No `method` and an `id` means it is the answer to an outbound call.
			if (message.id !== undefined) handleResponse(message);
			return;
		}
		if (message.id === undefined) {
			handleNotification(message);
			return;
		}
		void handleRequest(message);
	}

	function parseFrames() {
		while (buffer.byteLength > 0) {
			const delimiter = delimiterIndex(buffer);
			if (delimiter < 0) {
				if (buffer.byteLength > MAX_HEADER_BYTES) throw new Error("RPC header exceeds limit");
				return;
			}
			if (delimiter > MAX_HEADER_BYTES) throw new Error("RPC header exceeds limit");
			const length = contentLength(decoder.decode(buffer.slice(0, delimiter)));
			if (length > MAX_FRAME_BYTES) throw new Error("RPC frame exceeds limit");
			const bodyStart = delimiter + 4;
			const frameEnd = bodyStart + length;
			if (buffer.byteLength < frameEnd) return;
			const message = JSON.parse(decoder.decode(buffer.slice(bodyStart, frameEnd)));
			buffer = buffer.slice(frameEnd);
			handleMessage(message);
		}
	}

	function start() {
		process.stdin.on("data", (chunk) => {
			try {
				buffer = append(buffer, new Uint8Array(chunk));
				if (buffer.byteLength > MAX_BUFFER_BYTES) throw new Error("RPC input buffer exceeds limit");
				parseFrames();
			} catch (error) {
				log.error("fatal transport error", error);
				process.exit(2);
			}
		});
		process.stdin.on("end", () => process.exit(0));
		// Keep the event loop alive even if the host never activates us; without
		// this the process exits immediately after `hello` and the host sees a
		// crash before it has finished the handshake.
		process.stdin.resume();

		writeFrame({
			jsonrpc: "2.0",
			method: "hello",
			params: {
				pluginId,
				version,
				rpcProtocol: RPC_PROTOCOL,
				...(packageDigest ? { packageDigest } : {}),
				features: [...NEGOTIATED_FEATURES],
			},
		});
	}

	return { start, callHost, isActive: () => active, LIFECYCLE_METHODS };
}
