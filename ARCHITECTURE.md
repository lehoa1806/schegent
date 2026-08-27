# Schegent Architecture

Schegent is a local VS Code extension host that turns catalog definitions into
queued backend-CLI executions. The product has no listening server and no
remote control plane: operator actions enter through contributed VS Code
commands or the sidebar and Dashboard webviews, then cross typed host-side
boundaries before they may change persisted state or spawn a backend process.
Remote, multi-user, or service-hosted operation remains behind the expansion architecture gate.

<!-- Source: package.json -->
<!-- Source: src/extension.ts -->
<!-- Source: src/activation/ui-wiring.ts -->

## Runtime shape

Activation starts in `src/extension.ts`. It resolves the canonical workspace,
constructs logging and evidence services, acquires the workspace ownership
lease, loads workspace state and the effective catalog, composes the queue and
workflow controller, and finally registers operator commands and webviews. A
workspace-less window receives only the reduced UI and evidence wiring that can
operate without a project root.

Election precedes recovery (FR-R3-070): the primacy claim is taken immediately
after the lock and lease managers are constructed, and every recovery
installer — the scheduled-start re-arm, the credit-watchdog reattach, the
delayed-retry resume, and the persisted-run sweep — is gated on its result. A
non-primary window installs no recovery timers and leaves persisted deadlines
addressable for the primary; the resume path additionally claims its queue's
execution lease before marking anything in flight, so activation ordering is
defence in depth rather than the only defence. The scheduled-start coordinator
re-verifies primacy with the authoritative fenced predicate at fire time.

The fence reaches the point of effect (FR-R3-077). `WorkspaceStateStore.setRun`
and `updateQueue` both take a **required** ownership claim and verify it inside
the serialized link that performs the write, so a revived stale host is refused
at the commit rather than merely late; a call site that provably holds no lease
names its reason from a closed set in `src/state/ownership-claim.ts`, and a test
pins that set. The read side declines a record stamped at a superseded
generation and records the decline as evidence, which is the answer to the write
that lands between the verify and the update — the window a memento with no
conditional write cannot close.

Output targets are re-judged where they take effect (FR-R3-079).
`RunDriver.dispatchObserved` re-walks every declared target's component chain
immediately before the frozen plan reaches the runner; a refusal fails the Run
with a named cause recorded in evidence, before the child exists. The frozen
plan is read, never rewritten.

The production dependency direction is intentionally one-way:

```text
VS Code commands / sidebar / Dashboard
                    |
                    v
      validation + trust + primacy gates
                    |
                    v
         catalog and run-plan services
                    |
                    v
        queue admission and scheduling
                    |
                    v
        workflow controller / run driver
                    |
                    v
       backend runner -> local CLI process
                    |
                    v
     state, audit, transcript, runtime log
```

`src/activation/` is the composition root, **together with `wireStage2()` in
`src/extension.ts`, which is still part of it.** Domain modules do not construct VS
Code adapters themselves.

That sentence used to stop at the first clause, and it overstated the shipped shape:
`src/activation/` was twelve focused modules totalling ~2,200 lines while
`wireStage2` was a single 1,221-line function doing the same kind of work in the
entry file. `FR-R3-119` reconciled the two by moving, not by rewording — the largest
independent span became `src/activation/sidebar-router-wiring.ts` — and by pinning
the remainder under a shrink-only bound in `tests/lint/source-loc-budget.test.ts`, so
the sentence becomes unqualifiedly true by extraction rather than by editing. Until
it does, the qualification stays. The measurements, the waive-or-extract decision and
the mutation that corrected the bound's first draft are in
[Composition root extraction](docs/architecture/composition-root-extraction.md). `src/host-services/` wraps host-owned behavior such
as configuration, filesystem and notification seams. `src/headless/` exposes
process validation/import/export and run-launch entrypoints over the same
services without importing `vscode`.

<!-- Source: src/extension.ts -->
<!-- Source: src/activation/backend-wiring.ts -->
<!-- Source: src/activation/ui-wiring.ts -->
<!-- Source: src/headless/process-definition-api.ts -->
<!-- Source: src/headless/process-yaml-api.ts -->
<!-- Source: src/headless/pipeline-run-api.ts -->
<!-- Source: src/headless/workflow-run-api.ts -->

## Source ownership map

Every top-level production directory has one primary architectural role. The
table is an ownership map, not permission for cross-layer shortcuts.

