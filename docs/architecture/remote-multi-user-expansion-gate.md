# Remote, multi-user, and parallel execution expansion gate

Status: Accepted architecture decision (2026-08-01)

Decision: Schegent's current local, single-operator architecture must not be
expanded into remote control, shared multi-user operation, or parallel agents
in one workspace by increasing `schegent.queue.globalConcurrencyCap`, adding a
network endpoint, or weakening the workspace lock. Such work is blocked until
a separate implementation RFC satisfies every exit criterion in this record.

One carve-out, taken 2026-08-15: the `schegent.queue.globalConcurrencyCap`
half of that prohibition is narrowed for local queue parallelism under one
local operator, one host process, and one filesystem owner, per
[local-queue-parallelism-ratification.md](./local-queue-parallelism-ratification.md).
The network-endpoint and workspace-lock halves are untouched, and every
expansion beyond that narrow shape still requires the RFC and all seven exit
criteria.

This is an expansion blocker, not a defect in the supported local product.

## Scope that triggers this gate

The gate applies if a proposal introduces any of the following:

- commands or state access from outside the local VS Code host;
- more than one mutating operator or service identity;
- parallel workers or agents targeting the same canonical workspace
  — [narrowed 2026-08-15 for one shape only: N local queues under one operator,
  one host process, one filesystem owner, no network surface, per
  [local-queue-parallelism-ratification.md](./local-queue-parallelism-ratification.md).
  Any other parallelism, including a worker that outlives the host process,
  still triggers the gate];
- a shared scheduler, queue, evidence store, secret store, or control plane;
- cross-tenant storage, dashboards, logs, metrics, or administration.

Separate local VS Code windows remain covered by the existing primary-host
read-only/mutating split. Separate workspaces remain independent local trust
domains.

## Why the current architecture cannot be widened incrementally

| Current assumption | Expansion failure mode |
|---|---|
| VS Code Workspace Trust represents the operator trust decision. | It cannot authenticate a remote human or workload identity. |
| `workspaceState` and local `.schegent/` files are the state/evidence stores. | They provide no tenant isolation, transactional scheduler, or distributed consistency. |
| One primary host and one workspace lock serialize mutation/execution. | A second machine or stale worker can ignore or outlive the local lock. |
| The configured CLI receives local filesystem and environment capabilities. | Remote workers require explicit workspace sandboxing and secret brokering. |
| Local audit and retention policy have one operator and one filesystem owner. | Shared evidence requires tenant-scoped policy, access control, integrity, and deletion semantics. |
| Prompt content is trusted at the local operator boundary. | Shared ingestion creates cross-user prompt-injection and confused-deputy paths. |

The concurrency cap remains pinned at one. [Superseded 2026-08-15 for the
local single-operator shape only: the cap's range is `[1, 20]` with a default
of 3. This sentence is retained unedited as the record of the position before
that change; the current position is in
[local-queue-parallelism-ratification.md](./local-queue-parallelism-ratification.md).]
A cap change is not an architecture for coordination, identity, isolation, or
recovery.

## Required implementation RFC

The future RFC must define one end-to-end design, including the following
mandatory sections and test evidence.

### Authentication and authorization

- Use explicit human and workload identities with short-lived credentials;
  no identity may be inferred from a workspace path, hostname, or bearer token
  stored in repository files.
- Define authorization for every resource/action pair: tenant, workspace,
  queue, task, run, phase control, settings, evidence, secrets, and admin
  operations.
- Re-authorize mutating operations at the authoritative service, not only in a
  browser or client. Include revocation, session expiry, replay defense, and
  break-glass audit behavior.

### Tenant and workspace isolation

- Namespace state, evidence, caches, metrics, and encryption keys by tenant and
  workspace using server-derived identity, never client-supplied paths.
- Specify worker filesystem isolation, egress policy, resource limits, cleanup,
  and protection against symlink/path traversal and cross-workspace mounts.
- Prove negative cross-tenant tests for every read, mutation, log, artifact,
  backup, restore, and administrative path.

### Durable scheduling and execution

- Replace local memento scheduling with a transactional durable queue and an
  explicit at-least-once delivery model.
- Define leases, heartbeats, retry/backoff caps, poison-task handling,
  cancellation, priority/fairness, clock-skew tolerance, and recovery after
  scheduler or worker restarts.
- Preserve a frozen, versioned pipeline snapshot per run and make compatibility
  behavior explicit during rolling deployments.

