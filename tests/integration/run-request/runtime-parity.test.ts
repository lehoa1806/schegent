// Feature 087 (T067, US7, FR-037, SC-009) — a composed Run is not a new
// execution path.
//
// FR-037 says the existing audit, transcript, cancellation, timeout, retry,
// pause, breakpoint, monitoring, and workspace-lock behaviors stay in force for
// a composed Run, and SC-009 puts a number on it: "100% of the existing runtime
// guarantees apply to composed runs, with no new execution path introduced."
//
// The only honest way to test "no new path" is a differential. Each case below
// runs the *same* Pipeline twice against the *same* real controller wiring —
// once from a queue item carrying a `FrozenRunPlan` and once from a plain
// enqueue — and compares what the runtime produced. Asserting the composed run
// alone would pin its behavior; it would not pin that the behavior is the same
// one.
//
// What is compared, and why each is the right observable:
//
//   Audit — the on-disk `.schegent/audit.log`, as the sequence of
//   `(eventType, phase, iteration, outcome)` plus each payload's key set. Keys
//   rather than values, because values legitimately differ (run identifiers,
//   timestamps, durations); a *new* payload field, or a missing one, is the
//   drift this catches.
//
//   Transcript — the raw transcript the run wrote, keyed by run id. Compared as
//   its own event sequence for the same reason.
//
//   Lock — `withLock` scopes recorded in order, with release accounted for by
//   the wrapper. A composed run that acquired a different scope, acquired
//   twice, or left the lock held would show here.
//
//   Cancellation — a real in-flight cancel. The CLI double blocks inside the
//   first Phase, the test cancels while the run is genuinely mid-Phase, and the
//   drive loop's abort check does the rest. Both paths must reach the same
//   terminal status through the same seam.
//
// The Pipeline ends in `done` deliberately: `WorkflowRunFactory.resolvePipeline`
// appends a `done` Phase when one is absent while `validateRunRequest` does
// not, so a Pipeline without it would differ for a reason that has nothing to
// do with runtime parity.

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import { PhaseRunner } from '../../../src/controller/phase-runner';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { RawTranscriptWriter } from '../../../src/audit/raw-transcript-writer';
import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import { SanitizedLogger } from '../../../src/lib/logger';
import {
  buildCatalog,
  type PhaseDef,
  type PipelineCatalog,
  type PipelineDef
} from '../../../src/config/pipeline-config';
import type { RunRequest } from '../../../src/contracts/run-request';
import {
  validateRunRequest,
  type EffectivePipelineSource
} from '../../../src/services/run-request/run-request-validator';
import type { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import type { InvocationRequest, RawInvocationOutput } from '../../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { Notifier } from '../../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../../src/state/lock';

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

const COMPOSE: PhaseDef = {
  id: 'compose', name: 'Compose', version: 1, instruction: 'Compose the thing.',
  sourceScope: 'built-in'
};
const REFINE: PhaseDef = {
  id: 'refine', name: 'Refine', version: 1, instruction: 'Refine the thing.',
  sourceScope: 'built-in'
};
const DONE: PhaseDef = {
  id: 'done', name: 'Done', version: 1, instruction: '(no-op)', sourceScope: 'built-in'
};

/**
 * Two working Phases before `done`. The second one exists so cancellation has
 * somewhere to land: the drive loop checks its abort signal at the top of each
 * iteration, so a cancel raised during the first Phase is observed before the
 * second — a single-Phase Pipeline would complete instead.
 */
const PARITY_FLOW: PipelineDef = {
  id: 'parity-flow',
  name: 'Parity Flow',
  phases: ['compose', 'refine', 'done'],
  sourceScope: 'workspace',
  inputs: [{ portId: 'brief', label: 'Brief', type: 'text', required: true }],
  outputs: []
};

function catalog(): PipelineCatalog {
  return buildCatalog(
    [COMPOSE, REFINE, DONE], [PARITY_FLOW], { claude: [], codex: [], agy: [] }, 'parity-flow'
  );
}

const SOURCE: EffectivePipelineSource = {
  definition: PARITY_FLOW,
  phases: [COMPOSE, REFINE, DONE],
  defaultRunnerKind: 'claude'
};

const DESCRIPTION = 'compose the parity run';

const REQUEST: RunRequest = {
  pipelineId: 'parity-flow',
  inputs: [{ portId: 'brief', type: 'text', value: 'the brief' }],
  supplemental: [],
  outputs: [],
  instructions: DESCRIPTION
};

const cleanStdout = (phase: string): string =>
  [
    '[SCHEGENT_STATUS: CLEAR]',
    '=== SCHEGENT AUDIT LOG ===',
    `phase: ${phase}`,
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: ["mock"]',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    'open_questions: 0',
    'critical_issues: 0',
    'notes: ok',
    '=== END AUDIT LOG ==='
  ].join('\n');

function output(phase: string): RawInvocationOutput {
  const stdout = new ZippedStreamBuffer();
  stdout.append(cleanStdout(phase));
  stdout.finalize();
  const stderr = new ZippedStreamBuffer();
  stderr.finalize();
  return { stdoutBuffer: stdout, stderrBuffer: stderr, exitCode: 0, killed: false, timedOut: false, durationMs: 1 };
}

/** A lock double that records every acquisition, and whether each released. */
function recordingLock(): {
  lock: WorkspaceLockManager;
  scopes: string[];
  releases: () => number;
} {
  const scopes: string[] = [];
  const state = { released: 0 };
  const lock = {
    release: vi.fn(async () => { state.released += 1; }),
    tryAcquire: vi.fn(async () => ({ acquired: false, owner: null })),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    withLock: async function (
      this: { release(): Promise<void> },
      scope: string,
      fn: (session: { retain(): void }) => Promise<unknown>
    ) {
      scopes.push(scope);
      let retain = false;
      try {
        return await fn({ retain: () => { retain = true; } });
      } finally {
        if (!retain) await this.release().catch(() => undefined);
      }
    },
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
  return { lock, scopes, releases: () => state.released };
}

interface Harness {
  readonly controller: SchegentWorkflowController;
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly workspaceRoot: string;
  readonly scopes: readonly string[];
  readonly releases: () => number;
  readonly cliCancels: () => number;
}

/**
 * The production wiring, with only the CLI and the lock doubled. Everything
 * that produces the observables under comparison — the factory, the driver,
 * the phase runner, the audit writer, the transcript writer — is real.
 */
async function makeHarness(
  workspaceRoot: string,
  invoke: (req: InvocationRequest) => Promise<RawInvocationOutput>
): Promise<Harness> {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot }, logger);
  const transcript = new RawTranscriptWriter(workspaceRoot, logger);
  let cliCancels = 0;
  const runner = {
    invoke: vi.fn(invoke),
    cancelActive: vi.fn(() => { cliCancels += 1; return false; }),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
  const phaseRunner = new PhaseRunner(runner, new PromptBuilder(), audit, logger, transcript);

  const memento = new FakeMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  const { lock, scopes, releases } = recordingLock();

  const controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier,
    logger,
    lock,
    { cliPath: 'noop', cwd: workspaceRoot, iterationCap: 5, timeoutMs: 1000, skipProbing: true },
    { auditWriter: audit, catalog: catalog() }
  );

  return { controller, store, queue, workspaceRoot, scopes, releases, cliCancels: () => cliCancels };
}

