# Phase-to-Phase Context Handoff (`FR-R6-F15`)

**Declared**: 2026-11-11 (`specs/314-phase-context-handoff/spec.md`)

This guide is for an operator or maintainer who needs to know what a context handoff between
two workflow phases carries, what it never carries, which limits it stays under, how disabled and
opted-in transitions behave in production, why a handoff can be refused, and what limits remain.

Implemented in:

- [`src/contracts/phase-context/`](../../src/contracts/phase-context/): the limits, the closed
  failure list and the shapes of the policy, the contribution, the manifest, the delivery
  representation and the review records;
- [`src/services/phase-context/index.ts`](../../src/services/phase-context/index.ts): the
  services (`PhaseHandoffCoordinator`, `SqliteHandoffStore`, `attempt-result-publisher.ts`,
  `handoff-materializer.ts`, `handoff-delivery-coordinator.ts`, `review-loop-coordinator.ts`),
  re-exported from one index;
- [`src/activation/sqlite-cutover-wiring.ts`](../../src/activation/sqlite-cutover-wiring.ts),
  [`src/services/workflow-execution/phase-handoff-execution-bridge.ts`](../../src/services/workflow-execution/phase-handoff-execution-bridge.ts),
  and [`src/runner/acp-backed-runner.ts`](../../src/runner/acp-backed-runner.ts): production
  construction, workflow execution bridging, and ACP `session/prompt` delivery.

## Production status

**F15-B is wired in production.** Extension activation (`src/activation/sqlite-cutover-wiring.ts`)
constructs `createPhaseHandoffCoordinator` backed by the folder-scoped SQLite store
(`SqliteHandoffStore`, `phase_handoff_records`, `review_loop_ledgers`, `review_findings`,
`handoff_artifact_pins`) and F05 `ArtifactLifecycleService`, and passes it into workflow
execution (`connected-run-coordinator.ts`, `phase-handoff-execution-bridge.ts`,
`workflow-control-service.ts`, and `workflow-recovery-service.ts`).

Phase-context handoff remains **strictly opt-in per workflow connection**: a connection with no
`contextPolicy` prepares no handoff record, holds no F05 handoff pins, materializes no copies, and
transmits only the ordinary single text prompt from `PromptBuilder`.

### Disabled vs opted-in transition trace

| Stage | Disabled (`connection.contextPolicy === undefined`) | Opted-in (`connection.contextPolicy !== undefined`) |
|---|---|---|
| 1. Settled source attempt | `settleAndPrepareTransitionHandoff` records any staged attempt candidate locally and immediately returns `{ ok: true, waitingApproval: false }`. | Source attempt staged outputs (`.schegent/results/<rootAlias>/<attemptAlias>/contribution.json`, optional `review-report.json` / `fix-claims.json`, or opt-in `.schegent/phase-message.env` only when `legacySidecarOptIn === true`) are validated via `openWithinRoot`, copied immutably under `.schegent/immutable-results/<attemptAlias>/`, and registered/pinned in F05 `ArtifactLifecycleService`. |
| 2. Preparation & durable persistence | **Zero** `phase_handoff_records` SQLite rows, **zero** F05 handoff pins, and **zero** `.schegent/handoff-materialized/` files are created. | `prepareTransitionHandoff` runs deterministic selection up to the commit cutoff, persists the serialized manifest and rendered context in SQLite `phase_handoff_records` (`SqliteHandoffStore`), and establishes F05 owner-reference pins (`handoff_artifact_pins`). |
| 3. Operator confirmation / approval | None required (no handoff is prepared). | Under `approvalMode: 'manual'`, the revision enters `waiting-approval` and pauses the workflow until the operator inspects, optionally edits, and explicitly approves that revision (`workflow-control-service.ts` / `phase-context-api.ts`). Under `approvalMode: 'automatic'`, the revision starts `ready`. |
| 4. Delivery planning & materialization | `buildAttemptHandoffDelivery` returns `undefined`; no `FrozenPhaseHandoffDelivery` or `acpPromptBlocks` is attached. | `executePlanAttemptDelivery` plans routes per artifact (`embedded` up to 8 KiB text, `resource-link` for immutable URIs, or `materialized-copy` streaming verified bytes via `openWithinRoot` into `.schegent/handoff-materialized/<attemptAlias>/<file>` within 64 files / 16 MiB per file / 64 MiB total / 30 s deadline and pinned in F05) and freezes `acpPromptBlocks`. |
| 5. Provider prompt delivery & egress | `AcpBackedRunner` builds the ordinary single `{ type: 'text', text: request.prompt }` block from `PromptBuilder` and sends it to the configured backend (`claude`, `codex`, or `agy`). | `capability-decision-recorder.ts` forwards `handoff.acpPromptBlocks` onto the backend request. `AcpBackedRunner` sends `request.acpPromptBlocks` (replacing the plain text prompt) over ACP `session/prompt` to `claude`, `codex`, or `agy`, transmitting the rendered context and embedded/linked/materialized artifacts to the external model vendor. |
| 6. Terminal cleanup & surviving copies | No handoff pins or SQLite handoff rows exist. | On terminal exit (success, failure, or cancellation), handoff owner-reference pins are released after the durable terminal revision commits (and reconciled idempotently by recovery on restart). Local SQLite rows, F05/F15-B files, backups, vendor CLI histories (`<home>/.claude/`, `<home>/.codex/`, `<home>/.gemini/antigravity/`), and vendor-side copies are inventoried in [evidence-retention-disclosure.md](evidence-retention-disclosure.md). |

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

