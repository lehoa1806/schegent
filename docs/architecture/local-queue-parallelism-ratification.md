# Local queue parallelism ratification

Status: Accepted narrowing of the remote/multi-user expansion gate

Decision: Schegent may execute more than one Run at a time only when the Runs
belong to different queues inside one canonical workspace, one local operator
controls one authoritative extension-host process, and the workspace-wide cap
remains within the queue registry's declared bound. This record does not approve
remote submission, multiple mutating principals, multiple coordinating hosts,
tenant sharing, or service-owned workspaces.

The implementation arrived in feature 092 before the broader gate's RFC and
exit-criteria process was followed. This record is the post-implementation
ratification: it evaluates the shipped shape, states why it is narrower than the
rejected remote shape, and lists premises that automatically reopen the decision
if they move.

<!-- Source: docs/architecture/remote-multi-user-expansion-gate.md -->
<!-- Source: src/state/workspace-state.ts -->
<!-- Source: src/queue/queue-manager.ts -->
<!-- Source: src/state/execution-lease.ts -->

## Decision boundary

The authorized topology is:

```text
one local operator
        |
one authoritative VS Code extension host
        |
one canonical workspace / one shared working tree
        |
N queues, each sequential and separately leased
        |
at most globalConcurrencyCap active Runs
```

Concurrency is across queues, never within one queue. Window primacy remains one
holder per workspace from activation until disposal. Execution ownership is a
separate lease with one holder per queue. Every concurrent Run still operates
on the same working tree, under the same local backend permission posture and
the same operator trust decision.

<!-- Source: src/state/lock.ts -->
<!-- Source: src/state/execution-lease.ts -->
<!-- Source: src/state/workspace-folder-picker.ts -->
<!-- Source: src/queue/queue-manager.ts -->

## Shipped mechanism

Workspace state now stores queue execution records, active Runs, and history as
maps keyed by queue ID. The migrations are forward-only: the queue map was
introduced first, then the active-Run map, then per-queue history, followed by a
pause-state collapse within each queue record. A future state version is refused
rather than interpreted as an older shape.

The queue manager enforces two capacities. `hasQueueCapacity(queueId)` preserves
one in-flight Task for the addressed queue. `hasWorkspaceCapacity()` compares
all in-flight work with the global setting. The drain coordinator additionally
reserves a capacity slot across awaited admission so two concurrent local
continuations cannot both spend the same observed vacancy.

The public setting defaults to one, has a minimum of one and maximum of twenty,
and refuses invalid values instead of clamping them. The enforcing ceiling
derives from the queue-registry constant; three settings surfaces advertise the
same range. All six definition sites cite this authority record.

<!-- Source: src/contracts/state-schema.ts -->
<!-- Source: src/state/queue-state-migrator.ts -->
<!-- Source: src/state/run-state-migrator.ts -->
<!-- Source: src/state/history-state-migrator.ts -->
<!-- Source: src/queue/queue-manager.ts -->
<!-- Source: src/services/auto-drain-coordinator.ts -->
<!-- Source: src/contracts/validators/queue-management.ts -->
<!-- Source: src/config/settings-schema.ts -->
<!-- Source: src/config/general-settings.ts -->
<!-- Source: package.json -->

## Disposition of the expansion-gate criteria

The broad expansion gate has seven exit criteria. This narrowing is accepted
because it does not introduce most of the capabilities those criteria guard,
and because the concurrent parts it does introduce have explicit local
mechanisms.

### 1. Authentication and authorization

Disposition: no new principal or remote entry point.

Workspace Trust remains the ceiling for mutating sidebar commands, and the
authoritative-window predicate still gates those commands after trust. The
execution lease cannot grant UI primacy and is not an identity credential; it
only excludes a second executor for the same queue. Both Runs therefore inherit
one operator's local authorization decision.

This disposition fails if a second human, service account, API client, or host
process can submit mutations. That change requires genuine authentication and
per-action authorization under the broader gate.

<!-- Source: src/ui/sidebar/message-router.ts -->
<!-- Source: src/state/lock.ts -->
<!-- Source: src/state/execution-lease.ts -->

### 2. Tenant and workspace isolation

Disposition: no tenant boundary is added.

All queues remain under one canonical local workspace and one state store. A
queue ID addresses state; it is not a tenant identifier or a filesystem root.
Concurrent Runs deliberately share the operator's working tree. The operator
must choose work that can safely coexist, and ordinary Git conflicts or
overlapping edits remain possible.

This decision therefore does not claim isolation between concurrent Runs. It
claims only correct state attribution by queue and prevents one queue's
transition from rewriting a sibling queue's Run record.

<!-- Source: src/state/workspace-folder-picker.ts -->
<!-- Source: src/state/workspace-state.ts -->
<!-- Source: tests/integration/concurrent-run-execution.test.ts -->

