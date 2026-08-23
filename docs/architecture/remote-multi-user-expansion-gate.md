# Remote and multi-user expansion gate

Status: Accepted product-boundary decision

Schegent's implemented authority model is local: one operator, one canonical
workspace, and one VS Code extension-host process holding authoritative window
primacy. The extension exposes no listening API and has no tenant, account, or
service-scheduler layer. A proposal for remote control, multiple operators, or
multiple coordinating host processes must pass this gate before implementation.

Same-workspace parallel Runs inside one authoritative local host are a narrow
exception ratified separately. They do not authorize a network surface, a
second mutating principal, or service ownership of the working tree.

<!-- Source: src/extension.ts -->
<!-- Source: src/state/lock.ts -->
<!-- Source: src/state/workspace-folder-picker.ts -->
<!-- Source: src/queue/queue-manager.ts -->

## Original decision and its local narrowing

The concurrency cap remains pinned at one. This sentence records the original
decision and is superseded only for the single-local-operator shape described
in the status update below. It remains the default posture and remains current
for remote, multi-user, multi-host, and service-owned execution.

The original constraint was conservative because one process, one owner, one
queue, and one working tree made state transition ownership inspectable. Merely
raising a number could not answer who authenticated a request, which tenant
owned the files, how a crashed scheduler recovered, or how two writers avoided
duplicating effects.

<!-- Source: src/state/workspace-state.ts -->
<!-- Source: package.json -->
<!-- Source: src/state/lock.ts -->

## Status update — feature 092

Feature 092 implemented concurrent Runs across separate queues in one local
workspace. It added per-queue state maps, per-queue execution leases, addressed
scheduling, and a workspace-wide concurrency setting while retaining one
authoritative window and one Task per queue. The shipped default is one and the
upper bound derives from the queue-count ceiling.

This narrowing did not go through the implementation RFC and exit criteria in
this record before the implementation landed. The later local-parallelism
ratification evaluates that shipped shape against the criteria and authorizes
only these premises:

- one local human principal;
- one extension-host process with one authoritative-window lease;
- one canonical workspace and one operator-owned working tree;
- no remote command or state endpoint;
- one executing Task per queue, with a per-queue lease; and
- an opt-in global cap whose default remains one.

If any premise changes, the exception expires and this gate applies in full.

<!-- Source: src/contracts/state-schema.ts -->
<!-- Source: src/state/queue-state-migrator.ts -->
<!-- Source: src/state/run-state-migrator.ts -->
<!-- Source: src/state/execution-lease.ts -->
<!-- Source: src/state/workspace-state.ts -->
<!-- Source: docs/architecture/local-queue-parallelism-ratification.md -->

## Required design areas

The following areas are mandatory parts of a remote or multi-user design. A
proposal is incomplete if it treats one as a follow-up.

### Authentication and authorization

Workspace Trust is a local VS Code signal, not user authentication. Window
primacy identifies one local host owner, not a human or service identity. A
remote design must define authenticated principals, credential lifecycle,
revocation, session expiry, service identities, and authorization for every
read and mutation. Queue start, cancel, retry, catalog publication, settings
changes, evidence reads, and destructive cleanup need explicit permissions.

Authorization must be enforced at the authoritative host boundary, not only by
hiding a webview control. Audit events must identify a stable principal without
including secrets or bearer credentials.

<!-- Source: src/ui/sidebar/message-router.ts -->
<!-- Source: src/state/capability-trust-resolver.ts -->
<!-- Source: src/state/lock.ts -->
<!-- Source: src/audit/audit-payload.ts -->

### Tenant and workspace isolation

Today one canonical local folder supplies the state and filesystem scope. A
remote service must define tenant and workspace identifiers independently of a
client-provided path. Every database row, object-store key, queue, Run, catalog
version, log, checkpoint, secret, cache, and metric needs tenant-qualified
ownership.

Filesystem access must be mediated by service-owned workspace roots and safe
path resolution. A request from one tenant must be unable to select another
tenant's root, follow a link into it, infer its existence through timing or
errors, or receive its identifiers in a projection.

<!-- Source: src/state/workspace-folder-picker.ts -->
<!-- Source: src/lib/path-containment.ts -->
<!-- Source: src/contracts/run-request.ts -->

### Durable scheduling and execution

The local scheduler uses in-process timers plus persisted queue intent and
activation-time reattachment. That is appropriate for one host, but a remote
service needs durable jobs whose ownership survives process and machine loss.
The design must specify admission transactions, visibility timeouts or leases,
retry state, cancellation, backpressure, fairness, capacity, and recovery from
a worker dying at every transition.

At-least-once delivery is not the same as at-most-once effect. The design must
state which operations can repeat, which require an idempotency key, which are
transactional, and how an operator observes an ambiguous outcome.

<!-- Source: src/services/scheduled-start-coordinator.ts -->
<!-- Source: src/controller/schedule-watchdog.ts -->
<!-- Source: src/services/auto-drain-coordinator.ts -->
<!-- Source: src/services/terminal-transition-coordinator.ts -->

### Distributed locking and idempotency

The current ownership registry uses exclusive local filesystem creation and a
generation fence. The window lease has one holder per workspace; execution
leases have one holder per queue. These mechanisms do not coordinate separate
machines or a replicated control plane.

A distributed design must choose a consistency model and lease authority,
carry fencing tokens to every state-changing effect, define clock and expiry
assumptions, and prove that a stale worker cannot commit after replacement.
Every externally retried mutation needs a stable idempotency key and a durable
result record so a timeout does not become a duplicate Run.

<!-- Source: src/state/ownership-registry.ts -->
<!-- Source: src/state/lock.ts -->
<!-- Source: src/state/execution-lease.ts -->

