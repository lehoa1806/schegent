import type {
  HistoryEntry,
  PhaseName,
  PhaseTile,
  QueueItem,
  QueueRuntime,
  QueueSummary,
  WorkflowSnapshot
} from './snapshot-types';
import type { PhaseLogSelectionDraft } from './phase-log-store.svelte';
import { defaultQueueId, findQueueInFlightRow, findQueueRuntime } from './queue-runtime-view';

/**
 * Bug "the phase log that asked for a phase named done" (2026-09-02) — the
 * terminal state of the phase state machine, which is NOT a Phase.
 *
 * `src/controller/phase.ts` declares it as such at the `Phase` type itself:
 * nothing imports it as a catalog entry, `availablePhases` never lists it,
 * `phase-projector.ts` gives it no position in a strip, and the phase-log
 * service refuses any tuple naming it with `unknown-tuple`. But it is a
 * legitimate value of `WorkflowRun.currentPhase`, and `QueueItem.currentPhase`
 * is typed `PhaseName | null` — nothing in the type stops it reaching here.
 *
 * Named once because two surfaces read a task's current phase and turn it into
 * a phase-log tuple, and both must treat this value as "no current phase". The
 * host filters it out of the projection as well; this is the second line of
 * defence, at the sites where getting it wrong fails silently.
 */
export const TERMINAL_PHASE_SENTINEL = 'done';

export type ActivityFeedFollowMode = 'live' | 'manual';
export type ActivityFeedManualLevel = 'queue' | 'task' | 'phase' | null;

export interface ActivityFeedSelection extends PhaseLogSelectionDraft {
  readonly followMode: ActivityFeedFollowMode;
  readonly manualLevel: ActivityFeedManualLevel;
}

export interface ActivityFeedTaskOption {
  readonly id: string;
  readonly label: string;
  readonly queueId: string;
  readonly pipelineId: string | null;
  readonly currentPhase: PhaseName | null;
  readonly status: QueueItem['status'] | HistoryEntry['terminalStatus'] | 'history';
  readonly updatedAt: string | null;
}

export interface ActivityFeedPhaseOption {
  readonly id: string;
  readonly name: string;
  readonly order: number;
  readonly state: PhaseTile['state'] | null;
  readonly isCurrent: boolean;
}

export const EMPTY_ACTIVITY_FEED_SELECTION: ActivityFeedSelection = Object.freeze({
  queueId: null,
  taskId: null,
  pipelineId: null,
  phaseId: null,
  iterationN: null,
  followMode: 'live',
  manualLevel: null
});

export function toPhaseLogSelection(selection: ActivityFeedSelection): PhaseLogSelectionDraft {
  return {
    queueId: selection.queueId,
    taskId: selection.taskId,
    pipelineId: selection.pipelineId,
    phaseId: selection.phaseId,
    iterationN: selection.iterationN
  };
}

export function queueIdForItem(item: Pick<QueueItem, 'queueId'>): string {
  return item.queueId ?? 'default';
}

export function getQueueOptions(snapshot: WorkflowSnapshot): readonly QueueSummary[] {
  return snapshot.queue.queues ?? [
    {
      id: 'default',
      name: 'Default queue',
      position: 0,
      state: snapshot.queue.paused ? 'manually-paused' : 'active',
      pauseSource: snapshot.queue.paused ? 'operator' : null,
      schedule: null,
      taskCount:
        snapshot.queue.pending.length +
        snapshot.queue.recent.length +
        (snapshot.queue.inFlight ? 1 : 0),
      // Feature 195 (T039) — this fallback synthesizes a `QueueSummary` for a
      // host that predates the registry projection; no failure-policy read is
      // possible from `snapshot.queue` at all, so it reads as the literal
      // package default, exactly as an un-opinionated queue would.
      failurePolicy: 'halt-on-failure',
      failurePolicyOverride: null
    }
  ];
}

