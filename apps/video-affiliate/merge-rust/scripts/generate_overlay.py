#!/usr/bin/env python3
"""
Generate an RGBA PNG text-overlay at the requested canvas size.

Input  : JSON on stdin
Output : PNG bytes written to the `output_path` field inside the JSON

Why Pillow: Debian's ffmpeg ships WITHOUT --enable-libharfbuzz, so drawtext's
`text_shaping=1` can't position Thai combining marks. libass BorderStyle=3 boxes
also clip above diacritics (ไม้โท above the box). Pillow + FreeType + (raqm, if
available) shape Thai correctly and lets us measure the real bbox including
marks, so the box background fully contains them.
"""

import io
import json
import sys

from PIL import Image, ImageDraw, ImageFont


def hex_to_rgb(hex_str: str) -> tuple[int, int, int]:
    h = (hex_str or "").lstrip("#")
    if len(h) != 6:
        return (255, 255, 255)
    try:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except ValueError:
        return (255, 255, 255)


def load_font(path: str, size: int) -> ImageFont.FreeTypeFont:
    """Load a TTF with raqm layout engine when available for proper Thai shaping."""
    try:
        return ImageFont.truetype(path, size, layout_engine=ImageFont.Layout.RAQM)
    except Exception:
        return ImageFont.truetype(path, size)


def measure_line(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont,
    stroke_width: int = 0,
):
    # textbbox returns (x0, y0, x1, y1) of the actual inked pixels including
    # Thai marks above the cap height and the stroke expansion when stroke_width>0.
    # We pass stroke_width so the box sizing accounts for the outline too — otherwise
    # the outline clips at the edges of the textbox.
    bbox = draw.textbbox((0, 0), text, font=font, stroke_width=stroke_width)
    return bbox, bbox[2] - bbox[0], bbox[3] - bbox[1]


def draw_text_with_outline(
    draw: ImageDraw.ImageDraw,
    position: tuple[int, int],
    text: str,
    font: ImageFont.FreeTypeFont,
    fill_rgba,
    outline_rgba,
    outline_width: int,
) -> None:
    """Draw text with a clean outline using PIL's native stroke (single-pass, AA-correct).

    This produces a sharp, even outline that exactly follows the glyph curves — unlike
    the old multi-stamp circular trick which visibly blurred edges and merged adjacent
    characters into blobs when the outline was thick.
    """
    if outline_rgba and outline_width > 0:
        draw.text(
            position,
            text,
            font=font,
            fill=fill_rgba,
            stroke_width=outline_width,
            stroke_fill=outline_rgba,
        )
    else:
        draw.text(position, text, font=font, fill=fill_rgba)


