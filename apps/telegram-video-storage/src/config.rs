use std::env;

use serde::Serialize;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 8820;

#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub api_id: Option<i32>,
    pub api_hash: Option<String>,
    pub session_path: Option<String>,
    pub original_channel: Option<String>,
    pub processed_channel: Option<String>,
    pub api_key: Option<String>,
    pub mock_mode: bool,
}

impl Config {
    /// Load configuration from the current process environment. Missing fields
    /// are tolerated — they surface in [`Config::readiness`].
    pub fn from_env() -> Self {
        Self::from_map(|key| env::var(key).ok())
    }

    /// Pure constructor used by tests and the env loader. Accepts a closure so
    /// tests do not need to touch the global environment.
    pub fn from_map<F>(get: F) -> Self
    where
        F: Fn(&str) -> Option<String>,
    {
        let host = get("TELEGRAM_VIDEO_STORAGE_HOST")
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_HOST.to_string());

        let port = get("TELEGRAM_VIDEO_STORAGE_PORT")
            .and_then(|s| s.trim().parse::<u16>().ok())
            .unwrap_or(DEFAULT_PORT);

        let api_id = get("TELEGRAM_API_ID").and_then(|s| s.trim().parse::<i32>().ok());
        let api_hash = get("TELEGRAM_API_HASH").map(trim_nonempty).unwrap_or(None);
        let session_path = get("TELEGRAM_SESSION_PATH")
            .map(trim_nonempty)
            .unwrap_or(None);
        let original_channel = get("TELEGRAM_ORIGINAL_CHANNEL_ID")
            .map(trim_nonempty)
            .unwrap_or(None);
        let processed_channel = get("TELEGRAM_PROCESSED_CHANNEL_ID")
            .map(trim_nonempty)
            .unwrap_or(None);
        let api_key = get("TELEGRAM_VIDEO_STORAGE_API_KEY")
            .map(trim_nonempty)
            .unwrap_or(None);
        let mock_mode = get("TELEGRAM_VIDEO_STORAGE_MOCK")
            .map(|s| matches!(s.trim(), "1" | "true" | "TRUE" | "yes" | "on"))
            .unwrap_or(false);

        Self {
            host,
            port,
            api_id,
            api_hash,
            session_path,
            original_channel,
            processed_channel,
            api_key,
            mock_mode,
        }
    }

    /// Whether the service has every credential it needs to talk to Telegram.
    /// In mock mode, readiness ignores Telegram-specific fields.
    pub fn readiness(&self) -> ReadinessReport {
        if self.mock_mode {
            return ReadinessReport {
                ready: true,
                mode: "mock",
                missing: Vec::new(),
            };
        }
        let mut missing = Vec::new();
        if self.api_id.is_none() {
            missing.push("TELEGRAM_API_ID");
        }
        if self.api_hash.is_none() {
            missing.push("TELEGRAM_API_HASH");
        }
        if self.session_path.is_none() {
            missing.push("TELEGRAM_SESSION_PATH");
        }
        if self.original_channel.is_none() {
            missing.push("TELEGRAM_ORIGINAL_CHANNEL_ID");
        }
        if self.processed_channel.is_none() {
            missing.push("TELEGRAM_PROCESSED_CHANNEL_ID");
        }
        ReadinessReport {
            ready: missing.is_empty(),
            mode: "telegram",
            missing: missing.into_iter().map(String::from).collect(),
        }
    }

    /// Returns a status object safe to expose over HTTP. Secrets are reduced to
    /// presence booleans / fingerprints; raw values never leave the process.
    pub fn redacted_status(&self) -> RedactedStatus {
        let readiness = self.readiness();
        RedactedStatus {
            ready: readiness.ready,
            mode: readiness.mode,
            host: self.host.clone(),
            port: self.port,
            api_id_present: self.api_id.is_some(),
            api_hash_fingerprint: self.api_hash.as_deref().map(fingerprint),
            session_path_present: self.session_path.is_some(),
            original_channel_present: self.original_channel.is_some(),
            processed_channel_present: self.processed_channel.is_some(),
            api_key_required: self.api_key.is_some(),
            mock_mode: self.mock_mode,
            missing: readiness.missing,
        }
    }

    /// Constant-time-ish API key check. Returns `Ok(())` when the request is
    /// permitted, [`AuthCheck::Unauthorized`] otherwise.
    pub fn check_api_key(&self, presented: Option<&str>) -> AuthCheck {
        match (&self.api_key, presented) {
            (None, _) => AuthCheck::Ok,
            (Some(expected), Some(given))
                if constant_time_eq(expected.as_bytes(), given.as_bytes()) =>
            {
                AuthCheck::Ok
            }
            _ => AuthCheck::Unauthorized,
        }
    }
}

