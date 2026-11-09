/**
 * FR-R6-F03 — Versioned runtime resource inventory of caches, queues, parser residuals,
 * buffers, snapshots, state clones, query results, delivery backlogs, retained file
 * metadata, and diagnostic collectors (FR-001, FR-012, SC-001).
 *
 * Existing contract authorities are imported directly rather than copied (FR-012).
 *
 * Zero `vscode` imports.
 */

import {
  ACK_RETENTION_MAX_ENTRIES,
  ACK_RETENTION_MS
} from '../../contracts/ack-retention';
import { RUN_QUARANTINE_CAP } from '../../contracts/audit-events';
import { CATALOG_RETENTION_BOUND } from '../../contracts/catalog-store';
import {
  MAX_ACTIVE_AVAILABILITY_CHECKS,
  MAX_CONTROL_COMMAND_RECEIPTS_PER_ROOT,
  MAX_FRAMES_PER_ROOT,
  MAX_LIVE_CONTROL_ROOTS,
  MAX_QUOTA_OBSERVATIONS,
  MAX_QUOTA_WAITERS,
  MAX_ROOT_LEDGER_BYTES,
  ROOT_SETTLEMENT_RESERVE_BYTES
} from '../../contracts/control-ledger';
import {
  FAILURE_RECORD_MAX_BYTES,
  FAILURE_RECORD_RETAINED_MAX
} from '../../contracts/failure-record';
import { PHASE_LOG_MAX_ENTRIES } from '../../contracts/phase-log-bounds';
import { MAX_QUEUES } from '../../contracts/queue-bounds';
import {
  MAX_CAPTURE_TOTAL_BYTES,
  MAX_RECOVERY_ENVELOPE_BYTES,
  MAX_RECOVERY_WORKSPACE_ENTRIES
} from '../../contracts/recovery-envelope';
import {
  COMMON_BOUND_IDS,
  type CommonBoundId
} from '../../contracts/runtime-resource-budgets/common-bounds';
import {
  FULL_RESYNC_SNAPSHOT_BYTE_CEILING,
  MAX_RETAINED_HISTORY_ENTRIES,
  MAX_RETAINED_HISTORY_PARTITIONS,
  ROUTINE_SNAPSHOT_BYTE_BUDGET
} from '../../contracts/snapshot-bounds';
import {
  TRANSPORT_FILE_MAX_BYTES,
  TRANSPORT_WORKSPACE_MAX_BYTES
} from '../../contracts/transport-bounds';
import {
  AUDIT_ARCHIVE_DEFAULT_MAX_COUNT,
  AUDIT_ROTATION_DEFAULT_SIZE_BYTES
} from '../../audit/audit-log-writer';
import { POSTURE_LEDGER_MAX_PAIRS } from '../../controller/backend-posture-recorder';
import { DEFAULT_MAX_READ_BYTES } from '../../lib/bounded-read';
import { DEFAULT_MAX_LINE_UNITS } from '../../lib/line-framer';
import { DEBUG_LOG_TAIL_MAX } from '../../lib/webview-log-sink';
import {
  RETAINED_RECORDS_AFTER_TRIM,
  TRIM_THRESHOLD_BYTES
} from '../../metrics/metrics-rollup-writer';
import { MAX_PENDING_TASKS_PER_QUEUE } from '../../queue/feature-request';
import { MAX_OPEN_TASKS } from '../../runner/background-task-tracker';
import { MAX_TRACKED_SESSIONS } from '../../runner/session-cost-ledger';
import { MAX_STREAM_BUFFER_BYTES } from '../../runner/zipped-stream-buffer';
import { BACKEND_PROBE_OUTPUT_CAP_BYTES } from '../backend-capability-service';
import { BLOCKER_NOTICE_LEDGER_MAX } from '../blocker-notice';
import { MAX_RESOLVED_ENTRIES } from '../history/audit-pointer-resolver';
import { CHECKPOINT_MAX_TOTAL_BYTES } from '../run-checkpoint-retention';
import {
  MAX_DECISION_SUMMARIES_PER_ROOT,
  MAX_SETTLED_CHECK_SUMMARIES_PER_ROOT
} from '../workflow-execution/control-notification-service';
import { MAX_COMMAND_RECEIPTS } from '../../state/connected-workflow-run';
import {
  HISTORY_CAP_PER_QUEUE,
  MAX_DELETED_HISTORY_PARTITIONS
} from '../../state/workspace-state';
import type { ValidationResult } from '../../contracts/runtime-resource-budgets/qualification-record';

export const RUNTIME_RESOURCE_INVENTORY_VERSION = 1 as const;

export const INVENTORY_CATEGORIES = [
  'cache',
  'queue',
  'parser-residual',
  'buffer',
  'snapshot',
  'state-clone',
  'query-result',
  'delivery-backlog',
  'file-metadata',
  'diagnostic-collector'
] as const;

export type InventoryCategory = (typeof INVENTORY_CATEGORIES)[number];

export type InventoryLifetime =
  | 'per-call'
  | 'per-invocation'
  | 'per-run'
  | 'per-view'
  | 'per-activation'
  | 'per-process'
  | 'persisted';

export type InventoryUnits =
  | 'bytes'
  | 'items'
  | 'utf16-units'
  | 'ms'
  | 'items+bytes'
  | 'items+bytes+age';

export type LimitRef =
  | {
      readonly kind: 'authority';
      readonly module: string;
      readonly symbol: string;
      readonly value: number;
    }
  | {
      readonly kind: 'authority-private';
      readonly module: string;
      readonly symbol: string;
      readonly description: string;
    }
  | {
      readonly kind: 'f03-owned';
      readonly boundId: CommonBoundId;
    }
  | {
      readonly kind: 'owning-feature';
      readonly featureId: 'F04' | 'F05' | 'F07' | 'F11' | 'F13' | 'F14' | 'F15';
      readonly description: string;
    }
  | {
      readonly kind: 'protected-state';
      readonly reason: string;
    }
  | {
      readonly kind: 'unbounded-finding';
      readonly remediation: string;
      readonly scope: string;
    };

export interface InventoryEntry {
  readonly id: string;
  readonly category: InventoryCategory;
  readonly owner: string;
  readonly lifetime: InventoryLifetime;
  readonly units: InventoryUnits;
  readonly limit: LimitRef;
  readonly overflow: string;
  readonly architecture: 'current' | 'target';
  readonly consumers?: readonly string[];
}

