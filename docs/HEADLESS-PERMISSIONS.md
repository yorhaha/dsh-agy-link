# Headless permissions

The Antigravity provider invokes the official `agy` CLI directly; a model-selection label from another provider does not make this an API-router call. In noninteractive (`headless`) runs a request needing approval is auto-denied because no prompt can be answered.

## Reproduce

From a project dir in `plan` mode, request a read outside the workspace (no read allow-rule). Use a disposable fixture dir, not private data:

```sh
agy --model gemini-3.8-flash --effort high --mode plan \
  --output-format stream-json --print-timeout 90s \
  --print 'Use list_dir on /tmp/agy-shared-fixture. If denied, stop.'
```

A recorded `user denied permission` does not prove a human clicked Deny. Switching `plan` → `accept-edits` is not authorization for arbitrary external dirs.

## Least-privilege remediation

1. Back up the effective settings (Linux verified: `~/.gemini/antigravity-cli/settings.json`; verify per version/platform). Never copy credential stores into an issue.
2. Keep the existing config and permission list; add only the required rule (e.g. `read_file(/tmp/agy-shared-fixture)`) as one array entry — not a replacement file.
3. Test listing, a direct child, a nested child, and a sibling outside the dir (should be denied). A directory rule is broader than a file rule — grant the narrowest paths.
4. Keep `plan` for the read-only proof. Do not add `command(...)`, write rules or `--dangerously-skip-permissions` to make it green.
5. Read the recorded `step_update` outcome: exit 0 / `SUCCESS` / model prose alone are insufficient (the envelope can say success when a tool failed or the reply is empty).
6. Verify a fresh DSH turn after deployment; a newly spawned CLI reads its settings, so a permission change does not need a restart. Keep process completion, tool errors and response completeness separate — a passing read tool does not mean the whole turn passed.
