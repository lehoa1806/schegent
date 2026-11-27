# Operations documentation

Do not read this directory from top to bottom. It holds both active operator runbooks and dated historical measurements. If you are responding to an incident or running Schegent for the first time, follow the bounded five-item reading list below and stop there; use the specialist guides and dated records only when a symptom or review specifically points you to them.

Return to the [documentation index](../README.md) or [Course: Use Schegent](../courses/use-schegent.md).

## Operator First-Recovery Required Reading List

Read these five items in order before or during your first operational incident. **Stop after item 5** unless a linked diagnostic directs you to a deeper guide — do not spend incident triage time reading dated benchmarks or historical observations.

1. **[Operator Incident Recovery Guide](incident-recovery-guide.md)** — symptom-first triage for the three core operational failure modes: future SQLite schema / `min_reader_version` refusal, quarantined workspace-state writer (`GC-04`), and stuck execution lanes (`preparing`, `verifying`, `landing`, `uncertain`, `root-missing`).
2. **[SQLite Application Store Rollback Runbook](sqlite-rollback-runbook.md)** — verified online same-version restore and offline schema `N` → `N-1` downgrade rollback, backup manifest checks, file permissions, and live-versus-tombstone external-byte outcomes.
3. **[Recovery from an interrupted run](recovery-checkpoints.md)** — host crash and restart reconciliation, ownership lease staleness, and resuming or canceling interrupted Runs.
4. **[Retry contract](retry-contract.md)** — which failures retry automatically, credit-pause watchdog bounds, and what Resume, Restart, Skip, and row Retry each do to a Run.
5. **[Execution Lanes](execution-lanes.md)** and **[What Schegent keeps on this machine](evidence-retention-disclosure.md)** — lane provisioning, landing, reconciliation, and cleanup rules alongside the exact inventory of local files, redaction boundaries, and deletion/erasure scope so you know what survives a recovery action or reset.

## Current Recovery & Incident Runbooks

Active procedures for diagnosing failures, recovering state, inspecting logs, and unblocking execution.

| Guide | Use it when |
|---|---|
| [Operator Incident Recovery Guide](incident-recovery-guide.md) | Triaging future schema refusals, quarantined workspace-state writers, or stuck execution lanes from observed diagnostics. |
| [SQLite Application Store Rollback Runbook](sqlite-rollback-runbook.md) | Performing online same-version restores or offline schema `N` → `N-1` rollbacks from verified backups. |
| [Recovery from an interrupted run](recovery-checkpoints.md) | Reconciling interrupted Runs after an extension host crash, window reload, or stale workspace lease. |
| [Recovery Handoff](recovery-handoff.md) | Understanding pinned recovery handoff states, resolution reasons, redelivery refusal order, and prune fail-safes. |
| [Retry contract](retry-contract.md) | Checking automatic retry eligibility, backoff delays, 24-hour credit watchdog caps, and manual recovery controls. |
| [Workflow Control Flow and Backend Recovery Runbook](workflow-control-recovery.md) | Diagnosing candidate recovery blocks, scoped child-Workflow `Repeat`, sequential `ForEach`, availability monitoring, and workspace handover. |
| [Execution Lanes](execution-lanes.md) | Investigating isolated worktree provisioning refusals, integration/landing failures, reconciliation, and lane cleanup. |
| [Runtime log](runtime-log.md) | Reading host diagnostic logs and trace output during incident triage. |
| [Inspect structured audit logs](inspect-audit-logs.md) | Verifying `.schegent/audit.log` entries, hash-chain continuity, and terminal run evidence. |
| [Inspect raw session transcripts](inspect-raw-transcripts.md) | Reviewing captured backend CLI transcripts when structured audit metadata is not enough. |
| [Live-Log Delivery](live-log-delivery.md) | Understanding live phase-log byte bounds, coverage-gap reasons, delivery counters, and resumable cursors. |
| [Diagnose built webview routes](built-artifact-route-diagnosis.md) | Troubleshooting missing, blank, or misrouted views in the packaged webview bundle. |

## Current Runtime, Feature & Security Operations Guides

Active operational references for storage, runtimes, workflows, trust/security posture, retention, and maintainer operations.

### Storage, runtime & workflow execution

