# Phase-to-Phase Context Handoff (`FR-R6-F15`)

**Declared**: 2026-11-11 (`specs/314-phase-context-handoff/spec.md`)
**Hardened**: 2026-11-23 (`specs/331-feature-hardening-310-314/spec.md`, `R7-17-07` & `R7-17-08`)

This guide is for an operator or maintainer who needs to know what a context handoff between
two workflow phases carries, what it never carries, which limits it stays under, how disabled and
opted-in transitions behave in production, how restart recovery handles uncertain sends, why a
handoff can be refused, how acceptance criteria map to tests, and what external limits remain.

Implemented in:

- [`src/contracts/phase-context/`](../../src/contracts/phase-context/): the limits, the closed
  failure list and the shapes of the policy, the contribution, the manifest, the delivery
  representation and the review records;
- [`src/services/phase-context/index.ts`](../../src/services/phase-context/index.ts): the
  services (`PhaseHandoffCoordinator`, `SqliteHandoffStore`, `attempt-result-publisher.ts`,
  `handoff-materializer.ts`, `handoff-delivery-coordinator.ts`, `review-loop-coordinator.ts`,
  `explanation.ts`, `delivery-plan.ts`, `acceptance.ts`), re-exported from one index;
- [`src/headless/phase-context-api.ts`](../../src/headless/phase-context-api.ts): bounded
  metadata-only headless inspection, revision diff (`compareHandoffRevisions`), edit, and approval
  port;
- [`src/activation/sqlite-cutover-wiring.ts`](../../src/activation/sqlite-cutover-wiring.ts),
  [`src/services/workflow-execution/phase-handoff-execution-bridge.ts`](../../src/services/workflow-execution/phase-handoff-execution-bridge.ts),
  [`src/services/workflow-execution/connected-run-coordinator.ts`](../../src/services/workflow-execution/connected-run-coordinator.ts),
  [`src/services/workflow-execution/workflow-recovery-service.ts`](../../src/services/workflow-execution/workflow-recovery-service.ts),
  and [`src/runner/acp-backed-runner.ts`](../../src/runner/acp-backed-runner.ts): production
  construction, startup uncertain-dispatch reconciliation, workflow execution bridging, recovery
  enforcement, and ACP `session/prompt` delivery.

## Production status

**F15-B is wired in production.** Extension activation (`src/activation/sqlite-cutover-wiring.ts`)
constructs `createPhaseHandoffCoordinator` backed by the folder-scoped SQLite store (schema
version 9: `SqliteHandoffStore` persisting into **`phase_handoff_records`** and
**`phase_review_loop_ledgers`**, alongside F05 `ArtifactLifecycleService` managing protective owner
pins in **`artifact_references`** and artifact metadata in `artifacts` / `artifact_lifecycle`),
reconciles any unsettled `'intent'` dispatches on startup and restore, and passes the coordinator
into workflow execution (`connected-run-coordinator.ts`, `phase-handoff-execution-bridge.ts`,
`workflow-control-service.ts`, and `workflow-recovery-service.ts`). F05 scan roots
(`src/activation/sqlite-cutover-helpers.ts`) include `.schegent/handoff-materialized` and
`.schegent/immutable-results` alongside transcripts, diagnostics, and reports.

Phase-context handoff remains **strictly opt-in per workflow connection**: a connection with no
`contextPolicy` (whose nodes do not participate in an opted-in `contextPolicy` or authored review
loop) executes zero handoff capture, writes zero SQLite handoff rows, holds zero F05 handoff pins,
materializes zero copies, and transmits only the ordinary single text prompt from `PromptBuilder`.

### Disabled vs opted-in transition trace

