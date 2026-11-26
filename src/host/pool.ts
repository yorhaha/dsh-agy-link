// AccountPoolManager: single primary account state, family/model cooldowns,
// quota cache, and eligibility checks for Google Antigravity.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { stateDir } from '../common/config.ts'
import {
  accountHasArgon,
  baseModelSlug,
  type AccountPlanTier,
  type AccountPoolData,
  type FamilyQuotaInfo,
  type ManagedAccount,
  type ModelFamily,
  type QuotaUnavailableState,
} from '../common/pool-types.ts'
import { accountCanServeModel } from './model-support.ts'
import { defaultPoolDir } from '../domain/accounts/paths.ts'
import { PoolAdmin } from '../domain/accounts/admin.ts'
import { earliestAvailableCountdown, earliestResetCountdown, sweepOldAgyLogs } from '../domain/accounts/countdown.ts'
import { PoolStore } from '../domain/accounts/store.ts'
import {
  LOW_QUOTA_5H,
  LOW_QUOTA_WEEKLY,
  explainIneligibility,
  isModelQuotaClear,
  isAccountEligible,
  type AccountIneligibilityReason,
} from '../domain/accounts/selection.ts'
import { resolveAccountPlanTier } from '../common/plan-tier.ts'
import { detectSystemProxy } from './wincred.ts'

export { defaultPoolDir } from '../domain/accounts/paths.ts'
export { LOW_QUOTA_5H, LOW_QUOTA_WEEKLY }
export type { AccountIneligibilityReason }

export class AccountPoolManager {
  private data: AccountPoolData
  private readonly baseDir: string
  private readonly store: PoolStore
  private readonly admin: PoolAdmin
  private readonly authStrikes = new Map<string, number>()
  private readonly unsupportedModels = new Map<string, Map<string, number>>()
  private catalog?: {
    get(accountId?: string): { models?: readonly { id: string }[]; source?: string }
    getAccountCatalog?(accountId?: string): { models?: readonly { id: string }[]; source?: string } | undefined
  }
  /** True when load() had to fall back to pool.json.last-good (observable for diagnostics). */
  recoveredFromLastGood = false

  setCatalog(catalog: {
    get(accountId?: string): { models?: readonly { id: string }[]; source?: string }
    getAccountCatalog?(accountId?: string): { models?: readonly { id: string }[]; source?: string } | undefined
  }): void {
    this.catalog = catalog
  }

  constructor(baseDir = defaultPoolDir()) {
    this.baseDir = baseDir
    this.store = new PoolStore(baseDir)
    const loaded = this.store.load()
    this.data = loaded.data
    this.recoveredFromLastGood = loaded.recoveredFromLastGood
    this.data = this.store.bootstrapDefaultAccount(this.data, detectSystemProxy)
    this.data = this.store.normalizeLegacyPrimary(this.data)
    this.store.snapshot(this.data)
    this.admin = new PoolAdmin({
      authStrikes: this.authStrikes,
      getData: () => this.data,
      persist: () => this.persist(),
    })
    this.admin.dropModelScopedCooldowns()
  }

  catalogForAccount(accountId: string): { models?: readonly { id: string }[]; source?: string } | undefined {
    if (!this.catalog) return undefined
    if (typeof this.catalog.getAccountCatalog === 'function') {
      return this.catalog.getAccountCatalog(accountId)
    }
    return this.catalog.get(accountId)
  }

  /** Determine whether the account supports a specific model. */
  isModelSupported(acc: ManagedAccount, model: string): boolean {
    return accountCanServeModel(acc, model, { unsupportedModels: this.unsupportedModels, catalogFor: (id) => this.catalogForAccount(id), pool: this })
  }

  markModelUnsupported(accountId: string, model: string): void {
    const learned = this.unsupportedModels.get(accountId) ?? new Map<string, number>()
    this.unsupportedModels.set(accountId, learned)
    learned.set(baseModelSlug(model), Date.now())
  }

  get dir(): string {
    return this.baseDir
  }

  private persist(): void {
    this.data = this.store.persist(this.data)
  }

  getPoolData(defaultProxy?: string): Readonly<AccountPoolData> {
    const sysProxy = defaultProxy || detectSystemProxy()
    return {
      ...this.data,
      ...(sysProxy ? { systemProxy: sysProxy } : {}),
    }
  }

  getPrimaryAccount(): ManagedAccount {
    return (
      this.data.accounts.find((a) => a.id === this.data.primaryAccountId)
      ?? this.data.accounts[0]!
    )
  }

  getAccounts(): readonly ManagedAccount[] {
    return this.data.accounts
  }

  /**
   * The account serving `family`. With a single primary account there is no
   * per-family pinning left, so this is always the primary.
   */
  getActiveAccountId(_family?: ModelFamily): string | undefined {
    return this.getPrimaryAccount()?.id
  }

  /**
   * Single-account selection: with no rotation, this answers the only question
   * left — "can this pool serve `family` (and `model`) right now?" — by
   * returning the primary account, or null when it is unavailable.
   */
  selectAccount(
    family: ModelFamily,
    model?: string,
    quotaModel?: string,
    avoidAccountIds?: readonly string[],
  ): ManagedAccount | null {
    return this.findAccount(family, model, quotaModel, avoidAccountIds)
  }

  /** The account `selectAccount` would return, or null. */
  findAccount(
    family: ModelFamily,
    model?: string,
    quotaModel?: string,
    avoidAccountIds?: readonly string[],
  ): ManagedAccount | null {
    const acc = this.getPrimaryAccount()
    if (!acc || acc.enabled !== true) return null
    if (avoidAccountIds?.includes(acc.id) === true) return null
    const now = Date.now()
    if (this.explainIneligibility(acc, family, now, model) !== null) return null
    const gated = quotaModel !== undefined && quotaModel !== '' ? quotaModel : model
    if (gated !== undefined && gated !== '' && !isModelQuotaClear(acc, family, gated, now)) return null
    return acc
  }

