use axum::{Json, http::StatusCode};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::process::Stdio;
use tempfile::tempdir;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

#[derive(Deserialize)]
pub struct ThumbnailRequest {
    pub video_url: String,
    #[serde(default)]
    pub frame_seed: String,
    #[serde(default)]
    pub seek_seconds: Option<f64>,
    #[serde(default)]
    pub output_format: String,
    #[serde(default)]
    pub target_width: Option<u32>,
    #[serde(default)]
    pub target_height: Option<u32>,
    #[serde(default)]
    pub overlay_text: String,
    #[serde(default)]
    pub overlay_y_pct: Option<f64>,
    #[serde(default)]
    pub overlay_font_id: String,
    #[serde(default)]
    pub overlay_text_color: String,
    #[serde(default)]
    pub overlay_bg_color: String,
    #[serde(default)]
    pub overlay_bg_opacity: Option<f64>,
    #[serde(default)]
    pub overlay_size_scale: Option<f64>,
    #[serde(default)]
    pub overlay_auto_fit: Option<bool>,
    #[serde(default)]
    pub overlay_mode: String,
    #[serde(default)]
    pub overlay_outline_color: String,
    #[serde(default)]
    pub overlay_outline_width: Option<i32>,
    #[serde(default)]
    pub overlay_secondary_text_color: String,
}

#[derive(Serialize)]
pub struct ThumbnailResponse {
    pub success: bool,
    pub thumbnail_base64: String,
}

fn compute_seek_seconds(duration_secs: f64, frame_seed: &str) -> f64 {
    if !duration_secs.is_finite() || duration_secs <= 0.0 {
        return 0.1;
    }

    let safe_duration = duration_secs.max(0.2);
    let min_seek = (safe_duration * 0.08).min((safe_duration - 0.1).max(0.1));
    let max_seek = (safe_duration * 0.92).max(min_seek);
    if (max_seek - min_seek).abs() < f64::EPSILON {
        return min_seek.max(0.1);
    }

    let mut hasher = DefaultHasher::new();
    if frame_seed.trim().is_empty() {
        safe_duration.to_bits().hash(&mut hasher);
    } else {
        frame_seed.trim().hash(&mut hasher);
    }
    let hash = hasher.finish();
    let fraction = (hash as f64) / (u64::MAX as f64);

    let seed_parts: Vec<&str> = frame_seed.trim().split('|').collect();
    if seed_parts.len() == 5 && seed_parts[0] == "line-cover" {
        let slot_index = seed_parts[3].trim().parse::<usize>().unwrap_or(1).max(1);
        let slot_total = seed_parts[4].trim().parse::<usize>().unwrap_or(slot_index).max(slot_index).max(1);
        let segment_span = (max_seek - min_seek) / (slot_total as f64);
        if segment_span.is_finite() && segment_span > 0.0 {
            let segment_start = min_seek + segment_span * ((slot_index - 1) as f64);
            let segment_end = if slot_index >= slot_total {
                max_seek
            } else {
                (segment_start + segment_span).min(max_seek)
            };
            let inner_start = segment_start + (segment_span * 0.12);
            let inner_end = (segment_end - (segment_span * 0.12)).max(inner_start);
            let ranged = inner_start + ((inner_end - inner_start) * fraction);
            return ranged.clamp(0.1, (safe_duration - 0.05).max(0.1));
        }
    }

    (min_seek + ((max_seek - min_seek) * fraction))
        .clamp(0.1, (safe_duration - 0.05).max(0.1))
}

fn normalize_overlay_text(input: &str) -> String {
    input
        .replace("\r\n", "\n")
        .replace('\u{00A0}', " ")
        .replace("\\n", "\n")
        .replace('|', "\n")
        .split('\n')
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .chars()
        .take(80)
        .collect::<String>()
}