| Stage | Disabled (`connection.contextPolicy === undefined` and outside any review loop) | Opted-in (`connection.contextPolicy !== undefined` or review loop) |
|---|---|---|
| 1. Settled source attempt | `settleAndPrepareTransitionHandoff` returns `{ ok: true, waitingApproval: false }` immediately without reading staging directories, capturing immutable files, or touching SQLite/F05. | Staged outputs under `.schegent/results/<rootAlias>/<attemptAlias>/{contribution.json,review-report.json,fix-claims.json}` (failing closed on any leftover `*.tmp`/`*.part` temp file, never synthesizing a `complete` fallback) or attempt/iteration-scoped `phase-message.env` **only** when `legacySidecarOptIn === true` (4 KiB cap, `PhaseSidecarReader` + `SanitizedLogger.sanitizeRecord`) are validated via `openWithinRoot`, published atomically under `.schegent/immutable-results/<attemptAlias>/`, and registered/pinned in F05 `artifact_references` (with checked `LifecycleResult`). Declared mutable output files are snapshotted atomically under `.schegent/immutable-results/` and registered in F05; ForEach nodes expose `.schegent/foreach-results/<resultIndexRef>.json` as a full selectable `ArtifactRef` without 2 KiB truncation. |
| 2. Preparation & durable persistence | **Zero** `phase_handoff_records` SQLite rows, **zero** F05 `artifact_references` pins, **zero** `.schegent/immutable-results/` captures, and **zero** `.schegent/handoff-materialized/` files are created. | `prepareTransitionHandoff` enforces bounded FIFO admission (`2` active, `8` queued waiting in arrival order up to the 2 s deadline, `8 MiB` un-clamped working set), runs deterministic selection up to the commit cutoff, acquires checked F05 `owner_type = 'handoff'` pins in `artifact_references` before committing SQLite, persists the serialized manifest, rendered context, and workspace-relative `artifactLocations` inside `phase_handoff_records.record_json`, and records metadata-only observations (including revision-1 `'prepared'` persisted after `acceptance.accept`, with exception-safe `onObservation` delivery). |
| 3. Operator confirmation / approval | None required (no handoff is prepared). | Under `approval: 'manual'`, the revision enters `waiting-approval` and pauses until the operator inspects (`inspectHandoff` / metadata-only `compareHandoffRevisions`), optionally edits (producing revision `N + 1`, superseding revision `N`), and approves that exact revision (`approveHandoff` / revision-bound `continue-handoff` with `expectedHandoffRevision`). Under `approval: 'automatic'`, the revision starts `ready`. |
| 4. Delivery planning & materialization | `buildAttemptHandoffDelivery` returns `undefined`; no `FrozenPhaseHandoffDelivery` or `acpPromptBlocks` is attached. | `executePlanAttemptDelivery` loads any persisted `DeliveryRepresentation` via `store.loadRepresentation` and validates via `checkDispatch` **before** planning/dispatching (refusing changed capabilities, profile, or content without overwriting the stored representation), refuses duplicate dispatch while any `'intent'` or `'uncertain'` dispatch exists on the revision, resolves artifact locators across restarts (`in-memory` -> persisted `artifactLocations` -> F05 metadata), re-verifies same-root `resource-link` digests, streams cross-root `materialized-copy` files atomically via sibling temp + Pass-2 SHA-256 + `rename` into `.schegent/handoff-materialized/<attemptAlias>/` (64 files / 16 MiB per file / 64 MiB deduplicated total / `<= 1 MiB` chunks / 30 s deadline, sharing NFR-003 admission), and commits `recordDispatchIntent` before `saveRepresentation` inside one `BEGIN IMMEDIATE` transaction (rolling back on refusal). |
| 5. Provider prompt delivery & egress | `AcpBackedRunner` builds the ordinary single `{ type: 'text', text: request.prompt }` block from `PromptBuilder` and sends it to `claude`, `codex`, or `agy`. | `capability-decision-recorder.ts` forwards `handoff.acpPromptBlocks` and explicitly clears ambient `sessionReuse`/`resumeSessionId` when `sessionReusePermitted === false`. `AcpBackedRunner` verifies real `initialize`-negotiated capabilities (`loadSession`, `embeddedContext`, and persisted `DeliveryRepresentation` via `checkDispatch` when supplied) before `session/load` or `session/prompt`, then sends `request.acpPromptBlocks` over ACP `session/prompt`. |
| 6. Terminal cleanup & uncertain-send survival | No handoff pins or SQLite handoff rows exist. | On clean terminal completion, both `handoff` and clean `attempt` `artifact_references` pins release strictly after the durable terminal CAS commit (and reconcile idempotently on recovery). Whenever any dispatch on a handoff is `'intent'` or `'uncertain'`, **both** `handoff` and `attempt` pins remain protected across terminal cleanup and retention sweeps. Local SQLite rows, F05/F15-B files, backups, vendor CLI histories, and vendor-side copies are inventoried in [evidence-retention-disclosure.md](evidence-retention-disclosure.md). |

