use axum::{
    routing::{get, post},
    Router, Json,
};
use tower_http::cors::CorsLayer;
use serde_json::json;

mod merge;
mod xhs;
mod pipeline;
mod version;

fn build_id() -> String {
    if let Ok(v) = std::env::var("VIDEO_AFFILIATE_BUILD_ID") {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(meta) = std::fs::metadata("/app/merge-rust") {
        if let Ok(modified) = meta.modified() {
            if let Ok(ts) = modified.duration_since(std::time::UNIX_EPOCH) {
                return format!("bin-mtime-{}", ts.as_secs());
            }
        }
    }
    "unknown".to_string()
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let app = Router::new()
        .route("/health", get(health_check))
        .route("/merge", post(merge::handle_merge))
        .route("/xhs/resolve", post(xhs::handle_resolve))
        .route("/pipeline", post(pipeline::handle_pipeline))
        .layer(CorsLayer::permissive());

    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".to_string());
    let addr = format!("0.0.0.0:{}", port);
    println!(
        "[CONTAINER] Starting video-affiliate merge container on port {} (build={}, pipeline_engine_version={})",
        port,
        build_id(),
        version::PIPELINE_ENGINE_VERSION
    );
    
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn health_check() -> Json<serde_json::Value> {
    let mut ffmpeg_ok = false;
    if let Ok(output) = tokio::process::Command::new("ffmpeg").arg("-version").output().await {
        if output.status.success() {
            ffmpeg_ok = true;
        }
    }

    Json(json!({
        "status": if ffmpeg_ok { "ok" } else { "error" },
        "service": "video-affiliate-merge-container",
        "ffmpeg": ffmpeg_ok,
        "build": build_id(),
        "pipeline_engine_version": version::PIPELINE_ENGINE_VERSION,
    }))
}
