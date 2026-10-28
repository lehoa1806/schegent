# Custom Phases and Pipelines

Schegent starts with an empty catalog: it ships no active Phase, Pipeline, Workflow, model selection, or default Pipeline. Operators populate the catalog by importing one of the repository's `schegent/v1` documents or by authoring definitions in the Dashboard Builder.

<!-- Source: src/config/pipeline-config.ts -->
<!-- Source: examples/speckit-new-feature.pipeline.yaml -->
<!-- Source: examples/speckit-bugfix.pipeline.yaml -->
<!-- Source: webview-ui/src/dashboard/routes.ts -->

## Import a real Pipeline package

The repository includes `examples/speckit-new-feature.pipeline.yaml`, `examples/speckit-bugfix.pipeline.yaml`, and `examples/model-catalog.yaml`. Open the Dashboard Builder, run the process-YAML preflight, inspect the resource plan, then confirm publication. Preflight is read-only; publication uses the catalog lifecycle and its workspace-trust, primary-window, revision, and capability gates.

<!-- Source: examples/speckit-new-feature.pipeline.yaml -->
<!-- Source: examples/speckit-bugfix.pipeline.yaml -->
<!-- Source: examples/model-catalog.yaml -->
<!-- Source: src/services/process-yaml/preflight-service.ts -->
<!-- Source: src/ui/sidebar/commands/cmd-catalog-lifecycle.ts -->

The new-feature example declares Pipeline `speckit-new-feature` and includes nine real Phase definitions. It is data in `examples/`; nothing loads it automatically.

<!-- Source: examples/speckit-new-feature.pipeline.yaml -->
<!-- Source: src/config/pipeline-config.ts -->

## Phase definition reference

