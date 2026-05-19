# Release Notes

This file is a chronological summary of operator-visible changes
across Schegent features. The authoritative per-feature spec lives at
`specs/<NNN-name>/spec.md`; this file is the digest.

---

## Feature 013 — Correctness & Trust-Boundary Refactor

Branch: `013-correctness-trust-refactor`

### TL;DR

A 9-wave refactor focused on shippable build trustworthiness and
trust-boundary correctness. Every wave is independently testable and
landed as a separate commit.

### Operator-visible changes

| Area | Change |
|------|--------|
| **Release gate** | `npm run ci` now runs the integration suite; `npm run ci:fast` covers everything except integration for pre-commit / IDE loops. Four previously-excluded safety tests are either back in the suite or have a recorded rationale. |
| **Run-start path** | All run-start surfaces (auto, schedule, webview start/schedule, rerun-from-history, retry-active-run) now route through a single `GuardedRunService`. A lint regression test forbids drive-by enqueue/startNew calls. |
| **Outcome semantics** | The parser/runner outcome precedence is documented and enforced: fatal-signature > rate-limit > parser-failure > CLI exit code > stdout clear-token. Non-zero exit can no longer surface as `clean`. |
| **Pause-reason hygiene** | `pausedReason` strings are now sanitized through the canonical `SanitizedLogger` redaction set at the projector boundary and capped at 500 chars. The IPC validator mirrors the cap. |
| **IPC contracts** | Runtime validators live canonically in `src/contracts/`. `src/ui/sidebar/` thinly imports them. A lint test fails the build on drift. |
| **History rerun fidelity** | New history entries persist the full sanitized `originalDescription`. Rerun uses the full description; legacy entries trigger a one-line operator warning instead of silently falling back to the 80-char preview. |
| **God-object decomposition** | `WorkflowController` and `StateProjector` are decomposed into focused modules with byte-identical observable output. The split is verified by an audit-event parity test. See `specs/013-correctness-trust-refactor/decisions.md` for scope rationale. |
| **Prompt argv exposure** | `ClaudeCliRunner` detects whether the installed Claude CLI supports `--prompt-file` or `--prompt-stdin`, and when supported, the prompt body is no longer visible in `ps` / `/proc/<pid>/cmdline`. Legacy `-p` fallback preserved. `shell: false` is enforced via `safeSpawn()` on every transport. |
| **Product metadata** | `LICENSE.md` carries the canonical MIT body; `package.json` repository/bugs URLs point at the canonical project; a `docs/operations/licenses.md` playbook documents the quarterly license-review cadence. |

### Compatibility

- **State**: No `STATE_SCHEMA_VERSION` bump.
- **History**: `originalDescription` is an additive optional field; legacy
  entries continue to load. Reruns from legacy entries emit a one-time
  warning so operators know they're on the truncated path.
- **CLI transport**: `ClaudeCliRunner` defaults `probeTransport` to `false`
  internally for test fixtures. Production (`src/extension.ts`) opts in
  to probing. Operators on a CLI that predates the new transports see
  no behavior change.

### Things this refactor did NOT do

- The `RunDriver` and `RetryCoordinator` extractions (T096/T097) were
  intentionally deferred — the `lockReleased` flag pattern in
  `WorkflowController.driveRun()` is load-bearing and the byte-identical
  FR-035 contract makes mechanical extraction risky. See
  `specs/013-correctness-trust-refactor/decisions.md` for the long-form
  rationale.

### See also

- Spec: `specs/013-correctness-trust-refactor/spec.md`
- Plan: `specs/013-correctness-trust-refactor/plan.md`
- Tasks (with completion notes): `specs/013-correctness-trust-refactor/tasks.md`
- Decisions: `specs/013-correctness-trust-refactor/decisions.md`
- Threat model updates: `docs/security/threat-model.md` T15, T16.

---

## Feature 014 — Wake up

Adds an OS-scheduled wake-up runner that pre-warms the Claude CLI five-hour rolling allocation so credit returns before the next phase boundary.

