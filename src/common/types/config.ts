// Plugin identity, the user-facing config shape, and its defaults.

import { DEFAULT_FALLBACK_MODELS, type FallbackModelDef } from '../model-lineup.ts'

export const PROVIDER_ID = 'antigravity'

export type PermissionMode = 'skip' | 'auto' | 'plan' | 'accept-edits'

export type AgyTransportMode = 'cli' | 'acp'

export interface PluginConfig {
  enabled: boolean
  /** Absolute path to the agy binary; empty string = resolve from PATH. */
  agyBin: string
  /** Extra argv appended to every spawn (escape hatch). */
  extraArgs: readonly string[]
  permissionMode: PermissionMode
  /** Run agy with terminal sandboxing enabled (`--sandbox`). */
  sandbox: boolean
  /** Default custom agent name (`--agent`, empty = agy default). */
  agent: string
  /** Inline JSON object or path passed to `agy --settings`. */
  agySettings: string
  /** Execution transport: short-lived `-p` CLI or persistent `agy acp` stdio server. */
  transport: AgyTransportMode
  /** Per-file byte cap for non-image multimodal attachments (PDF/audio/video, default 20 MiB). */
  mediaMaxFileBytes: number
  defaultModel: string
  defaultEffort: string
  /** Orchestrator Planner (upstream) model id (empty = agy default). */
  orchestratorPlannerModel: string
  /** Orchestrator Planner thinking effort id (empty = model/agy default). */
  orchestratorPlannerEffort: string
  /** Orchestrator Executor (downstream) model id (empty = agy default). */
  orchestratorExecutorModel: string
  /** Orchestrator Executor thinking effort id (empty = model/agy default). */
  orchestratorExecutorEffort: string
  /** Watchdog for one full agy -p run. */
  timeoutMs: number
  /**
   * Idle budget while an agy tool step is still open (ACTIVE without
   * DONE/ERROR). A long build/compile is legitimately silent on stdout, so
   * the watchdog gets this larger budget instead of `timeoutMs`. Default 240
   * minutes (the print-mode ceiling). Set 0 to disable the raise: a tool step
   * that never completes then dies after `timeoutMs` and fails the turn
   * loudly instead of holding the session for hours.
   */
  longToolIdleMinutes: number
  /**
   * Hard wall-clock cap for a single turn, in minutes (0 = unlimited). The idle
   * watchdog re-arms on every output line, so without this a self-driving agy
   * loop that keeps printing can run unbounded (issue #92).
   */
  maxTurnMinutes: number
  /**
   * Grace (minutes) before the `root agent idle; waiting for N background
   * task(s)` reaper kills the agy process tree. agy prints that line while it
   * legitimately waits for a build, integration test or Docker job it launched;
   * the former hard-coded 5 s killed those turns and surfaced as
   * `agy stream ended without a result event` (issue #144). Default 10 minutes,
   * which stays below the normal generation idle budget (`timeoutMs`, at least
   * 15 min) so a real orphan is still reclaimed. 0 disables the reaper: the
   * activity watchdog and `maxTurnMinutes` then bound the turn alone.
   */
  idleGraceMinutes: number
  /** Hard cap (minutes) on the credential-slot wait before release+retry; 0 = unlimited. */
  dispatchTimeoutMinutes: number
  /** Extra dispatch attempts after a credential-slot hard-cap timeout. */
  dispatchRetries: number
  /**
   * Same-account credential-slot fast path: parallel runs on one account,
   * exclusive only for account switches (Windows credential slot).
   */
  parallelSameAccount: boolean
  /**
   * Reap MCP servers orphaned by short-lived agy probes (agy forks every MCP
   * server from the user registry for `models`/`/usage`/`--version` and does not
   * kill them on exit). Only processes whose parent is already dead are killed.
   */
  reapOrphanMcp: boolean
  /** Preserve a newer external standalone AGY sign-in in the Windows credential slot instead of overwriting it (#145). */
  respectExternalSignIn: boolean
  maxConcurrent: number
  contextWindowDefault: number
  maxTokensDefault: number
  /**
   * Prepend `options.system` to the agy prompt. Opt-in for ordinary turns,
   * because agy owns its own agent instructions and stacking DSH's rendered
   * prompt on top invites conflicts. Host authorization-review calls (those
   * carrying REVIEW_POLICY) always forward their system prompt regardless of
   * this flag: the output protocol lives there, and dropping it makes the
   * reviewer answer in prose instead of the required JSON object.
   */
  forwardSystemPrompt: boolean
  /**
   * Run pure-text auxiliary calls (session-title / compaction)
   * in a stable empty directory instead of the session workspace. agy loads
   * the project's GEMINI.md/AGENTS.md and workspace context into every
   * one-shot aux process (~15-20k uncached tokens each, 0% cache); a neutral
   * cwd keeps that prefix small and cacheable across calls. Default: true.
   */
  auxNeutralWorkspace: boolean
  /** Apply semantic-preserving rewrites to forwarded harness system prompts to avoid upstream prompt-fingerprint false 429 / shallow degradation (default: true). */
  cloakSystemPrompt: boolean
  digestMaxChars: number
  /**
   * Character budget for the history digest used to seed a brand-new agy
   * conversation (first contact, account switch, model switch, compaction
   * re-seed). Generous on purpose: modern models are 1M-token class, and a
   * small budget silently dropped most of a long session on every account
   * switch. Default 660K, sized for 1M-token-class models.
   */
  contextTransferMaxChars: number
  /**
   * Byte budget for INLINING the context-transfer digest into one prompt.
   * agy 1.4.x truncates a single user message at 192,000 UTF-8 bytes and the
   * cut lands on the TAIL, so a huge inline digest used to swallow the live
   * request that followed it. Keep this well below that ceiling.
   */
  contextTransferMaxBytes: number
  /**
   * Above this many UTF-8 bytes the digest is written to a temp .md file and
   * referenced by path instead of inlined: agy then reads it in pages, which is
   * the only way a long history can use the model's real (1M-token) window.
   */
  contextTransferFileAboveBytes: number
  /** Byte cap for the file-backed digest (not bounded by agy's message cap). */
  contextTransferFileMaxBytes: number
  modelsCacheTtlMs: number
  /** Allow compaction / session-title auxiliary calls to spawn agy. */
  allowAuxiliary: boolean
  /** Hard character cap for compaction prompts built from history. */
  compactionMaxChars: number
  /** Lock the working directory for agy spawns; empty string = process.cwd(). */
  workspaceRoot: string
  fallbackModels: readonly FallbackModelDef[]
  /**
   * Model ids hidden from the DSH model picker (deny-list: anything not
   * listed stays visible, so newly discovered models appear by default).
   * resolveModel still accepts hidden ids so in-flight sessions keep working.
   */
  hiddenModels: readonly string[]
  /**
   * Model ids the picker is ALLOWED to show (allow-list). Empty = no
   * restriction, so every discovered model stays visible — an allow-list that
   * defaults to "nothing" would silently empty the model menu on upgrade.
   * Applied AFTER `hiddenModels`, so a deny-listed id stays hidden even when
   * it also appears here.
   */
  selectedModels: readonly string[]
  askTool: boolean
  /** Directory where inbound images are staged for agy (path-based multimodal). */
  mediaDir: string
  /** Images older than this are swept from mediaDir. */
  mediaTtlMs: number
  /** Per-image byte cap for staging; larger images are skipped with a note. */
  mediaMaxBytes: number
  /** Max images staged per model call. */
  mediaMaxImages: number
  /** Experimental: expose DSH tools to agy over a local MCP bridge. */
  mcpBridge: boolean
  /** Where the bridge publishes its MCP entry. `agy` 1.4+ only reads the global registry. */
  mcpConfigScope: 'global' | 'workspace' | 'both'
  /** Absolute override for the agy MCP registry file. Empty = <agy home>/.gemini/config/mcp_config.json */
  mcpConfigPath: string
  /** Comma-separated tool-name allowlist for the MCP bridge (empty = all non-internal). */
  mcpToolAllowlist: string
  /** Maximum requests allowed per minute across all sessions (0 = disabled). */
  rateLimitPerMinute: number
  /** Automatically fallback to available lower-tier model if active model is exhausted. */
  autoFallbackModel: boolean
  /** Days to retain historical agy CLI log files before automatic sweep (default: 7). */
  logRetentionDays: number
  /** Opt-out and suppress Google Cloud Code / Antigravity telemetry tracking. */
  disableTelemetry: boolean
  /** Background quota polling interval in ms (default 60 min; clamped >= 60s). Lower = more risk-control exposure. */
  quotaPollIntervalMs: number
  /**
   * Fetch quota statistics via official `agy -p /usage` CLI execution instead
   * of direct Node.js REST calls to Google internal endpoints (default: true).
   */
  quotaViaCli: boolean
  /**
   * Global proxy URL (http:// or socks5://) applied to every agy spawn and
   * Google API call. An account's dedicated proxyUrl wins over this; empty
   * string = direct connection. GUI apps don't inherit shell proxy env, so
   * desktop installs need this (or per-account proxies) to reach Google.
   */
  proxyUrl: string
  /**
   * Pre-empt agy's built-in auto-updater before every spawn (issue #49).
   *
   * agy >= 1.4.2 ignores AGY_CLI_DISABLE_AUTO_UPDATE for the `--bg-updater`
   * child it spawns itself, and that child's `agy --version` grandchild
   * allocates a visible console window on Windows. Refreshing
   * `<agy home>/last_check.timestamp` keeps agy on its 15-minute fast path, so
   * the child chain never starts. Default: true on Windows, false elsewhere.
   * Cost: the agy home used by this plugin stops doing automatic update checks
   * (`agy update` still works); set false to restore agy's own behaviour.
   */
  suppressAgyAutoUpdate: boolean
  /**
   * Show Antigravity status badge in the conversation header toolbar (default: true).
   * Set false to hide it (especially on mobile / narrow viewports).
   */
  showHeaderBadge: boolean
  /**
   * Wake idle DSH sessions across turns when an agy `schedule` timer,
   * detached background task/subagent, or persistent ACP update finishes
   * after the turn ends.
   *
   * Opt-in (default false): a session that speaks on its own after the turn is
   * a behaviour change no existing install asked for. Turn it on in Settings →
   * Runtime controls, with `/agy config wakeup on`, or with
   * `DSH_AGY_BACKGROUND_WAKEUP=1`.
   */
  backgroundWakeup: boolean
  /** Max lifetime (minutes) to retain post-turn background watches/timers (default 30). */
  backgroundWakeupTtlMinutes: number
  /** Max automatic background wakeups per session between real human turns (default 12). */
  backgroundWakeupMaxPerSession: number
}

