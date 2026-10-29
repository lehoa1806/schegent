// FR-R4-F17 (feature 245; quickstart §3; SC-001, SC-002; US1-1, US1-3, US1-4) — the unchanged-metrics
// stop, end to end: a real controller, a real phase runner and a real audit writer, with a stub CLI that
// reports the figures a script gives it, and the bound set through the controller's live reader.
//
// The looping phase's retry condition reads one figure, `pending_tasks`. A second figure, `spec_gaps`,
// is printed in every block and is NOT read by the condition, so a change to it must not reset the
// count (US1-4). Later stories extend this file: US2 adds the replay with the bound off (T037) and US3
// adds the resume and lifecycle cases (T041).
import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import { failureNotice } from '../../src/services/failure-notice';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { SanitizedLogger } from '../../src/lib/logger';
import {
  buildCatalog,
  type PhaseDef,
  type PipelineDef
} from '../../src/config/pipeline-config';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { RawInvocationOutput, InvocationRequest } from '../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

function makeLock(): WorkspaceLockManager {
  return {
    release: vi.fn().mockResolvedValue(undefined),
    tryAcquire: vi.fn(async () => ({ acquired: false, owner: null })),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
}

function makeStubRunner(scripts: Array<() => RawInvocationOutput>): {
  runner: ClaudeCliRunner;
  invokeCount: { value: number };
} {
  const invokeCount = { value: 0 };
  const invoke = vi.fn(async (_req: InvocationRequest): Promise<RawInvocationOutput> => {
    const idx = invokeCount.value;
    invokeCount.value += 1;
    const fn = scripts[idx] ?? scripts[scripts.length - 1];
    return fn();
  });
  const runner = {
    invoke,
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
  return { runner, invokeCount };
}

function makeRaw(stdout: string, exitCode = 0): RawInvocationOutput {
  const stdoutBuffer = new ZippedStreamBuffer();
  stdoutBuffer.append(stdout);
  stdoutBuffer.finalize();
  const stderrBuffer = new ZippedStreamBuffer();
  stderrBuffer.finalize();

  return {
    stdoutBuffer,
    stderrBuffer,
    exitCode,
    killed: false,
    timedOut: false,
    durationMs: 1
  };
}

function block(phase: string, body: readonly string[]): string {
  return [
    '=== SCHEGENT AUDIT LOG ===',
    `phase: ${phase}`,
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: ["audit"]',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    'notes: ok',
    ...body,
    '=== END AUDIT LOG ==='
  ].join('\n');
}

const LOOP_PHASE_ID = 'implement-loop';

/** One dispatch's output: the judged figure and the unjudged one, with the status token after the block. */
function figures(pendingTasks: number, specGaps: number): () => RawInvocationOutput {
  return () =>
    makeRaw(
      `${block(LOOP_PHASE_ID, [`pending_tasks: ${pendingTasks}`, `spec_gaps: ${specGaps}`])}\n` +
        '[SCHEGENT_STATUS: CLEAR]'
    );
}

const LOOP_PHASE: PhaseDef = {
  id: LOOP_PHASE_ID,
  name: 'Implement Loop',
  instruction: 'Work the open tasks.',
  retryCondition: 'pending_tasks > 0'
};

const DONE_PHASE: PhaseDef = {
  id: 'done',
  name: 'Done',
  instruction: '(no-op)'
};

const LOOP_PIPELINE: PipelineDef = {
  id: 'stall',
  name: 'Stall Pipeline',
  phases: [LOOP_PHASE_ID, 'done']
};

function makeCatalog(loopPhase: PhaseDef = LOOP_PHASE) {
  return buildCatalog([loopPhase, DONE_PHASE], [LOOP_PIPELINE], { claude: [], codex: [], agy: [] }, 'stall');
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-no-progress-stop-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function readAuditLog(workspaceRoot: string): Promise<Array<Record<string, any>>> {
  const log = await fs.readFile(path.join(workspaceRoot, '.schegent', 'audit.log'), 'utf8');
  return log.trim().split('\n').map((l) => JSON.parse(l));
}

interface DriveOptions {
  readonly iterationCap?: number;
  /** The looping Phase's definition. Absent means `LOOP_PHASE`, which fails at its cap. */
  readonly phase?: PhaseDef;
  /** The live reader of the bound. Absent leaves the option unset, which is what a build without it is. */
  readonly getMaxUnchangedComparisons?: () => number;
}

async function makeController(scripts: Array<() => RawInvocationOutput>, options: DriveOptions = {}) {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);
  const { runner, invokeCount } = makeStubRunner(scripts);
  const phaseRunner = new PhaseRunner(runner, new PromptBuilder(), audit, logger);

  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  const queue = new QueueManager(store);

  const statusBar = { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
  const warn = vi.fn();
  const notifier = { info: vi.fn(), warn, error: vi.fn() } as unknown as Notifier;

  const controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    statusBar,
    notifier,
    logger,
    makeLock(),
    {
      cliPath: 'noop',
      cwd: tmpRoot,
      iterationCap: options.iterationCap ?? 10,
      timeoutMs: 1000,
      ...(options.getMaxUnchangedComparisons === undefined
        ? {}
        : { getMaxUnchangedComparisons: options.getMaxUnchangedComparisons })
    },
    // The lifecycle auditor writes `task-execution-ended` only when it is given the writer.
    { catalog: makeCatalog(options.phase), auditWriter: audit }
  );
  return { controller, queue, store, invokeCount, warn };
}

async function driveToEnd(scripts: Array<() => RawInvocationOutput>, options: DriveOptions = {}) {
  const harness = await makeController(scripts, options);
  const feature = await harness.queue.enqueue('Work the tasks', { pipelineId: 'stall' });
  await harness.controller.startNew(feature, 'specs/001-mock', { pipelineId: 'stall' });
  return { ...harness, run: harness.store.getRun(DEFAULT_QUEUE_ID)! };
}

describe('The unchanged-metrics stop, end to end (US1)', () => {
  it('SC-001: ten identical blocks, bound 2, cap 10 — three invocations, then a failed Run', async () => {
    const { run, invokeCount } = await driveToEnd([figures(3, 0)], {
      iterationCap: 10,
      getMaxUnchangedComparisons: () => 2
    });

    expect(invokeCount.value).toBe(3);
    expect(run.status).toBe('failed');
    expect(run.failureCause).toBe('judged_metrics_unchanged');
    expect(run.currentIteration).toBe(3);
    expect(run.lastError?.message).toBe('judged metrics unchanged before the iteration cap');
  });

  it('SC-001: the stopped iteration keeps its retry evaluation and its phase-end, and writes no cap row', async () => {
    const { invokeCount } = await driveToEnd([figures(3, 0)], {
      iterationCap: 10,
      getMaxUnchangedComparisons: () => 2
    });

    const lines = await readAuditLog(tmpRoot);
    const evaluated = lines.filter((l) => l.eventType === 'phase.retry_evaluated');
    expect(evaluated).toHaveLength(invokeCount.value);
    expect(evaluated.map((l) => l.payload.stalled)).toEqual([undefined, 1, 2]);
    const ends = lines.filter((l) => l.eventType === 'phase-end');
    expect(ends).toHaveLength(invokeCount.value);
    expect(ends.some((l) => l.payload.cause === 'cap_exhausted')).toBe(false);
    expect(ends.some((l) => l.payload.terminationReason === 'cap-exhausted')).toBe(false);
  });

  it('SC-001 control: the same script with the bound off runs to the cap and fails as cap_exhausted', async () => {
    const { run, invokeCount } = await driveToEnd([figures(3, 0)], { iterationCap: 10 });

    expect(invokeCount.value).toBe(10);
    expect(run.status).toBe('failed');
    expect(run.failureCause).toBe('cap_exhausted');
  });

  it.each([1, 2, 3, 4, 5])('SC-002: bound %i stops at iteration N + 1 and spawns nothing after', async (bound) => {
    const { run, invokeCount } = await driveToEnd([figures(3, 0)], {
      iterationCap: 10,
      getMaxUnchangedComparisons: () => bound
    });

    expect(run.status).toBe('failed');
    expect(run.failureCause).toBe('judged_metrics_unchanged');
    expect(run.currentIteration).toBe(bound + 1);
    expect(invokeCount.value).toBe(bound + 1);
  });

  it('US1-3: a change to the judged figure restarts the comparison, so the stop comes later', async () => {
    // Iterations: 3, 3 (count 1), 2 (changed, baseline), 2 (count 1), 2 (count 2, stop at 5).
    const { run, invokeCount } = await driveToEnd(
      [figures(3, 0), figures(3, 0), figures(2, 0), figures(2, 0), figures(2, 0)],
      { iterationCap: 10, getMaxUnchangedComparisons: () => 2 }
    );

    expect(invokeCount.value).toBe(5);
    expect(run.failureCause).toBe('judged_metrics_unchanged');
    expect(run.currentIteration).toBe(5);
  });

  it('US1-4: a falling figure the condition does not read leaves the count alone, and the notice says so', async () => {
    const { run, invokeCount, warn } = await driveToEnd(
      [figures(3, 5), figures(3, 4), figures(3, 3), figures(3, 2), figures(3, 1)],
      { iterationCap: 10, getMaxUnchangedComparisons: () => 2 }
    );

    expect(invokeCount.value).toBe(3);
    expect(run.failureCause).toBe('judged_metrics_unchanged');
    expect(run.currentIteration).toBe(3);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Work the condition does not measure may still have happened')
    );
  });
});

// FR-R4-F17 (feature 245; SC-003; US2-1 to US2-3) — nothing changes unless the bound applies. The same
// script that stops at iteration 3 under a bound of 2 runs to the cap, fails as `cap_exhausted` and
// writes the cap's rows when the bound is absent, 0 or out of range; and the cap, and a cap outcome of
// continue, keep their precedence over a bound that would otherwise have fired.
describe('Nothing changes unless the bound applies (US2)', () => {
  const NOTICE_TITLE = 'Work the tasks';

  async function expectCapFailure(drive: Awaited<ReturnType<typeof driveToEnd>>, iterations: number) {
    expect(drive.invokeCount.value).toBe(iterations);
    expect(drive.run.status).toBe('failed');
    expect(drive.run.failureCause).toBe('cap_exhausted');
    expect(drive.run.currentIteration).toBe(iterations);
    expect(drive.run.lastError?.message).toBe('cap_exhausted');

    const lines = await readAuditLog(tmpRoot);
    const ends = lines.filter((l) => l.eventType === 'phase-end');
    const lastEnd = ends.at(-1);
    if (lastEnd === undefined) throw new Error('no phase-end event was written');
    expect(lastEnd.payload.cause).toBe('cap_exhausted');
    expect(lastEnd.payload.terminationReason).toBe('cap-exhausted');
    expect(ends.filter((l) => l.payload.cause === 'cap_exhausted')).toHaveLength(1);
  }

  const OFF_READERS: ReadonlyArray<readonly [string, (() => number) | undefined]> = [
    ['absent', undefined],
    ['answering 0', () => 0],
    ['answering 50', () => 50],
    ['answering 2.5', () => 2.5]
  ];

  it.each(OFF_READERS)('SC-003: with the reader %s, ten invocations and a cap failure with the cap notice', async (_label, reader) => {
    const drive = await driveToEnd([figures(3, 0)], {
      iterationCap: 10,
      ...(reader === undefined ? {} : { getMaxUnchangedComparisons: reader })
    });

    await expectCapFailure(drive, 10);
    expect(drive.warn).toHaveBeenCalledTimes(1);
    expect(drive.warn).toHaveBeenCalledWith(
      failureNotice({
        cause: 'cap_exhausted',
        phase: LOOP_PHASE_ID,
        taskTitle: NOTICE_TITLE,
        iteration: 10,
        iterationCap: 10,
        stalledCount: 9,
        // The controller path writes F15's failure record, so the notice points at it.
        recordWritten: true
      }).message
    );
  });

  it('US2-2: with bound 2 and cap 3 the cap decides at iteration 3, as cap_exhausted', async () => {
    const drive = await driveToEnd([figures(3, 0)], {
      iterationCap: 3,
      getMaxUnchangedComparisons: () => 2
    });

    await expectCapFailure(drive, 3);
  });

  it('US2-3: bound 2 on a Phase that continues at its cap runs to the cap and continues', async () => {
    const { run, invokeCount } = await driveToEnd([figures(3, 0)], {
      iterationCap: 10,
      phase: { ...LOOP_PHASE, onRetryCap: 'continue' },
      getMaxUnchangedComparisons: () => 2
    });

    expect(invokeCount.value).toBe(10);
    expect(run.status).toBe('completed');
    expect(run).not.toHaveProperty('failureCause');
  });

  it('US2-3: bound 2 on a Phase that continues degraded at its cap runs to the cap and records the mark', async () => {
    const { run, invokeCount } = await driveToEnd([figures(3, 0)], {
      iterationCap: 10,
      phase: { ...LOOP_PHASE, onRetryCap: 'continue-degraded' },
      getMaxUnchangedComparisons: () => 2
    });

    expect(invokeCount.value).toBe(10);
    expect(run.status).toBe('completed');
    expect(run).not.toHaveProperty('failureCause');
    expect(run.degradedPhases).toEqual([{ phaseId: LOOP_PHASE_ID, condition: 'pending_tasks > 0' }]);
  });

  it('FR-010: a condition that names no figure has nothing to compare, so bound 2 runs it to the cap', async () => {
    const drive = await driveToEnd([figures(3, 0)], {
      iterationCap: 4,
      phase: { ...LOOP_PHASE, retryCondition: '1 > 0' },
      getMaxUnchangedComparisons: () => 2
    });

    await expectCapFailure(drive, 4);
  });

  it('FR-010: iterations that report none of the figures the condition names never stop the loop', async () => {
    // `pending_tasks < 1` is truthy while the figure is missing (a missing identifier reads as 0), and
    // nothing is measured, so the evaluator keeps no baseline and reports no count.
    const reportsOnlyTheOtherFigure = () =>
      makeRaw(`${block(LOOP_PHASE_ID, ['spec_gaps: 4'])}\n[SCHEGENT_STATUS: CLEAR]`);
    const drive = await driveToEnd([reportsOnlyTheOtherFigure], {
      iterationCap: 4,
      phase: { ...LOOP_PHASE, retryCondition: 'pending_tasks < 1' },
      getMaxUnchangedComparisons: () => 2
    });

    await expectCapFailure(drive, 4);
    const lines = await readAuditLog(tmpRoot);
    const evaluated = lines.filter((l) => l.eventType === 'phase.retry_evaluated');
    expect(evaluated).toHaveLength(4);
    expect(evaluated.every((l) => l.payload.stalled === undefined)).toBe(true);
  });

  it('control: the same script, cap and file with bound 2 on a Phase that fails at its cap stops at 3', async () => {
    const { run, invokeCount } = await driveToEnd([figures(3, 0)], {
      iterationCap: 10,
      getMaxUnchangedComparisons: () => 2
    });

    expect(invokeCount.value).toBe(3);
    expect(run.failureCause).toBe('judged_metrics_unchanged');
  });
});

// FR-R4-F17 (feature 245; contracts C6.1 to C6.5; FR-018, FR-019; SC-005; US3-3, US3-4, US3-6) — a stopped
// Run is recoverable by hand. The count lives in memory only, so a resume re-runs the stopped iteration
// as a new baseline; the cap is not reset, so the iterations already spent still count against it.
describe('A stopped Run resumes by hand and the cap still counts (US3)', () => {
  const BOUND = 2;

  /** Drive to the stop, then resume it once, the way the "Resume Paused or Failed Workflow" command does. */
  async function stopThenResume(scripts: Array<() => RawInvocationOutput>, iterationCap: number) {
    const first = await driveToEnd(scripts, { iterationCap, getMaxUnchangedComparisons: () => BOUND });
    const stoppedRun = first.run;
    const stoppedInvocations = first.invokeCount.value;
    const resumed = await first.controller.resumeExisting(DEFAULT_QUEUE_ID);
    return { ...first, stoppedRun, stoppedInvocations, resumed, run: first.store.getRun(DEFAULT_QUEUE_ID)! };
  }

  async function retryEvaluations() {
    const lines = await readAuditLog(tmpRoot);
    return lines.filter((l) => l.eventType === 'phase.retry_evaluated');
  }

  async function endedEvents() {
    const lines = await readAuditLog(tmpRoot);
    return lines.filter((l) => l.eventType === 'task-execution-ended');
  }

  it('US3-3: resumed with figures that change and then clear, the Phase runs again at iteration 3 and the Run advances', async () => {
    const { stoppedRun, stoppedInvocations, resumed, run, invokeCount } = await stopThenResume(
      [figures(3, 0), figures(3, 0), figures(3, 0), figures(2, 0), figures(0, 0)],
      10
    );

    expect(stoppedRun.failureCause).toBe('judged_metrics_unchanged');
    expect(stoppedRun.currentIteration).toBe(3);
    expect(stoppedInvocations).toBe(3);
    expect(resumed).toBe(true);
    expect(invokeCount.value).toBe(5);
    expect(run.status).toBe('completed');
    // C6.5: the resume cleared the cause, and nothing wrote it again.
    expect(run).not.toHaveProperty('failureCause');

    const evaluated = await retryEvaluations();
    expect(evaluated.map((l) => l.iteration)).toEqual([1, 2, 3, 3, 4]);
    expect(evaluated.map((l) => l.payload.decision)).toEqual([true, true, true, true, false]);
  });

  it('US3-4: resumed unchanged, it stops again at iteration 5, and the cap is not reset', async () => {
    const { run, invokeCount, resumed } = await stopThenResume([figures(3, 0)], 10);

    expect(resumed).toBe(true);
    // Three invocations before the stop; the resume re-runs iteration 3 as a baseline, then 4 and 5.
    expect(invokeCount.value).toBe(6);
    expect(run.status).toBe('failed');
    expect(run.failureCause).toBe('judged_metrics_unchanged');
    expect(run.currentIteration).toBe(5);

    const evaluated = await retryEvaluations();
    expect(evaluated.map((l) => l.iteration)).toEqual([1, 2, 3, 3, 4, 5]);
    expect(evaluated.map((l) => l.payload.stalled)).toEqual([undefined, 1, 2, undefined, 1, 2]);
    // The iterations did not start over: the highest one across both drives is under the cap.
    expect(Math.max(...evaluated.map((l) => Number(l.iteration)))).toBeLessThanOrEqual(10);
  });

  it('C6.3: where fewer than N + 1 iterations remain, the resume ends at the cap as cap_exhausted', async () => {
    // Bound 2, cap 4: the first drive stops at 3 with one iteration left. The resume re-runs 3 as a
    // baseline and reaches the cap at 4, which would need three more iterations to stop on the bound.
    const { stoppedRun, run, invokeCount } = await stopThenResume([figures(3, 0)], 4);

    expect(stoppedRun.failureCause).toBe('judged_metrics_unchanged');
    expect(stoppedRun.currentIteration).toBe(3);
    expect(invokeCount.value).toBe(5);
    expect(run.status).toBe('failed');
    expect(run.failureCause).toBe('cap_exhausted');
    expect(run.currentIteration).toBe(4);
  });

  it('US3-6: each stopped drive ends on a terminal event that carries the cause', async () => {
    const first = await driveToEnd([figures(3, 0)], {
      iterationCap: 10,
      getMaxUnchangedComparisons: () => BOUND
    });
    const afterStop = await endedEvents();
    expect(afterStop).toHaveLength(1);
    expect(afterStop[0]?.payload).toMatchObject({
      terminalStatus: 'failed',
      failureCause: 'judged_metrics_unchanged'
    });

    await first.controller.resumeExisting(DEFAULT_QUEUE_ID);
    const afterResume = await endedEvents();
    expect(afterResume).toHaveLength(2);
    expect(afterResume.map((l) => l.payload.failureCause)).toEqual([
      'judged_metrics_unchanged',
      'judged_metrics_unchanged'
    ]);
  });
});
