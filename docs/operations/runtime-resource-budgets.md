# Runtime Resource Budgets and Qualification (`FR-R6-F03`)

**Declared**: 2026-11-09 (`specs/302-runtime-resource-budgets/spec.md`)

This reference publishes the versioned runtime resource inventory (`RUNTIME_RESOURCE_INVENTORY_VERSION = 1`), the `FR-015` common queue and query bounds (`RUNTIME_RESOURCE_BUDGETS_CONTRACT_VERSION = 1`), the registered qualification targets (`BUDGET_REGISTRY_VERSION = 1`), the per-criterion cycle obligations, and the current-store/CLI migration baselines.

Implemented in:
- [`src/contracts/runtime-resource-budgets/common-bounds.ts`](../../src/contracts/runtime-resource-budgets/common-bounds.ts)
- [`src/contracts/runtime-resource-budgets/budget-targets.ts`](../../src/contracts/runtime-resource-budgets/budget-targets.ts)
- [`src/contracts/runtime-resource-budgets/qualification-record.ts`](../../src/contracts/runtime-resource-budgets/qualification-record.ts)
- [`src/services/runtime-resource-budgets/resource-inventory.ts`](../../src/services/runtime-resource-budgets/resource-inventory.ts)

For shared identity, authority, and retention contracts, see [`docs/operations/shared-memory-storage-contracts.md`](shared-memory-storage-contracts.md). For existing snapshot and stream measurements, see [`docs/operations/webview-snapshot-cost-measurement.md`](webview-snapshot-cost-measurement.md) and [`docs/operations/concurrent-run-resource-measurement.md`](concurrent-run-resource-measurement.md).

---

## 1. Runtime Resource Inventory (`FR-001`, `FR-012`, `SC-001`)

Every retained data class in the current and target runtime is registered in `RUNTIME_RESOURCE_INVENTORY` with its owner module, lifetime, units, authoritative limit (imported directly from its contract authority without competing constants), and overflow behavior:

