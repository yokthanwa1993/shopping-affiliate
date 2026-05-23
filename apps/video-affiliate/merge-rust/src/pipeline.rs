use crate::version::PIPELINE_ENGINE_VERSION;
use axum::{Json, http::StatusCode};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;
use tempfile::tempdir;
use tokio::fs;
use tokio::process::Command;
use tokio::time::{Duration, sleep};
use uuid::Uuid;

const FAST_MODE_DEFAULT_SKIP_GEMINI_AUDIO_SYNC: bool = true;
const GEMINI_WAIT_MAX_POLLS: usize = 20;
const GEMINI_WAIT_POLL_SECONDS: u64 = 2;
const GEMINI_SAFE_TRANSCODE_TIMEOUT_SECS: u64 = 300;
const GEMINI_SAFE_TRANSCODE_MIN_BYTES: usize = 1024;
const GEMINI_INLINE_VIDEO_MAX_BYTES: usize = 14 * 1024 * 1024;
const GEMINI_PREFLIGHT_MIN_DURATION_SECS: f64 = 0.3;
const GEMINI_PREFLIGHT_MAX_DURATION_SECS: f64 = 1800.0;
const VERTEX_TTS_DEFAULT_ENDPOINT: &str = "https://aiplatform.googleapis.com";
const VERTEX_TTS_DEFAULT_LOCATION: &str = "global";
const VERTEX_TTS_DEFAULT_MODEL: &str = "gemini-2.5-flash-preview-tts";

#[derive(Deserialize, Clone)]
pub struct PipelineRequest {
    pub token: String,
    pub video_url: String,
    pub chat_id: u64,
    pub msg_id: Option<u64>,
    pub api_key: String,
    pub api_keys: Option<Vec<String>>,
    pub model: Option<String>,
    pub r2_public_url: String,
    pub worker_url: String,
    pub bot_id: Option<String>,
    pub video_id: Option<String>,
    pub shopee_link: Option<String>,
    pub lazada_link: Option<String>,
    pub script_prompt: Option<String>,
    pub voice_name: Option<String>,
    pub tts_prompt_template: Option<String>,
    /// Style instructions for gemini-3.1-flash-tts-preview `systemInstruction` field.
    /// Sent separately from the script body so the model can apply voice direction without
    /// reading the style guide aloud. Falls back to `tts_prompt_template` when missing.
    pub tts_style_instructions: Option<String>,
    pub vertex_tts_endpoint: Option<String>,
    pub vertex_tts_project_id: Option<String>,
    pub vertex_tts_location: Option<String>,
    pub vertex_tts_model: Option<String>,
    pub vertex_tts_service_account_json: Option<String>,
}

#[derive(Serialize)]
pub struct PipelineResponse {
    pub status: String,
}

#[derive(Clone, Debug)]
struct ScriptPack {
    script: String,
    title: String,
    category: String,
    subtitle_lines: Vec<String>,
}

fn normalize_gemini_api_keys(keys: Option<&Vec<String>>, fallback: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();

    if let Some(raw_keys) = keys {
        for raw in raw_keys {
            let key = raw.trim().to_string();
            if key.is_empty() || seen.contains(&key) {
                continue;
            }
            seen.insert(key.clone());
            out.push(key);
            if out.len() >= 5 {
                break;
            }
        }
    }

    let fallback = fallback.trim().to_string();
    if out.is_empty() && !fallback.is_empty() {
        out.push(fallback);
    }

    out
}

fn parse_env_bool(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn should_enable_gemini_audio_sync() -> bool {
    std::env::var("VIDEO_AFFILIATE_ENABLE_GEMINI_AUDIO_SYNC")
        .ok()
        .and_then(|v| parse_env_bool(&v))
        .unwrap_or(!FAST_MODE_DEFAULT_SKIP_GEMINI_AUDIO_SYNC)
}

// ==================== HTTP Helpers ====================

async fn send_telegram(
    token: &str,
    method: &str,
    payload: &Value,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let url = format!("https://api.telegram.org/bot{}/{}", token, method);
    let client = Client::new();
    let res = client.post(&url).json(payload).send().await?;
    if !res.status().is_success() {
        let err_text = res.text().await?;
        return Err(format!("Telegram API error: {}", err_text).into());
    }
    Ok(())
}

async fn edit_status(token: &str, chat_id: u64, msg_id: Option<u64>, text: &str) {
    if let Some(m_id) = msg_id {
        let _ = send_telegram(
            token,
            "editMessageText",
            &json!({
                "chat_id": chat_id,
                "message_id": m_id,
                "text": text,
                "parse_mode": "HTML",
            }),
        )
        .await;
    }
}

async fn r2_put(
    worker_url: &str,
    token: &str,
    bot_id: &str,
    key: &str,
    data: Vec<u8>,
    content_type: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let url = format!("{}/api/r2-upload/{}", worker_url, key);
    let client = Client::new();
    let res = client
        .put(&url)
        .header("x-auth-token", token)
        .header("x-bot-id", bot_id)
        .header("content-type", content_type)
        .body(data)
        .send()
        .await?;
    if !res.status().is_success() {
        return Err(format!("R2 upload failed: {}", res.status()).into());
    }
    Ok(())
}

fn looks_like_html_document(bytes: &[u8]) -> bool {
    let prefix_len = bytes.len().min(256);
    let prefix = String::from_utf8_lossy(&bytes[..prefix_len])
        .trim_start_matches('\u{feff}')
        .trim_start()
        .to_ascii_lowercase();
    prefix.starts_with("<!doctype html")
        || prefix.starts_with("<html")
        || prefix.starts_with("<?xml")
}

fn content_type_is_video_like(content_type: &str) -> bool {
    let normalized = content_type.trim().to_ascii_lowercase();
    normalized.starts_with("video/")
        || normalized.contains("application/octet-stream")
        || normalized.contains("binary/octet-stream")
}

fn validate_downloaded_video(
    bytes: &[u8],
    content_type: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if bytes.is_empty() {
        return Err("ดาวน์โหลดวิดีโอได้ไฟล์ว่าง".into());
    }

    if looks_like_html_document(bytes) {
        return Err("ดาวน์โหลดได้เป็นหน้า HTML ไม่ใช่ไฟล์วิดีโอจริง".into());
    }

    let normalized = content_type.trim().to_ascii_lowercase();
    if !normalized.is_empty()
        && !content_type_is_video_like(&normalized)
        && (normalized.starts_with("text/")
            || normalized.contains("html")
            || normalized.contains("json")
            || normalized.contains("xml"))
    {
        return Err(format!("ดาวน์โหลดได้ content-type ไม่ใช่วิดีโอ: {}", content_type).into());
    }

    Ok(())
}

async fn download_video_bytes(
    client: &Client,
    req: &PipelineRequest,
    bot_id: &str,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    let response = tokio::time::timeout(
        Duration::from_secs(120),
        client
            .get(&req.video_url)
            .header("x-auth-token", &req.token)
            .header("x-bot-id", bot_id)
            .send(),
    )
    .await
    .map_err(|_| "ดาวน์โหลดวิดีโอ timeout (120s)")?
    .map_err(|e| format!("ดาวน์โหลดวิดีโอล้มเหลว: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("ดาวน์โหลดวิดีโอล้มเหลว: HTTP {}", status).into());
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("ดาวน์โหลดวิดีโอล้มเหลว: {}", e))?;
    validate_downloaded_video(bytes.as_ref(), &content_type)?;
    Ok(bytes.to_vec())
}

async fn update_step(
    worker_url: &str,
    token: &str,
    bot_id: &str,
    video_id: &str,
    step: f64,
    step_name: &str,
) {
    let url = format!("{}/api/r2-proxy/_processing/{}.json", worker_url, video_id);
    let client = Client::new();
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

    let mut data = match client
        .get(&url)
        .header("x-auth-token", token)
        .header("x-bot-id", bot_id)
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => res.json::<Value>().await.unwrap_or(json!({})),
        _ => json!({ "id": video_id, "status": "processing", "createdAt": now }),
    };

    if let Some(obj) = data.as_object_mut() {
        obj.insert("step".to_string(), json!(step));
        obj.insert("stepName".to_string(), json!(step_name));
        obj.insert("updatedAt".to_string(), json!(now));
    }

    let _ = r2_put(
        worker_url,
        token,
        &bot_id,
        &format!("_processing/{}.json", video_id),
        serde_json::to_vec(&data).unwrap(),
        "application/json",
    )
    .await;
}

// ==================== Gemini API ====================

async fn gemini_upload_bytes(
    file_bytes: &[u8],
    mime_type: &str,
    api_key: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let url = format!(
        "https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=media&key={}",
        api_key
    );
    let client = Client::new();
    let res = client
        .post(&url)
        .header("Content-Type", mime_type)
        .header("X-Goog-Upload-Protocol", "raw")
        .body(file_bytes.to_vec())
        .send()
        .await?;

    let json: Value = res.json().await?;
    if let Some(uri) = json
        .get("file")
        .and_then(|f| f.get("uri"))
        .and_then(|u| u.as_str())
    {
        Ok(uri.to_string())
    } else {
        Err(format!("Upload failed: {}", json).into())
    }
}

fn extract_gemini_file_state(json: &Value) -> Option<String> {
    json.get("state")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .or_else(|| {
            json.get("state")
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str().map(|s| s.to_string()))
        })
        .or_else(|| {
            json.get("file")
                .and_then(|v| v.get("state"))
                .and_then(|v| v.as_str().map(|s| s.to_string()))
        })
        .or_else(|| {
            json.get("file")
                .and_then(|v| v.get("state"))
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str().map(|s| s.to_string()))
        })
}

fn is_gemini_file_not_ready_error(status: u16, err: &str) -> bool {
    status == 400
        && (err.contains("FAILED_PRECONDITION")
            || err.contains("not in an ACTIVE state")
            || err.contains("usage is not allowed"))
}

fn is_gemini_file_processing_failed_error(err: &str) -> bool {
    let normalized = err.to_ascii_lowercase();
    normalized.contains("gemini file processing failed")
        || (normalized.contains("\"state\":\"failed\"")
            && normalized.contains("file failed to be processed"))
        || (normalized.contains("state: failed")
            && normalized.contains("file failed to be processed"))
}

fn extract_gemini_failed_summary(json: &Value) -> String {
    let error_node = json
        .get("error")
        .or_else(|| json.get("file").and_then(|f| f.get("error")));
    let code = error_node
        .and_then(|e| e.get("code"))
        .and_then(|c| c.as_i64());
    let message = error_node
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let name = json
        .get("name")
        .or_else(|| json.get("file").and_then(|f| f.get("name")))
        .and_then(|n| n.as_str())
        .unwrap_or("");
    let mut parts: Vec<String> = Vec::new();
    if let Some(c) = code {
        parts.push(format!("code {}", c));
    }
    if !message.is_empty() {
        parts.push(message);
    }
    if !name.is_empty() {
        parts.push(format!("file={}", name));
    }
    if parts.is_empty() {
        "no error detail returned".to_string()
    } else {
        parts.join(" — ")
    }
}

