import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defaultConfig } from '../src/common/types/config.ts'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const doc = readFileSync(join(root, 'docs/CONFIGURATION.md'), 'utf8')

interface DocRow {
  env: string
  value: string
  description: string
}

function parseRows(): Map<string, DocRow> {
  const rows = new Map<string, DocRow>()
  for (const line of doc.split('\n')) {
    if (!line.startsWith('| `')) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    if (cells.length !== 4) continue
    const [rawKey, env, value, description] = cells
    if (!rawKey || !env || !value || !description) continue
    const key = rawKey.replace(/^`|`$/g, '')
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) continue
    assert.equal(rows.has(key), false, `duplicate config docs row for ${key}`)
    rows.set(key, { env, value, description })
  }
  return rows
}

/** Parse the leading backticked literal; prose defaults return undefined. */
function parseLiteral(raw: string): unknown {
  const match = raw.match(/^`([^`]*)`/)
  if (!match) return undefined
  const token = match[1] ?? ''
  if (token === "''") return ''
  if (token === 'true') return true
  if (token === 'false') return false
  if (token === '[]') return []
  if (/^-?\d+$/.test(token)) return Number(token)
  return token
}

// Defaults that are intentionally prose, because their value is structural or
// platform-specific. They are checked separately below.
const PROSE_DEFAULTS = new Set(['fallbackModels', 'suppressAgyAutoUpdate'])

test('every PluginConfig key has exactly one row in docs/CONFIGURATION.md', () => {
  const rows = parseRows()
  const defaults = defaultConfig()
  for (const key of Object.keys(defaults)) {
    assert.equal(rows.has(key), true, `docs/CONFIGURATION.md is missing config key "${key}"`)
  }
  for (const key of rows.keys()) {
    assert.equal(key in defaults, true, `docs/CONFIGURATION.md documents unknown config key "${key}"`)
  }
})

test('documented defaults match defaultConfig()', () => {
  const rows = parseRows()
  const defaults = defaultConfig() as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(defaults)) {
    if (PROSE_DEFAULTS.has(key)) continue
    const row = rows.get(key)
    assert.ok(row, `missing docs row for ${key}`)
    const parsed = parseLiteral(row.value)
    assert.notEqual(parsed, undefined, `${key}: default "${row.value}" is neither a literal nor a declared prose default`)
    assert.deepEqual(parsed, value, `${key}: docs say ${row.value}, defaultConfig() says ${JSON.stringify(value)}`)
  }
})

test('prose defaults stay aligned with their implementation', () => {
  const rows = parseRows()
  const defaults = defaultConfig()
  assert.equal(defaults.suppressAgyAutoUpdate, process.platform === 'win32')
  assert.match(rows.get('suppressAgyAutoUpdate')?.value.replaceAll('`', '') ?? '', /true on Windows, false elsewhere/)
  assert.ok(defaults.fallbackModels.length > 0)
  assert.match(rows.get('fallbackModels')?.value ?? '', /lineup/i)
})
