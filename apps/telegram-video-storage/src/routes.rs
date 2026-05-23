use std::sync::Arc;

use axum::{
    extract::{Json, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use serde::Serialize;
use serde_json::json;

use crate::{
    config::{AuthCheck, Config},
    storage::{ArchiveRequest, Storage, StorageError, ValidationError},
};

pub struct AppState {
    pub config: Config,
    pub storage: Arc<dyn Storage>,
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/config/status", get(config_status))
        .route("/api/archive/local-file", post(archive_local_file))
        .with_state(state)
}

#[derive(Serialize)]
struct Health {
    ok: bool,
    ready: bool,
    mode: &'static str,
    missing: Vec<String>,
}

async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let r = state.config.readiness();
    (
        StatusCode::OK,
        Json(Health {
            ok: true,
            ready: r.ready,
            mode: r.mode,
            missing: r.missing,
        }),
    )
}

async fn config_status(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    (StatusCode::OK, Json(state.config.redacted_status()))
}

fn extract_api_key(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .or_else(|| {
            headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.strip_prefix("Bearer "))
        })
}

async fn archive_local_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<ArchiveRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let presented = extract_api_key(&headers);
    if state.config.check_api_key(presented) == AuthCheck::Unauthorized {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error": "unauthorized",
                "message": "missing or invalid x-api-key"
            })),
        );
    }

    let readiness = state.config.readiness();
    if !readiness.ready {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "telegram_not_ready",
                "missing": readiness.missing,
                "mode": readiness.mode,
            })),
        );
    }

    if let Err(e) = req.validate() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid_request", "message": e.to_string() })),
        );
    }

    match state.storage.archive_local_file(req).await {
        Ok(result) => (
            StatusCode::OK,
            Json(serde_json::to_value(result).unwrap_or_else(|_| json!({"error": "serialize"}))),
        ),
        Err(StorageError::FileNotFound(p)) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "file_not_found", "path": p })),
        ),
        Err(StorageError::Validation(v)) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid_request", "message": v.to_string() })),
        ),
        Err(StorageError::NotReady(msg)) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "telegram_not_ready", "message": msg })),
        ),
        Err(StorageError::Upload(msg)) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "upload_failed", "message": msg })),
        ),
        Err(StorageError::Io(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "io", "message": e.to_string() })),
        ),
    }
}

// Allow `?` against ValidationError without losing the StorageError boundary.
#[allow(dead_code)]
fn _validation_into_storage(e: ValidationError) -> StorageError {
    StorageError::Validation(e)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::mock::MockStorage;
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    fn make_state(cfg: Config, storage: Arc<dyn Storage>) -> Arc<AppState> {
        Arc::new(AppState {
            config: cfg,
            storage,
        })
    }

    fn cfg_ready() -> Config {
        Config::from_map(|k| match k {
            "TELEGRAM_API_ID" => Some("1".into()),
            "TELEGRAM_API_HASH" => Some("h".into()),
            "TELEGRAM_SESSION_PATH" => Some("/tmp/s".into()),
            "TELEGRAM_ORIGINAL_CHANNEL_ID" => Some("@o".into()),
            "TELEGRAM_PROCESSED_CHANNEL_ID" => Some("@p".into()),
            _ => None,
        })
    }

    fn cfg_mock_with_key(key: &str) -> Config {
        let key = key.to_string();
        Config::from_map(move |k| match k {
            "TELEGRAM_VIDEO_STORAGE_MOCK" => Some("1".into()),
            "TELEGRAM_VIDEO_STORAGE_API_KEY" => Some(key.clone()),
            _ => None,
        })
    }

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn health_reports_ready_when_configured() {
        let app = router(make_state(cfg_ready(), Arc::new(MockStorage::new())));
        let resp = app
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert_eq!(body["ok"], true);
        assert_eq!(body["ready"], true);
    }

    #[tokio::test]
    async fn health_reports_not_ready_when_missing_fields() {
        let cfg = Config::from_map(|_| None);
        let app = router(make_state(cfg, Arc::new(MockStorage::new())));
        let resp = app
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert_eq!(body["ready"], false);
        let missing = body["missing"].as_array().unwrap();
        assert!(missing.iter().any(|v| v == "TELEGRAM_API_ID"));
    }

    #[tokio::test]
    async fn config_status_redacts_secrets() {
        let cfg = Config::from_map(|k| match k {
            "TELEGRAM_API_HASH" => Some("topsecret".into()),
            "TELEGRAM_VIDEO_STORAGE_API_KEY" => Some("supersecret".into()),
            _ => None,
        });
        let app = router(make_state(cfg, Arc::new(MockStorage::new())));
        let resp = app
            .oneshot(
                Request::get("/api/config/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        assert!(!text.contains("topsecret"));
        assert!(!text.contains("supersecret"));
    }

    #[tokio::test]
    async fn archive_returns_503_when_not_ready() {
        let cfg = Config::from_map(|_| None);
        let app = router(make_state(cfg, Arc::new(MockStorage::new())));
        let payload = json!({
            "path": "/tmp/x.mp4",
            "kind": "original",
            "videoId": "v"
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
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = body_json(resp).await;
        assert_eq!(body["error"], "telegram_not_ready");
    }

    #[tokio::test]
    async fn archive_requires_api_key_when_configured() {
        let app = router(make_state(
            cfg_mock_with_key("hunter2"),
            Arc::new(MockStorage::new()),
        ));
        let payload = json!({
            "path": "/tmp/x.mp4",
            "kind": "original",
            "videoId": "v"
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
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn archive_validation_error_returns_400() {
        let app = router(make_state(
            cfg_mock_with_key("k"),
            Arc::new(MockStorage::new()),
        ));
        let payload = json!({
            "path": "relative.mp4",
            "kind": "original",
            "videoId": "v"
        });
        let resp = app
            .oneshot(
                Request::post("/api/archive/local-file")
                    .header("content-type", "application/json")
                    .header("x-api-key", "k")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let body = body_json(resp).await;
        assert_eq!(body["error"], "invalid_request");
    }

    #[tokio::test]
    async fn archive_returns_404_when_file_missing() {
        let app = router(make_state(
            cfg_mock_with_key("k"),
            Arc::new(MockStorage::new()),
        ));
        let payload = json!({
            "path": "/tmp/__does_not_exist_telegram_video__.mp4",
            "kind": "original",
            "videoId": "v"
        });
        let resp = app
            .oneshot(
                Request::post("/api/archive/local-file")
                    .header("content-type", "application/json")
                    .header("x-api-key", "k")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
}
