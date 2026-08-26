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
| `hostVerification` | Optional `model-token` or `exit-code`; decides who is believed when the host and the model disagree about the outcome. Omission resolves to `model-token`. <!-- Source: src/contracts/process-definitions.ts --> |
| `capabilities` | Optional list of `workspace-write`, `outside-workspace-write`, `process-spawn`, `network`. **Omission grants every capability** and produces exactly the argv the Phase spawned with before this field existed; naming a subset withholds the rest by translating them into the chosen backend's own permission flags. A capability the backend cannot express refuses the Phase before it starts rather than running it unbounded. Enforcement is the backend CLI's, not the host's — see the threat model for that limit. <!-- Source: src/contracts/phase-capabilities.ts --><!-- Source: src/services/capability-enforcement-plan.ts --> |
| `sideEffects` | Optional `none`, `workspace`, `git`, or `unrestricted`; omission resolves to `workspace`. <!-- Source: src/contracts/process-definitions.ts --><!-- Source: src/config/process-catalog.ts --> |
| `evidencePolicy` | Optional `required`, `best-effort`, or `none`; omission resolves to `required`. <!-- Source: src/contracts/process-definitions.ts --><!-- Source: src/config/process-catalog.ts --> |
| `loopable` | Optional compatibility boolean for legacy outcome looping. <!-- Source: src/contracts/process-definitions.ts --><!-- Source: src/controller/phase.ts --> |
| `retryCondition` | Optional non-empty expression, maximum 512 characters, parsed before the definition becomes effective. <!-- Source: src/contracts/process-definitions.ts --><!-- Source: src/config/process-definition-validator.ts --> |
| `isRequired` | Optional boolean; `false` lets a failed/timeout Phase advance. <!-- Source: src/contracts/process-definitions.ts --><!-- Source: src/controller/phase.ts --> |
| `forceContinueOnRetryCap` | Optional boolean; when true, a still-truthy condition at the cap advances with an explicit unverified warning. <!-- Source: src/contracts/process-definitions.ts --><!-- Source: src/controller/phase.ts --> |

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
  - speckit-review
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

<!-- Source: examples/speckit-new-feature.pipeline.yaml -->
<!-- Source: src/controller/phase.ts -->

## Author a verification Phase

The host does not verify your Phase. Outcome classification reads the backend's own audit report, and `resolveRunOutputs` checks whether a declared target exists rather than whether its content is correct. An unattended Pipeline therefore needs an ordinary Phase whose instruction runs the repository's real checks and reports their exit status.

<!-- Source: src/parser/stdout-parser.ts -->
<!-- Source: src/services/run-output/run-output-resolver.ts -->

For that verifier, declare `sideEffects: none` so the authored contract says it should report rather than repair, require evidence, and attach a `retryCondition` to the emitted failure metric so a failing report does not advance. The declaration is not process enforcement; the instruction and backend report still determine what happens.

<!-- Source: src/contracts/process-definitions.ts -->
<!-- Source: src/controller/phase.ts -->

The shipped example's `finalize` instruction already names the concrete check classes—build, tests, lint, and typecheck—and requires `checks_passing` and `checks_failing` metrics, but it is intentionally a repairing, Git-writing Phase rather than the read-only verifier described here.

<!-- Source: examples/speckit-new-feature.pipeline.yaml -->

## Versioning and publication

Catalog definitions are stored as immutable version records. Draft and active pointers derive the lifecycle state (`draft`, `active`, or `active-with-draft`). Saving, publishing, restoring, deactivating, and discarding use an expected draft token; stale callers are refused instead of overwriting a newer edit.

<!-- Source: src/contracts/catalog-lifecycle.ts -->
<!-- Source: src/catalog/lifecycle-service.ts -->
<!-- Source: src/catalog/catalog-store.ts -->

Phase authoring additionally requires the `phases` capability. A newly supplied body that declares `retryCondition` also requires the `retryConditions` capability. Publishing or restoring a Phase rechecks `phases`; deactivation and draft discard are removal operations and add no content capability gate.

<!-- Source: src/ui/sidebar/commands/cmd-catalog-lifecycle.ts -->
<!-- Source: src/state/capability-trust-resolver.ts -->
