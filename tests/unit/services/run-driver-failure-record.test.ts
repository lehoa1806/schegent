// FR-R4-F15 (spec 243, contracts C6 and C7.8 to C7.10, L5.1; FR-003, FR-004, FR-011, FR-014,
// FR-025, FR-028; User Stories 1, 3 and 4) — the failure record at the driver's real branches.
//
// Each case drives `RunDriver.drive()` over a real `WorkspaceStateStore` (so the persisted Run is held
// to `validateRunInvariants`), with a scripted phase runner and a REAL recorder that writes into a
// temporary directory. The recorder is wrapped, so the inputs the driver hands it are visible beside
// the files it wrote. The harness follows `run-driver-failure-cause.test.ts`.
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resumeAdmissionPatch } from '../../../src/controller/resume-pause-fields';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import type { FailureRecordV1 } from '../../../src/contracts/failure-record';
import { isValidFailureRecord, parseRecordName } from '../../../src/contracts/validators/failure-record';
import type { PhaseRunOutput } from '../../../src/controller/phase-runner';
import { SanitizedLogger } from '../../../src/lib/logger';
import {
  createFailureRecorder,
  type FailureRecorder,
  type FailureRecordInput
} from '../../../src/services/failure-record/failure-record-service';
import { FailureRecordStore } from '../../../src/services/failure-record/failure-record-store';
import { failureNotice } from '../../../src/services/failure-notice';
import { RunDriver, type RunDriverDeps } from '../../../src/services/run-driver';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';

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

const CLAIM = unfencedCommit('test-fixture');
const DESCRIPTION = 'Add the export button';
const PHASE = 'implement';
const RECORDS_DIR = path.join('.schegent', 'failure-records');
const CLOCK = new Date('2026-10-28T14:30:05.123Z');

/** Planted in every summary and every metric key: it may reach the record and nothing else. */
const ISSUE_SENTINEL = 'SENTINEL-ISSUE-TEXT';
const METRIC_SENTINEL = 'SENTINEL_METRIC_KEY';

interface Persisted {
  readonly previous: WorkflowRun;
  readonly next: WorkflowRun;
}

interface Harness {
  readonly store: WorkspaceStateStore;
  readonly driver: RunDriver;
  readonly persisted: Persisted[];
  readonly phaseRunner: { run: ReturnType<typeof vi.fn>; appendCapExhaustedPhaseEnd: ReturnType<typeof vi.fn> };
  readonly notifier: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  readonly statusBar: { update: ReturnType<typeof vi.fn> };
  readonly emitTaskLifecycleAudit: ReturnType<typeof vi.fn>;
  readonly queueFinish: ReturnType<typeof vi.fn>;
  /** Every audit emitter the driver holds, so a case can search them all. */
  readonly auditEmitters: ReadonlyArray<ReturnType<typeof vi.fn>>;
  readonly probeAvailability: ReturnType<typeof vi.fn>;
  /** The inputs the driver passed to the recorder, in order. */
  readonly recorderInputs: FailureRecordInput[];
  seedRun(overrides?: Partial<WorkflowRun>): Promise<WorkflowRun>;
  resume(): Promise<WorkflowRun>;
  endedPayloads(): Array<Record<string, unknown>>;
}

interface HarnessOptions {
  /** `none` builds the driver with no `failureRecords` dependency, as every existing caller does. */
  readonly recorder: 'real' | 'none' | FailureRecorder;
  /** The driver's audit-evidence gate. Absent means available. */
  readonly isAuditEvidenceAvailable?: () => boolean;
}

let root: string;
/** The clock the recorder reads. Each read is one second later, so a second failure is a later one. */
let clockReads = 0;
const nextFailureTime = (): Date => new Date(CLOCK.getTime() + clockReads++ * 1000);

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'run-driver-failure-record-'));
  clockReads = 0;
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

function realRecorder(): FailureRecorder {
  const logger = new SanitizedLogger([]);
  return createFailureRecorder({
    logger,
    queue: { queueIdForExistingTask: () => DEFAULT_QUEUE_ID },
    workspaceRoot: root,
    platform: 'linux',
    now: nextFailureTime
  });
}

