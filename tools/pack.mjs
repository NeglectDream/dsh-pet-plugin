/**
 * Build the `.nfplugin` archive.
 *
 * WHY A HAND-WRITTEN ZIP WRITER
 * The package has to be produced by `node tools/pack.mjs` on a machine with no
 * build toolchain, no npm install and no shell `zip` dependency — the same
 * constraint the rest of these tools follow. `node:zlib` gives deflate; the
 * remaining work is ~120 lines of local headers, a central directory and an
 * end-of-directory record, and it buys an archive whose byte layout is fully
 * reviewable instead of a binary produced by an opaque tool.
 *
 * ONLY `store` AND `deflate` (methods 0 and 8) are emitted, which is exactly what
 * the host's `zip-archive.ts` declares support for. Notably it does NOT support
 * ZIP64 in this writer's output path, so the archive is asserted to stay under
 * every classic-ZIP limit (4 GiB, 65 535 entries) — trivially true here, but a
 * silent overflow would produce a file that only fails at install time.
 *
 * WHAT SHIPS, EXPLICITLY
 * An allow-list, not a deny-list. The repository also contains the transcoder,
 * the animation index inputs and the UI *sources*; none of that belongs in a
 * package a user installs. An include list means adding a build tool can never
 * accidentally add a megabyte to the download.
 */

import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { DIST_DIR, PLUGIN_DIR, REPO_DIR, formatBytes, posix } from "./paths.mjs";