| Directory | Primary responsibility |
|---|---|
| `src/activation/` | Extension-host composition and lifecycle wiring. |
| `src/audit/` | Structured audit envelopes, rotation, raw transcripts, and diagnostic evidence writers. |
| `src/catalog/` | Versioned Phase, Pipeline, and Workflow catalog persistence and lifecycle state. |
| `src/commands/` | Contributed VS Code command handlers. |
| `src/config/` | Settings schemas, effective catalog projections, Pipeline snapshots, and definition validators. |
| `src/contracts/` | Shared host/webview, runner, state, audit, and catalog types plus validators. |
| `src/controller/` | Run and Phase orchestration, retries, pause/resume controls, and terminal transitions. |
| `src/headless/` | VS Code-independent public adapters over process and run services. |
| `src/host-services/` | Explicit adapters for facilities owned by the VS Code host. |
| `src/lib/` | Cross-cutting redaction, path-safety, runtime-log, and small utility modules. |
| `src/metrics/` | Read-only derivation of task, phase, cost, and coverage metrics from retained evidence. |
| `src/monitor/` | Bounded subprocess activity, transport, and progress observation. |
| `src/parser/` | Backend output, audit line, usage, reset-time, rate-limit, and error parsing. |
| `src/queue/` | Queue registry, task lifecycle, admission capacity, ordering, and scheduling state. |
| `src/runner/` | Backend-specific argv construction, spawn environment, prompt composition, and output collection. |
| `src/services/` | Reusable application services for guarded starts, process YAML, checkpoints, retention, and projections. |
| `src/state/` | Workspace memento records, forward migrations, ownership leases, run history, and recovery journals. |
| `src/telemetry/` | In-memory local process resource sampling and platform shims. |
| `src/ui/` | Status bar, notifications, sidebar IPC, Dashboard bridge, HTML, CSP, and immutable view projections. |
| `src/watchdog/` | Credit/rate-limit polling and delayed recovery scheduling. |

<!-- Source: src -->

## Operator request boundary

There are two interactive entry paths. Contributed commands are registered by
the activation wiring and call command handlers directly. Webview requests are
typed `SidebarCommand` values carrying a known command type and correlation ID;
the sidebar router dispatches them through the handler registry.

For every command classified as mutating, the sidebar route checks Workspace
Trust first and authoritative-window primacy second. Both checks fail closed:
an absent callback, thrown check, or non-true answer rejects the mutation. The
mutation executor serializes acknowledged work and preserves correlation IDs.
Read-only commands do not acquire mutation authority merely because they share
the same transport.

Direct command-palette commands have their own guards and must be evaluated
individually. Queue admission goes through `GuardedRunService`, which validates
the request, refuses a fresh foreign workspace lock, addresses the requested
queue's pause state, and enforces the scheduled-start horizon. Reset and Git
approval have explicit host dialogs rather than relying on a webview click.

<!-- Source: src/contracts/sidebar-ipc.ts -->
<!-- Source: src/contracts/sidebar-command-metadata.ts -->
<!-- Source: src/ui/sidebar/message-router.ts -->
<!-- Source: src/ui/sidebar/mutation-command-executor.ts -->
<!-- Source: src/services/guarded-run-service.ts -->
<!-- Source: src/commands/reset.ts -->
<!-- Source: src/activation/git-approval.ts -->

## Catalog and immutable execution plans

The catalog stores three definition kinds: Phase, Pipeline, and Workflow. Each
kind has versioned published content, an optional draft, and lifecycle state.
The effective projection supplies only runtime-eligible definitions. Lifecycle
writes use expected versions or revisions so stale editors are rejected rather
than overwriting a newer decision.

A `RunRequest` is transient and identity-free. It names one Pipeline, declared
input values, supplemental material, output targets, and optional instructions.
The validation service resolves the effective published definition, validates
ports and paths, and produces an immutable `ExecutionEnvelope`. That envelope
contains the expanded Pipeline snapshot, frozen inputs, supplemental inputs,
outputs, instructions, timestamp, and, when known, the published catalog
version. The enqueue path persists the frozen value; execution consumes the
same value instead of re-reading a changed live catalog.

A Phase definition's `sideEffects` declaration selects mutation planning,
operator consent, rollback checkpoint behavior, and the refusal of a
Git-capable phase on a runner that cannot perform Git writes. It does not
restrict the spawned process by itself; actual backend permission posture comes
from the argv used by that backend adapter.

