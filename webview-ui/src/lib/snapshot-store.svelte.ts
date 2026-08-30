import type { CommandAckMessage, HostMessage } from './messages';
import { CMD_ACK, STATE_SNAPSHOT } from './messages';
import { IDLE_DELAYED_RETRY, IDLE_GENERAL_SETTINGS, IDLE_QUEUE_SETTINGS } from './snapshot-types';
import { defaultQueueRuntime, findQueueRuntime } from './queue-runtime-view';
import type {
  AuditTailEntry,
  CliMonitorState,
  DebugLogEntry,
  DelayedRetryState,
  GeneralSettings,
  QueueSettingsProjection,
  HistoryEntry,
  LiveActivity,
  PhaseName,
  PhaseTile,
  QueueProjection,
  QueueRuntime,
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
  // canonical caller). Helpers that don't need it can ignore it.
  //
  // Feature 095 (T008) — corrected. This said "mutating commands MUST leave
  // this field absent", which was already untrue when it was written: a
  // two-phase mutating command populates `result` on the *refusal* that asks
  // for confirmation, carrying the impact the prompt has to state.
  // `CMD_DELETE_QUEUE` does exactly that (see queue-control-ipc.ts). The rule
  // that does hold is narrower — no mutating command returns a success value
  // here; an accepted mutation is observed through the next snapshot.
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

  /**
   * Feature 092 (FR-048) — every registered queue's runtime, in position order.
   * The v4 replacement for the root singulars: a surface that wants run state
   * picks a queue rather than reading "the" run.
   */
  get queueRuntimes(): readonly QueueRuntime[] {
    return this._snapshot?.queues ?? [];
  }

  runtimeById(queueId: string): QueueRuntime | null {
    return findQueueRuntime(this._snapshot, queueId);
  }

  /**
   * The runtime a surface reads when no queue has been selected. Slice E adds
   * the operator-facing selection; until then this is the default queue, which
   * reproduces the v3 reading for a workspace that has only that one.
   */
  get defaultRuntime(): QueueRuntime | null {
    return defaultQueueRuntime(this._snapshot);
  }

  get status(): WorkflowStatus {
    return this.defaultRuntime?.inFlightRun?.status ?? 'idle';
  }

  get phases(): readonly PhaseTile[] {
    return this.defaultRuntime?.phases ?? [];
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
    return this.defaultRuntime?.inFlightRun?.feature?.label ?? null;
  }

  /**
   * Feature 092 — live-activity and elapsed readings for the default queue's
   * Run. `null` when that queue owns none, which is what the header surfaces
   * rendered for an idle workspace before the fold.
   */
  get liveActivity(): LiveActivity | null {
    return this.defaultRuntime?.inFlightRun?.liveActivity ?? null;
  }

  get workflowElapsedMs(): number | null {
    return this.defaultRuntime?.inFlightRun?.elapsedMs ?? null;
  }

  get monitor(): CliMonitorState | null {
    return this._snapshot?.monitor ?? null;
  }

  get history(): readonly HistoryEntry[] {
    return this._snapshot?.history ?? [];
  }

  /**
   * Feature 011 — delayed-retry projection, read from the default queue's Run
   * since feature 092 folded it under the queue that owns it. Returns the IDLE
   * constant when that queue owns no Run.
   */
  get delayedRetry(): DelayedRetryState {
    return this.defaultRuntime?.inFlightRun?.delayedRetry ?? IDLE_DELAYED_RETRY;
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
   * FR-R3-145 (T1572) — the queue settings, from the workspace memento.
   *
   * A sibling of `generalSettings` and not a field on it, because the two come
   * from different stores. The queue modal used to prefill from
   * `generalSettings.queueGlobalConcurrencyCap` — the *configuration* — and save
   * through `CMD_SAVE_QUEUE_SETTINGS`, which writes the *memento*. The value came
   * back unchanged and the operator's save read as lost. Same legacy-tolerance as
   * its neighbour: the IDLE constant when an older host omits the projection.
   */
  get queueSettings(): QueueSettingsProjection {
    return this._snapshot?.queueSettings ?? IDLE_QUEUE_SETTINGS;
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
    return this.phases.find((p) => p.name === name) ?? null;
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
    if (snap.schemaVersion !== 4) {
      if (!this._lastSchemaWarning) {
        console.warn('[schegent] dropping snapshot with unknown schemaVersion', snap.schemaVersion);
        this._lastSchemaWarning = true;
      }
      return;
    }
    // Feature 092 — `queues` replaces the root `phases` array as the structural
    // field worth sanity-checking: a malformed one would leave every run-scoped
    // read with no place to resolve against.
    if (!Array.isArray(snap.queues)) {
      if (!this._lastSchemaWarning) {
        console.warn('[schegent] dropping snapshot with malformed queues');
        this._lastSchemaWarning = true;
      }
      return;
    }
    this._snapshot = snap;
    // FR-R3-106 (FR-071) — a snapshot clears NOTHING by itself.
    //
    // THE DEFECT. This used to be `if (this._pending.size > 0) this._pending = new Set();`
    // — any accepted snapshot wiped the ENTIRE pending set, with no correlation filtering.
    // Snapshots arrive on a 1 Hz tick as well as on real state changes, so a tick unrelated
    // to any in-flight command re-enabled its button before the mutation landed. The
    // operator sees a control go live again and reasonably clicks it twice.
    //
    // The targeted clear already existed, eight lines above, and this path did not use it.
    //
    // WHY NOTHING IS CLEARED HERE AT ALL. A pending command is resolved by its
    // ACKNOWLEDGEMENT (`applyAck`), which carries the correlation id that identifies it. A
    // snapshot carries no correlation id, so it cannot say which command it resolves — and
    // guessing from "the state now looks like the mutation happened" is exactly the
    // inference that made an unrelated tick clear a live command. If a mutation lands and
    // its ack is lost, the pending entry is cleared by the ack timeout, not by a snapshot
    // that happens to arrive afterwards.
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
