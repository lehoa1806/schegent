# Custom Phases and Pipelines

Schegent ships no phases and no pipelines, so in a strict sense every definition in your catalog is a custom one. What this page covers is *authoring* — writing a definition yourself rather than importing it. The two produce identical rows; the distinction is only where the text came from.

## When to author rather than import

- You have a workflow step that no document you have covers — for example, "run lint and security scans before implement".
- You have a multi-step flow you want to reuse across runs — a pipeline with its own ordering.
- You want a loop phase with a non-default exit condition (e.g., "loop until a metric is zero" rather than the default `[SCHEGENT_STATUS: CLEAR]` sentinel).

If you just want to tune the model, effort, or timeout of a phase you already imported, you do not need to author a new one — see [Phase Overrides](phase-overrides.md).

If the phase you want already exists on someone else's machine, you do not need to retype it — see [Phase YAML Exchange](phase-yaml-exchange.md), which moves a phase definition between catalogs as a portable YAML document and never overwrites a phase you already have.

## Defining a new phase

You define new phases visually via the **Pipeline Builder > Phases** dashboard, or as a `schegent/v1` document you import:

![Phase Builder](../assets/walkthrough/01_phase_builder.png)

```yaml
apiVersion: schegent/v1
kind: Phase
metadata:
  phaseId: lint-and-scan
  name: Lint and Scan
  version: 1
spec:
  instruction: >-
    Run the linter and security scanner. If both pass, emit
    [SCHEGENT_STATUS: CLEAR] on the last line of stdout. If either fails, fix
    the reported issues and re-run. After three iterations, emit a
    SCHEGENT_AUDIT_LOG block summarizing the remaining issues and exit.
  model: claude-sonnet-4-6
  effort: medium
  loopable: true
```

Either way the result is the same: a phase definition in the catalog under `<workspaceRoot>/.schegent/catalog/`, at version 1. Every later save writes a new immutable version.

Field requirements:

- `phaseId` — kebab-case, ≤ 64 chars (`^[a-z][a-z0-9-]{0,63}$`). No id is reserved. It is the definition's identity: an import naming an id the catalog already holds is reported as `skip` rather than overwriting it.
- `name` — display name (1–80 chars).
- `instruction` or `skill` — exactly one non-empty directive is required on every definition. A definition is complete in itself; nothing is inherited.
- `loopable` — optional deprecated compatibility boolean.
- `sideEffects` — optional declared side effects: `none`, `workspace`, `git`, or `unrestricted`. **Omitted, it is `workspace`.** Declare it accurately, and know what the declaration buys: `git` and `unrestricted` get a consent prompt before the run and a rollback checkpoint, `none` and `workspace` get neither, and `git` additionally pins the phase to a Git-capable runner. **It is not a sandbox** — it does not restrict what the spawned subprocess may write, run, or send, because the backend runs with its approval prompts disabled regardless of what you declare (see [unprompted-agent-not-contained.md](../concepts/unprompted-agent-not-contained.md)). Nothing infers it from the phase's name.
- `evidencePolicy` — optional: `required`, `best-effort`, or `none`. **Omitted, it is `required`.**

Optional fields (`model`, `effort`, `timeoutSeconds`, `retryCondition`) follow the same semantics as overrides; see [Phase Overrides](phase-overrides.md).

### Declaring Git side effects

A phase that commits, tags, or otherwise writes `.git` must say so and must run on a Git-capable runner:

```yaml
metadata:
  phaseId: commit-and-tag
  name: Commit and Tag
  version: 1
spec:
  instruction: ...
  sideEffects: git
  runner: claude
```

Saving `sideEffects: git` with `runner: codex` is refused — Codex's workspace-write sandbox keeps `.git` read-only, so the phase would fail mid-run instead of at save time. The check reads the declaration, never the id: a phase called `finalize` that declares nothing is a `workspace` phase like any other, and a phase called `commit-and-tag` gets Git access because it asked for it.

## Using the new phase in a pipeline

A new phase id is only useful if some pipeline references it. Define a custom pipeline visually in the **Pipelines** dashboard, or as a document you import:

![Pipeline Builder](../assets/walkthrough/02_pipeline_builder.png)

```yaml
apiVersion: schegent/v1
kind: Pipeline
metadata:
  id: speckit-with-security
  name: Spec-kit (with lint and security)
  version: 1
spec:
  phaseIds:
    - speckit-specify
    - speckit-clarify
    - speckit-plan
    - speckit-tasks
    - speckit-analyze
    - speckit-implement
    - lint-and-scan
    - finalize
```

Pipeline rules:

- `id` — kebab-case, ≤ 64 chars. No id is reserved; `speckit-new-feature` is simply the id the shipped example happens to use, and yours may reuse or replace it.
- `phaseIds` — 1 to 50 entries. Each must reference a phase id your catalog holds, whether you authored it or imported it. Do **not** list `done` — it is the terminal state the host appends after your last phase, not a phase you declare.