| ID | Category | Owner | Lifetime | Units | Limit / Authority | Overflow Behavior |
|---|---|---|---|---|---|---|
| `control-ledger-live-roots` | `snapshot` | `src/services/workflow-execution/control-ledger-store.ts` | `persisted` | `items` | `MAX_LIVE_CONTROL_ROOTS` (`20`) | Evict oldest terminal root; refuse 21st active root before spawn |
| `control-ledger-root-serialized-bytes` | `snapshot` | `src/services/workflow-execution/control-ledger-store.ts` | `persisted` | `bytes` | `MAX_ROOT_LEDGER_BYTES` (`2,097,152`) | Refuse non-settlement writes above `2,080,768` B; preserve settlement reserve |
| `control-ledger-root-settlement-reserve` | `snapshot` | `src/services/workflow-execution/control-ledger-store.ts` | `persisted` | `bytes` | `ROOT_SETTLEMENT_RESERVE_BYTES` (`16,384`) | Reserved for settlement/terminal commits (`allowSettlementReserve: true`) |
| `control-ledger-frames-per-root` | `snapshot` | `src/services/workflow-execution/control-ledger-store.ts` | `persisted` | `items` | `MAX_FRAMES_PER_ROOT` (`1,024`) | Refuse mutation with `control-frame-limit-exceeded` |
| `control-ledger-quota-observations` | `snapshot` | `src/services/workflow-execution/control-ledger-store.ts` | `persisted` | `items` | `MAX_QUOTA_OBSERVATIONS` (`256`) | Sort by `observedAt` and keep newest 256 |
| `control-ledger-quota-waiters` | `queue` | `src/services/workflow-execution/control-ledger-store.ts` | `persisted` | `items` | `MAX_QUOTA_WAITERS` (`160`) | Evict oldest terminal waiters; refuse active waiter past 160 |
| `control-ledger-availability-checks` | `queue` | `src/services/workflow-execution/control-ledger-store.ts` | `persisted` | `items` | `MAX_ACTIVE_AVAILABILITY_CHECKS` (`3`) | Refuse additional concurrent availability checks |
| `control-ledger-command-receipts` | `snapshot` | `src/services/workflow-execution/control-command-service.ts` | `persisted` | `items` | `MAX_CONTROL_COMMAND_RECEIPTS_PER_ROOT` (`256`) | Drop oldest receipts and advance `receiptHighWaterGeneration` |
| `control-decision-summaries` | `snapshot` | `src/services/workflow-execution/control-notification-service.ts` | `persisted` | `items` | `MAX_DECISION_SUMMARIES_PER_ROOT` (`256`) | Drop oldest summaries and increment `archivedSummaryCount` |
| `control-settled-check-summaries` | `snapshot` | `src/services/workflow-execution/control-notification-service.ts` | `persisted` | `items` | `MAX_SETTLED_CHECK_SUMMARIES_PER_ROOT` (`64`) | Drop oldest settled check summaries |
| `control-pending-operator-notifications` | `queue` | `src/services/workflow-execution/control-notification-service.ts` | `persisted` | `items` | Protected state inside 2 MiB root | Unclaimed operator decisions preserved until claimed |
| `connected-run-command-receipts` | `snapshot` | `src/state/connected-workflow-run.ts` | `persisted` | `items` | `MAX_COMMAND_RECEIPTS` (`64`) | Keep newest 64 receipts per connected run |
| `queue-registry-live-queues` | `snapshot` | `src/queue/queue-registry.ts` | `persisted` | `items` | `MAX_QUEUES` (`20`) | Refuse creation of a 21st queue |
| `queue-pending-tasks` | `queue` | `src/state/workspace-state.ts` | `persisted` | `items` | `MAX_PENDING_TASKS_PER_QUEUE` (`100`) | Refuse enqueue past 100 pending tasks per queue |
| `queue-history-per-partition` | `snapshot` | `src/state/workspace-state.ts` | `persisted` | `items` | `HISTORY_CAP_PER_QUEUE` (`50`) | Drop oldest history entries per partition beyond 50 |
| `deleted-history-partitions` | `snapshot` | `src/state/workspace-state.ts` | `persisted` | `items` | `MAX_DELETED_HISTORY_PARTITIONS` (`20`) | Evict deleted partition with oldest `completedAt` |
| `workspace-retained-history-partitions` | `snapshot` | `src/contracts/snapshot-bounds.ts` | `persisted` | `items` | `MAX_RETAINED_HISTORY_PARTITIONS` (`40`) | 20 live + 20 deleted partitions ceiling |
| `workspace-retained-history-entries` | `snapshot` | `src/contracts/snapshot-bounds.ts` | `persisted` | `items` | `MAX_RETAINED_HISTORY_ENTRIES` (`2,000`) | 40 partitions x 50 entries ceiling |
| `run-quarantine-entries` | `snapshot` | `src/state/run-quarantine.ts` | `persisted` | `items` | `RUN_QUARANTINE_CAP` (`20`) | Keep newest 20 quarantined run entries |
| `runner-zipped-stream-buffer` | `buffer` | `src/runner/zipped-stream-buffer.ts` | `per-invocation` | `bytes` | `MAX_STREAM_BUFFER_BYTES` (`64 MiB`) | Gzip head half + rolling tail with `STREAM_TRUNCATION_MARKER` |
| `runner-stdout-line-framer-residual` | `parser-residual` | `src/lib/line-framer.ts` | `per-invocation` | `utf16-units` | `DEFAULT_MAX_LINE_UNITS` (`1,048,576`) | Truncate at 1 Mi UTF-16 units and discard until newline |
| `phase-log-tail-residual` | `parser-residual` | `src/services/phase-log/phase-log-tail-session.ts` | `per-view` | `bytes` | `LIVE_LOG_RESIDUAL_MAX_BYTES` (`256 KiB`) | Discard unterminated record bytes past 256 KiB until newline and post one `oversized-record` coverage gap |
| `phase-log-read-entries` | `query-result` | `src/services/phase-log/phase-log-reader.ts` | `per-call` | `items` | `PHASE_LOG_MAX_ENTRIES` (`500`) | Keep newest 499 entries + `truncated-head` marker |
| `bounded-file-tail-read` | `buffer` | `src/lib/bounded-read.ts` | `per-call` | `bytes` | `DEFAULT_MAX_READ_BYTES` (`8 MiB`) | Read trailing 8 MiB and report `skippedBytes` |
| `agy-projector-open-steps` | `buffer` | `src/services/phase-log/phase-log-display-projector.ts` | `per-view` | `items+bytes` | `MAX_OPEN_AGY_STEPS` (`16` / `256 KiB`) | Close oldest step when 17th opens; cap step text at 256 KiB |
| `webview-phase-log-live-window` | `snapshot` | `webview-ui/src/lib/phase-log-window.ts` | `per-view` | `items` | `PHASE_LOG_WINDOW_MAX_ENTRIES` (`499`) | Drop oldest entry and increment `truncated-head` count |
| `webview-routine-snapshot-budget` | `snapshot` | `src/ui/sidebar/snapshot-transport.ts` | `per-view` | `bytes` | `ROUTINE_SNAPSHOT_BYTE_BUDGET` (`512 KiB`) | Suppress unchanged slices on routine updates |
| `webview-full-resync-snapshot-ceiling` | `snapshot` | `src/ui/sidebar/snapshot-transport.ts` | `per-view` | `bytes` | `FULL_RESYNC_SNAPSHOT_BYTE_CEILING` (`1 MiB`) | Full resync ceiling on 2,000-entry `large-history` fixture |
| `webview-snapshot-delivery-slot` | `delivery-backlog` | `src/ui/sidebar/sidebar-view-provider.ts` | `per-view` | `items` | Protected single-slot state | Coalesce to latest snapshot; skip hidden views and resync on reveal |
| `snapshot-transport-baseline-clone` | `state-clone` | `src/ui/sidebar/snapshot-transport.ts` | `per-view` | `items` | Protected single-slot state | Replaced on each post and cleared on view dispose |
| `audit-tail-projection` | `snapshot` | `src/ui/sidebar/audit-tail-state.ts` | `per-activation` | `items` | `AUDIT_TAIL_MAX` (`50`) | Splice oldest audit entries beyond 50 |
| `recent-queues-projection` | `query-result` | `src/ui/sidebar/queue-projector.ts` | `per-call` | `items` | `RECENT_QUEUE_MAX` (`5`) | Slice to top 5 recent queues |
| `sidebar-display-lists` | `query-result` | `src/ui/sidebar/display-projection.ts` | `per-call` | `items` | `ENTRIES_PER_DISPLAY_LIST_MAX` (`100`) | Slice list to 100 entries and truncate text to 512 chars |
| `debug-log-tail-ring` | `diagnostic-collector` | `src/lib/webview-log-sink.ts` | `per-activation` | `items` | `DEBUG_LOG_TAIL_MAX` (`200`) | Ring buffer overwrites oldest entry past 200 |
| `mutation-ack-replay-cache` | `cache` | `src/ui/sidebar/mutation-command-executor.ts` | `per-view` | `items+bytes+age` | `ACK_RETENTION_MAX_ENTRIES` (`1,000` / `1 h`) | Prune expired entries then evict oldest past 1,000 |
| `builder-undo-history` | `state-clone` | `webview-ui/src/lib/builder-history-bound.ts` | `per-view` | `items+bytes` | `MAX_BUILDER_HISTORY_BYTES` (`50` / `256 KiB`) | Drop oldest undo states until `<= 50` entries and `<= 256 KiB` |
| `monitor-active-run-states` | `cache` | `src/monitor/claude-cli-monitor.ts` | `per-run` | `items` | Protected live-run state | 1:1 with live invocations; settled on completion |
| `monitor-settled-run-states` | `cache` | `src/monitor/claude-cli-monitor.ts` | `per-activation` | `items` | `MAX_SETTLED_STATES` (`32`) | Evict oldest settled run state past 32 |
| `monitor-unknown-run-reports` | `diagnostic-collector` | `src/monitor/claude-cli-monitor.ts` | `per-activation` | `items` | `MAX_UNKNOWN_RUN_REPORTS` (`32`) | Stop recording IDs past 32 while incrementing counter |
| `cli-transport-pending-writes` | `delivery-backlog` | `src/monitor/cli-transport-sink.ts` | `per-activation` | `bytes` | `MAX_PENDING_BYTES` (`16 MiB`) | Drop line, count `droppedBytes`, and warn-once |
| `cli-transport-key-block-redactors` | `cache` | `src/monitor/cli-transport-sink.ts` | `per-activation` | `items` | `CLI_TRANSPORT_MAX_TRACKED_STREAMS` (`256`) | Evict first non-open stream redactor, else oldest |
| `run-transport-files-on-disk` | `file-metadata` | `src/monitor/transport/run-transport-store.ts` | `persisted` | `bytes` | `TRANSPORT_WORKSPACE_MAX_BYTES` (`20 MiB`) | Compact 5 MiB files to half; remove oldest inactive files above 20 MiB |
| `telemetry-live-subprocess-series` | `cache` | `src/telemetry/telemetry-sampler.ts` | `per-invocation` | `items` | Protected live-PID state | 1 entry per live child PID; deleted on `stop(pid)` |
| `metrics-rollup-log-on-disk` | `file-metadata` | `src/metrics/metrics-rollup-writer.ts` | `persisted` | `items+bytes` | `TRIM_THRESHOLD_BYTES` (`8 MiB` / `5,000`) | Fold older records into carry-forward header and retain newest 5,000 |
| `runner-session-cost-ledger` | `cache` | `src/runner/session-cost-ledger.ts` | `per-activation` | `items` | `MAX_TRACKED_SESSIONS` (`64`) | Evict oldest-inserted session cost baseline past 64 |
| `runner-background-task-tracker` | `cache` | `src/runner/background-task-tracker.ts` | `per-invocation` | `items` | `MAX_OPEN_TASKS` (`256`) | Refuse additional open task IDs past 256 and mark `dropped = true` |
| `blocker-notice-ledger` | `cache` | `src/services/blocker-notice.ts` | `per-activation` | `items` | `BLOCKER_NOTICE_LEDGER_MAX` (`256`) | Evict oldest blocker notice entry past 256 |
| `backend-posture-ledger` | `cache` | `src/controller/backend-posture-recorder.ts` | `per-activation` | `items` | `POSTURE_LEDGER_MAX_PAIRS` (`512`) | Evict oldest backend posture pair past 512 |
| `audit-pointer-resolved-entries` | `query-result` | `src/services/history/audit-pointer-resolver.ts` | `per-call` | `items` | `MAX_RESOLVED_ENTRIES` (`500`) | Stop resolving at 500 entries and set `more-available` |
| `failure-records-on-disk` | `file-metadata` | `src/services/failure-record/failure-record-retention.ts` | `persisted` | `items+bytes` | `FAILURE_RECORD_RETAINED_MAX` (`200` / `32 KiB`) | Prune by age then remove oldest beyond 200 records |
| `run-checkpoints-on-disk` | `file-metadata` | `src/services/run-checkpoint-retention.ts` | `persisted` | `bytes` | `CHECKPOINT_MAX_TOTAL_BYTES` (`256 MiB`) | Remove oldest checkpoints above 256 MiB / 14 days |
| `catalog-versions-on-disk` | `file-metadata` | `src/catalog/catalog-retention.ts` | `persisted` | `items` | `CATALOG_RETENTION_BOUND` (`50`) | Prune oldest unreferenced catalog versions beyond 50 |
| `audit-log-segments-on-disk` | `file-metadata` | `src/audit/audit-log-writer.ts` | `persisted` | `bytes` | `AUDIT_ROTATION_DEFAULT_SIZE_BYTES` (`5 MiB`) | Rotate at 5 MiB and prune beyond 10 archives / 90 days |
| `recovery-envelope-capture` | `snapshot` | `src/contracts/recovery-envelope.ts` | `per-run` | `items+bytes` | `MAX_RECOVERY_ENVELOPE_BYTES` (`16 KiB`) | Truncate workspace entries past 100 and record `droppedEntries` |
| `backend-capability-probe-buffer` | `buffer` | `src/services/backend-capability-service.ts` | `per-call` | `bytes` | `BACKEND_PROBE_OUTPUT_CAP_BYTES` (`64 KiB`) | Stop appending probe output past 64 KiB |
| `f03-resource-collector-window` | `diagnostic-collector` | `src/services/runtime-resource-budgets/resource-collector.ts` | `per-run` | `items+bytes` | `resource-collector-window` (`4,096` / `4 MiB`) | Overwrite oldest samples after updating bounded aggregates |
| `f03-pending-usage-ingestion` | `queue` | `src/services/runtime-resource-budgets/common-bound-references.ts` | `per-activation` | `items+bytes` | `pending-usage-ingestion` (`4,096` / `16 MiB`) | Coalesce provisional counters or refuse with counted coverage gap |
| `f03-unattributed-usage-observations` | `queue` | `src/services/runtime-resource-budgets/common-bound-references.ts` | `per-activation` | `items+bytes+age` | `unattributed-usage-observations` (`1,024` / `4 MiB` / `24 h`) | Expire or quarantine with omission counts; never guess attribution |
| `f03-pending-accounting-projection-work` | `queue` | `src/services/runtime-resource-budgets/common-bound-references.ts` | `per-activation` | `items+bytes` | `pending-accounting-projection-work` (`2,048` / `8 MiB`) | Refuse duplicate in-memory work and refill from durable intents |
| `f03-outstanding-accounting-intents` | `queue` | `src/services/runtime-resource-budgets/common-bound-references.ts` | `persisted` | `items+bytes` | `outstanding-accounting-intents` (`10,000` / `32 MiB`) | Pause new optional accounting acceptance before bound; keep accepted facts |
| `f03-correction-history-per-attempt` | `snapshot` | `src/services/runtime-resource-budgets/common-bound-references.ts` | `persisted` | `items+bytes` | `correction-history-per-attempt` (`64` / `256 KiB`) | Refuse 65th correction before acceptance; keep last accepted |
| `f03-historical-query-concurrency` | `queue` | `src/services/runtime-resource-budgets/common-bound-references.ts` | `per-activation` | `items+bytes` | `historical-query-concurrency` (`2` exec / `8` wait / `1 MiB`) | Return busy/limited for excess; cancellation removes waiting request |
| `f03-historical-query-working-data` | `query-result` | `src/services/runtime-resource-budgets/common-bound-references.ts` | `per-call` | `bytes` | `historical-query-working-data` (`32 MiB`) | Stream/batch or return typed limit excluding shared store cache |
| `f03-live-report-leases` | `cache` | `src/services/runtime-resource-budgets/common-bound-references.ts` | `per-activation` | `items+bytes+age` | `live-report-leases` (`4` leases / `5 min`) | Expiry ends query with restart instruction; no automatic renewal |
| `finding-raw-transcript-failed-runs-set` | `diagnostic-collector` | `src/audit/raw-transcript-writer.ts` | `per-activation` | `items` | Unbounded finding (remediation in `F05`) | Bound `failedRuns` with a 256-entry LRU ring in `F05` |
| `finding-terminal-transition-lost-noticed-set` | `diagnostic-collector` | `src/services/terminal-transition-coordinator.ts` | `per-activation` | `items` | Unbounded finding (remediation in `F08`) | Cap `lostNoticed` at 256 run IDs with FIFO eviction in `F08` |
| `finding-admission-consumed-token-sets` | `cache` | `src/services/workflow-execution/control-attempt-admission.ts` | `per-activation` | `items` | Unbounded finding (remediation in `F04`) | Prune token sets when owning root settles or evicts in `F04` |
| `finding-verbose-diagnostic-dir-sets` | `cache` | `src/audit/verbose-diagnostic-writer.ts` | `per-activation` | `items` | Unbounded finding (remediation in `F05`) | Evict per-iteration directory entries on run completion in `F05` |
| `finding-runner-diagnostic-write-promises` | `delivery-backlog` | `src/runner/claude-cli.ts` | `per-invocation` | `items` | Unbounded finding (remediation in `F07`/`F13`) | Drain settled promises incrementally via bounded concurrency queue |
| `finding-persisted-connected-runs-map` | `snapshot` | `src/state/workspace-state.ts` | `persisted` | `items` | Unbounded finding (remediation in `F04`) | Migrate `connectedRuns` into `F04` store with 90-day / 256-MiB retention |
| `finding-webview-intent-ledger-count` | `cache` | `webview-ui/src/lib/intent-ledger.ts` | `per-view` | `items+bytes+age` | Unbounded finding (time-bounded `1 h` only) | Add `ACK_RETENTION_MAX_ENTRIES` (`1,000`) count cap alongside 1-hour expiry |
| `finding-metrics-scan-corpus-cache` | `cache` | `src/metrics/metrics-service.ts` | `per-process` | `items` | Unbounded finding (remediation in `F04`/`F06`) | Replace whole-corpus maps with `F04`/`F06` bounded SQLite rollup projections |
| `target-sqlite-page-and-read-caches` | `cache` | `src/services/workflow-execution/control-ledger-store.ts` | `per-process` | `bytes` | Target (`F04`) | Evict clean pages per `cache_size` pragma inside 512 MiB host budget |
| `target-sqlite-wal-and-checkpoint-work` | `file-metadata` | `src/services/workflow-execution/control-ledger-store.ts` | `persisted` | `bytes` | Target (`F04`: `64` req / `16 MiB` queue) | Passive/restart checkpointing and writer admission refusal |
| `target-acp-decoding-and-request-queues` | `queue` | `src/runner/claude-cli.ts` | `per-invocation` | `items+bytes` | Target (`F13`) | Refuse excess requests or truncate display frames without starving control |
| `target-acp-bridge-process-overhead` | `buffer` | `src/telemetry/telemetry-sampler.ts` | `per-invocation` | `bytes` | Target (`F13` / `F14`) | Reported separately under `backend-process-memory`; never folded into host RSS |
| `target-phase-context-materialization` | `buffer` | `src/services/workflow-execution/control-attempt-admission.ts` | `per-invocation` | `items+bytes` | Target (`F15`) | Bound context preparation inside the 512 MiB aggregate normal envelope |