### 3. Durable scheduling, locking, and recovery

Disposition: satisfied for one local host and separately addressed queues.

Each queue's execution lease uses the ownership registry's generation fence and
the same heartbeat/staleness constants as window primacy. Admission claims the
lease before it creates an active Run; terminal transition releases that queue's
lease without touching siblings. Scheduled-start timers and watchdog recovery
are addressed by queue ID.

Durable state changes supplied the migration half of the decision: queue state,
active Runs, and history can coexist for multiple queues without one record
being the singleton overwritten by another. The current state version also
collapses persisted pause state to one answer inside each queue record, which
does not weaken the per-queue reasoning.

The design is not distributed. Its lease authority is one local filesystem and
its scheduler is one process. Multiple machines or replicated workers reopen
the broader criterion.

<!-- Source: src/state/ownership-registry.ts -->
<!-- Source: src/state/execution-lease.ts -->
<!-- Source: src/services/auto-drain-coordinator.ts -->
<!-- Source: src/services/execution-lease-release.ts -->
<!-- Source: src/services/scheduled-start-coordinator.ts -->
<!-- Source: src/controller/schedule-watchdog.ts -->
<!-- Source: src/contracts/state-schema.ts -->

### 4. Secret handling

Disposition: no new secret store or transport.

All backend processes still receive the same configured spawn-environment
policy from the same extension host. Parallel execution can create more than
one simultaneous child process, but it does not introduce a remote worker,
broker, tenant, or serialized credential. The existing warning for unrestricted
environment inheritance and the default allowlist posture remain applicable.

This is accepted only under one operator and one host trust domain. Moving a Run
to another process or machine would require the Secret brokering criterion in
the expansion gate.

<!-- Source: src/runner/spawn-env.ts -->
<!-- Source: src/activation/backend-wiring.ts -->
<!-- Source: package.json -->

### 5. Evidence, attribution, and privacy

Disposition: concurrent records are addressed and ambiguous recovery evidence
declines honestly.

Active Run state and history are keyed by queue. Structured audit continues to
use Run correlation identifiers and bounded payload projection. Terminal
transitions remove and record only the addressed queue's Run. Tests deliberately
interleave two Runs and verify that one completing, pausing, retrying, or being
canceled does not mutate its sibling.

Recovery checkpoints require a mutation ledger and a count of live Runs. With
one Run, the service can write the whole-tree diff. With siblings, it writes a
scoped patch only when attribution evidence is complete and paths do not
conflict; otherwise it emits a decline marker rather than presenting an
unreliable checkpoint. This is an attribution rule, not filesystem isolation.

All evidence remains local and retains its existing sensitivity: raw transcripts
and patches may contain source or secrets. Parallelism does not authorize wider
read access or a different retention owner.

<!-- Source: src/state/run-state-migrator.ts -->
<!-- Source: src/state/history-state-migrator.ts -->
<!-- Source: src/audit/audit-payload.ts -->
<!-- Source: src/services/terminal-transition-coordinator.ts -->
<!-- Source: src/services/run-mutation-ledger.ts -->
<!-- Source: src/services/run-checkpoint-service.ts -->
<!-- Source: tests/integration/concurrent-run-execution.test.ts -->

### 6. Backend and tool policy

Disposition: backend authority is unchanged and remains a per-Run fact.

Each admitted Run freezes its Pipeline snapshot and effective runner choice.
The backend adapters use the same argv whether or not a sibling Run exists.
Parallelism adds worktree-interleaving risk but does not add a tool, widen a
sandbox, enable remote egress, or create a new approval path.

The operator must assume concurrently executing unsandboxed backends can observe
and change the shared tree. Codex retains its `workspace-write` sandbox and
Git-metadata restriction; Claude and Agy retain disabled CLI approval prompts.
Those unequal permission boundaries are unaffected by this record.

<!-- Source: src/services/workflow-run-factory.ts -->
<!-- Source: src/config/pipeline-snapshot.ts -->
<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: src/runner/codex-cli.ts -->
<!-- Source: src/runner/agy-cli.ts -->

### 7. Rollout and rollback

Disposition: opt-in by setting, conservative by default, forward-only in state.

The shipped default is one, so existing operators retain sequential workspace
behavior until they deliberately raise the cap. The configured value is
validated at every defining boundary and invalid input is refused. Setting the
cap back to one stops new cross-queue admissions once current work releases its
slots; it does not kill a Run already admitted.

State migration is not rolled back. A host that cannot understand the persisted
version refuses it. The implementation and integration suites cover simultaneous
execution, queue isolation, capacity, lease lifetime, terminal independence,
retry, cancellation, and deterministic interleavings.

<!-- Source: src/state/workspace-state.ts -->
<!-- Source: src/contracts/validators/queue-management.ts -->
<!-- Source: src/services/auto-drain-coordinator.ts -->
<!-- Source: src/contracts/state-schema.ts -->
<!-- Source: tests/integration/concurrent-run-execution.test.ts -->
<!-- Source: tests/integration/concurrency-cap.test.ts -->

