// FR-R4-F02 (spec 240, US7; contract L5 G14, G15, G17; FR-023, FR-024) — every predicted offline
// failure, through the real path, against the documented retry contract.
//
// The expected column is NOT written here from the code's behaviour: it is the table in
// `docs/operations/retry-contract.md`, which was written from source before this file ran. Each
// scenario is a child process (`tests/fixtures/offline-cli-stub.mjs`, a PREDICTION, not an
// observation) driven through the real `ClaudeCliRunner` spawn, `unwrapStreamJson`,
// `detectCreditError`, `parseInvocation`, `PhaseRunner`, `PhaseSequencer`, `RetryHandler` and
// `RetryCoordinator`. Each case asserts three things: the outcome, the delay source, and that
// automatic attempts stop at `DELAYED_RETRY_CAP`, with an operator pause and an operator cancel
// interrupting a countdown. Whether a real CLI prints these shapes is Q2 in the observation record
// (**Unrun here**), and nothing here says it does.
//
// Real timers, real children, a temp root only. The idle-timeout scenario ends at a short idle
// bound; every other scenario exits on its own.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ClaudeCliRunner } from '../../src/runner/claude-cli';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { SanitizedLogger } from '../../src/lib/logger';
import { PhaseRunner, type PhaseRunInputs, type PhaseRunOutput } from '../../src/controller/phase-runner';
import { PhaseSequencer } from '../../src/controller/phase-sequencer';
import { PhaseControlService } from '../../src/controller/phase-control-service';
import { RetryCoordinator } from '../../src/services/retry-coordinator';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { unfencedCommit } from '../../src/state/ownership-claim';
import { canceledRunPatch, type PhaseResult, type WorkflowRun } from '../../src/state/workflow-run';
import { DELAYED_RETRY_CAP, TRANSIENT_BACKOFF_MS } from '../../src/contracts/retry-bounds';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import type { AuditLogWriter } from '../../src/audit/audit-log-writer';
import type { AuditEntry } from '../../src/audit/audit-entry';
import { RecordingDeadlineTimer } from '../recording-deadline-timer';

const STUB = resolve(__dirname, '../fixtures/offline-cli-stub.mjs');

type Scenario =
  | 'dns'
  | 'reset'
  | 'timeout'
  | 'proxy'
  | 'proxy-bad-gateway'
  | 'auth'
  | 'overload'
  | 'stale-credit-then-reset';

/** The idle bound the timeout scenario is run under. Every other scenario ends on its own. */
const IDLE_BOUND_MS = 1_500;
const QUIET_IDLE_MS = 60_000;
const ALL_SCENARIOS_TIMEOUT_MS = 60_000;

/**
 * The retry contract, row by row (`docs/operations/retry-contract.md`, "Which failures retry,
 * pause or fail"). `delayMs` is the delay source's value; `null` means no automatic attempt.
 */
interface ContractRow {
  readonly outcome: string;
  readonly decision: 'pause-delayed-retry' | 'fail';
  readonly delayMs: number | null;
}
const TRANSIENT: ContractRow = {
  outcome: 'transient_error',
  decision: 'pause-delayed-retry',
  delayMs: TRANSIENT_BACKOFF_MS
};
const FAILS: ContractRow = { outcome: 'failed', decision: 'fail', delayMs: null };
const CONTRACT: Readonly<Record<Scenario, ContractRow>> = {
  dns: TRANSIENT,
  reset: TRANSIENT,
  proxy: TRANSIENT,
  'proxy-bad-gateway': TRANSIENT,
  'stale-credit-then-reset': TRANSIENT,
  timeout: { outcome: 'timeout', decision: 'fail', delayMs: null },
  auth: FAILS,
  overload: FAILS
};
const SCENARIOS = Object.keys(CONTRACT) as Scenario[];

let root = '';
const outputs = new Map<Scenario, PhaseRunOutput>();

type AppendedEntry = Omit<AuditEntry, 'id' | 'timestamp'>;

function capturingAuditWriter(): AuditLogWriter {
  const entries: AppendedEntry[] = [];
  return {
    append: vi.fn(async (entry: AppendedEntry): Promise<AuditEntry> => {
      entries.push(entry);
      return { id: `audit-${entries.length}`, timestamp: '2026-10-28T00:00:00Z', ...entry };
    }),
    logPath: join(root, 'audit.log')
  } as unknown as AuditLogWriter;
}

async function runScenario(scenario: Scenario): Promise<PhaseRunOutput> {
  const wrapper = join(root, `cli-${scenario}.sh`);
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" ${scenario}\n`);
  await chmod(wrapper, 0o755);
  const inputs: PhaseRunInputs = {
    phase: 'finalize',
    iteration: 1,
    iterationCap: 5,
    featureDescription: 'offline retry path',
    featureDir: 'specs/240-offline-retry-path',
    cliPath: wrapper,
    cwd: root,
    timeoutMs: scenario === 'timeout' ? IDLE_BOUND_MS : QUIET_IDLE_MS,
    runId: `run-${scenario}`
  };
  const logger = new SanitizedLogger();
  const cli = new ClaudeCliRunner(undefined, null, {}, logger);
  return new PhaseRunner(cli, new PromptBuilder(), capturingAuditWriter(), logger).run(inputs);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'schegent-offline-retry-'));
  const results = await Promise.all(SCENARIOS.map((scenario) => runScenario(scenario)));
  SCENARIOS.forEach((scenario, index) => outputs.set(scenario, results[index]!));
}, ALL_SCENARIOS_TIMEOUT_MS);