fn pipeline_error_category(err: &str) -> &'static str {
    let normalized = err.to_ascii_lowercase();
    if normalized.contains("source_video_invalid") {
        "source_video_invalid"
    } else if normalized.contains("gemini-safe output invalid") {
        "gemini_safe_output_invalid"
    } else if normalized.contains("gemini-strict output invalid") {
        "gemini_strict_output_invalid"
    } else if normalized.contains("gemini-safe transcode timed out") {
        "gemini_safe_transcode_timeout"
    } else if normalized.contains("gemini-safe transcode failed") {
        "gemini_safe_transcode_failed"
    } else if normalized.contains("gemini-strict transcode timed out") {
        "gemini_strict_transcode_timeout"
    } else if normalized.contains("gemini-strict transcode failed") {
        "gemini_strict_transcode_failed"
    } else if normalized.contains("gemini file processing failed")
        || normalized.contains("file failed to be processed")
    {
        "gemini_file_processing_failed"
    } else if normalized.contains("gemini file did not become active") {
        "gemini_file_wait_timeout"
    } else if normalized.contains("gemini") {
        "gemini_pipeline_failed"
    } else if normalized.contains("ffmpeg") && normalized.contains("timed out") {
        "ffmpeg_timeout"
    } else {
        "container_pipeline_failed"
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GeminiTranscodeProfile {
    /// Upload profile used for Gemini analysis: 720px-max, CFR 24fps,
    /// H.264 constrained baseline, yuv420p, mono AAC, stripped metadata.
    Safe,
    /// Second-pass retry for files Gemini still rejects after the safe profile:
    /// smaller video-only MP4 to remove audio-container compatibility variables.
    Strict,
}

impl GeminiTranscodeProfile {
    fn label(&self) -> &'static str {
        match self {
            GeminiTranscodeProfile::Safe => "gemini-safe",
            GeminiTranscodeProfile::Strict => "gemini-strict",
        }
    }

    fn max_side(&self) -> u32 {
        match self {
            GeminiTranscodeProfile::Safe => 720,
            GeminiTranscodeProfile::Strict => 480,
        }
    }

    fn fps(&self) -> u32 {
        24
    }

    fn video_only(&self) -> bool {
        matches!(self, GeminiTranscodeProfile::Strict)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GeminiUploadVariant {
    Safe,
    Strict,
}

impl GeminiUploadVariant {
    fn label(&self) -> &'static str {
        match self {
            GeminiUploadVariant::Safe => "gemini-safe",
            GeminiUploadVariant::Strict => "gemini-strict",
        }
    }
}

fn should_retry_gemini_with_strict(variant: GeminiUploadVariant, err: &str) -> bool {
    variant == GeminiUploadVariant::Safe && is_gemini_file_processing_failed_error(err)
}

fn should_retry_gemini_with_inline_video(
    variant: GeminiUploadVariant,
    err: &str,
    bytes_len: usize,
) -> bool {
    variant == GeminiUploadVariant::Strict
        && bytes_len <= GEMINI_INLINE_VIDEO_MAX_BYTES
        && is_gemini_file_processing_failed_error(err)
}

fn build_gemini_transcode_filter(profile: GeminiTranscodeProfile) -> String {
    let max_side = profile.max_side();
    let fps = profile.fps();
    // Cap the longest side, keep aspect ratio, force even dimensions for libx264,
    // pin to constant framerate from timestamp zero, and lock pixel format to yuv420p.
    format!(
        "scale='if(gt(iw,ih),min({max_side},iw),-2)':'if(gt(iw,ih),-2,min({max_side},ih))':flags=lanczos,\
         scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,fps={fps},setpts=N/({fps}*TB),format=yuv420p",
        max_side = max_side,
        fps = fps,
    )
}

async fn transcode_video_for_gemini_with_profile(
    input_path: &Path,
    output_path: &Path,
    profile: GeminiTranscodeProfile,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    let input_str = input_path.to_str().ok_or("invalid_input_path")?;
    let output_str = output_path.to_str().ok_or("invalid_output_path")?;
    let vf_filter = build_gemini_transcode_filter(profile);

    let mut args: Vec<&str> = vec![
        "-y",
        "-fflags",
        "+genpts+igndts",
        "-i",
        input_str,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-sn",
        "-dn",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-vf",
        vf_filter.as_str(),
        "-c:v",
        "libx264",
    ];

    match profile {
        GeminiTranscodeProfile::Safe | GeminiTranscodeProfile::Strict => {
            args.extend([
                "-profile:v",
                "baseline",
                "-level",
                "3.1",
                "-preset",
                "medium",
                "-crf",
                "26",
                "-bf",
                "0",
                "-refs",
                "1",
                "-g",
                "48",
                "-fps_mode",
                "cfr",
                "-tag:v",
                "avc1",
            ]);
        }
    }

    args.extend(["-pix_fmt", "yuv420p"]);

    if profile.video_only() {
        args.extend(["-an"]);
    } else {
        // Force a clean, mainstream audio track for the primary Gemini upload.
        args.extend([
            "-af",
            "asetpts=PTS-STARTPTS",
            "-c:a",
            "aac",
            "-ar",
            "44100",
            "-ac",
            "1",
            "-b:a",
            "96k",
            "-async",
            "1",
        ]);
    }

    args.extend([
        "-avoid_negative_ts",
        "make_zero",
        "-max_muxing_queue_size",
        "4096",
        "-movflags",
        "+faststart",
        output_str,
    ]);

    let output =
        match tokio::time::timeout(Duration::from_secs(GEMINI_SAFE_TRANSCODE_TIMEOUT_SECS), {
            let mut command = Command::new("ffmpeg");
            command.kill_on_drop(true).args(&args);
            command.output()
        })
        .await
        {
            Err(_) => {
                return Err(format!(
                    "{} transcode timed out after {}s",
                    profile.label(),
                    GEMINI_SAFE_TRANSCODE_TIMEOUT_SECS
                )
                .into());
            }
            Ok(result) => result?,
        };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "{} transcode failed: {}",
            profile.label(),
            stderr.chars().take(500).collect::<String>()
        )
        .into());
    }

    let bytes = fs::read(output_path).await?;
    if bytes.len() < GEMINI_SAFE_TRANSCODE_MIN_BYTES {
        return Err(format!("{} transcode produced an empty video", profile.label()).into());
    }
    let preflight = preflight_probe_for_gemini(output_path)
        .await
        .map_err(|e| format!("{} transcode preflight failed: {}", profile.label(), e))?;
    validate_gemini_safe_output(&preflight)
        .map_err(|e| format!("{} output invalid: {}", profile.label(), e))?;
    println!(
        "[PIPELINE] {} transcode preflight ok: {}",
        profile.label(),
        format_gemini_preflight_info(&preflight)
    );
    println!(
        "[PIPELINE] {} transcode preflight detail: {}",
        profile.label(),
        gemini_preflight_sanitized_json(&preflight)
    );
    Ok(bytes)
}

async fn transcode_video_for_gemini(
    input_path: &Path,
    output_path: &Path,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    transcode_video_for_gemini_with_profile(input_path, output_path, GeminiTranscodeProfile::Safe)
        .await
}

async fn transcode_video_for_gemini_strict(
    input_path: &Path,
    output_path: &Path,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    transcode_video_for_gemini_with_profile(input_path, output_path, GeminiTranscodeProfile::Strict)
        .await
}

#[derive(Debug, Clone)]
struct GeminiPreflightInfo {
    duration: f64,
    video_codec: Option<String>,
    video_profile: Option<String>,
    pixel_format: Option<String>,
    width: u32,
    height: u32,
    has_audio: bool,
    audio_codec: Option<String>,
}

#[derive(Debug, Clone)]
enum GeminiPreflightError {
    NoVideoStream,
    InvalidDimensions { width: u32, height: u32 },
    DurationOutOfRange { duration: f64 },
    ProbeFailed { reason: String },
}

impl std::fmt::Display for GeminiPreflightError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GeminiPreflightError::NoVideoStream => {
                write!(f, "no video stream detected in source")
            }
            GeminiPreflightError::InvalidDimensions { width, height } => {
                write!(f, "invalid video dimensions {}x{}", width, height)
            }
            GeminiPreflightError::DurationOutOfRange { duration } => write!(
                f,
                "video duration {:.2}s is outside supported range ({:.1}–{:.0}s)",
                duration, GEMINI_PREFLIGHT_MIN_DURATION_SECS, GEMINI_PREFLIGHT_MAX_DURATION_SECS
            ),
            GeminiPreflightError::ProbeFailed { reason } => {
                write!(f, "ffprobe failed: {}", reason)
            }
        }
    }
}

fn format_gemini_preflight_info(info: &GeminiPreflightInfo) -> String {
    format!(
        "duration={:.2}s codec={} profile={} pix_fmt={} size={}x{} audio={} audio_codec={}",
        info.duration,
        info.video_codec.as_deref().unwrap_or("unknown"),
        info.video_profile.as_deref().unwrap_or("unknown"),
        info.pixel_format.as_deref().unwrap_or("unknown"),
        info.width,
        info.height,
        info.has_audio,
        info.audio_codec.as_deref().unwrap_or("none")
    )
}

fn gemini_preflight_sanitized_json(info: &GeminiPreflightInfo) -> Value {
    json!({
        "durationSeconds": info.duration,
        "videoCodec": info.video_codec.clone(),
        "videoProfile": info.video_profile.clone(),
        "pixelFormat": info.pixel_format.clone(),
        "width": info.width,
        "height": info.height,
        "hasAudio": info.has_audio,
        "audioCodec": info.audio_codec.clone(),
    })
}

fn validate_gemini_safe_output(info: &GeminiPreflightInfo) -> Result<(), String> {
    if info.video_codec.as_deref() != Some("h264") {
        return Err(format!(
            "expected h264 video codec, got {}",
            info.video_codec.as_deref().unwrap_or("unknown")
        ));
    }
    let profile = info
        .video_profile
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase();
    if !profile.contains("baseline") {
        return Err(format!(
            "expected baseline h264 profile, got {}",
            info.video_profile.as_deref().unwrap_or("unknown")
        ));
    }
    if info.pixel_format.as_deref() != Some("yuv420p") {
        return Err(format!(
            "expected yuv420p pixel format, got {}",
            info.pixel_format.as_deref().unwrap_or("unknown")
        ));
    }
    if info.width % 2 != 0 || info.height % 2 != 0 {
        return Err(format!(
            "expected even dimensions, got {}x{}",
            info.width, info.height
        ));
    }
    if info.width.max(info.height) > 720 {
        return Err(format!(
            "expected max side <=720, got {}x{}",
            info.width, info.height
        ));
    }
    if info.has_audio && info.audio_codec.as_deref() != Some("aac") {
        return Err(format!(
            "expected AAC audio, got {}",
            info.audio_codec.as_deref().unwrap_or("unknown")
        ));
    }
    Ok(())
}

async fn preflight_probe_for_gemini(
    input_path: &Path,
) -> Result<GeminiPreflightInfo, GeminiPreflightError> {
    let input_str = input_path
        .to_str()
        .ok_or_else(|| GeminiPreflightError::ProbeFailed {
            reason: "invalid_input_path".to_string(),
        })?;
    let output = Command::new("ffprobe")
        .args(&[
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            input_str,
        ])
        .output()
        .await
        .map_err(|e| GeminiPreflightError::ProbeFailed {
            reason: e.to_string(),
        })?;

    if !output.status.success() {
        return Err(GeminiPreflightError::ProbeFailed {
            reason: String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(200)
                .collect(),
        });
    }

    let json: Value =
        serde_json::from_slice(&output.stdout).map_err(|e| GeminiPreflightError::ProbeFailed {
            reason: format!("invalid_probe_json: {}", e),
        })?;
    parse_gemini_preflight_info(&json)
}

fn parse_gemini_preflight_info(json: &Value) -> Result<GeminiPreflightInfo, GeminiPreflightError> {
    let streams = json
        .get("streams")
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();
    let video_stream = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(|t| t.as_str()) == Some("video"));
    let audio_stream = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(|t| t.as_str()) == Some("audio"));

    let Some(video) = video_stream else {
        return Err(GeminiPreflightError::NoVideoStream);
    };

    let video_codec = video
        .get("codec_name")
        .and_then(|c| c.as_str())
        .map(|s| s.to_string());
    let video_profile = video
        .get("profile")
        .and_then(|c| c.as_str())
        .map(|s| s.to_string());
    let pixel_format = video
        .get("pix_fmt")
        .and_then(|c| c.as_str())
        .map(|s| s.to_string());
    let width = video.get("width").and_then(|w| w.as_u64()).unwrap_or(0) as u32;
    let height = video.get("height").and_then(|h| h.as_u64()).unwrap_or(0) as u32;
    if width == 0 || height == 0 {
        return Err(GeminiPreflightError::InvalidDimensions { width, height });
    }

    let format_duration = json
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    let stream_duration = video
        .get("duration")
        .and_then(|d| d.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    let duration = if format_duration > 0.0 {
        format_duration
    } else {
        stream_duration
    };

    if !(GEMINI_PREFLIGHT_MIN_DURATION_SECS..=GEMINI_PREFLIGHT_MAX_DURATION_SECS)
        .contains(&duration)
    {
        return Err(GeminiPreflightError::DurationOutOfRange { duration });
    }

    Ok(GeminiPreflightInfo {
        duration,
        video_codec,
        video_profile,
        pixel_format,
        width,
        height,
        has_audio: audio_stream.is_some(),
        audio_codec: audio_stream
            .and_then(|s| s.get("codec_name"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string()),
    })
}

fn extract_srt_payload(raw: &str) -> String {
    let normalized = raw.replace("\r\n", "\n").trim().to_string();
    if normalized.is_empty() {
        return String::new();
    }

    if !normalized.contains("```") {
        return normalized;
    }

    let mut best = String::new();
    for part in normalized.split("```") {
        let mut candidate = part.trim().to_string();
        if candidate.starts_with("srt\n") || candidate.starts_with("SRT\n") {
            candidate = candidate
                .split_once('\n')
                .map(|(_, tail)| tail.to_string())
                .unwrap_or_default();
        }
        if candidate.contains("-->") && candidate.len() > best.len() {
            best = candidate;
        }
    }

    if best.is_empty() { normalized } else { best }
}

fn normalize_srt_blocks(raw_srt: &str, max_duration: f64) -> String {
    let blocks = parse_srt_blocks_with_text(raw_srt);
    if blocks.is_empty() {
        return String::new();
    }

    let max_duration = max_duration.max(0.1);
    let mut out = String::new();
    let mut cursor = 0.0f64;
    let mut idx = 1usize;
    for (start, end, text) in blocks {
        let mut s = start.max(0.0).max(cursor);
        let mut e = end.max(s + 0.12);
        s = s.min(max_duration);
        e = e.min(max_duration);
        if e <= s {
            continue;
        }
        out.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            idx,
            format_srt_time(s),
            format_srt_time(e),
            text.trim()
        ));
        cursor = e;
        idx += 1;
    }
    out
}

fn remap_srt_blocks_to_window(
    raw_srt: &str,
    target_start: f64,
    target_end: f64,
    max_duration: f64,
) -> String {
    let blocks = parse_srt_blocks_with_text(raw_srt);
    if blocks.is_empty() {
        return String::new();
    }

    let source_start = blocks.first().map(|(s, _, _)| *s).unwrap_or(0.0);
    let source_end = blocks.last().map(|(_, e, _)| *e).unwrap_or(0.0);
    let source_span = (source_end - source_start).max(0.0);
    let target_span = (target_end - target_start).max(0.0);
    if source_span < 0.1 || target_span < 0.1 {
        return normalize_srt_blocks(raw_srt, max_duration);
    }

    let scale = target_span / source_span;
    let mut remapped = String::new();
    for (idx, (start, end, text)) in blocks.into_iter().enumerate() {
        let mut s = target_start + (start - source_start).max(0.0) * scale;
        let mut e = target_start + (end - source_start).max(0.0) * scale;
        if e <= s {
            e = s + 0.12;
        }
        s = s.max(0.0);
        e = e.max(s + 0.12);
        remapped.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            idx + 1,
            format_srt_time(s),
            format_srt_time(e),
            text.trim()
        ));
    }

    normalize_srt_blocks(&remapped, max_duration)
}

