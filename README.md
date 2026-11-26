<h1 align="center">🛰️ dsh-agy-link</h1>

<p align="center">
  <b>DeepSeek Harness × Google Antigravity</b> — 单账号直连与官方 agy CLI / ACP 双通道桥接
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-agy-link"><img src="https://img.shields.io/npm/v/dsh-agy-link?color=cb3837&label=npm&logo=npm" alt="npm"/></a>
  <a href="https://github.com/amlyczz/dsh-agy-link/actions/workflows/ci.yml"><img src="https://github.com/amlyczz/dsh-agy-link/actions/workflows/ci.yml/badge.svg" alt="CI"/></a>
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="MIT"/>
  <img src="https://img.shields.io/badge/node-%3E%3D24-green" alt="node"/>
  <img src="https://img.shields.io/badge/agy-%3E%3D1.5-purple" alt="agy >=1.5"/>
</p>

<p align="center">
  <a href="./docs/README.en.md">English</a> ·
  <a href="./docs/CONFIGURATION.md">配置</a> ·
  <a href="./docs/ARCHITECTURE.md">架构</a> ·
  <a href="./docs/SECURITY-NOTES.md">安全</a>
</p>

---

# 中文

把 **Google Antigravity 模型接入 DeepSeek Harness（DSH）**：多账号智能池化、CLI 优先多 Bucket 配额监控、`agy acp` / 短进程 `-p` 双传输、浏览器一键登录、多模态附件与 Generative UI。由官方未修改的 `agy` CLI 驱动，支持流式输出、思考折叠、原生工具卡片与 1M 上下文计量。

<p align="center">
  <img src="./docs/assets/console.png" alt="Antigravity 控制台" width="760" />
</p>
<p align="center">
  <img src="./docs/assets/model-picker.png" alt="模型选择器" width="240" />
  &nbsp;&nbsp;
  <img src="./docs/assets/models-orchestrator.png" alt="模型与编排器" width="520" />
</p>
<p align="center">
  <img src="./docs/assets/settings.png" alt="功能与界面" width="380" />
  &nbsp;&nbsp;
  <img src="./docs/assets/token-usage.png" alt="Token 用量" width="330" />
</p>

---

> 🚨 **国内用户前置：需开启代理 / TUN 模式访问 Google**
>
> 1. 推荐开启代理工具（Clash / Surge / v2rayA 等）的 **TUN / 系统代理全局接管**，让终端、后台 Node 进程与浏览器都能访问 Google。
> 2. 若终端未被接管，启动前执行：
>    ```bash
>    export HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890
>    ```
> 3. 代理：卡片「🌐 代理」按钮。

---

## 核心能力

- 👤 **单账号直连**：直接使用系统 `agy` 登录态，`0600` 原子凭证写入（`.bak` 自愈）。Windows 以引用计数租约接管全局凭据槽，同号并发安全。
- ⚡ **按模型族独立切换与冷却**（Gemini / Argon / Claude / GPT-OSS）：一族限流不影响其余。
- 📊 **配额监控**：`agy -p /usage` 采集 5h 滚动、7d 周额度与 Argon 独立周池。
- 🧠 **鉴权抖动区分与风控熔断**：日志证据区分网络抖动（按 `NETWORK` 重试）与真实登出；`TOS_VIOLATION` 立即隔离该账号并停止自动故障转移。
- 🔑 **浏览器免粘贴 OAuth 与 Token 导入**。
- 🌐 **代理支持**：优先使用配置的代理，回退全局或系统探测。

---

## 特性一览

