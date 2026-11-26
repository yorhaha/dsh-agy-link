// HTTP contract guard for the extracted /plugins/agy-link/* surface.
//
// Phase 3 moved every route body out of apply() into src/transport/http/*.
// This test pins the public contract without spawning agy or starting a real
// server: it drives registerRoutes() with a recording fake webServer and calls
// handlers directly with fake services.
//
// Scope: the full 20-route table plus the error/edge branches each handler
// actually implements today (method gating, strict-body parsing, parameter
// validation, unknown ids, upstream failure mapping). Assertions describe the
// CURRENT behaviour — no handler is changed by this file.
import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { registerRoutes } from '../src/transport/http/router.ts'
import { QUOTA_REFRESH_DEDUP_MS } from '../src/common/timeouts.ts'
import { AccountPoolManager } from '../src/host/pool.ts'
import type { HostServices } from '../src/host/services.ts'
import type { Route } from '../src/transport/http/respond.ts'

// The /qr handler dynamically imports the real `qrcode` package and renders a
// PNG. Dynamic import of this CJS package resolves the same exports object that
// createRequire returns, so replacing toBuffer here keeps the route real while
// making the response instant and independent of PNG generation (no timeout).
try {
  const qrcode = createRequire(import.meta.url)('qrcode') as { toBuffer?: (...args: unknown[]) => Promise<Buffer> }
  qrcode.toBuffer = async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
} catch {
  // qrcode unavailable: the /qr test still asserts the 404 branches.
}

/** The frozen route surface: kind + path, exactly as the client half polls it. */
const EXPECTED_ROUTES: ReadonlyArray<readonly [kind: string, path: string]> = [
  ['exact', '/plugins/agy-link/status'],
  ['exact', '/plugins/agy-link/session-view'],
  ['exact', '/plugins/agy-link/pool/begin-add'],
  ['exact', '/plugins/agy-link/pool/complete-add'],
  ['exact', '/plugins/agy-link/pool/cancel-add'],
  ['exact', '/plugins/agy-link/pool/refresh-quota'],
  ['exact', '/plugins/agy-link/auth'],
  ['exact', '/plugins/agy-link/auth-code'],
  ['exact', '/plugins/agy-link/auth-cancel'],
  ['exact', '/plugins/agy-link/qr'],
  ['exact', '/plugins/agy-link/config'],
  ['exact', '/plugins/agy-link/mermaid.min.js'],
  ['exact', '/plugins/agy-link/media'],
  ['exact', '/plugins/agy-link/open'],
  ['prefix', '/plugins/agy-link/assets'],
  ['exact', '/plugins/agy-link/embed'],
  ['exact', '/plugins/agy-link/lease/acquire'],
  ['exact', '/plugins/agy-link/lease/renew'],
  ['exact', '/plugins/agy-link/lease/release'],
  ['exact', '/plugins/agy-link/lease'],
]

/** Routes that reject every non-POST method with `405 {error:'POST only'}`. */
const POST_ONLY_ROUTES = [
  '/plugins/agy-link/auth',
  '/plugins/agy-link/auth-code',
  '/plugins/agy-link/auth-cancel',
  '/plugins/agy-link/pool/begin-add',
  '/plugins/agy-link/pool/complete-add',
  '/plugins/agy-link/pool/cancel-add',
  '/plugins/agy-link/pool/refresh-quota',
  '/plugins/agy-link/config',
  '/plugins/agy-link/open',
] as const

type FakeWebServer = {
  routes: Route[]
  disposed: string[]
  register(route: Route): () => void
}

function fakeWebServer(): FakeWebServer {
  const routes: Route[] = []
  const disposed: string[] = []
  return {
    routes,
    disposed,
    register(route) {
      routes.push(route)
      return () => {
        disposed.push(route.path)
      }
    },
  }
}

const POOL_DATA = {
  version: 1,
  defaultCooldownMs: 900_000,
  maxCooldownMs: 3_600_000,
  primaryAccountId: 'acc_primary',
  accounts: [],
}

type Overrides = Partial<Record<string, unknown>>
type ConfigOverrides = Record<string, unknown>

const BASE_CONFIG: Record<string, unknown> = {
  enabled: true,
  permissionMode: 'default',
  sandbox: false,
  agent: '',
  agySettings: '',
  transport: 'cli',
  mcpBridge: false,
  workspaceRoot: '/tmp/agy-contract',
  defaultModel: 'gemini-3-flash',
  defaultEffort: 'high',
  askTool: false,
  hiddenModels: [] as string[],
  selectedModels: [] as string[],
  showHeaderBadge: true,
  poolWideCatalog: false,
  proxyUrl: '',
  mcpConfigScope: 'global',
  mcpConfigPath: '',
  mediaDir: '',
  mediaTtlMs: 86_400_000,
  quotaPollIntervalMs: 900_000,
  logRetentionDays: 7,
  maxConcurrent: 0,
  suppressAgyAutoUpdate: false,
  quotaViaCli: false,
  fallbackModels: [] as string[],
  modelsCacheTtlMs: 0,
}

/** Minimal plain-object services double: only the fields these handlers touch. */
function fakeServices(overrides: Overrides = {}, config: ConfigOverrides = {}): HostServices {
  const cfg = { ...BASE_CONFIG, ...config }
  const base = {
    getConfig: () => cfg,
    log: () => undefined,
    notifyPicker: () => undefined,
    bin: () => null,
    version: () => null,
    status: { version: '1.1.15', dormantReason: null as string | null },
    store: { all: () => ({}) as Record<string, unknown>, clear: () => undefined },
    pool: {
      getPoolData: () => POOL_DATA,
      getAccounts: () => [],
      getAccount: () => undefined,
      getPrimaryAccount: () => undefined,
    },
    quota: {},
    catalog: {
      get: () => ({ source: 'fallback', models: [], lastError: null }),
      getAllKnownModels: () => [],
    },
    auth: { status: () => ({ phase: 'idle' }) },
    poolAuth: { status: () => ({ phase: 'idle' }) },
    adapter: { effortUnsupportedModels: () => [] },
    acpPool: { status: () => ({ activeProcesses: 0, sessions: 0, keys: [] }) },
    setOverride: () => undefined,
    readEffortUnsupported: () => [],
    rememberEffortUnsupported: () => undefined,
    sessionsSvc: () => undefined,
    sessionAuto: new Map<string, boolean>(),
    lastRun: null,
    lastParser: { recentLines: [] },
    mediaDir: () => '/tmp/agy-contract',
    bridgeState: { bridge: null, restores: [] as Array<() => void> },
    webServerPort: {} as { current?: number },
    hostDir: '',
    onConfigWritten: () => undefined,
    ...overrides,
  }
  return base as unknown as HostServices
}

type Captured = {
  res: unknown
  done: Promise<void>
  status: () => number
  headers: () => Record<string, string>
  text: () => string
  json: () => unknown
}