- [SQLite Application Store and Structured-State Migration](sqlite-application-store.md) — `node:sqlite` engine qualification, `STRICT` schema through Migration 9, transaction units, WAL checkpoint policy, fault-matrix coverage, and backup/restore architecture.
- [ACP Agent Runtime](acp-runtime.md) — host-owned ACP client lifecycle, prompt outcomes, refusal reasons, locality classification (`local` vs `remote`), and bounds.
- [Backend operations](backends.md) — Claude, Codex, and Agy CLI selection, authentication, probing, invocation, and resume policy.
- [Configure Schegent](configuration.md) — operational configuration posture, halt policy defaults, and setting behavior.
- [Dashboard UI](dashboard-ui.md) — operator dashboard views, routes, and interaction surfaces.
- [Import and export process YAML](process-yaml.md) — authoring, preflight validation, and transitive `include-closure` publication for Phase and Workflow packages.
- [Manage Phases and Tasks](phase-task-management.md) — Phase lifecycle controls, Enable/Disable refusal behavior, and task queue management.
- [Run Status Transitions and Atomic Admission](run-status-transitions.md) — exhaustive Run state transition table, actor classes, typed errors, and single-transaction admission.
- [Multi-queue concurrency](multi-queue-concurrency.md) — concurrent queue caps, attribution behavior, and operational trade-offs.
- [Production Workflow Integration and Support Boundary Matrix](production-workflow-integration-matrix.md) — entry-point wiring census, collaborator composition, refusal taxonomy, and eight-checkpoint recovery seams.
- [Shared Memory and Storage Contracts](shared-memory-storage-contracts.md) — C1–C4 storage field dictionary, single-authority inventory, consumer map, and retention contracts.
- [Runtime Resource Budgets and Qualification](runtime-resource-budgets.md) — queue/query bounds, runtime resource budgets, and qualification targets.
- [Artifact Lifecycle, Storage and Recovery](artifact-lifecycle.md) — retention rules, tombstones, interrupted-deletion recovery, and legacy catalog migration behavior.
- [Usage and Metrics Accounting](usage-accounting.md) — how usage and cost totals are assembled, reported versus estimated lanes, currencies/credits, corrections, and open cross-run spend policy.
- [Historical Reports and Exports](historical-reporting.md) — reporting views, query bounds, CSV/JSON export profiles, saved reports, and reconciliation.
- [Change Review & Execution Visibility](change-review.md) — reviewing integration request change sets before approval or landing.
- [Optional OpenTelemetry Export](telemetry-export.md) — opt-in OTLP metrics profile, exported versus excluded fields, refusal reasons, delivery bounds, and health diagnostics.
- [Phase-to-Phase Context Handoff](phase-context-handoff.md) — opt-in handoff persistence, ACP prompt delivery, selection/omission rules, approvals, and limits.

### Trust, security, retention & governance

- [What Schegent keeps on this machine](evidence-retention-disclosure.md) — derived inventory of every locally retained artifact, redaction status, and retention bound.
- [Data retention and deletion](data-retention-and-deletion.md) — operator deletion controls, cleanup scope, and what remains on disk.
- [What stops an unattended run](autonomy-bounds-disclosure.md) — derived table of every unattended execution bound, spend limits, and open daily/workspace spend policy.
- [Workspace Trust](workspace-trust.md) — what stays available, what refuses, and what granting trust enables in an untrusted VS Code window.
- [Trust scopes](trust-scopes.md) — workspace, user, and backend trust boundaries.
- [Running Schegent on a repository you do not trust](untrusted-repositories.md) — single authority for untrusted-repository safeguards linked from the threat model and quickstart.
- [Live-canary cadence](live-canary-cadence.md) — live backend canary cadence, ownership, cost bounds, and 30-day prompt-behavior fixture freshness tracking.
- [Gate recording](gate-recording.md) — `npm run gate:record` attestations, merge-into-`develop` cadence, dependency-change binding, and `npm run gate:distance`.
- [Dependency advisory comparison](dependency-advisory-comparison.md) — report-only `npm run security:advisory-diff` comparison against a base commit.
- [Generate and verify shared contracts](contract-generation.md) — regenerating and verifying shared host/webview IPC and schema contracts.
- [License review and release packaging](licenses.md) — dependency license checks and packaging policy.
- [VSIX content policy and allowlist derivation](vsix-allowlist-derivation.md) — how the packaged VSIX file allowlist is derived and checked.
- [Operator-visible release notes](release-notes.md) — hand-maintained operator changelog across versions.
- [Interactive verification register](interactive-verification-register.md) — open interactive dev-host verification items, owners, closure criteria, and review dates.

## Dated Measurements & Historical Observations

Recorded point-in-time benchmarks, inventories, sweeps, and retired-control observations. Each entry is dated evidence for a specific commit and environment — **do not treat these as live runbooks or rewrite historical observations to match today's tree**.

### Performance, latency & reliability measurements

