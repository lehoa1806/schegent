# Shared Memory and Storage Contracts (`FR-R6-F02`)

**Declared**: 2026-11-09 (`specs/301-shared-memory-storage-contracts/spec.md`)

This reference publishes the canonical logical contract (`SHARED_STORAGE_CONTRACT_VERSION = 1`) for Round 6 consumers (`F03`–`F08` and `F10`–`F15`), implemented in [`src/contracts/shared-memory-storage/`](../../src/contracts/shared-memory-storage/inventories.ts) (`inventories.ts`, `consumer-and-retention-inventories.ts`, `identity-and-observations.ts`, `monetary-and-clocks.ts`, and `artifacts-streams-and-acp.ts`, all re-exported by `src/contracts/index.ts`) and [`src/services/shared-memory-storage/shared-contract-entry-boundary.ts`](../../src/services/shared-memory-storage/shared-contract-entry-boundary.ts). For production workflow control-plane integration, see [`docs/operations/production-workflow-integration-matrix.md`](production-workflow-integration-matrix.md).

---

## 1. C1 Shared Field Dictionary and Current-Record Mappings (`FR-001`, `FR-003`, `SC-008`)

Every newly introduced identifier is validated at the boundary (`MAX_SHARED_IDENTIFIER_UTF8_BYTES = 256`). Valid existing identifiers longer than 256 UTF-8 bytes are preserved through a deterministic, collision-free opaque alias (`alias:<sha256-hex>`) without truncation or collision.

| Shared Field | Category | Limit / Bound | Owner | Named Consumers | Current-Record Mapping |
|---|---|---|---|---|---|
| `schemaVersion` | `schema-version` | Positive integer (`1`) | `F02` | `F01`, `F03`–`F15` | `CONTROL_LEDGER_VERSION`, `RECOVERY_ENVELOPE_VERSION`, `SCHEMA_VERSION` |
| `workspaceId` | `identity` | `<= 256` UTF-8 bytes | `F02` | `F01`, `F04`, `F05`, `F08`, `F10`, `F11` | Host-resolved workspace identity; never an untrusted UI path |
| `rootExecutionId` | `identity` | `<= 256` UTF-8 bytes | `F01` | `F02`–`F08`, `F10`–`F15` | `ConnectedWorkflowRun.runId`, `ControlRootRecord.ledgerRunId`, `TaskRecord.runId` |
| `queueId` | `identity` | `<= 256` UTF-8 bytes | `F01` | `F02`–`F04`, `F06`, `F08`, `F10`–`F12` | `QueueRegistryEntry.id`, `ConnectedWorkflowRun.queueId` |
| `invocationId` | `identity` | `<= 256` UTF-8 bytes | `F01` | `F02`, `F04`, `F06`–`F08`, `F11`, `F12`, `F15` | `ControlFrameRecord.frameId`, `RecoveryEnvelope.invocationId` (paired with `occurrenceNodePath` and `occurrenceIndex`) |
| `attemptId` | `identity` | `<= 256` UTF-8 bytes | `F01` | `F02`–`F15` | `ControlAttemptRecord.attemptId` (reused verbatim; retries allocate a new `attemptId`, redeliveries do not) |
| `providerSessionId` | `identity` | `<= 256` UTF-8 bytes | `F13` | `F02`, `F06`, `F08`, `F11` | Optional backend-owned conversation ID scoped by backend and opaque account alias |
| `acpSessionId` | `acp` | `<= 256` UTF-8 bytes | `F13` | `F02`, `F04`, `F06`–`F08`, `F14`, `F15` | ACP runtime session ID; distinct from `providerSessionId` |
| `observationId` | `identity` | `<= 256` UTF-8 bytes | `F06` | `F02`, `F04`, `F06`, `F11`, `F13`–`F15` | `attemptId:producerNamespace:producerObservationId` (or deterministic derivation) |
| `artifactId` | `artifact` | `<= 256` UTF-8 bytes | `F05` | `F02`, `F04`, `F07`, `F08`, `F11`, `F12`, `F15` | Opaque host-resolved artifact version ID (`RecoveryEnvelope.upstreamArtifactRefs`) |
| `handoffId` | `identity` | `<= 256` UTF-8 bytes | `F15` | `F02`, `F04`, `F08`, `F12`, `F13`, `F15` | Stable context-transfer revision ID |
| `acceptedSeq` | `timing` | Monotonic integer | `F04` | `F02`, `F05`–`F08`, `F11`, `F12`, `F14`, `F15` | Host-allocated commit sequence ordering accepted facts |
| `quality.provenance` | `quality` | `'observed' \| 'derived' \| 'estimated'` | `F02` | `F06`–`F08`, `F11`, `F12`, `F14` | Orthogonal provenance axis |
| `quality.completeness` | `quality` | `'known' \| 'partial' \| 'unknown' \| 'conflicting'` | `F02` | `F06`–`F08`, `F11`, `F12`, `F14`, `F15` | Orthogonal completeness axis (`CumulativeTotals.costUsdIsPartial`) |
| `streamCursor` | `stream-report` | `<= 256` UTF-8 bytes | `F07` | `F02`, `F03`, `F07`, `F11`, `F12` | Stream identity, generation, and sequence cursor |
| `sourceCutoff` | `stream-report` | `{ maxAcceptedSeq, snapshotRevision, capturedAtUtc }` | `F11` | `F02`, `F04`, `F08`, `F11`, `F12`, `F15` | Immutable cutoff governing stable paging and handoff manifests |
| `omissions` | `stream-report` | `<= 256` items; `<= 240` UTF-8 bytes per explanation | `F02` | `F05`, `F06`, `F08`, `F11`, `F12`, `F15` | Explicit omission entries (`capture-disabled`, `expired`, `unsupported`) |