A refusal, an explanation and a lifecycle observation carry identifiers, digests, counts and
members of closed lists. None of them carries source text, a path or an error message.

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
| Explanation | 64 KiB |
| Preparations active at once, and queued | 2 and 8 |
| Working set across the active preparations | 8 MiB |
| Preparation deadline, from activation | 2 seconds |
| Review artifact | 256 KiB, 200 records, 2 KiB per record, depth 16, 8,192 values |
| Findings in one review loop | 1,024 |
| Passes of one review loop | 32 |
| History shown to a later pass | the last 5 passes, 1 KiB each, 8 KiB in total |

A target profile with no qualified context size is refused; there is no default bound for it.

The materialization limits (64 files, 16 MiB per file, 64 MiB in total, 1 MiB streaming buffer,
30-second deadline) are enforced in production by `src/services/phase-context/handoff-materializer.ts`
when a delivery plan uses the `materialized-copy` route into `.schegent/handoff-materialized/<attemptAlias>/`.

## Acceptance, revisions and dispatch

Acceptance stores a prepared handoff through a durable store port (`SqliteHandoffStore` backed by
SQLite `phase_handoff_records` in production; `memory-store.ts` in pure unit tests).

- Acceptance, approval and a dispatch intent are idempotent by identity: asking again returns
  what is stored and writes nothing. No exactly-once delivery is claimed.
- An edit is not idempotent. It is a compare-and-set on the current revision, so the same edit
  asked a second time is refused as stale (`revision-not-current`). An approval of a revision
  that was superseded is refused the same way, and a dispatch intent for one is refused with
  `revision-not-ready`.
- A record the store returns is checked before any operation reads it. One whose entries do
  not have the shape acceptance writes, whose revisions are not numbered from 1 in the order
  they are stored, or that belongs to another handoff, refuses the operation (`stored-record`)
  and nothing is written.
- A prepared handoff is taken from its serialized text alone. The text is parsed, checked to be
  the one serialization of its manifest and rendered again, so the stored digests are of what
  the host computed.
- A revision is `waiting-approval`, `ready` or `superseded`. Under `manual` approval a revision
  waits; an approval names one revision and does not carry to the next.
- An edit writes the next revision, under the same limits. It may change the text of a
  selected source, drop entries and artifacts from it, and drop optional sources. It may not
  add a source or an artifact, change who produced a source or why it was taken, or remove
  a required source.
- A dispatch record is `intent`, `delivered` or `uncertain`. An intent says a send may have
  happened. An attempt whose delivery is `uncertain` gets no second intent.

## Delivery plan

Before target attempt dispatch, `handoff-delivery-coordinator.ts` computes the delivery plan,
materializes cross-root copies when selected, and freezes `acpPromptBlocks` onto the attempt's
`FrozenPhaseHandoffDelivery`. `AcpBackedRunner` transmits those blocks over ACP `session/prompt`
(replacing the plain `PromptBuilder` text block) so context travels as structured prompt blocks
only, never through a command line or an environment variable. Any content placed in embedded
blocks or read through linked/materialized files is transmitted to the external model vendor
(`claude`, `codex`, or `agy`); see [evidence-retention-disclosure.md](evidence-retention-disclosure.md)
for the complete retention and egress inventory.

Each artifact takes the first route that applies:

| Route | When |
|-------|------|
| `embedded` | A text artifact of at most 8 KiB, when embedding was negotiated, the host supplied the text, and it fits what is left of the profile's qualified size after the rendered context. A text whose size or digest does not match its reference refuses the plan. |
| `resource-link` | The host supplied an immutable link. |
| `materialized-copy` | A protected copy is permitted. Until the copy exists the plan lists the artifact and holds no block. |
| `omitted` | An optional artifact with no route. A required one refuses the plan. |

A `fresh` session is always allowed. Reuse is planned only when the policy says
`reuse-when-qualified` and the session belongs to the target's own node occurrence.