/** Fake ServerResponse that resolves `done` when the handler ends the response. */
function capture(): Captured {
  let status = 0
  let headers: Record<string, string> = {}
  let body = ''
  let resolveDone: () => void = () => undefined
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const res = {
    writeHead(s: number, h: Record<string, string>) {
      status = s
      headers = h
    },
    end(b?: unknown) {
      body = typeof b === 'string' ? b : b === undefined ? '' : Buffer.from(b as Uint8Array).toString('utf8')
      resolveDone()
    },
  }
  return {
    res,
    done,
    status: () => status,
    headers: () => headers,
    text: () => body,
    json: () => JSON.parse(body) as unknown,
  }
}

/** Fake IncomingMessage: readJsonBody sees the JSON body then 'end'. */
function fakeReq(method: string, url = '/', body?: unknown): unknown {
  return rawReq(method, url, body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
}

/** Fake IncomingMessage from raw chunks (malformed / oversized bodies). */
function rawReq(method: string, url = '/', chunks: Buffer[] = []): unknown {
  return {
    method,
    url,
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') for (const c of chunks) cb(c)
      if (event === 'end') cb(Buffer.alloc(0))
      return undefined
    },
  }
}

function oversizedReq(method: string, url = '/'): unknown {
  return rawReq(method, url, [Buffer.from(JSON.stringify({ text: 'x'.repeat(1_100_000) }))])
}

async function invoke(route: Route, req: unknown): Promise<Captured> {
  const captured = capture()
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('route did not end the response: ' + route.path)), 5_000)
    timer.unref?.()
  })
  try {
    route.handler(req, captured.res)
    await Promise.race([captured.done, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  return captured
}

function routeFor(routes: Route[], path: string): Route {
  const route = routes.find((r) => r.path === path)
  assert.ok(route, 'route must be registered: ' + path)
  return route
}

type Spy<T> = ((...args: unknown[]) => T) & { calls: unknown[][] }
function spy<T>(ret: T): Spy<T> {
  const calls: unknown[][] = []
  const fn = (...args: unknown[]): T => {
    calls.push(args)
    return ret
  }
  return Object.assign(fn, { calls })
}

/** Single-account pool double: every method the surviving account routes touch. */
function poolDouble(overrides: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown[]]> = []
  const fn = (name: string, ret: unknown) => (...args: unknown[]): unknown => {
    calls.push([name, args])
    return ret
  }
  const pool = {
    getPoolData: fn('getPoolData', POOL_DATA),
    getAccounts: fn('getAccounts', []),
    getAccount: fn('getAccount', undefined),
    getPrimaryAccount: fn('getPrimaryAccount', undefined),
    ...overrides,
  }
  return {
    pool,
    calls,
    callsTo: (name: string) => calls.filter(([n]) => n === name).map(([, args]) => args),
  }
}

/** Register routes against a fake server and return a path→route lookup. */
function setup(overrides: Overrides = {}, config: ConfigOverrides = {}) {
  const webServer = fakeWebServer()
  const services = fakeServices(overrides, config)
  registerRoutes(webServer, services)
  return {
    webServer,
    services,
    route: (path: string) => routeFor(webServer.routes, path),
    call: async (path: string, req: unknown) => invoke(routeFor(webServer.routes, path), req),
  }
}

// ---------------------------------------------------------------------------
// Surface + happy paths
// ---------------------------------------------------------------------------

test('registerRoutes exposes exactly the frozen route surface', () => {
  const webServer = fakeWebServer()
  const dispose = registerRoutes(webServer, fakeServices())
  assert.equal(webServer.routes.length, EXPECTED_ROUTES.length, 'route count changed')
  const actual = webServer.routes
    .map((r) => [r.kind, r.path] as const)
    .sort((a, b) => a[1].localeCompare(b[1]))
  const expected = [...EXPECTED_ROUTES].sort((a, b) => a[1].localeCompare(b[1]))
  assert.deepEqual(actual, expected)
  for (const route of webServer.routes) {
    assert.equal(typeof route.handler, 'function', 'handler must be a function: ' + route.path)
  }
  const paths = new Set(webServer.routes.map((r) => r.path))
  assert.equal(paths.size, EXPECTED_ROUTES.length, 'duplicate route path')
  assert.equal(typeof dispose, 'function')
})

test('the registerRoutes disposer tears every route down', () => {
  const webServer = fakeWebServer()
  const dispose = registerRoutes(webServer, fakeServices())
  dispose()
  assert.equal(webServer.disposed.length, EXPECTED_ROUTES.length)
  assert.deepEqual([...webServer.disposed].sort(), webServer.routes.map((r) => r.path).sort())
})

test('/status answers 200 with the client-visible shape', async () => {
  const webServer = fakeWebServer()
  registerRoutes(webServer, fakeServices())
  const captured = await invoke(routeFor(webServer.routes, '/plugins/agy-link/status'), fakeReq('GET'))
  assert.equal(captured.status(), 200)
  assert.equal(captured.headers()['Content-Type'], 'application/json; charset=utf-8')
  const body = captured.json() as Record<string, unknown>
  assert.equal(body.plugin, 'dsh-agy-link')
  assert.equal(body.bin, null)
  assert.equal(body.version, '1.1.15')
  assert.equal(body.dormantReason, null)
  assert.equal(body.enabled, true)
  assert.deepEqual(body.pool, POOL_DATA)
  assert.deepEqual(body.catalog, { source: 'fallback', count: 0, lastError: null })
  assert.deepEqual(body.catalogModels, [])
  assert.deepEqual(body.hiddenModels, [])
  assert.equal(body.bindings, 0)
  assert.deepEqual(body.effortUnsupported, [])
  assert.equal(body.lastRun, null)
  // Field names the client half depends on (frozen contract).
  for (const key of [
    'permissionMode', 'workspaceRoot', 'defaultModel', 'defaultEffort', 'askTool', 'auth', 'poolAuth',
    'showHeaderBadge',
  ]) {
    assert.ok(key in body, 'status must keep field ' + key)
  }
  assert.equal(body.showHeaderBadge, true)
  assert.equal('poolWideCatalog' in body, false, 'the pool-wide catalog switch is gone')
})

test('/session-view answers for the family of the model this session selected', async () => {
  const dao = {
    id: 'acc_dao',
    alias: 'dao',
    email: 'dao@example.com',
    dir: '',
    systemHome: true,
    enabled: true,
    createdAt: 1,
    cooldowns: {},
    quotas: {
      google: { remainingFraction: 0.98, resetTime: new Date(Date.now() + 86_400_000).toISOString(), updatedAt: Date.now() },
      argon: { weeklyFraction: 0.58, weeklyResetTime: new Date(Date.now() + 86_400_000).toISOString(), updatedAt: Date.now() },
    },
  }
  const poolData = {
    version: 1,
    defaultCooldownMs: 900_000,
    maxCooldownMs: 3_600_000,
    primaryAccountId: 'acc_dao',
    accounts: [dao],
  }
  const pool = {
    getPoolData: () => poolData,
    getAccounts: () => [dao],
    getAccount: (id: string) => (id === 'acc_dao' ? dao : undefined),
    isAccountEligible: () => true,
  }
  // The session's own selection outranks the configured default model.
  const sessionsSvc = () => ({
    get: () => ({ log: [{ type: 'model/selection', data: { provider: 'antigravity', model: 'gemini-4-argon-high' } }] }),
  })
  const setup = () => {
    const webServer = fakeWebServer()
    registerRoutes(webServer, fakeServices({ pool, sessionsSvc } as never))
    return { call: (path: string, req: unknown) => invoke(routeFor(webServer.routes, path), req) }
  }

  const captured = await setup().call('/plugins/agy-link/session-view', fakeReq('GET', '/?session=session-1'))
  assert.equal(captured.status(), 200)
  const body = captured.json() as Record<string, unknown>
  assert.equal(body.family, 'argon')
  assert.equal(body.accountId, 'acc_dao')
  assert.equal(body.alias, 'dao')
  assert.equal(body.percent, 58)
  assert.equal(body.window, 'weekly')
  assert.equal(body.model, 'gemini-4-argon-high')

  // No session id: the configured default decides, and the single primary
  // account is still the account that serves the family.
  const fallback = await setup().call('/plugins/agy-link/session-view', fakeReq('GET'))
  const fallbackBody = fallback.json() as Record<string, unknown>
  assert.equal(fallbackBody.model, 'gemini-3-flash')
  assert.equal(fallbackBody.family, 'google')
  assert.equal(fallbackBody.accountId, 'acc_dao')
  assert.equal(fallbackBody.percent, 98)
  assert.equal(fallbackBody.source, 'predicted')
})

test('/status forwards an explicit UI visibility opt-out (issue #105)', async () => {
  const webServer = fakeWebServer()
  registerRoutes(webServer, fakeServices({}, { showHeaderBadge: false }))
  const captured = await invoke(routeFor(webServer.routes, '/plugins/agy-link/status'), fakeReq('GET'))
  assert.equal(captured.status(), 200)
  const body = captured.json() as Record<string, unknown>
  assert.equal(body.showHeaderBadge, false, 'an explicit false must reach the client unchanged')
})

test('/status reflects bin/dormant/last-run/pool proxy and announces no method gate', async () => {
  const pool = poolDouble()
  const s = setup({
    bin: () => '/opt/agy',
    status: { version: '1.2.3', dormantReason: 'agy 1.0.0 is older than 1.1.15' },
    store: { all: () => ({ a: {}, b: {} }), clear: () => undefined },
    pool: pool.pool,
    catalog: {
      get: () => ({ source: 'agy', models: [{}, {}], lastError: 'boom' }),
      getAllKnownModels: () => [],
    },
    adapter: { effortUnsupportedModels: () => ['claude-sonnet-4-6'] },
    lastRun: { processOk: true, processCode: '0', toolErrors: [], durationMs: 10, model: 'm', tokenSpeed: { lastTps: 1, avgTps: 1, outputTokens: 1, measuredSteps: 1, generatingMs: 1 } },
  }, { proxyUrl: '  http://proxy.local:8080  ', hiddenModels: ['hidden-1'], enabled: false })

  // No method gate on GET-style routes: POST is processed identically.
  const captured = await invoke(s.route('/plugins/agy-link/status'), fakeReq('POST'))
  assert.equal(captured.status(), 200)
  const body = captured.json() as Record<string, unknown>
  assert.equal(body.bin, '/opt/agy')
  assert.equal(body.version, '1.2.3')
  assert.equal(body.dormantReason, 'agy 1.0.0 is older than 1.1.15')
  assert.equal(body.enabled, false)
  assert.deepEqual(body.hiddenModels, ['hidden-1'])
  assert.deepEqual(body.catalog, { source: 'agy', count: 2, lastError: 'boom' })
  assert.deepEqual(body.effortUnsupported, ['claude-sonnet-4-6'])
  assert.equal(body.bindings, 2)
  assert.deepEqual(body.lastRun, { processOk: true, processCode: '0', toolErrors: [], durationMs: 10, model: 'm', tokenSpeed: { lastTps: 1, avgTps: 1, outputTokens: 1, measuredSteps: 1, generatingMs: 1 } })
  assert.deepEqual(pool.callsTo('getPoolData'), [['http://proxy.local:8080']], 'status passes the trimmed proxy to getPoolData')
})

// ---------------------------------------------------------------------------
// Method gating tables
// ---------------------------------------------------------------------------

test('every POST-only route rejects GET/PUT/DELETE with 405 before touching services', async () => {
  const s = setup()
  for (const path of POST_ONLY_ROUTES) {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const captured = await invoke(s.route(path), fakeReq(method))
      assert.equal(captured.status(), 405, path + ' ' + method)
      assert.deepEqual(captured.json(), { error: 'POST only' }, path + ' ' + method)
    }
  }
  // POST-only + 7 GET/method-agnostic routes + 4 lease routes (their own
  // `{ok,code,error}` envelope; gated in test/lease-routes.test.ts).
  assert.equal(POST_ONLY_ROUTES.length + 7 + 4, EXPECTED_ROUTES.length)
})