  getAccount(id: string): ManagedAccount | undefined {
    return this.data.accounts.find((a) => a.id === id)
  }

  /**
   * Sweep agy CLI log files older than maxDays (default: 7) in the system
   * ~/.gemini/antigravity-cli/log directory and plugin ACP log dir.
   */
  sweepOldLogs(maxDays = 7): number {
    return sweepOldAgyLogs(this.data.accounts, homedir(), maxDays, Date.now(), [join(stateDir(), 'logs')])
  }

  setAccountProxy(id: string, proxyUrl?: string): boolean {
    return this.admin.setAccountProxy(id, proxyUrl)
  }

  setAccountAlias(id: string, alias: string): boolean {
    return this.admin.setAccountAlias(id, alias)
  }

  setAccountPlanTier(id: string, tier: AccountPlanTier | undefined): boolean {
    return this.admin.setAccountPlanTier(id, tier)
  }

  setPlanTierOverride(id: string, tier: AccountPlanTier | undefined): boolean {
    return this.admin.setPlanTierOverride(id, tier)
  }

  markAuthRequired(id: string, reason?: string): void {
    this.admin.markAuthRequired(id, reason)
  }

  noteAuthFailure(id: string, reason?: string): boolean {
    return this.admin.noteAuthFailure(id, reason)
  }

  resetAccountIdentity(id: string, newEmail: string, resetAlias = false): void {
    this.admin.resetAccountIdentity(id, newEmail, resetAlias)
  }

  clearAuthRequired(id: string, force = false): void {
    this.admin.clearAuthRequired(id, force)
  }

  noteAuthReverifyAttempt(id: string): void {
    this.admin.noteAuthReverifyAttempt(id)
  }

  healAuthFlagsFromQuota(): string[] {
    return this.admin.healAuthFlagsFromQuota()
  }

  clearAccountEmail(id: string): void {
    this.admin.clearAccountEmail(id)
  }

  accountHasArgon(acc: ManagedAccount): boolean {
    return accountHasArgon(acc, this, this.catalogForAccount(acc.id))
  }

  explainIneligibility(
    acc: ManagedAccount,
    family: ModelFamily,
    now = Date.now(),
    model?: string,
  ): AccountIneligibilityReason | null {
    return explainIneligibility(acc, family, now, this, model)
  }

  isAccountEligible(acc: ManagedAccount, family: ModelFamily, now = Date.now()): boolean {
    return isAccountEligible(acc, family, now, this)
  }

  isAccountEligibleForModel(acc: ManagedAccount, family: ModelFamily, model?: string, now = Date.now()): boolean {
    return this.explainIneligibility(acc, family, now, model) === null
  }

  recordModelFailure(id: string, model: string, reason: string, serverResetTime?: string): void {
    this.admin.recordModelFailure(id, model, reason, serverResetTime)
  }

  recordModelSuccess(id: string, model: string): void {
    this.admin.recordModelSuccess(id, model)
  }

  updateAccountQuotas(id: string, quotas: Partial<Record<ModelFamily, FamilyQuotaInfo>>, email?: string): void {
    const acc = this.getAccount(id)
    if (!acc) return
    acc.quotas = {
      ...acc.quotas,
      ...quotas,
    }
    if (email) acc.email = email
    const healed = resolveAccountPlanTier(acc)
    if (healed !== undefined && acc.planTier !== healed) acc.planTier = healed
    this.persist()
  }

  noteQuotaUnavailable(id: string, state: QuotaUnavailableState): void {
    const acc = this.getAccount(id)
    if (!acc) return
    acc.quotaUnavailable = state
    this.persist()
  }

  clearQuotaUnavailable(id: string): void {
    const acc = this.getAccount(id)
    if (!acc?.quotaUnavailable) return
    delete acc.quotaUnavailable
    this.persist()
  }

  clearQuotaFamily(id: string, family: ModelFamily): void {
    const acc = this.getAccount(id)
    if (!acc?.quotas || acc.quotas[family] === undefined) return
    delete acc.quotas[family]
    this.persist()
  }

  recordFailure(id: string, family: ModelFamily, reason: string, serverResetTime?: string): void {
    this.admin.recordFailure(id, family, reason, serverResetTime)
  }

  recordSuccess(id: string, family: ModelFamily): void {
    this.admin.recordSuccess(id, family)
  }

  hasDedicatedGroup(id: string, family: ModelFamily): boolean {
    return this.getAccount(id)?.dedicatedGroups?.includes(family) === true
  }

  noteDedicatedGroup(id: string, family: ModelFamily): void {
    const acc = this.getAccount(id)
    if (!acc) return
    if (acc.dedicatedGroups?.includes(family)) return
    acc.dedicatedGroups = [...(acc.dedicatedGroups ?? []), family]
    this.persist()
  }

  forgetDedicatedGroup(id: string, family: ModelFamily): void {
    const acc = this.getAccount(id)
    if (!acc?.dedicatedGroups?.includes(family)) return
    acc.dedicatedGroups = acc.dedicatedGroups.filter((f) => f !== family)
    this.persist()
  }

  clearCooldown(id?: string, family?: ModelFamily, includeQuotaBench = false): void {
    this.admin.clearCooldown(id, family, includeQuotaBench)
  }

  getEarliestResetCountdown(family: ModelFamily): number | null {
    return earliestResetCountdown(this.data.accounts, family)
  }

  getEarliestAvailableCountdown(family: ModelFamily): number | null {
    return earliestAvailableCountdown(this.data.accounts, family)
  }
}