---

## 2. Common Queue and Query Bounds (`FR-015`, `SC-008`)

For queues not already bounded by an existing contract, `F03` owns the defaults in `COMMON_QUEUE_BOUNDS`. The first reached count, byte, or age limit applies:

| Bound ID | Owner | Count / Concurrency Limit | Byte Limit | Age / Lifetime Limit | Overflow Policy | Cycle Enforcement |
|---|---|---|---|---|---|---|
| `resource-collector-window` | `F03` | `4,096` samples | `4 MiB` | — | Overwrite oldest after updating bounded aggregates | `ResourceCollector` |
| `pending-usage-ingestion` | `F06` | `4,096` observations | `16 MiB` | — | Coalesce provisional counters or refuse with coverage gap | Conformance fixture |
| `unattributed-usage-observations` | `F06` | `1,024` observations | `4 MiB` | `24 hours` | Expire or quarantine with omission counts; never guess | Conformance fixture |
| `pending-accounting-projection-work` | `F06` | `2,048` references | `8 MiB` | — | Refuse duplicate in-memory work; refill from durable intents | Conformance fixture |
| `outstanding-accounting-intents` | `F06` | `10,000` intents | `32 MiB` | — | Pause new optional acceptance before bound; keep accepted | Conformance fixture |
| `correction-history-per-attempt` | `F06` | `64` corrections | `256 KiB` | Retained horizon | Refuse before acceptance; keep last accepted contribution | Conformance fixture |
| `historical-query-concurrency` | `F11` | `2` executing / `8` waiting | `1 MiB` params | — | Return busy/limited; cancellation removes waiting request | Conformance fixture |
| `historical-query-working-data` | `F11` | — | `32 MiB` | — | Stream/batch or return typed limit (excludes store cache) | Conformance fixture |
| `live-report-leases` | `F11` | `4` leases | — | `5 minutes` fixed | Expire with restart instruction; no automatic renewal | Conformance fixture |