test('GET-style routes do not gate on method (current contract, asserted verbatim)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-contract-get-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'assets'), { recursive: true })
  const s = setup({ hostDir: root }, {})
  const cases: Array<[string, string, number]> = [
    ['/plugins/agy-link/status', '/', 200],
    ['/plugins/agy-link/session-view', '/?session=s', 200],
    ['/plugins/agy-link/qr', '/', 404],
    ['/plugins/agy-link/mermaid.min.js', '/', 404],
    ['/plugins/agy-link/media', '/', 400],
    ['/plugins/agy-link/assets', '/plugins/agy-link/assets/none.js', 404],
    ['/plugins/agy-link/embed', '/', 400],
  ]
  for (const [path, url, expected] of cases) {
    const captured = await invoke(s.route(path), fakeReq('POST', url))
    assert.notEqual(captured.status(), 405, path + ' must not reject POST')
    assert.equal(captured.status(), expected, path + ' POST status')
  }
})

test('a request without a method is treated as GET (methodOf default)', async () => {
  const s = setup()
  const noMethod = { url: '/', on: () => undefined }
  const captured = await invoke(s.route('/plugins/agy-link/config'), noMethod)
  assert.equal(captured.status(), 405)
  assert.deepEqual(captured.json(), { error: 'POST only' })
})

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test('/config is POST-only and validates keys before writing', async () => {
  const writes: Array<[string, unknown]> = []
  const configWrites: Array<[string, unknown]> = []
  let pickerEvents = 0
  const s = setup({
    setOverride: (key: string, value: unknown) => {
      writes.push([key, value])
    },
    onConfigWritten: (key: string, value: unknown) => {
      configWrites.push([key, value])
    },
    notifyPicker: () => {
      pickerEvents++
    },
  })
  const route = s.route('/plugins/agy-link/config')

  const wrongMethod = await invoke(route, fakeReq('GET'))
  assert.equal(wrongMethod.status(), 405)
  assert.deepEqual(wrongMethod.json(), { error: 'POST only' })
  assert.equal(writes.length, 0)

  const unknownKey = await invoke(route, fakeReq('POST', '/', { key: 'notAKey', value: 1 }))
  assert.equal(unknownKey.status(), 400)
  assert.deepEqual(unknownKey.json(), { error: 'key not settable' })
  assert.equal(writes.length, 0)

  const missingKey = await invoke(route, fakeReq('POST', '/', { value: 1 }))
  assert.equal(missingKey.status(), 400)
  assert.deepEqual(missingKey.json(), { error: 'key not settable' })


  const badArray = await invoke(route, fakeReq('POST', '/', { key: 'hiddenModels', value: 'nope' }))
  assert.equal(badArray.status(), 400)
  assert.deepEqual(badArray.json(), { error: 'hiddenModels must be an array of model ids' })
  assert.equal(writes.length, 0)

  // issue #131: the allow-list is validated exactly like the deny-list.
  const badSelected = await invoke(route, fakeReq('POST', '/', { key: 'selectedModels', value: ['ok', 1] }))
  assert.equal(badSelected.status(), 400)
  assert.deepEqual(badSelected.json(), { error: 'selectedModels must be an array of model ids' })
  assert.equal(writes.length, 0)

  const ok = await invoke(route, fakeReq('POST', '/', { key: 'defaultEffort', value: 'high' }))
  assert.equal(ok.status(), 200)
  assert.deepEqual(ok.json(), { ok: true, key: 'defaultEffort', value: 'high' })
  assert.deepEqual(writes, [['defaultEffort', 'high']])
  assert.deepEqual(configWrites, [['defaultEffort', 'high']])
  assert.equal(pickerEvents, 0, 'unrelated keys must not announce a picker update')

  const hidden = await invoke(route, fakeReq('POST', '/', { key: 'hiddenModels', value: ['gemini-3.7-flash'] }))
  assert.equal(hidden.status(), 200)
  assert.equal(pickerEvents, 1, 'hiddenModels writes must announce the picker update')

  // issue #105: both visibility switches are settable through the same guarded
  // endpoint; neither is a picker event.
  for (const [key, value] of [['showHeaderBadge', false]] as const) {
    const res = await invoke(route, fakeReq('POST', '/', { key, value }))
    assert.equal(res.status(), 200, key + ' must be an allowed config key')
    assert.deepEqual(res.json(), { ok: true, key, value })
    assert.deepEqual(writes.at(-1), [key, value])
  }
  // issue #108/#109: toggling the pool-wide catalog CHANGES the visible model
  // set, so it must announce a picker update (otherwise the cached picker
  // keeps showing the old account's models until a restart).
  const wide = await invoke(route, fakeReq('POST', '/', { key: 'poolWideCatalog', value: true }))
  assert.equal(wide.status(), 200)
  assert.deepEqual(writes.at(-1), ['poolWideCatalog', true])
  assert.equal(pickerEvents, 2, 'poolWideCatalog must refresh the model picker like hiddenModels')

  // issue #131: ticking a subset changes the picker contents too.
  const selected = await invoke(route, fakeReq('POST', '/', { key: 'selectedModels', value: ['gemini-3.7-flash'] }))
  assert.equal(selected.status(), 200)
  assert.deepEqual(writes.at(-1), ['selectedModels', ['gemini-3.7-flash']])
  assert.equal(pickerEvents, 3, 'selectedModels writes must announce the picker update')
})

