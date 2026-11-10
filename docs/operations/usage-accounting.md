# Usage and Metrics Accounting (`FR-R6-F06`)

**Declared**: 2026-11-10 (`specs/305-usage-metrics-accounting/spec.md`)

This guide is for an operator who reads usage and cost totals and needs to know how far to trust
them. Every total comes from one authority, the accounting service. The headless API and the
sidebar's usage read both call it and return its answer unchanged, so the two surfaces cannot
disagree.

Implemented in:
- [`src/contracts/usage-accounting/accounting-types.ts`](../../src/contracts/usage-accounting/accounting-types.ts)
- [`src/contracts/usage-accounting/query-contract.ts`](../../src/contracts/usage-accounting/query-contract.ts)
- [`src/contracts/usage-accounting/provider-qualifications.ts`](../../src/contracts/usage-accounting/provider-qualifications.ts)
- [`src/services/usage-accounting/usage-accounting-service.ts`](../../src/services/usage-accounting/usage-accounting-service.ts)
- [`src/services/usage-accounting/projection.ts`](../../src/services/usage-accounting/projection.ts)
- [`src/services/usage-accounting/authority-policy.ts`](../../src/services/usage-accounting/authority-policy.ts)
- [`src/services/usage-accounting/corrections.ts`](../../src/services/usage-accounting/corrections.ts)
- [`src/services/usage-accounting/legacy-epoch.ts`](../../src/services/usage-accounting/legacy-epoch.ts)
- [`src/services/usage-accounting/usage-accounting-wiring.ts`](../../src/services/usage-accounting/usage-accounting-wiring.ts)
- [`src/headless/usage-accounting-api.ts`](../../src/headless/usage-accounting-api.ts)

For the store these records live in, see [SQLite application store](sqlite-application-store.md).

## Production status

The service, its schema and its wiring ship in this release, but production constructs no
accounting service until the application store is opened in the extension host (the F01-B
cutover). Until then:

- the sidebar's usage read and the headless API answer `store-unavailable`;
- the audit-stream and terminal-run hooks are installed but have no service to feed;
- the existing metrics rollup (`metrics-rollup.jsonl`) and its readers are unchanged.

The F04 store also carries four placeholder tables (`usage_observations`, `usage_corrections`,
`usage_accounting_applications`, `attempt_usage_revisions`). F06 does not use them; its records
live in the `accounting_*` tables. Removing or repurposing the placeholders is a maintainer
decision, left open.

## How a figure is built