| Field | Contract |
|---|---|
| `phaseId` | Required identifier, maximum 64 characters. <!-- Source: src/contracts/process-definitions.ts --><!-- Source: src/config/process-definition-validator.ts --> |
| `name` | Required non-empty display name validated by the definition validator. <!-- Source: src/config/process-definition-validator.ts --> |
| `version` | Required positive integer in portable documents; catalog versions are immutable records. <!-- Source: src/services/process-yaml/phase-yaml-validator.ts --><!-- Source: src/contracts/catalog-store.ts --> |
| `instruction` / `skill` | Exactly one non-empty directive form. <!-- Source: src/contracts/process-definitions.ts --><!-- Source: src/config/process-definition-validator.ts --> |
| `runner` | Optional `claude`, `codex`, or `agy`. <!-- Source: src/contracts/process-definitions.ts --><!-- Source: src/runner/backend-runner-factory.ts --> |
| `model` | Optional backend model identifier. <!-- Source: src/contracts/process-definitions.ts --> |
| `effort` | Optional `low`, `medium`, `high`, `xhigh`, or `max`; Agy rejects the last two. <!-- Source: src/contracts/process-definitions.ts --><!-- Source: src/runner/agy-cli.ts --> |
| `timeoutSeconds` | Optional integer validated against the Phase timeout bounds. When present it **bounds this Phase's invocation**, overriding the workspace-wide `schegent.timeoutSeconds` default; when absent the workspace value applies. <!-- Source: src/config/process-definition-validator.ts --><!-- Source: src/controller/effective-phase-timeout.ts --> |
| `spendBoundUsd` / `spendBoundTokens` | Optional per-Phase spend bound, overriding the workspace default while this Phase runs. `spendBoundUsd` is a number from 0.01 to 10000; `spendBoundTokens` is an integer from 1 to 1000000000. Two fields because one number cannot carry two units: `claude` reports a cost, while `codex` and `agy` report tokens and no cost at all, so the bound in force follows what the backend reports. Precedence is **per denomination**: declaring only one leaves the operator's other bound in place. Crossing the bound pauses the run; it never fails or cancels it. <!-- Source: src/config/process-definition-validator.ts --><!-- Source: src/services/spend-bound.ts --> |
| `hostVerification` | Optional `model-token` or `exit-code`; decides who is believed when the host and the model disagree about the outcome. **Omission resolves to `exit-code` for any Phase whose `sideEffects` is other than `none`, or which produces a declared output** — and `sideEffects` itself resolves to `workspace` when omitted, so a Phase that declares nothing is judged on its process's exit status (`FR-R3-117`). Explicit `model-token` is the opt-out. <!-- Source: src/contracts/process-definitions.ts --><!-- Source: src/config/phase-runner-policy.ts --> |
| `capabilities` | Optional list of `workspace-write`, `outside-workspace-write`, `process-spawn`, `network`. **Omission grants every capability** and produces exactly the argv the Phase spawned with before this field existed; naming a subset withholds the rest by translating them into the chosen backend's own permission flags. A capability the backend cannot express refuses the Phase before it starts rather than running it unbounded. Enforcement is the backend CLI's, not the host's — see the threat model for that limit. <!-- Source: src/contracts/phase-capabilities.ts --><!-- Source: src/services/capability-enforcement-plan.ts --> |
| `sideEffects` | Optional `none`, `workspace`, `git`, or `unrestricted`; omission resolves to `workspace`. <!-- Source: src/contracts/process-definitions.ts --><!-- Source: src/config/process-catalog.ts --> |
| `evidencePolicy` | Optional `required`, `best-effort`, or `none`. **Declaring `required` withholds advancement**: a Phase that declares it and produces no audit block does not advance clean, and the record names the missing block as the cause. `best-effort` records an expectation not met and advances; `none` expects no block and says nothing. **Omission still resolves to `required` and still advances**, and that asymmetry is deliberate rather than a bug: the resolved default was written into every snapshot taken before the setting meant anything, so enforcing on it would retroactively change what advances for authors who said nothing. Enforcement follows the declaration, never the resolved value — so declaring `required` explicitly is not the same as leaving the field out. <!-- Source: src/contracts/process-definitions.ts --><!-- Source: src/config/pipeline-snapshot.ts --><!-- Source: src/parser/stdout-parser.ts --> |
| `loopable` | Optional compatibility boolean for legacy outcome looping. <!-- Source: src/contracts/process-definitions.ts --><!-- Source: src/controller/phase.ts --> |
| `retryCondition` | Optional non-empty expression, maximum 512 characters, parsed before the definition becomes effective. <!-- Source: src/contracts/process-definitions.ts --><!-- Source: src/config/process-definition-validator.ts --> |
| `isRequired` | Optional boolean; `false` lets a failed/timeout Phase advance. It also decides how a Pipeline ends: a required last Phase with no `retryCondition` that ends with remaining issues or open questions — including an exit 0 with no contract block — fails the Run instead of completing it, and resuming re-runs that Phase. With `false` the Run completes. <!-- Source: src/contracts/process-definitions.ts --><!-- Source: src/controller/phase.ts --> |
| `onRetryCap` | Optional `fail`, `continue`, or `continue-degraded`; decides what this Phase does when its `retryCondition` is still truthy at the final allowed iteration. `fail` ends the Phase failed with the cap-exhausted cause. `continue` advances with an explicit unverified warning and records nothing durable. `continue-degraded` advances *and* records on the Task that this Phase's condition was never satisfied, so the run stays distinguishable from a clean one after the run itself is gone. Omission inherits the workspace default; an unconfigured workspace resolves to `fail`. <!-- Source: src/contracts/process-definitions.ts --><!-- Source: src/contracts/retry-cap-outcome.ts --> |
| `forceContinueOnRetryCap` | **Deprecated by `onRetryCap`, and still loaded.** `true` means `continue`, `false` means `fail` — exactly what those values have always meant — so no pipeline file already on disk needs editing, now or later. The boolean covers two of the three outcomes and cannot reach `continue-degraded`. A Phase declaring both is resolved by `onRetryCap`. <!-- Source: src/contracts/process-definitions.ts --><!-- Source: src/contracts/retry-cap-outcome.ts --> |

`sideEffects` controls the mutation plan, consent, and rollback checkpoint; it does not restrict the backend. A Phase declaring `sideEffects: git` is refused unless it uses a Git-capable runner, because Codex's `workspace-write` sandbox keeps `.git` read-only.

<!-- Source: src/services/mutation-plan.ts -->
<!-- Source: src/services/run-driver.ts -->
<!-- Source: src/config/phase-runner-policy.ts -->

## Pipeline definition reference

A Pipeline orders Phase identities and declares inputs, outputs, position-addressed bindings, execution defaults, and recommended successors. A Phase ID may repeat; bindings therefore use `phaseIndex` rather than a bare ID. Pipeline IDs are bounded to 64 characters.

<!-- Source: src/contracts/pipeline-definitions.ts -->

The physical `speckit-new-feature` example orders these Phase IDs:

```yaml
phaseIds:
  - speckit-specify
  - speckit-clarify
  - speckit-plan
  - speckit-tasks
  - speckit-checklist
  - speckit-analyze
  - speckit-implement
  - speckit-code-review
  - speckit-security-review
  - finalize
```

