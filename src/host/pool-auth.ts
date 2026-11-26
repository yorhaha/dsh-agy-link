// PoolAuthFlow: self-owned Google OAuth lifecycle for the single primary account.
//
// Flow: PKCE authorize URL -> loopback callback listener + server-side browser
// open -> automatic code capture -> exchange -> write agy-format token file
// into system HOME / credential store -> verify via userinfo -> update primary
// account in place. Manual code (or redirect URL) paste is the fallback.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  buildAgyCredentialDoc,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserEmail,
  generatePkce,
  openBrowser,
  parsePastedCode,
  refreshTokens,
  startCallbackListener,
  writeAgyTokenFile,
  type CallbackHandle,
} from './oauth.ts'
import type { ManagedAccount } from '../common/pool-types.ts'
import { delay } from '../common/async.ts'
import type { AccountPoolManager } from './pool.ts'
import type { QuotaService } from './quota.ts'
import { detectSystemProxy, writeWindowsCredentialRaw } from './wincred.ts'
import { writePrimaryCredential } from './credential-slot.ts'
import { extractRefreshToken, saveCredentialBackup } from './credential-backup.ts'
import { writeSystemKeyringRaw } from '../runtime/agy/keychain.ts'

export type PoolAuthPhase = 'idle' | 'waiting' | 'exchanging' | 'done' | 'failed'
export type PoolAuthStatusCode =
  | 'browser_manual'
  | 'callback_failed'
  | 'no_active_flow'
  | 'invalid_code'
  | 'invalid_state'
  | 'exchange_failed'
  | 'primary_activated'
  | 'missing_code'
  | 'request_failed'

export interface PoolAuthStatus {
  phase: PoolAuthPhase
  stagingId?: string
  alias?: string
  url?: string
  /** 'auto' = loopback listener live; 'manual' = paste the code/URL back. */
  mode?: 'auto' | 'manual'
  browserOpened?: boolean
  /** Stable, locale-neutral user-facing state. Raw diagnostic details never leave the host. */
  code?: PoolAuthStatusCode
}

interface ActiveFlow {
  stagingId: string
  dir: string
  alias?: string
  proxyUrl?: string
  verifier: string
  state: string
  url: string
  mode: 'auto' | 'manual'
  listener: CallbackHandle | null
}

const DONE_STATUS_TTL_MS = 30_000

export interface PoolAuthFlowDeps {
  /** Injectable for tests; defaults to the OS browser open. */
  openBrowser?: (url: string) => Promise<boolean>
  exchangeCode?: typeof exchangeCode
  fetchUserEmail?: typeof fetchUserEmail
  refreshTokens?: typeof refreshTokens
  onUpdate?: () => void
  /** Injectable Windows credential-slot writer (tests must override). */
  writeSlot?: (raw: string) => boolean
  /** Injectable macOS/Linux Keychain writer (tests must override). */
  writeKeyring?: (raw: string, homeDir: string) => boolean
}

export class PoolAuthFlow {
  private flow: ActiveFlow | null = null
  private statusValue: PoolAuthStatus = { phase: 'idle' }
  private doneResetTimer: NodeJS.Timeout | null = null
  private readonly open: (url: string) => Promise<boolean>
  private readonly exchange: typeof exchangeCode
  private readonly userEmail: typeof fetchUserEmail
  private readonly refresh: typeof refreshTokens
  private readonly onUpdate?: () => void
  private readonly writeSlot: (raw: string) => boolean
  private readonly writeKeyring: (raw: string, homeDir: string) => boolean

  constructor(
    private readonly pool: AccountPoolManager,
    private readonly quota: QuotaService,
    private readonly log: (msg: string) => void = () => {},
    deps: PoolAuthFlowDeps = {},
  ) {
    this.open = deps.openBrowser ?? openBrowser
    this.exchange = deps.exchangeCode ?? exchangeCode
    this.userEmail = deps.fetchUserEmail ?? fetchUserEmail
    this.refresh = deps.refreshTokens ?? refreshTokens
    this.onUpdate = deps.onUpdate
    this.writeSlot = deps.writeSlot ?? ((raw) => writeWindowsCredentialRaw(raw, 'gemini:antigravity'))
    this.writeKeyring = deps.writeKeyring ?? ((raw, homeDir) => writeSystemKeyringRaw(raw, homeDir))
  }

  status(): PoolAuthStatus {
    return { ...this.statusValue }
  }

