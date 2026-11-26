// Single primary account state: bootstrap, persistence/recovery, credentials
// flags, family cooldowns, quota benches and countdowns. Multi-account
// scheduling (rotation, pinning, disabling, slot CRUD) was removed with the
// account pool; those tests are gone with the feature.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modelFamilyOf, shouldPollAccount, getAccountHealth } from '../src/common/pool-types.ts'
import { AccountPoolManager, defaultPoolDir } from '../src/host/pool.ts'
import { parseResetDurationMs } from '../src/common/types.ts'

function withTempHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'agy-pool-home-'))
  const prevHome = process.env.HOME
  const prevProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    return fn(home)
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevProfile
    rmSync(home, { recursive: true, force: true })
  }
}

test('modelFamilyOf correctly categorizes models', () => {
  assert.equal(modelFamilyOf('gemini-3.7-flash'), 'google')
  assert.equal(modelFamilyOf('gemini-3.6-flash'), 'google')
  assert.equal(modelFamilyOf('gemini-3.1-pro'), 'google')
  assert.equal(modelFamilyOf('gemma-2-9b'), 'google')
  // Gemini 4 Argon bills its own weekly pool — never the plain Gemini family.
  assert.equal(modelFamilyOf('gemini-4-argon'), 'argon')
  assert.equal(modelFamilyOf('gemini-4-argon-low'), 'argon')
  assert.equal(modelFamilyOf('gemini-4-argon-medium'), 'argon')
  assert.equal(modelFamilyOf('gemini-4-argon-high'), 'argon')
  assert.equal(modelFamilyOf('claude-sonnet-4-6'), 'anthropic')
  assert.equal(modelFamilyOf('claude-3-7-sonnet'), 'anthropic')
  assert.equal(modelFamilyOf('claude-opus-4-6-thinking'), 'anthropic')
  assert.equal(modelFamilyOf('gpt-oss-120b-medium'), 'openai')
  assert.equal(modelFamilyOf('openai/gpt-4o'), 'openai')
  assert.equal(modelFamilyOf('custom-other-model'), 'unknown')
  assert.equal(modelFamilyOf(undefined), 'unknown')
})

