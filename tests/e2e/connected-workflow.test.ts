// FR-R3-129 (T1491, FR-003) — a connected Workflow's node transition, end to end.
//
// THE FINDING THIS TEST EXISTS TO PIN. `recordChildTerminal` in
// `src/services/workflow-execution/connected-run-coordinator.ts` —
// *"evaluate and record one node's outgoing connections (FR-020, FR-030)"* — had
// **no production caller**. A whole-tree sweep found it in two test files and
// nowhere in `src/`; `onRunTerminal` finalized the transcript, swept retention, and
// routed nothing. So a connected Workflow's node could reach a terminal state and no
// routing decision was ever appended, leaving the append-only trail that exists to
// answer *"why was this branch not offered"* empty in every real Run.
//
// The four `tests/integration/workflow-execution/` suites could not see it: each
// calls `recordChildTerminal` itself, with a fake facts reader. That is the right
// shape for testing the coordinator and it structurally cannot notice that nobody
// calls it. This test drives the terminal path instead, so the wiring is the thing
// under test rather than the setup.
//
// WHAT IT ASSERTS, and all three are what T1491 names:
//
//   * NODE TRANSITION — a routing decision is appended when the node's Run ends.
//   * CHILD ATTRIBUTION — the decision's operands resolve from the REAL Run's
//     terminal status, read through the production `ChildRunFactsReader`, not a stub.
//   * CONTINUATION POSITION — the decision names which connections are eligible, in
//     offer order, which is what a later operator continuation reads.
//
// AND THE NEGATIVE, which matters more than the three: **no node starts on its own.**
// `FR-R3-088` refused a workflow scheduler deliberately (FR-039/FR-040 — the
// operator submits the continuation), and this wiring is the first thing in the tree
// that could have broken that refusal. The queue is asserted unchanged.
//
// It does not boot Electron, for the reason `pipeline.test.ts` states about itself.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { SanitizedLogger } from '../../src/lib/logger';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { ClaudeCliRunner } from '../../src/runner/claude-cli';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import { recordChildTerminal } from '../../src/services/workflow-execution/connected-run-coordinator';
import { makeChildRunFactsReader } from '../../src/services/workflow-execution/child-run-facts-reader';
import type { ConnectedWorkflowRun } from '../../src/state/connected-workflow-run';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { buildSpeckitCatalog, SPECKIT_PIPELINE_ID } from '../fixtures/speckit-catalog-fixture';

const FAKE_CLAUDE_PATH = path.resolve(__dirname, 'fixtures', 'fake-claude', 'index.js');

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

function makeLock(): WorkspaceLockManager {
  return {
    release: vi.fn(async () => {}),
    tryAcquire: vi.fn(async () => ({ acquired: true, ownerId: 'this-window' })),
    heartbeat: vi.fn(async () => {}),
    isHeld: vi.fn(() => true),
    isForeignLockHeld: vi.fn(() => false),
    ownerOfRecord: vi.fn(() => 'this-window'),
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
}

/**
 * A two-node Workflow with one condition on the outgoing edge.
 *
 * The smallest graph that can answer T1491: one node that runs, one edge whose
 * condition is evaluated against that node's terminal status, and one node the edge
 * points at so "eligible" means something.
 */
function twoNodeWorkflow(queueItemId: string, pipelineSnapshot: unknown): ConnectedWorkflowRun {
  // FROZEN, because `assertConnectedRunInvariants` requires it (FR-003/FR-004: the
  // graph and the Pipeline snapshots are frozen at start and never aliased to the
  // catalog). The invariant caught this fixture's first version, which is the
  // invariant working.
  return Object.freeze({
    connectedRunId: 'cr-e2e-1',
    workflowId: 'wf-e2e',
    graph: Object.freeze({
      workflowId: 'wf-e2e',
      name: 'E2E two-node',
      version: 1,
      nodes: [
        { nodeId: 'n-first', pipelineId: SPECKIT_PIPELINE_ID, label: 'First' },
        { nodeId: 'n-second', pipelineId: SPECKIT_PIPELINE_ID, label: 'Second' }
      ],
      connections: [
        {
          from: { nodeId: 'n-first', portId: 'out' },
          to: { nodeId: 'n-second', portId: 'in' },
          condition: {
            left: { source: 'node-status', nodeId: 'n-first' },
            operator: 'equals',
            right: 'completed'
          }
        }
      ],
      startNodeIds: ['n-first']
    }),
    pipelines: Object.freeze({ [SPECKIT_PIPELINE_ID]: pipelineSnapshot }),
    nodes: { 'n-first': { nodeId: 'n-first', attempts: [{ queueItemId, startedAt: Date.now() }] } },
    decisions: [],
    revision: 1,
    startedAt: Date.now(),
    queueId: DEFAULT_QUEUE_ID
  }) as unknown as ConnectedWorkflowRun;
}

let tmpRoot: string;
let priorMode: string | undefined;
let priorStateDir: string | undefined;

async function buildHost(root: string) {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot: root }, logger);
  const phaseRunner = new PhaseRunner(new ClaudeCliRunner(), new PromptBuilder(), audit, logger);
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  const queue = new QueueManager(store);
  const controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier,
    logger,
    makeLock(),
    { cliPath: FAKE_CLAUDE_PATH, cwd: root, iterationCap: 5, timeoutMs: 30_000 },
    { catalog: buildSpeckitCatalog() }
  );
  return { controller, store, queue, logger };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-e2e-connected-'));
  const stateDir = path.join(tmpRoot, '.e2e-stub-state');
  await fs.mkdir(stateDir, { recursive: true });
  priorMode = process.env.SCHEGENT_E2E_MODE;
  priorStateDir = process.env.SCHEGENT_E2E_STATE_DIR;
  process.env.SCHEGENT_E2E_STATE_DIR = stateDir;
  process.env.SCHEGENT_E2E_MODE = 'happy';
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  if (priorMode === undefined) delete process.env.SCHEGENT_E2E_MODE;
  else process.env.SCHEGENT_E2E_MODE = priorMode;
  if (priorStateDir === undefined) delete process.env.SCHEGENT_E2E_STATE_DIR;
  else process.env.SCHEGENT_E2E_STATE_DIR = priorStateDir;
});

