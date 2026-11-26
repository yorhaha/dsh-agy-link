# 重构待办（临界模块）

`npm run lint:budget` 的上限是 **每文件 600 行**。下面这些模块长期贴着上限：每次新增行为都要靠**删注释**腾出空间，这是职责过多的信号，而不是"还差几行"。

维护规则：
- 新增功能若让任一文件超过上限 → **不要加 ratchet 豁免**，先把一处**无状态职责**抽成独立模块。
- 抽取顺序按"纯函数 → 无状态分支 → 有状态协作"进行，避免一次动多个概念。
- 每次抽取后 `check`/`lint:budget`/`build`/`test` 必须全绿，行为不变（已有测试即回归网）。

## 2026-11-24 扫描（342 模块 / 67,894 行 / 0 环 / 0 方向违规）

| 模块 | 行数（抽取前） | 可抽出的职责 | 状态 |
| --- | --- | --- | --- |
| `src/provider/mapper/event-mapper.ts` | 599 | `formatRunningToolFallback`（纯函数） | **已抽出** → `running-tool-fallback.ts`（575 行） |
| `src/features/subagent/tracker.ts` | 599 | 日志尾部跟随与状态机可分离 | **已抽出** → `transcript-tail.ts`（540 行） |
| `src/features/background/watcher.ts` | 599 | 定时器调度与唤醒判定可分离 | 待办 |
| `src/features/acp/pool.ts` | 599 | 驱逐策略（`shouldEvict` 一族）可独立 | 待办 |
| `src/features/acp/client.ts` | 599 | JSON-RPC 帧收发可独立 | 待办 |
| `src/client/sections/AccountsPanel.ts` | 599 | 配额条 / 模型子列表渲染可分离 | 待办 |
| `src/host/adapter.ts` | 598 | 绑定（binding）读写可独立 | 待办 |
| `src/domain/credentials/slot.ts` | 598 | 平台差异分支可独立 | 待办 |

**为什么记下来而不是一次全抽**：这几处分别属于 ACP、凭证、宿主调度三条高风险链路；一次性大改会让回归范围失控。按上表逐个推进，每次只动一个概念。

## 2026-11-25 增量（区间修复顺带抽取）

- `adapter` 的一次性告警门 → `src/provider/warn-once.ts`；steer/lifecycle 判定（`promptIdentity` / `hasNewHumanTask`）→ `src/provider/prompt-identity.ts`（#205）。
- ACP 首事件门限与单行格式化 → `src/features/acp/turn-format.ts`；编排器设置落盘与空闲进程回收策略 → `src/features/acp/orchestrator-prep.ts`（#204）。
- `go-keyring` 信封 → `src/common/go-keyring.ts`（`domain/` 不再 import `runtime/`）；`settings.json` 原子合并 → `src/runtime/agy/settings-sync.ts`（#203/#204）。
- 结果：`adapter` 599、`run-attempt` 597、`prompt-text` 597、`pool` 598（均 < 600，无 ratchet）。

## 重复实现（比体积更该处理）

- **`delay(ms[, signal])` 收敛完成**：18 处纯 `new Promise(setTimeout)` 已统一到 `src/common/async.ts` 的 `delay(ms)`（含 `quota/sweep` 的本地 `sleep`、`subagent` 两条 JSONL tail 的重复读取循环 → `transcript-tail.ts`）。检查确认这些调用点全部不接受 `AbortSignal`；唯一带取消语义的 `abortableDelay` 仍留在 `src/provider/attempt.ts`，因为它需要 provider 专属的 `LlmError` 文案——不要把它折叠进 common。
  - 语义约定：`delay(ms)` 与原始 `setTimeout` 一致，`ms <= 0` 仍让出一个宏任务；同步重试等待（`domain/credentials/backup.ts` 的 `sleepMs`）不属于 Promise 睡眠，保持原样。
  - 优先级：已完成。
