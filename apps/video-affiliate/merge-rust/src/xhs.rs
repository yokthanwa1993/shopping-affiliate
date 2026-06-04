use axum::{Json, http::StatusCode};
use regex::Regex;
use reqwest::header::{
    ACCEPT, ACCEPT_LANGUAGE, CACHE_CONTROL, COOKIE, HeaderMap, HeaderValue, USER_AGENT,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
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
    pub selected_source: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VideoUrlSource {
    OriginVideoKey,
    BackupUrls,
}

impl VideoUrlSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::OriginVideoKey => "originVideoKey",
            Self::BackupUrls => "backupUrls",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedVideoUrl {
    url: String,
    source: VideoUrlSource,
}

pub async fn handle_resolve(
    Json(payload): Json<ResolveRequest>,
) -> Result<Json<ResolveResponse>, (StatusCode, Json<serde_json::Value>)> {
    let url = payload.url.trim().to_string();
    if url.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "url required"})),
        ));
    }

    if !is_allowed_resolver_entry_url(&url) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "unsupported XHS url host"})),
        ));
    }

    let client = build_mobile_client().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
    })?;
    let cookie = resolve_xhs_cookie();

    let mut current_url = url.clone();
    let mut hops: usize = 0;

    loop {
        let mut request = client.get(&current_url);
        if should_send_xhs_cookie(&current_url) {
            if let Some(cookie) = cookie
                .as_deref()
                .and_then(|value| HeaderValue::from_str(value.trim()).ok())
            {
                if !cookie.is_empty() {
                    request = request.header(COOKIE, cookie);
                }
            }
        }
        let resp = request.send().await.map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("request failed: {}", e)})),
            )
        })?;

        let final_url = resp.url().to_string();
        let html = resp.text().await.map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("text failed: {}", e)})),
            )
        })?;

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

        if let Some(parsed) = parse_video_url_with_source(&html) {
            return Ok(Json(ResolveResponse {
                video_url: parsed.url,
                selected_source: parsed.source.as_str(),
            }));
        }

        let error_message = if looks_like_non_video_note(&html) {
            "ลิงก์ XHS นี้ไม่ใช่โพสต์วิดีโอ (อาจเป็นรูปภาพหรือบทความ)"
        } else if looks_like_watermarked_only_video_note(&html) {
            "no_no_watermark_video_url"
        } else {
            "ไม่พบวิดีโอใน XHS link นี้"
        };
        return Err((StatusCode::NOT_FOUND, Json(json!({"error": error_message}))));
    }
}

fn build_mobile_client() -> Result<reqwest::Client, reqwest::Error> {
    let headers = build_mobile_headers(None);

    reqwest::Client::builder()
        .user_agent(MOBILE_USER_AGENT)
        .default_headers(headers)
        .build()
}

fn resolve_xhs_cookie() -> Option<String> {
    for key in ["XHS_COOKIE", "REDNOTE_COOKIE"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn host_matches_domain(host: &str, domain: &str) -> bool {
    host == domain || host.ends_with(&format!(".{domain}"))
}

fn is_allowed_resolver_entry_url(url_str: &str) -> bool {
    let Ok(parsed) = Url::parse(url_str) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    host_matches_domain(&host, "xiaohongshu.com")
        || host_matches_domain(&host, "xhslink.com")
        || host_matches_domain(&host, "xhscdn.com")
        || host_matches_domain(&host, "rednote.com")
        || host_matches_domain(&host, "weixin.qq.com")
        || host_matches_domain(&host, "open.weixin.qq.com")
        || host_matches_domain(&host, "wechat.com")
}

fn should_send_xhs_cookie(url_str: &str) -> bool {
    let Ok(parsed) = Url::parse(url_str) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    host_matches_domain(&host, "xiaohongshu.com")
        || host_matches_domain(&host, "xhslink.com")
        || host_matches_domain(&host, "xhscdn.com")
        || host_matches_domain(&host, "rednote.com")
}

fn build_mobile_headers(cookie: Option<&str>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(MOBILE_USER_AGENT));
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
    );
    headers.insert(
        ACCEPT_LANGUAGE,
        HeaderValue::from_static("zh-CN,zh;q=0.9,en;q=0.8"),
    );
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("max-age=0"));
    headers.insert("Sec-Ch-Ua-Mobile", HeaderValue::from_static("?1"));
    headers.insert("Sec-Ch-Ua-Platform", HeaderValue::from_static("\"iOS\""));
    if let Some(cookie) = cookie.and_then(|v| HeaderValue::from_str(v.trim()).ok()) {
        if !cookie.is_empty() {
            headers.insert(COOKIE, cookie);
        }
    }
    headers
}

