import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { unwrapGoKeyringPayload } from '../src/runtime/agy/keychain.ts'

test('unwrapGoKeyringPayload decodes go-keyring-base64 and preserves plain JSON', () => {
  const plain = JSON.stringify({ refresh_token: '1//abc' })
  const b64 = 'go-keyring-base64:' + Buffer.from(plain, 'utf8').toString('base64')
  assert.equal(unwrapGoKeyringPayload(b64), plain)
  assert.equal(unwrapGoKeyringPayload(plain), plain)
})
