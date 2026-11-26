// The header badge must describe the FAMILY the session's model belongs to.
//
// Reported 2026-11-23: a session showing `Gemini 4 Argon High` in the composer
// displayed `AGY · dao 98%` — the *Gemini* 5-hour quota — while the console's
// Argon row correctly said 58%. The badge resolved the `google` book alone.
// These tests pin the resolution the badge now uses: model -> family -> the
// single primary account, and THAT family's own quota book.
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSessionView } from '../src/common/session-view.ts'
import type { AccountPoolData, ManagedAccount } from '../src/common/pool-types.ts'

const RESET_FUTURE = new Date(Date.now() + 6 * 86_400_000).toISOString()
const RESET_PAST = new Date(Date.now() - 3 * 3_600_000).toISOString()

function account(over: Partial<ManagedAccount> & { id: string }): ManagedAccount {
  return {
    alias: over.id,
    dir: '',
    enabled: true,
    createdAt: 1,
    cooldowns: {},
    ...over,
  } as ManagedAccount
}

const dao = account({
  id: 'acc_dao',
  alias: 'dao',
  email: 'dao@example.com',
  quotas: {
    google: { remainingFraction: 0.98, weeklyFraction: 0.56, resetTime: RESET_FUTURE, updatedAt: Date.now() },
    argon: { weeklyFraction: 0.58, weeklyResetTime: RESET_FUTURE, updatedAt: Date.now() },
  },
})

const accounts = [dao]

const poolData: AccountPoolData = {
  version: 1,
  defaultCooldownMs: 900_000,
  maxCooldownMs: 3_600_000,
  primaryAccountId: 'acc_dao',
  accounts,
}

test('an Argon session reports the Argon weekly book of the primary account', () => {
  const view = buildSessionView({ poolData, accounts, model: 'gemini-4-argon-high' })
  assert.equal(view.family, 'argon')
  assert.equal(view.accountId, 'acc_dao')
  assert.equal(view.alias, 'dao')
  assert.equal(view.percent, 58, "dao's Argon weekly — never its Gemini 98%")
  assert.equal(view.window, 'weekly')
  assert.equal(view.source, 'predicted')
  assert.equal(view.cooling, false)
  assert.equal(view.eligible, true)
})

test('a Gemini session reports the google 5-hour window of the same account', () => {
  const view = buildSessionView({ poolData, accounts, model: 'gemini-4-pro' })
  assert.equal(view.family, 'google')
  assert.equal(view.accountId, 'acc_dao')
  assert.equal(view.percent, 98)
  assert.equal(view.window, 'five-hour')
  assert.equal(view.source, 'predicted')
})

test('an absent Argon row stays unknown instead of borrowing the Gemini reading', () => {
  const noArgon = account({
    id: 'acc_dao',
    alias: 'dao',
    quotas: { google: { remainingFraction: 0.95, weeklyFraction: 0.95, resetTime: RESET_FUTURE, updatedAt: Date.now() } },
  })
  const view = buildSessionView({
    poolData: { ...poolData, accounts: [noArgon] },
    accounts: [noArgon],
    model: 'gemini-4-argon',
  })
  assert.equal(view.accountId, 'acc_dao')
  assert.equal(view.percent, null, 'no argon data means no percentage')
  assert.equal(view.window, 'none')
})

test('a sticky session binding is reported as "in use", not as a prediction', () => {
  const view = buildSessionView({
    poolData,
    accounts,
    model: 'gemini-4-argon-high',
    stickyAccountId: 'acc_dao',
  })
  assert.equal(view.accountId, 'acc_dao', 'the session really ran on the primary account')
  assert.equal(view.percent, 58, 'its own argon reading')
  assert.equal(view.source, 'session')
})

test('without a sticky binding the reading is a prediction, never "in use"', () => {
  const view = buildSessionView({ poolData, accounts, model: 'gemini-4-argon-medium' })
  assert.equal(view.accountId, 'acc_dao')
  assert.equal(view.source, 'predicted')
})

test('a sticky id that no longer exists falls back to the primary account', () => {
  const view = buildSessionView({
    poolData,
    accounts,
    model: 'gemini-4-argon',
    stickyAccountId: 'acc_gone',
  })
  assert.equal(view.accountId, 'acc_dao')
  assert.equal(view.source, 'predicted', 'a stale binding must not be announced as in use')
})

test('a reset boundary already in the past marks the percentage stale', () => {
  const stale = account({
    id: 'acc_dao',
    alias: 'dao',
    quotas: { argon: { weeklyFraction: 0.33, weeklyResetTime: RESET_PAST, updatedAt: Date.now() - 30 * 3_600_000 } },
  })
  const view = buildSessionView({
    poolData: { ...poolData, accounts: [stale] },
    accounts: [stale],
    model: 'gemini-4-argon',
  })
  assert.equal(view.percent, 33)
  assert.equal(view.stale, true, 'a passed boundary must not read as live data')
})

test('no model means no claim: an empty selection reports nothing', () => {
  const view = buildSessionView({ poolData, accounts, model: '' })
  assert.equal(view.family, null)
  assert.equal(view.accountId, null)
  assert.equal(view.percent, null)
  assert.equal(view.source, 'none')
})

test('a model family with no quota row reports no percentage, not a neighbour', () => {
  const view = buildSessionView({ poolData, accounts, model: 'claude-opus-5-5' })
  assert.equal(view.family, 'anthropic')
  assert.equal(view.accountId, 'acc_dao')
  assert.equal(view.percent, null)
  assert.equal(view.window, 'none')
})
