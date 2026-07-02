const state = {
  status: null,
  selectedFile: null,
  maxUploadBytes: 10 * 1024 * 1024,
};

const els = {
  statusText: document.querySelector('#statusText'),
  botBadge: document.querySelector('#botBadge'),
  channelSelect: document.querySelector('#channelSelect'),
  captionInput: document.querySelector('#captionInput'),
  fileInput: document.querySelector('#fileInput'),
  chooseButton: document.querySelector('#chooseButton'),
  fileMeta: document.querySelector('#fileMeta'),
  uploadButton: document.querySelector('#uploadButton'),
  uploadForm: document.querySelector('#uploadForm'),
  progressBar: document.querySelector('#progressBar'),
  resultPanel: document.querySelector('#resultPanel'),
  resultBody: document.querySelector('#resultBody'),
  indexGrid: document.querySelector('#indexGrid'),
  indexHint: document.querySelector('#indexHint'),
  refreshButton: document.querySelector('#refreshButton'),
  reloadIndexButton: document.querySelector('#reloadIndexButton'),
  syncButton: document.querySelector('#syncButton'),
  limitText: document.querySelector('#limitText'),
};

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function setProgress(value) {
  els.progressBar.style.width = `${Math.max(0, Math.min(100, value))}%`;
}

function setUploadEnabled() {
  const fileOk = Boolean(state.selectedFile);
  const channelOk = Boolean(els.channelSelect.value);
  const sizeOk = !state.selectedFile || state.selectedFile.size <= state.maxUploadBytes;
  els.uploadButton.disabled = !(fileOk && channelOk && sizeOk);
}

function renderStatus(status) {
  state.status = status;
  state.maxUploadBytes = status.maxUploadBytes || state.maxUploadBytes;
  els.limitText.textContent = `Max single attachment: ${formatBytes(state.maxUploadBytes)}`;

  if (!status.configured) {
    els.statusText.textContent = 'Missing Discord bot config';
    els.botBadge.textContent = 'Not configured';
    els.botBadge.classList.remove('ready');
    return;
  }
  if (!status.ready) {
    els.statusText.textContent = status.error || 'Discord bot is connecting';
    els.botBadge.textContent = 'Connecting';
    els.botBadge.classList.remove('ready');
    return;
  }
  els.statusText.textContent = status.bot ? `Connected as ${status.bot.tag}` : 'Connected';
  els.botBadge.textContent = 'Ready';
  els.botBadge.classList.add('ready');
}

function renderChannels(channels) {
  const previous = els.channelSelect.value;
  els.channelSelect.innerHTML = '';
  for (const channel of channels) {
    const option = document.createElement('option');
    option.value = channel.id;
    option.disabled = !channel.canUpload;
    option.textContent = `${channel.isDefault ? '* ' : ''}#${channel.name}${channel.canUpload ? '' : ' (no upload permission)'}`;
    els.channelSelect.append(option);
  }
  const defaultChannel = channels.find((c) => c.isDefault && c.canUpload)
    || channels.find((c) => c.canUpload);
  els.channelSelect.value = previous || defaultChannel?.id || '';
  setUploadEnabled();
}

async function loadStatus() {
  const response = await fetch('/api/status');
  const status = await response.json();
  renderStatus(status);
  renderChannels(status.channels || []);
  await loadIndex();
}

