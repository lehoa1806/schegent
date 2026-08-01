import { randomUUID } from 'crypto';
import type { Disposable } from '../../state/workspace-state';
import type { ProjectorHandle, ProjectorListener } from './projector-handle';
import {
  AUDIT_TAIL_MAX,
  IDLE_DELAYED_RETRY,
  IDLE_EVIDENCE_HEALTH,
  IDLE_GENERAL_SETTINGS,
  IDLE_LIVE_ACTIVITY,
  IDLE_SESSION_ARTIFACTS,
  IDLE_TRUST_PROJECTION,
  IDLE_WAKEUP_LOG,
  IDLE_WAKEUP_PROJECTION,
  IDLE_WAKEUP_SETTINGS,
  SCHEMA_VERSION,
  buildEmptyPhases,
  type AuditTailEntry,
  type WorkflowSnapshot
} from './snapshot';

export type PlaceholderReason = 'no-workspace' | 'init-failed';

const REASON_SUMMARY: Record<PlaceholderReason, string> = {
  'no-workspace': 'Open a folder to enable Schegent.',
  'init-failed': 'Workspace state is incompatible — run Schegent: Reset Workspace State.'
};

export interface PlaceholderProjectorDeps {
  readonly reason: PlaceholderReason;
  readonly now?: () => Date;
}

export class PlaceholderProjector implements ProjectorHandle {
  private readonly snapshot: WorkflowSnapshot;
  private readonly listeners = new Set<ProjectorListener>();
  private readonly _reason: PlaceholderReason;

  public get reason(): PlaceholderReason {
    return this._reason;
  }

  constructor(deps: PlaceholderProjectorDeps) {
    this._reason = deps.reason;
    const now = deps.now ?? (() => new Date());
    const producedAt = now().toISOString();
    const guidance: AuditTailEntry = Object.freeze({
      id: randomUUID(),
      timestamp: producedAt,
      phase: null,
      category: 'system',
      summary: REASON_SUMMARY[deps.reason],
      // Feature 064 — synthetic placeholder is operator/system guidance, not
      // bound to a live run. Carry an empty runId and `'system'` scope so the
      // entry never satisfies the Activity Feed's reachable-runId filter.
      runId: '',
      scope: 'system' as const
    });
    const tail = Object.freeze([guidance]) as readonly AuditTailEntry[];
    this.snapshot = Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      isPrimary: true,
      status: 'idle' as const,
      activeFeature: null,
      phases: Object.freeze(buildEmptyPhases().map((p) => Object.freeze(p))),
      queue: Object.freeze({
        inFlight: null,
        pending: Object.freeze([]) as readonly never[],
        recent: Object.freeze([]) as readonly never[],
        orderedItems: Object.freeze([]) as readonly never[],
        queues: Object.freeze([]) as readonly never[],
        paused: false,
        pausedReason: null,
        lifecycle: 'active-empty' as const,
        scheduledStartAt: null,
        scheduledStartSource: null
      }),
      phaseOverrides: Object.freeze([]),
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: Object.freeze([]),
      resumeTargetPhaseId: null,
      activeRunId: null,
      defaultRunnerKind: 'claude',
      auditTail: tail.slice(-AUDIT_TAIL_MAX),
      debugLogTail: Object.freeze([]),
      liveActivity: IDLE_LIVE_ACTIVITY,
      workflowElapsedMs: null,
      monitor: null,
      history: Object.freeze([]) as readonly never[],
      producedAt,
      availablePipelines: Object.freeze([]) as readonly never[],
      availablePhases: Object.freeze([]) as readonly never[],
      availableModels: Object.freeze([]) as readonly never[],
      delayedRetry: IDLE_DELAYED_RETRY,
      generalSettings: IDLE_GENERAL_SETTINGS,
      sessionArtifacts: IDLE_SESSION_ARTIFACTS,
      evidenceHealth: IDLE_EVIDENCE_HEALTH,
      wakeUpSettings: IDLE_WAKEUP_SETTINGS,
      wakeUpLog: IDLE_WAKEUP_LOG,
      wakeUp: IDLE_WAKEUP_PROJECTION,
      // Feature 033 — telemetry is ephemeral; placeholder is always null.
      telemetry: null,
      // Feature 059 — fail-closed trust projection on placeholder.
      workspaceTrust: IDLE_TRUST_PROJECTION.workspaceTrust,
      resolvedTrust: IDLE_TRUST_PROJECTION.resolvedTrust
    });
  }

  public subscribe(listener: ProjectorListener): Disposable {
    this.listeners.add(listener);
    try {
      listener(this.snapshot);
    } catch {
      // listener errors must not propagate
    }
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  }

  public getCurrentSnapshot(): WorkflowSnapshot {
    return this.snapshot;
  }

  public dispose(): void {
    this.listeners.clear();
  }
}
