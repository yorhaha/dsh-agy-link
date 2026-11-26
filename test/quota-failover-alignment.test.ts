import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  defaultConfig,
  Err,
  extractAgyQuotaBanner,
  extractQuotaErrorModel,
  isAgyQuotaBannerLine,
  isHardQuotaResultError,
  isNonConsumableResultError,
  isTransientBurstRateLimit,
  looksLikeHardRateLimit,
  parseResetDurationMs,
  type PluginConfig,
} from '../src/common/types.ts'
import type { ManagedAccount } from '../src/common/pool-types.ts'
import { isQuotaBenched } from '../src/common/quota-bench.ts'
import { AgyAdapter, type AgyAdapterDeps } from '../src/host/adapter.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { AccountPoolManager } from '../src/host/pool.ts'
import { RunRecording, RunRegistry } from '../src/host/recording.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { runAgyOnce } from '../src/host/oneshot.ts'
import { EventMapper } from '../src/provider/mapper/event-mapper.ts'
import { driveSpan } from '../src/provider/span.ts'
import { SubagentTracker } from '../src/features/subagent/tracker.ts'
import { AcpProcess, AcpSessionPool, runAcpAttempt } from '../src/features/acp/index.ts'
import type { AttemptDeps, AttemptInput, AttemptSlot } from '../src/provider/attempt.ts'

const fakeBin = join(import.meta.dirname, 'fake-agy.mjs')

function msg(role: 'user' | 'assistant' | 'system', text: string): Message {
  return { role, content: [{ type: 'text', text }] } as unknown as Message
}

function opts(messages: Message[], extra: Partial<GenerateOptions> & Record<string, unknown> = {}): GenerateOptions {
  return {
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    messages,
    ...extra,
  } as GenerateOptions
}

function makeAdapter(
  root: string,
  cfgOverrides: Partial<PluginConfig> = {},
  deps: Partial<AgyAdapterDeps> = {},
) {
  const cfg: PluginConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 20_000, ...cfgOverrides }
  const store = new SessionStore(join(root, 'sessions.json'))
  const catalog = new ModelCatalog(
    async () => { throw new Error('no discovery in tests') },
    cfg.fallbackModels,
    300_000,
  )
  const runs = new RunRegistry()
  const adapter = new AgyAdapter({
    getConfig: () => cfg,
    catalog,
    store,
    bin: () => fakeBin,
    acquire: () => Promise.resolve(() => {}),
    runs,
    ...deps,
  })
  return { adapter, store, runs, cfg }
}

async function collect(gen: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const ch of gen) out.push(ch)
  return out
}

