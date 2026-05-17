import type {
  HistoryEntry,
  PhaseName,
  PhaseTile,
  QueueItem,
  QueueSummary,
  WorkflowSnapshot
} from './snapshot-types';
import type { PhaseLogSelectionDraft } from './phase-log-store.svelte';

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
        (snapshot.queue.inFlight ? 1 : 0)
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
    queueId: queueIdForItem(item),
    pipelineId: item.currentPipelineId ?? fallbackPipelineId(snapshot),
    currentPhase: item.currentPhase,
    status: item.status,
    updatedAt: item.completedAt ?? item.updatedAt ?? item.startedAt ?? item.enqueuedAt
  });

  const matchesQueue = (item: QueueItem): boolean => queueIdForItem(item) === queueId;
  if (snapshot.queue.inFlight && matchesQueue(snapshot.queue.inFlight)) {
    add(fromQueueItem(snapshot.queue.inFlight));
  }
  for (const item of snapshot.queue.pending.filter(matchesQueue)) add(fromQueueItem(item));
  for (const item of snapshot.queue.recent.filter(matchesQueue)) add(fromQueueItem(item));

  if (queueId === 'default') {
    for (const entry of snapshot.history) {
      add({
        id: entry.runId,
        label: entry.descriptionPreview,
        queueId: 'default',
        pipelineId: fallbackPipelineId(snapshot),
        currentPhase: null,
        status: entry.terminalStatus,
        updatedAt: entry.completedAt ?? entry.startedAt
      });
    }
  }

  return options;
}

export function getPhaseOptions(
  snapshot: WorkflowSnapshot,
  task: ActivityFeedTaskOption | null
): readonly ActivityFeedPhaseOption[] {
  const available = snapshot.availablePhases ?? [];
  const tilesByName = new Map(snapshot.phases.map((phase) => [phase.name, phase]));
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
  return snapshot.phases.map((phase) => ({
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

export function resolveLiveSelection(snapshot: WorkflowSnapshot): ActivityFeedSelection | null {
  const inFlight = snapshot.queue.inFlight;
  if (inFlight === null || inFlight.currentPhase === null) return null;
  const queueId = queueIdForItem(inFlight);
  const task = getTaskOptions(snapshot, queueId).find((candidate) => candidate.id === inFlight.id);
  return {
    queueId,
    taskId: inFlight.id,
    pipelineId: task?.pipelineId ?? inFlight.currentPipelineId ?? fallbackPipelineId(snapshot),
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

function fallbackPipelineId(snapshot: WorkflowSnapshot): string | null {
  return snapshot.activePipeline?.id ?? snapshot.availablePipelines?.[0]?.id ?? null;
}

function timeValue(value: string | null): number {
  if (value === null) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
