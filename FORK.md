# Fork notes

This fork of [tsmztech/mcp-server-salesforce](https://github.com/tsmztech/mcp-server-salesforce) carries one local change that is not intended for upstream: a write guard.

## Why it differs from the README

Upstream exposes every write tool as soon as the server starts. This fork **refuses all writes by default**. If a write tool returns `Write blocked: ...`, that is this guard working, not a bug.

## The guard

Source: `src/utils/writeGuard.ts`. Wired into `src/index.ts` in two places: the `ListToolsRequestSchema` handler and the line before `switch (name)` in the `CallToolRequestSchema` handler.

| Variable | Effect |
|---|---|
| `SFDC_ALLOWED_WRITES` | Comma-separated `Object:operation` pairs, e.g. `Task:insert`. Only these DML calls are allowed. Unset or empty refuses all DML. |
| `SFDC_ALLOW_ADMIN_WRITES` | Must be exactly `true` to enable `execute_anonymous`, `write_apex`, `write_apex_trigger`, `manage_object`, `manage_field` and `manage_field_permissions`. Otherwise they are refused and not listed. These tools can bypass the object allowlist, which is why they are gated separately. |
| `SFDC_EXPECTED_ORG_ID` | 15- or 18-character org id. Every write is refused unless the live connection reports this org. |

`salesforce_manage_debug_logs` is not gated. It writes TraceFlag config, not business data.

## Why the org pin exists

With `SALESFORCE_CONNECTION_TYPE=Salesforce_CLI`, the server connects to whichever org the CLI treats as default. A `sf org login` elsewhere on the machine repointed this server from a sandbox to production with no config change. `SFDC_EXPECTED_ORG_ID` turns that into a refused write instead of a silent one.

Upstream PR [#201](https://github.com/tsmztech/mcp-server-salesforce/pull/201) adds `SALESFORCE_TARGET_ORG` to pin the CLI org itself. This branch builds on it. Set both.

## Branches

- `feat/cli-target-org`: the upstream PR. Keep it free of guard code.
- `fork/write-guard`: guard on top of the PR. This is the branch to build and run.

## Merging upstream

`writeGuard.ts` never conflicts. Expect small conflicts in `src/index.ts` whenever upstream adds a tool, because both touchpoints sit where tools are registered and dispatched. After resolving, check that every new write-capable tool is either gated by `assertDmlAllowed` or listed in `ADMIN_WRITE_TOOLS`.
