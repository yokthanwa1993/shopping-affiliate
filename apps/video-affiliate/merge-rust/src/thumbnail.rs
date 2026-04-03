use axum::{Json, http::StatusCode};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use tempfile::tempdir;
use tokio::fs;
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
        .split('\n')
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .chars()
        .take(80)
        .collect::<String>()
}

fn wrap_overlay_text(input: &str, max_chars_per_line: usize, max_lines: usize) -> String {
    let normalized = normalize_overlay_text(input);
    if normalized.is_empty() {
        return String::new();
    }

    let max_chars = max_chars_per_line.max(8);
    let max_lines = max_lines.max(1);
    let mut lines: Vec<String> = Vec::new();

    for paragraph in normalized.split('\n') {
        let words: Vec<&str> = paragraph.split_whitespace().collect();
        if !words.is_empty() {
            let mut current = String::new();
            for word in words {
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
    input.unwrap_or(1.0).clamp(0.8, 1.35)
}

fn resolve_overlay_fontfile(font_id: &str) -> &'static str {
    match font_id.trim().to_ascii_lowercase().as_str() {
        "sukhumvit-bold" => "/usr/local/share/fonts/SukhumvitSet-Bold.ttf",
        "sukhumvit-semibold" => "/usr/local/share/fonts/SukhumvitSet-SemiBold.ttf",
        "fc-iconic-bold" => "/usr/local/share/fonts/FC-Iconic-Bold.ttf",
        _ => "/usr/local/share/fonts/FC-Iconic-Bold.ttf",
    }
}

fn build_thumbnail_filter(
    base_filter: &str,
    overlay_text: &str,
    overlay_text_path: Option<&str>,
    overlay_y_pct: Option<f64>,
    overlay_font_id: &str,
    overlay_text_color: &str,
    overlay_bg_color: &str,
    overlay_bg_opacity: Option<f64>,
    overlay_size_scale: Option<f64>,
    target_width: u32,
    target_height: u32,
) -> String {
    if overlay_text.trim().is_empty() {
        return base_filter.to_string();
    }

    let Some(text_path) = overlay_text_path else {
        return base_filter.to_string();
    };

    let y_pct = overlay_y_pct.unwrap_or(72.0).clamp(10.0, 90.0);
    let size_scale = normalize_overlay_size_scale(overlay_size_scale);
    let line_count = overlay_text.lines().count().max(1) as f64;
    let longest_line_chars = overlay_text
        .lines()
        .map(|line| line.chars().count())
        .max()
        .unwrap_or(0)
        .max(1) as f64;
    let mut font_size = (((target_width as f64) * 0.075) * size_scale).round().max(34.0);
    let max_text_width = (target_width as f64) * 0.82;
    let estimated_char_width = font_size * 0.62;
    let estimated_text_width = longest_line_chars * estimated_char_width;
    if estimated_text_width > max_text_width {
        font_size *= (max_text_width / estimated_text_width).clamp(0.72, 1.0);
    }
    let estimated_text_height = line_count * font_size * 1.18;
    let max_text_height = (target_height as f64) * 0.22;
    if estimated_text_height > max_text_height {
        font_size *= (max_text_height / estimated_text_height).clamp(0.72, 1.0);
    }
    let font_size = font_size.round().max(28.0) as i32;
    let panel_h = ((((font_size as f64) * 1.32 * line_count) + ((font_size as f64) * 0.95)).max(96.0)).round() as i32;
    let line_spacing = ((font_size as f64) * 0.18).round().max(6.0) as i32;
    let border_w = ((font_size as f64) * 0.08).round().max(2.0) as i32;
    let box_border_w = ((font_size as f64) * 0.34).round().max(12.0) as i32;
    let raw_panel_y = ((target_height as f64) * (y_pct / 100.0)).round() as i32 - (panel_h / 2);
    let max_panel_y = (target_height as i32 - panel_h - 12).max(12);
    let panel_y = raw_panel_y.clamp(12, max_panel_y);
    let text_color = normalize_overlay_color(overlay_text_color, "#FFFFFF");
    let bg_color = normalize_overlay_color(overlay_bg_color, "#E53935");
    let bg_opacity = normalize_overlay_bg_opacity(overlay_bg_opacity);
    let fontfile = resolve_overlay_fontfile(overlay_font_id);

    format!(
        "{base_filter},drawtext=fontfile={fontfile}:textfile={text_path}:fontcolor={text_color}:fontsize={font_size}:line_spacing={line_spacing}:x=(w-text_w)/2:y={panel_y}+({panel_h}-text_h)/2:borderw={border_w}:bordercolor=black@0.22:box=1:boxcolor={bg_color}@{bg_opacity}:boxborderw={box_border_w}",
        base_filter = base_filter,
        fontfile = fontfile,
        panel_y = panel_y,
        panel_h = panel_h,
        text_path = text_path,
        text_color = text_color,
        bg_color = bg_color,
        bg_opacity = format!("{:.2}", bg_opacity),
        font_size = font_size,
        line_spacing = line_spacing,
        border_w = border_w,
        box_border_w = box_border_w,
    )
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
    );
    let overlay_text_path = if overlay_text.is_empty() {
        None
    } else {
        let path = tmp_path.join("overlay.txt");
        fs::write(&path, overlay_text.as_bytes()).await.map_err(|e| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("write_overlay_text_failed: {}", e) })),
        ))?;
        Some(path)
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
    let filter_chain = build_thumbnail_filter(
        &scale_filter,
        &overlay_text,
        overlay_text_path.as_ref().and_then(|path| path.to_str()),
        payload.overlay_y_pct,
        &payload.overlay_font_id,
        &payload.overlay_text_color,
        &payload.overlay_bg_color,
        payload.overlay_bg_opacity,
        payload.overlay_size_scale,
        target_width,
        target_height,
    );

    let mut ffmpeg_args = vec![
        "-y".to_string(),
        "-i".to_string(),
        video_path.to_str().unwrap().to_string(),
        "-vframes".to_string(),
        "1".to_string(),
        "-ss".to_string(),
        seek_arg.clone(),
        "-vf".to_string(),
        filter_chain,
    ];
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