async fn detect_audio_activity_window(
    audio_path: &Path,
    audio_duration: f64,
) -> Option<(f64, f64)> {
    let out = Command::new("ffmpeg")
        .args(&[
            "-hide_banner",
            "-i",
            audio_path.to_str()?,
            "-af",
            "silencedetect=noise=-35dB:d=0.05",
            "-f",
            "null",
            "-",
        ])
        .output()
        .await
        .ok()?;

    let stderr = String::from_utf8_lossy(&out.stderr);
    let mut current_silence_start: Option<f64> = None;
    let mut first_active = 0.0f64;
    let mut last_active = audio_duration.max(0.0);

    for line in stderr.lines() {
        if let Some(idx) = line.find("silence_start:") {
            let raw = line[idx + "silence_start:".len()..].trim();
            if let Ok(value) = raw.parse::<f64>() {
                current_silence_start = Some(value);
            }
            continue;
        }

        if let Some(idx) = line.find("silence_end:") {
            let raw = line[idx + "silence_end:".len()..]
                .split('|')
                .next()
                .unwrap_or("")
                .trim();
            if let Ok(end_value) = raw.parse::<f64>() {
                let start_value = current_silence_start.take().unwrap_or(0.0);
                if start_value <= 0.02 {
                    first_active = end_value.min(audio_duration);
                }
                if end_value >= audio_duration - 0.05 {
                    last_active = start_value.max(first_active).min(audio_duration);
                }
            }
        }
    }

    if last_active <= first_active {
        last_active = audio_duration.max(first_active);
    }

    if first_active > 0.02 || last_active < audio_duration - 0.02 {
        Some((first_active, last_active))
    } else {
        None
    }
}

async fn gemini_srt_from_audio(
    file_uri: &str,
    subtitle_lines: &[String],
    api_key: &str,
    model: &str,
    duration: f64,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let lines = normalize_subtitle_lines(subtitle_lines, 20);
    let lines_text = if lines.is_empty() {
        "(ไม่มี subtitle_lines)".to_string()
    } else {
        lines
            .iter()
            .enumerate()
            .map(|(i, s)| format!("{}. {}", i + 1, s))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let prompt = format!(
        "ให้ฟังไฟล์เสียงพากย์ภาษาไทยนี้ แล้วสร้างไฟล์ซับ .srt ที่ตรงกับจังหวะเสียงพูดจริง\n\
         ข้อบังคับ:\n\
         1) ใช้ข้อความซับจากรายการด้านล่างนี้เท่านั้น (ห้ามเปลี่ยนคำ ห้ามเพิ่ม ห้ามลด)\n\
         2) คืนผลลัพธ์เป็น SRT ล้วนๆ เท่านั้น (ไม่ต้องมี markdown)\n\
         3) ถ้ามีช่วงเงียบก่อนเริ่มพูด ให้ timecode แรกเริ่มตามเสียงจริง ไม่ต้องบังคับเริ่มที่ 0 เสมอไป\n\
         4) จบบรรทัดสุดท้ายไม่เกิน {duration:.3} วินาที\n\
         5) timecode ต้องเรียงต่อเนื่อง ไม่ย้อนเวลา\n\n\
         รายการซับที่ต้องใช้:\n\
         {lines_text}",
        duration = duration.max(1.0),
        lines_text = lines_text,
    );

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        model, api_key
    );
    let client = Client::new();
    let payload = json!({
        "contents": [{
            "parts": [
                {"file_data": {"mime_type": "audio/wav", "file_uri": file_uri}},
                {"text": prompt}
            ]
        }],
        "generationConfig": {
            "temperature": 0.1
        }
    });

    let mut resp_text = String::new();
    let mut last_err = String::new();
    for attempt in 0..6 {
        if attempt > 0 {
            tokio::time::sleep(tokio::time::Duration::from_secs(5 * attempt)).await;
            println!("[PIPELINE] gemini_srt retry #{}", attempt);
        }
        let res = client.post(&url).json(&payload).send().await?;
        if res.status().is_success() {
            let json: Value = res.json().await?;
            if let Some(text) = json
                .get("candidates")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("content"))
                .and_then(|c| c.get("parts"))
                .and_then(|p| p.get(0))
                .and_then(|p| p.get("text"))
                .and_then(|t| t.as_str())
            {
                resp_text = text.to_string();
            }
            break;
        } else {
            let status = res.status().as_u16();
            let err = res.text().await?;
            last_err = format!("Gemini SRT Error: {}", err);
            println!(
                "[PIPELINE] gemini_srt attempt {} failed ({}): {}",
                attempt, status, err
            );
            if is_gemini_file_not_ready_error(status, &err) {
                continue;
            }
            if status != 503 && status != 500 && status != 429 {
                return Err(last_err.into());
            }
        }
    }

    if resp_text.is_empty() && !last_err.is_empty() {
        return Err(last_err.into());
    }

    let extracted = extract_srt_payload(&resp_text);
    let normalized = normalize_srt_blocks(&extracted, duration.max(1.0));
    Ok(normalized)
}

async fn gemini_wait(
    file_uri: &str,
    api_key: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let file_name = file_uri.split("/files/").last().unwrap_or("");
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/files/{}?key={}",
        file_name, api_key
    );
    let client = Client::new();
    let mut last_state = String::new();

    for attempt in 0..36 {
        // max 3 mins (36 * 5s)
        if let Ok(res) = client.get(&url).send().await {
            if let Ok(json) = res.json::<Value>().await {
                if let Some(state) = extract_gemini_file_state(&json) {
                    last_state = state.clone();
                    if state == "ACTIVE" {
                        return Ok(file_uri.to_string());
                    }
                    if state == "FAILED" {
                        let summary = extract_gemini_failed_summary(&json);
                        return Err(format!("Gemini file processing failed: {}", summary).into());
                    }
                    println!("[PIPELINE] gemini_wait attempt {} state={}", attempt, state);
                }
            }
        }
        sleep(Duration::from_secs(5)).await;
    }
    Err(format!(
        "Gemini file did not become ACTIVE in time (last_state={})",
        if last_state.is_empty() {
            "unknown"
        } else {
            &last_state
        }
    )
    .into())
}

fn render_script_prompt_template(
    template: &str,
    duration: f64,
    min_chars: i32,
    max_chars: i32,
) -> String {
    template
        .replace("{{duration_seconds}}", &format!("{:.1}", duration))
        .replace("{{min_chars}}", &min_chars.to_string())
        .replace("{{max_chars}}", &max_chars.to_string())
}

fn default_script_prompt_template() -> &'static str {
    "คุณคือคอนเทนต์ครีเอเตอร์และนักพากย์มืออาชีพสำหรับคลิปสั้นแนว Reels\n\n\
    งานของคุณ:\n\
    1) วิเคราะห์วิดีโออย่างละเอียดก่อนเขียน: ฉากเปิด, การกระทำหลัก, จุดพีค, อารมณ์, และเจตนาของคลิป\n\
    2) เลือกแนวพากย์ให้เหมาะกับเนื้อหาจริง (รีวิวสินค้า/สาธิต/ไวรัล/เล่าเรื่อง/ตลก)\n\
    3) เขียนบทพากย์ไทยที่ลื่นไหล ฟังธรรมชาติ ไม่ท่องแพทเทิร์นเดิม\n\n\
    กฎบังคับ:\n\
    - ห้ามใช้คำเปิดซ้ำทุกคลิป เช่น \"แม่จ๋า\", \"อุ๊ยตาย\", \"ของมันต้องมี\" เว้นแต่ภาพบังคับจริง\n\
    - ห้ามใช้คำหรือโครงประโยคซ้ำติดกัน ต้องมีความหลากหลายของถ้อยคำ\n\
    - ทุกประโยคต้องอิงสิ่งที่เห็นในวิดีโอจริง ห้ามมโนรายละเอียดที่ไม่ปรากฏ\n\
    - ถ้าเป็นคลิปไวรัล/บันเทิงที่ไม่ใช่รีวิวสินค้า ให้พากย์แบบเล่าเหตุการณ์หรือคอมเมนต์เชิงคอนเทนต์แทนการ hard sell\n\
    - ถ้าคลิปมีสินค้าและจุดขายชัดเจน ค่อยใส่ CTA สั้นๆ ท้ายคลิปแบบพอดี\n\
    - ห้ามขึ้นต้นด้วยคำว่า \"สวัสดี\"\n\
    - โทนโดยรวมต้องเป็นมืออาชีพ มีพลัง และตรงจังหวะภาพ"
}

fn build_script_prompt(
    user_prompt: Option<&str>,
    duration: f64,
    min_chars: i32,
    max_chars: i32,
) -> String {
    let base_prompt = user_prompt
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .unwrap_or(default_script_prompt_template());
    let rendered_base = render_script_prompt_template(base_prompt, duration, min_chars, max_chars);

    format!(
        "{rendered_base}\n\n\
        ⏱️ ความยาววิดีโอ {duration:.1} วินาที\n\
        ⚠️ ความยาว script ต้องอยู่ในช่วง {min_chars}-{max_chars} ตัวอักษร และพูดจบพอดีกับคลิป\n\
        ⚠️ subtitle_lines ต้องมาจาก thai_script เดียวกันเป๊ะ ห้ามเพิ่มหรือลดเนื้อหา\n\
        ⚠️ subtitle_lines ต้องแบ่งจังหวะอ่านจริง ไม่ตัดกลางคำไทย และพยายามให้ไม่เกิน ~15 ตัวอักษรต่อบรรทัด\n\n\
        ตอบเป็น JSON เท่านั้น:\n\
        {{\n\
          \"thai_script\": \"บทพากย์ภาษาไทยที่ตรงกับวิดีโอจริง\",\n\
          \"subtitle_lines\": [\"บรรทัดซับ 1\", \"บรรทัดซับ 2\", \"...\"],\n\
          \"title\": \"แคปชั่นสั้นกระชับตามเนื้อหาคลิป ไม่เว่อร์เกินจริง\",\n\
          \"category\": \"เลือกจาก: เครื่องมือช่าง/อาหาร/เครื่องครัว/ของใช้ในบ้าน/เฟอร์นิเจอร์/บิวตี้/แฟชั่น/อิเล็กทรอนิกส์/สุขภาพ/กีฬา/สัตว์เลี้ยง/ยานยนต์/อื่นๆ\"\n\
        }}",
        rendered_base = rendered_base,
        duration = duration,
        min_chars = min_chars,
        max_chars = max_chars
    )
}

async fn gemini_script(
    file_uri: &str,
    api_key: &str,
    model: &str,
    duration: f64,
    user_prompt: Option<&str>,
) -> Result<ScriptPack, Box<dyn std::error::Error + Send + Sync>> {
    gemini_script_with_video_part(
        json!({"file_data": {"mime_type": "video/mp4", "file_uri": file_uri}}),
        api_key,
        model,
        duration,
        user_prompt,
        "file",
    )
    .await
}

async fn gemini_script_inline_video(
    file_bytes: &[u8],
    api_key: &str,
    model: &str,
    duration: f64,
    user_prompt: Option<&str>,
) -> Result<ScriptPack, Box<dyn std::error::Error + Send + Sync>> {
    gemini_script_with_video_part(
        build_gemini_inline_video_part(file_bytes),
        api_key,
        model,
        duration,
        user_prompt,
        "inline-video",
    )
    .await
}

fn build_gemini_inline_video_part(file_bytes: &[u8]) -> Value {
    json!({
        "inlineData": {
            "mimeType": "video/mp4",
            "data": BASE64.encode(file_bytes),
        }
    })
}

async fn gemini_script_with_video_part(
    video_part: Value,
    api_key: &str,
    model: &str,
    duration: f64,
    user_prompt: Option<&str>,
    source_label: &str,
) -> Result<ScriptPack, Box<dyn std::error::Error + Send + Sync>> {
    let max_chars = ((duration * 10.0) as i32).min(800);
    let min_chars = ((duration * 7.0) as i32).max(80);

    let prompt = build_script_prompt(user_prompt, duration, min_chars, max_chars);

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        model, api_key
    );
    let client = Client::new();
    let payload = json!({
        "contents": [{
            "parts": [
                video_part,
                {"text": prompt}
            ]
        }],
        "generationConfig": {
            "temperature": 0.2
        }
    });

    let mut resp_text = String::new();
    let mut last_err = String::new();
    for attempt in 0..6 {
        if attempt > 0 {
            tokio::time::sleep(tokio::time::Duration::from_secs(5 * attempt)).await;
            println!(
                "[PIPELINE] gemini_script {} retry #{}",
                source_label, attempt
            );
        }
        let res = client.post(&url).json(&payload).send().await?;
        if res.status().is_success() {
            let json: Value = res.json().await?;
            if let Some(text) = json
                .get("candidates")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("content"))
                .and_then(|c| c.get("parts"))
                .and_then(|p| p.get(0))
                .and_then(|p| p.get("text"))
            {
                resp_text = text.as_str().unwrap_or("").to_string();
            }
            break;
        } else {
            let status = res.status().as_u16();
            let err = res.text().await?;
            last_err = format!("Gemini Script Error: {}", err);
            println!(
                "[PIPELINE] gemini_script {} attempt {} failed ({}): {}",
                source_label, attempt, status, err
            );
            if is_gemini_file_not_ready_error(status, &err) {
                continue;
            }
            if status != 503 && status != 500 && status != 429 {
                return Err(last_err.into());
            }
        }
    }
    if resp_text.is_empty() && !last_err.is_empty() {
        return Err(last_err.into());
    }

    let clean = resp_text
        .replace("```json", "")
        .replace("```", "")
        .trim()
        .to_string();
    let parsed: Value = serde_json::from_str(&clean).unwrap_or(json!({}));
    let script = parsed
        .get("thai_script")
        .and_then(|v| v.as_str())
        .unwrap_or(&clean)
        .to_string();
    let title = parsed
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let category = parsed
        .get("category")
        .and_then(|v| v.as_str())
        .unwrap_or("อื่นๆ")
        .to_string();
    let mut subtitle_lines: Vec<String> = parsed
        .get("subtitle_lines")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    subtitle_lines = normalize_subtitle_lines(&subtitle_lines, 15);
    if subtitle_lines.is_empty() {
        subtitle_lines = split_subtitle_chunks(&script, 15);
    }

    Ok(ScriptPack {
        script,
        title,
        category,
        subtitle_lines,
    })
}