---

## 3. Registered Qualification Targets & Cycle Obligations (`FR-016`, `SC-001`–`SC-012`)

Changing any registered target in `REGISTERED_BUDGET_TARGETS` requires a documented product trade-off and a fresh baseline (`FR-016`).

| Criterion / Target | Registered Threshold | Cycle Obligation |
|---|---|---|
| `SC-001` | 100% of in-scope queues in inventory with 5 attributes; 0 competing constants; 0 unbounded diagnostic collectors | `enforced-by-test` |
| `SC-002` | `>= 200` steady-state samples after `20` warm-up samples in `3` isolated runs (raw count, p50, p95, p99, max) | `migration-baseline` |
| `SC-003` | Mixed normal workload event-loop delay `p95 <= 20 ms` and `p99 <= 100 ms` on reference host | `pending-joint-qualification` |
| `SC-004` (`SC-004a`, `SC-004b`) | Routine mutation acknowledgement `p95 <= 100 ms` at `20 x 64 KiB` roots; `p95 <= 500 ms` at near-limit `2 MiB` roots; CPU vs persistence wait | `migration-baseline` |
| `SC-005` | Representative `large-history` (`2,000` entries) routine snapshot `<= 512 KiB` and full resync `<= 1 MiB` | `enforced-by-test` |
| `SC-006` | Three 60-minute mixed normal soaks show `<= 10%` owned retained byte growth between minutes 20 and 60 | `pending-joint-qualification` |
| `SC-007` | Mixed normal workload owned retained application data `<= 512 MiB` across in-scope host consumers | `pending-joint-qualification` |
| `SC-008` | 100% of limit-plus-one cases in control-ledger matrix and `FR-015` refuse/degrade; settlement reserve preserved | `enforced-by-test` |
| `SC-009` | Combined stress workload completes 100% of cancellations and durable acceptances with zero optional-consumer outcome drift | `pending-joint-qualification` |
| `SC-010` | Exported qualification records contain zero prompts, code, transcripts, or absolute paths; 100% of failed budgets carry remediation | `enforced-by-test` |
| `SC-011` | Zero metrics without a supported probe or with a refused permission are recorded as zero | `enforced-by-test` |
| `SC-012` | Every `FR-001`–`FR-023` and `SC-001`–`SC-012` maps to `F03-AC-01`–`F03-AC-06` with a reviewable fixture | `enforced-by-test` |
| `FR-023` | Installed editor host qualification run | `pending-joint-qualification` |