<!-- Source: examples/speckit-new-feature.pipeline.yaml -->

## Retry conditions

The DSL supports identifiers, signed numbers, comparisons, `and`/`&&`, `or`/`||`, `not`/`!`, and parentheses. It does not support arithmetic, calls, member access, string literals, or I/O. Missing metrics are reported and evaluate as the evaluator's default numeric value; a parse/evaluation error is reported and treated as false at the transition boundary.

<!-- Source: src/lib/retry-condition.ts -->
<!-- Source: src/controller/phase.ts -->

The repository's real `speckit-implement` Phase declares:

```yaml
retryCondition: pending_tasks > 0
```

That Phase instructs the backend to emit a top-level `pending_tasks: <N>` metric in the audit block. A truthy result loops until the iteration cap; a falsy result advances.

From version 3 of the example the Phase also emits `spec_gaps`, `blocked_tasks` and `user_run_tasks`, and only `pending_tasks` feeds the condition. That is deliberate: a condition that counted a blocked task or a hand-off would repeat the iteration to the cap on something no further iteration can change. The Phase lists each open hand-off under `Hand-off tasks (for the user):` as `- <task id> (<basis>): <task text>`, outside `Remaining issues:`, and `user_run_tasks` equals the number it lists.

A task the agent cannot settle by the precedence its instruction gives it (the constitution, then `spec.md`, `plan.md`, `research.md`, `tasks.md`) is *blocked*: it is recorded in `<feature_dir>/decisions.md` as `Status: needs-maintainer`, left unchecked, and left out of `pending_tasks`. A blocked task is listed under `Remaining issues:`, and the Phase does not report `CLEAR` while one is open.

A *hand-off* is an incomplete task only a person can finish, in three cases and no other. Its own line in `tasks.md` carries the `USER-RUN` marker outside inline code, so a line that only quotes the marker in inline code is not marked. Or its own line names a person's approval as the condition, so review and test wording do not count. Or every other step is done and the only one left is pushing, opening or merging a pull request, watching CI, or deploying outside the repository. A task with implementation still undone is pending, however hard it is, and a failing test the agent can fix never makes a hand-off. Only the tasks Phase writes the `[USER-RUN]` label, and only on work that needs a person; the implement Phase never adds, removes or edits a marker or an approval wording, and never ticks a hand-off. A Phase with only hand-offs left reports `CLEAR`, so the Run advances after one iteration instead of spending its retries.

