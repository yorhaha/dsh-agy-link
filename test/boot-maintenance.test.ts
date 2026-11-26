// Startup-cost regressions: the boot path must stay cheap, and the deferred
// maintenance pass must clean up what previous runs left behind.
//
// Covers:
//  - proxy env case folding (Windows env blocks are case-insensitive; writing
//    both spellings breaks PowerShell's env: provider and Start-Process),
//  - loopback NO_PROXY so our own bridge is never sent through a dead proxy,
//  - stale agy presence-lock sweeping,
//  - orphaned MCP server reaping (agy forks them for models/usage probes and
//    never kills them on exit),
//  - the deferred maintenance pass itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PRESENCE_LOCK_MAX_AGE_MS,
  parseCimDate,
  describeStartupCost,
  pickOrphanMcpProcesses,
  presenceDirOf,
  runMaintenancePass,
  scheduleBootMaintenance,
  sweepStalePresenceLocks,
  type ProcessRow,
} from '../src/host/boot-maintenance.ts'
import { ensureLoopbackNoProxy, foldProxyEnvCase, proxyEnvFor } from '../src/runtime/agy/env.ts'
import { buildAgyEnvWithProxy } from '../src/runtime/net/account-env.ts'

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'agy-boot-maint-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

test('foldProxyEnvCase collapses the paired spellings on Windows and leaves POSIX alone', () => {
  const win = foldProxyEnvCase(
    { HTTP_PROXY: 'http://a:1', http_proxy: 'http://a:1', HTTPS_PROXY: 'http://a:1', https_proxy: 'http://a:1', ALL_PROXY: 'http://a:1', all_proxy: 'http://a:1', NO_PROXY: 'localhost', no_proxy: 'localhost' },
    'win32',
  )
  assert.deepEqual(win, {
    HTTP_PROXY: 'http://a:1',
    HTTPS_PROXY: 'http://a:1',
    ALL_PROXY: 'http://a:1',
    NO_PROXY: 'localhost',
  })
  assert.equal((win as Record<string, unknown>).http_proxy, undefined, 'a lowercase duplicate must not survive into the child env block')
  // An inherited lowercase value with no uppercase twin still has to reach agy.
  const onlyLower = foldProxyEnvCase({ https_proxy: 'http://lower:2' }, 'win32')
  assert.deepEqual(onlyLower, { HTTPS_PROXY: 'http://lower:2' })

  // Uppercase wins when both are set to different values.
  const conflict = foldProxyEnvCase({ HTTPS_PROXY: 'http://upper:3', https_proxy: 'http://lower:3' }, 'win32')
  assert.deepEqual(conflict, { HTTPS_PROXY: 'http://upper:3' })

  // Empty values are dropped, not written as ''.
  assert.deepEqual(foldProxyEnvCase({ HTTP_PROXY: '  ', http_proxy: '' }, 'win32'), {})

  // POSIX keeps both spellings: they are distinct variables there.
  const posix = foldProxyEnvCase({ HTTPS_PROXY: 'http://a:1', https_proxy: 'http://a:1' }, 'linux')
  assert.equal(posix.HTTPS_PROXY, 'http://a:1')
  assert.equal(posix.https_proxy, 'http://a:1')
})

test('ensureLoopbackNoProxy appends loopback hosts once and keeps operator entries', () => {
  const first = ensureLoopbackNoProxy({ NO_PROXY: 'corp.example' })
  assert.equal(first.NO_PROXY, 'corp.example,127.0.0.1,localhost,::1')
  assert.equal(first.no_proxy, first.NO_PROXY)

  const again = ensureLoopbackNoProxy({ NO_PROXY: first.NO_PROXY })
  assert.equal(again.NO_PROXY, first.NO_PROXY, 'must be idempotent')

  const lowercaseOnly = ensureLoopbackNoProxy({ no_proxy: 'corp.example,127.0.0.1' })
  assert.equal(lowercaseOnly.NO_PROXY, 'corp.example,127.0.0.1,localhost,::1')

  const empty = ensureLoopbackNoProxy({})
  assert.equal(empty.NO_PROXY, '127.0.0.1,localhost,::1')
})

