# Phase Overrides

Phase overrides let you tune individual phases — backend runner, model,
effort, timeout, instruction, and retry condition — without changing the
underlying built-in pipeline. User and workspace definitions use explicit
per-field precedence; the supported subset of per-run overrides is then
frozen onto the in-flight run.

## When to use overrides

- "I want `speckit-implement` to run with Opus and high effort, but keep everything else on defaults."
- "This workspace has a long test suite — bump the `finalize` timeout."
- "I want a loop phase to keep iterating until a custom metric is zero."
- "For this one task, run `speckit-clarify` on Sonnet to save credits."

Overrides do not change phase *order* or *count* — that is the job of a [Custom Pipeline](custom-phases.md#custom-pipelines). Overrides change the per-phase tunable parameters within an existing pipeline.

## The three override layers

In ascending precedence (later wins):

1. **Built-in defaults** — the values shipped in the extension.
2. **User-layer overrides** (`schegent.phases` in your **user** `settings.json`).
3. **Workspace-layer overrides** (`schegent.phases` in your **workspace** `settings.json`).
4. **Per-run overrides** — set in the enqueue dialog for one specific task.

The precedence rule applies **per field**:

- If `schegent.phases[speckit-implement].model` is set in the workspace layer to `opus`, that wins over a user-layer `sonnet`.
- If only `model` is set in the workspace and only `effort` in the user, the merge is `model: workspace-value, effort: user-value`.

The webview reads `snapshot.phasePrecedence` from the host projection — a `Record<"<phaseId>::<fieldKey>", "workspace" | "user" | "default">` map — so the UI can show which layer is winning for each field.

## The `schegent.phases` setting

The setting accepts an array of phase objects. See [Settings Reference → `schegent.phases`](../reference/settings.md#schegentphases) for the full schema.

A minimal override that bumps the implement model:

```jsonc
// User or workspace settings.json
{
  "schegent.phases": [
    {
      "id": "speckit-implement",
      "name": "Spec-kit Implement",
      "instruction": "",
      "model": "claude-opus-4-7",
      "effort": "high",
      "loopable": false
    }
  ]
}
```

Notes on the fields:

- `id` must match the built-in id (`speckit-specify`, `speckit-clarify`, `speckit-plan`, `speckit-tasks`, `speckit-analyze`, `speckit-implement`, `finalize`, `done`) to **shadow** the built-in.
- `name` is required by the JSON schema but is purely cosmetic when shadowing.
- `instruction` is required by the schema; an **empty string is accepted** when shadowing — the built-in's instruction is preserved.
- `runner`, `model`, `effort`, `timeoutSeconds`, and `retryCondition` are the fields you typically want to tweak.

## Shadowing a built-in vs. defining a new phase

| If your `id` is... | Result |
|---|---|
| A built-in id | **Shadow.** Your fields merge with the built-in (your fields win where present). |
| A new id | **New phase.** Becomes available for inclusion in custom pipelines. Cannot be used in built-in pipelines. |

To use a new phase id in a pipeline, define a custom pipeline (`schegent.pipelines`) that references it. See [Custom Phases](custom-phases.md#custom-pipelines).

## Per-run overrides

When you enqueue a task, the enqueue dialog has a **Phase Overrides** disclosure. Open it to override individual phase fields for that specific task only.

Per-run overrides are written to `WorkflowRun.phaseOverrides` when the task transitions to in-flight. They merge into the frozen pipeline snapshot with the highest precedence.

Per-run overrides are **not** read from settings; they are inputs to the run.

## The frozen snapshot rule

When a task transitions from `pending` to `in-flight`, the host **freezes** the effective pipeline (after merging all override layers) onto `WorkflowRun.pipeline`. From that moment on:

- Edits to `schegent.phases` in user or workspace settings have **no effect** on the in-flight run.
- Edits to `schegent.pipelines` likewise have no effect on the in-flight run.

This is by design. It lets the operator reconfigure for the *next* task without disrupting the one currently running. It also makes the audit trail deterministic — every `phase-start` event records the model and effort that were actually used, not what was configured at some later point.

To apply settings changes to the in-flight run, you must cancel it and re-enqueue.

## What you can override

Per field:

| Field | Description |
|---|---|
| `runner` | Backend kind: `claude` \| `codex` \| `agy`. Omit to inherit `schegent.backend.runner`, except Git-mutating built-ins described below. |
| `model` | Backend model id passed as a single argv element. |
| `effort` | Reasoning effort. Enum: `low` \| `medium` \| `high` \| `xhigh` \| `max`. |
| `timeoutSeconds` | Per-phase timeout (1–3600 seconds). Overrides `schegent.invocation.timeoutSeconds` for this phase only. |
| `instruction` | The phase's prompt directive. Empty string preserves the built-in. |
| `retryCondition` | Optional retry-condition DSL expression. |

What you cannot override:

| Field | Why |
|---|---|
| `id` | Identity; you cannot rename a phase via override. |
| Pipeline order | Order belongs to `schegent.pipelines`, not `schegent.phases`. |
| The set of phases in a pipeline | Same — use a custom pipeline. |
| Audit event payloads | The host emits whatever the runner produces; you cannot intercept. |

`speckit-specify`, `specify-brainstorm`, and `superpowers-implement` invoke
mandatory branch/worktree creation; `finalize` and `superpowers-review-close`
commit or change branches.
Their built-in runner is `claude`, and any override must explicitly select
`claude` or `agy`. Codex's `workspace-write` sandbox keeps `.git` read-only, so
Codex and Inherit are disabled for these rows and rejected again by host
validation.

## How precedence shows up in the sidebar

The sidebar's phase model overrides panel shows each phase with a precedence badge:

- **default** — no override; the built-in value applies.
- **user** — your user `settings.json` overrides the built-in.
- **workspace** — your workspace `settings.json` overrides the user layer.

When you change a field, the badge updates immediately to reflect the new precedence. You can see at a glance which layer is contributing each value.

The precedence projection is host-computed at `src/config/phase-precedence.ts`
(UI-only — never persisted or logged). The composite key shape is
`"<phaseId>::<fieldKey>"`; the Pipeline Builder consumes the `runner` key to
show its winning built-in, user, or workspace layer.

## Operational tips

### Run one phase with Opus, the rest with Sonnet

Define a single `schegent.phases` entry for the heavy phase:

```jsonc
{
  "schegent.phases": [
    {
      "id": "speckit-implement",
      "name": "Spec-kit Implement (Opus)",
      "instruction": "",
      "model": "claude-opus-4-7",
      "effort": "high",
      "loopable": false
    }
  ]
}
```

All other phases inherit the built-in default (which is Sonnet on default effort).

### Tighten a timeout for a specific phase

If `finalize` regularly stalls and you want it to fail faster:

```jsonc
{
  "schegent.phases": [
    {
      "id": "finalize",
      "name": "Finalize",
      "instruction": "",
      "runner": "claude",
      "timeoutSeconds": 600,
      "loopable": false
    }
  ]
}
```

This overrides the global `schegent.invocation.timeoutSeconds` for `finalize` only.

### Disable a phase

There is no `enabled` field on the schema. To disable a phase for a single run, use the per-run override surface in the enqueue dialog or via the in-run **phase-disabled** path (operator-initiated mid-run). To disable a phase across all runs, define a custom pipeline that omits it.

## Saving phase overrides

The sidebar settings panel uses a single helper, [`save-phases.ts`](https://github.com/your-org/schegent/blob/main/webview-ui/src/lib/save-phases.ts), as the only call site for the phase-save IPC command. The host re-validates the entire `schegent.phases` array on save.

A workspace-layer save is accepted even when the user layer shadows the same row — the shadow only affects the *effective* run-time value, not the persisted user-layer record. You can edit both layers independently.

## Custom phases (different idea)

If you want a new phase that is *not* a shadow of a built-in — a phase id of your own, with its own instruction, slotted into a custom pipeline — that is the territory of [Custom Phases](custom-phases.md). The mechanism is the same `schegent.phases` setting; the difference is whether the id matches a built-in.

Next: [Custom Phases](custom-phases.md) for defining new phases and pipelines.
