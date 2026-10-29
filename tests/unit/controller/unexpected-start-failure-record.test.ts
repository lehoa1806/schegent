// FR-R4-F15 (spec 243, contract C6.3, C6.4, C7.11; FR-004, FR-014; User Story 4 scenario 5) — the
// start-failure handler keeps a record of the Run it fails.
//
// A start that threw before or outside the drive fails the Run `start_failed`, with no phase result in
// hand, so the record is `not-applicable` and carries no phase context. It is written for every
// classification that fails an active Run, `lock-held` included, because the Run ended and the record
// is about the Run. It is NOT written for a Run that was already failed (the first writer recorded it,
// and the handler does not fail the Run again) or when no Run exists (there is no Run id to name).
// The handler's other steps keep their order, and a record that cannot be written changes none of them.
// The harness follows `unexpected-start-failure-cause.test.ts`.
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FailureRecordV1 } from '../../../src/contracts/failure-record';
import { isValidFailureRecord, parseRecordName } from '../../../src/contracts/validators/failure-record';
import { ConsentWriteFailedError } from '../../../src/controller/uncontained-consent-gate';
import {
  reportUnexpectedStartFailure,
  type UnexpectedStartFailureDeps
} from '../../../src/controller/unexpected-start-failure';
import { LockHeldError } from '../../../src/lib/errors';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { FeatureRequest } from '../../../src/queue/feature-request';
import { UncontainedBackendRefusedError } from '../../../src/services/backend-containment-policy';
import { CapabilityNotEnforceableError } from '../../../src/services/capability-refusal';
import {
  createFailureRecorder,
  type FailureRecorder,
  type FailureRecordInput
} from '../../../src/services/failure-record/failure-record-service';
import type { WorkflowRun } from '../../../src/state/workflow-run';

const FEATURE_ID = 'task-start-1';
const RUN_ID = 'run-start-1';
const RECORDS_DIR = path.join('.schegent', 'failure-records');

const CLASSIFICATIONS: ReadonlyArray<{ readonly name: string; readonly err: () => unknown }> = [
  { name: 'lock-held', err: () => new LockHeldError('window-7') },
  { name: 'uncontained-backend-refused', err: () => new UncontainedBackendRefusedError('codex', 'refused: add it') },
  { name: 'capability-not-enforceable', err: () => new CapabilityNotEnforceableError('codex', ['network']) },
  { name: 'consent-write-failed', err: () => new ConsentWriteFailedError('codex', 'disk full') },
  { name: 'unexpected', err: () => new Error('something broke') }
];

function runWith(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: RUN_ID,
    featureId: FEATURE_ID,
    featureDir: '',
    status: 'running',
    currentPhase: 'speckit-implement',
    currentIteration: 1,
    startedAt: Date.now() - 1_000,
    lastTransitionAt: Date.now() - 500,
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
    ...overrides
  } as unknown as WorkflowRun;
}

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'unexpected-start-failure-record-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

function realRecorder(): FailureRecorder {
  return createFailureRecorder({
    logger: new SanitizedLogger(),
    queue: { queueIdForExistingTask: () => 'default' },
    workspaceRoot: root,
    platform: 'linux',
    now: () => new Date('2026-10-28T14:30:05.123Z')
  });
}

/** The handler's collaborators, each logging its own call so the order can be compared. */
function harness(activeRun: WorkflowRun | null, recorder: FailureRecorder | undefined) {
  const order: string[] = [];
  const inputs: FailureRecordInput[] = [];
  const logger = new SanitizedLogger();
  const note =
    <T>(name: string, result: T) =>
    async (): Promise<T> => {
      order.push(name);
      return result;
    };
  const notifierWarn = vi.fn(() => void order.push('notifier.warn'));
  const wrapped: FailureRecorder | undefined =
    recorder === undefined
      ? undefined
      : {
          record: async (input) => {
            order.push('failureRecords.record');
            inputs.push(input);
            return recorder.record(input);
          }
        };
  const deps = {
    logger,
    store: { getRun: vi.fn(() => activeRun) },
    queue: {
      queueIdForTask: vi.fn(() => 'default'),
      finish: vi.fn(async () => {
        order.push('queue.finish');
        return { ok: true };
      })
    },
    statusBar: { update: vi.fn(() => void order.push('statusBar.update')) },
    notifier: { warn: notifierWarn },
    historyRecorder: { record: vi.fn(note('historyRecorder.record', undefined)) },
    lifecycleAuditor: {
      emitRunEndedBreakpoints: vi.fn(note('emitRunEndedBreakpoints', undefined)),
      emitTaskExecutionEnded: vi.fn(note('emitTaskExecutionEnded', undefined))
    },
    terminalTransitions: { begin: vi.fn(), complete: vi.fn(note('terminalTransitions.complete', undefined)) },
    sessions: { disposeIfEnded: vi.fn(() => void order.push('sessions.disposeIfEnded')) },
    persist: vi.fn(async (_prev: WorkflowRun, next: WorkflowRun) => {
      order.push('persist');
      return next;
    }),
    releaseExecutionLeaseForRun: vi.fn(note('releaseExecutionLeaseForRun', undefined)),
    scheduleAutoDrain: vi.fn(() => void order.push('scheduleAutoDrain')),
    ...(wrapped === undefined ? {} : { failureRecords: wrapped })
  } as unknown as UnexpectedStartFailureDeps;

  async function report(err: unknown, run: WorkflowRun | null = activeRun): Promise<void> {
    await reportUnexpectedStartFailure(deps, {
      feature: { id: FEATURE_ID } as unknown as FeatureRequest,
      startedRun: run,
      description: 'Add the export button',
      err
    });
  }
  return { report, order, inputs, notifierWarn };
}

