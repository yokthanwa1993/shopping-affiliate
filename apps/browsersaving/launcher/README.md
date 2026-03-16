# BrowserSaving Remote Launcher

Prototype service for opening BrowserSaving profiles on Ubuntu through KasmVNC and Google Chrome.

## What it does

- Starts one KasmVNC session per BrowserSaving profile.
- Launches Chrome with a dedicated `--user-data-dir`.
- Proxies the per-session KasmVNC port behind a single HTTP port, so CapRover only has to expose one app port.
- Downloads browser archives from the existing BrowserSaving Worker on launch and uploads them back on stop.
- Verifies BrowserSaving session tokens against the Worker for `launch`, `stop`, and `status` requests.
- Issues a random viewer token per session and bakes it into the KasmVNC URL path opened by the dashboard.

## API

- `GET /health`
- `GET /api/status`
- `POST /api/sessions/launch`
- `DELETE /api/sessions/:profileId`
- `GET /kasm/:profileId/:viewerToken/vnc.html`

Launch body:

```json
{
  "profile": {
    "id": "uuid",
    "name": "Profile Name",
    "homepage": "https://facebook.com"
  },
  "url": "https://example.com"
}
```

## CapRover notes

- Persist `/data` so Chrome user data and session metadata survive container restarts.
- Set `SESSION_PUBLIC_BASE_URL` to the public app URL, for example `https://launcher.example.com`.
- Point the dashboard to this service with `VITE_REMOTE_LAUNCHER_URL`.
- The dashboard must log in through the BrowserSaving Worker first; the launcher validates `x-auth-token` with `GET /api/me`.

## Environment

- `PORT`: control/proxy port. Default `8080`.
- `SESSION_ROOT`: persistent root for KasmVNC and Chrome data. Default `/data/sessions`.
- `SESSION_PUBLIC_BASE_URL`: public origin used in generated viewer URLs.
- `SESSION_PATH_PREFIX`: proxy prefix for KasmVNC sessions. Default `/kasm`.
- `WORKER_URL`: BrowserSaving Worker base URL for sync.
- `DISPLAY_START` / `DISPLAY_END`: X display range.
- `KASM_PORT_START` / `KASM_PORT_END`: local KasmVNC port range.
- `CHROME_BIN`: Chrome binary path.
- `VNC_BIN`: KasmVNC `vncserver` path.

## Known limits

- Automatic sync back to Worker happens on explicit stop. If the whole container crashes, local changes may not upload.
- KasmVNC package URL is pinned in the Docker build arg. Update `KASMVNC_DEB_URL` when you move to a newer release.
- KasmVNC is reverse-proxied under a path prefix. If a future KasmVNC release changes asset or websocket paths, the proxy rewrite may need adjustment.
