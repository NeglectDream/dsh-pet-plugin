#!/usr/bin/env python3
"""Measure the per-clip alpha bounding boxes that the stage uses for hit-testing.

WHY A SEPARATE OFFLINE TOOL
The stage sits in an iframe whose CSP forbids `fetch()` and `<canvas>`-free pixel
readback is not something an `<img>` offers: it can display the WebP clips but
cannot ask them where their opaque pixels are. So the only way it can know "where
is the pet actually drawn?" is for the bounds to be measured ahead of time and
inlined into the bundle by `tools/build-ui.mjs`. That means the boxes are build
inputs, and a build input produced by an unrepeatable one-off script is a
liability: this tool is the script, and it re-derives every number from the
shipped `anim/webp/*.webp` files.

WHAT IS MEASURED
For each clip, the union of every frame's opaque area:

  * a pixel counts as opaque when its alpha is >= ALPHA_THRESHOLD (an anti-aliased
    edge is mostly transparent; counting alpha > 0 would grow every box out to the
    soft halo and make the pet's hit area feel far bigger than it looks);
  * the union — not the average or the first frame — because a clip's pose changes
    over time and a click anywhere the pet is visible in any frame must land;
  * PADDING_PX is then added on all four sides so the soft edge stays clickable,
    clamped to the canvas.

Coordinates are normalised against the clip's own canvas (`x / width`,
`y / height`) so the stage can multiply by whatever display size it picked. The
raw (unpadded) boxes are kept alongside them so a future padding change is
auditable without re-measuring.

BODY BOUNDS
`bodyBounds` is the box of the normal idle loop (`pools.idle` in
`anim/index.json`), not of the busiest clip: it is what the stage treats as "the
pet's body" for physical collision/boundary purposes, and the idle loop is the earliest clip the
user sees at its resting shape. The idle pool is read from the index rather than
hard-coded, and the tool refuses to guess if the pool has more than one clip.

FACING
`sourceFacing` records which way the *source artwork* faces, because the stage
mirrors a clip to match the pet's heading and a clip that is already drawn facing
left would otherwise always run backwards. Only the three clips in FACING_OVERRIDES
were established by inspecting frames; everything else defaults to 1 (right)
rather than being inferred from its Chinese name.

READ-ONLY ON THE WEBP FILES
The clips are opened for reading and never re-encoded: a measurement pass must not
change the bytes `verify.mjs` hashes against `anim/index.json`.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

PLUGIN_DIR = Path(__file__).resolve().parent.parent
ANIM_DIR = PLUGIN_DIR / "anim"
WEBP_DIR = ANIM_DIR / "webp"
INDEX_FILE = ANIM_DIR / "index.json"
OUTPUT_FILE = ANIM_DIR / "bounds.json"

VERSION = 1
ALPHA_THRESHOLD = 32
PADDING_PX = 2
DECIMALS = 6

# `+1` = the artwork faces right, `-1` = faces left, `0` = drawn front-on, so
# mirroring would be wrong in both directions. Confirmed by stepping frames, not
# by reading the clip name — a name like "原地左转奔跑" describes the motion, and
# for this asset the motion and the drawn facing happen to agree, which is exactly
# the kind of coincidence that must not be generalised to the other 111 clips.
FACING_OVERRIDES = {
	"螃蟹走路": -1,
	"原地左转奔跑": -1,
	"原地漂浮踏步": 0,
}
DEFAULT_FACING = 1


def alpha_lut(threshold: int) -> list[int]:
	"""256-entry lookup table for Pillow's C-level `point()`."""
	return [255 if value >= threshold else 0 for value in range(256)]


def frame_bbox(frame: Image.Image, lut: list[int]):
	"""Opaque-area bbox of one frame, or None when the frame is fully transparent."""
	if "A" not in frame.getbands():
		return (0, 0, frame.width, frame.height)
	# `getbbox()` on an "L" mask is exclusive on the right/bottom edges, which is
	# what the padding arithmetic below expects.
	return frame.getchannel("A").point(lut).getbbox()


