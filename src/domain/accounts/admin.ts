// Single-account state mutations (proxy, alias, plan tier, cooldowns, auth flags),
// extracted from AccountPoolManager so persistence stays decoupled from host logic.
import {
  argonSharesGoogleGroup,
  effectiveFamilyCooldown,
  isTerminalAuthError,
  sharedArgonPeerFamily,
  type AccountPlanTier,
  type AccountPoolData,
  type ManagedAccount,
  type ModelFamily,
} from '../../common/pool-types.ts'
import { normalizeModelFamily } from '../../common/quota-bench.ts'
import { applyModelFailure, clearModelCooldown, cooldownUntilFor, dropLegacyModelScopedFamilyCooldowns } from './model-cooldown.ts'
import { AccountAuthFlags } from './auth-state.ts'
import type { AuthEvidence, AuthVerdict } from './evidence.ts'

/** State and capabilities AccountPoolManager lends to PoolAdmin. */
export interface PoolAdminDeps {
  /** Per-account consecutive non-authoritative auth-failure streak (in-memory). */
  authStrikes: Map<string, number>
  /** The manager's current in-memory cache. */
  getData(): AccountPoolData
  /** Persist the manager's current cache. */
  persist(): void
}

export class PoolAdmin {
  /** 需重新登录 flag lifecycle (mark / confirm / clear / heal / back-off). */
  private readonly authFlags: AccountAuthFlags

  constructor(private readonly deps: PoolAdminDeps) {
    this.authFlags = new AccountAuthFlags(this.deps)
  }

  private account(id: string): ManagedAccount | undefined {
    return this.deps.getData().accounts.find((a) => a.id === id)
  }

  setAccountProxy(id: string, proxyUrl?: string): boolean {
    const acc = this.account(id)
    if (!acc) return false
    acc.proxyUrl = proxyUrl?.trim() ? proxyUrl.trim() : undefined
    this.deps.persist()
    return true
  }

  setAccountAlias(id: string, alias: string): boolean {
    const acc = this.account(id)
    if (!acc) return false
    acc.alias = alias.trim()
    acc.defaultAlias = false
    this.deps.persist()
    return true
  }

  setAccountPlanTier(id: string, tier: AccountPlanTier | undefined): boolean {
    const acc = this.account(id)
    if (!acc) return false
    if (acc.planTier === tier) return true
    if (tier === undefined || tier === 'unknown') delete acc.planTier
    else acc.planTier = tier
    this.deps.persist()
    return true
  }

  setPlanTierOverride(id: string, tier: AccountPlanTier | undefined): boolean {
    const acc = this.account(id)
    if (!acc) return false
    const next = tier === 'unknown' ? undefined : tier
    if (acc.planTierOverride === next) return true
    if (next === undefined) delete acc.planTierOverride
    else acc.planTierOverride = next
    this.deps.persist()
    return true
  }

  markAuthRequired(id: string, reason?: string): void {
    this.authFlags.mark(id, reason)
  }

  /** Confirmation-gated quarantine for a non-authoritative auth banner (2 strikes). */
  noteAuthFailure(id: string, reason?: string): boolean {
    return this.authFlags.noteFailure(id, reason)
  }

  /** Single writer for quota/token observations; see evidence.deriveAuthVerdict. */
  applyAuthEvidence(id: string, evidence: AuthEvidence): AuthVerdict {
    return this.authFlags.applyEvidence(id, evidence)
  }

  /**
   * External re-login detected: identity-bound state from the PREVIOUS account
   * must not leak onto the new one.
   */
  resetAccountIdentity(id: string, newEmail: string, resetAlias = false): void {
    const acc = this.account(id)
    if (!acc) return
    acc.email = newEmail
    acc.cooldowns = {}
    acc.quotas = {}
    delete acc.dedicatedGroups
    delete acc.planTier
    delete acc.quotaUnavailable
    delete acc.authRequired
    delete acc.authError
    delete acc.authMarkedAt
    delete acc.authReverifyAttempts
    if (resetAlias && acc.systemHome) {
      acc.alias = 'Primary account (system sign-in)'
      acc.defaultAlias = true
    }
    this.deps.persist()
  }

  /** Drop the flag (automatic paths never lift a terminal TOS ban; force = user action). */
  clearAuthRequired(id: string, force = false): void {
    this.authFlags.clear(id, force)
  }

  /** Count one failed background re-verification (drives the 2m→30m back-off). */
  noteAuthReverifyAttempt(id: string): void {
    this.authFlags.noteReverifyAttempt(id)
  }

