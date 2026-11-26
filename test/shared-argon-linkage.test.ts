import './helpers/client-render.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig } from '../src/common/types.ts'
import { accountCoolingFamilies, isQuotaBenched } from '../src/common/quota-bench.ts'
import type { ManagedAccount } from '../src/common/pool-types.ts'
import { AccountPoolManager } from '../src/host/pool.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { selectSessionAccount, stickyAccount } from '../src/provider/account-selection.ts'
import { createLiveQuotaController } from '../src/provider/quota-failover.ts'
import { refreshAccountQuotaPipeline } from '../src/features/quota/refresh.ts'
import { AccountsPanel } from '../src/client/sections/AccountsPanel.ts'

const SHARED_GEMINI_DESC =
  'Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Orchestrator (Neon), Orchestrator (Carbon), Orchestrator (Argon), Gemini 3.8 Flash'

const noopHandlers = {
  beginReauth: async () => {},
  refreshQuota: async () => {},
  saveProxy: async () => {},
  saveAlias: async () => {},
  clearCooldown: async () => {},
}

/**
 * One primary account whose Gemini Models group explicitly declares Argon as a
 * member (the paid-plan shape since agy 1.5.12/1.5.15): the two families share
 * one quota bucket, so cooldowns/quota benches must stay bidirectionally linked.
 */