## Re-evaluation trigger premises

The decision rests on eleven separately changeable facts. A change to any row
expires this ratification; it is a trigger for architectural re-evaluation, not
an invitation to update the number in prose.

| # | Premise | Value it is pinned at | Where it is observable |
|---|---|---|---|
| 1 | Mutating operator identities | one, local | Workspace Trust and the authoritative `WorkspaceLockManager` |
| 2 | Host processes executing Runs | one | the primary VS Code extension host |
| 3 | Filesystem owners | one | the local canonical workspace and `.schegent/` state |
| 4 | Network surface for command or state access | none | no listening endpoint in the extension host |
| 5 | `MAX_QUEUES` | 20 | `src/queue/queue-registry.ts` (declared); the cap ceiling derives from it |
| 6 | The cap's maximum | 20 | the three enforcing and three advertising definition sites |
| 7 | Window-primacy lease cardinality | one holder per workspace | `WorkspaceLockManager` |
| 8 | Execution lease tenure | per queue, admission through terminal transition | `ExecutionLeaseManager` and terminal release service |
| 9 | Working trees shared by concurrent Runs | one, operator-owned | the canonical workspace passed to every runner |
| 10 | State schema version | 14, forward-only, downgrade refused | `src/contracts/state-schema.ts` |
| 11 | Content provenance across queues | one operator and one workspace trust level | the local host boundary |

**Row ten moved 13 → 14 on 2026-08-27 (FR-R3-117), and the ratification survives.**
The trigger fired and the re-evaluation was done rather than the number edited.
v14 stamps a resolved `hostVerification` and its provenance into each phase of a
persisted plan snapshot: a forward-only rewrite **within** a record, adding two
fields to an object that already existed. It reshapes no record map, and it
touches none of the cardinalities this decision actually rests on — operators,
hosts, filesystem owners, network surface, queue count, lease tenure, or shared
working trees are all unchanged. The downgrade refusal still compares against the
runtime `STATE_SCHEMA_VERSION` rather than a literal, so it tightened with the
bump automatically. The shape of the argument is unchanged, for the same reason
v12 and v13 left it unchanged.

Rows five, six, and ten are mechanically compared with their source constants.
The other rows describe the deployment shape and must be checked during design
review because a unit test cannot prove the number of real operators or hosts.

<!-- Source: src/queue/queue-registry.ts -->
<!-- Source: package.json -->
<!-- Source: src/contracts/state-schema.ts -->
<!-- Source: tests/lint/cap-authority-citation-parity.test.ts -->

## Authority citation and drift control

The following sites define the setting's values and therefore cite this record:

| Role | Definition site |
|---|---|
| Enforces | `src/state/workspace-state.ts` |
| Enforces | `src/queue/queue-manager.ts` |
| Enforces | `src/contracts/validators/queue-management.ts` |
| Advertises | `src/config/settings-schema.ts` |
| Advertises | `src/config/general-settings.ts` |
| Advertises | `package.json` |

Contract, generated-schema, command, and webview files may carry the field
without defining its range. The citation parity test discovers every source
mention and requires each one to be classified, preventing a new seventh
definition from appearing without review.

<!-- Source: tests/lint/cap-authority-citation-parity.test.ts -->

## Residual risks accepted by this decision

Concurrent Runs share one worktree. They may edit the same path, observe each
other's uncommitted work, consume more CPU and memory, compete for backend quota,
and produce interleaved operator-visible activity. A queue ID is not a security
boundary. The global cap limits simultaneous admission but does not reserve
resources or guarantee fairness.

Checkpoint attribution reduces the chance that a recovery patch includes a
sibling's work, but a declined checkpoint can leave the operator without a
patch, and a malicious or misbehaving subprocess can under-report or obscure
its writes. The system responds conservatively when attribution is incomplete;
it does not claim perfect process isolation.

These risks are acceptable for one informed local operator choosing an opt-in
cap. They are not acceptable evidence for remote or multi-user expansion.

<!-- Source: src/services/run-checkpoint-service.ts -->
<!-- Source: src/services/run-mutation-ledger.ts -->
<!-- Source: src/queue/queue-manager.ts -->
<!-- Source: package.json -->

## Decision outcome

The range wider than one is ratified for the pinned local topology. The default
remains one; each queue remains sequential; window primacy remains singular;
and the cap cannot exceed the queue registry. Any proposal that changes those
facts must return to the remote/multi-user gate and satisfy its architecture RFC,
threat model, and exit criteria before implementation.

<!-- Source: docs/architecture/remote-multi-user-expansion-gate.md -->
<!-- Source: src/state/workspace-state.ts -->
<!-- Source: src/queue/queue-registry.ts -->