/// If `url_str` is an XHS login page like
/// `https://www.xiaohongshu.com/login?redirectPath=<encoded url>`,
/// decode the `redirectPath` query param and return the absolute URL to follow.
pub fn extract_redirect_path(url_str: &str) -> Option<String> {
    let parsed = Url::parse(url_str).ok()?;
    let host = parsed.host_str().unwrap_or("");
    if !host.contains("xiaohongshu")
        && !host.contains("xhscdn")
        && !host.contains("xhslink")
        && !host.contains("rednote")
    {
        return None;
    }
    if !parsed.path().contains("/login") {
        return None;
    }
    let raw = parsed.query_pairs().find_map(|(k, v)| {
        if k == "redirectPath" {
            Some(v.into_owned())
        } else {
            None
        }
    })?;
    resolve_relative(&parsed, &raw)
}

/// If `url_str` is a WeChat OAuth URL, extract its `redirect_uri` target.
pub fn extract_redirect_uri(url_str: &str) -> Option<String> {
    let parsed = Url::parse(url_str).ok()?;
    let host = parsed.host_str()?;
    if !host.contains("weixin") && !host.contains("wechat") && !host.contains("qq.com") {
        return None;
    }
    let raw = parsed.query_pairs().find_map(|(k, v)| {
        if k == "redirect_uri" {
            Some(v.into_owned())
        } else {
            None
        }
    })?;
    resolve_relative(&parsed, &raw)
}

fn resolve_relative(base: &Url, candidate: &str) -> Option<String> {
    if candidate.starts_with("http://") || candidate.starts_with("https://") {
        return Some(candidate.to_string());
    }
    base.join(candidate).ok().map(|u| u.to_string())
}

/// Try to find a playable XHS video URL inside the page HTML/JSON blob.
///
/// Resolution priority mirrors `JoeanAmier/XHS-Downloader`:
///   1. `video.consumer.originVideoKey` (original / no-watermark asset).
///   2. The best entry in `video.media.stream.h264` + `h265`, ranked by
///      `height` only (no bitrate/size tiebreakers). Items are gathered in
///      `[*h264, *h265]` order and sorted stably, so when heights tie the
///      h265 variant wins — matching XHS-Downloader's default preference.
///      For the chosen entry, `backupUrls[0]` (e.g. `sns-bak-*`) is used.
///
/// Strict no-watermark contract: never return `masterUrl` / inline
/// `sns-video` playback URLs as a successful candidate. Those often carry
/// the visible XHS watermark. If XHS only exposes watermarked playback URLs,
/// `/xhs/resolve` must fail instead of storing a bad original.
pub fn parse_video_url(html: &str) -> Option<String> {
    parse_video_url_with_source(html).map(|parsed| parsed.url)
}

fn parse_video_url_with_source(html: &str) -> Option<ParsedVideoUrl> {
    if let Some(parsed) = extract_origin_video_url(html) {
        return Some(parsed);
    }
    if let Some(parsed) = extract_best_stream_url(html) {
        return Some(parsed);
    }
    None
}

