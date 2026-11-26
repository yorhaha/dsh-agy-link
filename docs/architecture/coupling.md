# Service-level coupling baseline

`scripts/check-architecture.mjs` proves the **import graph** is acyclic. That is
not enough: the provider pipeline, account domain and background extensions also
talk through injected callbacks and mutable facades, and an import-only check
cannot see those edges. This page records the functional couplings behind
`scripts/check-coupling.mjs` and is the reference for the decoupling work.

The unit of analysis is the FR × DP design matrix from MIT axiomatic design:
rows are functional requirements, columns are design parameters, and
`A[i][j] = ∂FR[i]/∂DP[j]` is non-zero when DP[j] can change FR[i]. `X` is a
direct effect; `o` is an indirect, feedback or read-only evidence effect. Both
count as non-zero.

## FR / DP map

| FR | Requirement | DP | Mechanism |
| --- | --- | --- | --- |
| FR1 | Connect the provider and degrade safely when `agy` is missing | DP1 | assembly & admission (`index.ts`, `host/services.ts`, `runtime/agy/bin.ts`) |
| FR2 | Establish, maintain and repair Antigravity identity | DP4 | identity & credentials (`host/oauth.ts`, `host/pool-auth.ts`, `domain/credentials/*`) |
| FR3 | Decide whether a request is allowed by quota/risk control | DP5 | quota & scheduling (`host/quota.ts`, `host/pool.ts`, `features/quota/*`) |
| FR4 | Show usable models and effort levels in the native picker | DP6 | catalog & capabilities (`host/models.ts`, `domain/models/*`) |
| FR5 | Stream text, reasoning, usage and finish chunks for a model call | DP2/DP3 | transport/process + protocol mapping |
| FR6 | Continue the same agy session with the required context | DP7/DP8 | prompt/context + session binding |
| FR7 | Expose agy tool activity as native tool cards | DP9 | tool bridge (`host/mirror-tool.ts`, `provider/mirror/*`) |
| FR8 | Let agy call DSH tools inside a controlled step | DP9 | reverse MCP bridge |
| FR9 | Run auxiliary calls without polluting the main session | DP10 | purpose policy |
| FR10 | Observe subagents/background tasks and optionally wake the session | DP11 | background orchestration |
| FR11 | Inspect and control behaviour from commands, settings and UI | DP12 | control surface |
| FR12 | Obtain redacted diagnostic evidence | DP12 | diagnostics |

## Design matrix (natural FR/DP order)

```
             DP1  DP2  DP3  DP4  DP5  DP6  DP7  DP8  DP9  DP10 DP11 DP12
FR1 接入      X    X    .    .    .    .    .    .    .    .    .    .
FR2 身份      .    X    .    X    o    .    .    .    .    .    .    X
FR3 配额      .    X    .    X    X    X    .    .    .    .    .    o
FR4 目录      .    X    .    X    o    X    .    .    .    .    .    X
FR5 推理      .    X    X    X    X    X    X    X    X    .    .    .
FR6 连续      .    X    X    o    o    o    X    X    .    .    .    .
FR7 镜像      .    X    X    .    .    .    .    X    X    .    .    X
FR8 反桥      .    X    X    .    .    .    .    X    X    .    .    o
FR9 辅助      .    X    X    o    o    o    X    .    .    X    .    .
FR10 后台     .    X    X    .    o    .    o    X    .    X    X    X
FR11 控制     .    o    .    o    X    X    o    X    o    o    o    X
FR12 诊断     o    X    X    o    o    o    o    o    o    o    o    X
```

Natural order has 78 non-zero entries, 28 of them above the diagonal (36%).
Block-level it is lower triangular in five blocks (B1 base, B2 account,
B3 inference/session, B4 extensions, B5 control/diagnostics), which is why the
architecture *looks* decoupled. The scalar matrix is not triangular: the kernels
below are full 2×2 blocks, and a full 2×2 block cannot be removed by any row or
column permutation.

## Kernel A — identity ↔ quota ↔ catalog

```
             DP4  DP5  DP6
FR2 身份        X    X    .
FR3 配额        X    X    X
FR4 目录        X    X    X
```

Evidence in the current tree:

* quota refresh clears `authRequired` after authenticated evidence
  (`src/features/quota/refresh.ts`, `src/host/pool-auth.ts`);
* quota acquisition needs a fresh token, so identity gates quota
  (`src/host/quota.ts`, `src/features/quota/token.ts`);
* eligibility reads a catalog fallback and the catalog merges quota rows
  (`src/domain/accounts/selection.ts`, `src/host/pool.ts`,
  `src/domain/models/quota-catalog.ts`).

Tracked bridge symbols: `clearAuthRequired`, `markAuthRequired`,
`healAuthFlagsFromQuota`, `setCatalog`, `catalogForAccount`.

Target: append-only evidence + pure derivation. Quota produces a snapshot and
an `AuthEvidence`; one writer applies it; eligibility is a pure function of
account + quota snapshot + catalog snapshot. No synchronous cross-writes.

## Kernel B — inference stream ↔ tool mirror

```
             DP3  DP9
FR5 推理        X    X
FR7 镜像        X    X
```

Evidence:

* `EventMapper` asks `canCutOnTool()` whether the `agy_tool` mirror is
  registered/visible before deciding between a native tool card and inline
  reasoning (`src/provider/mapper/event-mapper.ts`, `src/provider/span.ts`);
* `agy_tool` execution reads the `RunRecording` produced by the mapper/attempt
  (`src/provider/mirror/definition.ts`).

Tracked bridge symbol: `canCutOnTool`.

Target: a `ToolProjection` stage consumes a capability snapshot and emits either
tool-card chunks or inline reasoning. The mapper stops querying the tools
service; a one-way revocation signal preserves the mid-run safety check.

## Kernel C — background ↔ ACP pool / quota

Evidence:

* `BackgroundWakeWatcher` retains ACP sessions through `retainAcpSession`; the
  pool's idle eviction must respect that retention
  (`src/host/services.ts`, `src/features/background/*`,
  `src/features/acp/pool.ts`);
* subagent quota exhaustion calls quota failover, which cools the account and
  can kill the main run (`src/features/subagent/tracker.ts`,
  `src/provider/quota-failover.ts`).

Tracked bridge symbols: `retainAcpSession`, `onQuotaExhausted`.

Target: the watcher acquires a time-bounded retention lease; the pool only reads
the lease view. Background activity emits quota evidence instead of directly
driving settlement.

## Residual single-account scheduling

`AccountPoolManager.advanceAccount()` is already a no-op and selection only
returns the primary account, but the multi-account vocabulary remains
(`advanceAccount`, `avoidAccountIds`). If single-account is the product target,
this is deletion work, not abstraction work. Tracked bridge symbols:
`advanceAccount`, `avoidAccountIds`.

## Ratchet

`scripts/check-coupling.mjs` counts references to the bridge symbols above in
`src/**` and compares them with `scripts/coupling-baseline.json`.

```bash
node scripts/check-coupling.mjs            # fail on new or removed references
node scripts/check-coupling.mjs --update   # regenerate after an intentional change
```

Rules:

1. A new reference or a higher count fails. Treat it as a design review: wire a
   read-only snapshot or an evidence object instead of a back-call.
2. A lower count also fails until the baseline is regenerated. Every decoupling
   PR therefore lands with a smaller baseline in the same commit.
3. The baseline is a proxy. It does not prove data-flow independence; it keeps
   new uses of the known bridges visible. `scripts/check-architecture.mjs`
   remains the import-cycle and direction gate.

Current baseline: **21 files / 83 references / 10 tracked symbols**.