def measure_clip(path: Path, threshold: int, padding: int) -> dict:
	lut = alpha_lut(threshold)
	with Image.open(path) as image:
		width, height = image.size
		frames = getattr(image, "n_frames", 1)
		union = None
		for index in range(frames):
			image.seek(index)
			bbox = frame_bbox(image.convert("RGBA"), lut)
			if bbox is None:
				continue
			if union is None:
				union = list(bbox)
			else:
				union[0] = min(union[0], bbox[0])
				union[1] = min(union[1], bbox[1])
				union[2] = max(union[2], bbox[2])
				union[3] = max(union[3], bbox[3])
			# Rewind is implicit in `seek`; nothing is written back to the file.
	if union is None:
		raise SystemExit(f"[measure-bounds] {path.name} 全部 {frames} 帧都是透明的，无法测量")

	raw = {
		"left": union[0],
		"top": union[1],
		"right": union[2],
		"bottom": union[3],
	}
	padded = {
		"left": max(0, raw["left"] - padding),
		"top": max(0, raw["top"] - padding),
		"right": min(width, raw["right"] + padding),
		"bottom": min(height, raw["bottom"] + padding),
	}
	return {
		"width": width,
		"height": height,
		"frames": frames,
		"bounds": normalise(padded, width, height),
		"rawBounds": normalise(raw, width, height),
	}


def normalise(box: dict, width: int, height: int) -> dict:
	return {
		"left": round(box["left"] / width, DECIMALS),
		"top": round(box["top"] / height, DECIMALS),
		"right": round(box["right"] / width, DECIMALS),
		"bottom": round(box["bottom"] / height, DECIMALS),
	}


def load_index() -> dict:
	try:
		with INDEX_FILE.open("r", encoding="utf-8") as handle:
			return json.load(handle)
	except FileNotFoundError:
		raise SystemExit("[measure-bounds] 缺少 anim/index.json（先跑 transcode + build-index）")
	except json.JSONDecodeError as error:
		raise SystemExit(f"[measure-bounds] anim/index.json 解析失败：{error}")


def measure_all(threshold: int, padding: int, verbose: bool) -> dict:
	index = load_index()
	clips = index.get("clips") or []
	if not clips:
		raise SystemExit("[measure-bounds] anim/index.json 里没有 clips")

	webp_files = sorted(WEBP_DIR.glob("*.webp"))
	by_file = {clip["file"].split("/")[-1]: clip for clip in clips}
	missing = [path.name for path in webp_files if path.name not in by_file]
	absent = [clip["file"] for clip in clips if not (PLUGIN_DIR / clip["file"]).is_file()]
	if missing:
		raise SystemExit(f"[measure-bounds] anim/webp 里有 index 未登记的帧文件：{', '.join(missing[:5])}")
	if absent:
		raise SystemExit(f"[measure-bounds] index 引用的文件不存在：{', '.join(absent[:5])}")

	canvas = {"width": 0, "height": 0}
	results = {}
	total_frames = 0
	for position, clip in enumerate(sorted(clips, key=lambda item: item["index"]), start=1):
		path = PLUGIN_DIR / clip["file"]
		measured = measure_clip(path, threshold, padding)
		if measured["frames"] != clip["frames"]:
			raise SystemExit(
				f"[measure-bounds] {clip['file']} 实测 {measured['frames']} 帧 ≠ index {clip['frames']} 帧"
			)
		if measured["width"] != clip["width"] or measured["height"] != clip["height"]:
			raise SystemExit(
				f"[measure-bounds] {clip['file']} 尺寸 {measured['width']}×{measured['height']} "
				f"≠ index {clip['width']}×{clip['height']}"
			)
		if canvas["width"] == 0:
			canvas = {"width": measured["width"], "height": measured["height"]}
		elif (canvas["width"], canvas["height"]) != (measured["width"], measured["height"]):
			raise SystemExit("[measure-bounds] 各段画布尺寸不一致，归一化坐标将不可比")

		total_frames += measured["frames"]
		results[clip["id"]] = {
			"bounds": measured["bounds"],
			"rawBounds": measured["rawBounds"],
			"frames": measured["frames"],
			"sourceFacing": FACING_OVERRIDES.get(clip["id"], DEFAULT_FACING),
		}
		if verbose:
			box = measured["bounds"]
			sys.stderr.write(
				f"[measure-bounds] {position:3d}/{len(clips)} {clip['file']} {clip['id']} "
				f"({box['left']:.4f},{box['top']:.4f})-({box['right']:.4f},{box['bottom']:.4f})\n"
			)

	body_clip = pick_body_clip(index)
	return {
		"version": VERSION,
		"generator": "tools/measure-bounds.py",
		"alphaThreshold": threshold,
		"paddingPx": padding,
		"canvas": canvas,
		"frameCount": total_frames,
		"clipCount": len(results),
		"bodyClip": body_clip,
		"bodyBounds": results[body_clip]["bounds"],
		"clips": results,
	}