async function makeHarness(iterationCap: number, options: HarnessOptions): Promise<Harness> {
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  const persisted: Persisted[] = [];
  const recorderInputs: FailureRecordInput[] = [];

  const phaseRunner = {
    run: vi.fn(),
    abort: vi.fn(),
    appendCapExhaustedPhaseEnd: vi.fn().mockResolvedValue(undefined),
    evictStagnationTracker: vi.fn()
  };
  const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const statusBar = { update: vi.fn(), dispose: vi.fn() };
  const emitTaskLifecycleAudit = vi.fn();
  const queueFinish = vi.fn(async () => ({ ok: true }));
  const appendPhaseControlAudit = vi.fn();
  const appendRunnerProbeFailedAudit = vi.fn();
  const appendBreakpointAudit = vi.fn();
  const emitRunEndedBreakpointAudit = vi.fn();
  const emitOptionalPhaseFailureContinued = vi.fn();
  const emitRunSnapshotDeclined = vi.fn();
  const emitOutputTargetRefusedAtDispatch = vi.fn();

  const probeAvailability = vi.fn().mockResolvedValue(true);
  const inner =
    options.recorder === 'real' ? realRecorder() : options.recorder === 'none' ? null : options.recorder;
  const failureRecords: FailureRecorder | undefined =
    inner === null
      ? undefined
      : {
          record: async (input) => {
            recorderInputs.push(input);
            return inner.record(input);
          }
        };

  const deps = {
    store,
    runner: phaseRunner,
    logger: new SanitizedLogger([]),
    options: {
      iterationCap,
      cwd: root,
      cliPath: '/test/bin',
      ...(options.isAuditEvidenceAvailable === undefined
        ? {}
        : { isAuditEvidenceAvailable: options.isAuditEvidenceAvailable })
    },
    backendCapabilities: { probeAvailability },
    terminalTransitions: { begin: vi.fn(), complete: vi.fn(async () => undefined) },
    monitor: null,
    retryCoordinator: {
      registerAttempt: vi.fn(),
      clear: vi.fn(),
      isRetryCapExhaustedOnNextFailure: vi.fn().mockReturnValue(false),
      handleDelayedRetry: vi.fn(),
      maybeEmitRetryRecovered: vi.fn().mockImplementation(async (r: unknown) => r)
    },
    queue: { finish: queueFinish, pause: vi.fn(async () => ({ ok: true })), findById: vi.fn(() => null) },
    notifier,
    statusBar,
    historyRecorder: { record: vi.fn(), recordPhaseOutput: vi.fn() },
    checkpoints: { checkpoint: vi.fn().mockResolvedValue(undefined) },
    emitRunEndedBreakpointAudit,
    emitTaskLifecycleAudit,
    emitOptionalPhaseFailureContinued,
    emitRunSnapshotDeclined,
    emitOutputTargetRefusedAtDispatch,
    appendPhaseControlAudit,
    appendRunnerProbeFailedAudit,
    appendBreakpointAudit,
    isContinueGate: { consume: vi.fn().mockReturnValue(false), arm: vi.fn() },
    lock: {
      release: vi.fn(async () => {}),
      tryAcquire: vi.fn(),
      heartbeat: vi.fn(),
      isHeld: vi.fn(),
      ownerOfRecord: vi.fn(),
      id: 'this-window'
    },
    persistTransition: async (previous: WorkflowRun, next: WorkflowRun) => {
      persisted.push({ previous, next });
      await store.setRun(DEFAULT_QUEUE_ID, next, CLAIM);
      return next;
    },
    scheduleAutoDrain: vi.fn(),
    releaseExecutionLease: vi.fn(),
    onRunTerminal: vi.fn(),
    ...(failureRecords === undefined ? {} : { failureRecords })
  } as unknown as RunDriverDeps;

  return {
    store,
    driver: new RunDriver(deps),
    persisted,
    phaseRunner,
    notifier,
    statusBar,
    emitTaskLifecycleAudit,
    queueFinish,
    auditEmitters: [
      emitTaskLifecycleAudit,
      appendPhaseControlAudit,
      appendRunnerProbeFailedAudit,
      appendBreakpointAudit,
      emitRunEndedBreakpointAudit,
      emitOptionalPhaseFailureContinued,
      emitRunSnapshotDeclined,
      emitOutputTargetRefusedAtDispatch,
      phaseRunner.appendCapExhaustedPhaseEnd
    ],
    probeAvailability,
    recorderInputs,
    async seedRun(overrides: Partial<WorkflowRun> = {}): Promise<WorkflowRun> {
      const run = {
        id: 'run-record-1',
        featureId: 'task-record-1',
        featureDir: '/tmp/feat',
        startedAt: Date.now(),
        lastTransitionAt: Date.now(),
        status: 'running',
        currentPhase: PHASE,
        currentIteration: 0,
        pipeline: { id: 'pipe-record', name: 'Record', phases: [capPhase(PHASE)] },
        phasesCompleted: [],
        lastError: null,
        delayedRetryCount: 0,
        pendingRetryAt: null,
        pendingRetryCause: null,
        manualPauseAt: null,
        manualPauseCause: null,
        phaseBreakpoints: [],
        phaseOverrides: [],
        resumeTargetPhaseId: null,
        ...overrides
      } as unknown as WorkflowRun;
      await store.setRun(DEFAULT_QUEUE_ID, run, CLAIM);
      return store.getRun(DEFAULT_QUEUE_ID)!;
    },
    async resume(): Promise<WorkflowRun> {
      const current = store.getRun(DEFAULT_QUEUE_ID);
      if (current === null) throw new Error('no Run to resume');
      return store.updateRun(
        DEFAULT_QUEUE_ID,
        {
          runId: current.id,
          allowedStatuses: ['failed'],
          label: 'resume-admission',
          patch: (run) =>
            resumeAdmissionPatch(run, {
              pipeline: run.pipeline,
              defaultRunnerKind: run.defaultRunnerKind,
              mutationPlan: run.mutationPlan,
              envelope: undefined,
              gitApprovalReceipt: undefined
            })
        },
        CLAIM
      );
    },
    endedPayloads(): Array<Record<string, unknown>> {
      return emitTaskLifecycleAudit.mock.calls
        .filter((call) => call[0] === 'task-execution-ended')
        .map((call) => call[2] as Record<string, unknown>);
    }
  };
}

