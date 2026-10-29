// ---------------------------------------------------------------------------
// FR-R4-F16 (feature 244, contract E2 and E3; research R9, R10) — pass 2 of the failed-row census,
// first half: apply the cutoff, open one episode per failed terminal record, resolve its queue, follow
// moves, and walk to the first next event.
//
// Pure. It reads the compact log and the snapshot and returns a draft per episode: where the walk
// stopped, which event ended it, whether it passed a gap, and how many other tasks started in its
// queue meanwhile. `census-outcome.ts` turns a draft into its one outcome.
//
// ONE SWEEP, NOT ONE WALK PER EPISODE. The log is read once, in order, with the open episodes indexed
// by Run, by task, by queue and by task and queue. An event touches only the episodes it can end, so a
// log with many failures and many events costs time in their sum, not their product. "Starts of other
// tasks in the queue" is a per-queue counter and each episode keeps the counter's value when it joined,
// so a start costs one increment however many episodes are open in that queue. A gap marker that
// counts is one increment too, and an episode that never ended is gapped when the counter moved.
//
// Order is the log's order (D7). Stamps place an event against the cutoff and nothing else, so a
// backwards stamp is counted by the log builder and changes no episode.
// ---------------------------------------------------------------------------

import type { CensusCause, CensusEvent, CensusLog, QueueSnapshot } from './census-model';

type StartedEvent = Extract<CensusEvent, { kind: 'started' }>;
type RemovedEvent = Extract<CensusEvent, { kind: 'removed' }>;
type MovedEvent = Extract<CensusEvent, { kind: 'moved' }>;
type EndedEvent = Extract<CensusEvent, { kind: 'ended' }>;
type GapEvent = Extract<CensusEvent, { kind: 'gap' }>;

/** The events that end an episode: research R10's list. A move is never one. */
export type EndingEvent = Extract<
  CensusEvent,
  { kind: 'started' | 'removed' | 'queue-deleted' | 'queue-cleared' | 'queue-cleared-all' }
>;

/** One episode as the walk left it, before its outcome is decided. */
export interface EpisodeDraft {
  readonly runId: string;
  readonly position: number;
  readonly taskId: string;
  readonly seq: number;
  readonly failedAtMs: number;
  readonly cause: CensusCause;
  /** The queue the walk stopped in; `null` when no single queue could be named. */
  readonly queueId: string | null;
  /** The first next event, or `null` when none ended the episode before the cutoff. */
  readonly end: EndingEvent | null;
  /** The walk passed a marker that counts as missing history before it stopped. */
  readonly gapped: boolean;
  readonly laterStartsInQueue: number;
}

export interface EpisodeCollection {
  /** Log order. */
  readonly drafts: readonly EpisodeDraft[];
  readonly failedEndsRead: number;
  readonly failedEndsAfterCutoff: number;
  readonly collapsedDuplicates: number;
  readonly entriesAfterCutoff: number;
}

type Draft = { -readonly [K in keyof EpisodeDraft]: EpisodeDraft[K] };

/** An episode the sweep is still following. */
interface OpenEpisode {
  readonly draft: Draft;
  queue: string;
  /** The first queue and the target of every move already followed. */
  readonly path: Set<string>;
  startsAtJoin: number;
  readonly gapsAtOpen: number;
}

/** A two-level index of open episodes, so a lookup never builds a key out of two log strings. */
class PairIndex {
  private readonly outer = new Map<string, Map<string, Set<OpenEpisode>>>();

  public get(first: string, second: string): readonly OpenEpisode[] {
    return [...(this.outer.get(first)?.get(second) ?? [])];
  }

  public add(first: string, second: string, episode: OpenEpisode): void {
    let inner = this.outer.get(first);
    if (inner === undefined) {
      inner = new Map();
      this.outer.set(first, inner);
    }
    let set = inner.get(second);
    if (set === undefined) {
      set = new Set();
      inner.set(second, set);
    }
    set.add(episode);
  }

  public delete(first: string, second: string, episode: OpenEpisode): void {
    this.outer.get(first)?.get(second)?.delete(episode);
  }
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, new Set([value]));
  else existing.add(value);
}

// A move is refused, as a move off the path is, when it would follow more open episodes of one task, or
// take one episode through more queues, than these. A real task holds one or two open episodes, because
// its next start in their queue ends them, so only a planted log reaches either. Without them a log of
// failures and moves of one task costs time in their product.
const MAX_EPISODES_FOLLOWED_PER_MOVE = 16;
const MAX_QUEUES_ON_PATH = 32;

/** A task's removals that name a queue, in log order: those that name no Run, and those of each Run. */
interface TaskRemovals {
  readonly anyRun: RemovedEvent[];
  readonly byRun: Map<string, RemovedEvent[]>;
}

