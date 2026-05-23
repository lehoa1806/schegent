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

// Feature 068 — absolute, human-readable timestamp for System tab cells.
// Returns "YYYY-MM-DD HH:MM:SS" in the operator's local timezone. Falls
// back to the raw input when the ISO string fails to parse so the cell
// never renders as empty.
export function formatAbsoluteTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}
