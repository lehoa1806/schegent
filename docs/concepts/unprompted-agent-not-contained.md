# The agent runs unprompted

Status: Accepted product-boundary decision (2026-08-22)

Permission-posture: prompts-disabled

Schegent deliberately launches each backend non-interactively. Claude is the default runner. Claude and Agy are launched with `--dangerously-skip-permissions`; their approval prompts are off and the agent acts without asking. Codex is launched with `--sandbox workspace-write`, an OS-enforced filesystem bound that leaves `.git` read-only. No contributed setting restores backend approval prompts.

<!-- Source: src/runner/backend-runner-factory.ts -->
<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: src/runner/codex-cli.ts -->
<!-- Source: src/runner/agy-cli.ts -->
<!-- Source: package.json -->

## The consent modal did not change this posture

The posture line above stays `prompts-disabled`. A later change added a blocking modal at the containment refusal point: when the configured backend is not named in `schegent.backend.uncontainedBackends`, Schegent asks the operator once, writes the granted backend id into that setting at application scope, and re-drives the run. Reading that as "prompts are configurable now" and editing the line to `operator-configurable` is the edit this section exists to stop, because it would be false.

The modal decides whether Schegent will launch an uncontained backend at all. It does not restore the backend CLI's own approval prompts. `--dangerously-skip-permissions` is still passed on every Claude and Agy invocation, unconditionally, and a granted run behaves exactly as this document describes: the agent acts without asking. The grant is consent to start the process, not supervision of what it then does — one answer before one spawn, not a prompt per action. The sentence above, that no contributed setting restores backend approval prompts, is as true after the modal as before it.

The edit is also not cosmetic. `readPosture()` in the gate reads this line, and every assertion there guarded by `if (readPosture() !== 'prompts-disabled') return;` — the first-run gate that must be named on each onboarding surface, and the disclosure checks beside it — returns early under any other value. Changing the word fails nothing and silently retires those. The value moves when the backend CLIs are launched with their own prompts intact, which is the condition recorded below, and not before.

<!-- Source: src/activation/uncontained-consent.ts -->
<!-- Source: src/controller/uncontained-consent-gate.ts -->
<!-- Source: src/runner/backend-runner-factory.ts -->
<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: package.json -->
<!-- Source: tests/lint/backend-permission-posture.test.ts -->

## Decision

Approval prompts remain disabled for unattended runs. A prompt with nobody present to answer it becomes an invocation stall and eventually an idle timeout; the product currently has no supervised prompt-forwarding mode. This is an explicit privilege trade-off, not a safety guarantee.

<!-- Source: src/contracts/backend-runner.ts -->
<!-- Source: src/runner/process-lifecycle-runner.ts -->
<!-- Source: package.json -->

| Runner | Default | Effective permission posture | Source |
|---|---|---|---|
| `claude` | yes | Unsandboxed by Schegent; CLI prompts disabled by `--dangerously-skip-permissions`. | <!-- Source: src/runner/claude-cli.ts --><!-- Source: src/runner/backend-runner-factory.ts --> |
| `agy` | no | Unsandboxed by Schegent; CLI prompts disabled by `--dangerously-skip-permissions`. | <!-- Source: src/runner/agy-cli.ts --> |
| `codex` | no | `--sandbox workspace-write`; workspace writes allowed, `.git` writes refused by that bound. | <!-- Source: src/runner/codex-cli.ts --><!-- Source: src/config/phase-runner-policy.ts --> |

The three adapters share lifecycle mechanics such as `shell: false`, cancellation, timeout, and monitor output, but the permission posture is deliberately different.

<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: src/runner/process-lifecycle-runner.ts -->

## What `sideEffects` does

A Phase declares `sideEffects` as `none`, `workspace`, `git`, or `unrestricted`; omission resolves to `workspace`. The declaration selects the mutation plan, modal consent, and rollback checkpoint. It does not restrict the subprocess. A Phase declaring `sideEffects: git` is refused unless it uses a Git-capable runner—Claude or Agy—because the Codex sandbox keeps `.git` read-only.

<!-- Source: src/contracts/process-definitions.ts -->
<!-- Source: src/services/mutation-plan.ts -->
<!-- Source: src/services/workflow-run-factory.ts -->
<!-- Source: src/services/run-driver.ts -->
<!-- Source: src/config/phase-runner-policy.ts -->

| Declaration | Modal approval | Rollback checkpoint | Codex eligibility | Process restriction |
|---|---|---|---|---|
| `none` | no | no | allowed | none added |
| `workspace` or omitted | no | no | allowed | none added |
| `git` | yes | yes | refused | none added |
| `unrestricted` | yes | yes | allowed | none added |

<!-- Source: src/services/mutation-plan.ts -->
<!-- Source: src/services/workflow-run-factory.ts -->
<!-- Source: src/services/run-driver.ts -->
<!-- Source: src/config/phase-runner-policy.ts -->

The approval gate binds the operator's `Approve This Run` choice to the exact mutation-plan fingerprint. Dispatch rechecks the receipt, and a changed plan no longer matches it.

<!-- Source: src/activation/git-approval.ts -->
<!-- Source: src/services/workflow-run-factory.ts -->
<!-- Source: src/services/run-driver.ts -->

## Operator consequence

Use a repository you can restore. Workspace trust and the mutation approval reduce accidental authority, but neither verifies that a model action is correct. Codex is the narrower filesystem choice, while Claude remains the default and Agy follows Claude's prompt-disabled posture.

<!-- Source: src/ui/sidebar/message-router.ts -->
<!-- Source: src/runner/backend-runner-factory.ts -->
<!-- Source: src/runner/codex-cli.ts -->

## The condition that would reopen this

A first-class supervised execution mode would reopen the decision: the UI would need to surface a live backend approval prompt to an operator who is present, distinguish waiting-for-approval from model work, and suspend the idle timeout while the prompt is open. No such mode or IPC contract exists today.

<!-- Source: src/contracts/backend-runner.ts -->
<!-- Source: src/contracts/sidebar-ipc.ts -->
<!-- Source: src/runner/process-lifecycle-runner.ts -->

## How the decision is held

`tests/lint/backend-permission-posture.test.ts` reads the single `Permission-posture:` line, inspects the runner argv, and checks every disclosure surface. Changing this posture requires changing the decision and its code/tests together.

<!-- Source: tests/lint/backend-permission-posture.test.ts -->
