# Workflow Control Flow Examples (`FR-R5-F35` / `SPEC-13`)

Importable Process YAML (`apiVersion: schegent/v1`, `kind: Workflow`) example packages demonstrating Schegent's four workflow control-flow and backend recovery mechanisms.

Consistent with hard rule 47 and `FR-R3-014`, **no Phase or Workflow definition is bundled inside the extension binary**. Each file below enters the catalog through the standard **Builder → Import…** preflight and confirmation flow.

## Example Packages

| File | Control Mechanism | Highlights |
|---|---|---|
| [`01-phase-repetition-and-branching.workflow.yaml`](01-phase-repetition-and-branching.workflow.yaml) | Standalone Phase repetition + exclusive routing (`SPEC-01`, `SPEC-02`) | `maxAttempts: 3`, `retryCapOutcome: continue`, `structured-result` operator (`pending_tasks == 0`), priority-ordered exclusive conditional edges |
| [`02-candidate-block-recovery.workflow.yaml`](02-candidate-block-recovery.workflow.yaml) | Multi-candidate fallback block (`SPEC-03`–`SPEC-10`) | 4 candidates across `claude`, `codex`, `agy`, and a second `codex` instruction contract; `availabilityPolicy: first-ready`; `allowUnverifiedTrial`; `strict-usd` budget; `decisionResults` export |
| [`03-scoped-workflow-repeat.workflow.yaml`](03-scoped-workflow-repeat.workflow.yaml) | Scoped child-Workflow `Repeat` (`SPEC-11`) | `maxIterations: 4`, post-pass `until` (`approved == true`), explicit `carry` (`nextFeedback -> feedback`, `score -> prior-score`), `onExhausted: pause` |
| [`04-sequential-workflow-foreach.workflow.yaml`](04-sequential-workflow-foreach.workflow.yaml) | Sequential child-Workflow `ForEach` (`SPEC-12`) | Contained `local-file` JSON collection (`{ "version": 1, "items": [...] }`), `itemKeyField: id`, `itemInputPortId: item-payload`, `maxItems: 50`, `onItemError: continue`, ordered `resultIndex` export |

## Operating Guidance

See the [Workflow Control Recovery Runbook](../../docs/operations/workflow-control-recovery.md) for runtime limits, check-versus-trial accounting, monitoring window renewal versus resume, strict USD spend pauses, uncertain-effect recovery, and retained evidence.

