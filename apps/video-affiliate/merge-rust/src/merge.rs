use axum::{Json, http::StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::json;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use tokio::fs;
use tempfile::tempdir;
use tokio::process::Command;

#[derive(Deserialize)]
pub struct MergeRequest {
    pub video_url: String,
    pub audio_base64: String,
    pub sample_rate: Option<u32>,
}

#[derive(Serialize)]
pub struct MergeResponse {
    pub success: bool,
    pub duration: f64,
    pub video_duration: f64,
    pub video_size: usize,
    pub video_base64: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb_base64: Option<String>,
}

async fn get_duration(path: &std::path::Path) -> f64 {
    if let Ok(output) = Command::new("ffprobe")
        .args(&["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1"])
        .arg(path.to_str().unwrap())
        .output()
        .await
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        stdout.trim().parse().unwrap_or(0.0)
    } else {
        0.0
    }
}

pub async fn handle_merge(
    Json(payload): Json<MergeRequest>,
) -> Result<Json<MergeResponse>, (StatusCode, Json<serde_json::Value>)> {
    let video_url = payload.video_url;
    let audio_base64 = payload.audio_base64;
    let sample_rate = payload.sample_rate.unwrap_or(24000);

    let tmp_dir = tempdir().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e.to_string()}))))?;
    let tmp_path = tmp_dir.path();

    // 1. Download video
    let video_resp = reqwest::get(&video_url).await.map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({"error": format!("Failed download: {}", e)}))))?;
    let video_bytes = video_resp.bytes().await.map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({"error": format!("Failed body: {}", e)}))))?;
    let video_path = tmp_path.join("video.mp4");
    fs::write(&video_path, &video_bytes).await.unwrap();

    let v_dur = get_duration(&video_path).await;
    let v_dur = if v_dur == 0.0 { 10.0 } else { v_dur };

    // 2. Write audio raw
    let raw_audio_path = tmp_path.join("audio.raw");
    let wav_audio_path = tmp_path.join("audio.wav");
    let decoded_audio = BASE64.decode(&audio_base64).map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid base64"}))))?;
    fs::write(&raw_audio_path, &decoded_audio).await.unwrap();

    // 3. Convert to WAV
    Command::new("ffmpeg").args(&["-y", "-f", "s16le", "-ar", &sample_rate.to_string(), "-ac", "1", "-i", raw_audio_path.to_str().unwrap(), wav_audio_path.to_str().unwrap()]).output().await.unwrap();

    let a_dur = get_duration(&wav_audio_path).await;

    // 4. Pad/Trim
    let adjusted_path = tmp_path.join("audio_adj.wav");
    let diff = v_dur - a_dur;
    if diff.abs() < 0.5 {
        fs::copy(&wav_audio_path, &adjusted_path).await.unwrap();
    } else if diff > 0.0 {
        Command::new("ffmpeg").args(&["-y", "-i", wav_audio_path.to_str().unwrap(), "-af", &format!("apad=pad_dur={}", diff), adjusted_path.to_str().unwrap()]).output().await.unwrap();
    } else {
        Command::new("ffmpeg").args(&["-y", "-i", wav_audio_path.to_str().unwrap(), "-t", &v_dur.to_string(), adjusted_path.to_str().unwrap()]).output().await.unwrap();
    }

    // 5. Merge
    let output_path = tmp_path.join("output.mp4");
    let merge_out = Command::new("ffmpeg")
        .args(&["-y", "-i", video_path.to_str().unwrap(), "-i", adjusted_path.to_str().unwrap(), "-c:v", "copy", "-c:a", "aac", "-map", "0:v:0", "-map", "1:a:0", "-t", &v_dur.to_string(), output_path.to_str().unwrap()])
        .output()
        .await.unwrap();

    if !merge_out.status.success() {
        return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "Merge failed"}))));
    }

    let out_dur = get_duration(&output_path).await;
    let out_dur = if out_dur == 0.0 { v_dur } else { out_dur };

    // 6. Thumbnail
    let thumb_path = tmp_path.join("thumb.webp");
    Command::new("ffmpeg").args(&["-y", "-i", output_path.to_str().unwrap(), "-vframes", "1", "-ss", "0.1", "-vf", "scale=270:480:force_original_aspect_ratio=increase,crop=270:480", "-q:v", "80", thumb_path.to_str().unwrap()]).output().await.unwrap();

    let out_bytes = fs::read(&output_path).await.unwrap();
    let thumb_enc = if let Ok(t) = fs::read(&thumb_path).await {
        if !t.is_empty() { Some(BASE64.encode(t)) } else { None }
    } else { None };

    Ok(Json(MergeResponse {
        success: true,
        duration: out_dur,
        video_duration: v_dur,
        video_size: out_bytes.len(),
        video_base64: BASE64.encode(out_bytes),
        thumb_base64: thumb_enc,
    }))
}