// The gallery is driven by the LOCAL SQLite index, not a live Discord fetch.
async function loadIndex() {
  const channelId = els.channelSelect.value;
  const query = channelId ? `?channelId=${encodeURIComponent(channelId)}&limit=100` : '?limit=100';
  els.indexGrid.innerHTML = '<div class="empty">Loading index</div>';
  const response = await fetch(`/api/media-items${query}`);
  const data = await response.json();

  if (!response.ok) {
    els.indexGrid.innerHTML = `<div class="empty error">${escapeHtml(data.error || 'Failed to load index')}</div>`;
    return;
  }
  const items = data.items || [];
  els.indexHint.textContent = channelId
    ? `${items.length} indexed item(s) for the selected channel · namespace ${data.namespaceId}`
    : `${items.length} indexed item(s) · namespace ${data.namespaceId}`;

  if (items.length === 0) {
    els.indexGrid.innerHTML = '<div class="empty">Nothing indexed yet — upload a file or run “Sync channel”.</div>';
    return;
  }

  els.indexGrid.innerHTML = items.map((item) => {
    const isVideo = String(item.content_type || '').startsWith('video/')
      || /\.(mp4|mov|m4v|webm)$/i.test(item.filename || '');
    const hasLocal = Boolean(item.local_path);
    const localUrl = `/api/local-media/${item.id}/file`;
    const freshUrl = `/api/media/${item.channel_id}/${item.message_id}/${item.attachment_id}`;
    const previewSrc = hasLocal ? localUrl : freshUrl;
    const media = isVideo
      ? `<video class="media-thumb" src="${previewSrc}" controls muted preload="metadata"></video>`
      : `<img class="media-thumb" src="${previewSrc}" alt="" loading="lazy">`;

    return `
      <article class="media-item">
        ${media}
        <div class="media-caption">
          <strong title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</strong>
          <span class="meta">${formatBytes(item.size)} · ${escapeHtml(item.status || 'indexed')}</span>
          <div class="links">
            ${hasLocal ? `<a href="${localUrl}" target="_blank" rel="noreferrer">Local file</a>` : '<span class="meta">no mirror</span>'}
            <a href="${freshUrl}" target="_blank" rel="noreferrer">Fresh URL</a>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

async function syncChannel() {
  const channelId = els.channelSelect.value;
  if (!channelId) {
    alert('Select a channel first');
    return;
  }
  els.syncButton.disabled = true;
  els.syncButton.textContent = 'Syncing…';
  try {
    const response = await fetch('/api/sync-channel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, limit: 100 }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Sync failed');
    els.indexHint.textContent =
      `Synced ${data.total}: ${data.downloaded} downloaded, ${data.skipped} already local, ${data.failed} index-only`;
    await loadIndex();
  } catch (error) {
    alert(error.message);
  } finally {
    els.syncButton.disabled = false;
    els.syncButton.textContent = 'Sync channel';
  }
}

function renderFileMeta(file) {
  if (!file) {
    els.fileMeta.textContent = 'No file selected';
    return;
  }
  const tooLarge = file.size > state.maxUploadBytes;
  els.fileMeta.innerHTML = `
    <strong>${escapeHtml(file.name)}</strong>
    <span class="${tooLarge ? 'error' : 'meta'}">${formatBytes(file.size)}</span>
  `;
}

function renderResult(result) {
  els.resultPanel.hidden = false;
  els.resultBody.className = 'result-body';
  const localFileUrl = result.localFileUrl;
  els.resultBody.innerHTML = `
    <div>
      <strong>${escapeHtml(result.filename)}</strong>
      <div class="meta">${formatBytes(result.size)} · ${escapeHtml(result.contentType || 'media')} · ${escapeHtml(result.status || 'indexed')}</div>
    </div>
    <div class="result-actions">
      <a href="${result.jumpUrl}" target="_blank" rel="noreferrer">Open Message</a>
      <a href="${result.proxyUrl}" target="_blank" rel="noreferrer">Fresh URL</a>
      ${localFileUrl ? `<a href="${localFileUrl}" target="_blank" rel="noreferrer">Local file</a>` : ''}
    </div>
  `;
}

function uploadWithProgress(formData) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/upload');
    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      setProgress((event.loaded / event.total) * 100);
    });
    request.addEventListener('load', () => {
      const data = JSON.parse(request.responseText || '{}');
      if (request.status >= 200 && request.status < 300) resolve(data);
      else reject(new Error(data.error || 'Upload failed'));
    });
    request.addEventListener('error', () => reject(new Error('Network upload failed')));
    request.send(formData);
  });
}

els.chooseButton.addEventListener('click', () => els.fileInput.click());

els.fileInput.addEventListener('change', () => {
  state.selectedFile = els.fileInput.files?.[0] || null;
  renderFileMeta(state.selectedFile);
  setUploadEnabled();
});

els.channelSelect.addEventListener('change', async () => {
  setUploadEnabled();
  await loadIndex();
});

els.uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.selectedFile) return;

  const formData = new FormData();
  formData.append('file', state.selectedFile);
  formData.append('channelId', els.channelSelect.value);
  formData.append('caption', els.captionInput.value);

  els.uploadButton.disabled = true;
  els.uploadButton.textContent = 'Uploading...';
  setProgress(0);

  try {
    const result = await uploadWithProgress(formData);
    renderResult(result);
    els.fileInput.value = '';
    state.selectedFile = null;
    renderFileMeta(null);
    await loadIndex();
  } catch (error) {
    alert(error.message);
  } finally {
    setProgress(0);
    els.uploadButton.textContent = 'Upload to Discord';
    setUploadEnabled();
  }
});

els.refreshButton.addEventListener('click', loadStatus);
els.reloadIndexButton.addEventListener('click', loadIndex);
els.syncButton.addEventListener('click', syncChannel);

loadStatus().catch((error) => {
  els.statusText.textContent = error.message;
  els.botBadge.textContent = 'Error';
});
