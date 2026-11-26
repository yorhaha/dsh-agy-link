// Pure auth evidence and eligibility verdicts.
//
// Kernel A in docs/architecture/coupling.md: identity, quota and catalog used
// to write into each other's state directly, so the same rule (a terminal TOS
// ban must survive an automatic clear; one auth banner is not proof of a dead
// login) was repeated at every call site. Nothing here reads the clock, disk or
// a service: callers hand in the current state plus one observation and get a
// verdict the single writer applies.
import { AUTH_CONFIRM_STRIKES, isTerminalAuthError } from '../../common/pool-types.ts'

/** The current auth flag as the verdict sees it. */
export interface AuthStateView {
  authRequired: boolean
  /** The stored authError; terminal bans live here. */
  authError?: string
  /** Consecutive non-authoritative auth failures already recorded (in-memory). */
  strikes: number
}

/**
 * One observation about an account's login. Sources only describe what was
 * seen; whether that is enough to change the flag is the verdict's job.
 */
export type AuthEvidence =
  /** An authenticated upstream call succeeded (quota, token refresh, a run). */
  | { kind: 'authenticated'; at: number; source: 'quota' | 'token' | 'run' | 'oauth' }
  /** An auth-classified failure; authoritative proof quarantines immediately. */
  | { kind: 'auth-failure'; at: number; reason: string; authoritative: boolean }
  /** A restriction only a human can lift (TOS ban / web verification). */
  | { kind: 'terminal-restriction'; at: number; reason: string }

export type AuthVerdict =
  | { action: 'none'; because: 'already-clear' | 'already-marked' | 'terminal-ban' | 'no-account' }
  | { action: 'mark'; reason: string }
  | { action: 'strike'; reason: string }
  | { action: 'clear' }

/**
 * Decide what one observation means for the flag.
 *
 * Rules, in one place:
 *   * an authenticated call disproves a non-terminal flag (issue #114: the TOS
 *     ban must survive every automatic clear);
 *   * authoritative OAuth evidence quarantines on first sight;
 *   * a bare "not signed in" banner needs `AUTH_CONFIRM_STRIKES` confirmations
 *     (network jitter produces the same bytes as a real sign-out);
 *   * a terminal restriction marks an unflagged account but never overwrites an
 *     existing reason — the same guard the quota refresh used inline.
 */
export function deriveAuthVerdict(state: AuthStateView, evidence: AuthEvidence): AuthVerdict {
  switch (evidence.kind) {
    case 'authenticated':
      if (!state.authRequired) return { action: 'none', because: 'already-clear' }
      if (isTerminalAuthError(state.authError)) return { action: 'none', because: 'terminal-ban' }
      return { action: 'clear' }
    case 'terminal-restriction':
      if (state.authRequired) return { action: 'none', because: 'already-marked' }
      return { action: 'mark', reason: evidence.reason }
    case 'auth-failure':
      if (evidence.authoritative) return { action: 'mark', reason: evidence.reason }
      if (state.strikes + 1 >= AUTH_CONFIRM_STRIKES) return { action: 'mark', reason: evidence.reason }
      return { action: 'strike', reason: evidence.reason }
  }
}

/** Why this account cannot serve a family right now (diagnostics only). */
export type EligibilityReason =
  | 'disabled'
  | 'auth'
  | 'cooldown'
  | 'quota'
  | 'unsupported'
  | 'model-unsupported'
  | 'model-cooldown'

/**
 * Everything eligibility needs, already resolved. `criticalAuth` folds the
 * account-level auth state (including a `validation_required` marker) into one
 * boolean so this function stays independent of pool-types helpers that need a
 * live manager.
 */
export interface EligibilityFacts {
  enabled: boolean
  criticalAuth: boolean
  /** Family is `argon` and the account has no confirmed Argon access. */
  argonUnsupported: boolean
  modelUnsupported: boolean
  familyCooldownUntil?: number
  modelCooldownUntil?: number
  quotaBenched: boolean
}

/** The first blocking reason in a stable diagnostic order, or null. */
export function deriveEligibility(facts: EligibilityFacts, now: number): EligibilityReason | null {
  if (!facts.enabled) return 'disabled'
  if (facts.criticalAuth) return 'auth'
  if (facts.argonUnsupported) return 'unsupported'
  if (facts.modelUnsupported) return 'model-unsupported'
  if (facts.familyCooldownUntil !== undefined && facts.familyCooldownUntil > now) return 'cooldown'
  if (facts.modelCooldownUntil !== undefined && facts.modelCooldownUntil > now) return 'model-cooldown'
  if (facts.quotaBenched) return 'quota'
  return null
}