export function getTaskOptions(
  snapshot: WorkflowSnapshot,
  queueId: string | null
): readonly ActivityFeedTaskOption[] {
  if (queueId === null) return [];
  const options: ActivityFeedTaskOption[] = [];
  const seen = new Set<string>();
  const add = (option: ActivityFeedTaskOption): void => {
    if (option.id.length === 0 || seen.has(option.id)) return;
    seen.add(option.id);
    options.push(option);
  };

  const fromQueueItem = (item: QueueItem): ActivityFeedTaskOption => ({
    id: item.id,
    label: item.label,
    queueId,
    pipelineId: item.currentPipelineId ?? fallbackPipelineId(snapshot, queueId),
    currentPhase: item.currentPhase,
    status: item.status,
    updatedAt: item.completedAt ?? item.updatedAt ?? item.startedAt ?? item.enqueuedAt
  });

  // BUG-002 (FR-018) — the queue's own rows, from its runtime. `snapshot.queue`
  // projects the default queue only, so every other queue listed no Task. The
  // in-flight row still leads; the rest keep the host's position order.
  const rows = findQueueRuntime(snapshot, queueId)?.tasks ?? [];
  const inFlight = findQueueInFlightRow(rows);
  if (inFlight !== null) add(fromQueueItem(inFlight));
  for (const item of rows) add(fromQueueItem(item));

  // Its own history slice, matched on the entry's queue the way the host
  // matches it (FR-008), so every Task offered here is one the host accepts.
  for (const entry of snapshot.history) {
    if (entry.queueId !== queueId) continue;
    add({
      id: entry.runId,
      label: entry.descriptionPreview,
      queueId,
      pipelineId: fallbackPipelineId(snapshot, queueId),
      currentPhase: null,
      status: entry.terminalStatus,
      updatedAt: entry.completedAt ?? entry.startedAt
    });
  }

  return options;
}

export function getPhaseOptions(
  snapshot: WorkflowSnapshot,
  task: ActivityFeedTaskOption | null
): readonly ActivityFeedPhaseOption[] {
  const available = snapshot.availablePhases ?? [];
  // Feature 092 — tiles come from the queue that owns the selected task, so a
  // second queue's live run cannot colour this task's phase strip.
  const tiles =
    findQueueRuntime(snapshot, task?.queueId ?? defaultQueueId(snapshot))?.phases ?? [];
  const tilesByName = new Map(tiles.map((phase) => [phase.name, phase]));
  if (available.length > 0) {
    return available.map((phase, index) => {
      const tile = tilesByName.get(phase.id);
      return {
        id: phase.id,
        name: phase.name ?? phase.id,
        order: tile?.order ?? index + 1,
        state: tile?.state ?? null,
        isCurrent: task?.currentPhase === phase.id
      };
    });
  }
  return tiles.map((phase) => ({
    id: phase.name,
    name: phase.name,
    order: phase.order,
    state: phase.state,
    isCurrent: task?.currentPhase === phase.name
  }));
}

export function selectActivityFeedQueue(
  snapshot: WorkflowSnapshot,
  queueId: string
): ActivityFeedSelection {
  return resolveForQueue(snapshot, queueId, 'manual', 'queue');
}

export function selectActivityFeedTask(
  snapshot: WorkflowSnapshot,
  taskId: string
): ActivityFeedSelection {
  const found = findTask(snapshot, taskId);
  if (!found) {
    return { ...EMPTY_ACTIVITY_FEED_SELECTION, taskId, followMode: 'manual', manualLevel: 'task' };
  }
  return resolveForTask(snapshot, found, 'manual', 'task');
}

export function selectActivityFeedPhase(
  snapshot: WorkflowSnapshot,
  current: ActivityFeedSelection,
  phaseId: string
): ActivityFeedSelection {
  const base =
    current.taskId !== null
      ? current
      : (resolveLiveSelection(snapshot) ?? current);
  return {
    ...base,
    phaseId,
    iterationN: null,
    followMode: 'manual',
    manualLevel: 'phase'
  };
}

/**
 * BUG-002 (FR-021) — the Run "Live" means, chosen among the in-flight row of
 * every queue: the latest `startedAt` wins, a Run with a start time outranks one
 * without, and a tie goes to the queue with the lower `position`, so one
 * snapshot answers the same Run on every call. `null` when no queue has a Run in
 * flight. The row comes back carrying the queue it was found on, because the
 * store keys its identity tuple and its jump on `queueId`.
 */