test('load() falls back to the last-good snapshot when pool.json is torn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-lastgood-'))
  try {
    const pool = new AccountPoolManager(dir)
    const ids = pool.getAccounts().map((a) => a.id)
    pool.updateAccountQuotas(ids[0]!, { google: { remainingFraction: 0.5 } }) // force a persist so pool.json.last-good exists
    // A concurrent host process truncating the file used to leave the user with
    // an empty account pool; the last good snapshot must win instead.
    writeFileSync(join(dir, 'pool.json'), '{"accounts":[{"id":"a1')
    const reloaded = new AccountPoolManager(dir)
    assert.deepEqual(reloaded.getAccounts().map((a) => a.id), ids)
    assert.ok(existsSync(join(dir, 'pool.json.last-good')), 'a last-good snapshot is kept next to pool.json')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('persist never reuses the fixed .pool.json.tmp name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-tmp-'))
  try {
    const pool = new AccountPoolManager(dir)
    writeFileSync(join(dir, '.pool.json.tmp'), 'sentinel')
    pool.updateAccountQuotas(pool.getPrimaryAccount().id, { google: { remainingFraction: 0.25 } })
    assert.equal(readFileSync(join(dir, '.pool.json.tmp'), 'utf8'), 'sentinel', 'a foreign fixed-name tmp is never written')
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), ['.pool.json.tmp'], 'no tmp litter is left behind')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AccountPoolManager bootstraps exactly one system-HOME primary account', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-test-'))
  try {
    const pool = new AccountPoolManager(dir)

    const accounts = pool.getAccounts()
    assert.equal(accounts.length, 1)
    assert.equal(accounts[0]?.id, 'acc_primary')
    // Primary rides the real system HOME: no isolated dir, Keychain keeps
    // agy signed in.
    assert.equal(accounts[0]?.systemHome, true)
    assert.equal(accounts[0]?.dir, '')
    assert.ok(existsSync(join(dir, 'pool.json')))

    // Settings still persist on the one account.
    const primary = pool.getPrimaryAccount()
    pool.setAccountProxy(primary.id, 'http://127.0.0.1:7890')
    assert.equal(pool.getAccount(primary.id)?.proxyUrl, 'http://127.0.0.1:7890')

    // Persistence across manager instances
    const pool2 = new AccountPoolManager(dir)
    assert.equal(pool2.getAccounts().length, 1)
    assert.equal(pool2.getPoolData().primaryAccountId, 'acc_primary')
    assert.equal(pool2.getPrimaryAccount().proxyUrl, 'http://127.0.0.1:7890')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loading legacy primary aliases never rewrites account data for localization', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-primary-alias-'))
  try {
    writeFileSync(join(dir, 'pool.json'), JSON.stringify({
      version: 1, defaultCooldownMs: 900000, maxCooldownMs: 3600000,
      primaryAccountId: 'acc_primary', accounts: [{ id: 'acc_primary', alias: '主账号 (系统登录)', dir: '', systemHome: true, enabled: true, createdAt: 1, cooldowns: {}, quotas: {} }],
    }), 'utf8')
    const before = readFileSync(join(dir, 'pool.json'), 'utf8')
    const pool = new AccountPoolManager(dir)
    const primary = pool.getAccount('acc_primary')!
    assert.equal(primary.alias, '主账号 (系统登录)')
    assert.equal(primary.defaultAlias, undefined)
    assert.equal(readFileSync(join(dir, 'pool.json'), 'utf8'), before)
    pool.setAccountAlias('acc_primary', 'Primary account (system sign-in)')
    const reloaded = new AccountPoolManager(dir).getAccount('acc_primary')!
    assert.equal(reloaded.alias, 'Primary account (system sign-in)')
    assert.equal(reloaded.defaultAlias, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Corrupt pool.json recovers gracefully', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-corrupt-'))
  try {
    writeFileSync(join(dir, 'pool.json'), '{ broken json', 'utf8')
    const pool = new AccountPoolManager(dir)
    assert.equal(pool.getAccounts().length, 1)
    assert.equal(pool.getAccounts()[0]?.id, 'acc_primary')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseResetDurationMs parses various rate limit durations', () => {
  // Compact durations
  assert.equal(parseResetDurationMs('RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 21m25s.'), 1285000)
  assert.equal(parseResetDurationMs('Rate limited. Resets in 2h26m6s.'), 8766000)
  assert.equal(parseResetDurationMs('Resets in 3m30s'), 210000)
  assert.equal(parseResetDurationMs('resets in 45s'), 45000)
  assert.equal(parseResetDurationMs('Resets in 1h'), 3600000)

  // Word-based durations
  assert.equal(parseResetDurationMs('Resets in 15 minutes'), 900000)
  assert.equal(parseResetDurationMs('retry after 30 seconds'), 30000)
  assert.equal(parseResetDurationMs('resets in 2 hours'), 7200000)

  // Invalid / empty
  assert.equal(parseResetDurationMs(undefined), undefined)
  assert.equal(parseResetDurationMs(''), undefined)
  assert.equal(parseResetDurationMs('regular error message without reset info'), undefined)
})

