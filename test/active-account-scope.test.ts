// The console's per-family "当前使用" badge must describe reality, not a guess.
//
// Reported 2026-11-23: a session running Orchestrator (Argon) as `ele` showed
// the Argon row claiming a different account was in use. The row was rendering
// the eligibility PREDICTION ("who would be picked") under an "in use" label.
// With a single primary account there is neither a pin nor a prediction: the
// family is either served by the one credential or it is not.
import { renderToStaticMarkup } from './helpers/client-render.ts'
import test from 'node:test'
import assert from 'node:assert/strict'

import { renderFamilyQuotaBar } from '../src/client/sections/QuotaPanel.ts'

const t = ((key: string, vars?: Record<string, string | number>) =>
  vars === undefined ? key : `${key}[${Object.values(vars).join(',')}]`) as never

test('an active family reads "in use"; an inactive one makes no claim', () => {
  const acc = {
    id: 'acc_1', alias: 'a', dir: '', enabled: true, createdAt: 1, cooldowns: {},
    quotas: { argon: { weeklyFraction: 1, weeklyResetTime: new Date(Date.now() + 86_400_000).toISOString() } },
  } as never

  const active = renderToStaticMarkup(renderFamilyQuotaBar(t, 'Argon', 'argon', acc, false, {
    isActive: true,
  }))
  assert.ok(active.includes('status.inUse'), 'the one account serves Argon, so the row says so')
  assert.equal(active.includes('account.predictedInUse'), false, 'no prediction label survives the pool removal')
  assert.equal(active.includes('account.setActive'), false, 'and there is nothing left to pin')

  const inactive = renderToStaticMarkup(renderFamilyQuotaBar(t, 'Argon', 'argon', acc, false, {
    isActive: false,
  }))
  assert.equal(inactive.includes('status.inUse'), false, 'an inactive family must not claim to be in use')
})
