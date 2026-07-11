#!/usr/bin/env python3
"""
Measurement helper for the Admin Media Drive subtitle verification gate.

Input : one JSON object on stdin  -> {"mode": "...", ...}
Output: one JSON object on stdout -> {"ok": true, ...}

Modes
-----
inspect_overlays  {"overlays": [{"path": "..."}]}
    For each RGBA overlay PNG: count pixels with alpha above threshold and
    return the inked bounding box. Used to prove every generated overlay
    actually contains non-transparent text pixels.

verify_frames     {"checks": [{"before","after","bbox":[x0,y0,x1,y1],"pad","label"}],
                   "proofSheet": {"path","tileWidth","columns"}}
    Compare a pre-overlay frame against a post-overlay frame inside the
    overlay's inked bbox. Returns changed / white-changed / dark-changed pixel
    counts (policy thresholds are applied by the Node caller). Also renders a
    labelled proof contact sheet from the "after" crops.

detect_text       {"regions": [{"path","bbox":[x0,y0,x1,y1]}]}
    Reference-free white/dark pixel counts inside a region of a single frame.
    Used for pre-burned-subtitle detection and for later re-verification.

This helper only measures pixels; it never invents subtitle content and never
prints environment values. On a missing Pillow install it writes
"AMD_PROOF_ERROR:pillow_missing" to stderr and exits non-zero so the Node gate
can fail closed with a sanitized category.
"""

import json
import sys

ALPHA_THRESHOLD = 16
DIFF_THRESHOLD = 20
WHITE_FLOOR = 180
DARK_CEIL = 80


def fail(category, detail=""):
    sys.stderr.write(f"AMD_PROOF_ERROR:{category} {str(detail)[:200]}\n")
    sys.exit(3 if category == "pillow_missing" else 4)


try:
    from PIL import Image, ImageDraw
except Exception as exc:  # pragma: no cover - exercised via subprocess tests
    fail("pillow_missing", exc)


def load_rgba(path):
    try:
        with Image.open(path) as img:
            return img.convert("RGBA")
    except Exception as exc:
        fail("image_unreadable", f"{path}: {exc}")


def overlay_stats(path):
    img = load_rgba(path)
    mask = img.getchannel("A").point(lambda a: 255 if a > ALPHA_THRESHOLD else 0)
    hist = mask.histogram()
    opaque = hist[255] if len(hist) > 255 else 0
    bbox = mask.getbbox()
    return {
        "path": path,
        "opaquePixels": int(opaque),
        "bbox": list(bbox) if bbox else None,
    }


def clamp_box(bbox, size, pad):
    x0, y0, x1, y1 = bbox
    w, h = size
    return (
        max(0, int(x0) - pad),
        max(0, int(y0) - pad),
        min(w, int(x1) + pad),
        min(h, int(y1) + pad),
    )


def count_region(img_rgb):
    """White-ish and dark-ish pixel counts of an RGB image."""
    px = img_rgb.load()
    w, h = img_rgb.size
    white = 0
    dark = 0
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y][:3]
            if r >= WHITE_FLOOR and g >= WHITE_FLOOR and b >= WHITE_FLOOR:
                white += 1
            elif r <= DARK_CEIL and g <= DARK_CEIL and b <= DARK_CEIL:
                dark += 1
    return white, dark


def mode_inspect_overlays(params):
    overlays = params.get("overlays") or []
    if not overlays:
        fail("invalid_input", "overlays required")
    return {"ok": True, "overlays": [overlay_stats(o["path"]) for o in overlays]}


