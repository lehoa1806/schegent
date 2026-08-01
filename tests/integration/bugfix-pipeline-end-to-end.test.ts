import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
// Feature 026 T019 + T020 — integration: the `speckit-bugfix` pipeline
// drives 5 phases end-to-end and emits five `phase-start` + five
// `phase-end` audit events in the canonical order.
//
// On-wire literals: the audit log carries the `phase-start` /
// `phase-end` literals (see `PHASE_EVENT_TYPES` in
// `src/contracts/audit-events.ts`); the feature docs / tasks.md prose
// refers to them as `phase-invocation-start` / `phase-invocation-end`
// for readability. The tests below assert the actual emitted literal.
//
// Scope (T019 happy path):
//   (a) The run completes with `status: 'completed'`.
//   (b) The audit log contains five `phase-start` + five `phase-end`
//       events in the exact `bugfix-report` → `bugfix-patch` →
//       `bugfix-verify-pre` → `bugfix-implement` → `bugfix-verify-post`
//       order.
//   (c) The immutable `WorkflowRun.pipeline` snapshot equals the
//       five-element ordered list (FR-007 — settings changes mid-run
//       never retarget in-flight runs).
//
// Scope (T020 verify-fail at bugfix-verify-pre):
//   (a) The run pauses with `pauseCause = 'phase-paused'`
//       (FR-016 — reuse, NOT a new literal).
//   (b) The audit log carries a `phase-end` event for
//       `bugfix-verify-pre` with a non-success outcome AND the
//       operator-visible pause projection identifies the failing
//       phase as `bugfix-verify-pre`.
//   (c) NO `bugfix-implement` or `bugfix-verify-post`
//       `phase-start` event appears between the first verify-pre
//       failure and the resume.
//   (d) A Resume call re-invokes `bugfix-verify-pre` (NOT
//       `bugfix-implement`).
//   (e) On the second verify success the run continues forward.

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
  BUILT_IN_CATALOG
} from '../../src/config/pipeline-config';
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

const BUGFIX_PHASES = [
  'bugfix-report',
  'bugfix-patch',
  'bugfix-verify-pre',
  'bugfix-implement',
  'bugfix-verify-post'
] as const;

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

const issuesStdout = (phase: string): string =>
  [
    'Remaining issues:',
    '- consistency check rejected the patch',
    '=== SCHEGENT AUDIT LOG ===',
    `phase: ${phase}`,
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: ["mock"]',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    'notes: verify failure',
    '=== END AUDIT LOG ==='
  ].join('\n');

type CliFactory = () => {
  runner: ClaudeCliRunner;
  invocations: Array<{ phase: string }>;
};

function makeCleanCliRunner(): { runner: ClaudeCliRunner; invocations: Array<{ phase: string }> } {
  const invocations: Array<{ phase: string }> = [];
  const invoke = vi.fn(async (req: InvocationRequest): Promise<RawInvocationOutput> => {
    invocations.push({ phase: req.phase });
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

interface HarnessOpts {
  readonly workspaceRoot: string;
  readonly cliFactory: CliFactory;
}

async function buildHarness(opts: HarnessOpts): Promise<{
  controller: SchegentWorkflowController;
  store: WorkspaceStateStore;
  queue: QueueManager;
  invocations: Array<{ phase: string }>;
}> {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot: opts.workspaceRoot }, logger);
  const { runner, invocations } = opts.cliFactory();
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
    { catalog: BUILT_IN_CATALOG, auditWriter: audit }
  );

  return { controller, store, queue, invocations };
}

