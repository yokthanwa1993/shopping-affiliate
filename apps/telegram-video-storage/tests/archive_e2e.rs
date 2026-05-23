//! End-to-end happy path: mock backend, ready config, real temp file →
//! 200 OK with the documented manifest shape.

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::json;
use telegram_video_storage::{
    config::Config,
    routes::{router, AppState},
    storage::{mock::MockStorage, Storage},
};
use tokio::io::AsyncWriteExt;
use tower::ServiceExt;

#[tokio::test]
async fn archive_local_file_returns_manifest() {
    let dir = std::env::temp_dir().join(format!(
        "tvs-e2e-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let path = dir.join("clip.mp4");
    let mut f = tokio::fs::File::create(&path).await.unwrap();
    f.write_all(b"fake-mp4-bytes").await.unwrap();
    f.flush().await.unwrap();

    let cfg = Config::from_map(|k| match k {
        "TELEGRAM_VIDEO_STORAGE_MOCK" => Some("1".into()),
        _ => None,
    });
    let storage: Arc<dyn Storage> = Arc::new(MockStorage::new());
    let app = router(Arc::new(AppState {
        config: cfg,
        storage,
    }));

    let payload = json!({
        "path": path.to_string_lossy(),
        "kind": "original",
        "videoId": "vid-001",
        "namespaceId": "ns-A",
        "fileName": "renamed.mp4"
    });
    let resp = app
        .oneshot(
            Request::post("/api/archive/local-file")
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

    assert_eq!(body["storage"], "mock");
    assert_eq!(body["kind"], "original");
    assert_eq!(body["videoId"], "vid-001");
    assert_eq!(body["namespaceId"], "ns-A");
    assert_eq!(body["fileName"], "renamed.mp4");
    assert_eq!(body["size"], 14);
    assert!(body["messageId"].is_number());
    assert!(body["channelId"].is_string());
    assert!(body["createdAt"].is_string());
}
