/**
 * Locating the NarraFork home directory from inside a plugin process.
 *
 * Three sources, most authoritative first:
 *  1. `NARRAFORK_HOME` — normally filtered out of the plugin environment
 *     (`SAFE_ENV_KEYS`), so this only helps in a hand-run development setup;
 *  2. walking up from the working directory, which the local-process runner sets
 *     to the package directory (`<home>/plugins/packages/<id>/<version>/<hash>`);
 *  3. `~/.narrafork`, the documented default.
 *
 * The walk verifies each candidate before accepting it, so a wrong guess is never
 * returned silently — and the fallback is only used if it also looks like a home.
 * This is the same derivation the reference wallpaper plugin uses to reach
 * `plugins/data`, made explicit and testable.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function looksLikeHome(directory) {
	try {
		const stat = await fs.stat(path.join(directory, "plugins"));
		return stat.isDirectory();
	} catch {
		return false;
	}
}

export async function resolveHostHome() {
	const fromEnv = process.env.NARRAFORK_HOME;
	if (typeof fromEnv === "string" && fromEnv.length > 0) {
		const candidate = path.resolve(fromEnv);
		if (await looksLikeHome(candidate)) return candidate;
	}

	let cursor = process.cwd();
	for (let depth = 0; depth < 7; depth += 1) {
		if (await looksLikeHome(cursor)) return cursor;
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}

	const fallback = path.join(os.homedir(), ".narrafork");
	return (await looksLikeHome(fallback)) ? fallback : undefined;
}
