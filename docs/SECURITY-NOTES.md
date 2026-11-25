# Security Notes

Threat model and boundaries. Authoritative specs: [`.spec/security-hardening.md`](../.spec/security-hardening.md), [`.spec/quota-and-risk-control.md`](../.spec/quota-and-risk-control.md).

## Process execution & risk control

- Only the official `agy` binary (config `agyBin`, `PATH`, or `~/.local/bin`) is executed for inference and quota probes. No shell interpolation (`spawn` with explicit `argv`, NUL-stripping, detached process-group cleanup).
- Node never sends spoofed inference requests or chimeric headers to Google. `undici` (per-account proxy) is used only for OAuth token refresh/userinfo and consumer quota summary reads (`daily-cloudcode-pa.googleapis.com` + sandbox failover).
- `skip` auto-approves ordinary agy tool prompts inside the session workspace while preserving agy's system protections. In `plan`/`accept-edits` print mode, interactive prompts are denied with an actionable hint (#121).

## Credential protection

- Per-account tokens and `.bak` backups are written atomically with `0600`; Windows handoffs verify refresh-token fingerprints (`sameCredentialGrant`) so foreign tokens cannot overwrite an account file.
- DSH-side API keys and other providers' credentials are never read or modified.
- `/agy doctor` strips Google auth URLs, `4/...` codes, `ya29.*` tokens, `1//...` refresh tokens, JWTs, API keys, and proxy credentials before writing diagnostics.

## Local HTTP surface

- Loopback Origin enforcement: non-loopback `Origin` rejected (`403`); no `Access-Control-Allow-Origin: *` on `/media`, `/open`, `/assets`.
- `/plugins/agy-link/open` is `POST`-only, confined via `realpathSync` to active workspace/media/brain dirs, blocks sensitive paths (`.ssh`, `.aws`, `.gnupg`, `.kube`, `.dsh`, `.gemini/antigravity-cli`, `.env`, keys), refuses executables, and passes Windows targets via env var (`-LiteralPath`).
- `/plugins/agy-link/embed` serves only confined local `.html` (≤2 MiB) with strict CSP (`default-src 'none'`, `connect-src 'none'`, allowlisted Tailwind CDN only) in a sandboxed `<iframe sandbox="allow-scripts">` (no `allow-same-origin`).
- Request bodies capped (1 MiB plugin routes, 8 MiB loopback MCP `/call`); the MCP bridge requires a constant-time bearer token plus `mcpToolAllowlist` and excludes internal tools (`run_code`, `agy_ask`, `agy_tool`).
