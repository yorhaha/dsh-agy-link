import assert from 'node:assert/strict'
import test from 'node:test'
import { BackgroundRetention } from '../src/domain/background/retention.ts'

test('a lease keeps the session retained until the last holder releases', () => {
  const retention = new BackgroundRetention()
  const first = retention.acquire('sid-1', 'sess-1')
  const second = retention.acquire('sid-1')
  assert.equal(retention.has('sid-1'), true)
  assert.deepEqual(retention.entries(), [{ acpSessionId: 'sid-1', sessionKey: 'sess-1' }])

  first.release()
  first.release() // idempotent
  assert.equal(retention.has('sid-1'), true, 'the second holder still has it')

  second.release()
  assert.equal(retention.has('sid-1'), false)
  assert.deepEqual(retention.entries(), [])
})

test('a later lease backfills a missing DSH session key', () => {
  const retention = new BackgroundRetention()
  const lease = retention.acquire('sid-2')
  retention.acquire('sid-2', 'sess-2')
  assert.deepEqual(retention.entries(), [{ acpSessionId: 'sid-2', sessionKey: 'sess-2' }])
  lease.release()
  assert.equal(retention.has('sid-2'), true, 'the keyless holder still owns its lease')
})

test('an empty ACP session id never creates a lease', () => {
  const retention = new BackgroundRetention()
  const lease = retention.acquire('')
  lease.release()
  assert.equal(retention.has(''), false)
  assert.deepEqual(retention.entries(), [])
})

test('subscribers see the release that actually drops the session', () => {
  const retention = new BackgroundRetention()
  let changes = 0
  const unsubscribe = retention.subscribe(() => {
    changes += 1
  })
  const first = retention.acquire('sid-3')
  const second = retention.acquire('sid-3')
  first.release()
  assert.equal(changes, 0, 'a refcount move that keeps the session has no effective change')
  second.release()
  assert.equal(changes, 1)

  unsubscribe()
  retention.acquire('sid-4').release()
  assert.equal(changes, 1, 'unsubscribed observers stay silent')
})