test('recordFailure parses reset duration from error text and sets safety buffer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-reset-'))
  try {
    const pool = new AccountPoolManager(dir)
    const accA = pool.getPrimaryAccount()

    // Record failure with reset text
    const errText = 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 21m25s.'
    const t0 = Date.now()
    pool.recordFailure(accA.id, 'google', errText)

    const cd = pool.getAccount(accA.id)?.cooldowns.google
    assert.ok(cd)
    // Expected cooldown = now + 1285s + 10s buffer
    const expectedMin = t0 + 1295 * 1000 - 500
    const expectedMax = t0 + 1295 * 1000 + 5000
    assert.ok(cd.cooldownUntil >= expectedMin && cd.cooldownUntil <= expectedMax)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the primary is re-bootstrapped when pool.json has no system-HOME account', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-primary-reboot-'))
  try {
    // Simulate the broken on-disk state: only a legacy isolated account row.
    const orphan = {
      id: 'acc_1787000000000_xx',
      alias: 'orphan',
      dir: join(dir, 'acc_1787000000000_xx'),
      enabled: true,
      createdAt: 1787000000000,
      cooldowns: {},
      quotas: {},
      email: 'old.pool.account@gmail.com',
    }
    writeFileSync(
      join(dir, 'pool.json'),
      JSON.stringify({ version: 1, defaultCooldownMs: 900000, maxCooldownMs: 3600000, accounts: [orphan], primaryAccountId: orphan.id }),
      'utf8',
    )

    const pool = new AccountPoolManager(dir)
    const accounts = pool.getAccounts()
    assert.equal(accounts.length, 1)
    assert.equal(accounts[0]?.id, 'acc_primary')
    assert.equal(accounts[0]?.systemHome, true)
    assert.equal(pool.getPoolData().primaryAccountId, 'acc_primary')
    assert.equal(accounts.some((a) => a.id === orphan.id), false, 'legacy sibling rows are dropped by the single-account convergence')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resetAccountIdentity clears identity-bound state on external re-login', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-identity-reset-'))
  try {
    const pool = new AccountPoolManager(dir)
    const acc = pool.getPrimaryAccount()

    // Simulate the old account going down hard before the user re-logged in:
    pool.recordFailure(acc.id, 'google', 'RESOURCE_EXHAUSTED (code 429): quota reached. Resets in 2h26m6s.')
    pool.markAuthRequired(acc.id, 'invalid_grant')
    pool.updateAccountQuotas(acc.id, { google: { remainingFraction: 0, updatedAt: Date.now() } }, 'old.account@gmail.com')
    const flagged = pool.getAccount(acc.id)!
    assert.equal(flagged.email, 'old.account@gmail.com')
    assert.equal(flagged.authRequired, true)
    assert.ok(flagged.cooldowns.google)
    assert.ok(flagged.quotas.google)
    assert.equal(shouldPollAccount(flagged), false)

    // External re-login detected from logs → full identity reset.
    pool.resetAccountIdentity(acc.id, 'new.account@gmail.com')
    const fresh = pool.getAccount(acc.id)!
    assert.equal(fresh.email, 'new.account@gmail.com')
    assert.equal(fresh.authRequired, undefined)
    assert.equal(fresh.authError, undefined)
    assert.deepEqual(fresh.cooldowns, {})
    assert.deepEqual(fresh.quotas, {})
    // Slot config survives the switch.
    assert.equal(fresh.id, acc.id)
    assert.equal(fresh.enabled, true)
    // And the primary is selectable again immediately.
    assert.equal(shouldPollAccount(fresh), true)
    const picked = pool.selectAccount('google')
    assert.equal(picked?.id, acc.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('issue #114: a terminal TOS quarantine survives automatic clearAuthRequired', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-tos-quarantine-'))
  try {
    const pool = new AccountPoolManager(dir)
    const acc = pool.getPrimaryAccount()
    const tos = 'HTTP 403: TOS_VIOLATION This service has been disabled. Appeal: https://forms.gle/x'
    pool.markAuthRequired(acc.id, tos)
    assert.equal(pool.getAccount(acc.id)?.authRequired, true)

    // The quota pipeline (and boot hygiene) clear the flag after any successful
    // OAuth refresh. A TOS-banned account still has a VALID refresh token, so
    // that success must NOT resurrect it.
    pool.clearAuthRequired(acc.id)
    assert.equal(pool.getAccount(acc.id)?.authRequired, true, 'terminal ban must be sticky')
    assert.equal(pool.getAccount(acc.id)?.authError, tos, 'appeal reason stays visible')

    // Only an explicit user action (re-login / import) may lift it.
    pool.clearAuthRequired(acc.id, true)
    assert.equal(pool.getAccount(acc.id)?.authRequired, undefined)

    pool.markAuthRequired(acc.id, 'invalid_grant: token expired')
    pool.clearAuthRequired(acc.id)
    assert.equal(pool.getAccount(acc.id)?.authRequired, undefined, 'ordinary auth failures still self-heal')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('markAuthRequired quarantines the primary from selectAccount', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-auth-'))
  try {
    const pool = new AccountPoolManager(dir)
    const accA = pool.getPrimaryAccount()

    assert.equal(pool.selectAccount('google')?.id, accA.id)

    // Mark A as auth required (token revoked/invalid_grant)
    pool.markAuthRequired(accA.id, 'invalid_grant: Token expired')
    const accAUpdated = pool.getAccount(accA.id)!
    assert.equal(accAUpdated.authRequired, true)

    const healthA = getAccountHealth(accAUpdated, 'google')
    assert.equal(healthA.status, 'auth_required')

    // With no sibling account, selection must refuse instead of using it.
    assert.equal(pool.selectAccount('google'), null)

    // When A is re-authenticated or cleared, it recovers
    pool.clearAuthRequired(accA.id)
    assert.equal(pool.getAccount(accA.id)?.authRequired, undefined)
    assert.equal(pool.selectAccount('google')?.id, accA.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sweepOldLogs sweeps log files older than retention days', () => {
  withTempHome((home) => {
    const pool = new AccountPoolManager(join(home, 'pool'))
    const logDir = join(home, '.gemini', 'antigravity-cli', 'log')
    mkdirSync(logDir, { recursive: true })

    const oldLog = join(logDir, 'cli-old.log')
    const freshLog = join(logDir, 'cli-fresh.log')
    writeFileSync(oldLog, 'old log data', 'utf8')
    writeFileSync(freshLog, 'fresh log data', 'utf8')

    // Set old log mtime to 10 days ago
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000)
    utimesSync(oldLog, tenDaysAgo, tenDaysAgo)

    const swept = pool.sweepOldLogs(7)
    assert.ok(swept >= 1)
    assert.equal(existsSync(oldLog), false)
    assert.equal(existsSync(freshLog), true)
  })
})

test('explainIneligibility separates quota rotation from cooldown, and clear-cooldown can lift it', () => {
  // Regression: every ineligible account used to be reported as "in cooldown",
  // and the advertised remedy `/agy clear-cooldown` only deleted cooldowns — so
  // a quota-benched account produced the same error forever.
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-quota-bench-'))
  try {
    const pool = new AccountPoolManager(dir)
    const acc = pool.getPrimaryAccount()
    const reset = new Date(Date.now() + 2 * 3600_000).toISOString()

    pool.updateAccountQuotas(acc.id, {
      google: {
        remainingFraction: 0.093,
        resetTime: reset,
        weeklyFraction: 0.5,
        weeklyResetTime: reset,
        updatedAt: Date.now(),
      },
    })

    const benched = pool.getAccount(acc.id)!
    assert.equal(pool.explainIneligibility(benched, 'google'), 'quota', 'a low-quota bench is not a cooldown')
    assert.equal(pool.isAccountEligible(benched, 'google'), false)
    const countdown = pool.getEarliestAvailableCountdown('google')
    assert.ok(countdown !== null && countdown > 1.9 * 3600_000 && countdown <= 2 * 3600_000)

    // A real 429 is a different reason, so the adapter can word its hint correctly.
    pool.recordFailure(acc.id, 'anthropic', '429 Rate Limit', reset)
    assert.equal(pool.explainIneligibility(pool.getAccount(acc.id)!, 'anthropic'), 'cooldown')

    // An account without Argon access reports 'unsupported', never 'quota' or 'cooldown'
    assert.equal(pool.explainIneligibility(acc, 'argon'), 'unsupported')

    // The user-facing clear also lifts the low-quota bench for the cached snapshot.
    pool.clearCooldown(acc.id, 'google', true)
    assert.equal(pool.isAccountEligible(pool.getAccount(acc.id)!, 'google'), true)
    assert.equal(pool.getEarliestAvailableCountdown('google'), null)

    // It only bridges the snapshot it overrode: fresh data re-arms the gate.
    pool.updateAccountQuotas(acc.id, {
      google: {
        remainingFraction: 0.093,
        resetTime: reset,
        weeklyFraction: 0.5,
        weeklyResetTime: reset,
        updatedAt: Date.now() + 1,
      },
    })
    assert.equal(pool.isAccountEligible(pool.getAccount(acc.id)!, 'google'), false)

    // Internal callers (orphan release, CLI quota cleanup) must not disable the gate.
    pool.clearCooldown(acc.id, 'google')
    assert.equal(pool.isAccountEligible(pool.getAccount(acc.id)!, 'google'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('getPoolData purges ghost abort cooldowns on the primary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-ghost-cd-'))
  try {
    const rawPool = {
      version: 1,
      accounts: [
        {
          id: 'acc_primary',
          alias: 'Primary',
          systemHome: true,
          dir: '',
          enabled: true,
          cooldowns: {
            google: {
              cooldownUntil: Date.now() + 600_000,
              reason: 'agy run aborted by caller',
            },
          },
          quotas: {},
        },
        {
          id: 'acc_sec',
          alias: 'Secondary',
          systemHome: false,
          dir: join(dir, 'acc_sec'),
          enabled: true,
          cooldowns: {},
          quotas: {},
        },
      ],
    }
    writeFileSync(join(dir, 'pool.json'), JSON.stringify(rawPool), 'utf8')

    const pool = new AccountPoolManager(dir)
    // Ghost cooldown on primary was purged
    assert.equal(pool.getAccount('acc_primary')?.cooldowns.google, undefined)
    // Legacy sibling accounts converge away.
    assert.deepEqual(pool.getAccounts().map((a) => a.id), ['acc_primary'])
    assert.equal(pool.getPoolData().primaryAccountId, 'acc_primary')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('getEarliestAvailableCountdown reports quota-window resets, not just cooldowns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-eta-'))
  try {
    const pool = new AccountPoolManager(dir)
    const iso = (ms: number): string => new Date(ms).toISOString()
    const now = Date.now()
    // A fully quota-drained account knows exactly when it comes back; the old
    // cooldown-only countdown reported "no ETA" for it.
    pool.updateAccountQuotas(pool.getPrimaryAccount().id, {
      google: { remainingFraction: 0, resetTime: iso(now + 30 * 60_000), weeklyFraction: 0.5, weeklyResetTime: iso(now + 5 * 86_400_000) },
    })
    const eta = pool.getEarliestAvailableCountdown('google')
    assert.ok(eta !== null && eta > 25 * 60_000 && eta <= 31 * 60_000, `expected ~30m ETA, got ${String(eta)}`)
    assert.equal(pool.getEarliestResetCountdown('google'), null, 'the cooldown-only view still sees nothing')
    // A live cooldown with a nearer reset wins over the far quota reset.
    pool.recordFailure(pool.getPrimaryAccount().id, 'google', 'RESOURCE_EXHAUSTED (code 429). Resets in 2m0s.')
    const eta2 = pool.getEarliestAvailableCountdown('google')
    assert.ok(eta2 !== null && eta2 <= 3 * 60_000, `expected the cooldown to win, got ${String(eta2)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a partial pool.json (missing cooldowns/quotas) is normalized instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-partial-'))
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pool.json'), JSON.stringify({
      version: 1,
      accounts: [
        { id: 'acc_primary', alias: 'Primary', dir: '', systemHome: true, createdAt: Date.now() },
      ],
    }), 'utf8')
    const pool = new AccountPoolManager(dir)
    // Before normalization `acc.cooldowns[family]` threw a TypeError inside
    // selectAccount, so EVERY turn failed with an opaque internal error.
    const picked = pool.selectAccount('google')
    assert.ok(picked !== null, 'a partial record must still be selectable')
    const primary = pool.getPrimaryAccount()
    assert.equal(primary.enabled, true, 'enabled defaults to true')
    assert.deepEqual(primary.cooldowns, {})
    assert.deepEqual(primary.quotas, {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('getPoolData exposes systemProxy when defaultProxy is provided or system proxy is detected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-system-proxy-'))
  try {
    const pool = new AccountPoolManager(dir)
    const poolData = pool.getPoolData('http://127.0.0.1:17891')
    assert.equal(poolData.systemProxy, 'http://127.0.0.1:17891')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('defaultPoolDir recovers when home directory is inside an isolated account path', () => {
  const savedStateDir = process.env.DSH_STATE_DIR
  try {
    // An explicit home always wins: accounts spawned inside an isolated
    // HOME must resolve to that home, not the parent process's state dir.
    process.env.DSH_STATE_DIR = '/tmp/some-other-state'
    assert.equal(
      defaultPoolDir('C:\\Users\\kybco\\.dsh\\agy-accounts\\acc_1793341113485_51ytc'),
      join('C:\\Users\\kybco', '.dsh', 'agy-accounts'),
    )
    assert.equal(
      defaultPoolDir('/home/user/.dsh/agy-accounts/acc_1793341113485_51ytc'),
      join('/home/user', '.dsh', 'agy-accounts'),
    )
    assert.equal(
      defaultPoolDir('C:\\Users\\kybco'),
      join('C:\\Users\\kybco', '.dsh', 'agy-accounts'),
    )
    // With no explicit home the host's state dir is authoritative.
    assert.equal(defaultPoolDir(), join('/tmp/some-other-state', 'agy-accounts'))
  } finally {
    if (savedStateDir === undefined) delete process.env.DSH_STATE_DIR
    else process.env.DSH_STATE_DIR = savedStateDir
  }
})

test('markModelUnsupported excludes that model from the only account', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-unsupported-'))
  try {
    const pool = new AccountPoolManager(dir)
    const primary = pool.getPrimaryAccount()
    pool.updateAccountQuotas(primary.id, { anthropic: { remainingFraction: 1 } })

    assert.equal(pool.selectAccount('anthropic', 'claude-opus-4-6')?.id, primary.id)
    pool.markModelUnsupported(primary.id, 'claude-opus-4-6')
    assert.equal(
      pool.selectAccount('anthropic', 'claude-opus-4-6'),
      null,
      'the only account is marked unsupported for that model',
    )
    assert.equal(pool.isModelSupported(pool.getAccount(primary.id)!, 'claude-opus-4-6'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shouldPollAccount polls until ALL known quota families are in active cooldown', () => {
  const now = Date.now()
  const base = {
    id: 'acc-poll',
    alias: 'poll',
    dir: '',
    enabled: true,
    createdAt: 1,
  }

  // Only Google is cooling, while Argon is healthy -> keep polling so healthy families refresh.
  assert.equal(shouldPollAccount({
    ...base,
    cooldowns: { google: { cooldownUntil: now + 60_000, reason: '429', consecutiveFailures: 1 } },
    quotas: {
      google: { remainingFraction: 0, updatedAt: now },
      argon: { weeklyFraction: 1, updatedAt: now },
    },
  }), true)

  // Every known family is in active cooldown -> skip unattended poll.
  assert.equal(shouldPollAccount({
    ...base,
    cooldowns: {
      google: { cooldownUntil: now + 60_000, reason: '429', consecutiveFailures: 1 },
      argon: { cooldownUntil: now + 60_000, reason: '429', consecutiveFailures: 1 },
    },
    quotas: {
      google: { remainingFraction: 0, updatedAt: now },
      argon: { weeklyFraction: 0, updatedAt: now },
    },
  }), false)

  // Empty quotas fallback: any active cooldown stops unattended polling.
  assert.equal(shouldPollAccount({
    ...base,
    cooldowns: { google: { cooldownUntil: now + 60_000, reason: '429', consecutiveFailures: 1 } },
    quotas: {},
  }), false)
})