fn wrap_overlay_text(input: &str, max_chars_per_line: usize, max_lines: usize, split_long_words: bool) -> String {
    let normalized = normalize_overlay_text(input);
    if normalized.is_empty() {
        return String::new();
    }

    let max_lines = max_lines.max(1);
    let manual_lines: Vec<String> = normalized
        .split('\n')
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();
    if manual_lines.len() > 1 {
        return manual_lines
            .into_iter()
            .take(max_lines)
            .collect::<Vec<_>>()
            .join("\n");
    }

    let max_chars = max_chars_per_line.max(8);
    let mut lines: Vec<String> = Vec::new();

    for paragraph in normalized.split('\n') {
        let words: Vec<&str> = paragraph.split_whitespace().collect();
        if !words.is_empty() {
            let mut current = String::new();
            for word in words {
                if split_long_words && word.chars().count() > max_chars {
                    if !current.trim().is_empty() {
                        lines.push(current.trim().to_string());
                        current.clear();
                        if lines.len() >= max_lines {
                            break;
                        }
                    }
                    let mut chunk = String::new();
                    for ch in word.chars() {
                        chunk.push(ch);
                        if chunk.chars().count() >= max_chars {
                            lines.push(chunk.trim().to_string());
                            chunk.clear();
                            if lines.len() >= max_lines {
                                break;
                            }
                        }
                    }
                    if lines.len() >= max_lines {
                        break;
                    }
                    current = chunk;
                    continue;
                }
                let candidate = if current.is_empty() {
                    word.to_string()
                } else {
                    format!("{} {}", current, word)
                };
                let candidate_len = candidate.chars().count();
                if candidate_len > max_chars && !current.is_empty() {
                    lines.push(current.trim().to_string());
                    current = word.to_string();
                    if lines.len() >= max_lines {
                        break;
                    }
                } else {
                    current = candidate;
                }
            }
            if lines.len() >= max_lines {
                break;
            }
            if !current.trim().is_empty() {
                lines.push(current.trim().to_string());
            }
        } else {
            let mut current = String::new();
            for ch in paragraph.chars() {
                current.push(ch);
                if current.chars().count() >= max_chars {
                    lines.push(current.trim().to_string());
                    current.clear();
                    if lines.len() >= max_lines {
                        break;
                    }
                }
            }
            if lines.len() >= max_lines {
                break;
            }
            if !current.trim().is_empty() {
                lines.push(current.trim().to_string());
            }
        }

        if lines.len() >= max_lines {
            break;
        }
    }

    lines
        .into_iter()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .take(max_lines)
        .collect::<Vec<_>>()
        .join("\n")
}

fn normalize_overlay_color(input: &str, fallback: &str) -> String {
    let trimmed = input.trim();
    let uppercase = trimmed.to_ascii_uppercase();
    if uppercase.len() == 7
        && uppercase.starts_with('#')
        && uppercase[1..].chars().all(|ch| ch.is_ascii_hexdigit())
    {
        uppercase
    } else {
        fallback.to_string()
    }
}

fn normalize_overlay_bg_opacity(input: Option<f64>) -> f64 {
    input.unwrap_or(0.94).clamp(0.0, 1.0)
}

fn normalize_overlay_size_scale(input: Option<f64>) -> f64 {
    input.unwrap_or(1.0).clamp(0.5, 1.35)
}

fn normalize_overlay_auto_fit(input: Option<bool>) -> bool {
    input.unwrap_or(true)
}

fn resolve_overlay_fontfile(font_id: &str) -> &'static str {
    match font_id.trim().to_ascii_lowercase().as_str() {
        "prompt-bold" => "/usr/local/share/fonts/Prompt-Bold.ttf",
        "sarabun-bold" => "/usr/local/share/fonts/Sarabun-Bold.ttf",
        "bai-jamjuree-bold" => "/usr/local/share/fonts/BaiJamjuree-Bold.ttf",
        "mitr-bold" => "/usr/local/share/fonts/Mitr-Bold.ttf",
        "krub-bold" => "/usr/local/share/fonts/Krub-Bold.ttf",
        "chakra-petch-bold" => "/usr/local/share/fonts/ChakraPetch-Bold.ttf",
        "ibm-plex-sans-thai-bold" => "/usr/local/share/fonts/IBMPlexSansThai-Bold.ttf",
        "psl-x-omyim-bold" => "/usr/local/share/fonts/PSLxOmyim-Bold.ttf",
        "fc-iconic-bold" | "kanit-bold" => "/usr/local/share/fonts/Kanit-Bold.ttf",
        "sukhumvit-bold" => "/usr/local/share/fonts/Prompt-Bold.ttf",
        "sukhumvit-semibold" => "/usr/local/share/fonts/Sarabun-Bold.ttf",
        _ => "/usr/local/share/fonts/Kanit-Bold.ttf",
    }
}