async function recordsOnDisk(): Promise<Array<{ name: string; record: FailureRecordV1 }>> {
  const dir = path.join(root, RECORDS_DIR);
  const names = (await fsp.readdir(dir).catch(() => [] as string[])).sort();
  const found: Array<{ name: string; record: FailureRecordV1 }> = [];
  for (const name of names) {
    found.push({ name, record: JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8')) as FailureRecordV1 });
  }
  return found;
}

describe('the handler writes one not-applicable record for the Run it fails (C7.11, C6.3)', () => {
  it.each(CLASSIFICATIONS)('$name: one record, cause start_failed, no phase context', async ({ err }) => {
    const h = harness(runWith(), realRecorder());
    await h.report(err());

    const found = await recordsOnDisk();
    expect(found).toHaveLength(1);
    const parsed = parseRecordName(found[0]?.name ?? '');
    expect(parsed).toMatchObject({ runId: RUN_ID, taskId: FEATURE_ID });
    expect(isValidFailureRecord(found[0]?.record, parsed ?? undefined)).toBe(true);
    expect(found[0]?.record).toMatchObject({
      cause: 'start_failed',
      issueState: 'not-applicable',
      entries: [],
      metrics: [],
      queueId: 'default'
    });
    const record = found.at(0)?.record;
    for (const key of ['phase', 'iteration', 'iterationCap', 'stalledCount']) {
      expect(record !== undefined && key in record, key).toBe(false);
    }
    expect(h.inputs).toHaveLength(1);
    expect(h.inputs[0]?.result).toBeNull();
    expect(h.inputs[0]?.cause).toBe('start_failed');
  });

  it('writes one for a paused Run too, which the handler also fails', async () => {
    const h = harness(runWith({ status: 'paused', manualPauseAt: 1, manualPauseCause: 'operator-paused' }), realRecorder());
    await h.report(new Error('boom'));
    expect(await recordsOnDisk()).toHaveLength(1);
  });

  it('names the Run the handler persisted, not the one it was handed', async () => {
    const h = harness(runWith(), realRecorder());
    await h.report(new Error('boom'));
    expect(h.inputs[0]?.run).toMatchObject({ id: RUN_ID, featureId: FEATURE_ID });
  });

  it('writes none for a Run that was already failed: the first writer recorded it', async () => {
    const h = harness(runWith({ status: 'failed', failureCause: 'cap_exhausted' }), realRecorder());
    await h.report(new Error('a later throw'));
    expect(await recordsOnDisk()).toEqual([]);
    expect(h.inputs).toEqual([]);
  });

  it('writes none when no Run exists: there is no Run id to name', async () => {
    const h = harness(null, realRecorder());
    await h.report(new Error('before any Run'), null);
    expect(await recordsOnDisk()).toEqual([]);
    expect(h.inputs).toEqual([]);
  });

  it('writes none for a Run that is neither running nor paused', async () => {
    const h = harness(runWith({ status: 'completed' }), realRecorder());
    await h.report(new Error('late'));
    expect(h.inputs).toEqual([]);
  });
});

describe('the handler\'s other steps keep their order (C6.3, C6.4)', () => {
  it('calls the recorder once, straight after the Run is persisted, and changes nothing else', async () => {
    const bare = harness(runWith(), undefined);
    await bare.report(new Error('boom'));
    const recording = harness(runWith(), realRecorder());
    await recording.report(new Error('boom'));

    expect(recording.order.filter((step) => step !== 'failureRecords.record')).toEqual(bare.order);
    const at = recording.order.indexOf('failureRecords.record');
    expect(at).toBeGreaterThan(0);
    expect(recording.order[at - 1]).toBe('persist');
    expect(recording.order.filter((step) => step === 'failureRecords.record')).toHaveLength(1);
  });

  it('behaves exactly as before with no recorder at all (C6.4)', async () => {
    const h = harness(runWith(), undefined);
    await h.report(new Error('boom'));
    expect(h.order).toContain('persist');
    expect(h.order).not.toContain('failureRecords.record');
  });

  it('leaves the announcement and every later step the same when the record cannot be written', async () => {
    const bare = harness(runWith(), undefined);
    await bare.report(new Error('boom'));
    const refusing = harness(runWith(), { record: async () => false });
    await refusing.report(new Error('boom'));

    expect(refusing.order.filter((step) => step !== 'failureRecords.record')).toEqual(bare.order);
    expect(refusing.notifierWarn.mock.calls).toEqual(bare.notifierWarn.mock.calls);
  });

  it('makes no promise about a record in the announcement, written or not (D13 is for two causes only)', async () => {
    const h = harness(runWith(), realRecorder());
    await h.report(new Error('boom'));
    expect(JSON.stringify(h.notifierWarn.mock.calls)).not.toContain('Show last error');
  });
});