### Distributed locking and idempotency

- Use lease epochs or fencing tokens so a stale worker cannot write state or
  evidence after ownership moves.
- Assign idempotency keys to every externally retried mutation and execution
  attempt. Specify deduplication scope and retention.
- Make state transitions conditional on the expected version and prove that
  duplicate delivery cannot start two backend subprocesses or emit conflicting
  terminal outcomes.

### Secret brokering

- Store provider and repository credentials outside task payloads, prompts,
  workspace state, logs, and evidence.
- Issue least-privilege, short-lived worker credentials bound to tenant,
  workspace, run, backend, and expiry; define revocation and rotation.
- Prohibit ambient host-environment inheritance for shared workers. Audit
  metadata without recording secret values or recoverable error text.

### Evidence, retention, and privacy

- Define tenant-scoped schemas, encryption, integrity/tamper evidence, access
  logging, legal/deletion holds, export, retention quotas, and backup/restore.
- Separate redacted operational evidence from explicitly authorized raw
  artifacts. A raw artifact must never become a default remote diagnostic.
- Specify behavior when authoritative evidence is unavailable; execution must
  retain the current fail-closed safety property.

### Prompt-injection and tool policy

- Label content provenance and trust level across user input, repository files,
  generated artifacts, retrieved content, and inter-agent messages.
- Define tool allowlists, network/egress controls, human approval points, and
  defenses against one tenant or agent influencing another's execution.
- Treat model output as untrusted data at every control-plane boundary. No
  model-emitted command may bypass authorization, idempotency, or sandboxing.

### Rollout and rollback

- Provide schema/version compatibility, feature flags, canary cohorts, drain
  behavior, rollback ordering, and recovery for mixed-version workers.
- Demonstrate rollback without duplicate execution, lost cancellation,
  orphaned leases, inaccessible evidence, or authorization widening.
- Keep the existing local execution path independently releasable until the
  remote path meets the full evidence gate.

## Required threat model

The RFC must replace the local-only threat assumptions with a reviewed network
threat model covering at least: credential theft, authorization bypass,
cross-tenant data access, replay, CSRF, SSRF, request smuggling, malicious
workers, stale leases, supply-chain compromise, prompt injection, artifact
poisoning, denial of service, quota abuse, audit tampering, backup leakage, and
incident response. Abuse cases and negative tests are required; a diagram
alone is insufficient.

## Exit criteria

Expansion is eligible for implementation approval only when all of these are
true:

1. Architecture and security reviewers approve the implementation RFC and its
   updated threat model.
2. Authentication/authorization and tenant-isolation contracts have automated
   negative tests.
3. Scheduler, lease/fencing, idempotency, cancellation, crash recovery, and
   rolling rollback pass deterministic fault-injection tests.
4. Secret brokering and evidence retention have an operational owner,
   documented rotation/deletion procedures, and no secret-bearing default
   diagnostic path.
5. Prompt/tool policy is enforced outside the model and has adversarial tests.
6. A staged rollout has measurable stop conditions and a tested return to the
   local path.
7. The local single-run gate remains green; expansion does not silently change
   local trust, audit, redaction, or package guarantees.

Until all seven are evidenced, F-025 remains an accepted expansion boundary:
local releases may proceed, but remote/multi-user/parallel execution may not.
One exception, and only one: the narrow local-parallelism shape — N queues
under one operator, one host process, and one filesystem owner, with no network
surface — is separately dispositioned against all seven criteria in
[local-queue-parallelism-ratification.md](./local-queue-parallelism-ratification.md)
and was ratified on 2026-08-15. Everything outside that shape, including every
remote and multi-user case, still requires all seven.

## Status update — feature 092 (2026-08-12)

Feature 092 (FR-R2-011, multi-queue concurrent execution) ships
same-workspace parallel execution for a **single local operator**:
`MAX_QUEUES` is 20, `schegent.queue.globalConcurrencyCap` defaults to 3 with
range `[1, 20]`, and up to N queues drain concurrently in one canonical
workspace, each holding its own per-queue execution lease.

That directly narrows one clause of this gate — "parallel workers or agents
targeting the same canonical workspace" — and it invalidates the sentence
"The concurrency cap remains pinned at one." above, which is retained as the
record of the position before this change rather than edited in place.

