// FR-R3-114 row 5 — the product's longest path, driven once, end to end.
//
// THE GAP THIS CLOSES. The residual register recorded that **no test exercises
// webview -> IPC -> controller -> CLI**. The e2e file starts at `ClaudeCliRunner` — below the
// router entirely — and every integration test that involves the webview drives a `MockWebview`
// or calls `router.dispatch()` with an already-typed object. So the two boundaries most likely to
// drift silently were each covered from one side only:
//
//   1. **The validator boundary.** A webview posts JSON. Every existing test hands the router a
//      TypeScript value that the compiler already proved well-formed, which is precisely what a
//      hostile or stale webview will not send.
//   2. **The router-to-controller boundary.** `RouterDeps.executeCommand` is a function in every
//      test; nothing drove a validated command through it into the real controller and out to a
//      CLI.
//
// Seam regressions across that path were invisible until someone used the product.
//
// WHAT THIS DRIVES, and every step is the real thing except the CLI:
//
//   raw JSON  ->  validateInboundMessage (the real runtime validator)
//             ->  MessageRouter.dispatch (the real router, real trust and primacy gates)
//             ->  the real command handler for CMD_RESUME_PHASE
//             ->  SchegentWorkflowController.resumeActivePhase -> .resumeExisting (the real controller)
//             ->  PhaseRunner (the real runner) -> a fake CLI
//             ->  the real audit log and the real WorkspaceStateStore
//
// The CLI is fake because a live turn costs the operator's own subscription quota and this is a
// per-run gate; `FR-R3-104`'s canary is where a real backend is exercised, deliberately off this
// path. Everything between the JSON and the spawn is production code.
//
// WHY CMD_RESUME_PHASE. It is the shortest validated command that reaches a CLI invocation through
// the controller, so the test is about the SEAM rather than about queue admission policy — which
// `guarded-run-service` and the enqueue tests already cover from both sides.
//
// It used to be `CMD_RESUME`, the queue-less ancestor. The lifecycle round-check of 2026-08-30
// (finding D) deleted that command: no webview surface had sent it since FR-R3-140 removed
// `ControlPanel.svelte`, so the longest path this test drove was a path only this test took —
// which is the one thing an end-to-end test must not be. `CMD_RESUME_PHASE` is what the product
// actually sends, and it reaches the same controller entry point one hop further along.
//
// That hop is asynchronous, and deliberately so: `resumeActivePhase` clears the pause, writes the
// run, and hands the resume to `setImmediate` rather than awaiting it, because the operator's
// acknowledgement must not wait on a CLI turn. So the assertions below wait for the invocation
// instead of assuming it has already happened by the time `dispatch` resolves.
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { validateInboundMessage } from '../../src/contracts/runtime-validators';
import { MessageRouter, type RouterDeps } from '../../src/ui/sidebar/message-router';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { SanitizedLogger } from '../../src/lib/logger';
import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { unfencedCommit } from '../../src/state/ownership-claim';
import {
  buildSpeckitCatalog,
  BUGFIX_PIPELINE,
  BUGFIX_PHASE_DEFS,
  SPECKIT_BUGFIX_PIPELINE_ID
} from '../fixtures/speckit-catalog-fixture';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { RawInvocationOutput, InvocationRequest } from '../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';
import type { CommandAckMessage } from '../../src/ui/sidebar/messages';
import { removeTempRoot } from '../temp-root-cleanup';

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
    'PHASE_COMPLETE',
    '=== SCHEGENT AUDIT LOG ===',
    `phase: ${phase}`,
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: ["mock"]',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    'notes: end-to-end seam',
    '=== END AUDIT LOG ==='
  ].join('\n');

interface Harness {
  readonly router: MessageRouter;
  readonly store: WorkspaceStateStore;
  readonly invocations: Array<{ phase: string; cliPath: string }>;
  readonly acks: CommandAckMessage[];
  readonly executed: string[];
  readonly workspaceRoot: string;
  readonly postAck: (msg: CommandAckMessage) => Promise<boolean>;
  cleanup(): Promise<void>;
}