describe('FR-R3-129 (T1491) — a connected Workflow node transition, end to end', () => {
  it('records the routing decision from the real Run, and starts nothing', async () => {
    const host = await buildHost(tmpRoot);
    const feature = await host.queue.enqueue('e2e connected workflow node');

    // The node's child Run, driven through the REAL spawn boundary.
    await host.controller.startNew(feature, null);
    const childRun = host.store.getRun(DEFAULT_QUEUE_ID);
    expect(childRun, 'the node produced no Run').not.toBeNull();
    expect(childRun?.status, 'the fake-claude happy path must complete').toBe('completed');

    // The connected record naming that child as `n-first`'s attempt.
    const written = await host.store.compareAndSetConnectedRun(
      twoNodeWorkflow(feature.id, childRun!.pipeline),
      0
    );
    expect(written.outcome, 'the connected record was not written').toBe('written');

    const queueBefore = host.store.getQueue(DEFAULT_QUEUE_ID).requests.length;

    // The terminal path, with the PRODUCTION facts reader — not a stub. This is the
    // wiring `run-safety-wiring.ts` performs; driving it here keeps the assertion on
    // the recorded decision rather than on a private call.
    const result = await recordChildTerminal(
      {
        connectedRuns: host.store,
        readChildFacts: makeChildRunFactsReader({
          runsByQueue: () => host.store.getRunMap(),
          history: () => host.store.getHistory()
        }),
        logger: host.logger
      },
      {
        run: host.store.getConnectedRun('cr-e2e-1')!,
        nodeId: 'n-first',
        attemptIndex: 0,
        decidedAt: Date.now()
      }
    );

    // NODE TRANSITION — a decision was appended.
    expect(result.outcome, 'the transition was not recorded').toBe('recorded');
    if (result.outcome !== 'recorded') return;
    const stored = host.store.getConnectedRun('cr-e2e-1')!;
    expect(stored.decisions).toHaveLength(1);
    expect(stored.decisions[0]!.nodeId).toBe('n-first');
    expect(stored.decisions[0]!.attemptIndex).toBe(0);

    // CHILD ATTRIBUTION — the operand resolved from the real Run's terminal status,
    // read through the production reader. A stub could have said anything; this
    // could only have come from the Run that actually ran.
    const statusOperand = stored.decisions[0]!.operands.find(
      (operand) => operand.source === 'node-status' && operand.nodeId === 'n-first'
    );
    expect(statusOperand, 'the decision resolved no node-status operand').toBeDefined();
    expect(statusOperand?.resolved).toBe(true);
    expect(statusOperand?.compared).toBe('completed');

    // CONTINUATION POSITION — the edge whose condition matched is eligible, in offer
    // order, which is what a later operator continuation reads.
    expect(stored.decisions[0]!.eligible).toEqual([0]);
    expect(stored.decisions[0]!.defaultApplied).toBe(false);

    // THE NEGATIVE, and it is the one that matters. FR-R3-088 refused a workflow
    // scheduler on purpose; recording a decision must not start the next node.
    expect(
      host.store.getQueue(DEFAULT_QUEUE_ID).requests.length,
      'recording a routing decision enqueued something — that is a scheduler, and ' +
        'FR-R3-088 refused one deliberately'
    ).toBe(queueBefore);
    expect(host.store.getConnectedRun('cr-e2e-1')!.nodes['n-second']).toBeUndefined();
  });

  it('refuses to route a child that has not finished', async () => {
    // The production reader answering `null` is what makes the coordinator's
    // `not-terminal` arm reachable. A reader that guessed a status would evaluate
    // every condition against a fact nobody has.
    const host = await buildHost(tmpRoot);
    const written = await host.store.compareAndSetConnectedRun(
      twoNodeWorkflow('no-such-queue-item', { id: SPECKIT_PIPELINE_ID, name: 'x', phases: [] }),
      0
    );
    expect(written.outcome).toBe('written');

    const result = await recordChildTerminal(
      {
        connectedRuns: host.store,
        readChildFacts: makeChildRunFactsReader({
          runsByQueue: () => host.store.getRunMap(),
          history: () => host.store.getHistory()
        }),
        logger: host.logger
      },
      {
        run: host.store.getConnectedRun('cr-e2e-1')!,
        nodeId: 'n-first',
        attemptIndex: 0,
        decidedAt: Date.now()
      }
    );

    expect(result.outcome).toBe('ignored');
    if (result.outcome !== 'ignored') return;
    expect(result.reason).toBe('not-terminal');
    expect(host.store.getConnectedRun('cr-e2e-1')!.decisions).toHaveLength(0);
  });
});

