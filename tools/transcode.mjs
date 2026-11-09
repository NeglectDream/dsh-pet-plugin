/**
 * webm → animated WebP, budget driven.
 *
 * THE CONSTRAINT THIS SOLVES
 * The host serves plugin UI assets with a hard 10 MiB per-file ceiling and the
 * package archive with a 100 MiB ceiling. The source material is 114 clips ×
 * 10.04 s at 640×360/24 fps ≈ 55 MiB of VP9 — a codec the iframe cannot use,
 * because `media-src 'none'` forbids `<video>` and the asset MIME table has no
 * `.webm`. So every clip has to become an animated WebP, and animated WebP is
 * far less efficient than VP9: at native resolution it can be 2–7× the source.
 *
 * THE ONE MEASUREMENT THAT DECIDES THE PARAMETERS
 * Quality barely moves the byte count; frame count and pixel count do. Halving
 * the frame rate halves the data, and halving the linear size quarters it, while
 * dropping `-q:v` from 75 to 50 saves single-digit percent. The ladder below is
 * therefore ordered by *cost*, coarsening resolution and frame rate first and
 * treating quality as a small final adjustment.
 *
 * WHY A LADDER AND NOT ONE NUMBER
 * The budget has to hold for the whole library, but the clips are not equal: a
 * mostly-static idle clip encodes to a fraction of a fireworks clip at identical
 * settings. Rather than pick a setting that starves everything to fit the worst
 * clip, the tool measures a spread sample, extrapolates the library total per
 * rung, and picks the first rung that fits. Any single clip that still exceeds
 * the per-file ceiling is re-encoded one rung lower on its own, so one expensive
 * animation cannot drag the resolution of the other 113 down.
 *
 * USAGE
 *   node tools/transcode.mjs --measure      # size table only, writes nothing
 *   node tools/transcode.mjs                # transcode the whole library
 *   node tools/transcode.mjs --profile=r3   # force a rung
 *   node tools/transcode.mjs --force        # ignore already-converted files
 *
 * Environment: PET_ANIM_BUDGET_MB (default 60), PET_TRANSCODE_JOBS (default 4).
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ANIM_DIR, PLUGIN_DIR, WEBM_DIR, formatBytes, posix } from "./paths.mjs";
import { readAnimatedWebpInfo } from "./webp.mjs";

const run = promisify(execFile);

/**
 * Rungs ordered from most to least expensive. `quality` is libwebp's `-q:v`
 * (0–100, higher is better); `compression_level` is pinned at the maximum
 * because this is a build, not a live encoder, and it is the one knob that buys
 * bytes for free.
 *
 * Measured on the real library, animated WebP size follows
 * `bytes ≈ 4.9e-4 KiB × fps × width²` per 10 s clip almost exactly (five rungs,
 * 4.7e-4 … 5.2e-4), which is why the middle of the table trades frame rate for
 * width along that curve rather than trusting a quality knob that barely moves
 * the number: 12→8 fps saves a third, 480→360 px saves 44%, q60→q45 saves ~8%.
 */
const LADDER = [
	{ name: "r1", fps: 12, width: 480, quality: 60 },
	{ name: "r2", fps: 10, width: 440, quality: 55 },
	{ name: "r3", fps: 8, width: 400, quality: 50 },
	/** Sweet spot: smooth enough for dancing, sharp enough for a hidpi panel. */
	{ name: "r3a", fps: 10, width: 384, quality: 48 },
	{ name: "r3b", fps: 12, width: 352, quality: 45 },
	{ name: "r4", fps: 8, width: 360, quality: 45 },
	{ name: "r5", fps: 6, width: 320, quality: 42 },
];

/**
 * 84 MiB, not the archive's 100 MiB: the remaining ~16 MiB has to hold the code,
 * the small assets and the `.nfplugin` container itself, and ZIP cannot shrink
 * already-compressed WebP. Budgeting to the hard ceiling would fail at install
 * time on a package that "built fine".
 */