---

## 2. C2 Single-Authority Inventory (`FR-002`, `SC-001`)

Every owned data class has **one** declared authority (`DATA_CLASS_AUTHORITY_INVENTORY`). Reports, transcripts, model summaries, telemetry spans, UI caches, and restored database backups are barred from authorizing `dispatch`, `completion`, `permit-release`, or `git-integration`.

| Data Class | Single Authority Owner | Authority Description | Derived Consumers | Execution Effect Authority |
|---|---|---|---|---|
| `current-execution-admission-permits` | `F01` | Host state machine and its fenced SQLite domain records | `F03`, `F04`, `F08`, `F09`, `F10`, `F12` | Yes |
| `window-queue-ownership` | `F01` | Authoritative workspace lock and queue execution lease records | `F04`, `F08`, `F10` | Yes |
| `accepted-usage-observations-adjustments` | `F06` | Normalized, versioned usage records attributed to an attempt | `F03`, `F11`, `F14` | No |
| `historical-execution-facts` | `F04` | Durable accepted transitions with source and coverage | `F08`, `F11`, `F12`, `F14`, `F15` | No |
| `audit-evidence` | `F02` | Existing append-only audit writer and independent integrity checks | `F05`, `F08`, `F11`, `F12` | No |
| `artifact-bytes` | `F05` | Immutable artifact version in governed file store | `F07`, `F08`, `F11`, `F12`, `F15` | No |
| `artifact-availability-references-pins` | `F05` | Host artifact index reconciled with the actual file | `F03`, `F07`, `F08`, `F11`, `F15` | No |
| `accepted-phase-context-input-selection` | `F15` | Versioned manifest and immutable target input envelope in SQLite | `F08`, `F13` | No |
| `review-findings-fix-claims` | `F15` | Versioned accepted observations in SQLite linked to report artifacts | `F01`, `F10`, `F12` | No |
| `catalog-definitions-version-pointers` | `F04` | Immutable SQLite version records and transactional pointer acceptance | `F01`, `F08`, `F11`, `F15` | No |
| `acp-interaction-metadata` | `F13` | Validated profile/connection/session/turn correlation and receipts | `F01`, `F06`, `F07`, `F08`, `F14`, `F15` | No |
| `ui-state-caches` | `F02` | Disposable projections with revision/cursor | `F06`, `F07`, `F11`, `F12` | No |
| `provider-conversation-history` | `F13` | Provider-owned backend store | `F08` | No |

---

## 3. All 15 Round 6 Feature Consumer Mappings (`FR-015`, `FR-018`, `SC-001`)

