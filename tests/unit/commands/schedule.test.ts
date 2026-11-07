// Feature 285 (OD-2, US3, FR-009, D7) — `schegent.schedule` opens no Pipeline picker.
//
// The command used to answer a missing `pipelineId` with a QuickPick titled "Schegent: select
// pipeline" that listed the linear catalog. Queue work is composed from Workflows now, in the
// Queue's Add work composer, so with no `pipelineId` the command tells the operator where to go
// and reveals the Schegent view; it enqueues nothing and opens no picker. The command id stays
// contributed, so a keybinding or a script that calls it gets that guidance rather than an
// error. An explicit `pipelineId` keeps the linear path unchanged.
//
// Feature 098 (T044) tested the picker's ordering and badging here; those cases left with the
// picker they described.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  quickPickCalls: 0,
  inputBoxCalls: 0,
  executed: [] as string[],
  revealFails: false
}));

vi.mock('vscode', () => ({
  window: {
    showQuickPick: async () => {
      mocks.quickPickCalls += 1;
      return undefined;
    },
    showInputBox: async () => {
      mocks.inputBoxCalls += 1;
      return 'A feature to schedule';
    }
  },
  commands: {
    executeCommand: async (command: string) => {
      mocks.executed.push(command);
      if (mocks.revealFails) throw new Error('view container is not registered');
      return undefined;
    }
  }
}));

import {
  SCHEDULE_FAILED_TOAST,
  SCHEDULE_NEEDS_A_WORKFLOW_GUIDANCE,
  runSchedule
} from '../../../src/commands/schedule';
import { SanitizedLogger } from '../../../src/lib/logger';

const SCHEGENT_VIEW = 'workbench.view.extension.schegent';

function makeCtx() {
  const scheduleOrEnqueue = vi.fn(async (_request: { pipelineId: string | null }) => ({
    outcome: 'enqueued',
    queueItemId: 'q-1'
  }));
  const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx = {
    guardedRunService: { scheduleOrEnqueue },
    notifier,
    logger: new SanitizedLogger()
  } as unknown as Parameters<typeof runSchedule>[1];
  return { ctx, scheduleOrEnqueue, notifier };
}

beforeEach(() => {
  mocks.quickPickCalls = 0;
  mocks.inputBoxCalls = 0;
  mocks.executed.length = 0;
  mocks.revealFails = false;
  vi.spyOn(SanitizedLogger.prototype, 'error').mockImplementation(() => undefined);
});

describe('Feature 285 (FR-009) — schegent.schedule with no pipelineId', () => {
  for (const [name, args] of [
    ['no arguments', undefined],
    ['a description and no pipelineId', { description: 'a feature to schedule' }],
    ['an empty pipelineId', { description: 'a feature to schedule', pipelineId: '' }]
  ] as const) {
    it(`shows the guidance, reveals the Schegent view and enqueues nothing, given ${name}`, async () => {
      const { ctx, scheduleOrEnqueue, notifier } = makeCtx();

      await runSchedule(args, ctx);

      expect(mocks.quickPickCalls).toBe(0);
      expect(mocks.inputBoxCalls).toBe(0);
      expect(scheduleOrEnqueue).not.toHaveBeenCalled();
      expect(mocks.executed).toEqual([SCHEGENT_VIEW]);
      expect(notifier.info).toHaveBeenCalledTimes(1);
      expect(notifier.info).toHaveBeenCalledWith(SCHEDULE_NEEDS_A_WORKFLOW_GUIDANCE);
      expect(notifier.warn).not.toHaveBeenCalled();
      expect(notifier.error).not.toHaveBeenCalled();
    });
  }

  it('still shows the guidance when the view reveal fails, and logs the failure', async () => {
    // The guidance is the answer; revealing the view is a convenience beside it. A failed
    // reveal must not replace the guidance with "the task could not be scheduled", because
    // nothing was being scheduled.
    const { ctx, scheduleOrEnqueue, notifier } = makeCtx();
    const warnLog = vi.spyOn(ctx.logger, 'warn');
    mocks.revealFails = true;

    await runSchedule(undefined, ctx);

    expect(notifier.info).toHaveBeenCalledTimes(1);
    expect(notifier.info).toHaveBeenCalledWith(SCHEDULE_NEEDS_A_WORKFLOW_GUIDANCE);
    expect(notifier.error).not.toHaveBeenCalled();
    expect(scheduleOrEnqueue).not.toHaveBeenCalled();
    expect(warnLog).toHaveBeenCalledWith(
      'schedule: the Schegent view could not be revealed',
      expect.objectContaining({
        error: expect.stringContaining('view container is not registered')
      })
    );
  });

  it('words the guidance as fixed text naming the composer, not a Pipeline picker', () => {
    expect(SCHEDULE_NEEDS_A_WORKFLOW_GUIDANCE).toBe(
      'Schegent: add work from a Queue in the Schegent view. Select Add work, then choose a Workflow.'
    );
  });
});

