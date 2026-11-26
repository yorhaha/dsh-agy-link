// Actions on the ONE Antigravity account this plugin drives (the system `agy`
// sign-in): re-sign-in (OAuth begin/complete/cancel), refresh-token import, and
// the per-account settings the console still edits (alias, dedicated proxy,
// cooldown reset) plus a manual quota + catalog refresh.
//
// These used to live on the multi-account `/pool` surface. The paths are now
// `/account/*` and every handler resolves its target from the primary account,
// so a stale `id` in a request body can no longer address another row.
import type { HostServices } from '../../../host/services.ts'
import { QUOTA_REFRESH_DEDUP_MS } from '../../../common/timeouts.ts'
import { normalizeModelFamily } from '../../../common/quota-bench.ts'
import { runRoute, sendJson, readBody, methodOf, type RawRes, type RouteRegistrar } from '../respond.ts'

const BASE = '/plugins/agy-link/account'

/** Longest alias we accept: it is a display label, not free text. */
const MAX_ALIAS_LEN = 64

/**
 * The one in-flight manual refresh. A refresh runs `agy /usage` (20s cap)
 * plus several REST calls; rapid clicks must not stack duplicate pipelines,
 * and the handler answers immediately so the console's 3s /status poll picks
 * the new numbers up on its own.
 */
let quotaRefreshInFlight: Promise<void> | null = null

function bodyString(body: Record<string, unknown>, key: string): string {
  const raw = body[key]
  return typeof raw === 'string' ? raw.trim() : ''
}

/** Begin the OAuth flow for the primary (system HOME) account. */
function handleReloginBegin(services: HostServices, req: unknown, res: unknown): void {
  const { getConfig, poolAuth } = services
  runRoute(res, async () => {
    if (methodOf(req) !== 'POST') {
      sendJson(res as RawRes, 405, { error: 'POST only' })
      return
    }
    const body = await readBody(req)
    const proxyUrl = bodyString(body, 'proxyUrl') || getConfig().proxyUrl.trim() || undefined
    const alias = bodyString(body, 'alias') || undefined
    const st = await poolAuth.beginPrimary(proxyUrl, alias)
    sendJson(res as RawRes, st.ok ? 200 : 500, st)
  })
}

/** Finish the primary sign-in with the pasted authorization code. */
function handleReloginComplete(services: HostServices, req: unknown, res: unknown): void {
  const { pool, poolAuth } = services
  runRoute(res, async () => {
    if (methodOf(req) !== 'POST') {
      sendJson(res as RawRes, 405, { error: 'POST only' })
      return
    }
    const body = await readBody(req)
    const code = bodyString(body, 'code')
    if (!code) {
      sendJson(res as RawRes, 400, { ok: false, phase: 'waiting', code: 'missing_code' })
      return
    }
    const st = await poolAuth.submitCode(code)
    sendJson(res as RawRes, st.ok ? 200 : 400, {
      ok: st.ok,
      phase: st.phase,
      code: st.code,
      pool: pool.getPoolData(),
    })
  })
}

/** Abandon an in-progress primary sign-in. */
function handleReloginCancel(services: HostServices, req: unknown, res: unknown): void {
  const { pool, poolAuth } = services
  runRoute(res, async () => {
    if (methodOf(req) !== 'POST') {
      sendJson(res as RawRes, 405, { error: 'POST only' })
      return
    }
    await readBody(req)
    await poolAuth.cancel()
    sendJson(res as RawRes, 200, { ok: true, pool: pool.getPoolData() })
  })
}

/** Replace the primary credential from a pasted refresh token / token JSON. */
function handleImportToken(services: HostServices, req: unknown, res: unknown): void {
  const { pool, poolAuth, notifyPicker } = services
  runRoute(res, async () => {
    if (methodOf(req) !== 'POST') {
      sendJson(res as RawRes, 405, { error: 'POST only' })
      return
    }
    const body = await readBody(req)
    const token = bodyString(body, 'token')
    if (!token) {
      sendJson(res as RawRes, 400, { ok: false, error: 'Token is required' })
      return
    }
    const alias = bodyString(body, 'alias') || undefined
    const proxyUrl = bodyString(body, 'proxyUrl') || undefined
    const result = await poolAuth.importRefreshToken(token, alias, proxyUrl)
    if (!result.ok) {
      sendJson(res as RawRes, 400, { ok: false, error: result.error ?? 'Import failed', code: result.code })
      return
    }
    notifyPicker()
    sendJson(res as RawRes, 200, {
      ok: true,
      account: result.account,
      email: result.email,
      pool: pool.getPoolData(),
    })
  })
}