| 能力 | 说明 |
| --- | --- |
| 🎨 4 标签控制台 | 账号与配额 / 模型与编排 / 功能与界面 / 运行；侧边栏面板入口，应用式整页（图标+计数标签条、卡片重排、窄屏堆叠） |
| 📋 模型目录与编排器 | 同步 agy 模型目录，允许清单（`selectedModels`）、Planner / Executor 独立配置 |
| 🛡️ 权限与桥接 | `skip` / `auto` / `accept-edits` / `plan`（`/aplan` 只读）与 `--sandbox`；`mcpBridge` 按会话步骤桥接 DSH 工具 |
| ⚡ 双传输 | 默认持久 `agy acp` 会话池，流前异常回退 CLI；后台配额刷新避让活跃回合 |
| 🃏 工具卡片与 Generative UI | 镜像 Terminal / Diff / Read / Search / MCP / 子代理等卡片；`<agent-embed>` CSP 沙箱微件 |
| 🎬 多模态附件 | 图片 / PDF / 音频 / 视频暂存；灯箱、视频预览、内联音频、Mermaid、决策芯片 |
| 📊 上下文与计量 | 无损 `cache_read_tokens` / 思考 token / 1M 上下文计量；超长上下文 8:2 掐头去尾并分页读取 |
| ⚡ `/a*` 命令族 | `/aplan` `/agoal` `/agrill` `/aboost` `/aswarm` `/ateamwork` `/aschedule` `/abrowser` `/acmd`，元操作 `/acompact` `/afork` `/alearn` |
| 🌐 四语 i18n | `zh` / `en` / `es` / `pt-BR`；`showHeaderBadge` 等可见性开关 |

---

## 前置要求

| 前置 | 验证 |
| --- | --- |
| 系统网络代理 | 开启 TUN / `HTTPS_PROXY`，可连 Google |
| DeepSeek Harness | `dsh --version` |
| Node.js ≥ 24 | `node --version` |
| Antigravity `agy` CLI ≥ 1.5 | `agy --version` |

---

## 快速上手

```bash
# 1. 安装插件
dsh plugin --profile web add dsh-agy-link

# 2. 启动 DSH Web GUI，输入框执行 /agy status 检查状态

# 3. 登录账号：
#    A) 顶部 "AGY" 徽标 → "🔑 重新登录"，浏览器一键登录 / 导入 Token
#    B) /agy auth 启动登录；/agy auth-code <code> 手动完成

# 4. /model 选择 Antigravity 模型开始对话
```

无头运行的权限预设见 [docs/HEADLESS-PERMISSIONS.md](./docs/HEADLESS-PERMISSIONS.md)。

---

## 配置

所有配置键、环境变量、默认值只维护一份：[docs/CONFIGURATION.md](./docs/CONFIGURATION.md)。常用入口：侧边栏 Antigravity 面板（主入口）、`/plugin`、`DSH_AGY_*` 环境变量、`~/.dsh/agy-link/runtime-overrides.json`（面板与 `/agy` 热修改写入处）。

---

## 常用 `/agy` 命令

| 分组 | 命令 |
| --- | --- |
| 状态与配额 | `/agy status` · `refresh-quota` · `clear-cooldown [family]` · `models` |
| 认证 | `/agy auth` · `auth-status` · `auth-code <code>` · `import <token_or_json> [alias]` |
| 运行与安全 | `/agy mode <skip\|auto\|plan\|accept-edits>` · `sandbox [on\|off]` · `transport [cli\|acp\|status]` · `agent [name\|off]` · `settings [show\|<json\|path>\|clear]` · `effort <…>` · `workspace [path]` |
| 目标与会话 | `/agy goal [...]` · `session [info\|clear]` |
| 工作流 | `/agy fork [...]` · `grill [主题]` · `learn [--apply] [焦点]` · `compact [焦点]` · `doctor` |
| `/a*` 快捷（直入会话） | `/aplan` `/agoal` `/agrill` `/aboost` `/aswarm` `/ateamwork` `/aschedule` `/abrowser` `/acmd` |
| `/a*` 元操作 | `/acompact` `/afork` `/alearn` |

---

## 外部进程凭据租约 API

Windows 上所有 `agy.exe` 共用凭据条目 `gemini:antigravity`，改 HOME 只换会话目录、不换身份。外部进程（如需扛过 DSH 重启的 runner）看不到插件内存计数，故提供租约 API 参与同一套选号 / 取槽 / 结算。