def pick_body_clip(index: dict) -> str:
	"""The normal idle loop — the clip the pet rests in, not a showcase animation."""
	pools = index.get("pools") or {}
	idle = pools.get("idle") or []
	if len(idle) != 1:
		raise SystemExit(
			"[measure-bounds] pools.idle 应当恰好有 1 段正常待机（不能用表演/事件动画代替），"
			f"实际 {len(idle)} 段：{', '.join(idle) or '空'}"
		)
	return idle[0]


def strip_volatile(document: dict) -> dict:
	return {key: value for key, value in document.items() if key != "generatedAt"}


def main(argv: list[str]) -> int:
	parser = argparse.ArgumentParser(
		description="离线测量 anim/webp 每一段的 alpha 包围盒，生成 anim/bounds.json",
	)
	parser.add_argument("--alpha-threshold", type=int, default=ALPHA_THRESHOLD, help="判定不透明的 alpha 下限（默认 32）")
	parser.add_argument("--padding", type=int, default=PADDING_PX, help="四边安全边距，像素（默认 2）")
	parser.add_argument("--check", action="store_true", help="只比对现有 anim/bounds.json，不写文件")
	parser.add_argument("--quiet", action="store_true", help="不打印逐段进度")
	args = parser.parse_args(argv)

	if not 0 <= args.alpha_threshold <= 255:
		raise SystemExit("[measure-bounds] --alpha-threshold 必须在 0–255")
	if not 0 <= args.padding <= 64:
		raise SystemExit("[measure-bounds] --padding 必须在 0–64")

	document = measure_all(args.alpha_threshold, args.padding, not args.quiet)
	payload = {"generatedAt": iso_timestamp(), **document}

	if args.check:
		try:
			existing = json.loads(OUTPUT_FILE.read_text(encoding="utf-8"))
		except FileNotFoundError:
			raise SystemExit("[measure-bounds] anim/bounds.json 不存在")
		except json.JSONDecodeError as error:
			raise SystemExit(f"[measure-bounds] anim/bounds.json 解析失败：{error}")
		if strip_volatile(existing) == strip_volatile(payload):
			sys.stderr.write(f"[measure-bounds] anim/bounds.json 与实测一致（{document['clipCount']} 段，{document['frameCount']} 帧）\n")
			return 0
		differing = sorted(
			clip_id
			for clip_id in set(existing.get("clips") or {}) | set(payload["clips"])
			if (existing.get("clips") or {}).get(clip_id) != payload["clips"].get(clip_id)
		)
		sys.stderr.write(
			"[measure-bounds] anim/bounds.json 与实测不一致："
			+ (", ".join(differing[:8]) if differing else "bodyBounds / 元数据")
			+ "\n"
		)
		return 1

	OUTPUT_FILE.write_text(f"{json.dumps(payload, ensure_ascii=False, indent='\t')}\n", encoding="utf-8")
	body = document["bodyBounds"]
	sys.stderr.write(
		f"[measure-bounds] 写入 anim/bounds.json：{document['clipCount']} 段 / {document['frameCount']} 帧，"
		f"alpha≥{args.alpha_threshold}，padding {args.padding}px，"
		f"bodyBounds=({body['left']:.4f},{body['top']:.4f})-({body['right']:.4f},{body['bottom']:.4f})"
		f"（{document['bodyClip']}）\n"
	)
	return 0


def iso_timestamp() -> str:
	"""UTC timestamp in the same millisecond form the other build reports use."""
	now = datetime.now(timezone.utc)
	return f"{now.strftime('%Y-%m-%dT%H:%M:%S')}.{now.microsecond // 1000:03d}Z"


if __name__ == "__main__":
	sys.exit(main(sys.argv[1:]))
