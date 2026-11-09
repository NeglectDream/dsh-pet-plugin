/**
 * Shared filesystem anchors for the build tools.
 *
 * Every tool resolves paths *upward from its own file location*, never from
 * `process.cwd()`. The tools are run both from the repository root and from
 * inside `narrafork/`, and on Windows the two differ by a percent-encoded
 * directory name (`下载`, `新建文件夹`) that breaks naive `new URL(...).pathname`
 * handling — hence `fileURLToPath`.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** `…/dsh-pet/narrafork` — the plugin source root that becomes the package root. */
export const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The repository root.
 *
 * Two layouts exist: the original one, where the plugin sources sit in a `narrafork/`
 * subdirectory of the dsh-pet repository, and the published plugin repository, where
 * the package *is* the root — its `.git` sits next to `manifest.json`. Every tool works
 * from either layout; the second one simply has no source media to transcode from.
 */
export const REPO_DIR = existsSync(path.join(PLUGIN_DIR, ".git"))
	? PLUGIN_DIR
	: path.resolve(PLUGIN_DIR, "..");

/** `<repo>/dsh-pet/assets` — where the original webm/gif/png/font material lives. */
export const ASSETS_DIR = path.join(REPO_DIR, "dsh-pet", "assets");

/** Default source animation directory; `PET_WEBM_DIR` overrides it for experiments. */
export const WEBM_DIR = process.env.PET_WEBM_DIR
	? path.resolve(process.env.PET_WEBM_DIR)
	: path.join(ASSETS_DIR, "webm");

/** Transcode output directory inside the plugin package. */
export const ANIM_DIR = path.join(PLUGIN_DIR, "anim");

/** Build staging root (never packaged as-is). */
export const BUILD_DIR = path.join(REPO_DIR, ".build");

/** Distribution directory for packed `.nfplugin` archives. */
export const DIST_DIR = path.join(REPO_DIR, "dist");

/** Convert a path to the forward-slash form used inside manifests and ZIP entries. */
export function posix(value) {
	return value.split(path.sep).join("/");
}

/** Human-readable byte size, for build logs. */
export function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