- **隔离备用账号 + agy ≥ 1.5**：不占槽（`slot: false`），返回 `env` 含 `SSH_CONNECTION`，agy 只读该账号 token，可与其它账号无锁并行。发放前插件把 token 刷新进 CLI 安全窗口；版本未知时先探测，探测失败按占槽处理。
- **主账号 / agy < 1.5 的隔离账号**：持有凭据槽（`slot: true`）。

**发现端点**：`<号池目录>/.link-endpoint.json`（默认 `~/.dsh/agy-accounts`），含 `url / pid / startedAt / token`，权限 `0600`，token 每次启动重生成。

**鉴权**：所有 `/lease*` 请求需 `Authorization: Bearer <token>`，缺失或不符 `401`；带非本机 `Origin` 的浏览器请求 `403`。

| 端点 | 要点 |
| --- | --- |
| `POST /lease/acquire` | `holder`（必填）、`model?`、`accountId?` / `accountDir?`（钉住账号）、`ttlMs?`（默认 120000，夹 15000–600000）、`waitMs?`。返回 `{ ok, leaseId, ttlMs, expiresAt, slot, env, account }` |
| `POST /lease/renew` | `leaseId`、`ttlMs?` |
| `POST /lease/release` | `leaseId`、`ok?`、`error?`、`model?`；`ok:true` 记成功，`ok:false` 按 one-shot 失败分类结算，省略只释放 |
| `GET /lease` | 诊断用，列出当前租约 |

使用要点：启动 agy 时把返回 `env` 原样叠加到进程环境；按 TTL 定期 `renew`，结束**恰好一次** `release`。租约只在内存，宿主重启即全部失效，客户端需重新 `acquire`。

---

## 架构

分层与依赖方向见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)；开发门禁见 [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)。

1. **双传输**：默认持久 `agy acp` 会话池，流前异常回退 CLI；需 `--settings` / `--json-schema` 时走 `-p`。
2. **多账号沙箱与凭据租约**：主账号用系统 HOME / 钥匙串，备用账号隔离于 `~/.dsh/agy-accounts/<id>`；Windows 以引用计数租约接管全局槽。
3. **配额汇总**：`agy -p /usage` 优先，必要时回退 `retrieveUserQuotaSummary`，追踪 5h / 7d / Argon 周池。
4. **故障转移与自愈**：按模型族独立分类与冷却 429 / 额度耗尽 / 地区限制 / 鉴权异常。
5. **辅助通道隔离**：标题生成与目标推导走专用 `purpose`，共享号池但不污染主会话绑定。

---

## FAQ

- **Windows 对话时闪现黑框**：Windows Terminal 委托拦截子进程句柄所致，良性。将默认终端改为「Windows 控制台主机」并重启 DSH 即可。
- **`agy` 自动更新子进程闪窗**：Windows 默认启用 `suppressAgyAutoUpdate`，spawn 前刷新 `last_check.timestamp`，不派生子进程；`agy update` 不受影响。
- **`--effort is not supported`**：插件自动无参数重放完成本轮，并记入 `effort-unsupported.json` 隐藏该档位。
- **配额未及时更新**：默认每小时轮询（`quotaPollIntervalMs`）；点「同步」或 `/agy refresh-quota` 立即刷新。

---

## 相关文档

- [CONFIGURATION.md](./docs/CONFIGURATION.md) — 配置键与环境变量
- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — 分层架构与 Provider 流水线
- [AUTH.md](./docs/AUTH.md) — OAuth、Token 导入与钥匙串隔离
- [SECURITY-NOTES.md](./docs/SECURITY-NOTES.md) — 威胁模型与安全边界
- [HEADLESS-PERMISSIONS.md](./docs/HEADLESS-PERMISSIONS.md) — `dsh headless` 最小权限
- [KNOWN-GAPS.md](./docs/KNOWN-GAPS.md) — 平台限制与上游行为
- [DEVELOPMENT.md](./docs/DEVELOPMENT.md) — 门禁与重构规范

## 致谢

CLIProxyAPI · opencode-antigravity-auth · OmniRoute · pi-mono

## 免责声明

本插件仅调用用户本地官方安装的未修改 `agy` CLI。使用需遵循 Google Antigravity 服务条款。

## 许可证

MIT License.