test('/config treats malformed and oversized bodies as empty (non-strict read)', async () => {
  const writes: unknown[] = []
  const s = setup({ setOverride: (...args: unknown[]) => writes.push(args) })
  const route = s.route('/plugins/agy-link/config')

  const malformed = await invoke(route, rawReq('POST', '/', [Buffer.from('{not json')]))
  assert.equal(malformed.status(), 400)
  assert.deepEqual(malformed.json(), { error: 'key not settable' })
  assert.equal(writes.length, 0)

  const oversized = await invoke(route, oversizedReq('POST'))
  assert.equal(oversized.status(), 400)
  assert.deepEqual(oversized.json(), { error: 'key not settable' })
  assert.equal(writes.length, 0)
})

test('/config does not type-check free-form values (current contract)', async () => {
  const writes: unknown[] = []
  const s = setup({ setOverride: (...args: unknown[]) => writes.push(args) })
  const captured = await invoke(
    s.route('/plugins/agy-link/config'),
    fakeReq('POST', '/', { key: 'defaultModel', value: 42 }),
  )
  assert.equal(captured.status(), 200)
  assert.deepEqual(captured.json(), { ok: true, key: 'defaultModel', value: 42 })
  assert.deepEqual(writes, [['defaultModel', 42]])
})

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

test('/pool/complete-add validates the code and maps pool success/failure', async () => {
  const beginState = { ok: false, phase: 'failed', code: 'BAD_CODE' }
  const pool = poolDouble()
  const s = setup({
    pool: pool.pool,
    poolAuth: {
      status: () => ({ phase: 'idle' }),
      submitCode: async () => beginState,
    },
  })

  const missing = await invoke(s.route('/plugins/agy-link/pool/complete-add'), fakeReq('POST', '/', {}))
  assert.equal(missing.status(), 400)
  assert.deepEqual(missing.json(), { ok: false, phase: 'waiting', code: 'missing_code' })

  const failed = await invoke(s.route('/plugins/agy-link/pool/complete-add'), fakeReq('POST', '/', { code: 'abc' }))
  assert.equal(failed.status(), 400)
  assert.deepEqual(failed.json(), { ok: false, phase: 'failed', code: 'BAD_CODE', pool: POOL_DATA })
})

test('/pool/complete-add returns 200 and the pool snapshot when the login completes', async () => {
  const pool = poolDouble()
  const s = setup({
    pool: pool.pool,
    poolAuth: {
      status: () => ({ phase: 'idle' }),
      submitCode: async () => ({ ok: true, phase: 'ok', code: 'OK' }),
    },
  })
  const captured = await invoke(s.route('/plugins/agy-link/pool/complete-add'), fakeReq('POST', '/', { code: 'abc' }))
  assert.equal(captured.status(), 200)
  assert.deepEqual(captured.json(), { ok: true, phase: 'ok', code: 'OK', pool: POOL_DATA })
  assert.deepEqual(pool.callsTo('getPoolData'), [[]])
})

