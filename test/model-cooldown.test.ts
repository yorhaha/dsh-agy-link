// Model-scoped availability: an image-model 429 must pause ONLY that model.
//
// Google meters image generation against a per-model bucket inside the same
// `google` family (`quotas.google.models[].modelId = gemini-3.1-flash-image`),
// so the family is the wrong granularity for a 429. These tests pin the
// contract: family stays usable, the model cools down, selection skips it.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baseModelSlug, type ManagedAccount } from '../src/common/pool-types.ts'
import { isModelQuotaClear } from '../src/domain/accounts/selection.ts'
import { AccountPoolManager } from '../src/host/pool.ts'

const IMAGE = 'gemini-3.1-flash-image'
const DRIVER = 'gemini-4-neon'

function fullGoogle(pool: AccountPoolManager, id: string, imageFraction = 1): void {
  pool.updateAccountQuotas(id, {
    google: {
      remainingFraction: 1,
      weeklyFraction: 1,
      updatedAt: Date.now(),
      models: [{ modelId: IMAGE, remainingFraction: imageFraction }],
    },
  })
}

/** The single primary account on a clean pool, with its catalog discovered. */
function primaryWithCatalog(root: string): { pool: AccountPoolManager; a: ManagedAccount } {
  const pool = new AccountPoolManager(join(root, 'pool'))
  pool.setCatalog({
    get: () => ({ source: 'discovered', models: [{ id: DRIVER }, { id: IMAGE }, { id: 'gemini-3.8-flash' }] }),
  })
  const a = pool.getPrimaryAccount()
  fullGoogle(pool, a.id)
  return { pool, a }
}

describe('model-scoped cooldown', () => {
  test('a model 429 cools only that model; the family and its other models stay available', () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-model-cd-'))
    try {
      const { pool, a } = primaryWithCatalog(root)
      pool.recordModelFailure(a.id, IMAGE, 'You have exhausted your capacity on this model.', '2026-11-23T20:46:40Z')

      const after = pool.getAccount(a.id)!
      assert.equal(after.cooldowns.google, undefined, 'the family must never be cooled by a model 429')
      assert.ok(after.modelCooldowns?.[baseModelSlug(IMAGE)], 'the image model carries the cooldown')
      assert.equal(pool.isAccountEligibleForModel(after, 'google', IMAGE), false)
      assert.equal(pool.isAccountEligibleForModel(after, 'google', DRIVER), true)
      assert.equal(isModelQuotaClear(after, 'google', IMAGE, Date.now()), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the cooldown persists across a pool reload and a success clears it', () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-model-cd-persist-'))
    try {
      const dir = join(root, 'pool')
      const pool = new AccountPoolManager(dir)
      const a = pool.getPrimaryAccount()
      pool.recordModelFailure(a.id, IMAGE, 'capacity exhausted', '2026-11-23T20:46:40Z')

      const reloaded = new AccountPoolManager(dir)
      assert.ok(reloaded.getAccount(a.id)?.modelCooldowns?.[baseModelSlug(IMAGE)])

      reloaded.recordModelSuccess(a.id, IMAGE)
      assert.equal(reloaded.getAccount(a.id)?.modelCooldowns?.[baseModelSlug(IMAGE)], undefined)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('selection takes a SECOND quota model into account (image bucket pre-filter)', () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-model-cd-select-'))
    try {
      const { pool, a } = primaryWithCatalog(root)
      // The family row is healthy, but the image model's own bucket is drained.
      fullGoogle(pool, a.id, 0)

      // Without the hint the family is healthy for the driver model.
      assert.ok(pool.selectAccount('google', DRIVER))
      // With the image bucket as a second dimension, the account is rejected
      // for that model instead of burning a request it cannot serve.
      assert.equal(pool.selectAccount('google', DRIVER, IMAGE), null)
      assert.equal(isModelQuotaClear(a, 'google', IMAGE, Date.now()), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
