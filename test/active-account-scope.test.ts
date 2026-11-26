// The console's per-family "当前使用" badge must describe reality, not a guess.
//
// Reported 2026-11-23: a session running Orchestrator (Argon) as `ele` showed
// the Argon row claiming a different account was in use. The row was rendering
// the eligibility PREDICTION ("who would be picked") under an "in use" label.
// With a single primary account there is no pointer to write, but the console
// still distinguishes a real pin from a prediction, so this rendering contract
// must keep holding.
import { renderToStaticMarkup } from './helpers/client-render.ts'
import test from 'node:test'
import assert from 'node:assert/strict'

import { renderFamilyQuotaBar } from '../src/client/sections/QuotaPanel.ts'

const t = ((key: string, vars?: Record<string, string | number>) =>
  vars === undefined ? key : `${key}[${Object.values(vars).join(',')}]`) as never

test('a predicted family shows "predicted", a real pin shows "in use"', () => {
  const acc = {
    id: 'acc_1', alias: 'a', dir: '', enabled: true, createdAt: 1, cooldowns: {},
    quotas: { argon: { weeklyFraction: 1, weeklyResetTime: new Date(Date.now() + 86_400_000).toISOString() } },
  } as never

  const predicted = renderToStaticMarkup(renderFamilyQuotaBar(t, 'Argon', 'argon', acc, false, {
    isActive: true,
    predicted: true,
  }))
  assert.ok(predicted.includes('account.predictedInUse'), 'an unpinned family must not claim to be in use')
  assert.equal(predicted.includes('status.inUse'), false)

  const pinned = renderToStaticMarkup(renderFamilyQuotaBar(t, 'Argon', 'argon', acc, false, {
    isActive: true,
    predicted: false,
  }))
  assert.ok(pinned.includes('status.inUse'), 'a real pin reads "in use"')
  assert.equal(pinned.includes('account.predictedInUse'), false)
})