A Phase whose condition is falsy advances, even when it reported `Remaining issues:`. A blocked task or an open spec gap therefore makes implement report `Remaining issues:` and not `CLEAR`, and the Run still moves on to the reviews and `finalize`. `finalize` withholds its merge while a `needs-maintainer` decision is open, as described under [Author a verification Phase](#author-a-verification-phase), and because it is the last Phase its remaining issues fail the Run with the `last_phase_issues_remain` cause. None of this is a human gate the host enforces: the classification is prose the backend follows, the host checks no marker, basis or count, and a miscount shows in the hand-offs the Phase lists.

<!-- Source: examples/speckit-new-feature.pipeline.yaml -->
<!-- Source: src/controller/phase.ts -->

### When the condition is still true at the cap

`onRetryCap` decides that, per Phase, between three outcomes. The choice is about what an unsatisfied condition is worth to *this* Phase: a formatting check that never settles is not the same event as a test suite that never goes green, and before this field both were governed by one workspace-wide boolean.

| Outcome | What the Phase does | What survives |
|---|---|---|
| `fail` | Ends failed, with the cap-exhausted cause. | The ordinary failure record. |
| `continue` | Advances with an explicit unverified warning. | Nothing durable; the warning lives with the run. |
| `continue-degraded` | Advances, exactly as `continue` does. | A degraded mark on the **Task**, naming this Phase and the condition that was never satisfied. |

The mark is what separates the two continuing outcomes. It is captured onto the Task record rather than left on the run, so it is still there after the run is disposed of, and it is cleared when the Task is retried — a fresh attempt is not degraded by a previous one. Nothing else about the run changes: the fail path's behaviour, warning text, and cause value are exactly what they were.

**A degraded Phase does not fail, and so does not halt its queue.** Under the `halt-on-failure` policy a Queue stops admitting work when one of its rows ended `failed`; `continue-degraded` produces a Task that completed, so the Queue drains on. That is the intended trade and the reason the mark exists — see [Failure policy](../operations/multi-queue-concurrency.md#failure-policy-halting-a-queue-on-a-failed-task). Choose `fail` for a Phase whose unsatisfied condition should stop the queue.

<!-- Source: src/contracts/retry-cap-outcome.ts -->
<!-- Source: src/queue/queue-halt-policy.ts -->

## Author a verification Phase

The host does not verify your Phase. Outcome classification reads the backend's own audit report, and `resolveRunOutputs` checks whether a declared target exists rather than whether its content is correct. An unattended Pipeline therefore needs an ordinary Phase whose instruction runs the repository's real checks and reports their exit status.

<!-- Source: src/parser/stdout-parser.ts -->
<!-- Source: src/services/run-output/run-output-resolver.ts -->

For that verifier, declare `sideEffects: none` so the authored contract says it should report rather than repair, require evidence, and attach a `retryCondition` to the emitted failure metric so a failing report does not advance. The declaration is not process enforcement; the instruction and backend report still determine what happens.

<!-- Source: src/contracts/process-definitions.ts -->
<!-- Source: src/controller/phase.ts -->

The shipped example's `finalize` instruction already names the concrete check classes—build, tests, lint, and typecheck—and requires `checks_passing` and `checks_failing` metrics, but it is intentionally a repairing, Git-writing Phase rather than the read-only verifier described here.

From version 3 its repairs have a stated limit, because a headless run has nobody to ask. A failing dependency-audit check whose advisory is in a dependency the feature did not change may be fixed without approval, by a patch or minor bump of at most three packages in a `fix(deps)` commit of its own, which is reverted if it turns a green check red. A major bump, a forced or blanket update, an `overrides` or `resolutions` entry, a new or replaced dependency, and any change to an audit's threshold, ignore list or waiver are outside that authority and are reported under `Remaining issues:`. The merge to `develop` happens only when every check is green and `<feature_dir>/decisions.md` has no `Status: needs-maintainer` entry. Because `finalize` is the last Phase, remaining issues fail the Run with the `last_phase_issues_remain` cause, and under `halt-on-failure` they stop the Queue. This reduces the risk of a stalled run; it does not remove it, because the authority is prose the backend follows and the host does not enforce it.

<!-- Source: examples/speckit-new-feature.pipeline.yaml -->
<!-- Source: src/controller/phase.ts -->

## Versioning and publication

Catalog definitions are stored as immutable version records. Draft and active pointers derive the lifecycle state (`draft`, `active`, or `active-with-draft`). Saving, publishing, restoring, deactivating, and discarding use an expected draft token; stale callers are refused instead of overwriting a newer edit.

<!-- Source: src/contracts/catalog-lifecycle.ts -->
<!-- Source: src/catalog/lifecycle-service.ts -->
<!-- Source: src/catalog/catalog-store.ts -->

Phase authoring additionally requires the `phases` capability. A newly supplied body that declares `retryCondition` also requires the `retryConditions` capability. Publishing or restoring a Phase rechecks `phases`; deactivation and draft discard are removal operations and add no content capability gate.

<!-- Source: src/ui/sidebar/commands/cmd-catalog-lifecycle.ts -->
<!-- Source: src/state/capability-trust-resolver.ts -->

## The verdict basis, and why it still is not verification

Since `FR-R3-117` a Phase making a load-bearing claim is judged on its **process's exit
status** rather than on the model's account of its work: a clean termination token
cannot override a non-zero exit or a timeout. The shipped example,
`examples/speckit-new-feature.pipeline.yaml`, writes `hostVerification: exit-code` out
explicitly on every Phase that makes a verifiable claim, even though those Phases would
resolve to it anyway — an example is what an operator copies, and a Phase should say
what judges it rather than inherit it silently.

**A Phase that legitimately exits non-zero** — a linter used as a probe, a diff check
that reports difference by exit code — needs `hostVerification: model-token` to opt out.
That is the only way to get self-report on a load-bearing Phase, and choosing it is a
decision worth a comment in your document.

**This does not replace an independent verification Phase, and the advice above stands.**
Exit status proves the process did not report failure. It does not prove the work is
correct, and `resolveRunOutputs` checks that a declared output *exists*, not that it is
right. A Phase that runs the tests still tells you more than a Phase that says it did.

Every completed Run's evidence names which basis judged each Phase: `phase-end` carries
`verdictBasis`, so an audit can answer "was this believed, or checked?" per Phase.
<!-- Source: src/config/phase-runner-policy.ts -->
<!-- Source: docs/architecture/phase-verdict-default.md -->