/// Font family name for libass/fontconfig lookup (match .ttf metadata's family field).
/// libass uses family+bold style, not file paths — cross-reference Dockerfile's fc-cache.
fn resolve_overlay_font_family(font_id: &str) -> &'static str {
    match font_id.trim().to_ascii_lowercase().as_str() {
        "prompt-bold" => "Prompt",
        "sarabun-bold" => "Sarabun",
        "bai-jamjuree-bold" => "Bai Jamjuree",
        "mitr-bold" => "Mitr",
        "krub-bold" => "Krub",
        "chakra-petch-bold" => "Chakra Petch",
        "ibm-plex-sans-thai-bold" => "IBM Plex Sans Thai",
        "fc-iconic-bold" | "kanit-bold" => "Kanit",
        "sukhumvit-bold" => "Prompt",
        "sukhumvit-semibold" => "Sarabun",
        _ => "Kanit",
    }
}

/// Convert "#RRGGBB" + alpha hex to ASS BGR color "&HAABBGGRR".
/// ASS alpha is INVERTED: 00=opaque, FF=transparent.
fn hex_to_ass_bgr(hex: &str, alpha_hex: &str) -> String {
    let h = hex.trim_start_matches('#').to_ascii_uppercase();
    if h.len() != 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return format!("&H{}FFFFFF", alpha_hex.to_ascii_uppercase());
    }
    format!("&H{}{}{}{}", alpha_hex.to_ascii_uppercase(), &h[4..6], &h[2..4], &h[0..2])
}

fn opacity_to_ass_alpha_hex(opacity: f64) -> String {
    let transparency = (1.0 - opacity.clamp(0.0, 1.0)) * 255.0;
    format!("{:02X}", transparency.round() as u8)
}

fn escape_ass_text(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('\n', "\\N")
        .replace('{', "\\{")
        .replace('}', "\\}")
}

/// Overlay plan — either a base-only filter (no overlay needed) or a Python-rendered
/// PNG to composite on top of the scaled frame.
///
/// We render the overlay with Pillow (python3-pil) because Debian's ffmpeg ships
/// WITHOUT `--enable-libharfbuzz`, so `drawtext text_shaping=1` cannot shape Thai.
/// libass also works for shaping but its BorderStyle=3 box clips diacritics
/// (ไม้โท above the cap height ends up outside the box). Pillow measures the
/// real inked bbox including combining marks → box contains all diacritics.
struct OverlayPlan {
    /// FFmpeg filter graph. Empty overlay → plain `-vf base_filter`.
    /// With overlay → uses `-filter_complex` form (base_filter is applied to [0:v]).
    uses_filter_complex: bool,
    filter: String,
    /// JSON params to pass to generate_overlay.py on stdin. None → no overlay.
    overlay_params_json: Option<String>,
}

