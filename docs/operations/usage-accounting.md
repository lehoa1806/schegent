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

The F04 store also retains seven deprecated, empty-in-production placeholder tables under SQLite
schema version `9` (`SQLITE_SCHEMA_CURRENT_VERSION = 9`, `SQLITE_MIN_READER_VERSION = 9`): four
usage placeholders (`usage_observations`, `usage_corrections`, `usage_accounting_applications`,
`attempt_usage_revisions`) superseded by F06 `accounting_*`, and three log placeholders
(`log_streams`, `log_segments`, `log_gaps`) superseded by F07 `live_log_*`. Production never writes
to those seven tables; their deprecated F04 adapters (`UsageStoreAdapter`, `LogIndexStoreAdapter`,
`executeUsageCorrection`) have zero production callers. Retaining them in schema v9 preserves
Migration 1 checksum immutability and schema-8/9 backup/restore compatibility; store relocation
(`src/services/sqlite-store/store-relocation.ts`) inspects `accounting_observations` and
`live_log_streams`, `state-census.ts` aligns `log-segment-bytes` to `live_log_segments`, and
retiring the seven placeholders is gated on a future breaking `min_reader_version` migration with
retired-table restore handling (see [SQLite application store](sqlite-application-store.md)).

## Three spend and usage mechanisms (and when each enforces)

Three separate host components read or display spend and usage. Each has a distinct unit, timing, and failure behavior:

| Mechanism | Source | Timing & enforcement | Handling of unpriced / incomplete data |
|---|---|---|---|
| **Post-turn spend watcher** | `src/services/spend-bound-watcher.ts` | Observes `phase-end` audit entries *after* a turn ends; pauses the Run (`spend-bound-reached`, never terminal) in the backend's denomination (`USD` for `claude`, `tokens` for `codex` / `agy`). Because spend is reported only after a turn ends, a crossing overshoots by the crossing phase and at most one phase after it if the pause write lands late. | Distinguishes genuine `0` usage from missing/unreported usage (`missing-usage` on mixed measured + unmeasured runs); marks missing or truncated runs `not-trustworthy` / incomplete (lower bound or not measurable); notifies once per Run per unit with no fabricated amount; never treats unmeasurable or partial runs as within budget, and still pauses if a measured lower bound crosses the limit. |
| **Pre-dispatch `strict-usd` control admission** | `src/services/workflow-execution/control-usage-accounting.ts` | Evaluates connected-workflow root budgets (`strict-usd` vs `count-only`) *before* dispatching the next attempt, tracking `verifiedMicrousd`, `estimatedMicrousd`, `unpricedAttemptCount`, `reservedMicrousd`, and `uncertainReservationCount`. | Refuses pre-dispatch with `spend-unverifiable` or `spend-limit-reached`; retains reservations for `uncertain` attempts; **never coerces unpriced or token-only usage to `$0` verified USD**. |
| **F06 usage accounting & historical reports** | `src/services/usage-accounting/usage-accounting-service.ts` | Projects authoritative historical totals per attempt/invocation/measure/unit into `reportedTotal` vs `estimatedTotal` lanes alongside `completeness` (`known`, `partial`, `unknown`, `conflicting`) and `coverage` (`{ known, denominator }`). | Records missing or baseline-less figures as `unknown` / `partial` with explicit gap reasons (`unattributed-session-baseline`, etc.), never as `$0.00`. |

**CLI-reported spend is not an authenticated provider billing statement.** Every dollar or token number Schegent displays comes from CLI stdout/ACP usage payloads emitted by the local backend process. It may omit cache-pricing adjustments, enterprise/subscription discounts, failed requests outside the bridge, or provider-side billing corrections. Any claim about actual billed spend requires an authenticated provider invoice or billing API measurement outside Schegent.

