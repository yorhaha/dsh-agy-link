<h1 align="center">🛰️ dsh-agy-link</h1>

<p align="center">
  <b>DeepSeek Harness × Google Antigravity</b> — multi-account pooling and native <code>agy</code> CLI / ACP bridge for DSH
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-agy-link"><img src="https://img.shields.io/npm/v/dsh-agy-link?color=cb3837&label=npm&logo=npm" alt="npm"/></a>
  <a href="https://github.com/amlyczz/dsh-agy-link/actions/workflows/ci.yml"><img src="https://github.com/amlyczz/dsh-agy-link/actions/workflows/ci.yml/badge.svg" alt="CI"/></a>
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="MIT"/>
  <img src="https://img.shields.io/badge/node-%3E%3D24-green" alt="node"/>
  <img src="https://img.shields.io/badge/agy-%3E%3D1.5-purple" alt="agy >=1.5"/>
</p>

<p align="center">
  <a href="../README.md">中文</a> ·
  English ·
  <a href="./CONFIGURATION.md">Configuration</a> ·
  <a href="./ARCHITECTURE.md">Architecture</a> ·
  <a href="./SECURITY-NOTES.md">Security</a>
</p>

---

Bring **Google Antigravity models into DeepSeek Harness (DSH)** through the official, unmodified `agy` CLI: streaming, thinking, native tool cards, Generative UI embeds, 1M context metering, in-GUI OAuth, per-family multi-account pooling with failover, CLI-first multi-bucket quota tracking, and multimodal attachments.

<p align="center">
  <img src="./assets/console.png" alt="Antigravity console" width="760" />
</p>
<p align="center">
  <img src="./assets/model-picker.png" alt="Model picker" width="240" />
  &nbsp;&nbsp;
  <img src="./assets/models-orchestrator.png" alt="Models & Orchestrator" width="520" />
</p>
<p align="center">
  <img src="./assets/settings.png" alt="Features & UI" width="380" />
  &nbsp;&nbsp;
  <img src="./assets/token-usage.png" alt="Token usage" width="330" />
</p>

---

## ✨ Features

| | |
| --- | --- |
| 🤖 **Models & 4-tab console** | Syncs the `agy` lineup (incl. `Gemini 4 Carbon`, `Orchestrator`), allow-list (`selectedModels`), `poolWideCatalog` routing, `--effort` refusal learning, Planner/Executor overrides. |
| 🔁 **Per-family pool** | Independent pins and cooldowns across `Gemini`/`Argon`/`Claude`/`GPT-OSS`; sequential drain or round-robin with quota-expiry-first rotation, isolated HOME + proxy, Windows identity-leased slots. |
| 📊 **CLI-first quota** | Prefers `agy -p /usage` (`quotaViaCli`) with summary fallback; 5h / 7d / Argon weekly buckets; defers background refresh during active turns. |
| 🛡️ **Permissions, sandbox & ACP** | `skip` / `auto` / `accept-edits` / `plan` (`/aplan` read-only) + `--sandbox`; default persistent `agy acp` pool with pre-stream `cli` fallback; MCP step-scoped routing. |
| 🃏 **Tool cards & Generative UI** | Native Terminal/Diff/Read/Search/MCP cards plus `swarm`, `run_workflow`, `schedule`, `manage_task`, subagent, `image-generator`; `<agent-embed>` CSP-sandboxed widgets. |
| 🎬 **Multimodal** | Images + PDF/audio/video staging (`--add-dir`), lightbox, video preview, inline `<audio>`, Mermaid, decision chips, compaction cards. |
| 🔐 **OAuth & token import** | Zero-paste browser PKCE (`127.0.0.1:51121`) + `refresh_token`/JSON import; `NETWORK` vs `AUTH` classification and `TOS_VIOLATION` circuit breaker. |
| ⚡ **`/a*` commands** | `/aplan` `/agoal` `/agrill` `/aboost` `/aswarm` `/ateamwork` `/aschedule` `/abrowser` `/acmd`; meta `/acompact` `/afork` `/alearn`. |
| 🌐 **i18n & toggles** | `en` / `zh` / `es` / `pt-BR`; `<680px` drawer; `showHeaderBadge` opt-out. |

## 📋 Requirements

