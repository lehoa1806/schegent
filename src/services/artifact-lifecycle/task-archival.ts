/**
 * FR-R6-F05 (US4) — terminal Task archival (FR-016, FR-017, FR-019, AC-07).
 *
 * Opt-in: before a policy is adopted nothing archives. After adoption a Task
 * whose status is terminal archives once it falls outside its queue's newest
 * `archivalHotListBound` resolved terminal Tasks, or once `archivalMaxAgeMs`
 * has passed since terminal resolution, whichever comes first. A Task whose
 * run still holds an unresolved control frame never archives.
 *
 * The queue memento stays the live authority (research R9): the caller passes
 * the Tasks it holds, this module commits each summary row and only then
 * returns the removal set the caller applies to its hot list.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { createHash } from 'node:crypto';
import type { ControlFrameStatus } from '../../contracts/control-ledger';
import {
  INVENTORY_CURSOR_PATTERN,
  INVENTORY_PAGE_MAX_ENTRIES,
  type ArchivedTaskSummary,
  type LifecycleResult,
  type RetentionPolicy,
  type RetentionPreview,
  type RetentionPreviewSummary
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import {
  RESOLVED_CONTROL_FRAME_STATUSES,
  type ArchivalQueueInput,
  type ArchivalRemoval,
  type ArchivalRequest,
  type ArchivalResult,
  type ArchivalTaskInput,
  type ArchivedDetailExpiry,
  type ArchivedTaskEntry,
  type ArchivedTaskListRequest,
  type ArchivedTaskPage,
  type RunFrameStatusLookup
} from '../../contracts/artifact-lifecycle/retention-policy-types';
import { isTerminalRequestStatus } from '../../queue/feature-request';
import type { LifecycleContext } from './lifecycle-context';
import { inImmediateTransaction, isNonNegativeInteger, isOpaqueId, ok, refuse } from './lifecycle-results';
import { runAuthorizedMutation } from './mutation-authority';
import { readAdoptedPolicy } from './retention-policy';

/** The most kept Tasks an archival preview names; the rest are counted only. */
export const ARCHIVAL_PREVIEW_MAX_EXCEPTIONS = 100;

const EXPIRED_SUMMARY_JSON = '{}';
const EXPIRED_REFERENCES_JSON = '[]';

/** Whether a frame in `status` still needs a decision or an intervention; terminal frames are resolved. */
export function isUnresolvedFrameStatus(status: ControlFrameStatus): boolean {
  return !RESOLVED_CONTROL_FRAME_STATUSES.includes(status);
}

type Placement = 'archive' | 'already-archived' | 'kept';

interface PlannedTask {
  readonly queueId: string;
  readonly task: ArchivalTaskInput;
  readonly placement: Placement;
}

interface ArchivalPlan {
  readonly basis: string;
  readonly summary: RetentionPreviewSummary;
  readonly policy: RetentionPolicy | null;
  readonly tasks: readonly PlannedTask[];
}

/** The caller's summary arrives untyped at runtime; a type that rules out `null` does not make it so. */
function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isValidTask(task: ArchivalTaskInput): boolean {
  if (!isPlainRecord(task)) return false;
  if (!isOpaqueId(task.taskId) || typeof task.outcome !== 'string' || typeof task.status !== 'string') return false;
  if (task.runId !== null && !isOpaqueId(task.runId)) return false;
  if (task.terminalResolvedAtMs !== null && !isNonNegativeInteger(task.terminalResolvedAtMs)) return false;
  if (!Array.isArray(task.retainedReferenceIds) || !task.retainedReferenceIds.every(isOpaqueId)) return false;
  return isPlainRecord(task.summary) && Object.values(task.summary).every(isPrimitive);
}

function validateQueues(queues: readonly ArchivalQueueInput[]): string | null {
  if (!Array.isArray(queues)) return 'queues';
  const queueIds = new Set<string>();
  for (const queue of queues) {
    if (!isPlainRecord(queue)) return 'queue';
    if (!isOpaqueId(queue.queueId) || queueIds.has(queue.queueId) || !Array.isArray(queue.tasks)) return 'queueId';
    queueIds.add(queue.queueId);
    const taskIds = new Set<string>();
    for (const task of queue.tasks) {
      if (!isValidTask(task) || taskIds.has(task.taskId)) return 'task';
      taskIds.add(task.taskId);
    }
  }
  return null;
}

function archivedTaskIds(ctx: LifecycleContext, queueId: string): ReadonlySet<string> {
  const rows = ctx.deps.conn.all<{ task_id: string }>('SELECT task_id FROM archived_task_summaries WHERE queue_id = ?', queueId);
  return new Set(rows.map((row) => row.task_id));
}

/** Resolved terminal Tasks, newest first, ties broken by id so the rank is stable. */
function rankResolved(tasks: readonly ArchivalTaskInput[]): ArchivalTaskInput[] {
  return tasks
    .filter((task) => isTerminalRequestStatus(task.status) && task.terminalResolvedAtMs !== null)
    .sort((a, b) => (b.terminalResolvedAtMs ?? 0) - (a.terminalResolvedAtMs ?? 0) || a.taskId.localeCompare(b.taskId));
}

