/**
 * Probe every source animation into `anim/sources.json`.
 *
 * WHY THIS IS A SEPARATE STEP
 * The transcode budget is decided from *durations*, not from file sizes: an
 * animated WebP's byte count is driven by pixel count and frame count, and the
 * frame count is `duration × fps`. Guessing from on-disk webm size would pick
 * the wrong clips to squeeze — a long, mostly-static clip is cheap to encode
 * while a short, high-motion one is expensive, and webm size reflects neither
 * cleanly.
 *
 * `ffmpeg` cannot be asked for the frame count of the *filtered* stream without
 * decoding it, so we record the source's own numbers and let the transcoder
 * derive the output frame count from the chosen fps. The transcoder then reads
 * the real durations back out of the finished WebP, so this file is an input to
 * planning, never a source of truth about the output.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ANIM_DIR, PLUGIN_DIR, WEBM_DIR, formatBytes } from "./paths.mjs";

const run = promisify(execFile);

const SOURCE_DIR = WEBM_DIR;
const OUT_FILE = path.resolve(PLUGIN_DIR, process.env.PET_SOURCES_OUT ?? "anim/sources.json");

/** One `show_streams`/`show_format` call per file. ffprobe handles the Chinese
 * filenames fine on Windows, but the id is kept verbatim because it is the join
 * key between this file, `index.json` and the asset name. */
async function probe(file) {
	const { stdout } = await run(
		"ffprobe",
		[
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=width,height,r_frame_rate,nb_read_frames,pix_fmt:format=duration",
			"-count_frames",
			"-of",
			"json",
			file,
		],
		{ maxBuffer: 4 * 1024 * 1024 },
	);
	const parsed = JSON.parse(stdout);
	const stream = parsed.streams?.[0];
	if (!stream) throw new Error(`no video stream in ${path.basename(file)}`);
	const [num, den] = String(stream.r_frame_rate ?? "0/1").split("/").map(Number);
	const fps = den ? num / den : 0;
	const durationSec = Number(parsed.format?.duration);
	return {
		width: Number(stream.width),
		height: Number(stream.height),
		fps,
		frames: Number(stream.nb_read_frames) || Math.round(durationSec * fps),
		durationMs: Math.round(durationSec * 1000),
		pixFmt: String(stream.pix_fmt ?? ""),
	};
}

async function main() {
	const entries = (await fs.readdir(SOURCE_DIR)).filter((name) => name.toLowerCase().endsWith(".webm"));
	if (entries.length === 0) throw new Error(`no .webm sources in ${SOURCE_DIR}`);
	// Sorted so `sources.json` and every derived index have a stable order across runs
	// and across machines, which is what makes the numeric asset names safe.
	entries.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));

	const sources = [];
	let totalMs = 0;
	for (const [index, name] of entries.entries()) {
		const id = name.slice(0, -".webm".length);
		const stat = await fs.stat(path.join(SOURCE_DIR, name));
		const info = await probe(path.join(SOURCE_DIR, name));
		totalMs += info.durationMs;
		sources.push({
			index,
			id,
			file: name,
			bytes: stat.size,
			...info,
		});
		process.stderr.write(
			`[probe] ${String(index).padStart(3, "0")} ${id} ${(info.durationMs / 1000).toFixed(2)}s ${info.width}x${info.height}@${info.fps} ${info.pixFmt}\n`,
		);
	}

	const alphaCount = sources.filter((item) => item.pixFmt.includes("a")).length;
	const report = {
		generatedAt: new Date().toISOString(),
		sourceDir: path.relative(PLUGIN_DIR, SOURCE_DIR).split(path.sep).join("/"),
		count: sources.length,
		alphaCount,
		totalDurationMs: totalMs,
		totalBytes: sources.reduce((sum, item) => sum + item.bytes, 0),
		sources,
	};
	await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
	await fs.writeFile(OUT_FILE, `${JSON.stringify(report, null, "\t")}\n`, "utf8");
	process.stderr.write(
		`[probe] ${report.count} clips, ${(totalMs / 1000).toFixed(1)}s total, ${(report.totalBytes / 1048576).toFixed(1)} MiB, ${alphaCount}/${report.count} with alpha\n`,
	);
}

await main();
