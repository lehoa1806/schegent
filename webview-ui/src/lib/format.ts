import type { PhaseName, WorkflowStatus } from './snapshot-types';

const BUILT_IN_PHASE_LABELS: Record<string, string> = {
  'speckit-specify': 'Spec-kit Specify',
  'speckit-clarify': 'Spec-kit Clarify',
  'speckit-plan': 'Spec-kit Plan',
  'speckit-tasks': 'Spec-kit Tasks',
  'speckit-analyze': 'Spec-kit Analyze',
  'speckit-implement': 'Spec-kit Implement',
  finalize: 'Finalize'
};

const STATUS_LABELS: Record<WorkflowStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  paused: 'Paused — waiting for credits',
  completed: 'Completed',
  failed: 'Failed',
  canceled: 'Canceled'
};

export function formatPhaseLabel(phase: PhaseName, displayName?: string): string {
  if (displayName && displayName.length > 0) return displayName;
  const builtIn = BUILT_IN_PHASE_LABELS[phase];
  if (builtIn) return builtIn;
  return phase
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function formatStatus(status: WorkflowStatus): string {
  return STATUS_LABELS[status];
}

export function formatIteration(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  return `iteration ${Math.floor(n)}`;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelativeTime(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const delta = nowMs - t;
  if (delta < 5 * SECOND) return 'just now';
  if (delta < MINUTE) return `${Math.floor(delta / SECOND)}s ago`;
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  return `${Math.floor(delta / DAY)}d ago`;
}
