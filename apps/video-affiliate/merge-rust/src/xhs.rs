use axum::{Json, http::StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::json;
use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT, ACCEPT, ACCEPT_LANGUAGE, CACHE_CONTROL};
use regex::Regex;
use url::Url;

const MOBILE_USER_AGENT: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const MAX_MANUAL_REDIRECT_HOPS: usize = 4;

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

    let client = build_mobile_client()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e.to_string()}))))?;

    let mut current_url = url.clone();
    let mut hops: usize = 0;

    loop {
        let resp = client.get(&current_url).send().await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("request failed: {}", e)}))))?;

        let final_url = resp.url().to_string();
        let html = resp.text().await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("text failed: {}", e)}))))?;

        if hops < MAX_MANUAL_REDIRECT_HOPS {
            if let Some(next) = extract_redirect_path(&final_url) {
                current_url = next;
                hops += 1;
                continue;
            }
            if let Some(next) = extract_redirect_uri(&final_url) {
                current_url = next;
                hops += 1;
                continue;
            }
        }

        if let Some(video_url) = parse_video_url(&html) {
            return Ok(Json(ResolveResponse { video_url }));
        }

        let error_message = if looks_like_non_video_note(&html) {
            "ลิงก์ XHS นี้ไม่ใช่โพสต์วิดีโอ (อาจเป็นรูปภาพหรือบทความ)"
        } else {
            "ไม่พบวิดีโอใน XHS link นี้"
        };
        return Err((StatusCode::NOT_FOUND, Json(json!({"error": error_message}))));
    }
}

fn build_mobile_client() -> Result<reqwest::Client, reqwest::Error> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(MOBILE_USER_AGENT));
    headers.insert(ACCEPT, HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"));
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("zh-CN,zh;q=0.9,en;q=0.8"));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("max-age=0"));
    headers.insert("Sec-Ch-Ua-Mobile", HeaderValue::from_static("?1"));
    headers.insert("Sec-Ch-Ua-Platform", HeaderValue::from_static("\"iOS\""));

    reqwest::Client::builder()
        .user_agent(MOBILE_USER_AGENT)
        .default_headers(headers)
        .build()
}

/// If `url_str` is an XHS login page like
/// `https://www.xiaohongshu.com/login?redirectPath=<encoded url>`,
/// decode the `redirectPath` query param and return the absolute URL to follow.
pub fn extract_redirect_path(url_str: &str) -> Option<String> {
    let parsed = Url::parse(url_str).ok()?;
    let host = parsed.host_str().unwrap_or("");
    if !host.contains("xiaohongshu") && !host.contains("xhscdn") && !host.contains("xhslink") {
        return None;
    }
    if !parsed.path().contains("/login") {
        return None;
    }
    let raw = parsed
        .query_pairs()
        .find_map(|(k, v)| if k == "redirectPath" { Some(v.into_owned()) } else { None })?;
    resolve_relative(&parsed, &raw)
}

/// If `url_str` is a WeChat OAuth URL, extract its `redirect_uri` target.
pub fn extract_redirect_uri(url_str: &str) -> Option<String> {
    let parsed = Url::parse(url_str).ok()?;
    let host = parsed.host_str()?;
    if !host.contains("weixin") && !host.contains("wechat") && !host.contains("qq.com") {
        return None;
    }
    let raw = parsed
        .query_pairs()
        .find_map(|(k, v)| if k == "redirect_uri" { Some(v.into_owned()) } else { None })?;
    resolve_relative(&parsed, &raw)
}

fn resolve_relative(base: &Url, candidate: &str) -> Option<String> {
    if candidate.starts_with("http://") || candidate.starts_with("https://") {
        return Some(candidate.to_string());
    }
    base.join(candidate).ok().map(|u| u.to_string())
}