If a referenced id is unknown at load time, the pipeline is rejected with a warning.

## Setting the default pipeline

`schegent.defaultPipelineId` ships **empty**. Until you set it, a launch that names no pipeline is refused with the missing id named — it does not fall back to anything, because there is nothing to fall back to. To make a pipeline the default, set:

```jsonc
{
  "schegent.defaultPipelineId": "speckit-with-security"
}
```

This sets the default selection in the enqueue dialog. You can still pick a different pipeline per task, and leaving the setting empty is a supported configuration rather than an unfinished one.

## Loopable phases

A phase with `loopable: true` is re-invoked until **one of two conditions** is met:

1. The phase's stdout last line equals `[SCHEGENT_STATUS: CLEAR]`. (Default exit.)
2. The configured `retryCondition` evaluates to false. (Custom exit — see below.)

Or until the iteration cap is reached (`schegent.loop.maxIterations`, default 10).

## Retry condition DSL

Loopable phases can declare a `retryCondition` expression that is evaluated against a structured metrics map the phase emitted. This lets you control the loop with a real expression instead of a hard-coded sentinel.

The host parses the phase's stdout for a `SCHEGENT AUDIT LOG` block of the form:

```text
=== SCHEGENT AUDIT LOG ===
open_questions: 3
unresolved_findings: 1
confidence: 0.78
=== END SCHEGENT AUDIT LOG ===
```

Each `<identifier>: <number>` line becomes an entry in the metrics map (the parser is whitespace-tolerant; only `<identifier>: <number>` lines are extracted). The expression in `retryCondition` is then evaluated:

```yaml
retryCondition: open_questions > 0
```

A truthy result means "loop"; a falsy result means "advance to the next phase".

### Supported syntax

- **Identifiers** — `[a-zA-Z_][a-zA-Z0-9_]*`, case-sensitive. Refer to metrics map keys.
- **Numeric literals** — signed numbers, e.g., `0`, `-1`, `3.14`.
- **Comparisons** — `>`, `>=`, `<`, `<=`, `==`, `!=`.
- **Boolean combinators** — `and` / `&&`, `or` / `||`.
- **Negation** — `not` / `!`.
- **Parentheses** — `(`, `)`.

Operator precedence (highest to lowest): `not` / `!` → comparisons → `and` / `&&` → `or` / `||`.

### Not supported

- Arithmetic (`+`, `-`, `*`, `/`).
- Function calls.
- Member access (`a.b`).
- String literals.
- Any kind of I/O.

The DSL is sandboxed by design (no arbitrary code, no eval). Any new evaluator that grows the surface must preserve these invariants.

### Examples

```yaml
retryCondition: open_questions > 0
retryCondition: unresolved_findings > 0 or open_questions > 0
retryCondition: not (confidence > 0.85)
retryCondition: (severity_high > 0 and severity_medium >= 3) or coverage < 80
```

### Decision audit trail

Each evaluation emits a `phase.retry_evaluated` audit event with:

- `pipelineId`
- `phaseId`
- `expression` — the DSL string evaluated.
- `metrics` — the extracted metrics map.
- `decision` — boolean. `true` means loop; `false` means advance.
- `missingKeys` — optional array. Identifiers in the expression that the metrics map did not contain.
- `evaluationError` / `errorMessage` — optional on parse/eval failure.

When `missingKeys` is non-empty, the expression evaluates as if those identifiers were `0` (or false, depending on context). When `evaluationError` is true, the host falls back to the default loop semantics (`[SCHEGENT_STATUS: CLEAR]` sentinel).

### Invalid expressions

An invalid expression invalidates that definition. The catalog keeps it visible with a field error so you can repair it. There is nothing to fall back to — one layer means an invalid definition costs only itself, and every other definition still resolves. The previous version of that definition is still in its history, so you can see what the expression was before you broke it.

## Writing a verification phase

**The host does not verify your phase.** It reads the phase's own audit block and
classifies the outcome from what the model wrote there; a phase resolving `clean`
advances the pipeline. Nothing runs your test suite, checks that the build still
compiles, or confirms that a declared output is correct — `resolveRunOutputs`
probes whether a declared output *exists*, which is a different question.

That is unavoidable in a design where the model is the worker, and it is stated
plainly here rather than left to be discovered: in an unattended pipeline, **the
only verification is the verification you author**. The same honesty appears in
`schegent.forceContinueOnRetryCap`, whose description says of a forced advance
that "whatever the condition gates is left unverified".

A verification phase is an ordinary phase whose instruction is to run the checks
and report what they said. What makes it useful is that its `retryCondition`
consults its own result, so a failing check keeps the pipeline on that phase
instead of advancing past it:

```yaml
metadata:
  phaseId: verify-build
  name: Verify Build
  version: 1
spec:
  instruction: |
    Run the project's full check chain. Do not fix anything and do not edit any
    file. Report, in the audit block, the exact command you ran, its exit code,
    and the failing output verbatim if it is non-zero.
  sideEffects: none
  evidencePolicy: required
  retryCondition: "exitCode != 0"
```