export const AUTHORITATIVE_CONSTANT_VALUES: ReadonlyMap<string, number> = new Map<string, number>([
  ['src/contracts/control-ledger.ts#MAX_LIVE_CONTROL_ROOTS', MAX_LIVE_CONTROL_ROOTS],
  ['src/contracts/control-ledger.ts#MAX_ROOT_LEDGER_BYTES', MAX_ROOT_LEDGER_BYTES],
  ['src/contracts/control-ledger.ts#ROOT_SETTLEMENT_RESERVE_BYTES', ROOT_SETTLEMENT_RESERVE_BYTES],
  ['src/contracts/control-ledger.ts#MAX_FRAMES_PER_ROOT', MAX_FRAMES_PER_ROOT],
  ['src/contracts/control-ledger.ts#MAX_QUOTA_OBSERVATIONS', MAX_QUOTA_OBSERVATIONS],
  ['src/contracts/control-ledger.ts#MAX_QUOTA_WAITERS', MAX_QUOTA_WAITERS],
  ['src/contracts/control-ledger.ts#MAX_ACTIVE_AVAILABILITY_CHECKS', MAX_ACTIVE_AVAILABILITY_CHECKS],
  [
    'src/contracts/control-ledger.ts#MAX_CONTROL_COMMAND_RECEIPTS_PER_ROOT',
    MAX_CONTROL_COMMAND_RECEIPTS_PER_ROOT
  ],
  ['src/contracts/snapshot-bounds.ts#ROUTINE_SNAPSHOT_BYTE_BUDGET', ROUTINE_SNAPSHOT_BYTE_BUDGET],
  [
    'src/contracts/snapshot-bounds.ts#FULL_RESYNC_SNAPSHOT_BYTE_CEILING',
    FULL_RESYNC_SNAPSHOT_BYTE_CEILING
  ],
  [
    'src/contracts/snapshot-bounds.ts#MAX_RETAINED_HISTORY_PARTITIONS',
    MAX_RETAINED_HISTORY_PARTITIONS
  ],
  ['src/contracts/snapshot-bounds.ts#MAX_RETAINED_HISTORY_ENTRIES', MAX_RETAINED_HISTORY_ENTRIES],
  ['src/contracts/queue-bounds.ts#MAX_QUEUES', MAX_QUEUES],
  ['src/contracts/phase-log-bounds.ts#PHASE_LOG_MAX_ENTRIES', PHASE_LOG_MAX_ENTRIES],
  ['src/contracts/ack-retention.ts#ACK_RETENTION_MAX_ENTRIES', ACK_RETENTION_MAX_ENTRIES],
  ['src/contracts/ack-retention.ts#ACK_RETENTION_MS', ACK_RETENTION_MS],
  ['src/contracts/transport-bounds.ts#TRANSPORT_FILE_MAX_BYTES', TRANSPORT_FILE_MAX_BYTES],
  [
    'src/contracts/transport-bounds.ts#TRANSPORT_WORKSPACE_MAX_BYTES',
    TRANSPORT_WORKSPACE_MAX_BYTES
  ],
  ['src/contracts/recovery-envelope.ts#MAX_RECOVERY_ENVELOPE_BYTES', MAX_RECOVERY_ENVELOPE_BYTES],
  [
    'src/contracts/recovery-envelope.ts#MAX_RECOVERY_WORKSPACE_ENTRIES',
    MAX_RECOVERY_WORKSPACE_ENTRIES
  ],
  ['src/contracts/recovery-envelope.ts#MAX_CAPTURE_TOTAL_BYTES', MAX_CAPTURE_TOTAL_BYTES],
  ['src/contracts/failure-record.ts#FAILURE_RECORD_RETAINED_MAX', FAILURE_RECORD_RETAINED_MAX],
  ['src/contracts/failure-record.ts#FAILURE_RECORD_MAX_BYTES', FAILURE_RECORD_MAX_BYTES],
  ['src/contracts/catalog-store.ts#CATALOG_RETENTION_BOUND', CATALOG_RETENTION_BOUND],
  ['src/contracts/audit-events.ts#RUN_QUARANTINE_CAP', RUN_QUARANTINE_CAP],
  ['src/runner/zipped-stream-buffer.ts#MAX_STREAM_BUFFER_BYTES', MAX_STREAM_BUFFER_BYTES],
  ['src/lib/line-framer.ts#DEFAULT_MAX_LINE_UNITS', DEFAULT_MAX_LINE_UNITS],
  ['src/lib/bounded-read.ts#DEFAULT_MAX_READ_BYTES', DEFAULT_MAX_READ_BYTES],
  ['src/lib/webview-log-sink.ts#DEBUG_LOG_TAIL_MAX', DEBUG_LOG_TAIL_MAX],
  [
    'src/services/workflow-execution/control-notification-service.ts#MAX_DECISION_SUMMARIES_PER_ROOT',
    MAX_DECISION_SUMMARIES_PER_ROOT
  ],
  [
    'src/services/workflow-execution/control-notification-service.ts#MAX_SETTLED_CHECK_SUMMARIES_PER_ROOT',
    MAX_SETTLED_CHECK_SUMMARIES_PER_ROOT
  ],
  ['src/state/connected-workflow-run.ts#MAX_COMMAND_RECEIPTS', MAX_COMMAND_RECEIPTS],
  ['src/state/workspace-state.ts#HISTORY_CAP_PER_QUEUE', HISTORY_CAP_PER_QUEUE],
  [
    'src/state/workspace-state.ts#MAX_DELETED_HISTORY_PARTITIONS',
    MAX_DELETED_HISTORY_PARTITIONS
  ],
  ['src/queue/feature-request.ts#MAX_PENDING_TASKS_PER_QUEUE', MAX_PENDING_TASKS_PER_QUEUE],
  ['src/audit/audit-log-writer.ts#AUDIT_ROTATION_DEFAULT_SIZE_BYTES', AUDIT_ROTATION_DEFAULT_SIZE_BYTES],
  ['src/audit/audit-log-writer.ts#AUDIT_ARCHIVE_DEFAULT_MAX_COUNT', AUDIT_ARCHIVE_DEFAULT_MAX_COUNT],
  ['src/metrics/metrics-rollup-writer.ts#TRIM_THRESHOLD_BYTES', TRIM_THRESHOLD_BYTES],
  [
    'src/metrics/metrics-rollup-writer.ts#RETAINED_RECORDS_AFTER_TRIM',
    RETAINED_RECORDS_AFTER_TRIM
  ],
  ['src/runner/session-cost-ledger.ts#MAX_TRACKED_SESSIONS', MAX_TRACKED_SESSIONS],
  ['src/runner/background-task-tracker.ts#MAX_OPEN_TASKS', MAX_OPEN_TASKS],
  ['src/services/blocker-notice.ts#BLOCKER_NOTICE_LEDGER_MAX', BLOCKER_NOTICE_LEDGER_MAX],
  [
    'src/controller/backend-posture-recorder.ts#POSTURE_LEDGER_MAX_PAIRS',
    POSTURE_LEDGER_MAX_PAIRS
  ],
  [
    'src/services/run-checkpoint-retention.ts#CHECKPOINT_MAX_TOTAL_BYTES',
    CHECKPOINT_MAX_TOTAL_BYTES
  ],
  [
    'src/services/backend-capability-service.ts#BACKEND_PROBE_OUTPUT_CAP_BYTES',
    BACKEND_PROBE_OUTPUT_CAP_BYTES
  ],
  ['src/services/history/audit-pointer-resolver.ts#MAX_RESOLVED_ENTRIES', MAX_RESOLVED_ENTRIES]
]);