/** A phase whose retry condition stays truthy until `open_questions` reaches zero. */
const capPhase = (id: string) => ({ id, name: id, instruction: id, retryCondition: 'open_questions > 0' });

/** A Run parked on its last phase, with an earlier phase before it so the last one is not the first. */
function atLastPhase(lastPhase: string): Partial<WorkflowRun> {
  return {
    currentPhase: lastPhase,
    pipeline: {
      id: 'pipe-last',
      name: 'Last',
      phases: [
        { id: 'implement', name: 'Implement', instruction: 'implement' },
        { id: lastPhase, name: 'Last', instruction: 'finish' }
      ]
    }
  } as unknown as Partial<WorkflowRun>;
}

function output(result: Record<string, unknown>, outcome: string, extra: Partial<PhaseRunOutput> = {}): PhaseRunOutput {
  return {
    result,
    outcome,
    terminationReason: 'token',
    stdoutSummary: '',
    stderrSummary: '',
    exitCode: 0,
    warnings: [],
    auditEntryId: null,
    ...extra
  } as unknown as PhaseRunOutput;
}

/** Three tagged issues and the planted sentinels, as a required last phase ends. */
function threeTaggedIssues(): PhaseRunOutput {
  return output(
    {
      kind: 'remaining_issues',
      issues: [
        { tag: 'needs-approval', summary: `${ISSUE_SENTINEL} 1: bump the dependency` },
        { tag: 'environment', summary: `${ISSUE_SENTINEL} 2: the registry is down` },
        { tag: 'regression', summary: `${ISSUE_SENTINEL} 3: the export test fails` }
      ],
      auditEntry: { metrics: { [METRIC_SENTINEL]: 7 } }
    },
    'issues_remain'
  );
}