Three things make this a check rather than a formality:

- **`sideEffects: none`** — a verification phase that repairs what it finds is not a verification phase. Keep the phase that reports separate from the phase that fixes, or a green report may only mean the reporter fixed it quietly.
- **`evidencePolicy: required`** — the audit record is the only trace. A phase permitted to report without evidence can report anything.
- **A `retryCondition` that reads the result** — without one, a failing verification phase resolves and the pipeline advances past the failure it just recorded. See [Retry condition DSL](#retry-condition-dsl).

Place it after the phase whose work it checks, and remember what it cannot do: it
is still a model reporting on a command it ran. It narrows the gap between "said
it was done" and "was done"; it does not close it.

### Two things deliberately not built

**No Builder hint.** The Pipeline Builder does not warn that a pipeline contains
no verification phase. It was considered and declined: the Builder has no way to
tell a verification phase from any other, since "runs the checks" is a property
of an instruction rather than of a field, and a heuristic that guessed would
either nag correct pipelines or miss the ones that matter. A hint that is wrong
half the time trains an operator to dismiss it. The guidance lives here, where a
phase is authored, instead.

**No `[notify]` record for a self-certified advance.** `forceContinueOnRetryCap`
writes `[notify] forced-continue` to the runtime log when a phase advances with
its condition unsatisfied, and the same trace for "advanced on the model's own
verdict" was considered. It was not built, because *every* phase advance is
self-certified: a line written on all of them records nothing that distinguishes
one run from another, and a log line that always fires is noise with a timestamp.
The forced-continue case is different precisely because it is the exception. If
the host ever gains an independent oracle, the line becomes meaningful and worth
adding then.

## Audit trail

Every phase flows through the same audit + redaction + transcript path; there is exactly one, and nothing is exempt from it. The audit payload for a `phase-start` event includes the `pipelineId`, `phaseId`, and (when set) `model` / `effort` / `timeoutMs`. There is no separate audit channel for phases you authored, because there is no privileged channel for anything else to use.

## Editing versus defining a new id

There is one catalog and one definition per id, so tuning a phase you imported means **editing it** — nothing shadows anything, and there is no higher scope to author an override in. Two things make that safe:

- **The edit is versioned.** Every save writes a new immutable version and leaves the previous one readable, so you can see exactly what you changed a phase from. Saving unchanged content writes nothing.
- **Every definition is complete.** Omitted optional fields take runtime defaults; they are never inherited from the version you replaced. That includes `sideEffects` and `evidencePolicy` — a definition that omits them is `workspace` and `required`, whatever the version before it declared.

Editing is the right move when you want to tune a step you already have. Defining a new id is the right move when you want an additional step — the original stays untouched and both can appear in the same pipeline.

## Worked example: custom bugfix pipeline

Suppose you want a smaller bugfix flow that skips the verify-pre phase:

```yaml
apiVersion: schegent/v1
kind: Pipeline
metadata:
  id: bugfix-fast
  name: Bugfix (fast)
  version: 1
spec:
  phaseIds:
    - bugfix-report
    - bugfix-patch
    - bugfix-implement
    - bugfix-verify-post
```

You did not define any new phases — you reused the five bugfix phases from `examples/speckit-bugfix.pipeline.yaml` in a different order, which assumes you imported that document first. To use it, pick **Bugfix (fast)** in the enqueue dialog when you submit a task.

## Worked example: custom phase with retry condition

Suppose `lint-and-scan` (defined above) emits:

```text
=== SCHEGENT AUDIT LOG ===
high_severity: 0
medium_severity: 2
low_severity: 5
=== END SCHEGENT AUDIT LOG ===
```

You want it to loop until high and medium are zero (low can stay):

```yaml
apiVersion: schegent/v1
kind: Phase
metadata:
  phaseId: lint-and-scan
  name: Lint and Scan
  version: 2
spec:
  instruction: >-
    Run the linter and security scanner. Emit a SCHEGENT AUDIT LOG block with
    the severity counts.
  model: claude-sonnet-4-6
  loopable: true
  retryCondition: high_severity > 0 or medium_severity > 0
```

After the first iteration above, `high_severity > 0` is false and `medium_severity > 0` is true → decision is true → loop. The phase re-invokes. Eventually both are zero → decision is false → advance.

## Things to watch out for

- **Loop cap.** Even with a `retryCondition`, the loop hits `schegent.loop.maxIterations` (default 10). Force-advance fires beyond that.
- **Phase id collisions.** There cannot be two definitions with one id — the catalog is keyed by id. What you get instead is a `skip` on an import that names an id you already hold, which is the store declining to overwrite your work.
- **Pipeline that references a missing phase.** The pipeline is rejected; the audit log records the rejection.
- **The DSL is for boolean decisions.** Do not try to use it for arithmetic.

The next feature is [Verbose Diagnostics](verbose-diagnostics.md).
