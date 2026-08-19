# Pipelines & Phases

A **pipeline** is an ordered list of phases that Schegent walks through for a single feature request. Schegent ships **no pipelines and no phases**. Every definition arrives by importing a process document at runtime, and `schegent.defaultPipelineId` ships empty. The extension package carries example documents under `examples/`; the Spec Driven Development workflow described below is one of them, not something compiled into the product. You select a pipeline when you enqueue a task, and a launch that resolves no pipeline is refused with importing named as the remedy rather than falling back to something you never chose.

This page explains what each phase of the shipped Spec Driven Development example does, the rules that govern phase execution, and how phase overrides let you tune individual phases without forking the whole pipeline.

## The Spec Driven Development workflow example (`speckit-new-feature`)

One document, `examples/speckit-new-feature.pipeline.yaml`, supplying one pipeline and the nine phases it names. Import it and the pipeline becomes selectable; skip it and nothing here exists.

| # | Phase id | Name | What Claude does in this phase |
|---|---|---|---|
| 1 | `speckit-specify` | Spec-kit Specify | Reads your feature description and produces `specs/<NNN-name>/spec.md`, the canonical specification. |
| 2 | `speckit-clarify` | Spec-kit Clarify | Reviews the spec for ambiguity and resolves clarification markers. Repeats while `open_questions > 0`. |
| 3 | `speckit-plan` | Spec-kit Plan | Drafts the implementation plan (`plan.md`) covering architecture, data model, and contract changes. |
| 4 | `speckit-tasks` | Spec-kit Tasks | Breaks the plan into discrete tasks in `tasks.md`. |
| 5 | `speckit-checklist` | Spec-kit Checklist | Generates a requirements-quality checklist under `checklists/`. Non-blocking — a missing checklist warns and proceeds. |
| 6 | `speckit-analyze` | Spec-kit Analyze | Audits the spec, plan, and tasks for cross-artifact consistency. Repeats while `critical_issues > 0`. |
| 7 | `speckit-implement` | Spec-kit Implement | Executes the tasks in order, writing code and tests until the feature is built. Repeats while `pending_tasks > 0`. |
| 8 | `speckit-review` | Spec-kit Review | Finishes any incomplete task, then loops code review and security review to zero findings. Repeats while any of the three counts is non-zero. |
| 9 | `finalize` | Finalize | Re-reads the implemented feature, regenerates any derived documentation, verifies the build and tests pass. |

