// FR-R3-001 — the shared harness for the four execution-envelope fixtures.
//
// It exists so "declared inputs reach the backend", "declared outputs are
// stated before they are probed", "the envelope is immutable in flight" and
// "the audit boundary holds" are all answered against the *same* wiring. Each of
// those is a claim about one seam of one path, and four separately-built
// harnesses would let three of them keep passing against a path the fourth had
// already shown to be different.
//
// Everything from `validateRunRequest()` to the CLI subprocess boundary is real:
// the validator, the queue, the store, the controller, the run driver, the phase
// runner, the prompt builder, the audit writer. Only two things are doubled, and
// both are doubled because they are the observation point rather than the
// subject — the CLI runner, which records the `InvocationRequest` it was handed
// instead of spawning a process, and the workspace lock, which is not this
// feature's concern (FR-028 governs it, and `runtime-parity.test.ts` pins it).
//
// The observation point is deliberately the *runner*, not the prompt builder. A
// unit test of the builder proves the sections render; only the request that
// arrives at the subprocess boundary proves they survive every seam between
// validation and the CLI, which is precisely where feature 087 lost four fields.

import { vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import { PhaseRunner } from '../../../src/controller/phase-runner';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
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
import type { ExecutionEnvelope, RunRequest } from '../../../src/contracts/run-request';
import {
  validateRunRequest,
  type EffectivePipelineSource
} from '../../../src/services/run-request/run-request-validator';
import type { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import type { InvocationRequest, RawInvocationOutput } from '../../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { Notifier } from '../../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';

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
  id: 'compose', name: 'Compose', version: 1, instruction: 'Compose the report.',
};
const REVIEW: PhaseDef = {
  id: 'review', name: 'Review', version: 1, instruction: 'Review the report.',
};
const DONE: PhaseDef = {
  id: 'done', name: 'Done', version: 1, instruction: '(no-op)'
};

/**
 * Two working Phases before `done`, with declared ports on both sides.
 *
 * The second Phase is load-bearing for more than one fixture: it is what lets a
 * test assert the envelope reaches *every* phase rather than only the first, and
 * what gives an in-flight catalog edit somewhere to take effect if the snapshot
 * were not frozen.
 */
export const ENVELOPE_FLOW: PipelineDef = {
  id: 'envelope-flow',
  name: 'Envelope Flow',
  phases: ['compose', 'review', 'done'],
  inputs: [
    { portId: 'brief', label: 'Brief', type: 'text', required: true },
    { portId: 'spec', label: 'Spec', type: 'local-file', required: true }
  ],
  outputs: [
    { portId: 'report', label: 'Report', type: 'markdown' },
    { portId: 'summary', label: 'Summary', type: 'file' }
  ]
};

export function catalog(): PipelineCatalog {
  return buildCatalog(
    [COMPOSE, REVIEW, DONE], [ENVELOPE_FLOW], { claude: [], codex: [], agy: [] }, 'envelope-flow'
  );
}

const SOURCE: EffectivePipelineSource = {
  definition: ENVELOPE_FLOW,
  phases: [COMPOSE, REVIEW, DONE],
  defaultRunnerKind: 'claude'
};

export const DESCRIPTION = 'compose the quarterly report';

/**
 * One request that exercises every arm of the envelope at once: both contract
 * input types, three supplemental kinds, both declared outputs, and free-text
 * instructions. A fixture that filled one arm at a time would let a renderer
 * that drops a whole section pass three of four fixtures.
 *
 * Every value below is a recognisable literal, so a test can assert its presence
 * by content rather than by counting lines.
 */
export const BRIEF = 'Summarise Q3 revenue by region.';
export const SPEC_PATH = 'docs/report-spec.md';
export const SUPPLEMENTAL_FILE = 'notes/prior-quarter.md';
export const SUPPLEMENTAL_URL = 'https://example.invalid/methodology';
export const SUPPLEMENTAL_TEXT = 'Prefer tables over prose wherever a table fits.';
export const REPORT_TARGET = 'out/report.md';
export const SUMMARY_TARGET = 'out/summary.txt';
export const INSTRUCTIONS = 'Cite a source for every figure, and flag any estimate.';

export const REQUEST: RunRequest = {
  pipelineId: ENVELOPE_FLOW.id,
  inputs: [
    { portId: 'brief', type: 'text', value: BRIEF },
    { portId: 'spec', type: 'local-file', value: SPEC_PATH }
  ],
  supplemental: [
    { kind: 'local-file', path: SUPPLEMENTAL_FILE },
    { kind: 'url', url: SUPPLEMENTAL_URL },
    { kind: 'text', text: SUPPLEMENTAL_TEXT }
  ],
  outputs: [
    { portId: 'report', target: REPORT_TARGET },
    { portId: 'summary', target: SUMMARY_TARGET }
  ],
  instructions: INSTRUCTIONS
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
    'notes: ok',
    '=== END AUDIT LOG ==='
  ].join('\n');

function output(phase: string): RawInvocationOutput {
  const stdout = new ZippedStreamBuffer();
  stdout.append(cleanStdout(phase));
  stdout.finalize();
  const stderr = new ZippedStreamBuffer();
  stderr.finalize();
  return {
    stdoutBuffer: stdout, stderrBuffer: stderr, exitCode: 0,
    killed: false, timedOut: false, durationMs: 1
  };
}

/** Primacy is not this feature's concern; see FR-028 and `runtime-parity.test.ts`. */
function inertLock(): WorkspaceLockManager {
  return {
    release: vi.fn(async () => {}),
    tryAcquire: vi.fn(async () => ({ acquired: false, owner: null })),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
}

export interface EnvelopeHarness {
  readonly controller: SchegentWorkflowController;
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly workspaceRoot: string;
  /** Every request that reached the CLI boundary, in invocation order. */
  readonly invocations: readonly InvocationRequest[];
  /** The prompt of the first invocation, which is the first phase's. */
  firstPrompt(): string;
  /** The envelope the validator froze for this harness's request. */
  readonly envelope: ExecutionEnvelope;
  /** The Run the drive produced, read back from the store. */
  finishedRun(): WorkflowRun;
  /** Every structured audit record the run appended. */
  auditRecords(): Promise<readonly Record<string, unknown>[]>;
}

/**
 * What a mid-flight hook can reach.
 *
 * Deliberately the *live* store, queue and catalog rather than copies: a fixture
 * that asserts the envelope is unaffected by an edit has to be able to make an
 * edit that would otherwise be felt. Handing it a copy would make every such
 * fixture pass for the wrong reason.
 */
export interface MidFlightContext {
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly catalog: PipelineCatalog;
  readonly featureId: string;
  readonly workspaceRoot: string;
}

export interface HarnessOptions {
  /**
   * Run before each CLI invocation, with the zero-based invocation index. The
   * immutability fixture uses it to edit the catalog and the queue row while the
   * run is genuinely mid-flight.
   */
  readonly beforeInvocation?: (index: number, context: MidFlightContext) => void | Promise<void>;
  /** Output targets that already exist on disk when the probe runs. */
  readonly existingOutputs?: readonly string[];
}

/**
 * Replace the in-flight queue row's frozen plan, in the persisted state.
 *
 * The row and the Run hold two copies of what was accepted. Fixtures use this to
 * make the copies disagree, so "the execution path reads the envelope" becomes
 * an observable difference rather than a claim that two agreeing sources happen
 * to agree.
 */
export async function rewriteQueuedPlan(
  context: MidFlightContext,
  edit: (plan: ExecutionEnvelope) => ExecutionEnvelope
): Promise<void> {
  const queueState = context.store.getQueue(DEFAULT_QUEUE_ID);
  const requests = queueState.requests.map((request) =>
    request.id === context.featureId && request.runPlan
      ? { ...request, runPlan: edit(request.runPlan) }
      : request
  );
  await context.store.setQueue({ ...queueState, requests }, DEFAULT_QUEUE_ID);
}

/**
 * Validates the request, enqueues the envelope it froze, and drives the run to
 * completion through the production controller.
 *
 * Throws rather than returning a failure shape if validation or the start does
 * not succeed: a fixture that silently proceeded from an unvalidated request
 * would be asserting against the legacy path while claiming to test the
 * composed one.
 */
export async function driveEnvelopeRun(
  workspaceRoot: string,
  options: HarnessOptions = {}
): Promise<EnvelopeHarness> {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot }, logger);
  const invocations: InvocationRequest[] = [];

  // Assigned once the request is enqueued, which is strictly before the first
  // invocation can happen. A hook that somehow fired earlier gets a throw rather
  // than a half-built context.
  let midFlight: MidFlightContext | null = null;

  const runner = {
    invoke: vi.fn(async (request: InvocationRequest) => {
      if (!midFlight) throw new Error('invocation before the run was enqueued');
      await options.beforeInvocation?.(invocations.length, midFlight);
      invocations.push(request);
      return output(request.phase);
    }),
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;

  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  const queue = new QueueManager(store);
  const liveCatalog = catalog();

  const controller = new SchegentWorkflowController(
    new PhaseRunner(runner, new PromptBuilder(), audit, logger),
    store,
    queue,
    { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier,
    logger,
    inertLock(),
    { cliPath: 'noop', cwd: workspaceRoot, iterationCap: 5, timeoutMs: 1000, skipProbing: true },
    { auditWriter: audit, catalog: liveCatalog }
  );

  const existing = new Set(options.existingOutputs ?? []);
  const outcome = await validateRunRequest(REQUEST, {
    pipeline: SOURCE,
    workspaceRoot,
    now: 1_700_000_000_000,
    localInputs: {
      checkFile: async () => ({ ok: true }) as const,
      checkFolder: async () => ({ ok: true }) as const
    },
    // Nothing exists at validation time, so no overwrite confirmation is owed.
    // What exists at *probe* time is a separate question and a separate port.
    outputProbe: { exists: async () => false },
    priorOutputs: { outputsFor: () => [] as const }
  });
  if (!outcome.ok) {
    throw new Error(`fixture request did not validate: ${JSON.stringify(outcome.errors)}`);
  }

  for (const target of existing) {
    const absolute = path.join(workspaceRoot, target);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, 'produced', 'utf8');
  }

  const feature = await queue.enqueue(DESCRIPTION, {
    pipelineId: outcome.plan.pipeline.id,
    runPlan: outcome.plan
  });
  midFlight = { store, queue, catalog: liveCatalog, featureId: feature.id, workspaceRoot };
  await controller.startNew(queue.findById(feature.id)!, null);

  return {
    controller,
    store,
    queue,
    workspaceRoot,
    invocations,
    envelope: outcome.plan,
    firstPrompt: () => {
      const first = invocations[0];
      if (!first) throw new Error('the run reached no CLI invocation');
      return first.prompt;
    },
    finishedRun: () => {
      const run = store.getRun(DEFAULT_QUEUE_ID);
      if (!run) throw new Error('the run left no record');
      return run;
    },
    auditRecords: async () => {
      const raw = await fs.readFile(path.join(workspaceRoot, '.schegent', 'audit.log'), 'utf8');
      return raw
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    }
  };
}