/** Rename the account's card label. */
function handleAlias(services: HostServices, req: unknown, res: unknown): void {
  const { pool } = services
  runRoute(res, async () => {
    if (methodOf(req) !== 'POST') {
      sendJson(res as RawRes, 405, { error: 'POST only' })
      return
    }
    const body = await readBody(req)
    const alias = bodyString(body, 'alias')
    // An empty alias would leave the card with no label at all: the UI's
    // "reset to default" path sends the old value back instead.
    if (alias === '') {
      sendJson(res as RawRes, 400, { ok: false, error: 'alias must not be empty' })
      return
    }
    if (alias.length > MAX_ALIAS_LEN) {
      sendJson(res as RawRes, 400, { ok: false, error: 'alias is too long (max ' + MAX_ALIAS_LEN + ')' })
      return
    }
    pool.setAccountAlias(pool.getPrimaryAccount().id, alias)
    sendJson(res as RawRes, 200, { ok: true, pool: pool.getPoolData() })
  })
}

/** Set (or, with an empty value, clear) the account's dedicated proxy. */
function handleProxy(services: HostServices, req: unknown, res: unknown): void {
  const { pool } = services
  runRoute(res, async () => {
    if (methodOf(req) !== 'POST') {
      sendJson(res as RawRes, 405, { error: 'POST only' })
      return
    }
    const body = await readBody(req)
    const proxyUrl = bodyString(body, 'proxyUrl')
    pool.setAccountProxy(pool.getPrimaryAccount().id, proxyUrl || undefined)
    sendJson(res as RawRes, 200, { ok: true, pool: pool.getPoolData() })
  })
}

/** Drop a cooldown (optionally one model family) and its low-quota bench. */
function handleClearCooldown(services: HostServices, req: unknown, res: unknown): void {
  const { pool, notifyPicker } = services
  runRoute(res, async () => {
    if (methodOf(req) !== 'POST') {
      sendJson(res as RawRes, 405, { error: 'POST only' })
      return
    }
    const body = await readBody(req)
    const rawFamily = bodyString(body, 'family')
    const family = rawFamily === '' ? undefined : normalizeModelFamily(rawFamily) ?? undefined
    if (rawFamily !== '' && family === undefined) {
      sendJson(res as RawRes, 400, { ok: false, error: 'invalid family', pool: pool.getPoolData() })
      return
    }
    pool.clearCooldown(pool.getPrimaryAccount().id, family, true)
    notifyPicker()
    sendJson(res as RawRes, 200, { ok: true, pool: pool.getPoolData() })
  })
}

/** Refresh the primary account's quota and model catalog on demand. */
function handleRefreshQuota(services: HostServices, req: unknown, res: unknown): void {
  const { pool, quota, catalog } = services
  runRoute(res, async () => {
    if (methodOf(req) !== 'POST') {
      sendJson(res as RawRes, 405, { error: 'POST only' })
      return
    }
    await readBody(req)
    const account = pool.getPrimaryAccount()
    const alreadyRunning = quotaRefreshInFlight !== null
    if (!alreadyRunning) {
      const work = (async () => {
        await quota.refreshAccountQuota(account, true)
        // A manual refresh also re-reads the catalog: after an external
        // re-login the subscription tier (and thus the model list) may differ.
        await catalog.forceRefresh(account.id).catch(() => undefined)
      })().catch(() => undefined)
      let releaseTimer: ReturnType<typeof setTimeout> | undefined
      const entry: Promise<void> = work.finally(() => {
        if (releaseTimer !== undefined) clearTimeout(releaseTimer)
        if (quotaRefreshInFlight === entry) quotaRefreshInFlight = null
      })
      quotaRefreshInFlight = entry
      // A generous hard cap keeps a genuinely wedged dependency from blocking
      // future syncs forever without opening an overlap window.
      releaseTimer = setTimeout(() => {
        if (quotaRefreshInFlight === entry) quotaRefreshInFlight = null
      }, QUOTA_REFRESH_DEDUP_MS)
      releaseTimer.unref?.()
    }
    sendJson(res as RawRes, 200, {
      ok: true,
      pending: true,
      alreadyRunning,
      pool: pool.getPoolData(),
    })
  })
}

export function register(reg: RouteRegistrar, services: HostServices): void {
  reg({ kind: 'exact', path: `${BASE}/begin-add`, handler: (req, res) => handleReloginBegin(services, req, res) })
  reg({ kind: 'exact', path: `${BASE}/complete-add`, handler: (req, res) => handleReloginComplete(services, req, res) })
  reg({ kind: 'exact', path: `${BASE}/cancel-add`, handler: (req, res) => handleReloginCancel(services, req, res) })
  reg({ kind: 'exact', path: `${BASE}/import`, handler: (req, res) => handleImportToken(services, req, res) })
  reg({ kind: 'exact', path: `${BASE}/alias`, handler: (req, res) => handleAlias(services, req, res) })
  reg({ kind: 'exact', path: `${BASE}/proxy`, handler: (req, res) => handleProxy(services, req, res) })
  reg({ kind: 'exact', path: `${BASE}/clear-cooldown`, handler: (req, res) => handleClearCooldown(services, req, res) })
  reg({ kind: 'exact', path: `${BASE}/refresh-quota`, handler: (req, res) => handleRefreshQuota(services, req, res) })
}