---

## 4. Unbounded Findings and Scoped Remediations (`FR-014`, `US4`)

- **Remediated in this cycle (`phase-log-tail-residual`)**: `PhaseLogTailSession` (`src/services/phase-log/phase-log-tail-session.ts`) previously accumulated its `partial` trailing buffer across ticks without a cap when a log file emitted bytes without a newline. It now enforces `DEFAULT_MAX_LINE_UNITS` (`1,048,576` UTF-16 units), discards excess units until the next newline, increments `droppedResidualUnits`, and pushes a single `system` (`systemSubtype: 'display-omission'`) entry per overflowed record while leaving the authoritative log file on disk untouched. FR-R6-F07 replaced that string residual with a byte framer bounded by `LIVE_LOG_RESIDUAL_MAX_BYTES` (`262,144` bytes); an overflowed record now posts one `oversized-record` coverage gap and is counted once in `omittedRecords` and `omittedBytes`.
- **Recorded with scoped remediation for owning Round 6 features**: the eight `finding-*` entries in Section 1 document grow-only structures in current-architecture modules and assign their concrete remediations to `F04`, `F05`, `F06`, `F07`, `F08`, and `F13`.

---

## 5. Migration Baselines and Pending Joint Qualification (`FR-019`, `SC-002`, `SC-004`)

