// Durable persistence for the single primary account: load (with JSON
// validation, legacy pool convergence, and last-good recovery) and persist
// (atomic write plus cross-process 3-way merge of quota/cooldown updates).
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  defaultPoolData,
  isTerminalAuthError,
  type AccountPoolData,
  type ManagedAccount,
  type ModelFamily,
} from '../../common/pool-types.ts'
import { writeJsonAtomic } from './paths.ts'

export interface PoolStoreLoadResult {
  data: AccountPoolData
  /** True when load() had to fall back to pool.json.last-good. */
  recoveredFromLastGood: boolean
}

function normalizePrimaryRecord(acc: ManagedAccount): ManagedAccount {
  if (acc.cooldowns === undefined || acc.cooldowns === null) acc.cooldowns = {}
  if (acc.quotas === undefined || acc.quotas === null) acc.quotas = {}
  acc.enabled = true
  acc.systemHome = true
  acc.dir = ''
  if (
    acc.quotaGateClearedAt !== undefined
    && (typeof acc.quotaGateClearedAt !== 'object' || acc.quotaGateClearedAt === null)
  ) {
    acc.quotaGateClearedAt = undefined
  }
  for (const [fam, cd] of Object.entries(acc.cooldowns)) {
    if (cd && cd.reason === 'agy run aborted by caller') {
      delete acc.cooldowns[fam as ModelFamily]
    }
  }
  return acc
}

export class PoolStore {
  private readonly baseDir: string
  private readonly file: string
  /** Serialized snapshot of the last successful persist/load; skips no-op writes. */
  private persistedJson = ''

  constructor(baseDir: string) {
    this.baseDir = baseDir
    this.file = join(baseDir, 'pool.json')
  }

  /**
   * Remember the current snapshot as the last cleanly-persisted one. Called
   * once after construction so the first steady-state persist is a no-op.
   */
  snapshot(data: AccountPoolData): void {
    this.persistedJson = JSON.stringify(data)
  }

  load(): PoolStoreLoadResult {
    const primary = this.readPoolFile(this.file)
    if (primary) return { data: primary, recoveredFromLastGood: false }
    try {
      if (existsSync(this.file)) copyFileSync(this.file, this.file + '.corrupt-' + Date.now())
    } catch {
      // best effort
    }
    const lastGood = this.readPoolFile(this.file + '.last-good')
    if (lastGood) return { data: lastGood, recoveredFromLastGood: true }
    return { data: defaultPoolData(), recoveredFromLastGood: false }
  }

  private readPoolFile(file: string): AccountPoolData | null {
    try {
      if (existsSync(file)) {
        const raw = readFileSync(file, 'utf8')
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if (parsed && Array.isArray(parsed.accounts)) {
          const rawAccounts = parsed.accounts.filter(
            (acc): acc is ManagedAccount => Boolean(acc && typeof acc === 'object' && (acc as { type?: string }).type !== 'gemini-web'),
          )
          // Converge legacy multi-account pools to the single primary account only.
          const primaryAcc =
            rawAccounts.find((a) => a.id === 'acc_primary')
            ?? rawAccounts.find((a) => a.systemHome === true)
          const accounts = primaryAcc ? [normalizePrimaryRecord(primaryAcc)] : []
          const base = defaultPoolData()
          return {
            version: 1,
            defaultCooldownMs: typeof parsed.defaultCooldownMs === 'number' ? parsed.defaultCooldownMs : base.defaultCooldownMs,
            maxCooldownMs: typeof parsed.maxCooldownMs === 'number' ? parsed.maxCooldownMs : base.maxCooldownMs,
            ...(primaryAcc ? { primaryAccountId: primaryAcc.id } : {}),
            ...(typeof parsed.systemProxy === 'string' && parsed.systemProxy !== '' ? { systemProxy: parsed.systemProxy } : {}),
            accounts,
          }
        }
      }
    } catch {
      // Unparsable: the caller decides whether a last-good snapshot exists.
    }
    return null
  }