/** A cap failure: a clean result whose metrics keep the retry condition truthy. */
function unsatisfied(stalledCount: number): PhaseRunOutput {
  return output(
    { kind: 'clean', auditEntry: { metrics: { open_questions: 3, zeta: 1, alpha: 2 } } },
    'clean',
    { stalledCount } as Partial<PhaseRunOutput>
  );
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

/** Watch every read and write of the driver's private `carriedIssues`, from outside the class. */
function watchCarriedIssues(driver: RunDriver): string[] {
  const events: string[] = [];
  let value: unknown = (driver as unknown as { carriedIssues: unknown }).carriedIssues;
  Object.defineProperty(driver, 'carriedIssues', {
    configurable: true,
    get() {
      events.push('read');
      return value;
    },
    set(next: unknown) {
      events.push(`write:${JSON.stringify(next)}`);
      value = next;
    }
  });
  return events;
}

describe('RunDriver writes one record when a required last phase ends with issues (C7.8 case 1, US1)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness(5, { recorder: 'real' });
    h.phaseRunner.run.mockResolvedValue(threeTaggedIssues());
  });

  it('writes exactly one valid record, named for the Run and the task', async () => {
    await h.driver.drive(await h.seedRun(atLastPhase('finalize')), DESCRIPTION);

    const found = await recordsOnDisk();
    expect(found).toHaveLength(1);
    const parsed = parseRecordName(found[0]?.name ?? '');
    expect(parsed).toMatchObject({ runId: 'run-record-1', taskId: 'task-record-1' });
    expect(isValidFailureRecord(found[0]?.record, parsed ?? undefined)).toBe(true);
    expect(h.recorderInputs).toHaveLength(1);
  });

  it('records the three tags as the agent\'s, the cause, the phase context and the failure time', async () => {
    await h.driver.drive(await h.seedRun(atLastPhase('finalize')), DESCRIPTION);

    const record = (await recordsOnDisk()).at(0)?.record;
    expect(record).toMatchObject({
      recordVersion: 1,
      queueId: DEFAULT_QUEUE_ID,
      taskId: 'task-record-1',
      runId: 'run-record-1',
      cause: 'last_phase_issues_remain',
      phase: 'finalize',
      iteration: 1,
      iterationCap: 5,
      failedAt: CLOCK.toISOString(),
      issueState: 'listed',
      omittedIssueCount: 0
    });
    expect(record?.entries.map((entry) => [entry.tag, entry.source, entry.kind])).toEqual([
      ['needs-approval', 'agent', 'issue'],
      ['environment', 'agent', 'issue'],
      ['regression', 'agent', 'issue']
    ]);
    expect(record?.entries.map((entry) => entry.summary)).toEqual([
      `${ISSUE_SENTINEL} 1: bump the dependency`,
      `${ISSUE_SENTINEL} 2: the registry is down`,
      `${ISSUE_SENTINEL} 3: the export test fails`
    ]);
    // A last-phase failure has no stall comparison, so none is recorded: absent, never 0.
    expect(record !== undefined && 'stalledCount' in record).toBe(false);
  });

  it('is written after the Run is persisted as failed, with the cause the Run carries', async () => {
    await h.driver.drive(await h.seedRun(atLastPhase('finalize')), DESCRIPTION);

    const run = h.store.getRun(DEFAULT_QUEUE_ID);
    expect(run?.status).toBe('failed');
    expect(run?.failureCause).toBe('last_phase_issues_remain');
    expect(h.recorderInputs[0]?.cause).toBe(run?.failureCause);
    expect(h.recorderInputs[0]?.run).toMatchObject({ id: 'run-record-1', featureId: 'task-record-1' });
  });

  it('hands the recorder the phase result the carry-forward read uses, not a second parse', async () => {
    const scripted = threeTaggedIssues();
    h.phaseRunner.run.mockResolvedValue(scripted);
    await h.driver.drive(await h.seedRun(atLastPhase('finalize')), DESCRIPTION);

    expect(h.recorderInputs[0]?.result).toBe(scripted.result);
  });

  it('never reads or assigns the carried issues (FR-003): the access log equals the same failure with no recorder', async () => {
    const withRecorder = watchCarriedIssues(h.driver);
    await h.driver.drive(await h.seedRun(atLastPhase('finalize')), DESCRIPTION);

    const bare = await makeHarness(5, { recorder: 'none' });
    bare.phaseRunner.run.mockResolvedValue(threeTaggedIssues());
    const withoutRecorder = watchCarriedIssues(bare.driver);
    await bare.driver.drive(await bare.seedRun(atLastPhase('finalize')), DESCRIPTION);

    expect(withRecorder.length).toBeGreaterThan(0);
    expect(withRecorder).toEqual(withoutRecorder);
  });
});

