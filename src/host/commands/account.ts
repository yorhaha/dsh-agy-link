// /agy refresh-quota and /agy clear-cooldown — operational commands for the
// single primary account (quota refresh and cooldown reset).
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { normalizeModelFamily } from '../../common/quota-bench.ts'
import type { ModelFamily } from '../../common/pool-types.ts'
import { err, ok, type CommandContext, type CommandDeps } from './shared.ts'

export async function handleAccountOps(deps: CommandDeps, ctx: CommandContext): Promise<CommandResult> {
  const { sub, parts } = ctx
  const pool = deps.pool?.()

  if (sub === 'refresh-quota') {
    const quota = deps.quota?.()
    if (!quota) return err('Quota service not available')
    await quota.refreshAllQuotas(true)
    await deps.catalog().forceRefresh().catch(() => undefined)
    deps.notifyPicker?.()
    return ok('Refreshed quota statistics and model catalog.')
  }

  if (sub === 'clear-cooldown') {
    if (!pool) return err('Account state not available')
    const tail = parts.slice(1)
    let targetFamily: ModelFamily | undefined
    if (tail.length > 0) {
      const full = tail.join(' ').trim()
      targetFamily = normalizeModelFamily(full) ?? undefined
      if (targetFamily === undefined) {
        return err(`Unknown model family "${full}". Expected: google, anthropic, openai, argon.`)
      }
    }
    pool.clearCooldown(undefined, targetFamily, true)
    deps.notifyPicker?.()
    return ok(targetFamily
      ? `Cleared cooldown and low-quota bench for family **${targetFamily}**.`
      : 'Cleared all cooldowns and low-quota benches.')
  }

  return err(`Unknown account command \`${sub}\`.`)
}
