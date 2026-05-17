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
  BUILT_IN_BUGFIX_PIPELINE_ID,
  BUILT_IN_CATALOG,
  BUILT_IN_PHASES,
  BUILT_IN_PIPELINES,
  BUILT_IN_PIPELINE_ID,
  buildCatalog,
  mergeCatalog,
  type PhaseDef,
  type PipelineDef
} from '../../src/config/pipeline-config';
import { MessageRouter, type RouterDeps } from '../../src/ui/sidebar/message-router';
import { CMD_SAVE_PHASES, type SidebarCommand, type CommandAckMessage } from '../../src/ui/sidebar/messages';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { RawInvocationOutput, InvocationRequest } from '../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';

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
      stdout: cleanStdout(req.phase),
      stderr: '',
      exitCode: 0,
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
    withLock: async function (this: { release(): Promise<void> }, _scope: string, fn: (session: { retain(): void }) => Promise<unknown>) {
      let retain = false;
      try {
        return await fn({ retain: () => { retain = true; } });
      } finally {
        if (!retain) await this.release().catch(() => undefined);
      }
    },
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
}

interface DispatchResult {
  status: 'accepted' | 'rejected';
  reason?: string;
}

async function dispatchSave(
  router: MessageRouter,
  phases: ReadonlyArray<Partial<PhaseDef> & { id: string; name?: string; instruction?: string; loopable?: boolean }>
): Promise<DispatchResult> {
  let captured: DispatchResult | undefined;
  await router.dispatch(
    { type: CMD_SAVE_PHASES, correlationId: 'save-1', payload: { phases } } as SidebarCommand,
    async (msg: CommandAckMessage) => {
      captured = { status: msg.status, reason: msg.reason };
      return true;
    }
  );
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
  readonly userPhases: readonly PhaseDef[];
  readonly workspaceRoot: string;
  readonly workspacePhases?: readonly PhaseDef[];
  readonly workspacePipelines?: readonly PipelineDef[];
  readonly pipelineId?: string;
}

async function runHarness(opts: HarnessOpts): Promise<{
  invocations: Array<{ phase: string; model?: string; effort?: string }>;
  auditLog: Array<Record<string, any>>;
  storedRunPipeline: import('../../src/state/workflow-run').WorkflowRun['pipeline'];
  controller: SchegentWorkflowController;
  store: WorkspaceStateStore;
}> {
  // Compose the merged catalog the same way the host does (built-in →
  // user → workspace). Built-in pipelines include both
  // `speckit-new-feature` and `speckit-bugfix` (Feature 026 Phase 2).
  const merge = mergeCatalog(
    { phases: BUILT_IN_PHASES, pipelines: BUILT_IN_PIPELINES, defaultPipelineId: BUILT_IN_PIPELINE_ID },
    { phases: opts.userPhases },
    {
      phases: opts.workspacePhases ?? [],
      pipelines: opts.workspacePipelines ?? []
    }
  );
  const catalog = buildCatalog(
    merge.catalog.phases,
    merge.catalog.pipelines,
    merge.catalog.models,
    BUILT_IN_PIPELINE_ID
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
      perPhaseRulesEnabled: false
    },
    { catalog }
  );

  const pipelineId = opts.pipelineId ?? BUILT_IN_PIPELINE_ID;
  const feature = await queue.enqueue('Audit thing', { pipelineId });
  await controller.startNew(feature, null, { pipelineId });

  const auditLog = await readAuditLog(opts.workspaceRoot);
  const storedRunPipeline = store.getRun()?.pipeline;
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
  updateConfigCalls: Array<{ key: string; value: unknown }>;
} {
  const updateConfigCalls: Array<{ key: string; value: unknown }> = [];
  const deps: RouterDeps = {
    executeCommand: vi.fn().mockResolvedValue(undefined),
    queueRemover: { remove: vi.fn().mockResolvedValue(true) },
    isPrimary: () => true,
    isTrusted: () => true,
    notifyWarning: vi.fn(),
    logger: new SanitizedLogger(),
    updateConfig: async (key, value) => {
      updateConfigCalls.push({ key, value });
    }
  };
  return { router: new MessageRouter(deps), updateConfigCalls };
}

const VALID_BASE_FIELDS = {
  name: 'placeholder',
  instruction: 'placeholder',
  loopable: false
};

