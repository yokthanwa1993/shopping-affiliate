use std::sync::Arc;

use anyhow::{Context, Result};
use async_trait::async_trait;
use telegram_video_storage::{
    config::Config,
    routes::{router, AppState},
    storage::{mock::MockStorage, ArchiveRequest, ArchiveResult, Storage, StorageError},
};
use tokio::net::TcpListener;
use tokio::signal;
use tower_http::trace::TraceLayer;
#[cfg(feature = "real_telegram")]
use tracing::error;
use tracing::{info, warn};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let cfg = Config::from_env();

    info!(
        host = %cfg.host,
        port = cfg.port,
        mock = cfg.mock_mode,
        "telegram-video-storage starting"
    );
    let readiness = cfg.readiness();
    if !readiness.ready {
        warn!(missing = ?readiness.missing, "service starting in NOT-READY state — archive endpoint will refuse");
    }

    let storage = build_storage(&cfg).await;
    let state = Arc::new(AppState {
        config: cfg.clone(),
        storage,
    });

    let app = router(state).layer(TraceLayer::new_for_http());
    let addr = format!("{}:{}", cfg.host, cfg.port);
    let listener = TcpListener::bind(&addr)
        .await
        .with_context(|| format!("bind {addr}"))?;
    info!(%addr, "listening");

    axum::serve(listener, app.into_make_service())
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("axum::serve failed")?;
    info!("shutdown complete");
    Ok(())
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,tower_http=warn"));
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(true))
        .init();
}

async fn build_storage(cfg: &Config) -> Arc<dyn Storage> {
    if cfg.mock_mode {
        info!("storage backend: mock (TELEGRAM_VIDEO_STORAGE_MOCK=1)");
        return Arc::new(MockStorage::new());
    }

    #[cfg(feature = "real_telegram")]
    {
        if !cfg.readiness().ready {
            return Arc::new(NotConfiguredStorage::new(
                "missing required env vars; see /api/config/status".to_string(),
            ));
        }
        return build_telegram_storage(cfg).await;
    }

    #[cfg(not(feature = "real_telegram"))]
    {
        warn!("real_telegram feature disabled at build time; archive endpoint will return 503");
        Arc::new(NotConfiguredStorage::new(
            "binary built without --features real_telegram".to_string(),
        ))
    }
}

#[cfg(feature = "real_telegram")]
async fn build_telegram_storage(cfg: &Config) -> Arc<dyn Storage> {
    use std::path::PathBuf;
    use telegram_video_storage::storage::telegram::{TelegramStorage, TelegramStorageOptions};

    // readiness() guarantees these are Some.
    let api_id = cfg.api_id.expect("readiness checked api_id");
    let api_hash = cfg.api_hash.clone().expect("readiness checked api_hash");
    let session_path = PathBuf::from(
        cfg.session_path
            .clone()
            .expect("readiness checked session_path"),
    );
    let original = cfg
        .original_channel
        .clone()
        .expect("readiness checked original_channel");
    let processed = cfg
        .processed_channel
        .clone()
        .expect("readiness checked processed_channel");

    match TelegramStorage::connect(TelegramStorageOptions {
        api_id,
        api_hash: &api_hash,
        session_path: &session_path,
        original_channel_spec: original,
        processed_channel_spec: processed,
    })
    .await
    {
        Ok(s) => {
            info!("storage backend: telegram (connected)");
            Arc::new(s)
        }
        Err(e) => {
            error!(error = ?e, "failed to connect to Telegram; archive endpoint will return 503");
            Arc::new(NotConfiguredStorage::new(format!("connect failed: {e:#}")))
        }
    }
}

/// Storage that refuses every request with a `503 NotReady`. Used during
/// startup when credentials are missing or when the binary was built without
/// the `real_telegram` feature so `/health` and `/api/config/status` can still
/// be served.
struct NotConfiguredStorage {
    reason: String,
}

impl NotConfiguredStorage {
    fn new(reason: String) -> Self {
        Self { reason }
    }
}

#[async_trait]
impl Storage for NotConfiguredStorage {
    fn name(&self) -> &'static str {
        "not_configured"
    }
    async fn archive_local_file(
        &self,
        _req: ArchiveRequest,
    ) -> Result<ArchiveResult, StorageError> {
        Err(StorageError::NotReady(self.reason.clone()))
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c().await.ok();
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut s) = signal::unix::signal(signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => info!("received SIGINT"),
        _ = terminate => info!("received SIGTERM"),
    }
}