/// Try to find a playable XHS video URL inside the page HTML/JSON blob.
pub fn parse_video_url(html: &str) -> Option<String> {
    let re_master = Regex::new(r#""masterUrl"\s*:\s*"([^"]+)""#).ok()?;
    if let Some(caps) = re_master.captures(html) {
        let v_url = decode_escaped_url(&caps[1]);
        if v_url.contains("sns-video") {
            return Some(v_url);
        }
    }

    let re_origin = Regex::new(r#""originVideoKey"\s*:\s*"([^"]+)""#).ok()?;
    if let Some(caps) = re_origin.captures(html) {
        let key = caps[1].to_string();
        return Some(format!("https://sns-video-bd.xhscdn.com/{}", key));
    }

    let re_url = Regex::new(r#""url"\s*:\s*"(https?://sns-video[^"]+)""#).ok()?;
    if let Some(caps) = re_url.captures(html) {
        return Some(decode_escaped_url(&caps[1]));
    }

    None
}

fn decode_escaped_url(raw: &str) -> String {
    raw.replace("\\u002F", "/").replace("\\u002f", "/")
}

/// Heuristic: HTML that has note metadata but no video URL is likely a
/// `normal`/image post rather than a video post.
fn looks_like_non_video_note(html: &str) -> bool {
    let has_note_marker = html.contains("noteId")
        || html.contains("note-detail")
        || html.contains("\"type\":\"normal\"");
    let has_video_hint = html.contains("sns-video")
        || html.contains("masterUrl")
        || html.contains("originVideoKey");
    has_note_marker && !has_video_hint
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_redirect_path_returns_absolute_url() {
        let url = "https://www.xiaohongshu.com/login?redirectPath=https%3A%2F%2Fwww.xiaohongshu.com%2Fdiscovery%2Fitem%2F123";
        assert_eq!(
            extract_redirect_path(url).as_deref(),
            Some("https://www.xiaohongshu.com/discovery/item/123"),
        );
    }

    #[test]
    fn extract_redirect_path_resolves_relative_path() {
        let url = "https://www.xiaohongshu.com/login?redirectPath=%2Fdiscovery%2Fitem%2F456";
        assert_eq!(
            extract_redirect_path(url).as_deref(),
            Some("https://www.xiaohongshu.com/discovery/item/456"),
        );
    }

    #[test]
    fn extract_redirect_path_returns_none_when_no_login_segment() {
        let url = "https://www.xiaohongshu.com/discovery/item/123?redirectPath=foo";
        assert!(extract_redirect_path(url).is_none());
    }

    #[test]
    fn extract_redirect_path_returns_none_for_non_xhs_host() {
        let url = "https://example.com/login?redirectPath=https%3A%2F%2Fxx";
        assert!(extract_redirect_path(url).is_none());
    }

    #[test]
    fn extract_redirect_uri_decodes_wechat_oauth_target() {
        let url = "https://open.weixin.qq.com/connect/oauth2/authorize?appid=x&redirect_uri=https%3A%2F%2Fwww.xiaohongshu.com%2Fdiscovery%2Fitem%2F789&response_type=code";
        assert_eq!(
            extract_redirect_uri(url).as_deref(),
            Some("https://www.xiaohongshu.com/discovery/item/789"),
        );
    }

    #[test]
    fn extract_redirect_uri_returns_none_for_unrelated_host() {
        let url = "https://example.com/oauth?redirect_uri=https%3A%2F%2Fwww.xiaohongshu.com%2Fdiscovery";
        assert!(extract_redirect_uri(url).is_none());
    }

    #[test]
    fn parse_video_url_finds_master_url() {
        let html = r#"prefix..."masterUrl":"https://sns-video-bd.xhscdn.com/clip.mp4"...suffix"#;
        assert_eq!(
            parse_video_url(html).as_deref(),
            Some("https://sns-video-bd.xhscdn.com/clip.mp4"),
        );
    }

    #[test]
    fn parse_video_url_falls_back_to_origin_video_key() {
        let html = r#"...{"originVideoKey":"stream/v1/abc"}..."#;
        assert_eq!(
            parse_video_url(html).as_deref(),
            Some("https://sns-video-bd.xhscdn.com/stream/v1/abc"),
        );
    }

    #[test]
    fn parse_video_url_finds_inline_video_src() {
        let html = r#"foo "url":"https://sns-video-bd.xhscdn.com/clip.mp4" bar"#;
        assert_eq!(
            parse_video_url(html).as_deref(),
            Some("https://sns-video-bd.xhscdn.com/clip.mp4"),
        );
    }

    #[test]
    fn parse_video_url_returns_none_when_master_url_is_not_sns_video() {
        let html = r#"{"masterUrl":"https://other.cdn.com/img.png"}"#;
        assert!(parse_video_url(html).is_none());
    }

    #[test]
    fn parse_video_url_returns_none_when_html_has_nothing() {
        assert!(parse_video_url("<html>plain page</html>").is_none());
    }

    #[test]
    fn looks_like_non_video_note_true_for_normal_note_without_video() {
        let html = r#"<script>window.__INITIAL_STATE__={"note":{"noteId":"x","type":"normal"}}</script>"#;
        assert!(looks_like_non_video_note(html));
    }

    #[test]
    fn looks_like_non_video_note_false_when_video_hint_present() {
        let html = r#"<script>{"noteId":"x","masterUrl":"https://sns-video-bd.xhscdn.com/x.mp4"}</script>"#;
        assert!(!looks_like_non_video_note(html));
    }
}
