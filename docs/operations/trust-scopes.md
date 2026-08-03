# Per-Capability Trust Scopes

VS Code's built-in Workspace Trust is a single on/off switch. Schegent
adds four independently-configurable **trust scopes** on top of it so
enterprise IT can grant workspace trust (which the seven built-in
Spec Driven Development workflow phases require) while still denying operator-authored prompt
overrides on the same workspace.

The four scopes are:

| Setting | Capability gated | Resets-to-defaults allowed? |
|---|---|---|
| `schegent.trust.allowCustomPhases` | Saving non-default phase definitions (`schegent.phases[]`) | Yes |
| `schegent.trust.allowCustomRetryConditions` | Saving a non-default `retryCondition` expression on any phase row | Yes (the row's default retry-condition is unaffected) |
| `schegent.trust.allowPipelineOverrides` | Saving non-default entries in the pipeline catalog (`schegent.pipelines`) | Yes |
| `schegent.trust.allowWorkflowOverrides` | Saving non-default entries in the workflow catalog (`schegent.workflows`) | Yes |

All four default to `null`, which means "follow Workspace Trust". When
explicitly set to `true` or `false`, they are independent of each other
but **never widen the Workspace Trust ceiling**.

`allowPipelineOverrides` and `allowWorkflowOverrides` are deliberately separate
capabilities: permitting pipeline-catalog edits does not thereby permit
workflow-graph edits. A workflow decides which pipelines run and in what
relation to each other, which is a broader authority than editing one pipeline's
phase order.

Committing a [Phase YAML import](../features/phase-yaml-exchange.md) can require
**two** of these scopes: `allowCustomPhases` always, because an imported Phase is
a custom Phase, and `allowCustomRetryConditions` additionally when the imported
document declares a `retryCondition`. Both are read at commit time, never
inherited from the earlier read-only preflight, so a scope changed between
inspecting a document and confirming it is honored as of the confirm. A denial on
either is audited as the same `trust.capability-denied` event as any other
refused catalog write.

This page is the operator reference for the feature. See
[specs/059-fine-grained-trust-scopes/](../../../specs/059-fine-grained-trust-scopes/)
for the full specification and contract dossiers.

## Why four scopes (and not one)

Workspace Trust is workspace-wide: granting it enables every Schegent
phase, including the built-ins (`speckit-specify`, `speckit-plan`,
…). Operators who only need the built-ins shouldn't have to grant a
blank cheque on custom phase prompts. The four scopes let your IT
team approve the built-in flow on a per-workspace or per-user basis
while still denying:

- operator-authored phase **prompts** (which run as Claude CLI input on
  the operator's workstation),
- operator-authored retry-condition **DSL expressions** (sandboxed at
  evaluation, but still operator-controlled looping logic),
- operator-authored **pipeline catalogs** (which decide which phases
  run in what order),
- operator-authored **workflow graphs** (which decide which pipelines
  relate to which, and under what conditions).

The Workspace Trust ceiling guarantees a denied workspace can never be
overridden by user-scope settings — see the resolution ladder below.

## The four-step resolution ladder

For each capability, Schegent runs four checks in order. The **first
explicit answer wins**:

```text
INPUT: capability ∈ { phases, retryConditions, pipelineOverrides, workflowOverrides }

STEP 1: if vscode.workspace.isTrusted === false  → return false
STEP 2: read workspace-scope setting via .inspect(key).workspaceValue
        if it is explicit true or false           → return that value
STEP 3: read user-scope setting via .inspect(key).globalValue
        if it is explicit true or false           → return that value
STEP 4: workspace is trusted; no explicit override → return true
```

Two consequences:

1. **The workspace-trust ceiling is never widened.** Setting
   `schegent.trust.allowCustomPhases: true` at user scope on an
   untrusted workspace still denies — step 1 already returned `false`.
2. **Workspace scope beats user scope.** A user-scope `true` is ignored
   when the workspace says `false`; a user-scope `false` is ignored
   when the workspace says `true`.

## Worked examples

### 1. Default-allow (typical individual developer)

- Workspace is trusted.
- Neither workspace nor user setting set any of the four scopes.

Step 1 passes. Steps 2 and 3 find no explicit value. Step 4 returns
`true` for every capability. The webview shows no trust banners; every
Save button is enabled. The `getResolvedScope()` resolver reports the
scope as `workspace-trust` (the only layer that fired).

### 2. User-scope deny (operator opts out of risky overrides)

```jsonc
// settings.json (User)
{
  "schegent.trust.allowCustomPhases": false
}
```

- Workspace is trusted.
- Workspace-scope: not set. User-scope: `false`.

Step 1 passes. Step 2 finds no value. Step 3 returns `false`. The
PipelineBuilder shows the **phases** banner; the Save Phases and Add
Phase buttons are disabled. Retry-conditions and pipelines are
unaffected. The resolver reports `resolvedScope: 'user'`.

### 3. Workspace-scope override (enterprise IT denies for one repo)

```jsonc
// <workspace>/.vscode/settings.json
{
  "schegent.trust.allowPipelineOverrides": false
}
```

- Workspace is trusted.
- Workspace-scope: `false`. User-scope: any value.

Step 1 passes. Step 2 returns `false`. The user-scope value never
gets read. Save Pipelines and Add Pipeline are disabled; phases and
retry-conditions remain enabled (default-allow). The resolver reports
`resolvedScope: 'workspace'`.

### 4. Workspace-trust ceiling (untrusted workspace)

- Workspace is not trusted.
- Any value at any scope for any of the four settings.

Step 1 returns `false` for every capability. The webview shows the
**workspace-trust** banner; the per-capability banners are suppressed
(one banner only, FR-010e). Every Save button is disabled. The
resolver reports `resolvedScope: 'workspace-trust'` for every
capability.

## The 16-row truth table

`isTrusted ∈ {true, false}` × `workspace-scope ∈ {true, false, null}` ×
`user-scope ∈ {true, false, null}`. The `*` rows collapse three
identical outcomes each.

| `isTrusted` | Workspace | User  | Result | Resolved scope     |
|-------------|-----------|-------|--------|--------------------|
| `false`     | *         | *     | `false`| `workspace-trust`  |
| `true`      | `true`    | `true`| `true` | `workspace`        |
| `true`      | `true`    | `false`| `true`| `workspace`        |
| `true`      | `true`    | `null`| `true` | `workspace`        |
| `true`      | `false`   | `true`| `false`| `workspace`        |
| `true`      | `false`   | `false`| `false`| `workspace`       |
| `true`      | `false`   | `null`| `false`| `workspace`        |
| `true`      | `null`    | `true`| `true` | `user`             |
| `true`      | `null`    | `false`| `false`| `user`            |
| `true`      | `null`    | `null`| `true` | `workspace-trust`  |

The 9 untrusted-workspace rows are covered by the single `*` line
(3 workspace-scope × 3 user-scope = 9 combinations, all resolving to
`false` / `workspace-trust`).

## The audit-event shape

Every denied save writes exactly one structured audit entry to
`<workspaceRoot>/.schegent/audit.log` (JSONL).

```json
{
  "id": "...",
  "timestamp": "2026-05-20T12:34:56.789Z",
  "runId": "trust-gate",
  "phase": "settings",
  "iteration": 0,
  "eventType": "trust.capability-denied",
  "payload": {
    "capability": "phases",
    "resolvedScope": "workspace",
    "workspaceBasename": "enterprise-monorepo",
    "reason": "allowCustomPhases is false at workspace scope.",
    "rowIndex": 1
  },
  "outcome": "failure",
  "correlationId": "<the IPC command's correlationId>"
}
```

Field guarantees (see the
[`trust-capability-denied-audit-contract.md`](../../../specs/059-fine-grained-trust-scopes/contracts/trust-capability-denied-audit-contract.md)
for the canonical invariants):

- `capability` ∈ `{ phases, retryConditions, pipelineOverrides, workflowOverrides }` —
  closed enum.
- `resolvedScope` ∈ `{ user, workspace, workspace-trust }` — closed
  enum identifying the layer that produced the denial decision.
- `reason` is one of the fixed templates in `TRUST_DENIED_REASONS` —
  no operator-controlled string ever flows through this field.
- `workspaceBasename` is `path.basename(workspaceRoot)` only. The full
  workspace path is **never** serialized (hard rule).
- `rowIndex` is present **only** when `capability === 'retryConditions'`
  and identifies the offending phase row (0-indexed).
- `runId: 'trust-gate'`, `phase: 'settings'`, `iteration: 0`, and
  `outcome: 'failure'` are pinned constants.

## Tracing denials from the audit log

```bash
grep '"eventType":"trust.capability-denied"' .schegent/audit.log | jq .
```

Counting denials by capability over the last hour:

```bash
jq -c 'select(.eventType=="trust.capability-denied") |
       select(.timestamp > (now - 3600 | todate)) |
       .payload.capability' \
  .schegent/audit.log | sort | uniq -c
```

## Recipes for enterprise IT

### A. Allow only the built-in Spec Driven Development workflow phases on every workspace

Add to your VS Code user-scope settings (or push via the VS Code Settings
Sync / your MDM channel of choice):

```jsonc
{
  "schegent.trust.allowCustomPhases": false,
  "schegent.trust.allowCustomRetryConditions": false,
  "schegent.trust.allowPipelineOverrides": false
}
```

Operators can still grant Workspace Trust and run the built-in
Spec Driven Development workflow pipeline; every operator-authored override is denied.

### B. Allow custom phases only on approved workspaces

Leave the user-scope values at their default (`null`) and add per-
workspace overrides in `<workspace>/.vscode/settings.json`:

```jsonc
{
  "schegent.trust.allowCustomPhases": true,
  "schegent.trust.allowCustomRetryConditions": true,
  "schegent.trust.allowPipelineOverrides": true
}
```

This is the explicit opt-in. The workspace setting wins over user
scope, so even an operator who flipped these to `false` at user scope
gets `true` on the approved workspace.

### C. Block one capability project-wide while keeping the rest open

```jsonc
// User settings
{
  "schegent.trust.allowPipelineOverrides": false
}
```

Pipelines are denied everywhere; phases and retry-conditions follow
workspace-trust default-allow.

### D. Audit denials across all workspaces

Aggregate per-workspace `.schegent/audit.log` files in your SIEM or
log pipeline; filter on `eventType == "trust.capability-denied"` and
group by `payload.workspaceBasename` for a per-workspace denial
report. No path-bearing fields are present in the payload — only the
basename is recorded.

## Common questions

**Q: I set `allowCustomPhases: true` at user scope but the Save Phases
button is still disabled. Why?**

Either (a) Workspace Trust is not granted (workspace-trust ceiling
applies — open the VS Code "Manage Workspace Trust" command and grant
trust), or (b) the workspace has `allowCustomPhases: false` at
workspace scope. Workspace-scope always wins over user-scope.

**Q: Reset-to-defaults is greyed out too.**

It shouldn't be. The save handlers explicitly allow a payload whose
authored content equals the catalog default — see the
[`save-command-trust-gate-contract.md`](../../../specs/059-fine-grained-trust-scopes/contracts/save-command-trust-gate-contract.md).
File an issue with the audit-log entries from the most recent save
attempt.

**Q: The webview projection still shows the old value after I change
the setting.**

The capability-trust resolver subscribes to
`workspace.onDidGrantWorkspaceTrust` and
`workspace.onDidChangeConfiguration` and kicks the state projector
each time. If the projection looks stale, reload the window
(`Developer: Reload Window`).

## References

- Spec: [specs/059-fine-grained-trust-scopes/spec.md](../../../specs/059-fine-grained-trust-scopes/spec.md)
- Data model: [specs/059-fine-grained-trust-scopes/data-model.md](../../../specs/059-fine-grained-trust-scopes/data-model.md)
- Resolver contract: [specs/059-fine-grained-trust-scopes/contracts/capability-trust-resolver-contract.md](../../../specs/059-fine-grained-trust-scopes/contracts/capability-trust-resolver-contract.md)
- Save-command gate: [specs/059-fine-grained-trust-scopes/contracts/save-command-trust-gate-contract.md](../../../specs/059-fine-grained-trust-scopes/contracts/save-command-trust-gate-contract.md)
- Audit contract: [specs/059-fine-grained-trust-scopes/contracts/trust-capability-denied-audit-contract.md](../../../specs/059-fine-grained-trust-scopes/contracts/trust-capability-denied-audit-contract.md)
- Webview projection: [specs/059-fine-grained-trust-scopes/contracts/trust-projection-contract.md](../../../specs/059-fine-grained-trust-scopes/contracts/trust-projection-contract.md)
- Trust model strategy: [docs/plans/trust-model-strategy.md](../../../docs/plans/trust-model-strategy.md)
- Security threat model: [docs/security/threat-model.md](../security/threat-model.md)
