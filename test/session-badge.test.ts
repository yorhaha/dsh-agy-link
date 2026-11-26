// Header badge rendering rules (issue: the badge contradicted the composer and
// the console for an Argon session, reported 2026-11-23).
//
// The badge may only claim what the session view resolved. Without a view it
// must stay silent about the account rather than borrow another family's book.
import './helpers/client-render.ts'
import { React, renderToStaticMarkup } from './helpers/client-render.ts'

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSessionView } from '../src/common/session-view.ts'
import type { AccountPoolData, ManagedAccount } from '../src/common/pool-types.ts'
import { resolveBadgeReadout } from '../src/client/sections/SessionStatus.ts'
import { createSessionStatus } from '../src/client/sections/SessionStatus.ts'
import { disposeStatusPolling, publishStatusSnapshot } from '../src/client/status.ts'
import { agyModalStore, modalHostManager } from '../src/client/ui/Modal.ts'

const RESET = new Date(Date.now() + 6 * 86_400_000).toISOString()

function account(over: Partial<ManagedAccount> & { id: string }): ManagedAccount {
  return { alias: over.id, dir: '', enabled: true, createdAt: 1, cooldowns: {}, ...over } as ManagedAccount
}

const dao = account({
  id: 'acc_dao',
  alias: 'dao',
  email: 'dao@example.com',
  quotas: {
    google: { remainingFraction: 0.98, weeklyFraction: 0.56, resetTime: RESET, updatedAt: Date.now() },
    argon: { weeklyFraction: 0.58, weeklyResetTime: RESET, updatedAt: Date.now() },
  },
})

const pool: AccountPoolData = {
  version: 1,
  defaultCooldownMs: 900_000,
  maxCooldownMs: 3_600_000,
  primaryAccountId: 'acc_dao',
  accounts: [dao],
}

const argonView = buildSessionView({ poolData: pool, accounts: [dao], model: 'gemini-4-argon-high' })

test('a session view wins: the badge shows the Argon book of the primary account', () => {
  const readout = resolveBadgeReadout({
    pool,
    accounts: pool.accounts,
    view: argonView,
    sessionScoped: true,
    now: Date.now(),
  })
  assert.equal(readout.accountId, 'acc_dao')
  assert.equal(readout.percent, 58)
  assert.equal(readout.window, 'weekly')
  assert.equal(readout.source, 'predicted')
})

test('a session with no answer yet claims nothing instead of showing google', () => {
  const readout = resolveBadgeReadout({
    pool,
    accounts: pool.accounts,
    view: null,
    sessionScoped: true,
    now: Date.now(),
  })
  assert.equal(readout.accountId, null)
  assert.equal(readout.percent, null)
  assert.equal(readout.source, 'none')
})

test('without a session context the historical google readout is preserved', () => {
  const readout = resolveBadgeReadout({
    pool,
    accounts: pool.accounts,
    view: null,
    sessionScoped: false,
    now: Date.now(),
  })
  assert.equal(readout.accountId, 'acc_dao')
  assert.equal(readout.percent, 98)
  assert.equal(readout.family, 'google')
  assert.equal(readout.source, 'legacy')
})

const locale = { subscribe: () => () => {}, bind: () => (key: string) => key }

const createElement = (React as {
  createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown
}).createElement

function renderBadge(props?: { sessionId?: string }): string {
  const Badge = createSessionStatus(locale as never, () => null)
  return renderToStaticMarkup(createElement(Badge, props as never))
}

test('the rendered badge no longer announces another family\'s account for a session', () => {
  const prevOpen = agyModalStore.open
  const prevActive = modalHostManager.activeId
  try {
    modalHostManager.activeId = null
    agyModalStore.setOpen(false)
    publishStatusSnapshot({ pool } as never)
    const scoped = renderBadge({ sessionId: 'session-1' })
    assert.equal(/AGY · dao/.test(scoped), false, 'an unresolved session must not print the account')
    assert.match(scoped, /AGY \(1\)/, 'it falls back to the account count only')
    assert.equal(/98%/.test(scoped), false, 'and prints no percentage it cannot attribute')

    const unscoped = renderBadge()
    assert.match(unscoped, /AGY · dao/, 'the session-less preview still reads the primary account')
    assert.match(unscoped, /98%/)
  } finally {
    agyModalStore.setOpen(prevOpen)
    modalHostManager.activeId = prevActive
    publishStatusSnapshot({ showHeaderBadge: true } as never)
    disposeStatusPolling()
  }
})