test('/pool/begin-add / cancel-add forward to the pool auth flow and map begin failure to 500', async () => {
  const begun: unknown[][] = []
  const cancelled: unknown[][] = []
  const s = setup({
    getConfig: () => ({ ...BASE_CONFIG, proxyUrl: '' }),
    poolAuth: {
      status: () => ({ phase: 'idle' }),
      begin: async (...args: unknown[]) => {
        begun.push(args)
        return { ok: false, phase: 'failed', code: 'NOPE' }
      },
      cancel: async (...args: unknown[]) => {
        cancelled.push(args)
        return undefined
      },
    },
  })

  const failed = await invoke(s.route('/plugins/agy-link/pool/begin-add'), fakeReq('POST', '/', { alias: 'a', proxyUrl: 'http://p:1' }))
  assert.equal(failed.status(), 500)
  assert.deepEqual(failed.json(), { ok: false, phase: 'failed', code: 'NOPE' })
  assert.deepEqual(begun, [['a', 'http://p:1']])

  const cancel = await invoke(s.route('/plugins/agy-link/pool/cancel-add'), fakeReq('POST', '/', {}))
  assert.equal(cancel.status(), 200)
  assert.deepEqual(cancel.json(), { ok: true, pool: POOL_DATA })
  assert.equal(cancelled.length, 1)
})

test('/pool/begin-add falls back to the configured proxy and trims the body value', async () => {
  const begun: unknown[][] = []
  const s = setup({
    getConfig: () => ({ ...BASE_CONFIG, proxyUrl: ' http://cfg-proxy:9 ' }),
    poolAuth: {
      status: () => ({ phase: 'idle' }),
      begin: async (...args: unknown[]) => {
        begun.push(args)
        return { ok: true, phase: 'pending' }
      },
    },
  })
  const trimmed = await invoke(s.route('/plugins/agy-link/pool/begin-add'), fakeReq('POST', '/', { proxyUrl: '  http://body-proxy:1  ' }))
  assert.equal(trimmed.status(), 200)
  assert.deepEqual(begun[0], [undefined, 'http://body-proxy:1'])

  const fromConfig = await invoke(s.route('/plugins/agy-link/pool/begin-add'), fakeReq('POST', '/', {}))
  assert.equal(fromConfig.status(), 200)
  assert.deepEqual(begun[1], [undefined, 'http://cfg-proxy:9'])
})

test('/pool/refresh-quota refreshes one known account and tolerates unknown ids', async () => {
  const acc = { id: 'known' }
  const pool = poolDouble({ getAccount: (id: unknown) => (id === 'known' ? acc : undefined) })
  const quotaRefreshes: unknown[][] = []
  const catalogCalls: unknown[][] = []
  const s = setup({
    pool: pool.pool,
    quota: {
      refreshAccountQuota: async (...args: unknown[]) => {
        quotaRefreshes.push(args)
      },
      refreshAllQuotas: async () => undefined,
    },
    catalog: {
      get: () => ({ source: 'fallback', models: [], lastError: null }),
      getAllKnownModels: () => [],
      forceRefresh: async (...args: unknown[]) => {
        catalogCalls.push(args)
      },
    },
  })

  const known = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', { id: 'known' }))
  assert.equal(known.status(), 200)
  assert.deepEqual(quotaRefreshes, [[acc, true]])

  const unknown = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', { id: 'ghost' }))
  assert.equal(unknown.status(), 200)
  assert.deepEqual(quotaRefreshes, [[acc, true]], 'unknown id refreshes nothing')
  assert.deepEqual(catalogCalls, [['known'], ['ghost']])
})

test('/pool/refresh-quota reports a duplicate click instead of silently doing nothing', async () => {
  // WHY: the route dedupes by key for up to QUOTA_REFRESH_DEDUP_MS. A click that
  // lands inside that window used to answer exactly like a fresh start, so a
  // slow pool looked frozen ("I clicked and the second account never moved").
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started: string[] = []
  const acc = { id: 'inflight-acct' }
  const pool = poolDouble({ getAccount: (id: unknown) => (id === 'inflight-acct' ? acc : undefined) })
  const s = setup({
    pool: pool.pool,
    quota: {
      refreshAccountQuota: async () => {
        started.push('pipeline')
        await gate
      },
      refreshAllQuotas: async () => undefined,
    },
    catalog: {
      get: () => ({ source: 'fallback', models: [], lastError: null }),
      getAllKnownModels: () => [],
      forceRefresh: async () => undefined,
    },
  })

  const first = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', { id: 'inflight-acct' }))
  const second = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', { id: 'inflight-acct' }))
  assert.equal(first.status(), 200)
  assert.equal((first.json() as Record<string, unknown>).alreadyRunning, false)
  assert.equal((second.json() as Record<string, unknown>).alreadyRunning, true, 'the duplicate click must be reported as such')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['pipeline'], 'a duplicate click must never stack a second pipeline')
  release!()
})

test('/status forwards the account ids the host is refreshing right now', async () => {
  const withIds = fakeServices({ quota: { refreshingAccounts: () => ['a1', 'a2'] } })
  const webServer = fakeWebServer()
  registerRoutes(webServer, withIds)
  const captured = await invoke(routeFor(webServer.routes, '/plugins/agy-link/status'), fakeReq('GET'))
  assert.deepEqual((captured.json() as Record<string, unknown>).quotaRefreshing, ['a1', 'a2'])

  // A host double without the method must degrade to an empty list, not throw.
  const withoutMethod = fakeServices({ quota: {} })
  const ws2 = fakeWebServer()
  registerRoutes(ws2, withoutMethod)
  const second = await invoke(routeFor(ws2.routes, '/plugins/agy-link/status'), fakeReq('GET'))
  assert.deepEqual((second.json() as Record<string, unknown>).quotaRefreshing, [])
})

test('/pool/refresh-quota decouples slow catalog.warmAccounts from quotaRefreshInFlight', async () => {
  let releaseWarm: (() => void) | null = null
  const warmGate = new Promise<void>((resolve) => {
    releaseWarm = resolve
  })
  let refreshCalls = 0
  let warmCalls = 0
  const s = setup({
    pool: poolDouble({ getAccounts: () => [] }).pool,
    quota: {
      refreshAccountQuota: async () => undefined,
      refreshAllQuotas: async () => { refreshCalls++ },
    },
    catalog: {
      get: () => ({ source: 'fallback', models: [], lastError: null }),
      getAllKnownModels: () => [],
      forceRefresh: async () => undefined,
      warmAccounts: async () => {
        warmCalls++
        await warmGate
      },
    },
  })

  const first = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', {}))
  assert.equal(first.status(), 200)
  assert.equal((first.json() as Record<string, unknown>).alreadyRunning, false)
  // Let refreshAllQuotas + forceRefresh finish while warmAccounts stays pending.
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  const second = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', {}))
  assert.equal(second.status(), 200)
  assert.equal((second.json() as Record<string, unknown>).alreadyRunning, false, 'slow catalog.warmAccounts must not keep quotaRefreshInFlight locked')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(refreshCalls, 2)
  assert.equal(warmCalls, 1, 'warmAccounts still deduplicates its own background run via catalogWarmInFlight')
  releaseWarm!()
  await new Promise((resolve) => setImmediate(resolve))
})

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

