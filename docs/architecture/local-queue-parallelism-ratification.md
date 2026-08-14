# Ratification: local queue parallelism under the expansion gate

Status: Accepted (2026-08-15)

Approver: architecture owner (repository maintainer)

Narrows: one clause of
[remote-multi-user-expansion-gate.md](./remote-multi-user-expansion-gate.md) —
"parallel workers or agents targeting the same canonical workspace" — and only
for the shape described under [Authorised scope](#authorised-scope).

Supersedes: nothing. The gate is amended additively; no sentence in it was
edited or removed.

## This document is not the implementation RFC

The gate requires an implementation RFC before remote, multi-user, or parallel
expansion is eligible for approval. **That requirement remains outstanding in
full.** This record does not discharge it, does not substitute for it, and does
not begin it.

What this record does is narrower: it takes the decision that the gate's own
feature-092 status note left explicitly open — whether to ratify or reverse a
narrowing that had already shipped without going through the gate — and takes
it in one direction, for one shape, with the seven exit criteria evaluated one
at a time rather than waived as a set.

Exit criterion 1 asks for architecture **and security** reviewer approval of
that RFC and its updated threat model. This record is dispositioned
`not-satisfied` against that criterion, by its own author, and nothing below
should be read as claiming otherwise. An approver's signature on a ratification
of a narrow local behaviour is not reviewer approval of a design that does not
exist.

## Decision

**Ratify.** Concurrent execution of Runs across separate local queues in one
canonical workspace, by one local operator, in one host process, is an accepted
part of the supported local product as of 2026-08-15. The concurrency cap
`schegent.queue.globalConcurrencyCap` may take values in `[1, 20]` with a
default of 3.

The reasoning that selected ratification over the alternatives:

- **The gate's stated failure modes need a second principal, and there isn't
  one.** Every row of the gate's "why the current architecture cannot be widened
  incrementally" table fails on the arrival of a second identity, a second
  machine, a second filesystem owner, or a network path. N local queues
  introduce none of those. They introduce a second *execution context* under the
  same identity, which is a different thing and is not what those rows describe.
- **The capability shipped and is in operators' hands.** Feature 092 shipped the
  per-queue layers on 2026-08-12 and feature 093 shipped the per-queue execution
  that makes them real. Leaving the gate's text asserting a cap "pinned at one"
  while the product ships a default of 3 does not restore the boundary; it
  removes the reader's ability to trust either statement. A record that
  contradicts the product protects nothing.
- **The narrowing is separable and observable.** The authorised shape is
  bounded by properties that are checkable from the code — one operator, one
  host process, one filesystem owner, no network surface — rather than by an
  intention. That makes the [re-evaluation trigger](#re-evaluation-trigger)
  enforceable rather than aspirational.

### Alternatives rejected

**Reverse** — pin the cap back to one and revert features 092 and 093.
Rejected. This would discard delivered capability to restore a boundary whose
stated failure modes are not reachable in the authorised shape, and it would
treat "the decision was taken outside the gate's process" as equivalent to "the
decision was wrong". The process defect is real and is recorded here; the remedy
for it is this evaluation, not a revert. It would also reintroduce the
single-Run engine that feature 093's follow-up identified as unable to honour a
setting the product already advertised.

**Scope-only** — narrow the gate's clause without evaluating the seven exit
criteria, on the grounds that the criteria are written for the remote design.
Rejected. That is the same move feature 092 made, and it is the reason this
record exists. Several criteria do turn out to be inapplicable to the local
shape — but "inapplicable" is a finding, reached by reading the criterion
against what shipped, and it has to be written down per criterion so that a
future reader can check the reasoning instead of inheriting the conclusion. A
blanket "these don't apply" is indistinguishable from not having looked.

## Authorised scope

This ratification authorises exactly the following shape, stated positively:

| Property | Authorised value |
|---|---|
| Canonical workspaces per running set | one |
| Mutating operator identities | one, local |
| Host processes executing Runs | one (the primary VS Code window) |
| Filesystem owners | one |
| Network surface for command or state access | none |
| Concurrent queues | up to `MAX_QUEUES` (20) |
| `schegent.queue.globalConcurrencyCap` | range `[1, 20]`, default 3 |
| Working trees shared by concurrent Runs | one |
| Window-primacy lease holders per workspace | one |

The parallelism authorised is N local queues under one operator, one host
process, and one filesystem owner. It supplies none of the identity, isolation,
brokering, or distributed-consistency machinery the gate requires for remote or
multi-user operation.

## What this record must not be cited for

This record is not precedent for, and MUST NOT be cited in support of:

- remote operation — commands or state access from outside the local VS Code
  host, by any transport;
- multi-operator operation — a second mutating human or workload identity, on
  the same workspace or otherwise;
- networked, shared, or out-of-process workers, including a worker on the same
  machine that outlives the host process that started it;
- a shared scheduler, queue, evidence store, secret store, or control plane;
- cross-tenant storage, dashboards, logs, metrics, or administration;
- any other clause of the gate. This record narrows one clause. Every clause it
  does not name is untouched, and its being unmentioned in an evaluation of a
  different clause is not a disposition of it.

Raising `MAX_QUEUES`, or raising the cap's maximum above 20, is outside this
authorisation and is governed by its own hard rule in `CLAUDE.md` — a widening
needs both a state migration and a scheduler design that answer for the new
entries.

## Exit-criteria disposition

Each of the gate's seven exit criteria, evaluated against the authorised scope
above. Dispositions are drawn from a closed set: `satisfied`,
`not-applicable`, `not-satisfied`.

| # | Criterion (abbreviated) | Disposition | Reason |
|---|---|---|---|
| 1 | Architecture and security reviewers approve the implementation RFC and its updated threat model | `not-satisfied` | There is no implementation RFC and no updated threat model, so there is nothing for a reviewer to have approved. See [Criterion 1 in full](#criterion-1-in-full) — this row is not discharged by anything in this document. |
| 2 | AuthN/authZ and tenant-isolation contracts have automated negative tests | `not-applicable` | The authorised shape has one mutating identity and one tenant. Queues are not principals: every queue executes as the same local operator, under the same VS Code Workspace Trust decision, against the same filesystem owner, and no queue can be addressed, authenticated, or authorised separately from any other. An authorization contract needs two principals to bind differently, and a cross-tenant negative test needs a second tenant to be denied. Neither exists to be tested. The window-primacy lease continues to admit exactly one mutating window per workspace, so a second window does not supply the missing second principal either. |
| 3 | Scheduler, lease/fencing, idempotency, cancellation, crash recovery, and rolling rollback pass deterministic fault-injection tests | `satisfied` | Each named mechanism that exists in the authorised shape is covered by deterministic tests, and the interleaving in those tests is driven rather than raced (`tests/integration/concurrent-run-execution.test.ts:101` — "the interleaving is chosen, not raced"). Scheduler: per-queue round-robin drain, `tests/integration/concurrent-drain.test.ts`. Cap as a real execution ceiling including the N+1th refusal: `tests/integration/concurrency-cap.test.ts:155`. Lease: per-queue execution lease with heartbeat and staleness reclaim (`src/state/execution-lease.ts`), release on every terminal status and on the drain's pre-ownership failure path, `tests/integration/execution-lease-release.test.ts:243`. Cancellation and bulkheading: `tests/integration/concurrent-run-execution.test.ts:306` — one Run's failure disposes only its own session. Crash recovery: forward-only v10 → v11 migration with per-queue Run records, `tests/unit/state/run-state-migrator-v10-to-v11.test.ts` and `tests/integration/crash-recovery.integration.test.ts`. **Absences, stated rather than passed over**: there are no fencing tokens and no idempotency keys. Their failure mode — a stale worker writing state or evidence after ownership has moved, or a duplicate delivery starting two subprocesses — requires an executor that can outlive the process holding the lease, and the authorised shape has exactly one host process. There is likewise no rolling rollback: a downgrade to a runtime older than schema version 11 is **refused** at load with an explicit message, not rolled back (`src/state/queue-state-migrator.ts:644`). Refusal is the correct local behaviour and is not a substitute for the mixed-version-worker design the remote form of this criterion requires. |
| 4 | Secret brokering and evidence retention have an operational owner, documented rotation/deletion procedures, and no secret-bearing default diagnostic path | `not-applicable` | Concurrency adds no credential path and no evidence boundary. Every queue's phase invocation inherits the same local host environment under the same Workspace Trust decision the single-queue product already relied on, so there is no second worker for a credential to be brokered *to* and no least-privilege boundary to issue one across. Retention has one filesystem owner and one `.schegent/` store; the criterion's subject matter — arbitrating policy between owners — has no second party. The redaction set (`SECRET_PATTERNS`) and the append-only audit writer are unchanged by 092 and 093, so the default diagnostic path is the one already evaluated for the single-run product. |
| 5 | Prompt/tool policy is enforced outside the model and has adversarial tests | `not-applicable` | The criterion defends against one tenant or agent influencing another's execution across a trust boundary. The authorised shape has no second trust level to cross: all N queues execute tasks authored by the same operator, in the same workspace, at the same provenance. Concurrent Runs do share one working tree, so one Run's file writes are visible to another's phase — but that channel already existed between sequential Runs in the single-queue product and carries the same operator-authored content at the same trust level. What changed is the interleaving, not the provenance. That is why the single-working-tree assumption is an enumerated premise of the [re-evaluation trigger](#re-evaluation-trigger) rather than a closed question: if a future change gives one queue content the operator did not author, this row's reasoning fails and the criterion becomes live. |
| 6 | A staged rollout has measurable stop conditions and a tested return to the local path | `satisfied` | The rollout control and the stop condition are the same operator-visible setting. `schegent.queue.globalConcurrencyCap` is per-workspace and takes effect on the next start decision; setting it to 1 returns the product to single-Run execution. That return is tested rather than asserted: `tests/integration/concurrency-cap.test.ts:239` lowers a live cap to 1 and asserts that executing Runs are left alone and only later starts are refused, so the drain-to-one is a drain and not a kill. The measurable condition is `sessions.size` at each start decision, which is the same oracle the cap gate itself consults. |
| 7 | The local single-run gate remains green; expansion does not silently change local trust, audit, redaction, or package guarantees | `satisfied` | The full verification suite is green with the single-Run path intact — a cap of 1 is a supported, tested configuration, not a legacy mode. Trust: unchanged; the Workspace Trust decision and the one-holder window-primacy lease are the same objects with the same cardinality. Audit: the append-only writer and the raw transcript writer are unchanged, and per-Run attribution across concurrent Runs is asserted directly (`tests/integration/concurrent-run-execution.test.ts:187` — no output, audit line, or transcript line is attributed to the wrong Run). Redaction: `SECRET_PATTERNS` is untouched and remains the single source. Package guarantees: unchanged; the only manifest change in this area is the cap's own range, which is the subject of this record rather than a side effect of it. |

### Criterion 1 in full

The gate asks for architecture and security reviewer approval of an
implementation RFC and its updated threat model.

**Disposition: `not-satisfied`.** Not `not-applicable`. The criterion is
applicable — a reviewed design document is exactly what the gate's process
required and exactly what features 092 and 093 did not produce for this
narrowing. Recording it as inapplicable would convert a process failure into a
category error.

**What would discharge it**: an implementation RFC covering the remote and
multi-user design in the sections the gate enumerates, a threat model that
replaces the local-only assumptions, and recorded approval from an architecture
reviewer and a security reviewer who are not the RFC's author.

**Evidence that exists, and what it is not**: features 092 and 093 each went
through the repository's Spec Driven Development cycle — specification,
clarification, plan, tasks, cross-artifact analysis, implementation, and the
full automated verification suite — and this feature's own planning re-read the
gate against the shipped code. That is engineering review of two increments
against their own specifications. **It is not the approval this criterion asks
for**, on three counts: it reviewed increments rather than an end-to-end design,
it had no separate security reviewer, and the reviewer was not independent of
the author. It is recorded here because a reader is entitled to know what review
did happen; it is labelled because presenting it as partial satisfaction is how
a `not-satisfied` row quietly becomes a satisfied one.

## Gate clauses still in force

Each of the following is restated affirmatively — not left to be inferred from
the fact that this record does not mention it:

- **No command or state access from outside the local VS Code host.** In force,
  unchanged.
- **One mutating operator identity.** In force. The window-primacy lease is
  unchanged and a second VS Code window on the same workspace remains read-only,
  however many queues are running in the primary.
- **No shared or networked scheduler, evidence store, secret store, or control
  plane.** In force, unchanged.
- **No cross-tenant storage, dashboards, logs, metrics, or administration.** In
  force, unchanged.
- **The required implementation RFC**, in every section the gate enumerates —
  authentication and authorization, tenant and workspace isolation, durable
  scheduling and execution, distributed locking and idempotency, secret
  brokering, evidence/retention/privacy, prompt-injection and tool policy,
  rollout and rollback. In force, outstanding in full.
- **The required threat model.** In force, outstanding in full.
- **Exit criteria 1 through 7 for any expansion beyond the authorised scope.**
  In force. Their disposition above is against the narrow local shape only and
  carries no weight for the remote or multi-user case.
- **Separate workspaces remain independent local trust domains**, and separate
  local windows remain covered by the primary-host read-only/mutating split. In
  force, unchanged.

## Re-evaluation trigger

The reasoning above rests on the following premises. Each is stated separately
because each can change on its own, and a change to any one of them invalidates
this ratification and returns the underlying question to the gate. This is not a
list of things that would be "nice to re-check"; a change to any line below
means this record no longer holds.

| # | Premise | Value it is pinned at | Where it is observable |
|---|---|---|---|
| 1 | Mutating operator identities | one, local | Workspace Trust; `WorkspaceLockManager` |
| 2 | Host processes executing Runs | one | the primary VS Code window |
| 3 | Filesystem owners | one | the local `.schegent/` store |
| 4 | Network surface for command or state access | none | no listening endpoint in the host |
| 5 | `MAX_QUEUES` | 20 | `src/queue/queue-registry.ts` (declared); `src/state/workspace-state.ts` derives the cap ceiling from it |
| 6 | The cap's maximum | 20 | the six cap value definition sites |
| 7 | Window-primacy lease cardinality | one holder per workspace | `WorkspaceLockManager` |
| 8 | Execution lease tenure | per queue, claimed at start, released at the Run's terminal transition | `src/state/execution-lease.ts` |
| 9 | Working trees shared by concurrent Runs | one, operator-authored | `docs/operations/` |
| 10 | State schema version | 11, forward-only, downgrade refused | `src/contracts/state-schema.ts` |
| 11 | Content provenance across queues | one operator, one trust level | criterion 5 above |

Premises 10 and 11 were added by re-reading this record's own reasoning against
the list rather than by drafting the list from the specification: criterion 3
leans on the downgrade being refused rather than silently misread, and criterion
5 leans on every queue's content having one provenance. Both were facts the
reasoning used and the trigger did not watch. The target for
relied-on-but-unlisted premises is zero, and this table is the result of the
second pass, not the first.

## Sites this record authorises

Traceability runs both ways. Each site below cites this record; this record
names each site. A reader arriving from either direction reaches the other.

| Site | Role | How it holds the bound |
|---|---|---|
| `src/state/workspace-state.ts` | enforces (store) | `DEFAULT_GLOBAL_CONCURRENCY_CAP = 3`; ceiling derived from `MAX_QUEUES` |
| `src/queue/queue-manager.ts` | enforces (save path) | range check on save; ceiling derived from `MAX_GLOBAL_CONCURRENCY_CAP` |
| `src/contracts/validators/queue-management.ts` | enforces (IPC boundary) | range check on the inbound command; ceiling derived from `MAX_QUEUES` |
| `src/config/settings-schema.ts` | advertises (schema) | `default: 3, min: 1, max: 20`, restated |
| `src/config/general-settings.ts` | advertises (descriptor) | `defaultValue: 3, min: 1, max: 20`, restated |
| `package.json` | advertises (manifest) | `default: 3, minimum: 1, maximum: 20`, restated |

The distinguishing test is whether a site would still be consulted if every
other were deleted: an enforcing site would still refuse an out-of-range value;
an advertising site would still tell an operator what the range is.

### Why this record enumerates rather than summarises

Because the summaries were wrong. When feature 094 went to check that every
site agreed, it found three separate statements of *how many sites there are*,
no two alike, and none correct:

| Claim | Where it was written | Count |
|---|---|---|
| "three agreeing sites … and `settings-schema.ts` … a fourth" | `src/config/general-settings.ts` | 4 |
| "the schema default the five pinning sites agree on" | `src/state/workspace-state.ts` | 5 |
| "three definition sites" | the follow-up report that requested this feature | 3 |

The actual number is six. Each of those three counts was written by someone who
had just looked at the code, and the two in-code counts sat about a thousand
lines apart in files that import from each other. The two that undercounted
both omitted enforcing sites — the ones that refuse a bad value — which is the
half a reader most needs to find.

A requirement that every site agree is worth nothing if the set of sites is
itself uncertain, so this record names them instead of counting them. Both
in-code counts were corrected to six as part of this feature; the follow-up's
count is left as written, because it is a report of what its author found and
not a statement the product makes about itself.

## Attribution

Two features delivered this capability, and the gate's existing status note
attributes it to the wrong one.

**Feature 092 (multi-queue concurrency, merged 2026-08-12)** made every layer
*above* the Run engine per-queue: persistence, the drain coordinator, the
scheduler, the execution lease, the snapshot, and the UI. It also introduced
`schegent.queue.globalConcurrencyCap` with a default of 3 and a range of
`[1, 20]`. What it did **not** change was the Run engine itself — one controller
per window owned one driver, and the single `KEYS.run` record held one
`WorkflowRun` — so two queues could drain concurrently but two Runs could not
execute concurrently. The drain refused the second start rather than corrupting
the first. The gate's 2026-08-12 status note states that 092 "ships
same-workspace parallel execution"; at the time it was written, the cap
advertised a concurrency the engine could not honour.

**Feature 093 (per-queue Run execution)** delivered the execution. It replaced
the single Run record with a per-queue record under a forward-only v10 → v11
state-schema migration, gave the controller a `RunSession` per queue, made the
cap bound concurrently executing Runs rather than accounted slots, and deleted
the drain's step 4b — the refusal of the second start — as its final acceptance
signal.

What is ratified here is the capability as it exists after 093. The gate's 092
status note is retained unedited as the record of what was believed on
2026-08-12; the correction is appended as a separate 093 status update rather
than written over it.
