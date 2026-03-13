use axum::{Json, http::StatusCode};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tempfile::tempdir;
use tokio::fs;
use tokio::process::Command;

#[derive(Deserialize)]
pub struct ThumbnailRequest {
    pub video_url: String,
}

#[derive(Serialize)]
pub struct ThumbnailResponse {
    pub success: bool,
    pub thumbnail_base64: String,
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
    let thumb_path = tmp_path.join("thumb.webp");

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

    let ffmpeg_out = Command::new("ffmpeg")
        .args(&[
            "-y",
            "-i", video_path.to_str().unwrap(),
            "-vframes", "1",
            "-ss", "0.1",
            "-vf", "scale=270:480:force_original_aspect_ratio=increase,crop=270:480",
            "-q:v", "80",
            thumb_path.to_str().unwrap(),
        ])
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