All fifteen Round 6 features (`ROUND6_FEATURE_CONSUMER_MAPPING`) share one physical store boundary (`F04-sqlite-domain-service`) and one canonical agent runtime boundary (`F13-acp-canonical-ingress`), excluding whole-map storage, CLI-first handoff, raw wire schemas as domain tables, and direct SQL access from agents or UI:

| Feature | Domain | Input Authorities | Output Authorities | Owned Limits |
|---|---|---|---|---|
| `F01` | Execution control & recovery | `current-execution-admission-permits`, `window-queue-ownership`, `catalog-definitions-version-pointers`, `review-findings-fix-claims` | `current-execution-admission-permits`, `window-queue-ownership` | `refusalMessageBytes = 240`, `maxForEachItems = 256` |
| `F02` | Shared memory & storage contracts | `audit-evidence`, `ui-state-caches` | `audit-evidence`, `ui-state-caches` | `sharedIdentifierUtf8Bytes = 256`, `operatorExplanationUtf8Bytes = 240`, `omissionsCollectionItems = 256` |
| `F03` | Runtime resource budgets | `current-execution-admission-permits`, `accepted-usage-observations-adjustments`, `artifact-availability-references-pins` | `current-execution-admission-permits` | `resourceCollectorWindow = 4,096 / 4 MiB`, `pendingAccountingProjectionWork = 2,048 / 8 MiB`, `outstandingAccountingIntents = 10,000 / 32 MiB` |
| `F04` | SQLite transactional store | `current-execution-admission-permits`, `window-queue-ownership`, `catalog-definitions-version-pointers` | `historical-execution-facts`, `catalog-definitions-version-pointers` | `writerAdmissionQueueRequests = 64`, `writerAdmissionQueueBytes = 16 MiB` |
| `F05` | Artifact lifecycle & retention | `audit-evidence`, `artifact-bytes`, `artifact-availability-references-pins` | `artifact-bytes`, `artifact-availability-references-pins` | `artifactDisplayNameBytes = 256`, `artifactPinsPerOwner = 64` |
| `F06` | Usage metrics & accounting | `acp-interaction-metadata`, `accepted-usage-observations-adjustments` | `accepted-usage-observations-adjustments`, `ui-state-caches` | `usageCorrectionsPerAttempt = 64`, `decimalMonetaryTextBytes = 64` |
| `F07` | Recoverable live logs | `acp-interaction-metadata`, `artifact-bytes`, `artifact-availability-references-pins` | `artifact-bytes`, `artifact-availability-references-pins`, `ui-state-caches` | `liveLogSegmentsPerStream = 256`, `liveLogSegmentBytes = 1 MiB` |
| `F08` | Durable handoff & resume | `current-execution-admission-permits`, `window-queue-ownership`, `historical-execution-facts`, `audit-evidence`, `artifact-bytes`, `artifact-availability-references-pins`, `accepted-phase-context-input-selection`, `catalog-definitions-version-pointers`, `acp-interaction-metadata`, `provider-conversation-history` | `current-execution-admission-permits`, `artifact-availability-references-pins` | `recoveryEnvelopeBytes = 16 KiB`, `recoveryRefsPerArray = 32` |
| `F09` | Backend containment qualification | `current-execution-admission-permits` | `current-execution-admission-permits` | `containmentDiagnosticBytes = 240` |
| `F10` | Isolated workspaces & Git integration | `current-execution-admission-permits`, `window-queue-ownership`, `review-findings-fix-claims` | `current-execution-admission-permits`, `historical-execution-facts` | `candidateSnapshotEntries = 256` |
| `F11` | Historical reporting & exports | `accepted-usage-observations-adjustments`, `historical-execution-facts`, `audit-evidence`, `artifact-bytes`, `artifact-availability-references-pins`, `catalog-definitions-version-pointers` | `artifact-bytes`, `artifact-availability-references-pins`, `ui-state-caches` | `reportPageSizeMax = 100`, `reportFilterKeysMax = 16` |
| `F12` | Change review & execution visibility | `current-execution-admission-permits`, `historical-execution-facts`, `audit-evidence`, `artifact-bytes`, `review-findings-fix-claims`, `ui-state-caches` | `ui-state-caches` | `reviewVisibilityFindingsPageMax = 100` |
| `F13` | ACP agent runtime | `accepted-phase-context-input-selection`, `acp-interaction-metadata`, `provider-conversation-history` | `acp-interaction-metadata`, `provider-conversation-history` | `acpReceiptReasonBytes = 240`, `acpActiveSessionsPerConnection = 16` |
| `F14` | Optional OpenTelemetry export | `accepted-usage-observations-adjustments`, `historical-execution-facts`, `acp-interaction-metadata` | None (downstream read-only export) | `telemetryExportBatchSpansMax = 256`, `telemetryDimensionSetMax = 64` |
| `F15` | Phase context handoff & review loops | `historical-execution-facts`, `artifact-bytes`, `artifact-availability-references-pins`, `catalog-definitions-version-pointers`, `acp-interaction-metadata` | `accepted-phase-context-input-selection`, `review-findings-fix-claims` | `handoffSourcesMax = 32`, `findingsPerReportMax = 256` |