afterAll(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true });
});

function outputOf(scenario: Scenario): PhaseRunOutput {
  const output = outputs.get(scenario);
  if (output === undefined) throw new Error(`no output for ${scenario}`);
  return output;
}

function runAt(delayedRetryCount: number): WorkflowRun {
  const now = Date.now();
  return {
    id: 'run-offline',
    featureId: 'task-offline',
    featureDir: 'specs/240-offline-retry-path',
    status: 'running',
    currentPhase: 'finalize',
    currentIteration: 1,
    startedAt: now,
    lastTransitionAt: now,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    creditPause: null
  } as WorkflowRun;
}

function decisionFor(scenario: Scenario, run: WorkflowRun): ReturnType<PhaseSequencer['decideAfterPhase']> {
  return new PhaseSequencer().decideAfterPhase({
    run,
    output: outputOf(scenario),
    iteration: 1,
    iterationCap: 5,
    activePhaseDef: undefined,
    latestManualPauseAt: null,
    now: Date.now(),
    forceContinueOnRetryCapDefault: false
  });
}

/** One place that builds the coordinator, so a later change to its wiring touches one function. */
function makeCoordinator(persisted: WorkflowRun[]): { coordinator: RetryCoordinator } {
  const coordinator = new RetryCoordinator({
    store: {},
    queue: {
      queueIdForTask: () => DEFAULT_QUEUE_ID,
      pause: vi.fn(async () => ({ ok: true })),
      setQueuePausedState: vi.fn(async () => {})
    },
    statusBar: { update: vi.fn() },
    notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    auditWriter: { append: vi.fn(async () => ({ id: 'a', timestamp: 't' })) },
    getRetryCap: () => DELAYED_RETRY_CAP,
    persistTransition: async (_prev: WorkflowRun, next: WorkflowRun) => {
      persisted.push(next);
      return next;
    },
    clock: () => Date.now(),
    // The coordinator arms a timer of its own (FR-R4-F02); this file never lets one fire.
    timer: new RecordingDeadlineTimer(),
    onBackoffElapsed: vi.fn()
  } as unknown as ConstructorParameters<typeof RetryCoordinator>[0]);
  return { coordinator };
}

describe('the stub children reached the real path', () => {
  it('control: every scenario produced a classified output and was ended by the stub or the idle bound', () => {
    for (const scenario of SCENARIOS) {
      const output = outputOf(scenario);
      expect(output.outcome, scenario).toBeTypeOf('string');
    }
    expect(outputOf('timeout').terminationReason).toBe('timeout');
  });
});