  /**
   * Write `data` to pool.json, merging newer quota/cooldown updates for the
   * primary account if another process wrote concurrently.
   */
  persist(data: AccountPoolData): AccountPoolData {
    const serialized = JSON.stringify(data)
    let merged: AccountPoolData = data
    try {
      if (existsSync(this.file)) {
        const onDisk = JSON.parse(readFileSync(this.file, 'utf8')) as AccountPoolData
        const base = this.persistedJson
          ? (JSON.parse(this.persistedJson) as AccountPoolData)
          : null
        const baseAcc = base?.accounts?.[0]
        if (onDisk && Array.isArray(onDisk.accounts)) {
          const now = Date.now()
          const nextAccounts = data.accounts.map((ourAcc) => {
            const diskAcc = onDisk.accounts.find((a) => a && typeof a === 'object' && a.id === ourAcc.id)
            if (!diskAcc) return ourAcc
            let nextQuot = ourAcc.quotas
            let accountMerged = false
            for (const [fam, dq] of Object.entries(diskAcc.quotas ?? {}) as [ModelFamily, ManagedAccount['quotas'][ModelFamily]][]) {
              if (!dq) continue
              const oq = ourAcc.quotas?.[fam]
              const bq = baseAcc?.quotas?.[fam]
              if ((dq.updatedAt ?? 0) > (oq?.updatedAt ?? 0) && (dq.updatedAt ?? 0) > (bq?.updatedAt ?? 0)) {
                nextQuot = { ...nextQuot, [fam]: dq }
                accountMerged = true
              }
            }
            let nextCd = ourAcc.cooldowns
            for (const [fam, dcd] of Object.entries(diskAcc.cooldowns ?? {}) as [ModelFamily, ManagedAccount['cooldowns'][ModelFamily]][]) {
              if (!dcd || dcd.cooldownUntil <= now) continue
              const ocd = ourAcc.cooldowns?.[fam]
              const bcd = baseAcc?.cooldowns?.[fam]
              if (dcd.cooldownUntil > (ocd?.cooldownUntil ?? 0) && dcd.cooldownUntil !== (bcd?.cooldownUntil ?? 0)) {
                nextCd = { ...nextCd, [fam]: dcd }
                accountMerged = true
              }
            }
            const diskTos = Boolean(diskAcc.authRequired && isTerminalAuthError(diskAcc.authError))
            const baseTos = Boolean(baseAcc?.authRequired && isTerminalAuthError(baseAcc.authError))
            const adoptTos = diskTos && !baseTos && !ourAcc.authRequired
            if (!accountMerged && !adoptTos) return ourAcc
            ourAcc.quotas = nextQuot
            ourAcc.cooldowns = nextCd
            if (adoptTos) {
              ourAcc.authRequired = true
              ourAcc.authError = diskAcc.authError
              ourAcc.authMarkedAt = diskAcc.authMarkedAt
            }
            return ourAcc
          })
          merged = { ...data, accounts: nextAccounts }
        }
      }
    } catch {
      // unreadable/partial file: this process's view wins
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      if (serialized === this.persistedJson && merged === data) return merged
      const body = JSON.stringify(merged, null, 2)
      writeJsonAtomic(this.file, body)
      this.persistedJson = JSON.stringify(merged)
      try {
        writeJsonAtomic(this.file + '.last-good', body)
      } catch {
        // recovery copy is optional
      }
      return merged
    } catch (e) {
      try {
        console.error('[dsh-agy-link] pool persist failed: ' + String(e))
      } catch {
        // ignore
      }
      return data
    }
  }

  /**
   * Bootstraps the single primary account on first start (system HOME sign-in).
   */
  bootstrapDefaultAccount(data: AccountPoolData, getSysProxy?: () => string | undefined): AccountPoolData {
    const existing = data.accounts.find((a) => a.systemHome || a.id === 'acc_primary')
    if (existing) {
      const normalized = normalizePrimaryRecord(existing)
      if (data.accounts.length !== 1 || data.primaryAccountId !== normalized.id) {
        data.accounts = [normalized]
        data.primaryAccountId = normalized.id
        return this.persist(data)
      }
      return data
    }

    const sysProxy = getSysProxy?.()
    const primary: ManagedAccount = {
      id: 'acc_primary',
      alias: 'Primary account (system sign-in)',
      defaultAlias: true,
      dir: '',
      systemHome: true,
      ...(sysProxy ? { proxyUrl: sysProxy } : {}),
      enabled: true,
      createdAt: Date.now(),
      cooldowns: {},
      quotas: {},
    }

    data.accounts = [primary]
    data.primaryAccountId = primary.id
    return this.persist(data)
  }

  /**
   * Migrates legacy primary records to system HOME and heals primary email on Windows.
   */
  normalizeLegacyPrimary(data: AccountPoolData): AccountPoolData {
    const primary = data.accounts.find((a) => a.id === 'acc_primary' || a.systemHome)
    if (!primary) return data
    let changed = false
    if (!primary.systemHome || primary.dir) {
      primary.dir = ''
      primary.systemHome = true
      primary.alias = 'Primary account (system sign-in)'
      primary.defaultAlias = true
      data.primaryAccountId = primary.id
      changed = true
    }
    if (process.platform === 'win32') {
      try {
        const credFile = join(this.baseDir, '.primary-credential.json')
        if (existsSync(credFile)) {
          const parsed = JSON.parse(readFileSync(credFile, 'utf8')) as { email?: string }
          if (parsed && typeof parsed.email === 'string' && parsed.email && primary.email !== parsed.email) {
            primary.email = parsed.email
            changed = true
          }
        }
      } catch {
        // best-effort
      }
    }
    if (changed) return this.persist(data)
    return data
  }
}
