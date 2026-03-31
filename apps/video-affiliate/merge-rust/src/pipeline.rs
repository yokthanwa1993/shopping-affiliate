use axum::{Json, http::StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::fs;
use tokio::process::Command;
use tokio::time::{sleep, Duration};
use reqwest::Client;
use std::path::Path;
use tempfile::tempdir;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use uuid::Uuid;
use crate::version::PIPELINE_ENGINE_VERSION;

const FAST_MODE_DEFAULT_SKIP_GEMINI_AUDIO_SYNC: bool = true;
const GEMINI_WAIT_MAX_POLLS: usize = 20;
const GEMINI_WAIT_POLL_SECONDS: u64 = 2;

#[derive(Deserialize, Clone)]
pub struct PipelineRequest {
    pub token: String,
    pub video_url: String,
    pub chat_id: u64,
    pub msg_id: Option<u64>,
    pub api_key: String,
    pub model: Option<String>,
    pub r2_public_url: String,
    pub worker_url: String,
    pub bot_id: Option<String>,
    pub video_id: Option<String>,
    pub shopee_link: Option<String>,
    pub script_prompt: Option<String>,
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

async fn send_telegram(token: &str, method: &str, payload: &Value) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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
        let _ = send_telegram(token, "editMessageText", &json!({
            "chat_id": chat_id,
            "message_id": m_id,
            "text": text,
            "parse_mode": "HTML",
        })).await;
    }
}

