// Regression coverage for the "red badge outlives its evidence" class of false
// positives (reported 2026-11-23): an account was flagged 需重新登录 by a
// transient identity/transport misfire, stayed out of rotation, and kept the
// badge for up to ~70 minutes although its quotas kept refreshing normally.
//
// Two contracts are pinned here:
//   1. a quota snapshot NEWER than the flag proves the login works — whoever
//      wrote it (web + CLI share pool.json), the flag is dropped with no network;
//   2. flagged accounts are re-verified on a short timer with an exponential
//      back-off, so a transient flag clears in minutes while a dead login backs
//      off instead of being probed every two minutes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPoolManager } from '../src/host/pool.ts'
import { QuotaService } from '../src/host/quota.ts'
import {
  AUTH_FAST_REVERIFY_MS,
  AUTH_REVERIFY_DELAY_MS,
  AUTH_REVERIFY_MAX_MS,
  authReverifyDelayMs,
  needsAuthReverify,
  type ManagedAccount,
} from '../src/common/pool-types.ts'

function withPool(fn: (pool: AccountPoolManager, dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agy-auth-heal-'))
  const pool = new AccountPoolManager(dir)
  return Promise.resolve(fn(pool, dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function isolate(pool: AccountPoolManager, label: string): ManagedAccount {
  const acc = pool.getPrimaryAccount()
  pool.setAccountAlias(acc.id, label)
  return pool.getAccount(acc.id)!
}

test('heal: a quota snapshot newer than the flag disproves it (no network)', async () => {
  await withPool((pool) => {
    const acc = isolate(pool, 'dao')
    pool.markAuthRequired(acc.id, 'ACP identity mismatch: agy fell back to the machine-wide keyring')
    const markedAt = pool.getAccount(acc.id)!.authMarkedAt!
    pool.updateAccountQuotas(acc.id, {
      google: { remainingFraction: 0.76, weeklyFraction: 0.56, updatedAt: markedAt + 1_000 },
    })
    assert.deepEqual(pool.healAuthFlagsFromQuota(), [acc.id])
    assert.equal(pool.getAccount(acc.id)!.authRequired, undefined, 'the badge is gone')
    assert.equal(pool.getAccount(acc.id)!.authError, undefined)
  })
})

test('heal: an OLDER quota snapshot is not evidence and leaves the flag alone', async () => {
  await withPool((pool) => {
    const acc = isolate(pool, 'dao')
    const old = Date.now() - 60 * 60_000
    pool.updateAccountQuotas(acc.id, { google: { remainingFraction: 0.76, updatedAt: old } })
    pool.markAuthRequired(acc.id, 'token endpoint 400: invalid_grant')
    assert.deepEqual(pool.healAuthFlagsFromQuota(), [])
    assert.equal(pool.getAccount(acc.id)!.authRequired, true)
  })
})

test('heal: a legacy flag without authMarkedAt is disproved by any quota row', async () => {
  await withPool((pool) => {
    const acc = isolate(pool, 'jackson')
    // Old builds persisted the flag without a timestamp (live 2026-11-23).
    pool.updateAccountQuotas(acc.id, { google: { remainingFraction: 0.87, updatedAt: Date.now() } })
    const live = pool.getAccount(acc.id)!
    live.authRequired = true
    live.authError = 'ACP identity mismatch: agy fell back to the machine-wide keyring instead of x'
    delete live.authMarkedAt
    assert.deepEqual(pool.healAuthFlagsFromQuota(), [acc.id])
  })
})

test('heal: Google verification and TOS bans are never healed by quota data', async () => {
  await withPool((pool) => {
    const valid = isolate(pool, 'valid')
    pool.markAuthRequired(valid.id, 'VALIDATION_REQUIRED (https://accounts.google.com/x)')
    pool.getAccount(valid.id)!.quotaUnavailable = { reason: 'validation_required', since: Date.now(), retryAfter: Date.now() }
    pool.updateAccountQuotas(valid.id, { google: { remainingFraction: 0.5, updatedAt: Date.now() + 1_000 } })

    const tos = isolate(pool, 'tos')
    pool.markAuthRequired(tos.id, 'TOS_VIOLATION (https://forms.gle/x)')
    pool.updateAccountQuotas(tos.id, { google: { remainingFraction: 0.5, updatedAt: Date.now() + 1_000 } })

    assert.deepEqual(pool.healAuthFlagsFromQuota(), [])
    assert.equal(pool.getAccount(valid.id)!.authRequired, true, 'a verification challenge needs the human')
    assert.equal(pool.getAccount(tos.id)!.authRequired, true, 'a terminal ban waits for an explicit re-login')
  })
})

test('reverify back-off: 2m, 4m, 8m, 16m then 30m, and 0 attempts is the fast window', () => {
  assert.equal(authReverifyDelayMs(0), AUTH_FAST_REVERIFY_MS)
  assert.equal(authReverifyDelayMs(1), 4 * 60_000)
  assert.equal(authReverifyDelayMs(2), 8 * 60_000)
  assert.equal(authReverifyDelayMs(3), 16 * 60_000)
  assert.equal(authReverifyDelayMs(4), AUTH_REVERIFY_MAX_MS)
  assert.equal(authReverifyDelayMs(99), AUTH_REVERIFY_MAX_MS)
  assert.equal(authReverifyDelayMs(-3), AUTH_FAST_REVERIFY_MS)
  assert.ok(AUTH_FAST_REVERIFY_MS < AUTH_REVERIFY_DELAY_MS)
})

class RecordingQuotaService extends QuotaService {
  calls: string[] = []
  constructor(pool: AccountPoolManager) {
    super(pool, () => '', () => '1.5.11', { bin: () => null, viaCli: () => true })
  }

  override async refreshAccountQuota(acc: ManagedAccount): Promise<null> {
    this.calls.push(acc.id)
    return null
  }
}

test('reverify sweep: only flags past their window are retried, survivors back off', async () => {
  // A flag past its fast window is re-probed once and then backs off, so a dead
  // login is not re-probed every two minutes forever.
  await withPool(async (pool) => {
    const stale = isolate(pool, 'stale')
    pool.markAuthRequired(stale.id, 'agy is not signed in')
    pool.getAccount(stale.id)!.authMarkedAt = Date.now() - AUTH_FAST_REVERIFY_MS - 5_000
    const svc = new RecordingQuotaService(pool)
    await svc.reverifyFlaggedAccounts()
    assert.deepEqual(svc.calls, [stale.id])
    assert.equal(pool.getAccount(stale.id)!.authReverifyAttempts, 1)
  })

  // A fresh flag is not re-probed yet.
  await withPool(async (pool) => {
    const fresh = isolate(pool, 'fresh')
    pool.markAuthRequired(fresh.id, 'agy is not signed in')
    pool.getAccount(fresh.id)!.authMarkedAt = Date.now()
    const svc = new RecordingQuotaService(pool)
    await svc.reverifyFlaggedAccounts()
    assert.deepEqual(svc.calls, [], 'the fresh flag is not re-probed yet')
    assert.equal(pool.getAccount(fresh.id)!.authReverifyAttempts, undefined, 'an untouched flag keeps its fast window')
  })

  // Proven by a newer quota row instead: the sweep heals it without any request.
  await withPool(async (pool) => {
    const healed = isolate(pool, 'healed')
    pool.markAuthRequired(healed.id, 'agy is not signed in')
    pool.getAccount(healed.id)!.authMarkedAt = Date.now() - AUTH_FAST_REVERIFY_MS - 5_000
    pool.updateAccountQuotas(healed.id, { google: { remainingFraction: 0.9, updatedAt: Date.now() } })
    const svc = new RecordingQuotaService(pool)
    await svc.reverifyFlaggedAccounts()
    assert.deepEqual(svc.calls, [], 'nothing left to verify over the network')
    assert.equal(pool.getAccount(healed.id)!.authRequired, undefined)
  })
})

test('reverify schedule feeds needsAuthReverify: a fresh flag never re-enters early', () => {
  const base = { id: 'a', alias: 'a', dir: '', enabled: true, cooldowns: {}, quotas: {} } as ManagedAccount
  const now = Date.now()
  const flagged = { ...base, authRequired: true, authMarkedAt: now - AUTH_FAST_REVERIFY_MS - 1 }
  assert.equal(needsAuthReverify(flagged, now, authReverifyDelayMs(0)), true)
  assert.equal(needsAuthReverify(flagged, now, authReverifyDelayMs(3)), false)
})