fn extract_origin_video_url(html: &str) -> Option<ParsedVideoUrl> {
    let re_origin = Regex::new(r#""originVideoKey"\s*:\s*"([^"]+)""#).ok()?;
    let caps = re_origin.captures(html)?;
    let key = decode_escaped_url(&caps[1]);
    let key = key.trim_start_matches('/');
    if key.is_empty() {
        return None;
    }
    Some(ParsedVideoUrl {
        url: format!("https://sns-video-bd.xhscdn.com/{}", key),
        source: VideoUrlSource::OriginVideoKey,
    })
}

/// Walks `h264` and `h265` stream arrays anywhere in the HTML/JSON blob,
/// picks the highest-resolution entry, and returns its `backupUrls[0]` only.
///
/// Selection mirrors XHS-Downloader's default-resolution path exactly:
/// concatenate `h264` then `h265`, stable-sort by `height` only, take the
/// last. The stable sort means that on a height tie the later-inserted
/// h265 entry wins — which is important because the h264 variant is the
/// one carrying the visible XHS/username watermark.
fn extract_best_stream_url(html: &str) -> Option<ParsedVideoUrl> {
    let mut items: Vec<serde_json::Value> = Vec::new();
    for key in ["h264", "h265"] {
        if let Some(arr) = extract_balanced_json_array(html, key) {
            if let Some(values) = arr.as_array() {
                items.extend(values.iter().cloned());
            }
        }
    }
    if items.is_empty() {
        return None;
    }
    items.sort_by_key(|it| it.get("height").and_then(|v| v.as_i64()).unwrap_or(0));
    let best = items.last()?;

    if let Some(backups) = best.get("backupUrls").and_then(|v| v.as_array()) {
        if let Some(first) = backups.iter().find_map(|v| v.as_str()) {
            let decoded = decode_escaped_url(first);
            if !decoded.is_empty() {
                return Some(ParsedVideoUrl {
                    url: decoded,
                    source: VideoUrlSource::BackupUrls,
                });
            }
        }
    }
    None
}

/// Locate `"key": [ ... ]` somewhere in `html` and return the parsed array
/// using a brace-balanced scan that respects JSON string literals.
fn extract_balanced_json_array(html: &str, key: &str) -> Option<serde_json::Value> {
    let needle = format!("\"{}\"", key);
    let bytes = html.as_bytes();
    let mut search_start = 0usize;

    while let Some(rel) = html[search_start..].find(&needle) {
        let key_end = search_start + rel + needle.len();
        let mut i = key_end;
        while i < bytes.len() && matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r') {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b':' {
            search_start = key_end;
            continue;
        }
        i += 1;
        while i < bytes.len() && matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r') {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'[' {
            search_start = key_end;
            continue;
        }

        let array_start = i;
        let mut depth: i32 = 0;
        let mut in_str = false;
        let mut escape = false;
        let mut j = array_start;
        while j < bytes.len() {
            let b = bytes[j];
            if escape {
                escape = false;
            } else if in_str {
                if b == b'\\' {
                    escape = true;
                } else if b == b'"' {
                    in_str = false;
                }
            } else {
                match b {
                    b'"' => in_str = true,
                    b'[' => depth += 1,
                    b']' => {
                        depth -= 1;
                        if depth == 0 {
                            let slice = &html[array_start..=j];
                            return serde_json::from_str::<serde_json::Value>(slice).ok();
                        }
                    }
                    _ => {}
                }
            }
            j += 1;
        }
        search_start = key_end;
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
    let has_video_hint =
        html.contains("sns-video") || html.contains("masterUrl") || html.contains("originVideoKey");
    has_note_marker && !has_video_hint
}

fn looks_like_watermarked_only_video_note(html: &str) -> bool {
    html.contains("masterUrl") || html.contains("sns-video")
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
    fn extract_redirect_path_accepts_rednote_login_host() {
        let url = "https://www.rednote.com/login?redirectPath=https%3A%2F%2Fwww.rednote.com%2Fexplore%2F69fa78c7000000003701ea6c";
        assert_eq!(
            extract_redirect_path(url).as_deref(),
            Some("https://www.rednote.com/explore/69fa78c7000000003701ea6c"),
        );
    }

    #[test]
    fn extract_redirect_path_returns_none_when_no_login_segment() {
        let url = "https://www.xiaohongshu.com/discovery/item/123?redirectPath=foo";
        assert!(extract_redirect_path(url).is_none());
    }

    #[test]
    fn extract_redirect_path_returns_none_for_rednote_non_login_url() {
        let url = "https://www.rednote.com/explore/69fa78c7000000003701ea6c?redirectPath=https%3A%2F%2Fwww.rednote.com%2Fexplore%2Fother";
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
        let url =
            "https://example.com/oauth?redirect_uri=https%3A%2F%2Fwww.xiaohongshu.com%2Fdiscovery";
        assert!(extract_redirect_uri(url).is_none());
    }

    #[test]
    fn build_mobile_headers_applies_cookie_when_provided() {
        let headers = build_mobile_headers(Some("a=b; web_session=secret"));
        assert_eq!(
            headers.get(COOKIE).and_then(|v| v.to_str().ok()),
            Some("a=b; web_session=secret"),
        );
    }

    #[test]
    fn build_mobile_headers_skips_invalid_cookie() {
        let headers = build_mobile_headers(Some("bad\nvalue"));
        assert!(headers.get(COOKIE).is_none());
    }

    #[test]
    fn resolver_entry_url_rejects_lookalike_host() {
        assert!(!is_allowed_resolver_entry_url(
            "https://www.xiaohongshu.com.evil.example/discovery/item/123"
        ));
    }

    #[test]
    fn resolver_entry_url_allows_xhs_and_wechat_oauth_hosts() {
        assert!(is_allowed_resolver_entry_url(
            "https://www.xiaohongshu.com/discovery/item/123"
        ));
        assert!(is_allowed_resolver_entry_url(
            "https://open.weixin.qq.com/connect/oauth2/authorize?redirect_uri=x"
        ));
    }

    #[test]
    fn xhs_cookie_is_only_sent_to_trusted_xhs_hosts() {
        assert!(should_send_xhs_cookie(
            "https://www.xiaohongshu.com/discovery/item/123"
        ));
        assert!(should_send_xhs_cookie(
            "https://sns-bak-v8.xhscdn.com/a.mp4"
        ));
        assert!(should_send_xhs_cookie(
            "https://www.rednote.com/explore/123"
        ));
        assert!(!should_send_xhs_cookie(
            "https://open.weixin.qq.com/connect/oauth2/authorize"
        ));
        assert!(!should_send_xhs_cookie(
            "https://www.xiaohongshu.com.evil.example/steal"
        ));
    }

    #[test]
    fn parse_video_url_rejects_master_url_when_only_master_present() {
        let html = r#"prefix..."masterUrl":"https://sns-video-bd.xhscdn.com/clip.mp4"...suffix"#;
        assert!(parse_video_url(html).is_none());
        assert!(looks_like_watermarked_only_video_note(html));
    }

    #[test]
    fn parse_video_url_returns_origin_key_when_only_origin_present() {
        let html = r#"...{"originVideoKey":"stream/v1/abc"}..."#;
        assert_eq!(
            parse_video_url(html).as_deref(),
            Some("https://sns-video-bd.xhscdn.com/stream/v1/abc"),
        );
    }

    #[test]
    fn parse_video_url_prefers_origin_key_over_master_url() {
        // Both candidates present: must return the originVideoKey-derived URL
        // because masterUrl now serves a watermarked playback stream.
        let html = r#"{"masterUrl":"https://sns-video-bd.xhscdn.com/watermarked.mp4","originVideoKey":"stream/v1/original"}"#;
        assert_eq!(
            parse_video_url(html).as_deref(),
            Some("https://sns-video-bd.xhscdn.com/stream/v1/original"),
        );
        assert_eq!(
            parse_video_url_with_source(html).map(|parsed| parsed.source),
            Some(VideoUrlSource::OriginVideoKey),
        );
    }

    #[test]
    fn parse_video_url_decodes_escaped_origin_key() {
        // XHS sometimes ships the key with `/` escapes for the slashes.
        let html = r#"{"originVideoKey":"stream/v1/escaped","masterUrl":"https://sns-video-bd.xhscdn.com/wm.mp4"}"#;
        assert_eq!(
            parse_video_url(html).as_deref(),
            Some("https://sns-video-bd.xhscdn.com/stream/v1/escaped"),
        );
    }

    #[test]
    fn parse_video_url_trims_leading_slash_in_origin_key() {
        let html = r#"{"originVideoKey":"/stream/v1/abc"}"#;
        assert_eq!(
            parse_video_url(html).as_deref(),
            Some("https://sns-video-bd.xhscdn.com/stream/v1/abc"),
        );
    }

    #[test]
    fn parse_video_url_skips_empty_origin_key() {
        // Empty originVideoKey should not fall back to masterUrl because
        // masterUrl is a watermarked playback stream.
        let html =
            r#"{"originVideoKey":"","masterUrl":"https://sns-video-bd.xhscdn.com/clip.mp4"}"#;
        assert!(parse_video_url(html).is_none());
    }

    #[test]
    fn parse_video_url_rejects_inline_video_src() {
        let html = r#"foo "url":"https://sns-video-bd.xhscdn.com/clip.mp4" bar"#;
        assert!(parse_video_url(html).is_none());
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
        let html =
            r#"<script>window.__INITIAL_STATE__={"note":{"noteId":"x","type":"normal"}}</script>"#;
        assert!(looks_like_non_video_note(html));
    }

    #[test]
    fn looks_like_non_video_note_false_when_video_hint_present() {
        let html = r#"<script>{"noteId":"x","masterUrl":"https://sns-video-bd.xhscdn.com/x.mp4"}</script>"#;
        assert!(!looks_like_non_video_note(html));
    }

    // ---- XHS-Downloader parity: stream-based selection ----

    #[test]
    fn parse_video_url_prefers_backup_url_over_master_url_in_stream() {
        // Real-world failure mode that motivated this change: when
        // `originVideoKey` is absent, `masterUrl` serves a watermarked
        // `sns-video-v28...` stream but `backupUrls[0]` still points at the
        // raw `sns-bak-*` clip. We must select the backup URL.
        let html = r#"<script>window.__INITIAL_STATE__={"note":{"video":{"media":{"stream":{"h264":[{"height":720,"width":1280,"videoBitrate":1500000,"size":4000000,"masterUrl":"https://sns-video-v28.xhscdn.com/wm_259.mp4","backupUrls":["https://sns-bak-v8.xhscdn.com/bak_258.mp4"]}],"h265":[]}}}}};</script>"#;
        assert_eq!(
            parse_video_url(html).as_deref(),
            Some("https://sns-bak-v8.xhscdn.com/bak_258.mp4"),
        );
        assert_eq!(
            parse_video_url_with_source(html).map(|parsed| parsed.source),
            Some(VideoUrlSource::BackupUrls),
        );
    }

    #[test]
    fn parse_video_url_rejects_master_url_when_backup_urls_empty() {
        let html = r#"{"video":{"media":{"stream":{"h264":[{"height":720,"masterUrl":"https://sns-video-bd.xhscdn.com/m.mp4","backupUrls":[]}],"h265":[]}}}}"#;
        assert!(parse_video_url(html).is_none());
    }

    #[test]
    fn parse_video_url_picks_highest_height_across_h264_and_h265() {
        // h265 carries the larger height; we should pick its backup URL.
        let html = r#"{
            "video":{"media":{"stream":{
                "h264":[
                    {"height":480,"videoBitrate":800000,"masterUrl":"https://sns-video-bd.xhscdn.com/lo264.mp4","backupUrls":["https://sns-bak-v8.xhscdn.com/lo264-bak.mp4"]},
                    {"height":720,"videoBitrate":1500000,"masterUrl":"https://sns-video-bd.xhscdn.com/mid264.mp4","backupUrls":["https://sns-bak-v8.xhscdn.com/mid264-bak.mp4"]}
                ],
                "h265":[
                    {"height":1080,"videoBitrate":2200000,"masterUrl":"https://sns-video-bd.xhscdn.com/hi265.mp4","backupUrls":["https://sns-bak-v8.xhscdn.com/hi265-bak.mp4"]}
                ]
            }}}
        }"#;
        assert_eq!(
            parse_video_url(html).as_deref(),
            Some("https://sns-bak-v8.xhscdn.com/hi265-bak.mp4"),
        );
    }

    #[test]
    fn parse_video_url_supports_mobile_initial_state_shape() {
        // Mobile shape: noteData.data.noteData.video.media.stream.{h264,h265}
        let html = r#"<script>window.__INITIAL_STATE__={"noteData":{"data":{"noteData":{"type":"video","video":{"media":{"stream":{"h264":[{"height":1080,"videoBitrate":2000000,"masterUrl":"https://sns-video-v28.xhscdn.com/m_259.mp4","backupUrls":["https://sns-bak-v8.xhscdn.com/m_258.mp4"]}],"h265":[]}}}}}}};</script>"#;
        assert_eq!(
            parse_video_url(html).as_deref(),
            Some("https://sns-bak-v8.xhscdn.com/m_258.mp4"),
        );
    }

    #[test]
    fn parse_video_url_supports_pc_initial_state_shape() {
        // PC shape: note.noteDetailMap.<id>.note.video.media.stream.{h264,h265}
        let html = r#"<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"abc123":{"note":{"type":"video","video":{"media":{"stream":{"h264":[],"h265":[{"height":1080,"videoBitrate":2200000,"masterUrl":"https://sns-video-v28.xhscdn.com/pc_259.mp4","backupUrls":["https://sns-bak-v8.xhscdn.com/pc_258.mp4"]}]}}}}}}}};</script>"#;
        assert_eq!(
            parse_video_url(html).as_deref(),
            Some("https://sns-bak-v8.xhscdn.com/pc_258.mp4"),
        );
    }

    #[test]
    fn parse_video_url_origin_video_key_beats_stream_data() {
        // When both shapes are present, originVideoKey wins (XHS-Downloader parity).
        let html = r#"{"video":{"consumer":{"originVideoKey":"stream/v1/original"},"media":{"stream":{"h264":[{"height":1080,"masterUrl":"https://sns-video-bd.xhscdn.com/m.mp4","backupUrls":["https://sns-bak-v8.xhscdn.com/b.mp4"]}],"h265":[]}}}}"#;
        assert_eq!(
            parse_video_url(html).as_deref(),
            Some("https://sns-video-bd.xhscdn.com/stream/v1/original"),
        );
    }

    #[test]
    fn parse_video_url_prefers_h265_over_h264_when_height_ties() {
        // Real-world failure mode: o/ASdSCwPJF3g returns both a 720p h264
        // and a 720p h265 backup. The h264 variant has higher bitrate/size
        // but carries a visible XHS/username watermark; the h265 variant
        // is the clean one. XHS-Downloader's default path sorts by height
        // alone (stable, [*h264, *h265]) so on a tie h265 wins. We must
        // match that behavior — bitrate/size MUST NOT be tiebreakers.
        let html = r#"{"video":{"media":{"stream":{
            "h264":[{"height":1280,"width":720,"videoBitrate":900000,"size":1632963,"masterUrl":"https://sns-video-v28.xhscdn.com/wm_259.mp4","backupUrls":["https://sns-bak-v8.xhscdn.com/stream/79/110/259/01e86a4ffd7dfd560103700397df48bbe2_259.mp4"]}],
            "h265":[{"height":1280,"width":720,"videoBitrate":600000,"size":1082904,"masterUrl":"https://sns-video-v28.xhscdn.com/wm_114.mp4","backupUrls":["https://sns-bak-v8.xhscdn.com/stream/79/110/114/01e86a4ffd7dfd564f03700197df48dc9b_114.mp4"]}]
        }}}}"#;
        assert_eq!(
            parse_video_url(html).as_deref(),
            Some(
                "https://sns-bak-v8.xhscdn.com/stream/79/110/114/01e86a4ffd7dfd564f03700197df48dc9b_114.mp4"
            ),
        );
    }

    #[test]
    fn parse_video_url_decodes_unicode_escaped_backup_url() {
        // XHS often ships URLs with / escapes for slashes. serde_json
        // decodes those inside JSON strings, so the result must come out clean.
        let html = r#"{"video":{"media":{"stream":{"h264":[{"height":720,"masterUrl":"https://sns-video-bd.xhscdn.com/m.mp4","backupUrls":["https://sns-bak-v8.xhscdn.com/b.mp4"]}],"h265":[]}}}}"#;
        assert_eq!(
            parse_video_url(html).as_deref(),
            Some("https://sns-bak-v8.xhscdn.com/b.mp4"),
        );
    }
}
