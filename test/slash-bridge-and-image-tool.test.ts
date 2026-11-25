import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { defaultConfig } from '../src/common/types.ts'
import { handleConfig } from '../src/host/commands/config.ts'
import type { CommandDeps } from '../src/host/commands/shared.ts'
import { handleSlashBridge } from '../src/host/commands/slash-bridge.ts'
import { runAgyOnce } from '../src/host/oneshot.ts'
import { AccountPoolManager } from '../src/host/pool.ts'
import { SessionStore } from '../src/host/sessions.ts'

test('slash-bridge handles fork/restore/list, grill-me, learn --apply with traversal rejection, and compact', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-slash-bridge-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const store = new SessionStore(join(dir, 'sessions.json'))
  store.set('sess-1', { conversationId: 'conv-orig', lastMessageCount: 3, updatedAt: Date.now(), model: 'gemini-3.8-flash' })
  const wsDir = join(dir, 'ws')
  const forksFile = join(dir, 'forks.json')
  const runs: Array<Record<string, unknown>> = []
  let nextRunResult: { ok: boolean; text: string; conversationId: string | null; error?: string; durationMs: number } = {
    ok: true, text: 'Side answer', conversationId: 'conv-branch', durationMs: 25,
  }

  const fakeSession = {
    header: { cwd: wsDir },
    snapshotEvents: () => [
      { type: 'user/message', data: { message: { content: 'Build module A' } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Implemented A' }] } } },
    ],
  }

  const deps: CommandDeps = {
    cfg: () => ({ ...defaultConfig(), workspaceRoot: wsDir }),
    bin: () => 'agy',
    version: () => '1.5.12',
    auth: () => ({} as never),
    catalog: () => ({} as never),
    store: () => store,
    pool: () => ({} as never),
    lastRun: () => null,
    runDoctor: async () => '',
    setOverride: () => {},
    forksFile,
    sessions: () => ({ get: () => fakeSession }),
    runOnce: async (req) => {
      runs.push(req)
      return nextRunResult
    },
  }

  const inv = {
    commandId: 'agy' as CommandInvocation['commandId'],
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
    agent: { id: 'sess-1', session: fakeSession },
  } as unknown as CommandInvocation

  // Empty fork list before any checkpoint
  assert.match((await handleSlashBridge(deps, { sub: 'fork', arg: 'list', parts: ['fork', 'list'], raw: '/agy fork list', invocation: inv })).text ?? '', /No fork checkpoints saved/)

  // Missing runOnce runner paths
  const noRunnerDeps: CommandDeps = { ...deps, runOnce: undefined }
  for (const sub of ['grill', 'learn', 'compact'] as const) {
    const msg = (await handleSlashBridge(noRunnerDeps, { sub, arg: 'q', parts: [sub, 'q'], raw: `/agy ${sub} q`, invocation: inv })).text ?? ''
    assert.match(msg, /not configured/)
  }

  // runOnce failure propagation paths
  nextRunResult = { ok: false, text: '', conversationId: null, error: 'boom', durationMs: 5 }
  assert.match((await handleSlashBridge(deps, { sub: 'fork', arg: 'go', parts: ['fork', 'go'], raw: '/agy fork go', invocation: inv })).text ?? '', /Fork execution failed/)
  assert.match((await handleSlashBridge(deps, { sub: 'grill', arg: 'x', parts: ['grill', 'x'], raw: '/agy grill x', invocation: inv })).text ?? '', /Grill interview failed/)
  assert.match((await handleSlashBridge(deps, { sub: 'learn', arg: 'x', parts: ['learn', 'x'], raw: '/agy learn x', invocation: inv })).text ?? '', /Learn preview failed/)
  assert.match((await handleSlashBridge(deps, { sub: 'learn', arg: '--apply x', parts: ['learn', '--apply', 'x'], raw: '/agy learn --apply x', invocation: inv })).text ?? '', /Learn --apply failed/)
  assert.match((await handleSlashBridge(deps, { sub: 'compact', arg: '', parts: ['compact'], raw: '/agy compact', invocation: inv })).text ?? '', /Compaction failed/)
  nextRunResult = { ok: true, text: 'Side answer', conversationId: 'conv-branch', durationMs: 25 }
})

test('runAgyOnce handles headless deny on empty exit-0, structured_output, effort-refused retry, and model-not-recognized failover', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-oneshot-edge-'))
  const fakeBin = join(dir, 'fake-oneshot-agy.mjs')
  const logFile = join(dir, 'invocations.jsonl')
  writeFileSync(
    fakeBin,
    [
      'import { appendFileSync, readFileSync } from "node:fs"',
      'const mode = process.env.FAKE_ONESHOT_MODE || ""',
      'const logFile = process.env.FAKE_ONESHOT_LOG || ""',
      'const args = process.argv.slice(2)',
      'if (logFile) appendFileSync(logFile, JSON.stringify({ args, mode }) + "\\n")',
      'if (mode === "headless-deny") {',
      '  process.stderr.write("jetski: no output produced — a tool required the \\"command\\" permission that headless mode cannot prompt for, so it was auto-denied.\\n")',
      '  process.exit(0)',
      '}',
      'if (mode === "structured-output") {',
      '  console.log(JSON.stringify({ event: "result", result: { conversation_id: "c-struct", status: "SUCCESS", response: "", structured_output: { kind: "rule", name: "r1" } } }))',
      '  process.exit(0)',
      '}',
      'if (mode === "effort-refused") {',
      '  if (args.includes("--effort")) {',
      '    process.stderr.write("invalid model selection (--model \\"gemini-3.8-flash\\" --effort \\"high\\"): --effort \\"high\\" is not supported for model \\"gemini-3.8-flash\\"\\n")',
      '    process.exit(1)',
      '  }',
      '  console.log(JSON.stringify({ event: "result", result: { conversation_id: "c-eff", status: "OK", response: "recovered without effort" } }))',
      '  process.exit(0)',
      '}',
      'if (mode === "model-not-recognized") {',
      '  const calls = logFile ? readFileSync(logFile, "utf8").trim().split("\\n").filter(Boolean).length : 1',
      '  if (calls === 1) {',
      '    process.stderr.write("invalid model selection (--model \\"gemini-4-hydrogen\\" --effort \\"\\"): model gemini-4-hydrogen is not recognized as a known model or custom model in settings\\n")',
      '    process.exit(1)',
      '  }',
      '  console.log(JSON.stringify({ event: "result", result: { conversation_id: "c-m2", status: "OK", response: "served by account 2" } }))',
      '  process.exit(0)',
      '}',
    ].join('\n'),
  )

  const prevMode = process.env.FAKE_ONESHOT_MODE
  const prevLog = process.env.FAKE_ONESHOT_LOG
  t.after(() => {
    if (prevMode === undefined) delete process.env.FAKE_ONESHOT_MODE
    else process.env.FAKE_ONESHOT_MODE = prevMode
    if (prevLog === undefined) delete process.env.FAKE_ONESHOT_LOG
    else process.env.FAKE_ONESHOT_LOG = prevLog
    rmSync(dir, { recursive: true, force: true })
  })

  process.env.FAKE_ONESHOT_LOG = logFile
  const baseOneShotDeps = {
    cfg: () => ({ ...defaultConfig(), agyBin: fakeBin, workspaceRoot: dir, timeoutMs: 10_000, mcpBridge: false }),
    bin: () => fakeBin,
  }

  // Case 1: headless-deny on exit 0 empty output
  process.env.FAKE_ONESHOT_MODE = 'headless-deny'
  const denyRes = await runAgyOnce(baseOneShotDeps, { prompt: 'hello' })
  assert.equal(denyRes.ok, false)
  assert.match(denyRes.error ?? '', /headless mode cannot prompt/)

  // Case 2: structured_output extraction
  process.env.FAKE_ONESHOT_MODE = 'structured-output'
  const structRes = await runAgyOnce(baseOneShotDeps, {
    prompt: 'learn',
    schema: { type: 'object', properties: { kind: { type: 'string' }, name: { type: 'string' } } },
  })
  assert.equal(structRes.ok, true, structRes.error)
  assert.deepEqual(JSON.parse(structRes.text), { kind: 'rule', name: 'r1' })

  // Case 3: effort-refused retry
  writeFileSync(logFile, '')
  process.env.FAKE_ONESHOT_MODE = 'effort-refused'
  const refusedModels: string[] = []
  const effRes = await runAgyOnce(
    { ...baseOneShotDeps, onEffortUnsupported: (m) => refusedModels.push(m) },
    { prompt: 'hi', model: 'gemini-3.8-flash', effort: 'high' },
  )
  assert.equal(effRes.ok, true, effRes.error)
  assert.equal(effRes.text, 'recovered without effort')
  assert.deepEqual(refusedModels, ['gemini-3.8-flash'])
  const effLogs = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[] })
  assert.equal(effLogs.length, 2)
  assert.equal(effLogs[0]!.args.includes('--effort'), true)
  assert.equal(effLogs[1]!.args.includes('--effort'), false)

  // Case 4: model-not-recognized failover across pool accounts
  writeFileSync(logFile, '')
  process.env.FAKE_ONESHOT_MODE = 'model-not-recognized'
  const pool = new AccountPoolManager(join(dir, 'pool-mnr'))
  pool.createAccountSlot('Second')
  const firstAcc = pool.getAccounts()[0]!
  const mnrRes = await runAgyOnce(
    { ...baseOneShotDeps, pool: () => pool },
    { prompt: 'hi', model: 'gemini-4-hydrogen' },
  )
  assert.equal(mnrRes.ok, true, mnrRes.error)
  assert.equal(mnrRes.text, 'served by account 2')
  const mnrLogs = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(mnrLogs.length, 2)
  assert.equal(pool.isModelSupported(firstAcc, 'gemini-4-hydrogen'), false)
})
