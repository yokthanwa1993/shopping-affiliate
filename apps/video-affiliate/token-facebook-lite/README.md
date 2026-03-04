# token-facebook-lite

Cloudflare Containers service for generating Facebook Lite token from credential payload.

## Endpoints

- `GET /healthz` (Worker health)
- `GET /health` (Container app health)
- `POST /token` (Container app token generation)

### `POST /token` body

```json
{
  "identifier": "uid-or-email",
  "password": "plain-password-or-#PWD_FB4A",
  "twofa": "BASE32_TOTP_SECRET",
  "datr": "optional-machine-id",
  "target_app": "FB_LITE",
  "timeout_seconds": 30
}
```

## Local build check

```bash
cd token-facebook-lite
python3 -m py_compile app/main.py
npm install
npm run check
```

## Deploy

```bash
cd token-facebook-lite
wrangler containers build . --tag token-facebook-lite:v1
docker tag token-facebook-lite:v1 token-facebook-lite:v1
wrangler containers push token-facebook-lite:v1
npx wrangler deploy
```