<!-- Source: src/catalog/catalog-store.ts -->
<!-- Source: src/contracts/catalog-lifecycle.ts -->
<!-- Source: src/contracts/run-request.ts -->
<!-- Source: src/services/run-request/run-request-validator.ts -->
<!-- Source: src/services/workflow-run-factory.ts -->
<!-- Source: src/services/mutation-plan.ts -->

## Queues, Runs, and scheduling

The queue registry contains at least one queue and at most `MAX_QUEUES = 20`.
Each queue is sequential: it can have at most one in-flight Task. Workspace-wide
capacity is independent and is controlled by
`schegent.queue.globalConcurrencyCap`, default `1`, range `[1, 20]`. The default
keeps parallel work opt-in; raising the value allows different queues to run at
the same time against the same operator-owned working tree.

Queue state is addressed by queue ID. Pending Tasks retain order, one task may
be marked in flight, and queue lifecycle distinguishes ordinary idle state,
held `idle-pending`, active execution, and operator pause. An explicit start
intent decides whether enqueueing should start now, schedule a start, cancel a
schedule, or remain queued. Scheduled starts beyond seven days are refused
before any queue write.

The auto-drain coordinator is the single policy site that turns eligible queued
work into run admission. It checks queue and workspace capacity, claims a
per-queue execution lease, asks the controller to admit the task, and releases
or transitions ownership at the appropriate terminal boundary. A paused queue
does not block a sibling queue, and a queue never runs two Tasks concurrently.

<!-- Source: src/queue/queue-registry.ts -->
<!-- Source: src/queue/queue-manager.ts -->
<!-- Source: src/queue/feature-request.ts -->
<!-- Source: src/services/auto-drain-coordinator.ts -->
<!-- Source: src/services/guarded-run-service.ts -->
<!-- Source: src/state/execution-lease.ts -->
<!-- Source: package.json -->

## Controller and Phase execution

`SchegentWorkflowController` owns active Run sessions and delegates one Phase
at a time to `RunDriver` and `PhaseRunner`. A `WorkflowRun` carries the immutable
Pipeline snapshot, phase cursor, iteration and retry state, pause controls,
breakpoints, mutation-plan decision, transcript mode, and terminal status.
Catalog edits made after admission therefore affect later Runs, never the
in-flight snapshot.

The Phase runner resolves the pinned backend, constructs the prompt, starts the
raw evidence sink when enabled, invokes the runner, and classifies bounded
stdout and stderr. The controller records liveness, advances successful phases,
applies bounded delayed retry policy, pauses on operator or breakpoint control,
and hands terminal Runs to history and cleanup services. A terminal transition
journal makes a partially completed terminal write recoverable at activation;
it journals the sanitized run description (FR-R3-071) so crash-replay records
the operator's text, and it clears only when the history recorder reports a
durable append. History replay resolves descriptions through the sidecar
description store's typed read — the host commands and the sidebar rerun
surface share one resolver, and force retains its meaning of "replay the
truncated preview knowingly".

Each backend invocation carries two independent bounds (FR-R3-075): an idle
window (`schegent.invocation.idleTimeoutSeconds`, reset by output, suspended
under sink backpressure) and an absolute wall-clock deadline
(`schegent.invocation.maxDurationSeconds`, armed once at spawn and never
reset). Evidence distinguishes the two terminations — `timeout` for a child
that went quiet, `deadline` for one that ran long — end to end: raw output,
monitor events, transcript, and the phase-end audit record.

Workflows compose multiple Pipeline Runs. Connected-run state identifies the
Workflow graph node, child Run, revision, and continuation position so a later
node cannot be continued against stale graph state. Conditions are structured
data rather than evaluated operator-authored source.

<!-- Source: src/controller/workflow-controller.ts -->
<!-- Source: src/controller/phase-runner.ts -->
<!-- Source: src/services/run-driver.ts -->
<!-- Source: src/services/retry-coordinator.ts -->
<!-- Source: src/services/terminal-transition-coordinator.ts -->
<!-- Source: src/state/workflow-run.ts -->
<!-- Source: src/state/connected-workflow-run.ts -->
<!-- Source: src/services/workflow-execution/continuation-service.ts -->

## Backend process boundary

The supported runner kinds are `claude`, `codex`, and `agy`; `claude` is the
default. All adapters spawn with `shell: false`, receive prompts over stdin, use
the shared environment builder, and return the common `BackendRunner` result.
They do not have equal authority.

Claude and Agy disable their CLI approval prompts and therefore act without
asking through those CLIs. Codex runs non-interactively with an OS-enforced
`workspace-write` sandbox whose Git metadata is read-only. Runner selection is
resolved when a Run is created and frozen in its Pipeline snapshot. CLI path
resolution is backend-specific; the spawn environment follows the configured
minimal, allowlist, or inherit policy.

