import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { defaultConfig, Err, type PluginConfig } from '../src/common/types.ts'
import { AgyAdapter, type AgyAdapterDeps } from '../src/host/adapter.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { AccountPoolManager } from '../src/host/pool.ts'
import { RunRegistry } from '../src/host/recording.ts'
import { SessionStore } from '../src/host/sessions.ts'
import {
  AGY_PROMPT_SAFE_BYTES,
  buildDigest,
  defuseQuotedSlashCommands,
  utf8Bytes,
} from '../src/provider/prompt-text.ts'
import { buildCompactionPrompt } from '../src/provider/compaction-prompt.ts'
import { ParentQuotaMonitor } from '../src/features/subagent/parent-quota.ts'
import { selectSessionAccount } from '../src/provider/account-selection.ts'
import { streamWithEffortRetry } from '../src/provider/retry-policy.ts'
import { createToolWatchdog } from '../src/provider/tool-watchdog.ts'
import { isBackgroundStderrNoise, startAgyProcess } from '../src/runtime/agy/process.ts'

const fakeBin = join(import.meta.dirname, 'fake-agy.mjs')

/**
 * The `parent-429-loop` fake writes 429 transcripts under the real system HOME
 * (that is exactly where the adapter's findBrainDir() lookup resolves). Remove
 * those throwaway conversation dirs after each test so the harness never leaves
 * fake quota logs behind in ~/.gemini.
 */
function cleanupFakeBrainDirs(): void {
  const homes = [homedir(), process.env.USERPROFILE, process.env.HOME].filter(
    (h): h is string => typeof h === 'string' && h !== '',
  )
  for (const home of new Set(homes)) {
    const brain = join(home, '.gemini', 'antigravity-cli', 'brain')
    try {
      for (const name of readdirSync(brain)) {
        if (name.startsWith('conv-parent-429-')) {
          rmSync(join(brain, name), { recursive: true, force: true })
        }
      }
    } catch {
      // no brain dir — nothing to clean
    }
  }
}

function msg(role: 'user' | 'assistant' | 'system' | 'tool', text: string, extra: Record<string, unknown> = {}): Message {
  return { role, content: [{ type: 'text', text }], ...extra } as unknown as Message
}

