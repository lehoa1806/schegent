# Schegent Architecture

The execution-repository architecture map. Source code lives under `src/`, the
Svelte webview under `webview-ui/`, and operator-facing docs under `docs/`.
This document is normative for module boundaries and trust gates; CLAUDE.md
remains the authoritative source for code-change hard rules.

## Purpose

Schegent is a local-first VS Code extension that drives autonomous Speckit
workflows through CLI backends (Claude Code, Codex, and Agy). The extension host owns
orchestration, workspace state, audit evidence, runtime logging, IPC
validation, and queue control. The Svelte webview is a presentation layer
that renders host-projected snapshots and dispatches typed commands; the host
is the single source of truth.

"Local-first" describes storage and control-plane placement; it is not an
offline AI-execution guarantee. See
[`docs/concepts/local-first-not-offline.md`](docs/concepts/local-first-not-offline.md).
Remote control and multi-user operation are blocked by the accepted
[`expansion architecture gate`](docs/architecture/remote-multi-user-expansion-gate.md);
raising the local concurrency cap is not a substitute for that design. Feature
092 narrows one clause of that gate — same-workspace parallel execution for a
single local operator, N queues draining concurrently — without supplying any
of the identity, isolation or brokering the remote/multi-user clauses require;
see the status update at the end of the gate record.

## System Boundaries

```text
┌──────────────────────────────────────────────────────────────────┐
│ Operator Workstation (trusted)                                   │
│                                                                  │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ VS Code Extension Host (Node 20, TypeScript 5.x)             │ │
│ │   • workspace state, IPC validation, audit, runtime log      │ │
│ │   • controller, queue, scheduler, backend-runner factory     │ │
│ └──┬────────────────────────────┬──────────────────────────────┘ │
│    │ host-projected snapshots   │ subprocess                     │
│    │ + typed IPC commands       │ (shell: false)                 │
│    ▼                            ▼                                │
│ ┌──────────────┐    ┌────────────────────────┐                   │
│ │ Svelte       │    │ Claude/Codex/Agy CLI   │                   │
│ │ Webview      │    │ subprocess             │                   │
│ │ (sidebar +   │    │ • stdin prompt         │                   │
│ │  dashboard)  │    │ • stream-json stdout   │                   │
│ └──────────────┘    └────────────────────────┘                   │
└──────────────────────────────────────────────────────────────────┘
```

**External boundaries:**

- VS Code APIs are usable in extension-host code and forbidden in `src/headless/` and `src/telemetry/`. Lint regressions under `tests/lint/` enforce this.
- CLI backends run as subprocesses with `shell: false`, bounded stdout/stderr
  buffers, timeout/cancellation handling, and one centrally resolved
  environment policy. The compatibility default inherits; hardened `minimal`
  and names-only `allowlist` modes apply identically to probes, phase calls,
  and pre-compaction calls.