| Requirement | Verify |
| --- | --- |
| DSH | `dsh --version` |
| Node.js ≥ 24 | `node --version` |
| Antigravity CLI (≥ 1.5) | `agy --version` (https://antigravity.google/docs/cli/install) |
| Google connectivity | proxy/VPN/TUN where required |

Where Google is unreachable, enable system proxy/TUN before starting DSH, or set a per-account proxy in the panel.

## 🚀 Quick start

```bash
dsh plugin --profile web add dsh-agy-link --registry https://registry.npmjs.org
dsh web

# in chat input:
/agy status              # binary, version, transport, pool, catalog
/agy auth                # sign the primary account in
/agy pool                # account IDs + per-family quota/active pins
/agy auth <account-id>   # reauth a secondary (alias or email also accepted)
/agy auth-status         # final login result
```

Add more accounts from the **AGY (n)** badge (browser login or token import), then pick an Antigravity model in `/model`.

## 🧩 `/agy` commands

- **Runtime:** `/agy mode <skip|auto|plan|accept-edits>`, `sandbox [on|off]`, `transport [cli|acp|status]`, `agent [name|off]`, `settings [show|<json|path>|clear]`, `effort <…>`, `workspace [path]`
- **Session & workflow:** `/agy goal [...]`, `session [info|clear]`, `fork [...]`, `grill [topic]`, `learn [--apply] [focus]`, `compact [focus]`, `doctor`
- **`/a*` direct turns:** `/aplan [task]` (one-shot read-only), `/agoal`, `/agrill`, `/aboost`, `/aswarm`, `/ateamwork`, `/aschedule`, `/abrowser`, `/acmd </cmd|list>`
- **Meta:** `/acompact`, `/afork`, `/alearn`

## 🔌 External credential lease API

On Windows every `agy.exe` reads one Credential Manager entry (`gemini:antigravity`); HOME only moves conversation storage, not identity. A process that **launches `agy` itself** (e.g. a long-job runner) cannot see the plugin's in-memory counters, so the lease API lets it join the same account-selection / slot / settlement logic.

- **Isolated secondary on agy ≥ 1.5:** slot not taken (`slot: false`); returned `env` carries `SSH_CONNECTION` so agy reads only that account's token and runs lock-free. Unknown version is probed first; a failed probe falls back to taking the slot.
- **Primary, or isolated account on agy < 1.5:** holds the slot (`slot: true`).

**Discovery:** `<pool dir>/.link-endpoint.json` (default `~/.dsh/agy-accounts`) with `url / pid / startedAt / token`, mode `0600`, token regenerated each start.

**Auth:** every `/lease*` request needs `Authorization: Bearer <token>`, else `401`; non-loopback browser `Origin` gets `403`.

| Endpoint | Body | Success |
| --- | --- | --- |
| `POST /lease/acquire` | `holder` (required), `model?`, `accountId?`/`accountDir?` (pin), `ttlMs?` (120000, 15000–600000), `waitMs?` | `{ ok, leaseId, ttlMs, expiresAt, slot, env, account }` |
| `POST /lease/renew` | `leaseId`, `ttlMs?` | `{ ok, expiresAt }` |
| `POST /lease/release` | `leaseId`, `ok?`, `error?`, `model?` | `{ ok, outcome }` — `ok:true` success, `ok:false` settles via one-shot failure classification, omit to only release |
| `GET /lease` | — | current leases (diagnostics) |

Notes: overlay returned `env` as-is onto your agy process; `renew` within TTL, `release` **exactly once**; leases are in-memory only (a DSH restart drops them — re-acquire).

## ⚙️ Configuration

Every key, env var and default lives in **one place**: [CONFIGURATION.md](./CONFIGURATION.md). Entry points: `/plugin`, the Antigravity settings panel, `DSH_AGY_*`, and `~/.dsh/agy-link/runtime-overrides.json`.

## 🧩 How it works

1. **Persistent `agy acp` default, CLI (`-p`) fallback:** each turn (incl. `isAux`) reuses `agy acp` stdio processes (ephemeral aux sessions `session/close` on settlement; pre-stream failures fall back to `agy -p`).
2. **Per-account sandbox:** primary uses system HOME/keychain; secondaries get isolated HOME with `0600` credentials + `.bak`. Windows leases the slot by identity so same-account sessions run concurrently.
3. **CLI-first quota & pooled failover:** `agy -p /usage` preferred, `retrieveUserQuotaSummary` fallback; 429/quota/region/auth classified per family — cool down, rotate, or retry.
4. **Aux routes:** translation, titles, goal derivation ride the same pool via dedicated `purpose` without polluting a binding.

## ❓ FAQ

- **Proxy?** Export `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` before DSH, or set a per-account proxy.
- **Model rejects `--effort`?** The plugin learns it, replays without the flag, persists to `effort-unsupported.json`, hides the level.
- **Quotas stale?** Poll hourly (`quotaPollIntervalMs`); press "Sync" / "Refresh Quota" / `/agy refresh-quota`.
- **Windows console flash?** Set Windows Terminal's default terminal to **Windows Console Host**; `suppressAgyAutoUpdate` also stops agy's `--bg-updater` chain.

## 📚 Documentation

- [CONFIGURATION.md](./CONFIGURATION.md) — keys, env vars, defaults
- [ARCHITECTURE.md](./ARCHITECTURE.md) — layering, provider pipeline, HTTP routes
- [AUTH.md](./AUTH.md) — PKCE OAuth, token import, keychain isolation
- [SECURITY-NOTES.md](./SECURITY-NOTES.md) — threat model, route confinement, CSP, MCP guardrails
- [HEADLESS-PERMISSIONS.md](./HEADLESS-PERMISSIONS.md) — least-privilege `dsh headless`
- [KNOWN-GAPS.md](./KNOWN-GAPS.md) — platform limits and upstream behaviors
- [DEVELOPMENT.md](./DEVELOPMENT.md) — gates and refactoring rules

## ⚠️ Disclaimer

This plugin only invokes the official, unmodified `agy` CLI installed locally. Use is subject to Google Antigravity's Terms of Service.

## License

MIT License.
