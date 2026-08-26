import type { AuditEntry } from '../../audit/audit-entry';
import type { ClaudeCliMonitor } from '../../monitor/claude-cli-monitor';
import type { WorkflowRun } from '../../state/workflow-run';
import {
  computeLiveActivity,
  computePhaseElapsedMs,
  computeWorkflowElapsedMs,
  type ActivityCache
} from './activity-timing';
import { computeSubProgressForTile } from './phase-projector';
import { mapRunStatus } from './run-projector';
import type { PhaseName } from '../../contracts/phase-identity';
import type {
  AuditTailEntry,
  LiveActivity,
  PhaseTile,
  WorkflowStatus
} from './snapshot';

type MonitorLifecycle = Pick<
  ClaudeCliMonitor,
  'onWorkflowPaused' | 'onWorkflowResumed'
> | null;

/** Owns elapsed-time, transition, activity, and per-phase ephemeral state. */
export class ProjectorBookkeeping {
  private workflowStartMonotonic: number | null = null;
  private phaseStartMonotonic: number | null = null;
  private readonly cumulativePhaseMs = new Map<PhaseName, number>();
  private cumulativePausedMs = 0;
  private pausedSinceMonotonic: number | null = null;
  private lastActivityAtMonotonic: number | null = null;
  private lastActivityCache: ActivityCache | null = null;
  private readonly subProgressByPhase = new Map<PhaseName, { current: number; total: number }>();
  private readonly phaseMessageByPhase = new Map<
    PhaseName,
    NonNullable<PhaseTile['phaseMessage']>
  >();
  private observedRunId: string | null = null;
  private observedPhase: PhaseName | null = null;
  private status: WorkflowStatus = 'idle';

  constructor(private readonly monotonicNow: () => number) {}

  /**
   * Feature 093 (T051) — a predicate, where this used to expose the whole
   * `observedStatus`. Its one consumer is the registry's `anyRunning`, and the
   * pinned status literal belongs on this side of that call: this file is on
   * the `no-running-state-literal` allowlist because it owns the discriminator,
   * and answering with a boolean keeps the registry off it.
   */
  public get isRunning(): boolean { return this.status === 'running'; }

  public recordAudit(entry: AuditEntry, projected: AuditTailEntry): void {
    if (projected.category !== 'system') {
      this.lastActivityAtMonotonic = this.monotonicNow();
      this.lastActivityCache = {
        summary: projected.summary,
        category: projected.category,
        isoAt: projected.timestamp
      };
    }
    const phaseName = entry.phase === 'done' ? null : (entry.phase as PhaseName);
    if (!phaseName) return;
    if (
      entry.eventType === 'phase-message-emitted'
      || entry.eventType === 'phase-message-truncated'
      || entry.eventType === 'phase-message-invalid'
    ) {
      this.phaseMessageByPhase.set(phaseName, {
        fromPhaseId: typeof entry.payload.phaseId === 'string'
          ? entry.payload.phaseId : phaseName,
        entryCount: typeof entry.payload.entryCount === 'number'
          ? entry.payload.entryCount : 0,
        byteSize: typeof entry.payload.byteSize === 'number'
          ? entry.payload.byteSize : 0,
        truncated: entry.eventType === 'phase-message-truncated',
        invalidReason: entry.eventType === 'phase-message-invalid'
          ? String(entry.payload.reason ?? 'invalid') : null
      });
    }
    const completed = entry.payload?.tasksCompleted;
    const total = entry.payload?.tasksTotal;
    if (
      typeof completed !== 'number' || typeof total !== 'number'
      || !Number.isFinite(completed) || !Number.isFinite(total)
      || completed < 0 || total <= 0
    ) return;
    const existing = this.subProgressByPhase.get(phaseName);
    const current = existing
      ? Math.max(existing.current, Math.floor(completed))
      : Math.floor(completed);
    this.subProgressByPhase.set(phaseName, {
      current: Math.min(current, Math.floor(total)),
      total: Math.floor(total)
    });
  }

