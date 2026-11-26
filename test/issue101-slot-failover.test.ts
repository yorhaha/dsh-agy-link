import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AccountPoolManager } from '../src/host/pool.ts'
import { SlotUnavailableError } from '../src/domain/credentials/errors.ts'
import { purgeStaleIsolatedKeychain } from '../src/runtime/agy/keychain.ts'

test('a slot-unavailable rejection marks the primary authRequired so it stops being selected (issue #101)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-issue101-'))
  try {
    const pool = new AccountPoolManager(dir)
    const primary = pool.getPrimaryAccount()
    pool.updateAccountQuotas(primary.id, { google: { remainingFraction: 1 } })

    assert.equal(pool.isAccountEligible(primary, 'google'), true)
    assert.equal(pool.selectAccount('google')?.id, primary.id)

    // Mark the primary as broken via markAuthRequired (what SlotUnavailableError triggers)
    pool.markAuthRequired(primary.id, 'Account acc_primary has no stored credential.')
    assert.equal(pool.isAccountEligible(pool.getAccount(primary.id)!, 'google'), false)
    assert.equal(pool.explainIneligibility(pool.getAccount(primary.id)!, 'google'), 'auth')

    // With one account and no failover target left, selection must refuse.
    assert.equal(pool.selectAccount('google'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SlotUnavailableError with target="primary" does not blame a healthy secondary account', () => {
  const primaryErr = new SlotUnavailableError('Cannot verify the primary Antigravity credential', 'primary')
  const secondaryErr = new SlotUnavailableError('Account acc2 has no stored credential', 'account')
  assert.equal((primaryErr as { target?: string }).target, 'primary')
  assert.equal((secondaryErr as { target?: string }).target, 'account')
})

test('purgeStaleIsolatedKeychain preserves login.keychain-db when security times out under load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-kc-timeout-'))
  try {
    const kcDir = join(dir, 'Library', 'Keychains')
    mkdirSync(kcDir, { recursive: true })
    const kc = join(kcDir, 'login.keychain-db')
    writeFileSync(kc, 'valid-keychain-bytes')

    const purged = purgeStaleIsolatedKeychain(dir, 'darwin', () => {
      const err = Object.assign(new Error('Command timed out'), { code: 'ETIMEDOUT', killed: true })
      throw err
    })
    assert.equal(purged, false, 'timeout must not purge a healthy isolated keychain')
    assert.equal(existsSync(kc), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
