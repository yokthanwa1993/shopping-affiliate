use crate::version::PIPELINE_ENGINE_VERSION;
use axum::{
    Json,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::process::Output;
use std::sync::{Arc, OnceLock};
use std::time::Instant;
use tempfile::tempdir;
use tokio::fs;
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::{Duration, sleep};
use uuid::Uuid;

const GEMINI_SAFE_TRANSCODE_TIMEOUT_SECS: u64 = 300;
const GEMINI_SAFE_TRANSCODE_MIN_BYTES: usize = 1024;
const GEMINI_INLINE_VIDEO_MAX_BYTES: usize = 14 * 1024 * 1024;
const GEMINI_PREFLIGHT_MIN_DURATION_SECS: f64 = 0.3;
const GEMINI_PREFLIGHT_MAX_DURATION_SECS: f64 = 1800.0;
const VERTEX_GENERATION_INLINE_MAX_BYTES: usize = GEMINI_INLINE_VIDEO_MAX_BYTES;
const VERTEX_GEMINI_AUDIO_SRT_TIMEOUT_SECS: u64 = 120;
const GEMINI_STRICT_INLINE_TARGET_BYTES: usize = VERTEX_GENERATION_INLINE_MAX_BYTES * 85 / 100;
const GEMINI_STRICT_INLINE_CONTAINER_HEADROOM_BYTES: usize = 256 * 1024;
const GEMINI_STRICT_MAX_SIDE: u32 = 360;
const GEMINI_STRICT_FPS: u32 = 15;
const GEMINI_STRICT_MIN_VIDEO_BITRATE_KBPS: u32 = 40;
const GEMINI_STRICT_MAX_VIDEO_BITRATE_KBPS: u32 = 360;
const SUBTITLE_BURN_TIMEOUT_SECS: u64 = 300;
// Cloudflare Workers reject request bodies larger than the account plan limit
// (100 MB on Free/Pro) with HTTP 413 *before* the request reaches our
// `/api/r2-upload/:key` route, so the Worker cannot raise it. Large processed
// MP4 outputs therefore fail the final upload. We re-encode the
// already-subtitle-burned final MP4 down to a safe size before uploading;
// subtitles are pixel-burned so re-encoding preserves them. The ceiling is
// overridable via the `R2_UPLOAD_MAX_BYTES` env var (e.g. lower it for a
// smaller plan) without a code/version change.
const R2_UPLOAD_MAX_BYTES_DEFAULT: usize = 95 * 1024 * 1024;
// Compression target leaves headroom below the hard ceiling so a single pass
// reliably lands under it.
const R2_UPLOAD_COMPRESS_TARGET_BYTES: usize = 85 * 1024 * 1024;
const FINAL_COMPRESS_TIMEOUT_SECS: u64 = 600;
const FINAL_COMPRESS_MIN_VIDEO_BITRATE_KBPS: u32 = 300;
const FINAL_COMPRESS_AUDIO_BITRATE_KBPS: u32 = 96;
// Fast bounded budgets for the cosmetic horizontal-flip preprocessing step. The
// primary flip re-encodes (ultrafast/high-CRF) so even long LINE videos finish
// well inside the budget; if it still times out or fails we fall back to a
// near-instant stream-copy remux (no flip) so the job is never terminal-failed
// solely because the cosmetic mirror exceeded its budget.
const FLIP_PRIMARY_TIMEOUT_SECS: u64 = 150;
const FLIP_FALLBACK_TIMEOUT_SECS: u64 = 60;
const VERTEX_TTS_DEFAULT_ENDPOINT: &str = "https://aiplatform.googleapis.com";
const VERTEX_TTS_DEFAULT_LOCATION: &str = "global";
const VERTEX_TTS_DEFAULT_MODEL: &str = "gemini-2.5-flash-preview-tts";

#[derive(Deserialize, Clone)]
pub struct PipelineRequest {
    pub token: String,
    pub video_url: String,
    pub chat_id: u64,
    pub msg_id: Option<u64>,
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

#[derive(Deserialize, Clone, Debug)]
pub struct AvatarComposeRequest {
    #[serde(alias = "base_video_url", alias = "baseVideoUrl")]
    pub video_url: String,
    #[serde(alias = "avatarVideoUrl")]
    pub avatar_video_url: String,
    #[serde(
        default = "default_avatar_chromakey_similarity",
        alias = "chromakeySimilarity"
    )]
    pub chromakey_similarity: f64,
    #[serde(default = "default_avatar_chromakey_blend", alias = "chromakeyBlend")]
    pub chromakey_blend: f64,
}

#[derive(Serialize)]
pub struct AvatarComposeStartResponse {
    pub status: String,
    pub job_id: String,
}

#[derive(Clone, Debug)]
struct ScriptPack {
    script: String,
    title: String,
    category: String,
    subtitle_lines: Vec<String>,
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
    let payload_bytes = data.len();
    let client = Client::new();
    let res = client
        .put(&url)
        .header("x-auth-token", token)
        .header("x-bot-id", bot_id)
        .header("content-type", content_type)
        .body(data)
        .send()
        .await?;
    let status = res.status();
    if !status.is_success() {
        // Surface the local payload size + the upload ceiling on 413 so the
        // failure is diagnosable without leaking tokens/URLs.
        if status.as_u16() == 413 {
            return Err(format!(
                "R2 upload failed: 413 Payload Too Large (payload {} bytes, upload ceiling {} bytes)",
                payload_bytes,
                r2_upload_max_bytes()
            )
            .into());
        }
        return Err(format!("R2 upload failed: {}", status).into());
    }
    Ok(())
}

/// Hard ceiling (in bytes) for the final-MP4 Worker PUT body. Defaults to a
/// conservative value below the Cloudflare 100 MB Free/Pro request-body limit,
/// overridable via `R2_UPLOAD_MAX_BYTES` (only honored when >= 8 MB so a stray
/// tiny value cannot brick uploads).
fn r2_upload_max_bytes() -> usize {
    std::env::var("R2_UPLOAD_MAX_BYTES")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|v| *v >= 8 * 1024 * 1024)
        .unwrap_or(R2_UPLOAD_MAX_BYTES_DEFAULT)
}

/// Average video bitrate (kbps) that fits `duration_secs` of video plus the
/// AAC audio track inside `target_bytes`, clamped to a sane floor so we never
/// destroy short outputs into mush.
fn final_compress_video_bitrate_kbps(target_bytes: usize, duration_secs: f64) -> u32 {
    let dur = duration_secs.max(1.0);
    let total_kbps = (target_bytes as f64 * 8.0 / 1000.0) / dur;
    let video_kbps = total_kbps - FINAL_COMPRESS_AUDIO_BITRATE_KBPS as f64;
    video_kbps
        .max(FINAL_COMPRESS_MIN_VIDEO_BITRATE_KBPS as f64)
        .round() as u32
}

/// Build a size-targeting re-encode of an already-subtitle-burned MP4. Subtitles
/// are pixel-burned in the source, so no subtitle handling is needed here. The
/// optional `max_long_side` downscales the longest dimension (aspect-preserving,
/// even dims) and `fps_cap` limits frame rate; both only ever shrink.
fn build_final_compress_ffmpeg_args(
    input_str: &str,
    output_str: &str,
    video_bitrate_kbps: u32,
    max_long_side: Option<u32>,
    fps_cap: Option<u32>,
) -> Vec<String> {
    let mut args = Vec::new();
    push_ffmpeg_args(&mut args, &["-y", "-i", input_str]);

    let mut filters: Vec<String> = Vec::new();
    if let Some(side) = max_long_side {
        // Clamp the longest side to `side`, keep aspect, force even dimensions
        // (-2). When the source is already smaller, min() is a no-op.
        filters.push(format!(
            "scale=w='if(gt(iw,ih),min(iw,{side}),-2)':h='if(gt(iw,ih),-2,min(ih,{side}))'",
            side = side
        ));
    }
    if let Some(fps) = fps_cap {
        filters.push(format!("fps={}", fps));
    }
    filters.push("format=yuv420p".to_string());
    let vf = filters.join(",");
    push_ffmpeg_args(&mut args, &["-vf", &vf]);

    let maxrate = video_bitrate_kbps * 115 / 100;
    let bufsize = video_bitrate_kbps * 2;
    push_ffmpeg_args(&mut args, &["-c:v", "libx264", "-preset", "medium"]);
    push_ffmpeg_args(&mut args, &["-b:v", &format!("{}k", video_bitrate_kbps)]);
    push_ffmpeg_args(&mut args, &["-maxrate", &format!("{}k", maxrate)]);
    push_ffmpeg_args(&mut args, &["-bufsize", &format!("{}k", bufsize)]);
    push_ffmpeg_args(&mut args, &["-pix_fmt", "yuv420p"]);
    push_ffmpeg_args(
        &mut args,
        &[
            "-c:a",
            "aac",
            "-b:a",
            &format!("{}k", FINAL_COMPRESS_AUDIO_BITRATE_KBPS),
        ],
    );
    push_ffmpeg_args(&mut args, &["-movflags", "+faststart", output_str]);
    args
}