**No daily or workspace-wide cross-run aggregate spend cap ships today (explicit open product decision).** Alongside GC-10 tighten-only per-run bounds (`schegent.spend.maxUsdPerRun`, `schegent.spend.maxTokensPerRun`) and GC-25 post-turn phase-end overshoot, Schegent does not enforce a calendar-day or workspace-wide cross-run aggregate spend stop. F06 usage accounting aggregates historical totals across runs for reporting only and does not gate new run admission on a cross-run budget; see [Autonomy bounds disclosure](autonomy-bounds-disclosure.md#open-product-decision-daily-and-workspace-wide-aggregate-spend-caps).

## Operator walkthrough: priced vs incomplete/unmeasurable runs

### 1. Priced run (e.g., `claude` reporting USD cost)

- **Displayed unit & completeness**: `USD` in exact decimal micro-units (`reportedTotal`), `completeness: 'known'`, `coverage: { known: N, denominator: N }` when every attempt reports a valid cost (and an estimated lane only if explicitly computed, never blended into `reportedTotal`).
- **Enforcement**:
  - Under `SpendBoundWatcher` (`schegent.spend.maxUsdPerRun` or Phase `spendBoundUsd`), each settled `phase-end` adds to the Run's tally. Crossing the bound writes a resumable pause (`spend-bound-reached`) at the phase boundary — the crossing turn itself has already completed and been paid for (phase-end overshoot).
  - Under connected-workflow `strict-usd` control admission (`control-usage-accounting.ts`), verified micro-USD and reservations are checked *before* the next attempt dispatches (`spend-limit-reached` stops before starting another turn).
  - In F06 historical reports, the Run's total appears with `completeness: 'known'` and its exact coverage ratio.

### 2. Incomplete or unmeasurable run (e.g., `codex` / `agy` token-only, missing `costBaseline`, context-only ACP updates, or truncated restart replay)

- **Never coerced to `$0` or synthetic `0` tokens (`FR-R8-02` / `02-01`)**: ACP `used`/`size` remain context-window occupancy only and are never copied into billable tokens. Bridged CLIs forward validated billable counters via `usage_update._meta.billableTokens` (including `agy` `cacheCreationInputTokens` / `cache_creation_tokens`, and Claude USD cost paired with `SessionCostLedger` baseline subtraction in `AcpBackedRunner`). When billable counters or USD cost are absent, malformed, or context-only, `AcpBackedRunner` omits the corresponding keys rather than emitting synthetic `0`s; genuine `0` counters are preserved distinctly as measured zeroes. Token totals in `usage-reader.ts` are provider-qualified via `cacheRelation` (`disjoint` for `claude`, `subset-of-input` for `codex`, and fail-closed `unknown` for `agy` or any omitted/unlisted backend) so subset-of-input cached tokens are never double-counted, cache > input preserves a monotonic lower bound, contradictory `cacheRead + cacheCreate > input` or unknown positive cache counters mark the total `incomplete` (`cacheRelationAmbiguous`), and `SpendBoundWatcher` / `spend-bound-replay.ts` correlate `phase-end` rows with preceding `cli-invocation` backend tags chronologically.
- **Enforcement & display**:
  - Under `SpendBoundWatcher`: on `codex` or `agy`, USD bounds do not apply (use `schegent.spend.maxTokensPerRun`); if a configured denomination is absent from any `phase-end` row (`missing-usage`) or an 8 MiB restart replay (`SPEND_REPLAY_MAX_BYTES`) stops before the Run's start, the watcher marks the Run `not-trustworthy` (`unmeasurable` when zero rows reported the unit, or lower-bound `incomplete` when some rows reported it and others did not), notifies the operator once per Run per unit with no fabricated figure, never reports it as within budget, and still pauses if the measured lower bound crosses the limit.
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
  be deduplicated, so it is stored for evidence and never counted. It shares the 10,000
  `maxUnattributed` retention cap with unattributed observations; past that combined bound, new
  ones are refused as `unattributed-limit` so unkeyed replays cannot exhaust
  `maxRetainedObservations`.

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

## Producer trust separation, unit bounds, and clock skew (`FR-R7-16` / `16-05`)

Four producers feed usage accounting with distinct trust boundaries between host-stamped metadata
and agent-settable values:

| Producer | Entry point | Host-controlled fields | Agent-settable / external fields |
|---|---|---|---|
| **Phase-end audit watcher** | `src/services/usage-accounting/phase-end-ingestion.ts` via `UsageAccountingWiring` | `eventUtc` (audit timestamp), `observedUtc`, `rootId`, `attemptId`, `invocationOrdinal`, correlated `backend`/`model`/`phaseId`, `costBaseline`, fixed units (`count`, `USD`) | Parsed CLI token/cost numbers (validated through `readPhaseEndUsage`) |
| **ACP `usage_update`** | `src/services/acp-runtime/observation-emitter.ts` → `client-guards.ts` → `acp-usage-mapping.ts` | `eventUtc` (stamped from host receive clock in `ObservationEmitter`, never agent clock), `hostReceiveSeq`, `profileId`, `acpSessionId`, `connectionGeneration`, `turnId`, `replayed`, `hasQualifiedSessionBaseline: false` | `used`, `size`, optional `cost` (`amount`, `currency`), optional `credits` (`amount`, `unit`), optional `producerEventId` |
| **Direct `ingestObservation`** | `src/services/usage-accounting/usage-accounting-service.ts` | Host-internal service boundary only (not exposed directly to agents or webviews) | Validated by `observation-normalizer.ts` and `observation-store.ts` |
| **Legacy rollup import** | `src/services/usage-accounting/legacy-epoch.ts` | Isolated in `accounting_legacy_epoch` / `accounting_legacy_runs`, hardcoded `USD` micro-units | Historical `metrics-rollup.jsonl` lines (sanitized, capped at $1,000,000/run) |

To prevent unit-cardinality DoS and retention evasion:

- **Unbaselined ACP unit folding**: when `hasQualifiedSessionBaseline` is `false`, `acp-usage-mapping.ts` folds unknown `cost` updates to `USD` and unknown `credits` updates to `credits` so an unbaselined agent cannot mint arbitrary distinct currencies or credit units.
- **Per-`(attempt_id, measure)` ingest cap (`16`)**: introducing a 17th distinct unit for one `(attempt_id, measure)` is refused as `invalid-observation` (`detail: 'unit'`) and counted as an `ingest-failed` gap.
- **Per-`(row, measure)` query cap (`32`)**: `accounting-query.ts` serializes at most 32 distinct units per `(row, measure)` in deterministic `unit ASC` order and reports total omitted units on `AccountingRow.omittedUnitCount` (omitted when `0`), keeping even `limit: 1` cross-attempt mixed-unit groups readable well inside the 1 MiB response bound.
- **Future clock-skew refusal (`24 h`) and retention bound**: observations with `eventUtc` more than 24 hours (`86,400,000 ms`) ahead of ingest time are refused as `invalid-observation` (`detail: 'eventUtc'`) with a counted `ingest-failed` gap. Mild future skew `(5 min, 24 h]` is stored with `clock_anomaly = 1`, and retention evaluates expiry against `MIN(julianday(event_utc), julianday(ingested_utc))` so skewed rows cannot evade expiry past `horizonDays` from ingest.

## Paging cursors and UI response validation (`FR-R7-16` / `16-06`)

- **Query-bound v2 cursor**: accounting query cursors use `2~<revision>~<queryDigest32Hex>~<key0>~...` (at most 512 characters), where `queryDigest32Hex` is the first 32 lowercase hex characters of SHA-256 over the canonical query shape `{ groupBy, from, to, filters (sorted keys), measures (sorted unique or null), rootIds (sorted unique or null), includeLegacy }`. `limit` and `asOfRevision` are excluded from the digest so multi-revision consumers such as `src/services/reporting/report-usage.ts` can omit `asOfRevision` on page 1 and pass `asOfRevision: page1.revision` on later pages while `cursor.revision === request.asOfRevision` is still enforced.
- **Ephemeral cursor compatibility decision**: accounting cursors are never persisted to SQLite, disk, or webview state. Legacy v1 cursors (`1~...`) and mismatched query digests are refused consistently as `invalid-query` (`detail: 'cursor'`).
- **Deep UI response validation**: `isValidReadUsageAccountingResponse` (`src/contracts/validators/usage-accounting.ts`) validates `policyVersion`, `calculationVersion`, bounded `nextCursor`, every `row` (`key` dimensions/values, counts, `measures`, optional positive `omittedUnitCount`, zero unexpected keys), every `gap` (`kind` in `GAP_KINDS`, safe count), and optional `legacy` (`LegacyEpochSummary`) before the webview consumes a response.

## Retention, post-horizon compaction, and conflict history (`FR-R7-16` / `16-07`)

- **Post-horizon selected-observation compaction**: past `horizonDays` (90 days, evaluated as `MIN(julianday(event_utc), julianday(ingested_utc)) < julianday(cutoff)`), `pruneExpired` compacts expired selected observations (excluding any row with a pending projection intent or the highest `ingest_seq`) by detaching `accounting_contributions.selected_observation_id = NULL` before deleting the aged observation rows. Compacted open contributions stay frozen in `projection.ts:recomputeInvocation`, preserving selected quantities, completeness, and visible gaps while reclaiming observation capacity so long-running stores do not wedge at `store-full`. When capacity (`1,000,000` observations) is saturated by *within-horizon* observations, ingest still refuses explicitly with `store-full` and counts an `ingest-failed` gap.
- **Immutable disagreement history**: once an open contribution is marked `conflicting`, pruning an expired non-selected conflicting observation does not silently downgrade `completeness` back to `known` upon later reevaluation; only an explicit correction (`applyCorrection`) or a strictly higher-ranked known provenance (`provider-reported` over `derived`, etc.) can supersede it.

## Limits

| Bound | Value |
|---|---|
| Retained observations | 1,000,000 (expired detail and post-horizon selected observations compact within 1% of the bound) |
| Retention horizon | 90 days (bounded by `MIN(event_utc, ingested_utc)`) |
| Distinct units per `(attempt_id, measure)` at ingest | 16 (excess refused as `invalid-observation` with `ingest-failed` gap) |
| Distinct units per `(row, measure)` in query responses | 32 (`unit ASC`; overflow surfaced via `AccountingRow.omittedUnitCount`) |
| Maximum future clock skew (`eventUtc - nowUtc`) | 24 hours (`86,400,000 ms`; `(5 min, 24 h]` flagged `clock_anomaly = 1`) |
| Rows per page | 200 |
| Response size | 1 MiB |
| Query deadline | 5 seconds |
| Roots per query (`rootIds`, added by `FR-R6-F11`) | 1 to 64 unique ids, each matching the identifier pattern; absent means every root. It narrows the rows only: the unattributed count, gaps and legacy summary stay store-wide |
| Grouping dimensions | at most 3 of `backend`, `model`, `workflowRevision`, `phaseId`, `attemptOutcome`, `utcDay` |

### Measured query latency and host blocking (`tests/perf/usage-accounting-query.test.ts`)

- **100,000-attempt regression budget (`NFR-003`, `SC-006`)**: at 100,000 retained attempts (400,000 open contributions), warm filtered 200-row reads measured `p50 36.89 ms`, `p95 128.80 ms`, `p99 129.99 ms`, `max 134.62 ms`, and `maxResponseBytes 125,068 B` (`<= 500 ms` p95 and `<= 1 MiB`, re-measured 2026-11-24 on Apple M4 Max / Node `v24.22.2`).
- **1,000,000-observation retention-bound remediation (`FR-R8-03` / `03-03`)**:
  - **Design evaluation**: live `EXPLAIN QUERY PLAN` on Schema v9 showed that covering indexes (`idx_accounting_attempts_backend_phase`, `idx_accounting_contributions_query_cover`, `idx_accounting_observations_disposition`) were already in use; the `334–460 ms` stall came from executing the `node:sqlite` C++ `DatabaseSync` scan synchronously on the extension-host event loop. Neither index tuning alone nor JS yielding between SQL statements can prevent a single multi-hundred-millisecond SQLite query from stalling the host or allow mid-statement cancellation.
  - **Implemented solution**: `src/services/usage-accounting/accounting-query-worker.ts` runs file-backed WAL reads (`queryAsync`) inside a reusable lazy-spawned read-only `node:worker_threads` worker (`readOnly: true`, verified `PRAGMA query_only = ON`, `foreign_keys = ON`, `trusted_schema = OFF`, `temp_store = MEMORY`, `busy_timeout = 5000`, bounded FIFO queue `MAX_PENDING_QUERIES = 64`, `10 s` unref'd idle shutdown, and real mid-read `AbortSignal` / deadline termination via `worker.terminate()` with transparent respawn). `accounting-query.ts` also skips the redundant occupancy `latest` window query when no occupancy measures (`context_used`, `context_size`) are present. All production async readers (sidebar IPC `cmd-read-usage-accounting.ts`, reporting `report-usage.ts` / `report-capture.ts` / `report-engine.ts`, and headless `queryUsageAccountingAsync`) use `queryAsync`; `:memory:` stores retain the synchronous fallback.
  - **Before vs. after comparison** (measured 2026-11-24 on `darwin-arm64`, Apple M4 Max, local APFS SSD, Node `v24.22.2`, `1,000,000` retained observations, `250,000` attempts, `1,000,000` open contributions, `500` phases, `2` backends, `4` models, filtered `200`-row pages, `5` warm-up + `30` measured):

| Metric (1,000,000 observations, 200-row page) | Before: Sync Host Thread (`service.query`) | After: Read-Only Worker (`service.queryAsync`, idle disk) | After: Read-Only Worker (concurrent async disk-fsync contention) |
|---|---:|---:|---:|
| Cold first page (incl. lazy worker spawn on After) | `334.54 ms` | `526.34 ms` | — |
| Warm end-to-end read (`p50` / `p95` / `max`) | `86.91` / `333.65` / `336.27 ms` | `130.88` / `522.46` / `524.41 ms` | `132.35` / `534.33` / `539.63 ms` |
| Worker queue wait (`p50` / `p95` / `max`) | — | `0.00` / `0.00` / `0.01 ms` | — |
| **Host event-loop blocking (`p50` / `p95` / `max`)** | **`87.01` / `333.88` / `336.66 ms`** | **`1.34` / `1.46` / `1.50 ms`** (`<= 50 ms` target) | **`1.33` / `1.60` / `1.83 ms`** (`<= 50 ms` target) |
| Host `monitorEventLoopDelay` (`p95` / `max`) | — | `1.28` / `3.80 ms` | — |
| Concurrent unrelated host ticks serviced during reads | `0` (blocked per query) | **`1,851` ticks** | — |
| Cancellation (`AbortSignal`) latency | `0.066 ms` (preflight only; cannot cancel mid-SQL) | **`6.75 ms`** (real mid-read worker terminate + clean respawn) | — |
| Largest response payload | `125,384 bytes` (`<= 1 MiB`) | `125,384 bytes` (`<= 1 MiB`) | `125,384 bytes` (`<= 1 MiB`) |

## Known limits

- **File-backed vs. `:memory:` query execution (`FR-R8-03` / `03-03`).** Production file-backed WAL stores serve `queryAsync` through the dedicated read-only worker thread (`<= 50 ms p95` host event-loop blocking, measured `1.46 ms p95` idle / `1.60 ms p95` under concurrent async `fsync` disk contention on Apple M4 Max, with single-snapshot `BEGIN DEFERRED` WAL reads and real mid-read `AbortSignal` / `5 s` deadline cancellation via worker termination). Synchronous `service.query()` and `:memory:` test stores still execute synchronously on the calling thread and check deadlines/aborts between statements only. Measurements cover local `darwin-arm64` APFS SSD only; slower spinning disks, network filesystems, Linux, and Windows remain unobserved.
- **A response's `cutoffIngestSeq` is a high-water mark.** It is the highest ingest sequence any
  projection reflected, not a promise that every earlier observation is reflected. One whose
  projection failed shows as a `projection-failed` gap until the next start applies it.
- **Within-horizon observation saturation still refuses `store-full`.** Post-horizon selected
  observations compact cleanly past 90 days, but if 1,000,000 observations accumulate *within* the
  90-day horizon, retention cannot reclaim them and new ingests are refused `store-full` with a
  counted `ingest-failed` gap until older observations cross the horizon.
- **A resumed legacy run.** Usage of a legacy run that resumes after the import is counted as
  new usage; its root outcome is refused `legacy-epoch-overlap` and counted as an
  `ingest-failed` gap.
- **Corrections are idempotent against the current correction only.** Resending an older
  correction after a newer one applies it again as a new revision.
- **A cost beyond the exact range** (about $9.2 trillion, 2^63−1 micro-units) in a phase-end row
  is refused as `invalid-counter` and counted, together with the rest of that observation.
