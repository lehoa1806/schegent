// FR-R4-F04 (FR-031, S1 to S4) — the hourly evidence maintenance scheduler.
//
// WHY IT EXISTS. Retention ran at activation and at a Run's end, so an idle window that never started a Run
// kept expired evidence for as long as it stayed open. This arms one interval that runs the maintenance
// pass (`evidence-maintenance-pass.ts`) on an idle owner window.
//
// WHAT IT DECIDES, AND NOTHING ELSE. Whether a tick may run a pass: trust first, then primacy, then the
// in-flight guard (S2). Any `false` returns without touching the filesystem. It imports nothing from VS
// Code, so the gate is exercised on fake timers by `evidence-maintenance-scheduler.test.ts`; the wiring
// (`activation/evidence-maintenance-wiring.ts`) supplies the real trust and primacy reads.
//
// NO OVERLAP, NO QUEUE (S3). A tick that lands during a pass returns at once and starts nothing; the next
// interval after the pass ends runs again. A queue would run a burst of passes after a long one.
//
// DISPOSAL (S4). `dispose()` clears the interval. A pass in flight is not cancelled (Node cannot abort an
// in-flight rename), it finishes, and its completion starts nothing. A primacy read that completes after
// disposal runs no pass.

import type { Scheduler, SchedulerHandle } from '../../state/lock';

/** One pass when armed, then one per hour (data-model §12). */
export const EVIDENCE_MAINTENANCE_INTERVAL_MS = 3_600_000;

/** What one pass did, as counts. Never a path, a Run id or content (S5, FR-031). */
export interface EvidenceMaintenanceReport {
  readonly transportFilesRemoved: number;
  readonly transportFilesCompacted: number;
  readonly sessionGroupsRemoved: number;
  readonly sessionBytesRemoved: number;
}

export interface EvidenceMaintenanceDeps {
  readonly scheduler: Scheduler;
  readonly isTrusted: () => boolean;
  readonly hasPrimacy: () => Promise<boolean>;
  readonly runPass: () => Promise<EvidenceMaintenanceReport>;
}

export type EvidenceMaintenanceState = 'idle' | 'in-flight' | 'disposed';

export interface EvidenceMaintenanceScheduler {
  state(): EvidenceMaintenanceState;
  dispose(): void;
}

/** Arms the interval and starts the first tick at once. */
export function createEvidenceMaintenanceScheduler(deps: EvidenceMaintenanceDeps): EvidenceMaintenanceScheduler {
  let state: EvidenceMaintenanceState = 'idle';
  let handle: SchedulerHandle | null = null;
  // Read through a call, so each check after an `await` sees what another tick or `dispose()` wrote.
  const stateNow = (): EvidenceMaintenanceState => state;

  const tick = async (): Promise<void> => {
    if (stateNow() === 'disposed' || !deps.isTrusted()) return;
    if (!(await deps.hasPrimacy())) return;
    // The guard is read after the primacy await, not before it: two ticks can both be waiting on the read,
    // and only the first to return may start the pass. Disposal can also have landed during the read.
    if (stateNow() !== 'idle') return;
    state = 'in-flight';
    try {
      await deps.runPass();
    } finally {
      if (stateNow() === 'in-flight') state = 'idle';
    }
  };

  // The pass reports its own failures (the router per step, the retention service by code), and a timer
  // callback has no caller to throw to, so a rejection ends this tick and the next one runs.
  const run = (): void => {
    void tick().catch(() => undefined);
  };

  handle = deps.scheduler.setInterval(run, EVIDENCE_MAINTENANCE_INTERVAL_MS);
  run();

  return {
    state: () => state,
    dispose: () => {
      if (stateNow() === 'disposed') return;
      state = 'disposed';
      handle?.clear();
      handle = null;
    }
  };
}
