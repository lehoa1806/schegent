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

The example declares none of `sideEffects`, `evidencePolicy`, or `loopable`, so all nine phases take the defaults described under [The phase definition](#the-phase-definition): `workspace` side effects and `required` evidence. Repetition is driven by each phase's `retryCondition`, which the host consults whether or not `loopable` is set; `loopable` affects only the planned-total estimate the progress bar divides by.

The example ends at `finalize` and declares no `done` phase. `done` remains a terminal sentinel the host understands, but a pipeline is not obliged to name one.



## The phase definition

Each phase is a versioned JSON record. Every phase has these fields:

- **`phaseId`** — a stable kebab-case identifier (regex `^[a-z][a-z0-9-]{0,63}$`). **No id is reserved and no id is privileged.** The ids above belong to the example document, not to the product; import it and they are yours, edit them and nothing objects. It is the definition's identity in the catalog — there is one definition per id, so an id never shadows another — and it grants no capability by being recognised, because nothing recognises it.
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
- **`sideEffects`** — optional declared side effects: one of `none`,
  `workspace`, `git`, `unrestricted`. **Omitted, it is `workspace`.** The
  declaration selects two things and refuses one. `git` and `unrestricted` get a
  consent prompt before the run and a rollback checkpoint; `none` and
  `workspace` get neither. And a phase declaring `git` must also declare a
  Git-capable runner (`claude` or `agy`), or the save is refused — Codex's
  workspace-write sandbox keeps `.git` read-only. That rule reads the
  declaration, never the id: a phase named `finalize` that declares no Git side
  effects is not treated as a Git phase, and a phase named anything at all that
  declares `git` is. What the declaration does **not** do is restrict the
  spawned subprocess: the backend runs with its approval prompts disabled
  whatever you declare, so this is consent bookkeeping rather than a sandbox
  (see [unprompted-agent-not-contained.md](unprompted-agent-not-contained.md)).
- **`evidencePolicy`** — optional: one of `required`, `best-effort`, `none`.
  **Omitted, it is `required`.**

Both defaults are the narrow end of their range, and both are chosen because the
phase said nothing rather than because the host recognised it. Earlier releases
derived the side-effects value from whether the id was one the extension
shipped; since no id is now, the value is declared or it is `workspace`.

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

There are two places a phase's fields can come from, and they are not two layers of the same thing:

- **The stored definition.** What the catalog holds for that id, under `<workspaceRoot>/.schegent/catalog/`. There is exactly one per id, and it applies to every run in that workspace.
- **Per-run overrides.** Set in the enqueue dialog for one specific task. They merge into the frozen snapshot and win for that run only; they are never stored in the catalog.

The stored side is a single layer. A definition either resolves or is reported **invalid** — there is no shadowing, no precedence to reason about, and no falling back to a lower scope. An invalid definition stays visible with its field errors so you can repair it, and it costs only itself.

### Concrete example

A `schegent/v1` document you import, or the equivalent typed into the Builder:

```yaml
apiVersion: schegent/v1
kind: Phase
metadata:
  phaseId: speckit-implement
  name: Spec Driven Development Implement
  version: 1
spec:
  instruction: ...
  model: claude-opus-4-7
  effort: high
```

Each definition is complete in itself. Omitted optional fields use runtime defaults; they are never inherited from anywhere. That includes `sideEffects` and `evidencePolicy` — a definition that omits them is `workspace` and `required`, whatever the version it replaced declared.

### What happens on save

When you save a phase change, the host:

1. Validates the complete definition against the field's allowed range, and rejects the save if the catalog moved under you since you were shown it.
2. Writes a new **immutable version** of the definition and points the manifest at it. Saving unchanged content writes nothing, so opening the editor and closing it cannot manufacture history.
3. **Does not** retarget any in-flight `WorkflowRun.pipeline` snapshot. Active runs keep their frozen pipeline. The change takes effect for the *next* enqueued task.

Step 3 is intentional: phase definitions are configuration, not commands. To use a changed Phase definition, enqueue a new task; pausing and resuming an existing run preserves its frozen snapshot. What a past run actually executed is in its frozen snapshot and its audit trail, not in whatever the catalog holds now.

## Custom phases

Every phase is a custom phase now — the shipped example's nine are yours the moment you import them, and they are ordinary definitions in your own catalog afterwards. "Custom" here means only *authored by you rather than imported from the example*: nothing distinguishes the two once they are in the catalog. You might add a `security-scan` phase between `speckit-implement` and `finalize` that runs a prompt against the just-written code.

Phases:

- Are stored in the catalog with a `phaseId`, `name`, positive `version`, and exactly one of `instruction` or `skill`; pipeline order is declared separately, by a pipeline definition.
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
