import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPoolManager } from '../src/host/pool.ts'
import { PoolAuthFlow } from '../src/host/pool-auth.ts'
import { QuotaService } from '../src/host/quota.ts'

/** Never the real machine-wide Windows slot / login keychain (see PoolAuthFlowDeps). */
const noMachineWrites = { writeSlot: () => true, writeKeyring: () => true }

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-auth-'))
  const pool = new AccountPoolManager(dir)
  const quota = new QuotaService(pool)
  return { dir, pool, quota }
}

test('PoolAuthFlow beginPrimary produces a PKCE authorize URL and auto mode', async () => {
  const { pool, quota } = fixture()
  const flow = new PoolAuthFlow(pool, quota, () => {}, {
    ...noMachineWrites,
    openBrowser: async () => true,
    exchangeCode: async () => { throw new Error('invalid_grant: Bad Request') },
  })
  const st = await flow.beginPrimary(undefined, '测试账号')
  assert.equal(st.ok, true)
  assert.equal(st.phase, 'waiting')
  assert.equal(st.mode, 'auto')
  assert.equal(st.browserOpened, true)
  assert.ok(st.url?.includes('accounts.google.com'))
  assert.ok(st.url?.includes('code_challenge='))
  assert.ok(st.url?.includes('code_challenge_method=S256'))
  assert.ok(st.url?.includes('redirect_uri=http%3A%2F%2Flocalhost%3A51121'))
  // openid must NOT be in the scope (hangs consent for this client)
  assert.ok(!st.url?.includes('openid'))
  // The pool keeps exactly the bootstrapped primary; no slot is committed yet.
  assert.equal(pool.getAccounts().length, 1)
  await flow.cancel()
  assert.equal(flow.status().phase, 'idle')
})

test('PoolAuthFlow rejects bogus paste and wrong-state URLs', async () => {
  const { pool, quota } = fixture()
  const flow = new PoolAuthFlow(pool, quota, () => {}, {
    ...noMachineWrites,
    openBrowser: async () => true,
    exchangeCode: async () => { throw new Error('invalid_grant: Bad Request') },
  })
  const st = await flow.beginPrimary()
  assert.equal(st.ok, true)

  const bogus = await flow.submitCode('not a code at all!!!')
  assert.equal(bogus.ok, false)
  assert.equal(bogus.phase, 'waiting') // still waiting, not failed

  const wrongState = await flow.submitCode('http://localhost:51121/oauth-callback?code=4/1AfValidLookingCode&state=WRONG')
  assert.equal(wrongState.ok, false)
  assert.equal(wrongState.phase, 'waiting')
  assert.equal(wrongState.code, 'invalid_state')

  await flow.cancel()
})

test('PoolAuthFlow fails cleanly when the exchange is rejected', async () => {
  const { pool, quota } = fixture()
  const flow = new PoolAuthFlow(pool, quota, () => {}, {
    ...noMachineWrites,
    openBrowser: async () => true,
    exchangeCode: async () => { throw new Error('invalid_grant: Bad Request') },
  })
  const st = await flow.beginPrimary()
  assert.equal(st.ok, true)
  // A real-looking but invalid code reaches the token endpoint and is
  // rejected; the flow must fail (not hang).
  // NOTE: this test requires network; skip silently when offline.
  try {
    const res = await flow.submitCode('4/1AfDefinitelyInvalidCode123')
    assert.equal(res.ok, false)
    assert.equal(res.phase, 'failed')
    assert.equal(res.code, 'exchange_failed')
  } catch (err) {
    if (String(err).includes('fetch failed')) return // offline: skip
    throw err
  }
})

test('importRefreshToken imports the user identity into the primary account in place', async () => {
  const { pool, quota } = fixture()
  let notified = false
  const flow = new PoolAuthFlow(pool, quota, () => {}, {
    ...noMachineWrites,
    refreshTokens: async (rt) => ({ access_token: 'acc_' + rt, refresh_token: rt }),
    fetchUserEmail: async () => 'imported@example.com',
    onUpdate: () => { notified = true },
  })

  const res = await flow.importRefreshToken('1//my-fresh-refresh-token', 'Imported Alias')
  assert.equal(res.ok, true)
  assert.equal(res.email, 'imported@example.com')
  assert.equal(res.account?.id, 'acc_primary')
  assert.equal(notified, true)

  const acc = pool.getPrimaryAccount()
  assert.equal(acc.email, 'imported@example.com')
  assert.equal(acc.alias, 'Imported Alias')
  assert.equal(pool.getAccounts().length, 1, 'import updates the primary instead of adding an account')
})