async function buildHarness(overrides: { isPrimary?: boolean; isTrusted?: boolean } = {}): Promise<Harness> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-webview-e2e-'));
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot }, logger);

  const invocations: Array<{ phase: string; cliPath: string }> = [];
  const runner = {
    invoke: vi.fn(async (req: InvocationRequest): Promise<RawInvocationOutput> => {
      invocations.push({ phase: req.phase, cliPath: req.cliPath });
      const stdoutBuffer = new ZippedStreamBuffer();
      stdoutBuffer.append(cleanStdout(req.phase));
      stdoutBuffer.finalize();
      const stderrBuffer = new ZippedStreamBuffer();
      stderrBuffer.finalize();
      return { stdoutBuffer, stderrBuffer, exitCode: 0, killed: false, timedOut: false, durationMs: 1 };
    }),
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;

  const phaseRunner = new PhaseRunner(runner, new PromptBuilder(), audit, logger);
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
    {
      release: vi.fn(async () => {}),
      tryAcquire: vi.fn(async () => ({ acquired: false, owner: null })),
      heartbeat: vi.fn(),
      isHeld: vi.fn(),
      ownerOfRecord: vi.fn(),
      id: 'this-window'
    } as unknown as WorkspaceLockManager,
    { cliPath: 'fake-cli', cwd: workspaceRoot, iterationCap: 5, timeoutMs: 1_000 },
    { catalog: buildSpeckitCatalog(), auditWriter: audit }
  );

  const executed: string[] = [];
  const acks: CommandAckMessage[] = [];
  const deps: RouterDeps = {
    // THE SEAM. The router names a VS Code command id; activation binds that id to the
    // controller. Binding it here is what makes this test end-to-end rather than two halves:
    // a handler that stopped calling `schegent.resumePhase` would show up as a missing invocation.
    executeCommand: (async (id: string, ...args: unknown[]) => {
      executed.push(id);
      if (id === 'schegent.resumePhase') {
        return controller.resumeActivePhase(
          args[0] as string | undefined,
          args[1] as string | undefined
        );
      }
      return undefined;
    }) as unknown as RouterDeps['executeCommand'],
    queueRemover: { remove: vi.fn(async () => true) },
    isPrimary: () => overrides.isPrimary ?? true,
    isTrusted: () => overrides.isTrusted ?? true,
    logger
  };

  return {
    router: new MessageRouter(deps),
    store,
    invocations,
    acks,
    executed,
    workspaceRoot,
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    cleanup: async () => {
      // `resumeActivePhase` hands the resume to `setImmediate` and the audit
      // writer appends with nothing awaiting it, so a write can still land after
      // the last assertion — which is the behaviour under test, not a leak. A
      // plain recursive `rm` races it and fails on `rmdir` with ENOTEMPTY:
      // measured at 4 failures in 10 isolated runs before this call replaced it.
      await removeTempRoot(workspaceRoot);
    }
  };
}

/** Exactly what a webview posts: JSON, parsed, of unknown shape. */
function postedFromWebview(raw: unknown): unknown {
  return JSON.parse(JSON.stringify(raw));
}

/** How long the scheduled resume gets to finish before we give up on it. */
const RESUME_SETTLE_MS = 5_000;

/**
 * Wait for something the scheduled resume produces, or give up.
 *
 * `resumeActivePhase` hands the actual resume to `setImmediate` rather than
 * awaiting it, so `dispatch` resolves while the CLI turn is still ahead. Every
 * assertion about what the path reached therefore has to wait for it. This
 * returns rather than asserts: the caller says what it expected to find, so a
 * timeout fails on the real claim instead of on "waited too long".
 */
