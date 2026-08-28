// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: GATED HERE.
// The tail itself is a read and stays available untrusted. The
// `phase-log-tail-started` / `-stopped` audit appends are writes, on a message
// the IPC gate deliberately does not cover; the gate is inside `appendAudit`
// below, which carries the whole argument.

import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { SanitizedLogger } from '../lib/logger';
import type { QueueManager } from '../queue/queue-manager';
import {
  PhaseLogTailRegistry,
  type PhaseLogTailSubscriptionToken,
  type PhaseLogTailRegistryAuditEvent
} from '../services/phase-log';
import type {
  PhaseLogEntryPushMessage,
  StartPhaseLogTailRequest,
  StartPhaseLogTailResponse,
  StopPhaseLogTailRequest,
  StopPhaseLogTailResponse
} from '../contracts/sidebar-ipc';
import type { StateProjector } from '../ui/sidebar/state-projector';

/**
 * The half of the tail wiring the sidebar router consumes, shaped to
 * `RouterDeps.phaseLogTailService` so extraction did not widen that contract.
 */
export interface PhaseLogTailService {
  start(req: StartPhaseLogTailRequest): Promise<StartPhaseLogTailResponse>;
  stop(req: StopPhaseLogTailRequest): Promise<StopPhaseLogTailResponse>;
}

export interface PhaseLogTailWiring {
  readonly phaseLogTailService: PhaseLogTailService;
  /**
   * Closes the forward reference described below. Called once, after
   * `registerStage2Ui` returns; pushes before it are dropped, not queued.
   */
  bindDashboardBridge(bridge: Pick<DashboardBridgeSink, 'postPhaseLogEntry'>): void;
  dispose(): void;
}

type DashboardBridgeSink = { postPhaseLogEntry(envelope: PhaseLogEntryPushMessage): void };

/**
 * Feature 020 — phase-log tail wiring (T049).
 *
 * The PhaseLogTailRegistry owns the cap-of-1 invariant per host and the
 * watcher mechanism (fs.watch vs polling) chosen at start time. Three
 * dispose paths converge here:
 *   1. webview-stop      — explicit CMD_STOP_PHASE_LOG_TAIL (handled in router)
 *   2. webview-dispose   — extension teardown via the returned `dispose()`
 *   3. phase-complete    — the in-flight task transitioned out
 *
 * Path (3) is derived from a projector subscription that watches
 * `queue.inFlight.id` transitions and fires every registered
 * listener exactly once with the leaving runId.
 *
 * Extracted from `extension.ts` rather than left inline because the whole block
 * has exactly two outward references — the service the router reads and the
 * bridge binding — and its registry, task-leave listener set and previous-id
 * cursor are otherwise private to it. Keeping them in the activation function
 * put three mutable locals in scope for the 300 lines that follow, where
 * nothing may touch them.
 */
