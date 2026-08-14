// Feature 093 (T051, US1) — one `ProjectorBookkeeping` per Run.
//
// The bookkeeper accumulates across ticks: elapsed time, cumulative paused
// time, per-phase durations, sub-progress counters, and the last activity line.
// One instance for the whole window was correct while the window held one Run;
// with N it would interleave N Runs' timings into one set of counters, and the
// operator would read whichever Run happened to tick last.
//
// Keyed by **run id**, not queue id, for the same reason `SchegentStatusBar` is
// (T050) and on the T048 precedent: an audit entry names its Run and never its
// queue, so a queue-keyed registry would have to resolve a queue for every
// appended line. Run ids are unique across queues, so the two keyings agree on
// which counters belong together and only the run-id one is reachable from the
// data the callers hold.

import type { AuditEntry } from '../../audit/audit-entry';
import type { ClaudeCliMonitor } from '../../monitor/claude-cli-monitor';
import type { RunStateMap } from '../../state/run-state-migrator';
import { ProjectorBookkeeping } from './projector-bookkeeping';
import type { AuditTailEntry } from './snapshot';

type MonitorLifecycle = Pick<ClaudeCliMonitor, 'onWorkflowPaused' | 'onWorkflowResumed'> | null;

export class ProjectorBookkeepingRegistry {
  private readonly byRun = new Map<string, ProjectorBookkeeping>();

  constructor(private readonly monotonicNow: () => number) {}

  /**
   * The bookkeeper for one Run, created on first sight.
   *
   * Creating on demand rather than on reconcile is what keeps an audit line
   * attributable when it arrives before the projection that would have
   * introduced its Run — the store write and the audit append are separate
   * events and the projection between them is debounced.
   */
  public for(runId: string): ProjectorBookkeeping {
    const existing = this.byRun.get(runId);
    if (existing) return existing;
    const created = new ProjectorBookkeeping(this.monotonicNow);
    this.byRun.set(runId, created);
    return created;
  }

  /** Route an appended audit line to the Run that produced it. */
  public recordAudit(entry: AuditEntry, projected: AuditTailEntry): void {
    this.for(entry.runId).recordAudit(entry, projected);
  }

  /**
   * Advance every Run's bookkeeper and forget the ones no Run claims.
   *
   * A terminal Run stays in the record until its queue starts another, so its
   * timings survive for as long as the operator can still see its result;
   * pruning to the record is therefore the same reset the single bookkeeper
   * performed when its observed Run went away, not an earlier one.
   */
  public reconcile(runs: Readonly<RunStateMap>, monitor: MonitorLifecycle): void {
    const live = new Set(Object.values(runs).map((run) => run.id));
    for (const runId of [...this.byRun.keys()]) {
      if (!live.has(runId)) this.byRun.delete(runId);
    }
    for (const run of Object.values(runs)) {
      this.for(run.id).updateRun(run, monitor);
    }
  }

  /**
   * Whether any Run is in the executing state, which is what the projector's
   * 1 Hz tick exists to refresh. Asking the aggregate is the point: a Run
   * reaching a terminal status must not stop the tick a sibling Run still
   * needs.
   *
   * The status comparison itself lives in `ProjectorBookkeeping.isRunning`,
   * which owns the discriminator and is already allowlisted by the feature-017
   * stray-status-literal guard. This file is deliberately **not** allowlisted
   * there and has no reason to name the state at all — hence the roundabout
   * phrasing above. The guard greps text, so an allowlist entry added to
   * accommodate prose would also excuse a real literal here later.
   */
  public get anyRunning(): boolean {
    for (const bookkeeping of this.byRun.values()) {
      if (bookkeeping.isRunning) return true;
    }
    return false;
  }
}