describe('Feature 285 (FR-009) — schegent.schedule with an explicit pipelineId keeps the linear path', () => {
  it('enqueues the named id without a picker and without revealing the view', async () => {
    const { ctx, scheduleOrEnqueue, notifier } = makeCtx();

    await runSchedule({ description: 'a feature to schedule', pipelineId: 'alpha-flow' }, ctx);

    expect(mocks.quickPickCalls).toBe(0);
    expect(mocks.executed).toEqual([]);
    expect(scheduleOrEnqueue).toHaveBeenCalledTimes(1);
    expect(scheduleOrEnqueue.mock.calls.at(0)?.at(0)).toMatchObject({
      pipelineId: 'alpha-flow',
      description: 'a feature to schedule'
    });
    expect(notifier.info).toHaveBeenCalledWith('Schegent: enqueued q-1');
  });

  it('still asks for a description when only the pipelineId is given', async () => {
    const { ctx, scheduleOrEnqueue } = makeCtx();

    await runSchedule({ pipelineId: 'alpha-flow' }, ctx);

    expect(mocks.inputBoxCalls).toBe(1);
    expect(scheduleOrEnqueue.mock.calls.at(0)?.at(0)).toMatchObject({
      pipelineId: 'alpha-flow',
      description: 'A feature to schedule'
    });
  });
});

// FR-R4-F05 (FR-014; contract F, F6; contract O, O5) — the generic arm.
//
// It used to toast `Schegent: ${message}` and log the bare message, so a path in an
// exception reached the operator's screen. The toast is fixed text now and the detail goes
// to the log through `describeFailure`. The outcomes the service returns as codes
// (`rejected-validation`, `failed-storage` and the rest) are not failures of the command
// and are untouched.
describe('runSchedule — the unexpected-failure arm (FR-R4-F05)', () => {
  const PATH = '/synthetic/home/user-252/queue.json';

  /** A command whose launch service rejects with `thrown`, and the spies that watch it. */
  function failingWith(thrown: unknown) {
    const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const logger = new SanitizedLogger();
    const errorLog = vi.spyOn(logger, 'error');
    const ctx = {
      guardedRunService: { scheduleOrEnqueue: vi.fn().mockRejectedValueOnce(thrown) },
      notifier,
      logger
    } as unknown as Parameters<typeof runSchedule>[1];
    return { ctx, notifier, errorLog };
  }

  const ARGS = { description: 'a feature to schedule', pipelineId: 'alpha-flow' };

  it('toasts the fixed text and logs the detail when an Error carries a path', async () => {
    const { ctx, notifier, errorLog } = failingWith(new Error(`queue write failed at ${PATH}`));

    await runSchedule(ARGS, ctx);

    expect(notifier.error).toHaveBeenCalledTimes(1);
    expect(notifier.error).toHaveBeenCalledWith(SCHEDULE_FAILED_TOAST);
    expect(JSON.stringify(notifier.error.mock.calls)).not.toContain('user-252');
    expect(errorLog).toHaveBeenCalledWith(
      'schedule: unexpected failure',
      expect.objectContaining({ error: expect.stringContaining('user-252') })
    );
  });

  it('toasts the fixed text for a thrown null and logs a bounded description of it', async () => {
    const { ctx, notifier, errorLog } = failingWith(null);

    await runSchedule(ARGS, ctx);

    expect(notifier.error).toHaveBeenCalledWith(SCHEDULE_FAILED_TOAST);
    expect(errorLog).toHaveBeenCalledWith(
      'schedule: unexpected failure',
      expect.objectContaining({ error: 'null thrown' })
    );
  });

  it('words the toast without an exception, a path or a code', () => {
    expect(SCHEDULE_FAILED_TOAST).toBe(
      'Schegent: the task could not be scheduled. See the Schegent log for details.'
    );
  });

  it('directs the operator to Workflow Launch when scheduleOrEnqueue refuses a composable Workflow ID (FR-R5-F08 / NF-01)', async () => {
    const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const scheduleOrEnqueue = vi.fn(async () => ({
      outcome: 'rejected-validation',
      reason: 'workflow-requires-graph-launch:wf-composable'
    }));
    const ctx = {
      guardedRunService: { scheduleOrEnqueue },
      notifier,
      logger: new SanitizedLogger()
    } as unknown as Parameters<typeof runSchedule>[1];

    await runSchedule({ description: 'test workflow schedule', pipelineId: 'wf-composable' }, ctx);

    expect(notifier.warn).toHaveBeenCalledWith(
      'Schegent: rejected (workflow-requires-graph-launch:wf-composable). Launch composable Workflows from the Workflow Launch view.'
    );
  });
});