describe('quota handling across subagents, aux, and tools', () => {
  test('1. diagnostics helpers parse 429 JSON, QUOTA_EXHAUSTED, reset after, transient bursts, and model name', () => {
    const sub429 = 'Encountered error in step execution: image failed to generate: failed to generate content: 429 Too Many Requests, body: {\n  "error": {\n    "code": 429,\n    "message": "You have exhausted your capacity on this model. Your quota will reset after 4h58m46s.",\n    "status": "RESOURCE_EXHAUSTED",\n    "details": [{\n      "@type": "type.googleapis.com/google.rpc.ErrorInfo",\n      "reason": "QUOTA_EXHAUSTED",\n      "metadata": { "model": "gemini-3.1-flash-image", "quotaResetDelay": "4h58m46.438781284s" }\n    }]\n  }\n}'
    assert.equal(looksLikeHardRateLimit(sub429), true)
    assert.equal(looksLikeHardRateLimit('QUOTA_EXHAUSTED'), true)
    assert.equal(looksLikeHardRateLimit('{"code": 429}'), true)
    assert.equal(looksLikeHardRateLimit('conversation 42912345-abcd-1234 not found'), false)
    assert.equal(looksLikeHardRateLimit('the docs say rate limits apply'), false)

    const d1 = parseResetDurationMs('Your quota will reset after 4h58m46s.')
    assert.equal(d1, (4 * 3600 + 58 * 60 + 46) * 1000)
    const d2 = parseResetDurationMs('"quotaResetDelay": "4h58m46.438781284s"')
    assert.ok(d2 !== undefined && Math.abs(d2 - 17926439) <= 2, `got ${d2}`)
    assert.equal(parseResetDurationMs('Your quota will reset after 1s.'), 1000)
    assert.equal(parseResetDurationMs('Resets in 3h43m44s.'), (3 * 3600 + 43 * 60 + 44) * 1000)

    const burst1s = '429 Too Many Requests, body: { "error": { "code": 429, "message": "You have exhausted your capacity on this model. Your quota will reset after 1s.", "status": "RESOURCE_EXHAUSTED", "details": [{ "reason": "RATE_LIMIT_EXCEEDED", "metadata": { "quotaResetDelay": "1.309933519s" } }] } }'
    assert.equal(isTransientBurstRateLimit(burst1s), true)
    assert.equal(isTransientBurstRateLimit(sub429), false)
    assert.equal(isTransientBurstRateLimit('RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 3h43m44s.'), false)

    assert.equal(extractQuotaErrorModel(sub429), 'gemini-3.1-flash-image')

    assert.equal(isNonConsumableResultError(false, 'RESOURCE_EXHAUSTED (code 429): Individual quota reached.', 'partial'), true)
    assert.equal(isNonConsumableResultError(false, 'TOS_VIOLATION', 'partial'), true)
    assert.equal(isNonConsumableResultError(false, 'Find command timed out.', 'There are 2 files.'), false)
  })

  test('2. isQuotaBenched enforces per-model exhaustion and honors quotaGateClearedAt', () => {
    const now = Date.parse('2026-11-21T14:00:00Z')
    const future = new Date(now + 3600_000).toISOString()
    const acc: ManagedAccount = {
      id: 'acc_1',
      alias: 'A1',
      dir: '/tmp/a1',
      enabled: true,
      createdAt: now - 10_000,
      cooldowns: {},
      quotas: {
        google: {
          remainingFraction: 0.8,
          resetTime: future,
          weeklyFraction: 0.9,
          weeklyResetTime: future,
          updatedAt: now - 1000,
          models: [
            { modelId: 'gemini-3.1-flash-image', remainingFraction: 0, resetTime: future },
            { modelId: 'gemini-4-neon-high', remainingFraction: 0.8, resetTime: future },
          ],
        },
      },
    }
    assert.equal(isQuotaBenched(acc, 'google', now, 'gemini-3.1-flash-image'), true)
    assert.equal(isQuotaBenched(acc, 'google', now, 'gemini-4-neon-high'), false)
    assert.equal(isQuotaBenched(acc, 'google', now), false)

    acc.quotaGateClearedAt = { google: now }
    assert.equal(isQuotaBenched(acc, 'google', now, 'gemini-3.1-flash-image'), false)
  })

  test('3. partial-response hard quota exhaustion stays non-consumable and benches the primary account', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-partial-quota-'))
    const prevMode = process.env.FAKE_AGY_MODE
    try {
      process.env.FAKE_AGY_MODE = 'real-quota-partial'
      const mapper = new EventMapper({ runId: 'r1', cutOnTool: true })
      const chunks = [
        ...mapper.map({ kind: 'step', stepKey: '1', stepKind: 'text', text: 'partial interim text', fragment: true }, 0),
        ...mapper.map({ kind: 'result', conversationId: 'c1', ok: false, response: 'partial interim text', error: 'Individual quota reached. Resets in 3h43m38s.', usage: {}, raw: {} }, 1),
      ]
      assert.equal(mapper.isFinished, false)
      assert.equal(chunks.some((c) => c.type === 'finish'), false)

      const rec = new RunRecording('r-rec')
      rec.append({ kind: 'result', conversationId: 'c1', ok: false, response: 'partial interim text', error: 'Individual quota reached. Resets in 3h43m38s.', usage: {}, raw: {} })
      assert.equal(rec.hasConsumableResult, false)
      assert.equal(rec.hasFinishableEventFrom(0), false)

      const pool = new AccountPoolManager(join(root, 'pool'))
      const primary = pool.getPrimaryAccount()
      const { adapter } = makeAdapter(root, {}, { pool })
      const span = await collect(adapter.stream(opts([msg('user', 'count files')], { sessionId: 'sess-partial' as never })))
      const finish = span[span.length - 1] as { type: string; reason: { kind: string; failure?: { code: string } } }
      // Single account: the cut span surfaces as unusable tool-calls (no
      // answer), and the 429 benches the only account instead of rotating.
      assert.equal(finish.reason.kind, 'tool-calls')
      assert.equal(span.some((c) => c.type === 'text-delta'), false, 'quota text must not be consumed as an answer')
      const cdUntil = primary.cooldowns.google?.cooldownUntil ?? 0
      assert.ok(cdUntil > Date.now(), `expected a live cooldown, got ${cdUntil - Date.now()}`)
      assert.equal(pool.selectAccount('google'), null, 'the only account is benched by the 429')
    } finally {
      process.env.FAKE_AGY_MODE = prevMode
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('4. SubagentTracker detects subagent & parent SYSTEM_MESSAGE quota exhaustion with strict provenance and burst filtering', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-sub-tracker-q-'))
    try {
      const brainBase = join(root, '.gemini', 'antigravity-cli', 'brain')
      const mainId = 'main-conv-q'
      const subId = 'sub-conv-q'
      const mainLogDir = join(brainBase, mainId, '.system_generated', 'logs')
      const mainSubDir = join(brainBase, mainId, '.system_generated', 'subagents')
      const subLogDir = join(brainBase, subId, '.system_generated', 'logs')
      mkdirSync(mainLogDir, { recursive: true })
      mkdirSync(mainSubDir, { recursive: true })
      mkdirSync(subLogDir, { recursive: true })

      writeFileSync(
        join(mainSubDir, `${subId}.json`),
        JSON.stringify({ conversationId: subId, subagentDescriptor: { typeName: 'image-generator', role: 'Sprite Artist' }, state: 'SUBAGENT_STATE_ALIVE' }),
      )

      const subTranscript = join(subLogDir, 'transcript.jsonl')
      writeFileSync(subTranscript, '')

      const quotaHits: Array<{ source: string; model?: string; resetMs?: number; errorText: string }> = []
      const events: Array<{ text?: string }> = []
      const tracker = new SubagentTracker({
        conversationId: mainId,
        accountHome: root,
        pollIntervalMs: 5000,
        onEvent: (ev) => events.push({ ...(ev.kind === 'step' ? { text: ev.text } : {}) }),
        onQuotaExhausted: (info) => quotaHits.push(info),
      })
      tracker.start()
      // False positives first: command exit and 1s burst and DONE status must NOT fire
      writeFileSync(
        subTranscript,
        [
          JSON.stringify({ step_index: 1, type: 'GENERIC', status: 'ERROR', content: 'Command exited with code 1\nRESOURCE_EXHAUSTED (code 429)' }),
          JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'ERROR', content: 'image failed to generate: 429 Too Many Requests {"error":{"code":429,"message":"Your quota will reset after 1s.","status":"RESOURCE_EXHAUSTED","details":[{"reason":"RATE_LIMIT_EXCEEDED","metadata":{"quotaResetDelay":"1.3s"}}]}}' }),
          JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'RESOURCE_EXHAUSTED (code 429)' }),
        ].join('\n') + '\n',
        { flag: 'a' },
      )
      tracker.poll()
      assert.equal(quotaHits.length, 0)

      // Real subagent QUOTA_EXHAUSTED error
      writeFileSync(
        subTranscript,
        JSON.stringify({
          step_index: 4,
          type: 'GENERIC',
          status: 'ERROR',
          content: 'Encountered error in step execution: image failed to generate: failed to generate content: 429 Too Many Requests, body: {"error":{"code":429,"message":"You have exhausted your capacity on this model. Your quota will reset after 4h58m46s.","status":"RESOURCE_EXHAUSTED","details":[{"reason":"QUOTA_EXHAUSTED","metadata":{"model":"gemini-3.1-flash-image","quotaResetDelay":"4h58m46.438s"}}]}}',
        }) + '\n',
        { flag: 'a' },
      )
      tracker.poll()
      assert.equal(quotaHits.length, 1)
      assert.equal(quotaHits[0]!.model, 'gemini-3.1-flash-image')
      assert.ok((quotaHits[0]!.resetMs ?? 0) > 4 * 3600_000)

      // Parent SYSTEM_MESSAGE subagent error
      const parentTranscript = join(mainLogDir, 'transcript.jsonl')
      writeFileSync(
        parentTranscript,
        JSON.stringify({
          step_index: 10,
          source: 'SYSTEM',
          type: 'SYSTEM_MESSAGE',
          status: 'DONE',
          content: 'The subagent Code Auditor (research) with id "895a3e66" encountered an error: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h43m44s.',
        }) + '\n',
      )
      tracker.poll()
      assert.equal(quotaHits.length, 2)
      assert.ok((quotaHits[1]!.resetMs ?? 0) > 3 * 3600_000)
      tracker.stop()

      // Resumed tracker must baseline parent transcript at EOF and NOT replay step 10
      const resumedHits: unknown[] = []
      const resumedTracker = new SubagentTracker({
        conversationId: mainId,
        accountHome: root,
        resumed: true,
        pollIntervalMs: 5000,
        onEvent: () => {},
        onQuotaExhausted: (info) => resumedHits.push(info),
      })
      resumedTracker.start()
      resumedTracker.poll()
      assert.equal(resumedHits.length, 0)
      resumedTracker.stop()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('7. runAgyOnce refuses to spawn when the primary is unavailable and stops on TOS_VIOLATION', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-oneshot-'))
    const prevMode = process.env.FAKE_AGY_MODE
    const prevInv = process.env.FAKE_AGY_INVOCATION_FILE
    const invFile = join(root, 'inv.txt')
    try {
      process.env.FAKE_AGY_MODE = 'quota-once'
      process.env.FAKE_AGY_INVOCATION_FILE = invFile
      writeFileSync(invFile, '')

      // The single account is already benched -> fail without spawning against
      // an unavailable/undefined account.
      const pool = new AccountPoolManager(join(root, 'pool'))
      const primary = pool.getPrimaryAccount()
      pool.recordFailure(primary.id, 'google', '429')

      const noneRes = await runAgyOnce(
        {
          cfg: () => ({ ...defaultConfig(), permissionMode: 'plan', timeoutMs: 10_000 }),
          bin: () => fakeBin,
          pool: () => pool,
        },
        { prompt: 'ask question' },
      )
      assert.equal(noneRes.ok, false)
      assert.match(noneRes.error ?? '', /unavailable/i)
      assert.equal(readFileSync(invFile, 'utf8').split('\n').filter(Boolean).length, 0)

      // TOS_VIOLATION -> stops on the 1st attempt, no retry.
      process.env.FAKE_AGY_MODE = 'tos-violation'
      const poolTos = new AccountPoolManager(join(root, 'pool-tos'))
      writeFileSync(invFile, '')
      const tosRes = await runAgyOnce(
        {
          cfg: () => ({ ...defaultConfig(), permissionMode: 'plan', timeoutMs: 10_000 }),
          bin: () => fakeBin,
          pool: () => poolTos,
        },
        { prompt: 'ask question' },
      )
      assert.equal(tosRes.ok, false)
      assert.equal(readFileSync(invFile, 'utf8').split('\n').filter(Boolean).length, 1)
    } finally {
      process.env.FAKE_AGY_MODE = prevMode
      if (prevInv === undefined) delete process.env.FAKE_AGY_INVOCATION_FILE
      else process.env.FAKE_AGY_INVOCATION_FILE = prevInv
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('10. runAcpAttempt treats partial-response 429 quota error as RATE_LIMIT and benches the account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-acp-quota-'))
    const pool = new AccountPoolManager(join(dir, 'pool'))
    const primary = pool.getPrimaryAccount()
    const scriptPath = join(dir, 'mock-acp-quota.mjs')
    writeFileSync(scriptPath, `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-q-1' } });
  if (msg.method === 'session/set_mode' || msg.method === 'session/set_config_option') return send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
  if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial answer ' } } } });
    setTimeout(() => {
      send({ jsonrpc: '2.0', id: msg.id, result: { error: { message: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h0m0s.' } } });
    }, 15);
  }
});
rl.on('close', () => process.exit(0));
`, 'utf8')
    const cfg: PluginConfig = { ...defaultConfig(), timeoutMs: 10_000, transport: 'acp' }
    const store = new SessionStore(join(dir, 'sessions.json'))
    const runs = new RunRegistry()
    const spawned: AcpProcess[] = []
    const acpPool = new AcpSessionPool({
      bin: () => scriptPath,
      cfg: () => cfg,
      createProcess: (o) => {
        const p = new AcpProcess({ ...o, preemptAutoUpdate: false })
        spawned.push(p)
        return p
      },
    })
    const deps: AttemptDeps = {
      acquire: () => Promise.resolve(() => {}),
      pool,
      runs,
      store,
      clearInFlightPrompt: () => {},
      registerActiveRun: () => {},
      unregisterActiveRun: () => {},
      isSuperseded: () => false,
      noteNetworkFailure: () => 1,
      clearNetworkStreak: () => {},
      dropFailoverBudget: () => {},
      clearRateLimitFailover: () => {},
      sharesSingleEgress: () => true,
      lastAccountSpawnTime: new Map(),
      minSpawnIntervalMs: 0,
    }
    const input: AttemptInput = {
      cfg,
      bin: scriptPath,
      permissionMode: 'auto',
      sessionKey: 'sess-acp-q',
      workspaceRoot: dir,
      isAux: false,
      account: primary,
      prompt: 'hi',
      model: 'gemini-3.8-flash',
      activeModel: 'gemini-3.8-flash',
      effort: 'medium',
      addDirs: [],
      persistBinding: false,
      binding: undefined,
      messages: [msg('user', 'hi')],
      newlySentImageIds: [],
      sessionAccountKey: 'sess-acp-q',
      family: 'google',
      signal: undefined,
      agyOnEvent: undefined,
      sandbox: false,
      agent: '',
    }
    const slot: AttemptSlot = { releaseOnce: () => {}, armHandoff: () => null }
    try {
      const rec = await runAcpAttempt(acpPool, deps, input, slot)
      assert.ok(rec)
      for await (const _ of rec.eventsFrom(0)) { /* drain */ }
      assert.equal(rec.failureInfo?.kind, 'error')
      assert.equal(rec.failureInfo?.code, Err.RATE_LIMIT)
      assert.ok((primary.cooldowns.google?.cooldownUntil ?? 0) > Date.now() + 3600_000)
      assert.equal(pool.selectAccount('google'), null, 'the sole account stays benched')
    } finally {
      await Promise.all(spawned.map((p) => new Promise<void>((r) => { p.once('exit', () => r()); p.close(); setTimeout(r, 200) })))
      acpPool.dispose()
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
    }
  })

  test('11. standalone agy ⚠ quota banners with ok=true classify as hard quota without false positives on prose', () => {
    const banner = '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h25m47s.'
    const credits = '⚠ Your AI credits balance is too low to continue.'
    assert.equal(isAgyQuotaBannerLine(banner), true)
    assert.equal(isAgyQuotaBannerLine(credits), true)
    assert.equal(extractAgyQuotaBanner(banner), banner)
    assert.equal(isHardQuotaResultError(true, undefined, banner), true)
    assert.equal(isNonConsumableResultError(true, undefined, banner), true)
    assert.equal(isHardQuotaResultError(true, undefined, credits), true)

    // Prose quoting or non-quota ⚠ answers must remain normal consumable replies.
    assert.equal(isAgyQuotaBannerLine('⚠ 端口 8080 已被占用，请先停掉旧服务。'), false)
    assert.equal(isAgyQuotaBannerLine('Fixed Individual quota reached in diagnostics.ts'), false)
    assert.equal(extractAgyQuotaBanner(`${banner}\nDone checking logs.`), undefined)
    assert.equal(isHardQuotaResultError(true, undefined, 'Fixed Individual quota reached handling.'), false)
    assert.equal(isNonConsumableResultError(true, undefined, '⚠ 端口 8080 已被占用，请先停掉旧服务。'), false)
  })

  test('12. EventMapper suppresses fragmented ⚠ quota banners while preserving legitimate ⚠ warnings', () => {
    const mapperQuota = new EventMapper({ runId: 'r-q', cutOnTool: false })
    const c1 = [...mapperQuota.map({ kind: 'step', stepKey: 's1', stepKind: 'text', fragment: true, text: '⚠ Individual quota ' }, 0)]
    const c2 = [...mapperQuota.map({ kind: 'step', stepKey: 's1', stepKind: 'text', fragment: true, text: 'reached. Please upgrade your subscription to increase your limits. Resets in 4h25m47s.' }, 1)]
    const c3 = [...mapperQuota.map({ kind: 'result', conversationId: 'c1', ok: true, response: '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h25m47s.', usage: {}, raw: {} }, 2)]
    const c4 = [...mapperQuota.emitFailure('error', Err.RATE_LIMIT, 'quota reached')]
    const leaked = [...c1, ...c2, ...c3, ...c4].filter((c) => c.type === 'text-delta')
    assert.equal(leaked.length, 0, 'quota banner must never leak as assistant text-delta')
    assert.equal(mapperQuota.isFinished, true)

    const mapperWarn = new EventMapper({ runId: 'r-w', cutOnTool: false })
    const w1 = [...mapperWarn.map({ kind: 'step', stepKey: 's1', stepKind: 'text', fragment: true, text: '⚠ 端口 8080 ' }, 0)]
    const w2 = [...mapperWarn.map({ kind: 'step', stepKey: 's1', stepKind: 'text', fragment: true, text: '已被占用。' }, 1)]
    const w3 = [...mapperWarn.map({ kind: 'result', conversationId: 'c1', ok: true, response: '⚠ 端口 8080 已被占用。', usage: {}, raw: {} }, 2)]
    const textOut = [...w1, ...w2, ...w3].filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
    assert.equal(textOut, '⚠ 端口 8080 已被占用。')
  })

  test('13. runAcpAttempt cools the account when agy emits ⚠ Individual quota reached with end_turn (both post-tool and empty turn)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-acp-banner-quota-'))
    const pool = new AccountPoolManager(join(dir, 'pool'))
    const primary = pool.getPrimaryAccount()
    const scriptPath = join(dir, 'mock-acp-banner.mjs')
    writeFileSync(scriptPath, `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
let promptCount = 0;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-b-1' } });
  if (msg.method === 'session/set_mode' || msg.method === 'session/set_config_option') return send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
  if (msg.method === 'session/prompt') {
    promptCount++;
    if (promptCount === 1) {
      // Simulate a tool call followed by agy emitting ⚠ Individual quota reached... and ending with end_turn.
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', name: 'edit_file', status: 'in_progress', rawInput: { path: 'a.ts' } } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', name: 'edit_file', status: 'completed', rawOutput: 'ok' } } });
      setTimeout(() => {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h25m47s.' } } } });
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }, 20);
    } else {
      // Immediate banner on an empty turn (no tools)
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h25m47s.' } } } });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    }
  }
});
rl.on('close', () => process.exit(0));
`, 'utf8')
    const cfg: PluginConfig = { ...defaultConfig(), timeoutMs: 10_000, transport: 'acp' }
    const store = new SessionStore(join(dir, 'sessions.json'))
    const runs = new RunRegistry()
    const spawned: AcpProcess[] = []
    const acpPool = new AcpSessionPool({
      bin: () => scriptPath,
      cfg: () => cfg,
      createProcess: (o) => {
        const p = new AcpProcess({ ...o, preemptAutoUpdate: false })
        spawned.push(p)
        return p
      },
    })
    const deps: AttemptDeps = {
      acquire: () => Promise.resolve(() => {}),
      pool,
      runs,
      store,
      clearInFlightPrompt: () => {},
      registerActiveRun: () => {},
      unregisterActiveRun: () => {},
      isSuperseded: () => false,
      noteNetworkFailure: () => 1,
      clearNetworkStreak: () => {},
      dropFailoverBudget: () => {},
      clearRateLimitFailover: () => {},
      sharesSingleEgress: () => true,
      lastAccountSpawnTime: new Map(),
      minSpawnIntervalMs: 0,
    }
    const baseInput = (sessionKey: string): AttemptInput => ({
      cfg,
      bin: scriptPath,
      permissionMode: 'auto',
      sessionKey,
      workspaceRoot: dir,
      isAux: false,
      account: primary,
      prompt: 'continue',
      model: 'gemini-3.8-flash',
      activeModel: 'gemini-3.8-flash',
      effort: 'medium',
      addDirs: [],
      persistBinding: false,
      binding: undefined,
      messages: [msg('user', 'continue')],
      newlySentImageIds: [],
      sessionAccountKey: sessionKey,
      family: 'google',
      signal: undefined,
      agyOnEvent: undefined,
      sandbox: false,
      agent: '',
    })
    const slot: AttemptSlot = { releaseOnce: () => {}, armHandoff: () => null }
    try {
      // 1) Post-tool turn: span 0 cuts on tool; continuation span 1 must surface RATE_LIMIT with zero leaked banner text
      const rec1 = await runAcpAttempt(acpPool, deps, baseInput('sess-b-1'), slot)
      assert.ok(rec1)
      const span0: StreamChunk[] = []
      for await (const ch of driveSpan({ runs }, rec1, 0, true, false, undefined, undefined, undefined, undefined, undefined, true, 'sess-b-1')) span0.push(ch)
      const finish0 = span0[span0.length - 1] as { type: string; reason: { kind: string } }
      assert.equal(finish0.reason.kind, 'tool-calls')

      const span1: StreamChunk[] = []
      for await (const ch of driveSpan({ runs }, rec1, 3, true, false, undefined, undefined, undefined, undefined, undefined, true, 'sess-b-1')) span1.push(ch)
      const finish1 = span1[span1.length - 1] as { type: string; reason: { kind: string; failure?: { code: string } } }
      assert.equal(finish1.reason.kind, 'error')
      assert.equal(finish1.reason.failure?.code, Err.RATE_LIMIT)
      assert.equal(span1.some((c) => c.type === 'text-delta'), false, 'must not leak quota banner text before rotating')
      assert.ok((pool.getAccount(primary.id)?.cooldowns.google?.cooldownUntil ?? 0) > Date.now() + 4 * 3600_000)

      // 2) Immediate empty turn: must NOT return null (CLI fallback on same account), must settle RATE_LIMIT
      delete primary.cooldowns.google
      const rec2 = await runAcpAttempt(acpPool, deps, baseInput('sess-b-2'), slot)
      assert.ok(rec2, 'must return settled recording instead of falling back to CLI on the same exhausted account')
      for await (const _ of rec2.eventsFrom(0)) { /* drain */ }
      assert.equal(rec2.failureInfo?.code, Err.RATE_LIMIT)
      assert.ok((pool.getAccount(primary.id)?.cooldowns.google?.cooldownUntil ?? 0) > Date.now() + 4 * 3600_000)
    } finally {
      await Promise.all(spawned.map((p) => new Promise<void>((r) => { p.once('exit', () => r()); p.close(); setTimeout(r, 200) })))
      acpPool.dispose()
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
    }
  })
})
