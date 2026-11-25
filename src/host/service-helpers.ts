// Cohesive runtime helpers extracted from createHostServices (services.ts):
// cross-session Semaphore, DSH session/goal/model-selection bridges, attachment
// fallback reader.
import type { Context } from '@deepseek-ai/cordis'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Err, PROVIDER_ID, type PluginConfig } from '../common/types.ts'
import type { MediaRefLike } from './media.ts'
import type { AccountPoolManager } from './pool.ts'
import type { CommandDeps } from './commands/shared.ts'

/** Cross-session concurrency limiter (ADR-12). max() <= 0 means unlimited. */
export class Semaphore {
  private active = 0
  private queue: Array<() => void> = []
  constructor(private readonly max: () => number) {}
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error('aborted before semaphore acquisition')
    const limit = this.max()
    if (limit <= 0 || this.active < limit) {
      this.active++
      return () => this.releaseOne()
    }
    return new Promise((resolve, reject) => {
      let entry: () => void
      const onAbort = () => {
        const idx = this.queue.indexOf(entry)
        if (idx >= 0) this.queue.splice(idx, 1)
        reject(new Error('aborted while waiting for semaphore slot'))
      }
      entry = () => {
        signal?.removeEventListener('abort', onAbort)
        this.active++
        resolve(() => this.releaseOne())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(entry)
    })
  }
  private releaseOne(): void {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }
}

export function findSessionLogFile(dshHomeDir: string, sessionId: string): string | undefined {
  if (sessionId === '') return undefined
  try {
    const root = join(dshHomeDir, 'sessions')
    for (const bucket of readdirSync(root)) {
      const dir = join(root, bucket, 'session-' + sessionId)
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir)) {
        if (name.startsWith('session.') && name.endsWith('.jsonl.zstd')) return join(dir, name)
      }
    }
  } catch {
    // No sessions directory (or no permission)
  }
  return undefined
}

export function resolveSessionGoal(
  ctx: Context,
  sessionId: string,
): { goalId: string; revision: number } | null | undefined {
  try {
    const agents = (ctx.get('agents') as { get(id: unknown): unknown } | undefined)
      ?? (ctx as unknown as { agents?: { get(id: unknown): unknown } }).agents
    const goals = (ctx.get('goals') as { get(agent: unknown): { id?: string; revision?: number; phase?: string; activation?: string } | undefined } | undefined)
      ?? (ctx as unknown as { goals?: { get(agent: unknown): { id?: string; revision?: number; phase?: string; activation?: string } | undefined } }).goals
    const agent = agents?.get(sessionId)
    if (agent && goals) {
      const g = goals.get(agent)
      if (g?.id && g.phase === 'active' && (g.activation === undefined || g.activation === 'armed')) {
        return { goalId: g.id, revision: typeof g.revision === 'number' ? g.revision : 1 }
      }
      return null
    }
  } catch {
    // Fall back to inspecting the session log below.
  }

  type SessionWithEvents = {
    log?: readonly { type: string; data?: unknown }[]
    snapshotEvents?(): readonly { type: string; data?: unknown }[]
    ownEvents?(): readonly { type: string; data?: unknown }[]
    events?: readonly { type: string; data?: unknown }[]
  }
  const sessions = (ctx.get('sessions') as { get(id: unknown): SessionWithEvents | undefined } | undefined)
    ?? (ctx as unknown as { sessions?: { get(id: unknown): SessionWithEvents | undefined } }).sessions
  const session = sessions?.get(sessionId)
  if (!session) return undefined
  const evs = session.snapshotEvents?.() ?? session.ownEvents?.() ?? session.log ?? session.events
  if (!evs) return undefined
  for (let i = evs.length - 1; i >= 0; i--) {
    const ev = evs[i]
    if (ev?.type !== 'goal/change' || !ev.data || typeof ev.data !== 'object') continue
    const d = ev.data as { operation?: string; goal?: { id?: string; revision?: number; phase?: string } }
    if (d.operation === 'clear') return null
    if (d.goal?.id && d.goal.phase === 'active') {
      return { goalId: d.goal.id, revision: typeof d.goal.revision === 'number' ? d.goal.revision : 1 }
    }
    return null
  }
  return null
}