  /** Clear flags that a NEWER quota snapshot already disproved (zero network). */
  healAuthFlagsFromQuota(): string[] {
    return this.authFlags.healFromQuota()
  }

  clearAccountEmail(id: string): void {
    const acc = this.account(id)
    if (!acc) return
    delete acc.email
    this.deps.persist()
  }

  /**
   * Drop cooldowns that were recorded from a MODEL-scoped refusal.
   */
  dropModelScopedCooldowns(): number {
    const dropped = dropLegacyModelScopedFamilyCooldowns(this.deps.getData().accounts)
    if (dropped > 0) this.deps.persist()
    return dropped
  }

  /** Clear cooldowns (family-level, and every model bucket of that account). */
  clearCooldown(id?: string, family?: ModelFamily, includeQuotaBench = false): void {
    const now = Date.now()
    const targetFamily = family ? (normalizeModelFamily(family) ?? family) : undefined
    const clearOne = (acc: ManagedAccount): void => {
      acc.cooldowns ??= {}
      const sharedArgon = argonSharesGoogleGroup(acc)
      if (targetFamily) {
        delete acc.cooldowns[targetFamily]
        if (targetFamily === 'google' && !acc.quotas?.argon) delete acc.cooldowns.argon
        if (targetFamily === 'argon' && includeQuotaBench && sharedArgon) delete acc.cooldowns.google
      } else {
        acc.cooldowns = {}
      }
      acc.modelCooldowns = {}
      if (!includeQuotaBench) return
      const families: ModelFamily[] = targetFamily
        ? ((targetFamily === 'google' && !acc.quotas?.argon) || (targetFamily === 'argon' && sharedArgon) ? ['google', 'argon'] : [targetFamily])
        : [...new Set([...(Object.keys(acc.quotas ?? {}) as ModelFamily[]), ...(sharedArgon ? (['argon'] as ModelFamily[]) : [])])]
      if (families.length === 0) return
      acc.quotaGateClearedAt ??= {}
      for (const fam of families) {
        const updatedAt = acc.quotas?.[fam]?.updatedAt ?? (fam === 'argon' ? acc.quotas?.google?.updatedAt : undefined)
        acc.quotaGateClearedAt[fam] = Math.max(now, updatedAt ?? 0)
      }
    }
    if (id) {
      const acc = this.account(id)
      if (!acc) return
      clearOne(acc)
    } else {
      for (const acc of this.deps.getData().accounts) clearOne(acc)
    }
    this.deps.persist()
  }

  /** Record a 429 that belongs to ONE model's own bucket (never the family). */
  recordModelFailure(id: string, model: string, reason: string, serverResetTime?: string): void {
    const acc = this.account(id)
    const data = this.deps.getData()
    if (!acc) return
    applyModelFailure(acc, model, reason, serverResetTime, data)
    this.deps.persist()
  }

  /** Clear one model's cooldown after a successful call on it. */
  recordModelSuccess(id: string, model: string): void {
    const acc = this.account(id)
    if (acc && clearModelCooldown(acc, model)) this.deps.persist()
  }

  /**
   * Records a rate-limit / 429 error and sets cooldown for the requested model family.
   */
  recordFailure(id: string, family: ModelFamily, reason: string, serverResetTime?: string): void {
    const data = this.deps.getData()
    const acc = this.account(id)
    if (!acc) return
    acc.cooldowns ??= {}
    const prev = effectiveFamilyCooldown(acc, family)
    const failures = (prev?.consecutiveFailures ?? 0) + 1
    const entry = { cooldownUntil: cooldownUntilFor(data, failures, reason, serverResetTime), reason, consecutiveFailures: failures }
    acc.cooldowns[family] = entry
    const peer = sharedArgonPeerFamily(acc, family)
    if (peer) acc.cooldowns[peer] = { ...entry }
    this.deps.persist()
  }

  /**
   * Records a successful run, clearing failure counter and authRequired flag for the family.
   */
  recordSuccess(id: string, family: ModelFamily): void {
    const acc = this.account(id)
    if (!acc) return
    acc.lastUsedAt = Date.now()
    if (acc.authRequired && !isTerminalAuthError(acc.authError)) {
      delete acc.authRequired
      delete acc.authError
      delete acc.authMarkedAt
      delete acc.authReverifyAttempts
    }
    if (acc.cooldowns?.[family]) delete acc.cooldowns[family]
    const peer = sharedArgonPeerFamily(acc, family)
    if (peer && acc.cooldowns?.[peer]) delete acc.cooldowns[peer]
    this.deps.authStrikes.delete(id)
    this.deps.persist()
  }
}
