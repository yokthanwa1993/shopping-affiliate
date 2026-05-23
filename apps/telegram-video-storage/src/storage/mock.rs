use std::sync::atomic::{AtomicI64, Ordering};

use async_trait::async_trait;
use chrono::Utc;
use tokio::fs;

use super::{ArchiveRequest, ArchiveResult, Storage, StorageError};

/// In-process backend that does not talk to Telegram. Used when
/// `TELEGRAM_VIDEO_STORAGE_MOCK=1` so operators can validate plumbing
/// end-to-end without burning a real session. It reads the file's metadata so
/// the response still reflects a real file size, and assigns a monotonic fake
/// message id starting at 1.
pub struct MockStorage {
    counter: AtomicI64,
    channel_label: String,
}

impl MockStorage {
    pub fn new() -> Self {
        Self {
            counter: AtomicI64::new(0),
            channel_label: "mock-channel".to_string(),
        }
    }
}

impl Default for MockStorage {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Storage for MockStorage {
    fn name(&self) -> &'static str {
        "mock"
    }

    async fn archive_local_file(&self, req: ArchiveRequest) -> Result<ArchiveResult, StorageError> {
        req.validate()?;
        let meta = fs::metadata(&req.path)
            .await
            .map_err(|_| StorageError::FileNotFound(req.path.clone()))?;
        if !meta.is_file() {
            return Err(StorageError::FileNotFound(req.path.clone()));
        }
        let message_id = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        Ok(ArchiveResult {
            storage: "mock",
            kind: req.kind.as_str(),
            video_id: req.video_id.clone(),
            namespace_id: req.namespace_id.clone(),
            channel_id: self.channel_label.clone(),
            message_id,
            file_name: req.resolved_file_name(),
            size: meta.len(),
            created_at: Utc::now(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Kind;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn returns_file_size_and_monotonic_message_id() {
        let dir = tempdir_in_target().await;
        let path = dir.join("sample.mp4");
        let mut f = tokio::fs::File::create(&path).await.unwrap();
        f.write_all(b"video-payload").await.unwrap();
        f.flush().await.unwrap();

        let storage = MockStorage::new();
        let req = ArchiveRequest {
            path: path.to_string_lossy().to_string(),
            kind: Kind::Original,
            video_id: "v1".to_string(),
            namespace_id: None,
            file_name: None,
        };
        let r1 = storage.archive_local_file(req.clone()).await.unwrap();
        assert_eq!(r1.storage, "mock");
        assert_eq!(r1.size, 13);
        assert_eq!(r1.kind, "original");
        assert_eq!(r1.file_name, "sample.mp4");
        assert_eq!(r1.message_id, 1);

        let r2 = storage.archive_local_file(req).await.unwrap();
        assert_eq!(r2.message_id, 2);
    }

    #[tokio::test]
    async fn missing_file_returns_not_found() {
        let storage = MockStorage::new();
        let req = ArchiveRequest {
            path: "/tmp/__nope_does_not_exist__.mp4".to_string(),
            kind: Kind::Processed,
            video_id: "v".to_string(),
            namespace_id: None,
            file_name: None,
        };
        let err = storage.archive_local_file(req).await.unwrap_err();
        assert!(matches!(err, StorageError::FileNotFound(_)));
    }

    async fn tempdir_in_target() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        p.push(format!("tvs-test-{nonce}"));
        tokio::fs::create_dir_all(&p).await.unwrap();
        p
    }
}
