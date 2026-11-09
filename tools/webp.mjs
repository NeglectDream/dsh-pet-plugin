/**
 * Minimal animated-WebP container reader.
 *
 * WHY THIS EXISTS AT ALL
 * `<img src="x.webp">` fires `load` when the *first* frame is decoded and never
 * fires anything when the animation ends. A player that chains clips therefore
 * has to know the clip length up front. Two places need it:
 *
 *  - the build (`build-index.mjs`) writes each clip's exact duration into
 *    `index.json`, so the shipped player never parses a container at runtime;
 *  - the player keeps a copy of this parser as a fallback for an index entry
 *    whose duration is missing or obviously wrong.
 *
 * Byte layout used here (WebP container specification, RIFF):
 *
 *   "RIFF" <u32 size> "WEBP"
 *   "VP8X" <u32 size> [flags:u8, reserved:u24, canvasW-1:u24, canvasH-1:u24]
 *   "ANIM" <u32 size> [backgroundColor:u32, loopCount:u16]
 *   "ANMF" <u32 size> [x:u24, y:u24, w-1:u24, h-1:u24, durationMs:u24, flags:u8]
 *   …
 *
 * ANMF durations are already in milliseconds, so the total is a plain sum — no
 * timebase conversion, which is exactly why this is 60 lines instead of a
 * demuxer.
 */

/** @typedef {{ loopCount: number, frames: number, durationMs: number, width: number, height: number, hasAlpha: boolean }} WebpInfo */

const RIFF = 0x52494646; // "RIFF"
const WEBP = 0x57454250; // "WEBP"
const VP8X = 0x56503858; // "VP8X"
const ANIM = 0x414e494d;
const ANMF = 0x414e4d46;

function fourCC(bytes, offset) {
	return (
		(bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]
	) >>> 0;
}

function u32(bytes, offset) {
	return (
		(bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>>
		0
	);
}

function u24(bytes, offset) {
	return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

/**
 * Read an animated WebP's frame count and total duration.
 *
 * Returns `null` for a still image or a truncated/corrupt file rather than
 * throwing: a caller that cannot measure one clip should be able to keep going
 * with the rest of the library.
 *
 * @param {Uint8Array} bytes complete file contents
 * @returns {WebpInfo | null}
 */
export function readAnimatedWebpInfo(bytes) {
	if (bytes.byteLength < 20) return null;
	if (fourCC(bytes, 0) !== RIFF || fourCC(bytes, 8) !== WEBP) return null;

	let offset = 12;
	let animation = false;
	let loopCount = 0;
	let frames = 0;
	let durationMs = 0;
	let width = 0;
	let height = 0;
	let alpha = false;

	while (offset + 8 <= bytes.byteLength) {
		const type = fourCC(bytes, offset);
		const size = u32(bytes, offset + 4);
		const body = offset + 8;
		if (body + size > bytes.byteLength) break;

		if (type === VP8X) {
			if (size < 10) return null;
			const flags = bytes[body];
			// Same byte carries both bit 1 (animation) and bit 4 (alpha on the
			// canvas), which is why one branch reads both.
			animation = (flags & 0x02) !== 0;
			alpha = (flags & 0x10) !== 0;
			width = u24(bytes, body + 4) + 1;
			height = u24(bytes, body + 7) + 1;
		} else if (type === ANIM) {
			if (size < 6) return null;
			loopCount = bytes[body + 4] | (bytes[body + 5] << 8);
		} else if (type === ANMF) {
			if (size < 16) return null;
			// Body layout: x:u24, y:u24, w-1:u24, h-1:u24, durationMs:u24, flags:u8.
			// The duration is already in milliseconds, so the total is a plain sum.
			durationMs += u24(bytes, body + 12);
			frames += 1;
		}

		// Chunks are even-byte aligned: an odd body is followed by one pad byte.
		offset = body + size + (size % 2);
	}

	if (!animation || frames === 0) return null;
	return {
		loopCount,
		frames,
		durationMs,
		width,
		height,
		hasAlpha: alpha,
	};
}

/**
 * The same measurement, but parsed from a Buffer/typed array helper that also
 * reports the frame durations individually — used by `verify.mjs` to prove the
 * sum in `index.json` matches the file byte-for-byte.
 */
export function readFrameDurations(bytes) {
	const out = [];
	let offset = 12;
	while (offset + 8 <= bytes.byteLength) {
		const type = fourCC(bytes, offset);
		const size = u32(bytes, offset + 4);
		const body = offset + 8;
		if (body + size > bytes.byteLength) break;
		if (type === ANMF && size >= 16) out.push(u24(bytes, body + 12));
		offset = body + size + (size % 2);
	}
	return out;
}

export const WEBP_CHUNK_NAMES = { VP8X, ANIM, ANMF };
