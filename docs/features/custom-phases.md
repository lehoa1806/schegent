# Custom Phases and Pipelines

Schegent ships no phases and no pipelines, so in a strict sense every definition in your catalog is a custom one. What this page covers is *authoring* — writing a definition yourself rather than importing it. The two produce identical rows; the distinction is only where the text came from.

## When to author rather than import

- You have a workflow step that no document you have covers — for example, "run lint and security scans before implement".
- You have a multi-step flow you want to reuse across runs — a pipeline with its own ordering.
- You want a loop phase with a non-default exit condition (e.g., "loop until a metric is zero" rather than the default `[SCHEGENT_STATUS: CLEAR]` sentinel).

If you just want to tune the model, effort, or timeout of a phase you already imported, you do not need to author a new one — see [Phase Overrides](phase-overrides.md).

If the phase you want already exists on someone else's machine, you do not need to retype it — see [Phase YAML Exchange](phase-yaml-exchange.md), which moves a phase definition between catalogs as a portable YAML document and never overwrites a phase you already have.

## Defining a new phase

You can define new phases visually via the **Pipeline Builder > Phases** dashboard, or manually by adding an entry to `schegent.phases`:

![Phase Builder](../assets/walkthrough/01_phase_builder.png)

```jsonc
{
  "schegent.phases": [
    {
      "id": "lint-and-scan",
      "name": "Lint and Scan",
      "instruction": "Run the linter and security scanner. If both pass, emit [SCHEGENT_STATUS: CLEAR] on the last line of stdout. If either fails, fix the reported issues and re-run. After three iterations, emit a SCHEGENT_AUDIT_LOG block summarizing the remaining issues and exit.",
      "model": "claude-sonnet-4-6",
      "effort": "medium",
      "loopable": true
    }
  ]
}
```

Field requirements:

- `id` — kebab-case, ≤ 64 chars (`^[a-z][a-z0-9-]{0,63}$`). No id is reserved. Reusing an id you already have in a lower-precedence scope shadows that row; reusing one within the same scope is a duplicate and both rows are quarantined.
- `name` — display name (1–80 chars).
- `instruction` or `skill` — exactly one non-empty directive is required for every source row.
- `loopable` — optional deprecated compatibility boolean.
- `sideEffects` — optional containment class: `none`, `workspace`, `git`, or `unrestricted`. **Omitted, it is `workspace`.** Declare it honestly — this is what the phase is permitted to write, and nothing infers it from the phase's name.
- `evidencePolicy` — optional: `required`, `best-effort`, or `none`. **Omitted, it is `required`.**

Optional fields (`model`, `effort`, `timeoutSeconds`, `retryCondition`) follow the same semantics as overrides; see [Phase Overrides](phase-overrides.md).

### Declaring Git side effects

A phase that commits, tags, or otherwise writes `.git` must say so and must run on a Git-capable runner:

```jsonc
{
  "id": "commit-and-tag",
  "name": "Commit and Tag",
  "instruction": "...",
  "sideEffects": "git",
  "runner": "claude"
}
```

Saving `sideEffects: git` with `runner: codex` is refused — Codex's workspace-write sandbox keeps `.git` read-only, so the phase would fail mid-run instead of at save time. The check reads the declaration, never the id: a phase called `finalize` that declares nothing is a `workspace` phase like any other, and a phase called `commit-and-tag` gets Git access because it asked for it.

## Using the new phase in a pipeline

A new phase id is only useful if some pipeline references it. Define a custom pipeline visually in the **Pipelines** dashboard, or manually in your settings:

![Pipeline Builder](../assets/walkthrough/02_pipeline_builder.png)

```jsonc
{
  "schegent.pipelines": [
    {
      "id": "speckit-with-security",
      "name": "Spec-kit (with lint and security)",
      "phases": [
        "speckit-specify",
        "speckit-clarify",
        "speckit-plan",
        "speckit-tasks",
        "speckit-analyze",
        "speckit-implement",
        "lint-and-scan",
        "finalize"
      ]
    }
  ]
}
```

Pipeline rules:

- `id` — kebab-case, ≤ 64 chars. No id is reserved; `speckit-new-feature` is simply the id the shipped example happens to use, and yours may reuse or replace it.
- `phases` — 1 to 50 entries. Each must reference one of your `schegent.phases[].id`, whether you authored it or imported it. Do **not** list `done` — it is the terminal state the host appends after your last phase, not a phase you declare.

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

```jsonc
"retryCondition": "open_questions > 0"
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

```jsonc
"retryCondition": "open_questions > 0"
"retryCondition": "unresolved_findings > 0 or open_questions > 0"
"retryCondition": "not (confidence > 0.85)"
"retryCondition": "(severity_high > 0 and severity_medium >= 3) or coverage < 80"
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

An invalid expression invalidates that source row. The catalog keeps the authored row visible with a field error so you can repair it, while runtime resolution falls back to the next valid workspace, user, or built-in source for the same id.

## Audit trail

Every phase flows through the same audit + redaction + transcript path; there is exactly one, and nothing is exempt from it. The audit payload for a `phase-start` event includes the `pipelineId`, `phaseId`, and (when set) `model` / `effort` / `timeoutMs`. There is no separate audit channel for phases you authored, because there is no privileged channel for anything else to use.

## Shadowing across scopes

If two rows share an `id` in different scopes, the higher-precedence one **shadows** the other. Shadowing rules:

- A shadow is a complete definition; omitted optional fields use runtime defaults and are not copied from the row it shadows. That includes `sideEffects` and `evidencePolicy` — a shadow that omits them is `workspace` and `required`, whatever the shadowed row declared.
- Workspace-layer entries shadow user-layer entries. The built-in layer sits below both and is permanently empty, so in practice there are two ranks with a third held open.

Shadowing is the right pattern when you want to tune a definition you imported without editing the document. Defining a new id is the right pattern when you want a new step.

## Worked example: custom bugfix pipeline

Suppose you want a smaller bugfix flow that skips the verify-pre phase:

```jsonc
{
  "schegent.pipelines": [
    {
      "id": "bugfix-fast",
      "name": "Bugfix (fast)",
      "phases": ["bugfix-report", "bugfix-patch", "bugfix-implement", "bugfix-verify-post"]
    }
  ]
}
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

```jsonc
{
  "schegent.phases": [
    {
      "id": "lint-and-scan",
      "name": "Lint and Scan",
      "instruction": "Run the linter and security scanner. Emit a SCHEGENT AUDIT LOG block with the severity counts.",
      "model": "claude-sonnet-4-6",
      "loopable": true,
      "retryCondition": "high_severity > 0 or medium_severity > 0"
    }
  ]
}
```

After the first iteration above, `high_severity > 0` is false and `medium_severity > 0` is true → decision is true → loop. The phase re-invokes. Eventually both are zero → decision is false → advance.

## Things to watch out for

- **Loop cap.** Even with a `retryCondition`, the loop hits `schegent.loop.maxIterations` (default 10). Force-advance fires beyond that.
- **Phase id collisions.** Two custom phases with the same id is a configuration error caught at load.
- **Pipeline that references a missing phase.** The pipeline is rejected; the audit log records the rejection.
- **The DSL is for boolean decisions.** Do not try to use it for arithmetic.

The next feature is [Verbose Diagnostics](verbose-diagnostics.md).