Current-store (`ControlLedgerStore` over in-memory `Memento`) and CLI/stream measurements are recorded by `tests/perf/runtime-resource-baselines.test.ts` as **migration baselines** (`baselineLabel: 'migration-baseline'`, `targetArchitectureQualified: false`). They do not qualify the target `F04` SQLite + `F13` ACP architecture.

- **Environment**: `darwin` `27.0.0` / `arm64`, Node `v24.21.0`, `32 GiB` (`34,359,738,368` B) RAM, standalone Node runtime (`runtime: 'standalone-node'`), local filesystem, warm cache (`f335b498`).
- **Routine mutation acknowledgement (`SC-004a`, 20 roots of ~64 KiB, 3 runs x 220 samples with 20 warm-up)**:
  - `sc004a-run-1`: wall `p50 = 2.45 ms`, `p95 = 3.17 ms`, `p99 = 4.96 ms`, `max = 6.07 ms` (CPU `p95 = 2.93 ms`; persistence wait `p95 = 1.27 ms`).
  - `sc004a-run-2`: wall `p50 = 2.40 ms`, `p95 = 2.97 ms`, `p99 = 5.11 ms`, `max = 5.82 ms` (CPU `p95 = 3.01 ms`; persistence wait `p95 = 1.25 ms`).
  - `sc004a-run-3`: wall `p50 = 2.34 ms`, `p95 = 2.69 ms`, `p99 = 5.04 ms`, `max = 6.02 ms` (CPU `p95 = 2.66 ms`; persistence wait `p95 = 1.17 ms`).
  - Result: `p95 max = 3.17 ms <= 100 ms` (`migration-baseline-recorded`).