fn build_thumbnail_plan(
    base_filter: &str,
    overlay_text: &str,
    overlay_png_path: Option<&str>,
    overlay_y_pct: Option<f64>,
    overlay_font_id: &str,
    overlay_text_color: &str,
    overlay_secondary_text_color: &str,
    overlay_bg_color: &str,
    overlay_bg_opacity: Option<f64>,
    overlay_size_scale: Option<f64>,
    overlay_auto_fit: Option<bool>,
    overlay_mode: &str,
    overlay_outline_color: &str,
    overlay_outline_width: Option<i32>,
    target_width: u32,
    target_height: u32,
) -> OverlayPlan {
    if overlay_text.trim().is_empty() {
        return OverlayPlan {
            uses_filter_complex: false,
            filter: base_filter.to_string(),
            overlay_params_json: None,
        };
    }

    let Some(png_path) = overlay_png_path else {
        return OverlayPlan {
            uses_filter_complex: false,
            filter: base_filter.to_string(),
            overlay_params_json: None,
        };
    };

    let y_pct = overlay_y_pct.unwrap_or(72.0).clamp(10.0, 90.0);
    let size_scale = normalize_overlay_size_scale(overlay_size_scale);
    let auto_fit = normalize_overlay_auto_fit(overlay_auto_fit);
    let line_count = overlay_text.lines().count().max(1) as f64;
    let longest_line_chars = overlay_text
        .lines()
        .map(|line| line.chars().count())
        .max()
        .unwrap_or(0)
        .max(1) as f64;
    // Base font size at 100% scale: 18% of frame width (≈194px on 1080px wide = viral-huge).
    // Size-scale slider still multiplies: 100%=194px, 120%=233px, 135%=262px.
    let mut font_size = (((target_width as f64) * 0.18) * size_scale).round().max(72.0);
    // Max text width 92% of frame — allow long text without excessive shrink.
    let max_text_width = (target_width as f64) * 0.92;
    let estimated_char_width = font_size * 0.62;
    let estimated_text_width = longest_line_chars * estimated_char_width;
    if auto_fit && estimated_text_width > max_text_width {
        font_size *= (max_text_width / estimated_text_width).clamp(0.72, 1.0);
    }
    let estimated_text_height = line_count * font_size * 1.18;
    let max_text_height = (target_height as f64) * 0.22;
    if auto_fit && estimated_text_height > max_text_height {
        font_size *= (max_text_height / estimated_text_height).clamp(0.72, 1.0);
    }
    let font_size = font_size.round().max(28.0) as i32;
    let panel_h = ((((font_size as f64) * 1.32 * line_count) + ((font_size as f64) * 0.95)).max(96.0)).round() as i32;
    let line_spacing_px = ((font_size as f64) * 0.18).round().max(6.0) as i32;
    let box_border_w = ((font_size as f64) * 0.34).round().max(12.0) as i32;
    let raw_panel_y = ((target_height as f64) * (y_pct / 100.0)).round() as i32 - (panel_h / 2);
    let max_panel_y = (target_height as i32 - panel_h - 12).max(12);
    let panel_y = raw_panel_y.clamp(12, max_panel_y);
    let center_y = panel_y + (panel_h / 2);
    let text_color = normalize_overlay_color(overlay_text_color, "#FFFFFF");
    let bg_color = normalize_overlay_color(overlay_bg_color, "#E53935");
    let bg_opacity = normalize_overlay_bg_opacity(overlay_bg_opacity);
    let font_path = resolve_overlay_fontfile(overlay_font_id);

    // Padding inside the coloured box, tuned to leave generous room above the text
    // so Thai marks (ไม้โท / ไม้เอก / สระอี) always fit inside the box.
    let pad_x = (box_border_w as f64).round().max(16.0) as i32;
    let pad_y = ((font_size as f64) * 0.22).round().max(14.0) as i32;

    // mode=outline → draw text with thick outline, no box. mode=box (default) → filled box behind text.
    let is_outline_mode = overlay_mode.eq_ignore_ascii_case("outline");
    let (effective_bg_color, effective_bg_opacity, effective_outline_color, effective_outline_width) =
        if is_outline_mode {
            let normalized_outline = normalize_overlay_color(overlay_outline_color, "#000000");
            let width = overlay_outline_width.unwrap_or(8).clamp(0, 40);
            (String::new(), 0.0, normalized_outline, width)
        } else {
            (bg_color, bg_opacity, String::new(), 0)
        };

    // Secondary fill: used for line 2+ when in outline mode and a distinct secondary
    // color is provided (matches reference project's line1=orange line2=white pattern).
    let secondary_trimmed = overlay_secondary_text_color.trim();
    let secondary_effective = if !secondary_trimmed.is_empty() && !secondary_trimmed.eq_ignore_ascii_case(&text_color) {
        normalize_overlay_color(overlay_secondary_text_color, &text_color)
    } else {
        String::new()
    };

    let params = json!({
        "text": overlay_text,
        "width": target_width,
        "height": target_height,
        "font_path": font_path,
        "font_size": font_size,
        "fill_color": text_color,
        "secondary_fill_color": secondary_effective,
        "bg_color": effective_bg_color,
        "bg_opacity": effective_bg_opacity,
        "outline_color": effective_outline_color,
        "outline_width": effective_outline_width,
        "pad_x": pad_x,
        "pad_y": pad_y,
        "line_spacing_px": line_spacing_px,
        "center_y": center_y,
        "auto_fit": auto_fit,
        "max_box_width": ((target_width as f64) * 0.96).round() as i32,
        "max_box_height": ((target_height as f64) * 0.26).round() as i32,
        "min_font_size": if target_width >= 720 { 42 } else { 24 },
        "output_path": png_path,
    });

    // filter_complex: apply base scale/crop to [0:v], then overlay the PNG at 0:0
    // (the PNG is rendered at exact target dimensions, so top-left alignment matches).
    let filter = format!(
        "[0:v]{base}[bg];[bg][1:v]overlay=0:0:format=auto[out]",
        base = base_filter,
    );

    OverlayPlan {
        uses_filter_complex: true,
        filter,
        overlay_params_json: Some(params.to_string()),
    }
}

