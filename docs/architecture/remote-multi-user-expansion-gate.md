# Remote, multi-user, and parallel execution expansion gate

Status: Accepted architecture decision (2026-08-01)

Decision: Schegent's current local, single-operator architecture must not be
expanded into remote control, shared multi-user operation, or parallel agents
in one workspace by increasing `schegent.queue.globalConcurrencyCap`, adding a
network endpoint, or weakening the workspace lock. Such work is blocked until
a separate implementation RFC satisfies every exit criterion in this record.

This is an expansion blocker, not a defect in the supported local product.

## Scope that triggers this gate

The gate applies if a proposal introduces any of the following:

- commands or state access from outside the local VS Code host;
- more than one mutating operator or service identity;
- parallel workers or agents targeting the same canonical workspace;
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

The concurrency cap remains pinned at one. A cap change is not an architecture
for coordination, identity, isolation, or recovery.

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
