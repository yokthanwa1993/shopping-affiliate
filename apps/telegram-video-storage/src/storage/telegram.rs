//! Real Telegram backend using the `grammers` crates.
//!
//! Auth model mirrors `caamer20/Telegram-Drive`:
//!   * Session is a file-backed `grammers_session::Session`.
//!   * Operator must log in once via an interactive helper (out of scope for
//!     this pilot) and drop the resulting `.session` file at
//!     `TELEGRAM_SESSION_PATH`. We refuse to start unauthorized.
//!
//! Upload path mirrors `Telegram-Drive/app/src-tauri/src/commands/fs.rs`:
//!   * `client.upload_stream(&mut reader, size, name)` → `Uploaded`
//!   * `InputMessage::default().file(uploaded)` → send to resolved channel.

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use chrono::Utc;
use grammers_client::{
    types::{Chat, Message},
    Client, Config as ClientConfig, InitParams, InputMessage,
};
use grammers_session::Session;
use tokio::fs::File;
use tracing::{info, warn};

use super::{ArchiveRequest, ArchiveResult, Kind, Storage, StorageError};

pub struct TelegramStorage {
    client: Client,
    original_channel_spec: String,
    processed_channel_spec: String,
}

pub struct TelegramStorageOptions<'a> {
    pub api_id: i32,
    pub api_hash: &'a str,
    pub session_path: &'a Path,
    pub original_channel_spec: String,
    pub processed_channel_spec: String,
}

impl TelegramStorage {
    pub async fn connect(opts: TelegramStorageOptions<'_>) -> Result<Self> {
        let session = Session::load_file_or_create(opts.session_path)
            .with_context(|| format!("failed to load session at {:?}", opts.session_path))?;

        info!(target: "telegram-video-storage", "connecting to Telegram MTProto...");
        let client = Client::connect(ClientConfig {
            session,
            api_id: opts.api_id,
            api_hash: opts.api_hash.to_string(),
            params: InitParams {
                catch_up: false,
                ..Default::default()
            },
        })
        .await
        .context("Client::connect failed")?;

        if !client
            .is_authorized()
            .await
            .context("is_authorized check failed")?
        {
            return Err(anyhow!(
                "Telegram session at {:?} is not authorized; run the interactive auth helper to log in first",
                opts.session_path
            ));
        }
        info!(target: "telegram-video-storage", "Telegram session authorized");

        Ok(Self {
            client,
            original_channel_spec: opts.original_channel_spec,
            processed_channel_spec: opts.processed_channel_spec,
        })
    }

    fn channel_spec_for(&self, kind: Kind) -> &str {
        match kind {
            Kind::Original => &self.original_channel_spec,
            Kind::Processed => &self.processed_channel_spec,
        }
    }

    async fn resolve_chat(&self, spec: &str) -> Result<Chat> {
        let trimmed = spec.trim();
        if trimmed.is_empty() {
            return Err(anyhow!("empty channel spec"));
        }
        let stripped = trimmed.trim_start_matches('@');

        // Numeric id (e.g. -100123456789 or 123456789) → look up in dialogs.
        if let Ok(target_id) = stripped.parse::<i64>() {
            let mut dialogs = self.client.iter_dialogs();
            while let Some(dialog) = dialogs
                .next()
                .await
                .context("iter_dialogs failed while searching by id")?
            {
                if dialog.chat().id() == target_id {
                    return Ok(dialog.chat().clone());
                }
            }
            return Err(anyhow!(
                "channel id {target_id} not found in this account's dialogs; make sure the session user is a member"
            ));
        }

        // Otherwise treat as public username.
        match self
            .client
            .resolve_username(stripped)
            .await
            .with_context(|| format!("resolve_username failed for @{stripped}"))?
        {
            Some(chat) => Ok(chat),
            None => Err(anyhow!("could not resolve @{stripped}")),
        }
    }

    async fn upload_and_send(
        &self,
        chat: &Chat,
        local_path: &str,
        size: u64,
        file_name: &str,
    ) -> Result<Message> {
        let mut file = File::open(local_path)
            .await
            .with_context(|| format!("open {local_path}"))?;
        let uploaded = self
            .client
            .upload_stream(&mut file, size as usize, file_name.to_string())
            .await
            .with_context(|| format!("upload_stream {file_name}"))?;
        let message = InputMessage::default().file(uploaded);
        self.client
            .send_message(chat, message)
            .await
            .context("send_message failed")
    }
}

#[async_trait]
impl Storage for TelegramStorage {
    fn name(&self) -> &'static str {
        "telegram"
    }

    async fn archive_local_file(&self, req: ArchiveRequest) -> Result<ArchiveResult, StorageError> {
        req.validate()?;

        let spec = self.channel_spec_for(req.kind);
        if spec.trim().is_empty() {
            return Err(StorageError::NotReady(format!(
                "no channel configured for kind={}",
                req.kind.as_str()
            )));
        }

        let meta = tokio::fs::metadata(&req.path)
            .await
            .map_err(|_| StorageError::FileNotFound(req.path.clone()))?;
        if !meta.is_file() {
            return Err(StorageError::FileNotFound(req.path.clone()));
        }
        let size = meta.len();
        let file_name = req.resolved_file_name();

        let chat = self
            .resolve_chat(spec)
            .await
            .map_err(|e| StorageError::Upload(format!("resolve channel: {e:#}")))?;

        let sent = self
            .upload_and_send(&chat, &req.path, size, &file_name)
            .await
            .map_err(|e| {
                warn!(target: "telegram-video-storage", error = %e, "upload_and_send failed");
                StorageError::Upload(format!("{e:#}"))
            })?;

        Ok(ArchiveResult {
            storage: "telegram",
            kind: req.kind.as_str(),
            video_id: req.video_id,
            namespace_id: req.namespace_id,
            channel_id: chat.id().to_string(),
            message_id: sent.id() as i64,
            file_name,
            size,
            created_at: Utc::now(),
        })
    }
}
