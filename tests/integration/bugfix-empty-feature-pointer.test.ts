import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
// Feature 026 T020a — integration: enqueueing a `speckit-bugfix` task
// against a workspace whose feature pointer is empty (or refers to a
// non-existent feature dir) MUST fail fast at `bugfix-report` without
// invoking any downstream phase. Covers FR-020 + spec.md edge case
// "bugfix pipeline enqueued before any feature exists".
//
// Scope:
//   (a) `bugfix-report` fails fast via the existing audited-failure
//       pathway (run transitions to `failed`); NO new state literal.
//   (b) NONE of the downstream phases (`bugfix-patch`,
//       `bugfix-verify-pre`, `bugfix-implement`, `bugfix-verify-post`)
//       emit a `phase-start` event before the first failure.
//   (c) The audit log contains exactly one `phase-start` + one
//       `phase-end` for `bugfix-report`, with the `phase-end`
//       carrying a non-success outcome.
//   (d) Repointing the feature pointer at a valid dir and resuming
//       allows the pipeline to proceed past `bugfix-report`.
//
// On-wire literals: the audit log carries `phase-start` / `phase-end`
// (see `PHASE_EVENT_TYPES` in `src/contracts/audit-events.ts`); the
// feature docs / tasks.md prose refers to them as
// `phase-invocation-start` / `phase-invocation-end` for readability.

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
// Feature 098 (T080) — the bugfix Pipeline and its Phases come from the test
// fixture rather than from a compiled-in catalog, which no longer holds any. The
// ids are the real ones because `phase-sequencer.ts` and
// `workflow-run-migrator.ts` still key on them; see the fixture header.
import {
  buildSpeckitCatalog,
  SPECKIT_BUGFIX_PIPELINE_ID
} from '../fixtures/speckit-catalog-fixture';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { RawInvocationOutput, InvocationRequest } from '../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';

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

// Feature 107 (FR-R3-023, T623) — the token trails the audit block, where
// `.specify/memory/constitution.md` § Output Formatting & Loop Termination has
// always required it ("the **last non-empty line** of stdout for terminal
// phases"). It sat on the line *before* the block until the host began
// enforcing that rule; nothing about this fixture's intent changed.
const cleanStdout = (phase: string): string =>
  [
    '=== SCHEGENT AUDIT LOG ===',
    `phase: ${phase}`,
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: ["mock"]',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    'notes: ok',
    '=== END AUDIT LOG ===',
    '[SCHEGENT_STATUS: CLEAR]'
  ].join('\n');

// The first invocation of `bugfix-report` simulates the empty/missing
// feature-pointer fast-fail by emitting a built-in fatal signature in
// stderr (`"error: unknown option"` — see FATAL_SIGNATURES in
// src/lib/fatal-signature-registry.ts). The stdout-parser classifies
// that as `kind:'malformed'` with `fatalCause`, the runner maps it to
// `outcome:'failed'`, the transition engine halts to `status:'failed'`,
// and the controller routes it through the existing audited-failure
// pathway. No new state literal is required.
//
// On subsequent invocations the CLI returns clean — simulating the
// operator repointing the workspace's feature pointer at a valid dir.