export function currentInFlightRow(snapshot: Pick<WorkflowSnapshot, 'queues'>): QueueItem | null {
  let best: InFlightCandidate | null = null;
  for (const runtime of snapshot.queues) {
    const row = findQueueInFlightRow(runtime.tasks);
    if (row === null) continue;
    const candidate: InFlightCandidate = { row, runtime };
    if (best === null || outranks(candidate, best)) best = candidate;
  }
  if (best === null) return null;
  const { row, runtime } = best;
  return row.queueId === runtime.queueId ? row : { ...row, queueId: runtime.queueId };
}

/**
 * BUG-002 (FR-022) — the in-flight row of the queue `queueId` names, which is
 * the row a tail check reads. The host's start check reads the same row.
 */
export function queueInFlightRow(
  snapshot: Pick<WorkflowSnapshot, 'queues'>,
  queueId: string | null
): QueueItem | null {
  if (queueId === null) return null;
  return findQueueInFlightRow(findQueueRuntime(snapshot, queueId)?.tasks ?? []);
}

interface InFlightCandidate {
  readonly row: QueueItem;
  readonly runtime: Pick<QueueRuntime, 'queueId' | 'position'>;
}

function outranks(candidate: InFlightCandidate, incumbent: InFlightCandidate): boolean {
  const started = timeValue(candidate.row.startedAt) - timeValue(incumbent.row.startedAt);
  if (started !== 0) return started > 0;
  return candidate.runtime.position < incumbent.runtime.position;
}

export function resolveLiveSelection(snapshot: WorkflowSnapshot): ActivityFeedSelection | null {
  const inFlight = currentInFlightRow(snapshot);
  if (inFlight === null || inFlight.currentPhase === null) return null;
  const queueId = queueIdForItem(inFlight);
  const task = getTaskOptions(snapshot, queueId).find((candidate) => candidate.id === inFlight.id);
  return {
    queueId,
    taskId: inFlight.id,
    pipelineId: task?.pipelineId ?? inFlight.currentPipelineId ?? fallbackPipelineId(snapshot, queueId),
    phaseId: inFlight.currentPhase,
    iterationN: null,
    followMode: 'live',
    manualLevel: null
  };
}

export function jumpActivityFeedToCurrent(
  snapshot: WorkflowSnapshot,
  current: ActivityFeedSelection
): ActivityFeedSelection {
  return resolveLiveSelection(snapshot) ?? current;
}

// Feature 021 T043 (BUG-001 Defect A) — cold-start fallback.
//
// When the dashboard mounts and the Activity Feed has no live in-flight
// selection (resolveLiveSelection returned null), pick the most-recently
// updated recent task that actually has on-disk phase log iterations.
// The caller supplies `hasOnDiskIterations` because the webview cannot
// stat the filesystem directly; the host bridges that via a projection
// or IPC predicate.
//
// Tie-breaking rule: order by `updatedAt` desc, then `enqueuedAt` desc
// for tasks with equal `updatedAt`. This mirrors the dashboard's existing
// "newest-first" recent-history sort and keeps the fallback deterministic.
//
// Returns null when no candidate qualifies — the caller leaves the
// "No selection" empty state in place.
export function resolveColdStartFallback(
  snapshot: WorkflowSnapshot,
  hasOnDiskIterations: (taskId: string) => boolean
): ActivityFeedSelection | null {
  const candidates = snapshot.queue.recent.filter((item) => hasOnDiskIterations(item.id));
  if (candidates.length === 0) return null;
  const ranked = [...candidates].sort((a, b) => {
    const updated = timeValue(coldStartUpdatedAt(b)) - timeValue(coldStartUpdatedAt(a));
    if (updated !== 0) return updated;
    return timeValue(b.enqueuedAt) - timeValue(a.enqueuedAt);
  });
  const winner = ranked[0];
  if (!winner) return null;
  const queueId = queueIdForItem(winner);
  const taskOption = getTaskOptions(snapshot, queueId).find(
    (candidate) => candidate.id === winner.id
  );
  if (!taskOption) return null;
  const phase = pickBestPhase(snapshot, taskOption);
  return {
    queueId,
    taskId: taskOption.id,
    pipelineId: taskOption.pipelineId,
    phaseId: phase?.id ?? null,
    iterationN: null,
    followMode: 'manual',
    manualLevel: 'task'
  };
}

function coldStartUpdatedAt(item: QueueItem): string | null {
  return item.completedAt ?? item.updatedAt ?? item.startedAt ?? item.enqueuedAt;
}