- Workspace files at `<workspaceRoot>/.schegent/` hold per-workspace runtime artifacts: structured audit log, raw transcripts, opt-in verbose diagnostics, runtime log, and the ownership records two extension hosts arbitrate over.
- `vscode.ExtensionContext.workspaceState` (memento) stores serialized run, queue, and history records. Forward-only migrators upgrade old records. It is a **per-extension-host** cache, so it orders nothing between two hosts; anything two hosts must agree on is arbitrated on disk (see [State](#state-srcstate)).

## Module Layout

```text
src/
├── activation/   extension-host composition helpers; no workflow policy
├── audit/        evidence sinks — structured audit, raw transcript, verbose diagnostics, gitignore
├── commands/     extension command palette and command handlers
├── config/       settings schema (single source of truth), phase/pipeline/workflow catalogs, precedence, validation
├── contracts/    IPC, audit, monitor, queue-snapshot, state-schema, runner contracts
├── controller/   workflow state machine, phase runner, sequencer, retry handler, continue gate
├── engine/       shared engine boundary taxonomy, parity fixtures, current extension adapter
├── headless/     non-extension-host entrypoints (process/run APIs) — must not import vscode
├── host-services/ neutral host-service interfaces and VS Code adapter for future desktop host parity
├── lib/          shared pure helpers, SanitizedLogger, runtime-log sink, retry-condition DSL
├── monitor/      subprocess progress, stall detection, monitor events, bounded CLI transport capture
├── parser/       stdout/audit-block/usage/rate-limit/credit-error parsers
├── queue/        single-active-run queue registry and scheduling primitives
├── runner/       Claude/Codex/Agy adapters, lazy registry, factory, prompt builder
├── services/     auto-drain, guarded-run, history-recorder, phase-log, process-yaml, session-cleanup
├── state/        memento-backed run/queue/history state, forward-only migrators, fenced cross-host ownership records
├── telemetry/    local process-resource sampling — must not import vscode
├── ui/           VS Code-facing UI surfaces (sidebar provider, dashboard panel, output channel, status bar)
└── watchdog/     credit/rate-limit polling for delayed retry recovery

webview-ui/
├── src/
│   ├── App.svelte                  sidebar root
│   ├── main.ts                     sidebar entry
│   ├── components/                 sidebar Svelte components
│   ├── dashboard/                  dashboard Svelte components + entry
│   └── lib/                        IPC helper modules and pure projectors
└── __tests__/                      vitest suite
```

## Module Ownership

| Module | Owned responsibility | Must not own |
|---|---|---|
| `src/activation/backend-wiring.ts` | Runtime/evidence sinks plus workspace-scoped backend capability/Ping composition | Workflow transitions, IPC routing, or backend invocation |
| `src/activation/ui-wiring.ts` | Stage-2 dashboard bridge plus VS Code operator-command registration/disposal | Workflow mutation policy, persistence, or IPC validation |
| `src/activation/workspace-scaffolding.ts` | Activation-time `.specify/` presence notice to the runtime log and the operator | Refusing an enqueue, a drain, or a Run; the notice never gates |
| `src/controller/phase-control-service.ts` | Operator pause/resume/restart/skip/enable/disable/remove and breakpoint mutation policy | Activation wiring, queue ownership, or audit serialization |
| `src/controller/workflow-lifecycle-auditor.ts` | Workflow/phase audit taxonomy, envelope construction, and best-effort append handling | Workflow state mutation, dispatch, or UI projection |
| `src/services/evidence-health/` | Workspace-scoped sink health, bounded causes, and continuation policies | Raw exception text, filesystem paths, or UI rendering |
| `src/services/session-retention/` | Age/byte pruning for inactive `.schegent/sessions` run groups | Structured audit retention or active-run deletion |
| `src/services/run-checkpoint-retention.ts` | Age/byte/floor pruning of whole run directories under `<globalStorageUri>/checkpoints/` | Judging whether a checkpoint was valid, reading a `.patch`, or blocking a phase, a run, or activation |
| `src/services/session-dispatch-policy.ts` | Pure backend-session ownership and continuation/reuse dispatch policy | Persisting session IDs or composing backend argv |
| `src/services/backend-capability-service.ts` | Bounded host-only CLI availability/model discovery and newest-generation snapshot publication | Constructing invocation runners, persisting capability state, or backend failover policy |
| `src/services/backend-ping-service.ts` | Memory-only single-flight operator Ping state and paths-free audit evidence | Resolving webview-supplied paths, exposing process output, or persisting health state |
| `src/runner/spawn-env.ts` | One subprocess environment policy for probes, phases, and compaction | Backend-specific argument construction |
| `src/contracts/validators/` | Shared IPC validation primitives plus phase-log and metrics domain validators | Command dispatch coverage or downstream business invariants |
| `src/contracts/sidebar-ipc/` | Focused phase-log, metrics, trust, and host-message IPC type families | Command literals, runtime guards, or routing behavior |
| `src/ui/sidebar/activity-timing.ts` | Pure elapsed-time and live-activity calculations | Store subscriptions, audit hydration, or snapshot publication |
| `src/ui/sidebar/audit-tail-state.ts` | Bounded live audit cache, cold-start dedupe/merge, seeding, and snapshot copies | Store subscriptions, workflow timing, or UI publication |
| `src/ui/sidebar/state-projector.ts` | Public lifecycle/subscription/telemetry-sanitization facade | Domain projection algorithms or mutable timing state |
| `src/ui/sidebar/state-projector-runtime.ts` | Subscription ordering, debounce/tick lifecycle, audit hydration, and disposal | Snapshot field composition |
| `src/ui/sidebar/projector-bookkeeping.ts` | Elapsed-time, activity, transition, and per-phase ephemeral bookkeeping | Store or audit I/O |
| `src/ui/sidebar/snapshot-composer.ts` | Immutable WorkflowSnapshot composition from focused projectors | Subscriptions, subprocesses, or persistence |

`src/host-services/` makes VS Code-owned platform behavior explicit before a
Rust desktop host exists. Its `types.ts` contract is `vscode`-free and covers
workspace root/trust, configuration, memento persistence, global storage,
notifications, command dispatch, file reveal, scheduler, and lifecycle
disposal. `vscode-host-services.ts` is the current adapter and delegates
canonical root selection through `src/state/workspace-folder-picker.ts`.

**`src/engine/` no longer exists.** Earlier revisions of this document
described it as a shared workflow control boundary that a future Rust desktop
host would target, with a `CurrentExtensionEngineAdapter` wrapping the
TypeScript handlers and rejecting unwired commands as
`engine-command-unavailable`. It never became the controller path and was
removed along with the Rust contracts; `tests/unit/build/release-qualification.test.ts`
now asserts `src/engine/index.ts` is **absent**, so it cannot come back by
accident. The description is recorded here as removed rather than deleted
outright because it survived in this file long enough to be built against.

`src/host-services/` above is the boundary that actually exists. It carries
the vscode-free contract; there is no second abstraction layer beneath it.

## Primary Flow

```text
operator action / IPC      ┌─────────────────────────────────────┐
   │                       │ src/ui/sidebar/message-router.ts    │
   ▼                       │   workspace-trust gate (closed-fail)│
┌───────────────┐          │   primary-host gate (MUTATING_*)    │
│ src/commands/ │──────────▶│   ipc-validator.ts (typed payload)  │
└───────────────┘          └─────────────┬───────────────────────┘
                                         │ accepted command
                                         ▼
                          ┌──────────────────────────────────┐
                          │ src/services/guarded-run-service │
                          │   + queue/queue-manager          │
                          └─────────────┬────────────────────┘
                                        │ promote pending → active
                                        ▼
                          ┌──────────────────────────────────┐
                          │ src/controller/workflow-controller│
                          │   one RunSession per queue        │
                          │   drives phases via phase-runner  │
                          └─────────────┬────────────────────┘
                                        │ per-phase invocation
                                        ▼
                          ┌──────────────────────────────────┐
                          │ src/controller/phase-runner       │
                          │   phase-start audit emit          │
                          │   raw-transcript bracket          │
                          │   build prompt, invoke runner     │
                          │   parse stdout, classify outcome  │
                          │   phase-end audit emit            │
                          └─────────────┬────────────────────┘
                                        │ outcome
                                        ▼
                          ┌──────────────────────────────────┐
                          │ src/runner/{claude,codex,agy}-cli │
                          │   subprocess: shell:false         │
                          │   bounded buffers, env scrubbed   │
                          └─────────────┬────────────────────┘
                                        │ stdout/stderr/exit
                                        ▼
                          ┌──────────────────────────────────┐
                          │ src/parser/*                      │
                          │   precedence: fatal → rate-limit  │
                          │   → non-zero exit → contract      │
                          │   blocks → remaining issues       │
                          └─────────────┬────────────────────┘
                                        │
                                        ▼
                          ┌──────────────────────────────────┐
                          │ src/state/workspace-state         │
                          │   serialize run/queue/history     │
                          │   forward-only migration          │
                          └─────────────┬────────────────────┘
                                        │ snapshot
                                        ▼
                          ┌──────────────────────────────────┐
                          │ src/ui/sidebar/* projectors       │
                          │   pure snapshot → webview shape   │
                          └─────────────┬────────────────────┘
                                        │ postMessage
                                        ▼
                                Svelte webview render
```

The webview command router is one **primary adapter**, not the only one.
`src/headless/` is a second adapter over the same services: it validates its
own arguments, then calls the identical service functions the router calls.
Both enter at the service layer, so neither owns validation the other lacks:

```text
   webview IPC                              in-process caller
        │                                          │
        ▼                                          ▼
┌────────────────────────┐             ┌──────────────────────────┐
│ src/ui/sidebar/        │             │ src/headless/*-api.ts    │
│   message-router.ts    │             │   process-api-validators │
│   ipc-validator.ts     │             │   → BoundaryRefusal      │
└───────────┬────────────┘             └────────────┬─────────────┘
            │                                       │
            └───────────────┬───────────────────────┘
                            ▼
        ┌────────────────────────────────────────────────┐
        │ shared services (adapter-free, vscode-free)     │
        │   services/process-yaml/preflight-service.ts    │
        │   services/process-yaml/export-service.ts       │
        │   services/workflow-execution/                  │
        │       continuation-service.ts                   │
        │   config/*-definition-validator.ts              │
        └────────────────────────────────────────────────┘
```

## Execution Envelope

`ExecutionEnvelope` ([src/contracts/run-request.ts](src/contracts/run-request.ts))
is the runtime contract for a composed run: **the accepted request is the
executed request.** It carries the frozen Pipeline snapshot, the bound contract
inputs, the supplemental context, the declared output targets, the operator's
free-text instructions, and the freeze timestamp.
[validateRunRequest()](src/services/run-request/run-request-validator.ts) is its
only construction site — there is no other constructor, no cast, and no partial.
`FrozenRunPlan` is an alias of it, retained so pre-existing imports keep
compiling; it is not a sibling type.

It is consumed **by reference**. A component that needs part of the request
takes the whole envelope and reads what it needs; it does not copy fields out of
it into its own parameters. That is the rule the type exists to enforce, and it
is what makes adding a field to the request a one-place change rather than an
edit to every seam between validation and the CLI. Feature 087 froze five fields
and read one of them on the way to the backend — the other four were persisted
and dropped at the factory seam — and four new optional scalars on `PromptInputs`
would have closed that gap and reopened it on the next field.

```text
  validateRunRequest()            single construction site
        │  ExecutionEnvelope
        ▼
  queue item `runPlan`            persisted with the request
        │
        ▼
  workflow-run-factory            attaches it whole: `run.envelope`
        │                         no re-resolve, no narrowing
        ▼
  run-driver ──────────────┬───▶ phase-runner ──▶ prompt-builder
        │                  │       (carrier only)   renders the request
        │                  │
        │                  └───▶ `PhaseRunInputs.envelope`
        ▼
  resolveRunOutputs()             probes `run.envelope.outputs`
```

Properties worth knowing before changing any of it:

- **One construction site, enforced.**
  [tests/lint/no-envelope-reconstruction.test.ts](tests/lint/no-envelope-reconstruction.test.ts)
  fails the build on an envelope literal, assertion, or spread-rebuild anywhere
  in `src/` outside the validator and the declaration.
- **The prompt is derivable from the envelope alone.** The request sections read
  the same regardless of phase, iteration, or feature directory, in one
  documented order: bound inputs, supplemental context, declared output targets,
  operator instructions. Order within each section is the envelope's frozen
  order, which is the operator's composition order — never sorted.
- **Operator content is carried, never interpolated.** Instructions, input
  values, and supplemental text are untrusted. They appear under headings that
  name whose words they are, positioned after Schegent's own `OUTPUT CONTRACT:`
  block; no Schegent-authored contract line is built from them.
- **Outputs are stated, then probed, from the same array.** `prompt-builder`
  tells the backend the declared targets and `resolveRunOutputs` looks for those
  targets — literally the same array on the same object, not a second read of
  the queue row, which may already be gone by the time a run completes.
- **Nothing envelope-derived reaches the structured audit log.** Phase events
  keep carrying bounded identifiers and counts. Paths, brief text, targets, and
  instructions stay out of `.schegent/audit.log` (the standing workspace-root
  rule, restated for this material).
- **The legacy path is a discriminated choice, not a fallback.** A queue item
  with no `runPlan` produces a Run with no `envelope` key at all and resolves its
  Pipeline exactly as it did before. The two branches never merge in either
  direction.

### Where the rest of the runtime contract lives

The envelope is the whole runtime contract, but three of its elements are
reached through the Run rather than through a prompt section, which makes them
easy to mistake for state resolved somewhere else. They are not.

- **Model and runner policy is inside the snapshot.**
  [snapshotPhaseDef()](src/config/pipeline-snapshot.ts) resolves each phase's
  effective `runner`, `sideEffects`, `evidencePolicy` and `promptVersion` at
  validation and freezes them into `envelope.pipeline.phases`. Nothing
  downstream re-resolves them; `run.defaultRunnerKind` is a run-level fallback
  for partially migrated snapshots, not the authority for a phase that has one.
  Since feature 098 the containment class and evidence policy are **declared by
  the Phase, never derived from its id**: `sideEffects` defaults to `workspace`
  and `evidencePolicy` to `required` when the definition omits them (FR-005),
  and both defaults are literals in that one function. The derivation they
  replaced asked whether the host recognised the id and answered `unrestricted`
  for every Phase it did not — which, for imported Phases, was all of them. A
  `sideEffects: git` declaration additionally requires a Git-capable runner
  ([phase-runner-policy.ts](src/config/phase-runner-policy.ts)), enforced three
  times — at save, again when the catalog resolves the row, and once more before
  the phase runs — and every time against the declaration. There is deliberately
  no replacement id list (FR-008): an id carries no authority, so a Phase named
  `finalize` is admitted or refused on exactly the terms of one named anything
  else.
- **The mutation plan is a projection, not a second source.**
  [buildMutationPlan()](src/services/mutation-plan.ts) is a pure function of
  that frozen phase array — `run.mutationPlan` is a memoized derivation of
  `run.envelope.pipeline`, and `run.pipeline` **is** `run.envelope.pipeline` by
  identity on a composed run. This is deliberately not stored on the envelope:
  a persisted copy of a derived value is the second-source-of-truth shape the
  Workflow-ports rule already forbids.
- **The approval receipt is minted after the envelope and still cannot drift
  from it.** A `GitApprovalReceipt` records an operator's answer to a modal, so
  it necessarily comes later than validation. It binds by `planFingerprint`, a
  hash over the frozen phases, so an approval can only ever match the exact
  contract it was shown. `run-driver.ts` re-checks that binding per phase before
  any git-capable phase runs.

[tests/integration/execution-envelope/runtime-contract-completeness.test.ts](tests/integration/execution-envelope/runtime-contract-completeness.test.ts)
pins all three, and pins that the envelope survives `workspaceState`
persistence with every section intact — a member that does not survive
`JSON.stringify` would be a run that executes one contract before a window
reload and a smaller one afterwards.

### Runs that predate the envelope

A composed Run already in flight when this contract landed carries no
`envelope`, because the field did not exist when it was created. Since the
execution path reads the envelope and nothing else, such a Run would be probed
for no outputs at all. `resumeExistingOnQueue()` in
[workflow-controller.ts](src/controller/workflow-controller.ts) repairs it once,
on the way back into execution, by attaching the queue row's `runPlan` — the
same envelope `validateRunRequest()` froze for that Run, aliased rather than
rebuilt, and safe to read because nothing under `src/` writes `runPlan` after
enqueue.

This is **not** a general licence to consult the queue row. It is guarded on
`run.envelope` being absent, so a Run created after this contract never reaches
it, and it sits alongside the two backfills that were already there for the same
reason (the pinned runner kind and the pre-009 Pipeline snapshot). Adding a
queue-row read anywhere on the execution path itself is the defect this contract
closed.

## Subsystems

### Controller (`src/controller/`)

[workflow-controller.ts](src/controller/workflow-controller.ts) owns the run
state machine, lock acquisition, and the phase-by-phase execution loop. It
delegates per-phase work to:

- [phase-runner.ts](src/controller/phase-runner.ts) — boundary between
  orchestration and CLI execution. Owns `phase-start` / `phase-end` audit
  emission, raw-transcript bracketing, fatal-signature classification,
  rate-limit classification, phase-message sidecar parsing (with the
  canonical-path containment guard from spec 056 Track 2), retry-condition
  evaluation (sandboxed DSL), and timeout/cancel mapping. It **carries** the
  [Execution Envelope](#execution-envelope) to the prompt seam and does not read
  its members.
- [phase-sequencer.ts](src/controller/phase-sequencer.ts) — iteration
  sequencing primitives extracted in feature 047.
- [retry-handler.ts](src/controller/retry-handler.ts) — retry orchestration,
  clamped by `DELAYED_RETRY_CAP = 5` (in [retry-constants.ts](src/controller/retry-constants.ts)).
- [is-continue-gate.ts](src/controller/is-continue-gate.ts) — single
  source-of-truth for whether `--continue` may be passed to Claude on the
  next phase invocation. `request.isContinue === true` is the only path that
  inserts the `-c` flag.
- [rate-limit-backoff.ts](src/controller/rate-limit-backoff.ts) and
  [breakpoint-accessor.ts](src/controller/breakpoint-accessor.ts) — supporting
  collaborators.
- [schedule-watchdog.ts](src/controller/schedule-watchdog.ts) — the recovery
  sweep for scheduled starts no in-process timer will fire. It was a documented
  no-op from feature 030 until FR-R3-002; `tick()` now scans every
  `QueueState` for an elapsed `scheduledStartAt` on an `idle-pending` queue
  with no armed timer, and promotes it through the **same**
  `promoteScheduledQueue` hop the `ScheduledStartCoordinator`'s `onFire` uses.
  It asks `AutoDrainCoordinator.drainIfIdle(queueId)` rather than deciding
  eligibility itself, so it is not a second idle-pending enforcement site.

Feature 057 will further decompose `phase-runner.ts` into sidecar reader,
prompt assembler, and continue-gate coordinator; see
[specs/057-phase-runner-decomposition/plan.md](../specs/057-phase-runner-decomposition/plan.md).

### Runner (`src/runner/`)

[backend-runner-registry.ts](src/runner/backend-runner-registry.ts) lazily
constructs and caches a concrete `BackendRunner` per kind through
[backend-runner-factory.ts](src/runner/backend-runner-factory.ts).
`PhaseRunner` resolves the effective kind once per invocation from the phase
override and global default, and `RunDriver` clears backend-owned session
state before a runner transition.

[backend-capability-service.ts](src/services/backend-capability-service.ts)
owns short-lived availability and model-discovery subprocesses separately
from the lazy runner registry. It publishes the newest completed scan to the
sidebar, and `RunDriver` reuses its bounded availability probe before the first
phase. Probe processes use `shell: false`, the invocation cwd/environment
policy, a configurable 1–30 second timeout, 64 KiB output retention, and
TERM→KILL cleanup. Capability results are ephemeral and do not alter persisted
workflow snapshots.

[backend-ping-service.ts](src/services/backend-ping-service.ts) reuses the
same host-resolved probe path for an operator-requested Ping. The read-only
`CMD_PING_BACKEND` payload contains a runner kind only; it never accepts an
executable path. One host-local Ping may run at a time, state remains
memory-only, and every accepted or rejected attempt appends a paths-free
`backend-ping` record through the workspace audit sink. The webview consumes
only the bounded classification, timing, latency, and optional numeric exit
code—never subprocess output, environment data, paths, or stack traces.

- [claude-cli.ts](src/runner/claude-cli.ts) — invokes Claude with `shell: false`,
  bounded stdout and stderr for parsing, a backpressured disk tee for the
  verbatim raw transcript, timeout/cancellation handling, optional safer
  prompt transports, optional verbose-diagnostic flags, and a strict
  `request.isContinue === true` gate for `-c`.
- [codex-cli.ts](src/runner/codex-cli.ts) — same `BackendRunner` contract;
  uses stdin transport and `codex exec --json --sandbox workspace-write`.
  Does not invent
  Claude-specific continuation or verbose-diagnostic behavior.
- [agy-cli.ts](src/runner/agy-cli.ts) — uses stdin transport and
  `--output-format stream-json`, continues with `--conversation <id>`, and
  caps unsupported `xhigh`/`max` effort values to `high` with a warning.
- [prompt-builder.ts](src/runner/prompt-builder.ts) — composes the phase
  prompt template, previous-iteration sidecar context, per-phase metadata,
  and — for a composed run — the request itself from the
  [Execution Envelope](#execution-envelope): bound inputs, supplemental
  context, declared output targets, and operator instructions, appended after
  the feature description and omitted section by section when empty. Takes the
  envelope as one field rather than four scalars. Pure module.

### Parsers (`src/parser/`)

Each parser is hot-path-aware and avoids broad JSON parsing:

- [stdout-parser.ts](src/parser/stdout-parser.ts) — classifies output
  precedence: fatal signature → rate limit → non-zero exit → contract blocks
  → remaining issues.
- [audit-log-parser.ts](src/parser/audit-log-parser.ts) — parses the
  model-authored constitution audit block. Unknown event types and future
  schema versions are preserved by readers instead of dropped (CLAUDE.md
  hard rule).
- [rate-limit-reset-extractor.ts](src/parser/rate-limit-reset-extractor.ts) —
  extracts dynamic reset timestamps from plain and stream-json output
  without parsing common allow events on the hot path.
- [invocation-usage.ts](src/parser/invocation-usage.ts) — extracts numeric
  fields from stream-json `result` rows. Only finite non-negative numbers
  and integers are accepted; the host-owned `durationMs` remains canonical,
  CLI-reported duration recorded separately as `cliDurationMs`.
- [credit-error-detector.ts](src/parser/credit-error-detector.ts) — detects
  credit-exhaustion patterns for the watchdog polling layer.

### Audit and Logging (`src/audit/`, `src/lib/`)

Six distinct sinks with different sanitization postures:

| Sink | Path | Sanitized? | Read back via IPC? |
|---|---|---|---|
| Structured audit log | `<workspaceRoot>/.schegent/audit.log` | Yes (single point) | Yes (audit-tail projector) |
| Raw transcript | `<workspaceRoot>/.schegent/sessions/raw-<runId>.log` | No (intentional) | Never |
| Verbose diagnostics | `<workspaceRoot>/.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-N/` | No (intentional, opt-in via `schegent.logging.verbose`) | Never |
| Runtime log | `<workspaceRoot>/.schegent/syslog` (configurable) | Yes (single point) | No (operator opens file) |
| CLI transport capture | `<workspaceRoot>/.schegent/cli-transport.log` (+ `.1`…`.3`) | Yes (single point; paths retained) | Never |
| Metrics rollup | `<workspaceRoot>/.schegent/metrics-rollup.jsonl` | N/A — carries no free text to sanitize | Yes (composed into `CMD_READ_METRICS` totals) |

The structured audit log records what Schegent *did*; a line of CLI stdout is
content Schegent was merely *transporting*. Those two were conflated until
FR-R3-007: the monitor wrote one `monitor-stdout-line` audit entry per line,
which measured 93.2% of `audit.log` by bytes and was read by nothing. Because
the audit log's retention budget is what bounds the metrics horizon, spending it
on transport capped that horizon at roughly forty runs — against spec 073's
SC-001, which asks the dashboard to cover the full retention window. The
per-line writers are gone from both streams; the counts they carried are now the
`monitor-invocation-summary` aggregate (`stdoutLines`, `stderrLines`,
`firstOutputAt`, `lastOutputAt`), and the content goes to the transport sink.

`monitor-stdout-line` and `monitor-stderr-line` stay registered in
`ALL_AUDIT_EVENT_TYPES` permanently, as **read-only event types with no
writer**. Rotated archives on operator disks are full of them, and the parser's
warn-and-preserve rule would turn one archive read into a stream of
`unknown eventType` warnings if the registry entries were dropped. Retiring a
writer is not an envelope change, so `AUDIT_SCHEMA_VERSION` stays `3`.

Raw transcripts and verbose-diagnostic trees share one retention owner. It
groups artifacts by run, protects running and paused runs, and prunes only
complete inactive-run groups by age and total-byte budget. Sweeps run at
activation, after terminal runs, and after policy changes. The structured
audit log is outside the managed root and is never pruned by this service.

**The recovery-checkpoint store is the second retention owner, and the only sink
outside the workspace.** `<globalStorageUri>/checkpoints/<runId>/` holds a
`git diff --binary HEAD` per Git-capable phase — unredacted source, in a
directory `.schegent/.gitignore` does not reach, the session sweep does not
visit, and every workspace the extension has ever opened writes into.
`RunCheckpointService.prune()` bounds one directory to 20 artifacts and is only
ever called with the directory of the run that just wrote, so until FR-R3-012 the
*number* of directories had no bound at all.
[run-checkpoint-retention.ts](src/services/run-checkpoint-retention.ts) supplies
the outer one: 14 days, 256 MiB total, and a floor of the ten newest directories
held back from the **size** bound but deliberately not from the **age** bound,
since a floor covering both leaves a residue of ancient diffs nothing can reap.
Both are code-resident constants rather than settings — a wrong value here is
silent data loss in a directory an operator never opens — and both are age- and
volume-based rather than lifecycle-based, because a completed run's patch is
exactly what is wanted when that run turned out badly.

The sweep is scheduled at activation and not awaited; it never throws, so a
retention fault costs a sweep rather than a phase, a run, or the activation that
scheduled it. Every candidate is proven contained against the checkpoint root
through the one oracle in
[path-containment.ts](src/lib/path-containment.ts) immediately before `rm` —
the root check cannot answer for a run directory that is itself a link out of the
store — and measurement uses `lstat`, so a symlink planted inside one is an entry
rather than a tree to descend. Counts, bytes, and the triggering bound go to the
sanitized runtime log; nothing about retention reaches `audit.log`, which never
carries a workspace path. It is strictly a volume bound: it does not read a
`.patch`, does not judge whether an artifact was valid, and treats a
`.declined.json` marker as an ordinary artifact, because FR-R3-004 owns what a
decline means and the marker is the evidence that a checkpoint was declined.
Operator-facing policy and the by-hand `git apply` procedure live in
[docs/operations/recovery-checkpoints.md](docs/operations/recovery-checkpoints.md).

**The metrics rollup is the one sink with no retention policy at all**, and
that is its entire purpose (FR-R3-009). Every other figure the dashboard shows
is a fold over the audit corpus, so it reports the *rotation window* rather than
the history — when the eleventh archive or the ninety-first day prunes the
oldest evidence, a *cumulative* total goes down. A total that goes down is not a
short window; it is a wrong number, and nothing in the view distinguished the
two. `.schegent/metrics-rollup.jsonl` is append-only JSON Lines, one record per
terminal run, written by `MetricsRollupWriter` at the terminal transition while
the evidence is still present. A record holds a run id, a terminal status, two
timestamps, six integer counters and an optional cost — ids, counters, and
money, with no description, no path, and no CLI output, which is why the
sanitization column above reads N/A rather than "yes". At roughly 200 bytes per
run it is measured in bytes per day, so it is bounded by how much work a
workspace actually does rather than by a budget that has to be spent against
anything else.

Three properties make it durable rather than merely persisted. It is **never
recomputed**: a rebuild from a corpus that has since been pruned would inherit
exactly the defect the rollup removes, so the reader treats the file as
authoritative for its own range and attempts no backfill over missing days. It
is **forward-only**: records are never rewritten, a schema change adds a version
marker and a reader branch, and a record from a newer writer is read rather than
refused, because refusing one makes a total drop for an operator who downgraded.
And the append is **idempotent on run id** — the terminal transition is reached
both live and by crash replay, and a second record for one run is
indistinguishable from a second run.

Those three owners — session artifacts, checkpoints, the rollup's deliberate
absence of one — are the ones with interesting *reasons*, not the whole set. A
workspace also carries audit rotation and archive retention, runtime-log and
CLI-capture generations, the ownership registry's generational prune, and the
per-queue history cap, each bounded by a different rule and triggered by a
different event. Enumerating them here would duplicate a table that has to stay
correct for operators rather than for readers of this document, so the inventory
— every store with its location, bound, deletion trigger, and whether the data
is recoverable — lives in
[docs/operations/data-retention-and-deletion.md](docs/operations/data-retention-and-deletion.md),
alongside the procedures for removing each on purpose. That page is also the one
place the out-of-workspace `globalStorageUri` paths are written down per
platform.

`readMetrics` composes the rollup with the fold and deduplicates by run id, so
neither range double-counts the runs they overlap on and a workspace that
predates the file still reports its older runs from the log. `MetricsCoverage`
then states the two horizons **separately** on the IPC contract: the totals
window is the rollup's range, and the detail window is the scanned corpus's.
Naming only one would leave a figure presented as all-time when it is not, which
was the half of the defect that no amount of durable storage fixes.

`EvidenceHealthMonitor` is the workspace-scoped owner for sink availability.
It projects normalized, paths-free health for structured audit, raw transcript,
runtime log, and metrics rollup. Structured-audit failure is a run-control
boundary: the phase runner throws `RequiredEvidenceUnavailableError`, the run
driver persists a sanitized terminal failure, and auto-drain remains stopped.
Raw-transcript, runtime-log, and metrics-rollup failures are
availability-preserving but visibly degraded. Health stays sticky until
workspace wiring is recreated because a later successful write cannot
reconstruct missing evidence. The rollup earns a sink of its own precisely
because its failure is otherwise silent: a run whose append failed still
executes and still completes, and its contribution to the totals then lasts only
as long as its audit evidence — so the degraded badge is the operator's warning
that a total may regress at the next prune.

- [audit-log-writer.ts](src/audit/audit-log-writer.ts) — structured
  append-only writer. Every audit record passes through `SanitizedLogger`
  before reaching disk. Rotation/archive preserves history; existing
  records are never rewritten.
- [raw-transcript-writer.ts](src/audit/raw-transcript-writer.ts) —
  verbatim prompts, stdout, stderr, and exit status. Best-effort,
  intentionally unredacted, never surfaced through webview IPC. Subprocess
  chunks are backpressured into mode-`0600` stdout/stderr spools under the
  OS-managed temporary directory, streamed into the append-only transcript at
  invocation end, and removed; abandoned spools are scavenged by owner PID;
  the transcript therefore remains complete even when parser buffers truncate.
- [verbose-diagnostic-writer.ts](src/audit/verbose-diagnostic-writer.ts) —
  opt-in diagnostic payloads. Diagnostic write failures fold into phase
  warnings; they never fail a run.
- [schegent-gitignore.ts](src/audit/schegent-gitignore.ts) — writes a
  best-effort `.schegent/.gitignore` (containing `*`) the first time the
  runtime writers create `.schegent/`. Operator-managed ignore files are
  never overwritten.
- [verbose-diagnostic-path.ts](src/audit/verbose-diagnostic-path.ts) —
  pure path composer; also used by the canonical sidecar-path
  computation in `phase-runner.ts`.

Sanitization is centralized in [src/lib/logger.ts](src/lib/logger.ts).
`SECRET_PATTERNS` is the **single source of truth** redaction set;
pre-compiled case-sensitive and case-insensitive unions hot-path the
sanitize call. The set currently covers Anthropic / OpenAI keys
(`sk-`, `sk-ant-`, `sk-proj-`, `sk-svcacct-`), GitHub PATs (`ghp_`,
`github_pat_`), Slack tokens (`xox[baprs]-`), AWS long-lived keys
(`AKIA…`) and STS session keys (`ASIA…`), Google API keys (`AIza…`),
Google OAuth tokens (`ya29.…`), Stripe live/test/restricted keys
(`[rs]k_(live|test)_…`), GCP service-account JSON snippets, standalone
PEM private-key headers (RSA / DSA / EC / OPENSSH / PGP / ENCRYPTED),
`Bearer` and `Authorization` headers, `api_key` / `apikey` / `api-key`,
`x-api-key` / `X-API-Key`, JWTs (`eyJ…`), and generic
`SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY=value` env-style assignments.

[src/lib/runtime-log/](src/lib/runtime-log/) is the sanitized runtime log
sink. It registers on `SanitizedLogger`, re-reads runtime-log settings on
every emit (never cached on long-lived objects), and rotates by configured
size/generation policy (`schegent.logging.runtimeLogMaxBytes`,
`schegent.logging.runtimeLogMaxGenerations`).

[src/monitor/cli-transport-sink.ts](src/monitor/cli-transport-sink.ts) owns the
transport tier. It lives beside the monitor rather than under `src/audit/`
because it is not evidence of a decision — it is a bounded convenience copy of
the subprocess's own output. Three properties follow from that, and each is
deliberate: it is **best-effort** (a write failure warns once per (path, cause)
and the phase continues, matching `verbose-diagnostic-writer` rather than the
audit writer); it is **bounded by its own rotation** (`CLI_TRANSPORT_MAX_BYTES`
5 MiB × `CLI_TRANSPORT_MAX_GENERATIONS` 3, code-resident precisely so no
operator setting can let one sink starve the other's budget); and it is
**sanitized** through the same `SECRET_PATTERNS` set, applied inside the sink so
a per-line caller cannot forget it. Paths are the one difference from the audit
log: `audit.log` refuses to carry a workspace path at all, while raw CLI output
names the files the CLI touched and stripping them would leave a record no
operator could use. Rotation renames and unlinks are proven against the
workspace root through the one containment oracle in
[src/lib/path-containment.ts](src/lib/path-containment.ts). Record format is one
physical line per record — `<ISO-8601>\t<runId>\t<phase>\t<stream>\t<line>` —
with content last, so `cut -f5-` recovers the CLI's own bytes and no per-line
truncation is applied.

### State (`src/state/`)

[workspace-state.ts](src/state/workspace-state.ts) is the memento-backed
serialization layer. The numeric schema version `STATE_SCHEMA_VERSION = 13`
lives in [src/contracts/state-schema.ts](src/contracts/state-schema.ts);
forward-only migrators handle 1→2 (feature 011), 2→3
([queue-state-migrator.ts](src/state/queue-state-migrator.ts)),
5→6 (feature 030), 9→10 (feature 092, `migrateV9ToV10`, which lifts the
singleton queue record into `Record<queueId, QueueState>`), 10→11
([run-state-migrator.ts](src/state/run-state-migrator.ts), feature 093,
`migrateV10ToV11`, which does the same to the run record so two queues can hold
two live Runs), 11→12
([history-state-migrator.ts](src/state/history-state-migrator.ts), FR-R3-010,
`migrateV11ToV12`, which partitions `KEYS.history` by queue and re-reads the cap
as per-queue depth) and 12→13 (FR-R3-011, `migrateV12ToV13`, which collapses the
three pause representations into `QueueState.queueLifecycle`). The full
per-version rationale lives beside the constant, not here. A persisted version
*above* `STATE_SCHEMA_VERSION` is refused, not rolled back. `setRun()` enforces
paired invariants for manual pause and retry state so the scheduler cannot
persist one-sided resumption data.

`initialize()` no longer runs a pause reconciler.
`reconcileQueuePauseStateIfDivergent()` is deleted, along with the startup write
it performed, because the divergence it repaired is now unrepresentable rather
than merely checked for — see
[One persisted answer to "is this queue paused"](#one-persisted-answer-to-is-this-queue-paused-fr-r3-011).

[workflow-run.ts](src/state/workflow-run.ts) carries the composed run's
[Execution Envelope](#execution-envelope) on the optional `envelope` field —
additive, so no version bump. `run.pipeline` and `run.envelope.pipeline` are the
same object in memory and serialize twice on disk; that duplication is the
accepted cost of consuming the request by reference rather than harvesting
fields from it. `runInputs` remains as a legacy projection and nothing under
`src/` reads it.

Two further optional fields on the same record answer "is this run working or
hung, and how far along is it" from the persisted state rather than from window
memory (FR-R3-008, blueprint finding DATA-02). Both are additive, so no version
bump, and absence on a record means **unknown** — never zero and never stale.

`liveness` is `{ lastActivityAt, stdoutLines, stderrLines }`: a timestamp and two
bounded counters, no line content and no path. It exists because
`lastTransitionAt` moves only at status transitions, so a phase streaming output
productively for 3.6 h and a phase dead for 3.6 h were indistinguishable in the
record, while the reading that *could* tell them apart —
`CliMonitorState`/`liveActivity` — is computed in memory and discarded on window
reload. `lastTransitionAt` remains transition-only and is **not** a heartbeat: the
lifecycle auditor's `durationMs`, the staleness reclaim, and the history
recorder's `completedAt` all read it as "when the status last changed".

The write is **coalesced**, not per line. `ClaudeCliMonitor` notes every chunk to
[activity-coalescer.ts](src/monitor/activity-coalescer.ts), which forwards at most
one observation per `ACTIVITY_COALESCE_INTERVAL_MS` (15 s) per Run — a bound of
`1 + floor(elapsed / interval)` writes whatever the line count, so this field does
not reintroduce FR-R3-007's amplification in a medium (`globalState`) with no
rotation. Dropped observations are discarded rather than buffered; there is no
timer, because one would fire after the phase ended. The write itself is
`WorkflowController.recordRunActivity` → `setRun(queueId, …)` on the existing
serialize chain, skipped for a terminal Run and never moved backwards. The
persisted stamp therefore trails true last output by up to one interval; exact
end-of-phase totals stay in `monitor-invocation-summary`.

`plannedTotal` is `{ phaseCount, iterationCap, maxPhaseInvocations }`, frozen at
run creation beside the `pipeline` snapshot. `loop.maxIterations` is a live
setting, so a denominator derived on read would move under a Run already in
flight — lowering the setting from 5 to 2 mid-run would make every in-flight Run's
progress jump. [run-planned-total.ts](src/services/run-planned-total.ts) owns all
of the arithmetic for the three call sites that must agree: the factory freezes
the total, `PhaseControlService` refreshes it **in the same write** that changes
`phaseOverrides`, and the snapshot projector computes the numerator. Numerator and
denominator exclude the same override set, so the fraction cannot exceed one;
`phaseCount` counts distinct phase ids (what the numerator can reach) while
`maxPhaseInvocations` counts positions weighted by the frozen cap (a ceiling on
CLI invocations, not a forecast).

[history-store.ts](src/state/history-store.ts) and
[history-entry.ts](src/state/history-entry.ts) own the rolling history
window.

**History is partitioned by queue** (FR-R3-010). `KEYS.history` holds a
`Record<queueId, HistoryEntry[]>`, each partition capped at
`HISTORY_CAP_PER_QUEUE` (50), reached from the flat `HistoryEntry[]` by the
forward-only v11 → v12 migration in
[history-state-migrator.ts](src/state/history-state-migrator.ts). The flat array
carried one cap for the workspace, so under concurrent queues a busy queue's
completions evicted a quiet queue's records and nothing in the product said so;
the workspace now holds cap × queues. `append(queueId, entry)` is a whole-map
read-modify-write on the store's existing serialize chain — the only write path
for this key — and dedupes on `runId` + `terminalStatus` **within the target
partition**, so a retried completion costs no write at all. `list()` folds every
partition for the workspace-wide view; `listForQueue(queueId)` is the per-queue
one. A legacy row whose Task resolves to no queue is filed under
`__unattributed__`, which is an ordinary partition rather than a tombstone: the
migration emits an audit event naming the count and never re-caps, because a
forward-only step that *deletes* records is the one kind that cannot be
re-attempted after a crash.

**The pointer is `runId:<runId>`**, minted by `buildAuditLogPointer` and read by
[audit-pointer-resolver.ts](src/services/history/audit-pointer-resolver.ts) —
never a path, so nothing machine-specific reaches persisted state or the
webview. Resolution streams the corpus oldest-first (archives matching the
writer's own naming, then the live log), returns at most
`MAX_RESOLVED_ENTRIES` (500) entries sorted by timestamp, and reports parse
warnings as a count rather than text. **Two retention policies govern one
drill-down and they are independent by design**: audit evidence prunes at 10
archives or 90 days, while a history row lives until its queue's cap evicts it,
so a row outliving its evidence is expected rather than a fault. The resolver
therefore separates `evidence-expired` (the corpus starts after this run
completed) from `no-evidence-recorded` (the corpus covers the run and holds
nothing for it) from `unaddressable` (a pointer an older build minted), and the
webview renders all three as information while only a genuine resolution failure
renders as an error. A pointer is read verbatim and never repaired from the run
id being asked about, which would turn "cannot address this" into a fabricated
success. The `historyPointer` evidence sink is `continue-degraded` and degrades
only on `corpus-unreadable`; a full description no longer lives in the memento
at all but under `.schegent/history/<runId>.txt` via
[history-description-store.ts](src/services/history/history-description-store.ts),
whose reads, writes, and evictions all route through the containment oracle in
[src/lib/path-containment.ts](src/lib/path-containment.ts).

[lock.ts](src/state/lock.ts) provides the workspace lock
acquisition wrapper, which since feature 092 arbitrates **window primacy**
only. Per-queue **execution** leases live in
[execution-lease.ts](src/state/execution-lease.ts) — at most one holder per
queue, N concurrently per workspace, reusing the lock module's 5 s heartbeat
and 15 s staleness threshold.

Both leases are arbitrated by
[ownership-registry.ts](src/state/ownership-registry.ts) over the storage seam
in [ownership-fs.ts](src/state/ownership-fs.ts), and neither is decided in the
memento (FR-R3-003). Acquisition is an exclusive create (`O_CREAT|O_EXCL`) of a
generation-numbered record under `<workspaceRoot>/.schegent/ownership/`, so two
hosts racing for one resource produce one winner in the kernel rather than two
winners in two caches. The generation number *is* the fencing token — a holder
carries it and re-checks it at the point of effect through
`WorkspaceStateStore.verifyClaim()` / `writeGuarded()`, so a host that stalled
past the staleness threshold, was reclaimed, and then revived has its writes
rejected rather than merely landing late. Every failure resolves to a refusal to
acquire; nothing assumes acquired. `KEYS.lock` and `KEYS.executionLeases` remain
as per-host advisory **mirrors** for the synchronous readers on projection paths
that cannot await, and every one of those reads is additionally gated on this
window holding a fence. The mechanism, the platform property it rests on, and
the alternatives rejected are recorded in
[docs/architecture/workspace-ownership-fencing.md](docs/architecture/workspace-ownership-fencing.md);
production wiring is pinned by
[tests/lint/ownership-registry-wiring.test.ts](tests/lint/ownership-registry-wiring.test.ts).

[workspace-folder-picker.ts](src/state/workspace-folder-picker.ts) is the
single source of truth for the canonical workspace folder in multi-root
workspaces (feature 058). It memoizes `vscode.workspace.workspaceFolders[0]`
and lazily subscribes to `onDidChangeWorkspaceFolders` for cache
invalidation. All host code routes through `getCanonicalWorkspaceRoot()`;
direct `workspaceFolders[0]` reads are forbidden outside this module and
guarded by the lint regression at
[tests/lint/no-direct-first-workspace-folder.test.ts](tests/lint/no-direct-first-workspace-folder.test.ts).
[multi-root-warning.ts](src/state/multi-root-warning.ts) consumes the picker
and emits a one-shot activation-time toast plus a `multi-root.warning-shown`
audit event (payload: `folderCount`, `canonicalFolderName` — name only,
never `fsPath`). Suppressible per-workspace via
`schegent.multiRoot.suppressWarning` (`window`-scoped boolean).

[capability-trust-resolver.ts](src/state/capability-trust-resolver.ts) is
the host-only resolver for the three per-capability trust scopes
introduced in feature 059 (`schegent.trust.allowCustomPhases`,
`schegent.trust.allowCustomRetryConditions`,
`schegent.trust.allowPipelineOverrides`). Each call re-reads
`vscode.workspace.isTrusted` and the relevant setting via
`getConfiguration().inspect(key)` — no value is cached across
configuration or workspace-trust changes. Resolution follows a four-step
ladder: **workspace-trust ceiling → workspace-scope → user-scope →
default-allow**. The ceiling is never widened; user-scope cannot
override workspace-scope. The resolver subscribes to
`onDidGrantWorkspaceTrust` and `onDidChangeConfiguration` and kicks the
state projector so the webview reflects projection changes immediately.
Save handlers consult the resolver before mutating the catalog and emit
a `trust.capability-denied` audit event on denial (payload bounded to
closed enums + workspace basename).

### Queue (`src/queue/`)

Feature 030 pinned this to one queue and one in-flight run; feature 092 supplies
the state migration and scheduler design that hard rule required and reopens it.
The public registry in [queue-registry.ts](src/queue/queue-registry.ts) holds up
to `MAX_QUEUES = 20` entries with its id, uniqueness and position-compaction
rules intact, and [queue-manager.ts](src/queue/queue-manager.ts) splits capacity
into `hasQueueCapacity(queueId)` (one in-flight run per queue — a queue is still
sequential) and `hasWorkspaceCapacity()` (`schegent.queue.globalConcurrencyCap`,
default `1`, range `[1, 20]`). The default is `1`, not the range's midpoint or
its ceiling: the 2026-08-18 defaults change lowered it from `3` to close review
finding REL-02 — see the [principal architecture
review](docs/operations/principal-architecture-review-2026-08-18.md) — so that
concurrency is a thing an operator turns on deliberately, having read what two
Runs sharing one worktree costs — see
[Recovery checkpoints](docs/operations/recovery-checkpoints.md). Not feature
098: that number belongs to the runtime-only catalog, cited elsewhere in this
file, which never touched this setting. The range is unchanged. `DEFAULT_GLOBAL_CONCURRENCY_CAP` in
[workspace-state.ts](src/state/workspace-state.ts) is the constant; this line is
pinned against it by
[architecture-doc-schema-parity.test.ts](tests/lint/architecture-doc-schema-parity.test.ts).
The formerly deprecated CRUD helpers are
un-deprecated. Widening further still requires both halves — a migration and a
scheduler that answers for the new entries (CLAUDE.md hard rule).

#### One persisted answer to "is this queue paused" (FR-R3-011)

Pausedness used to be written three times across two memento keys:
`QueueRegistryEntry.state` and its `pauseSource` in `KEYS.queueRegistry`, and
`QueueState.queueLifecycle` plus the legacy `QueueState.paused` / `pausedReason`
mirrors in `KEYS.queue`. A `Memento` offers no multi-key transaction, so every
pause was two writes with a window between them, and a window disposed inside
that window left the pair split.
`reconcileQueuePauseStateIfDivergent()` in
[workspace-state.ts](src/state/workspace-state.ts) ran at store initialization to
repair exactly that, and its existence was the evidence the three could disagree.

The surviving representation is `QueueState.queueLifecycle === 'operator-paused'`
with `QueueState.pauseSource` beside it — one entry of one key, so a pause is one
write and a split pair is unrepresentable rather than repaired. The registry's
`state` and `pauseSource` are **derived on read** by `projectQueueRegistry()` in
[queue-registry.ts](src/queue/queue-registry.ts), which every registry-facing
surface reaches through `store.getProjectedQueueRegistry()`; `setQueueRegistry()`
strips both fields on the way to disk, so a caller that spreads a projected entry
into a rename or a reorder cannot quietly recreate the second copy. `paused` and
`pausedReason` are **migration input only** —
[no-legacy-pause-mirror-write.test.ts](tests/lint/no-legacy-pause-mirror-write.test.ts)
fails the build on a live write and on a live read outside a named allowlist,
because a live read is the more dangerous half: an absent mirror reads
`undefined`, so a paused queue would drain.

The reconciler is deleted rather than tightened. It re-derived `queueLifecycle`
from the `(inFlightId, registry pause, pending count)` triple, which made it a
fourth writer of the discriminator and let it overwrite a legitimately held
`idle-pending` on the strength of a disagreement between the two values it was
comparing. Existing workspaces cross over through the forward-only
`migrateV12ToV13()` in
[queue-state-migrator.ts](src/state/queue-state-migrator.ts), whose per-entry
winner is **any representation reading paused wins**: the two directions are not
symmetric, since resolving to paused costs an operator one Resume click and
resolving the other way starts work nobody asked for. A queue that resolves to
not-paused keeps its existing lifecycle verbatim, `scheduledStartAt` and all.

Attribution survives the collapse on `pauseSource` rather than on a registry
column: `cascadedPause()` is a no-op against an operator pause and never demotes
it, and `cascadedResume()` lifts a pause only when the source is `'cascade'`.
`AutoDrainCoordinator` step 2 refuses on the same discriminator step 1 reads, so
the drain is not a second place where pausedness is decided — it previously
consulted the retired `paused` mirror. Coverage:
[queue-pause-collapse.test.ts](tests/unit/state/queue-pause-collapse.test.ts) over
every disagreement combination, and
[single-representation.test.ts](tests/integration/queue-pause/single-representation.test.ts)
over precedence and drain refusal against a real store.

### Config (`src/config/`)

[settings-schema.ts](src/config/settings-schema.ts) is the typed
single-source-of-truth description of every Schegent setting (added by
spec 056 Track 3). [settings-schema-validator.ts](src/config/settings-schema-validator.ts)
validates host writes against the schema and is reused by parity tests
against `package.json contributions.configuration` and webview defaults.

[general-settings.ts](src/config/general-settings.ts) performs full-batch
validation before any write; partial-write failures attempt compensating
rollback of already-touched keys and return a rollback-specific failure
when rollback itself fails. [phase-precedence.ts](src/config/phase-precedence.ts)
is pure and UI-only — it computes projection metadata that is never
persisted or logged. [pipeline-config.ts](src/config/pipeline-config.ts)
and [pipeline-config-loader.ts](src/config/pipeline-config-loader.ts) own
the host-owned pipeline catalog.
[workflow-config.ts](src/config/workflow-config.ts),
[workflow-catalog.ts](src/config/workflow-catalog.ts), and
[workflow-graph-validator.ts](src/config/workflow-graph-validator.ts) own the
third definition family — saved Workflow *graphs* whose nodes are Pipelines,
which are documents and not executions. This is a different thing from the
run-side `WorkflowRun`, which is unchanged; both senses of the word are
recorded in [docs/reference/glossary.md](docs/reference/glossary.md).
[workflow-graph.ts](src/config/workflow-graph.ts) holds the pure graph
algorithms with no Pipeline knowledge, and
[workflow-derived-ports.ts](src/config/workflow-derived-ports.ts) derives a
Workflow's own ports on read rather than storing them. The full contract is in
the workspace-root [ARCHITECTURE.md](../ARCHITECTURE.md).

**All three families ship an empty built-in layer** (feature
098-runtime-only-catalog). `BUILT_IN_PHASES`, `BUILT_IN_PIPELINES` and
`BUILT_IN_WORKFLOWS` are each `Object.freeze([])` and
`schegent.defaultPipelineId` defaults to `''`, so a fresh install resolves no
Phase, no Pipeline, no Workflow and no Model until the operator imports a
document. The layer itself is retained in full: three-scope precedence
(workspace > user > built-in), the `effective` / `shadowed` / `invalid`
statuses, deterministic writable-layer revisions, and the ordered save-gate
tables in [cmd-save-phases.ts](src/ui/sidebar/commands/cmd-save-phases.ts) and
[cmd-save-pipelines.ts](src/ui/sidebar/commands/cmd-save-pipelines.ts) all
behave exactly as before — one rung of each table, built-in immutability, is now
unreachable because no id belongs to the empty layer, and it is kept because it
encodes the rule rather than the rows. `EMPTY_CATALOG` replaces the deleted
`BUILT_IN_CATALOG` as the unreadable-configuration fallback, and
`BUILT_IN_PIPELINE_ID` is deleted with no successor: a launch that resolves no
Pipeline is refused with `catalog-empty`
([empty-catalog-guidance.ts](src/contracts/empty-catalog-guidance.ts)) rather
than defaulted. `examples/` is the only process content in the package.

[src/services/process-yaml/](src/services/process-yaml/) is the portable
exchange format for all three of those families — `schegent/v1` `Phase`,
`Pipeline`, and `Workflow` documents. The latter two optionally carry the
complete definitions of what they reference, so one file is a runnable package:
a Pipeline document may include its Phases, and a Workflow document may include
its Pipelines **and**, through them, those Pipelines' Phases. Because a Workflow
has two levels of dependency where a Pipeline has one, it has its own inclusion
vocabulary rather than reusing the Pipeline's: `references-only`,
`include-pipelines`, `include-closure`. Each mode is still a single choice that
fixes the depth —
[workflow-export-closure.ts](src/services/process-yaml/workflow-export-closure.ts)
resolves node → Pipeline → Phase and de-duplicates, so a Phase reached by two
Pipelines is written once and a Pipeline reached by two nodes likewise. The service imports no `vscode` and no configuration,
and it imports the catalogs' own field bounds from
[process-definition-validator.ts](src/config/process-definition-validator.ts),
[pipeline-definition-validator.ts](src/config/pipeline-definition-validator.ts),
and
[workflow-definition-validator.ts](src/config/workflow-definition-validator.ts)
rather than restating them, so the format cannot drift from what the catalogs
accept. The scanner reads a deliberately small YAML subset rather than
delegating to a general parser, and
[scalar-style.ts](src/services/process-yaml/scalar-style.ts) is the single rule
both the scanner and the serializer consult, so what one refuses to write the
other refuses to read.

A Workflow's conditions cross the format as **structured data** —
`{ left, operator, right }` over a closed operand set — never as a string. There
is no expression language in a Workflow document, so there is nothing to parse
on import and nothing to sandbox; the graph validator compares the fields and
the runtime compares them again. The one field on the whole exchange path that
*is* an expression, a Phase's `retryCondition`, stays inert text here: the
service validates its presence, carries it verbatim, and lets
[retry-condition.ts](src/lib/retry-condition.ts) be the only thing that ever
reads it, at run time.

Two oracles answer two different questions about the same catalog, and never
from one read:
[import-planner.ts](src/services/process-yaml/import-planner.ts) answers
*presence* — scanning stored rows at every status, `shadowed` and `invalid`
included, so a write cannot silently destroy authored work — while
[package-resolver.ts](src/services/process-yaml/package-resolver.ts) answers
*resolution* against the effective catalog, because a shadowed or invalid row is
not what runs. A package can therefore legitimately show a Phase row as `skip`
beside a Pipeline row `blocked` on that same id. With three levels the blocked
reason also propagates: a Workflow blocked because its Pipeline is blocked
reports the chain to its root cause, so the operator is pointed at the Phase to
fix rather than at the intermediate. Export reads the *effective* catalog for
the opposite reason — what it writes must be the definition that actually runs.
The full rationale is in the workspace-root
[ARCHITECTURE.md](../ARCHITECTURE.md).

### IPC and Webview (`src/contracts/`, `src/ui/sidebar/`, `src/ui/dashboard/`)

[contracts/sidebar-ipc.ts](src/contracts/sidebar-ipc.ts) defines every
host↔webview message shape. [ipc-validator.ts](src/ui/sidebar/ipc-validator.ts)
provides hand-rolled type guards for each payload.

[message-router.ts](src/ui/sidebar/message-router.ts) is the host IPC
router with a two-tier gate:

1. **Workspace-trust gate** — closed-fail; missing trust information is
   treated as untrusted.
2. **Primary-host gate** — `MUTATING_COMMANDS` is the pinned list of IPC
   commands that may mutate workspace state. Commands not on the list
   are read-only and may execute from secondary VS Code windows.

`MUTATING_COMMANDS` is pinned by
[tests/unit/ui/sidebar/mutating-commands-pinned-list.test.ts](tests/unit/ui/sidebar/mutating-commands-pinned-list.test.ts);
adding a mutating command without updating both lists is a hard rule
violation (CLAUDE.md). The four config-save commands
(`saveGeneralSettings`, `saveModels`, `savePhases`, `savePipelines`)
were added to the gate in spec 056 Track 1.

The process exchange adds two commands and **neither** is mutating:
`CMD_EXPORT_PROCESS_YAML` writes a file the operator named in a host dialog and
changes no extension state, and `CMD_PREFLIGHT_PROCESS_YAML` reads one chosen
document and returns a plan. The import commits through the pre-existing catalog
saves, so it inherits their revision gate, mutation-intent check, and trust gate
rather than declaring a second write path: a Phase document through
`CMD_SAVE_PHASES`, a Pipeline package through **both** — Phases first, then
`CMD_SAVE_PIPELINES` — and a Workflow package through all **three**, adding
`CMD_SAVE_WORKFLOWS` last. Each write carries its own `expectedRevision` and its
own single `import-package` intent naming that layer's target set; a document
supplying fewer layers performs fewer writes and never merges two into one
intent to save a write. The order is load-bearing (a Pipeline written first would
reference Phases the catalog does not yet have, and a Workflow written first
would reference Pipelines it does not yet have), and a rejection stops the
sequence without retracting what already landed. Whichever prefix landed stays
written and the outcome is reported as partial — re-running the same document is
the recovery path, because the presence scan turns the already-written rows into
`skip` rows, so the retry is self-healing at whatever depth it stopped. There is
no compensating delete: it would remove rows an operator may already have edited,
on a failure path where no operator confirmed a destructive write. Both dialogs are
injected seams wired in [src/extension.ts](src/extension.ts), so no filesystem
path crosses the IPC boundary in either direction. Operator documentation:
[docs/features/phase-yaml-exchange.md](docs/features/phase-yaml-exchange.md).

Individual command handlers live under
[src/ui/sidebar/commands/](src/ui/sidebar/commands/) (~45 files).
[sidebar-view-provider.ts](src/ui/sidebar/sidebar-view-provider.ts)
mounts the webview. [csp.ts](src/ui/sidebar/csp.ts) and
[html.ts](src/ui/sidebar/html.ts) generate the strict CSP HTML scaffold
(no `unsafe-inline`, no `unsafe-eval`, nonce-based scripts).

The dashboard panel is the operator-facing detail surface
([src/ui/dashboard/](src/ui/dashboard/)). Bridge, HTML scaffold, and
panel lifecycle are split into three files.

Webview projectors are pure — they consume already-snapshotted host
state and produce display-shaped output:
[state-projector.ts](src/ui/sidebar/state-projector.ts),
[queue-projector.ts](src/ui/sidebar/queue-projector.ts),
[phase-projector.ts](src/ui/sidebar/phase-projector.ts),
[history-projector.ts](src/ui/sidebar/history-projector.ts),
[monitor-projector.ts](src/ui/sidebar/monitor-projector.ts),
[audit-tail-projector.ts](src/ui/sidebar/audit-tail-projector.ts), and
[run-projector.ts](src/ui/sidebar/run-projector.ts).
[projector-memo.ts](src/ui/sidebar/projector-memo.ts) and
[projector-handle.ts](src/ui/sidebar/projector-handle.ts) provide
memoization plumbing.

Every Svelte component is limited to 500 physical lines by a repository-wide
lint gate. Large operator surfaces retain state and IPC ownership in their
existing parents while typed semantic leaves own metric panels, pipeline and
phase editors, queue regions, dashboard panes, and activity-feed regions.
Leaves communicate through props and callbacks; they do not introduce global
stores or duplicate host-command call sites.

### Headless Entrypoints (`src/headless/`)

`src/headless/` holds the **process and run entrypoints** — the second
primary adapter described under Primary Flow. They are in-process functions
reachable only by a caller that already holds a reference; feature 089 added no
command, palette entry, executable, or listener for them.

| Entrypoint | Module | Calls |
|---|---|---|
| `validateProcessDefinition` | [process-definition-api.ts](src/headless/process-definition-api.ts) | `config/{phase,pipeline,workflow}-definition-validator.ts` |
| `previewProcessDocument` | [process-yaml-api.ts](src/headless/process-yaml-api.ts) | `services/process-yaml/preflight-service.ts` |
| `importProcessDocument` | [process-yaml-api.ts](src/headless/process-yaml-api.ts) | preflight, then the ordered per-layer catalog writes |
| `exportProcessDefinitions` | [process-yaml-api.ts](src/headless/process-yaml-api.ts) | `services/process-yaml/export-service.ts` |
| `launchPipelineRun` | [pipeline-run-api.ts](src/headless/pipeline-run-api.ts) | `services/guarded-run-service.ts` + the queue |
| `continueWorkflowRun` | [workflow-run-api.ts](src/headless/workflow-run-api.ts) | `services/workflow-execution/continuation-service.ts` |

[process-api-validators.ts](src/headless/process-api-validators.ts) is the
adapter's own boundary: `checkDefinitionArgs`, `checkDocumentBytes`,
`checkExportSelection`, `checkRunRequest`, `checkContinuationArgs`, and
`checkWorkspaceRoot` each return a `BoundaryRefusal` or `null`. It is the
headless counterpart to `ipc-validator.ts`, not a replacement for the domain
validation underneath — an argument that survives it still faces the same
service-layer rules a webview payload does.

Those three services under `src/services/` were extracted from the webview
command handlers in feature 089's Phase 1 so both adapters call one
implementation rather than two that drift: `preflight-service.ts` (import
preflight, from a 509-line handler), `export-service.ts` (document
serialization, from 473 lines), and `continuation-service.ts` (Workflow
continuation, from 138 lines). The handlers remain, reduced to adapter
concerns.

`src/headless/` and `src/telemetry/` MUST NOT import `vscode`;
one lint regression per directory enforces it —
[no-vscode-import-in-headless.test.ts](tests/lint/no-vscode-import-in-headless.test.ts)
and [no-vscode-import-in-telemetry.test.ts](tests/lint/no-vscode-import-in-telemetry.test.ts).
That constraint is what makes the second adapter possible: a headless caller
supplies host ports explicitly instead of inheriting an extension host.

### Monitor, Telemetry, Watchdog

- [src/monitor/](src/monitor/) tracks subprocess progress, stdout/stderr
  lines, stalls, rate limits, cancellation, completion, and failure.
  Monitor failures never become workflow failures. Per FR-R3-007 the line
  *content* goes to the bounded transport sink and the line *counts* to the
  `monitor-invocation-summary` audit event; the two chunk handlers no longer
  write an audit entry each. The judgements the monitor makes about an
  invocation stay audit events — `monitor-rate-limited` is still written from
  the stderr handler, on the raw line, beside the transport hand-off. Per
  FR-R3-008 both chunk handlers additionally note the chunk to
  `ActivityCoalescer`, which is the only thing that turns output into a
  persisted `WorkflowRun.liveness` stamp; the monitor supplies counters and a
  timestamp and decides nothing about when a write happens.
- [src/metrics/](src/metrics/) derives read-only dashboard metrics (task
  records, phase records, phase-type aggregates, cost timeline) from
  `.schegent/audit.log` on each `CMD_READ_METRICS` call; see spec 073.
  Per-run **detail** has no persistent storage of its own, so its horizon is
  whatever the audit log's rotation retains — which is why transport capture
  was moved out of it and given its own budget. **Cumulative totals** are the
  exception: since FR-R3-009 they compose that fold with the append-only
  `.schegent/metrics-rollup.jsonl` rollup, deduplicated by run id, so they
  survive rotation instead of shrinking with it. `metrics-rollup.ts` owns the
  record shape, the parser, and the composition; `-writer.ts` owns the
  idempotent append; `-reader.ts` owns the tolerant read. `MetricsCoverage`
  reports the totals window and the detail window separately, because a figure
  whose range is unstated reads as all-time whether or not it is one.
- [src/telemetry/](src/telemetry/) samples local process resource usage
  for operator display. Must remain vscode-free; sensitive telemetry is
  not persisted. Platform shims live in [src/telemetry/platform/](src/telemetry/platform/).
- [src/watchdog/credit-watchdog.ts](src/watchdog/credit-watchdog.ts)
  polls credit/rate-limit state for delayed retry recovery, bounded by
  configured caps and dynamic reset timestamps. The dynamic reset
  backoff is never capped below the CLI-reported reset timestamp plus
  buffer (CLAUDE.md hard rule).

## Trust Boundaries

```text
        untrusted             trusted host                   trusted host
      ┌─────────────┐       ┌─────────────────┐            ┌──────────────┐
      │ webview IPC │──IPC─▶│ message-router  │──audit────▶│ audit writer │
      └─────────────┘       │ (gate + valid.) │            └──────────────┘
                            └────────┬────────┘
                                     │
                                     ▼
                            ┌──────────────────┐
       attacker-influenced  │ phase-runner     │
       CLI stdout ────────▶│ sidecar reader   │── canonical path check
                            │ (canonical-path  │   path-outside-run-dir
                            │  containment)    │── missing-canonical-sidecar
                            └──────────────────┘
```

**Gates:**

- Workspace-trust gate at the IPC router boundary. Closed-fail on
  missing trust information.
- Primary-host gate via `MUTATING_COMMANDS` for state-mutating IPC.
- Webview CSP is nonce-based with no `unsafe-inline` or `unsafe-eval`.
- Phase-message sidecar canonical containment (spec 056 Track 2)
  rejects audit-reported paths that do not canonicalize to the
  host-computed canonical path under `<workspaceRoot>/.schegent/
  sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/
  phase-message.env`. Rejection reasons: `path-outside-run-dir`,
  `missing-canonical-sidecar`.
- Operator-authored `retryCondition` expressions are parsed by a
  sandboxed DSL evaluator that accepts identifiers, signed numerics,
  comparison operators, and boolean combinators. Arithmetic, function
  calls, member access, and I/O are rejected at parse time.
- Subprocesses are spawned with `shell: false` and bounded buffers.

For the full operator threat model see
[docs/security/threat-model.md](docs/security/threat-model.md).

## Schema Versions

| Schema | Constant | Current | Migrators |
|---|---|---|---|
| Workspace state | `STATE_SCHEMA_VERSION` ([state-schema.ts](src/contracts/state-schema.ts)) | `13` | 1→2 (011), 2→3 ([queue-state-migrator](src/state/queue-state-migrator.ts)), 3→4, 4→5, 5→6 (030), 6→7 (065, `migrateV6ToV7`), 7→8 (transcript retention + terminal-transition journal), 8→9 (088, [`migrateConnectedRuns`](src/state/connected-run-migrator.ts)), 9→10 (092, `migrateV9ToV10` — `KEYS.queue` becomes `Record<queueId, QueueState>`, lockstep asserted per entry, `KEYS.run` untouched), 10→11 (093, [`migrateV10ToV11`](src/state/run-state-migrator.ts) — `KEYS.run` becomes `Record<queueId, WorkflowRun>`), 11→12 (FR-R3-010, [`migrateV11ToV12`](src/state/history-state-migrator.ts) — `KEYS.history` becomes `Record<queueId, HistoryEntry[]>`, capped per queue rather than per workspace, never re-capped on the way past), 12→13 (FR-R3-011, `migrateV12ToV13` — pause collapses to `QueueState.queueLifecycle` + `pauseSource`; any representation reading paused wins) |
| Audit event envelope | `AUDIT_SCHEMA_VERSION` ([audit-events.ts](src/contracts/audit-events.ts)) | `3` | Additive event types and additive payload fields do not bump the version (per the comment policy). Neither does retiring a *writer*: FR-R3-007 removed the `monitor-stdout-line` / `monitor-stderr-line` writers and left both types registered as read-only, so archived logs keep parsing without a warning |

State migrators are forward-only and tolerate old records. Versions
exceeding the runtime version raise an explicit "Update the extension"
error rather than silently overwriting. CLAUDE.md hard rule:
"Never bypass the v2 → v3 state migration or any later forward-only
migration."

## Extension Points

| Surface | Update |
|---|---|
| New backend runner | Implement [`BackendRunner`](src/contracts/backend-runner.ts); register in [`backend-runner-factory.ts`](src/runner/backend-runner-factory.ts); controller semantics unchanged. |
| New mutating IPC command | Add to `MUTATING_COMMANDS` in [`message-router.ts`](src/ui/sidebar/message-router.ts); add a payload validator in [`ipc-validator.ts`](src/ui/sidebar/ipc-validator.ts); update the pinned-list test; add a webview helper or button. |
| New phase tunable | Add to settings schema, package contributions, host catalog/precedence projection, IPC contract, and operations docs in one change. |
| New runtime sink | Use `SanitizedLogger` unless the threat model declares the sink intentionally unredacted and local-only. |
| New persisted state field | Add a forward-only migrator; ensure parser tolerance for old records; bump `STATE_SCHEMA_VERSION` if shape changes; update docs. |
| New audit event type | Define in [`audit-events.ts`](src/contracts/audit-events.ts); readers preserve unknown types (CLAUDE.md hard rule). |
| New secret pattern | Add to `SECRET_PATTERNS` in [`logger.ts`](src/lib/logger.ts) — adding to the array auto-extends the precompiled union. Do not fork the redaction set. |

## Reliability Invariants

- Workspace locks are released through the lock manager; retained locks are intentional pause exits only. Window primacy is acquired at activation and released at disposal — no Run-scoped path releases it (FR-028, SC-009).
- Both leases are acquired by exclusive create against the on-disk ownership record and carry a monotonic fencing token checked at the point of effect; storage that cannot answer refuses the acquisition rather than assuming it.
- Phase timeout, cancellation, fatal signatures, rate limits, and parser failures map to explicit outcomes.
- A clean token from truncated parser buffers fails closed as a terminal failure because fatal evidence may exist in the discarded middle.
- Runtime artifact writes are best-effort unless the artifact is the structured audit record required for evidence.
- The controller owns `WorkflowRun` mutation. Webview and services request transitions through host commands or controller methods.
- Settings writes are validated before mutation and attempt rollback on partial failure.
- Queue removal is not rolled back by session-cleanup I/O failure.
- The audit log is append-only across every code path; task and phase deletion never erase `.schegent/audit.log`.

## Performance Notes

- Hot parsers avoid broad JSON parsing. `rate-limit-reset-extractor` filters common allow events before parse; `invocation-usage` parses only short lines containing both `"type"` and `"result"`.
- Runner parsing buffers are bounded head/tail windows so malformed or noisy CLI output cannot grow memory without limit; the independent raw-transcript tee applies disk-stream backpressure.
- The sanitization hot path uses two precompiled regex unions (case-sensitive and case-insensitive) — each `SanitizedLogger.sanitize()` call costs two regex passes, not N (where N is the number of patterns).
- Snapshot projection and phase-log display projection are pure and testable. The UI consumes already-projected state rather than walking disk state or live controller structures.
- Performance budgets are pinned in `tests/perf/budgets.json` (feature 049).

## Verification Surface

The pre-merge gate is `npm run ci` from `repo/`. It runs host and webview
typechecks, lint, host unit/integration tests, webview tests,
deterministic E2E tests, production builds, and VS Code integration
smoke tests. Targeted tests (`npx vitest run <pattern>`) are useful while
iterating, but the full gate is the release-level signal.

`.github/workflows/`:

- `pr.yml` — fast PR gate: typecheck + lint + unit + build.
- `ci.yml` — full gate on a different trigger.
- `codeql.yml` — security scanning.
- `full-gate.yml` (added by spec 056 Track 6) — scheduled / manual; runs
  the deterministic E2E suite and the extension-host integration suite
  before release-tag merges. `RELEASE.md` documents the release gate.

Doc-drift lint regressions under `tests/lint/` enforce that operations
docs do not reference removed symbols and that documented defaults
match package contributions.
