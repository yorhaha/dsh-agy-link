// Pure account-eligibility policy for the single primary account:
// predicates, quota-bench detection, and reset-time calculation.
//
// Nothing here touches disk or reads the wall clock: every function takes its
// inputs explicitly (account, family, now, pool) so eligibility rules stay
// side-effect-free and unit-testable in isolation.
import {
  accountHasArgon,
  argonSharesGoogleGroup,
  baseModelSlug,
  effectiveFamilyCooldown,
  type FamilyQuotaInfo,
  type ManagedAccount,
  type ModelFamily,
} from '../../common/pool-types.ts'
import {
  isAccountCriticalAuth,
  isQuotaBenched,
  LOW_QUOTA_5H,
  LOW_QUOTA_WEEKLY,
} from '../../common/quota-bench.ts'

export { isQuotaBenched, LOW_QUOTA_5H, LOW_QUOTA_WEEKLY }

/** Why the account cannot serve a family right now (diagnostics only). */
export type AccountIneligibilityReason = 'disabled' | 'auth' | 'cooldown' | 'quota' | 'unsupported' | 'model-unsupported' | 'model-cooldown'

/**
 * The slice of the manager the Argon check needs: whether the account has
 * itself reported a dedicated quota group for a family.
 */
export interface DedicatedGroupSource {
  hasDedicatedGroup?: (id: string, family: ModelFamily) => boolean
  isModelSupported?: (acc: ManagedAccount, model: string) => boolean
  catalogForAccount?: (id: string) => { source?: string; models?: readonly { id: string }[] } | undefined
}

/**
 * Why this account cannot serve `family` right now, or null when it can.
 */
export function explainIneligibility(
  acc: ManagedAccount,
  family: ModelFamily,
  now: number,
  pool?: DedicatedGroupSource | null,
  model?: string,
): AccountIneligibilityReason | null {
  if (!acc.enabled) return 'disabled'
  if (isAccountCriticalAuth(acc)) return 'auth'
  if (family === 'argon' && !accountHasArgon(acc, pool, pool?.catalogForAccount?.(acc.id))) return 'unsupported'
  if (model && pool?.isModelSupported && !pool.isModelSupported(acc, model)) {
    return 'model-unsupported'
  }
  const cd = effectiveFamilyCooldown(acc, family)
  if (cd && cd.cooldownUntil > now) return 'cooldown'
  if (model) {
    const mcd = acc.modelCooldowns?.[baseModelSlug(model)]
    if (mcd && mcd.cooldownUntil > now) return 'model-cooldown'
  }
  if (isQuotaBenched(acc, family, now, model)) return 'quota'
  return null
}

/**
 * True when a specific MODEL's quota bucket still has room on this account.
 */
export function isModelQuotaClear(acc: ManagedAccount, family: ModelFamily, model: string, now: number): boolean {
  if (model.trim() === '') return true
  const mcd = acc.modelCooldowns?.[baseModelSlug(model)]
  if (mcd && mcd.cooldownUntil > now) return false
  return !isQuotaBenched(acc, family, now, model)
}

/**
 * Check whether an account is eligible to serve requests for the given family.
 */
export function isAccountEligible(
  acc: ManagedAccount,
  family: ModelFamily,
  now: number,
  pool?: DedicatedGroupSource | null,
  model?: string,
): boolean {
  return explainIneligibility(acc, family, now, pool, model) === null
}

function effectiveFamilyQuota(acc: ManagedAccount, family: ModelFamily): FamilyQuotaInfo | undefined {
  if (family === 'argon' && argonSharesGoogleGroup(acc)) {
    return acc.quotas?.google
  }
  return acc.quotas?.[family]
}

/**
 * Next moment this account's quota state refreshes for one family: the
 * sooner of the 5h window reset and the weekly cap reset. NaN when unknown.
 */
export function nextQuotaResetAt(acc: ManagedAccount, family: ModelFamily): number {
  const q = effectiveFamilyQuota(acc, family)
  const stamps = [q?.resetTime, q?.weeklyResetTime]
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .map((v) => Date.parse(v))
    .filter((t) => !Number.isNaN(t))
  return stamps.length === 0 ? Number.NaN : Math.min(...stamps)
}
