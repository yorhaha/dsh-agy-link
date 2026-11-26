import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { EventMapper, ToolProjection } from '../src/host/mapper.ts'

type ToolCallEnd = Extract<StreamChunk, { type: 'block-end' }> & {
  block: { type: 'tool-call'; name: string }
}

const activeStep = {
  kind: 'step',
  stepKey: '1',
  stepKind: 'tool',
  state: 'ACTIVE',
  text: '',
  tool: { name: 'run_command', args: { CommandLine: 'echo hi' } },
} as const

const doneStep = {
  kind: 'step',
  stepKey: '1',
  stepKind: 'tool',
  state: 'DONE',
  text: '',
  tool: { name: 'run_command', args: { CommandLine: 'echo hi' }, output: 'hi' },
} as const

function mapAll(mapper: EventMapper, events: readonly unknown[]): StreamChunk[] {
  const out: StreamChunk[] = []
  let i = 0
  for (const event of events) {
    out.push(...mapper.map(event as never, i++))
  }
  return out
}

function toolCalls(chunks: readonly StreamChunk[]): ToolCallEnd[] {
  return chunks.filter(
    (chunk): chunk is ToolCallEnd =>
      chunk.type === 'block-end' && (chunk as { block?: { type?: string } }).block?.type === 'tool-call',
  )
}

test('ToolProjection combines purpose policy with the mirror liveness gate', () => {
  let live = true
  const projection = new ToolProjection({ cutOnTool: true, canCutOnTool: () => live })
  assert.equal(projection.enabled, true)
  assert.equal(projection.canCut, true)

  live = false
  assert.equal(projection.canCut, false, 'mid-span mirror loss suppresses the cut')

  const auxiliary = new ToolProjection({ cutOnTool: false, canCutOnTool: () => true })
  assert.equal(auxiliary.enabled, false)
  assert.equal(auxiliary.canCut, false, 'auxiliary calls never cut spans')
})

test('EventMapper consumes a ToolProjection instead of a host callback', () => {
  let live = true
  const projection = new ToolProjection({ cutOnTool: true, canCutOnTool: () => live })
  const mapper = new EventMapper({ runId: 'run-projection', cutOnTool: true, toolProjection: projection })

  const before = mapAll(mapper, [activeStep])
  const reasoning = before
    .filter((chunk): chunk is Extract<StreamChunk, { type: 'reasoning-delta' }> => chunk.type === 'reasoning-delta')
    .map((chunk) => chunk.text)
    .join('')
  assert.match(reasoning, /agy tool running: run_command/)

  live = false
  const after = mapAll(mapper, [
    doneStep,
    { kind: 'result', conversationId: 'c1', ok: true, response: 'done', usage: {}, raw: {} },
  ])
  assert.equal(toolCalls(after).length, 0, 'revoked projection must not emit an agy_tool call')
  const finish = after.find((chunk) => chunk.type === 'finish')
  assert.ok(finish && finish.type === 'finish')
  assert.equal(finish.reason.kind, 'stop')
})

test('an enabled ToolProjection still emits the native tool card', () => {
  const mapper = new EventMapper({
    runId: 'run-projection-live',
    cutOnTool: true,
    toolProjection: new ToolProjection({ cutOnTool: true }),
  })
  const chunks = mapAll(mapper, [doneStep])
  const calls = toolCalls(chunks)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.block.name, 'agy_tool')
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  assert.ok(finish && finish.type === 'finish')
  assert.equal(finish.reason.kind, 'tool-calls')
})