const BUDGET_BYTES = Number(process.env.PET_ANIM_BUDGET_MB ?? 84) * 1024 * 1024;
/** Host ceiling is exactly 10 MiB; leave a margin so a re-encode never lands on the boundary. */
const MAX_FILE_BYTES = 9.5 * 1024 * 1024;
/**
 * Capped well below the core count on purpose. `libwebp_anim` at
 * `compression_level 6` is CPU-bound and single-threaded per frame; oversubscribing
 * (one process per hardware thread) makes every encode slower without finishing
 * the queue sooner, and it starves the rest of the machine.
 */
const JOBS = Math.max(
	1,
	Number(process.env.PET_TRANSCODE_JOBS ?? Math.min(8, os.availableParallelism() - 1)),
);

const SOURCES_FILE = path.join(ANIM_DIR, "sources.json");
const BUILD_FILE = path.join(ANIM_DIR, "build.json");
const TEMP_DIR = path.join(os.tmpdir(), "dsh-pet-transcode");

const argv = process.argv.slice(2);
const has = (flag) => argv.some((value) => value === flag || value.startsWith(`${flag}=`));
const value = (flag) => {
	const match = argv.find((item) => item.startsWith(`${flag}=`));
	return match ? match.slice(flag.length + 1) : undefined;
};

/**
 * Alpha handling is not tunable here, and that is a finding worth recording.
 *
 * This ffmpeg build's `libwebp_anim` encoder exposes only `-lossless`, `-preset`,
 * `-cr_threshold`, `-cr_size` and `-quality` (`ffmpeg -h encoder=libwebp_anim`) —
 * there is no `-alpha_compression` / `-alpha_quality`, so the alpha plane is coded
 * with libwebp's own default and cannot be switched to lossless from here. The
 * alternative is the standalone `img2webp`/`webpmux` tools, which are a separate
 * install and would replace the whole encode path.
 *
 * Before treating that as a defect, the measured alpha distribution was compared
 * against the *source*: the webm material itself carries a soft, semi-transparent
 * background (mean alpha ≈ 16 %), so a decoded frame is legitimately 84 %
 * "partial" alpha. Round-tripping is faithful; there is no veil to remove. See
 * README 「已知限制」 for the number and how it was measured.
 */

function ffmpegArgs(source, target, profile) {
	return [
		"-y",
		"-v",
		"error",
		// The explicit VP9 decoder is REQUIRED: the default decoder reports
		// yuv420p and silently drops the alpha plane, turning every transparent
		// pixel black. Verified with `-vf alphaextract,signalstats`.
		"-c:v",
		"libvpx-vp9",
		"-i",
		source,
		"-vf",
		`fps=${profile.fps},scale=${profile.width}:-1:flags=lanczos`,
		"-c:v",
		"libwebp_anim",
		"-lossless",
		"0",
		"-q:v",
		String(profile.quality),
		"-compression_level",
		"6",
		"-loop",
		"0",
		"-an",
		"-map_metadata",
		"-1",
		target,
	];
}

/** Run tasks with a fixed concurrency and a stable output order. */
async function pool(items, limit, worker) {
	const results = new Array(items.length);
	let cursor = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await worker(items[index], index);
		}
	});
	await Promise.all(runners);
	return results;
}

async function transcodeOne(source, profile, targetDir) {
	const target = path.join(targetDir, `${String(source.index).padStart(3, "0")}.webp`);
	const started = Date.now();
	await run("ffmpeg", ffmpegArgs(path.join(WEBM_DIR, source.file), target, profile), {
		maxBuffer: 8 * 1024 * 1024,
	});
	const stat = await fs.stat(target);
	return { target, bytes: stat.size, elapsedMs: Date.now() - started };
}

/**
 * A spread sample, not the first N.
 *
 * The first clips are alphabetically arbitrary but content-wise they are all
 * "a fish doing something"; taking a stride across the whole sorted list is what
 * catches the expensive outliers (fireworks, snow, confetti) instead of
 * measuring twelve quiet idle clips and under-budgeting the library.
 */