/// Given a legacy combined template like "...style guide...\n\nบทพากย์:\n{{script}}",
/// extract just the style guide portion (everything before "บทพากย์:" or "{{script}}").
/// Returns None if the template is empty or has no separable style portion.
fn extract_style_from_legacy_template(template: Option<&str>) -> Option<String> {
    let trimmed = template.unwrap_or("").trim();
    if trimmed.is_empty() {
        return None;
    }
    // Try the script header first ("บทพากย์:") which the worker template emits.
    let cut = trimmed
        .find("บทพากย์:")
        .or_else(|| trimmed.find("{{script}}"));
    let style_portion = match cut {
        Some(idx) => trimmed[..idx].trim().to_string(),
        None => trimmed.to_string(),
    };
    if style_portion.is_empty() {
        None
    } else {
        Some(style_portion)
    }
}

#[derive(Deserialize)]
struct VertexServiceAccount {
    client_email: String,
    private_key: String,
    token_uri: Option<String>,
    project_id: Option<String>,
}

#[derive(Serialize)]
struct VertexJwtClaims {
    iss: String,
    scope: String,
    aud: String,
    iat: i64,
    exp: i64,
}

fn redact_vertex_error(body: &str) -> String {
    body.replace('\n', " ")
        .chars()
        .take(300)
        .collect::<String>()
}

fn load_vertex_service_account(
    request_raw_json: Option<&str>,
) -> Result<VertexServiceAccount, Box<dyn std::error::Error + Send + Sync>> {
    if let Some(raw_json) = request_raw_json {
        let trimmed = raw_json.trim();
        if !trimmed.is_empty() {
            return Ok(serde_json::from_str(trimmed)?);
        }
    }
    if let Ok(raw_json) = std::env::var("VERTEX_TTS_SERVICE_ACCOUNT_JSON") {
        let trimmed = raw_json.trim();
        if !trimmed.is_empty() {
            return Ok(serde_json::from_str(trimmed)?);
        }
    }
    let path = std::env::var("GOOGLE_APPLICATION_CREDENTIALS")
        .map_err(|_| "Vertex TTS service account is not configured (GOOGLE_APPLICATION_CREDENTIALS or VERTEX_TTS_SERVICE_ACCOUNT_JSON)")?;
    let raw_json = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&raw_json)?)
}

async fn fetch_vertex_access_token(
    client: &Client,
    service_account: &VertexServiceAccount,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let token_uri = service_account
        .token_uri
        .as_deref()
        .unwrap_or("https://oauth2.googleapis.com/token");
    let now = chrono::Utc::now().timestamp();
    let claims = VertexJwtClaims {
        iss: service_account.client_email.clone(),
        scope: "https://www.googleapis.com/auth/cloud-platform".to_string(),
        aud: token_uri.to_string(),
        iat: now,
        exp: now + 3600,
    };
    let jwt = jsonwebtoken::encode(
        &Header::new(Algorithm::RS256),
        &claims,
        &EncodingKey::from_rsa_pem(service_account.private_key.as_bytes())?,
    )?;
    let form_body = format!(
        "grant_type={}&assertion={}",
        urlencoding::encode("urn:ietf:params:oauth:grant-type:jwt-bearer"),
        urlencoding::encode(&jwt),
    );
    let resp = client
        .post(token_uri)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(form_body)
        .send()
        .await?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(format!(
            "Vertex OAuth token exchange failed: http_{} {}",
            status,
            redact_vertex_error(&body)
        )
        .into());
    }
    let data: Value = serde_json::from_str(&body)?;
    let token = data
        .get("access_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if token.is_empty() {
        return Err("Vertex OAuth token exchange returned no access_token".into());
    }
    Ok(token.to_string())
}

fn build_tts_payload(
    script: &str,
    voice_name: Option<&str>,
    tts_prompt_template: Option<&str>,
    tts_style_instructions: Option<&str>,
) -> Value {
    let selected_voice = voice_name
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("Puck");
    let style_text: String = tts_style_instructions
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| extract_style_from_legacy_template(tts_prompt_template))
        .unwrap_or_default();
    let script_only = script.trim().to_string();
    let mut payload = json!({
        "contents": [{"role": "user", "parts": [{"text": script_only}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": selected_voice}}}
        }
    });
    if !style_text.is_empty() {
        payload["systemInstruction"] = json!({
            "parts": [{"text": format!(
                "นี่คือคำสั่งกำกับสไตล์เสียงเท่านั้น ห้ามอ่านออกเสียง ห้ามใส่คำสั่งนี้ในเสียงพากย์ ให้พูดเฉพาะข้อความบทพากย์จากผู้ใช้เท่านั้น\n{}",
                style_text
            )}]
        });
    }
    payload
}

fn extract_tts_audio_b64(json: &Value) -> Option<String> {
    json.get("candidates")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.get(0))
        .and_then(|p| p.get("inlineData"))
        .and_then(|i| i.get("data"))
        .and_then(|d| d.as_str())
        .map(|s| s.to_string())
}

async fn vertex_gemini_tts(
    script: &str,
    voice_name: Option<&str>,
    tts_prompt_template: Option<&str>,
    tts_style_instructions: Option<&str>,
    request_project_id: Option<&str>,
    request_location: Option<&str>,
    request_model: Option<&str>,
    request_endpoint: Option<&str>,
    request_service_account_json: Option<&str>,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let client = Client::new();
    let service_account = load_vertex_service_account(request_service_account_json)?;
    let access_token = fetch_vertex_access_token(&client, &service_account).await?;
    let env_project_id = std::env::var("VERTEX_TTS_PROJECT_ID").ok();
    let project_id = request_project_id
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            env_project_id
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
        .or_else(|| {
            service_account
                .project_id
                .clone()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
        .ok_or("Vertex TTS project_id is not configured")?;
    let env_location = std::env::var("VERTEX_TTS_LOCATION").ok();
    let location = request_location
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            env_location
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
        .unwrap_or_else(|| VERTEX_TTS_DEFAULT_LOCATION.to_string());
    if location != "global" {
        return Err(format!("Vertex TTS location must be global, got {}", location).into());
    }
    let env_model = std::env::var("VERTEX_TTS_MODEL").ok();
    let model = request_model
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            env_model
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
        .unwrap_or_else(|| VERTEX_TTS_DEFAULT_MODEL.to_string());
    let env_endpoint = std::env::var("VERTEX_TTS_ENDPOINT").ok();
    let endpoint = request_endpoint
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            env_endpoint
                .map(|v| v.trim().trim_end_matches('/').to_string())
                .filter(|v| !v.is_empty())
        })
        .unwrap_or_else(|| VERTEX_TTS_DEFAULT_ENDPOINT.to_string());
    let url = format!(
        "{}/v1/projects/{}/locations/{}/publishers/google/models/{}:generateContent",
        endpoint, project_id, location, model
    );
    // Vertex Gemini TTS currently rejects systemInstruction for AUDIO generation with
    // a generic INVALID_ARGUMENT on some models. Keep the spoken payload script-only
    // to prevent prompt leakage and keep production processing unblocked.
    let payload = build_tts_payload(script, voice_name, None, None);
    let mut last_err = String::new();
    for attempt in 0..3 {
        println!(
            "[PIPELINE] vertex_gemini_tts using model={} location={} attempt={}",
            model,
            location,
            attempt + 1
        );
        let res = client
            .post(&url)
            .bearer_auth(&access_token)
            .json(&payload)
            .send()
            .await?;
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        if (200..300).contains(&status) {
            let json: Value = serde_json::from_str(&body).unwrap_or(json!({}));
            if let Some(data) = extract_tts_audio_b64(&json) {
                return Ok(data);
            }
            last_err = format!(
                "Vertex TTS success_without_audio_body: {}",
                redact_vertex_error(&body)
            );
        } else {
            last_err = format!("Vertex TTS http_{}: {}", status, redact_vertex_error(&body));
        }
        println!(
            "[PIPELINE] vertex_gemini_tts attempt {} failed: {}",
            attempt + 1,
            last_err
        );
        sleep(Duration::from_secs(5 + (attempt as u64 * 3))).await;
    }
    Err(format!("Vertex TTS failed after retries: {}", last_err).into())
}

async fn gemini_tts_api_key_fallback(
    script: &str,
    api_key: &str,
    voice_name: Option<&str>,
    tts_prompt_template: Option<&str>,
    tts_style_instructions: Option<&str>,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let client = Client::new();
    let payload = build_tts_payload(
        script,
        voice_name,
        tts_prompt_template,
        tts_style_instructions,
    );
    let mut last_err = String::new();
    let tts_models = [
        "gemini-3.1-flash-tts-preview",
        "gemini-2.5-pro-preview-tts",
        "gemini-2.5-flash-preview-tts",
    ];

    for model in tts_models {
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, api_key
        );
        println!(
            "[PIPELINE] gemini_tts_api_key_fallback using model={}",
            model
        );
        for attempt in 0..3 {
            let res = client.post(&url).json(&payload).send().await?;
            let status = res.status().as_u16();
            let body = res.text().await.unwrap_or_default();
            if (200..300).contains(&status) {
                let json: Value = serde_json::from_str(&body).unwrap_or(json!({}));
                if let Some(data) = extract_tts_audio_b64(&json) {
                    return Ok(data);
                }
                last_err = format!(
                    "TTS fallback model={} success_without_audio_body: {}",
                    model,
                    redact_vertex_error(&body)
                );
            } else {
                last_err = format!(
                    "TTS fallback model={} http_{}: {}",
                    model,
                    status,
                    redact_vertex_error(&body)
                );
            }
            println!(
                "[PIPELINE] gemini_tts_api_key_fallback attempt {} failed: {}",
                attempt + 1,
                last_err
            );
            sleep(Duration::from_secs(5 + (attempt as u64 * 3))).await;
        }
    }
    Err(format!("TTS API-key fallback failed after retries: {}", last_err).into())
}

async fn gemini_tts(
    script: &str,
    api_key: &str,
    voice_name: Option<&str>,
    tts_prompt_template: Option<&str>,
    tts_style_instructions: Option<&str>,
    request_project_id: Option<&str>,
    request_location: Option<&str>,
    request_model: Option<&str>,
    request_endpoint: Option<&str>,
    request_service_account_json: Option<&str>,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    match vertex_gemini_tts(
        script,
        voice_name,
        tts_prompt_template,
        tts_style_instructions,
        request_project_id,
        request_location,
        request_model,
        request_endpoint,
        request_service_account_json,
    )
    .await
    {
        Ok(audio) => Ok(audio),
        Err(vertex_err) => {
            let allow_fallback = std::env::var("VIDEO_AFFILIATE_TTS_ALLOW_API_KEY_FALLBACK")
                .ok()
                .and_then(|v| parse_env_bool(&v))
                .unwrap_or(false);
            if allow_fallback {
                println!(
                    "[PIPELINE] Vertex TTS failed; using API-key fallback: {}",
                    vertex_err
                );
                return gemini_tts_api_key_fallback(
                    script,
                    api_key,
                    voice_name,
                    tts_prompt_template,
                    tts_style_instructions,
                )
                .await;
            }
            Err(vertex_err)
        }
    }
}

// Fallback: Simple script to SRT when Whisper fails
fn script_to_srt_simple(script: &str, duration: f64) -> String {
    let chars: Vec<char> = script.chars().collect();
    let chunk_size = 15usize;
    let mut chunks: Vec<String> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let end = (i + chunk_size).min(chars.len());
        chunks.push(chars[i..end].iter().collect());
        i = end;
    }
    if chunks.is_empty() {
        return String::new();
    }
    let seg_dur = duration / chunks.len() as f64;
    let mut out = String::new();
    for (idx, chunk) in chunks.iter().enumerate() {
        let start = idx as f64 * seg_dur;
        let end = start + seg_dur - 0.1;
        let fmt = |t: f64| {
            let h = t as u32 / 3600;
            let m = (t as u32 % 3600) / 60;
            let s = t as u32 % 60;
            let ms = ((t - t.floor()) * 1000.0) as u32;
            format!("{:02}:{:02}:{:02},{:03}", h, m, s, ms)
        };
        out.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            idx + 1,
            fmt(start),
            fmt(end),
            chunk
        ));
    }
    out
}

fn split_long_token_balanced(token: &str, max_chars: usize) -> Vec<String> {
    let chars: Vec<char> = token.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }
    if chars.len() <= max_chars {
        return vec![token.to_string()];
    }

    // Balance chunk size to avoid tiny tail (e.g. 1-char Thai chunk).
    let parts = chars.len().div_ceil(max_chars);
    let base = chars.len().div_ceil(parts.max(1));
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        let end = (i + base).min(chars.len());
        out.push(chars[i..end].iter().collect::<String>());
        i = end;
    }
    out
}