pub async fn handle_thumbnail(
    Json(payload): Json<ThumbnailRequest>,
) -> Result<Json<ThumbnailResponse>, (StatusCode, Json<serde_json::Value>)> {
    let video_url = payload.video_url.trim().to_string();
    if video_url.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "video_url_required" }))));
    }

    let tmp_dir = tempdir().map_err(|e| (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": e.to_string() })),
    ))?;
    let tmp_path = tmp_dir.path();
    let video_path = tmp_path.join("video.mp4");
    let output_format = match payload.output_format.trim().to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "jpg",
        _ => "webp",
    };
    let thumb_path = tmp_path.join(if output_format == "jpg" { "thumb.jpg" } else { "thumb.webp" });
    let overlay_text = wrap_overlay_text(
        &payload.overlay_text,
        if payload.target_width.unwrap_or(270) >= 720 { 16 } else { 12 },
        3,
        normalize_overlay_auto_fit(payload.overlay_auto_fit),
    );
    // Overlay PNG is rendered by the Python Pillow helper at the canvas size.
    let overlay_png_path = if overlay_text.is_empty() {
        None
    } else {
        Some(tmp_path.join("overlay.png"))
    };

    let video_resp = reqwest::get(&video_url).await.map_err(|e| (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": format!("download_failed: {}", e) })),
    ))?;
    if !video_resp.status().is_success() {
        return Err((StatusCode::BAD_REQUEST, Json(json!({
            "error": format!("download_failed_status: {}", video_resp.status())
        }))));
    }
    let video_bytes = video_resp.bytes().await.map_err(|e| (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": format!("download_body_failed: {}", e) })),
    ))?;
    fs::write(&video_path, &video_bytes).await.map_err(|e| (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": format!("write_video_failed: {}", e) })),
    ))?;

    let probe_out = Command::new("ffprobe")
        .args(&[
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=nokey=1:noprint_wrappers=1",
            video_path.to_str().unwrap(),
        ])
        .output()
        .await
        .map_err(|e| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("ffprobe_failed: {}", e) })),
        ))?;

    let duration_secs = if probe_out.status.success() {
        String::from_utf8_lossy(&probe_out.stdout).trim().parse::<f64>().unwrap_or(0.0)
    } else {
        0.0
    };
    let seek_seconds = payload
        .seek_seconds
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value.clamp(0.0, (duration_secs - 0.05).max(0.0)))
        .unwrap_or_else(|| compute_seek_seconds(duration_secs, &payload.frame_seed));
    let seek_arg = format!("{:.3}", seek_seconds);
    let target_width = payload.target_width.unwrap_or(270).clamp(120, 1440);
    let target_height = payload.target_height.unwrap_or(480).clamp(160, 2560);
    let scale_filter = format!(
        "scale={}:{}:force_original_aspect_ratio=increase:flags=lanczos,crop={}:{}",
        target_width,
        target_height,
        target_width,
        target_height,
    );
    let plan = build_thumbnail_plan(
        &scale_filter,
        &overlay_text,
        overlay_png_path.as_ref().and_then(|path| path.to_str()),
        payload.overlay_y_pct,
        &payload.overlay_font_id,
        &payload.overlay_text_color,
        &payload.overlay_secondary_text_color,
        &payload.overlay_bg_color,
        payload.overlay_bg_opacity,
        payload.overlay_size_scale,
        payload.overlay_auto_fit,
        &payload.overlay_mode,
        &payload.overlay_outline_color,
        payload.overlay_outline_width,
        target_width,
        target_height,
    );

    // Render the overlay PNG via Pillow before invoking ffmpeg.
    if let Some(params_json) = plan.overlay_params_json.as_ref() {
        let mut child = Command::new("python3")
            .arg("/app/scripts/generate_overlay.py")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("spawn_overlay_python_failed: {}", e) })),
            ))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(params_json.as_bytes()).await.map_err(|e| (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("write_overlay_params_failed: {}", e) })),
            ))?;
            stdin.shutdown().await.ok();
        }
        let py_out = child.wait_with_output().await.map_err(|e| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("overlay_python_wait_failed: {}", e) })),
        ))?;
        if !py_out.status.success() {
            let stderr = String::from_utf8_lossy(&py_out.stderr).trim().to_string();
            return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
                "error": format!("overlay_python_failed: {}", stderr)
            }))));
        }
    }

    let mut ffmpeg_args: Vec<String> = vec![
        "-y".to_string(),
        "-ss".to_string(),
        seek_arg.clone(),
        "-i".to_string(),
        video_path.to_str().unwrap().to_string(),
    ];
    if plan.uses_filter_complex {
        // Second input is the overlay PNG.
        if let Some(png_path) = overlay_png_path.as_ref().and_then(|p| p.to_str()) {
            ffmpeg_args.push("-i".to_string());
            ffmpeg_args.push(png_path.to_string());
        }
        ffmpeg_args.push("-filter_complex".to_string());
        ffmpeg_args.push(plan.filter.clone());
        ffmpeg_args.push("-map".to_string());
        ffmpeg_args.push("[out]".to_string());
    } else {
        ffmpeg_args.push("-vf".to_string());
        ffmpeg_args.push(plan.filter.clone());
    }
    ffmpeg_args.push("-frames:v".to_string());
    ffmpeg_args.push("1".to_string());
    if output_format == "jpg" {
        ffmpeg_args.extend(["-q:v".to_string(), "1".to_string()]);
    } else {
        ffmpeg_args.extend(["-q:v".to_string(), "95".to_string()]);
    }
    ffmpeg_args.push(thumb_path.to_str().unwrap().to_string());

    let ffmpeg_out = Command::new("ffmpeg")
        .args(&ffmpeg_args)
        .output()
        .await
        .map_err(|e| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("ffmpeg_failed: {}", e) })),
        ))?;

    if !ffmpeg_out.status.success() {
        let stderr = String::from_utf8_lossy(&ffmpeg_out.stderr).trim().to_string();
        return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
            "error": format!("ffmpeg_thumbnail_failed: {}", stderr)
        }))));
    }

    let thumb_bytes = fs::read(&thumb_path).await.map_err(|e| (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": format!("read_thumbnail_failed: {}", e) })),
    ))?;
    if thumb_bytes.is_empty() {
        return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "thumbnail_empty" }))));
    }

    Ok(Json(ThumbnailResponse {
        success: true,
        thumbnail_base64: BASE64.encode(thumb_bytes),
    }))
}