export const RUNTIME_RESOURCE_INVENTORY: readonly InventoryEntry[] = Object.freeze([
  // --- Current architecture: execution, control ledger, and queues ---
  {
    id: 'control-ledger-live-roots',
    category: 'snapshot', owner: 'src/services/workflow-execution/control-ledger-store.ts', lifetime: 'persisted', units: 'items',
    limit: { kind: 'authority', module: 'src/contracts/control-ledger.ts', symbol: 'MAX_LIVE_CONTROL_ROOTS', value: MAX_LIVE_CONTROL_ROOTS },
    overflow: 'Evict oldest terminal root; if all 20 roots are active, refuse with control-root-limit-exceeded before spawn.',
    architecture: 'current', consumers: ['F01', 'F03', 'F04']
  },
  {
    id: 'control-ledger-root-serialized-bytes',
    category: 'snapshot', owner: 'src/services/workflow-execution/control-ledger-store.ts', lifetime: 'persisted', units: 'bytes',
    limit: { kind: 'authority', module: 'src/contracts/control-ledger.ts', symbol: 'MAX_ROOT_LEDGER_BYTES', value: MAX_ROOT_LEDGER_BYTES },
    overflow: 'Non-settlement writes refuse above MAX_ROOT_LEDGER_BYTES - ROOT_SETTLEMENT_RESERVE_BYTES; settlement may use full 2 MiB.',
    architecture: 'current', consumers: ['F01', 'F03', 'F04']
  },
  {
    id: 'control-ledger-root-settlement-reserve',
    category: 'snapshot', owner: 'src/services/workflow-execution/control-ledger-store.ts', lifetime: 'persisted', units: 'bytes',
    limit: { kind: 'authority', module: 'src/contracts/control-ledger.ts', symbol: 'ROOT_SETTLEMENT_RESERVE_BYTES', value: ROOT_SETTLEMENT_RESERVE_BYTES },
    overflow: 'Reserved exclusively for terminal/settlement commits (allowSettlementReserve: true); never consumed by new attempt admission.',
    architecture: 'current', consumers: ['F01', 'F03', 'F04']
  },
  {
    id: 'control-ledger-frames-per-root',
    category: 'snapshot', owner: 'src/services/workflow-execution/control-ledger-store.ts', lifetime: 'persisted', units: 'items',
    limit: { kind: 'authority', module: 'src/contracts/control-ledger.ts', symbol: 'MAX_FRAMES_PER_ROOT', value: MAX_FRAMES_PER_ROOT },
    overflow: 'Refuse mutation with control-frame-limit-exceeded.',
    architecture: 'current', consumers: ['F01', 'F03']
  },
  {
    id: 'control-ledger-quota-observations',
    category: 'snapshot', owner: 'src/services/workflow-execution/control-ledger-store.ts', lifetime: 'persisted', units: 'items',
    limit: { kind: 'authority', module: 'src/contracts/control-ledger.ts', symbol: 'MAX_QUOTA_OBSERVATIONS', value: MAX_QUOTA_OBSERVATIONS },
    overflow: 'Sort by observedAt and keep newest 256 observations.',
    architecture: 'current', consumers: ['F03', 'F06']
  },
  {
    id: 'control-ledger-quota-waiters',
    category: 'queue', owner: 'src/services/workflow-execution/control-ledger-store.ts', lifetime: 'persisted', units: 'items',
    limit: { kind: 'authority', module: 'src/contracts/control-ledger.ts', symbol: 'MAX_QUOTA_WAITERS', value: MAX_QUOTA_WAITERS },
    overflow: 'Evict oldest terminal waiters; if active waiters exceed 160, refuse with control-waiter-limit-exceeded.',
    architecture: 'current', consumers: ['F01', 'F03']
  },
  {
    id: 'control-ledger-availability-checks',
    category: 'queue', owner: 'src/services/workflow-execution/control-ledger-store.ts', lifetime: 'persisted', units: 'items',
    limit: { kind: 'authority', module: 'src/contracts/control-ledger.ts', symbol: 'MAX_ACTIVE_AVAILABILITY_CHECKS', value: MAX_ACTIVE_AVAILABILITY_CHECKS },
    overflow: 'Refuse additional concurrent availability checks.',
    architecture: 'current', consumers: ['F01', 'F03']
  },
  {
    id: 'control-ledger-command-receipts',
    category: 'snapshot', owner: 'src/services/workflow-execution/control-command-service.ts', lifetime: 'persisted', units: 'items',
    limit: { kind: 'authority', module: 'src/contracts/control-ledger.ts', symbol: 'MAX_CONTROL_COMMAND_RECEIPTS_PER_ROOT', value: MAX_CONTROL_COMMAND_RECEIPTS_PER_ROOT },
    overflow: 'Drop oldest command receipts and advance receiptHighWaterGeneration.',
    architecture: 'current', consumers: ['F01', 'F03']
  },
  {
    id: 'control-decision-summaries',
    category: 'snapshot', owner: 'src/services/workflow-execution/control-notification-service.ts', lifetime: 'persisted', units: 'items',
    limit: { kind: 'authority', module: 'src/services/workflow-execution/control-notification-service.ts', symbol: 'MAX_DECISION_SUMMARIES_PER_ROOT', value: MAX_DECISION_SUMMARIES_PER_ROOT },
    overflow: 'Drop oldest decision summaries and record archivedSummaryCount.',
    architecture: 'current', consumers: ['F01', 'F03']
  },
  {
    id: 'control-settled-check-summaries',
    category: 'snapshot', owner: 'src/services/workflow-execution/control-notification-service.ts', lifetime: 'persisted', units: 'items',
    limit: { kind: 'authority', module: 'src/services/workflow-execution/control-notification-service.ts', symbol: 'MAX_SETTLED_CHECK_SUMMARIES_PER_ROOT', value: MAX_SETTLED_CHECK_SUMMARIES_PER_ROOT },
    overflow: 'Drop oldest settled availability check summaries.',
    architecture: 'current', consumers: ['F01', 'F03']
  },
  {
    id: 'control-pending-operator-notifications',
    category: 'queue', owner: 'src/services/workflow-execution/control-notification-service.ts', lifetime: 'persisted', units: 'items',
    limit: { kind: 'protected-state', reason: 'Unclaimed operator notifications represent pending human/controller decisions inside a bounded 2 MiB root and must not be silently dropped.' },
    overflow: 'Protected within the per-root 2 MiB serialized ceiling; trimmed only after claim.',
    architecture: 'current', consumers: ['F01', 'F03']
  },
  {
    id: 'connected-run-command-receipts',
    category: 'snapshot', owner: 'src/state/connected-workflow-run.ts', lifetime: 'persisted', units: 'items',
    limit: { kind: 'authority', module: 'src/state/connected-workflow-run.ts', symbol: 'MAX_COMMAND_RECEIPTS', value: MAX_COMMAND_RECEIPTS },
    overflow: 'Retain newest 64 receipts per connected workflow run.',
    architecture: 'current', consumers: ['F01', 'F03']
  },
  {
    id: 'queue-registry-live-queues',
    category: 'snapshot', owner: 'src/queue/queue-registry.ts', lifetime: 'persisted', units: 'items',
    limit: { kind: 'authority', module: 'src/contracts/queue-bounds.ts', symbol: 'MAX_QUEUES', value: MAX_QUEUES },
    overflow: 'Refuse creation of a 21st queue.',
    architecture: 'current', consumers: ['F01', 'F03']
  },
  {
    id: 'queue-pending-tasks',
    category: 'queue', owner: 'src/state/workspace-state.ts', lifetime: 'persisted', units: 'items',
    limit: { kind: 'authority', module: 'src/queue/feature-request.ts', symbol: 'MAX_PENDING_TASKS_PER_QUEUE', value: MAX_PENDING_TASKS_PER_QUEUE },
    overflow: 'Refuse enqueue when a queue already holds 100 pending tasks.',
    architecture: 'current', consumers: ['F01', 'F03']
  },
  {
    id: 'queue-history-per-partition',
    category: 'snapshot', owner: 'src/state/workspace-state.ts', lifetime: 'persisted', units: 'items',
    limit: { kind: 'authority', module: 'src/state/workspace-state.ts', symbol: 'HISTORY_CAP_PER_QUEUE', value: HISTORY_CAP_PER_QUEUE },
    overflow: 'Drop oldest history entries per partition beyond 50.',
    architecture: 'current', consumers: ['F03', 'F11']
  },
  {
    id: 'deleted-history-partitions',
    category: 'snapshot', owner: 'src/state/workspace-state.ts', lifetime: 'persisted', units: 'items',
    limit: { kind: 'authority', module: 'src/state/workspace-state.ts', symbol: 'MAX_DELETED_HISTORY_PARTITIONS', value: MAX_DELETED_HISTORY_PARTITIONS },
    overflow: 'Evict deleted-queue history partition with oldest completedAt.',
    architecture: 'current', consumers: ['F03', 'F11']
  },
  {
    id: 'workspace-retained-history-partitions',
    category: 'snapshot', owner: 'src/contracts/snapshot-bounds.ts', lifetime: 'persisted', units: 'items',
    limit: { kind: 'authority', module: 'src/contracts/snapshot-bounds.ts', symbol: 'MAX_RETAINED_HISTORY_PARTITIONS', value: MAX_RETAINED_HISTORY_PARTITIONS },
    overflow: '20 live + 20 deleted partitions ceiling.',
    architecture: 'current', consumers: ['F03', 'F11']
  },
  {
    id: 'workspace-retained-history-entries',
    category: 'snapshot', owner: 'src/contracts/snapshot-bounds.ts', lifetime: 'persisted', units: 'items',
    limit: { kind: 'authority', module: 'src/contracts/snapshot-bounds.ts', symbol: 'MAX_RETAINED_HISTORY_ENTRIES', value: MAX_RETAINED_HISTORY_ENTRIES },
    overflow: '40 partitions x 50 entries = 2,000 total retained history entries.',
    architecture: 'current', consumers: ['F03', 'F11']
  },
  {
    id: 'run-quarantine-entries',
    category: 'snapshot', owner: 'src/state/run-quarantine.ts', lifetime: 'persisted', units: 'items',
    limit: { kind: 'authority', module: 'src/contracts/audit-events.ts', symbol: 'RUN_QUARANTINE_CAP', value: RUN_QUARANTINE_CAP },
    overflow: 'Slice to keep newest 20 quarantined run entries.',
    architecture: 'current', consumers: ['F01', 'F03']
  },

  // --- Current architecture: streams, parsers, and logs ---
  {
    id: 'runner-zipped-stream-buffer',
    category: 'buffer', owner: 'src/runner/zipped-stream-buffer.ts', lifetime: 'per-invocation', units: 'bytes',
    limit: { kind: 'authority', module: 'src/runner/zipped-stream-buffer.ts', symbol: 'MAX_STREAM_BUFFER_BYTES', value: MAX_STREAM_BUFFER_BYTES },
    overflow: 'Gzip-compress head half and evict middle chunks from rolling tail with STREAM_TRUNCATION_MARKER.',
    architecture: 'current', consumers: ['F03', 'F07']
  },
  {
    id: 'runner-stdout-line-framer-residual',
    category: 'parser-residual', owner: 'src/lib/line-framer.ts', lifetime: 'per-invocation', units: 'utf16-units',
    limit: { kind: 'authority', module: 'src/lib/line-framer.ts', symbol: 'DEFAULT_MAX_LINE_UNITS', value: DEFAULT_MAX_LINE_UNITS },
    overflow: 'Truncate line at 1,048,576 UTF-16 units and discard remaining units until newline.',
    architecture: 'current', consumers: ['F03', 'F07', 'F13']
  },
  {
    id: 'phase-log-tail-residual',
    category: 'parser-residual', owner: 'src/services/phase-log/phase-log-tail-session.ts', lifetime: 'per-view', units: 'utf16-units',
    limit: { kind: 'authority', module: 'src/lib/line-framer.ts', symbol: 'DEFAULT_MAX_LINE_UNITS', value: DEFAULT_MAX_LINE_UNITS },
    overflow: 'Drop unterminated residual above DEFAULT_MAX_LINE_UNITS, discard until newline, and push one display-omission system entry.',
    architecture: 'current', consumers: ['F03', 'F07']
  },
  {
    id: 'phase-log-read-entries',
    category: 'query-result', owner: 'src/services/phase-log/phase-log-reader.ts', lifetime: 'per-call', units: 'items',
    limit: { kind: 'authority', module: 'src/contracts/phase-log-bounds.ts', symbol: 'PHASE_LOG_MAX_ENTRIES', value: PHASE_LOG_MAX_ENTRIES },
    overflow: 'Retain newest 499 entries and prepend truncated-head marker with droppedEntryCount.',
    architecture: 'current', consumers: ['F03', 'F07']
  },
  {
    id: 'bounded-file-tail-read',
    category: 'buffer', owner: 'src/lib/bounded-read.ts', lifetime: 'per-call', units: 'bytes',
    limit: { kind: 'authority', module: 'src/lib/bounded-read.ts', symbol: 'DEFAULT_MAX_READ_BYTES', value: DEFAULT_MAX_READ_BYTES },
    overflow: 'Read trailing 8 MiB and report skippedBytes.',
    architecture: 'current', consumers: ['F03', 'F07']
  },
  {
    id: 'agy-projector-open-steps',
    category: 'buffer', owner: 'src/services/phase-log/phase-log-display-projector.ts', lifetime: 'per-view', units: 'items+bytes',
    limit: { kind: 'authority-private', module: 'src/services/phase-log/phase-log-display-projector.ts', symbol: 'MAX_OPEN_AGY_STEPS', description: '16 open steps; 256 KiB per step via MAX_AGY_STEP_TEXT_LENGTH' },
    overflow: 'Close oldest open step when 17th opens; cap step text at 256 KiB.',
    architecture: 'current', consumers: ['F03', 'F07']
  },
  {
    id: 'webview-phase-log-live-window',
    category: 'snapshot', owner: 'webview-ui/src/lib/phase-log-window.ts', lifetime: 'per-view', units: 'items',
    limit: { kind: 'authority-private', module: 'webview-ui/src/lib/phase-log-window.ts', symbol: 'PHASE_LOG_WINDOW_MAX_ENTRIES', description: 'PHASE_LOG_MAX_ENTRIES - 1 (499 live entries + 1 truncated-head marker)' },
    overflow: 'Drop oldest entry and increment truncated-head droppedEntryCount.',
    architecture: 'current', consumers: ['F03', 'F07']
  },

  // --- Current architecture: snapshots, IPC delivery, and webview state ---
  {
    id: 'webview-routine-snapshot-budget',
    category: 'snapshot', owner: 'src/ui/sidebar/snapshot-transport.ts', lifetime: 'per-view', units: 'bytes',
    limit: { kind: 'authority', module: 'src/contracts/snapshot-bounds.ts', symbol: 'ROUTINE_SNAPSHOT_BYTE_BUDGET', value: ROUTINE_SNAPSHOT_BYTE_BUDGET },
    overflow: 'Suppress eligible unchanged slices on routine updates; enforced by webview-snapshot-cost perf gate.',
    architecture: 'current', consumers: ['F03']
  },
  {
    id: 'webview-full-resync-snapshot-ceiling',
    category: 'snapshot', owner: 'src/ui/sidebar/snapshot-transport.ts', lifetime: 'per-view', units: 'bytes',
    limit: { kind: 'authority', module: 'src/contracts/snapshot-bounds.ts', symbol: 'FULL_RESYNC_SNAPSHOT_BYTE_CEILING', value: FULL_RESYNC_SNAPSHOT_BYTE_CEILING },
    overflow: 'Full resync snapshot ceiling (1 MiB) on 2,000-entry large-history fixture.',
    architecture: 'current', consumers: ['F03']
  },
  {
    id: 'webview-snapshot-delivery-slot',
    category: 'delivery-backlog', owner: 'src/ui/sidebar/sidebar-view-provider.ts', lifetime: 'per-view', units: 'items',
    limit: { kind: 'protected-state', reason: 'Single-slot latestSnapshot coalescing; hidden views skip postMessage and resync on reveal.' },
    overflow: 'Overwrite single slot with newest snapshot; failed post marks transport for full resync.',
    architecture: 'current', consumers: ['F03']
  },
  {
    id: 'snapshot-transport-baseline-clone',
    category: 'state-clone', owner: 'src/ui/sidebar/snapshot-transport.ts', lifetime: 'per-view', units: 'items',
    limit: { kind: 'protected-state', reason: 'Single baselineSnapshot reference per view for slice diffing; cleared on dispose.' },
    overflow: 'Replaced on each delivered post; cleared on view dispose.',
    architecture: 'current', consumers: ['F03']
  },
  {
    id: 'audit-tail-projection',
    category: 'snapshot', owner: 'src/ui/sidebar/audit-tail-state.ts', lifetime: 'per-activation', units: 'items',
    limit: { kind: 'authority-private', module: 'src/ui/sidebar/snapshot.ts', symbol: 'AUDIT_TAIL_MAX', description: '50 recent audit entries' },
    overflow: 'Splice oldest audit entries beyond 50.',
    architecture: 'current', consumers: ['F03']
  },
  {
    id: 'recent-queues-projection',
    category: 'query-result', owner: 'src/ui/sidebar/queue-projector.ts', lifetime: 'per-call', units: 'items',
    limit: { kind: 'authority-private', module: 'src/ui/sidebar/snapshot.ts', symbol: 'RECENT_QUEUE_MAX', description: '5 recent queues in sidebar summary' },
    overflow: 'Slice to top 5 queues.',
    architecture: 'current', consumers: ['F03']
  },
  {
    id: 'sidebar-display-lists',
    category: 'query-result', owner: 'src/ui/sidebar/display-projection.ts', lifetime: 'per-call', units: 'items',
    limit: { kind: 'authority-private', module: 'src/ui/sidebar/display-projection.ts', symbol: 'ENTRIES_PER_DISPLAY_LIST_MAX', description: '100 entries per display list; 512 chars per text field' },
    overflow: 'Slice list to 100 entries and truncate text to 512 chars.',
    architecture: 'current', consumers: ['F03']
  },
  {
    id: 'debug-log-tail-ring',
    category: 'diagnostic-collector', owner: 'src/lib/webview-log-sink.ts', lifetime: 'per-activation', units: 'items',
    limit: { kind: 'authority', module: 'src/lib/webview-log-sink.ts', symbol: 'DEBUG_LOG_TAIL_MAX', value: DEBUG_LOG_TAIL_MAX },
    overflow: 'Ring buffer overwrites oldest entry past 200.',
    architecture: 'current', consumers: ['F03']
  },
  {
    id: 'mutation-ack-replay-cache',
    category: 'cache', owner: 'src/ui/sidebar/mutation-command-executor.ts', lifetime: 'per-view', units: 'items+bytes+age',
    limit: { kind: 'authority', module: 'src/contracts/ack-retention.ts', symbol: 'ACK_RETENTION_MAX_ENTRIES', value: ACK_RETENTION_MAX_ENTRIES },
    overflow: `Prune entries older than ACK_RETENTION_MS (${ACK_RETENTION_MS} ms) then evict oldest-inserted past 1,000.`,
    architecture: 'current', consumers: ['F03']
  },
  {
    id: 'builder-undo-history',
    category: 'state-clone', owner: 'webview-ui/src/lib/builder-history-bound.ts', lifetime: 'per-view', units: 'items+bytes',
    limit: { kind: 'authority-private', module: 'webview-ui/src/lib/builder-history-bound.ts', symbol: 'MAX_BUILDER_HISTORY_BYTES', description: '50 entries (MAX_BUILDER_HISTORY_ENTRIES) and 262,144 bytes (MAX_BUILDER_HISTORY_BYTES)' },
    overflow: 'Drop oldest undo states until entries <= 50 and bytes <= 256 KiB (always keeps >= 1).',
    architecture: 'current', consumers: ['F03']
  },

  // --- Current architecture: monitor, transport, telemetry, metrics, and retention ---
  {
    id: 'monitor-active-run-states',
    category: 'cache', owner: 'src/monitor/claude-cli-monitor.ts', lifetime: 'per-run', units: 'items',
    limit: { kind: 'protected-state', reason: 'Active monitor run states correspond 1:1 with live in-flight invocations and are bounded by global concurrency.' },
    overflow: 'Transitioned to settled state on completion and subject to MAX_SETTLED_STATES eviction.',
    architecture: 'current', consumers: ['F03']
  },
  {
    id: 'monitor-settled-run-states',
    category: 'cache', owner: 'src/monitor/claude-cli-monitor.ts', lifetime: 'per-activation', units: 'items',
    limit: { kind: 'authority-private', module: 'src/monitor/claude-cli-monitor.ts', symbol: 'MAX_SETTLED_STATES', description: '32 settled run states' },
    overflow: 'Evict oldest settled run state past 32.',
    architecture: 'current', consumers: ['F03']
  },
  {
    id: 'monitor-unknown-run-reports',
    category: 'diagnostic-collector', owner: 'src/monitor/claude-cli-monitor.ts', lifetime: 'per-activation', units: 'items',
    limit: { kind: 'authority-private', module: 'src/monitor/claude-cli-monitor.ts', symbol: 'MAX_UNKNOWN_RUN_REPORTS', description: '32 unknown run report IDs' },
    overflow: 'Stop recording additional IDs past 32 while incrementing counter.',
    architecture: 'current', consumers: ['F03']
  },
  {
    id: 'cli-transport-pending-writes',
    category: 'delivery-backlog', owner: 'src/monitor/cli-transport-sink.ts', lifetime: 'per-activation', units: 'bytes',
    limit: { kind: 'authority-private', module: 'src/monitor/cli-transport-sink.ts', symbol: 'MAX_PENDING_BYTES', description: '16 MiB pending transport write backlog' },
    overflow: 'Drop line, increment droppedLines/droppedBytes, and emit warn-once pending-bytes-exceeded.',
    architecture: 'current', consumers: ['F03', 'F07']
  },
  {
    id: 'cli-transport-key-block-redactors',
    category: 'cache', owner: 'src/monitor/cli-transport-sink.ts', lifetime: 'per-activation', units: 'items',
    limit: { kind: 'authority-private', module: 'src/monitor/cli-transport-sink.ts', symbol: 'CLI_TRANSPORT_MAX_TRACKED_STREAMS', description: '256 tracked stream redactors' },
    overflow: 'Evict first non-open stream redactor, else oldest.',
    architecture: 'current', consumers: ['F03']
  },
  {
    id: 'run-transport-files-on-disk',
    category: 'file-metadata', owner: 'src/monitor/transport/run-transport-store.ts', lifetime: 'persisted', units: 'bytes',
    limit: { kind: 'authority', module: 'src/contracts/transport-bounds.ts', symbol: 'TRANSPORT_WORKSPACE_MAX_BYTES', value: TRANSPORT_WORKSPACE_MAX_BYTES },
    overflow: `Compact individual files at ${TRANSPORT_FILE_MAX_BYTES} B to half size; remove oldest inactive files above 20 MiB workspace cap.`,
    architecture: 'current', consumers: ['F03', 'F05']
  },
  {
    id: 'telemetry-live-subprocess-series',
    category: 'cache', owner: 'src/telemetry/telemetry-sampler.ts', lifetime: 'per-invocation', units: 'items',
    limit: { kind: 'protected-state', reason: 'Series map holds one entry per live child PID and removes the entry on stop(pid).' },
    overflow: 'Removed immediately when child process stops or sampler disposes.',
    architecture: 'current', consumers: ['F03', 'F14']
  },
  {
    id: 'metrics-rollup-log-on-disk',
    category: 'file-metadata', owner: 'src/metrics/metrics-rollup-writer.ts', lifetime: 'persisted', units: 'items+bytes',
    limit: { kind: 'authority', module: 'src/metrics/metrics-rollup-writer.ts', symbol: 'TRIM_THRESHOLD_BYTES', value: TRIM_THRESHOLD_BYTES },
    overflow: `When rollup file exceeds 8 MiB, fold older records into carry-forward header and retain newest ${RETAINED_RECORDS_AFTER_TRIM} records.`,
    architecture: 'current', consumers: ['F03', 'F06', 'F11']
  },
  {
    id: 'runner-session-cost-ledger',
    category: 'cache', owner: 'src/runner/session-cost-ledger.ts', lifetime: 'per-activation', units: 'items',
    limit: { kind: 'authority', module: 'src/runner/session-cost-ledger.ts', symbol: 'MAX_TRACKED_SESSIONS', value: MAX_TRACKED_SESSIONS },
    overflow: 'Evict oldest-inserted session cost baseline past 64.',
    architecture: 'current', consumers: ['F03', 'F06']
  },
  {
    id: 'runner-background-task-tracker',
    category: 'cache', owner: 'src/runner/background-task-tracker.ts', lifetime: 'per-invocation', units: 'items',
    limit: { kind: 'authority', module: 'src/runner/background-task-tracker.ts', symbol: 'MAX_OPEN_TASKS', value: MAX_OPEN_TASKS },
    overflow: 'Refuse additional open background task IDs past 256 and mark dropped = true.',
    architecture: 'current', consumers: ['F03']
  },
  {
    id: 'blocker-notice-ledger',
    category: 'cache', owner: 'src/services/blocker-notice.ts', lifetime: 'per-activation', units: 'items',
    limit: { kind: 'authority', module: 'src/services/blocker-notice.ts', symbol: 'BLOCKER_NOTICE_LEDGER_MAX', value: BLOCKER_NOTICE_LEDGER_MAX },
    overflow: 'Evict oldest blocker notice entry past 256.',
    architecture: 'current', consumers: ['F03']
  },
  {
    id: 'backend-posture-ledger',
    category: 'cache', owner: 'src/controller/backend-posture-recorder.ts', lifetime: 'per-activation', units: 'items',
    limit: { kind: 'authority', module: 'src/controller/backend-posture-recorder.ts', symbol: 'POSTURE_LEDGER_MAX_PAIRS', value: POSTURE_LEDGER_MAX_PAIRS },
    overflow: 'Evict oldest backend posture pair past 512.',
    architecture: 'current', consumers: ['F03']
  },
  {
    id: 'audit-pointer-resolved-entries',
    category: 'query-result', owner: 'src/services/history/audit-pointer-resolver.ts', lifetime: 'per-call', units: 'items',
    limit: { kind: 'authority', module: 'src/services/history/audit-pointer-resolver.ts', symbol: 'MAX_RESOLVED_ENTRIES', value: MAX_RESOLVED_ENTRIES },
    overflow: 'Stop resolving at 500 entries and set more-available flag.',
    architecture: 'current', consumers: ['F03', 'F11']
  },
  {
    id: 'failure-records-on-disk',
    category: 'file-metadata', owner: 'src/services/failure-record/failure-record-retention.ts', lifetime: 'persisted', units: 'items+bytes',
    limit: { kind: 'authority', module: 'src/contracts/failure-record.ts', symbol: 'FAILURE_RECORD_RETAINED_MAX', value: FAILURE_RECORD_RETAINED_MAX },
    overflow: `Prune by age then remove oldest beyond 200 records (${FAILURE_RECORD_MAX_BYTES} B per record).`,
    architecture: 'current', consumers: ['F03', 'F05']
  },
  {
    id: 'run-checkpoints-on-disk',
    category: 'file-metadata', owner: 'src/services/run-checkpoint-retention.ts', lifetime: 'persisted', units: 'bytes',
    limit: { kind: 'authority', module: 'src/services/run-checkpoint-retention.ts', symbol: 'CHECKPOINT_MAX_TOTAL_BYTES', value: CHECKPOINT_MAX_TOTAL_BYTES },
    overflow: 'Retention sweep removes oldest checkpoints above 256 MiB / 14 days while keeping recent run floor.',
    architecture: 'current', consumers: ['F03', 'F05', 'F08']
  },
  {
    id: 'catalog-versions-on-disk',
    category: 'file-metadata', owner: 'src/catalog/catalog-retention.ts', lifetime: 'persisted', units: 'items',
    limit: { kind: 'authority', module: 'src/contracts/catalog-store.ts', symbol: 'CATALOG_RETENTION_BOUND', value: CATALOG_RETENTION_BOUND },
    overflow: 'Prune oldest unreferenced catalog versions beyond 50.',
    architecture: 'current', consumers: ['F03', 'F05']
  },
  {
    id: 'audit-log-segments-on-disk',
    category: 'file-metadata', owner: 'src/audit/audit-log-writer.ts', lifetime: 'persisted', units: 'bytes',
    limit: { kind: 'authority', module: 'src/audit/audit-log-writer.ts', symbol: 'AUDIT_ROTATION_DEFAULT_SIZE_BYTES', value: AUDIT_ROTATION_DEFAULT_SIZE_BYTES },
    overflow: `Rotate at 5 MiB and prune beyond ${AUDIT_ARCHIVE_DEFAULT_MAX_COUNT} archives / 90 days.`,
    architecture: 'current', consumers: ['F03', 'F05']
  },
  {
    id: 'recovery-envelope-capture',
    category: 'snapshot', owner: 'src/contracts/recovery-envelope.ts', lifetime: 'per-run', units: 'items+bytes',
    limit: { kind: 'authority', module: 'src/contracts/recovery-envelope.ts', symbol: 'MAX_RECOVERY_ENVELOPE_BYTES', value: MAX_RECOVERY_ENVELOPE_BYTES },
    overflow: `Truncate workspace entries past ${MAX_RECOVERY_WORKSPACE_ENTRIES} (capture cap ${MAX_CAPTURE_TOTAL_BYTES} B) and record droppedEntries.`,
    architecture: 'current', consumers: ['F03', 'F08']
  },
  {
    id: 'backend-capability-probe-buffer',
    category: 'buffer', owner: 'src/services/backend-capability-service.ts', lifetime: 'per-call', units: 'bytes',
    limit: { kind: 'authority', module: 'src/services/backend-capability-service.ts', symbol: 'BACKEND_PROBE_OUTPUT_CAP_BYTES', value: BACKEND_PROBE_OUTPUT_CAP_BYTES },
    overflow: 'Stop appending probe stdout/stderr past 64 KiB.',
    architecture: 'current', consumers: ['F03']
  },

  // --- F03-owned common queue and query bounds (FR-015) ---
  {
    id: 'f03-resource-collector-window',
    category: 'diagnostic-collector', owner: 'src/services/runtime-resource-budgets/resource-collector.ts', lifetime: 'per-run', units: 'items+bytes',
    limit: { kind: 'f03-owned', boundId: 'resource-collector-window' },
    overflow: 'Overwrite oldest samples after updating bounded per-metric aggregates; export sampleCoverage.',
    architecture: 'current', consumers: ['F03']
  },
  {
    id: 'f03-pending-usage-ingestion',
    category: 'queue', owner: 'src/services/runtime-resource-budgets/common-bound-references.ts', lifetime: 'per-activation', units: 'items+bytes',
    limit: { kind: 'f03-owned', boundId: 'pending-usage-ingestion' },
    overflow: 'Coalesce provisional counters where semantics permit; otherwise refuse with counted coverage gap.',
    architecture: 'current', consumers: ['F03', 'F06']
  },
  {
    id: 'f03-unattributed-usage-observations',
    category: 'queue', owner: 'src/services/runtime-resource-budgets/common-bound-references.ts', lifetime: 'per-activation', units: 'items+bytes+age',
    limit: { kind: 'f03-owned', boundId: 'unattributed-usage-observations' },
    overflow: 'Expire or quarantine with omission counts at 1,024 items, 4 MiB, or 24 hours; never guess attribution.',
    architecture: 'current', consumers: ['F03', 'F06']
  },
  {
    id: 'f03-pending-accounting-projection-work',
    category: 'queue', owner: 'src/services/runtime-resource-budgets/common-bound-references.ts', lifetime: 'per-activation', units: 'items+bytes',
    limit: { kind: 'f03-owned', boundId: 'pending-accounting-projection-work' },
    overflow: 'Refuse in-memory duplicate beyond 2,048 refs / 8 MiB and refill from durable intents.',
    architecture: 'current', consumers: ['F03', 'F06']
  },
  {
    id: 'f03-outstanding-accounting-intents',
    category: 'queue', owner: 'src/services/runtime-resource-budgets/common-bound-references.ts', lifetime: 'persisted', units: 'items+bytes',
    limit: { kind: 'f03-owned', boundId: 'outstanding-accounting-intents' },
    overflow: 'Pause new optional accounting acceptance before crossing 10,000 intents / 32 MiB; keep accepted facts.',
    architecture: 'current', consumers: ['F03', 'F06']
  },
  {
    id: 'f03-correction-history-per-attempt',
    category: 'snapshot', owner: 'src/services/runtime-resource-budgets/common-bound-references.ts', lifetime: 'persisted', units: 'items+bytes',
    limit: { kind: 'f03-owned', boundId: 'correction-history-per-attempt' },
    overflow: 'Refuse 65th correction or > 256 KiB before acceptance; keep last accepted contribution and expose conflict.',
    architecture: 'current', consumers: ['F02', 'F03', 'F06']
  },
  {
    id: 'f03-historical-query-concurrency',
    category: 'queue', owner: 'src/services/runtime-resource-budgets/common-bound-references.ts', lifetime: 'per-activation', units: 'items+bytes',
    limit: { kind: 'f03-owned', boundId: 'historical-query-concurrency' },
    overflow: 'Allow 2 executing + 8 waiting queries (1 MiB params); return busy/limited for excess; cancel removes waiting.',
    architecture: 'current', consumers: ['F03', 'F11']
  },
  {
    id: 'f03-historical-query-working-data',
    category: 'query-result', owner: 'src/services/runtime-resource-budgets/common-bound-references.ts', lifetime: 'per-call', units: 'bytes',
    limit: { kind: 'f03-owned', boundId: 'historical-query-working-data' },
    overflow: 'Stream/batch or return typed limit at 32 MiB per workspace excluding shared store cache.',
    architecture: 'current', consumers: ['F03', 'F11']
  },
  {
    id: 'f03-live-report-leases',
    category: 'cache', owner: 'src/services/runtime-resource-budgets/common-bound-references.ts', lifetime: 'per-activation', units: 'items+bytes+age',
    limit: { kind: 'f03-owned', boundId: 'live-report-leases' },
    overflow: 'Max 4 leases per workspace with fixed 5-minute lifetime; expiry returns restart instruction with no renewal.',
    architecture: 'current', consumers: ['F03', 'F11']
  },

  // --- Honest unbounded findings with scoped remediations (FR-014, research R2) ---
  {
    id: 'finding-raw-transcript-failed-runs-set',
    category: 'diagnostic-collector', owner: 'src/audit/raw-transcript-writer.ts', lifetime: 'per-activation', units: 'items',
    limit: { kind: 'unbounded-finding', scope: 'failedRuns Set<runId> in RawTranscriptWriter', remediation: 'Bound failedRuns with a 256-entry LRU ring in F05 artifact lifecycle cleanup.' },
    overflow: 'Grow-only per failed run during activation; scoped remediation assigned to F05.',
    architecture: 'current', consumers: ['F03', 'F05']
  },
  {
    id: 'finding-terminal-transition-lost-noticed-set',
    category: 'diagnostic-collector', owner: 'src/services/terminal-transition-coordinator.ts', lifetime: 'per-activation', units: 'items',
    limit: { kind: 'unbounded-finding', scope: 'lostNoticed Set<runId> in TerminalTransitionCoordinator', remediation: 'Cap lostNoticed at 256 run IDs with FIFO eviction during F08 handoff/recovery integration.' },
    overflow: 'Grow-only per lost-terminal notice during activation; scoped remediation assigned to F08.',
    architecture: 'current', consumers: ['F03', 'F08']
  },
  {
    id: 'finding-admission-consumed-token-sets',
    category: 'cache', owner: 'src/services/workflow-execution/control-attempt-admission.ts', lifetime: 'per-activation', units: 'items',
    limit: { kind: 'unbounded-finding', scope: 'consumedTokenIds Set and unconsumedTokens Map in ControlAttemptAdmissionService', remediation: 'Prune token sets when the owning root settles or is evicted in F04 store migration.' },
    overflow: 'Grow-only across consumed/prepared tokens per activation; scoped remediation assigned to F04.',
    architecture: 'current', consumers: ['F03', 'F04']
  },
  {
    id: 'finding-verbose-diagnostic-dir-sets',
    category: 'cache', owner: 'src/audit/verbose-diagnostic-writer.ts', lifetime: 'per-activation', units: 'items',
    limit: { kind: 'unbounded-finding', scope: 'preparedDirs Set and warnedSlots Map in VerboseDiagnosticWriter', remediation: 'Evict per-iteration directory entries on run completion in F05.' },
    overflow: 'Grow-only when verbose diagnostics are enabled; scoped remediation assigned to F05.',
    architecture: 'current', consumers: ['F03', 'F05']
  },
  {
    id: 'finding-runner-diagnostic-write-promises',
    category: 'delivery-backlog', owner: 'src/runner/claude-cli.ts', lifetime: 'per-invocation', units: 'items',
    limit: { kind: 'unbounded-finding', scope: 'diagnosticWrites Promise<void>[] array per invocation when verbose logging is active', remediation: 'Drain settled promises incrementally via a bounded concurrency queue in F07/F13.' },
    overflow: 'Accumulates one promise per chunk until invocation exit; scoped remediation assigned to F07/F13.',
    architecture: 'current', consumers: ['F03', 'F07', 'F13']
  },
  {
    id: 'finding-persisted-connected-runs-map',
    category: 'snapshot', owner: 'src/state/workspace-state.ts', lifetime: 'persisted', units: 'items',
    limit: { kind: 'unbounded-finding', scope: 'KEYS.connectedRuns persisted map in WorkspaceStateStore', remediation: 'Migrate connectedRuns into F04 SQLite store with 90-day / 256-MiB metadata retention sweep.' },
    overflow: 'Deleted only on queue removal today; scoped remediation assigned to F04.',
    architecture: 'current', consumers: ['F03', 'F04']
  },
  {
    id: 'finding-webview-intent-ledger-count',
    category: 'cache', owner: 'webview-ui/src/lib/intent-ledger.ts', lifetime: 'per-view', units: 'items+bytes+age',
    limit: { kind: 'unbounded-finding', scope: 'webview intent-ledger Map (time-bounded by ACK_RETENTION_MS = 1h without ACK_RETENTION_MAX_ENTRIES count cap)', remediation: 'Apply ACK_RETENTION_MAX_ENTRIES (1,000) count cap alongside the 1-hour expiry in webview intent-ledger.' },
    overflow: 'Expires entries older than 1 hour; count cap remediation documented.',
    architecture: 'current', consumers: ['F03']
  },
  {
    id: 'finding-metrics-scan-corpus-cache',
    category: 'cache', owner: 'src/metrics/metrics-service.ts', lifetime: 'per-process', units: 'items',
    limit: { kind: 'unbounded-finding', scope: 'metricsCache parsed taskStarted/taskEnded/phaseGroups Maps in metrics-service.ts', remediation: 'Replace whole-corpus in-memory maps with F04/F06 bounded SQLite rollup projections.' },
    overflow: 'Indirectly bounded only by audit log rotation (10 x 5 MiB); scoped remediation assigned to F04/F06.',
    architecture: 'current', consumers: ['F03', 'F04', 'F06']
  },

  // --- Target architecture entries (FR-001, US1 scenario 3) ---
  {
    id: 'target-sqlite-page-and-read-caches',
    category: 'cache', owner: 'src/services/workflow-execution/control-ledger-store.ts', lifetime: 'per-process', units: 'bytes',
    limit: { kind: 'owning-feature', featureId: 'F04', description: 'SQLite worker page cache and prepared read caches counted inside the 512 MiB host normal envelope' },
    overflow: 'Evict clean pages per SQLite cache_size pragma; never enlarge aggregate 512 MiB host budget.',
    architecture: 'target', consumers: ['F03', 'F04', 'F11']
  },
  {
    id: 'target-sqlite-wal-and-checkpoint-work',
    category: 'file-metadata', owner: 'src/services/workflow-execution/control-ledger-store.ts', lifetime: 'persisted', units: 'bytes',
    limit: { kind: 'owning-feature', featureId: 'F04', description: 'SQLite WAL journal growth, checkpoint staging bytes, and writer admission queue (64 requests / 16 MiB)' },
    overflow: 'Passive/restart checkpointing and bounded writer admission refusal before journal exhaustion.',
    architecture: 'target', consumers: ['F03', 'F04']
  },
  {
    id: 'target-acp-decoding-and-request-queues',
    category: 'queue', owner: 'src/runner/claude-cli.ts', lifetime: 'per-invocation', units: 'items+bytes',
    limit: { kind: 'owning-feature', featureId: 'F13', description: 'ACP frame decoding buffer, permission-wait queue, and connection-local request correlation table' },
    overflow: 'Refuse excess requests or truncate oversize non-control display frames without starving protocol control or cancellation.',
    architecture: 'target', consumers: ['F03', 'F13']
  },
  {
    id: 'target-acp-bridge-process-overhead',
    category: 'buffer', owner: 'src/telemetry/telemetry-sampler.ts', lifetime: 'per-invocation', units: 'bytes',
    limit: { kind: 'owning-feature', featureId: 'F13', description: 'Native or bridge child-process resident memory reported in the backend-process-memory category' },
    overflow: 'Measured and reported separately from host-process memory; never folded into host RSS.',
    architecture: 'target', consumers: ['F03', 'F13', 'F14']
  },
  {
    id: 'target-phase-context-materialization',
    category: 'buffer', owner: 'src/services/workflow-execution/control-attempt-admission.ts', lifetime: 'per-invocation', units: 'items+bytes',
    limit: { kind: 'owning-feature', featureId: 'F15', description: 'Phase-to-phase context preparation queues and working set included inside the aggregate normal envelope' },
    overflow: 'Refuse or bound context materialization per F15 contract without enlarging the 512 MiB aggregate budget.',
    architecture: 'target', consumers: ['F03', 'F15']
  }
]);

