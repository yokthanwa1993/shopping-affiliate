# affiliate-credential-vault

Side-by-side local Credential Vault for AFFILIATE operations. It unifies Facebook and Shopee credential management in one localhost UI with top tabs.

- Default: `http://127.0.0.1:8840/`
- Secrets are write-only and stored in macOS Generic Keychain under `com.affiliate.credential-vault.*`.
- Non-secret registry metadata is stored outside git at `~/.affiliate-credential-vault/registry.json` with mode `0600`.
- Shopee shortlink calls the existing bridge on `127.0.0.1:8810`, but when a profile alias is selected it omits `id` by default to avoid the old hard-map conflict (`15130770000 -> affiliate_chearb.com`).

## Run

```sh
npm --prefix apps/affiliate-credential-vault start
```

## Check

```sh
npm --prefix apps/affiliate-credential-vault run check
npm --prefix apps/affiliate-credential-vault test
```