/** Enqueues either a composed item (carrying a frozen plan) or a plain one. */
async function enqueue(harness: Harness, composed: boolean): Promise<string> {
  if (!composed) {
    const feature = await harness.queue.enqueue(DESCRIPTION, { pipelineId: PARITY_FLOW.id });
    return feature.id;
  }
  const outcome = await validateRunRequest(REQUEST, {
    pipeline: SOURCE,
    workspaceRoot: harness.workspaceRoot,
    now: Date.now(),
    localInputs: {
      checkFile: async () => ({ ok: true }) as const,
      checkFolder: async () => ({ ok: true }) as const
    },
    outputProbe: { exists: async () => false },
    priorOutputs: { outputsFor: () => [] as const }
  });
  if (!outcome.ok) throw new Error(`fixture request did not validate: ${JSON.stringify(outcome.errors)}`);
  const feature = await harness.queue.enqueue(DESCRIPTION, {
    pipelineId: outcome.plan.pipeline.id,
    runPlan: outcome.plan
  });
  return feature.id;
}

/** One audit line, reduced to what must match across the two paths. */
interface AuditShape {
  readonly eventType: string;
  readonly phase: string;
  readonly iteration: number;
  readonly outcome: string;
  readonly payloadKeys: readonly string[];
}

async function readAuditShapes(workspaceRoot: string): Promise<readonly AuditShape[]> {
  const raw = await fs.readFile(path.join(workspaceRoot, '.schegent', 'audit.log'), 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map((entry) => ({
      eventType: String(entry.eventType),
      phase: String(entry.phase),
      iteration: Number(entry.iteration),
      outcome: String(entry.outcome),
      payloadKeys: Object.keys((entry.payload ?? {}) as object).sort()
    }));
}

/** The transcript a run wrote, reduced the same way. */
async function readTranscriptShapes(
  workspaceRoot: string,
  runId: string
): Promise<readonly string[]> {
  const file = path.join(workspaceRoot, '.schegent', 'sessions', `raw-${runId}.log`);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  return raw
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return `${String(parsed.type ?? parsed.event ?? 'entry')}:${String(parsed.phase ?? '')}`;
      } catch {
        // Non-JSON transcript bytes are compared by presence, not content —
        // the writer sink must never transform them, so their text is the
        // CLI's, not this feature's.
        return 'raw';
      }
    });
}

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-087-parity-'));
});

