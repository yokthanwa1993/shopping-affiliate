# affiliate-shortlink-cloak-python

Minimal Python CloakBrowser prototype for the affiliate shortlink flow.

This is a parallel prototype, not production. It has no LaunchAgent, no
cloudflared tunnel, no auto-start, and no production wiring. It binds
`127.0.0.1:8811` by default, uses the separate profile root
`~/.affiliate-shortlink-cloak-python/profiles`, and does not touch the active
Node service on port `8810`.

Real shortening is not implemented. `/shorten` validates the request, opens the
headed persistent CloakBrowser context, and returns the placeholder status
`not_implemented_after_login`. No Shopee GraphQL calls are made.

The HTTP server uses only the Python standard library. The optional
`cloakbrowser` import is lazy and happens only when `/login` or `/shorten`
actually launches a browser. The prototype does not use autofill, Keychain,
stored tokens, cookies, or secrets.

## Run

```bash
cd apps/affiliate-shortlink-cloak-python
./scripts/run_dev.sh
```

Equivalent direct command:

```bash
PYTHONPATH=src python3 -m affiliate_shortlink_cloak_python.server
```

Environment overrides:

| Var | Default |
| --- | --- |
| `HOST` | `127.0.0.1` |
| `PORT` | `8811` |
| `PROFILE_ROOT` | `~/.affiliate-shortlink-cloak-python/profiles` |

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness and non-secret config summary |
| `GET` | `/accounts` | Known Shopee account aliases |
| `GET` | `/login?platform=shopee&account=affiliate_chearb.com` | Open headed CloakBrowser at `https://affiliate.shopee.co.th/offer/custom_link` |
| `GET` | `/shorten?id=15130770000&url=https://...` | Validate and return `not_implemented_after_login` after opening the context |

## Known Shopee Aliases

| Shopee id | account | utm_source | display |
| --- | --- | --- | --- |
| `15130770000` | `affiliate_chearb.com` | `an_15130770000` | `affiliate@chearb.com` |
| `15142270000` | `affiliate_neezs.com` | `an_15142270000` | `affiliate@neezs.com` |

## Tests

```bash
./scripts/smoke_local.sh
python3 -m unittest discover -s tests
```

Tests use `unittest` and never launch a browser.
