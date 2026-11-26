# Configuration reference

Resolution order (highest first): `DSH_AGY_*` environment variable → runtime overrides written by `/agy` (`.dsh/agy-link/runtime-overrides.json`) → plugin entry config in the DSH profile → defaults below.

| Legend | Meaning |
| --- | --- |
| `—` | No environment variable; set it through the plugin config |

## Basics

| Key | Environment | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `DSH_AGY_ENABLED` | `true` | Master switch |
| `agyBin` | `DSH_AGY_BIN` | `''` (auto-detect) | Path to the `agy` binary |
| `extraArgs` | `DSH_AGY_EXTRA_ARGS` | `[]` | Extra argv appended to every `agy` spawn (space separated in the env var) |
| `permissionMode` | `DSH_AGY_MODE` | `skip` | `skip` / `auto` / `plan` / `accept-edits`. `DSH_AGY_SKIP_PERMISSIONS` maps `true`→`skip`, `false`→`plan` |
| `sandbox` | `DSH_AGY_SANDBOX` | `false` | Run `agy` with OS terminal sandboxing (`--sandbox`) |
| `agent` | `DSH_AGY_AGENT` | `''` (agy default) | Default custom Markdown agent name (`--agent`) |
| `agySettings` | `DSH_AGY_SETTINGS` | `''` | Inline JSON object or file path passed to `agy --settings` |
| `transport` | `DSH_AGY_TRANSPORT` | `acp` | `acp` (default): one persistent `agy acp` process per account+session — background commands, subagents and timers keep running after a turn and report back; accurate per-call usage/cache. `cli`: one-shot `agy -p` per turn (background work dies with the process). A pre-stream ACP failure falls back to `cli`. Switch via `/agy transport cli` or Settings. |
| `workspaceRoot` | `DSH_AGY_WORKSPACE_ROOT` | `''` (session cwd) | Workspace root passed to agy |

## Models and effort

| Key | Environment | Default | Description |
| --- | --- | --- | --- |
| `defaultModel` | `DSH_AGY_DEFAULT_MODEL` | `''` (agy default) | Initial model slug |
| `defaultEffort` | `DSH_AGY_DEFAULT_EFFORT` | `high` | Initial thinking effort; the menu offers exactly the levels the live catalog advertises (`low`/`medium`/`high`/`xhigh`/`max`) plus `auto`. |
| `hiddenModels` | `DSH_AGY_HIDDEN_MODELS` | `[]` | Slugs hidden from the picker (comma separated); applied after `selectedModels`, so it wins. |
| `selectedModels` | `DSH_AGY_SELECTED_MODELS` | `[]` | Allow-list of slugs in the picker (comma separated; empty = all). Written by the Settings tick-list; a deselected model still resolves for sessions already using it. |
| `fallbackModels` | `—` | agy 1.5.7 lineup: Gemini 4 Argon, Gemini 4 Hydrogen, Orchestrator (Argon), Gemini 3.8 Flash, Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B (Medium) | Catalog shown before `agy models` succeeds (signed out or offline); mirrors `agy models` exactly, no retired entries |
| `autoFallbackModel` | `DSH_AGY_AUTO_FALLBACK_MODEL` | `false` | Retry on a fallback model when the selected one cannot run |
| `modelsCacheTtlMs` | `—` | `300000` | Model catalog cache lifetime |

## Timeouts and scheduling