export function reconcileActivityFeedSelection(
  snapshot: WorkflowSnapshot,
  current: ActivityFeedSelection
): ActivityFeedSelection {
  if (current.followMode === 'live') {
    const live = resolveLiveSelection(snapshot);
    if (live) return live;
  }

  if (current.queueId === null) return current;
  const queues = getQueueOptions(snapshot);
  const queueId = queues.some((queue) => queue.id === current.queueId)
    ? current.queueId
    : (queues[0]?.id ?? null);
  if (queueId === null) return { ...current, queueId: null, taskId: null, pipelineId: null, phaseId: null };

  const tasks = getTaskOptions(snapshot, queueId);
  const task =
    tasks.find((candidate) => candidate.id === current.taskId) ??
    pickBestTask(snapshot, queueId);
  if (!task) {
    return { ...current, queueId, taskId: null, pipelineId: null, phaseId: null, iterationN: null };
  }
  const phases = getPhaseOptions(snapshot, task);
  const canPreservePhase = task.id === current.taskId;
  const phase =
    (canPreservePhase ? phases.find((candidate) => candidate.id === current.phaseId) : null) ??
    pickBestPhase(snapshot, task);
  return {
    ...current,
    queueId,
    taskId: task.id,
    pipelineId: task.pipelineId,
    phaseId: phase?.id ?? null,
    iterationN: phase?.id === current.phaseId ? current.iterationN : null
  };
}

function resolveForQueue(
  snapshot: WorkflowSnapshot,
  queueId: string,
  followMode: ActivityFeedFollowMode,
  manualLevel: ActivityFeedManualLevel
): ActivityFeedSelection {
  const task = pickBestTask(snapshot, queueId);
  if (!task) {
    return {
      queueId,
      taskId: null,
      pipelineId: null,
      phaseId: null,
      iterationN: null,
      followMode,
      manualLevel
    };
  }
  return resolveForTask(snapshot, task, followMode, manualLevel);
}

function resolveForTask(
  snapshot: WorkflowSnapshot,
  task: ActivityFeedTaskOption,
  followMode: ActivityFeedFollowMode,
  manualLevel: ActivityFeedManualLevel
): ActivityFeedSelection {
  const phase = pickBestPhase(snapshot, task);
  return {
    queueId: task.queueId,
    taskId: task.id,
    pipelineId: task.pipelineId,
    phaseId: phase?.id ?? null,
    iterationN: null,
    followMode,
    manualLevel
  };
}

function pickBestTask(
  snapshot: WorkflowSnapshot,
  queueId: string
): ActivityFeedTaskOption | null {
  const tasks = getTaskOptions(snapshot, queueId);
  const active = tasks.find((task) => task.status === 'in-flight');
  if (active) return active;
  return [...tasks].sort((a, b) => timeValue(b.updatedAt) - timeValue(a.updatedAt))[0] ?? null;
}

function pickBestPhase(
  snapshot: WorkflowSnapshot,
  task: ActivityFeedTaskOption
): ActivityFeedPhaseOption | null {
  const phases = getPhaseOptions(snapshot, task);
  if (task.currentPhase !== null) {
    const current = phases.find((phase) => phase.id === task.currentPhase);
    if (current) return current;
  }
  const active = phases.find((phase) => phase.state === 'active');
  if (active) return active;
  const completed = [...phases]
    .filter((phase) => phase.state === 'completed')
    .sort((a, b) => b.order - a.order)[0];
  return completed ?? phases[0] ?? null;
}

function findTask(
  snapshot: WorkflowSnapshot,
  taskId: string
): ActivityFeedTaskOption | null {
  for (const queue of getQueueOptions(snapshot)) {
    const found = getTaskOptions(snapshot, queue.id).find((task) => task.id === taskId);
    if (found) return found;
  }
  return null;
}

// Feature 092 — the pipeline a task falls back to is the one in flight on *its
// own* queue, not a workspace-wide "active" pipeline: with concurrent runs there
// is no such thing, and borrowing a neighbour queue's would mislabel the task.
function fallbackPipelineId(snapshot: WorkflowSnapshot, queueId: string): string | null {
  const runtime = findQueueRuntime(snapshot, queueId);
  return runtime?.inFlightRun?.pipeline?.id ?? snapshot.availablePipelines?.[0]?.id ?? null;
}

function timeValue(value: string | null): number {
  if (value === null) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