## What a handoff is

A handoff is the context one phase attempt receives from attempts that finished before it. It
is opt-in per transition: a transition with no policy gets no handoff, and nothing is sent.

| Term | Meaning |
|------|---------|
| Policy | Version `1`. Names the approval mode (`automatic` or `manual`), the session policy (`fresh` or `reuse-when-qualified`) and up to 32 selectors. A selector names one source node, whether it is required, and a priority from 0 to 99 (lower is taken first). |
| Bound input | An input the workflow itself bound. Always required, and taken before any selector. |
| Contribution | What one accepted attempt offers: outcomes, decisions, constraints, unresolved issues, an optional summary, artifact references, and a coverage of `complete`, `partial` or `unavailable`. |
| Cutoff | One commit sequence number the host supplies. A contribution accepted after it is left out. |
| Identity | The lineage values of one handoff and the source attempts it may carry, at most 32. The handoff identifier is a tagged SHA-256 over them. |
| Manifest | The record of what was selected and what was left out, serialized in one fixed key order, with its digest. |
| Rendered context | The one text a target receives for a manifest, written by renderer version `1`. |

### Selection

Selection takes bound inputs first, then required selectors in the order the policy lists
them, then optional selectors by priority. Ties keep the selector's position in the policy,
then the producer's node path, then its occurrence identity.

- A request must name exactly one producer occurrence. Two occurrences of one node refuse the
  handoff.
- Required context that is missing, has `unavailable` coverage or does not fit refuses the
  handoff.
- Optional context that does not fit is left out, with every optional request after it.
- Nothing is cut to fit. A source is carried whole or left out.

Every source left out is recorded with one reason:

| Reason | When |
|--------|------|
| `after-cutoff` | The contribution was accepted after the cutoff. |
| `not-selected-by-policy` | No bound input and no selector asked for it. |
| `coverage-unavailable` | An optional source reported `unavailable` coverage. |
| `optional-capacity` | An optional source, or one before it in priority order, did not fit. |

### What a source cannot do

Source text is untrusted. The renderer writes the preamble and every heading; each line a
source wrote appears only as a quoted line under one of them, so it cannot pass for a heading
or an instruction. A contribution whose text has a control character or ill-formed UTF-16 is
not valid and is never rendered. The bidirectional embedding, override and isolate characters
(U+202A to U+202E, U+2066 to U+2069) count as control characters, because text after one can be
shown in another order than it is stored in. The directional marks and the zero-width
characters are allowed; right-to-left prose needs them.

A refusal, an explanation, a revision diff (`compareHandoffRevisions`), and a lifecycle
observation carry identifiers, digests, counts, and members of closed lists. None of them carries
source text, a filesystem path, or an error message.

## Limits

Sizes are UTF-8 bytes. None is a token count.

| Limit | Value |
|-------|-------|
| Serialized manifest | 64 KiB |
| Rendered context | 32 KiB, or the smaller bound the target profile is qualified for |
| Sources in one manifest | 32 |
| Entries in one collection, per contribution and across a manifest | 32 |
| One text entry | 2 KiB |
| One summary | 8 KiB |
| Artifact references, per contribution and across a manifest | 64 |
| Selectors, and bound inputs | 32 each |
| Candidate contributions read by one preparation | 256 |
| Revisions of one handoff | 16 |
| Dispatch records of one handoff | 64 |
| Text artifact embedded in the prompt | 8 KiB |
| Explanation / revision diff | 64 KiB |
| Preparations active at once, and queued | 2 and 8 (FIFO arrival order) |
| Working set across the active preparations | 8 MiB (never clamped below the limit) |
| Preparation deadline, from activation / queue wait | 2 seconds |
| Legacy sidecar (`legacySidecarOptIn === true` only) | 4 KiB (`PhaseSidecarReader` bound) |
| Review / staged result artifact | 256 KiB (exact `262,144` B accepted / `262,145` B refused), 200 records, 2 KiB per record, depth 16, 8,192 values |
| Findings in one review loop | 1,024 |
| Passes of one review loop | 32 (further bounded by authored Repeat `maxIterations`) |
| History shown to a later pass | the last 5 passes, 1 KiB each, 8 KiB in total |

