# Pipelines & Phases

A **pipeline** is an ordered list of phases that Schegent walks through for a single feature request. Schegent ships with a built-in pipeline — the standard Spec Driven Development workflow pipeline — and lets you define your own. You select a pipeline when you enqueue a task; the default is set by `schegent.defaultPipelineId` (which itself defaults to `speckit-new-feature`).

This page explains what each built-in phase does, the rules that govern phase execution, and how phase overrides let you tune individual phases without forking the whole pipeline.

## The Spec Driven Development workflow pipeline (`speckit-new-feature`)

Eight phases in order. The first six are operator-visible work; the last two are completion sentinels.

| # | Phase id | Loopable | What Claude does in this phase |
|---|---|---|---|
| 1 | `speckit-specify` | no | Reads your feature description and produces `specs/<NNN-name>/spec.md`, the canonical specification. |
| 2 | `speckit-clarify` | yes | Reviews the spec for ambiguity and resolves clarification markers. Loops until no open questions remain or the loop cap fires. |
| 3 | `speckit-plan` | no | Drafts the implementation plan (`plan.md`) covering architecture, data model, and contract changes. |
| 4 | `speckit-tasks` | no | Breaks the plan into discrete tasks in `tasks.md`. |
| 5 | `speckit-analyze` | yes | Audits the spec, plan, and tasks for cross-artifact consistency. Loops while consistency issues remain (up to the loop cap). |
| 6 | `speckit-implement` | no | Executes the tasks in order, writing code and tests until the feature is built. |
| 7 | `finalize` | no | Re-reads the implemented feature, regenerates any derived documentation, verifies the build and tests pass. |
| 8 | `done` | no | Terminal sentinel — emits the closing audit events and releases the run cleanly. |



## The phase definition

Each phase is a versioned JSON record. Every phase has these fields:

- **`id`** — a stable kebab-case identifier (regex `^[a-z][a-z0-9-]{0,63}$`). Built-in pipelines use the ids above; the bare names `specify`, `clarify`, `plan`, `tasks`, `analyze`, `implement`, `finalize`, `done` are reserved so a custom phase declared with one of those ids *shadows* (replaces) the built-in.
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

The setting takes an array of complete phase records. A custom record whose `id` matches a built-in phase id *shadows* the built-in. Workspace-scoped (`.vscode/settings.json`) entries take precedence over user-scoped ones. The sidebar's host-computed `phasePrecedence` projection remains a UI-only compatibility indicator; runtime catalog resolution never merges rows per field.

Omitted optional fields use runtime defaults; they are not copied from a shadowed lower source.

### What happens on save

When you save a phase-override change, the host:

1. Validates the new value against the field's allowed range.
2. Recomputes the `phasePrecedence` projection so the sidebar can show the new winning layer.
3. **Does not** retarget any in-flight `WorkflowRun.pipeline` snapshot. Active runs keep their frozen pipeline. The override takes effect for the *next* enqueued task.

This is intentional: phase definitions are configuration, not commands. To use a changed Phase definition, enqueue a new task; pausing and resuming an existing run preserves its frozen snapshot.

## Custom phases

The pipeline is not closed to seven phases. You can extend it with your own — for example, a `security-scan` phase between `implement` and `finalize` that runs a custom prompt against the just-written code.

Custom phases:

- Are declared in `schegent.phases` with an `id`, `name`, positive `version`, and exactly one of `instruction` or `skill`; pipeline order is declared separately.
- Flow through *the same* audit pipeline as built-ins: every `phase-start` and `phase-end` event carries the same fields, sanitization runs identically, and the verbose diagnostic sink captures everything.
- Are subject to the same phase overrides as built-ins (model, effort, timeout, loopable, retryCondition).

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
