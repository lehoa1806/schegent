# Phase Overrides

Phase definitions let you tune individual phases — backend runner, model,
effort, timeout, directive, and retry condition — without changing pipeline
order. A phase definition is a **complete** record: the effective one is frozen
onto the Run when the task starts.

## When to use overrides

- "I want `speckit-implement` to run with Opus and high effort, but keep everything else as it is."
- "This workspace has a long test suite — bump the `finalize` timeout."
- "I want a loop phase to keep iterating until a custom metric is zero."
- "For this one task, run `speckit-clarify` on Sonnet to save credits."

Overrides do not change phase *order* or *count* — that is the job of a [Custom Pipeline](custom-phases.md#custom-pipelines). Overrides change the per-phase tunable parameters within an existing pipeline.

## Where phase definitions live

There is **one catalog**, stored under `<workspaceRoot>/.schegent/catalog/`.
Phase definitions are not settings and there are no `schegent.phases` /
`schegent.pipelines` / `schegent.workflows` keys; nothing about a phase is
resolved from `settings.json`.

That leaves two override layers rather than four:

1. **The stored phase definition** — what the catalog holds for that id.
2. **Per-run overrides** — set in the enqueue dialog for one specific task.

Because there is one layer, a definition either **resolves** or is reported
**invalid**. There is no shadowing, no precedence to reason about, and no
fallback to a lower layer. An invalid definition stays visible with its field
errors so you can repair it, and it costs only itself — every other definition
still resolves.

You get definitions into the catalog in one of two ways: edit them in the
Pipeline Builder, or import a `schegent/v1` YAML document. A minimal document
that runs the implement phase on Opus:

```yaml
apiVersion: schegent/v1
kind: Phase
metadata:
  phaseId: speckit-implement
  name: Spec-kit Implement
  version: 1
spec:
  instruction: Implement the approved plan.
  model: claude-opus-4-7
  effort: high
  loopable: false
```

Notes on the fields:

- `phaseId` is the identity. An import naming an id you already hold is
  reported as `skip` rather than overwriting it.
- Exactly one non-empty `instruction` or `skill` is required. A phase
  definition is complete in itself; nothing is inherited.
- `runner`, `model`, `effort`, `timeoutSeconds`, and `retryCondition` are the
  fields you typically want to tweak.

To use a phase in a pipeline, define a pipeline that references its id. See
[Custom Phases](custom-phases.md#custom-pipelines).

## Version history

Every save writes an **immutable new version** of the definition, so you can read
back what a phase looked like before you changed it. Two properties follow:

- **Saving unchanged content writes nothing.** Opening the editor and closing it
  cannot manufacture history — the content is hashed, and an identical body is a
  no-op.
- **History is bounded at 50 versions per definition**, pruned oldest-first. The
  active version is never pruned, and neither is any version a retained run
  still references — an exemption that is wired now and becomes load-bearing when
  run history starts recording which version it ran.

## Per-run overrides

When you enqueue a task, the enqueue dialog has a **Phase Overrides** disclosure. Open it to override individual phase fields for that specific task only.

Per-run overrides are written to `WorkflowRun.phaseOverrides` when the task transitions to in-flight. They merge into the frozen pipeline snapshot and win over the stored definition.

Per-run overrides are **not** stored in the catalog; they are inputs to the run.

## The frozen snapshot rule

When a task transitions from `pending` to `in-flight`, the host **freezes** the effective pipeline (after applying per-run overrides) onto `WorkflowRun.pipeline`. From that moment on:

- Edits to a phase definition have **no effect** on the in-flight run.
- Edits to a pipeline definition likewise have no effect on the in-flight run.

This is by design. It lets the operator reconfigure for the *next* task without disrupting the one currently running. It also makes the audit trail deterministic — every `phase-start` event records the model and effort that were actually used, not what was configured at some later point.

To apply catalog changes to the in-flight run, you must cancel it and re-enqueue.

## What you can override

Per field:

| Field | Description |
|---|---|
| `runner` | Backend kind: `claude` \| `codex` \| `agy`. Omit to inherit `schegent.backend.runner`. |
| `model` | Backend model id passed as a single argv element. |
| `effort` | Reasoning effort. Enum: `low` \| `medium` \| `high` \| `xhigh` \| `max`. |
| `timeoutSeconds` | Per-phase timeout (1–3600 seconds). Overrides `schegent.invocation.timeoutSeconds` for this phase only. |
| `instruction` or `skill` | Exactly one non-empty prompt directive is required on each definition. |
| `retryCondition` | Optional retry-condition DSL expression. |
| `sideEffects` | What the phase may write: `none` \| `workspace` \| `git` \| `unrestricted`. Omitted, it is `workspace`. |
| `evidencePolicy` | How strictly evidence is enforced: `required` \| `best-effort` \| `none`. Omitted, it is `required`. |

What you cannot override:

| Field | Why |
|---|---|
| `phaseId` | Identity; you cannot rename a phase via override. |
| Pipeline order | Order belongs to the pipeline definition, not the phase. |
| The set of phases in a pipeline | Same — edit the pipeline. |
| Audit event payloads | The host emits whatever the runner produces; you cannot intercept. |

**Nothing is privileged by name.** A phase that commits or changes branches must
**declare** `sideEffects: git`, and a phase declaring `git` must also declare a
runner that can write Git metadata or the save is refused. A phase called
`finalize` that declares no Git side effects is not treated as a Git phase, and
a phase called anything at all that declares `git` is.

## Editing in the sidebar

The sidebar's phase editor shows each phase with its current field values and
the version history behind it. There is no precedence badge: with one catalog
layer there is only ever one source for a value, so a badge naming that source
would say the same thing on every field.

## Operational tips

### Run one phase with Opus, the rest with Sonnet

Set `model` on the heavy phase and leave the others alone:

```yaml
apiVersion: schegent/v1
kind: Phase
metadata:
  phaseId: speckit-implement
  name: Spec-kit Implement (Opus)
  version: 1
spec:
  instruction: Implement the approved plan and verify the result.
  model: claude-opus-4-7
  effort: high
  loopable: false
```

Every other phase keeps whatever its own definition declares.

### Tighten a timeout for a specific phase

If `finalize` regularly stalls and you want it to fail faster:

```yaml
apiVersion: schegent/v1
kind: Phase
metadata:
  phaseId: finalize
  name: Finalize
  version: 1
spec:
  instruction: Finalize the run, verify the evidence, and commit the approved changes.
  runner: claude
  sideEffects: git
  timeoutSeconds: 600
  loopable: false
```

This overrides the global `schegent.invocation.timeoutSeconds` for `finalize` only.

### Disable a phase

There is no `enabled` field on the schema. To disable a phase for a single run, use the per-run override surface in the enqueue dialog or via the in-run **phase-disabled** path (operator-initiated mid-run). To disable a phase across all runs, edit the pipeline to omit it.

## Saving phase overrides

The sidebar settings panel uses a single helper, [`save-phases.ts`](https://github.com/your-org/schegent/blob/main/webview-ui/src/lib/save-phases.ts), as the only call site for the phase-save IPC command. The host re-validates the complete definition on save and gates the write on the catalog revision you were shown — if someone else changed the catalog first, the save is refused as stale rather than silently overwriting their work.

## Custom phases (different idea)

If you want a new phase — a phase id of your own, with its own instruction,
slotted into a custom pipeline — that is the territory of
[Custom Phases](custom-phases.md). The mechanism is the same catalog; the
difference is whether the id is one you already hold.

Next: [Custom Phases](custom-phases.md) for defining new phases and pipelines.