A target profile with no qualified context size is refused; there is no default bound for it.

Materialization limits (**64** unique files, **16 MiB** per file, **64 MiB** deduplicated total,
**<= 1 MiB** streaming copy buffer, **30-second** wall-clock deadline) are enforced in production
by `src/services/phase-context/handoff-materializer.ts` with atomic sibling temp + Pass-2 SHA-256
+ contained `rename` and full batch rollback on failure (zero partial or 0-byte files exposed at
destination paths).

## Acceptance, revisions, delivery verification and uncertain-send restart

Acceptance stores prepared handoffs in SQLite `phase_handoff_records` (`SqliteHandoffStore`;
`memory-store.ts` in pure unit tests):

- Acceptance and approval are idempotent by identity: asking again returns what is stored and
  writes nothing. No exactly-once external delivery is claimed.
- An edit is a compare-and-set on the current revision (`revision-not-current` on stale base).
  Editing creates revision `N + 1` in `waiting-approval` and supersedes revision `N`. The sidebar
  and headless API support both full source replacement (`op: 'edit'` / `editHandoff`) and the
  narrow host-owned summary patch (`op: 'editSummary'` / `editHandoffSummary`), which loads the
  persisted manifest, enforces `textFault` control/bidi/UTF-16 and 8 KiB byte limits, requires an
  explicit unambiguous `producerAttemptId` on multi-source handoffs (`edit-ambiguous-source`), and
  preserves every outcome, decision, constraint, unresolved issue, artifact reference, and other
  source intact. Approval of a superseded revision is refused (`revision-not-current`), approval
  never carries across an edit, and `compareHandoffRevisions(handoffId, fromRev, toRev)` returns a
  strictly metadata-only diff (added/removed source and artifact identities, manifest digests,
  omission and byte deltas, zero prose).
- `continue-handoff` (`approvePendingPhaseHandoffForContinue`) supports explicit revision binding
  (`expectedHandoffRevision`) and refuses approval if the handoff moved to a newer revision.
- A record the store returns is checked before any operation reads it (`stored-record`); a stored
  manifest with a newer future version is surfaced explicitly as `unsupported-version` rather than
  silently reclassified as corrupt storage.
- **Delivery representation verification (`FR-035`)**: `handoff-delivery-coordinator.ts` loads any
  persisted `DeliveryRepresentation` via `store.loadRepresentation` and validates it with
  `checkDispatch` before planning or committing dispatch intent. If capabilities, profile
  identity/revision, or content digest changed, dispatch is refused (`capabilities-changed`,
  `profile-changed`, `content-changed`) **without** overwriting the stored representation. Inside
  the `BEGIN IMMEDIATE` transaction, `recordDispatchIntent` commits before `saveRepresentation`,
  and `SqliteHandoffStore.runInImmediateTransaction` rolls back on any `{ ok: false }` refusal.
- **Session reuse (`FR-013`)**: `fresh` is always allowed; `reuse` requires
  `session: 'reuse-when-qualified'`, negotiated `capabilities.loadSession === true`, same backend,
  and same node + occurrence lineage. `AcpBackedRunner` re-verifies real `initialize`-negotiated
  capabilities before calling `session/load` or `session/prompt`, and
  `capability-decision-recorder.ts` clears ambient `sessionReuse` / `resumeSessionId` whenever
  `sessionReusePermitted === false`.