  private setStatus(patch: Partial<PoolAuthStatus> & { phase: PoolAuthPhase }): void {
    if (this.doneResetTimer) {
      clearTimeout(this.doneResetTimer)
      this.doneResetTimer = null
    }
    this.statusValue = { ...this.statusValue, ...patch }
    if (patch.phase === 'done') {
      this.doneResetTimer = setTimeout(() => {
        if (this.statusValue.phase === 'done') this.statusValue = { phase: 'idle' }
      }, DONE_STATUS_TTL_MS)
      this.doneResetTimer.unref?.()
    }
  }

  private async startFlow(flow: Omit<ActiveFlow, 'verifier' | 'state' | 'url' | 'mode' | 'listener'>): Promise<PoolAuthStatus & { ok: boolean; dir?: string }> {
    await this.abortActive()

    const { verifier, challenge } = generatePkce()
    const state = randomBytes(16).toString('base64url')
    const url = buildAuthorizeUrl(challenge, state)

    let listener: CallbackHandle | null = startCallbackListener()
    let bindFailed = false
    await Promise.race([
      listener.result.then(
        () => {},
        () => {
          bindFailed = true
        },
      ),
      delay(300),
    ])
    if (bindFailed) {
      await listener.close().catch(() => undefined)
      listener = null
    }
    const mode: 'auto' | 'manual' = listener ? 'auto' : 'manual'

    const browserOpened = await this.open(url)

    const active: ActiveFlow = { ...flow, verifier, state, url, mode, listener }
    this.flow = active
    this.setStatus({
      phase: 'waiting',
      stagingId: active.stagingId,
      alias: active.alias,
      url,
      mode,
      browserOpened,
      code: browserOpened ? undefined : 'browser_manual',
    })
    this.log(`primary auth begun (${mode} mode, browserOpened=${browserOpened})`)

    if (listener) {
      void listener.result
        .then(({ code, state: returnedState }) => this.finishWithCode(code, returnedState, active))
        .catch((err: unknown) => {
          if (!this.flow || this.flow.listener !== listener) return
          this.fail('callback_failed', err)
        })
    }

    return { ok: true, ...this.statusValue, dir: active.dir }
  }

  /**
   * Begin logging in the PRIMARY account (system HOME, no staging slot):
   * tokens land in ~/.gemini / credential store so agy stays signed in.
   */
  async beginPrimary(proxyUrl?: string, alias?: string): Promise<PoolAuthStatus & { ok: boolean; dir?: string }> {
    const primary = this.pool.getPrimaryAccount()
    return this.startFlow({
      stagingId: primary.id,
      dir: homedir(),
      alias: alias?.trim() || primary.alias,
      proxyUrl: proxyUrl || primary.proxyUrl || detectSystemProxy(),
    })
  }