The plan records a representation: identities, digests, the negotiated capabilities, the
profile and the route names. A dispatch is checked against it and refused when the
capabilities, the profile or the content changed after the plan was made.

## Review loop

The host, not the reviewer, decides what a review pass means.

- A review report and a fixer's claims are parsed by a bounded strict parser: duplicate keys,
  forbidden keys, depth over 16 and more than 8,192 values are refused.
- A report is checked against the loop, the pass before it and the candidate, scope and
  criteria it was made for.
- The verdict is computed from the finding statuses: `needs-fixes` when any finding of a
  blocking severity is not `resolved`; otherwise `passed` with `complete` coverage and
  `incomplete` with `partial` coverage. A report with `unavailable` coverage, or one that
  states another verdict, is refused whole.
- A fixer's claims (`claimed-fixed`, `not-addressed`, `disputed`) are recorded beside the
  statuses and change none.
- The ledger keeps identities, severities, statuses and claims. A finding's title, explanation
  and evidence stay in the report artifact.

A completed review phase and a passed review are separate facts: a phase can finish with the
verdict `needs-fixes`.

## Why a handoff was refused

Every refusal is one of eight failures with a fixed detail code.

| Failure | When | Detail codes, for example |
|---------|------|---------------------------|
| `invalid-policy` | The policy is malformed, or an operation asks for something it does not allow. | `policy-shape`, `selector-duplicate`, `approval-not-required`, `session-reuse-not-permitted` |
| `invalid-source` | An input is malformed, ambiguous or not what its reference says. | `contribution-shape`, `entry-text`, `ambiguous-source`, `source-not-in-identity`, `source-attempt-count`, `embedded-digest`, `session-lineage`, `verdict-mismatch`, `artifact-oversized` |
| `stale-revision` | The operation names a revision, dispatch or review pass that is no longer the current one. | `revision-not-ready`, `revision-not-current`, `dispatch-settled`, `capabilities-changed`, `profile-changed`, `content-changed`, `candidate-mismatch` |
| `required-context-unavailable` | Required context is missing or cannot be reached. | `no-contribution`, `coverage-unavailable`, `artifact-unroutable` |
| `capacity-exceeded` | A limit above was reached. | `manifest-bytes`, `rendered-bytes`, `source-count`, `candidate-count`, `profile-unqualified`, `revision-count`, `preparation-queue-full`, `working-set-exceeded`, `pass-limit` |
| `storage-unavailable` | The store failed, or a stored record or a stored manifest text did not pass the checks made before it is read. | `store-failure`, `version-race`, `stored-manifest`, `stored-record` |
| `unsupported-version` | A policy, contribution, manifest, renderer, report or claims version is newer than this revision knows. A newer policy or manifest is handed back as it was given, not rewritten. | `policy-version`, `contribution-version`, `manifest-version`, `renderer-version`, `report-version`, `claims-version` |
| `uncertain-delivery` | A send for the attempt may already have happened. | `dispatch-uncertain` |

## Measured latency

Preparing one handoff with a maximum manifest (256 candidates, 32 selected sources, a rendered
context of 31,097 bytes) took 2.70 ms and 8.17 ms at the 95th percentile in two takes of 200
samples, against a bound of 250 ms. The measurement is in memory only; it includes no store
write. The test is `tests/perf/phase-context-preparation.test.ts`.

## Remaining limits and open gaps

While F15-B durable persistence, F05 pinning, streaming cross-root materialization, result
publication, review-loop coordination, operator inspection/approval, and ACP `session/prompt`
delivery are wired in production, the following limits remain:

- **Reconciling an `uncertain` dispatch**: when a dispatch intent is interrupted before settlement
  and left in `uncertain`, Schegent refuses to issue a second automated dispatch intent for that
  attempt (`uncertain-delivery` / `dispatch-uncertain`) and retains handoff pins while recovery is
  possible; there is no automated provider-side reconciliation protocol to confirm whether the
  external backend received the first send.
- **Model-vendor egress and retention outside Schegent**: once `acpPromptBlocks` are sent to
  `claude`, `codex`, or `agy`, any rendered handoff text, embedded artifact bytes, or files read via
  resource links / materialized copies leave the local machine and are subject to the model vendor's
  retention policies and the backend CLI's local session store under `<home>/`.
- **Legacy sidecar import**: `.schegent/phase-message.env` is ignored by default and is only read
  when `legacySidecarOptIn === true` (capped at 16 KiB).
- **Live provider observation**: integration tests (`tests/integration/phase-context/f15b-handoff-integration.test.ts`)
  exercise real SQLite persistence, restart recovery, and synthetic source/target fixtures; live
  paid provider turns remain gated separately by release qualification.