/* -------------------------------------------------------------------------- */
/* CRC-32                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Own implementation rather than `zlib.crc32`: that helper only appeared in Node
 * 20.15, and this build also runs under bun, whose `node:zlib` surface is not
 * guaranteed to include it. A 256-entry table costs 16 lines and removes both
 * questions.
 */
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32(bytes) {
	let crc = 0xffffffff;
	for (let index = 0; index < bytes.length; index += 1) {
		crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/* -------------------------------------------------------------------------- */
/* ZIP writing                                                                */
/* -------------------------------------------------------------------------- */

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/**
 * Extensions worth compressing. WebP, GIF and PNG are already entropy-coded, so
 * deflating them costs time and saves nothing measurable — and this split is
 * visible in the archive's own metadata, which makes it obvious on inspection
 * that the big files were stored rather than badly compressed.
 */
const COMPRESSIBLE = new Set([".json", ".js", ".css", ".md", ".txt"]);

/** Fixed DOS timestamp so two builds of the same inputs produce the same bytes. */
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

function makeEntry(name, data) {
	const extension = path.extname(name).toLowerCase();
	const compress = COMPRESSIBLE.has(extension);
	const body = compress ? zlib.deflateRawSync(data, { level: 9 }) : data;
	return {
		name,
		crc: crc32(data),
		method: compress ? METHOD_DEFLATE : METHOD_STORE,
		compressedBytes: body.length,
		uncompressedBytes: data.length,
		body,
	};
}

function localHeader(entry) {
	const name = Buffer.from(entry.name, "utf8");
	const header = Buffer.alloc(30);
	header.writeUInt32LE(0x04034b50, 0);
	header.writeUInt16LE(20, 4); // version needed to extract
	// Bit 11 (UTF-8 names) is set unconditionally: it costs nothing for ASCII
	// names and keeps a future non-ASCII path from being mis-decoded.
	header.writeUInt16LE(0x0800, 6);
	header.writeUInt16LE(entry.method, 8);
	header.writeUInt16LE(DOS_TIME, 10);
	header.writeUInt16LE(DOS_DATE, 12);
	header.writeUInt32LE(entry.crc, 14);
	header.writeUInt32LE(entry.compressedBytes, 18);
	header.writeUInt32LE(entry.uncompressedBytes, 22);
	header.writeUInt16LE(name.length, 26);
	header.writeUInt16LE(0, 28);
	return Buffer.concat([header, name]);
}

function centralHeader(entry, offset) {
	const name = Buffer.from(entry.name, "utf8");
	const header = Buffer.alloc(46);
	header.writeUInt32LE(0x02014b50, 0);
	header.writeUInt16LE(20, 4); // version made by
	header.writeUInt16LE(20, 6); // version needed
	header.writeUInt16LE(0x0800, 8);
	header.writeUInt16LE(entry.method, 10);
	header.writeUInt16LE(DOS_TIME, 12);
	header.writeUInt16LE(DOS_DATE, 14);
	header.writeUInt32LE(entry.crc, 16);
	header.writeUInt32LE(entry.compressedBytes, 20);
	header.writeUInt32LE(entry.uncompressedBytes, 24);
	header.writeUInt16LE(name.length, 28);
	header.writeUInt16LE(0, 30); // extra
	header.writeUInt16LE(0, 32); // comment
	header.writeUInt16LE(0, 34); // disk
	header.writeUInt16LE(0, 36); // internal attrs
	// 0644 regular file, so extraction on a POSIX host does not need a chmod pass.
	// `>>> 0` because the mode sits in the high half of a 32-bit field and `<< 16`
	// produces a negative int32 for any mode whose low bits reach bit 15.
	header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
	header.writeUInt32LE(offset, 42);
	return Buffer.concat([header, name]);
}

function buildArchive(entries) {
	const chunks = [];
	const directory = [];
	let offset = 0;
	for (const entry of entries) {
		const header = localHeader(entry);
		chunks.push(header, entry.body);
		directory.push(centralHeader(entry, offset));
		offset += header.length + entry.body.length;
	}
	const directoryBytes = Buffer.concat(directory);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directoryBytes.length, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20);
	return Buffer.concat([...chunks, directoryBytes, end]);
}

/* -------------------------------------------------------------------------- */
/* Package contents                                                           */
/* -------------------------------------------------------------------------- */

/** Every shipped file, relative to the plugin source root. */
const INCLUDE = [
	"manifest.json",
	"server/index.js",
	"server/rpc.js",
	"server/log.js",
	"server/config.js",
	"server/host-home.js",
	"server/accounting.js",
	"server/notices.js",
	"server/balance/index.js",
	"server/balance/providers.js",
	"server/balance/amounts.js",
	"ui/stage.iife.js",
	"ui/stage.bundle.css",
	"ui/settings.iife.js",
	"ui/settings.bundle.css",
	"ui/bubble-presets.json",
	"anim/index.json",
	"anim/bounds.json",
	"assets/sound/click-duck.wav",
	"sbom.spdx.json",
	"README-NARRAFORK.md",
];

const LICENSE_SOURCE = path.join(REPO_DIR, "LICENSE");

/** Host-side ceilings, mirrored so this tool fails before an install would. */
const LIMITS = {
	maxArchiveBytes: 100 * 1024 * 1024,
	maxUnpackedBytes: 500 * 1024 * 1024,
	maxFileBytes: 50 * 1024 * 1024,
	maxFiles: 10_000,
};

async function collect() {
	const missing = [];
	const files = [];
	for (const relative of INCLUDE) {
		const absolute = path.join(PLUGIN_DIR, relative);
		try {
			const stat = await fs.stat(absolute);
			if (!stat.isFile()) throw new Error("not a file");
			files.push({ name: relative, absolute, bytes: stat.size });
		} catch {
			missing.push(relative);
		}
	}

	// Animation WebPs are discovered rather than listed: there are 114 of them and a
	// hand-maintained list would drift the first time the set changes. The index is
	// what defines the real membership, so the two are cross-checked below.
	const webpDir = path.join(PLUGIN_DIR, "anim", "webp");
	let webpNames = [];
	try {
		webpNames = (await fs.readdir(webpDir)).filter((name) => name.endsWith(".webp")).sort();
	} catch {
		missing.push("anim/webp/*.webp");
	}
	for (const name of webpNames) {
		const absolute = path.join(webpDir, name);
		const stat = await fs.stat(absolute);
		files.push({ name: `anim/webp/${name}`, absolute, bytes: stat.size });
	}

	const license = await fs.stat(LICENSE_SOURCE).catch(() => undefined);
	if (license?.isFile()) files.push({ name: "LICENSE", absolute: LICENSE_SOURCE, bytes: license.size });
	else process.stderr.write("[pack] 注意：找不到 LICENSE，将不带许可证文件打包\n");

	if (missing.length > 0) {
		throw new Error(
			`缺少必要的打包文件：\n  ${missing.join("\n  ")}\n` +
				`（先运行 node tools/build-ui.mjs）`,
		);
	}

	// The index must describe exactly the WebPs that exist: a clip listed but not
	// shipped would 404 at runtime, and a shipped clip not in the index is dead weight.
	const index = JSON.parse(await fs.readFile(path.join(PLUGIN_DIR, "anim", "index.json"), "utf8"));
	const indexed = new Set(index.clips.map((clip) => clip.file));
	for (const name of webpNames) {
		if (!indexed.has(`anim/webp/${name}`)) {
			throw new Error(`anim/webp/${name} 没有出现在 anim/index.json 里`);
		}
	}
	for (const file of indexed) {
		if (!webpNames.includes(path.posix.basename(file))) {
			throw new Error(`anim/index.json 引用的 ${file} 不存在`);
		}
	}

	return { files, index };
}

async function main() {
	const { files, index } = await collect();

	const entries = [];
	let absoluteTotal = 0;
	for (const file of files) {
		const data = await fs.readFile(file.absolute);
		if (data.length > LIMITS.maxFileBytes) {
			throw new Error(`${file.name} 是 ${formatBytes(data.length)}，超过单文件上限 ${formatBytes(LIMITS.maxFileBytes)}`);
		}
		absoluteTotal += data.length;
		entries.push(makeEntry(file.name, data));
	}

	if (entries.length > LIMITS.maxFiles) throw new Error(`文件数 ${entries.length} 超过上限 ${LIMITS.maxFiles}`);
	if (absoluteTotal > LIMITS.maxUnpackedBytes) {
		throw new Error(`解包后 ${formatBytes(absoluteTotal)} 超过上限 ${formatBytes(LIMITS.maxUnpackedBytes)}`);
	}

	// Deterministic order: the index first, then everything else alphabetically, so
	// two builds of identical inputs are byte-identical archives.
	entries.sort((a, b) => (a.name === "manifest.json" ? -1 : b.name === "manifest.json" ? 1 : a.name.localeCompare(b.name)));

	const archive = buildArchive(entries);
	if (archive.length > LIMITS.maxArchiveBytes) {
		throw new Error(
			`归档 ${formatBytes(archive.length)} 超过上限 ${formatBytes(LIMITS.maxArchiveBytes)}（压缩包上限 100 MiB）`,
		);
	}

	const manifest = JSON.parse(await fs.readFile(path.join(PLUGIN_DIR, "manifest.json"), "utf8"));
	const stem = `${manifest.pluginId}-${manifest.version}`;
	await fs.mkdir(DIST_DIR, { recursive: true });
	const target = path.join(DIST_DIR, `${stem}.nfplugin`);
	await fs.writeFile(target, archive);

	// A size report, because "it fits" is the kind of claim that should be printed
	// with numbers rather than asserted.
	const byArea = new Map();
	for (const file of files) {
		const area = file.name.split("/")[0];
		byArea.set(area, (byArea.get(area) ?? 0) + file.bytes);
	}
	const report = {
		generatedAt: new Date().toISOString(),
		archive: posix(path.relative(REPO_DIR, target)),
		archiveBytes: archive.length,
		unpackedBytes: absoluteTotal,
		fileCount: entries.length,
		clipCount: index.clips.length,
		byArea: Object.fromEntries([...byArea.entries()].sort((a, b) => b[1] - a[1])),
		largest: entries
			.map((entry) => ({ name: entry.name, bytes: entry.uncompressedBytes }))
			.sort((a, b) => b.bytes - a.bytes)
			.slice(0, 5),
	};
	await fs.writeFile(path.join(DIST_DIR, `${stem}.pack.json`), `${JSON.stringify(report, null, "\t")}\n`, "utf8");

	process.stderr.write(
		`[pack] ${report.archive}: ${formatBytes(archive.length)}（解包 ${formatBytes(absoluteTotal)}，${entries.length} 个文件，${index.clips.length} 段动画）\n`,
	);
	for (const [area, bytes] of Object.entries(report.byArea)) {
		process.stderr.write(`[pack]   ${area.padEnd(10)} ${formatBytes(bytes)}\n`);
	}
}

await main();
