/**
 * Structured logging to stderr.
 *
 * stdout belongs to the RPC framing (`narrafork.rpc/1` over stdio). A single
 * stray `console.log` there corrupts the stream and the host is entitled to
 * treat the whole runtime as misbehaving, so nothing in this plugin writes to
 * stdout except `rpc.js`.
 *
 * Lines are one-per-event and prefixed with the plugin's short name, because the
 * host multiplexes several plugins' stderr into one diagnostic view. `detail` is
 * serialized compactly and truncated: a log line that can be 4 KB defeats the
 * point of a log line.
 */

const PREFIX = "[dsh-pet]";
const MAX_DETAIL_CHARS = 800;
const MAX_MESSAGE_CHARS = 2000;

function text(value, limit) {
	if (value === undefined || value === null) return "";
	let out;
	if (typeof value === "string") {
		out = value;
	} else if (value instanceof Error) {
		out = `${value.name}: ${value.message}`;
	} else {
		try {
			out = JSON.stringify(value);
		} catch {
			out = String(value);
		}
	}
	out = out.replace(/[\r\n]+/g, " ");
	return out.length > limit ? `${out.slice(0, limit)}…` : out;
}

function emit(level, message, detail) {
	const suffix = detail === undefined ? "" : ` ${text(detail, MAX_DETAIL_CHARS)}`;
	process.stderr.write(`${PREFIX} ${level} ${text(message, MAX_MESSAGE_CHARS)}${suffix}\n`);
}

export const log = {
	info: (message, detail) => emit("info", message, detail),
	warn: (message, detail) => emit("warn", message, detail),
	error: (message, detail) => emit("error", message, detail),
};

/**
 * Never let a diagnostic path take the runtime down.
 *
 * The plugin is a guest process: if it crashes the panel loses its backend and
 * the user sees a dead pet with no explanation. Both process-level handlers keep
 * the process alive and surface the failure on stderr, where the host's
 * diagnostic view can show it.
 */
export function installCrashHandlers() {
	process.on("uncaughtException", (error) => {
		emit("error", "uncaughtException (process kept alive)", error);
	});
	process.on("unhandledRejection", (reason) => {
		emit("error", "unhandledRejection (process kept alive)", reason);
	});
}
