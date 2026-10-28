// FR-R4-F02 (spec 240, US3; contract S2; FR-027, FR-029; SC-004) — the spend bound, fed by the real
// audit writer.
//
// The watcher's unit tests hand it hand-built payloads, and they carried the usage as FLAT keys.
// The writer's projection nests usage under `metrics`, so a bound that read only the flat keys
// found nothing in any real row and reported every run "unmeasurable" without ever pausing one.
// Nothing in the unit tier could see that: it exercised the reader with a shape the writer does not
// produce. This test removes the gap by construction. The rows are appended through the real
// `AuditLogWriter.append`, which projects them, and the real `SpendBoundWatcher` subscribes to the
// writer exactly as the activation wiring does, over a real `WorkspaceStateStore`.
//
// A `claude` phase reports USD and is bounded in USD; a `codex` phase reports tokens and is bounded
// in tokens. Each pauses at the FIRST phase boundary at or over its bound and not below it, and the
// pause is the operator-resumable pair, never a terminal transition.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../src/lib/logger';
import { createSpendBoundWatcher } from '../../src/services/spend-bound-watcher';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { unfencedCommit } from '../../src/state/ownership-claim';
import { LIVE_RUN_STATUSES, type WorkflowRun } from '../../src/state/workflow-run';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import type { BackendRunnerKind } from '../../src/contracts/backend-kinds';
import { waitForCondition } from '../wait-for-condition';

class FakeMemento implements Memento {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

const PHASE = 'speckit-plan';
const LIMIT_USD = 2;
const LIMIT_TOKENS = 1_000;

let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'schegent-spend-real-writer-'));
});

afterAll(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true });
});

function runFor(runner: BackendRunnerKind): WorkflowRun {
  const now = Date.now();
  return {
    id: `run-${runner}`,
    featureId: `task-${runner}`,
    featureDir: `specs/240-${runner}`,
    status: 'running',
    currentPhase: PHASE,
    currentIteration: 1,
    startedAt: now,
    lastTransitionAt: now,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    creditPause: null,
    defaultRunnerKind: runner,
    pipeline: { id: 'p', name: 'P', phases: [{ id: PHASE, name: 'Plan', instruction: 'plan' }] }
  } as unknown as WorkflowRun;
}

interface Rig {
  readonly store: WorkspaceStateStore;
  readonly writer: AuditLogWriter;
  readonly notices: string[];
  readonly appendUsage: (usage: Record<string, number>) => Promise<void>;
  readonly pausedCause: () => string | null;
}

async function rigFor(runner: BackendRunnerKind): Promise<Rig> {
  const workspace = join(root, runner);
  await mkdir(workspace, { recursive: true });
  const logger = new SanitizedLogger();
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  const run = runFor(runner);
  await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
  const writer = new AuditLogWriter({ workspaceRoot: workspace }, logger);
  const notices: string[] = [];
  const watcher = createSpendBoundWatcher({
    config: () => ({ limitUsd: LIMIT_USD, limitTokens: LIMIT_TOKENS }),
    findRunById: (runId) => store.findRunById(runId),
    pause: async (queueId, paused) => {
      await store.updateRun(
        queueId,
        {
          runId: paused.id,
          allowedStatuses: LIVE_RUN_STATUSES,
          label: 'spend-pause',
          patch: (current) =>
            current.manualPauseAt !== null
              ? {}
              : { manualPauseAt: paused.manualPauseAt, manualPauseCause: paused.manualPauseCause }
        },
        unfencedCommit('test-fixture')
      );
    },
    notify: (message) => notices.push(message),
    logger,
    now: () => Date.now()
  });
  writer.subscribe(watcher.onAuditEntry);
  return {
    store,
    writer,
    notices,
    appendUsage: async (usage) => {
      await writer.append({
        runId: run.id,
        phase: PHASE,
        iteration: 1,
        eventType: 'phase-end',
        outcome: 'success',
        payload: { outcome: 'clean', exitCode: 0, terminationReason: 'token', metrics: usage }
      });
    },
    pausedCause: () => store.getRun(DEFAULT_QUEUE_ID)?.manualPauseCause ?? null
  };
}

describe('a claude phase under a USD bound (US3-1, SC-004)', () => {
  it('does not pause below the bound, and pauses at the first boundary that reaches it', async () => {
    const rig = await rigFor('claude');
    await rig.appendUsage({ totalCostUsd: 1.2 });
    expect(rig.pausedCause()).toBeNull();

    await rig.appendUsage({ totalCostUsd: 0.7 });
    expect(rig.pausedCause()).toBeNull();

    await rig.appendUsage({ totalCostUsd: 0.1 });
    await waitForCondition(() => rig.pausedCause() === 'spend-bound-reached', {
      label: 'the spend pause at the boundary that reached $2'
    });
    expect(rig.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('running');
  });

  it('a total exactly at the bound pauses (at or over)', async () => {
    const rig = await rigFor('claude');
    await rig.appendUsage({ totalCostUsd: 2 });
    await waitForCondition(() => rig.pausedCause() === 'spend-bound-reached', {
      label: 'the spend pause at a total equal to the bound'
    });
  });
});

describe('a codex phase under a token bound (US3-2, SC-004)', () => {
  it('does not pause below the bound, and pauses at the first boundary that reaches it', async () => {
    const rig = await rigFor('codex');
    await rig.appendUsage({ inputTokens: 400, outputTokens: 100 });
    expect(rig.pausedCause()).toBeNull();

    await rig.appendUsage({ inputTokens: 300, outputTokens: 100 });
    expect(rig.pausedCause()).toBeNull();

    await rig.appendUsage({ inputTokens: 100, cacheReadInputTokens: 10 });
    await waitForCondition(() => rig.pausedCause() === 'spend-bound-reached', {
      label: 'the spend pause at the boundary that reached 1,000 tokens'
    });
  });

  it('a cost the backend does not report is not invented: tokens bound the phase, not dollars', async () => {
    const rig = await rigFor('codex');
    // A cost row on a token-denominated phase must neither pause on dollars nor be read as tokens.
    await rig.appendUsage({ totalCostUsd: 50 });
    expect(rig.pausedCause()).toBeNull();
  });
});

describe('every row counts once', () => {
  it('an unmeasurable denomination is reported once for the run, not once per row', async () => {
    const rig = await rigFor('claude');
    // A `claude` phase is bounded in USD, and these rows report tokens only: the denomination that
    // applies is not measurable, row after row.
    for (let row = 0; row < 5; row += 1) await rig.appendUsage({ inputTokens: 10 });
    expect(rig.notices).toHaveLength(1);
    expect(rig.notices[0]).not.toMatch(/\d/);
  });
});
