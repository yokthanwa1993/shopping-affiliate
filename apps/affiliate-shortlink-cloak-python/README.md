# affiliate-shortlink-cloak-python

Parallel **prototype** of the CloakBrowser shortlink service, written in Python.
It exists purely for local experimentation and testing.

> ⚠️ **Not production.** This is a throwaway parallel prototype.
> - **No LaunchAgent, no cloudflared tunnel, no auto-start.** Run it by hand.
> - Binds `127.0.0.1:8811` by default — it **does not touch the production Node service on 8810**.
> - Uses a **separate profile root** (`~/.affiliate-shortlink-cloak-python/profiles`) so it never
>   shares or corrupts the production browser profiles.
> - **Real shorten is not implemented yet.** `/shorten` only validates input and reports
>   `not_implemented_after_login`. No Shopee GraphQL calls are made.
> - Never stores/returns secrets, cookies, tokens, or keychain data.

## Requirements

- Python 3.9+
- Standard library only for the HTTP server (no FastAPI).
- `cloakbrowser` is imported **lazily**, only when a browser is actually launched
  (`/login`, best-effort `/shorten`). Tests and `/health`/`/accounts` never import it.

## Run

```bash
cd apps/affiliate-shortlink-cloak-python
./scripts/run_dev.sh
# or:
PYTHONPATH=src python3 -m affiliate_shortlink_cloak_python.server
```

Environment overrides:

| Var | Default | Meaning |
|-----|---------|---------|
| `HOST` | `127.0.0.1` | bind host |
| `PORT` | `8811` | bind port |
| `PROFILE_ROOT` | `~/.affiliate-shortlink-cloak-python/profiles` | browser profile root |

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | liveness + config summary |
| GET | `/accounts` | known Shopee aliases + runtime state (no secrets) |
| GET | `/login?platform=shopee&account=affiliate_chearb.com&json=1` | open a headed CloakBrowser persistent context at the Shopee custom-link page |
| GET | `/shorten?id=...&url=...&account=...` | validate mapping, best-effort open context, return `not_implemented_after_login` |

## Known Shopee aliases

| Shopee id | account | utm_source | display |
|-----------|---------|------------|---------|
| `15130770000` | `affiliate_chearb.com` | `an_15130770000` | `affiliate@chearb.com` |
| `15142270000` | `affiliate_neezs.com` | `an_15142270000` | `affiliate@neezs.com` |

## Tests

```bash
./scripts/smoke_local.sh
# or directly:
PYTHONPATH=src python3 -m pytest -q     # if pytest is installed
PYTHONPATH=src python3 -m unittest discover -s tests -p 'test_*.py'
```

Tests never launch a browser.