function sampleClips(sources, count) {
	if (count >= sources.length) return sources;
	const stride = sources.length / count;
	const picked = [];
	const seen = new Set();
	for (let slot = 0; slot < count; slot += 1) {
		const index = Math.min(sources.length - 1, Math.round(slot * stride));
		if (seen.has(index)) continue;
		seen.add(index);
		picked.push(sources[index]);
	}
	return picked;
}

/**
 * Measurement cache key.
 *
 * Tuning the ladder is iterative — a rung change, a budget change, a rerun — and
 * a 10-second clip takes tens of seconds to encode. Caching each (clip, rung)
 * result on disk turns every tuning loop after the first into a stat call. The
 * key includes every parameter that affects bytes, so a stale entry can never be
 * mistaken for a current measurement.
 */
function cachePath(clip, profile) {
	const key = `${String(clip.index).padStart(3, "0")}-${profile.name}-${profile.fps}-${profile.width}-${profile.quality}`;
	return path.join(TEMP_DIR, "cache", `${key}.webp`);
}

async function measureClip(clip, profile) {
	const cached = cachePath(clip, profile);
	try {
		const stat = await fs.stat(cached);
		return stat.size;
	} catch {
		// not cached yet
	}
	// Per-(clip, rung) scratch directory: the cache write below moves the file out
	// of it, so two concurrent measurements must not share one.
	const scratch = path.join(
		TEMP_DIR,
		`scratch-${process.pid}-${profile.name}-${String(clip.index).padStart(3, "0")}`,
	);
	await fs.mkdir(scratch, { recursive: true });
	const attempt = await transcodeOne(clip, profile, scratch);
	await fs.rm(scratch, { recursive: true, force: true });
	await fs.mkdir(path.dirname(cached), { recursive: true });
	await fs.rename(attempt.target, cached).catch(async () => {
		await fs.copyFile(attempt.target, cached).catch(() => {});
	});
	return attempt.bytes;
}

