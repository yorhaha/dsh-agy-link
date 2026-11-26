import assert from 'node:assert/strict'
import test from 'node:test'
import { AUTH_CONFIRM_STRIKES } from '../src/common/pool-types.ts'
import { deriveAuthVerdict, deriveEligibility } from '../src/domain/accounts/evidence.ts'

test('authoritative OAuth evidence quarantines on first sight', () => {
  assert.deepEqual(
    deriveAuthVerdict(
      { authRequired: false, strikes: 0 },
      { kind: 'auth-failure', at: 1, reason: 'invalid_grant', authoritative: true },
    ),
    { action: 'mark', reason: 'invalid_grant' },
  )
})

test('a bare auth banner needs the configured confirmation strikes', () => {
  const evidence = { kind: 'auth-failure', at: 1, reason: 'agy is not signed in', authoritative: false } as const
  assert.deepEqual(
    deriveAuthVerdict({ authRequired: false, strikes: 0 }, evidence),
    { action: 'strike', reason: 'agy is not signed in' },
  )
  assert.deepEqual(
    deriveAuthVerdict({ authRequired: false, strikes: AUTH_CONFIRM_STRIKES - 1 }, evidence),
    { action: 'mark', reason: 'agy is not signed in' },
  )
})

test('authenticated evidence clears a non-terminal flag only', () => {
  const evidence = { kind: 'authenticated', at: 1, source: 'quota' } as const
  assert.deepEqual(deriveAuthVerdict({ authRequired: false, strikes: 0 }, evidence), { action: 'none', because: 'already-clear' })
  assert.deepEqual(
    deriveAuthVerdict({ authRequired: true, authError: 'invalid_grant', strikes: 0 }, evidence),
    { action: 'clear' },
  )
  assert.deepEqual(
    deriveAuthVerdict(
      { authRequired: true, authError: 'TOS_VIOLATION: disabled for violation of Terms of Service', strikes: 0 },
      evidence,
    ),
    { action: 'none', because: 'terminal-ban' },
  )
})

test('a terminal restriction marks an unflagged account without overwriting a reason', () => {
  const evidence = { kind: 'terminal-restriction', at: 1, reason: 'VALIDATION_REQUIRED' } as const
  assert.deepEqual(
    deriveAuthVerdict({ authRequired: false, strikes: 0 }, evidence),
    { action: 'mark', reason: 'VALIDATION_REQUIRED' },
  )
  assert.deepEqual(
    deriveAuthVerdict({ authRequired: true, authError: 'invalid_grant', strikes: 0 }, evidence),
    { action: 'none', because: 'already-marked' },
  )
})

test('eligibility reports the first blocker in diagnostic order', () => {
  const allBlocked = {
    enabled: false,
    criticalAuth: true,
    argonUnsupported: true,
    modelUnsupported: true,
    familyCooldownUntil: 10,
    modelCooldownUntil: 10,
    quotaBenched: true,
  }
  assert.equal(deriveEligibility(allBlocked, 0), 'disabled')
  assert.equal(deriveEligibility({ ...allBlocked, enabled: true }, 0), 'auth')
  assert.equal(deriveEligibility({ ...allBlocked, enabled: true, criticalAuth: false }, 0), 'unsupported')
  assert.equal(
    deriveEligibility({ ...allBlocked, enabled: true, criticalAuth: false, argonUnsupported: false }, 0),
    'model-unsupported',
  )
  assert.equal(
    deriveEligibility({ ...allBlocked, enabled: true, criticalAuth: false, argonUnsupported: false, modelUnsupported: false }, 0),
    'cooldown',
  )
  assert.equal(
    deriveEligibility(
      { ...allBlocked, enabled: true, criticalAuth: false, argonUnsupported: false, modelUnsupported: false, familyCooldownUntil: undefined },
      0,
    ),
    'model-cooldown',
  )
  assert.equal(
    deriveEligibility(
      {
        ...allBlocked,
        enabled: true,
        criticalAuth: false,
        argonUnsupported: false,
        modelUnsupported: false,
        familyCooldownUntil: undefined,
        modelCooldownUntil: undefined,
      },
      0,
    ),
    'quota',
  )
})

test('expired cooldowns and clear quota do not block eligibility', () => {
  assert.equal(
    deriveEligibility(
      {
        enabled: true,
        criticalAuth: false,
        argonUnsupported: false,
        modelUnsupported: false,
        familyCooldownUntil: 5,
        modelCooldownUntil: 5,
        quotaBenched: false,
      },
      10,
    ),
    null,
  )
})