- **Restart after an uncertain or interrupted send (`R7-17-07`)**:
  - A transport drop settles a dispatch to `'uncertain'` (`delivered: false`).
  - A host crash between recording dispatch `'intent'` and receiving completion leaves `'intent'`
    in SQLite. On activation, restore (`reloadFromStore`), and `WorkflowRecoveryService.reconcileRun`,
    `reconcileInterruptedDispatches` transitions all unsettled `'intent'` dispatches to `'uncertain'`
    and persists `'uncertain'` observations **before** terminal pin release or recovery dispatch.
  - While **any** dispatch on a handoff is `'intent'` or `'uncertain'`, **both** `owner_type = 'handoff'`
    and `owner_type = 'attempt'` pins in `artifact_references` survive `releaseTerminalRunPins` and
    F05 retention sweeps.
  - While **any** dispatch on a handoff revision is `'intent'` or `'uncertain'`,
    `planAndAuthorizeAttemptDelivery`, `recordDispatchIntent`, and `WorkflowRecoveryService` refuse
    duplicate dispatch with `uncertain-delivery` / `dispatch-uncertain` for **both** the same
    `targetAttemptId` and any newly minted `targetAttemptId` on that revision until explicit
    recovery supersedes it.

## Delivery routes

Each artifact takes the first route that applies:

| Route | When |
|-------|------|
| `embedded` | A text artifact of at most 8 KiB, when `embeddedContext` was negotiated, the host supplied the text, and it fits what is left of the profile's qualified size after the rendered context. A text whose size or digest does not match its reference refuses the plan. |
| `resource-link` | The artifact resides inside the target execution root and passes pre-dispatch size + SHA-256 re-verification (`openWithinRoot`). Mutated files are never linked. |
| `materialized-copy` | The artifact resides outside the target execution root (e.g. primary workspace or another lane). `handoff-materializer.ts` streams verified bytes through a sibling temp file into `.schegent/handoff-materialized/<attemptAlias>/`, verifies Pass-2 SHA-256 before atomic `rename`, and registers/pins the copy in F05 `artifact_references`. |
| `omitted` | An optional artifact with no route. A required one refuses the plan (`required-context-unavailable`). |

## Review loop (`FR-027`)

The host, not the reviewer or fixer, decides what a review pass means:

- An authored `Initial Review -> conditional Repeat(Fix -> Review)` workflow maps both the
  upstream initial review and all `Fix` / `Review` attempts inside `Repeat` to **one** unified
  ledger (`loop-<runId>-<repeatNodeId>` in `phase_review_loop_ledgers`), with pass caps derived
  from the Repeat node's frozen `control.maxIterations`.
- An initial passing review skips `Repeat` (0 Fix attempts). An initial negative review enters
  `Repeat` carrying findings into `Fix`.
- `fix-claims.json` (`claimed-fixed`, `not-addressed`, `disputed`) records claims beside findings
  and **never** changes finding status or closes blocking findings on its own.
- Host-bound `candidateRef`, `scopeRevision`, and `criteriaRevision` are persisted in
  `phase_review_loop_ledgers`; candidate mutations call `invalidateReviewLoopCandidate`, requiring
  re-review before exit.
- Both `connected-run-coordinator.ts` and `WorkflowRecoveryService` enforce
  `verifyRepeatExitAllowed` so neither live execution nor post-crash recovery can falsely exit
  `Repeat` with open blocking findings or an unreviewed candidate.

## Why a handoff was refused

Every refusal is one of eight failures with a fixed detail code.