Output is bounded before it reaches parsers or UI projections. Structured audit
events do not receive arbitrary subprocess output. Raw transcripts, when
enabled, are a separate evidence class and may contain sensitive backend output.

**Backend identity is separate from backend construction (FR-R3-089).** The
backend enum — `BackendRunnerKind`, `SUPPORTED_BACKENDS`, `DEFAULT_BACKEND`,
`isBackendRunnerKind` — lives in `src/contracts/backend-kinds.ts`, a leaf module
that imports nothing. The runner family keeps construction. Before the move,
validators in `config/` and `services/` that only needed to know *which backend
names exist* imported them from the module that knows *how to build one*, and the
visible symptom was a module cycle: `services/backend-containment-policy.ts`
took `SUPPORTED_BACKENDS` from the factory as a value while the factory imported
`judgeBackendContainment` from the policy.

**The cycle is gone as a consequence of the move**, not as a separate fix: the
policy now reads identity from contracts, so only the `factory → policy` edge
remains and it is acyclic.

**The stated limit is retired (`FR-R3-128`, 2026-08-27).** This paragraph used to
end by admitting that the repository shipped no dependency-cycle checker, so the
claim rested on one directional assertion plus inspection, and *"a cycle elsewhere
in the tree would not be caught by either"*. That admission was honest and is now
false, which is the one way a true statement goes wrong.
`tests/lint/import-graph-acyclic.test.ts` walks the whole first-party graph — 673
modules and 1,484 value edges as of 2026-08-27 — and fails on any cycle. No
`madge`-class dependency was added: it reads relative static imports with one
regex per file, excludes type-only edges (erased at compile time, and legitimately
circular in a recursive type model) and dynamic imports (a deliberate deferral, and
the technique used to break a cycle).

It found one on its first run, which is the argument for having built it:
`ui/sidebar/state-projector.ts` and `state-projector-runtime.ts` imported each
other over a single constant, and neither existing gate could see it — both files
are in `ui/`, so `dependency-direction.test.ts`'s leaf-to-acting rule never looked.
The constant moved to the module that consumes it as a default.

**Agent capability boundary (FR-R3-086).** A Phase may declare a capability set —
`workspace-write`, `outside-workspace-write`, `process-spawn`, `network` — frozen
into the Run's plan snapshot. `services/capability-enforcement-plan.ts` translates
it into the chosen backend's own enforcement flags, so the backend's permission
engine refuses at the attempt. **Omission means every capability**, and the plan
turns that into each adapter's current argv byte for byte, so a phase that
declares nothing spawns exactly as it did before. A capability the backend cannot
express refuses the phase before it starts, via
`controller/capability-decision-recorder.ts`, recording `capability-refused` first.
A set the backend **can** enforce is recorded too, as `capability-applied`: the
bound lives in argv and `argv` is an omitted key in `audit/audit-payload.ts` by
design, so without that event a successful narrowing would be indistinguishable
in evidence from no narrowing at all. The two are mutually exclusive, and a phase
that declares nothing emits neither.
The limits — the host does not observe tool calls, and `agy` can express one of
four — are stated in `docs/security/threat-model.md` beside what it does bound.

**Local evidence controls (FR-R3-085).** `services/retention-disclosure.ts` derives
the operator-facing retention document from the constants that enforce it;
`services/evidence-export.ts` produces a manifest checked in both directions with
an export-side digest chain; `services/evidence-delete.ts` refuses rather than
races and reports both what it removed and what it retained. All three route
through the shared containment oracle and act on the resolved path.

<!-- Source: src/contracts/phase-capabilities.ts -->
<!-- Source: src/services/capability-enforcement-plan.ts -->
<!-- Source: src/controller/capability-decision-recorder.ts -->
<!-- Source: src/services/evidence-export.ts -->
<!-- Source: src/services/evidence-delete.ts -->
<!-- Source: src/services/retention-disclosure.ts -->
<!-- Source: src/contracts/backend-kinds.ts -->
<!-- Source: src/runner/backend-runner-factory.ts -->
<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: src/runner/codex-cli.ts -->
<!-- Source: src/runner/agy-cli.ts -->
<!-- Source: src/runner/spawn-env.ts -->
<!-- Source: src/runner/zipped-stream-buffer.ts -->
<!-- Source: src/parser/stdout-parser.ts -->

