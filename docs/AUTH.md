# Authentication & credential isolation

The plugin supports the system-wide primary sign-in and isolated multi-account pool slots (`PoolAuthFlow`). State machine: [`.spec/credential-lifecycle.md`](../.spec/credential-lifecycle.md).

## Flows

1. **In-GUI / `/agy auth` PKCE OAuth (`PoolAuthFlow`):** standard PKCE (`S256`) consent URL with a loopback listener on `127.0.0.1:51121` (manual code/URL paste fallback); code exchanged directly with `oauth2.googleapis.com/token` (sending `agyUserAgent()`, honoring per-account proxy). Token written atomically (`0600` + `.bak`) in agy's native JSON format — `~/.dsh/agy-accounts/<id>/.gemini/antigravity-cli/antigravity-oauth-token` for isolated accounts, or system `HOME` + OS keyring for the primary.
2. **Refresh-token import (`/agy import` / GUI Import):** exchanges a `refresh_token` or token JSON, verifies identity via `userinfo`, updates matching accounts in place (or commits a new slot), and lifts stale `authRequired` / cooldown flags.

## Keyring isolation

- **macOS / Linux:** secondary accounts run with isolated `HOME` and silent per-account login keychains (`ensureIsolatedKeychain`), so `go-keyring` never prompts or touches the primary keychain.
- **Windows:** agy reads one machine-wide Credential Manager entry (`gemini:antigravity`). `acquireCredentialSlot` serializes cross-identity handoffs (in-process refcount + cross-process lockfile), verifies grant fingerprints (`sameCredentialGrant`), and restores the verified primary credential after startup.

## Hygiene & anti-false-quarantine

- Network/proxy/HTTP2/keyring-timeout blips (`looksLikeNetworkError`, `looksLikeAuthVerificationJitter`) classify as `NETWORK`, never `AUTH`.
- Non-authoritative sign-out banners require `AUTH_CONFIRM_STRIKES = 2` consecutive confirmations before setting `authRequired`.
- Terminal `TOS_VIOLATION` quarantines only the affected account and halts automatic failover to prevent IP-correlated sweeps.
- `/agy doctor` redacts OAuth URLs, `4/...`, `ya29.*`, `1//...`, JWTs, API keys, and proxy credentials before writing to disk.
