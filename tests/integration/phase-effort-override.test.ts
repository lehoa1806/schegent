import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
// Feature 026 T018 — integration: per-phase Effort/Model override
// flows through CMD_SAVE_PHASES, lands on the user-layer catalog,
// and surfaces on the `phase-start` audit payload at run time.
//
// Scope:
//   (a) Dispatch CMD_SAVE_PHASES with `{ id: 'speckit-plan', effort: 'high' }`
//       through MessageRouter; assert the host writes `phases` to the
//       user-layer catalog byte-for-byte.
//   (b) Build a controller against the post-save merged catalog;
//       enqueue + run the standard pipeline; assert the `phase-start`
//       audit entry for `speckit-plan` carries `effort: 'high'` and no
//       `model` field.
//   (c) Clear the override (omit `effort` in a follow-up save) and
//       re-run; assert the next `phase-start` for `speckit-plan` has
//       neither `effort` nor `model`.
//   (d) SC-002 smoke matrix: sample 3 representative built-in phases
//       (head/middle/tail of the standard pipeline) — `speckit-specify`,
//       `speckit-plan`, `speckit-implement` — assert that when a `model`
//       override is set on each, the corresponding `phase-start` audit
//       event carries the saved `model`.
//
// The flow exercises the router validator path (T013a) + the catalog
// merge (built-in vs user) + the runtime emission at
// `phase-runner.ts:172-176`. The host-side validators reject malformed
// rows; the integration test uses only well-formed rows.

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
import {
  buildCatalog,
  type PhaseDef,
  type PipelineDef
} from '../../src/config/pipeline-config';
import { FakeCatalogStore, layerWrites } from '../fixtures/fake-catalog-store';
// Feature 098 (T080) — the base layer these tests override comes from the test
// fixture rather than from a compiled-in catalog, which no longer holds any. The
// Spec Kit and bugfix ids are the real ones because the tests are about
// per-Phase overrides landing on named Phases, and because several host branches
// still key on those literals; see the fixture header.
import {
  buildSpeckitCatalog,
  SPECKIT_ALL_PHASE_DEFS,
  SPECKIT_BUGFIX_PIPELINE_ID,
  SPECKIT_PIPELINE_DEFS,
  SPECKIT_PIPELINE_ID
} from '../fixtures/speckit-catalog-fixture';
import { MessageRouter, type RouterDeps } from '../../src/ui/sidebar/message-router';
import { CMD_SAVE_PHASES, type SidebarCommand, type CommandAckMessage } from '../../src/ui/sidebar/messages';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { RawInvocationOutput, InvocationRequest } from '../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';
import { DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';

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

function makeCliRunner(): { runner: ClaudeCliRunner; invocations: Array<{ phase: string; model?: string; effort?: string }> } {
  const invocations: Array<{ phase: string; model?: string; effort?: string }> = [];
  const invoke = vi.fn(async (req: InvocationRequest): Promise<RawInvocationOutput> => {
    invocations.push({ phase: req.phase, model: req.model, effort: req.effort });
    return {
        stdoutBuffer: (() => { const b = new ZippedStreamBuffer(); b.append(cleanStdout(req.phase)); b.finalize(); return b; })(),
        stderrBuffer: (() => { const b = new ZippedStreamBuffer(); b.finalize(); return b; })(),exitCode: 0,
      killed: false,
      timedOut: false,
      durationMs: 1
    };
  });
  const runner = {
    invoke,
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
  return { runner, invocations };
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

interface DispatchResult {
  status: 'accepted' | 'rejected';
  reason?: string;
}

async function dispatchSave(
  router: MessageRouter,
  store: FakeCatalogStore,
  phases: ReadonlyArray<Partial<PhaseDef> & { id: string; name?: string; instruction?: string; loopable?: boolean }>
): Promise<DispatchResult> {
  let captured: DispatchResult | undefined;
  const proposed: unknown[] = [];
  for (const phase of phases) {
    proposed.push(phase);
    await router.dispatch(
      {
        type: CMD_SAVE_PHASES,
        correlationId: `save-${proposed.length}`,
        payload: {
          // Feature 099 (T496f, FR-044) — read fresh each time: the previous save
          // moved the store's revision, and echoing a stale one is exactly what the
          // gate exists to refuse.
          expectedRevision: store.revisionOf('phase'),
          mutation: { kind: 'create', phaseId: phase.id },
          phases: [...proposed]
        }
      } as SidebarCommand,
      async (msg: CommandAckMessage) => {
        captured = { status: msg.status, reason: msg.reason };
        return true;
      }
    );
    if (captured?.status === 'rejected') break;
  }
  if (!captured) throw new Error('router did not ack the save');
  return captured;
}

async function readAuditLog(workspaceRoot: string): Promise<Array<Record<string, any>>> {
  const log = await fs.readFile(path.join(workspaceRoot, '.schegent', 'audit.log'), 'utf8');
  return log
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

interface HarnessOpts {
  /** The Phases the operator authored; each replaces the fixture row of its id. */
  readonly phases: readonly PhaseDef[];
  readonly workspaceRoot: string;
  readonly pipelines?: readonly PipelineDef[];
  readonly pipelineId?: string;
}

/**
 * The one catalog the host resolves, as it stands after the operator's edits.
 *
 * Feature 099 (T496f, FR-042) — this composition was `mergeCatalog(base, user,
 * workspace)`, a precedence ladder that is deleted with the layer tier. An
 * operator who wants a Phase to differ from the document they imported now EDITS
 * that row, so the successor is a replace-by-id over one list. Every override
 * these tests set up means the same thing it always did — this Phase, with this
 * effort or model, is the one the run will use.
 */
function composePhases(authored: readonly PhaseDef[]): readonly PhaseDef[] {
  const byId = new Map<string, PhaseDef>(
    SPECKIT_ALL_PHASE_DEFS.map((phase) => [phase.id, phase])
  );
  for (const phase of authored) byId.set(phase.id, phase);
  return [...byId.values()];
}

async function runHarness(opts: HarnessOpts): Promise<{
  invocations: Array<{ phase: string; model?: string; effort?: string }>;
  auditLog: Array<Record<string, any>>;
  storedRunPipeline: import('../../src/state/workflow-run').WorkflowRun['pipeline'];
  controller: SchegentWorkflowController;
  store: WorkspaceStateStore;
}> {
  // The catalog holds both `speckit-new-feature` and `speckit-bugfix` (Feature
  // 026 Phase 2), which is what makes a per-Phase override on either Pipeline
  // observable.
  //
  // Feature 098 (T080) — these rows were `BUILT_IN_PHASES` / `BUILT_IN_PIPELINES`,
  // i.e. the product's own. Both are empty now, so the fixture supplies the same
  // content under the same ids.
  const catalog = buildCatalog(
    composePhases(opts.phases),
    [...SPECKIT_PIPELINE_DEFS, ...(opts.pipelines ?? [])],
    { claude: [], codex: [], agy: [] },
    SPECKIT_PIPELINE_ID
  );

  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot: opts.workspaceRoot }, logger);
  const { runner, invocations } = makeCliRunner();
  const phaseRunner = new PhaseRunner(runner, new PromptBuilder(), audit, logger);

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
    {
      cliPath: 'noop',
      cwd: opts.workspaceRoot,
      iterationCap: 5,
      timeoutMs: 1000,
    },
    { catalog }
  );

  const pipelineId = opts.pipelineId ?? SPECKIT_PIPELINE_ID;
  const feature = await queue.enqueue('Audit thing', { pipelineId });
  await controller.startNew(feature, null, { pipelineId });

  const auditLog = await readAuditLog(opts.workspaceRoot);
  const storedRunPipeline = store.getRun(DEFAULT_QUEUE_ID)?.pipeline;
  return { invocations, auditLog, storedRunPipeline, controller, store };
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-phase-effort-override-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function buildRouter(): {
  router: MessageRouter;
  store: FakeCatalogStore;
  writes: () => readonly (readonly unknown[])[];
} {
  const store = new FakeCatalogStore();
  const deps: RouterDeps = {
    executeCommand: vi.fn().mockResolvedValue(undefined),
    queueRemover: { remove: vi.fn().mockResolvedValue(true) },
    isPrimary: () => true,
    isTrusted: () => true,
    notifyWarning: vi.fn(),
    logger: new SanitizedLogger(),
    catalogStore: store,
    refreshCatalog: async () => undefined,
    readPhaseConfig: () => ({ rows: store.rowsOf('phase'), revision: store.revisionOf('phase') })
  };
  return { router: new MessageRouter(deps), store, writes: () => layerWrites(store) };
}

const VALID_BASE_FIELDS = {
  name: 'placeholder',
  instruction: 'placeholder',
  loopable: false
};

describe('Feature 026 T018 — per-phase Effort/Model override end-to-end', () => {
  it('(a)+(b) saves effort: high on speckit-plan via CMD_SAVE_PHASES and emits it on phase-start', async () => {
    const { router, store, writes } = buildRouter();
    const savePayload = [
      { id: 'speckit-plan', ...VALID_BASE_FIELDS, effort: 'high' as const }
    ];
    const ack = await dispatchSave(router, store, savePayload);
    expect(ack.status).toBe('accepted');
    expect(store.layerSaves.map((request) => request.kind)).toEqual(['phase']);
    expect(writes()[0]).toEqual([
      expect.objectContaining({ ...savePayload[0], version: 1 })
    ]);

    const { auditLog } = await runHarness({
      phases: savePayload as readonly PhaseDef[],
      workspaceRoot: tmpRoot
    });
    const planStarts = auditLog.filter(
      (e) => e.eventType === 'phase-start' && e.payload.phaseId === 'speckit-plan'
    );
    expect(planStarts.length).toBeGreaterThan(0);
    for (const evt of planStarts) {
      expect(evt.payload.effort).toBe('high');
      expect(evt.payload).not.toHaveProperty('model');
    }
  });

  it('(c) clearing the override (omit effort) removes effort from the next phase-start payload', async () => {
    const cleared = [
      { id: 'speckit-plan', ...VALID_BASE_FIELDS }
    ];
    const { router, store, writes } = buildRouter();
    const ack = await dispatchSave(router, store, cleared);
    expect(ack.status).toBe('accepted');
    expect(writes()[0]).toEqual([
      expect.objectContaining({ ...cleared[0], version: 1 })
    ]);

    const { auditLog } = await runHarness({
      phases: cleared as readonly PhaseDef[],
      workspaceRoot: tmpRoot
    });
    const planStarts = auditLog.filter(
      (e) => e.eventType === 'phase-start' && e.payload.phaseId === 'speckit-plan'
    );
    expect(planStarts.length).toBeGreaterThan(0);
    for (const evt of planStarts) {
      expect(evt.payload).not.toHaveProperty('effort');
      expect(evt.payload).not.toHaveProperty('model');
    }
  });

  it('(d) SC-002 smoke: model override on head/middle/tail built-in phases surfaces on phase-start', async () => {
    const modelByPhase: Record<string, string> = {
      'speckit-specify': 'claude-haiku-4-5-20251001',
      'speckit-plan': 'claude-sonnet-4-6',
      'speckit-implement': 'claude-opus-4-7'
    };
    const authored: PhaseDef[] = Object.entries(modelByPhase).map(([id, model]) => ({
      id,
      ...VALID_BASE_FIELDS,
      model
    }));

    const { router, store } = buildRouter();
    const ack = await dispatchSave(router, store, authored);
    expect(ack.status).toBe('accepted');
    expect(store.layerSaves).toHaveLength(3);

    const { auditLog } = await runHarness({
      phases: authored as readonly PhaseDef[],
      workspaceRoot: tmpRoot
    });
    for (const [phaseId, expectedModel] of Object.entries(modelByPhase)) {
      const starts = auditLog.filter(
        (e) => e.eventType === 'phase-start' && e.payload.phaseId === phaseId
      );
      expect(starts.length).toBeGreaterThan(0);
      for (const evt of starts) {
        expect(evt.payload.model).toBe(expectedModel);
      }
    }
  });
});

// Feature 099 (T496f, FR-042) — this block was 'BUG-003 — user-layer override wins
// over workspace (US3)', and both its cases asked which of two layers wins on one
// phase id. One catalog answers no such question, so the precedence claim is gone
// with the tier that made it meaningful. What the cases also carried, and nothing
// else in this file pins, is the SECOND Pipeline: every case above runs
// `speckit-new-feature`, and an override reaching a Phase of `speckit-bugfix`
// exercises pipeline selection at enqueue as well as the override plumbing. Both
// successors below keep that, and between them they keep the pair the originals
// were built from — an authored override arrives, and its absence leaves nothing
// behind.
describe('BUG-003 successor — an override on a non-default Pipeline (US3)', () => {
  it('(a) saves effort on a bugfix Phase and emits it on that Pipeline\'s phase-start', async () => {
    const bugfixImplement: PhaseDef = {
      id: 'bugfix-implement',
      ...VALID_BASE_FIELDS,
      effort: 'high'
    };
    const { router, store, writes } = buildRouter();
    const ack = await dispatchSave(router, store, [bugfixImplement]);
    expect(ack.status).toBe('accepted');
    expect(writes()[0]).toEqual([
      expect.objectContaining({ id: 'bugfix-implement', effort: 'high', version: 1 })
    ]);

    const { auditLog } = await runHarness({
      phases: [bugfixImplement],
      workspaceRoot: tmpRoot,
      pipelineId: SPECKIT_BUGFIX_PIPELINE_ID
    });
    const implementStarts = auditLog.filter(
      (e) => e.eventType === 'phase-start' && e.payload.phaseId === 'bugfix-implement'
    );
    expect(implementStarts.length).toBeGreaterThan(0);
    for (const evt of implementStarts) {
      expect(evt.payload.effort).toBe('high');
      expect(evt.payload).not.toHaveProperty('model');
    }
  });

  it('(b) emits no effort once the authored override is gone, and the row itself is untouched', async () => {
    // The successor of 'removing the user catalog entry falls back to workspace
    // effort:high'. There is no lower layer to fall back TO, so dropping the
    // override drops it outright — and the second half of the assertion is what
    // makes that precise: the Phase is still there, still carrying the `model`
    // the catalog declares for it. Only the operator's edit went away.
    const { auditLog } = await runHarness({
      phases: [],
      workspaceRoot: tmpRoot,
      pipelineId: SPECKIT_BUGFIX_PIPELINE_ID
    });
    const implementStarts = auditLog.filter(
      (e) => e.eventType === 'phase-start' && e.payload.phaseId === 'bugfix-implement'
    );
    expect(implementStarts.length).toBeGreaterThan(0);
    const declared = SPECKIT_ALL_PHASE_DEFS.find((p) => p.id === 'bugfix-implement');
    for (const evt of implementStarts) {
      expect(evt.payload).not.toHaveProperty('effort');
      expect(evt.payload.model).toBe(declared?.model);
    }
  });
});

describe('Feature 026 T025a — a custom Pipeline mixing effort+model (US3, SC-006)', () => {
  const customPipelineId = 'workspace-mix';
  const customPhaseIds = ['workspace-step-a', 'workspace-step-b', 'workspace-step-c'] as const;

  function makeCustomPhases(args: {
    omitModelOn?: string;
  } = {}): readonly PhaseDef[] {
    return customPhaseIds.map((id) => {
      const base: PhaseDef = {
        id,
        ...VALID_BASE_FIELDS,
        effort: 'xhigh'
      };
      return args.omitModelOn === id
        ? base
        : { ...base, model: 'claude-sonnet-4-6' };
    });
  }

  function makeCustomPipeline(): PipelineDef {
    return {
      id: customPipelineId,
      name: 'Workspace Mix',
      phases: [...customPhaseIds]
    };
  }

  it('(a)+(b)+(d) resolves the custom pipeline at enqueue time, emits its effort+model on every phase-start, and the immutable snapshot mirrors the catalog state', async () => {
    const { auditLog, storedRunPipeline, controller, store } = await runHarness({
      phases: makeCustomPhases(),
      pipelines: [makeCustomPipeline()],
      workspaceRoot: tmpRoot,
      pipelineId: customPipelineId
    });

    // (a) The run captured the custom pipeline in its immutable snapshot. The
    // snapshot's phase ids match the pipeline's phase list (plus the
    // auto-appended `done` terminator).
    expect(storedRunPipeline).toBeDefined();
    const snapshotIds = (storedRunPipeline?.phases ?? []).map((p) => p.id);
    expect(snapshotIds.slice(0, customPhaseIds.length)).toEqual([...customPhaseIds]);
    expect(snapshotIds.length).toBe(customPhaseIds.length);

    // (b) Each phase invocation's phase-start carries both the authored
    // effort:'xhigh' and the authored model.
    for (const phaseId of customPhaseIds) {
      const starts = auditLog.filter(
        (e) => e.eventType === 'phase-start' && e.payload.phaseId === phaseId
      );
      expect(starts.length).toBeGreaterThan(0);
      for (const evt of starts) {
        expect(evt.payload.effort).toBe('xhigh');
        expect(evt.payload.model).toBe('claude-sonnet-4-6');
      }
    }

    // (d) The immutable WorkflowRun.pipeline snapshot is unaffected by
    // post-enqueue catalog mutations. After completing the run, swap the
    // controller's catalog back to the fixture rows alone (which have neither
    // the workspace-mix pipeline NOR the workspace-step-* phases) and
    // confirm the persisted snapshot still references the catalog state
    // captured at enqueue time.
    controller.setCatalog(buildSpeckitCatalog());
    const snapshotAfter = store.getRun(DEFAULT_QUEUE_ID)?.pipeline;
    expect(snapshotAfter).toBe(storedRunPipeline);
    expect((snapshotAfter?.phases ?? []).map((p) => p.id)).toEqual(snapshotIds);
  });

  it('(c) a phase with no model emits none, while its effort stays active', async () => {
    // The operator clears `model` on workspace-step-b only; effort remains
    // 'xhigh' across all three phases. Feature 099 (T496f, FR-042) — the title
    // read "falls back to the next-precedence layer", and the body's own comment
    // already said workspace-step-b has no fallback, so `model` is absent on its
    // phase-start payload (no empty-string, no null — see phase-runner.ts:172-176).
    // With one catalog that absence is the whole claim, and the title now says so.
    const { auditLog } = await runHarness({
      phases: makeCustomPhases({ omitModelOn: 'workspace-step-b' }),
      pipelines: [makeCustomPipeline()],
      workspaceRoot: tmpRoot,
      pipelineId: customPipelineId
    });

    const stepBStarts = auditLog.filter(
      (e) => e.eventType === 'phase-start' && e.payload.phaseId === 'workspace-step-b'
    );
    expect(stepBStarts.length).toBeGreaterThan(0);
    for (const evt of stepBStarts) {
      expect(evt.payload).not.toHaveProperty('model');
      expect(evt.payload.effort).toBe('xhigh');
    }

    // workspace-step-a + workspace-step-c retain both effort + model.
    for (const phaseId of ['workspace-step-a', 'workspace-step-c'] as const) {
      const starts = auditLog.filter(
        (e) => e.eventType === 'phase-start' && e.payload.phaseId === phaseId
      );
      expect(starts.length).toBeGreaterThan(0);
      for (const evt of starts) {
        expect(evt.payload.effort).toBe('xhigh');
        expect(evt.payload.model).toBe('claude-sonnet-4-6');
      }
    }
  });
});