- Spec: [specs/014-wake-up/spec.md](../../../specs/014-wake-up/spec.md)
- Landing commit: [166401a](https://github.com/lehoa1806/schegent/commit/166401a0af08ce5150356da55a3a39a4f748d601)

---

## Feature 019 — Runtime Debug Log Service

Adds a runtime log sink with operator-configurable level and file path, sharing the canonical `SanitizedLogger` redaction set so log lines on disk are pre-redacted.

- Spec: [specs/019-runtime-debug-log/spec.md](../../../specs/019-runtime-debug-log/spec.md)
- Landing commit: [7c81de6](https://github.com/lehoa1806/schegent/commit/7c81de6918e24166f67b336caf9b2738d4d3ad25)

---

## Feature 020 — Phase-Level Log Management

Adds a phase-level log feed with hierarchical drill-in (queue → task → pipeline → phase → iteration), host-sanitized at the IPC boundary.

- Spec: [specs/020-phase-level-logs/spec.md](../../../specs/020-phase-level-logs/spec.md)
- Landing commit: [72f9656](https://github.com/lehoa1806/schegent/commit/72f9656d4dff13f1e3fcda1106dbf7b8ebe14971)

---

## Feature 022 — Unrestricted Task & Phase Deletion with Confirmation

Lifts the in-flight-only restriction on task and phase deletion, gating destructive removals behind an operator confirmation prompt.

- Spec: [specs/022-unrestricted-deletion/spec.md](../../../specs/022-unrestricted-deletion/spec.md)
- Landing commit: [565a898](https://github.com/lehoa1806/schegent/commit/565a898464a59fa242cadcd747d7a414d9a45a9d)

---

## Feature 026 — Phase-Level Effort Configuration and Spec-kit Bugfix Pipeline

Adds per-phase model and effort overrides plus a Spec-Kit bugfix pipeline; user/workspace precedence is computed in a UI-only host projection.

- Spec: [specs/026-phase-effort-bugfix-pipeline/spec.md](../../../specs/026-phase-effort-bugfix-pipeline/spec.md)
- Landing commit: [6dc6965](https://github.com/lehoa1806/schegent/commit/6dc69653db32eac81eb7c35ec45df3bc5737b5cd)

---

## Feature 027 — Dynamic Quota Reset Countdown

Replaces the fixed 60-minute rate-limit backoff with a dynamic schedule derived from the parsed Claude CLI reset epoch.

- Spec: [specs/027-dynamic-quota-reset-countdown/spec.md](../../../specs/027-dynamic-quota-reset-countdown/spec.md)
- Landing commit: [89fc24b](https://github.com/lehoa1806/schegent/commit/89fc24b1ddf1eec9e647dd33bf62bf5958a6273f)

---

## Feature 028 — Advanced Phase Pausing

Adds operator-set phase breakpoints and decouples queue-pause source attribution so operator-initiated queue pauses survive cascade-resume.

- Spec: [specs/028-advanced-phase-pausing/spec.md](../../../specs/028-advanced-phase-pausing/spec.md)
- Landing commit: [0efa49d](https://github.com/lehoa1806/schegent/commit/0efa49d69e4f2689eb17f64af2bcffa141d2990c)

---

## Feature 029 — Human-Readable Activity Feed Logs

Reshapes the activity feed so tool calls, metadata, and audit footers render as structured rows, with operator-influenced strings host-sanitized at the IPC boundary.

- Spec: [specs/029-human-readable-activity-logs/spec.md](../../../specs/029-human-readable-activity-logs/spec.md)
- Landing commit: [3ee88ba](https://github.com/lehoa1806/schegent/commit/3ee88bab50646a8e583e26a193e1bdb3f1f13b07)

---

## Feature 030 — Single Task Queue Migration

Migrates the queue registry to a single-queue model with operator-driven reorder UX; legacy multi-queue commands and the rename/delete/schedule surface are retired.

- Spec: [specs/030-single-task-queue/spec.md](../../../specs/030-single-task-queue/spec.md)
- Landing commit: [989ee31](https://github.com/lehoa1806/schegent/commit/989ee31ad4b77ddc6dc31df0ef9fb56fc3b8254c)

---

## Feature 031 — Advanced Wake Up Logs & Model Selection

Adds a closed-registry model picker for wake-up invocations plus a per-correlation on-disk session log under globalStorage.

- Spec: [specs/031-advanced-wakeup-logs-models/spec.md](../../../specs/031-advanced-wakeup-logs-models/spec.md)
- Landing commit: [f40d02c](https://github.com/lehoa1806/schegent/commit/f40d02c948f16908a7fd1e776867eb89447d2e19)

---

## Feature 032 — Context-Preserving Phase Retries, Restarts, and Resumes

Injects the Claude CLI continuation flag (`-c`) on retry, resume, and restart-active dispatches so the agent retains context across recovery boundaries.

- Spec: [specs/032-context-preserving-retries/spec.md](../../../specs/032-context-preserving-retries/spec.md)
- Landing commit: [c5f9654](https://github.com/lehoa1806/schegent/commit/c5f9654c2ccb6cfcafdde1a8010ea9c863877384)

---

## Feature 033 — Aggressive Phase Pausing and Process Telemetry

Switches the manual-pause path to an aggressive subprocess kill, plus an ephemeral per-task CPU/RSS/uptime telemetry projection on the snapshot.

- Spec: [specs/033-aggressive-pause-telemetry/spec.md](../../../specs/033-aggressive-pause-telemetry/spec.md)
- Landing commit: [2560f07](https://github.com/lehoa1806/schegent/commit/2560f07ea2213c668a0515ce57818fdd8e6a08e0)

---

## Feature 034 — Task Deletion Cleans Up Session Folder and Raw Transcript

Cleans up the per-runId session tree and raw transcript on operator-confirmed task deletion; the append-only audit log is explicitly preserved.

- Spec: [specs/034-task-deletion-cleanup/spec.md](../../../specs/034-task-deletion-cleanup/spec.md)
- Landing commit: [3b5a4d7](https://github.com/lehoa1806/schegent/commit/3b5a4d7cb944db923612dbe439961cc601723f39)
