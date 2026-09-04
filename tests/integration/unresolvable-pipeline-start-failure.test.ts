// FR-R3-160 — a start that fails before admission must fail its task, once.
//
// WHAT THIS GUARDS. `WorkflowController.admitNew` builds the Run before it marks
// the task in-flight, so anything thrown by `WorkflowRunFactory.create` leaves
// the task `pending`. The reachable case is a `pipelineId` absent from the
// effective catalog — a workspace pipeline renamed or deleted while a task
// referencing it sits queued. The failure path then tries to fail the task and,
// before this feature, could not: the closed transition table had no
// `pending -> failed` edge, so `queue.finish` was refused, the refusal was
// logged and ignored, the task stayed pending, and
// `reportUnexpectedStartFailure` ended by re-arming the drain — which re-drove
// the same task into the same refusal. ~19,500 iterations per second, ~1.3 KB
// retained each, until the heap was gone. See specs/196-host-suite-exit-zero/
// research.md §4a.
//
// WHY THE CIRCUIT BREAKER. The loop is composed entirely of microtasks — every
// await in the cycle resolves against an already-settled promise — so it never
// yields to the timer phase. `testTimeout` therefore cannot fire, and a bare
// `await controller.startNew(...)` on a regressed tree would exhaust the
// worker's heap instead of failing this test. The breaker below bounds the loop
// from inside the logger spy and lets the test report a real assertion in both
// states: 1 refusal when the edge exists, `REFUSAL_BREAKER` refusals when it
// does not.
//
// A spy that *throws* was tried first and does not work: `admitNew` catches, the
// throw re-enters the failure path's own logger call, and what escapes is
// swallowed by `scheduleAutoDrain`'s `void ... .catch(...)`. The loop survives
// and the worker still dies. The breaker instead removes the loop's fuel, by
// taking the task out of `pending` through the `pending -> canceled` edge that
// has always been legal.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { SanitizedLogger } from '../../src/lib/logger';
import { buildCatalog, type PhaseDef, type PipelineDef } from '../../src/config/pipeline-config';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { describePipelineRefusal } from '../../src/services/workflow-run-factory';

/**
 * How many refusals to tolerate before cutting the loop's fuel. A correct tree
 * produces exactly one. Anything above one is already the defect; 25 is chosen
 * only to be unmistakably distinguishable from a correct run in the failure
 * message, while still costing microseconds on a regressed one.
 */
const REFUSAL_BREAKER = 25;

/**
 * Microtask turns to yield after `startNew` returns, so a detached auto-drain
 * has room to settle or to trip the breaker. Generous on purpose: each loop
 * iteration spends several turns, so this is well past `REFUSAL_BREAKER`
 * iterations, and on a correct tree the loop is long settled and the turns cost
 * microseconds.
 */
const MICROTASK_YIELDS = 5_000;

/**
 * The pipeline id the queued task names and the effective catalog does not
 * carry. Shared by the `enqueue` call and the log filter so the two cannot
 * drift apart.
 */
const MISSING_PIPELINE_ID = 'nonexistent';

/**
 * The refusal `WorkflowRunFactory` logs for that id, built with production's own
 * phrasing rather than a hand-typed copy of it (code-review finding). A copied
 * substring would stop matching if the wording were ever reworded, and the test
 * would then fail as "expected 1 refusal, got 0" — a message that names the
 * symptom and points nowhere near the cosmetic edit that caused it.
 */
const EXPECTED_REFUSAL = describePipelineRefusal({
  reason: 'pipeline-not-found',
  pipelineId: MISSING_PIPELINE_ID
});

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

const SPECIFY_PHASE: PhaseDef = {
  id: 'speckit-specify',
  name: 'Spec-kit Specify',
  instruction: 'Run /speckit-specify',
  model: 'claude-opus-5',
  runner: 'claude'
};

const KNOWN_PIPELINE: PipelineDef = {
  id: 'speckit-new-feature',
  name: 'Spec-kit New Feature',
  phases: [SPECIFY_PHASE.id]
};

/**
 * A runner that fails the test if it is ever reached. Nothing should invoke the
 * CLI: the pipeline is unresolvable, so the Run is never built and no phase can
 * run. Asserting that here rather than only on a captured array means a
 * regression that somehow *does* start the task is reported as itself, not as a
 * confusing count mismatch further down.
 */
