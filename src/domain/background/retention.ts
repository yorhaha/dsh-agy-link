// Retention leases: the neutral meeting point between background work and the
// ACP process pool.
//
// An `agy acp` process must survive its turn while background work (a timer, a
// subagent, a long command) can still report. The background watcher knows when
// that work exists; the pool knows which process would be evicted. Instead of
// the watcher calling into the pool, both sides share this registry:
//
//   * the watcher acquires a lease and releases it when the work is done;
//   * the pool reads the view when deciding whether a process is idle, and
//     reacts to releases (a draining process can close as soon as its last
//     lease is gone).
//
// The registry owns no process, clock or credential knowledge, so it stays a
// pure domain object.

/** One session whose ACP process must not be evicted yet. */
export interface RetentionEntry {
  readonly acpSessionId: string
  /** DSH session key; drain notices need it to address the transcript. */
  readonly sessionKey: string
}

/** What an acquirer holds and eventually gives back. */
export interface RetentionLease {
  /** Idempotent: a second release is a no-op. */
  release(): void
}

/** The acquire side the background watcher depends on. */
export interface RetentionSource {
  acquire(acpSessionId: string, sessionKey?: string): RetentionLease
}

/** The read side the process pool depends on. */
export interface RetentionView {
  /** Sessions currently holding at least one lease. */
  entries(): readonly RetentionEntry[]
  has(acpSessionId: string): boolean
}

interface Held {
  entry: RetentionEntry
  count: number
}

export class BackgroundRetention implements RetentionSource, RetentionView {
  private readonly held = new Map<string, Held>()
  private readonly listeners = new Set<() => void>()

  /**
   * Observe the release that drops a session's last lease (a refcount move
   * that keeps the session retained emits nothing). Returns an unsubscribe
   * function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  acquire(acpSessionId: string, sessionKey = ''): RetentionLease {
    if (acpSessionId === '') return { release: () => {} }
    const cur = this.held.get(acpSessionId)
    if (cur) {
      cur.count += 1
      if (sessionKey !== '' && cur.entry.sessionKey === '') {
        cur.entry = { acpSessionId, sessionKey }
      }
    } else {
      this.held.set(acpSessionId, { entry: { acpSessionId, sessionKey }, count: 1 })
    }
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        const live = this.held.get(acpSessionId)
        if (!live) return
        if (live.count <= 1) {
          this.held.delete(acpSessionId)
          this.notify()
        } else {
          live.count -= 1
        }
      },
    }
  }

  entries(): readonly RetentionEntry[] {
    return [...this.held.values()].map((h) => h.entry)
  }

  has(acpSessionId: string): boolean {
    return this.held.has(acpSessionId)
  }

  private notify(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn()
      } catch {
        /* a failing observer must not break the lease */
      }
    }
  }
}