/**
 * Resolve the authoritative live DSH plan-mode flag (`pending ?? active`) for a session.
 * Returns `undefined` when `ctx.planMode` or the live agent is unavailable so callers
 * can fall back to `options.system` and current-turn message signals.
 */
export function resolveSessionPlanMode(ctx: Context, sessionId: string): boolean | undefined {
  if (sessionId === '') return undefined
  try {
    const agents = (ctx.get('agents') as { get(id: unknown): unknown } | undefined)
      ?? (ctx as unknown as { agents?: { get(id: unknown): unknown } }).agents
    const planMode = (ctx.get('planMode') as { get(agent: unknown): { active?: boolean; pending?: boolean } | undefined } | undefined)
      ?? (ctx as unknown as { planMode?: { get(agent: unknown): { active?: boolean; pending?: boolean } | undefined } }).planMode
    const agent = agents?.get(sessionId)
    if (!agent || !planMode || typeof planMode.get !== 'function') return undefined
    const state = planMode.get(agent)
    if (!state || typeof state !== 'object') return undefined
    if (typeof state.pending === 'boolean') return state.pending
    return typeof state.active === 'boolean' ? state.active : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the session's latest selected Antigravity model from `model/selection`
 * session events so background compaction honors user model switches when DSH
 * passes stale `lastUsed` metadata.
 *
 * Split out of `resolveSessionPendingModel` so a caller that already holds the
 * session object (the HTTP session-view route) can read the SAME event stream
 * without reaching for `ctx`.
 */
export function latestAgyModelOf(session: unknown): string | undefined {
  try {
    type SessionWithEvents = {
      log?: readonly { type: string; data?: unknown }[]
      snapshotEvents?(): readonly { type: string; data?: unknown }[]
      ownEvents?(): readonly { type: string; data?: unknown }[]
      events?: readonly { type: string; data?: unknown }[]
    }
    if (!session) return undefined
    const s = session as SessionWithEvents
    const evs = s.snapshotEvents?.() ?? s.ownEvents?.() ?? s.log ?? s.events
    if (!evs) return undefined
    for (let i = evs.length - 1; i >= 0; i--) {
      const ev = evs[i]
      if (ev?.type !== 'model/selection' || !ev.data || typeof ev.data !== 'object') continue
      const d = ev.data as { provider?: unknown; model?: unknown }
      if (d.provider !== PROVIDER_ID) return undefined
      return typeof d.model === 'string' && d.model.trim() !== '' ? d.model.trim() : undefined
    }
    return undefined
  } catch {
    return undefined
  }
}

export function resolveSessionPendingModel(ctx: Context, sessionId: string): string | undefined {
  if (sessionId === '') return undefined
  try {
    type SessionWithEvents = {
      log?: readonly { type: string; data?: unknown }[]
      snapshotEvents?(): readonly { type: string; data?: unknown }[]
      ownEvents?(): readonly { type: string; data?: unknown }[]
      events?: readonly { type: string; data?: unknown }[]
    }
    const sessions = (ctx.get('sessions') as { get(id: unknown): SessionWithEvents | undefined } | undefined)
      ?? (ctx as unknown as { sessions?: { get(id: unknown): SessionWithEvents | undefined } }).sessions
    return latestAgyModelOf(sessions?.get(sessionId))
  } catch {
    return undefined
  }
}

export function syncSessionModelSelection(
  ctx: Context,
  sessionId: string,
  model: string,
  effort?: string,
): void {
  if (!sessionId) return
  const selection = {
    provider: PROVIDER_ID,
    model,
    ...(effort ? { reasoningEffort: effort } : {}),
  }
  try {
    const sessions = (ctx.get('sessions') as { get(id: unknown): { append?: (type: string, data: unknown) => unknown } } | undefined)
      ?? (ctx as unknown as { sessions?: { get(id: unknown): { append?: (type: string, data: unknown) => unknown } } }).sessions
    const session = sessions?.get(sessionId)
    if (session && typeof session.append === 'function') {
      session.append('model/selection', selection)
    }
  } catch {
    // safe containment
  }

  try {
    type AgentHandle = { model?: { select?: (sel: unknown) => unknown } }
    type AgentsSvc = {
      get?: (id: unknown) => AgentHandle | undefined
      resolve?: (id: unknown) => Promise<AgentHandle | undefined> | AgentHandle | undefined
      selectForNextRequest?: (a: unknown, s: unknown) => void
    }
    const agents = (ctx.get('agents') as AgentsSvc | undefined)
      ?? (ctx as unknown as { agents?: AgentsSvc }).agents
    if (!agents) return
    const applyAgentSelection = (agent: AgentHandle | undefined): void => {
      if (!agent) return
      if (typeof agent.model?.select === 'function') {
        agent.model.select(selection)
        return
      }
      if (typeof agents.selectForNextRequest === 'function') {
        agents.selectForNextRequest(agent, selection)
      }
    }
    if (typeof agents.resolve === 'function') {
      void Promise.resolve(agents.resolve(sessionId)).then(applyAgentSelection).catch(() => undefined)
    } else if (typeof agents.get === 'function') {
      applyAgentSelection(agents.get(sessionId))
    }
  } catch {
    // safe containment
  }
}

export async function readSessionImage(ctx: Context, dshHomeDir: string, ref: MediaRefLike): Promise<Uint8Array | null> {
  type AttachmentsSvc = {
    readImage?: (r: MediaRefLike) => Promise<{ data?: Uint8Array } | null>
    readAttachment?: (r: MediaRefLike) => Promise<{ data?: Uint8Array } | Uint8Array | null>
    read?: (idOrRef: unknown) => Promise<{ data?: Uint8Array } | Uint8Array | null>
  }
  const svc = (ctx.get('attachments') as AttachmentsSvc | undefined)
    ?? (ctx as unknown as { attachments?: AttachmentsSvc }).attachments
  if (svc) {
    for (const fn of [svc.readImage, svc.readAttachment, svc.read]) {
      if (typeof fn !== 'function') continue
      try {
        const stored = await fn.call(svc, ref)
        if (stored instanceof Uint8Array) return stored
        if (stored && typeof stored === 'object' && stored.data) return stored.data
      } catch {
        // try next reader / disk fallback
      }
    }
  }
  try {
    const id = ref.attachmentId
    if (id && typeof id === 'string') {
      const diskPath = join(dshHomeDir, 'attachments', 'v1', 'objects', id.slice(0, 2), id)
      if (existsSync(diskPath)) return readFileSync(diskPath)
    }
    if (typeof ref.path === 'string' && ref.path !== '' && existsSync(ref.path)) {
      return readFileSync(ref.path)
    }
  } catch {
    return null
  }
  return null
}

const FORCED_PLAN_TTL_MS = 5 * 60_000

/** Tracks one-shot `/aplan` read-only permissions per session without leaking into later turns. */
export function createForcedPlanGuard(now: () => number = Date.now): {
  arm: (sessionId: string) => void
  consume: (sessionId: string) => boolean
} {
  const armed = new Map<string, number>()
  return {
    arm: (sessionId: string): void => {
      if (sessionId !== '') armed.set(sessionId, now())
    },
    consume: (sessionId: string): boolean => {
      const ts = armed.get(sessionId)
      if (ts === undefined) return false
      armed.delete(sessionId)
      return now() - ts <= FORCED_PLAN_TTL_MS
    },
  }
}