**This narrowing did not go through the implementation RFC and exit criteria
in this document.** It was decided by the FR-R2-011 specification and plan
([specs/092-multi-queue-concurrency/](../../../specs/092-multi-queue-concurrency/)),
which neither cite nor reconcile this record. Ratifying or reversing that is
an open decision for the architecture owner; this note exists so the gap is
visible rather than implied by silence. [Decided 2026-08-15: ratified, for the
local single-operator shape only, in
[local-queue-parallelism-ratification.md](./local-queue-parallelism-ratification.md),
which dispositions all seven exit criteria individually and records criterion 1
as `not-satisfied`. This sentence is retained unedited; the decision it
describes as open is no longer open.]

Everything else in this gate remains fully in force and untouched by feature
092:

- no command or state access from outside the local VS Code host;
- one mutating operator identity — the window-primacy lease is unchanged, and
  a second VS Code window on the same workspace stays read-only however many
  queues are running;
- no shared or networked scheduler, evidence store, secret store, or control
  plane;
- no cross-tenant storage, dashboards, logs, metrics, or administration.

The parallelism added is N local queues under one operator, one host process,
and one filesystem owner. It supplies none of the identity, isolation,
brokering, or distributed-consistency machinery this document requires for
remote or multi-user operation, and MUST NOT be cited as precedent for them.
Concurrent runs share one working tree; see
[docs/operations/](../operations/) for what that means for the operator.

## Status update — feature 093 (2026-08-15)

This section supersedes one claim in the 092 note above and records the
decision that note left open. The 092 note is retained unedited; nothing below
replaces it in place.

**Correction to attribution.** The 092 note states that feature 092 "ships
same-workspace parallel execution". It did not. Feature 092 made every layer
*above* the Run engine per-queue — persistence, drain, scheduler, execution
lease, snapshot, and UI — and introduced
`schegent.queue.globalConcurrencyCap` with a default of 3 and a range of
`[1, 20]`. The Run engine itself was unchanged: one controller per window owned
one driver and a single record held one `WorkflowRun`, so two queues could
*drain* concurrently but two Runs could not *execute* concurrently. The drain
refused the second start rather than corrupting the first, so the cap
advertised a concurrency the engine could not honour.

**Feature 093 delivered the execution.** It replaced the single Run record with
a per-queue record under a forward-only v10 → v11 state-schema migration, gave
the controller a session per queue, made the cap bound concurrently executing
Runs rather than accounted slots, and removed the drain step that refused the
second start.

**The open decision is taken.** The 092 note recorded that ratifying or
reversing the narrowing was an open decision for the architecture owner. It was
ratified on 2026-08-15 in
[local-queue-parallelism-ratification.md](./local-queue-parallelism-ratification.md),
which dispositions each of the seven exit criteria individually rather than
waiving them as a set, records criterion 1 (reviewer approval of an
implementation RFC) as `not-satisfied`, bounds the authorised shape, refuses
precedent beyond it, and enumerates the premises whose change would return the
question here.

What is ratified is the capability as it exists after 093 — not the
092 description of it, and not anything wider. Every clause of this gate other
than the concurrency-cap carve-out remains fully in force.

## Status update — feature 098 (2026-08-18)

**The shipped default is now 1.** The 092 and 093 notes above both state a
default of 3 for `schegent.queue.globalConcurrencyCap`. They are retained as
written, on the same principle as the rest of this file: each is the record of
what was true when it was written. As of 2026-08-18 the shipped default is
**1**, changed under the principal architecture review's REL-02 finding.

**This narrows nothing and widens nothing in this gate.** The range remains
`[1, 20]`, the ratified shape is unchanged, and concurrent local execution
remains supported. What changed is which value an operator gets without
choosing one. The reason is a local trade rather than a boundary question:
concurrent Runs share one working tree, and a recovery checkpoint taken above
one in-flight Run cannot be attributed to a single Run, so the previous default
put a fresh install into the configuration where checkpoints are declined. The
reasoning and what was deliberately not done are recorded in
[local-queue-parallelism-ratification.md](./local-queue-parallelism-ratification.md#the-default-moved-to-1-2026-08-18).

The checkpoint half of that reason lapsed the same day: FR-R3-004 scoped each
patch to the paths its Run's audit records declare, so a checkpoint above one
in-flight Run is attributable and the blanket decline is gone. The default stays
**1** on the shared-tree contention argument alone. This changes nothing in this
gate either — attribution is a local mechanism inside one host's working tree,
and it neither reaches nor relaxes any boundary clause below.

Every clause of this gate other than the concurrency-cap carve-out remains
fully in force.
