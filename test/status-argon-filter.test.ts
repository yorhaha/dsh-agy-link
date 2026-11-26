import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { createHostServices } from '../src/host/services.ts'
import { register as registerStatus } from '../src/transport/http/routes/status.ts'

function createSandbox(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'agy-status-sandbox-'))
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(process.env)) saved[k] = process.env[k]
  process.env.HOME = root
  process.env.USERPROFILE = root
  process.env.DSH_HOME = root
  process.env.DSH_STATE_DIR = root
  process.env.DSH_AGY_ACCOUNTS_DIR = root
  t.after(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k]
    }
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v
    }
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

function mockRes() {
  let statusCode = 0
  let bodyStr = ''
  return {
    writeHead(code: number) { statusCode = code },
    end(data?: string) { if (data) bodyStr += data },
    get status() { return statusCode },
    json() { return JSON.parse(bodyStr) },
  }
}

test('issue #131: status offers quota-derived models and echoes the selectedModels whitelist', async (t) => {
  createSandbox(t)
  const fakeCtx = {
    logger: { info: () => {} },
    emit: () => {},
  } as unknown as Context

  // No agy binary in the sandbox: the CLI catalog is the fallback rows, so any
  // model reachable only through the quota snapshot proves the merge happened.
  const services = createHostServices(fakeCtx, { enabled: true })
  const routes = new Map<string, (req: any, res: any) => void>()
  registerStatus((route: { path: string; handler: (req: any, res: any) => void }) => routes.set(route.path, route.handler), services)

  const pool = services.pool
  const acc = pool.getPrimaryAccount()
  pool.updateAccountQuotas(acc.id, {
    google: {
      remainingFraction: 1,
      models: [
        { modelId: 'gemini-4-neon-low', displayName: 'Gemini 4 Neon (Low)' },
        { modelId: 'gemini-4-neon-high', displayName: 'Gemini 4 Neon (High)' },
        { modelId: 'gemini-9-quota-only', displayName: 'Gemini 9 Quota Only' },
      ],
    },
  })

  services.setOverride('selectedModels', ['gemini-3.8-flash'])

  const res = mockRes()
  routes.get('/plugins/agy-link/status')!({ method: 'GET' }, res)
  await new Promise((r) => setTimeout(r, 20))

  const body = res.json()
  const ids = (body.catalogModels as Array<{ id: string }>).map((m) => m.id)
  assert.ok(ids.includes('gemini-9-quota-only'), 'a quota-only model must be selectable in the panel')
  assert.ok(ids.includes('gemini-4-neon'), 'effort variants fold into one selectable row')
  assert.deepEqual(body.selectedModels, ['gemini-3.8-flash'], 'the panel needs the current whitelist')
  // The panel list is the full selectable set on purpose: a deselected model
  // must stay clickable or the user could never re-enable it.
  assert.ok(ids.includes('gemini-3.8-flash'), 'the whitelisted model is present')
  assert.equal(ids.length >= 3, true)
})