describe('Feature 026 T018 — per-phase Effort/Model override end-to-end', () => {
  it('(a)+(b) saves effort: high on speckit-plan via CMD_SAVE_PHASES and emits it on phase-start', async () => {
    const { router, updateConfigCalls } = buildRouter();
    const savePayload = [
      { id: 'speckit-plan', ...VALID_BASE_FIELDS, effort: 'high' as const }
    ];
    const ack = await dispatchSave(router, savePayload);
    expect(ack.status).toBe('accepted');
    expect(updateConfigCalls).toHaveLength(1);
    expect(updateConfigCalls[0].key).toBe('phases');
    expect(updateConfigCalls[0].value).toEqual(savePayload);

    const { auditLog } = await runHarness({
      userPhases: savePayload as readonly PhaseDef[],
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
    const { router, updateConfigCalls } = buildRouter();
    const ack = await dispatchSave(router, cleared);
    expect(ack.status).toBe('accepted');
    expect(updateConfigCalls[0].value).toEqual(cleared);

    const { auditLog } = await runHarness({
      userPhases: cleared as readonly PhaseDef[],
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
    const userPhases: PhaseDef[] = Object.entries(modelByPhase).map(([id, model]) => ({
      id,
      ...VALID_BASE_FIELDS,
      model
    }));

    const { router, updateConfigCalls } = buildRouter();
    const ack = await dispatchSave(router, userPhases);
    expect(ack.status).toBe('accepted');
    expect(updateConfigCalls).toHaveLength(1);

    const { auditLog } = await runHarness({
      userPhases: userPhases as readonly PhaseDef[],
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

describe('Feature 026 T025 — workspace-layer override wins over user (US3)', () => {
  it('(a)+(c) workspace effort:high on bugfix-implement wins over user effort:medium; the user save remains accepted while shadowed', async () => {
    // (c) FR-021 — user-layer save is accepted by CMD_SAVE_PHASES even
    // when the workspace catalog will shadow it. We dispatch the save
    // first and assert the ack succeeds.
    const userBugfixImplement: PhaseDef = {
      id: 'bugfix-implement',
      ...VALID_BASE_FIELDS,
      effort: 'medium'
    };
    const { router, updateConfigCalls } = buildRouter();
    const ack = await dispatchSave(router, [userBugfixImplement]);
    expect(ack.status).toBe('accepted');
    expect(updateConfigCalls).toHaveLength(1);
    expect(updateConfigCalls[0].key).toBe('phases');

    // (a) workspace layer overrides the user layer on the same phase id.
    const workspaceBugfixImplement: PhaseDef = {
      id: 'bugfix-implement',
      ...VALID_BASE_FIELDS,
      effort: 'high'
    };
    const { auditLog } = await runHarness({
      userPhases: [userBugfixImplement],
      workspacePhases: [workspaceBugfixImplement],
      workspaceRoot: tmpRoot,
      pipelineId: BUILT_IN_BUGFIX_PIPELINE_ID
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

  it('(b) removing the workspace catalog entry falls back to user effort:medium on the next enqueue', async () => {
    const userBugfixImplement: PhaseDef = {
      id: 'bugfix-implement',
      ...VALID_BASE_FIELDS,
      effort: 'medium'
    };
    const { auditLog } = await runHarness({
      userPhases: [userBugfixImplement],
      workspacePhases: [], // workspace layer entry removed
      workspaceRoot: tmpRoot,
      pipelineId: BUILT_IN_BUGFIX_PIPELINE_ID
    });
    const implementStarts = auditLog.filter(
      (e) => e.eventType === 'phase-start' && e.payload.phaseId === 'bugfix-implement'
    );
    expect(implementStarts.length).toBeGreaterThan(0);
    for (const evt of implementStarts) {
      expect(evt.payload.effort).toBe('medium');
      expect(evt.payload).not.toHaveProperty('model');
    }
  });
});

describe('Feature 026 T025a — workspace-defined custom pipeline mixing effort+model (US3, SC-006)', () => {
  const customPipelineId = 'workspace-mix';
  const customPhaseIds = ['workspace-step-a', 'workspace-step-b', 'workspace-step-c'] as const;

  function makeWorkspacePhases(args: {
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

  function makeWorkspacePipeline(): PipelineDef {
    return {
      id: customPipelineId,
      name: 'Workspace Mix',
      phases: [...customPhaseIds]
    };
  }

  it('(a)+(b)+(d) resolves the workspace-defined pipeline at enqueue time, emits workspace effort+model on every phase-start, and the immutable snapshot mirrors the workspace catalog state', async () => {
    const workspacePhases = makeWorkspacePhases();
    const { auditLog, storedRunPipeline, controller, store } = await runHarness({
      userPhases: [],
      workspacePhases,
      workspacePipelines: [makeWorkspacePipeline()],
      workspaceRoot: tmpRoot,
      pipelineId: customPipelineId
    });

    // (a) The run captured the workspace-defined pipeline in its
    // immutable snapshot. The snapshot's phase ids match the workspace
    // pipeline's phase list (plus the auto-appended `done` terminator).
    expect(storedRunPipeline).toBeDefined();
    const snapshotIds = (storedRunPipeline?.phases ?? []).map((p) => p.id);
    expect(snapshotIds.slice(0, customPhaseIds.length)).toEqual([...customPhaseIds]);
    expect(snapshotIds[snapshotIds.length - 1]).toBe('done');

    // (b) Each phase invocation's phase-start carries both the workspace
    // effort:'xhigh' and the workspace model.
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
    // controller's catalog back to BUILT_IN_CATALOG (which has neither
    // the workspace-mix pipeline NOR the workspace-step-* phases) and
    // confirm the persisted snapshot still references the workspace
    // catalog state captured at enqueue time.
    controller.setCatalog(BUILT_IN_CATALOG);
    const snapshotAfter = store.getRun()?.pipeline;
    expect(snapshotAfter).toBe(storedRunPipeline);
    expect((snapshotAfter?.phases ?? []).map((p) => p.id)).toEqual(snapshotIds);
  });

  it('(c) removing the workspace model on one phase falls back to the next-precedence layer; the workspace effort stays active', async () => {
    // The workspace removes `model` on workspace-step-b only; effort
    // remains 'xhigh' across all three phases. workspace-step-b has no
    // user/built-in fallback, so `model` is absent on its phase-start
    // payload (no empty-string, no null — see phase-runner.ts:172-176).
    const workspacePhases = makeWorkspacePhases({ omitModelOn: 'workspace-step-b' });
    const { auditLog } = await runHarness({
      userPhases: [],
      workspacePhases,
      workspacePipelines: [makeWorkspacePipeline()],
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

    // workspace-step-a + workspace-step-c retain both effort + model
    // from the workspace layer.
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