The example declares none of `sideEffects`, `evidencePolicy`, or `loopable`, so all nine phases take the defaults described under [The phase definition](#the-phase-definition): `workspace` containment and `required` evidence. Repetition is driven by each phase's `retryCondition`, which the host consults whether or not `loopable` is set; `loopable` affects only the planned-total estimate the progress bar divides by.

The example ends at `finalize` and declares no `done` phase. `done` remains a terminal sentinel the host understands, but a pipeline is not obliged to name one.



## The phase definition

Each phase is a versioned JSON record. Every phase has these fields:

- **`id`** — a stable kebab-case identifier (regex `^[a-z][a-z0-9-]{0,63}$`). **No id is reserved and no id is privileged.** The ids above belong to the example document, not to the product; import it and they are yours, edit them and nothing objects. An id shadows another only within the scope precedence described below — workspace over user — and it grants no capability by being recognised, because nothing recognises it.
- **`name`** — display name used in the sidebar, audit log summaries, and pipeline picker (1–80 chars).
- **`description`** — optional operator-facing context (up to 1024 chars).
- **`version`** — a positive, host-owned revision. Legacy definitions load as version 1; changed rows increment on save.
- **`instruction`** or **`skill`** — exactly one directive. Instructions contain 1–8192 chars. A skill is a bounded declarative Agent CLI reference; the extension never reads or executes the referenced skill itself.
- **`model`** — optional Claude model id passed as `--model`. When omitted, the runner's default applies.
- **`effort`** — optional reasoning depth: one of `low`, `medium`, `high`, `xhigh`, `max`. Higher levels take longer and cost more but produce more thorough output.
- **`timeoutSeconds`** — optional per-phase idle-timeout override (1–3600). The timer resets on every CLI output chunk, so this caps idle time, not wall time. Falls back to `schegent.invocation.timeoutSeconds` if unset.
- **`loopable`** — whether this phase can be re-invoked automatically in response to a retry condition. Defaults to `false`. When `true`, the runner re-runs the phase until stdout signals `[SCHEGENT_STATUS: CLEAR]` or `schegent.loop.maxIterations` (default 10) is reached.
- **`retryCondition`** — optional, sandboxed DSL expression evaluated against the phase's audit metrics; controls whether the phase loops on non-fatal outcomes.
- **`isRequired`** — optional completion policy. Missing or `true` means a
  terminal failure stops the task. `false` allows the sequencer to continue
  after retry policy is exhausted and the phase ends as failed or timed out.
- **`sideEffects`** — optional containment class: one of `none`, `workspace`,
  `git`, `unrestricted`. It declares what the phase is permitted to write.
  **Omitted, it is `workspace`.** A phase declaring `git` must also declare a
  Git-capable runner (`claude` or `agy`), or the save is refused — Codex's
  workspace-write sandbox keeps `.git` read-only. That rule reads the
  declaration, never the id: a phase named `finalize` that declares no Git side
  effects is not treated as a Git phase, and a phase named anything at all that
  declares `git` is.
- **`evidencePolicy`** — optional: one of `required`, `best-effort`, `none`.
  **Omitted, it is `required`.**

Both defaults are the narrow end of their range, and both are chosen because the
phase said nothing rather than because the host recognised it. Earlier releases
derived the containment class from whether the id was one the extension shipped;
since no id is now, the class is declared or it is `workspace`.

### Optional phases

Optional phases still use the ordinary transient-error and rate-limit retry
policy. They continue only after the result is terminal `failed` or `timeout`;
verification pauses, breakpoints, manual pauses, and cancellation keep their
normal boundaries. The failed/timed-out phase remains visible in progression,
history, metrics, and the ordinary `phase-end` evidence. The task can complete
if all remaining required phases succeed, without promoting that phase result
to success or setting a terminal task `lastError`.

Each continuation emits `phase-optional-failure-continued` with structural
identifiers, runner, iteration, and termination reason only. Because
`isRequired` is captured in the immutable run snapshot, editing the catalog
does not change an already-enqueued run.

## How a phase actually runs

The host treats every phase invocation identically:

1. Read phase behavior from the immutable pipeline snapshot captured when the task was enqueued; unrelated runtime controls keep their documented dynamic behavior.
2. Compose the Claude CLI argv: prompt, model flag, effort flag, and the `--continue` flag if this invocation is a context-preserving retry.
3. Spawn the subprocess with a sanitized environment.
4. Stream stdout and stderr through the parser, the audit pipeline, and (if enabled) the verbose diagnostic sink.
5. Wait for the subprocess to exit or for the watchdog to fire.
6. Apply the retry condition (if loopable) and decide whether to advance, retry, or stop.

The phase is *the unit of orchestration*. Audit events fire at phase boundaries (`phase-start`, `phase-end`). Breakpoints attach to phase boundaries. Pauses take effect at the next phase boundary. Most things you care about as an operator happen at phase boundaries.

## Phase overrides

You rarely need to redefine an entire phase. More often you want to change one tunable without touching anything else — say, run `implement` with Opus instead of Sonnet, or extend `analyze`'s timeout for a particularly large feature.

Phase overrides live at two precedence levels:

- **User layer.** Settings under `schegent.phases` in your user `settings.json`. These apply across every workspace you open.
- **Workspace layer.** The same settings under `.vscode/settings.json` in a specific project. These take precedence over the user layer for that project only.

Resolution selects one complete valid source row per id: workspace first, then user, then built-in. An invalid higher-precedence row remains visible but is quarantined, allowing the next valid source to become effective. Source rows do not merge field-by-field.

The built-in layer is retained and permanently empty. It is read-only and is never a save target, so in practice a workspace row wins over a user row, and a lone user row wins outright. An import writes to whichever writable layer you pick in the import preflight — there is no default, and an unchosen scope never quietly resolves to the workspace. Nothing writes to the built-in layer.

### Concrete example

In your user `settings.json`:

```jsonc
{
  "schegent.phases": [
    {
      "id": "speckit-implement",
      "name": "Spec Driven Development Implement",
      "instruction": "...",
      "model": "claude-opus-4-7",
      "effort": "high"
    }
  ]
}
```

The setting takes an array of complete phase records. Workspace-scoped (`.vscode/settings.json`) entries take precedence over user-scoped ones, so a record here shadows a record with the same `id` in the user layer. The sidebar's host-computed `phasePrecedence` projection remains a UI-only compatibility indicator; runtime catalog resolution never merges rows per field.

Omitted optional fields use runtime defaults; they are not copied from a shadowed lower source. That includes `sideEffects` and `evidencePolicy` — a record that omits them is `workspace` and `required`, not whatever the row it shadows declared.

### What happens on save

When you save a phase-override change, the host:

1. Validates the new value against the field's allowed range.
2. Recomputes the `phasePrecedence` projection so the sidebar can show the new winning layer.
3. **Does not** retarget any in-flight `WorkflowRun.pipeline` snapshot. Active runs keep their frozen pipeline. The override takes effect for the *next* enqueued task.

This is intentional: phase definitions are configuration, not commands. To use a changed Phase definition, enqueue a new task; pausing and resuming an existing run preserves its frozen snapshot.

## Custom phases

Every phase is a custom phase now — the shipped example's nine are yours the moment you import them, and they are ordinary rows in your own settings afterwards. "Custom" here means only *authored by you rather than imported from the example*: nothing distinguishes the two once they are in the catalog. You might add a `security-scan` phase between `speckit-implement` and `finalize` that runs a prompt against the just-written code.

Phases:

- Are declared in `schegent.phases` with an `id`, `name`, positive `version`, and exactly one of `instruction` or `skill`; pipeline order is declared separately.
- All flow through *the same* audit pipeline: every `phase-start` and `phase-end` event carries the same fields, sanitization runs identically, and the verbose diagnostic sink captures everything. There is no second, privileged path — there is nothing left to be privileged.
- Are all subject to the same phase overrides (model, effort, timeout, loopable, retryCondition).

See [Custom Phases](../features/custom-phases.md) for the full reference.

## Loopable phases and the retry condition

A phase marked `loopable: true` can be re-run automatically when it ends in a non-fatal failure. The host evaluates the phase's `retryCondition` against the phase outcome; if the DSL expression returns `true`, the phase is re-invoked (preserving context if the operator armed `retryPhaseNow`, otherwise fresh).

The retry-condition DSL is intentionally narrow: no function calls, no member access, no I/O. It exposes a small set of fields about the phase outcome (`exitCode`, `stalled`, `rateLimited`, `fatalSignalMatched`) and a tiny grammar of comparisons and boolean combinators. It runs in a sandboxed evaluator.

For the actual grammar and the available fields, see [Phase Overrides](../features/phase-overrides.md).

## What is not a phase

A few things look phase-shaped but are not:

- **Manual retry-phase-now actions** are not new phases — they re-run the existing phase, optionally with `--continue` to preserve context.
- **Bugfix loop iterations** (an extension-point in Spec Driven Development workflow) run inside a phase, not as separate phases.

If something does not have a `phase-start` and `phase-end` event in the audit log, it is not a phase.

The next page, [The Queue, Tasks, and Runs](queue-and-runs.md), explains how phases combine into a single run and how runs are scheduled.
