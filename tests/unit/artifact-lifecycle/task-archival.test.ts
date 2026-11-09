// FR-R6-F05 (T038, US4) — terminal Task archival (AC-07, FR-016, FR-017, FR-019).
//
// Archival is opt-in: nothing archives before a policy is adopted. After adoption a resolved
// terminal Task archives once it falls outside its queue's newest 100 or is 30 days past terminal
// resolution. Unresolved Tasks, and terminal Tasks whose run still holds an unresolved control
// frame, never archive. The summary row commits before the caller sees the removal set, the outcome
// is copied verbatim, and detail past its expiry is labelled and reduced to aggregates.

import { beforeEach, describe, expect, it } from 'vitest';
import type { ControlFrameStatus } from '../../../src/contracts/control-ledger';
import type { MutationAuthority } from '../../../src/contracts/artifact-lifecycle/lifecycle-types';
import {
  DEFAULT_RETENTION_POLICY,
  type ArchivalQueueInput,
  type ArchivalTaskInput
} from '../../../src/contracts/artifact-lifecycle/retention-policy-types';
import {
  ArtifactRecordStore,
  DENY_ALL_ACCESS_POLICY,
  PreviewStore,
  ReferenceStore,
  type LifecycleContext
} from '../../../src/services/artifact-lifecycle';
import { adoptPolicy, previewPolicyAdoption } from '../../../src/services/artifact-lifecycle/retention-policy';
import {
  archiveTerminalTasks,
  expireArchivedDetail,
  listArchivedTasks,
  previewArchival
} from '../../../src/services/artifact-lifecycle/task-archival';
import { FULL, lifecycleFixture, NOW, type LifecycleFixture } from './lifecycle-fixture';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

type FrameMap = Map<string, readonly ControlFrameStatus[]>;

function contextAt(fx: LifecycleFixture, nowMs: number): LifecycleContext {
  let next = 0;
  const newId = (): string => `ta-${nowMs}-${(next += 1)}`;
  const now = (): number => nowMs;
  return {
    deps: {
      conn: fx.conn,
      nowMs: now,
      fs: fx.fs,
      probe: {
        observe: () => Promise.resolve({ exists: true, sizeBytes: 40, producerIdentity: 'writer', generation: null }),
        digestSha256: () => Promise.resolve(null)
      },
      audit: { recordLifecycleMutation: (record) => fx.audits.push(record) },
      scanRoots: [],
      accessPolicy: DENY_ALL_ACCESS_POLICY,
      resolveOwner: () => 'live',
      newId
    },
    records: new ArtifactRecordStore(fx.conn, now),
    previews: new PreviewStore(fx.conn, now, newId),
    references: new ReferenceStore(fx.conn, now),
    newId
  };
}

function task(taskId: string, resolvedAgoMs: number, overrides: Partial<ArchivalTaskInput> = {}): ArchivalTaskInput {
  return {
    taskId,
    status: 'completed',
    runId: `run-${taskId}`,
    terminalResolvedAtMs: NOW - resolvedAgoMs,
    outcome: 'completed',
    summary: { retryCount: 0, pipelineId: 'speckit' },
    retainedReferenceIds: [],
    ...overrides
  };
}

function adoptDefault(ctx: LifecycleContext): void {
  const preview = previewPolicyAdoption(ctx, DEFAULT_RETENTION_POLICY);
  if (!preview.ok) throw new Error(preview.refusal.code);
  const adopted = adoptPolicy(ctx, {
    previewId: preview.value.previewId,
    confirmation: 'confirmed',
    authority: FULL,
    policy: DEFAULT_RETENTION_POLICY
  });
  if (!adopted.ok) throw new Error(adopted.refusal.code);
}

function archive(
  ctx: LifecycleContext,
  queues: readonly ArchivalQueueInput[],
  frames: FrameMap = new Map(),
  authority: MutationAuthority = FULL
) {
  const lookup = (runId: string): readonly ControlFrameStatus[] => frames.get(runId) ?? [];
  const preview = previewArchival(ctx, queues, lookup);
  if (!preview.ok) throw new Error(preview.refusal.code);
  return archiveTerminalTasks(
    ctx,
    { previewId: preview.value.previewId, confirmation: 'confirmed', authority, queues },
    lookup
  );
}

function removedIds(result: ReturnType<typeof archive>): string[] {
  if (!result.ok) throw new Error(result.refusal.code);
  return result.value.removalSet.map((entry) => `${entry.queueId}/${entry.taskId}`).sort();
}

function rowCount(fx: LifecycleFixture): number | undefined {
  return fx.conn.scalar<number>('SELECT COUNT(*) FROM archived_task_summaries');
}