function planQueue(
  ctx: LifecycleContext,
  queue: ArchivalQueueInput,
  policy: RetentionPolicy,
  frameStatusesOf: RunFrameStatusLookup
): PlannedTask[] {
  const nowMs = ctx.deps.nowMs();
  const archived = archivedTaskIds(ctx, queue.queueId);
  const planned: PlannedTask[] = [];
  rankResolved(queue.tasks).forEach((task, rank) => {
    if (archived.has(task.taskId)) {
      planned.push({ queueId: queue.queueId, task, placement: 'already-archived' });
      return;
    }
    const age = nowMs - (task.terminalResolvedAtMs ?? nowMs);
    if (rank < policy.archivalHotListBound && age < policy.archivalMaxAgeMs) return;
    const blocked = task.runId !== null && frameStatusesOf(task.runId).some(isUnresolvedFrameStatus);
    planned.push({ queueId: queue.queueId, task, placement: blocked ? 'kept' : 'archive' });
  });
  return planned;
}

function summarize(tasks: readonly PlannedTask[], policyRevision: number): RetentionPreviewSummary {
  const removed = tasks.filter((item) => item.placement !== 'kept');
  const kept = tasks.filter((item) => item.placement === 'kept');
  const listed = kept.slice(0, ARCHIVAL_PREVIEW_MAX_EXCEPTIONS);
  const notes =
    policyRevision === 0
      ? ['no retention policy is adopted; nothing archives']
      : [
          `policy revision ${policyRevision} governs archival`,
          'archived summaries keep the outcome, terminal-resolution time and retained references',
          ...(kept.length > listed.length ? [`${kept.length - listed.length} further kept Tasks are counted but not listed`] : [])
        ];
  return {
    affectedCount: removed.length,
    affectedBytes: 0,
    protectedCount: kept.length,
    protectedBytes: 0,
    unclassifiedCount: 0,
    unclassifiedBytes: 0,
    perClass: [],
    protectedExceptions: listed.map((item) => ({ artifactId: item.task.taskId, reason: 'preserve-protected' as const })),
    coverage: 'complete',
    notes
  };
}

function planArchival(
  ctx: LifecycleContext,
  queues: readonly ArchivalQueueInput[],
  frameStatusesOf: RunFrameStatusLookup
): LifecycleResult<ArchivalPlan> {
  const invalid = validateQueues(queues);
  if (invalid !== null) return refuse('invalid-input', `${invalid} is malformed`);
  const adopted = readAdoptedPolicy(ctx.deps.conn);
  const policy = adopted?.policy ?? null;
  const tasks = policy === null ? [] : queues.flatMap((queue) => planQueue(ctx, queue, policy, frameStatusesOf));
  const policyRevision = adopted?.policyRevision ?? 0;
  const considered = tasks.map((item) => [item.queueId, item.task.taskId, item.placement, item.task.terminalResolvedAtMs]);
  const basis = createHash('sha256')
    .update(JSON.stringify({ kind: 'archival', policyRevision, policy, considered }))
    .digest('hex');
  return ok({ basis, summary: summarize(tasks, policyRevision), policy, tasks });
}

/** Persists and returns an `archival` preview over the Tasks the caller's queues hold. */
export function previewArchival(
  ctx: LifecycleContext,
  queues: readonly ArchivalQueueInput[],
  frameStatusesOf: RunFrameStatusLookup
): LifecycleResult<RetentionPreview> {
  const plan = planArchival(ctx, queues, frameStatusesOf);
  if (!plan.ok) return plan;
  return ok(ctx.previews.create('archival', plan.value.basis, plan.value.summary));
}