1. A source reports an **observation**: one invocation of one attempt, with up to eight measures
   (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost`,
   `credits`, `context_used`, `context_size`).
2. The observation is stored once. A redelivery with the same identity and content is a
   `duplicate` and writes nothing; the same identity with different content is kept as
   `conflicting` evidence.
3. The **projection** picks one authoritative contribution per attempt, invocation, measure and
   unit, and records a new **revision**. Totals are sums of contributions, never of observations,
   so retries, replays and overlapping sources cannot be counted twice.

### Which source wins

Authority policy version 1 ranks `provider-reported` above `derived` above `estimated`. Within one
rank the earliest accepted observation wins. A later observation of the same figure is kept as
`corroborating` evidence when its value is equal, and as `conflicting` evidence when it differs.
Either way it is not added. The policy version and the calculation version are on every answer.

ACP usage updates are the exception. Each update is a fresh reading of the session's occupancy and
cumulative amounts, so within the winning rank the newest event wins (then the later ingest), and
the older readings are `superseded`, not `conflicting`.

The ingest result reports the disposition at admission (`accepted`, `duplicate`, `conflicting`,
`unattributed`, `historical`). The projection then sets the stored observation's final
disposition, so a second source of an already-counted figure reads `corroborating` in the store
even though its ingest answered `accepted`.

## Completeness and coverage

Every measure total carries a completeness and a coverage:

| Completeness | Meaning |
|---|---|
| `known` | Every attempt in the row reported this measure. |
| `partial` | Some attempts reported it; the total covers only those. |
| `unknown` | No attempt in the row has a known value. The total is not a measurement. |
| `conflicting` | Sources disagree on a selected figure; see the evidence. |

`coverage` is `{ known, denominator }`: attempts with a known value over attempts in the row. Read
a total together with its coverage. A `partial` total of 3 of 10 attempts is a floor, not an
estimate of the whole.

## Reported and estimated cost

Cost has two lanes, reported separately and never blended:

- `reportedTotal`: provider-reported and derived cost;
- `estimatedTotal`: cost estimated from tokens and a price table.

A cost `total` equals `reportedTotal`; the estimated lane is never added into it, and an attempt
with only estimated cost does not count as known in the coverage. Quote an estimated figure only
as an estimate, beside the reported total.

A session-cumulative cost with no qualified baseline (for example, a `phase-end` row with no
`costBaseline`) is stored with cost `unknown` and the reason `unattributed-session-baseline`. It
is never counted as the full session figure.

## Currencies and credits

Money is held as exact decimal micro-units (six fractional digits), never as floating point. Sums
are exact: 100,000 additions and 1,000 corrections at scales 0 to 6 total to the micro-unit
(SC-003, `tests/integration/usage-accounting-acceptance.test.ts`).

Each currency is its own unit; USD and EUR are never added together. Provider credits are the
separate `credits` measure in the provider's own unit (for example `acme.credits`). They are never
converted into cost.

ACP `used` and `size` are context-window occupancy (`context_used`, `context_size`). They are
reported as the latest value and are never billable tokens.

## Unattributed and historical observations

- **Unattributed**: an observation with no root or attempt. It is stored, up to 10,000 retained,
  and counted in `unattributedCount`, but it is in no row total. Past the bound, new ones are
  refused and counted as an `unattributed-limit` gap.
- **Historical**: a replayed observation with no producer identity (an ACP replay, say). It cannot
  be deduplicated, so it is stored for evidence and never counted.

## Corrections and revisions

A correction replaces one contribution's quantity, with a reason code and an actor (`operator` or
`provider`), under a new `correction` revision. A correction outranks any later observation until it
is itself replaced. Each contribution takes at most 64 corrections. A target past the 90-day
horizon is refused as `beyond-correction-horizon`.

Every answer names its `revision`. A query with `asOfRevision: N` answers exactly what the latest
read answered at revision N, including after a restart. Retention may compact old revisions; a
read below the compaction floor answers `revision-compacted`.

## The legacy epoch

Runs recorded before F06 by the first-terminal rollup are imported once into a labelled legacy
epoch. They are never mixed with observations:

- they carry no backend, model or phase, so they appear in no grouped row;
- `includeLegacy: true` adds a separate `legacy` summary (run count, cost, boundary run,
  reconciliation);
- a legacy run id cannot be recorded again as a new root (`legacy-epoch-overlap`).

The import reads the rollup twice and reports `matched`, `mismatch` (with counts only), or `empty`.
An interrupted import resumes to the same rows. Two overlapping imports complete the epoch once.
The rollup file is only read.

The import never completes on a figure it could not read:

- a rollup that exists but cannot be read is refused `store-unavailable`
  (`legacy-rollup-unreadable`), and the epoch stays open for the next start;
- a read that skipped bytes or unreadable records reconciles `mismatch`, with the counts;
- the reconciliation compares the runs stored in the epoch with the second read, so an
  interrupted import that resumes after the rollup shrank or vanished reconciles `mismatch`, not
  `matched` or `empty`;
- a run id over 256 bytes or containing a control character is excluded and counted in the
  `mismatch` detail;
- a run cost over $1,000,000 is stored as unknown, not as a figure.

## Gaps

Anything the service could not count is counted as a gap instead of being dropped silently.
`readGaps` lists each kind with its scope, count and first and last time:

| Gap kind | Cause |
|---|---|
| `invalid-counter` | A counter that went backwards or was malformed. |
| `cumulative-reset` | A session-cumulative counter reset. |
| `unattributed-session-baseline` | A cumulative cost with no baseline; stored as unknown. |
| `dimension-excluded` | A dimension value failed sanitizing and was dropped. |
| `unattributed-limit` | The unattributed bound was reached. |
| `admission-overflow` | The bounded admission queue was full. |
| `ingest-failed` | The store refused or failed an ingest. |
| `projection-failed` | A projection did not commit; it is retried at the next start. |
| `expired-source` | An observation older than the horizon. |
| `telemetry-echo` | Schegent's own exported telemetry came back in; refused. |
| `observation-too-large` | An observation over 16 KiB or 32 fields. |
| `correction-refused` | A correction the service refused. |

A projection that fails is left pending and applied by the rebuild when the service next starts, so
a crash between storing an observation and projecting it loses nothing.

## Limits

| Bound | Value |
|---|---|
| Retained observations | 1,000,000 (expired detail is pruned within 1% of the bound) |
| Retention horizon | 90 days |
| Rows per page | 200 |
| Response size | 1 MiB |
| Query deadline | 5 seconds |
| Roots per query (`rootIds`, added by `FR-R6-F11`) | 1 to 64 unique ids, each matching the identifier pattern; absent means every root. It narrows the rows only: the unattributed count, gaps and legacy summary stay store-wide |
| Grouping dimensions | at most 3 of `backend`, `model`, `workflowRevision`, `phaseId`, `attemptOutcome`, `utcDay` |

At 100,000 retained attempts, warm filtered 200-row reads meet p95 ≤ 500 ms
(`tests/perf/usage-accounting-query.test.ts`).

## Known limits

These are accepted for this release and recorded in the feature review
(`docs/audits/305-usage-metrics-accounting-review.md` in the workspace):

- **The deadline is checked between statements.** A read runs synchronously, so one slow
  statement is not interrupted; the 5-second deadline and a headless caller's abort signal are
  checked before each next step. The sidebar passes no signal: no cancel message can be handled
  while a read is in progress. Reads at the 1,000,000-observation bound are not measured.
- **A response's `cutoffIngestSeq` is a high-water mark.** It is the highest ingest sequence any
  projection reflected, not a promise that every earlier observation is reflected. One whose
  projection failed shows as a `projection-failed` gap until the next start applies it.
- **A paging cursor carries only its revision and keys.** A cursor replayed with a different
  number of grouping dimensions, or keys that do not fit them, is refused; one replayed with
  different filters, range or measures returns pages of the new query from the cursor's keys.
  Keep the request unchanged while paging.
- **Retention keeps every selected observation.** An observation that backs an open
  contribution is never pruned, so a store at the 1,000,000 bound with only selected rows
  refuses new observations as `store-full`. Retention can prune a non-selected conflicting
  observation past the horizon; a later observation of the same figure then re-evaluates without
  it.
- **Event times are trusted forward.** An observation dated in the future is stored (flagged
  as a clock anomaly) and is not pruned until its date passes the horizon. Distinct units are
  not capped per row, so a producer emitting very many units can push a row over the response
  limit. Both matter once ACP producers (FR-R6-F13) feed the service.
- **A resumed legacy run.** Usage of a legacy run that resumes after the import is counted as
  new usage; its root outcome is refused `legacy-epoch-overlap` and counted as an
  `ingest-failed` gap.
- **Corrections are idempotent against the current correction only.** Resending an older
  correction after a newer one applies it again as a new revision.
- **A cost beyond the exact range** (about $9.2 trillion, 2^63−1 micro-units) in a phase-end row
  is refused as `invalid-counter` and counted, together with the rest of that observation.