describe('task archival before a policy is adopted', () => {
  it('archives nothing', () => {
    const fx = lifecycleFixture();
    const ctx = contextAt(fx, NOW);
    const queues = [{ queueId: 'q1', tasks: [task('old', 365 * DAY_MS)] }];
    const preview = previewArchival(ctx, queues, () => []);
    if (!preview.ok) throw new Error(preview.refusal.code);
    expect(preview.value.kind).toBe('archival');
    expect(preview.value.summary.affectedCount).toBe(0);
    expect(archive(ctx, queues)).toEqual({ ok: true, value: { archived: 0, skipped: 0, removalSet: [] } });
    expect(rowCount(fx)).toBe(0);
  });
});

describe('task archival after adoption', () => {
  let fx: LifecycleFixture;
  let ctx: LifecycleContext;

  beforeEach(() => {
    fx = lifecycleFixture();
    ctx = contextAt(fx, NOW);
    adoptDefault(ctx);
  });

  it('archives Tasks beyond the newest 100 resolved terminal Tasks of each queue', () => {
    const busy = Array.from({ length: 102 }, (_, i) => task(`t${String(i).padStart(3, '0')}`, (i + 1) * MINUTE_MS));
    const quiet = [task('a', MINUTE_MS), task('b', 2 * MINUTE_MS)];
    const result = archive(ctx, [
      { queueId: 'busy', tasks: busy },
      { queueId: 'quiet', tasks: quiet }
    ]);
    expect(removedIds(result)).toEqual(['busy/t100', 'busy/t101']);
    expect(result.ok && result.value.archived).toBe(2);
  });

  it('archives Tasks 30 days past terminal resolution, whichever bound comes first', () => {
    const tasks = [task('fresh', 29 * DAY_MS), task('stale', 30 * DAY_MS), task('ancient', 400 * DAY_MS)];
    expect(removedIds(archive(ctx, [{ queueId: 'q1', tasks }]))).toEqual(['q1/ancient', 'q1/stale']);
  });

  it('never archives pending, in-flight or paused Tasks', () => {
    const tasks = [
      task('pending', 400 * DAY_MS, { status: 'pending', terminalResolvedAtMs: null }),
      task('in-flight', 400 * DAY_MS, { status: 'in-flight' }),
      task('paused', 400 * DAY_MS, { status: 'paused' })
    ];
    expect(removedIds(archive(ctx, [{ queueId: 'q1', tasks }]))).toEqual([]);
    expect(rowCount(fx)).toBe(0);
  });

  it.each<ControlFrameStatus>(['intervention-required', 'paused', 'waiting-handoff'])(
    'keeps a terminal Task whose run holds an unresolved %s frame',
    (status) => {
      const frames: FrameMap = new Map([['run-blocked', ['completed', status]]]);
      const tasks = [task('blocked', 400 * DAY_MS), task('settled', 400 * DAY_MS)];
      const result = archive(ctx, [{ queueId: 'q1', tasks }], frames);
      expect(removedIds(result)).toEqual(['q1/settled']);
      expect(result.ok && result.value.skipped).toBe(1);
    }
  );

  it('commits the summary row before the removal set is returned', () => {
    const result = archive(ctx, [{ queueId: 'q1', tasks: [task('old', 40 * DAY_MS), task('new', DAY_MS)] }]);
    if (!result.ok) throw new Error(result.refusal.code);
    for (const entry of result.value.removalSet) {
      const row = fx.conn.get<{ terminal_resolved_at_ms: number }>(
        'SELECT terminal_resolved_at_ms FROM archived_task_summaries WHERE queue_id = ? AND task_id = ?',
        entry.queueId,
        entry.taskId
      );
      expect(row).toEqual({ terminal_resolved_at_ms: NOW - 40 * DAY_MS });
    }
    expect(result.value.removalSet).toHaveLength(1);
  });

  it('returns no removal set when the summary cannot be persisted', () => {
    fx.conn.exec(
      `CREATE TRIGGER refuse_archive BEFORE INSERT ON archived_task_summaries BEGIN SELECT RAISE(ABORT, 'refused'); END`
    );
    const audited = fx.audits.length;
    expect(() => archive(ctx, [{ queueId: 'q1', tasks: [task('old', 40 * DAY_MS)] }])).toThrow();
    expect(rowCount(fx)).toBe(0);
    expect(fx.audits).toHaveLength(audited);
  });

  it('copies the outcome verbatim and keeps the summary and references while detail is retained', () => {
    const outcome = 'failed: provider exited 137 (Opensend run, "quoted")';
    const tasks = [task('old', 40 * DAY_MS, { status: 'failed', outcome, retainedReferenceIds: ['ref-1'] })];
    removedIds(archive(ctx, [{ queueId: 'q1', tasks }]));
    expect(fx.conn.scalar<string>('SELECT outcome FROM archived_task_summaries')).toBe(outcome);
    const page = listArchivedTasks(ctx, { queueId: 'q1' });
    if (!page.ok) throw new Error(page.refusal.code);
    expect(page.value.entries).toEqual([
      {
        queueId: 'q1',
        taskId: 'old',
        outcome,
        terminalResolvedAtMs: NOW - 40 * DAY_MS,
        archivedAtMs: NOW,
        summary: { retryCount: 0, pipelineId: 'speckit' },
        retainedReferenceIds: ['ref-1'],
        detailExpiresAtMs: NOW - 40 * DAY_MS + DEFAULT_RETENTION_POLICY.terminalDetailMaxAgeMs,
        detailState: 'retained',
        coverage: 'full'
      }
    ]);
    expect(page.value.nextCursor).toBeNull();
  });

  it('labels detail past its expiry as expired with aggregates-only coverage', () => {
    removedIds(archive(ctx, [{ queueId: 'q1', tasks: [task('old', 40 * DAY_MS, { retainedReferenceIds: ['ref-1'] })] }]));
    const later = contextAt(fx, NOW + 60 * DAY_MS);
    const labelled = listArchivedTasks(later, { queueId: 'q1' });
    if (!labelled.ok) throw new Error(labelled.refusal.code);
    expect(labelled.value.entries.at(0)).toMatchObject({
      outcome: 'completed',
      detailState: 'expired',
      coverage: 'aggregates-only',
      summary: {},
      retainedReferenceIds: []
    });
    expect(expireArchivedDetail(later)).toEqual({ ok: true, value: { expired: 1 } });
    expect(fx.conn.get('SELECT detail_state, summary_json, retained_reference_ids_json FROM archived_task_summaries')).toEqual({
      detail_state: 'expired',
      summary_json: '{}',
      retained_reference_ids_json: '[]'
    });
    expect(expireArchivedDetail(later)).toEqual({ ok: true, value: { expired: 0 } });
  });

  it('keeps detail before its expiry', () => {
    removedIds(archive(ctx, [{ queueId: 'q1', tasks: [task('old', 40 * DAY_MS)] }]));
    expect(expireArchivedDetail(contextAt(fx, NOW + 49 * DAY_MS))).toEqual({ ok: true, value: { expired: 0 } });
  });

  it('archives once and still returns a Task the hot list kept', () => {
    const queues = [{ queueId: 'q1', tasks: [task('old', 40 * DAY_MS)] }];
    removedIds(archive(ctx, queues));
    const again = archive(contextAt(fx, NOW + 1), queues);
    expect(removedIds(again)).toEqual(['q1/old']);
    expect(again.ok && again.value.archived).toBe(0);
    expect(rowCount(fx)).toBe(1);
  });

  it('refuses a preview taken before the queue changed', () => {
    const original = [task('old', 40 * DAY_MS)];
    const preview = previewArchival(ctx, [{ queueId: 'q1', tasks: original }], () => []);
    if (!preview.ok) throw new Error(preview.refusal.code);
    const changed = [{ queueId: 'q1', tasks: [...original, task('older', 50 * DAY_MS)] }];
    const result = archiveTerminalTasks(
      ctx,
      { previewId: preview.value.previewId, confirmation: 'confirmed', authority: FULL, queues: changed },
      () => []
    );
    expect(result.ok ? undefined : result.refusal.code).toBe('preview-stale');
    expect(rowCount(fx)).toBe(0);
  });

  it('refuses an untrusted workspace and writes nothing', () => {
    const result = archive(ctx, [{ queueId: 'q1', tasks: [task('old', 40 * DAY_MS)] }], new Map(), { ...FULL, trusted: false });
    expect(result.ok ? undefined : result.refusal.code).toBe('untrusted-workspace');
    expect(rowCount(fx)).toBe(0);
  });

  it.each([
    ['a malformed queue id', [{ queueId: 'a/b', tasks: [] }]],
    ['a malformed task id', [{ queueId: 'q1', tasks: [task('../x', DAY_MS)] }]],
    ['a duplicate task', [{ queueId: 'q1', tasks: [task('t', DAY_MS), task('t', DAY_MS)] }]],
    ['a duplicate queue', [{ queueId: 'q1', tasks: [] }, { queueId: 'q1', tasks: [] }]],
    ['a null task', [{ queueId: 'q1', tasks: [null] }]],
    ['a null queue', [null]]
  ])('refuses %s as invalid-input', (_label, queues) => {
    const preview = previewArchival(ctx, queues as never, () => []);
    expect(preview.ok ? undefined : preview.refusal.code).toBe('invalid-input');
  });

  it('pages archived Tasks by cursor', () => {
    const tasks = Array.from({ length: 3 }, (_, i) => task(`t${i}`, (40 + i) * DAY_MS));
    removedIds(archive(ctx, [{ queueId: 'q1', tasks }]));
    const first = listArchivedTasks(ctx, { queueId: 'q1', pageSize: 2 });
    if (!first.ok) throw new Error(first.refusal.code);
    expect(first.value.entries.map((entry) => entry.taskId)).toEqual(['t0', 't1']);
    const cursor = first.value.nextCursor ?? undefined;
    const second = listArchivedTasks(ctx, { queueId: 'q1', pageSize: 2, cursor });
    if (!second.ok) throw new Error(second.refusal.code);
    expect(second.value.entries.map((entry) => entry.taskId)).toEqual(['t2']);
    expect(second.value.nextCursor).toBeNull();
  });
});