test('importRefreshToken clears authRequired / cooldowns on the primary account', async () => {
  const { pool, quota } = fixture()
  const existing = pool.getPrimaryAccount()
  pool.updateAccountQuotas(existing.id, {}, 'existing@example.com')
  pool.markAuthRequired(existing.id, 'credential missing')
  pool.recordFailure(existing.id, 'google', 'rate limit test')
  assert.equal(existing.authRequired, true)

  const flow = new PoolAuthFlow(pool, quota, () => {}, {
    ...noMachineWrites,
    refreshTokens: async (rt) => ({ access_token: 'acc_' + rt, refresh_token: rt }),
    fetchUserEmail: async () => 'EXISTING@example.com',
  })

  const tokenJson = JSON.stringify({
    token: { refresh_token: '1//updated-token' },
    auth_method: 'consumer',
  })
  const res = await flow.importRefreshToken(tokenJson, 'Updated Alias')
  assert.equal(res.ok, true)
  assert.equal(res.account?.id, existing.id)

  const updated = pool.getAccount(existing.id)!
  assert.equal(updated.alias, 'Updated Alias')
  assert.equal(updated.authRequired, undefined)
  assert.equal(Object.keys(updated.cooldowns ?? {}).length, 0)
})

test('importRefreshToken rejects empty/invalid input or failed token exchange', async () => {
  const { pool, quota } = fixture()
  const flow = new PoolAuthFlow(pool, quota, () => {}, {
    ...noMachineWrites,
    refreshTokens: async () => { throw new Error('invalid_grant: Token has been expired or revoked') },
    fetchUserEmail: async () => 'bad@example.com',
  })

  const invalid = await flow.importRefreshToken('')
  assert.equal(invalid.ok, false)

  const failed = await flow.importRefreshToken('1//revoked-token')
  assert.equal(failed.ok, false)
  assert.ok(failed.error?.includes('invalid_grant'))
})

test('beginPrimary completion clears authRequired and cooldowns on primary account and invokes onUpdate', async () => {
  const { pool, quota } = fixture()
  quota.refreshAccountQuota = async () => null
  const primary = pool.getPrimaryAccount()
  pool.markAuthRequired(primary.id, 'TOS_VIOLATION: previous ban')
  pool.recordFailure(primary.id, 'google', '429 rate limit')
  assert.equal(pool.getAccount(primary.id)?.authRequired, true)

  let updated = 0
  const slotWrites: string[] = []
  const keyringWrites: string[] = []
  const flow = new PoolAuthFlow(pool, quota, () => {}, {
    openBrowser: async () => true,
    exchangeCode: async () => ({ access_token: 'primary_acc', refresh_token: '1//primary_rt' }),
    fetchUserEmail: async () => 'primary@example.com',
    onUpdate: () => { updated++ },
    // The Windows credential slot is machine-wide and shared with the running
    // app: a fake login written from here would break the real primary
    // account. Capture the document instead of writing it.
    writeSlot: (raw) => { slotWrites.push(raw); return true },
    // Same hazard on macOS/Linux, where the login Keychain plays the slot's
    // role — and where CI actually runs.
    writeKeyring: (raw) => { keyringWrites.push(raw); return true },
  })
  // Override dir on active flow via a temp home so real ~ is untouched:
  const tempHome = mkdtempSync(join(tmpdir(), 'agy-primary-home-'))
  try {
    const started = await flow.beginPrimary()
    assert.equal(started.ok, true)
    ;(flow as any).flow.dir = tempHome

    const done = await flow.submitCode('4/1AfPrimaryValidCode')
    assert.equal(done.ok, true)
    assert.equal(done.code, 'primary_activated')
    assert.equal(pool.getAccount(primary.id)?.authRequired, undefined, 'primary login must clear authRequired')
    assert.equal(Object.keys(pool.getAccount(primary.id)?.cooldowns ?? {}).length, 0, 'primary login must clear cooldowns')
    assert.ok(updated >= 1, 'primary login must notify listeners (model picker / UI)')
    // Exactly one of the two machine-wide stores is written, decided by the
    // platform under test (Windows: credential slot, macOS/Linux: Keychain).
    const installs = process.platform === 'win32' ? slotWrites : keyringWrites
    assert.equal(installs.length, 1, 'primary login installs the credential into the machine store exactly once')
    assert.ok(installs[0]?.includes('primary_acc'), 'the machine store receives the freshly exchanged token')
  } finally {
    rmSync(tempHome, { recursive: true, force: true })
  }
})