// The offline/signed-out lineup lives in `common/model-lineup.ts` — the single
// place that names concrete agy models. Re-exported here so the historical
// `common/types` import surface keeps working.
export { DEFAULT_FALLBACK_MODELS }
export type { FallbackModelDef }

export function defaultConfig(): PluginConfig {
  return {
    enabled: true,
    agyBin: '',
    extraArgs: [],
    permissionMode: 'skip',
    sandbox: false,
    agent: '',
    agySettings: '',
    // ACP is the default transport: the persistent `agy acp` channel keeps one
    // process per account/session so background commands, subagents, timers and
    // the cross-turn wake path survive the end of a turn, and it reports real
    // per-call usage (#158). A pre-stream failure still falls back to the
    // one-shot `-p` CLI automatically, so nothing is lost when ACP cannot start.
    // Opt back into the CLI with `DSH_AGY_TRANSPORT=cli`,
    // `/agy config transport cli` or the settings page.
    transport: 'acp',
    mediaMaxFileBytes: 20 * 1024 * 1024,
    defaultModel: '',
    // Explicit 'high' (not ''): effort-capable models default to the highest
    // agy offers, and the per-model choice now lives in DSH's model menu.
    defaultEffort: 'high',
    orchestratorPlannerModel: '',
    orchestratorPlannerEffort: '',
    orchestratorExecutorModel: '',
    orchestratorExecutorEffort: '',
    timeoutMs: 600_000,
    longToolIdleMinutes: 240,
    maxTurnMinutes: 0,
    idleGraceMinutes: 10,
    /**
     * Hard cap (minutes) on waiting for the Windows credential slot before the
     * dispatch releases, backs off and retries (dispatchRetries). Each attempt
     * waits up to this long, so persistence ≈ (1 + dispatchRetries) × N
     * minutes before the turn fails visibly. 0 = wait indefinitely (the wait
     * stays abort-aware, poll-healed and heartbeat-logged).
     */
    dispatchTimeoutMinutes: 15,
    /** Extra dispatch attempts after a credential-slot hard-cap timeout. */
    dispatchRetries: 1,
    /**
     * Same-account credential-slot fast path (default true): sessions running
     * on the account whose credential already sits in the Windows slot start
     * immediately WITHOUT exclusivity — agy is a stateless CLI and handles
     * concurrent processes natively. Only account SWITCHES serialize.
     * false restores full-run slot exclusivity (one agy process at a time).
     */
    parallelSameAccount: true,
    reapOrphanMcp: true,
    respectExternalSignIn: false,
    /**
     * Cross-session cap on concurrent agy request streams. 0 = UNLIMITED
     * (default): native agy concurrency — agy is a stateless CLI and runs
     * concurrent processes natively; Google rate limits and the account
     * pool's cooldowns are the natural regulators. Set a positive number to
     * re-introduce an admission bound.
     */
    maxConcurrent: 0,
    contextWindowDefault: 1_048_576,
    maxTokensDefault: 65_536,
    forwardSystemPrompt: false,
    auxNeutralWorkspace: true,
    cloakSystemPrompt: true,
    digestMaxChars: 8_000,
    contextTransferMaxChars: 660_000,
    contextTransferMaxBytes: 150_000,
    contextTransferFileAboveBytes: 150_000,
    contextTransferFileMaxBytes: 2_000_000,
    modelsCacheTtlMs: 300_000,
    allowAuxiliary: true,
    compactionMaxChars: 800_000,
    workspaceRoot: '',
    fallbackModels: DEFAULT_FALLBACK_MODELS,
    hiddenModels: [],
    // Empty = no allow-list: every model the account supports stays visible.
    selectedModels: [],
    askTool: false,
    mediaDir: '',
    mediaTtlMs: 86_400_000,
    mediaMaxBytes: 10 * 1024 * 1024,
    mediaMaxImages: 8,
    mcpBridge: false,
    mcpConfigScope: 'global',
    mcpConfigPath: '',
    mcpToolAllowlist: '',
    rateLimitPerMinute: 0,
    autoFallbackModel: false,
    logRetentionDays: 7,
    disableTelemetry: true,
    quotaPollIntervalMs: 60 * 60_000,
    quotaViaCli: true,
    proxyUrl: '',
    // Windows is where agy's `--bg-updater` grandchild flashes a console
    // window; other platforms keep agy's own update behaviour by default.
    suppressAgyAutoUpdate: process.platform === 'win32',
    showHeaderBadge: true,
    backgroundWakeup: false,
    backgroundWakeupTtlMinutes: 30,
    backgroundWakeupMaxPerSession: 12,
  }
}