  /**
   * Import an existing refresh_token or OAuth token JSON document into the
   * primary account.
   */
  async importRefreshToken(
    tokenInput: string,
    alias?: string,
    proxyUrl?: string,
  ): Promise<{
    ok: boolean
    account?: ManagedAccount
    email?: string
    error?: string
    code?: PoolAuthStatusCode
  }> {
    const refreshToken = extractRefreshToken(tokenInput)
    if (!refreshToken) {
      return { ok: false, error: 'Invalid refresh token or token JSON format', code: 'invalid_code' }
    }
    await this.abortActive()
    this.setStatus({ phase: 'exchanging' })
    try {
      const tokens = await this.refresh(refreshToken, proxyUrl)
      if (!tokens?.access_token) {
        this.fail('exchange_failed', new Error('Token endpoint did not return an access token'))
        return { ok: false, error: 'Failed to exchange refresh token', code: 'exchange_failed' }
      }
      const email = await this.userEmail(tokens.access_token, proxyUrl)
      const primary = this.pool.getPrimaryAccount()

      if (process.platform === 'win32') {
        try {
          const docStr = buildAgyCredentialDoc(tokens)
          this.writeSlot(docStr)
          writePrimaryCredential({ raw: docStr, email, savedAt: Date.now() }, this.pool.dir)
        } catch {
          // best effort
        }
      } else if (process.env.NODE_TEST_CONTEXT === undefined) {
        try {
          const home = homedir()
          const primaryFile = writeAgyTokenFile(home, tokens)
          saveCredentialBackup(primaryFile)
          this.writeKeyring(readFileSync(primaryFile, 'utf8'), home)
        } catch {
          // best effort
        }
      }

      const emailChanged = Boolean(email && primary.email && primary.email.toLowerCase() !== email.toLowerCase())
      if (emailChanged && email) {
        this.pool.resetAccountIdentity(primary.id, email, true)
      }
      if (alias?.trim()) {
        this.pool.setAccountAlias(primary.id, alias.trim())
      }
      if (proxyUrl?.trim()) {
        this.pool.setAccountProxy(primary.id, proxyUrl.trim())
      }
      this.pool.clearAuthRequired(primary.id, true)
      this.pool.clearCooldown(primary.id, undefined, true)
      this.pool.updateAccountQuotas(primary.id, emailChanged ? {} : primary.quotas, email)
      void this.quota.refreshAccountQuota(primary, true).catch(() => undefined)
      this.log(`imported refresh token for primary account${email ? ` <${email}>` : ''}`)
      this.setStatus({ phase: 'done', alias: primary.alias || email, code: 'primary_activated' })
      this.onUpdate?.()
      return { ok: true, account: primary, email }
    } catch (err) {
      this.fail('exchange_failed', err)
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'exchange_failed',
      }
    }
  }

  /** Manual paste fallback: accepts a bare code or the full redirect URL. */
  async submitCode(input: string): Promise<PoolAuthStatus & { ok: boolean }> {
    const flow = this.flow
    if (!flow || this.statusValue.phase !== 'waiting') {
      return { ok: false, phase: this.statusValue.phase, code: 'no_active_flow' }
    }
    const parsed = parsePastedCode(input)
    if (!parsed) {
      return { ok: false, phase: 'waiting', code: 'invalid_code' }
    }
    if (parsed.state && parsed.state !== flow.state) {
      return { ok: false, phase: 'waiting', code: 'invalid_state' }
    }
    await this.finishWithCode(parsed.code, parsed.state ?? flow.state, flow)
    const after = this.status()
    return { ...after, ok: after.phase === 'done' }
  }

  private async finishWithCode(code: string, returnedState: string, owner?: ActiveFlow): Promise<void> {
    const flow = this.flow
    if (!flow || this.statusValue.phase !== 'waiting') return
    if (owner !== undefined && owner !== flow) return
    if (returnedState !== flow.state) {
      this.fail('invalid_state')
      return
    }
    this.setStatus({ phase: 'exchanging' })
    try {
      const tokens = await this.exchange(code, flow.verifier, flow.proxyUrl)
      if (this.flow !== flow) return

      const tokenFile = writeAgyTokenFile(flow.dir, tokens)
      saveCredentialBackup(tokenFile)
      if (process.platform === 'win32') {
        try {
          const raw = readFileSync(tokenFile, 'utf8')
          this.writeSlot(raw)
        } catch {
          // best effort
        }
      } else {
        try {
          this.writeKeyring(readFileSync(tokenFile, 'utf8'), flow.dir)
        } catch {
          // best effort
        }
      }
      const email = await this.userEmail(tokens.access_token, flow.proxyUrl)
      if (process.platform === 'win32') {
        try {
          const raw = readFileSync(tokenFile, 'utf8')
          writePrimaryCredential({ raw, email, savedAt: Date.now() }, this.pool.dir)
        } catch {
          // best effort
        }
      }

      const primary = this.pool.getPrimaryAccount()
      if (flow.proxyUrl && !primary.proxyUrl) {
        this.pool.setAccountProxy(primary.id, flow.proxyUrl)
      }
      const emailChanged = Boolean(
        email && primary.email && primary.email.toLowerCase() !== email.toLowerCase(),
      )
      if (emailChanged && email) {
        this.pool.resetAccountIdentity(primary.id, email, true)
      }
      this.pool.clearAuthRequired(primary.id, true)
      this.pool.clearCooldown(primary.id, undefined, true)
      this.pool.updateAccountQuotas(primary.id, emailChanged ? {} : primary.quotas, email)
      void this.quota.refreshAccountQuota(primary, true).catch(() => undefined)

      this.log(`primary account signed in${email ? ` <${email}>` : ''}`)
      this.flow = null
      if (flow.listener) void flow.listener.close().catch(() => undefined)
      this.setStatus({ phase: 'done', alias: email, code: 'primary_activated' })
      this.onUpdate?.()
    } catch (err) {
      if (this.flow === flow) this.fail('exchange_failed', err)
    }
  }

  private fail(code: PoolAuthStatusCode, detail?: unknown): void {
    const flow = this.flow
    this.log(`primary auth failed [${code}]${detail ? `: ${detail instanceof Error ? detail.message : String(detail)}` : ''}`)
    if (flow) {
      if (flow.listener) void flow.listener.close().catch(() => undefined)
      this.flow = null
    }
    this.setStatus({ phase: 'failed', code })
  }

  async cancel(): Promise<PoolAuthStatus & { ok: boolean }> {
    await this.abortActive()
    this.setStatus({ phase: 'idle' })
    return { ok: true, phase: 'idle' }
  }

  private async abortActive(): Promise<void> {
    const flow = this.flow
    if (!flow) return
    this.flow = null
    if (flow.listener) await flow.listener.close().catch(() => undefined)
  }
}