const REQUIRED_TARGET_IDS = [
  'target-sqlite-page-and-read-caches',
  'target-sqlite-wal-and-checkpoint-work',
  'target-acp-decoding-and-request-queues',
  'target-acp-bridge-process-overhead',
  'target-phase-context-materialization'
] as const;

/**
 * Review a proposal to add a diagnostic collector (US1 scenario 4, SC-001):
 * any new diagnostic collector must declare a concrete authority or f03-owned bound.
 */
export function reviewDiagnosticCollectorProposal(entry: InventoryEntry): ValidationResult {
  const errors: string[] = [];
  if (entry.category !== 'diagnostic-collector') {
    errors.push(`Entry '${entry.id}' is not a diagnostic-collector.`);
  }
  if (
    entry.limit.kind !== 'authority' &&
    entry.limit.kind !== 'authority-private' &&
    entry.limit.kind !== 'f03-owned'
  ) {
    errors.push(
      `Diagnostic collector '${entry.id}' must declare a concrete authority or f03-owned bound; '${entry.limit.kind}' is rejected.`
    );
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate the runtime resource inventory for uniqueness, five required attributes,
 * zero competing authority constants, bounded F03 diagnostic collectors, remediations
 * on all unbounded findings, and target-architecture coverage (FR-001, FR-012, SC-001).
 */
export function validateResourceInventory(
  entries: readonly InventoryEntry[] = RUNTIME_RESOURCE_INVENTORY,
  expectedAuthorities: ReadonlyMap<string, number> = AUTHORITATIVE_CONSTANT_VALUES
): ValidationResult {
  const errors: string[] = [];
  const seenIds = new Set<string>();
  const commonBoundSet = new Set<string>(COMMON_BOUND_IDS);

  for (const entry of entries) {
    if (!entry.id || entry.id.trim().length === 0) {
      errors.push('Inventory entry has an empty id.');
      continue;
    }
    if (seenIds.has(entry.id)) {
      errors.push(`Duplicate inventory id '${entry.id}'.`);
    }
    seenIds.add(entry.id);

    const rawEntry = entry as unknown as Record<string, unknown>;
    if (!entry.owner || entry.owner.trim().length === 0) {
      errors.push(`Entry '${entry.id}' is missing owner.`);
    }
    if (typeof rawEntry.lifetime !== 'string' || rawEntry.lifetime.trim().length === 0) {
      errors.push(`Entry '${entry.id}' is missing lifetime.`);
    }
    if (typeof rawEntry.units !== 'string' || rawEntry.units.trim().length === 0) {
      errors.push(`Entry '${entry.id}' is missing units.`);
    }
    if (!entry.overflow || entry.overflow.trim().length === 0) {
      errors.push(`Entry '${entry.id}' is missing overflow behavior.`);
    }
    if (entry.overflow && entry.overflow.length > 240) {
      errors.push(`Entry '${entry.id}' overflow exceeds 240 characters.`);
    }

    const limit = entry.limit;
    switch (limit.kind) {
      case 'authority': {
        const key = `${limit.module}#${limit.symbol}`;
        const authoritative = expectedAuthorities.get(key);
        if (authoritative === undefined) {
          errors.push(`Entry '${entry.id}' references unknown authority '${key}'.`);
        } else if (limit.value !== authoritative) {
          errors.push(
            `Entry '${entry.id}' introduces a competing value (${limit.value}) for authority '${key}' (expected ${authoritative}).`
          );
        }
        break;
      }
      case 'authority-private': {
        if (!limit.module || !limit.symbol || !limit.description) {
          errors.push(`Entry '${entry.id}' has an incomplete authority-private reference.`);
        }
        break;
      }
      case 'f03-owned': {
        if (!commonBoundSet.has(limit.boundId)) {
          errors.push(`Entry '${entry.id}' references unknown f03-owned bound '${limit.boundId}'.`);
        }
        break;
      }
      case 'owning-feature': {
        if (!limit.description || limit.description.trim().length === 0) {
          errors.push(`Entry '${entry.id}' is missing owning-feature description.`);
        }
        break;
      }
      case 'protected-state': {
        if (!limit.reason || limit.reason.trim().length === 0) {
          errors.push(`Entry '${entry.id}' is missing protected-state reason.`);
        }
        break;
      }
      case 'unbounded-finding': {
        if (
          !limit.remediation ||
          limit.remediation.trim().length === 0 ||
          !limit.scope ||
          limit.scope.trim().length === 0
        ) {
          errors.push(
            `Entry '${entry.id}' is an unbounded-finding without a scoped remediation (FR-014).`
          );
        }
        break;
      }
    }

    if (
      entry.category === 'diagnostic-collector' &&
      entry.id.startsWith('f03-') &&
      limit.kind !== 'f03-owned' &&
      limit.kind !== 'authority'
    ) {
      errors.push(`F03 diagnostic collector '${entry.id}' must have a declared bound (SC-001).`);
    }
  }

  for (const targetId of REQUIRED_TARGET_IDS) {
    if (!seenIds.has(targetId)) {
      errors.push(`Target-architecture inventory entry '${targetId}' is missing.`);
    }
  }

  return { ok: errors.length === 0, errors };
}