---

## 4. C4 Retention Policy Inventory (`FR-008`, `FR-020`)

| Retention Class | Governing Policy | Age / Size Target | Legacy Upgrade Deletion | Reporting Horizon Disclosure |
|---|---|---|---|---|
| `new-terminal-execution-usage-detail` | `new-metadata-90d-or-256mib` | 90 days from terminal settlement or 256 MiB reclaim target (after activation) | Never (`false`) | Commit supported aggregate contribution and deletion watermark before reclaiming unpinned detail |
| `active-and-recovery-required-metadata` | `existing-admission-ledger-limits` | Bounded by admission/ledger caps; settlement reserve protected | Never (`false`) | Pinned recovery and handoff dependencies survive retention sweeps |
| `aggregate-history` | `explicit-reporting-horizon-aggregate` | Retained across workspace lifetime | Never (`false`) | Preserves cumulative totals and coverage; does not promise expired per-attempt cohorts |
| `transcripts-diagnostics-checkpoints-audit-catalog` | `existing-class-specific-policy` | Existing rotation and append-only audit rules | Never (`false`) | Unchanged until an explicitly reviewed class-specific policy change |
| `generated-reports-handoff-exports` | `independent-export-or-artifact-class` | Exported user copies independent; internal copies follow artifact class | Never (`false`) | Saving or exporting a report never creates an indefinite retention pin |
| `provider-owned-session-stores` | `external-provider-boundary` | Governed by external provider | Never (`false`) | Outside Schegent retention and deletion; disclosed in operator views |

---

## 5. Honest Disclosure of Unavailable Historical Attribution & Acceptance Matrix (`FR-012`, `FR-023`, `SC-013`)

- **Unavailable Legacy Attribution**: Pre-Round-6 task-lifecycle and phase-reconstruction records (`TaskRecord`, `PhaseRecord` in `src/contracts/sidebar-ipc/metrics.ts`) do not record `modelId`, `providerSessionId`, or per-attempt `invocationId` when derived solely from legacy task-level audit summaries. `mapCurrentRecordToSharedIdentity` and `readCompatibleRecord` preserve all available fields (`durationMs`, `costUsd`, `phaseType`, `iteration`) and explicitly populate `missingIdentityReasons` (`'not-recorded-in-legacy-schema'`) without inferring attribution from timestamps, node names, file paths, or model names.
- **Cross-Restart Unanchored Notifications**: ACP or runner notifications that lack a durable `producerObservationId` carry `replayQuality: 'unavailable'`. Across a host restart, redelivered unanchored notifications are marked `'unresolved-duplicate'` (`completeness: 'conflicting'`) rather than hashed by payload or silently counted twice.
- **Canonical Acceptance Fixtures (`F02-AC-01`–`F02-AC-10`)**: Published in `SHARED_CONTRACT_ACCEPTANCE_FIXTURES` (`src/services/shared-memory-storage/shared-contract-entry-boundary.ts`) and verified in `tests/unit/contracts/shared-memory-storage-contracts.test.ts` and `tests/integration/shared-memory-storage-contracts-acceptance.test.ts`.