- **Near-limit root mutation acknowledgement (`SC-004b`, 1 root at `2,070,866` B near the `2,080,768` B admission ceiling, 3 runs x 220 samples with 20 warm-up)**:
  - `sc004b-run-1`: wall `p50 = 5.78 ms`, `p95 = 10.19 ms`, `p99 = 18.13 ms`, `max = 62.89 ms` (CPU `p95 = 9.38 ms`).
  - `sc004b-run-2`: wall `p50 = 5.76 ms`, `p95 = 9.52 ms`, `p99 = 13.96 ms`, `max = 47.64 ms` (CPU `p95 = 9.65 ms`).
  - `sc004b-run-3`: wall `p50 = 5.77 ms`, `p95 = 8.97 ms`, `p99 = 10.81 ms`, `max = 37.29 ms` (CPU `p95 = 9.45 ms`).
  - Result: `p95 max = 10.19 ms <= 500 ms` (`migration-baseline-recorded`), with `2,070,866 B` serialized bytes rewritten per commit.
- **Stream containment matrix (`FR-006`, concurrency 1, 2, 4, 8, 20 across ordinary text, incompressible bytes, 2 MiB giant lines, and no-newline output)**:
  - Production-cap (`64 MiB`) and reduced-cap (`1 MiB`) overflow arms stay within their declared byte and line-unit ceilings across all 20 cells, emit `STREAM_TRUNCATION_MARKER` when total input exceeds `maxBytes`, and keep `setImmediate` control-probe lateness bounded.
- **Snapshot gate reproduction (`SC-005`)**:
  - Verified by `tests/perf/webview-snapshot-cost.test.ts#large-history`: routine update `17,207 B <= 524,288 B` (`512 KiB`) and full resync `780,706 B <= 1,048,576 B` (`1 MiB`).
- **Pending joint qualification (`SC-003`, `SC-006`, `SC-007`, `SC-009`, `FR-023`)**:
  - Recorded as `pending-joint-qualification` in the exported qualification record until `F04`, `F07`, `F11`, and `F13` land and the combined workload runs in the installed editor host.