fn split_subtitle_chunks(text: &str, max_chars: usize) -> Vec<String> {
    let max_chars = max_chars.max(1);
    let cleaned = text
        .split_whitespace()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if cleaned.is_empty() {
        return Vec::new();
    }

    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();

    for word in cleaned.split(' ') {
        let word_len = word.chars().count();
        if current.is_empty() {
            if word_len <= max_chars {
                current.push_str(word);
            } else {
                chunks.extend(split_long_token_balanced(word, max_chars));
            }
            continue;
        }

        let next_len = current.chars().count() + 1 + word_len;
        if next_len <= max_chars {
            current.push(' ');
            current.push_str(word);
        } else {
            chunks.push(current);
            current = String::new();
            if word_len <= max_chars {
                current.push_str(word);
            } else {
                chunks.extend(split_long_token_balanced(word, max_chars));
            }
        }
    }

    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

// Parse whisper time string to seconds
fn parse_whisper_time(t: &str) -> f64 {
    let t = t.replace(',', ".");
    let parts: Vec<&str> = t.split(':').collect();
    if parts.len() == 3 {
        let h: f64 = parts[0].parse().unwrap_or(0.0);
        let m: f64 = parts[1].parse().unwrap_or(0.0);
        let s: f64 = parts[2].parse().unwrap_or(0.0);
        return h * 3600.0 + m * 60.0 + s;
    }
    0.0
}

fn parse_srt_time_range(line: &str) -> Option<(f64, f64)> {
    let parts: Vec<&str> = line.splitn(2, "-->").collect();
    if parts.len() != 2 {
        return None;
    }
    let start = parse_whisper_time(parts[0].trim());
    let end = parse_whisper_time(parts[1].trim());
    if end <= start {
        return None;
    }
    Some((start, end))
}

fn format_srt_time(t: f64) -> String {
    let t = if t.is_finite() { t.max(0.0) } else { 0.0 };
    let h = (t as u32) / 3600;
    let m = ((t as u32) % 3600) / 60;
    let s = (t as u32) % 60;
    let ms = ((t - t.floor()) * 1000.0).round() as u32;
    format!("{:02}:{:02}:{:02},{:03}", h, m, s, ms.min(999))
}

fn extract_srt_time_span(srt: &str) -> Option<(f64, f64)> {
    let mut min_start = f64::INFINITY;
    let mut max_end = 0.0f64;
    for line in srt.lines().filter(|l| l.contains("-->")) {
        if let Some((start, end)) = parse_srt_time_range(line) {
            min_start = min_start.min(start);
            max_end = max_end.max(end);
        }
    }
    if min_start.is_finite() && max_end > min_start {
        Some((min_start, max_end))
    } else {
        None
    }
}

fn parse_srt_blocks_with_text(srt: &str) -> Vec<(f64, f64, String)> {
    let mut blocks = Vec::new();
    for block in srt.split("\n\n") {
        let lines: Vec<&str> = block
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();
        let Some(time_idx) = lines.iter().position(|l| l.contains("-->")) else {
            continue;
        };
        if time_idx + 1 >= lines.len() {
            continue;
        }
        let Some((start, end)) = parse_srt_time_range(lines[time_idx]) else {
            continue;
        };
        let text = lines[time_idx + 1..].join(" ");
        let text = text
            .split_whitespace()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        blocks.push((start, end, text));
    }
    blocks
}

fn is_non_speech_cue(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return true;
    }
    if t.chars()
        .all(|c| c.is_whitespace() || c == '♪' || c == '♫' || c == '-')
    {
        return true;
    }

    let lower = t.to_lowercase();
    let normalized = lower
        .replace(' ', "")
        .replace('\u{00A0}', "")
        .replace('　', "");

    let cue_markers = [
        "เสียงดนตรี",
        "ดนตรี",
        "music",
        "instrumental",
        "sfx",
        "soundeffect",
        "applause",
        "laughter",
        "เสียงปรบมือ",
        "เสียงหัวเราะ",
    ];

    if (normalized.starts_with('[') && normalized.ends_with(']'))
        || (normalized.starts_with('(') && normalized.ends_with(')'))
    {
        if cue_markers.iter().any(|m| normalized.contains(m)) {
            return true;
        }
    }

    cue_markers.iter().any(|m| normalized == *m)
}

fn extract_speech_srt_time_span(srt: &str) -> Option<(f64, f64)> {
    let speech_blocks: Vec<(f64, f64, String)> = parse_srt_blocks_with_text(srt)
        .into_iter()
        .filter(|(_, _, text)| !is_non_speech_cue(text))
        .collect();

    if speech_blocks.is_empty() {
        return extract_srt_time_span(srt);
    }

    let start = speech_blocks.first().map(|(s, _, _)| *s).unwrap_or(0.0);
    let end = speech_blocks.last().map(|(_, e, _)| *e).unwrap_or(0.0);
    if end > start {
        Some((start, end))
    } else {
        None
    }
}

fn visible_chars_len(s: &str) -> usize {
    s.chars().filter(|c| !c.is_whitespace()).count()
}

fn srt_quality_ok(script: &str, srt: &str, max_chars: usize) -> bool {
    let script_chars = visible_chars_len(script);
    if script_chars == 0 {
        return false;
    }

    let mut block_count = 0usize;
    let mut subtitle_chars = 0usize;
    for block in srt.split("\n\n") {
        let lines: Vec<String> = block
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        if lines.is_empty() {
            continue;
        }
        let Some(time_idx) = lines.iter().position(|l| l.contains("-->")) else {
            return false;
        };
        if parse_srt_time_range(&lines[time_idx]).is_none() {
            return false;
        }
        if time_idx + 1 >= lines.len() {
            return false;
        }
        let text = lines[time_idx + 1..].join(" ");
        let text = text
            .split_whitespace()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if text.is_empty() {
            return false;
        }
        if text.chars().count() > max_chars {
            return false;
        }

        subtitle_chars += visible_chars_len(&text);
        block_count += 1;
    }

    if block_count == 0 {
        return false;
    }

    let min_chars = ((script_chars as f64) * 0.65) as usize;
    let max_chars_allowed = ((script_chars as f64) * 1.35) as usize;
    subtitle_chars >= min_chars.max(1) && subtitle_chars <= max_chars_allowed.max(1)
}

fn normalize_subtitle_lines(lines: &[String], max_chars: usize) -> Vec<String> {
    let mut out = Vec::new();
    for line in lines {
        let clean = line
            .split_whitespace()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if clean.is_empty() {
            continue;
        }
        // Keep AI line boundaries by default; only hard-wrap very long lines.
        if clean.chars().count() > (max_chars * 2) {
            out.extend(
                split_subtitle_chunks(&clean, max_chars)
                    .into_iter()
                    .filter(|s| !s.trim().is_empty()),
            );
        } else {
            out.push(clean);
        }
    }
    out
}

fn build_srt_from_lines_with_timing(
    lines: &[String],
    timing_srt: &str,
    fallback_duration: f64,
    max_chars: usize,
) -> String {
    let chunks = normalize_subtitle_lines(lines, max_chars);
    if chunks.is_empty() {
        return String::new();
    }

    let fallback_duration = fallback_duration.max(1.0);
    let (timing_start, timing_end) =
        extract_speech_srt_time_span(timing_srt).unwrap_or((0.0, fallback_duration));
    let timing_span = (timing_end - timing_start).max(0.0);
    let start = if timing_span >= 0.2 {
        timing_start.max(0.0).min(fallback_duration.max(0.1) - 0.1)
    } else {
        0.0
    };
    let total_duration = if timing_span >= 0.2 {
        timing_span.min((fallback_duration - start).max(0.1))
    } else {
        fallback_duration
    };
    let end = (start + total_duration.max(0.1)).min(fallback_duration.max(0.1));
    let total_chars: usize = chunks.iter().map(|c| c.chars().count().max(1)).sum();

    let mut out = String::new();
    let mut cursor = start;
    for (idx, chunk) in chunks.iter().enumerate() {
        let chunk_end = if idx == chunks.len() - 1 {
            end
        } else {
            let ratio = chunk.chars().count().max(1) as f64 / total_chars.max(1) as f64;
            (cursor + (total_duration * ratio)).min(end)
        };
        let safe_end = if chunk_end <= cursor {
            (cursor + 0.05).min(end)
        } else {
            chunk_end
        };
        out.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            idx + 1,
            format_srt_time(cursor),
            format_srt_time(safe_end),
            chunk
        ));
        cursor = safe_end;
    }
    out
}

fn build_srt_from_script_with_timing(
    script: &str,
    timing_srt: &str,
    fallback_duration: f64,
    max_chars: usize,
) -> String {
    build_srt_from_lines_with_timing(
        &split_subtitle_chunks(script, max_chars)
            .into_iter()
            .collect::<Vec<_>>(),
        timing_srt,
        fallback_duration,
        max_chars,
    )
}

fn build_atempo_filter(mut factor: f64) -> String {
    let mut filters: Vec<String> = Vec::new();

    while factor > 2.0 {
        filters.push("atempo=2.0".to_string());
        factor /= 2.0;
    }

    while factor < 0.5 {
        filters.push("atempo=0.5".to_string());
        factor /= 0.5;
    }

    filters.push(format!("atempo={:.6}", factor));
    filters.join(",")
}

#[cfg(test)]
mod tests {
    use super::{
        GEMINI_INLINE_VIDEO_MAX_BYTES, GeminiPreflightError, GeminiTranscodeProfile,
        GeminiUploadVariant, build_gemini_inline_video_part, build_gemini_transcode_filter,
        build_srt_from_lines_with_timing, build_tts_payload, extract_speech_srt_time_span,
        extract_srt_payload, format_gemini_preflight_info, normalize_srt_blocks,
        parse_gemini_preflight_info, parse_srt_time_range, pipeline_error_category,
        should_retry_gemini_with_inline_video, should_retry_gemini_with_strict,
        validate_gemini_safe_output,
    };
    use serde_json::json;

    fn extract_time_lines(srt: &str) -> Vec<(f64, f64)> {
        srt.lines()
            .filter_map(|l| parse_srt_time_range(l))
            .collect::<Vec<_>>()
    }

    #[test]
    fn tts_payload_keeps_voice_direction_out_of_spoken_text() {
        let payload = build_tts_payload(
            "พูดประโยคนี้เท่านั้น",
            Some("Kore"),
            Some("พูดแบบสดใส\n\nบทพากย์:\n{{script}}"),
            None,
        );
        let spoken = payload["contents"][0]["parts"][0]["text"].as_str().unwrap();
        assert_eq!(spoken, "พูดประโยคนี้เท่านั้น");
        assert!(!spoken.contains("พูดแบบสดใส"));
        assert!(
            payload["systemInstruction"]["parts"][0]["text"]
                .as_str()
                .unwrap()
                .contains("พูดแบบสดใส")
        );
    }

    #[test]
    fn deterministic_srt_is_zero_based_even_if_whisper_starts_late() {
        let timing_srt = "1\n00:00:01,200 --> 00:00:04,200\nทดสอบ\n\n";
        let lines = vec!["บรรทัดหนึ่ง".to_string(), "บรรทัดสอง".to_string()];
        let out = build_srt_from_lines_with_timing(&lines, timing_srt, 4.2, 15);
        let times = extract_time_lines(&out);
        assert!(!times.is_empty());
        let (first_start, _) = times[0];
        let (_, last_end) = times[times.len() - 1];
        assert!(
            (first_start - 1.2).abs() < 0.1,
            "first subtitle should preserve speech offset"
        );
        assert!((last_end - 4.2).abs() < 0.1, "end should match speech span");
    }

    #[test]
    fn deterministic_srt_uses_fallback_when_whisper_span_is_inflated() {
        let timing_srt = "1\n00:00:00,000 --> 00:00:25,000\nทดสอบ\n\n";
        let lines = vec!["หนึ่ง".to_string(), "สอง".to_string(), "สาม".to_string()];
        let out = build_srt_from_lines_with_timing(&lines, timing_srt, 10.0, 15);
        let times = extract_time_lines(&out);
        assert!(!times.is_empty());
        let (_, last_end) = times[times.len() - 1];
        assert!(
            last_end <= 10.2,
            "inflated timing should clamp to fallback duration"
        );
    }

    #[test]
    fn speech_span_ignores_music_cue_tail() {
        let timing_srt = "\
1\n00:00:00,000 --> 00:00:02,000\nสวัสดี\n\n\
2\n00:00:02,000 --> 00:00:05,000\n[เสียงดนตรี]\n\n";
        let span = extract_speech_srt_time_span(timing_srt).expect("speech span expected");
        assert!((span.0 - 0.0).abs() < 0.001);
        assert!(
            (span.1 - 2.0).abs() < 0.001,
            "music cue tail must not stretch speech span"
        );
    }

    #[test]
    fn extract_srt_payload_handles_markdown_fence() {
        let raw = "```srt\n1\n00:00:00,000 --> 00:00:01,000\nทดสอบ\n```";
        let out = extract_srt_payload(raw);
        assert!(out.contains("-->"));
        assert!(out.contains("ทดสอบ"));
    }

    #[test]
    fn normalize_srt_blocks_clamps_and_keeps_monotonic() {
        let raw = "\
1\n00:00:00,500 --> 00:00:01,500\nหนึ่ง\n\n\
2\n00:00:01,400 --> 00:00:03,500\nสอง\n\n";
        let out = normalize_srt_blocks(raw, 2.0);
        let times = extract_time_lines(&out);
        assert_eq!(times.len(), 2);
        assert!(times[0].0 >= 0.0);
        assert!(times[0].1 <= 2.0);
        assert!(
            times[1].0 >= times[0].1,
            "second block must not overlap first"
        );
        assert!(times[1].1 <= 2.0);
    }

    #[test]
    fn remap_srt_blocks_to_window_preserves_relative_order() {
        let raw = "\
1\n00:00:00,000 --> 00:00:01,000\nหนึ่ง\n\n\
2\n00:00:01,000 --> 00:00:02,000\nสอง\n\n";
        let out = super::remap_srt_blocks_to_window(raw, 0.25, 1.75, 2.0);
        let times = extract_time_lines(&out);
        assert_eq!(times.len(), 2);
        assert!((times[0].0 - 0.25).abs() < 0.05);
        assert!((times[1].1 - 1.75).abs() < 0.05);
        assert!(times[1].0 >= times[0].1);
    }