def bool_param(value, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() not in {"0", "false", "off", "no"}


def main() -> None:
    params = json.loads(sys.stdin.read())

    text: str = params.get("text", "")
    lines = [ln for ln in text.split("\n") if ln.strip()]

    img_w = int(params["width"])
    img_h = int(params["height"])
    font_path: str = params["font_path"]
    font_size = int(params.get("font_size", 80))
    fill_hex = params.get("fill_color", "#FFFFFF")
    secondary_fill_hex = str(params.get("secondary_fill_color", "") or "").strip()
    bg_hex = params.get("bg_color", "")
    bg_opacity = float(params.get("bg_opacity", 0.0))
    outline_hex = params.get("outline_color", "")
    # outline_width from the UI slider is interpreted as the TOTAL visible stroke width
    # (both sides of the glyph) — matching CSS `-webkit-text-stroke` which also draws
    # centered on the path, so half shows inside + half outside. PIL stroke_width is
    # per-side, so we halve here to keep the settings preview and the final render
    # visually identical.
    outline_width = max(0, int(params.get("outline_width", 0)) // 2)
    pad_x = int(params.get("pad_x", 40))
    pad_y = int(params.get("pad_y", 24))
    line_spacing_px = int(params.get("line_spacing_px", 12))
    center_y = int(params.get("center_y", img_h // 2))
    output_path: str = params["output_path"]
    auto_fit = bool_param(params.get("auto_fit"), default=True)
    max_box_width = int(params.get("max_box_width", int(img_w * 0.96)))
    max_box_height = int(params.get("max_box_height", int(img_h * 0.26)))
    min_font_size = max(12, int(params.get("min_font_size", 24)))

    img = Image.new("RGBA", (img_w, img_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if not lines:
        img.save(output_path, "PNG")
        return

    def measure_layout(size: int, spacing_px: int):
        measured_font = load_font(font_path, size)
        measured_metrics = []
        for ln in lines:
            bbox, lw, lh = measure_line(draw, ln, measured_font, stroke_width=outline_width)
            measured_metrics.append((ln, bbox, lw, lh))
        measured_total_h = sum(m[3] for m in measured_metrics) + spacing_px * max(0, len(measured_metrics) - 1)
        measured_max_w = max(m[2] for m in measured_metrics)
        return measured_font, measured_metrics, measured_total_h, measured_max_w

    font = load_font(font_path, font_size)
    metrics = []
    total_text_h = 0
    max_line_w = 0

    if auto_fit:
        # Fit against measured inked glyph bounds, including Thai diacritics and
        # outline stroke. This catches long Thai text with no spaces accurately.
        while True:
            scaled_line_spacing = max(4, int(round(line_spacing_px * (font_size / max(1, int(params.get("font_size", font_size)))))))
            scaled_pad_x = max(8, int(round(pad_x * (font_size / max(1, int(params.get("font_size", font_size)))))))
            scaled_pad_y = max(8, int(round(pad_y * (font_size / max(1, int(params.get("font_size", font_size)))))))
            font, metrics, total_text_h, max_line_w = measure_layout(font_size, scaled_line_spacing)
            box_w = max_line_w + scaled_pad_x * 2
            box_h = total_text_h + scaled_pad_y * 2
            if (box_w <= max_box_width and box_h <= max_box_height) or font_size <= min_font_size:
                line_spacing_px = scaled_line_spacing
                pad_x = scaled_pad_x
                pad_y = scaled_pad_y
                break
            width_ratio = max_box_width / max(1, box_w)
            height_ratio = max_box_height / max(1, box_h)
            next_size = int(font_size * min(width_ratio, height_ratio) * 0.98)
            font_size = max(min_font_size, min(font_size - 1, next_size))
    else:
        font, metrics, total_text_h, max_line_w = measure_layout(font_size, line_spacing_px)

    # Box covers the real inked bounds + padding on all sides.
    box_w = max_line_w + pad_x * 2
    box_h = total_text_h + pad_y * 2
    box_x = (img_w - box_w) // 2
    box_y = center_y - box_h // 2

    # Optional filled background box (preserves existing orange/red box design).
    if bg_hex and bg_opacity > 0.0:
        r, g, b = hex_to_rgb(bg_hex)
        a = max(0, min(255, int(round(bg_opacity * 255))))
        draw.rectangle(
            [box_x, box_y, box_x + box_w, box_y + box_h],
            fill=(r, g, b, a),
        )

    primary_fill_rgba = (*hex_to_rgb(fill_hex), 255)
    secondary_fill_rgba = (*hex_to_rgb(secondary_fill_hex), 255) if secondary_fill_hex else None
    outline_rgba = (*hex_to_rgb(outline_hex), 255) if outline_hex else None

    # Draw each line. `bbox[0]/bbox[1]` are the offset of inked pixels from the
    # nominal pen position (can be negative for Thai marks above baseline),
    # so we subtract them to place the inked top-left at our target coordinate.
    #
    # Color per line: the first line always uses `fill_color`. If a distinct
    # `secondary_fill_color` is provided, every line from index 1 onward uses it
    # (matches the reference style: line 1 orange, line 2 white).
    cursor_y = box_y + pad_y
    for idx, (ln, bbox, lw, lh) in enumerate(metrics):
        x_draw = (img_w - lw) // 2 - bbox[0]
        y_draw = cursor_y - bbox[1]
        fill_rgba = secondary_fill_rgba if (idx >= 1 and secondary_fill_rgba is not None) else primary_fill_rgba
        draw_text_with_outline(
            draw,
            (x_draw, y_draw),
            ln,
            font,
            fill_rgba=fill_rgba,
            outline_rgba=outline_rgba,
            outline_width=outline_width,
        )
        cursor_y += lh + line_spacing_px

    img.save(output_path, "PNG")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # pylint: disable=broad-except
        sys.stderr.write(f"generate_overlay failed: {exc}\n")
        sys.exit(1)