| Failure | When | Detail codes, for example |
|---------|------|---------------------------|
| `invalid-policy` | The policy is malformed, or an operation asks for something it does not allow. | `policy-shape`, `selector-duplicate`, `approval-not-required`, `session-reuse-not-permitted`, `session-load-unsupported` |
| `invalid-source` | An input is malformed, ambiguous, contains leftover temp files, or fails validation. | `contribution-shape`, `entry-text`, `ambiguous-source`, `source-not-in-identity`, `incomplete-staging-temp-file`, `embedded-digest`, `session-lineage`, `verdict-mismatch`, `reviewer-attempt-mismatch`, `fixer-attempt-mismatch` |
| `stale-revision` | The operation names a revision, dispatch, representation, or review pass that is no longer current. | `revision-not-ready`, `revision-not-current`, `dispatch-settled`, `capabilities-changed`, `profile-changed`, `content-changed`, `candidate-mismatch`, `review-revalidation-required` |
| `required-context-unavailable` | Required context is missing, mutated, or cannot be reached. | `no-contribution`, `coverage-unavailable`, `artifact-unroutable`, `source-digest-mismatch`, `source-mutated-during-copy`, `review-blocking-findings` |
| `capacity-exceeded` | A limit above was reached. | `manifest-bytes`, `rendered-bytes`, `source-count`, `candidate-count`, `profile-unqualified`, `revision-count`, `preparation-queue-full`, `working-set-exceeded`, `preparation-deadline`, `materialized-file-count`, `materialized-file-bytes`, `materialized-total-bytes`, `materialization-deadline`, `pin-quota-reached`, `artifact-oversized`, `pass-limit` |
| `storage-unavailable` | The store, filesystem (`ENOSPC`/`EACCES`/I/O), or F05 pin/registration failed. | `store-failure`, `version-race`, `stored-manifest`, `stored-record`, `destination-write-enospc`, `staging-io-eacces`, `artifact-pin-failed` |
| `unsupported-version` | A policy, contribution, manifest, renderer, report, or claims version is newer than this build knows. | `policy-version`, `contribution-version`, `manifest-version`, `renderer-version`, `report-version`, `claims-version` |
| `uncertain-delivery` | An earlier dispatch on this handoff revision is unsettled (`intent`) or `uncertain`. | `dispatch-uncertain` |

## Acceptance & verification mapping (`R7-17-07`, `R7-17-08`)

| Requirement / Criterion | Scope verified | Automated test files |
|---|---|---|
| `R7-17-07` (`FR-001`, `FR-007/008/009/012/013/016/020/022/035`, `NFR-003`) | Disabled vs opted-in transition isolation (0 SQLite rows, 0 pins, 0 captures); checked protective pins & restart locator fallback without `registerExternalContribution`; revision-bound approval, `continue-handoff` `expectedHandoffRevision`, and metadata-only `compareHandoffRevisions`; negotiated `loadSession` reuse, incapable-target fallback, cross-backend fresh, persisted `DeliveryRepresentation` `checkDispatch` non-overwrite on refusal, and `AcpBackedRunner` negotiated-capability check; attempt-scoped sanitized `legacySidecarOptIn`; persisted revision-1 `'prepared'` observation & exception-safe `onObservation`; saturated FIFO admission (2 active + 8 queued + 11th refused, FIFO promotion, un-clamped working set, 2 s deadline); restart after both transport-drop `'uncertain'` and host-crash `'intent'` preserving both `handoff` & `attempt` pins and blocking duplicate dispatch for same and new `targetAttemptId` across coordinator & `WorkflowRecoveryService`. | `tests/integration/phase-context/f15b-handoff-integration.test.ts`, `tests/unit/services/phase-context/phase-handoff-coordinator.test.ts`, `tests/unit/phase-context/acceptance.test.ts`, `tests/unit/phase-context/delivery-plan.test.ts`, `tests/unit/phase-context/explanation.test.ts` |
| `AC-12` (`FR-023`, `FR-024`, `FR-033`) | Atomic valid publish; stale/foreign attempt refusal; partial/0-byte & short-read buffer offset safety; malformed JSON; exact `262,144` B accepted vs `262,145` B refused; symlink/non-regular refusal; `EACCES` denied read (only `ENOENT` maps to absent); leftover `*.tmp`/`*.part` failing closed (alone or beside a final file, zero silent `complete` fallback); atomic sibling temp + `rename` immutable capture. | `tests/unit/services/phase-context/attempt-result-publisher.test.ts`, `tests/integration/phase-context/f15b-handoff-integration.test.ts` |
| `AC-14` (`FR-025`, `FR-026`, `NFR-003`, `NFR-007`) | Exact/over caps (`64`/`65` files, `16 MiB` / `16 MiB + 1 B` per file, `64 MiB` / `64 MiB + 1 B` deduplicated aggregate); `<= 1 MiB` streaming chunk memory; `30,000 ms` vs `30,001 ms` deadline; `ENOSPC`/disk-pressure typed `storage-unavailable` with 0 uncaught throws; Pass-1/Pass-2 digest & mutation detection; restart reuse verifying bytes and ensuring F05 pin; original pin survival; batch rollback & copy cleanup leaving 0 partial/0-byte exposed destination files; shared NFR-003 admission. | `tests/unit/services/phase-context/handoff-materializer.test.ts`, `tests/integration/phase-context/f15b-handoff-integration.test.ts` |
| `FR-032` | Authored ForEach node producing a `> 2 KiB` ordered result index (with succeeded + failed/partial slots and slot errors) feeding a `contextPolicy`-enabled downstream phase that selects the immutable `.schegent/foreach-results/<ref>.json` as a full `ArtifactRef` without 2 KiB truncation or raw child outbox concatenation. | `tests/integration/phase-context/f15b-handoff-integration.test.ts`, `tests/unit/services/foreach-executor.test.ts` |
| `FR-027` | Authored `Initial Review -> conditional Repeat(Fix -> Review)` workflow sharing one unified `loop-<runId>-<repeatNodeId>` ledger: initial passing review skips Repeat (0 Fix attempts); negative review enters Repeat carrying findings into Fix; `fix-claims.json` alone never closes findings; re-review pass closes findings & exits cleanly; candidate mutation invalidates exit until re-reviewed; false Repeat exit blocked across live execution and `WorkflowRecoveryService` restart; pass-cap exhaustion (`maxIterations`) stops without dispatching an extra Fix. | `tests/integration/phase-context/f15b-handoff-integration.test.ts`, `tests/unit/phase-context/finding-ledger.test.ts` |