describe('each predicted failure has the outcome the retry contract documents (FR-023)', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario}: outcome and decision`, () => {
      const row = CONTRACT[scenario];
      expect(outputOf(scenario).outcome).toBe(row.outcome);
      expect(decisionFor(scenario, runAt(0)).kind).toBe(row.decision);
    });
  }

  it('a transient failure is never read as a rate limit, whatever an earlier line quoted (FR-024, G17)', () => {
    const output = outputOf('stale-credit-then-reset');
    expect(output.result.kind).toBe('transient_error');
    expect(output.result.kind).not.toBe('rate_limited');
  });
});

describe('each retrying failure has the documented delay source and stops at the cap', () => {
  const retrying = SCENARIOS.filter((scenario) => CONTRACT[scenario].delayMs !== null);

  for (const scenario of retrying) {
    it(`${scenario}: the first failure arms TRANSIENT_BACKOFF_MS`, async () => {
      const run = runAt(0);
      const decision = decisionFor(scenario, run);
      if (decision.kind !== 'pause-delayed-retry') throw new Error(`unexpected decision ${decision.kind}`);
      const persisted: WorkflowRun[] = [];
      const { coordinator } = makeCoordinator(persisted);
      const before = Date.now();
      const next = await coordinator.handleDelayedRetry(
        run,
        1,
        decision.phaseResult as PhaseResult,
        decision.cause,
        decision.resetsAtMs,
        decision.rateLimitMessage,
        decision.originalCause
      );
      expect(decision.cause).toBe('transient_error');
      expect(decision.resetsAtMs).toBeNull();
      expect(next.pendingRetryCause).toBe('transient_error');
      expect(next.delayedRetryCount).toBe(1);
      const delay = (next.pendingRetryAt as number) - before;
      expect(Math.abs(delay - TRANSIENT_BACKOFF_MS)).toBeLessThan(5_000);
    });
  }

  it('automatic attempts stop at DELAYED_RETRY_CAP: the cap-th failure arms nothing', async () => {
    const persisted: WorkflowRun[] = [];
    const { coordinator } = makeCoordinator(persisted);
    let run = runAt(0);
    for (let failure = 1; failure <= DELAYED_RETRY_CAP; failure += 1) {
      const decision = decisionFor('dns', run);
      if (decision.kind !== 'pause-delayed-retry') throw new Error(`unexpected decision ${decision.kind}`);
      run = await coordinator.handleDelayedRetry(
        run,
        1,
        decision.phaseResult as PhaseResult,
        decision.cause,
        decision.resetsAtMs,
        decision.rateLimitMessage,
        decision.originalCause
      );
      if (failure < DELAYED_RETRY_CAP) {
        expect(run.pendingRetryAt, `failure ${failure}`).not.toBeNull();
        run = { ...run, status: 'running', pendingRetryAt: null, pendingRetryCause: null } as WorkflowRun;
      }
    }
    // Counted from the writes, not from the deadline arms: the arms are idempotent per deadline,
    // and five failures in one millisecond share one.
    expect(persisted.filter((written) => written.pendingRetryAt !== null)).toHaveLength(
      DELAYED_RETRY_CAP - 1
    );
    expect(run.delayedRetryCount).toBe(DELAYED_RETRY_CAP);
    expect(run.pendingRetryAt).toBeNull();
    expect(run.pendingRetryCause).toBeNull();
    expect(run.status).toBe('paused');
  });

  it('the failing rows arm no retry at all: no delay source, no automatic attempt', () => {
    const failing = SCENARIOS.filter((scenario) => CONTRACT[scenario].delayMs === null);
    expect(failing.sort()).toEqual(['auth', 'overload', 'timeout']);
    for (const scenario of failing) {
      expect(decisionFor(scenario, runAt(0)).kind, scenario).toBe('fail');
    }
  });
});

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

describe('an operator interrupts a countdown at any point (FR-023; US7-3)', () => {
  async function pausedInCountdown(): Promise<{
    store: WorkspaceStateStore;
    coordinator: RetryCoordinator;
    run: WorkflowRun;
  }> {
    const store = new WorkspaceStateStore(new FakeMemento());
    await store.initialize();
    const persisted: WorkflowRun[] = [];
    const { coordinator } = makeCoordinator(persisted);
    const run = runAt(0);
    const decision = decisionFor('dns', run);
    if (decision.kind !== 'pause-delayed-retry') throw new Error(`unexpected decision ${decision.kind}`);
    const counting = await coordinator.handleDelayedRetry(
      run,
      1,
      decision.phaseResult as PhaseResult,
      decision.cause,
      decision.resetsAtMs,
      decision.rateLimitMessage,
      decision.originalCause
    );
    await store.setRun(DEFAULT_QUEUE_ID, counting, unfencedCommit('test-fixture'));
    expect(coordinator.hasPendingDelayedRetry(DEFAULT_QUEUE_ID)).toBe(true);
    return { store, coordinator, run: counting };
  }

  it('Pause drops the queue deadline and stamps the manual pause', async () => {
    const { store, coordinator, run } = await pausedInCountdown();
    const service = new PhaseControlService({
      store,
      queue: { cascadedPause: vi.fn(async () => {}), cascadedResume: vi.fn(), setQueuePausedState: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      retryCoordinator: coordinator,
      isDriving: () => false,
      noteActivePhaseOverrideAbort: vi.fn(),
      armIsContinue: vi.fn(),
      cancelActive: vi.fn(),
      resumeExisting: vi.fn(async () => true),
      auditor: {
        appendPhaseControl: vi.fn(async () => {}),
        emitTaskPaused: vi.fn(async () => {}),
        emitPhaseJumped: vi.fn(async () => {}),
        appendBreakpoint: vi.fn(async () => {})
      }
    } as unknown as ConstructorParameters<typeof PhaseControlService>[0]);

    const result = await service.pauseActivePhase(DEFAULT_QUEUE_ID);

    expect(result.ok).toBe(true);
    expect(coordinator.hasPendingDelayedRetry(DEFAULT_QUEUE_ID)).toBe(false);
    const after = store.getRun(DEFAULT_QUEUE_ID) as WorkflowRun;
    expect(after.id).toBe(run.id);
    expect(after.manualPauseCause).toBe('operator-paused');
  });

  it('Cancel ends the Run and clears the retry pair, so a deadline that fires finds nothing to resume', async () => {
    const { store, run } = await pausedInCountdown();

    await store.updateRun(
      DEFAULT_QUEUE_ID,
      {
        runId: run.id,
        allowedStatuses: ['running', 'paused'],
        label: 'cancel',
        patch: () => canceledRunPatch(Date.now())
      },
      unfencedCommit('test-fixture')
    );

    const after = store.getRun(DEFAULT_QUEUE_ID) as WorkflowRun;
    expect(after.status).toBe('canceled');
    expect(after.pendingRetryAt).toBeNull();
    expect(after.pendingRetryCause).toBeNull();
  });
});