async function settle(done: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + RESUME_SETTLE_MS;
  while (!(await done()) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The audit log the path writes, or `''` before the first event lands. */
async function readAuditLog(h: Harness): Promise<string> {
  try {
    return await fs.readFile(path.join(h.workspaceRoot, '.schegent', 'audit.log'), 'utf8');
  } catch {
    return '';
  }
}

describe('FR-R3-114 row 5 — webview -> IPC -> controller -> CLI, once, end to end', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('carries a real posted message all the way to a CLI invocation', async () => {
    harness = await buildHarness();
    // The queue entry the run belongs to. `resumeExistingOnQueue` resolves the Task by
    // `run.featureId` and refuses without it — a precondition worth setting up honestly rather
    // than working around, since a resume with no Task is exactly the state it must refuse.
    await harness!.store.setQueue(
      {
        paused: false,
        pausedReason: null,
        inFlightId: null,
        updatedAt: 1_700_000_000_000,
        queueLifecycle: 'active-empty',
        pauseSource: null,
        scheduledStartAt: null,
        scheduledStartSource: null,
        requests: [
          {
            id: 'feat-e2e',
            description: 'end-to-end seam',
            enqueuedAt: 1_700_000_000_000,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            startedAt: 1_700_000_000_000,
            completedAt: null,
            status: 'in-flight',
            position: 0,
            runId: 'run-e2e',
            retryCount: 0,
            lastError: null,
            pausedReason: null,
            pipelineId: SPECKIT_BUGFIX_PIPELINE_ID
          }
        ]
      } as never,
      DEFAULT_QUEUE_ID
    );

    // A paused run for the resume to pick up, written the way activation would.
    await harness!.store.setRun(
      DEFAULT_QUEUE_ID,
      {
        id: 'run-e2e',
        featureId: 'feat-e2e',
        featureDir: 'specs/999-e2e',
        status: 'paused',
        currentPhase: 'bugfix-report',
        currentIteration: 1,
        startedAt: 1_700_000_000_000,
        lastTransitionAt: 1_700_000_000_000,
        phasesCompleted: [],
        lastError: null,
        delayedRetryCount: 0,
        pendingRetryAt: null,
        pendingRetryCause: null,
        phaseOverrides: [],
        manualPauseAt: 1_700_000_000_000,
        manualPauseCause: 'operator-paused',
        phaseBreakpoints: [],
        resumeTargetPhaseId: null,
        pipelineId: SPECKIT_BUGFIX_PIPELINE_ID,
        // The frozen plan. `resumeExistingOnQueue` REFUSES a run with no snapshot rather than
        // substituting one (feature 098 T026), so this is a precondition of the path rather than
        // test scaffolding — a resume that re-planned would run a sequence the operator never
        // approved.
        pipeline: {
          id: SPECKIT_BUGFIX_PIPELINE_ID,
          name: BUGFIX_PIPELINE.name,
          version: BUGFIX_PIPELINE.version,
          phases: BUGFIX_PHASE_DEFS
        }
      } as never,
      unfencedCommit('test-fixture')
    );

    const posted = postedFromWebview({
      type: 'CMD_RESUME_PHASE',
      correlationId: 'c-1',
      // The queue is mandatory and the prompt is not: the real validator refuses a
      // `CMD_RESUME_PHASE` that does not say which Run it resumes, which is itself a small thing
      // this test learned by driving the real validator instead of a typed object.
      payload: { queueId: DEFAULT_QUEUE_ID }
    });

    // 1. The real validator, on the real posted bytes.
    const validated = validateInboundMessage(posted);
    expect(validated.ok, JSON.stringify(validated)).toBe(true);
    if (!validated.ok) return;

    // 2..n. The real router, the real handler, the real controller, the real phase runner.
    await harness!.router.dispatch(validated.command, harness!.postAck);

    expect(harness!.executed, 'the handler must reach the command activation binds').toContain(
      'schegent.resumePhase'
    );
    // The whole turn, not just its start: `phase-end` is the last thing the path
    // writes, so waiting for it is waiting for every step in between.
    await settle(async () => (await readAuditLog(harness!)).includes('phase-end'));

    expect(
      harness!.invocations.length,
      'a validated CMD_RESUME_PHASE must reach the CLI through the controller'
    ).toBeGreaterThan(0);
    expect(harness!.invocations[0]!.cliPath).toBe('fake-cli');

    // The evidence half: the path wrote a real audit log through the real writer.
    const log = await readAuditLog(harness!);
    const events = log
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { eventType: string });
    expect(events.map((e) => e.eventType)).toContain('phase-start');
    expect(events.map((e) => e.eventType)).toContain('phase-end');
  });

  it('refuses a malformed posted message at the validator, before the controller sees it', async () => {
    // The direction the compiler cannot check. Every other test hands the router a typed value;
    // a webview hands it whatever it happens to send.
    harness = await buildHarness();
    for (const bad of [
      { type: 'CMD_RESUME_PHASE', payload: { queueId: DEFAULT_QUEUE_ID } }, // no correlationId
      { type: 'CMD_RESUME_PHASE', correlationId: 'c-2a' }, // no queue named
      { type: 'NOT_A_COMMAND', correlationId: 'c-2' },
      { correlationId: 'c-3', payload: {} }, // no type
      'CMD_RESUME_PHASE',
      null
    ]) {
      const validated = validateInboundMessage(postedFromWebview(bad));
      expect(validated.ok, `${JSON.stringify(bad)} must not validate`).toBe(false);
    }
    expect(harness!.invocations, 'nothing reached the CLI').toEqual([]);
    expect(harness!.executed, 'nothing reached a command').toEqual([]);
  });

  it('refuses a well-formed message from a secondary window, before the controller sees it', async () => {
    // The primacy gate is on this path and is asserted here because the gate being IN the path is
    // the property that matters: a validated message from a window that lost the lock must not
    // reach the controller at all.
    harness = await buildHarness({ isPrimary: false });
    const validated = validateInboundMessage(
      postedFromWebview({
        type: 'CMD_RESUME_PHASE',
        correlationId: 'c-4',
        payload: { queueId: DEFAULT_QUEUE_ID }
      })
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    await harness!.router.dispatch(validated.command, harness!.postAck);

    // The gate refuses ahead of `executeCommand`, so nothing was scheduled and
    // there is nothing to wait for — which is the claim, not an assumption: an
    // empty `executed` is what makes the empty `invocations` below meaningful
    // rather than merely early. One macrotask turn is enough to show that a
    // `setImmediate` the gate failed to prevent would already have run.
    await new Promise((r) => setImmediate(r));
    expect(harness!.executed, 'a secondary window must not reach a command').toEqual([]);
    expect(harness!.invocations, 'a secondary window must not reach the CLI').toEqual([]);
    expect(harness!.acks.some((ack) => ack.status === 'rejected')).toBe(true);
  });
});