function opts(messages: Message[], extra: Partial<GenerateOptions> & Record<string, unknown> = {}): GenerateOptions {
  return {
    provider: 'antigravity',
    model: 'gemini-4-neon',
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

describe('compaction deadlock & parent 429 loop resilience', () => {
  test('1. defuseQuotedSlashCommands neutralizes standalone agy commands while preserving paths and URLs', () => {
    const cases: Array<[string, string]> = [
      ['Use after /goal complete or reflect.', 'Use after / goal complete or reflect.'],
      ['Run `/goal` and (/plan) or "/compact"', 'Run `/ goal` and (/ plan) or "/ compact"'],
      ['/schedule at top of line\n使用/goal完成', '/ schedule at top of line\n使用/ goal完成'],
      ['Try /browser /grill-me /teamwork /learn /boost', 'Try / browser / grill-me / teamwork / learn / boost'],
      // Paths, URLs, and hyphenated tokens must remain untouched
      ['Edit /plan/doc.md and src/goal.ts in /tmp/foo', 'Edit /plan/doc.md and src/goal.ts in /tmp/foo'],
      ['C:\\proj\\goal\\plan.txt https://example.com/goal', 'C:\\proj\\goal\\plan.txt https://example.com/goal'],
      ['Track issue /goal-123 and /plan-v2', 'Track issue /goal-123 and /plan-v2'],
    ]
    for (const [input, expected] of cases) {
      assert.equal(defuseQuotedSlashCommands(input), expected)
    }
  })

  test('2. buildCompactionPrompt & buildDigest strip synthetic harness messages, elide tool outputs, keep anchor + newest, and never truncate footer', () => {
    const bigToolPayload = 'HEAD_TOOL_START\n' + 'X'.repeat(60_000) + '\nTAIL_TOOL_END'
    const bigAssistant = 'A_BLOCK_'.repeat(35_000) // ~280KB prose forcing trimming
    const messages: Message[] = [
      msg('system', 'System prompt mentioning /goal and /plan'),
      msg('user', 'Skill catalog: Use after /goal complete in zand-skills', { source: { kind: 'skill-catalog' } }),
      msg('user', 'Time sampled while preparing turn 1: 2026-11-22', { source: { kind: 'time-context' } }),
      msg('user', 'FIRST_OBJECTIVE: build tribal-era games and verify'),
      msg('assistant', bigAssistant),
      msg('tool', bigToolPayload, { toolCallId: 'tc-1' }),
      msg('user', 'Mentioning `/goal` and /plan in history'),
      msg('assistant', 'LATEST_DECISION: fixed shader and ready for final verification'),
      msg('user', 'LATEST_QUESTION: check progress now'),
    ]

    const prompt = buildCompactionPrompt(messages, 800_000)
    assert.ok(utf8Bytes(prompt) <= AGY_PROMPT_SAFE_BYTES, `expected <= ${AGY_PROMPT_SAFE_BYTES}, got ${utf8Bytes(prompt)}`)
    assert.ok(prompt.includes('FIRST_OBJECTIVE: build tribal-era games and verify'), 'retains first real user anchor')
    assert.ok(prompt.includes('LATEST_DECISION: fixed shader and ready for final verification'), 'retains newest assistant decision')
    assert.ok(prompt.includes('LATEST_QUESTION: check progress now'), 'retains newest user turn')
    assert.ok(prompt.includes('</conversation_history>'), 'closing conversation_history tag never truncated')
    assert.ok(prompt.includes('CRITICAL: Output ONLY the markdown summary text directly.'), 'closing instruction never truncated')
    assert.equal(prompt.includes('System prompt mentioning'), false, 'system message stripped')
    assert.equal(prompt.includes('Skill catalog:'), false, 'synthetic skill catalog stripped')
    assert.equal(prompt.includes('Time sampled while preparing'), false, 'time-context stripped')
    assert.equal(/\/(goal|plan)\b/.test(prompt), false, 'standalone /goal and /plan neutralized in compaction prompt')
    assert.ok(prompt.includes('HEAD_TOOL_START') && prompt.includes('TAIL_TOOL_END') && prompt.includes('…[elided'), 'tool payload uses 8:2 middle elision')

    const digest = buildDigest(
      [
        msg('user', 'Discussed /goal and /plan earlier'),
        msg('assistant', 'Ack'),
        msg('user', 'Run /goal on the target now'),
      ],
      0,
      10_000,
    )
    assert.ok(digest.includes('/ goal and / plan'), 'digest history neutralizes quoted slash commands')
    assert.ok(digest.includes('User: Run /goal on the target now'), 'live task line keeps original user text')
  })

  test('3. ParentQuotaMonitor tracks transcript_full.jsonl streaks, Stop hook deadlocks, healthy resets, and resumed baseline', () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-parent-quota-'))
    try {
      const logsDir = join(root, '.system_generated', 'logs')
      mkdirSync(logsDir, { recursive: true })
      const fullLog = join(logsDir, 'transcript_full.jsonl')
      const compactLog = join(logsDir, 'transcript.jsonl')
      writeFileSync(compactLog, JSON.stringify({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'hi' }) + '\n')
      writeFileSync(fullLog, JSON.stringify({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'hi' }) + '\n')

      const monitor = new ParentQuotaMonitor()
      const hits: Array<{ source: string; errorText: string }> = []

      // 1-2 generic 429s followed by healthy PLANNER_RESPONSE -> no trigger, streak resets
      writeFileSync(fullLog, [
        JSON.stringify({ step_index: 1, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: 'API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted.' }),
        JSON.stringify({ step_index: 2, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: 'API error (attempt 2): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted.' }),
      ].join('\n') + '\n', { flag: 'a' })
      monitor.poll(root, (h) => hits.push(h))
      assert.equal(hits.length, 0, '2 generic 429s must not trip threshold=3')

      writeFileSync(fullLog, JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Recovered ok' }) + '\n', { flag: 'a' })
      monitor.poll(root, (h) => hits.push(h))
      assert.equal(hits.length, 0)

      // 1s transient burst & TOS_VIOLATION must be ignored
      writeFileSync(fullLog, [
        JSON.stringify({ step_index: 4, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: '429 Too Many Requests {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"reason":"RATE_LIMIT_EXCEEDED","metadata":{"quotaResetDelay":"1s"}}]}}' }),
        JSON.stringify({ step_index: 5, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: 'TOS_VIOLATION (code 429)' }),
      ].join('\n') + '\n', { flag: 'a' })
      monitor.poll(root, (h) => hits.push(h))
      assert.equal(hits.length, 0)

      // 3 consecutive generic 429s -> fires once
      writeFileSync(fullLog, [
        JSON.stringify({ step_index: 6, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: 'API error (attempt 1): RESOURCE_EXHAUSTED (code 429)' }),
        JSON.stringify({ step_index: 7, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: 'API error (attempt 2): RESOURCE_EXHAUSTED (code 429)' }),
        JSON.stringify({ step_index: 8, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: 'API error (attempt 3): RESOURCE_EXHAUSTED (code 429)' }),
      ].join('\n') + '\n', { flag: 'a' })
      monitor.poll(root, (h) => hits.push(h))
      assert.equal(hits.length, 1)
      assert.equal(hits[0]!.source, 'parent-retry-loop')

      // Authoritative QUOTA_EXHAUSTED triggers at threshold=2
      monitor.reset()
      monitor.baseline(root)
      writeFileSync(fullLog, [
        JSON.stringify({ step_index: 9, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h10m.' }),
        JSON.stringify({ step_index: 10, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h10m.' }),
      ].join('\n') + '\n', { flag: 'a' })
      monitor.poll(root, (h) => hits.push(h))
      assert.equal(hits.length, 2)

      // 1 generic 429 + Stop hook blocked termination -> fires immediately
      monitor.reset()
      monitor.baseline(root)
      writeFileSync(fullLog, [
        JSON.stringify({ step_index: 11, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: 'API error (attempt 1): RESOURCE_EXHAUSTED (code 429)' }),
        JSON.stringify({ step_index: 12, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'Stop hook blocked termination: You are still working toward the user\'s goal.' }),
      ].join('\n') + '\n', { flag: 'a' })
      monitor.poll(root, (h) => hits.push(h))
      assert.equal(hits.length, 3)

      // Resumed baseline ignores all pre-existing errors
      const resumed = new ParentQuotaMonitor()
      resumed.baseline(root)
      const resumedHits: unknown[] = []
      resumed.poll(root, (h) => resumedHits.push(h))
      assert.equal(resumedHits.length, 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Tests 4 and 5 covered multi-account failover (429 loop rotating to a
  // second account, and aux model fallback across accounts). The plugin now
  // drives a single account, so those scenarios no longer exist.

  test('6. Background aux caps watchdog printTimeout/maxTurnMs and stderr noise ignores 429 retry spam', async () => {
    const cfg: PluginConfig = {
      ...defaultConfig(),
      timeoutMs: 600_000,
      longToolIdleMinutes: 240,
      maxTurnMinutes: 0,
    }
    const auxWd = createToolWatchdog(undefined, cfg, { isBackgroundAux: true })
    assert.ok(auxWd.printTimeoutMinutes <= 10, `expected aux printTimeoutMinutes <= 10, got ${auxWd.printTimeoutMinutes}`)
    assert.equal(auxWd.maxTurnMs, 180_000)

    const customCfg: PluginConfig = { ...cfg, maxTurnMinutes: 2, timeoutMs: 600_000 }
    const cappedAuxWd = createToolWatchdog(undefined, customCfg, { isBackgroundAux: true })
    assert.equal(cappedAuxWd.maxTurnMs, 120_000)

    const chatWd = createToolWatchdog(undefined, cfg)
    assert.equal(chatWd.printTimeoutMinutes, 240)
    assert.equal(chatWd.maxTurnMs, undefined)

    assert.equal(isBackgroundStderrNoise('I1122 13:50:50.782366 733 run.go:317] Run: attempt 1 failed (RESOURCE_EXHAUSTED (code 429)), retrying in 4s'), true)
    assert.equal(isBackgroundStderrNoise('I1122 14:06:51.939920 332 manager.go:1641] Reloading system slash commands'), true)
    assert.equal(isBackgroundStderrNoise('I1122 14:06:52.958550 1 manager.go:1650] Slash commands unchanged, skipping update'), true)

    // Watchdog integration: 429 retry spam on stderr must not extend timeoutMs=300ms
    const script = `
      setTimeout(() => {
        process.stderr.write('I1122 13:50:50.782366 733 run.go:317] Run: attempt 1 failed (RESOURCE_EXHAUSTED (code 429)), retrying in 4s\\n');
      }, 150);
      setTimeout(() => process.exit(0), 1200);
    `
    const proc = startAgyProcess({
      bin: process.execPath,
      args: ['-e', script],
      timeoutMs: 300,
      stderrKeepalive: true,
    })
    const outcome = await proc.outcome
    assert.equal(outcome.timedOut, true, 'run.go 429 retry stderr spam must not keep watchdog alive')
  })
})