/// Ensure the final MP4 at `output_mp4` is small enough for the Worker PUT body.
/// If it already fits, this is a no-op. Otherwise it re-encodes in escalating
/// tiers (each more aggressive on resolution/fps) until the result is both
/// smaller than the original *and* under the ceiling, then replaces the file in
/// place under the same path. Returns a distinct, non-retryable error if no tier
/// succeeds so the job fails cleanly instead of re-attempting the same category.
async fn ensure_final_mp4_within_upload_limit(
    output_mp4: &Path,
    tmp_path: &Path,
    duration_secs: f64,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let max_bytes = r2_upload_max_bytes();
    let original_len = fs::metadata(output_mp4).await?.len() as usize;
    if original_len <= max_bytes {
        return Ok(());
    }
    println!(
        "[PIPELINE] final mp4 {} bytes exceeds upload ceiling {} bytes; compressing",
        original_len, max_bytes
    );

    let target_bytes = R2_UPLOAD_COMPRESS_TARGET_BYTES.min(max_bytes);
    // (max_long_side, fps_cap) — escalate only if a tier is still over the
    // ceiling. Vertical shorts stay sharp at 1280; later tiers protect very
    // long/high-bitrate sources.
    let tiers: [(Option<u32>, Option<u32>); 3] = [
        (Some(1280), Some(30)),
        (Some(854), Some(30)),
        (Some(640), Some(24)),
    ];
    let compressed = tmp_path.join("final_compressed.mp4");

    for (i, (side, fps)) in tiers.iter().enumerate() {
        let bitrate = final_compress_video_bitrate_kbps(target_bytes, duration_secs);
        let args = build_final_compress_ffmpeg_args(
            output_mp4.to_str().ok_or("invalid_output_path")?,
            compressed.to_str().ok_or("invalid_compressed_path")?,
            bitrate,
            *side,
            *fps,
        );
        let _ = fs::remove_file(&compressed).await;
        let result = tokio::time::timeout(Duration::from_secs(FINAL_COMPRESS_TIMEOUT_SECS), {
            let mut command = Command::new("ffmpeg");
            command.kill_on_drop(true).args(&args);
            command.output()
        })
        .await;
        let ok = match result {
            Err(_) => {
                println!("[PIPELINE] final compress tier {} timed out", i);
                false
            }
            Ok(Err(e)) => {
                println!("[PIPELINE] final compress tier {} process error: {}", i, e);
                false
            }
            Ok(Ok(out)) => match ffmpeg_nonzero_status_reason(&out) {
                Some(reason) => {
                    println!("[PIPELINE] final compress tier {} failed: {}", i, reason);
                    false
                }
                None => true,
            },
        };
        if !ok {
            continue;
        }
        let new_len = match fs::metadata(&compressed).await {
            Ok(m) => m.len() as usize,
            Err(_) => continue,
        };
        if new_len == 0 || new_len >= original_len {
            println!(
                "[PIPELINE] final compress tier {} not smaller ({} -> {} bytes); escalating",
                i, original_len, new_len
            );
            continue;
        }
        if new_len <= max_bytes {
            fs::remove_file(output_mp4).await.ok();
            fs::rename(&compressed, output_mp4).await?;
            println!(
                "[PIPELINE] final mp4 compressed {} -> {} bytes (tier {})",
                original_len, new_len, i
            );
            return Ok(());
        }
        println!(
            "[PIPELINE] final compress tier {} still over ceiling ({} > {} bytes); escalating",
            i, new_len, max_bytes
        );
    }

    let _ = fs::remove_file(&compressed).await;
    Err(format!(
        "final mp4 exceeds upload ceiling after compression (original {} bytes, ceiling {} bytes)",
        original_len, max_bytes
    )
    .into())
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

// ==================== Media processing helpers ====================

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
    } else if normalized.contains("exceeds upload ceiling after compression") {
        // Output is irreducibly too large for the Worker PUT body even after the
        // most aggressive compression tier — terminal, not worth retrying.
        "final_upload_too_large"
    } else if normalized.contains("413 payload too large") {
        "r2_upload_payload_too_large"
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
            GeminiTranscodeProfile::Strict => GEMINI_STRICT_MAX_SIDE,
        }
    }

    fn fps(&self) -> u32 {
        match self {
            GeminiTranscodeProfile::Safe => 24,
            GeminiTranscodeProfile::Strict => GEMINI_STRICT_FPS,
        }
    }

    fn video_only(&self) -> bool {
        matches!(self, GeminiTranscodeProfile::Strict)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct GeminiStrictVideoBudget {
    bitrate_kbps: u32,
    maxrate_kbps: u32,
    bufsize_kbps: u32,
}

fn gemini_strict_video_budget(duration_secs: f64) -> GeminiStrictVideoBudget {
    let duration_secs = if duration_secs.is_finite() && duration_secs > 0.0 {
        duration_secs.max(GEMINI_PREFLIGHT_MIN_DURATION_SECS)
    } else {
        GEMINI_PREFLIGHT_MAX_DURATION_SECS
    };
    let video_budget_bytes = GEMINI_STRICT_INLINE_TARGET_BYTES
        .saturating_sub(GEMINI_STRICT_INLINE_CONTAINER_HEADROOM_BYTES);
    let bitrate_kbps = ((video_budget_bytes as f64 * 8.0) / duration_secs / 1000.0)
        .floor()
        .max(1.0) as u32;
    let bitrate_kbps = bitrate_kbps.clamp(
        GEMINI_STRICT_MIN_VIDEO_BITRATE_KBPS,
        GEMINI_STRICT_MAX_VIDEO_BITRATE_KBPS,
    );

    GeminiStrictVideoBudget {
        bitrate_kbps,
        maxrate_kbps: bitrate_kbps,
        bufsize_kbps: bitrate_kbps * 2,
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

fn push_ffmpeg_args(args: &mut Vec<String>, values: &[&str]) {
    args.extend(values.iter().map(|value| value.to_string()));
}

fn build_flip_processing_input_ffmpeg_args(input_str: &str, output_str: &str) -> Vec<String> {
    let mut args = Vec::new();
    push_ffmpeg_args(&mut args, &["-y", "-i", input_str]);
    push_ffmpeg_args(&mut args, &["-vf", "hflip,format=yuv420p"]);
    push_ffmpeg_args(&mut args, &["-c:v", "libx264"]);
    // Speed/reliability over CRF quality for this intermediate input: ultrafast +
    // high CRF keeps the encode bounded for long/large LINE videos. zerolatency
    // disables lookahead so ffmpeg spends less time before producing frames.
    push_ffmpeg_args(&mut args, &["-preset", "ultrafast", "-crf", "28"]);
    push_ffmpeg_args(&mut args, &["-tune", "zerolatency"]);
    push_ffmpeg_args(&mut args, &["-pix_fmt", "yuv420p"]);
    push_ffmpeg_args(&mut args, &["-c:a", "aac", "-b:a", "128k"]);
    push_ffmpeg_args(&mut args, &["-movflags", "+faststart"]);
    args.push(output_str.to_string());
    args
}

/// Fallback when the cosmetic flip cannot finish in budget: stream-copy remux
/// (no re-encode, no flip) so the job continues with the original/normalized
/// input instead of terminal-failing on a cosmetic mirror.
fn build_flip_fallback_remux_ffmpeg_args(input_str: &str, output_str: &str) -> Vec<String> {
    let mut args = Vec::new();
    push_ffmpeg_args(&mut args, &["-y", "-i", input_str]);
    push_ffmpeg_args(&mut args, &["-c", "copy"]);
    push_ffmpeg_args(&mut args, &["-movflags", "+faststart"]);
    args.push(output_str.to_string());
    args
}

async fn run_flip_ffmpeg_step(
    args: &[String],
    timeout_secs: u64,
    label: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let output = tokio::time::timeout(
        Duration::from_secs(timeout_secs),
        Command::new("ffmpeg").args(args).output(),
    )
    .await
    .map_err(|_| format!("FFmpeg {} timed out (>{}s)", label, timeout_secs))??;
    if let Some(reason) = ffmpeg_nonzero_status_reason(&output) {
        return Err(format!("FFmpeg {} failed: {}", label, reason).into());
    }
    Ok(())
}

async fn create_flipped_processing_input(
    input_path: &Path,
    output_path: &Path,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let input_str = input_path
        .to_str()
        .ok_or("source_video_path_invalid_for_flip")?;
    let output_str = output_path
        .to_str()
        .ok_or("processing_video_path_invalid_for_flip")?;

    // Primary: fast bounded horizontal flip.
    let flip_args = build_flip_processing_input_ffmpeg_args(input_str, output_str);
    match run_flip_ffmpeg_step(&flip_args, FLIP_PRIMARY_TIMEOUT_SECS, "flip").await {
        Ok(()) => return Ok(()),
        Err(flip_err) => {
            eprintln!(
                "[PIPELINE] flip preprocessing failed ({}); falling back to no-flip stream-copy remux",
                flip_err
            );
        }
    }

    // Fallback: skip the cosmetic flip and remux the original so the job still
    // completes. Surfaces the remux error if even the copy path fails (truly
    // terminal — the source itself is unusable, not just the cosmetic flip).
    let remux_args = build_flip_fallback_remux_ffmpeg_args(input_str, output_str);
    run_flip_ffmpeg_step(&remux_args, FLIP_FALLBACK_TIMEOUT_SECS, "flip-fallback-remux")
        .await
        .map_err(|remux_err| {
            format!("FFmpeg flip fallback remux failed: {}", remux_err).into()
        })
}

fn build_gemini_transcode_ffmpeg_args(
    input_str: &str,
    output_str: &str,
    profile: GeminiTranscodeProfile,
    input_duration_secs: f64,
) -> Vec<String> {
    let vf_filter = build_gemini_transcode_filter(profile);
    let mut args = Vec::new();
    push_ffmpeg_args(
        &mut args,
        &[
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
            "-profile:v",
            "baseline",
            "-level",
            "3.1",
            "-preset",
            "medium",
        ],
    );

    match profile {
        GeminiTranscodeProfile::Safe => {
            push_ffmpeg_args(&mut args, &["-crf", "26"]);
        }
        GeminiTranscodeProfile::Strict => {
            let budget = gemini_strict_video_budget(input_duration_secs);
            push_ffmpeg_args(&mut args, &["-b:v", &format!("{}k", budget.bitrate_kbps)]);
            push_ffmpeg_args(
                &mut args,
                &["-maxrate", &format!("{}k", budget.maxrate_kbps)],
            );
            push_ffmpeg_args(
                &mut args,
                &["-bufsize", &format!("{}k", budget.bufsize_kbps)],
            );
        }
    }

    push_ffmpeg_args(
        &mut args,
        &[
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
            "-pix_fmt",
            "yuv420p",
        ],
    );

    if profile.video_only() {
        push_ffmpeg_args(&mut args, &["-an"]);
    } else {
        // Force a clean, mainstream audio track for the primary Gemini upload.
        push_ffmpeg_args(
            &mut args,
            &[
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
            ],
        );
    }

    push_ffmpeg_args(
        &mut args,
        &[
            "-avoid_negative_ts",
            "make_zero",
            "-max_muxing_queue_size",
            "4096",
            "-movflags",
            "+faststart",
            output_str,
        ],
    );
    args
}

async fn transcode_video_for_gemini_with_profile(
    input_path: &Path,
    output_path: &Path,
    profile: GeminiTranscodeProfile,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    let input_str = input_path.to_str().ok_or("invalid_input_path")?;
    let output_str = output_path.to_str().ok_or("invalid_output_path")?;
    let input_duration_secs = if profile == GeminiTranscodeProfile::Strict {
        preflight_probe_for_gemini(input_path)
            .await
            .map_err(|e| format!("{} source preflight failed: {}", profile.label(), e))?
            .duration
    } else {
        0.0
    };
    let args =
        build_gemini_transcode_ffmpeg_args(input_str, output_str, profile, input_duration_secs);

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
    if profile == GeminiTranscodeProfile::Strict && bytes.len() > VERTEX_GENERATION_INLINE_MAX_BYTES
    {
        return Err(format!(
            "{} transcode exceeded inline limit: {} bytes > {} bytes",
            profile.label(),
            bytes.len(),
            VERTEX_GENERATION_INLINE_MAX_BYTES
        )
        .into());
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

fn build_gemini_inline_video_part(file_bytes: &[u8]) -> Value {
    json!({
        "inlineData": {
            "mimeType": "video/mp4",
            "data": BASE64.encode(file_bytes),
        }
    })
}

fn build_inline_media_part(file_bytes: &[u8], mime_type: &str) -> Value {
    json!({
        "inlineData": {
            "mimeType": mime_type,
            "data": BASE64.encode(file_bytes),
        }
    })
}

fn extract_generate_content_text(json: &Value) -> Option<String> {
    json.get("candidates")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.get(0))
        .and_then(|p| p.get("text"))
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
}

fn parse_script_pack_from_response(resp_text: &str) -> ScriptPack {
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

    ScriptPack {
        script,
        title,
        category,
        subtitle_lines,
    }
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

#[derive(Clone, Debug)]
struct VertexGenerationContext {
    client: Client,
    access_token: String,
    endpoint: String,
    project_id: String,
    location: String,
    model: String,
}

fn has_vertex_service_account_config(request_raw_json: Option<&str>) -> bool {
    request_raw_json
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
        || std::env::var("VERTEX_TTS_SERVICE_ACCOUNT_JSON")
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
        || std::env::var("GOOGLE_APPLICATION_CREDENTIALS")
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
}

fn resolve_vertex_endpoint(request_endpoint: Option<&str>) -> String {
    request_endpoint
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            std::env::var("VERTEX_TTS_ENDPOINT")
                .ok()
                .map(|v| v.trim().trim_end_matches('/').to_string())
                .filter(|v| !v.is_empty())
        })
        .unwrap_or_else(|| VERTEX_TTS_DEFAULT_ENDPOINT.to_string())
}

fn resolve_vertex_project_id(
    request_project_id: Option<&str>,
    service_account: &VertexServiceAccount,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    request_project_id
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            std::env::var("VERTEX_TTS_PROJECT_ID")
                .ok()
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
        .ok_or_else(|| "Vertex project_id is not configured".into())
}

fn resolve_vertex_location(request_location: Option<&str>) -> String {
    request_location
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            std::env::var("VERTEX_TTS_LOCATION")
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
        .unwrap_or_else(|| VERTEX_TTS_DEFAULT_LOCATION.to_string())
}

async fn build_vertex_generation_context(
    client: &Client,
    req: &PipelineRequest,
    model: &str,
) -> Result<VertexGenerationContext, Box<dyn std::error::Error + Send + Sync>> {
    if !has_vertex_service_account_config(req.vertex_tts_service_account_json.as_deref()) {
        return Err("Vertex service account is required for Vertex Gemini processing".into());
    }
    let service_account =
        load_vertex_service_account(req.vertex_tts_service_account_json.as_deref())?;
    let access_token = fetch_vertex_access_token(client, &service_account).await?;
    let endpoint = resolve_vertex_endpoint(req.vertex_tts_endpoint.as_deref());
    let project_id =
        resolve_vertex_project_id(req.vertex_tts_project_id.as_deref(), &service_account)?;
    let location = resolve_vertex_location(req.vertex_tts_location.as_deref());
    let model = model.trim();
    let model = if model.is_empty() {
        "gemini-3-flash-preview".to_string()
    } else {
        model.to_string()
    };
    println!(
        "[PIPELINE] Vertex Gemini generation auth ready model={} location={}",
        model, location
    );
    Ok(VertexGenerationContext {
        client: client.clone(),
        access_token,
        endpoint,
        project_id,
        location,
        model,
    })
}

fn is_retryable_generation_status(status: u16) -> bool {
    status == 500 || status == 503 || status == 429
}

async fn vertex_generate_content_text(
    ctx: &VertexGenerationContext,
    payload: &Value,
    source_label: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let url = format!(
        "{}/v1/projects/{}/locations/{}/publishers/google/models/{}:generateContent",
        ctx.endpoint, ctx.project_id, ctx.location, ctx.model
    );
    let mut last_err = String::new();
    for attempt in 0..6 {
        if attempt > 0 {
            tokio::time::sleep(tokio::time::Duration::from_secs(5 * attempt)).await;
            println!(
                "[PIPELINE] vertex_generate_content {} retry #{}",
                source_label, attempt
            );
        }
        let res = match ctx
            .client
            .post(&url)
            .bearer_auth(&ctx.access_token)
            .json(payload)
            .send()
            .await
        {
            Ok(res) => res,
            Err(err) => {
                last_err = format!(
                    "Vertex Gemini {} request_error attempt_{}: {}",
                    source_label,
                    attempt + 1,
                    err
                );
                continue;
            }
        };
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        if (200..300).contains(&status) {
            let json: Value = serde_json::from_str(&body).unwrap_or(json!({}));
            if let Some(text) = extract_generate_content_text(&json) {
                return Ok(text);
            }
            last_err = format!(
                "Vertex Gemini {} success_without_text_body: {}",
                source_label,
                redact_vertex_error(&body)
            );
        } else {
            last_err = format!(
                "Vertex Gemini {} http_{}: {}",
                source_label,
                status,
                redact_vertex_error(&body)
            );
            if !is_retryable_generation_status(status) {
                return Err(last_err.into());
            }
        }
    }
    Err(last_err.into())
}

async fn vertex_gemini_script_inline_video(
    file_bytes: &[u8],
    ctx: &VertexGenerationContext,
    duration: f64,
    user_prompt: Option<&str>,
    source_label: &str,
) -> Result<ScriptPack, Box<dyn std::error::Error + Send + Sync>> {
    if file_bytes.len() > VERTEX_GENERATION_INLINE_MAX_BYTES {
        return Err(format!(
            "Vertex inline video exceeds {} bytes after {} transcode; GCS fileData upload is not implemented",
            VERTEX_GENERATION_INLINE_MAX_BYTES, source_label
        )
        .into());
    }

    let max_chars = ((duration * 10.0) as i32).min(800);
    let min_chars = ((duration * 7.0) as i32).max(80);
    let prompt = build_script_prompt(user_prompt, duration, min_chars, max_chars);
    let payload = json!({
        "contents": [{
            "role": "user",
            "parts": [
                build_gemini_inline_video_part(file_bytes),
                {"text": prompt}
            ]
        }],
        "generationConfig": {
            "temperature": 0.2
        }
    });
    let resp_text = vertex_generate_content_text(ctx, &payload, source_label).await?;
    Ok(parse_script_pack_from_response(&resp_text))
}

async fn vertex_gemini_srt_from_audio_bytes(
    file_bytes: &[u8],
    subtitle_lines: &[String],
    ctx: &VertexGenerationContext,
    duration: f64,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    if file_bytes.len() > VERTEX_GENERATION_INLINE_MAX_BYTES {
        return Err(format!(
            "Vertex inline audio exceeds {} bytes; deterministic subtitle fallback required",
            VERTEX_GENERATION_INLINE_MAX_BYTES
        )
        .into());
    }

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
    let payload = json!({
        "contents": [{
            "role": "user",
            "parts": [
                build_inline_media_part(file_bytes, "audio/wav"),
                {"text": prompt}
            ]
        }],
        "generationConfig": {
            "temperature": 0.1
        }
    });
    let resp_text = vertex_generate_content_text(ctx, &payload, "audio-srt").await?;
    let extracted = extract_srt_payload(&resp_text);
    Ok(normalize_srt_blocks(&extracted, duration.max(1.0)))
}

fn should_retry_vertex_with_strict(variant: GeminiUploadVariant, err: &str) -> bool {
    if variant != GeminiUploadVariant::Safe {
        return false;
    }
    let normalized = err.to_ascii_lowercase();
    normalized.contains("vertex inline video exceeds")
        || normalized.contains("request entity too large")
        || normalized.contains("payload too large")
        || normalized.contains("request payload size")
        || (normalized.contains("invalid_argument")
            && (normalized.contains("video")
                || normalized.contains("media")
                || normalized.contains("mime")
                || normalized.contains("inline")))
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
    _tts_prompt_template: Option<&str>,
    _tts_style_instructions: Option<&str>,
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
        AVATAR_COMPOSE_AUDIO_BITRATE, AVATAR_COMPOSE_VIDEO_BITRATE, AVATAR_COMPOSE_VIDEO_BUFSIZE,
        AVATAR_COMPOSE_VIDEO_MAXRATE, AVATAR_COMPOSE_VIDEO_PRESET,
        GEMINI_PREFLIGHT_MAX_DURATION_SECS, GEMINI_STRICT_INLINE_CONTAINER_HEADROOM_BYTES,
        GeminiPreflightError, GeminiTranscodeProfile, VERTEX_GEMINI_AUDIO_SRT_TIMEOUT_SECS,
        VERTEX_GENERATION_INLINE_MAX_BYTES, build_avatar_compose_ffmpeg_args,
        FINAL_COMPRESS_AUDIO_BITRATE_KBPS, FINAL_COMPRESS_MIN_VIDEO_BITRATE_KBPS,
        build_avatar_compose_filter_complex, build_final_compress_ffmpeg_args,
        build_final_merge_ffmpeg_args, build_flip_fallback_remux_ffmpeg_args,
        build_flip_processing_input_ffmpeg_args, build_gemini_inline_video_part,
        final_compress_video_bitrate_kbps,
        build_gemini_transcode_ffmpeg_args, build_gemini_transcode_filter,
        build_srt_from_lines_with_timing, build_tts_payload, convert_to_ass,
        extract_speech_srt_time_span, extract_srt_payload, ffmpeg_nonzero_status_reason,
        format_gemini_preflight_info, normalize_srt_blocks, parse_gemini_preflight_info,
        parse_srt_time_range, pipeline_error_category, validate_gemini_safe_output,
    };
    use serde_json::json;

    fn extract_time_lines(srt: &str) -> Vec<(f64, f64)> {
        srt.lines()
            .filter_map(|l| parse_srt_time_range(l))
            .collect::<Vec<_>>()
    }

    #[test]
    fn final_compress_bitrate_fits_target_and_respects_floor() {
        // 30 MB target over 60s → well above the floor, derived from size.
        let kbps = final_compress_video_bitrate_kbps(30 * 1024 * 1024, 60.0);
        let expected_total = (30.0 * 1024.0 * 1024.0 * 8.0 / 1000.0) / 60.0;
        let expected_video = (expected_total - FINAL_COMPRESS_AUDIO_BITRATE_KBPS as f64).round() as u32;
        assert_eq!(kbps, expected_video);
        assert!(kbps > FINAL_COMPRESS_MIN_VIDEO_BITRATE_KBPS);

        // Tiny target over a long video must never fall below the floor.
        let floored = final_compress_video_bitrate_kbps(1024 * 1024, 600.0);
        assert_eq!(floored, FINAL_COMPRESS_MIN_VIDEO_BITRATE_KBPS);

        // Zero/negative duration must not panic or divide by zero.
        let safe = final_compress_video_bitrate_kbps(10 * 1024 * 1024, 0.0);
        assert!(safe >= FINAL_COMPRESS_MIN_VIDEO_BITRATE_KBPS);
    }

    #[test]
    fn final_compress_args_target_size_and_preserve_burned_frames() {
        let args =
            build_final_compress_ffmpeg_args("/tmp/in.mp4", "/tmp/out.mp4", 1200, Some(1280), Some(30));
        let value_after = |flag: &str| {
            args.iter()
                .position(|a| a == flag)
                .and_then(|i| args.get(i + 1))
                .map(String::as_str)
        };
        assert_eq!(value_after("-i"), Some("/tmp/in.mp4"));
        assert_eq!(args.last().map(String::as_str), Some("/tmp/out.mp4"));
        assert_eq!(value_after("-c:v"), Some("libx264"));
        assert_eq!(value_after("-b:v"), Some("1200k"));
        // maxrate = 115%, bufsize = 200% of the target bitrate.
        assert_eq!(value_after("-maxrate"), Some("1380k"));
        assert_eq!(value_after("-bufsize"), Some("2400k"));
        assert_eq!(value_after("-movflags"), Some("+faststart"));
        // Audio is re-encoded (subtitles are pixel-burned; no -sn/subtitle args).
        assert_eq!(value_after("-c:a"), Some("aac"));
        assert!(!args.iter().any(|a| a == "-sn"));
        // vf clamps the longest side and caps fps.
        let vf = value_after("-vf").expect("vf present");
        assert!(vf.contains("1280"), "vf should clamp long side: {vf}");
        assert!(vf.contains("fps=30"), "vf should cap fps: {vf}");
    }

    #[test]
    fn final_compress_args_without_scaling_still_normalizes_pixfmt() {
        let args = build_final_compress_ffmpeg_args("/tmp/in.mp4", "/tmp/out.mp4", 800, None, None);
        let vf = args
            .iter()
            .position(|a| a == "-vf")
            .and_then(|i| args.get(i + 1))
            .map(String::as_str)
            .expect("vf present");
        assert_eq!(vf, "format=yuv420p");
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
    fn vertex_gemini_audio_srt_timeout_is_bounded() {
        assert!(
            (90..=120).contains(&VERTEX_GEMINI_AUDIO_SRT_TIMEOUT_SECS),
            "Vertex audio SRT sync timeout should stay within the operational guardrail"
        );
    }

    #[test]
    fn srt_burn_nonzero_status_has_fallback_reason() {
        use std::os::unix::process::ExitStatusExt;

        let output = std::process::Output {
            status: std::process::ExitStatus::from_raw(1 << 8),
            stdout: Vec::new(),
            stderr: Vec::new(),
        };
        let reason = ffmpeg_nonzero_status_reason(&output).expect("non-zero status fails");

        assert!(reason.contains("exit_status="));
        assert!(reason.contains('1'));
    }

    #[test]
    fn flip_processing_input_ffmpeg_args_mirror_and_normalize_mp4() {
        let args = build_flip_processing_input_ffmpeg_args("/tmp/video.mp4", "/tmp/processing.mp4");
        let value_after = |flag: &str| {
            args.iter()
                .position(|arg| arg == flag)
                .and_then(|index| args.get(index + 1))
                .map(String::as_str)
        };

        assert_eq!(value_after("-i"), Some("/tmp/video.mp4"));
        assert_eq!(value_after("-vf"), Some("hflip,format=yuv420p"));
        assert_eq!(value_after("-c:v"), Some("libx264"));
        // Fast bounded transcode: ultrafast preset + high CRF over quality so
        // long/large LINE videos finish well inside FLIP_PRIMARY_TIMEOUT_SECS.
        assert_eq!(value_after("-preset"), Some("ultrafast"));
        assert_eq!(value_after("-crf"), Some("28"));
        assert_eq!(value_after("-tune"), Some("zerolatency"));
        assert_eq!(value_after("-pix_fmt"), Some("yuv420p"));
        assert_eq!(value_after("-c:a"), Some("aac"));
        assert_eq!(value_after("-b:a"), Some("128k"));
        assert_eq!(value_after("-movflags"), Some("+faststart"));
        assert_eq!(args.last().map(String::as_str), Some("/tmp/processing.mp4"));
    }

    #[test]
    fn flip_fallback_remux_streams_copy_without_flip() {
        let args =
            build_flip_fallback_remux_ffmpeg_args("/tmp/video.mp4", "/tmp/processing.mp4");
        let value_after = |flag: &str| {
            args.iter()
                .position(|arg| arg == flag)
                .and_then(|index| args.get(index + 1))
                .map(String::as_str)
        };

        assert_eq!(value_after("-i"), Some("/tmp/video.mp4"));
        // Fallback must NOT re-encode (no libx264) and must NOT flip (no -vf),
        // so it stays near-instant and never re-hits the encode timeout.
        assert_eq!(value_after("-c"), Some("copy"));
        assert!(!args.iter().any(|arg| arg == "-vf"));
        assert!(!args.iter().any(|arg| arg == "libx264"));
        assert!(!args.iter().any(|arg| arg == "hflip,format=yuv420p"));
        assert_eq!(value_after("-movflags"), Some("+faststart"));
        assert_eq!(args.last().map(String::as_str), Some("/tmp/processing.mp4"));
    }

    #[test]
    fn final_merge_ffmpeg_args_use_flipped_processing_input() {
        let args = build_final_merge_ffmpeg_args(
            "/tmp/video_processing_flipped.mp4",
            "/tmp/audio_adj.wav",
            12.5,
            "/tmp/merged_nosub.mp4",
        );
        let first_input = args
            .iter()
            .position(|arg| arg == "-i")
            .and_then(|index| args.get(index + 1))
            .map(String::as_str);
        let value_after = |flag: &str| {
            args.iter()
                .position(|arg| arg == flag)
                .and_then(|index| args.get(index + 1))
                .map(String::as_str)
        };

        assert_eq!(first_input, Some("/tmp/video_processing_flipped.mp4"));
        assert!(!args.iter().any(|arg| arg == "/tmp/video.mp4"));
        assert_eq!(value_after("-c:v"), Some("copy"));
        assert_eq!(value_after("-c:a"), Some("aac"));
        assert_eq!(value_after("-t"), Some("12.5"));
        assert_eq!(
            args.last().map(String::as_str),
            Some("/tmp/merged_nosub.mp4")
        );
    }

    #[test]
    fn convert_to_ass_uses_middle_center_subtitle_style() {
        let ass = convert_to_ass(
            "1\n00:00:00,000 --> 00:00:02,000\nทดสอบซับกลางจอ\n\n",
            1080,
            1920,
        );
        let style_line = ass
            .lines()
            .find(|line| line.starts_with("Style: Default,"))
            .expect("default style line");
        let style_fields = style_line
            .strip_prefix("Style: ")
            .expect("style prefix")
            .split(',')
            .collect::<Vec<_>>();

        assert_eq!(style_fields.len(), 23, "ASS style field count changed");
        assert_eq!(
            style_fields[18], "5",
            "subtitle style must be middle-center"
        );
        assert_eq!(
            style_fields[21], "0",
            "centered subtitles must not use bottom margin"
        );
        assert_ne!(
            style_fields[18], "2",
            "bottom-center alignment must not regress"
        );
        assert_ne!(
            style_fields[21], "250",
            "bottom MarginV=250 must not regress"
        );
        assert!(ass.contains("{\\an5\\pos(540,960)}ทดสอบซับกลางจอ"));
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
        assert!(filter.contains("min(360"));
        assert!(filter.contains("fps=15"));
        assert!(filter.contains("setsar=1"));
        assert!(filter.contains("setpts=N/(15*TB)"));
        assert!(filter.contains("format=yuv420p"));
    }

    #[test]
    fn gemini_strict_ffmpeg_args_bound_inline_size() {
        let args = build_gemini_transcode_ffmpeg_args(
            "/tmp/input.mp4",
            "/tmp/output.mp4",
            GeminiTranscodeProfile::Strict,
            GEMINI_PREFLIGHT_MAX_DURATION_SECS,
        );
        let value_after = |flag: &str| {
            args.iter()
                .position(|arg| arg == flag)
                .and_then(|index| args.get(index + 1))
                .map(String::as_str)
        };
        let parse_kbps = |flag: &str| {
            value_after(flag)
                .and_then(|value| value.strip_suffix('k'))
                .and_then(|value| value.parse::<usize>().ok())
                .expect("kbps ffmpeg argument")
        };

        let video_kbps = parse_kbps("-b:v");
        let maxrate_kbps = parse_kbps("-maxrate");
        let bufsize_kbps = parse_kbps("-bufsize");
        let estimated_video_bytes = ((video_kbps as f64 * 1000.0 / 8.0)
            * GEMINI_PREFLIGHT_MAX_DURATION_SECS)
            .ceil() as usize;

        assert_eq!(maxrate_kbps, video_kbps);
        assert_eq!(bufsize_kbps, video_kbps * 2);
        assert!(
            estimated_video_bytes + GEMINI_STRICT_INLINE_CONTAINER_HEADROOM_BYTES
                <= VERTEX_GENERATION_INLINE_MAX_BYTES,
            "strict budget must keep max-duration inline video under Vertex raw byte limit"
        );
        assert!(args.iter().any(|arg| arg == "-an"));
        assert_eq!(value_after("-crf"), None);
        assert_eq!(value_after("-b:a"), None);
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

    #[test]
    fn avatar_compose_ffmpeg_args_bound_output_size() {
        let args = build_avatar_compose_ffmpeg_args(
            "/tmp/base.mp4",
            "/tmp/avatar.mp4",
            "[base][avatar]overlay[outv]",
            "174.590",
            "/tmp/output.mp4",
        );
        let value_after = |flag: &str| {
            args.iter()
                .position(|arg| arg == flag)
                .and_then(|index| args.get(index + 1))
                .map(String::as_str)
        };

        assert_eq!(value_after("-preset"), Some(AVATAR_COMPOSE_VIDEO_PRESET));
        assert_eq!(value_after("-b:v"), Some(AVATAR_COMPOSE_VIDEO_BITRATE));
        assert_eq!(value_after("-maxrate"), Some(AVATAR_COMPOSE_VIDEO_MAXRATE));
        assert_eq!(value_after("-bufsize"), Some(AVATAR_COMPOSE_VIDEO_BUFSIZE));
        assert_eq!(value_after("-b:a"), Some(AVATAR_COMPOSE_AUDIO_BITRATE));
        assert_eq!(value_after("-movflags"), Some("+faststart"));
        assert!(!args.iter().any(|arg| arg == "ultrafast"));
        assert!(!args.iter().any(|arg| arg == "-crf"));

        let avatar_input_index = args
            .iter()
            .position(|arg| arg == "/tmp/avatar.mp4")
            .expect("avatar input present");
        assert_eq!(
            args.get(avatar_input_index.saturating_sub(3))
                .map(String::as_str),
            Some("-stream_loop"),
            "avatar input must be looped before the -i avatar argument"
        );
        assert_eq!(
            args.get(avatar_input_index.saturating_sub(2))
                .map(String::as_str),
            Some("-1"),
            "avatar input must loop until bounded by base duration"
        );
    }

    #[test]
    fn avatar_compose_filter_does_not_freeze_last_avatar_frame() {
        let filter = build_avatar_compose_filter_complex(0.30, 0.10);
        assert!(filter.contains("eof_action=pass"));
        assert!(filter.contains("repeatlast=0"));
        assert!(!filter.contains("eof_action=repeat"));
        assert!(!filter.contains("repeatlast=1"));
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
         &H00FFFFFF,&H00000000,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,10,0,5,10,10,0,1\n\n\
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
            "Dialogue: 0,{},{},Default,,0,0,0,,{{\\an5\\pos({},{})}}{}\n",
            ts,
            te,
            vw / 2,
            vh / 2,
            text
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

fn ffmpeg_nonzero_status_reason(output: &Output) -> Option<String> {
    if output.status.success() {
        None
    } else {
        Some(format!("exit_status={}", output.status))
    }
}

fn build_final_merge_ffmpeg_args(
    video_input_str: &str,
    adjusted_audio_str: &str,
    duration: f64,
    output_str: &str,
) -> Vec<String> {
    let duration_str = duration.to_string();
    let mut args = Vec::new();
    push_ffmpeg_args(&mut args, &["-y", "-i", video_input_str]);
    push_ffmpeg_args(&mut args, &["-i", adjusted_audio_str]);
    push_ffmpeg_args(&mut args, &["-c:v", "copy", "-c:a", "aac"]);
    push_ffmpeg_args(&mut args, &["-map", "0:v:0", "-map", "1:a:0"]);
    push_ffmpeg_args(&mut args, &["-t", &duration_str]);
    args.push(output_str.to_string());
    args
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
    let mock_mode = req
        .model
        .as_deref()
        .map(|model| model.trim() == "mock")
        .unwrap_or(false);

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
    let processing_video_path = tmp_path.join("video_processing_flipped.mp4");
    update_step(
        worker_url,
        token,
        &bot_id,
        &video_id,
        1.2,
        "🛠️ เตรียมไฟล์วิดีโอ",
    )
    .await;
    edit_status(token, req.chat_id, req.msg_id, "🛠️ กำลังเตรียมไฟล์วิดีโอ").await;
    create_flipped_processing_input(&video_path, &processing_video_path).await?;
    let processing_video_bytes = fs::read(&processing_video_path).await?;
    let source_preflight = preflight_probe_for_gemini(&processing_video_path)
        .await
        .map_err(|e| format!("processing_video_invalid: {}", e))?;
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
        .clone()
        .unwrap_or_else(|| "gemini-3-flash-preview".to_string());
    let vertex_generation = if mock_mode {
        None
    } else {
        Some(build_vertex_generation_context(&client, &req, &model).await?)
    };

    let (script, subtitle_lines, title, category, a_dur, wav_audio) = if mock_mode {
        let wav = tmp_path.join("audio.wav");
        Command::new("ffmpeg")
            .args(&[
                "-y",
                "-i",
                processing_video_path.to_str().unwrap(),
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
        let vertex_context = vertex_generation
            .as_ref()
            .ok_or("Vertex service account is required for Vertex Gemini processing")?;

        // 2. Analyze
        update_step(
            worker_url,
            token,
            &bot_id,
            &video_id,
            2.0,
            "🔍 เตรียมวิดีโอสำหรับ Vertex Gemini...",
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
        let mut last_vertex_err = String::new();
        let mut gemini_strict_video_bytes: Option<Vec<u8>> = None;
        let gemini_safe_video_path = tmp_path.join("gemini_safe.mp4");
        let gemini_strict_video_path = tmp_path.join("gemini_strict.mp4");

        update_step(
            worker_url,
            token,
            &bot_id,
            &video_id,
            2.2,
            "🔍 แปลงวิดีโอให้ Vertex Gemini อ่านได้...",
        )
        .await;
        let gemini_safe_video_bytes =
            transcode_video_for_gemini(&processing_video_path, &gemini_safe_video_path).await?;
        if gemini_safe_video_bytes == processing_video_bytes {
            return Err(
                "Vertex Gemini transcode output invalid: output is identical to source".into(),
            );
        }
        println!(
            "[PIPELINE] Vertex Gemini inline artifact produced {} bytes",
            gemini_safe_video_bytes.len()
        );

        println!("[PIPELINE] Vertex Gemini analyze start");
        for variant in [GeminiUploadVariant::Safe, GeminiUploadVariant::Strict] {
            if variant == GeminiUploadVariant::Strict && gemini_strict_video_bytes.is_none() {
                update_step(
                    worker_url,
                    token,
                    &bot_id,
                    &video_id,
                    2.2,
                    "🔍 แปลงวิดีโอให้ Vertex Gemini อ่านได้แบบเข้มงวด...",
                )
                .await;
                match transcode_video_for_gemini_strict(
                    &processing_video_path,
                    &gemini_strict_video_path,
                )
                .await
                {
                    Ok(bytes) => {
                        println!(
                            "[PIPELINE] Vertex Gemini strict transcode produced {} bytes",
                            bytes.len()
                        );
                        gemini_strict_video_bytes = Some(bytes);
                    }
                    Err(transcode_err) => {
                        last_vertex_err = format!(
                            "{}; Vertex Gemini strict transcode failed: {}",
                            last_vertex_err, transcode_err
                        );
                        println!(
                            "[PIPELINE] Vertex Gemini strict transcode failed: {}",
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
                update_step(
                    worker_url,
                    token,
                    &bot_id,
                    &video_id,
                    2.7,
                    "🔍 สร้างบทพากย์ผ่าน Vertex Gemini...",
                )
                .await;
                let pack = vertex_gemini_script_inline_video(
                    upload_bytes,
                    vertex_context,
                    duration,
                    req.script_prompt.as_deref(),
                    variant_label,
                )
                .await?;

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

                let tts_b64 = vertex_gemini_tts(
                    &pack.script,
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
                    analyze_result = Some(result);
                    break;
                }
                Err(err) => {
                    last_vertex_err = err.to_string();
                    if should_retry_vertex_with_strict(variant, &last_vertex_err) {
                        println!(
                            "[PIPELINE] Vertex Gemini {} analysis failed; retrying with strict transcode: {}",
                            variant_label, last_vertex_err
                        );
                        continue;
                    }
                    println!(
                        "[PIPELINE] Vertex Gemini analyze failed with {} variant: {}",
                        variant_label, last_vertex_err
                    );
                    break;
                }
            }
        }

        match analyze_result {
            Some(result) => result,
            None => {
                return Err(if last_vertex_err.is_empty() {
                    "Vertex Gemini pipeline failed".into()
                } else {
                    last_vertex_err.into()
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

    // 5. Vertex Gemini SRT from generated dub audio (no whisper)
    update_step(
        worker_url,
        token,
        &bot_id,
        &video_id,
        4.3,
        "📝 กำลังสร้างซับจากเสียงพากย์ (Vertex Gemini SRT)...",
    )
    .await;
    edit_status(token, req.chat_id, req.msg_id, "🎬 ตัดต่อ: กำลังฝังซับไตเติ้ล").await;

    let mut raw_srt = String::new();
    if !mock_mode {
        let t_sync = std::time::Instant::now();
        let adjusted_bytes = fs::read(&adjusted).await?;
        let vertex_context = vertex_generation
            .as_ref()
            .ok_or("Vertex service account is required for Vertex Gemini audio sync")?;
        match tokio::time::timeout(
            Duration::from_secs(VERTEX_GEMINI_AUDIO_SRT_TIMEOUT_SECS),
            vertex_gemini_srt_from_audio_bytes(
                &adjusted_bytes,
                &subtitle_lines,
                vertex_context,
                adjusted_audio_dur,
            ),
        )
        .await
        {
            Ok(Ok(srt)) => {
                raw_srt = srt;
            }
            Ok(Err(err)) => {
                println!(
                    "[PIPELINE] Vertex Gemini audio sync failed; deterministic subtitle fallback will be used: {}",
                    err
                );
            }
            Err(_) => {
                println!(
                    "[PIPELINE] Vertex Gemini audio sync timed out after {}s; deterministic subtitle fallback will be used",
                    VERTEX_GEMINI_AUDIO_SRT_TIMEOUT_SECS
                );
            }
        }
        println!(
            "[PIPELINE] Vertex Gemini audio sync -> {} chars, {} blocks ({:.1}s)",
            raw_srt.len(),
            raw_srt
                .split("\n\n")
                .filter(|s| !s.trim().is_empty())
                .count(),
            t_sync.elapsed().as_secs_f64()
        );
    } else {
        println!("[PIPELINE] mock mode: skip Vertex Gemini audio sync");
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
        println!("[PIPELINE] Vertex Gemini SRT quality check failed -> deterministic fallback");
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
            processing_video_path.to_str().unwrap(),
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
            .args(build_final_merge_ffmpeg_args(
                processing_video_path.to_str().unwrap(),
                adjusted.to_str().unwrap(),
                duration,
                nosub_path.to_str().unwrap(),
            ))
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
    let mut burn_cmd = Command::new("ffmpeg");
    burn_cmd.kill_on_drop(true);
    burn_cmd.args(&[
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
    ]);
    let ffmpeg_burn = tokio::time::timeout(
        Duration::from_secs(SUBTITLE_BURN_TIMEOUT_SECS),
        burn_cmd.output(),
    )
    .await;
    let burn_fallback_reason = match ffmpeg_burn {
        Err(_) => Some(format!("timeout>{}s", SUBTITLE_BURN_TIMEOUT_SECS)),
        Ok(Err(e)) => Some(format!("process_error={}", e)),
        Ok(Ok(output)) => ffmpeg_nonzero_status_reason(&output),
    };
    if let Some(reason) = burn_fallback_reason {
        println!(
            "[PIPELINE] subtitle burn failed-open: {}; using no-subtitle mp4",
            reason
        );
        let _ = fs::remove_file(&output_mp4).await;
        fs::copy(&nosub_path, &output_mp4).await?;
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
    // Shrink oversize outputs (subtitles already pixel-burned) so the Worker PUT
    // body stays under Cloudflare's 413 request-body ceiling.
    ensure_final_mp4_within_upload_limit(&output_mp4, &tmp_path, duration).await?;
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

const AVATAR_COMPOSE_OUTPUT_MIN_BYTES: usize = 1024;
const AVATAR_COMPOSE_JOB_TTL_SECS: u64 = 600;
const AVATAR_COMPOSE_VIDEO_PRESET: &str = "veryfast";
const AVATAR_COMPOSE_VIDEO_BITRATE: &str = "2500k";
const AVATAR_COMPOSE_VIDEO_MAXRATE: &str = "3000k";
const AVATAR_COMPOSE_VIDEO_BUFSIZE: &str = "6000k";
const AVATAR_COMPOSE_AUDIO_BITRATE: &str = "128k";

#[derive(Clone)]
struct AvatarComposeInput {
    video_url: String,
    avatar_video_url: String,
    chromakey_similarity: f64,
    chromakey_blend: f64,
}

#[derive(Clone)]
enum AvatarComposeJobState {
    Processing,
    Done(Vec<u8>),
    Failed(String),
}

#[derive(Clone)]
struct AvatarComposeJob {
    state: AvatarComposeJobState,
    updated_at: Instant,
}

type AvatarComposeJobs = Arc<Mutex<HashMap<String, AvatarComposeJob>>>;

static AVATAR_COMPOSE_JOBS: OnceLock<AvatarComposeJobs> = OnceLock::new();

fn avatar_compose_jobs() -> &'static AvatarComposeJobs {
    AVATAR_COMPOSE_JOBS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn default_avatar_chromakey_similarity() -> f64 {
    0.14
}

fn default_avatar_chromakey_blend() -> f64 {
    0.02
}

fn clamp_avatar_chromakey(value: f64, default_value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        default_value
    }
}

fn validate_avatar_compose_url(raw: &str, label: &str) -> Result<String, String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err(format!("{}_missing", label));
    }
    let parsed = url::Url::parse(url).map_err(|_| format!("{}_invalid", label))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(format!("{}_invalid", label));
    }
    Ok(url.to_string())
}

fn parse_avatar_compose_request(
    payload: AvatarComposeRequest,
) -> Result<AvatarComposeInput, String> {
    Ok(AvatarComposeInput {
        video_url: validate_avatar_compose_url(&payload.video_url, "video_url")?,
        avatar_video_url: validate_avatar_compose_url(
            &payload.avatar_video_url,
            "avatar_video_url",
        )?,
        chromakey_similarity: clamp_avatar_chromakey(
            payload.chromakey_similarity,
            default_avatar_chromakey_similarity(),
        ),
        chromakey_blend: clamp_avatar_chromakey(
            payload.chromakey_blend,
            default_avatar_chromakey_blend(),
        ),
    })
}

fn avatar_compose_error_response(
    status: StatusCode,
    message: impl Into<String>,
) -> (StatusCode, Json<Value>) {
    let message = message.into();
    (
        status,
        Json(json!({
            "error": "avatar_compose_failed",
            "details": message,
        })),
    )
}

fn avatar_compose_status_for_error(message: &str) -> StatusCode {
    if message.contains("_missing") || message.contains("_invalid") {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

fn avatar_compose_video_response(output: Vec<u8>) -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "video/mp4")],
        output,
    )
        .into_response()
}

fn prune_avatar_compose_jobs(jobs: &mut HashMap<String, AvatarComposeJob>) {
    jobs.retain(|_, job| job.updated_at.elapsed().as_secs() <= AVATAR_COMPOSE_JOB_TTL_SECS);
}

async fn download_avatar_compose_video(
    client: &Client,
    url: &str,
    label: &str,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    let response = tokio::time::timeout(Duration::from_secs(120), client.get(url).send())
        .await
        .map_err(|_| format!("{}_download_timeout", label))?
        .map_err(|_| format!("{}_download_failed", label))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("{}_download_http_{}", label, status.as_u16()).into());
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
        .map_err(|_| format!("{}_download_read_failed", label))?;
    validate_downloaded_video(bytes.as_ref(), &content_type)
        .map_err(|e| format!("{}_invalid: {}", label, e))?;
    Ok(bytes.to_vec())
}

fn build_avatar_compose_filter_complex(chromakey_similarity: f64, chromakey_blend: f64) -> String {
    format!(
        "[0:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30,format=rgba[base];\
         [1:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:0x00c800,setsar=1,fps=30,format=rgba,colorkey=0x00c800:{:.4}:{:.4},format=rgba[avatar];\
         [base][avatar]overlay=0:0:format=auto:eof_action=pass:repeatlast=0,format=yuv420p[outv]",
        chromakey_similarity, chromakey_blend,
    )
}

fn build_avatar_compose_ffmpeg_args(
    base_path: &str,
    avatar_path: &str,
    filter_complex: &str,
    duration: &str,
    output_path: &str,
) -> Vec<String> {
    vec![
        "-y".to_string(),
        "-i".to_string(),
        base_path.to_string(),
        "-stream_loop".to_string(),
        "-1".to_string(),
        "-i".to_string(),
        avatar_path.to_string(),
        "-filter_complex".to_string(),
        filter_complex.to_string(),
        "-map".to_string(),
        "[outv]".to_string(),
        "-map".to_string(),
        "0:a:0?".to_string(),
        "-t".to_string(),
        duration.to_string(),
        "-c:v".to_string(),
        "libx264".to_string(),
        "-preset".to_string(),
        AVATAR_COMPOSE_VIDEO_PRESET.to_string(),
        "-b:v".to_string(),
        AVATAR_COMPOSE_VIDEO_BITRATE.to_string(),
        "-maxrate".to_string(),
        AVATAR_COMPOSE_VIDEO_MAXRATE.to_string(),
        "-bufsize".to_string(),
        AVATAR_COMPOSE_VIDEO_BUFSIZE.to_string(),
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        AVATAR_COMPOSE_AUDIO_BITRATE.to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        output_path.to_string(),
    ]
}

async fn compose_avatar_video(
    input: AvatarComposeInput,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    let client = Client::builder()
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(15))
        .build()?;
    let base_bytes = download_avatar_compose_video(&client, &input.video_url, "base_video").await?;
    let avatar_bytes =
        download_avatar_compose_video(&client, &input.avatar_video_url, "avatar_video").await?;

    let tmp_dir = tempdir()?;
    let base_path = tmp_dir.path().join("base.mp4");
    let avatar_path = tmp_dir.path().join("avatar.mp4");
    let output_path = tmp_dir.path().join("avatar_composed.mp4");
    fs::write(&base_path, base_bytes).await?;
    fs::write(&avatar_path, avatar_bytes).await?;

    let base_duration = get_duration(&base_path).await.max(0.1);
    let base_path_str = base_path.to_str().ok_or("base_video_path_invalid")?;
    let avatar_path_str = avatar_path.to_str().ok_or("avatar_video_path_invalid")?;
    let output_path_str = output_path.to_str().ok_or("output_path_invalid")?;
    // Use an RGBA colorkey pipeline for the full-canvas green-screen avatar.
    // The previous yuv420p+chromakey pipeline produced a broken alpha mask on
    // compressed green-screen MP4s, darkening the whole base video during FB posting.
    let effective_similarity = input.chromakey_similarity.max(0.30);
    let effective_blend = input.chromakey_blend.max(0.10);
    let filter_complex = build_avatar_compose_filter_complex(effective_similarity, effective_blend);

    let duration = format!("{:.3}", base_duration);
    let ffmpeg_args = build_avatar_compose_ffmpeg_args(
        base_path_str,
        avatar_path_str,
        &filter_complex,
        &duration,
        output_path_str,
    );
    let output = tokio::time::timeout(
        Duration::from_secs(300),
        Command::new("ffmpeg").args(&ffmpeg_args).output(),
    )
    .await;

    let output = match output {
        Err(_) => return Err("avatar_compose_ffmpeg_timeout".into()),
        Ok(Err(err)) => return Err(Box::new(err)),
        Ok(Ok(output)) => output,
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "avatar_compose_ffmpeg_failed: {}",
            stderr.chars().take(1200).collect::<String>()
        )
        .into());
    }

    let bytes = fs::read(&output_path).await?;
    if bytes.len() < AVATAR_COMPOSE_OUTPUT_MIN_BYTES {
        return Err(format!("avatar_compose_output_too_small_{}", bytes.len()).into());
    }
    Ok(bytes)
}

pub async fn handle_avatar_compose(
    Json(payload): Json<AvatarComposeRequest>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let input = parse_avatar_compose_request(payload)
        .map_err(|e| avatar_compose_error_response(StatusCode::BAD_REQUEST, e))?;
    compose_avatar_video(input)
        .await
        .map(avatar_compose_video_response)
        .map_err(|e| {
            let message = e.to_string();
            avatar_compose_error_response(avatar_compose_status_for_error(&message), message)
        })
}

pub async fn handle_avatar_compose_start(
    Json(payload): Json<AvatarComposeRequest>,
) -> Result<Json<AvatarComposeStartResponse>, (StatusCode, Json<Value>)> {
    let input = parse_avatar_compose_request(payload)
        .map_err(|e| avatar_compose_error_response(StatusCode::BAD_REQUEST, e))?;
    let job_id = Uuid::new_v4().to_string();
    {
        let mut jobs = avatar_compose_jobs().lock().await;
        prune_avatar_compose_jobs(&mut jobs);
        jobs.insert(
            job_id.clone(),
            AvatarComposeJob {
                state: AvatarComposeJobState::Processing,
                updated_at: Instant::now(),
            },
        );
    }

    let job_id_for_task = job_id.clone();
    tokio::spawn(async move {
        let result = compose_avatar_video(input).await;
        let state = match result {
            Ok(output) => AvatarComposeJobState::Done(output),
            Err(err) => AvatarComposeJobState::Failed(err.to_string()),
        };
        let mut jobs = avatar_compose_jobs().lock().await;
        prune_avatar_compose_jobs(&mut jobs);
        jobs.insert(
            job_id_for_task,
            AvatarComposeJob {
                state,
                updated_at: Instant::now(),
            },
        );
    });

    Ok(Json(AvatarComposeStartResponse {
        status: "started".to_string(),
        job_id,
    }))
}

pub async fn handle_avatar_compose_result(
    axum::extract::Path(job_id): axum::extract::Path<String>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    if Uuid::parse_str(&job_id).is_err() {
        return Err(avatar_compose_error_response(
            StatusCode::BAD_REQUEST,
            "job_id_invalid",
        ));
    }

    let mut jobs = avatar_compose_jobs().lock().await;
    prune_avatar_compose_jobs(&mut jobs);
    let Some(job) = jobs.remove(&job_id) else {
        return Err(avatar_compose_error_response(
            StatusCode::NOT_FOUND,
            "job_not_found",
        ));
    };

    match job.state {
        AvatarComposeJobState::Processing => {
            jobs.insert(job_id, job);
            Ok((
                StatusCode::ACCEPTED,
                Json(json!({
                    "status": "processing",
                })),
            )
                .into_response())
        }
        AvatarComposeJobState::Done(output) => Ok(avatar_compose_video_response(output)),
        AvatarComposeJobState::Failed(message) => Err(avatar_compose_error_response(
            avatar_compose_status_for_error(&message),
            message,
        )),
    }
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