test('/auth forwards the trimmed proxy and returns the auth status', async () => {
  const beginCalls: unknown[][] = []
  const s = setup({
    getConfig: () => ({ ...BASE_CONFIG, proxyUrl: 'http://cfg:1' }),
    auth: {
      status: () => ({ phase: 'idle' }),
      begin: async (...args: unknown[]) => {
        beginCalls.push(args)
        return { phase: 'pending', url: 'https://accounts.google.com/x', accountId: 'a1' }
      },
    },
  })
  const captured = await invoke(
    s.route('/plugins/agy-link/auth'),
    fakeReq('POST', '/', { homeDir: '/home/u', accountId: 'a1', proxyUrl: '  http://body:2  ' }),
  )
  assert.equal(captured.status(), 200)
  assert.deepEqual(captured.json(), { phase: 'pending', url: 'https://accounts.google.com/x', accountId: 'a1' })
  assert.deepEqual(beginCalls, [['/home/u', 'a1', 'http://body:2']])
})

test('/auth falls back to the configured proxy when the body omits it', async () => {
  const beginCalls: unknown[][] = []
  const s = setup({
    getConfig: () => ({ ...BASE_CONFIG, proxyUrl: ' http://cfg:1 ' }),
    auth: {
      status: () => ({ phase: 'idle' }),
      begin: async (...args: unknown[]) => {
        beginCalls.push(args)
        return { phase: 'idle' }
      },
    },
  })
  const captured = await invoke(s.route('/plugins/agy-link/auth'), fakeReq('POST', '/', {}))
  assert.equal(captured.status(), 200)
  assert.deepEqual(beginCalls, [[undefined, undefined, 'http://cfg:1']])
})

test('/auth-code rejects a missing code and completes the login on success', async () => {
  const storeClears: unknown[] = []
  const quotaCalls: unknown[][] = []
  const catalogCalls: unknown[][] = []
  const acc = { id: 'a1' }
  const s = setup({
    store: { all: () => ({}), clear: (...args: unknown[]) => storeClears.push(args) },
    pool: { ...poolDouble({ getAccount: (id: unknown) => (id === 'a1' ? acc : undefined) }).pool },
    quota: {
      refreshAccountQuota: async (...args: unknown[]) => quotaCalls.push(['account', ...args]),
      refreshAllQuotas: async (...args: unknown[]) => quotaCalls.push(['all', ...args]),
    },
    catalog: {
      get: () => ({ source: 'fallback', models: [], lastError: null }),
      getAllKnownModels: () => [],
      forceRefresh: async (...args: unknown[]) => catalogCalls.push(args),
    },
    auth: {
      status: () => ({ phase: 'idle' }),
      submitCode: async (code: string) => ({ phase: code === 'ok' ? 'ok' : 'failed', accountId: 'a1' }),
    },
  })

  const missing = await invoke(s.route('/plugins/agy-link/auth-code'), fakeReq('POST', '/', {}))
  assert.equal(missing.status(), 400)
  assert.deepEqual(missing.json(), { error: 'missing code' })

  const failed = await invoke(s.route('/plugins/agy-link/auth-code'), fakeReq('POST', '/', { code: 'nope' }))
  assert.equal(failed.status(), 200)
  assert.deepEqual(failed.json(), { phase: 'failed', accountId: 'a1' })
  assert.equal(storeClears.length, 0)
  assert.equal(quotaCalls.length, 0)

  const ok = await invoke(s.route('/plugins/agy-link/auth-code'), fakeReq('POST', '/', { code: 'ok' }))
  assert.equal(ok.status(), 200)
  assert.deepEqual(ok.json(), { phase: 'ok', accountId: 'a1' })
  assert.deepEqual(quotaCalls, [['account', acc]])
  assert.equal(storeClears.length, 1)
  assert.equal(catalogCalls.length, 1)
})

test('/auth-code refreshes every account when no account id is attached', async () => {
  const quotaCalls: unknown[][] = []
  const s = setup({
    store: { all: () => ({}), clear: () => undefined },
    quota: {
      refreshAccountQuota: async (...args: unknown[]) => quotaCalls.push(['account', ...args]),
      refreshAllQuotas: async (...args: unknown[]) => quotaCalls.push(['all', ...args]),
    },
    catalog: {
      get: () => ({ source: 'fallback', models: [], lastError: null }),
      getAllKnownModels: () => [],
      forceRefresh: async () => undefined,
    },
    auth: {
      status: () => ({ phase: 'idle' }),
      submitCode: async () => ({ phase: 'ok' }),
    },
  })
  const captured = await invoke(s.route('/plugins/agy-link/auth-code'), fakeReq('POST', '/', { code: 'ok' }))
  assert.equal(captured.status(), 200)
  assert.deepEqual(quotaCalls, [['all']])
})

test('/auth-cancel cancels the pending flow', async () => {
  const cancels: unknown[] = []
  const s = setup({
    auth: {
      status: () => ({ phase: 'idle' }),
      cancelAuth: (...args: unknown[]) => {
        cancels.push(args)
        return { phase: 'cancelled' }
      },
    },
  })
  const captured = await invoke(s.route('/plugins/agy-link/auth-cancel'), fakeReq('POST', '/', {}))
  assert.equal(captured.status(), 200)
  assert.deepEqual(captured.json(), { phase: 'cancelled' })
  assert.equal(cancels.length, 1)
})

test('/qr returns 404 without a pending URL and a PNG when one exists', async () => {
  const idle = setup()
  const none = await invoke(idle.route('/plugins/agy-link/qr'), fakeReq('GET'))
  assert.equal(none.status(), 404)
  assert.equal(none.text(), 'no pending auth')

  // Pending but with no URL is still 404.
  const pendingNoUrl = setup({ auth: { status: () => ({ phase: 'pending' }) } })
  assert.equal((await invoke(pendingNoUrl.route('/plugins/agy-link/qr'), fakeReq('GET'))).status(), 404)

  const pending = setup({
    auth: { status: () => ({ phase: 'pending', url: 'https://accounts.google.com/o/oauth2/auth?client_id=x' }) },
  })
  const captured = await invoke(pending.route('/plugins/agy-link/qr'), fakeReq('GET'))
  assert.equal(captured.status(), 200)
  assert.equal(captured.headers()['Content-Type'], 'image/png')
  assert.equal(captured.headers()['Cache-Control'], 'no-store')
  // The stubbed toBuffer returns a tiny PNG magic header (see the module stub).
  assert.ok(captured.text().length > 0)
})