| Key | Environment | Default | Description |
| --- | --- | --- | --- |
| `timeoutMs` | `DSH_AGY_TIMEOUT_MS` | `600000` | Activity watchdog timeout per turn |
| `maxTurnMinutes` | `DSH_AGY_MAX_TURN_MINUTES` | `0` | Hard wall-clock cap per turn (0 = unlimited); bounds a self-driving turn that never goes idle |
| `longToolIdleMinutes` | `DSH_AGY_LONG_TOOL_IDLE_MINUTES` | `240` | Idle budget while a tool step is open; `0` keeps `timeoutMs` so wedged tools fail fast |
| `idleGraceMinutes` | `DSH_AGY_IDLE_GRACE_MINUTES` | `10` | Grace before the idle-background reaper kills the agy tree; `0` disables it (watchdog and `maxTurnMinutes` still bound the turn). |
| `reapOrphanMcp` | `DSH_AGY_REAP_ORPHAN_MCP` | `true` | Reap MCP servers orphaned by short-lived agy probes (`models`/`/usage`/`--version` fork servers agy doesn't kill on exit). Only parent-dead, >5-min-old processes are killed; runs in the deferred maintenance pass. |
| `backgroundWakeup` | `DSH_AGY_BACKGROUND_WAKEUP` | `false` | Opt-in. Wake idle sessions across turns when a `schedule` timer expires, a detached task/subagent finishes, or an ACP session emits a background completion. Enable via Settings or `DSH_AGY_BACKGROUND_WAKEUP=1`. |
| `backgroundWakeupTtlMinutes` | `DSH_AGY_BACKGROUND_WAKEUP_TTL_MINUTES` | `30` | Max window (minutes, 1–240) to keep post-turn background watches and one-shot `schedule` timers alive |
| `backgroundWakeupMaxPerSession` | `DSH_AGY_BACKGROUND_WAKEUP_MAX_PER_SESSION` | `12` | Max automatic background wakeups per session between human turns (1–100) |
| `dispatchTimeoutMinutes` | `—` | `15` | Cap on waiting for the Windows credential slot before backing off and retrying; `0` waits indefinitely |
| `dispatchRetries` | `—` | `1` | Extra dispatch attempts after a credential-slot timeout |
| `parallelSameAccount` | `—` | `true` | Concurrent sessions on the credential already in the slot start without exclusivity; `false` restores full slot exclusivity |
| `maxConcurrent` | `—` | `0` (unlimited) | Cross-session cap on concurrent agy streams |
| `rateLimitPerMinute` | `DSH_AGY_RATE_LIMIT_PER_MINUTE` | `0` (off) | Admission cap on requests per minute |

## Context and metering

| Key | Environment | Default | Description |
| --- | --- | --- | --- |
| `contextWindowDefault` | `DSH_AGY_CONTEXT_WINDOW` | `1048576` | Context window advertised when agy does not report one |
| `maxTokensDefault` | `DSH_AGY_MAX_TOKENS` | `65536` | Max output tokens advertised when agy does not report one |
| `forwardSystemPrompt` | `—` | `false` | Forward the current DSH system prompt and latest producer snapshots to agy on each chat turn, including resumed sessions |
| `digestMaxChars` | `—` | `8000` | Budget for the history digest sent each turn |
| `contextTransferMaxChars` | `—` | `660000` | Character cap for the transferred context block |
| `contextTransferMaxBytes` | `—` | `150000` | Byte cap for the transferred context block |
| `contextTransferFileAboveBytes` | `—` | `150000` | Files larger than this are elided in the context block |
| `contextTransferFileMaxBytes` | `—` | `2000000` | Hard cap for an inlined file |
| `compactionMaxChars` | `—` | `800000` | Character budget for compaction input |
| `allowAuxiliary` | `—` | `true` | Allow auxiliary calls (titles, goal derivation) through the adapter |

## Media

| Key | Environment | Default | Description |
| --- | --- | --- | --- |
| `mediaDir` | `DSH_AGY_MEDIA_DIR` | `''` (plugin data dir) | Staging directory for multimodal attachments (images, PDF, audio, video) |
| `mediaTtlMs` | `DSH_AGY_MEDIA_TTL_MS` | `86400000` | Staged attachment lifetime |
| `mediaMaxBytes` | `—` | `10485760` | Per-image size cap |
| `mediaMaxFileBytes` | `DSH_AGY_MEDIA_MAX_FILE_BYTES` | `20971520` | Per-file byte cap for non-image multimodal attachments (PDF, audio, video; 20 MiB) |
| `mediaMaxImages` | `—` | `8` | Images per turn |

## MCP and tools

| Key | Environment | Default | Description |
| --- | --- | --- | --- |
| `askTool` | `—` | `false` | Expose the `agy_ask` delegation tool |
| `mcpBridge` | `DSH_AGY_MCP_BRIDGE` | `false` | Expose the current DSH step’s tools to agy (requires a step-tool-set host; without a bound step no tools are advertised). |
| `mcpConfigScope` | `DSH_AGY_MCP_CONFIG_SCOPE` | `global` | `global` / `workspace` / `both` |
| `mcpConfigPath` | `DSH_AGY_MCP_CONFIG_PATH` | `''` | Explicit agy MCP config path |
| `mcpToolAllowlist` | `DSH_AGY_MCP_TOOL_ALLOWLIST` | `''` | Only expose these MCP tools (comma separated) |

## Network, quota and updates

| Key | Environment | Default | Description |
| --- | --- | --- | --- |
| `proxyUrl` | `DSH_AGY_PROXY_URL` | `''` | Global proxy for agy processes; per-account proxies take precedence |
| `quotaPollIntervalMs` | `DSH_AGY_QUOTA_POLL_INTERVAL_MS` | `3600000` | Background quota poll interval (minimum 60 s) |
| `quotaViaCli` | `DSH_AGY_QUOTA_VIA_CLI` | `true` | Prefer the CLI for quota queries. The CLI is only spawned once the token has ≥2 min of life left (refreshed up front otherwise); else that round uses the REST quota endpoint. |
| `suppressAgyAutoUpdate` | `DSH_AGY_SUPPRESS_AUTOUPDATE` | `true` on Windows, `false` elsewhere | Refresh agy's update-check timestamp before every spawn to stop the `--bg-updater` console flash chain |

## Orchestrator & security options

| Key | Environment | Default | Description |
| --- | --- | --- | --- |
| `orchestratorPlannerModel` | `DSH_AGY_ORCHESTRATOR_PLANNER_MODEL` | `''` | Planner model override passed via `--settings` when an Orchestrator model is active |
| `orchestratorPlannerEffort` | `DSH_AGY_ORCHESTRATOR_PLANNER_EFFORT` | `''` | Planner reasoning effort override for Orchestrator turns |
| `orchestratorExecutorModel` | `DSH_AGY_ORCHESTRATOR_EXECUTOR_MODEL` | `''` | Executor model override passed via `--settings` when an Orchestrator model is active |
| `orchestratorExecutorEffort` | `DSH_AGY_ORCHESTRATOR_EXECUTOR_EFFORT` | `''` | Executor reasoning effort override for Orchestrator turns |
| `cloakSystemPrompt` | `DSH_AGY_CLOAK_SYSTEM_PROMPT` | `true` | Replace DSH-specific wording/paths in injected prompts with neutral Antigravity phrasing |
| `auxNeutralWorkspace` | `DSH_AGY_AUX_NEUTRAL_WORKSPACE` | `true` | Run auxiliary/side-channel turns (title, compaction) in a clean neutral cwd instead of leaking the user workspace |
| `respectExternalSignIn` | `—` | `false` | Preserve a newer external standalone AGY sign-in in the Windows credential slot instead of overwriting it (#145) |

## Client UI visibility (issue #105)

| Key | Environment | Default | Description |
| --- | --- | --- | --- |
| `showHeaderBadge` | `DSH_AGY_SHOW_HEADER_BADGE` | `true` | Show the AGY status badge in the header; `false` hides it (console still reachable from Settings). ≤680 px hides the label, keeps the dot. |

Opt-out (only an explicit `false` hides); changes apply on the next 3 s status poll without reload.

## Diagnostics

| Key | Environment | Default | Description |
| --- | --- | --- | --- |
| `logRetentionDays` | `DSH_AGY_LOG_RETENTION_DAYS` | `7` | Host log retention |
| `disableTelemetry` | `DSH_AGY_DISABLE_TELEMETRY` | `true` | Disable outbound telemetry |