  /**
   * Feature 093 (T051) — the `cancelTick` callback this took is gone. The tick
   * belongs to the window, not to a Run, and one bookkeeper per Run means a Run
   * reaching a terminal status would otherwise cancel the tick a sibling Run is
   * still using. `ProjectorBookkeepingRegistry.anyRunning` answers for the
   * window instead, and the projector cancels from that.
   */
  public updateRun(run: WorkflowRun | null, monitor: MonitorLifecycle): void {
    const now = this.monotonicNow();
    if (!run) {
      if (this.observedRunId !== null) this.resetRunState();
      this.observedRunId = null;
      this.observedPhase = null;
      this.status = 'idle';
      return;
    }
    const nextStatus = mapRunStatus(run);
    const nextPhase = run.currentPhase === 'done'
      ? null : (run.currentPhase as PhaseName);
    // Feature 093 (T040) — justified survivor of the identity-reconciliation
    // sweep. This is a memoization change-detector, not a slot check: elapsed
    // and cumulative timings are accumulated across ticks, so the bookkeeper
    // resets them when the Run it is measuring changes. `observedRunId` is its
    // own remembered subject, not a re-read of shared state, so there is no
    // second source to reconcile against. T050/T051 give the projector one
    // bookkeeper per queue; the comparison then answers the same question about
    // a narrower subject and stays correct either way.
    if (run.id !== this.observedRunId) {
      this.workflowStartMonotonic = now;
      this.phaseStartMonotonic = nextPhase === null ? null : now;
      this.cumulativePhaseMs.clear();
      this.cumulativePausedMs = 0;
      this.pausedSinceMonotonic = nextStatus === 'paused' ? now : null;
      this.subProgressByPhase.clear();
      this.phaseMessageByPhase.clear();
      this.observedRunId = run.id;
      this.observedPhase = nextPhase;
      this.status = nextStatus;
      return;
    }
    if (this.status === 'running' && nextStatus === 'paused') {
      this.pausedSinceMonotonic = now;
      try { monitor?.onWorkflowPaused(); } catch { /* isolation */ }
    } else if (this.status === 'paused' && nextStatus === 'running') {
      if (this.pausedSinceMonotonic !== null) {
        this.cumulativePausedMs += now - this.pausedSinceMonotonic;
        this.pausedSinceMonotonic = null;
      }
      try { monitor?.onWorkflowResumed(); } catch { /* isolation */ }
    }
    if (this.observedPhase !== nextPhase) {
      if (this.observedPhase !== null && this.phaseStartMonotonic !== null) {
        const prior = this.cumulativePhaseMs.get(this.observedPhase) ?? 0;
        this.cumulativePhaseMs.set(
          this.observedPhase,
          Math.max(0, prior + Math.max(0, now - this.phaseStartMonotonic))
        );
        this.subProgressByPhase.delete(this.observedPhase);
      }
      this.phaseStartMonotonic = nextPhase === null ? null : now;
    }
    this.observedPhase = nextPhase;
    this.status = nextStatus;
  }

  public decoratePhases(phases: PhaseTile[], run: WorkflowRun | null): void {
    for (const tile of phases) {
      const message = this.phaseMessageByPhase.get(tile.name);
      if (message) (tile as { phaseMessage?: PhaseTile['phaseMessage'] }).phaseMessage = message;
      const mutable = tile as { -readonly [K in keyof PhaseTile]: PhaseTile[K] };
      mutable.elapsedMs = computePhaseElapsedMs({
        phaseName: tile.name,
        isActive: tile.state === 'active',
        cumulativePhaseMs: this.cumulativePhaseMs,
        phaseStartMonotonic: this.phaseStartMonotonic,
        pausedSinceMonotonic: this.pausedSinceMonotonic,
        status: this.status,
        monotonicNow: this.monotonicNow
      });
      mutable.subProgress = computeSubProgressForTile(
        tile, run, this.subProgressByPhase.get(tile.name)
      );
    }
  }

  public liveActivity(status: WorkflowStatus): LiveActivity {
    return computeLiveActivity({
      status,
      lastActivityAtMonotonic: this.lastActivityAtMonotonic,
      pausedSinceMonotonic: this.pausedSinceMonotonic,
      cache: this.lastActivityCache,
      monotonicNow: this.monotonicNow
    });
  }

  public workflowElapsedMs(status: WorkflowStatus): number | null {
    return computeWorkflowElapsedMs({
      status,
      workflowStartMonotonic: this.workflowStartMonotonic,
      pausedSinceMonotonic: this.pausedSinceMonotonic,
      cumulativePausedMs: this.cumulativePausedMs,
      monotonicNow: this.monotonicNow
    });
  }

  private resetRunState(): void {
    this.workflowStartMonotonic = null;
    this.phaseStartMonotonic = null;
    this.cumulativePhaseMs.clear();
    this.cumulativePausedMs = 0;
    this.pausedSinceMonotonic = null;
    this.lastActivityAtMonotonic = null;
    this.lastActivityCache = null;
    this.subProgressByPhase.clear();
    this.phaseMessageByPhase.clear();
  }
}