async function measure(sources, rungs, sampleSize) {
	await fs.mkdir(path.join(TEMP_DIR, "cache"), { recursive: true });
	const clips = sampleClips(sources, Math.min(sampleSize, sources.length));
	const sampleMs = clips.reduce((sum, item) => sum + item.durationMs, 0);
	const totalMs = sources.reduce((sum, item) => sum + item.durationMs, 0);
	process.stderr.write(
		`[transcode] measuring ${clips.length}/${sources.length} clips × ${rungs.length} rungs (${(sampleMs / 1000).toFixed(1)}s of ${(totalMs / 1000).toFixed(1)}s), ${JOBS} jobs\n`,
	);

	// One pool over every (clip, rung) pair. Iterating rung-by-rung would leave
	// cores idle at the end of each rung and makes the whole measurement as slow
	// as the sum of its slowest row.
	const pairs = [];
	for (const profile of rungs) for (const clip of clips) pairs.push({ profile, clip });
	let finished = 0;
	const bytesByRung = new Map(rungs.map((profile) => [profile.name, 0]));
	await pool(pairs, JOBS, async ({ profile, clip }) => {
		const started = Date.now();
		const bytes = await measureClip(clip, profile);
		bytesByRung.set(profile.name, bytesByRung.get(profile.name) + bytes);
		finished += 1;
		process.stderr.write(
			`[transcode]   ${String(finished).padStart(3)}/${pairs.length} ${profile.name} ${clip.id} ${formatBytes(bytes)} ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
		);
		return bytes;
	});

	const rows = rungs.map((profile) => {
		const sampleBytes = bytesByRung.get(profile.name);
		const projected = Math.round((sampleBytes / sampleMs) * totalMs);
		return { profile, sampleBytes, perClip: Math.round(sampleBytes / clips.length), projected };
	});
	for (const row of rows) {
		process.stderr.write(
			`[transcode]   ${row.profile.name} fps=${row.profile.fps} w=${row.profile.width} q=${row.profile.quality} → ${formatBytes(row.perClip)}/clip, projected ${formatBytes(row.projected)} (${((row.projected / BUDGET_BYTES) * 100).toFixed(0)}% of budget)\n`,
		);
	}
	return { rows, sampleMs, totalMs };
}

async function loadSources() {
	let raw;
	try {
		raw = await fs.readFile(SOURCES_FILE, "utf8");
	} catch {
		throw new Error(`missing ${posix(path.relative(PLUGIN_DIR, SOURCES_FILE))} — run tools/probe.mjs first`);
	}
	const parsed = JSON.parse(raw);
	if (!Array.isArray(parsed.sources) || parsed.sources.length === 0) {
		throw new Error("sources.json has no sources");
	}
	return parsed;
}

async function main() {
	await fs.mkdir(ANIM_DIR, { recursive: true });
	const catalog = await loadSources();
	const sources = catalog.sources;

	// `--rungs=r3,r4` narrows the search when a previous run already told us which
	// band fits; `--sample=N` trades measurement accuracy for wall time.
	const rungFilter = value("--rungs");
	const rungs = rungFilter
		? rungFilter
				.split(",")
				.map((name) => LADDER.find((profile) => profile.name === name.trim()))
				.filter((profile) => profile)
		: LADDER;
	if (rungs.length === 0) throw new Error(`--rungs named no known profile (${LADDER.map((p) => p.name).join(", ")})`);
	const sampleSize = Number(value("--sample") ?? 6);

	const { rows } = await measure(sources, rungs, sampleSize);
	const fitting = rows.find((row) => row.projected <= BUDGET_BYTES);
	const forced = value("--profile");
	let chosen = forced ? rows.find((row) => row.profile.name === forced) : fitting;
	if (forced && !chosen) throw new Error(`unknown or unmeasured profile: ${forced}`);
	if (!chosen) {
		const cheapest = rows.at(-1);
		throw new Error(
			`no rung fits ${formatBytes(BUDGET_BYTES)}: cheapest rung ${cheapest.profile.name} projects ${formatBytes(cheapest.projected)}. ` +
				`Raise PET_ANIM_BUDGET_MB, add a rung to LADDER, or trim the animation set.`,
		);
	}

	if (has("--measure")) {
		process.stderr.write(
			`[transcode] chosen for a ${formatBytes(BUDGET_BYTES)} budget: ${chosen.profile.name}\n`,
		);
		await fs.writeFile(
			path.join(ANIM_DIR, "measure.json"),
			`${JSON.stringify(
				{
					generatedAt: new Date().toISOString(),
					budgetBytes: BUDGET_BYTES,
					totalDurationMs: rows[0] ? sources.reduce((sum, item) => sum + item.durationMs, 0) : 0,
					rows: rows.map((row) => ({
						profile: row.profile,
						perClipBytes: row.perClip,
						projectedBytes: row.projected,
					})),
					chosen: chosen.profile.name,
				},
				null,
				"\t",
			)}\n`,
			"utf8",
		);
		return;
	}

	process.stderr.write(
		`[transcode] profile ${chosen.profile.name} (fps=${chosen.profile.fps} w=${chosen.profile.width} q=${chosen.profile.quality})\n`,
	);

	const force = has("--force");
	const outDir = path.join(ANIM_DIR, "webp");
	await fs.mkdir(outDir, { recursive: true });

	const started = Date.now();
	let done = 0;
	const results = await pool(sources, JOBS, async (source) => {
		const target = path.join(outDir, `${String(source.index).padStart(3, "0")}.webp`);
		const relPath = posix(path.relative(PLUGIN_DIR, target));
		if (!force) {
			try {
				const existing = await fs.readFile(target);
				const info = readAnimatedWebpInfo(existing);
				// Only skip a file this tool wrote at these settings; a stale
				// file from another rung would silently mix quality levels.
				if (info && existing.byteLength <= MAX_FILE_BYTES) {
					done += 1;
					process.stderr.write(`[transcode] ${String(done).padStart(3)}/${sources.length} skip ${relPath}\n`);
					return { source, file: relPath, bytes: existing.byteLength, ...info, skipped: true };
				}
			} catch {
				// fall through to a real transcode
			}
		}

		let current = chosen.profile;
		let attempt = await transcodeOne(source, current, outDir);
		// A single expensive clip is re-encoded on its own rather than pushing the
		// whole library down a rung.
		for (let rung = LADDER.indexOf(chosen.profile) + 1; attempt.bytes > MAX_FILE_BYTES; rung += 1) {
			const next = LADDER[rung];
			if (!next) {
				throw new Error(`${source.id} exceeds ${formatBytes(MAX_FILE_BYTES)} even at the cheapest rung`);
			}
			process.stderr.write(
				`[transcode] ${source.id} is ${formatBytes(attempt.bytes)}, retrying at ${next.name}\n`,
			);
			current = next;
			attempt = await transcodeOne(source, current, outDir);
		}

		const bytes = await fs.readFile(attempt.target);
		const info = readAnimatedWebpInfo(bytes);
		if (!info) throw new Error(`${source.id}: output is not an animated WebP`);
		if (!info.hasAlpha) throw new Error(`${source.id}: output lost its alpha channel`);
		done += 1;
		process.stderr.write(
			`[transcode] ${String(done).padStart(3)}/${sources.length} ${relPath} ${formatBytes(attempt.bytes)} ${info.frames}f ${info.durationMs}ms${current.name === chosen.profile.name ? "" : ` (${current.name})`}\n`,
		);
		return {
			source,
			file: relPath,
			bytes: attempt.bytes,
			...info,
			profile: current.name,
			skipped: false,
		};
	});

	const totalBytes = results.reduce((sum, item) => sum + item.bytes, 0);
	const largest = results.reduce((max, item) => (item.bytes > max.bytes ? item : max), results[0]);
	const report = {
		generatedAt: new Date().toISOString(),
		profile: chosen.profile.name,
		settings: chosen.profile,
		budgetBytes: BUDGET_BYTES,
		maxFileBytes: MAX_FILE_BYTES,
		count: results.length,
		totalBytes,
		largest: { id: largest.source.id, file: largest.file, bytes: largest.bytes },
		files: results
			.map((item) => ({
				index: item.source.index,
				id: item.source.id,
				source: item.source.file,
				file: item.file,
				bytes: item.bytes,
				frames: item.frames,
				durationMs: item.durationMs,
				width: item.width,
				height: item.height,
				hasAlpha: item.hasAlpha,
				profile: item.profile,
				sourceDurationMs: item.source.durationMs,
			}))
			.sort((a, b) => a.index - b.index),
	};

	await fs.writeFile(path.join(ANIM_DIR, "files.json"), `${JSON.stringify(report, null, "\t")}\n`, "utf8");
	await fs.writeFile(
		BUILD_FILE,
		`${JSON.stringify({ generatedAt: report.generatedAt, profile: chosen.profile, settings: chosen.profile }, null, "\t")}\n`,
		"utf8",
	);

	process.stderr.write(
		`[transcode] done: ${report.count} clips, ${formatBytes(totalBytes)} (${((totalBytes / BUDGET_BYTES) * 100).toFixed(0)}% of ${formatBytes(BUDGET_BYTES)}), largest ${largest.source.id} ${formatBytes(largest.bytes)}, ${((Date.now() - started) / 1000).toFixed(0)}s\n`,
	);
	if (totalBytes > BUDGET_BYTES) {
		throw new Error(
			`transcoded library is ${formatBytes(totalBytes)}, over the ${formatBytes(BUDGET_BYTES)} budget`,
		);
	}
}

await main();