## Persistence and ownership

Workspace-scoped durable files live below `.schegent/`; memento-backed state is
owned by `WorkspaceStateStore`. The host writes whole addressed queue, Run, and
history maps rather than partially mutating independently serialized fragments.
Schema upgrades are forward-only. State written by a newer unsupported version
is refused rather than guessed backward.

The workspace lock decides which VS Code window is authoritative for mutations.
Its durable ownership record is filesystem-fenced and freshness-aware.
Containment for the on-disk stores is anchored at the workspace root
(FR-R3-069), never at a store directory the checkout itself supplies: the
catalog and ownership adapters take the trusted workspace root and the
untrusted store directory as separate required parameters, resolve the store
against the root per operation, and create store chains only through the
safe-open anchor walk — so a cloned workspace arriving with `.schegent`,
`.schegent/catalog`, or `.schegent/ownership` symlinked out of the workspace
refuses instead of adopting the link target as its own boundary, while a link
that stays inside the workspace is admitted. The
separate execution lease is per queue and lasts from admission to terminal
transition. This split prevents a Run from releasing window primacy while still
letting separate queues carry independent execution ownership.

Multi-root workspaces select one canonical folder; other folders remain normal
VS Code roots but do not receive another Schegent state authority. Trust is a
ceiling for catalog and sidebar mutations, with capability-specific decisions
applied only below that ceiling.

<!-- Source: src/state/workspace-state.ts -->
<!-- Source: src/state/lock.ts -->
<!-- Source: src/state/ownership-registry.ts -->
<!-- Source: src/state/execution-lease.ts -->
<!-- Source: src/state/workspace-folder-picker.ts -->
<!-- Source: src/state/capability-trust-resolver.ts -->

## Evidence, logs, and metrics

The audit writer serializes metadata-only JSON-line events with a schema version
and correlation ID, rotates the active file, and prunes archives by bounded
retention rules. Its append-only behavior is an application write pattern; the
tamper-evidence is separate and real. Since FR-R3-112 every entry carries the
previous entry's digest, so a local operator, backend process, or any process
with filesystem authority may still alter or delete local evidence, but not
without the break becoming detectable — `npm run audit:verify` names the first
one. Evident, not impossible: the chain head sits on the same disk, so an actor
who can edit the log can recompute every later digest; what they cannot do is
edit one entry and leave the rest consistent.
<!-- Source: src/audit/audit-chain.ts -->

Raw transcripts are separately configurable and written below
`.schegent/sessions`. They preserve backend streams for diagnosis and can hold
source content or secrets that the structured audit projection rejects. The
sanitized runtime log uses the shared redaction logger; its configured sink is
restricted to the canonical workspace, extension global storage, or OS
temporary root. Recovery checkpoints live in extension global storage and can
contain unredacted Git patches, so they have their own restrictive permissions
and retention service.

Metrics are read-only projections over the retained audit corpus plus durable
rollups. Detail coverage follows the evidence retention window; cumulative
rollups prevent already-accounted terminal Runs from disappearing merely
because an audit archive rotated away. Telemetry samples local process resource
usage in memory and does not create a remote telemetry channel.

<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/audit/audit-payload.ts -->
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: src/lib/logger.ts -->
<!-- Source: src/activation/backend-wiring.ts -->
<!-- Source: src/services/run-checkpoint-service.ts -->
<!-- Source: src/services/run-checkpoint-retention.ts -->
<!-- Source: src/metrics/metrics-service.ts -->
<!-- Source: src/metrics/metrics-rollup.ts -->
<!-- Source: src/telemetry/telemetry-sampler.ts -->

## Failure and recovery model

Failures remain explicit state. Backend nonzero exits, detected rate limits,
credit exhaustion, timeouts, cancellation, evidence degradation, stale
ownership, and invalid input take distinct paths. Sanitized errors are stored
on the Run; unbounded raw strings do not cross into structured audit or webview
state. Rate-limit retry is capped and delayed; the watchdog reattaches a pending
poll after activation.

Run mutation checkpoints bracket Git-capable phases. The mutation ledger
attributes observed changes to one Run, and the checkpoint service records the
patch needed for operator recovery. Checkpoint creation is not proof that a
backend stayed within an intended file set. Terminal transition recovery,
scheduled-start reattachment, and ownership reconciliation are activation-time
repairs over persisted intent.

Evidence sinks are best-effort where losing evidence must not corrupt workflow
state, but their health is projected so degradation is visible. State writes
that define admission, queue ownership, or terminal completion are not silently
reclassified as optional evidence.