function makeUnreachableCliRunner(): ClaudeCliRunner {
  return {
    invoke: vi.fn(async () => {
      throw new Error('the CLI runner must not be reached for an unresolvable pipeline');
    }),
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
}

function makeLock(): WorkspaceLockManager {
  return {
    release: vi.fn(async () => {}),
    tryAcquire: vi.fn(async () => ({ acquired: false, owner: null })),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-unresolvable-pipeline-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('a start that fails before admission fails its task once (FR-R3-160)', () => {
  it('refuses an unknown pipeline exactly once, fails the task, and settles', async () => {
    const catalog = buildCatalog(
      [SPECIFY_PHASE],
      [KNOWN_PIPELINE],
      { claude: [], codex: [], agy: [] },
      KNOWN_PIPELINE.id
    );

    const logger = new SanitizedLogger();
    const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);
    const phaseRunner = new PhaseRunner(makeUnreachableCliRunner(), new PromptBuilder(), audit, logger);

    const memento = new FakeMemento();
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    const queue = new QueueManager(store);

    const statusBar = { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
    const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;

    const controller = new SchegentWorkflowController(
      phaseRunner,
      store,
      queue,
      statusBar,
      notifier,
      logger,
      makeLock(),
      { cliPath: 'noop', cwd: tmpRoot, iterationCap: 5, timeoutMs: 1000 },
      { catalog }
    );

    const feature = await queue.enqueue('References a pipeline that is gone', {
      pipelineId: MISSING_PIPELINE_ID
    });

    const refusals: string[] = [];
    let breakerFired = false;
    vi.spyOn(logger, 'warn').mockImplementation((message: string) => {
      if (!message.includes(EXPECTED_REFUSAL)) return;
      refusals.push(message);
      if (refusals.length === REFUSAL_BREAKER) {
        breakerFired = true;
        // Not awaited: the spy is synchronous, and the surrounding loop is all
        // microtasks, so this lands within a few turns and takes the task out of
        // `pending` — which is the only thing keeping the loop fed.
        //
        // Swallowed deliberately (code-review finding). This write is an escape
        // hatch, not an assertion — `breakerFired` above is what the test reads.
        // `QueueManager.finish` already absorbs its own refusals, but anything
        // else that rejected here would escape as an unhandled rejection and
        // fail the test with an error unrelated to what it checks.
        void queue.finish(feature.id, 'canceled').catch(() => {});
      }
    });

    await controller.startNew(feature, null);

    // `startNew` returning proves nothing on its own: the auto-drain that
    // `reportUnexpectedStartFailure` re-arms is detached (`void ... .catch(...)`
    // in `scheduleAutoDrain`), so on a regressed tree it outlives the call and
    // goes on consuming the worker after this line — which is how the first
    // version of this test managed to run its assertions and still lose the
    // worker to an OOM before the reporter could flush.
    //
    // Yielding *microtask* turns, and a bounded number of them, is the only wait
    // that works here. The regressed loop never reaches the timer phase, so
    // anything built on `setTimeout`/`setImmediate` — or on `testTimeout` — would
    // never resume. A bounded yield instead interleaves with the loop and gives
    // it room to either settle (one refusal, fixed) or trip the breaker
    // (regressed), and cannot itself hang.
    for (let i = 0; i < MICROTASK_YIELDS; i++) await Promise.resolve();

    expect(
      breakerFired,
      `the start-failure loop ran at least ${REFUSAL_BREAKER} times: a task whose start fails ` +
        'before admission is being re-driven instead of failed. The pending -> failed edge in ' +
        'src/queue/task-transition-decision.ts is what stops this.'
    ).toBe(false);
    expect(refusals).toHaveLength(1);

    // The task reached a terminal state, and it is the right one — `failed`, not
    // the `canceled` the breaker would have written.
    expect(queue.findById(feature.id)?.status).toBe('failed');

    // And nothing was started on the way: no Run persisted, so there is no
    // orphaned record for a Run that never existed.
    expect(store.getRun(DEFAULT_QUEUE_ID)).toBeNull();
  });
});
