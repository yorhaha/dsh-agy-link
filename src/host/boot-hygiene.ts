// Boot-time hygiene for the single primary account and session store.
import { resolveAccountPlanTier } from '../common/plan-tier.ts'
import { repairMacSystemKeychain } from './runner.ts'
import type { HostServices } from './services.ts'

export function runBootHygiene(services: HostServices): void {
  const { pool, store, log } = services
  try {
    const validAccIds = new Set(pool.getAccounts().map((a) => a.id))
    store.cleanupStaleAccounts(validAccIds)
    const pruned = store.pruneStaleBindings()
    if (pruned > 0) log('pruned ' + pruned + ' expired session binding(s)')
  } catch {
    // best-effort hygiene
  }
  try {
    let healed = 0
    for (const acc of pool.getAccounts()) {
      const resolved = resolveAccountPlanTier(acc)
      if (resolved !== undefined && resolved !== acc.planTier) {
        pool.setAccountPlanTier(acc.id, resolved)
        healed++
      }
    }
    if (healed > 0) log('corrected ' + healed + ' stale plan-tier badge(s)')
  } catch {
    // best-effort
  }
  if (process.platform === 'darwin') {
    try {
      const repaired = repairMacSystemKeychain()
      if (repaired) log('repaired macOS system keychain settings (restored real login keychain)')
    } catch {
      // ignore
    }
  }
}
