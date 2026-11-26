/**
 * Plain timer sleep: resolves after `ms`, and `ms <= 0` still yields one
 * macrotask exactly like the raw `new Promise(setTimeout)` calls this replaces.
 *
 * Abort-aware waits intentionally do NOT live here: their callers must choose
 * the rejection type (attempt failure vs. process abort) and the exact message,
 * and the old copies disagreed on abort behaviour. `abortableDelay` in
 * src/provider/attempt.ts remains the one signal-aware sleep.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
