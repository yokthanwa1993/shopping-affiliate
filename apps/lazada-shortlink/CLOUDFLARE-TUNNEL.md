# Cloudflare Tunnel

This app listens on `http://127.0.0.1:8800`.

## Quick Tunnel

Use this when you want a temporary public URL for testing:

```bash
./tunnel-quick.sh
```

## Real Domain

1. Login to Cloudflare:

```bash
$HOME/.codex/tools/cloudflared/cloudflared tunnel login
```

2. Create a tunnel:

```bash
$HOME/.codex/tools/cloudflared/cloudflared tunnel create lazada-shortlink
```

3. Route a hostname to the tunnel:

```bash
$HOME/.codex/tools/cloudflared/cloudflared tunnel route dns lazada-shortlink short.example.com
```

4. Copy `cloudflared/config.example.yml` to `cloudflared/config.yml` and replace:
   - `REPLACE_WITH_TUNNEL_ID`
   - `REPLACE_WITH_YOUR_USER`
   - `REPLACE_WITH_HOSTNAME`

5. Run the managed tunnel:

```bash
./tunnel-domain.sh
```

## Recommended Security

Put Cloudflare Access in front of the hostname so the API is not publicly open.
