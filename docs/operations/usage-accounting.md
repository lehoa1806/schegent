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

**F06 usage accounting is wired in production.** Trusted primary activation (`src/activation/sqlite-cutover-wiring.ts`) constructs `createUsageAccountingService` and `createUsageAccountingWiring` on the canonical folder-keyed SQLite store (`<globalStorageUri>/sqlite/<scope>/schegent-state.db`), imports the legacy metrics-rollup epoch (`metrics-rollup.jsonl`) once, serves both the sidebar usage view and headless API (`src/headless/usage-accounting-api.ts`), and offers accepted observations to the opt-in telemetry host service when enabled. In an untrusted window or before the SQLite store opens, reads fail closed with `store-unavailable`.

The F04 store also carries four placeholder tables (`usage_observations`, `usage_corrections`,
`usage_accounting_applications`, `attempt_usage_revisions`). F06 does not use them; its records
live in the `accounting_*` tables. Removing or repurposing the placeholders is a maintainer
decision, left open.

## Three spend and usage mechanisms (and when each enforces)

Three separate host components read or display spend and usage. Each has a distinct unit, timing, and failure behavior:

| Mechanism | Source | Timing & enforcement | Handling of unpriced / incomplete data |
|---|---|---|---|
| **Post-turn spend watcher** | `src/services/spend-bound-watcher.ts` | Observes `phase-end` audit entries *after* a turn ends; pauses the Run (`spend-bound-reached`, never terminal) in the backend's denomination (`USD` for `claude`, `tokens` for `codex` / `agy`). Because spend is reported only after a turn ends, a crossing overshoots by the crossing phase and at most one phase after it if the pause write lands late. | Marks the Run `not-trustworthy` / incomplete (lower bound or not measurable); notifies once per Run per unit with no fabricated amount; never treats unmeasurable usage as within budget, and still pauses if a lower bound crosses the limit. |
| **Pre-dispatch `strict-usd` control admission** | `src/services/workflow-execution/control-usage-accounting.ts` | Evaluates connected-workflow root budgets (`strict-usd` vs `count-only`) *before* dispatching the next attempt, tracking `verifiedMicrousd`, `estimatedMicrousd`, `unpricedAttemptCount`, `reservedMicrousd`, and `uncertainReservationCount`. | Refuses pre-dispatch with `spend-unverifiable` or `spend-limit-reached`; retains reservations for `uncertain` attempts; **never coerces unpriced or token-only usage to `$0` verified USD**. |
| **F06 usage accounting & historical reports** | `src/services/usage-accounting/usage-accounting-service.ts` | Projects authoritative historical totals per attempt/invocation/measure/unit into `reportedTotal` vs `estimatedTotal` lanes alongside `completeness` (`known`, `partial`, `unknown`, `conflicting`) and `coverage` (`{ known, denominator }`). | Records missing or baseline-less figures as `unknown` / `partial` with explicit gap reasons (`unattributed-session-baseline`, etc.), never as `$0.00`. |

**CLI-reported spend is not an authenticated provider billing statement.** Every dollar or token number Schegent displays comes from CLI stdout/ACP usage payloads emitted by the local backend process. It may omit cache-pricing adjustments, enterprise/subscription discounts, failed requests outside the bridge, or provider-side billing corrections. Any claim about actual billed spend requires an authenticated provider invoice or billing API measurement outside Schegent.

## Operator walkthrough: priced vs incomplete/unmeasurable runs

### 1. Priced run (e.g., `claude` reporting USD cost)

- **Displayed unit & completeness**: `USD` in exact decimal micro-units (`reportedTotal`), `completeness: 'known'`, `coverage: { known: N, denominator: N }` when every attempt reports a valid cost (and an estimated lane only if explicitly computed, never blended into `reportedTotal`).
- **Enforcement**:
  - Under `SpendBoundWatcher` (`schegent.spend.maxUsdPerRun` or Phase `spendBoundUsd`), each settled `phase-end` adds to the Run's tally. Crossing the bound writes a resumable pause (`spend-bound-reached`) at the phase boundary — the crossing turn itself has already completed and been paid for (phase-end overshoot).
  - Under connected-workflow `strict-usd` control admission (`control-usage-accounting.ts`), verified micro-USD and reservations are checked *before* the next attempt dispatches (`spend-limit-reached` stops before starting another turn).
  - In F06 historical reports, the Run's total appears with `completeness: 'known'` and its exact coverage ratio.

### 2. Incomplete or unmeasurable run (e.g., `codex` / `agy` token-only, missing `costBaseline`, or truncated restart replay)

- **Never coerced to `$0`**: missing cost is never converted to `$0.00`, and token counts are never converted into synthetic USD in the verified/reported lane.
- **Enforcement & display**:
  - Under `SpendBoundWatcher`: on `codex` or `agy`, USD bounds do not apply (use `schegent.spend.maxTokensPerRun`); if a configured denomination is absent from `phase-end` or an 8 MiB restart replay (`SPEND_REPLAY_MAX_BYTES`) stops before the Run's start, the watcher marks the Run `not-trustworthy`, notifies the operator once per Run per unit with no fabricated figure, never reports it as within budget, and still pauses if the measured lower bound crosses the limit.
  - Under `strict-usd` control admission: an unpriced or token-only attempt increments `unpricedAttemptCount` (leaving `verifiedMicrousd` untouched) and refuses further `strict-usd` dispatch with `spend-unverifiable`.
  - In F06 historical reports: an attempt missing a qualified session baseline records `unknown` with gap `unattributed-session-baseline`, yielding `completeness: 'unknown'` or `'partial'` with `coverage.known < coverage.denominator`.

## Reproducibility boundaries and `promptIdentity` exclusions

Re-running a workflow does **not** guarantee identical model outputs or identical spend. Schegent separates frozen run inputs from dynamic execution variables:

- **Frozen at run admission**: `FrozenWorkflowClosure` (published Phase and Workflow definitions, effective per-phase runner/capability/retry policies, tighten-only limits, output contracts) and `ExecutionEnvelope` (initial inputs, supplemental inputs, declared outputs, instructions, and frozen `acpPromptBlocks` when a connection opts into `contextPolicy`). Editing the catalog after admission never mutates an in-flight Run.
- **Dynamic variables that can still vary across runs**: prior phase messages, carried unresolved issues, workspace checkout contents, CLI-loaded skill files/system prompts/defaults, installed backend CLI version, remote model/provider version or routing updates, provider-side sampling non-determinism, and tool side effects.
- **What `promptIdentity` covers and excludes (`src/runner/prompt-identity.ts`, `PROMPT_COMPOSITION_VERSION = 2`)**: each `phase-start` audit row records either `{ scope: 'contract', compositionVersion, digest }` (SHA-256 over the composition version, output-contract text, and rendered task block) or `{ scope: 'resume' }` (no digest when a stored resume prompt is sent). `promptIdentity` **deliberately excludes** the feature brief, iteration count, feature directory, sidecar path, previous phase messages, carried issues, request envelope, continuation note, phase ID, filesystem paths, CLI-loaded skills/system prompts, backend argv, model/provider version, and sampling parameters. Equal `promptIdentity` digests prove only that two attempts shared the same output-contract scaffold and task block, not that their full prompts or environments were identical.

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

The workspace tracks these release limits and their follow-up tasks in FR-R7-16, under “305 Usage and metrics accounting.”

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
