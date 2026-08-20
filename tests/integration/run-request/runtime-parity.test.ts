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
//   Lock — every Run-scoped touch of window primacy, counted in both
//   directions. Primacy runs activation-to-disposal (FR-028), so the expected
//   count is zero on all three paths: a composed run that acquired the lock, or
//   released one it never took, would show here.
//
//   Cancellation — a real in-flight cancel. The CLI double blocks inside the
//   first Phase, the test cancels while the run is genuinely mid-Phase, and the
//   drive loop's abort check does the rest. Both paths must reach the same
//   terminal status through the same seam.
//
// The Pipeline ends in `done` deliberately: `WorkflowRunFactory.resolvePipeline`
// used to append a `done` Phase when one was absent while `validateRunRequest`
// did not, so a Pipeline without it would differ for a reason that has nothing
// to do with runtime parity. Feature 098 (T025) removed that append, so the two
// paths agree either way now; the `done` row stays because the catalog defines
// it and a Pipeline naming a Phase the catalog does not hold is refused.
//
// -- Feature 088 (T048, FR-067, SC-009) -------------------------------------
//
// A third variant runs the same comparison for a **node-started child**: a
// queue row produced by starting a Workflow node, through the real launcher,
// the real `GuardedRunService`, and the real store. FR-067 says such a child is
// indistinguishable from an independently launched Run except for its
// connected-run association, and SC-009 counts it.
//
// It is a differential for the same reason the composed case is. The node path
// resolves its Pipeline against the connected run's **frozen snapshot** rather
// than the effective catalog, and it labels its row from the node — two real
// differences upstream of the queue. What must not differ is anything the
// runtime does afterwards, and the only way to state that is to run the same
// Pipeline the same way and compare.
//
// The child is started by `launchWorkflow`, which is a node start: the launch
// and continuation paths reach the queue through the same seam
// (`startPipelineRun`, with the frozen snapshot supplied), so the row under
// comparison is the row either produces. The node's label is set to the same
// description the other two variants enqueue with, so the one thing left to
// differ is the association itself — which lives on the connected-run
// aggregate, never on the queue row.

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
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import { GuardedRunService } from '../../../src/services/guarded-run-service';
import {
  launchWorkflow,
  type WorkflowLauncherDeps
} from '../../../src/services/workflow-execution/workflow-launcher';
import {
  validateRunRequest,
  type EffectivePipelineSource
} from '../../../src/services/run-request/run-request-validator';
import type { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import type { InvocationRequest, RawInvocationOutput } from '../../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { Notifier } from '../../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';

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
};
const REFINE: PhaseDef = {
  id: 'refine', name: 'Refine', version: 1, instruction: 'Refine the thing.',
};
const DONE: PhaseDef = {
  id: 'done', name: 'Done', version: 1, instruction: '(no-op)'
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

/** The connected run the node variant opens, and the node it starts. */
const CONNECTED_RUN_ID = 'connected-parity-1';
const PARITY_NODE_ID = 'n-parity';

/**
 * One node, no connections — the smallest Workflow that starts a child.
 *
 * The label carries `DESCRIPTION` because the launcher labels the queue row
 * from the node (`node.label ?? workflow.name`). Matching it here removes the
 * one incidental difference between this row and the other two variants', so a
 * later divergence in the compared observables cannot be waved off as a
 * different description.
 */
const PARITY_WORKFLOW: WorkflowDefinition = {
  workflowId: 'parity-workflow',
  name: 'Parity Workflow',
  version: 1,
  nodes: [{ nodeId: PARITY_NODE_ID, pipelineId: PARITY_FLOW.id, label: DESCRIPTION }],
  connections: [],
  startNodeIds: [PARITY_NODE_ID]
};

/** Which of the three enqueue paths a run under comparison came from. */
type Variant = 'plain' | 'composed' | 'node';

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

/**
 * A lock double that counts every Run-scoped touch of window primacy, in both
 * directions. This used to record `withLock` scopes, but that method is gone
 * (feature 093, FR-028) and a recorder nothing can write to asserts `[]`
 * vacuously — the gate would keep passing however a Run misbehaved. Counting
 * `tryAcquire` and `release` on the real surface keeps it live: primacy runs
 * activation-to-disposal, so a Run must touch neither.
 */
function recordingLock(): {
  lock: WorkspaceLockManager;
  acquires: () => number;
  releases: () => number;
} {
  const state = { acquired: 0, released: 0 };
  const lock = {
    release: vi.fn(async () => { state.released += 1; }),
    tryAcquire: vi.fn(async () => {
      state.acquired += 1;
      return { acquired: false, owner: null };
    }),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
  return { lock, acquires: () => state.acquired, releases: () => state.released };
}

interface Harness {
  readonly controller: SchegentWorkflowController;
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly lock: WorkspaceLockManager;
  readonly logger: SanitizedLogger;
  readonly workspaceRoot: string;
  readonly acquires: () => number;
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
  // Feature 093 (T082) — per-harness spool root; see the note in
  // `tests/integration/verbose-logging.test.ts`. The default `os.tmpdir()` is
  // scavenged with one `readdir` per instance and this harness builds one per
  // test.
  const transcript = new RawTranscriptWriter(
    workspaceRoot,
    logger,
    path.join(workspaceRoot, 'raw-spool')
  );
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
  const { lock, acquires, releases } = recordingLock();

  const controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier,
    logger,
    lock,
    { cliPath: 'noop', cwd: workspaceRoot, iterationCap: 5, timeoutMs: 1000, skipProbing: true },
    // Feature 098 (PRIV-02) — the manifest default moved to `errors-only`,
    // under which a run that COMPLETES retains no transcript. This suite
    // compares transcripts across three paths, so it names the retentive mode
    // explicitly rather than inheriting whatever the default happens to be;
    // the parity it asserts is between the three paths, not with a default.
    { auditWriter: audit, catalog: catalog(), getRawTranscriptMode: () => 'always' }
  );

  return {
    controller,
    store,
    queue,
    lock,
    logger,
    workspaceRoot,
    acquires,
    releases,
    cliCancels: () => cliCancels
  };
}

/**
 * Starts the parity node of a connected run, through the production launcher.
 *
 * Everything the launcher touches is the harness's own: the real
 * `GuardedRunService` over the real queue and store, and the store itself as
 * the connected-run writer. The row this leaves behind is what the drive loop
 * is then handed, exactly as the host would hand it.
 */
async function startParityNode(harness: Harness): Promise<string> {
  const guardedRun = new GuardedRunService({
    lock: harness.lock,
    queue: harness.queue,
    controller: harness.controller,
    logger: harness.logger,
    store: harness.store,
    catalogProvider: () => catalog()
  });
  const deps: WorkflowLauncherDeps = {
    guardedRun,
    getCatalog: () => catalog(),
    defaultRunnerKind: 'claude',
    logger: harness.logger,
    connectedRuns: harness.store,
    // No attempt exists yet at launch, so the probe is never consulted; it
    // answers the way an unresolvable id answers (see `ChildRunSettledProbe`).
    isChildSettled: () => true
  };
  const launched = await launchWorkflow(deps, {
    connectedRunId: CONNECTED_RUN_ID,
    workflow: PARITY_WORKFLOW,
    catalog: catalog(),
    startNodeId: PARITY_NODE_ID,
    request: REQUEST,
    workspaceRoot: harness.workspaceRoot,
    startedAt: Date.now(),
    defaultRunnerKind: 'claude'
  });
  if (launched.outcome !== 'started') {
    throw new Error(`fixture node did not start: ${JSON.stringify(launched)}`);
  }
  return launched.queueItemId;
}

/** Enqueues a plain item, a composed one (carrying a frozen plan), or a node start. */
async function enqueue(harness: Harness, variant: Variant): Promise<string> {
  if (variant === 'plain') {
    const feature = await harness.queue.enqueue(DESCRIPTION, { pipelineId: PARITY_FLOW.id });
    return feature.id;
  }
  if (variant === 'node') return startParityNode(harness);
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

/**
 * The transcript a run wrote, reduced the same way.
 *
 * Consecutive non-JSON lines collapse to one `raw` marker. FR-R3-001 is why:
 * the transcript opens each invocation with the verbatim prompt, and a composed
 * run's prompt now carries the bound inputs, supplemental context, declared
 * output targets and operator instructions that a plain enqueue has none of. Its
 * prompt is therefore *longer*, on purpose — that is the requirement, not drift.
 *
 * Without the collapse this comparison counts prompt lines, so it fails on
 * exactly the change FR-R3-001 exists to make, and it would keep failing every
 * time the envelope grows a field. Collapsed, it still asserts what FR-037
 * claims: the same sequence of transcript events, with verbatim CLI bytes
 * present, untransformed, in the same places. Presence of the raw span is the
 * guarantee — the writer must never rewrite those bytes — and its length never
 * was.
 */
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
  const shapes = raw
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
  return shapes.filter((shape, index) => shape !== 'raw' || shapes[index - 1] !== 'raw');
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
  readonly acquires: number;
  readonly releases: number;
  readonly status: string;
  readonly phasesCompleted: readonly string[];
  readonly runInputs: unknown;
  /** The queue row that ran, and the node attempts pointing at it (FR-067). */
  readonly queueItemId: string;
  readonly nodeAttempts: readonly string[];
}

/** Drives one full run and collects every observable under comparison. */
async function runToCompletion(variant: Variant): Promise<Observed> {
  const workspaceRoot = await fs.mkdtemp(path.join(tmpRoot, `${variant}-`));
  const harness = await makeHarness(workspaceRoot, async (req) => output(req.phase));
  const featureId = await enqueue(harness, variant);
  const feature = harness.queue.findById(featureId)!;

  await harness.controller.startNew(feature, null);

  const run = harness.store.getRun(DEFAULT_QUEUE_ID)!;
  const connected = harness.store.getConnectedRun(CONNECTED_RUN_ID);
  return {
    audit: await readAuditShapes(workspaceRoot),
    transcript: await readTranscriptShapes(workspaceRoot, run.id),
    acquires: harness.acquires(),
    releases: harness.releases(),
    status: run.status,
    phasesCompleted: run.phasesCompleted.map(
      (entry) => `${entry.phase}#${entry.iteration}:${entry.result}`
    ),
    runInputs: (run as { runInputs?: unknown }).runInputs,
    queueItemId: featureId,
    nodeAttempts: (connected?.nodes[PARITY_NODE_ID]?.attempts ?? []).map(
      (attempt) => attempt.queueItemId
    )
  };
}

describe('a composed run and a plain run leave the same runtime trace (FR-037, SC-009)', () => {
  // One pair of runs, compared from several angles. Re-running the pair per
  // assertion would compare a different pair each time — and would pay for two
  // real, disk-backed drives to answer each question.
  let plain: Observed;
  let composed: Observed;
  let node: Observed;

  beforeAll(async () => {
    plain = await runToCompletion('plain');
    composed = await runToCompletion('composed');
    node = await runToCompletion('node');
  }, 45_000);

  it('writes the same audit event sequence, with the same payload shape', () => {
    expect(plain.audit.length).toBeGreaterThan(0);
    expect(composed.audit).toEqual(plain.audit);
    expect(node.audit).toEqual(plain.audit);
  });

  it('writes the same transcript event sequence', () => {
    // Guarded like the audit sweep above: two empty transcripts would compare
    // equal and prove nothing.
    expect(plain.transcript.length).toBeGreaterThan(0);
    expect(composed.transcript).toEqual(plain.transcript);
    expect(node.transcript).toEqual(plain.transcript);
  });

  it('never touches window primacy, identically on all three paths', () => {
    // Feature 092 (T136, BUG-002, FR-032a) — was `['drive-run']` and one
    // release. `RunDriver.drive()` no longer wraps itself in a lock scope:
    // window primacy runs activation-to-disposal and is not a Run's to take or
    // end, so a Run leaves no trace on the workspace lock at all. The parity
    // this test exists for (FR-037) is unaffected — what changed is the shared
    // baseline all three paths are compared against, not whether they agree.
    //
    // Counted on `tryAcquire` / `release` rather than on recorded `withLock`
    // scopes: that method was deleted with the wrapper, and a scope recorder
    // nothing can write to would assert `[]` however a Run misbehaved.
    expect(plain.acquires).toBe(0);
    expect(plain.releases).toBe(0);
    expect(composed.acquires).toBe(plain.acquires);
    expect(composed.releases).toBe(plain.releases);
    // The node path enqueued through the guarded service on its way here, and
    // that service holds the same lock manager — so an acquisition it failed to
    // release would show up as an extra acquire or an extra release.
    expect(node.acquires).toBe(plain.acquires);
    expect(node.releases).toBe(plain.releases);
  });

  it('reaches the same terminal status through the same Phase sequence', () => {
    expect(plain.status).toBe('completed');
    expect(composed.status).toBe(plain.status);
    expect(composed.phasesCompleted).toEqual(plain.phasesCompleted);
    expect(node.status).toBe(plain.status);
    expect(node.phasesCompleted).toEqual(plain.phasesCompleted);
  });

  it('differs only by the additive record of what it was composed from', () => {
    // The one intended difference, stated rather than left implicit: a composed
    // Run records its frozen inputs (T035) and a plain one writes no such key.
    // Every observable above is identical precisely because nothing downstream
    // reads this field.
    expect(plain.runInputs).toBeUndefined();
    expect(composed.runInputs).toEqual([{ portId: 'brief', type: 'text', value: 'the brief' }]);
    // A node-started child composed the same request, so it records the same
    // thing — the node path adds nothing of its own to the Run (FR-067).
    expect(node.runInputs).toEqual(composed.runInputs);
  });

  it('carries its connected-run association outside the Run itself (FR-067, SC-009)', () => {
    // The association is the one permitted difference, and it lives on the
    // connected-run aggregate: the node's attempt references the queue row.
    // Nothing the runtime reads carries it, which is why every comparison above
    // holds.
    expect(node.nodeAttempts).toEqual([node.queueItemId]);
    expect(plain.nodeAttempts).toEqual([]);
    expect(composed.nodeAttempts).toEqual([]);
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
  async function runAndCancel(variant: Variant): Promise<Canceled> {
    const workspaceRoot = await fs.mkdtemp(path.join(tmpRoot, `cancel-${variant}-`));
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
    const featureId = await enqueue(harness, variant);
    const feature = harness.queue.findById(featureId)!;

    const driving = harness.controller.startNew(feature, null);
    await insidePhase;
    harness.controller.cancelActive();
    release();
    await driving;

    const run = harness.store.getRun(DEFAULT_QUEUE_ID)!;
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
  let node: Canceled;

  beforeAll(async () => {
    plain = await runAndCancel('plain');
    composed = await runAndCancel('composed');
    node = await runAndCancel('node');
  }, 45_000);

  it('stops at the same point, with the same terminal status', () => {
    expect(plain.status).toBe('canceled');
    // Cancelled after `compose` returned and before `refine` began — the abort
    // is observed at the top of the loop, so the in-flight Phase still records.
    expect(plain.phasesCompleted).toEqual(['compose#1:clean']);
    expect(composed.status).toBe(plain.status);
    expect(composed.phasesCompleted).toEqual(plain.phasesCompleted);
    // A node-started child is cancelled through the same seam and stops in the
    // same place — nothing about belonging to a connected run defers it or
    // keeps it running (FR-067).
    expect(node.status).toBe(plain.status);
    expect(node.phasesCompleted).toEqual(plain.phasesCompleted);
  });

  it('leaves the workspace lock alone on the cancel path too', () => {
    // Feature 092 (T136, FR-032a) — was one release, for the same reason as
    // above: a cancelled Run ends its own tenure on its queue's execution lease,
    // never the window's primacy. Still asserted, because a cancel path that
    // started releasing primacy again would be the defect returning.
    expect(plain.releases).toBe(0);
    expect(composed.releases).toBe(plain.releases);
    expect(node.releases).toBe(plain.releases);
  });
});
