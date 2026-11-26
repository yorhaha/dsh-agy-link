#!/usr/bin/env node
// Service-level coupling ratchet. The import graph is already checked by
// scripts/check-architecture.mjs; this guard watches *runtime* bridges that
// are invisible to an import-only analysis: callbacks and facades that let one
// design parameter write into another one's state.
//
// The baseline in scripts/coupling-baseline.json records today's references.
// It is a ratchet:
//   * a new reference (or a higher count) fails the check;
//   * a removed reference also fails until the baseline is regenerated, so
//     every intentional decoupling lands with a smaller baseline.
//
// This is a proxy, not a proof: it catches new uses of the named bridges. It
// does not understand data flow. Keep the symbol list small and meaningful;
// see docs/architecture/coupling.md for the kernels behind it.
import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const srcRoot = path.join(root, 'src')
const baselineFile = path.join(root, 'scripts', 'coupling-baseline.json')

const SYMBOLS = [
  // Kernel A: identity <-> quota <-> catalog.
  'clearAuthRequired',
  'markAuthRequired',
  'healAuthFlagsFromQuota',
  'setCatalog',
  'catalogForAccount',
  // Kernel B: inference stream <-> tool mirror.
  'canCutOnTool',
  // Kernel C: background <-> ACP pool / quota failover.
  'retainAcpSession',
  'onQuotaExhausted',
  // Residual multi-account scheduling (single-account teardown).
  'advanceAccount',
  'avoidAccountIds',
]

const SOURCE_EXT = /\.(?:ts|tsx)$/

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (SOURCE_EXT.test(entry.name)) out.push(full)
  }
  return out
}

function rel(file) {
  return path.relative(root, file).replaceAll(path.sep, '/')
}

function collect() {
  const counts = {}
  for (const file of walk(srcRoot)) {
    const source = fs.readFileSync(file, 'utf8')
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const hits = new Map()
    const visit = (node) => {
      if (ts.isIdentifier(node) && SYMBOLS.includes(node.text)) {
        const parent = node.parent
        const isImportName = ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)
        if (!isImportName) hits.set(node.text, (hits.get(node.text) ?? 0) + 1)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    if (hits.size > 0) {
      counts[rel(file)] = Object.fromEntries([...hits.entries()].sort(([a], [b]) => a.localeCompare(b)))
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

function loadBaseline() {
  if (!fs.existsSync(baselineFile)) return { version: 1, symbols: SYMBOLS, counts: {} }
  return JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
}

function update(actual) {
  const payload = {
    version: 1,
    description: 'Service-level coupling ratchet. Regenerate only after an intentional decoupling: node scripts/check-coupling.mjs --update',
    symbols: SYMBOLS,
    counts: actual,
  }
  fs.writeFileSync(baselineFile, JSON.stringify(payload, null, 2) + '\n')
  const files = Object.keys(actual).length
  const refs = Object.values(actual).reduce((sum, bySymbol) => sum + Object.values(bySymbol).reduce((n, count) => n + count, 0), 0)
  console.log(`coupling baseline updated: ${files} files, ${refs} references, ${SYMBOLS.length} symbols`)
}

function compare(baseline, actual) {
  const regressions = []
  const removed = []

  for (const [file, bySymbol] of Object.entries(actual)) {
    for (const [symbol, count] of Object.entries(bySymbol)) {
      const allowed = baseline.counts?.[file]?.[symbol] ?? 0
      if (count > allowed) regressions.push(`${file}: ${symbol} ${allowed} -> ${count}`)
      else if (count < allowed) removed.push(`${file}: ${symbol} ${allowed} -> ${count}`)
    }
  }

  for (const [file, bySymbol] of Object.entries(baseline.counts ?? {})) {
    for (const [symbol, count] of Object.entries(bySymbol)) {
      const current = actual[file]?.[symbol] ?? 0
      if (current === 0) removed.push(`${file}: ${symbol} ${count} -> 0`)
    }
  }

  return { regressions, removed }
}

const actual = collect()
if (process.argv.includes('--update')) {
  update(actual)
  process.exit(0)
}

const baseline = loadBaseline()
const { regressions, removed } = compare(baseline, actual)

if (regressions.length > 0 || removed.length > 0) {
  if (regressions.length > 0) {
    console.error('New service-level coupling:')
    for (const line of regressions) console.error('  + ' + line)
  }
  if (removed.length > 0) {
    console.error('Coupling baseline is stale (this is good, ratchet it down):')
    for (const line of removed) console.error('  - ' + line)
  }
  console.error('\nRun `node scripts/check-coupling.mjs --update` only after reviewing the diff.')
  process.exit(1)
}

const files = Object.keys(actual).length
const refs = Object.values(actual).reduce((sum, bySymbol) => sum + Object.values(bySymbol).reduce((n, count) => n + count, 0), 0)
console.log(`coupling ok: ${files} files, ${refs} references, ${SYMBOLS.length} tracked symbols`)