    #[test]
    fn gemini_preflight_parser_reads_video_shape_duration_and_audio() {
        let probe = json!({
            "format": { "duration": "12.345" },
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "profile": "Constrained Baseline",
                    "pix_fmt": "yuv420p",
                    "width": 1080,
                    "height": 1920
                },
                {
                    "codec_type": "audio",
                    "codec_name": "aac"
                }
            ]
        });

        let info = parse_gemini_preflight_info(&probe).expect("valid preflight info");

        assert!((info.duration - 12.345).abs() < 0.001);
        assert_eq!(info.video_codec.as_deref(), Some("h264"));
        assert_eq!(info.video_profile.as_deref(), Some("Constrained Baseline"));
        assert_eq!(info.pixel_format.as_deref(), Some("yuv420p"));
        assert_eq!(info.width, 1080);
        assert_eq!(info.height, 1920);
        assert!(info.has_audio);
        assert_eq!(info.audio_codec.as_deref(), Some("aac"));
        let summary = format_gemini_preflight_info(&info);
        assert!(summary.contains("duration=12.35s"));
        assert!(summary.contains("codec=h264"));
        assert!(summary.contains("profile=Constrained Baseline"));
        assert!(summary.contains("pix_fmt=yuv420p"));
        assert!(summary.contains("size=1080x1920"));
        assert!(summary.contains("audio=true"));
    }

    #[test]
    fn gemini_preflight_parser_rejects_missing_duration() {
        let probe = json!({
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 720,
                    "height": 1280
                }
            ]
        });

        let err = parse_gemini_preflight_info(&probe).expect_err("missing duration rejects");

        assert!(matches!(
            err,
            GeminiPreflightError::DurationOutOfRange { duration } if (duration - 0.0).abs() < 0.001
        ));
    }

    #[test]
    fn pipeline_error_category_distinguishes_gemini_media_retries() {
        assert_eq!(
            pipeline_error_category("Gemini-safe output invalid: expected yuv420p pixel format"),
            "gemini_safe_output_invalid"
        );
        assert_eq!(
            pipeline_error_category("Gemini-strict transcode failed: encoder error"),
            "gemini_strict_transcode_failed"
        );
        assert_eq!(
            pipeline_error_category(
                "Gemini file processing failed: code 12 — The file failed to be processed"
            ),
            "gemini_file_processing_failed"
        );
    }

    #[test]
    fn gemini_file_processing_failure_retries_safe_upload_with_strict_transcode() {
        let code_12 = "Gemini file processing failed: code 12 — The file failed to be processed";

        assert!(should_retry_gemini_with_strict(
            GeminiUploadVariant::Safe,
            code_12
        ));
        assert!(!should_retry_gemini_with_strict(
            GeminiUploadVariant::Strict,
            code_12
        ));
        assert!(!should_retry_gemini_with_strict(
            GeminiUploadVariant::Safe,
            "quota exceeded"
        ));
    }

    #[test]
    fn gemini_inline_video_fallback_is_strict_code12_and_size_gated() {
        let code_12 = "Gemini file processing failed: code 12 — The file failed to be processed";

        assert!(should_retry_gemini_with_inline_video(
            GeminiUploadVariant::Strict,
            code_12,
            GEMINI_INLINE_VIDEO_MAX_BYTES
        ));
        assert!(!should_retry_gemini_with_inline_video(
            GeminiUploadVariant::Safe,
            code_12,
            1024
        ));
        assert!(!should_retry_gemini_with_inline_video(
            GeminiUploadVariant::Strict,
            code_12,
            GEMINI_INLINE_VIDEO_MAX_BYTES + 1
        ));
        assert!(!should_retry_gemini_with_inline_video(
            GeminiUploadVariant::Strict,
            "quota exceeded",
            1024
        ));
    }

    #[test]
    fn gemini_inline_video_part_uses_video_mp4_inline_data() {
        let part = build_gemini_inline_video_part(b"abc");
        let inline = part
            .get("inlineData")
            .and_then(|value| value.as_object())
            .expect("inlineData object");

        assert_eq!(
            inline.get("mimeType").and_then(|value| value.as_str()),
            Some("video/mp4")
        );
        assert_eq!(
            inline.get("data").and_then(|value| value.as_str()),
            Some("YWJj")
        );
    }

    #[test]
    fn gemini_safe_transcode_filter_forces_cfr_even_yuv420p() {
        let filter = build_gemini_transcode_filter(GeminiTranscodeProfile::Safe);
        assert!(filter.contains("fps=24"));
        assert!(filter.contains("setsar=1"));
        assert!(filter.contains("setpts=N/(24*TB)"));
        assert!(filter.contains("format=yuv420p"));
        assert!(filter.contains("trunc(iw/2)*2"));
        assert!(filter.contains("trunc(ih/2)*2"));
    }

    #[test]
    fn gemini_strict_profile_is_video_only_and_smaller_than_safe() {
        let filter = build_gemini_transcode_filter(GeminiTranscodeProfile::Strict);

        assert!(GeminiTranscodeProfile::Strict.video_only());
        assert!(!GeminiTranscodeProfile::Safe.video_only());
        assert!(filter.contains("min(480"));
        assert!(filter.contains("fps=24"));
        assert!(filter.contains("setsar=1"));
        assert!(filter.contains("setpts=N/(24*TB)"));
        assert!(filter.contains("format=yuv420p"));
    }

    #[test]
    fn gemini_safe_output_validation_rejects_odd_dimensions() {
        let parsed = parse_gemini_preflight_info(&json!({
            "streams": [{
                "codec_type": "video",
                "codec_name": "h264",
                "profile": "Constrained Baseline",
                "pix_fmt": "yuv420p",
                "width": 721,
                "height": 405,
                "duration": "4.0"
            }],
            "format": { "duration": "4.0" }
        }))
        .expect("probe parses before output validation");
        let err = validate_gemini_safe_output(&parsed).expect_err("odd dimensions rejected");
        assert!(err.contains("even dimensions"));
    }
}

// Convert Whisper JSON to SRT with word-level timestamps
#[allow(dead_code)]
async fn convert_whisper_json_to_srt(
    json_path: &std::path::Path,
    srt_path: &std::path::Path,
    max_chars: usize,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let json_str = fs::read_to_string(json_path).await?;
    let json: Value = serde_json::from_str(&json_str)?;

    let mut srt_blocks: Vec<(usize, f64, f64, String)> = Vec::new();
    let mut block_num = 1;
    let mut has_word_timestamps = false;

    // Try whisper.cpp format: { "transcription": [{ "timestamps": { "from": "...", "to": "..." }, "text": "..." }] }
    if let Some(transcription) = json.get("transcription").and_then(|t| t.as_array()) {
        for item in transcription {
            if let (Some(text), Some(from), Some(to)) = (
                item.get("text").and_then(|t| t.as_str()),
                item.get("timestamps")
                    .and_then(|t| t.get("from"))
                    .and_then(|f| f.as_str()),
                item.get("timestamps")
                    .and_then(|t| t.get("to"))
                    .and_then(|t| t.as_str()),
            ) {
                let start = parse_whisper_time(from);
                let end = parse_whisper_time(to);
                let text_clean = text.trim();
                if text_clean.is_empty() {
                    continue;
                }

                // Split long text into chunks
                let chars: Vec<char> = text_clean.chars().collect();
                let mut i = 0;
                let total_chars = chars.len();
                let time_per_char = (end - start) / total_chars.max(1) as f64;

                while i < total_chars {
                    let chunk_end = (i + max_chars).min(total_chars);
                    // Try to break at space
                    let mut break_idx = chunk_end;
                    if chunk_end < total_chars {
                        for j in (i..chunk_end).rev() {
                            if chars[j] == ' ' {
                                break_idx = j;
                                break;
                            }
                        }
                    }

                    let chunk: String = chars[i..break_idx].iter().collect();
                    let chunk_start = start + (i as f64 * time_per_char);
                    let chunk_end_time = start + (break_idx as f64 * time_per_char);

                    srt_blocks.push((
                        block_num,
                        chunk_start,
                        chunk_end_time,
                        chunk.trim().to_string(),
                    ));
                    block_num += 1;
                    i = if break_idx == i {
                        chunk_end
                    } else {
                        break_idx + 1
                    };
                }
            }
        }
    }

    // Check if we have word-level timestamps (whisper-ctranslate2 format)
    if let Some(segments) = json.get("segments").and_then(|s| s.as_array()) {
        for segment in segments {
            if let Some(words) = segment.get("words").and_then(|w| w.as_array()) {
                has_word_timestamps = true;
                let mut current_text = String::new();
                let mut current_start: Option<f64> = None;
                let mut last_end: f64 = 0.0;

                for word_obj in words {
                    if let (Some(word), Some(start), Some(end)) = (
                        word_obj.get("word").and_then(|w| w.as_str()),
                        word_obj.get("start").and_then(|s| s.as_f64()),
                        word_obj.get("end").and_then(|e| e.as_f64()),
                    ) {
                        let word_clean = word.trim();
                        if word_clean.is_empty() {
                            continue;
                        }

                        if !current_text.is_empty()
                            && current_text.len() + word_clean.len() > max_chars
                        {
                            if let Some(start_time) = current_start {
                                srt_blocks.push((
                                    block_num,
                                    start_time,
                                    last_end,
                                    current_text.clone(),
                                ));
                                block_num += 1;
                            }
                            current_text.clear();
                            current_start = None;
                        }

                        if current_start.is_none() {
                            current_start = Some(start);
                        }
                        if !current_text.is_empty() {
                            current_text.push(' ');
                        }
                        current_text.push_str(word_clean);
                        last_end = end;
                    }
                }

                if !current_text.is_empty() {
                    if let Some(start_time) = current_start {
                        srt_blocks.push((block_num, start_time, last_end, current_text));
                        block_num += 1;
                    }
                }
            }
        }
    }

    // Write SRT file
    if !srt_blocks.is_empty() {
        let mut srt_content = String::new();
        for (num, start, end, text) in srt_blocks {
            let fmt_time = |t: f64| {
                let h = (t as u32) / 3600;
                let m = ((t as u32) % 3600) / 60;
                let s = (t as u32) % 60;
                let ms = ((t - t.floor()) * 1000.0) as u32;
                format!("{:02}:{:02}:{:02},{:03}", h, m, s, ms)
            };
            srt_content.push_str(&format!(
                "{}\n{} --> {}\n{}\n\n",
                num,
                fmt_time(start),
                fmt_time(end),
                text
            ));
        }
        fs::write(srt_path, srt_content).await?;
    }

    Ok(has_word_timestamps)
}

// ==================== ASS Subtitle ====================

fn fmt_ass_time(t: &str) -> String {
    let t = t.trim().replace(',', ".");
    if let Some(dot) = t.rfind('.') {
        let ms = &t[dot + 1..];
        let ms_padded = format!("{:0<3}", ms);
        let cs = &ms_padded[..2.min(ms_padded.len())];
        return format!("{}.{}", &t[..dot], cs);
    }
    t.to_string()
}

fn convert_to_ass(srt: &str, vw: u32, vh: u32) -> String {
    let font_size = ((vw as f32 * 0.115) as u32).max(50);
    let header = format!(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: {vw}\nPlayResY: {vh}\n\n\
         [V4+ Styles]\n\
         Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, \
         Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, \
         Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n\
         Style: Default,Noto Sans Thai,{fs},\
         &H00FFFFFF,&H00000000,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,10,0,2,10,10,250,1\n\n\
         [Events]\n\
         Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
        vw = vw,
        vh = vh,
        fs = font_size
    );
    let mut events = String::new();
    for block in srt.trim().split("\n\n") {
        let lines: Vec<&str> = block
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();
        let Some(ti) = lines.iter().position(|l| l.contains("-->")) else {
            continue;
        };
        let Some(time_line) = lines.get(ti) else {
            continue;
        };
        if ti + 1 >= lines.len() {
            continue;
        }
        let parts: Vec<&str> = time_line.splitn(2, "-->").collect();
        if parts.len() != 2 {
            continue;
        }
        let ts = fmt_ass_time(parts[0]);
        let te = fmt_ass_time(parts[1]);
        let text = lines[ti + 1..].join(" ");
        events.push_str(&format!(
            "Dialogue: 0,{},{},Default,,0,0,0,,{}\n",
            ts, te, text
        ));
    }
    header + &events
}

// ==================== FFmpeg & Timing Core ====================

