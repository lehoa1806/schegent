import type { CommandAckMessage, HostMessage } from './messages';
import { CMD_ACK, STATE_SNAPSHOT } from './messages';
import { IDLE_DELAYED_RETRY, IDLE_GENERAL_SETTINGS } from './snapshot-types';
import type {
  AuditTailEntry,
  CliMonitorState,
  DebugLogEntry,
  DelayedRetryState,
  GeneralSettings,
  HistoryEntry,
  PhaseName,
  PhaseTile,
  QueueProjection,
  QueueSummary,
  QueueItem,
  WorkflowSnapshot,
  WorkflowStatus
} from './snapshot-types';

export interface AckResult {
  readonly status: 'accepted' | 'rejected';
  readonly reason?: string;
  // Feature 020 — optional typed payload from the read-only phase-log
  // IPC surface (see webview-ui/src/lib/phase-log-ipc.ts for the
  // canonical caller). Mutating commands MUST leave this field
  // absent; helpers that don't need it can ignore it.
  readonly result?: unknown;
}

export type AckListener = (ack: AckResult) => void;

class SnapshotStore {
  private _snapshot = $state<WorkflowSnapshot | null>(null);
  private _lastSchemaWarning = false;
  private _pending = $state<Set<string>>(new Set());
  private _ackListeners = new Map<string, AckListener>();

  get snapshot(): WorkflowSnapshot | null {
    return this._snapshot;
  }

  get isReady(): boolean {
    return this._snapshot !== null;
  }

  get isPrimary(): boolean {
    return this._snapshot?.isPrimary ?? false;
  }

  get status(): WorkflowStatus {
    return this._snapshot?.status ?? 'idle';
  }

  get phases(): readonly PhaseTile[] {
    return this._snapshot?.phases ?? [];
  }

  get queue(): QueueProjection {
    return (
      this._snapshot?.queue ?? {
        inFlight: null,
        pending: [],
        recent: [],
        orderedItems: [],
        paused: false
      }
    );
  }

  get queues(): readonly QueueSummary[] {
    return this.queue.queues ?? [];
  }

  queueById(queueId: string): QueueSummary | null {
    return this.queues.find((queue) => queue.id === queueId) ?? null;
  }

  queueItems(queueId: string): readonly QueueItem[] {
    const matches = (item: QueueItem): boolean => (item.queueId ?? 'default') === queueId;
    return [
      ...(this.queue.inFlight && matches(this.queue.inFlight) ? [this.queue.inFlight] : []),
      ...this.queue.pending.filter(matches),
      ...this.queue.recent.filter(matches)
    ];
  }

  get auditTail(): readonly AuditTailEntry[] {
    return this._snapshot?.auditTail ?? [];
  }

  get debugLogTail(): readonly DebugLogEntry[] {
    return this._snapshot?.debugLogTail ?? [];
  }

  get activeFeatureLabel(): string | null {
    return this._snapshot?.activeFeature?.label ?? null;
  }

  get monitor(): CliMonitorState | null {
    return this._snapshot?.monitor ?? null;
  }

  get history(): readonly HistoryEntry[] {
    return this._snapshot?.history ?? [];
  }

  /**
   * Feature 011 — delayed-retry projection. Returns the IDLE constant
   * when the host did not include it (legacy-tolerance per
   * contracts/general-settings-ipc.md).
   */
  get delayedRetry(): DelayedRetryState {
    return this._snapshot?.delayedRetry ?? IDLE_DELAYED_RETRY;
  }

  /**
   * Feature 011 — general-settings projection. Returns the IDLE
   * constant when the host did not include it (legacy-tolerance per
   * contracts/general-settings-ipc.md).
   */
  get generalSettings(): GeneralSettings {
    return this._snapshot?.generalSettings ?? IDLE_GENERAL_SETTINGS;
  }

  /**
   * Feature 011 — register a one-shot listener for the ack of a
   * specific correlationId. The listener is invoked exactly once and
   * then removed.
   */
  onceAck(correlationId: string, listener: AckListener): () => void {
    this._ackListeners.set(correlationId, listener);
    return () => {
      this._ackListeners.delete(correlationId);
    };
  }

  phaseByName(name: PhaseName): PhaseTile | null {
    return this._snapshot?.phases.find((p) => p.name === name) ?? null;
  }

  apply(message: HostMessage<WorkflowSnapshot>): void {
    if (message.type === STATE_SNAPSHOT) {
      this.applySnapshot(message.payload);
      return;
    }
    if (message.type === CMD_ACK) {
      this.applyAck(message);
      return;
    }
  }

  isPending(correlationId: string): boolean {
    return this._pending.has(correlationId);
  }

  markPending(correlationId: string): void {
    const next = new Set(this._pending);
    next.add(correlationId);
    this._pending = next;
  }

  clearPending(correlationId: string): void {
    if (!this._pending.has(correlationId)) return;
    const next = new Set(this._pending);
    next.delete(correlationId);
    this._pending = next;
  }

  private applySnapshot(snap: WorkflowSnapshot): void {
    if (!snap || typeof snap !== 'object') return;
    if (snap.schemaVersion !== 3) {
      if (!this._lastSchemaWarning) {
        console.warn('[schegent] dropping snapshot with unknown schemaVersion', snap.schemaVersion);
        this._lastSchemaWarning = true;
      }
      return;
    }
    if (!Array.isArray(snap.phases)) {
      if (!this._lastSchemaWarning) {
        console.warn('[schegent] dropping snapshot with malformed phases');
        this._lastSchemaWarning = true;
      }
      return;
    }
    this._snapshot = snap;
    if (this._pending.size > 0) {
      this._pending = new Set();
    }
  }

  private applyAck(msg: CommandAckMessage): void {
    this.clearPending(msg.correlationId);
    const listener = this._ackListeners.get(msg.correlationId);
    if (listener) {
      this._ackListeners.delete(msg.correlationId);
      try {
        listener({ status: msg.status, reason: msg.reason, result: msg.result });
      } catch {
        // listener errors must not propagate into the host-message bus
      }
    }
  }
}

export const snapshotStore = new SnapshotStore();