## Measured latency

Preparing one handoff with a maximum manifest (256 candidates, 32 selected sources, a rendered
context of 31,097 bytes) took 2.70 ms and 8.17 ms at the 95th percentile in two takes of 200
samples, against a bound of 250 ms. The measurement is in memory only; it includes no store
write. The test is `tests/perf/phase-context-preparation.test.ts`.

## Remaining limits and open gaps

While F15-B durable SQLite persistence, checked F05 pinning, atomic AC-12 result staging, atomic
streaming AC-14 materialization, selectable FR-032 ForEach result indexes, unified FR-027 review
loops, operator inspection/diff/approval, recovery enforcement, and ACP `session/prompt` delivery
are wired in production, the following external and host limits remain:

- **Reconciling an `uncertain` dispatch**: when a dispatch intent is interrupted by a transport
  drop or host crash and transitioned to `'uncertain'`, Schegent preserves both `handoff` and
  `attempt` protective pins and refuses any duplicate automated dispatch on that revision
  (`uncertain-delivery` / `dispatch-uncertain`) for both the same and newly minted target attempt
  IDs; no automated provider-side reconciliation protocol exists to query an external backend for
  whether it processed the interrupted send, so explicit operator/recovery intervention is
  required to supersede the revision.
- **Model-vendor egress and retention outside Schegent**: once `acpPromptBlocks` are sent to
  `claude`, `codex`, or `agy`, any rendered handoff text, embedded artifact bytes, or files read via
  resource links / materialized copies leave the local machine and are subject to the model vendor's
  retention policies and the backend CLI's local session store under `<home>/`.
- **Legacy sidecar import**: legacy `phase-message.env` sidecars are ignored by default and are
  only read when `legacySidecarOptIn === true` (attempt- or iteration-scoped, capped at 4 KiB,
  parsed through `PhaseSidecarReader` and sanitized via `SanitizedLogger.sanitizeRecord`).
- **Live provider observation**: automated integration tests
  (`tests/integration/phase-context/f15b-handoff-integration.test.ts`) exercise real SQLite
  persistence, F05 pinning/retention, cross-root streaming materialization, restart recovery, and
  deterministic stdio ACP fixtures; live paid provider turns remain gated separately by release
  qualification.