async fn get_duration(path: &Path) -> f64 {
    if let Ok(output) = Command::new("ffprobe")
        .args(&[
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(path.to_str().unwrap())
        .output()
        .await
    {
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse()
            .unwrap_or(10.0)
    } else {
        10.0
    }
}

async fn rust_pipeline(
    req: PipelineRequest,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    println!("[PIPELINE] engine_version={}", PIPELINE_ENGINE_VERSION);
    let video_id = req
        .video_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().simple().to_string()[..8].to_string());
    let bot_id = req.bot_id.clone().unwrap_or_else(|| "default".to_string());
    let token = &req.token;
    let worker_url = &req.worker_url;
    let gemini_api_keys = normalize_gemini_api_keys(req.api_keys.as_ref(), &req.api_key);
    let mock_mode =
        gemini_api_keys.len() == 1 && gemini_api_keys.get(0).map(|k| k == "mock").unwrap_or(false);

    // 1. Download
    update_step(
        worker_url,
        token,
        &bot_id,
        &video_id,
        1.0,
        "📥 ดาวน์โหลดวิดีโอ",
    )
    .await;
    edit_status(token, req.chat_id, req.msg_id, "📥 กำลังดาวน์โหลดวิดีโอ").await;

    let client = Client::builder()
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(15))
        .build()?;
    let video_bytes = download_video_bytes(&client, &req, &bot_id).await?;

    let _ = r2_put(
        worker_url,
        token,
        &bot_id,
        &format!("videos/{}_original.mp4", video_id),
        video_bytes.clone(),
        "video/mp4",
    )
    .await;
    let tmp_dir = tempdir()?;
    let tmp_path = tmp_dir.path();
    let video_path = tmp_path.join("video.mp4");
    fs::write(&video_path, &video_bytes).await?;
    let source_preflight = preflight_probe_for_gemini(&video_path)
        .await
        .map_err(|e| format!("source_video_invalid: {}", e))?;
    println!(
        "[PIPELINE] source preflight ok: {}",
        format_gemini_preflight_info(&source_preflight)
    );
    println!(
        "[PIPELINE] source preflight detail: {}",
        gemini_preflight_sanitized_json(&source_preflight)
    );
    let duration = source_preflight.duration;

    let model = req
        .model
        .unwrap_or_else(|| "gemini-3-flash-preview".to_string());
    let mut selected_gemini_key = String::new();

    let (script, subtitle_lines, title, category, a_dur, wav_audio) = if mock_mode {
        let wav = tmp_path.join("audio.wav");
        Command::new("ffmpeg")
            .args(&[
                "-y",
                "-i",
                video_path.to_str().unwrap(),
                "-f",
                "s16le",
                "-ar",
                "24000",
                "-ac",
                "1",
                wav.to_str().unwrap(),
            ])
            .output()
            .await?;
        let d = get_duration(&wav).await;
        let mock_script = "mock script".to_string();
        (
            mock_script.clone(),
            split_subtitle_chunks(&mock_script, 15),
            "mock title".to_string(),
            "mock category".to_string(),
            d,
            wav,
        )
    } else {
        if gemini_api_keys.is_empty() {
            return Err("ยังไม่ได้ตั้ง Gemini API key กลางของระบบ".into());
        }

        // 2. Analyze
        update_step(
            worker_url,
            token,
            &bot_id,
            &video_id,
            2.0,
            "🔍 อัปโหลดวิดีโอไป Gemini...",
        )
        .await;
        edit_status(
            token,
            req.chat_id,
            req.msg_id,
            "📥 ดาวน์โหลดวิดีโอ ✅\n🔍 กำลังวิเคราะห์วิดีโอ",
        )
        .await;
        let mut analyze_result = None;
        let mut last_gemini_err = String::new();
        let mut gemini_strict_video_bytes: Option<Vec<u8>> = None;
        let gemini_safe_video_path = tmp_path.join("gemini_safe.mp4");
        let gemini_strict_video_path = tmp_path.join("gemini_strict.mp4");

        update_step(
            worker_url,
            token,
            &bot_id,
            &video_id,
            2.2,
            "🔍 แปลงวิดีโอให้ Gemini อ่านได้ (Gemini-safe)...",
        )
        .await;
        let gemini_safe_video_bytes =
            transcode_video_for_gemini(&video_path, &gemini_safe_video_path).await?;
        if gemini_safe_video_bytes == video_bytes {
            return Err(
                "Gemini-safe output invalid: transcode output is identical to source".into(),
            );
        }
        println!(
            "[PIPELINE] Gemini-safe upload artifact produced {} bytes",
            gemini_safe_video_bytes.len()
        );

        for (index, api_key) in gemini_api_keys.iter().enumerate() {
            println!("[PIPELINE] Gemini key slot {} analyze start", index + 1);
            for variant in [GeminiUploadVariant::Safe, GeminiUploadVariant::Strict] {
                if variant == GeminiUploadVariant::Strict && gemini_strict_video_bytes.is_none() {
                    update_step(
                        worker_url,
                        token,
                        &bot_id,
                        &video_id,
                        2.2,
                        "🔍 แปลงวิดีโอให้ Gemini อ่านได้แบบเข้มงวด...",
                    )
                    .await;
                    match transcode_video_for_gemini_strict(&video_path, &gemini_strict_video_path)
                        .await
                    {
                        Ok(bytes) => {
                            println!(
                                "[PIPELINE] Gemini-strict transcode produced {} bytes",
                                bytes.len()
                            );
                            gemini_strict_video_bytes = Some(bytes);
                        }
                        Err(transcode_err) => {
                            last_gemini_err = format!(
                                "{}; Gemini-strict transcode failed: {}",
                                last_gemini_err, transcode_err
                            );
                            println!(
                                "[PIPELINE] Gemini-strict transcode failed: {}",
                                transcode_err
                            );
                            break;
                        }
                    }
                }
                let variant_label = variant.label();
                let upload_bytes: &[u8] = match variant {
                    GeminiUploadVariant::Safe => gemini_safe_video_bytes.as_slice(),
                    GeminiUploadVariant::Strict => match gemini_strict_video_bytes.as_ref() {
                        Some(bytes) => bytes.as_slice(),
                        None => break,
                    },
                };
                let attempt = async {
                    let wait_step_name = format!("🔍 รอ Gemini ประมวลผลไฟล์ {}...", variant_label);
                    let gemini_uri = gemini_upload_bytes(upload_bytes, "video/mp4", api_key).await?;
                    update_step(worker_url, token, &bot_id, &video_id, 2.3, &wait_step_name).await;
                    let pack = match gemini_wait(&gemini_uri, api_key).await {
                        Ok(active_uri) => {
                            update_step(
                                worker_url,
                                token,
                                &bot_id,
                                &video_id,
                                2.7,
                                "🔍 สร้างบทพากย์...",
                            )
                            .await;
                            gemini_script(
                                &active_uri,
                                api_key,
                                &model,
                                duration,
                                req.script_prompt.as_deref(),
                            )
                            .await?
                        }
                        Err(wait_err)
                            if should_retry_gemini_with_inline_video(
                                variant,
                                &wait_err.to_string(),
                                upload_bytes.len(),
                            ) =>
                        {
                            println!(
                                "[PIPELINE] Gemini key slot {} strict File API failed after verified transcode; retrying inline video analysis ({} bytes): {}",
                                index + 1,
                                upload_bytes.len(),
                                wait_err
                            );
                            update_step(
                                worker_url,
                                token,
                                &bot_id,
                                &video_id,
                                2.7,
                                "🔍 สร้างบทพากย์ผ่าน Gemini inline fallback...",
                            )
                            .await;
                            gemini_script_inline_video(
                                upload_bytes,
                                api_key,
                                &model,
                                duration,
                                req.script_prompt.as_deref(),
                            )
                            .await?
                        }
                        Err(wait_err) => return Err(wait_err),
                    };

                    update_step(
                        worker_url,
                        token,
                        &bot_id,
                        &video_id,
                        3.0,
                        "🎙 กำลังสร้างเสียงพากย์ไทย...",
                    )
                    .await;
                    edit_status(
                        token,
                        req.chat_id,
                        req.msg_id,
                        "📥 ดาวน์โหลดวิดีโอ ✅\n🔍 วิเคราะห์วิดีโอ ✅\n🎙 กำลังสร้างเสียงพากย์",
                    )
                    .await;

                    let tts_b64 = gemini_tts(
                        &pack.script,
                        api_key,
                        req.voice_name.as_deref(),
                        req.tts_prompt_template.as_deref(),
                        req.tts_style_instructions.as_deref(),
                        req.vertex_tts_project_id.as_deref(),
                        req.vertex_tts_location.as_deref(),
                        req.vertex_tts_model.as_deref(),
                        req.vertex_tts_endpoint.as_deref(),
                        req.vertex_tts_service_account_json.as_deref(),
                    )
                    .await?;
                    let raw_audio = tmp_path.join("audio.raw");
                    fs::write(&raw_audio, BASE64.decode(&tts_b64)?).await?;

                    let wav = tmp_path.join("audio.wav");
                    Command::new("ffmpeg")
                        .args(&[
                            "-y",
                            "-f",
                            "s16le",
                            "-ar",
                            "24000",
                            "-ac",
                            "1",
                            "-i",
                            raw_audio.to_str().unwrap(),
                            wav.to_str().unwrap(),
                        ])
                        .output()
                        .await?;
                    let d = get_duration(&wav).await;
                    Ok::<_, Box<dyn std::error::Error + Send + Sync>>((
                        pack.script,
                        pack.subtitle_lines,
                        pack.title,
                        pack.category,
                        d,
                        wav,
                    ))
                }
                .await;

                match attempt {
                    Ok(result) => {
                        selected_gemini_key = api_key.clone();
                        analyze_result = Some(result);
                        break;
                    }
                    Err(err) => {
                        last_gemini_err = err.to_string();
                        if should_retry_gemini_with_strict(variant, &last_gemini_err) {
                            last_gemini_err = format!(
                                "Gemini-safe upload failed after verified transcode: {}",
                                last_gemini_err
                            );
                            println!(
                                "[PIPELINE] Gemini key slot {} rejected verified Gemini-safe upload; retrying with Gemini-strict transcode: {}",
                                index + 1,
                                last_gemini_err
                            );
                            continue;
                        }
                        println!(
                            "[PIPELINE] Gemini key slot {} analyze failed with {} variant: {}",
                            index + 1,
                            variant_label,
                            last_gemini_err
                        );
                        break;
                    }
                }
            }
            if analyze_result.is_some() {
                break;
            }
        }

        match analyze_result {
            Some(result) => result,
            None => {
                return Err(if last_gemini_err.is_empty() {
                    "Gemini pipeline failed".into()
                } else {
                    last_gemini_err.into()
                });
            }
        }
    };

    // 4. Merge Prep
    update_step(
        worker_url,
        token,
        &bot_id,
        &video_id,
        4.0,
        "🎬 กำลังรวมเสียง+วิดีโอ...",
    )
    .await;
    edit_status(
        token,
        req.chat_id,
        req.msg_id,
        "📥 ดาวน์โหลดวิดีโอ ✅\n🔍 วิเคราะห์วิดีโอ ✅\n🎙 สร้างเสียงพากย์ ✅\n🎬 กำลังเตรียมรวมวิดีโอ",
    )
    .await;

    let adjusted = tmp_path.join("audio_adj.wav");
    let diff = duration - a_dur;
    let adjusted_audio_dur = if diff.abs() < 0.5 { a_dur } else { duration };
    if diff.abs() < 0.5 {
        fs::copy(&wav_audio, &adjusted).await?;
    } else if diff > 0.0 {
        Command::new("ffmpeg")
            .args(&[
                "-y",
                "-i",
                wav_audio.to_str().unwrap(),
                "-af",
                &format!("apad=pad_dur={}", diff),
                adjusted.to_str().unwrap(),
            ])
            .output()
            .await?;
    } else {
        let speed_ratio = (a_dur / duration.max(0.1)).max(0.5);
        let atempo_filter = build_atempo_filter(speed_ratio);
        println!(
            "[PIPELINE] audio longer than video -> tempo fit (audio_dur={:.2}s, video_dur={:.2}s, speed_ratio={:.4}, filter={})",
            a_dur, duration, speed_ratio, atempo_filter
        );
        Command::new("ffmpeg")
            .args(&[
                "-y",
                "-i",
                wav_audio.to_str().unwrap(),
                "-af",
                &atempo_filter,
                "-t",
                &duration.to_string(),
                adjusted.to_str().unwrap(),
            ])
            .output()
            .await?;
    }

    // 5. Gemini SRT from generated dub audio (no whisper)
    update_step(
        worker_url,
        token,
        &bot_id,
        &video_id,
        4.3,
        "📝 กำลังสร้างซับจากเสียงพากย์ (Gemini SRT)...",
    )
    .await;
    edit_status(token, req.chat_id, req.msg_id, "🎬 ตัดต่อ: กำลังฝังซับไตเติ้ล").await;

    let mut raw_srt = String::new();
    if !mock_mode {
        let t_sync = std::time::Instant::now();
        let adjusted_bytes = fs::read(&adjusted).await?;
        let mut audio_sync_keys = gemini_api_keys.clone();
        if !selected_gemini_key.is_empty() {
            audio_sync_keys.retain(|key| key != &selected_gemini_key);
            audio_sync_keys.insert(0, selected_gemini_key.clone());
        }
        let mut last_audio_sync_err = String::new();
        for (index, api_key) in audio_sync_keys.iter().enumerate() {
            let attempt = async {
                let audio_uri = gemini_upload_bytes(&adjusted_bytes, "audio/wav", api_key).await?;
                let audio_uri = gemini_wait(&audio_uri, api_key).await?;
                gemini_srt_from_audio(
                    &audio_uri,
                    &subtitle_lines,
                    api_key,
                    &model,
                    adjusted_audio_dur,
                )
                .await
            }
            .await;

            match attempt {
                Ok(srt) => {
                    raw_srt = srt;
                    break;
                }
                Err(err) => {
                    last_audio_sync_err = err.to_string();
                    println!(
                        "[PIPELINE] Gemini key slot {} audio sync failed: {}",
                        index + 1,
                        last_audio_sync_err
                    );
                }
            }
        }
        if raw_srt.trim().is_empty() && !last_audio_sync_err.is_empty() {
            return Err(last_audio_sync_err.into());
        }
        println!(
            "[PIPELINE] Gemini audio sync -> {} chars, {} blocks ({:.1}s)",
            raw_srt.len(),
            raw_srt
                .split("\n\n")
                .filter(|s| !s.trim().is_empty())
                .count(),
            t_sync.elapsed().as_secs_f64()
        );
    } else {
        println!("[PIPELINE] mock mode: skip gemini audio sync");
    }

    let audio_activity_window = detect_audio_activity_window(&adjusted, adjusted_audio_dur).await;
    if let Some((audio_speech_start_detected, audio_speech_end_detected)) = audio_activity_window {
        let raw_span_opt = extract_srt_time_span(&raw_srt);
        let raw_start_detected = raw_span_opt.map(|(s, _)| s).unwrap_or(0.0);
        let raw_end_detected = raw_span_opt.map(|(_, e)| e).unwrap_or(0.0);
        let should_remap = !raw_srt.trim().is_empty()
            && audio_speech_end_detected > audio_speech_start_detected + 0.2
            && ((audio_speech_start_detected - raw_start_detected).abs() > 0.08
                || (audio_speech_end_detected - raw_end_detected).abs() > 0.12);

        if should_remap {
            println!(
                "[PIPELINE] remap raw SRT to detected audio activity window ({:.3}s -> {:.3}s)",
                audio_speech_start_detected, audio_speech_end_detected
            );
            raw_srt = remap_srt_blocks_to_window(
                &raw_srt,
                audio_speech_start_detected,
                audio_speech_end_detected,
                adjusted_audio_dur.max(duration),
            );
        }
    }

    let raw_srt_blocks = raw_srt
        .split("\n\n")
        .filter(|s| !s.trim().is_empty())
        .count();
    let raw_span_opt = extract_srt_time_span(&raw_srt);
    let raw_start = raw_span_opt.map(|(s, _)| s).unwrap_or(0.0);
    let raw_end = raw_span_opt.map(|(_, e)| e).unwrap_or(0.0);
    let raw_span = (raw_end - raw_start).max(0.0);
    let speech_span_opt = extract_speech_srt_time_span(&raw_srt);
    let speech_start = speech_span_opt.map(|(s, _)| s).unwrap_or(0.0);
    let speech_end = speech_span_opt.map(|(_, e)| e).unwrap_or(0.0);
    let speech_span = (speech_end - speech_start).max(0.0);

    let mut speech_dur = a_dur.max(1.0).min(duration.max(1.0));
    if speech_span > 0.5 {
        speech_dur = speech_span.min(duration.max(1.0)).max(1.0);
    }
    let subtitle_max_end = if speech_end > 0.12 {
        speech_end.min(duration.max(1.0)).max(speech_dur)
    } else {
        speech_dur
    };
    println!(
        "[PIPELINE] speech_dur={:.2}s max_end={:.2}s (a_dur={:.2}s, video_dur={:.2}s, speech_start={:.2}s, speech_end={:.2}s, speech_span={:.2}s)",
        speech_dur, subtitle_max_end, a_dur, duration, speech_start, speech_end, speech_span
    );

    let t_srt = std::time::Instant::now();
    let mut final_srt_text = normalize_srt_blocks(&raw_srt, subtitle_max_end);
    if !final_srt_text.trim().is_empty() && !srt_quality_ok(&script, &final_srt_text, 120) {
        println!("[PIPELINE] Gemini SRT quality check failed -> deterministic fallback");
        final_srt_text.clear();
    }

    if final_srt_text.trim().is_empty() {
        final_srt_text = if subtitle_lines.is_empty() {
            build_srt_from_script_with_timing(&script, &raw_srt, subtitle_max_end, 15)
        } else {
            build_srt_from_lines_with_timing(&subtitle_lines, &raw_srt, subtitle_max_end, 15)
        };
    }

    if final_srt_text.trim().is_empty() {
        println!("[PIPELINE] Final SRT empty -> simple script split fallback");
        final_srt_text = script_to_srt_simple(&script, subtitle_max_end);
    }
    println!(
        "[PIPELINE] Build SRT (Gemini-first) → {:.1}s",
        t_srt.elapsed().as_secs_f64()
    );
    println!(
        "[PIPELINE] Final SRT: {} chars, {} blocks",
        final_srt_text.len(),
        final_srt_text
            .split("\n\n")
            .filter(|s| !s.trim().is_empty())
            .count()
    );

    let final_srt_path = tmp_path.join("final.srt");
    fs::write(&final_srt_path, &final_srt_text).await?;

    // Upload debug timing artifacts for production verification
    let debug_prefix = format!("debug/{video_id}");
    let _ = r2_put(
        worker_url,
        token,
        &bot_id,
        &format!("{debug_prefix}/raw_gemini.srt"),
        raw_srt.clone().into_bytes(),
        "application/x-subrip",
    )
    .await;
    // Keep legacy key for backward compatibility with existing dashboard/tools.
    let _ = r2_put(
        worker_url,
        token,
        &bot_id,
        &format!("{debug_prefix}/raw_whisper.srt"),
        raw_srt.clone().into_bytes(),
        "application/x-subrip",
    )
    .await;
    let _ = r2_put(
        worker_url,
        token,
        &bot_id,
        &format!("{debug_prefix}/final_subtitles.srt"),
        final_srt_text.clone().into_bytes(),
        "application/x-subrip",
    )
    .await;
    let timing_debug = json!({
        "video_id": video_id,
        "timing_source": "gemini_audio_srt",
        "raw_start": raw_start,
        "raw_end": raw_end,
        "raw_span": raw_span,
        "speech_start": speech_start,
        "speech_end": speech_end,
        "speech_span": speech_span,
        "speech_dur": speech_dur,
        "subtitle_max_end": subtitle_max_end,
        "audio_dur": a_dur,
        "adjusted_audio_dur": adjusted_audio_dur,
        "audio_activity_window": audio_activity_window.map(|(start, end)| json!({
            "start": start,
            "end": end,
        })),
        "video_dur": duration,
        "raw_srt_blocks": raw_srt_blocks,
        "final_srt_blocks": final_srt_text.split("\n\n").filter(|s| !s.trim().is_empty()).count(),
        "pipeline_engine_version": PIPELINE_ENGINE_VERSION,
    });
    let _ = r2_put(
        worker_url,
        token,
        &bot_id,
        &format!("{debug_prefix}/timing.json"),
        serde_json::to_vec(&timing_debug).unwrap_or_default(),
        "application/json",
    )
    .await;

    // 6. Burn Subtitles and Thumbnail
    update_step(
        worker_url,
        token,
        &bot_id,
        &video_id,
        4.8,
        "🎨 กำลังฝังซับไตเติ้ลลงวิดีโอ...",
    )
    .await;
    let output_mp4 = tmp_path.join("output.mp4");

    // Get video dimensions for ASS scaling
    let dim_out = Command::new("ffprobe")
        .args(&[
            "-v",
            "error",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0:s=x",
            video_path.to_str().unwrap(),
        ])
        .output()
        .await;
    let (vw, vh) = if let Ok(o) = dim_out {
        let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
        s.split_once('x')
            .and_then(|(w, h)| Some((w.trim().parse::<u32>().ok()?, h.trim().parse::<u32>().ok()?)))
            .unwrap_or((1080, 1920))
    } else {
        (1080, 1920)
    };

    // Convert SRT → ASS with FC Iconic Bold font
    let final_srt_text_str = fs::read_to_string(&final_srt_path)
        .await
        .unwrap_or_default();
    let ass_content = convert_to_ass(&final_srt_text_str, vw, vh);
    let ass_path = tmp_path.join("subtitles.ass");
    fs::write(&ass_path, &ass_content).await?;

    // Step 1: Merge video + audio (no subtitle) — copy video stream, re-encode audio to AAC
    let nosub_path = tmp_path.join("merged_nosub.mp4");
    let merge_out = tokio::time::timeout(
        Duration::from_secs(300),
        Command::new("ffmpeg")
            .args(&[
                "-y",
                "-i",
                video_path.to_str().unwrap(),
                "-i",
                adjusted.to_str().unwrap(),
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-t",
                &duration.to_string(),
                nosub_path.to_str().unwrap(),
            ])
            .output(),
    )
    .await;
    match merge_out {
        Err(_) => return Err("FFmpeg merge timed out (>300s)".into()),
        Ok(Err(e)) => return Err(Box::new(e)),
        Ok(Ok(_)) => {}
    }

    // Step 2: Burn subtitles — re-encode video with libass, copy audio
    let vf = format!(
        "ass={}:fontsdir=/usr/local/share/fonts",
        ass_path.to_str().unwrap()
    );
    let ffmpeg_burn = tokio::time::timeout(
        Duration::from_secs(300),
        Command::new("ffmpeg")
            .args(&[
                "-y",
                "-i",
                nosub_path.to_str().unwrap(),
                "-vf",
                &vf,
                "-c:v",
                "libx264",
                "-c:a",
                "copy",
                "-preset",
                "fast",
                output_mp4.to_str().unwrap(),
            ])
            .output(),
    )
    .await;
    match ffmpeg_burn {
        Err(_) => return Err("FFmpeg burn subtitles timed out (>300s)".into()),
        Ok(Err(e)) => return Err(Box::new(e)),
        Ok(Ok(_)) => {}
    }

    let thumb_path = tmp_path.join("thumb.webp");
    let ffmpeg_thumb = tokio::time::timeout(
        Duration::from_secs(60),
        Command::new("ffmpeg")
            .args(&[
                "-y",
                "-i",
                output_mp4.to_str().unwrap(),
                "-vframes",
                "1",
                "-ss",
                "0.1",
                "-vf",
                "scale=270:480:force_original_aspect_ratio=increase,crop=270:480",
                "-q:v",
                "80",
                thumb_path.to_str().unwrap(),
            ])
            .output(),
    )
    .await;
    match ffmpeg_thumb {
        Err(_) => println!("[PIPELINE] Thumbnail FFmpeg timed out, skipping"),
        Ok(Err(e)) => println!("[PIPELINE] Thumbnail FFmpeg error: {}", e),
        Ok(Ok(_)) => {}
    }

    // 7. Upload to R2
    update_step(
        worker_url,
        token,
        &bot_id,
        &video_id,
        5.0,
        "📤 กำลังอัพโหลดผลลัพธ์...",
    )
    .await;
    let final_bytes = fs::read(&output_mp4).await?;
    r2_put(
        worker_url,
        token,
        &bot_id,
        &format!("videos/{}.mp4", video_id),
        final_bytes,
        "video/mp4",
    )
    .await?;

    let thumb_bytes = fs::read(&thumb_path).await.unwrap_or_default();
    if !thumb_bytes.is_empty() {
        r2_put(
            worker_url,
            token,
            &bot_id,
            &format!("videos/{}_thumb.webp", video_id),
            thumb_bytes.clone(),
            "image/webp",
        )
        .await?;
    }

    // 8. Final Metadata
    let bot_prefix = req.bot_id.map(|id| format!("/{}", id)).unwrap_or_default();
    let public_url = format!(
        "{}{}/videos/{}.mp4",
        req.r2_public_url, bot_prefix, video_id
    );
    let thumb_url = if !thumb_bytes.is_empty() {
        format!(
            "{}{}/videos/{}_thumb.webp",
            req.r2_public_url, bot_prefix, video_id
        )
    } else {
        "".to_string()
    };

    let shopee_link = req
        .shopee_link
        .clone()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let mut metadata = json!({
        "id": video_id, "script": script, "title": title,
        "category": category, "duration": duration,
        "originalUrl": req.video_url, "publicUrl": public_url,
        "thumbnailUrl": thumb_url,
        "voiceName": req.voice_name.clone().unwrap_or_else(|| "Puck".to_string()),
        "chatId": req.chat_id,
        "pipelineEngineVersion": PIPELINE_ENGINE_VERSION,
        "debugTimingKey": format!("debug/{}/timing.json", video_id),
        "debugFinalSrtKey": format!("debug/{}/final_subtitles.srt", video_id),
        "debugRawWhisperKey": format!("debug/{}/raw_whisper.srt", video_id),
        "createdAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    });
    if let Some(link) = shopee_link {
        metadata
            .as_object_mut()
            .unwrap()
            .insert("shopeeLink".to_string(), json!(link));
    }

    r2_put(
        worker_url,
        token,
        &bot_id,
        &format!("videos/{}.json", video_id),
        serde_json::to_vec(&metadata).unwrap(),
        "application/json",
    )
    .await?;

    // Done!
    // Removed Telegram notification here

    let _ = client
        .delete(&format!(
            "{}/api/r2-proxy/_processing/{}.json",
            worker_url, video_id
        ))
        .header("x-auth-token", token)
        .header("x-bot-id", &bot_id)
        .send()
        .await;
    let _ = client
        .post(&format!("{}/api/gallery/refresh/{}", worker_url, video_id))
        .header("x-auth-token", token)
        .header("x-bot-id", &bot_id)
        .send()
        .await;
    let _ = client
        .post(&format!("{}/api/queue/next", worker_url))
        .header("x-auth-token", token)
        .header("x-bot-id", &bot_id)
        .send()
        .await;

    Ok(())
}

pub async fn handle_pipeline(
    Json(payload): Json<PipelineRequest>,
) -> Result<Json<PipelineResponse>, (StatusCode, Json<Value>)> {
    // Clone and spawn in background immediately
    let payload_clone = payload.clone();
    tokio::spawn(async move {
        println!(
            "[RUST-PIPELINE] Starting background pipeline for {}",
            payload_clone.video_url
        );
        match rust_pipeline(payload_clone.clone()).await {
            Ok(_) => println!("[RUST-PIPELINE] Completed successfully"),
            Err(e) => {
                println!("[RUST-PIPELINE] Failed: {}", e);
                let _ = edit_status(
                    &payload_clone.token,
                    payload_clone.chat_id,
                    payload_clone.msg_id,
                    &format!("❌ ผิดพลาด\n\n{}", e),
                )
                .await;
                // Mark failed
                if let Some(vid) = payload_clone.video_id {
                    let client = Client::new();
                    let url = format!(
                        "{}/api/r2-proxy/_processing/{}.json",
                        payload_clone.worker_url, vid
                    );
                    let bot_id = payload_clone
                        .bot_id
                        .clone()
                        .unwrap_or_else(|| "default".to_string());
                    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
                    let mut json = if let Ok(res) = client
                        .get(&url)
                        .header("x-auth-token", &payload_clone.token)
                        .header("x-bot-id", &bot_id)
                        .send()
                        .await
                    {
                        res.json::<Value>().await.unwrap_or_else(|_| json!({}))
                    } else {
                        json!({})
                    };
                    if !json.is_object() {
                        json = json!({});
                    }
                    let error_text = e.to_string();
                    if let Some(obj) = json.as_object_mut() {
                        obj.insert("id".to_string(), json!(vid));
                        obj.insert("status".to_string(), json!("failed"));
                        obj.insert("error".to_string(), json!(error_text.clone()));
                        obj.insert(
                            "errorCategory".to_string(),
                            json!(pipeline_error_category(&error_text)),
                        );
                        obj.insert("failedAt".to_string(), json!(now));
                        obj.insert("updatedAt".to_string(), json!(now));
                    }
                    let _ = r2_put(
                        &payload_clone.worker_url,
                        &payload_clone.token,
                        &bot_id,
                        &format!("_processing/{}.json", vid),
                        serde_json::to_vec(&json).unwrap(),
                        "application/json",
                    )
                    .await;
                    let _ = client
                        .post(&format!("{}/api/queue/next", payload_clone.worker_url))
                        .header("x-auth-token", &payload_clone.token)
                        .header("x-bot-id", &bot_id)
                        .send()
                        .await;
                }
            }
        }
    });

    Ok(Json(PipelineResponse {
        status: "started".to_string(),
    }))
}
