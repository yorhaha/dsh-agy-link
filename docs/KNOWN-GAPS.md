# Known gaps

Deliberate boundaries and upstream-behavior notes.

## Platform limits

- **Windows uses a shared credential slot.** agy resolves its Google credential from one machine-wide Credential Manager entry (`gemini:antigravity`); `HOME`/`USERPROFILE` move files only. The plugin owns the slot: the primary credential is kept in a durable, fingerprint-verified store (`agy-accounts/.primary-credential.json`) and every run enters through `acquireCredentialSlot`.
  - Same-identity runs are parallel (reference-counted); only **identity switches** serialize.
  - The slot is held only until agy has read it (print mode resolves its credential once at startup), so different accounts overlap after a few seconds instead of for the whole run.
  - A primary that cannot be verified aborts the run instead of spending the wrong account.
  - Cross-process coordination uses an atomic lockfile alongside the in-process mutex.

- **Per-process credential injection is unavailable in current agy.** The per-HOME token file is a read-path fallback only (the keyring wins when present); there is no `--api-key`/`--credential*` flag; `JETSKI_OAUTH_TOKEN` and the documented env routes are different auth products. A true fix must come from agy (namespace the keyring by HOME, or accept a `--credential-file`). Until then the reference-counted slot is the strongest isolation available.

## ACP transport (default)

`agy acp` is a long-lived JSON-RPC process per account+session and the default transport; opt back into one-shot CLI with `/agy transport cli` or `DSH_AGY_TRANSPORT=cli`. A pre-stream ACP failure falls back to `cli` for that turn. ACP is what makes background work survive a turn (`run_command`, `invoke_subagent`, `schedule` keep running and push results later).

- Only `pending`/`in_progress` at turn end counts as background work; a finished call does not wake.
- agy's own post-turn text is presented as a card over a short silence window, not re-run (two exceptions wake with a real turn: an armed Goal, and a silent completion with no text).
- An unrestorable session is rebuilt with a full history digest and a reset notice, never silently emptied.
- A turn with no output is a failure, not an empty success.
- One credential slot, three guards: pre/post-install `id_token_email` check, agy-log identity verification after start (one reinstall-retry), and primary re-assertion on secondary exit.

## Multimodal staging

agy print mode has no inline binary flag. Attachments (images, PDF, audio, video) are staged into `mediaDir` (TTL-swept) and referenced by absolute path with `--add-dir` so agy inspects them with its own tools.

## Reverse MCP bridge

`mcpBridge` runs a loopback-only, token-guarded endpoint and registers a stdio MCP server in agy's registry (merged in, restored on disable). Bridged calls carry an opaque per-session route; DSH supplies the current step's schemas and admitted tool set. The allowlist applies to both layers; recursive agy helpers are excluded. Request bodies are capped (8 MiB → 413) and the bearer token compared in constant time. Colliding normalized tool names get a stable suffix. Every call is audit-logged (`mcp call <tool> [<outcome>] <ms>`, never arguments).

**Contract for external callers of `tools.execute(exec)`:** DSH's `ToolExecutionInput` requires `callId`, `name`, `arguments` **and `signal: AbortSignal`** (missing `signal` throws on any awaited tool). Omit `agent` entirely when sessionless — never `null` (DSH checks `=== void 0`). The plugin's `/call` handler already mints an `AbortController` per call and resolves the caller from `x-dsh-session`. A fabricated `agent.session` cannot pass DSH's live-session check; tools requiring one need a real `agent`.

## Not forwarded / known limitations

- **DSH `send_message` from an agy child:** the footer names DSH's `send_message`, but in agy it resolves to agy's own tool. Bridge `send_message` explicitly via `mcpToolAllowlist` on the `dsh-tools-<port>` server, or instruct the child to use `agent_teams_send_message`. Root cause is upstream in `@deepseek-ai/dsh-subagent`.
- **Full tool args / diff cards:** read from agy's conversation SQLite DB via `sqlite3` to recover args stripped by `filterToolParameters`; without `sqlite3` cards fall back to stream metadata (conversation ids whitelist-validated).
- **Structured outputs:** `agy_ask` accepts a `schema` (JSON string via `--json-schema`); wiring schema into DSH-native tool generation is future work.

## Mapping choices

- agy tool activity mirrors as native DSH tool cards (`agy_tool` dispatched inside `run_code`), covering terminal, diff, read, search, MCP, `swarm`, `run_workflow`, `schedule`, `manage_task`, subagents, `image-generator`, browser/DevTools; falls back to reasoning annotations when mirroring is off.
- Gemini effort suffixes fold into one model with selectable efforts; Claude / GPT-OSS slugs stay verbatim (agy rejects `--effort` for them).
- Auxiliary calls (compaction, titles) reuse the `agy acp` pool when `transport === 'acp'`, else `agy -p`; they force `plan` mode, capped at 800K chars.

## Upstream behaviors

- Permission prompts hang print mode (#318) — hence the permission-mode design.
- `--sandbox` must not combine with `--dangerously-skip-permissions` (#36).
- First unauthenticated call takes ~60–70s to fail; later ones are faster.
- **Third-party MCP servers with item-less array schemas break the whole turn.** agy forwards their `tools/list` verbatim and Google rejects any array declaration missing `items`. The schema doctor (`dist/mcp-sanitize.mjs` + `writeMcpConfig()`) proxies foreign stdio entries, repairs `tools/list`, and drops stale per-tool descriptors. Gaps: `url`-based (http/sse) servers, specs larger than `MAX_WRAPPED_SPEC_CHARS`, and a plugin removed while wrapped entries remain in a foreign registry (each wrapper carries its original spec, so recovery needs no plugin). Manual mitigation: remove duplicate entries from agy's registry.

## Fallbacks

- If `agy models` fails, a bundled fallback catalog keeps the picker non-empty; unknown ids still accepted.
- Conversation-id discovery prefers stream ids, falls back to a conversations-directory snapshot diff (newest file wins).
