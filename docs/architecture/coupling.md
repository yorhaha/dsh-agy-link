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

* quota and token refresh observe credentials, quota success and TOS/validation
  refusals, but write them as `AuthEvidence` through the single
  `applyAuthEvidence` writer; the verdict itself is the pure
  `deriveAuthVerdict` (`src/features/quota/refresh.ts`,
  `src/features/quota/token.ts`, `src/domain/accounts/evidence.ts`,
  `src/domain/accounts/auth-state.ts`);
* quota acquisition needs a fresh token, so identity gates quota
  (`src/host/quota.ts`, `src/features/quota/token.ts`);
* eligibility reads a catalog fallback and the catalog merges quota rows
  (`src/domain/accounts/selection.ts`, `src/host/pool.ts`,
  `src/domain/models/quota-catalog.ts`).

Tracked bridge symbols: `clearAuthRequired`, `markAuthRequired`,
`healAuthFlagsFromQuota`, `setCatalog`, `catalogForAccount`.

Target: append-only evidence + pure derivation. Quota produces a snapshot and
an `AuthEvidence`; one writer applies it; eligibility is a pure function of
account + quota snapshot + catalog snapshot. No synchronous cross-writes. Both
quota refresh and token refresh now funnel through the writer; run settlement
and the explicit user paths still call `markAuthRequired`/`clearAuthRequired`
directly.

Residual edge: `setCatalog`/`catalogForAccount` stay on the manager. Eligibility
needs a model catalog discovered asynchronously per account, and threading an
immutable snapshot through selection, retry policy, one-shot calls, external
leases and the model picker would move the mutation from one facade to a dozen
call sites without removing the dependency. The pair is the intentional seam;
the pure `deriveEligibility` already takes catalog-derived facts as inputs, so a
future snapshot handoff changes only the adapter, not the decision rule.

## Kernel B — inference stream ↔ tool mirror

```
             DP3  DP9
FR5 推理        X    X
FR7 镜像        X    X
```

Evidence:

* `ToolProjection` owns the cut decision and receives an optional read-only
  liveness probe at the span boundary (`src/provider/mapper/tool-projection.ts`,
  `src/provider/span.ts`); `EventMapper` consumes the projection and no longer
  queries the host tools service while streaming;
* `agy_tool` execution reads the `RunRecording` produced by the mapper/attempt
  (`src/provider/mirror/definition.ts`).

Tracked bridge symbol: `canCutOnTool` (now confined to `ToolProjection`).

Target: a `ToolProjection` stage consumes a capability snapshot and emits either
tool-card chunks or inline reasoning. The mirror availability still gates cuts
for mid-span safety (plugin disposal, `tools.restrict`, tools remount), but the
probe is a host-injected capability read at the span boundary, not a back-call
from the streaming mapper. A future host event could replace the probe with a
revocation signal and remove the remaining edge.

## Kernel C — background ↔ ACP pool / quota

Evidence:

* background work acquires a `BackgroundRetention` lease and the ACP pool only
  reads the same `RetentionView` when deciding whether a process is idle
  (`src/domain/background/retention.ts`,
  `src/features/background/acp-watch.ts`, `src/features/acp/pool.ts`); the two
  sides share state through the injected registry instead of calling each
  other;
* subagent quota exhaustion calls quota failover, which cools the account and
  can kill the main run (`src/features/subagent/tracker.ts`,
  `src/provider/quota-failover.ts`).

Tracked bridge symbol: `onQuotaExhausted`.

Target: background activity emits quota evidence instead of directly driving
settlement. The retention half is done.

## Residual single-account scheduling

Selection only returns the primary account and the no-op
`advanceAccount()` hook has been removed; failure settlement now records
cooldowns, model pauses and auth evidence without moving an account pointer.
The remaining multi-account vocabulary is `avoidAccountIds`, which is still a
public request option: with one account it means "do not re-pick the only
account for this attempt", not a rotation pointer. Tracked bridge symbol:
`avoidAccountIds`.

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

Current baseline: **17 files / 52 references / 8 tracked symbols**.