test('/media rejects a missing path, missing files, non-images and directories', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-contract-media-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const text = join(root, 'note.txt')
  const image = join(root, 'ok.png')
  const dir = join(root, 'sub')
  writeFileSync(text, 'plain text')
  writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  mkdirSync(dir, { recursive: true })

  const s = setup()
  const route = s.route('/plugins/agy-link/media')

  const missingParam = await invoke(route, fakeReq('GET', '/'))
  assert.equal(missingParam.status(), 400)
  assert.equal(missingParam.text(), 'missing path query parameter')

  const missingFile = await invoke(route, fakeReq('GET', '/?path=' + encodeURIComponent(join(root, 'nope.png'))))
  assert.equal(missingFile.status(), 404)
  assert.equal(missingFile.text(), 'file not found')

  const nonImage = await invoke(route, fakeReq('GET', '/?path=' + encodeURIComponent(text)))
  assert.equal(nonImage.status(), 403)
  assert.equal(nonImage.text(), 'access denied: not an image')

  const notAFile = await invoke(route, fakeReq('GET', '/?path=' + encodeURIComponent(dir)))
  assert.equal(notAFile.status(), 403)
  assert.equal(notAFile.text(), 'not a regular file')

  // `path=` empty behaves like a missing parameter.
  const emptyParam = await invoke(route, fakeReq('GET', '/?path='))
  assert.equal(emptyParam.status(), 400)

  // A relative path is resolved against workspaceRoot when provided.
  const workspace = setup({}, { workspaceRoot: root })
  const relative = await invoke(workspace.route('/plugins/agy-link/media'), fakeReq('GET', '/?path=note.txt'))
  assert.equal(relative.status(), 403, 'relative path resolves under the workspace root')
  assert.equal(relative.text(), 'access denied: not an image')
})

test('/assets rejects traversal, missing assets and directories; serves mermaid only when present', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-contract-assets-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const assets = join(root, 'assets')
  mkdirSync(assets, { recursive: true })
  mkdirSync(join(assets, 'nested'), { recursive: true })
  writeFileSync(join(assets, 'app.js'), 'console.log(1)')
  writeFileSync(join(root, 'secret.txt'), 'secret')
  let symlinked = true
  try {
    symlinkSync(join(root, 'secret.txt'), join(assets, 'escape.txt'))
  } catch {
    // Windows without Developer Mode refuses symlink creation (EPERM). The escape
    // case below cannot be exercised there; the remaining assertions still run.
    symlinked = false
  }

  const s = setup({ hostDir: root })
  const assetRoute = s.route('/plugins/agy-link/assets')

  const missing = await invoke(assetRoute, fakeReq('GET', '/plugins/agy-link/assets/none.js'))
  assert.equal(missing.status(), 404)
  assert.equal(missing.text(), 'asset not found')

  const traversal = await invoke(assetRoute, fakeReq('GET', '/plugins/agy-link/assets/%2e%2e%2fsecret.txt'))
  assert.equal(traversal.status(), 404, 'encoded traversal resolves to a literal name and is not served')
  assert.equal(traversal.text(), 'asset not found')

  if (symlinked) {
    const escaped = await invoke(assetRoute, fakeReq('GET', '/plugins/agy-link/assets/escape.txt'))
    assert.equal(escaped.status(), 403, 'symlink escape is forbidden')
    assert.equal(escaped.text(), 'forbidden')
  } else {
    t.diagnostic('symlink creation unavailable on this host: escape assertion skipped')
  }

  const directory = await invoke(assetRoute, fakeReq('GET', '/plugins/agy-link/assets/nested'))
  assert.equal(directory.status(), 403)
  assert.equal(directory.text(), 'not a file')

  const mermaidMissing = await invoke(s.route('/plugins/agy-link/mermaid.min.js'), fakeReq('GET'))
  assert.equal(mermaidMissing.status(), 404)
  assert.equal(mermaidMissing.text(), 'mermaid.min.js not found')

  writeFileSync(join(root, 'mermaid.min.js'), 'console.log("mermaid")')
  const mermaid = await invoke(s.route('/plugins/agy-link/mermaid.min.js'), fakeReq('GET'))
  assert.equal(mermaid.status(), 200)
  assert.equal(mermaid.headers()['content-type'], 'application/javascript; charset=utf-8')
  assert.equal(mermaid.text(), 'console.log("mermaid")')
})

test('/assets 404s when the asset dir cannot be resolved', async () => {
  const s = setup({ hostDir: '/nonexistent-agy-host-dir' })
  const captured = await invoke(s.route('/plugins/agy-link/assets'), fakeReq('GET', '/plugins/agy-link/assets/a.js'))
  assert.equal(captured.status(), 404)
  assert.equal(captured.text(), 'asset not found')
})

test('/mermaid.min.js maps an unreadable file to 500', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-contract-mermaid-err-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // A directory named mermaid.min.js exists but readFileSync throws EISDIR.
  mkdirSync(join(root, 'mermaid.min.js'))
  const s = setup({ hostDir: root })
  const captured = await invoke(s.route('/plugins/agy-link/mermaid.min.js'), fakeReq('GET'))
  assert.equal(captured.status(), 500)
  assert.match(captured.text(), /^read error: /)
})

test('REGRESSION: /pool/refresh-quota answers immediately even when the quota pipeline never settles', async () => {
  // Before the fix the route awaited a 20s `agy /usage` spawn + several REST
  // calls, so the console's "同步中" kept spinning. The status poll (3s) is
  // what actually delivers fresh numbers, so the HTTP response must not wait.
  let started = 0
  const s = setup({
    quota: {
      refreshAccountQuota: async () => {
        started++
        await new Promise<void>(() => undefined) // deliberately never resolves
      },
      refreshAllQuotas: async () => undefined,
    },
    catalog: {
      get: () => ({ source: 'fallback', models: [], lastError: null }),
      getAllKnownModels: () => [],
      forceRefresh: async () => undefined,
    },
    pool: poolDouble({ getAccount: (id: unknown) => (id === 'hanging' ? { id: 'hanging' } : undefined) }).pool,
  })
  const startedAt = Date.now()
  const res = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', { id: 'hanging' }))
  assert.equal(res.status(), 200)
  assert.equal((res.json() as { pending?: boolean }).pending, true)
  assert.equal(started, 1, 'the refresh still runs in the background')
  assert.ok(Date.now() - startedAt < 1000, 'the HTTP response must not wait for the pipeline')

  // A second click on the same account must not stack a duplicate pipeline.
  const again = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', { id: 'hanging' }))
  assert.equal(again.status(), 200)
  assert.equal(started, 1, 'in-flight refresh is deduped')
})