### Secret brokering

Local runners inherit a configured subset of the extension-host environment.
A hosted worker cannot rely on ambient operator credentials. It needs an
explicit broker that authorizes secret access by tenant, workspace, backend,
and Run; delivers only the minimum material for the minimum time; records access
without recording values; and supports rotation and revocation.

Secrets must not enter queue payloads, catalog definitions, structured audit,
logs, metrics, crash reports, or client-visible errors. Worker teardown must
remove temporary credentials and account for subprocess descendants.

<!-- Source: src/runner/spawn-env.ts -->
<!-- Source: src/lib/logger.ts -->
<!-- Source: src/audit/audit-payload.ts -->

### Evidence, retention, and privacy

The local product distinguishes metadata-only audit, sanitized runtime logs,
unredacted transcripts, verbose diagnostics, and recovery checkpoints. A remote
service must preserve those distinctions and add data residency, encryption,
access logging, export, deletion, legal retention, backup, restore, and incident
response policies.

Retention must be enforceable per tenant and evidence class. Checkpoints and
transcripts can contain source code and secrets, so access to a queue or Run
summary must not imply access to those artifacts. A deletion workflow needs a
documented result for partial failure and immutable compliance records that do
not recreate deleted content.

<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: src/lib/runtime-log/runtime-log-sink.ts -->
<!-- Source: src/services/run-checkpoint-service.ts -->
<!-- Source: src/services/run-checkpoint-retention.ts -->

### Prompt-injection and tool policy

A remote or shared service combines content from users, repositories, prior
outputs, catalog instructions, and backend models. It must treat all of that as
untrusted input. The design must define permitted tools and destinations,
network egress, file and Git authority, approval policy, content provenance,
cross-tenant retrieval controls, and behavior when instructions conflict.

Catalog declarations can select consent and rollback behavior, but they do not
confine a backend process. Enforcement must live at the worker and operating
system boundary, with a policy that cannot be weakened by repository content.

<!-- Source: src/contracts/run-request.ts -->
<!-- Source: src/services/mutation-plan.ts -->
<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: src/runner/codex-cli.ts -->
<!-- Source: src/runner/agy-cli.ts -->

### Rollout and rollback

Remote execution needs a staged rollout with tenant allowlists, observable
capacity and error budgets, compatibility checks for clients and workers, and a
kill switch that prevents new admission without abandoning already-owned work.
Schema changes require forward and backward application compatibility during a
mixed-version deploy, even if durable data migrations themselves remain
forward-only.

Rollback must explain what happens to leased work, scheduled starts, terminal
transitions, catalog revisions, evidence uploads, and secret grants. “Deploy the
old binary” is not a rollback plan when the old binary cannot understand newly
written state.

<!-- Source: src/contracts/state-schema.ts -->
<!-- Source: src/state/workspace-state.ts -->
<!-- Source: src/services/terminal-transition-coordinator.ts -->

## Required threat model

Before implementation, the proposal must publish a threat model that names:

1. assets, principals, trust boundaries, entry points, and data flows;
2. tenant-crossing and workspace-crossing attack paths;
3. stolen credentials, revoked users, compromised workers, and malicious
   repository content;
4. replay, duplicate delivery, stale leases, split brain, and confused-deputy
   scenarios;
5. backend process escape, unsafe tool calls, network egress, and dependency
   compromise;
6. evidence disclosure, deletion failure, backup exposure, and operator abuse;
7. detection, containment, recovery, and responsible owners for each material
   risk; and
8. verification evidence showing the controls at the actual authority boundary.

The model must distinguish product controls from deployment assumptions. A
statement such as “the network is private” or “workers are trusted” is an
assumption to test and monitor, not a substitute for authorization.

<!-- Source: docs/security/threat-model.md -->
<!-- Source: src/ui/sidebar/message-router.ts -->
<!-- Source: src/state/ownership-registry.ts -->
<!-- Source: src/runner/backend-runner-factory.ts -->

## Exit criteria

A remote or multi-user implementation may begin only after an architecture RFC
and threat model satisfy all of these criteria:

1. Every command and data read maps to authenticated principal and explicit
   authorization policy.
2. Tenant-qualified storage and execution roots have negative isolation tests.
3. Durable scheduling specifies delivery, lease, fencing, idempotency, crash
   recovery, and ambiguous-outcome behavior.
4. Secret brokering has a concrete provider, scoping model, rotation procedure,
   and audit story that never records values.
5. Evidence classes have encryption, access, retention, export, deletion,
   backup, restore, residency, and privacy owners.
6. Worker tool, filesystem, Git, and egress policies are enforced outside
   operator-controlled content and tested against injection attempts.
7. Rollout, compatibility, rollback, incident response, observability, capacity,
   and cost controls have named owners and rehearsed procedures.

The RFC must include an incremental implementation plan and evidence for each
criterion. Passing this gate is a review decision recorded in the repository;
the absence of an objection or the presence of a prototype is not approval.

<!-- Source: tests/lint/product-boundary-decisions.test.ts -->
<!-- Source: ARCHITECTURE.md -->

## Re-evaluation triggers

The local exception must be re-evaluated if any of these become true: more than
one mutating human principal, more than one coordinating host process, a network
endpoint for command or state access, service-owned workspaces, remote workers,
tenant-shared storage, brokered credentials, or a concurrency ceiling beyond the
queue registry's declared maximum. Each change invalidates a premise rather
than merely requesting a documentation refresh.

<!-- Source: docs/architecture/local-queue-parallelism-ratification.md -->
<!-- Source: src/queue/queue-registry.ts -->
<!-- Source: src/state/workspace-state.ts -->