function insertSummary(ctx: LifecycleContext, item: PlannedTask, policy: RetentionPolicy, nowMs: number): boolean {
  const resolvedAt = item.task.terminalResolvedAtMs ?? nowMs;
  const detailExpiresAtMs = resolvedAt + policy.terminalDetailMaxAgeMs;
  const expired = detailExpiresAtMs <= nowMs;
  const inserted = ctx.deps.conn.run(
    `INSERT OR IGNORE INTO archived_task_summaries (queue_id, task_id, outcome, terminal_resolved_at_ms, archived_at_ms,
       summary_json, retained_reference_ids_json, detail_expires_at_ms, detail_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    item.queueId,
    item.task.taskId,
    item.task.outcome,
    resolvedAt,
    nowMs,
    expired ? EXPIRED_SUMMARY_JSON : JSON.stringify(item.task.summary),
    expired ? EXPIRED_REFERENCES_JSON : JSON.stringify(item.task.retainedReferenceIds),
    detailExpiresAtMs,
    expired ? 'expired' : 'retained'
  );
  return inserted.changes > 0;
}

/**
 * Archives the previewed Tasks. Every summary row commits in one transaction before the removal
 * set is returned; a failed write throws and returns no removal set. Tasks archived by an earlier
 * call that the hot list still holds are returned again, never rewritten.
 */
export function archiveTerminalTasks(
  ctx: LifecycleContext,
  request: ArchivalRequest,
  frameStatusesOf: RunFrameStatusLookup
): LifecycleResult<ArchivalResult> {
  const plan = planArchival(ctx, request.queues, frameStatusesOf);
  if (!plan.ok) return plan;
  const { policy, tasks } = plan.value;
  const deps = { previews: ctx.previews, audit: ctx.deps.audit };
  return runAuthorizedMutation(deps, request, 'archival', plan.value.basis, () => {
    const nowMs = ctx.deps.nowMs();
    const toArchive = tasks.filter((item) => item.placement === 'archive');
    const archived =
      policy === null
        ? 0
        : inImmediateTransaction(ctx.deps.conn, () =>
            toArchive.reduce((count, item) => count + (insertSummary(ctx, item, policy, nowMs) ? 1 : 0), 0)
          );
    const removalSet: ArchivalRemoval[] = tasks
      .filter((item) => item.placement !== 'kept')
      .map((item) => ({ queueId: item.queueId, taskId: item.task.taskId }));
    const skipped = tasks.length - removalSet.length;
    return {
      operationId: ctx.newId(),
      counts: { archived, skipped, removed: removalSet.length },
      result: 'completed',
      value: { archived, skipped, removalSet }
    };
  });
}

/** Reduces every archived summary past its detail expiry to its aggregates (FR-019). */
export function expireArchivedDetail(ctx: LifecycleContext): LifecycleResult<ArchivedDetailExpiry> {
  const changed = ctx.deps.conn.run(
    `UPDATE archived_task_summaries
       SET detail_state = 'expired', summary_json = ?, retained_reference_ids_json = ?
     WHERE detail_state = 'retained' AND detail_expires_at_ms <= ?`,
    EXPIRED_SUMMARY_JSON,
    EXPIRED_REFERENCES_JSON,
    ctx.deps.nowMs()
  );
  return ok({ expired: changed.changes });
}

interface ArchivedRow {
  readonly queue_id: string;
  readonly task_id: string;
  readonly outcome: string;
  readonly terminal_resolved_at_ms: number;
  readonly archived_at_ms: number;
  readonly summary_json: string;
  readonly retained_reference_ids_json: string;
  readonly detail_expires_at_ms: number;
  readonly detail_state: string;
}

function toEntry(row: ArchivedRow, nowMs: number): ArchivedTaskEntry {
  const expired = row.detail_state === 'expired' || row.detail_expires_at_ms <= nowMs;
  return {
    queueId: row.queue_id,
    taskId: row.task_id,
    outcome: row.outcome,
    terminalResolvedAtMs: row.terminal_resolved_at_ms,
    archivedAtMs: row.archived_at_ms,
    summary: expired ? {} : (JSON.parse(row.summary_json) as ArchivedTaskSummary['summary']),
    retainedReferenceIds: expired ? [] : (JSON.parse(row.retained_reference_ids_json) as string[]),
    detailExpiresAtMs: row.detail_expires_at_ms,
    detailState: expired ? 'expired' : 'retained',
    coverage: expired ? 'aggregates-only' : 'full'
  };
}

function decodeCursor(cursor: string | undefined): string | null | undefined {
  if (cursor === undefined) return undefined;
  if (!INVENTORY_CURSOR_PATTERN.test(cursor)) return null;
  const taskId = Buffer.from(cursor, 'base64url').toString('utf8');
  return isOpaqueId(taskId) ? taskId : null;
}

/** One page of a queue's archived Tasks in task-id order; expired detail is labelled, never shown. */
export function listArchivedTasks(ctx: LifecycleContext, request: ArchivedTaskListRequest): LifecycleResult<ArchivedTaskPage> {
  if (!isOpaqueId(request.queueId)) return refuse('invalid-input', 'queueId is malformed');
  const pageSize = request.pageSize ?? INVENTORY_PAGE_MAX_ENTRIES;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > INVENTORY_PAGE_MAX_ENTRIES) {
    return refuse('invalid-input', 'pageSize is malformed');
  }
  const after = decodeCursor(request.cursor);
  if (after === null) return refuse('invalid-input', 'cursor is malformed');
  const rows = ctx.deps.conn.all<ArchivedRow>(
    `SELECT * FROM archived_task_summaries WHERE queue_id = ? AND task_id > ? ORDER BY task_id LIMIT ?`,
    request.queueId,
    after ?? '',
    pageSize + 1
  );
  const nowMs = ctx.deps.nowMs();
  const page = rows.slice(0, pageSize);
  const last = page.at(-1);
  const nextCursor = rows.length > pageSize && last !== undefined ? Buffer.from(last.task_id, 'utf8').toString('base64url') : null;
  return ok({ entries: page.map((row) => toEntry(row, nowMs)), nextCursor });
}