/**
 * FR-R3-129 (T1491, T016) — the wiring itself, asserted.
 *
 * The two cases above drive `recordChildTerminal` with the production facts reader,
 * which proves the coordinator and the reader agree about a real Run. They cannot
 * prove that anything in `src/` CALLS it — and that was the entire defect: two test
 * files called it and nothing else did, so every suite was green over a Workflow that
 * never transitioned.
 *
 * So the terminal path is asserted at the source, the way
 * `tests/unit/services/terminal-outcome-emitter.test.ts` asserts its own invariant.
 * A source-text check is a weak tool and it is the right one here: the property is
 * "a production module reaches this function", and no behavioural test can observe
 * the absence of a call.
 */
describe('the terminal path reaches the coordinator (FR-R3-129)', () => {
  it('run-safety-wiring routes a terminal Run into recordChildTerminal', async () => {
    const wiring = await fs.readFile(
      path.resolve(__dirname, '..', '..', 'src', 'activation', 'run-safety-wiring.ts'),
      'utf8'
    );
    expect(
      wiring,
      'src/activation/run-safety-wiring.ts no longer imports recordChildTerminal. That import IS ' +
        'the fix FR-R3-129 made: before it, a connected Workflow node could reach a terminal ' +
        'state and no routing decision was ever appended, and every suite was green over it ' +
        'because the only callers were test files.'
    ).toContain('recordChildTerminal');
    expect(wiring).toContain('makeChildRunFactsReader');

    // Reached FROM the terminal handler, not merely imported.
    //
    // Sliced to the handler's own closing brace rather than by a fixed character
    // window. The first version used 1,200 characters and passed with the call
    // removed, because the window ran past the handler and into the helper's own
    // definition further down the file — the same over-reaching anchor
    // `terminal-outcome-emitter.test.ts` records about an unbounded `indexOf`. A
    // check that reads past its subject is a check that cannot fail.
    const terminalAt = wiring.indexOf('onRunTerminal:');
    expect(terminalAt, 'onRunTerminal is gone').toBeGreaterThan(0);
    const handler = wiring.slice(terminalAt, wiring.indexOf('\n    }', terminalAt));
    expect(
      handler,
      'the terminal handler no longer reaches the connected-workflow routing record'
    ).toMatch(/recordConnectedWorkflowTransition|recordChildTerminal/);

    // And it must stay best-effort: a routing-record failure cannot throw out of the
    // terminal handler and leave the rest of a Run's bookkeeping undone.
    const routing = wiring.slice(wiring.indexOf('async function recordConnectedWorkflowTransition'));
    expect(routing, 'the routing record is not guarded').toMatch(/try\s*\{/);
    expect(routing).toMatch(/logger\.warn/);
  });
});