function makeSharedPool() {
  const dir = mkdtempSync(join(tmpdir(), 'agy-shared-argon-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.getPrimaryAccount()
  const now = Date.now()
  const reset5h = new Date(now + 4 * 3_600_000).toISOString()
  const reset7d = new Date(now + 6 * 86_400_000).toISOString()
  pool.updateAccountQuotas(acc.id, {
    google: {
      remainingFraction: 0.9,
      resetTime: reset5h,
      weeklyFraction: 0.85,
      weeklyResetTime: reset7d,
      description: SHARED_GEMINI_DESC,
      updatedAt: now,
    },
  })
  return { dir, pool, acc, reset5h, reset7d }
}

test('Gap 3: catalog propagation lets explainIneligibility/selectAccount recognize discovered Argon without quotas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-argon-cat-'))
  try {
    const pool = new AccountPoolManager(dir)
    const acc = pool.getPrimaryAccount()
    const argonCatalog = {
      source: 'discovered',
      models: [
        { id: 'gemini-4-argon' },
        { id: 'gemini-pro-orchestrator-argon' },
        { id: 'gemini-3.8-flash' },
      ],
    }
    pool.setCatalog({
      get: () => ({ source: 'fallback', models: [] }),
      getAccountCatalog: () => argonCatalog,
    })

    assert.equal(pool.explainIneligibility(pool.getAccount(acc.id)!, 'argon'), null)
    assert.equal(pool.selectAccount('argon', 'gemini-pro-orchestrator-argon')?.id, acc.id)

    // An explicit per-model breakdown that omits Argon is authoritative: the
    // discovered catalog must not override the account's own negative evidence.
    pool.updateAccountQuotas(acc.id, {
      google: {
        weeklyFraction: 1,
        models: [{ modelId: 'gemini-3.8-flash', remainingFraction: 1 }],
        updatedAt: Date.now(),
      },
    })
    assert.equal(
      pool.explainIneligibility(pool.getAccount(acc.id)!, 'argon'),
      'unsupported',
      'explicit non-Argon per-model breakdown must still reject even if the catalog lists Argon',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Gap 1: shared-group google/argon cooldowns, countdowns, selection, clearCooldown, and UI stay bidirectionally linked', async () => {
  const { dir, pool, acc, reset5h, reset7d } = makeSharedPool()
  try {
    const store = new SessionStore(join(dir, 'sessions.json'))
    const cfg = { ...defaultConfig(), parallelSameAccount: false }
    const futureIso = new Date(Date.now() + 2 * 3_600_000).toISOString()

    store.set(`s1:${acc.id}`, {
      conversationId: 'conv-orch-1',
      lastMessageCount: 2,
      updatedAt: Date.now() + 10,
      model: 'gemini-pro-orchestrator-argon',
    })

    // The shared Gemini group is what grants Argon: a healthy account serves it.
    assert.equal(stickyAccount({ pool, store }, 'argon', 's1', 'gemini-pro-orchestrator-argon')?.id, acc.id)
    const picked = await selectSessionAccount({
      deps: { pool, store },
      cfg,
      model: 'gemini-pro-orchestrator-argon',
      isAux: false,
      sessionKey: 's1',
    })
    assert.equal(picked.account?.id, acc.id)

    // 1. google 429 cools BOTH google and argon and clears sticky affinity
    pool.recordFailure(acc.id, 'google', 'RESOURCE_EXHAUSTED (code 429)', futureIso)

    assert.equal(pool.explainIneligibility(pool.getAccount(acc.id)!, 'argon'), 'cooldown')
    assert.equal(pool.explainIneligibility(pool.getAccount(acc.id)!, 'google'), 'cooldown')
    assert.equal(stickyAccount({ pool, store }, 'argon', 's1', 'gemini-pro-orchestrator-argon'), undefined)

    const resetArgon = pool.getEarliestResetCountdown('argon')
    const availArgon = pool.getEarliestAvailableCountdown('argon')
    assert.ok(resetArgon !== null && resetArgon > 0, `expected >0 argon reset countdown, got ${resetArgon}`)
    assert.ok(availArgon !== null && availArgon > 0, `expected >0 argon available countdown, got ${availArgon}`)

    // UI/readout hygiene: shared-group cooling reports ['google'] (no duplicate
    // argon), and AccountsPanel hides the phantom Argon bar.
    const cooled = pool.getAccount(acc.id)!
    assert.deepEqual(accountCoolingFamilies(cooled, Date.now()), ['google'])
    const panelTree = JSON.stringify(AccountsPanel({
      t: ((k: string) => k) as never,
      pool: pool.getPoolData(),
      accounts: [cooled],
      loadingAction: null,
      proxyInputs: {},
      setProxyInputs: () => {},
      editingProxyId: null,
      setEditingProxyId: () => {},
      aliasInputs: {},
      setAliasInputs: () => {},
      editingAliasId: null,
      setEditingAliasId: () => {},
      expandedModels: {},
      toggleExpand: () => {},
      handlers: noopHandlers,
    }))
    assert.equal(panelTree.includes('"Argon"'), false, 'shared-group cooling must not render a phantom Argon bar')

    // 2. Reverse direction: argon 429 also cools both peers.
    pool.recordSuccess(acc.id, 'google')
    assert.equal(pool.explainIneligibility(pool.getAccount(acc.id)!, 'google'), null)
    assert.equal(pool.explainIneligibility(pool.getAccount(acc.id)!, 'argon'), null)
    pool.recordFailure(acc.id, 'argon', 'RESOURCE_EXHAUSTED (code 429)', futureIso)
    assert.equal(pool.explainIneligibility(pool.getAccount(acc.id)!, 'argon'), 'cooldown')
    assert.equal(pool.explainIneligibility(pool.getAccount(acc.id)!, 'google'), 'cooldown')

    // 3. recordSuccess clears both peers in either direction.
    pool.recordSuccess(acc.id, 'argon')
    assert.equal(pool.explainIneligibility(pool.getAccount(acc.id)!, 'argon'), null)
    assert.equal(pool.explainIneligibility(pool.getAccount(acc.id)!, 'google'), null)

    // 4. clearCooldown(id, 'argon', true) lifts both the cooldown and the quota
    //    bench for BOTH argon and google.
    const now = Date.now()
    pool.updateAccountQuotas(acc.id, {
      google: {
        remainingFraction: 0.02,
        resetTime: reset5h,
        weeklyFraction: 0.5,
        weeklyResetTime: reset7d,
        description: SHARED_GEMINI_DESC,
        updatedAt: now,
      },
    })
    pool.recordFailure(acc.id, 'google', 'RESOURCE_EXHAUSTED (code 429)', futureIso)
    assert.equal(isQuotaBenched(pool.getAccount(acc.id)!, 'google', now), true)
    assert.equal(isQuotaBenched(pool.getAccount(acc.id)!, 'argon', now), true)

    pool.clearCooldown(acc.id, 'argon', true)
    assert.equal(isQuotaBenched(pool.getAccount(acc.id)!, 'google', now), false)
    assert.equal(isQuotaBenched(pool.getAccount(acc.id)!, 'argon', now), false)
    assert.equal(pool.explainIneligibility(pool.getAccount(acc.id)!, 'google'), null)
    assert.equal(pool.explainIneligibility(pool.getAccount(acc.id)!, 'argon'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Gap 1b: createLiveQuotaController records both families for shared-group subagent 429 when no alternative account exists', () => {
  const { dir, pool, acc } = makeSharedPool()
  try {
    let killed = false
    const ctrl = createLiveQuotaController({
      pool,
      account: pool.getAccount(acc.id)!,
      inputFamily: 'argon',
      activeModel: 'gemini-pro-orchestrator-argon',
      emitNotice: () => {},
      onTriggerKill: () => { killed = true },
    })

    ctrl.handleQuotaExhausted({
      source: 'subagent-transcript',
      role: 'Worker',
      model: 'gemini-4-hydrogen',
      errorText: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h0m0s.',
    })

    assert.equal(killed, false)
    assert.equal(ctrl.cooledFamilies().has('google'), true)
    assert.equal(ctrl.cooledFamilies().has('argon'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Gap 1c: steady-state shared-group CLI /usage refresh preserves active 429 cooldown', async () => {
  const { dir, pool, acc } = makeSharedPool()
  try {
    const futureIso = new Date(Date.now() + 2 * 3_600_000).toISOString()
    pool.recordFailure(acc.id, 'google', 'RESOURCE_EXHAUSTED (code 429)', futureIso)
    assert.equal(pool.hasDedicatedGroup(acc.id, 'argon'), false)

    await refreshAccountQuotaPipeline(
      {
        pool,
        shouldUseCli: () => true,
        readCliUsageFamilies: async () => ({
          google: {
            remainingFraction: 0.9,
            resetTime: futureIso,
            weeklyFraction: 0.9,
            weeklyResetTime: futureIso,
            description: SHARED_GEMINI_DESC,
            updatedAt: Date.now(),
          },
        }),
        getValidAccessToken: async () => null,
        proxyFor: () => undefined,
        fetchUserInfo: async () => null,
        fetchQuotaSummary: async () => null,
        fetchAvailableModels: async () => null,
        fetchUserQuota: async () => null,
        getTokenFilePath: () => '',
        detectEmailFromLogs: () => undefined,
        readPrimaryCredential: () => null,
        writePrimaryCredential: () => false,
        credentialFingerprint: () => null,
      },
      pool.getAccount(acc.id)!,
      true,
    )

    assert.equal(pool.explainIneligibility(pool.getAccount(acc.id)!, 'google'), 'cooldown')
    assert.equal(pool.explainIneligibility(pool.getAccount(acc.id)!, 'argon'), 'cooldown')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Dedicated Argon isolation remains intact when quotas.argon exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-ded-argon-'))
  try {
    const pool = new AccountPoolManager(dir)
    const acc = pool.getPrimaryAccount()
    const now = Date.now()
    const reset5h = new Date(now + 4 * 3_600_000).toISOString()
    const reset7d = new Date(now + 6 * 86_400_000).toISOString()
    pool.updateAccountQuotas(acc.id, {
      google: { remainingFraction: 1, resetTime: reset5h, weeklyFraction: 1, weeklyResetTime: reset7d, updatedAt: now },
      argon: { weeklyFraction: 1, weeklyResetTime: reset7d, updatedAt: now },
    })

    // One account serves both families; there is no per-family pin left.
    assert.equal(pool.getActiveAccountId('google'), acc.id)
    assert.equal(pool.getActiveAccountId('argon'), acc.id)

    // Dedicated Argon: its 429 must NOT cool the Gemini family.
    pool.recordFailure(acc.id, 'argon', 'RESOURCE_EXHAUSTED (code 429)', reset5h)
    assert.equal(pool.explainIneligibility(pool.getAccount(acc.id)!, 'argon'), 'cooldown')
    assert.equal(pool.explainIneligibility(pool.getAccount(acc.id)!, 'google'), null)

    // The reverse also holds: Gemini 429 + Argon success leaves Gemini cooling.
    pool.recordFailure(acc.id, 'google', 'RESOURCE_EXHAUSTED (code 429)', reset5h)
    pool.recordSuccess(acc.id, 'argon')
    assert.equal(pool.explainIneligibility(pool.getAccount(acc.id)!, 'argon'), null)
    assert.equal(pool.explainIneligibility(pool.getAccount(acc.id)!, 'google'), 'cooldown')

    const store = new SessionStore(join(dir, 'sessions.json'))
    store.set(`sess-ded:${acc.id}`, {
      conversationId: 'conv-ded',
      lastMessageCount: 1,
      updatedAt: Date.now() + 20,
      model: 'gemini-pro-orchestrator-argon',
    })
    assert.equal(
      stickyAccount({ pool, store }, 'google', 'sess-ded', 'gemini-4-hydrogen'),
      undefined,
      'Gemini stays benched by its own cooldown',
    )
    assert.equal(
      stickyAccount({ pool, store }, 'argon', 'sess-ded', 'gemini-pro-orchestrator-argon')?.id,
      acc.id,
      'Argon is an independent book and stays serviceable',
    )

    // Ensure typecheck covers ManagedAccount usage cleanly
    const accCheck: ManagedAccount = pool.getAccount(acc.id)!
    assert.ok(accCheck.quotas.argon)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
