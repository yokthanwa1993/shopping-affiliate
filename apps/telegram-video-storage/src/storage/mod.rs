use std::path::PathBuf;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::config::Config;

pub mod mock;
#[cfg(feature = "real_telegram")]
pub mod telegram;

/// Which archive bucket (channel) a file is destined for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Original,
    Processed,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Original => "original",
            Kind::Processed => "processed",
        }
    }

    /// Pick the configured channel identifier for this kind.
    /// Channel id is a `String` because operators may pass either a numeric
    /// `-100xxxx` id or an `@username` — resolution happens in the backend.
    pub fn channel_for<'a>(self, cfg: &'a Config) -> Option<&'a str> {
        match self {
            Kind::Original => cfg.original_channel.as_deref(),
            Kind::Processed => cfg.processed_channel.as_deref(),
        }
    }
}

/// Incoming POST /api/archive/local-file payload.
#[derive(Debug, Clone, Deserialize)]
pub struct ArchiveRequest {
    pub path: String,
    pub kind: Kind,
    #[serde(rename = "videoId")]
    pub video_id: String,
    #[serde(rename = "namespaceId", default)]
    pub namespace_id: Option<String>,
    #[serde(rename = "fileName", default)]
    pub file_name: Option<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ValidationError {
    #[error("path must be a non-empty absolute path")]
    BadPath,
    #[error("videoId is required")]
    MissingVideoId,
    #[error("namespaceId, when set, must be non-empty")]
    EmptyNamespace,
    #[error("fileName, when set, must be non-empty")]
    EmptyFileName,
}

impl ArchiveRequest {
    /// Pure validation — no filesystem access, safe to unit-test.
    pub fn validate(&self) -> Result<(), ValidationError> {
        let path = self.path.trim();
        if path.is_empty() || !PathBuf::from(path).is_absolute() {
            return Err(ValidationError::BadPath);
        }
        if self.video_id.trim().is_empty() {
            return Err(ValidationError::MissingVideoId);
        }
        if let Some(ns) = &self.namespace_id {
            if ns.trim().is_empty() {
                return Err(ValidationError::EmptyNamespace);
            }
        }
        if let Some(name) = &self.file_name {
            if name.trim().is_empty() {
                return Err(ValidationError::EmptyFileName);
            }
        }
        Ok(())
    }

    /// Pick the display file name: explicit field wins, else basename of `path`.
    pub fn resolved_file_name(&self) -> String {
        if let Some(name) = self
            .file_name
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            return name.to_string();
        }
        PathBuf::from(&self.path)
            .file_name()
            .and_then(|n| n.to_str())
            .map(String::from)
            .unwrap_or_else(|| "video.bin".to_string())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ArchiveResult {
    pub storage: &'static str,
    pub kind: &'static str,
    #[serde(rename = "videoId")]
    pub video_id: String,
    #[serde(rename = "namespaceId")]
    pub namespace_id: Option<String>,
    #[serde(rename = "channelId")]
    pub channel_id: String,
    #[serde(rename = "messageId")]
    pub message_id: i64,
    #[serde(rename = "fileName")]
    pub file_name: String,
    pub size: u64,
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("storage not ready: {0}")]
    NotReady(String),
    #[error("file not found at {0}")]
    FileNotFound(String),
    #[error("validation failed: {0}")]
    Validation(#[from] ValidationError),
    #[error("upload failed: {0}")]
    Upload(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[async_trait]
pub trait Storage: Send + Sync {
    fn name(&self) -> &'static str;
    async fn archive_local_file(&self, req: ArchiveRequest) -> Result<ArchiveResult, StorageError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> ArchiveRequest {
        ArchiveRequest {
            path: "/tmp/sample.mp4".to_string(),
            kind: Kind::Original,
            video_id: "abc123".to_string(),
            namespace_id: Some("ns1".to_string()),
            file_name: Some("nice-name.mp4".to_string()),
        }
    }

    #[test]
    fn kind_serializes_lowercase() {
        let payload = serde_json::json!({
            "path": "/tmp/x.mp4",
            "kind": "processed",
            "videoId": "v",
        });
        let parsed: ArchiveRequest = serde_json::from_value(payload).unwrap();
        assert_eq!(parsed.kind, Kind::Processed);
    }

    #[test]
    fn kind_rejects_unknown() {
        let payload = serde_json::json!({
            "path": "/tmp/x.mp4",
            "kind": "deleted",
            "videoId": "v",
        });
        let result: Result<ArchiveRequest, _> = serde_json::from_value(payload);
        assert!(result.is_err());
    }

    #[test]
    fn channel_routing_picks_correct_field() {
        let cfg = Config::from_map(|k| match k {
            "TELEGRAM_ORIGINAL_CHANNEL_ID" => Some("@orig".into()),
            "TELEGRAM_PROCESSED_CHANNEL_ID" => Some("@proc".into()),
            _ => None,
        });
        assert_eq!(Kind::Original.channel_for(&cfg), Some("@orig"));
        assert_eq!(Kind::Processed.channel_for(&cfg), Some("@proc"));
    }

    #[test]
    fn channel_routing_missing_returns_none() {
        let cfg = Config::from_map(|_| None);
        assert!(Kind::Original.channel_for(&cfg).is_none());
        assert!(Kind::Processed.channel_for(&cfg).is_none());
    }

    #[test]
    fn validate_accepts_good_request() {
        assert_eq!(req().validate(), Ok(()));
    }

    #[test]
    fn validate_rejects_relative_path() {
        let mut r = req();
        r.path = "relative/path.mp4".to_string();
        assert_eq!(r.validate(), Err(ValidationError::BadPath));
    }

    #[test]
    fn validate_rejects_empty_path() {
        let mut r = req();
        r.path = "   ".to_string();
        assert_eq!(r.validate(), Err(ValidationError::BadPath));
    }

    #[test]
    fn validate_rejects_blank_video_id() {
        let mut r = req();
        r.video_id = "".to_string();
        assert_eq!(r.validate(), Err(ValidationError::MissingVideoId));
    }

    #[test]
    fn validate_rejects_empty_namespace_when_present() {
        let mut r = req();
        r.namespace_id = Some(" ".to_string());
        assert_eq!(r.validate(), Err(ValidationError::EmptyNamespace));
    }

    #[test]
    fn resolved_file_name_prefers_explicit() {
        let r = req();
        assert_eq!(r.resolved_file_name(), "nice-name.mp4");
    }

    #[test]
    fn resolved_file_name_falls_back_to_basename() {
        let mut r = req();
        r.file_name = None;
        assert_eq!(r.resolved_file_name(), "sample.mp4");
    }
}