test('buildAgyEnvWithProxy adds loopback NO_PROXY only when a proxy is actually set', () => {
  const proxied = buildAgyEnvWithProxy({ proxy: 'http://127.0.0.1:17891', base: {} })
  assert.equal(proxied.HTTPS_PROXY, 'http://127.0.0.1:17891')
  assert.match(String(proxied.NO_PROXY), /127\.0\.0\.1/)

  const direct = buildAgyEnvWithProxy({ base: {} })
  assert.equal(direct.NO_PROXY, undefined, 'a direct connection must not invent NO_PROXY')

  // The six-var helper stays intact for POSIX callers and existing tests.
  assert.deepEqual(Object.keys(proxyEnvFor('http://x:1')).sort(), ['ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'all_proxy', 'http_proxy', 'https_proxy'])
})

test('sweepStalePresenceLocks removes only day-old .lock files and never throws on a missing dir', () => {
  withTempDir((dir) => {
    const presence = presenceDirOf(dir)
    mkdirSync(presence, { recursive: true })
    const now = Date.now()
    const old = join(presence, 'old-conversation.lock')
    const fresh = join(presence, 'live-conversation.lock')
    const notLock = join(presence, 'notes.txt')
    writeFileSync(old, '')
    writeFileSync(fresh, '')
    writeFileSync(notLock, 'x')
    const stale = new Date(now - PRESENCE_LOCK_MAX_AGE_MS - 60_000)
    utimesSync(old, stale, stale)
    utimesSync(notLock, stale, stale)

    assert.equal(sweepStalePresenceLocks(dir, now), 1)
    assert.equal(existsSync(old), false)
    assert.equal(existsSync(fresh), true, 'a lock from a live conversation must survive')
    assert.equal(existsSync(notLock), true, 'non-lock files are never touched')

    // Missing dir: no throw, no count.
    assert.equal(sweepStalePresenceLocks(join(dir, 'nope'), now), 0)
  })
})

test('pickOrphanMcpProcesses kills only long-running MCP servers whose parent is gone', () => {
  const now = Date.now()
  const rows: ProcessRow[] = [
    // orphaned chrome-devtools MCP, old enough -> kill
    { pid: 100, parentPid: 10, startedAtMs: now - 30 * 60_000, commandLine: 'node ... chrome-devtools-mcp@latest' },
    // orphaned but brand new: it may belong to an agy process that is still booting
    { pid: 101, parentPid: 11, startedAtMs: now - 1_000, commandLine: 'npx -y computer-use-mcp' },
    // parent still alive -> leave
    { pid: 102, parentPid: 12, startedAtMs: now - 30 * 60_000, commandLine: 'node blender-mcp' },
    // not an MCP server at all
    { pid: 103, parentPid: 13, startedAtMs: now - 30 * 60_000, commandLine: 'node server.js' },
    // orphan with no parent pid recorded
    { pid: 104, parentPid: 0, startedAtMs: now - 30 * 60_000, commandLine: 'godot-mcp.cmd' },
  ]
  const alive = new Set([12])
  const picked = pickOrphanMcpProcesses(rows, (pid) => alive.has(pid), now)
  assert.deepEqual(picked, [100])
})

test('runMaintenancePass aggregates every step and survives a throwing step', () => {
  const logs: string[] = []
  const result = runMaintenancePass({
    sweepLogs: () => {
      throw new Error('disk on fire')
    },
    log: (m) => logs.push(m),
    reapOrphans: false,
  })

  assert.equal(result.presence, 0)
  assert.equal(result.staging, 0)
  assert.equal(result.logs, 0, 'a throwing step degrades to 0 instead of aborting the pass')
  assert.equal(logs.length, 0, 'nothing is logged when every step degraded to 0')
})

test('scheduleBootMaintenance runs deferred passes and stops cleanly', async () => {
  let passes = 0
  const stop = scheduleBootMaintenance(
    {
      sweepLogs: () => {
        passes++
        return 0
      },
      log: () => {},
      reapOrphans: false,
    },
    { initialDelayMs: 5, intervalMs: 5 },
  )
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(passes >= 1, 'the deferred pass must actually run')
  stop()
  const afterStop = passes
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(passes, afterStop, 'stop() must cancel both the first timer and the interval')
})

test('the plugin source wires deferred maintenance instead of doing it inline at boot', () => {
  // Guard against regressing the boot path: these calls must live behind
  // scheduleBootMaintenance(), never in runBootHygiene().
  const hygiene = readFileSync(join(process.cwd(), 'src/host/boot-hygiene.ts'), 'utf8')
  assert.equal(/pool\.sweepStaleStaging\(\)/.test(hygiene), false, 'staging sweep must not run on the load path')
  const index = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8')
  assert.match(index, /scheduleBootMaintenance\(/)
  // The boot probe must not fan model discovery out over several accounts: the
  // multi-account warm-up path is gone with the pool.
  assert.equal(/warmAccounts\(/.test(index), false, 'the boot path must not warm a pool of accounts')
  assert.match(index, /activeRunCount\(\) > 0/)
})

test('parseCimDate reads both PowerShell JSON shapes and refuses to guess', () => {
  // ConvertTo-Json renders CIM DateTime as /Date(ms)/ on Windows PowerShell and
  // as an ISO string on pwsh 7; a parse failure must yield 0 (unknown), never
  // "age 0" which would make the reaper trigger-happy.
  assert.equal(parseCimDate('/Date(1763000000000)/'), 1763000000000)
  assert.equal(parseCimDate('2026-11-22T08:00:00.000Z'), Date.parse('2026-11-22T08:00:00.000Z'))
  assert.equal(parseCimDate(''), 0)
  assert.equal(parseCimDate(undefined), 0)
  assert.equal(parseCimDate('not a date'), 0)
  assert.equal(parseCimDate('/Date(0)/'), 0)
})

test('an orphan with an unparseable start time is never killed', () => {
  const now = Date.now()
  const rows: ProcessRow[] = [
    { pid: 200, parentPid: 20, startedAtMs: 0, commandLine: 'node chrome-devtools-mcp@latest' },
  ]
  assert.deepEqual(pickOrphanMcpProcesses(rows, () => false, now), [])
})

test('describeStartupCost names the registry cost and flags unpinned servers', () => {
  withTempDir((dir) => {
    const registry = join(dir, 'mcp_config.json')
    writeFileSync(
      registry,
      JSON.stringify({
        mcpServers: {
          pinned: { command: 'blender-mcp.exe', args: [] },
          floating: { command: 'npx.cmd', args: ['-y', 'chrome-devtools-mcp@latest'] },
          plain: { command: 'npx.cmd', args: ['-y', 'computer-use-mcp'] },
        },
      }),
    )
    const lines = describeStartupCost(registry, [{ id: 'a', dir: join(dir, 'acc'), enabled: true } as never])
    const text = lines.join('\n')
    assert.match(text, /startup cost: the primary account/)
    assert.match(text, /MCP registry: 3 server\(s\) forked by EVERY agy spawn/)
    assert.match(text, /floating — @latest re-resolves on every spawn/)
    assert.match(text, /plain — npx/)
    assert.doesNotMatch(text, /pinned —/, 'a pinned binary server costs nothing extra')
    assert.match(text, /1 unpinned server\(s\)/)
  })
})

test('describeStartupCost is silent about a missing registry and never throws', () => {
  withTempDir((dir) => {
    const lines = describeStartupCost(join(dir, 'nope.json'), [])
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /startup cost: no signed-in account/)
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{not json')
    assert.doesNotThrow(() => describeStartupCost(broken, []))
  })
})