export function createPhaseLogTailWiring(input: {
  readonly workspaceRoot: string;
  readonly projector: Pick<StateProjector, 'getCurrentSnapshot' | 'subscribe'>;
  readonly queue: Pick<QueueManager, 'findById'>;
  readonly auditWriter: Pick<AuditLogWriter, 'append'>;
  /**
   * FR-R3-136 (FR-005, FR-011) — read on every append, never captured. See the
   * gate inside `appendAudit` for why a tail needs this at all.
   */
  readonly isWorkspaceTrusted: () => boolean;
  readonly logger: SanitizedLogger;
}): PhaseLogTailWiring {
  const { workspaceRoot, projector, queue, auditWriter, isWorkspaceTrusted, logger } = input;

  let previousInFlightTaskId: string | null =
    projector.getCurrentSnapshot().queue.inFlight?.id ?? null;
  const taskLeaveListeners = new Set<(runId: string) => void>();
  const taskLeaveProjectorSub = projector.subscribe((snapshot) => {
    const nextId = snapshot.queue.inFlight?.id ?? null;
    if (previousInFlightTaskId !== null && previousInFlightTaskId !== nextId) {
      const leavingId = previousInFlightTaskId;
      for (const listener of taskLeaveListeners) {
        try {
          listener(leavingId);
        } catch (err) {
          logger.debug(
            `phase-log-tail: task-leave listener threw: ${(err as Error).message}`
          );
        }
      }
    }
    previousInFlightTaskId = nextId;
  });

  // Forward reference: the registry pushes through `dashboardBridge`,
  // which is constructed AFTER the router. The thunk resolves the
  // bridge at call time; pushes before the bridge exists are silently
  // dropped (the dashboard cannot be open yet).
  let dashboardBridgeRef: DashboardBridgeSink | null = null;
  const phaseLogTailRegistry = new PhaseLogTailRegistry({
    pushToWebview: (envelope) => {
      const bridge = dashboardBridgeRef;
      if (bridge === null) return;
      bridge.postPhaseLogEntry(envelope as PhaseLogEntryPushMessage);
    },
    sanitize: (s) => logger.sanitize(s),
    appendAudit: async (event: PhaseLogTailRegistryAuditEvent) => {
      // FR-R3-136 (FR-011) — THE TAIL IS A READ; RECORDING IT IS NOT.
      //
      // Found by T1525a's classification pass, not by the task list, and it is
      // the one producer act neither Phase A nor Phase B could have caught.
      // `CMD_START_PHASE_LOG_TAIL` is deliberately absent from
      // `MUTATING_COMMAND_TYPES`, so the router's trust gate never sees it — a
      // log view is exactly what the manifest's `limited` claim promises keeps
      // working in an untrusted window. But `PhaseLogTailRegistry.start()`
      // appends `phase-log-tail-started` here, and that append writes
      // `.schegent/audit.log`. So the message stays admitted and the write does
      // not happen: the operator still reads the log, and the untrusted folder
      // is still not written to.
      //
      // Reachable without this window having started anything, which is the part
      // worth spelling out: `start()` demands that the requested phase be in
      // flight, and "in flight" is a projection of PERSISTED state. A
      // `.schegent/` that arrives with the checkout — or a primary window
      // mid-drive right now — satisfies it in a window that has elected nothing
      // and spawned nothing.
      //
      // Losing the record costs little. No Run can start here, so the events are
      // "someone opened a log", and the append was already best-effort — the
      // catch below warns and continues. The info line keeps it observable.
      if (!isWorkspaceTrusted()) {
        logger.info(
          `phase-log-tail: audit append skipped, workspace is not trusted (${event.type})`
        );
        return;
      }
      const p = event.payload;
      const auditPayload: Record<string, unknown> = {
        sessionId: p.sessionId,
        queueId: p.queueId,
        taskId: p.taskId,
        pipelineId: p.pipelineId,
        phaseId: p.phaseId,
        iterationN: p.iterationN,
        outcome: p.outcome
      };
      if (p.mechanism !== undefined) auditPayload.mechanism = p.mechanism;
      if (p.reason !== undefined) auditPayload.reason = p.reason;
      try {
        await auditWriter.append({
          runId: p.taskId,
          phase: p.phaseId,
          iteration: typeof p.iterationN === 'number' ? p.iterationN : 0,
          eventType: event.type,
          payload: auditPayload,
          outcome: p.outcome === 'success' ? 'success' : 'failure'
        });
      } catch (err) {
        logger.warn(
          `phase-log-tail: audit append failed: ${(err as Error).message}`
        );
      }
    },
    onTaskNoLongerInFlight: (cb): PhaseLogTailSubscriptionToken => {
      taskLeaveListeners.add(cb);
      return {
        dispose: () => {
          taskLeaveListeners.delete(cb);
        }
      };
    },
    caps: { perFieldBytes: 65536 }
  });

  return {
    // Adapter: validate the selection against the current snapshot before
    // delegating to the registry. The "not-in-flight" failure surfaces a
    // typed wire-format reason so the webview can show the right empty
    // state instead of a generic internal-error.
    phaseLogTailService: {
      start: async (
        req: StartPhaseLogTailRequest
      ): Promise<StartPhaseLogTailResponse> => {
        const snap = projector.getCurrentSnapshot();
        const inFlight = snap.queue.inFlight;
        if (inFlight === null || inFlight.id !== req.selection.taskId) {
          return { outcome: 'failure', reason: 'not-in-flight' };
        }
        if (inFlight.currentPhase !== req.selection.phaseId) {
          return { outcome: 'failure', reason: 'not-in-flight' };
        }
        return phaseLogTailRegistry.start({
          workspaceRoot,
          selection: {
            queueId: req.selection.queueId,
            // Feature 020 BUG-001 — same runId resolution as the read
            // path. The tail registry resolves filesystem paths from
            // taskId, so we substitute the actual session directory UUID.
            taskId: queue.findById(req.selection.taskId)?.runId ?? req.selection.taskId,
            pipelineId: req.selection.pipelineId,
            phaseId: req.selection.phaseId,
            iterationN: req.selection.iterationN
          }
        });
      },
      stop: async (
        req: StopPhaseLogTailRequest
      ): Promise<StopPhaseLogTailResponse> =>
        phaseLogTailRegistry.stop(req.sessionId, 'webview-stop')
    },
    bindDashboardBridge: (bridge) => {
      dashboardBridgeRef = bridge;
    },
    dispose: () => {
      taskLeaveProjectorSub.dispose();
      void phaseLogTailRegistry.disposeAll('webview-dispose');
    }
  };
}
