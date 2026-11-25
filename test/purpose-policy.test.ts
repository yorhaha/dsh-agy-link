import { test } from 'node:test'
import assert from 'node:assert/strict'
import { purposePolicy } from '../src/provider/purpose-policy.ts'

const p = (purpose: 'chat' | 'compaction' | 'session-title' | 'image', isReview = false) =>
  purposePolicy({ purpose, isReview })

test('chat mirrors tools and persists its binding', () => {
  assert.equal(p('chat').aux, false)
  assert.equal(p('chat').mirrorTools, true)
  assert.equal(p('chat').pinLowEffort, false)
  assert.equal(p('chat').persistBinding(), true)
})

test('background helpers are aux, low effort, no tools, no binding', () => {
  for (const purpose of ['compaction', 'session-title'] as const) {
    assert.equal(p(purpose).aux, true)
    assert.equal(p(purpose).pinLowEffort, true)
    assert.equal(p(purpose).mirrorTools, false)
    assert.equal(p(purpose).persistBinding(), false)
  }
})

test('review behaves like a background helper regardless of purpose', () => {
  const review = p('chat', true)
  assert.equal(review.aux, true)
  assert.equal(review.pinLowEffort, true)
  assert.equal(review.mirrorTools, false)
  assert.equal(review.persistBinding(), false)
})

test('image never persists a binding and keeps the caller effort', () => {
  const i = p('image')
  assert.equal(i.pinLowEffort, false)
  assert.equal(i.mirrorTools, false)
  assert.equal(i.persistBinding(), false)
})