<!-- Source: src/controller/retry-handler.ts -->
<!-- Source: src/watchdog/credit-watchdog.ts -->
<!-- Source: src/services/run-checkpoint-service.ts -->
<!-- Source: src/services/run-mutation-ledger.ts -->
<!-- Source: src/services/terminal-transition-coordinator.ts -->
<!-- Source: src/services/evidence-health/evidence-health-monitor.ts -->

## Schema Versions

The table is the current persisted compatibility contract. Migration arrows are
kept as plain text so the Current cells remain the sole numeric code spans on
their constant rows.

| Store | Constant | Current | Migrators |
|---|---|---|---|
| Workspace state | `STATE_SCHEMA_VERSION` | `14` | 1→2, 2→3, 3→4, 4→5, 5→6, 6→7, 7→8, 8→9, 9→10, 10→11, 11→12, 12→13, 13→14 |
| Audit event envelope | `AUDIT_SCHEMA_VERSION` | `3` | Additive event types and payload fields retain the current envelope version; readers preserve unknown historical event types. |

Workspace migration history includes the legacy Run lift, queue-registry lift,
breakpoint additions, queue coalescing, explicit queue lifecycle, frozen
evidence and mutation metadata, connected Runs, queue/run/history map
pluralization, and the final collapse to one persisted pause answer. A downgrade
migrator is intentionally absent.

<!-- Source: src/contracts/state-schema.ts -->
<!-- Source: src/contracts/audit-events.ts -->
<!-- Source: src/state/workflow-run-migrator.ts -->
<!-- Source: src/state/queue-state-migrator.ts -->
<!-- Source: src/state/connected-run-migrator.ts -->
<!-- Source: src/state/run-state-migrator.ts -->
<!-- Source: src/state/history-state-migrator.ts -->

## Extension points and review obligations

A new backend implements the shared runner contract, registers in the factory,
uses the common spawn environment and bounded output result, and documents its
actual permission-shaped argv. A new mutating IPC command must join the command
metadata registry, receive runtime payload validation, and pass through the
trust and primacy executor. A new persisted field requires an old-record read
story and, when record shape changes, the next forward migration.

A new catalog definition or lifecycle operation must preserve the three-kind
closed union, optimistic concurrency, trust ordering, published-version
history, and immutable execution snapshot. A new destructive filesystem action
must call the shared path-safety oracle immediately before effect. A new audit
event keeps payloads bounded and paths-free, while readers continue to tolerate
unknown event types.

Remote command submission, multiple operators, multiple host processes, tenant
boundaries, or a service-owned scheduler do not fit the current local ownership
model. Those changes require the remote/multi-user decision record's threat
model and exit criteria; increasing local queue concurrency does not silently
authorize any of them.

<!-- Source: src/contracts/backend-runner.ts -->
<!-- Source: src/runner/backend-runner-factory.ts -->
<!-- Source: src/contracts/sidebar-command-metadata.ts -->
<!-- Source: src/ui/sidebar/ipc-validator.ts -->
<!-- Source: src/catalog/catalog-store.ts -->
<!-- Source: src/lib/path-containment.ts -->
<!-- Source: src/parser/audit-log-parser.ts -->

## Architectural invariants

The following statements summarize the boundaries the implementation relies
on:

1. One canonical workspace root owns one local Schegent state tree.
2. One authoritative window may perform host mutations for that workspace.
3. Each queue has at most one executing Task; workspace parallelism is bounded
   independently and remains opt-in.
4. A validated execution envelope is frozen before enqueue and is the value the
   controller executes.
5. Workspace Trust and primacy are checked before mutating sidebar handlers.
6. Backend subprocess authority is determined by its adapter and operating
   environment, not by catalog metadata alone.
7. Structured audit, raw transcripts, runtime logs, checkpoints, and metrics are
   distinct evidence classes with different sensitivity and retention.
8. Persisted migrations move forward; an unknown future state version is
   refused.
9. Absolute workspace paths and unsanitized backend output do not belong in
   webview projections or structured audit payloads.
10. Remote or multi-user expansion requires a new authority model, not merely a
    larger local concurrency setting.

<!-- Source: src/extension.ts -->
<!-- Source: src/contracts/run-request.ts -->
<!-- Source: src/ui/sidebar/message-router.ts -->
<!-- Source: src/state/workspace-state.ts -->
<!-- Source: src/queue/queue-manager.ts -->
<!-- Source: src/runner/backend-runner-factory.ts -->
