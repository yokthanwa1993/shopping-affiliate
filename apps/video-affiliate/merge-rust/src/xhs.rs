use axum::{Json, http::StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::json;
use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT, ACCEPT, ACCEPT_LANGUAGE, CACHE_CONTROL};
use regex::Regex;

#[derive(Deserialize)]
pub struct ResolveRequest {
    pub url: String,
}

#[derive(Serialize)]
pub struct ResolveResponse {
    pub video_url: String,
}

pub async fn handle_resolve(
    Json(payload): Json<ResolveRequest>,
) -> Result<Json<ResolveResponse>, (StatusCode, Json<serde_json::Value>)> {
    let url = payload.url.trim().to_string();
    if url.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "url required"}))));
    }

    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"));
    headers.insert(ACCEPT, HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"));
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("zh-CN,zh;q=0.9,en;q=0.8"));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("max-age=0"));
    headers.insert("Sec-Ch-Ua", HeaderValue::from_static("\"Not_A Brand\";v=\"8\", \"Chromium\";v=\"120\""));
    headers.insert("Sec-Ch-Ua-Mobile", HeaderValue::from_static("?0"));
    headers.insert("Sec-Ch-Ua-Platform", HeaderValue::from_static("\"macOS\""));

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .default_headers(headers)
        .build()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e.to_string()}))))?;

    let resp = client.get(&url).send().await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("request failed: {}", e)}))))?;

    let html = resp.text().await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("text failed: {}", e)}))))?;

    // 1. masterUrl
    let re_master = Regex::new(r#""masterUrl"\s*:\s*"([^"]+)""#).unwrap();
    if let Some(caps) = re_master.captures(&html) {
        let v_url = caps[1].to_string().replace("\\u002F", "/");
        if v_url.contains("sns-video") {
            return Ok(Json(ResolveResponse { video_url: v_url }));
        }
    }

    // 2. originVideoKey
    let re_origin = Regex::new(r#""originVideoKey"\s*:\s*"([^"]+)""#).unwrap();
    if let Some(caps) = re_origin.captures(&html) {
        let key = caps[1].to_string();
        let v_url = format!("https://sns-video-bd.xhscdn.com/{}", key);
        return Ok(Json(ResolveResponse { video_url: v_url }));
    }

    // 3. video src
    let re_url = Regex::new(r#""url"\s*:\s*"(https?://sns-video[^"]+)""#).unwrap();
    if let Some(caps) = re_url.captures(&html) {
        let v_url = caps[1].to_string().replace("\\u002F", "/");
        return Ok(Json(ResolveResponse { video_url: v_url }));
    }

    Err((StatusCode::NOT_FOUND, Json(json!({"error": "ไม่พบวิดีโอใน XHS link นี้"}))))
}
