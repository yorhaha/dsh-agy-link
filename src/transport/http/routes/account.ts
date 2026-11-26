// Single-account actions kept from the removed account-pool HTTP surface:
// re-sign-in for the primary account (OAuth begin/complete/cancel) and a
// manual quota + catalog refresh, so the console's "sign in again" and
// "refresh quota" buttons keep working. Pool administration routes are gone.
import type { HostServices } from '../../../host/services.ts'
import { QUOTA_REFRESH_DEDUP_MS } from '../../../common/timeouts.ts'
import { runRoute, sendJson, readBody, methodOf, type RawRes, type RouteRegistrar } from '../respond.ts'

/**
 * The one in-flight manual refresh. A refresh runs `agy /usage` (20s cap)
 * plus several REST calls; rapid clicks must not stack duplicate pipelines,
 * and the handler answers immediately so the console's 3s /status poll picks
 * the new numbers up on its own.
 */
let quotaRefreshInFlight: Promise<void> | null = null

/** Begin the OAuth flow for the primary (system HOME) account. */
function handleReloginBegin(services: HostServices, req: unknown, res: unknown): void {
  const { getConfig, poolAuth } = services
  runRoute(res, async () => {
    if (methodOf(req) !== 'POST') {
      sendJson(res as RawRes, 405, { error: 'POST only' })
      return
    }
    const body = await readBody(req)
    const bodyProxy = typeof body.proxyUrl === 'string' ? body.proxyUrl.trim() : ''
    const proxyUrl = bodyProxy || getConfig().proxyUrl.trim() || undefined
    const st = await poolAuth.beginPrimary(proxyUrl)
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
    const code = typeof body.code === 'string' ? body.code : ''
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
  // Paths are unchanged from the removed pool routes so the existing console
  // keeps working while the single-account UI is rewritten.
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/begin-add', handler: (req, res) => handleReloginBegin(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/complete-add', handler: (req, res) => handleReloginComplete(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/cancel-add', handler: (req, res) => handleReloginCancel(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/pool/refresh-quota', handler: (req, res) => handleRefreshQuota(services, req, res) })
}