test('REGRESSION: quota dedupe outlives the old 30s race while its work still runs', async () => {
  // The first version raced the work against ROUTE_TIMEOUT_MS and deleted the
  // dedupe entry when the timer won — a second click then started a second
  // `agy /usage` pipeline on top of the first. The entry now belongs to the
  // work itself, with a much longer hard cap.
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    let started = 0
    const s = setup({
      quota: {
        refreshAccountQuota: async () => {
          started++
          await new Promise<void>(() => undefined) // never settles
        },
        refreshAllQuotas: async () => undefined,
      },
      catalog: {
        get: () => ({ source: 'fallback', models: [], lastError: null }),
        getAllKnownModels: () => [],
        forceRefresh: async () => undefined,
      },
      pool: poolDouble({ getAccount: (id: unknown) => (id === 'slow' ? { id: 'slow' } : undefined) }).pool,
    })
    const route = s.route('/plugins/agy-link/pool/refresh-quota')
    await invoke(route, fakeReq('POST', '/', { id: 'slow' }))
    mock.timers.tick(31_000)
    await invoke(route, fakeReq('POST', '/', { id: 'slow' }))
    assert.equal(started, 1, 'no duplicate pipeline after 30s')
    mock.timers.tick(QUOTA_REFRESH_DEDUP_MS + 1)
    await invoke(route, fakeReq('POST', '/', { id: 'slow' }))
    assert.equal(started, 2, 'a genuinely wedged refresh can be retried after the hard cap')
  } finally {
    mock.timers.reset()
  }
})

test('REGRESSION: every route answers 500 when a dependency throws (no silent hang)', async () => {
  const s = setup({
    quota: {
      refreshAccountQuota: async () => { throw new Error('boom') },
      refreshAllQuotas: async () => undefined,
    },
    pool: poolDouble({ getAccount: () => ({ id: 'x' }) }).pool,
  })
  // A background rejection is swallowed by the guarded runner, but the HTTP
  // response is still 200/pending — the important part is that it ENDS.
  const res = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', { id: 'x' }))
  assert.equal(res.status(), 200)
  assert.equal((res.json() as { ok?: boolean }).ok, true)
})

test('/config validates permissionMode enum and registerBridgeMcpConfig is idempotent', async () => {
  const s = setup()
  const route = s.route('/plugins/agy-link/config')
  const badMode = await invoke(route, fakeReq('POST', '/', { key: 'permissionMode', value: 'yolo' }))
  assert.equal(badMode.status(), 400)
  assert.match((badMode.json() as { error?: string }).error ?? '', /permissionMode/)

  const goodMode = await invoke(route, fakeReq('POST', '/', { key: 'permissionMode', value: 'accept-edits' }))
  assert.equal(goodMode.status(), 200)

  const { startMcpBridge, registerBridgeMcpConfig, teardownBridgeState } = await import('../src/host/mcp-bridge.ts')
  const dir = mkdtempSync(join(tmpdir(), 'agy-mcp-idem-'))
  try {
    const bridge = await startMcpBridge({ bridgeScript: 'fake-bridge.mjs', tools: () => undefined, allowlist: () => '' })
    const cfgFile = join(dir, 'mcp_config.json')
    const state = { bridge, restores: [] as Array<() => void> }
    registerBridgeMcpConfig(state, cfgFile)
    registerBridgeMcpConfig(state, cfgFile)
    assert.equal(state.restores.length, 1, 'registerBridgeMcpConfig must not duplicate restores for the same file')
    teardownBridgeState(state)
    assert.equal(state.bridge, null)
    assert.equal(state.restores.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/embed serves confined HTML widgets with strict CSP and bridge script', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-embed-route-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const widget = join(dir, 'chart.html')
  const nonHtml = join(dir, 'note.txt')
  const missingHtml = join(dir, 'nope.html')
  writeFileSync(widget, '<html><head></head><body><h1>Chart</h1></body></html>')
  writeFileSync(nonHtml, 'hello')

  const s = setup({}, { workspaceRoot: dir })
  const route = s.route('/plugins/agy-link/embed')

  const missing = await invoke(route, fakeReq('GET', '/'))
  assert.equal(missing.status(), 400)

  const notFound = await invoke(route, fakeReq('GET', '/?path=' + encodeURIComponent(missingHtml)))
  assert.equal(notFound.status(), 404)

  const txtRes = await invoke(route, fakeReq('GET', '/?path=' + encodeURIComponent(nonHtml)))
  assert.equal(txtRes.status(), 403)

  const okRes = await invoke(route, fakeReq('GET', '/?path=' + encodeURIComponent(widget) + '&id=w1'))
  assert.equal(okRes.status(), 200)
  assert.match(okRes.headers()['Content-Security-Policy'] ?? '', /default-src 'none'/)
  assert.match(okRes.text(), /agy-embed-resize/)
  assert.match(okRes.text(), /"w1"/)
})

test('/config validates auto mode, sandbox, transport, agent, and agySettings', async () => {
  const written: Array<[string, unknown]> = []
  const s = setup({ setOverride: (k: string, v: unknown) => written.push([k, v]) })
  const route = s.route('/plugins/agy-link/config')

  assert.equal((await invoke(route, fakeReq('POST', '/', { key: 'permissionMode', value: 'auto' }))).status(), 200)
  assert.equal((await invoke(route, fakeReq('POST', '/', { key: 'sandbox', value: true }))).status(), 200)
  assert.equal((await invoke(route, fakeReq('POST', '/', { key: 'sandbox', value: 'yes' }))).status(), 400)
  assert.equal((await invoke(route, fakeReq('POST', '/', { key: 'transport', value: 'acp' }))).status(), 200)
  assert.equal((await invoke(route, fakeReq('POST', '/', { key: 'transport', value: 'grpc' }))).status(), 400)
  assert.equal((await invoke(route, fakeReq('POST', '/', { key: 'agent', value: 'reviewer' }))).status(), 200)
  assert.equal((await invoke(route, fakeReq('POST', '/', { key: 'agySettings', value: '{"a":1}' }))).status(), 200)
  assert.equal((await invoke(route, fakeReq('POST', '/', { key: 'agySettings', value: '{bad-json' }))).status(), 400)

  assert.deepEqual(written, [
    ['permissionMode', 'auto'],
    ['sandbox', true],
    ['transport', 'acp'],
    ['agent', 'reviewer'],
    ['agySettings', '{"a":1}'],
  ])
})

test('issue #196: mcpBridge is settable through the config route (boolean only) and reported by status', async () => {
  const writes: Array<[string, unknown]> = []
  const s = setup({ setOverride: (k: string, v: unknown) => { writes.push([k, v]) } })
  const route = s.route('/plugins/agy-link/config')

  // It used to answer 400 "key not settable", which is why the switch was unreachable.
  const ok = await invoke(route, fakeReq('POST', '/', { key: 'mcpBridge', value: true }))
  assert.equal(ok.status(), 200)
  assert.deepEqual(writes, [['mcpBridge', true]])

  const bad = await invoke(route, fakeReq('POST', '/', { key: 'mcpBridge', value: 'yes' }))
  assert.equal(bad.status(), 400)
  assert.deepEqual(bad.json(), { error: 'mcpBridge must be a boolean' })

  const status = await s.call('/plugins/agy-link/status', fakeReq('GET', '/plugins/agy-link/status'))
  assert.equal(status.status(), 200)
  assert.ok('mcpBridge' in (status.json() as Record<string, unknown>), 'status must expose mcpBridge so the panel can render its switch')
})