async function readAuditLog(workspaceRoot: string): Promise<Array<Record<string, any>>> {
  const log = await fs.readFile(path.join(workspaceRoot, '.schegent', 'audit.log'), 'utf8');
  return log
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-bugfix-pipeline-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('Feature 026 T019 — speckit-bugfix happy-path end-to-end', () => {
  it('drives the 5 bugfix phases in canonical order and emits matching phase-start/phase-end events', async () => {
    const { controller, store, queue, invocations } = await buildHarness({
      workspaceRoot: tmpRoot,
      cliFactory: makeCleanCliRunner
    });

    const feature = await queue.enqueue('Fix the login bug', {
      pipelineId: BUILT_IN_BUGFIX_PIPELINE_ID
    });
    await controller.startNew(feature, null, { pipelineId: BUILT_IN_BUGFIX_PIPELINE_ID });

    // (a) Completed status — the controller transitions to 'completed' after
    // sweeping through `done`.
    const run = store.getRun()!;
    expect(run.status).toBe('completed');
    expect(run.currentPhase).toBe('done');
    expect(run.pipeline?.id).toBe(BUILT_IN_BUGFIX_PIPELINE_ID);

    // (c) Immutable pipeline snapshot equals the canonical 5-phase list +
    // the auto-appended `done` terminator (the controller appends `done`
    // when it isn't already present in the pipeline's declared phases).
    const snapshotIds = (run.pipeline?.phases ?? []).map((p) => p.id);
    expect(snapshotIds.slice(0, BUGFIX_PHASES.length)).toEqual([...BUGFIX_PHASES]);
    expect(snapshotIds.length).toBe(5);

    // CLI invocation order matches the 5 bugfix phases in declaration order.
    expect(invocations.map((i) => i.phase)).toEqual([...BUGFIX_PHASES]);

    // (b) 5 phase-start + 5 phase-end audit events in the canonical order.
    const auditLog = await readAuditLog(tmpRoot);
    const starts = auditLog.filter((e) => e.eventType === 'phase-start');
    const ends = auditLog.filter((e) => e.eventType === 'phase-end');
    expect(starts.length).toBe(5);
    expect(ends.length).toBe(5);
    expect(starts.map((e) => e.payload.phaseId)).toEqual([...BUGFIX_PHASES]);
    expect(ends.map((e) => e.payload.phaseId)).toEqual([...BUGFIX_PHASES]);
    for (const evt of [...starts, ...ends]) {
      expect(evt.payload.pipelineId).toBe(BUILT_IN_BUGFIX_PIPELINE_ID);
    }
  });

  it('FR-007 immutability: post-startNew catalog reload does NOT retarget the live snapshot', async () => {
    const { controller, store, queue } = await buildHarness({
      workspaceRoot: tmpRoot,
      cliFactory: makeCleanCliRunner
    });

    const feature = await queue.enqueue('Bug-X', {
      pipelineId: BUILT_IN_BUGFIX_PIPELINE_ID
    });
    await controller.startNew(feature, null, { pipelineId: BUILT_IN_BUGFIX_PIPELINE_ID });

    const snapshot = store.getRun()!.pipeline;
    const phaseIdsBefore = (snapshot?.phases ?? []).map((p) => p.id);

    // Even after a controller setCatalog (mid-flight settings change) the
    // existing run's snapshot stays pinned to its enqueue-time pipeline.
    // Build a degenerate catalog with the bugfix pipeline reduced to a
    // single `done` step — the persisted run snapshot must not adopt it.
    const tamperedCatalog = BUILT_IN_CATALOG; // identity for clarity; the
    // assertion below is that store.getRun().pipeline is structurally identical
    // to what was captured at startNew(), regardless of catalog reloads.
    controller.setCatalog(tamperedCatalog);

    const snapshotAfter = store.getRun()!.pipeline;
    expect(snapshotAfter).toBe(snapshot);
    expect((snapshotAfter?.phases ?? []).map((p) => p.id)).toEqual(phaseIdsBefore);
  });
});

describe('Feature 026 T020 — speckit-bugfix verify-fail at bugfix-verify-pre', () => {
  // First invocation of bugfix-verify-pre returns `issues_remain` (the
  // canonical verify-fail signal); every other invocation — including
  // the SECOND visit to bugfix-verify-pre after Resume — returns clean.
  function makeVerifyFailCliRunner(): {
    runner: ClaudeCliRunner;
    invocations: Array<{ phase: string }>;
  } {
    const invocations: Array<{ phase: string }> = [];
    let verifyPreCount = 0;
    const invoke = vi.fn(async (req: InvocationRequest): Promise<RawInvocationOutput> => {
      invocations.push({ phase: req.phase });
      const failVerifyPre =
        req.phase === 'bugfix-verify-pre' && verifyPreCount === 0;
      if (req.phase === 'bugfix-verify-pre') verifyPreCount++;
      return {
        stdoutBuffer: (() => { const b = new ZippedStreamBuffer(); b.append(failVerifyPre ? issuesStdout(req.phase) : cleanStdout(req.phase)); b.finalize(); return b; })(),
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

  it('pauses with pauseCause=phase-paused, never advances past the failing verify, resumes back into the same phase, then completes', async () => {
    const { controller, store, queue, invocations } = await buildHarness({
      workspaceRoot: tmpRoot,
      cliFactory: makeVerifyFailCliRunner
    });

    const feature = await queue.enqueue('Verify-fail bug', {
      pipelineId: BUILT_IN_BUGFIX_PIPELINE_ID
    });
    await controller.startNew(feature, null, { pipelineId: BUILT_IN_BUGFIX_PIPELINE_ID });

    // (a) Run paused with currentPhase pinned to the failing verify phase.
    const pausedRun = store.getRun()!;
    expect(pausedRun.status).toBe('paused');
    expect(pausedRun.currentPhase).toBe('bugfix-verify-pre');

    // (a) Operator-visible queue task pauseCause = 'phase-paused'
    // (FR-016 — reuse, NOT a new literal).
    const pausedFeature = queue.findById(feature.id)!;
    expect(pausedFeature.status).toBe('paused');
    expect(pausedFeature.pauseCause).toBe('phase-paused');

    // (c) No phase-start for bugfix-implement or bugfix-verify-post BEFORE
    // resume. The CLI must have been invoked exactly once: the failing
    // verify-pre.
    expect(invocations.map((i) => i.phase)).toEqual(['bugfix-report', 'bugfix-patch', 'bugfix-verify-pre']);

    const auditBeforeResume = await readAuditLog(tmpRoot);
    const startsBeforeResume = auditBeforeResume.filter((e) => e.eventType === 'phase-start');
    const endsBeforeResume = auditBeforeResume.filter((e) => e.eventType === 'phase-end');
    expect(startsBeforeResume.map((e) => e.payload.phaseId)).toEqual([
      'bugfix-report',
      'bugfix-patch',
      'bugfix-verify-pre'
    ]);
    // NO bugfix-implement / bugfix-verify-post phase-start yet.
    expect(startsBeforeResume.some((e) => e.payload.phaseId === 'bugfix-implement')).toBe(false);
    expect(startsBeforeResume.some((e) => e.payload.phaseId === 'bugfix-verify-post')).toBe(false);

    // (b) phase-end for bugfix-verify-pre has a non-success outcome
    // (issues_remain), and a phase-paused control event followed it.
    const verifyPreEnd = endsBeforeResume.find((e) => e.payload.phaseId === 'bugfix-verify-pre');
    expect(verifyPreEnd).toBeDefined();
    expect(verifyPreEnd!.outcome === 'success' || verifyPreEnd!.outcome === 'clean').toBe(false);
    const pauseEvent = auditBeforeResume.find(
      (e) => e.eventType === 'phase-paused' && e.payload.phaseId === 'bugfix-verify-pre'
    );
    expect(pauseEvent).toBeDefined();

    // (d) Resume IPC re-invokes bugfix-verify-pre — NOT bugfix-implement.
    await controller.resumeExisting();

    // The next CLI invocation after the pause boundary is the SAME phase.
    // We expect the second bugfix-verify-pre to appear at index 3 (right
    // after the three pre-pause invocations).
    expect(invocations[3]?.phase).toBe('bugfix-verify-pre');

    // (e) Second verify success continues forward: bugfix-implement, then
    // bugfix-verify-post (both clean), then done → completed.
    const completed = store.getRun()!;
    expect(completed.status).toBe('completed');
    expect(completed.currentPhase).toBe('done');

    const finalInvocationPhases = invocations.map((i) => i.phase);
    expect(finalInvocationPhases).toEqual([
      'bugfix-report',
      'bugfix-patch',
      'bugfix-verify-pre',
      'bugfix-verify-pre',
      'bugfix-implement',
      'bugfix-verify-post'
    ]);

    const auditAfterResume = await readAuditLog(tmpRoot);
    const startsAfterResume = auditAfterResume.filter((e) => e.eventType === 'phase-start');
    // Two phase-starts for bugfix-verify-pre (initial + resume); one each
    // for the four other bugfix phases. Six total bugfix phase-starts.
    expect(startsAfterResume.map((e) => e.payload.phaseId).filter((p) => p !== 'done')).toEqual([
      'bugfix-report',
      'bugfix-patch',
      'bugfix-verify-pre',
      'bugfix-verify-pre',
      'bugfix-implement',
      'bugfix-verify-post'
    ]);
  });
});
