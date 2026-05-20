import type { PhaseName, PhaseTile, QueueProjection, SubProgress } from './snapshot-types';

export interface SidebarStats {
  readonly done: number;
  readonly pending: number;
  readonly failed: number;
}

export interface ActivePhaseDescriptor {
  readonly name: PhaseName;
  readonly displayName?: string;
  readonly subProgress: SubProgress | null;
}

export function deriveSidebarStats(
  phases: readonly PhaseTile[],
  queue: QueueProjection
): SidebarStats {
  let done = 0;
  let phasePending = 0;
  for (const p of phases) {
    if (p.state === 'completed' || p.state === 'skipped') {
      done++;
    } else if (p.state === 'not-started' || p.state === 'active') {
      phasePending++;
    }
  }
  const queuePending = queue.pending.length;
  const queueFailed = queue.recent.filter((i) => i.status === 'failed').length;
  return {
    done,
    pending: phasePending + queuePending,
    failed: queueFailed
  };
}

export function deriveActivePhase(phases: readonly PhaseTile[]): ActivePhaseDescriptor | null {
  for (const p of phases) {
    if (p.state === 'active') {
      return { name: p.name, displayName: p.displayName, subProgress: p.subProgress };
    }
  }
  return null;
}