afterAll(async () => {
  // The transcript writer's spool cleanup can still be settling when the last
  // assertion returns, so the removal retries rather than racing it.
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Everything one run leaves behind that the two paths must agree on. */
interface Observed {
  readonly audit: readonly AuditShape[];
  readonly transcript: readonly string[];
  readonly scopes: readonly string[];
  readonly releases: number;
  readonly status: string;
  readonly phasesCompleted: readonly string[];
  readonly runInputs: unknown;
}

/** Drives one full run and collects every observable under comparison. */
async function runToCompletion(composed: boolean): Promise<Observed> {
  const workspaceRoot = await fs.mkdtemp(path.join(tmpRoot, composed ? 'composed-' : 'plain-'));
  const harness = await makeHarness(workspaceRoot, async (req) => output(req.phase));
  const featureId = await enqueue(harness, composed);
  const feature = harness.queue.findById(featureId)!;

  await harness.controller.startNew(feature, null);

  const run = harness.store.getRun()!;
  return {
    audit: await readAuditShapes(workspaceRoot),
    transcript: await readTranscriptShapes(workspaceRoot, run.id),
    scopes: harness.scopes,
    releases: harness.releases(),
    status: run.status,
    phasesCompleted: run.phasesCompleted.map(
      (entry) => `${entry.phase}#${entry.iteration}:${entry.result}`
    ),
    runInputs: (run as { runInputs?: unknown }).runInputs
  };
}

describe('a composed run and a plain run leave the same runtime trace (FR-037, SC-009)', () => {
  // One pair of runs, compared from several angles. Re-running the pair per
  // assertion would compare a different pair each time — and would pay for two
  // real, disk-backed drives to answer each question.
  let plain: Observed;
  let composed: Observed;

  beforeAll(async () => {
    plain = await runToCompletion(false);
    composed = await runToCompletion(true);
  }, 30_000);

  it('writes the same audit event sequence, with the same payload shape', () => {
    expect(plain.audit.length).toBeGreaterThan(0);
    expect(composed.audit).toEqual(plain.audit);
  });

  it('writes the same transcript event sequence', () => {
    // Guarded like the audit sweep above: two empty transcripts would compare
    // equal and prove nothing.
    expect(plain.transcript.length).toBeGreaterThan(0);
    expect(composed.transcript).toEqual(plain.transcript);
  });

  it('acquires and releases the workspace lock identically', () => {
    expect(plain.scopes).toEqual(['drive-run']);
    expect(plain.releases).toBe(1);
    expect(composed.scopes).toEqual(plain.scopes);
    expect(composed.releases).toBe(plain.releases);
  });

  it('reaches the same terminal status through the same Phase sequence', () => {
    expect(plain.status).toBe('completed');
    expect(composed.status).toBe(plain.status);
    expect(composed.phasesCompleted).toEqual(plain.phasesCompleted);
  });

  it('differs only by the additive record of what it was composed from', () => {
    // The one intended difference, stated rather than left implicit: a composed
    // Run records its frozen inputs (T035) and a plain one writes no such key.
    // Every observable above is identical precisely because nothing downstream
    // reads this field.
    expect(plain.runInputs).toBeUndefined();
    expect(composed.runInputs).toEqual([{ portId: 'brief', type: 'text', value: 'the brief' }]);
  });
});

describe('cancelling a composed run behaves as cancelling any other (FR-037)', () => {
  interface Canceled {
    readonly status: string;
    readonly phasesCompleted: readonly string[];
    readonly releases: number;
    readonly cliCancels: number;
  }

  /**
   * Cancels while the run is genuinely inside its first Phase, then lets that
   * Phase finish. The drive loop checks its abort signal at the top of the next
   * iteration, so the run stops before `refine` rather than after `done`.
   */
  async function runAndCancel(composed: boolean): Promise<Canceled> {
    const workspaceRoot = await fs.mkdtemp(path.join(tmpRoot, composed ? 'cx-' : 'px-'));
    let entered!: () => void;
    const insidePhase = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const harness = await makeHarness(workspaceRoot, async (req) => {
      if (req.phase === 'compose') {
        entered();
        await gate;
      }
      return output(req.phase);
    });
    const featureId = await enqueue(harness, composed);
    const feature = harness.queue.findById(featureId)!;

    const driving = harness.controller.startNew(feature, null);
    await insidePhase;
    harness.controller.cancelActive();
    release();
    await driving;

    const run = harness.store.getRun()!;
    return {
      status: run.status,
      phasesCompleted: run.phasesCompleted.map(
      (entry) => `${entry.phase}#${entry.iteration}:${entry.result}`
    ),
      releases: harness.releases(),
      cliCancels: harness.cliCancels()
    };
  }

  let plain: Canceled;
  let composed: Canceled;

  beforeAll(async () => {
    plain = await runAndCancel(false);
    composed = await runAndCancel(true);
  }, 30_000);

  it('stops at the same point, with the same terminal status', () => {
    expect(plain.status).toBe('canceled');
    // Cancelled after `compose` returned and before `refine` began — the abort
    // is observed at the top of the loop, so the in-flight Phase still records.
    expect(plain.phasesCompleted).toEqual(['compose#1:clean']);
    expect(composed.status).toBe(plain.status);
    expect(composed.phasesCompleted).toEqual(plain.phasesCompleted);
  });

  it('releases the workspace lock on the cancel path too', () => {
    expect(plain.releases).toBe(1);
    expect(composed.releases).toBe(plain.releases);
  });
});