describe('RunDriver writes the cap, the stall count and the metrics when a phase fails at its cap (C7.8 case 2, US1)', () => {
  it('records the iteration, the cap, the stall count and the sorted metrics', async () => {
    const h = await makeHarness(2, { recorder: 'real' });
    h.phaseRunner.run.mockResolvedValue(unsatisfied(2));
    await h.driver.drive(await h.seedRun(), DESCRIPTION);

    const found = await recordsOnDisk();
    expect(found).toHaveLength(1);
    expect(found[0]?.record).toMatchObject({
      cause: 'cap_exhausted',
      phase: PHASE,
      iteration: 2,
      iterationCap: 2,
      stalledCount: 2,
      issueState: 'none-reported',
      entries: [],
      metrics: [
        { key: 'alpha', value: 2 },
        { key: 'open_questions', value: 3 },
        { key: 'zeta', value: 1 }
      ],
      omittedMetricCount: 0
    });
  });
});

describe('the audit boundary holds with a recorder (L5.1, FR-028)', () => {
  async function failOnce(recorder: 'real' | 'none'): Promise<Harness> {
    const h = await makeHarness(5, { recorder });
    h.phaseRunner.run.mockResolvedValue(threeTaggedIssues());
    await h.driver.drive(await h.seedRun(atLastPhase('finalize')), DESCRIPTION);
    return h;
  }

  it('carries no summary and no metric key into any audit append, notice, status or persisted Run', async () => {
    const h = await failOnce('real');

    // Control: the sentinels are in the record, so their absence elsewhere is not vacuous.
    const onDisk = JSON.stringify(await recordsOnDisk());
    expect(onDisk).toContain(ISSUE_SENTINEL);
    expect(onDisk).toContain(METRIC_SENTINEL);

    const surfaces = [
      ...h.auditEmitters.map((emitter) => JSON.stringify(emitter.mock.calls)),
      JSON.stringify(h.notifier.warn.mock.calls),
      JSON.stringify(h.statusBar.update.mock.calls),
      JSON.stringify(h.persisted.map((entry) => entry.next)),
      JSON.stringify(h.queueFinish.mock.calls)
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(ISSUE_SENTINEL);
      expect(surface).not.toContain(METRIC_SENTINEL);
    }
  });

  it('emits a task-execution-ended payload with the same keys as the same failure without a recorder', async () => {
    const withRecorder = await failOnce('real');
    const bare = await failOnce('none');

    expect(withRecorder.endedPayloads()).toHaveLength(1);
    expect(bare.endedPayloads()).toHaveLength(1);
    expect(Object.keys(withRecorder.endedPayloads()[0] ?? {}).sort()).toEqual(
      Object.keys(bare.endedPayloads()[0] ?? {}).sort()
    );
  });

  it('makes the same audit calls, in the same order, with or without a recorder', async () => {
    const withRecorder = await failOnce('real');
    const bare = await failOnce('none');
    const shape = (h: Harness): string[] =>
      h.auditEmitters.map((emitter) => emitter.mock.calls.map((call) => String(call[0])).join(','));
    expect(shape(withRecorder)).toEqual(shape(bare));
  });
});