function makeFailFirstReportRunner(): {
  runner: ClaudeCliRunner;
  invocations: Array<{ phase: string }>;
} {
  const invocations: Array<{ phase: string }> = [];
  let bugfixReportCount = 0;
  const invoke = vi.fn(async (req: InvocationRequest): Promise<RawInvocationOutput> => {
    invocations.push({ phase: req.phase });
    const failFirstReport = req.phase === 'bugfix-report' && bugfixReportCount === 0;
    if (req.phase === 'bugfix-report') bugfixReportCount++;
    if (failFirstReport) {
      return {
        stdoutBuffer: (() => { const b = new ZippedStreamBuffer(); b.append('feature pointer empty — bugfix-report cannot proceed.'); b.finalize(); return b; })(), stderrBuffer: (() => { const b = new ZippedStreamBuffer(); b.append('error: unknown option'); b.finalize(); return b; })(), // built-in fatal signature
        exitCode: 1,
        killed: false,
        timedOut: false,
        durationMs: 1
      };
    }
    return {
      stdoutBuffer: (() => { const b = new ZippedStreamBuffer(); b.append(cleanStdout(req.phase)); b.finalize(); return b; })(), stderrBuffer: (() => { const b = new ZippedStreamBuffer(); b.finalize(); return b; })(),
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
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
}

interface HarnessOpts {
  readonly workspaceRoot: string;
}

async function buildHarness(opts: HarnessOpts): Promise<{
  controller: SchegentWorkflowController;
  store: WorkspaceStateStore;
  queue: QueueManager;
  invocations: Array<{ phase: string }>;
}> {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot: opts.workspaceRoot }, logger);
  const { runner, invocations } = makeFailFirstReportRunner();
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
    { catalog: buildSpeckitCatalog(), auditWriter: audit }
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
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-bugfix-empty-pointer-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('Feature 026 T020a — speckit-bugfix fails fast on empty feature pointer', () => {
  it('halts at bugfix-report, emits exactly one phase-start + phase-end, no downstream invocations; resume after repointing proceeds', async () => {
    const { controller, store, queue, invocations } = await buildHarness({
      workspaceRoot: tmpRoot
    });

    // Enqueue with an empty/missing feature pointer (featureDir omitted).
    const feature = await queue.enqueue('Bug against missing feature', {
      pipelineId: SPECKIT_BUGFIX_PIPELINE_ID
    });
    await controller.startNew(feature, null, { pipelineId: SPECKIT_BUGFIX_PIPELINE_ID });

    // (a) Run halts via the existing audited-failure pathway (no new
    // state literal). currentPhase stays pinned at bugfix-report.
    const failedRun = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(failedRun.status).toBe('failed');
    expect(failedRun.currentPhase).toBe('bugfix-report');
    expect(failedRun.lastError).toBeTruthy();

    // (b) Exactly one CLI invocation — bugfix-report; no downstream.
    expect(invocations.map((i) => i.phase)).toEqual(['bugfix-report']);

    // (c) Audit log: one phase-start + one phase-end for bugfix-report
    // with a non-success outcome. No downstream phase-start.
    const auditBeforeResume = await readAuditLog(tmpRoot);
    const starts = auditBeforeResume.filter((e) => e.eventType === 'phase-start');
    const ends = auditBeforeResume.filter((e) => e.eventType === 'phase-end');
    expect(starts.length).toBe(1);
    expect(starts[0].payload.phaseId).toBe('bugfix-report');
    expect(ends.length).toBe(1);
    expect(ends[0].phase).toBe('bugfix-report');
    expect(ends[0].payload).not.toHaveProperty('phaseId');
    expect(ends[0].outcome === 'success' || ends[0].outcome === 'clean').toBe(false);

    // None of the downstream phases emitted phase-start before failure.
    for (const downstream of [
      'bugfix-patch',
      'bugfix-verify-pre',
      'bugfix-implement',
      'bugfix-verify-post'
    ]) {
      expect(starts.some((e) => e.payload.phaseId === downstream)).toBe(false);
    }

    // (d) After "repointing the feature pointer" (simulated here by the
    // CLI runner returning clean on subsequent invocations — the second
    // bugfix-report invocation will succeed), resume drives the pipeline
    // forward past bugfix-report.
    const resumed = await controller.resumeExisting(DEFAULT_QUEUE_ID);
    expect(resumed).toBe(true);

    const completed = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(completed.status).toBe('completed');
    expect(completed.currentPhase).toBe('done');

    // Six total invocations: the failing bugfix-report + the second
    // bugfix-report after resume + four remaining bugfix phases.
    expect(invocations.map((i) => i.phase)).toEqual([
      'bugfix-report',
      'bugfix-report',
      'bugfix-patch',
      'bugfix-verify-pre',
      'bugfix-implement',
      'bugfix-verify-post'
    ]);
  });
});