async fn r2_put(worker_url: &str, token: &str, bot_id: &str, key: &str, data: Vec<u8>, content_type: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let url = format!("{}/api/r2-upload/{}", worker_url, key);
    let client = Client::new();
    let res = client.put(&url)
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

fn validate_downloaded_video(bytes: &[u8], content_type: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if bytes.is_empty() {
        return Err("ดาวน์โหลดวิดีโอได้ไฟล์ว่าง".into());
    }

    if looks_like_html_document(bytes) {
        return Err("ดาวน์โหลดได้เป็นหน้า HTML ไม่ใช่ไฟล์วิดีโอจริง".into());
    }

    let normalized = content_type.trim().to_ascii_lowercase();
    if !normalized.is_empty()
        && !content_type_is_video_like(&normalized)
        && (
            normalized.starts_with("text/")
            || normalized.contains("html")
            || normalized.contains("json")
            || normalized.contains("xml")
        )
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

async fn update_step(worker_url: &str, token: &str, bot_id: &str, video_id: &str, step: f64, step_name: &str) {
    let url = format!("{}/api/r2-proxy/_processing/{}.json", worker_url, video_id);
    let client = Client::new();
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    
    let mut data = match client.get(&url).header("x-auth-token", token).header("x-bot-id", bot_id).send().await {
        Ok(res) if res.status().is_success() => res.json::<Value>().await.unwrap_or(json!({})),
        _ => json!({ "id": video_id, "status": "processing", "createdAt": now }),
    };

    if let Some(obj) = data.as_object_mut() {
        obj.insert("step".to_string(), json!(step));
        obj.insert("stepName".to_string(), json!(step_name));
        obj.insert("updatedAt".to_string(), json!(now));
    }
    
    let _ = r2_put(worker_url, token, &bot_id, &format!("_processing/{}.json", video_id), serde_json::to_vec(&data).unwrap(), "application/json").await;
}

// ==================== Gemini API ====================

async fn gemini_upload_bytes(
    file_bytes: &[u8],
    mime_type: &str,
    api_key: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let url = format!("https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=media&key={}", api_key);
    let client = Client::new();
    let res = client.post(&url)
        .header("Content-Type", mime_type)
        .header("X-Goog-Upload-Protocol", "raw")
        .body(file_bytes.to_vec())
        .send()
        .await?;
    
    let json: Value = res.json().await?;
    if let Some(uri) = json.get("file").and_then(|f| f.get("uri")).and_then(|u| u.as_str()) {
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
        && (
            err.contains("FAILED_PRECONDITION")
            || err.contains("not in an ACTIVE state")
            || err.contains("usage is not allowed")
        )
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

    if best.is_empty() {
        normalized
    } else {
        best
    }
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
         3) เริ่มซับที่ 00:00:00,000\n\
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
            println!("[PIPELINE] gemini_srt attempt {} failed ({}): {}", attempt, status, err);
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

async fn gemini_wait(file_uri: &str, api_key: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let file_name = file_uri.split("/files/").last().unwrap_or("");
    let url = format!("https://generativelanguage.googleapis.com/v1beta/files/{}?key={}", file_name, api_key);
    let client = Client::new();
    let mut last_state = String::new();
    
    for attempt in 0..36 { // max 3 mins (36 * 5s)
        if let Ok(res) = client.get(&url).send().await {
            if let Ok(json) = res.json::<Value>().await {
                if let Some(state) = extract_gemini_file_state(&json) {
                    last_state = state.clone();
                    if state == "ACTIVE" {
                        return Ok(file_uri.to_string());
                    }
                    if state == "FAILED" {
                        return Err(format!("Gemini file processing failed: {}", json).into());
                    }
                    println!("[PIPELINE] gemini_wait attempt {} state={}", attempt, state);
                }
            }
        }
        sleep(Duration::from_secs(5)).await;
    }
    Err(format!("Gemini file did not become ACTIVE in time (last_state={})", if last_state.is_empty() { "unknown" } else { &last_state }).into())
}

fn render_script_prompt_template(template: &str, duration: f64, min_chars: i32, max_chars: i32) -> String {
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

fn build_script_prompt(user_prompt: Option<&str>, duration: f64, min_chars: i32, max_chars: i32) -> String {
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
    let max_chars = ((duration * 10.0) as i32).min(800);
    let min_chars = ((duration * 7.0) as i32).max(80);

    let prompt = build_script_prompt(user_prompt, duration, min_chars, max_chars);

    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}", model, api_key);
    let client = Client::new();
    let payload = json!({
        "contents": [{
            "parts": [
                {"file_data": {"mime_type": "video/mp4", "file_uri": file_uri}},
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
            println!("[PIPELINE] gemini_script retry #{}", attempt);
        }
        let res = client.post(&url).json(&payload).send().await?;
        if res.status().is_success() {
            let json: Value = res.json().await?;
            if let Some(text) = json.get("candidates").and_then(|c| c.get(0)).and_then(|c| c.get("content")).and_then(|c| c.get("parts")).and_then(|p| p.get(0)).and_then(|p| p.get("text")) {
                resp_text = text.as_str().unwrap_or("").to_string();
            }
            break;
        } else {
            let status = res.status().as_u16();
            let err = res.text().await?;
            last_err = format!("Gemini Script Error: {}", err);
            println!("[PIPELINE] gemini_script attempt {} failed ({}): {}", attempt, status, err);
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

    let clean = resp_text.replace("```json", "").replace("```", "").trim().to_string();
    let parsed: Value = serde_json::from_str(&clean).unwrap_or(json!({}));
    let script = parsed.get("thai_script").and_then(|v| v.as_str()).unwrap_or(&clean).to_string();
    let title = parsed.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let category = parsed.get("category").and_then(|v| v.as_str()).unwrap_or("อื่นๆ").to_string();
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

async fn gemini_tts(script: &str, api_key: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key={}", api_key);
    let client = Client::new();
    let payload = json!({
        "contents": [{"parts": [{"text": script}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": "Puck"}}}
        }
    });

    for _ in 0..3 {
        let res = client.post(&url).json(&payload).send().await?;
        if res.status().is_success() {
            let json: Value = res.json().await?;
            if let Some(data) = json.get("candidates").and_then(|c| c.get(0)).and_then(|c| c.get("content")).and_then(|c| c.get("parts")).and_then(|p| p.get(0)).and_then(|p| p.get("inlineData")).and_then(|i| i.get("data")).and_then(|d| d.as_str()) {
                return Ok(data.to_string());
            }
        }
        sleep(Duration::from_secs(5)).await;
    }
    Err("TTS failed after retries".into())
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
        out.push_str(&format!("{}\n{} --> {}\n{}\n\n", idx + 1, fmt(start), fmt(end), chunk));
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
    if t.chars().all(|c| c.is_whitespace() || c == '♪' || c == '♫' || c == '-') {
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
    let (timing_start, timing_end) = extract_speech_srt_time_span(timing_srt)
        .unwrap_or((0.0, fallback_duration));
    let timing_span = (timing_end - timing_start).max(0.0);
    // Normalize to 0-based timeline so subtitles do not shift right when Whisper misses early words.
    let total_duration = if timing_span >= 0.2 {
        timing_span.min(fallback_duration)
    } else {
        fallback_duration
    };
    let start = 0.0f64;
    let end = total_duration.max(0.1);
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

#[cfg(test)]
mod tests {
    use super::{
        build_srt_from_lines_with_timing, extract_speech_srt_time_span, extract_srt_payload,
        normalize_srt_blocks, parse_srt_time_range,
    };

    fn extract_time_lines(srt: &str) -> Vec<(f64, f64)> {
        srt.lines()
            .filter_map(|l| parse_srt_time_range(l))
            .collect::<Vec<_>>()
    }

    #[test]
    fn deterministic_srt_is_zero_based_even_if_whisper_starts_late() {
        let timing_srt = "1\n00:00:01,200 --> 00:00:04,200\nทดสอบ\n\n";
        let lines = vec!["บรรทัดหนึ่ง".to_string(), "บรรทัดสอง".to_string()];
        let out = build_srt_from_lines_with_timing(&lines, timing_srt, 3.0, 15);
        let times = extract_time_lines(&out);
        assert!(!times.is_empty());
        let (first_start, _) = times[0];
        let (_, last_end) = times[times.len() - 1];
        assert!(first_start <= 0.001, "first subtitle should start at 0");
        assert!((last_end - 3.0).abs() < 0.1, "end should match speech span");
    }

    #[test]
    fn deterministic_srt_uses_fallback_when_whisper_span_is_inflated() {
        let timing_srt = "1\n00:00:00,000 --> 00:00:25,000\nทดสอบ\n\n";
        let lines = vec!["หนึ่ง".to_string(), "สอง".to_string(), "สาม".to_string()];
        let out = build_srt_from_lines_with_timing(&lines, timing_srt, 10.0, 15);
        let times = extract_time_lines(&out);
        assert!(!times.is_empty());
        let (_, last_end) = times[times.len() - 1];
        assert!(last_end <= 10.2, "inflated timing should clamp to fallback duration");
    }

    #[test]
    fn speech_span_ignores_music_cue_tail() {
        let timing_srt = "\
1\n00:00:00,000 --> 00:00:02,000\nสวัสดี\n\n\
2\n00:00:02,000 --> 00:00:05,000\n[เสียงดนตรี]\n\n";
        let span = extract_speech_srt_time_span(timing_srt).expect("speech span expected");
        assert!((span.0 - 0.0).abs() < 0.001);
        assert!((span.1 - 2.0).abs() < 0.001, "music cue tail must not stretch speech span");
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
        assert!(times[1].0 >= times[0].1, "second block must not overlap first");
        assert!(times[1].1 <= 2.0);
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
                item.get("timestamps").and_then(|t| t.get("from")).and_then(|f| f.as_str()),
                item.get("timestamps").and_then(|t| t.get("to")).and_then(|t| t.as_str()),
            ) {
                let start = parse_whisper_time(from);
                let end = parse_whisper_time(to);
                let text_clean = text.trim();
                if text_clean.is_empty() { continue; }
                
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
                    
                    srt_blocks.push((block_num, chunk_start, chunk_end_time, chunk.trim().to_string()));
                    block_num += 1;
                    i = if break_idx == i { chunk_end } else { break_idx + 1 };
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
                        if word_clean.is_empty() { continue; }
                        
                        if !current_text.is_empty() && current_text.len() + word_clean.len() > max_chars {
                            if let Some(start_time) = current_start {
                                srt_blocks.push((block_num, start_time, last_end, current_text.clone()));
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
            srt_content.push_str(&format!("{}\n{} --> {}\n{}\n\n", 
                num, fmt_time(start), fmt_time(end), text));
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
        vw = vw, vh = vh, fs = font_size
    );
    let mut events = String::new();
    for block in srt.trim().split("\n\n") {
        let lines: Vec<&str> = block.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
        let Some(ti) = lines.iter().position(|l| l.contains("-->")) else { continue };
        let Some(time_line) = lines.get(ti) else { continue };
        if ti + 1 >= lines.len() { continue; }
        let parts: Vec<&str> = time_line.splitn(2, "-->").collect();
        if parts.len() != 2 { continue; }
        let ts = fmt_ass_time(parts[0]);
        let te = fmt_ass_time(parts[1]);
        let text = lines[ti + 1..].join(" ");
        events.push_str(&format!("Dialogue: 0,{},{},Default,,0,0,0,,{}\n", ts, te, text));
    }
    header + &events
}

// ==================== FFmpeg & Timing Core ====================

async fn get_duration(path: &Path) -> f64 {
    if let Ok(output) = Command::new("ffprobe")
        .args(&["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1"])
        .arg(path.to_str().unwrap())
        .output().await 
    {
        String::from_utf8_lossy(&output.stdout).trim().parse().unwrap_or(10.0)
    } else {
        10.0
    }
}

async fn rust_pipeline(req: PipelineRequest) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    println!("[PIPELINE] engine_version={}", PIPELINE_ENGINE_VERSION);
    let video_id = req.video_id.clone().unwrap_or_else(|| Uuid::new_v4().simple().to_string()[..8].to_string());
    let bot_id = req.bot_id.clone().unwrap_or_else(|| "default".to_string());
    let token = &req.token;
    let worker_url = &req.worker_url;
    
    // 1. Download
    update_step(worker_url, token, &bot_id, &video_id, 1.0, "📥 ดาวน์โหลดวิดีโอ").await;
    edit_status(token, req.chat_id, req.msg_id, "📥 กำลังดาวน์โหลดวิดีโอ").await;

    let client = Client::builder()
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(15))
        .build()?;
    let video_bytes = download_video_bytes(&client, &req, &bot_id).await?;

    let _ = r2_put(worker_url, token, &bot_id, &format!("videos/{}_original.mp4", video_id), video_bytes.clone(), "video/mp4").await;
    let tmp_dir = tempdir()?;
    let tmp_path = tmp_dir.path();
    let video_path = tmp_path.join("video.mp4");
    fs::write(&video_path, &video_bytes).await?;
    let duration = get_duration(&video_path).await;

    let model = req.model.unwrap_or_else(|| "gemini-3-flash-preview".to_string());

    let (script, subtitle_lines, title, category, a_dur, wav_audio) = if req.api_key == "mock" {
        let wav = tmp_path.join("audio.wav");
        Command::new("ffmpeg").args(&["-y", "-i", video_path.to_str().unwrap(), "-f", "s16le", "-ar", "24000", "-ac", "1", wav.to_str().unwrap()]).output().await?;
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
        // 2. Analyze
        update_step(worker_url, token, &bot_id, &video_id, 2.0, "🔍 อัปโหลดวิดีโอไป Gemini...").await;
        edit_status(token, req.chat_id, req.msg_id, "📥 ดาวน์โหลดวิดีโอ ✅\n🔍 กำลังวิเคราะห์วิดีโอ").await;

        let gemini_uri = gemini_upload_bytes(&video_bytes, "video/mp4", &req.api_key).await?;
        update_step(worker_url, token, &bot_id, &video_id, 2.3, "🔍 รอ Gemini ประมวลผล...").await;
        let gemini_uri = gemini_wait(&gemini_uri, &req.api_key).await?;

        update_step(worker_url, token, &bot_id, &video_id, 2.7, "🔍 สร้างบทพากย์...").await;
        let pack = gemini_script(
            &gemini_uri,
            &req.api_key,
            &model,
            duration,
            req.script_prompt.as_deref(),
        ).await?;
        
        // 3. TTS
        update_step(worker_url, token, &bot_id, &video_id, 3.0, "🎙 กำลังสร้างเสียงพากย์ไทย...").await;
        edit_status(token, req.chat_id, req.msg_id, "📥 ดาวน์โหลดวิดีโอ ✅\n🔍 วิเคราะห์วิดีโอ ✅\n🎙 กำลังสร้างเสียงพากย์").await;
        
        let tts_b64 = gemini_tts(&pack.script, &req.api_key).await?;
        let raw_audio = tmp_path.join("audio.raw");
        fs::write(&raw_audio, BASE64.decode(&tts_b64)?).await?;
        
        let wav = tmp_path.join("audio.wav");
        Command::new("ffmpeg").args(&["-y", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", raw_audio.to_str().unwrap(), wav.to_str().unwrap()]).output().await?;
        let d = get_duration(&wav).await;
        (pack.script, pack.subtitle_lines, pack.title, pack.category, d, wav)
    };

    // 4. Merge Prep
    update_step(worker_url, token, &bot_id, &video_id, 4.0, "🎬 กำลังรวมเสียง+วิดีโอ...").await;
    edit_status(token, req.chat_id, req.msg_id, "📥 ดาวน์โหลดวิดีโอ ✅\n🔍 วิเคราะห์วิดีโอ ✅\n🎙 สร้างเสียงพากย์ ✅\n🎬 กำลังเตรียมรวมวิดีโอ").await;
    
    let adjusted = tmp_path.join("audio_adj.wav");
    let diff = duration - a_dur;
    if diff.abs() < 0.5 {
         fs::copy(&wav_audio, &adjusted).await?;
    } else if diff > 0.0 {
         Command::new("ffmpeg").args(&["-y", "-i", wav_audio.to_str().unwrap(), "-af", &format!("apad=pad_dur={}", diff), adjusted.to_str().unwrap()]).output().await?;
    } else {
         Command::new("ffmpeg").args(&["-y", "-i", wav_audio.to_str().unwrap(), "-t", &duration.to_string(), adjusted.to_str().unwrap()]).output().await?;
    }

    // 5. Gemini SRT from generated dub audio (no whisper)
    update_step(worker_url, token, &bot_id, &video_id, 4.3, "📝 กำลังสร้างซับจากเสียงพากย์ (Gemini SRT)...").await;
    edit_status(token, req.chat_id, req.msg_id, "🎬 ตัดต่อ: กำลังฝังซับไตเติ้ล").await;

    let mut raw_srt = String::new();
    if req.api_key != "mock" {
        let t_sync = std::time::Instant::now();
        let adjusted_bytes = fs::read(&adjusted).await?;
        let audio_uri = gemini_upload_bytes(&adjusted_bytes, "audio/wav", &req.api_key).await?;
        let audio_uri = gemini_wait(&audio_uri, &req.api_key).await?;
        raw_srt = gemini_srt_from_audio(&audio_uri, &subtitle_lines, &req.api_key, &model, a_dur).await?;
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

    let raw_srt_blocks = raw_srt.split("\n\n").filter(|s| !s.trim().is_empty()).count();
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
    println!(
        "[PIPELINE] speech_dur={:.2}s (a_dur={:.2}s, video_dur={:.2}s, speech_start={:.2}s, speech_end={:.2}s, speech_span={:.2}s)",
        speech_dur, a_dur, duration, speech_start, speech_end, speech_span
    );

    let t_srt = std::time::Instant::now();
    let mut final_srt_text = normalize_srt_blocks(&raw_srt, speech_dur);
    if !final_srt_text.trim().is_empty() && !srt_quality_ok(&script, &final_srt_text, 120) {
        println!("[PIPELINE] Gemini SRT quality check failed -> deterministic fallback");
        final_srt_text.clear();
    }

    if final_srt_text.trim().is_empty() {
        final_srt_text = if subtitle_lines.is_empty() {
            build_srt_from_script_with_timing(&script, "", speech_dur, 15)
        } else {
            build_srt_from_lines_with_timing(&subtitle_lines, "", speech_dur, 15)
        };
    }

    if final_srt_text.trim().is_empty() {
        println!("[PIPELINE] Final SRT empty -> simple script split fallback");
        final_srt_text = script_to_srt_simple(&script, speech_dur);
    }
    println!("[PIPELINE] Build SRT (Gemini-first) → {:.1}s", t_srt.elapsed().as_secs_f64());
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
        "audio_dur": a_dur,
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
    update_step(worker_url, token, &bot_id, &video_id, 4.8, "🎨 กำลังฝังซับไตเติ้ลลงวิดีโอ...").await;
    let output_mp4 = tmp_path.join("output.mp4");

    // Get video dimensions for ASS scaling
    let dim_out = Command::new("ffprobe")
        .args(&["-v", "error", "-show_entries", "stream=width,height",
                "-of", "csv=p=0:s=x", video_path.to_str().unwrap()])
        .output().await;
    let (vw, vh) = if let Ok(o) = dim_out {
        let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
        s.split_once('x')
            .and_then(|(w, h)| Some((w.trim().parse::<u32>().ok()?, h.trim().parse::<u32>().ok()?)))
            .unwrap_or((1080, 1920))
    } else { (1080, 1920) };

    // Convert SRT → ASS with FC Iconic Bold font
    let final_srt_text_str = fs::read_to_string(&final_srt_path).await.unwrap_or_default();
    let ass_content = convert_to_ass(&final_srt_text_str, vw, vh);
    let ass_path = tmp_path.join("subtitles.ass");
    fs::write(&ass_path, &ass_content).await?;

    // Step 1: Merge video + audio (no subtitle) — copy video stream, re-encode audio to AAC
    let nosub_path = tmp_path.join("merged_nosub.mp4");
    let merge_out = tokio::time::timeout(
        Duration::from_secs(300),
        Command::new("ffmpeg").args(&[
            "-y",
            "-i", video_path.to_str().unwrap(),
            "-i", adjusted.to_str().unwrap(),
            "-c:v", "copy", "-c:a", "aac",
            "-map", "0:v:0", "-map", "1:a:0",
            "-t", &duration.to_string(),
            nosub_path.to_str().unwrap()
        ]).output()
    ).await;
    match merge_out {
        Err(_) => return Err("FFmpeg merge timed out (>300s)".into()),
        Ok(Err(e)) => return Err(Box::new(e)),
        Ok(Ok(_)) => {}
    }

    // Step 2: Burn subtitles — re-encode video with libass, copy audio
    let vf = format!("ass={}:fontsdir=/usr/local/share/fonts", ass_path.to_str().unwrap());
    let ffmpeg_burn = tokio::time::timeout(
        Duration::from_secs(300),
        Command::new("ffmpeg").args(&[
            "-y", "-i", nosub_path.to_str().unwrap(),
            "-vf", &vf,
            "-c:v", "libx264", "-c:a", "copy", "-preset", "fast",
            output_mp4.to_str().unwrap()
        ]).output()
    ).await;
    match ffmpeg_burn {
        Err(_) => return Err("FFmpeg burn subtitles timed out (>300s)".into()),
        Ok(Err(e)) => return Err(Box::new(e)),
        Ok(Ok(_)) => {}
    }

    let thumb_path = tmp_path.join("thumb.webp");
    let ffmpeg_thumb = tokio::time::timeout(
        Duration::from_secs(60),
        Command::new("ffmpeg").args(&[
            "-y", "-i", output_mp4.to_str().unwrap(), "-vframes", "1", "-ss", "0.1",
            "-vf", "scale=270:480:force_original_aspect_ratio=increase,crop=270:480",
            "-q:v", "80", thumb_path.to_str().unwrap()
        ]).output()
    ).await;
    match ffmpeg_thumb {
        Err(_) => println!("[PIPELINE] Thumbnail FFmpeg timed out, skipping"),
        Ok(Err(e)) => println!("[PIPELINE] Thumbnail FFmpeg error: {}", e),
        Ok(Ok(_)) => {}
    }

    // 7. Upload to R2
    update_step(worker_url, token, &bot_id, &video_id, 5.0, "📤 กำลังอัพโหลดผลลัพธ์...").await;
    let final_bytes = fs::read(&output_mp4).await?;
    r2_put(worker_url, token, &bot_id, &format!("videos/{}.mp4", video_id), final_bytes, "video/mp4").await?;
    
    let thumb_bytes = fs::read(&thumb_path).await.unwrap_or_default();
    if !thumb_bytes.is_empty() {
        r2_put(worker_url, token, &bot_id, &format!("videos/{}_thumb.webp", video_id), thumb_bytes.clone(), "image/webp").await?;
    }
    
    // 8. Final Metadata
    let bot_prefix = req.bot_id.map(|id| format!("/{}", id)).unwrap_or_default();
    let public_url = format!("{}{}/videos/{}.mp4", req.r2_public_url, bot_prefix, video_id);
    let thumb_url = if !thumb_bytes.is_empty() { format!("{}{}/videos/{}_thumb.webp", req.r2_public_url, bot_prefix, video_id) } else { "".to_string() };
    
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
        "chatId": req.chat_id,
        "pipelineEngineVersion": PIPELINE_ENGINE_VERSION,
        "debugTimingKey": format!("debug/{}/timing.json", video_id),
        "debugFinalSrtKey": format!("debug/{}/final_subtitles.srt", video_id),
        "debugRawWhisperKey": format!("debug/{}/raw_whisper.srt", video_id),
        "createdAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    });
    if let Some(link) = shopee_link {
        metadata.as_object_mut().unwrap().insert("shopeeLink".to_string(), json!(link));
    }

    r2_put(worker_url, token, &bot_id, &format!("videos/{}.json", video_id), serde_json::to_vec(&metadata).unwrap(), "application/json").await?;

    // Done!
    // Removed Telegram notification here


    let _ = client.delete(&format!("{}/api/r2-proxy/_processing/{}.json", worker_url, video_id)).header("x-auth-token", token).header("x-bot-id", &bot_id).send().await;
    let _ = client.post(&format!("{}/api/gallery/refresh/{}", worker_url, video_id)).header("x-auth-token", token).header("x-bot-id", &bot_id).send().await;
    let _ = client.post(&format!("{}/api/queue/next", worker_url)).header("x-auth-token", token).header("x-bot-id", &bot_id).send().await;

    Ok(())
}

pub async fn handle_pipeline(
    Json(payload): Json<PipelineRequest>,
) -> Result<Json<PipelineResponse>, (StatusCode, Json<Value>)> {
    
    // Clone and spawn in background immediately
    let payload_clone = payload.clone();
    tokio::spawn(async move {
        println!("[RUST-PIPELINE] Starting background pipeline for {}", payload_clone.video_url);
        match rust_pipeline(payload_clone.clone()).await {
            Ok(_) => println!("[RUST-PIPELINE] Completed successfully"),
            Err(e) => {
                println!("[RUST-PIPELINE] Failed: {}", e);
                let _ = edit_status(&payload_clone.token, payload_clone.chat_id, payload_clone.msg_id, &format!("❌ ผิดพลาด\n\n{}", e)).await;
                // Mark failed
                if let Some(vid) = payload_clone.video_id {
                    let client = Client::new();
                    let url = format!("{}/api/r2-proxy/_processing/{}.json", payload_clone.worker_url, vid);
                    if let Ok(res) = client.get(&url).header("x-auth-token", &payload_clone.token).header("x-bot-id", payload_clone.bot_id.clone().unwrap_or_else(|| "default".to_string())).send().await {
                        if let Ok(mut json) = res.json::<Value>().await {
                            if let Some(obj) = json.as_object_mut() {
                                obj.insert("status".to_string(), json!("failed"));
                                obj.insert("error".to_string(), json!(e.to_string()));
                            }
                            let _ = r2_put(&payload_clone.worker_url, &payload_clone.token, &payload_clone.bot_id.clone().unwrap_or_else(|| "default".to_string()), &format!("_processing/{}.json", vid), serde_json::to_vec(&json).unwrap(), "application/json").await;
                        }
                    }
                    let _ = client.post(&format!("{}/api/queue/next", payload_clone.worker_url)).header("x-auth-token", &payload_clone.token).header("x-bot-id", payload_clone.bot_id.clone().unwrap_or_else(|| "default".to_string())).send().await;
                }
            }
        }
    });
    
    Ok(Json(PipelineResponse {
        status: "started".to_string(),
    }))
}