def compare_frames(check):
    before = load_rgba(check["before"]).convert("RGB")
    after = load_rgba(check["after"]).convert("RGB")
    if before.size != after.size:
        fail("frame_size_mismatch", f"{before.size} vs {after.size}")
    bbox = check.get("bbox") or [0, 0, after.size[0], after.size[1]]
    box = clamp_box(bbox, after.size, int(check.get("pad", 12)))
    b = before.crop(box)
    a = after.crop(box)
    bp = b.load()
    ap = a.load()
    w, h = a.size
    changed = 0
    white_changed = 0
    dark_changed = 0
    for y in range(h):
        for x in range(w):
            pb = bp[x, y]
            pa = ap[x, y]
            if max(abs(pa[0] - pb[0]), abs(pa[1] - pb[1]), abs(pa[2] - pb[2])) > DIFF_THRESHOLD:
                changed += 1
                if pa[0] >= WHITE_FLOOR and pa[1] >= WHITE_FLOOR and pa[2] >= WHITE_FLOOR:
                    white_changed += 1
                elif pa[0] <= DARK_CEIL and pa[1] <= DARK_CEIL and pa[2] <= DARK_CEIL:
                    dark_changed += 1
    return {
        "changedPixels": changed,
        "whiteChangedPixels": white_changed,
        "darkChangedPixels": dark_changed,
        "cropBox": list(box),
        "cropWidth": w,
        "cropHeight": h,
    }, a


def build_proof_sheet(tiles, spec):
    tile_width = int(spec.get("tileWidth", 360))
    columns = max(1, int(spec.get("columns", 3)))
    label_h = 22
    scaled = []
    for crop, label in tiles:
        ratio = tile_width / max(1, crop.size[0])
        tile = crop.resize((tile_width, max(1, int(crop.size[1] * ratio))))
        scaled.append((tile, label))
    if not scaled:
        fail("invalid_input", "no tiles for proof sheet")
    rows = (len(scaled) + columns - 1) // columns
    row_heights = []
    for r in range(rows):
        row = scaled[r * columns:(r + 1) * columns]
        row_heights.append(max(t.size[1] for t, _ in row) + label_h)
    sheet_w = columns * tile_width
    sheet_h = sum(row_heights)
    sheet = Image.new("RGB", (sheet_w, sheet_h), (24, 24, 24))
    draw = ImageDraw.Draw(sheet)
    y = 0
    for r in range(rows):
        row = scaled[r * columns:(r + 1) * columns]
        for c, (tile, label) in enumerate(row):
            x = c * tile_width
            draw.text((x + 6, y + 4), str(label)[:60], fill=(255, 255, 255))
            sheet.paste(tile, (x, y + label_h))
        y += row_heights[r]
    sheet.save(spec["path"], "PNG")
    return {"path": spec["path"], "width": sheet_w, "height": sheet_h, "tiles": len(scaled)}


def mode_verify_frames(params):
    checks = params.get("checks") or []
    if not checks:
        fail("invalid_input", "checks required")
    results = []
    tiles = []
    for check in checks:
        result, after_crop = compare_frames(check)
        results.append(result)
        tiles.append((after_crop, check.get("label", "")))
    out = {"ok": True, "checks": results}
    sheet_spec = params.get("proofSheet")
    if sheet_spec and sheet_spec.get("path"):
        out["proofSheet"] = build_proof_sheet(tiles, sheet_spec)
    return out


def mode_detect_text(params):
    regions = params.get("regions") or []
    if not regions:
        fail("invalid_input", "regions required")
    results = []
    for region in regions:
        frame = load_rgba(region["path"]).convert("RGB")
        bbox = region.get("bbox") or [0, 0, frame.size[0], frame.size[1]]
        box = clamp_box(bbox, frame.size, int(region.get("pad", 0)))
        white, dark = count_region(frame.crop(box))
        results.append({
            "path": region["path"],
            "cropBox": list(box),
            "whitePixels": white,
            "darkPixels": dark,
        })
    return {"ok": True, "regions": results}


MODES = {
    "inspect_overlays": mode_inspect_overlays,
    "verify_frames": mode_verify_frames,
    "detect_text": mode_detect_text,
}


def main():
    try:
        params = json.loads(sys.stdin.read() or "{}")
    except Exception as exc:
        fail("invalid_input", exc)
    handler = MODES.get(params.get("mode"))
    if not handler:
        fail("invalid_input", f"unknown mode {params.get('mode')!r}")
    print(json.dumps(handler(params)))


if __name__ == "__main__":
    main()
