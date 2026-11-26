import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')

test('service-level coupling ratchet: no new or silently removed bridges', () => {
  try {
    const out = execFileSync(process.execPath, [join(root, 'scripts/check-coupling.mjs')], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.match(out, /^coupling ok: /m)
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    assert.fail([e.stdout, e.stderr, e.message].filter(Boolean).join('\n'))
  }
})

test('coupling baseline and its documentation are present', () => {
  assert.equal(existsSync(join(root, 'scripts/coupling-baseline.json')), true)
  assert.equal(existsSync(join(root, 'docs/architecture/coupling.md')), true)
})