fn trim_nonempty(s: String) -> Option<String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Short, deterministic fingerprint that lets the operator confirm a hash is
/// loaded without revealing the value. NOT a cryptographic identifier.
fn fingerprint(value: &str) -> String {
    if value.is_empty() {
        return String::from("∅");
    }
    let len = value.len();
    let head: String = value.chars().take(2).collect();
    let tail: String = value
        .chars()
        .rev()
        .take(2)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("{head}…{tail} ({len})")
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[derive(Debug, Clone, Serialize)]
pub struct ReadinessReport {
    pub ready: bool,
    pub mode: &'static str,
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RedactedStatus {
    pub ready: bool,
    pub mode: &'static str,
    pub host: String,
    pub port: u16,
    pub api_id_present: bool,
    pub api_hash_fingerprint: Option<String>,
    pub session_path_present: bool,
    pub original_channel_present: bool,
    pub processed_channel_present: bool,
    pub api_key_required: bool,
    pub mock_mode: bool,
    pub missing: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum AuthCheck {
    Ok,
    Unauthorized,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn loader<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        let map: HashMap<&str, &str> = pairs.iter().copied().collect();
        move |k| map.get(k).map(|v| v.to_string())
    }

    #[test]
    fn defaults_when_env_empty() {
        let cfg = Config::from_map(|_| None);
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 8820);
        assert!(cfg.api_id.is_none());
        assert!(!cfg.mock_mode);
    }

    #[test]
    fn overrides_host_and_port() {
        let cfg = Config::from_map(loader(&[
            ("TELEGRAM_VIDEO_STORAGE_HOST", "0.0.0.0"),
            ("TELEGRAM_VIDEO_STORAGE_PORT", "9100"),
        ]));
        assert_eq!(cfg.host, "0.0.0.0");
        assert_eq!(cfg.port, 9100);
    }

    #[test]
    fn invalid_port_falls_back_to_default() {
        let cfg = Config::from_map(loader(&[("TELEGRAM_VIDEO_STORAGE_PORT", "not-a-port")]));
        assert_eq!(cfg.port, 8820);
    }

    #[test]
    fn readiness_lists_all_missing_telegram_fields() {
        let cfg = Config::from_map(|_| None);
        let r = cfg.readiness();
        assert!(!r.ready);
        assert_eq!(r.mode, "telegram");
        assert_eq!(
            r.missing,
            vec![
                "TELEGRAM_API_ID",
                "TELEGRAM_API_HASH",
                "TELEGRAM_SESSION_PATH",
                "TELEGRAM_ORIGINAL_CHANNEL_ID",
                "TELEGRAM_PROCESSED_CHANNEL_ID",
            ]
        );
    }

    #[test]
    fn readiness_ok_when_all_fields_set() {
        let cfg = Config::from_map(loader(&[
            ("TELEGRAM_API_ID", "12345"),
            ("TELEGRAM_API_HASH", "deadbeefcafebabe"),
            ("TELEGRAM_SESSION_PATH", "/tmp/session.session"),
            ("TELEGRAM_ORIGINAL_CHANNEL_ID", "archive_original"),
            ("TELEGRAM_PROCESSED_CHANNEL_ID", "archive_processed"),
        ]));
        let r = cfg.readiness();
        assert!(r.ready, "should be ready, got {:?}", r);
        assert!(r.missing.is_empty());
    }

    #[test]
    fn mock_mode_is_always_ready() {
        let cfg = Config::from_map(loader(&[("TELEGRAM_VIDEO_STORAGE_MOCK", "1")]));
        let r = cfg.readiness();
        assert!(r.ready);
        assert_eq!(r.mode, "mock");
    }

    #[test]
    fn redacted_status_never_contains_raw_hash_or_session_path() {
        let cfg = Config::from_map(loader(&[
            ("TELEGRAM_API_HASH", "topsecret-hash-value"),
            ("TELEGRAM_SESSION_PATH", "/var/secret/session.session"),
            ("TELEGRAM_VIDEO_STORAGE_API_KEY", "supersecret"),
        ]));
        let status = cfg.redacted_status();
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains("topsecret-hash-value"));
        assert!(!json.contains("/var/secret/session.session"));
        assert!(!json.contains("supersecret"));
        assert!(status.api_hash_fingerprint.is_some());
        assert!(status.session_path_present);
        assert!(status.api_key_required);
    }

    #[test]
    fn api_key_check_open_when_unset() {
        let cfg = Config::from_map(|_| None);
        assert_eq!(cfg.check_api_key(None), AuthCheck::Ok);
        assert_eq!(cfg.check_api_key(Some("anything")), AuthCheck::Ok);
    }

    #[test]
    fn api_key_check_requires_match_when_set() {
        let cfg = Config::from_map(loader(&[("TELEGRAM_VIDEO_STORAGE_API_KEY", "let-me-in")]));
        assert_eq!(cfg.check_api_key(None), AuthCheck::Unauthorized);
        assert_eq!(cfg.check_api_key(Some("wrong")), AuthCheck::Unauthorized);
        assert_eq!(cfg.check_api_key(Some("let-me-in")), AuthCheck::Ok);
    }
}