- [Sidebar Cancellation Latency Measurement and Ordering Decision](cancellation-latency-measurement.md) — **measured 2026-11-24**: dispatch and ACK latency behind held start/teardown mutations and `gatedConcurrent` bypass verification (`FR-R7-18` / `N01`).
- [Stage 2 Startup and 5 MiB Audit Chain Verification Measurement](startup-and-audit-verification-measurement.md) — **measured 2026-11-24**: Stage 2 activation sub-stages with sidebar open and 5 MiB whole-file / multi-archive audit verification latency and event-loop delay (`FR-R7-18` / `N05`).
- [Asynchronous Test Flakiness Remediation and Isolated-vs-Loaded Measurement](async-test-flakiness-measurement.md) — **measured 2026-11-24**: multi-invariant test splits, deterministic wait replacements, wait-lint expansion, and repeated isolated versus CPU-loaded run comparison (`FR-R7-18` / `N06`).
- [SQLite Large Restore Measurement, Maintenance Envelope & Ownership Fencing](sqlite-large-restore-measurement.md) — **measured 2026-11-23**: SQLite-native `ATTACH` + `INSERT INTO ... SELECT` restore timings, RSS, event-loop delay, and 512 MiB maintenance envelope (`FR-R7-14` / `14-03`).
- [Historical Reporting 100,000-Attempt Query Performance Measurement](historical-reporting-measurement.md) — **measured 2026-11-23**: 100,000-attempt reference fixture query latency, event-loop gaps, cancellation, and deadline metrics (`FR-R6-F11` / `R7-17-02`).
- [SQLite Operational State Commit Latency Measurement and Migration 9 Decision](sqlite-operational-commit-latency-measurement.md) — **measured 2026-11-19**: `WAL` + `synchronous = FULL` write/read/prune latency distributions and Schema 8 → Schema 9 verification (`FR-R7-02`).
- [Webview snapshot cost, render cost and persisted-state growth](webview-snapshot-cost-measurement.md) — **measured 2026-10-31**: snapshot serialization/render costs, hidden-sidebar delivery, and persisted-state growth (`FR-R4-F08`).
- [Transport-sink descriptor measurement](transport-descriptor-measurement.md) — **measured 2026-08-28**: append-handle counts across build/teardown, repoint/rotation, and sustained record bursts (`FR-R3-137`).
- [Concurrent-run isolation measurement](concurrent-run-isolation-measurement.md) — **measured 2026-08-27**: attribution outcomes at concurrency 1/2/4/8 and recommended cap of 2 (`FR-R3-124`).
- [Large-workspace resource measurement](large-workspace-resource-measurement.md) — **measured 2026-08-27**: memory, descriptor, `git status`, and activation percentiles on 2,000 tracked files (`FR-R3-130`).
- [Concurrent-run resource measurement](concurrent-run-resource-measurement.md) — **measured 2026-08-25**: concurrent runner memory and descriptor resource observations (`FR-R3-081`).

### Inventories, sweeps & historical records

- [Platform observation record](platform-observation-record.md) — platform-branched module inventory, macOS/Linux/Windows observation status, and dated review log (updated 2026-11-24).
- [Legacy `Pipeline` Compatibility Caller Inventory](legacy-pipeline-caller-inventory.md) — **measured 2026-11-23**: host and webview file counts and retirement prerequisites for remaining internal `Pipeline` compatibility callers (`FR-R7-14` / `14-21`).
- [Counts the round-3 documents assert](asserted-counts-sweep.md) — **swept 2026-08-24**: round-3 asserted-count sweep and static-registry sizing rationale (`FR-R3-067`).
- [Duplicate-authority detection: the threshold measurements](duplicate-authority-threshold-measurement.md) — **measured 2026-08-24**: overlap distribution behind the 80% / 20-line duplicate-authority gate (`FR-R3-066`).
- [Visual gate preflight observations](visual-gate-preflight-observations.md) — **observed 2026-08-24**: Playwright preflight observations on darwin/arm64 (`FR-R3-065`).
- [Lazy-route wait budget](lazy-route-wait-budget.md) — sweep record explaining the lazy-route wait budget constant (`FR-R3-068`).
- [Single-task queue migration history](single-task-queue-migration.md) — historical migration notes for the single-task queue collapse.
- [Observe the merge gates](merge-gate-observation.md) — **historical record** (`doc-class: record`): observation of retired hosted merge gates (hosted workflows retired on 2026-08-26).
- [Observe release provenance](release-provenance-observation.md) — **historical record** (`doc-class: record`): observation of retired hosted release provenance steps (hosted workflows retired on 2026-08-26).
