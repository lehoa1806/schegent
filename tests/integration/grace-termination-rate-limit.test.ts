// FR-R4-F02 (spec 240, US5; contract L4 G11 to G13; FR-016, D7) — a rate limit the host grace
// terminated.
//
// The relevance of host grace termination to rate-limit classification is a lifecycle question: a
// child prints its terminal result and does not exit, the host waits out its settle window and
// sends SIGTERM and then SIGKILL, and the capture it classifies then ends in the host's own signal.
// This runs the SYNTHETIC stub `tests/fixtures/grace-termination-stub.mjs` through the REAL
// `ClaudeCliRunner` and `PhaseRunner`, so detection and parsing run for real and only the child is
// invented. Nothing here says how often a real CLI does this (Q3, qualification, never run here).
//
// Real timers, a real child, a temp root only (contract L4 G12): nothing is retained after the
// file, and no counter, metric or persisted field is added.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ClaudeCliRunner } from '../../src/runner/claude-cli';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { SanitizedLogger } from '../../src/lib/logger';
import { PhaseRunner, type PhaseRunInputs, type PhaseRunOutput } from '../../src/controller/phase-runner';
import { PhaseSequencer } from '../../src/controller/phase-sequencer';
import { RetryHandler, type RetryHandlerDeps } from '../../src/controller/retry-handler';
import { DELAYED_RETRY_CAP } from '../../src/contracts/retry-bounds';
import type { AuditLogWriter } from '../../src/audit/audit-log-writer';
import type { AuditEntry } from '../../src/audit/audit-entry';
import type { PhaseResult, WorkflowRun } from '../../src/state/workflow-run';

const STUB = resolve(__dirname, '../fixtures/grace-termination-stub.mjs');
const SCENARIOS = ['quoted', 'genuine', 'incidental'] as const;
type Scenario = (typeof SCENARIOS)[number];

/** The settle window is 15 s and the SIGTERM-to-SIGKILL ladder 2 s; all three run at once. */
const ALL_SCENARIOS_TIMEOUT_MS = 90_000;
/** Idle window before the result: generous, the stub prints at once. */
const INVOCATION_IDLE_MS = 60_000;

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
  // The runner builds the CLI's argv itself, so the stub is reached through a one-line wrapper that
  // drops those arguments and names the scenario.
  const wrapper = join(root, `cli-${scenario}.sh`);
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" ${scenario}\n`);
  await chmod(wrapper, 0o755);
  const inputs: PhaseRunInputs = {
    phase: 'finalize',
    iteration: 1,
    iterationCap: 5,
    featureDescription: 'grace termination',
    featureDir: 'specs/240-grace-termination',
    cliPath: wrapper,
    cwd: root,
    timeoutMs: INVOCATION_IDLE_MS,
    runId: `run-${scenario}`
  };
  const logger = new SanitizedLogger();
  const cli = new ClaudeCliRunner(undefined, null, {}, logger);
  return new PhaseRunner(cli, new PromptBuilder(), capturingAuditWriter(), logger).run(inputs);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'schegent-grace-termination-'));
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

describe('the host grace-terminates a child that printed its result and did not exit', () => {
  it('control: every scenario was ended by the host after its result, not by an idle timeout', () => {
    for (const scenario of SCENARIOS) {
      const output = outputOf(scenario);
      expect(output.terminationReason, scenario).not.toBe('timeout');
      expect(output.terminationReason, scenario).not.toBe('deadline');
    }
  });

  it('a quoted rate_limit_event inside a tool_result is not a rate limit (FR-012, FR-014)', () => {
    const output = outputOf('quoted');
    expect(output.result.kind).not.toBe('rate_limited');
    expect(output.outcome).not.toBe('rate_limited');
  });

  it('incidental 429 text is not a rate limit (FR-012, FR-013)', () => {
    const output = outputOf('incidental');
    expect(output.result.kind).not.toBe('rate_limited');
    expect(output.outcome).not.toBe('rate_limited');
  });

  it('a genuine rejected record is rate-limited, with its reset time (FR-015)', () => {
    const output = outputOf('genuine');
    expect(output.result.kind).toBe('rate_limited');
    if (output.result.kind !== 'rate_limited') return;
    expect(output.result.cause).toBe('rate-limit');
    expect(output.result.resetsAtMs).toBeGreaterThan(Date.now());
  });
});

describe('the retry cap still bounds a genuine rate limit (contract L4 G13)', () => {
  function runAt(delayedRetryCount: number): WorkflowRun {
    const now = Date.now();
    return {
      id: 'run-cap',
      featureId: 'task-cap',
      featureDir: 'specs/240-grace-termination',
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

  function handlerOver(persisted: WorkflowRun[]): RetryHandler {
    const deps = {
      store: {},
      queue: {
        queueIdForTask: () => 'default',
        pause: vi.fn(async () => ({ ok: true })),
        setQueuePausedState: vi.fn(async () => {})
      },
      statusBar: { update: vi.fn() },
      notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      armDelayedRetry: vi.fn(async () => {}),
      auditWriter: { append: vi.fn(async () => ({ id: 'a', timestamp: 't' })) },
      getRetryCap: () => DELAYED_RETRY_CAP,
      persistTransition: async (_prev: WorkflowRun, next: WorkflowRun) => {
        persisted.push(next);
        return next;
      },
      getGuardedRunService: () => null,
      clock: () => Date.now()
    } as unknown as RetryHandlerDeps;
    return new RetryHandler(deps);
  }

  function decisionFor(run: WorkflowRun): ReturnType<PhaseSequencer['decideAfterPhase']> {
    return new PhaseSequencer().decideAfterPhase({
      run,
      output: outputOf('genuine'),
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: null,
      now: Date.now(),
      forceContinueOnRetryCapDefault: false
    });
  }

  it('the genuine record is a delayed retry below the cap, scheduled from its reset', async () => {
    const run = runAt(0);
    const decision = decisionFor(run);
    expect(decision.kind).toBe('pause-delayed-retry');
    if (decision.kind !== 'pause-delayed-retry') return;
    expect(decision.cause).toBe('rate_limit');
    expect(decision.resetsAtMs).not.toBeNull();

    const persisted: WorkflowRun[] = [];
    const next = await handlerOver(persisted).handleDelayedRetry(
      run,
      1,
      decision.phaseResult as PhaseResult,
      decision.cause,
      decision.resetsAtMs,
      decision.rateLimitMessage,
      decision.originalCause
    );
    expect(next.delayedRetryCount).toBe(1);
    expect(next.pendingRetryCause).toBe('rate_limit');
    expect(next.pendingRetryAt).toBeGreaterThanOrEqual(decision.resetsAtMs!);
  });

  it('repeated past DELAYED_RETRY_CAP it ends in the existing cap handling: no further retry is armed', async () => {
    const run = runAt(DELAYED_RETRY_CAP - 1);
    const decision = decisionFor(run);
    if (decision.kind !== 'pause-delayed-retry') throw new Error(`unexpected decision ${decision.kind}`);

    const persisted: WorkflowRun[] = [];
    const next = await handlerOver(persisted).handleDelayedRetry(
      run,
      1,
      decision.phaseResult as PhaseResult,
      decision.cause,
      decision.resetsAtMs,
      decision.rateLimitMessage,
      decision.originalCause
    );
    expect(next.delayedRetryCount).toBe(DELAYED_RETRY_CAP);
    expect(next.pendingRetryAt).toBeNull();
    expect(next.pendingRetryCause).toBeNull();
    expect(next.status).toBe('paused');
  });
});