/** The first of `removals`, which are in log order, after `seq`. A binary search. */
function firstAfter(removals: readonly RemovedEvent[] | undefined, seq: number): RemovedEvent | undefined {
  if (removals === undefined) return undefined;
  let low = 0;
  let high = removals.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((removals[middle] as RemovedEvent).seq > seq) high = middle;
    else low = middle + 1;
  }
  return removals[low];
}

/** Every queue in `met` is on `path`. Never longer than `path`, which is bounded. */
function isOnPath(met: Set<string> | undefined, path: Set<string>): boolean {
  if (met === undefined) return true;
  if (met.size > path.size) return false;
  for (const queue of met) if (!path.has(queue)) return false;
  return true;
}

/** Applies the cutoff, forms the episodes and walks each to its first next event. */
export function collectEpisodes(log: CensusLog, snapshot: QueueSnapshot): EpisodeCollection {
  const cutoffMs = snapshot.cutoffMs;

  // E2: events stamped after the cutoff are ignored and counted; gap markers carry no stamp and stay.
  let failedEndsRead = 0;
  let failedEndsAfterCutoff = 0;
  let entriesAfterCutoff = 0;
  const events: CensusEvent[] = [];
  for (const event of log.events) {
    if (event.kind === 'gap') {
      events.push(event);
      continue;
    }
    const isFailedEnd = event.kind === 'ended' && event.failed;
    if (isFailedEnd) failedEndsRead += 1;
    if (event.stampMs > cutoffMs) {
      entriesAfterCutoff += 1;
      if (isFailedEnd) failedEndsAfterCutoff += 1;
      continue;
    }
    events.push(event);
  }

  // The queues a task id is met in (E3.3), and the removals and snapshot rows queue resolution reads.
  const queuesMet = new Map<string, Set<string>>();
  const removalsByTask = new Map<string, TaskRemovals>();
  for (const event of events) {
    if (event.kind === 'started') addTo(queuesMet, event.taskId, event.queueId);
    if (event.kind === 'removed' && event.queueId !== null) {
      addTo(queuesMet, event.taskId, event.queueId);
      let removals = removalsByTask.get(event.taskId);
      if (removals === undefined) {
        removals = { anyRun: [], byRun: new Map() };
        removalsByTask.set(event.taskId, removals);
      }
      if (event.runId === null) {
        removals.anyRun.push(event);
        continue;
      }
      const own = removals.byRun.get(event.runId);
      if (own === undefined) removals.byRun.set(event.runId, [event]);
      else own.push(event);
    }
  }
  const snapshotQueuesByTask = new Map<string, string[]>();
  for (const queue of snapshot.queues) {
    for (const row of queue.rows) {
      addTo(queuesMet, row.taskId, queue.queueId);
      const list = snapshotQueuesByTask.get(row.taskId);
      if (list === undefined) snapshotQueuesByTask.set(row.taskId, [queue.queueId]);
      else list.push(queue.queueId);
    }
  }

  const drafts: Draft[] = [];
  let collapsedDuplicates = 0;

  // Sweep state.
  const startCounter = new Map<string, number>();
  const startsIn = (queue: string): number => startCounter.get(queue) ?? 0;
  let gapCounter = 0;
  const lastStartQueueByRun = new Map<string, string>();
  const failureSinceStart = new Map<string, boolean>();
  const positionByRun = new Map<string, number>();
  const metSoFar = new Map<string, Set<string>>();

  const open = new Set<OpenEpisode>();
  const byRun = new Map<string, Set<OpenEpisode>>();
  const byTask = new Map<string, Set<OpenEpisode>>();
  const byQueue = new Map<string, Set<OpenEpisode>>();
  const byTaskQueue = new PairIndex();

  const index = (episode: OpenEpisode): void => {
    open.add(episode);
    addTo(byRun, episode.draft.runId, episode);
    addTo(byTask, episode.draft.taskId, episode);
    addTo(byQueue, episode.queue, episode);
    byTaskQueue.add(episode.draft.taskId, episode.queue, episode);
  };
  const unindex = (episode: OpenEpisode): void => {
    open.delete(episode);
    byRun.get(episode.draft.runId)?.delete(episode);
    byTask.get(episode.draft.taskId)?.delete(episode);
    byQueue.get(episode.queue)?.delete(episode);
    byTaskQueue.delete(episode.draft.taskId, episode.queue, episode);
  };
  const copyOf = (set: Set<OpenEpisode> | undefined): readonly OpenEpisode[] => [...(set ?? [])];

  /** Folds the starts seen in the episode's current queue since it joined it into its count. */
  const settleStarts = (episode: OpenEpisode): void => {
    episode.draft.laterStartsInQueue += startsIn(episode.queue) - episode.startsAtJoin;
  };

  const close = (episode: OpenEpisode, end: EndingEvent): void => {
    unindex(episode);
    settleStarts(episode);
    episode.draft.queueId = episode.queue;
    episode.draft.end = end;
  };

  // E3.3: the Run's own latest start; else, when the task id is met in at most one queue, the first
  // removal that names a queue, then the one snapshot row.
  const resolveQueue = (failure: EndedEvent): string | null => {
    const started = lastStartQueueByRun.get(failure.runId);
    if (started !== undefined) return started;
    const met = queuesMet.get(failure.taskId);
    if (met !== undefined && met.size > 1) return null;
    const removals = removalsByTask.get(failure.taskId);
    const anyRun = firstAfter(removals?.anyRun, failure.seq);
    const ownRun = firstAfter(removals?.byRun.get(failure.runId), failure.seq);
    const first = ownRun !== undefined && (anyRun === undefined || ownRun.seq < anyRun.seq) ? ownRun : anyRun;
    if (first !== undefined) return first.queueId as string;
    const rows = snapshotQueuesByTask.get(failure.taskId);
    return rows !== undefined && rows.length === 1 ? (rows[0] as string) : null;
  };

  const openEpisode = (failure: EndedEvent): void => {
    if (failureSinceStart.get(failure.runId) === true) {
      collapsedDuplicates += 1;
      return;
    }
    failureSinceStart.set(failure.runId, true);
    const position = (positionByRun.get(failure.runId) ?? 0) + 1;
    positionByRun.set(failure.runId, position);
    const draft: Draft = {
      runId: failure.runId,
      position,
      taskId: failure.taskId,
      seq: failure.seq,
      failedAtMs: failure.stampMs,
      cause: failure.cause,
      queueId: null,
      end: null,
      gapped: false,
      laterStartsInQueue: 0
    };
    drafts.push(draft);
    const queue = resolveQueue(failure);
    if (queue === null) return;
    index({ draft, queue, path: new Set([queue]), startsAtJoin: startsIn(queue), gapsAtOpen: gapCounter });
  };

  const handleStart = (event: StartedEvent): void => {
    for (const episode of copyOf(byRun.get(event.runId))) close(episode, event);
    for (const episode of byTaskQueue.get(event.taskId, event.queueId)) close(episode, event);
    startCounter.set(event.queueId, startsIn(event.queueId) + 1);
    lastStartQueueByRun.set(event.runId, event.queueId);
    failureSinceStart.set(event.runId, false);
    addTo(metSoFar, event.taskId, event.queueId);
  };

  const handleRemoval = (event: RemovedEvent): void => {
    if (event.queueId === null) return;
    for (const episode of byTaskQueue.get(event.taskId, event.queueId)) close(episode, event);
    addTo(metSoFar, event.taskId, event.queueId);
  };

  // E3.4: a move is followed when every queue the task has been met in so far is on the episode's
  // path and within the bounds above, and refused otherwise. A refused move ends the walk with no single
  // queue.
  const handleMove = (event: MovedEvent): void => {
    const met = metSoFar.get(event.taskId);
    const ofTask = byTask.get(event.taskId);
    const refuseAll = ofTask !== undefined && ofTask.size > MAX_EPISODES_FOLLOWED_PER_MOVE;
    for (const episode of copyOf(ofTask)) {
      if (!refuseAll && event.toQueueId === episode.queue) continue;
      const pathHasRoom = episode.path.size < MAX_QUEUES_ON_PATH || episode.path.has(event.toQueueId);
      const follows = !refuseAll && pathHasRoom && isOnPath(met, episode.path);
      unindex(episode);
      settleStarts(episode);
      if (!follows) {
        episode.draft.queueId = null;
        continue;
      }
      episode.queue = event.toQueueId;
      episode.path.add(event.toQueueId);
      episode.startsAtJoin = startsIn(event.toQueueId);
      index(episode);
    }
  };

  // A cut record and an unreadable segment always count. An unparseable or malformed marker counts only
  // when a parsed entry stamped at or before the cutoff follows it (research R10's gap table).
  const countsAsGap = (gap: GapEvent): boolean =>
    !('nextStampMs' in gap) || (gap.nextStampMs !== null && gap.nextStampMs <= cutoffMs);

  for (const event of events) {
    switch (event.kind) {
      case 'gap':
        if (countsAsGap(event)) gapCounter += 1;
        break;
      case 'started':
        handleStart(event);
        break;
      case 'ended':
        if (event.failed) openEpisode(event);
        break;
      case 'removed':
        handleRemoval(event);
        break;
      case 'moved':
        handleMove(event);
        break;
      case 'queue-deleted':
      case 'queue-cleared':
        for (const episode of copyOf(byQueue.get(event.queueId))) close(episode, event);
        break;
      case 'queue-cleared-all':
        for (const episode of [...open]) close(episode, event);
        break;
    }
  }

  // Whatever is still open reached the cutoff with no next event.
  for (const episode of open) {
    settleStarts(episode);
    episode.draft.queueId = episode.queue;
    episode.draft.gapped = gapCounter > episode.gapsAtOpen;
  }

  return { drafts, failedEndsRead, failedEndsAfterCutoff, collapsedDuplicates, entriesAfterCutoff };
}