describe('a resumed Run keeps each failure\'s own record (C7.8 case 3, FR-011, FR-023; US3)', () => {
  async function failResumeFail(): Promise<{
    afterFirst: Awaited<ReturnType<typeof recordsOnDisk>>;
    firstBytes: Buffer;
    afterSecond: Awaited<ReturnType<typeof recordsOnDisk>>;
    h: Harness;
  }> {
    const h = await makeHarness(2, { recorder: 'real' });
    h.phaseRunner.run.mockResolvedValue(unsatisfied(2));
    await h.driver.drive(await h.seedRun(), DESCRIPTION);
    const afterFirst = await recordsOnDisk();
    const firstBytes = await fsp.readFile(path.join(root, RECORDS_DIR, afterFirst[0]?.name ?? 'missing'));
    const resumed = await h.resume();
    await h.driver.drive(resumed, DESCRIPTION);
    return { afterFirst, firstBytes, afterSecond: await recordsOnDisk(), h };
  }

  it('writes a second file, later than the first, and leaves the first byte for byte as it was', async () => {
    const { afterFirst, firstBytes, afterSecond } = await failResumeFail();

    // Control: exactly one record existed after the first failure, so the second is a new file and
    // not a count that was already two.
    expect(afterFirst).toHaveLength(1);
    expect(afterSecond).toHaveLength(2);
    const first = afterSecond.at(0);
    const second = afterSecond.at(1);
    expect(first?.name).toBe(afterFirst[0]?.name);
    expect(await fsp.readFile(path.join(root, RECORDS_DIR, first?.name ?? 'missing'))).toEqual(firstBytes);
    expect(Date.parse(second?.record.failedAt ?? '')).toBeGreaterThan(Date.parse(first?.record.failedAt ?? ''));
  });

  it('gives both records the same Run and cause, each its own suffix', async () => {
    const { afterSecond } = await failResumeFail();
    const first = afterSecond.at(0);
    const second = afterSecond.at(1);
    expect(second?.record.runId).toBe(first?.record.runId);
    expect(second?.record.cause).toBe('cap_exhausted');
    expect(second?.record.suffix).not.toBe(first?.record.suffix);
    // The phase runs again at the iteration it failed on, so both report the same position.
    expect([first?.record.iteration, second?.record.iteration]).toEqual([2, 2]);
  });

  it('records each failure in its own write: the recorder is called once per failure', async () => {
    const { h } = await failResumeFail();
    expect(h.recorderInputs).toHaveLength(2);
    expect(h.recorderInputs.map((input) => input.cause)).toEqual(['cap_exhausted', 'cap_exhausted']);
  });

  it('writes no record for a resume that then succeeds', async () => {
    const h = await makeHarness(2, { recorder: 'real' });
    h.phaseRunner.run.mockResolvedValue(unsatisfied(2));
    await h.driver.drive(await h.seedRun(), DESCRIPTION);
    const resumed = await h.resume();
    h.phaseRunner.run.mockResolvedValue(
      output({ kind: 'clean', auditEntry: { metrics: { open_questions: 0 } } }, 'clean')
    );
    await h.driver.drive(resumed, DESCRIPTION);
    expect(h.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('completed');
    expect(await recordsOnDisk()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// C7.9 — a recorder that cannot write changes nothing the Run does (FR-014, D12; US4 scenarios 1, 5)
// ---------------------------------------------------------------------------

/** What a failed Run leaves behind everywhere except the record, with the one timestamp it carries removed. */
function outcomeOf(h: Harness): Record<string, unknown> {
  const run = h.store.getRun(DEFAULT_QUEUE_ID);
  const withoutTime = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    const { at: _at, ...rest } = value as Record<string, unknown>;
    return rest;
  };
  return {
    status: run?.status,
    failureCause: run?.failureCause,
    lastError: withoutTime(run?.lastError),
    currentPhase: run?.currentPhase,
    persistedStatuses: h.persisted.map((entry) => entry.next.status),
    queueFinish: h.queueFinish.mock.calls.map((call) => [call[0], call[1], withoutTime(call[2])]),
    notices: h.notifier.warn.mock.calls.map((call) => call[0]),
    statusBar: h.statusBar.update.mock.calls.map((call) => call[1]),
    audit: h.auditEmitters.map((emitter) => emitter.mock.calls.map((call) => String(call[0]))),
    ended: h.endedPayloads().map((payload) => [payload.terminalStatus, payload.failureCause])
  };
}

const THROWING_STORE_SEAM = {
  write: async (): Promise<void> => {
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  }
};

describe('a recorder that cannot write changes nothing else (C7.9, FR-014, D12)', () => {
  async function failLastPhase(recorder: HarnessOptions['recorder']): Promise<Harness> {
    const h = await makeHarness(5, { recorder });
    h.phaseRunner.run.mockResolvedValue(threeTaggedIssues());
    await h.driver.drive(await h.seedRun(atLastPhase('finalize')), DESCRIPTION);
    return h;
  }

  const unwritableRecorder = (): FailureRecorder =>
    createFailureRecorder({
      logger: new SanitizedLogger([]),
      queue: { queueIdForExistingTask: () => DEFAULT_QUEUE_ID },
      workspaceRoot: root,
      store: new FailureRecordStore({ workspaceRoot: root, logger: { warn: vi.fn() }, fs: THROWING_STORE_SEAM })
    });

  it('a recorder that returns false leaves the Run, the queue, the audit and the notice as with no recorder', async () => {
    const bare = await failLastPhase('none');
    const refusing = await failLastPhase({ record: async () => false });
    expect(outcomeOf(refusing)).toEqual(outcomeOf(bare));
    expect(outcomeOf(bare).status).toBe('failed');
  });

  it('a recorder whose store throws on write leaves the same outcome, and no file', async () => {
    const bare = await failLastPhase('none');
    const throwing = await failLastPhase(unwritableRecorder());
    expect(outcomeOf(throwing)).toEqual(outcomeOf(bare));
    expect(await recordsOnDisk()).toEqual([]);
  });

  it('says 242\'s text, with no promise about a record, whenever nothing was written', async () => {
    const expected = failureNotice({ cause: 'last_phase_issues_remain', phase: 'finalize', taskTitle: DESCRIPTION });
    for (const recorder of ['none', { record: async () => false }, unwritableRecorder()] as const) {
      const h = await failLastPhase(recorder);
      expect(h.notifier.warn).toHaveBeenCalledTimes(1);
      expect(h.notifier.warn).toHaveBeenCalledWith(expected.message);
      expect(String(h.notifier.warn.mock.calls[0]?.[0])).not.toContain('Show last error');
    }
  });

  it('control: with a recorder that wrote, the notice is 242\'s text and the one new sentence, and nothing else differs', async () => {
    const bare = await failLastPhase('none');
    const written = await failLastPhase('real');
    const expected = failureNotice({
      cause: 'last_phase_issues_remain',
      phase: 'finalize',
      taskTitle: DESCRIPTION,
      recordWritten: true
    });
    expect(written.notifier.warn).toHaveBeenCalledWith(expected.message);
    expect(String(written.notifier.warn.mock.calls[0]?.[0])).toMatch(/ "Show last error" lists what was open\.$/);
    const { notices: writtenNotices, ...writtenRest } = outcomeOf(written);
    const { notices: bareNotices, ...bareRest } = outcomeOf(bare);
    expect(writtenRest).toEqual(bareRest);
    expect(writtenNotices).not.toEqual(bareNotices);
  });

  it('puts the sentence on the cap notice too, and only when the record was written', async () => {
    const written = await makeHarness(2, { recorder: 'real' });
    written.phaseRunner.run.mockResolvedValue(unsatisfied(2));
    await written.driver.drive(await written.seedRun(), DESCRIPTION);
    const bare = await makeHarness(2, { recorder: 'none' });
    bare.phaseRunner.run.mockResolvedValue(unsatisfied(2));
    await bare.driver.drive(await bare.seedRun(), DESCRIPTION);
    expect(String(written.notifier.warn.mock.calls[0]?.[0])).toBe(
      `${String(bare.notifier.warn.mock.calls[0]?.[0])} "Show last error" lists what was open.`
    );
  });
});

// ---------------------------------------------------------------------------
// C7.10 — the failures that happen before any phase produced output (FR-004; US4 scenario 5)
// ---------------------------------------------------------------------------

/** A Run with an unprobed backend: no phase finished, iteration 0, so the start-of-run probe applies. */
function unprobedRun(): Partial<WorkflowRun> {
  return {
    currentPhase: 'plan',
    pipeline: {
      id: 'pipe-probe',
      name: 'Probe',
      phases: [{ id: 'plan', name: 'Plan', instruction: 'plan', runner: 'codex' }]
    }
  } as unknown as Partial<WorkflowRun>;
}

describe('a failure before any phase output writes a not-applicable record (C7.10, FR-004)', () => {
  /** The probe is skipped under `NODE_ENV=test`; the existing probe suite sets it the same way. */
  async function withProbeEnabled(work: () => Promise<void>): Promise<void> {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      await work();
    } finally {
      process.env.NODE_ENV = original;
    }
  }

  const NO_PHASE_CONTEXT = ['phase', 'iteration', 'iterationCap', 'stalledCount'] as const;

  it('a runner probe that fails writes one record with cause runner_probe_failed', async () => {
    const h = await makeHarness(5, { recorder: 'real' });
    h.probeAvailability.mockResolvedValue(false);
    await withProbeEnabled(async () => {
      await h.driver.drive(await h.seedRun(unprobedRun()), DESCRIPTION);
    });

    expect(h.store.getRun(DEFAULT_QUEUE_ID)?.failureCause).toBe('runner_probe_failed');
    const found = await recordsOnDisk();
    expect(found).toHaveLength(1);
    const record = found.at(0)?.record;
    expect(record).toMatchObject({
      cause: 'runner_probe_failed',
      issueState: 'not-applicable',
      entries: [],
      metrics: [],
      taskId: 'task-record-1',
      runId: 'run-record-1'
    });
    for (const key of NO_PHASE_CONTEXT) expect(record !== undefined && key in record, key).toBe(false);
    expect(h.recorderInputs.map((input) => input.result)).toEqual([null]);
  });

  it('audit evidence that is unavailable writes one record with cause audit_evidence_unavailable', async () => {
    const h = await makeHarness(5, { recorder: 'real', isAuditEvidenceAvailable: () => false });
    await h.driver.drive(await h.seedRun(), DESCRIPTION);

    expect(h.store.getRun(DEFAULT_QUEUE_ID)?.failureCause).toBe('audit_evidence_unavailable');
    const found = await recordsOnDisk();
    expect(found).toHaveLength(1);
    const record = found.at(0)?.record;
    expect(record).toMatchObject({ cause: 'audit_evidence_unavailable', issueState: 'not-applicable', entries: [] });
    for (const key of NO_PHASE_CONTEXT) expect(record !== undefined && key in record, key).toBe(false);
    expect(h.recorderInputs.map((input) => input.result)).toEqual([null]);
  });

  it('leaves both notices exactly as 242 wrote them, a record or not', async () => {
    const probe = await makeHarness(5, { recorder: 'real' });
    probe.probeAvailability.mockResolvedValue(false);
    await withProbeEnabled(async () => {
      await probe.driver.drive(await probe.seedRun(unprobedRun()), DESCRIPTION);
    });
    expect(probe.notifier.warn).toHaveBeenCalledWith(
      failureNotice({ cause: 'runner_probe_failed', runnerKind: 'codex' }).message
    );

    const evidence = await makeHarness(5, { recorder: 'real', isAuditEvidenceAvailable: () => false });
    await evidence.driver.drive(await evidence.seedRun(), DESCRIPTION);
    expect(evidence.notifier.warn).toHaveBeenCalledWith(failureNotice({ cause: 'audit_evidence_unavailable' }).message);
  });

  it('writes nothing for a phase that ends clean and advances', async () => {
    const h = await makeHarness(5, { recorder: 'real' });
    h.phaseRunner.run.mockResolvedValue(output({ kind: 'clean', auditEntry: { metrics: { open_questions: 0 } } }, 'clean'));
    await h.driver.drive(await h.seedRun(), DESCRIPTION);
    expect(h.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('completed');
    expect(await recordsOnDisk()).toEqual([]);
    expect(h.recorderInputs).toEqual([]);
  });
});
