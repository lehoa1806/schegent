// FR-R3-004 — a real git repository, a real ledger, and Runs whose phases can be
// opened and closed by hand.
//
// Shared by the attribution, decline, and integration suites because all three
// need the same thing: a tree that git actually reports on. The property under
// test is which bytes land in a `.patch`, and a stubbed `execFile` would be
// asserting that the stub returns what the stub was told to return.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SanitizedLogger } from '../../../src/lib/logger';
import { RunCheckpointService } from '../../../src/services/run-checkpoint-service';
import { RunMutationLedger } from '../../../src/services/run-mutation-ledger';
import type { WorkflowRun } from '../../../src/state/workflow-run';

export const git = promisify(execFile);

/** Frozen: nothing may pass because a Run looked older than the ledger by luck. */
export const LEDGER_CREATED_AT = 1_700_000_000_000;

export interface CheckpointHarness {
  readonly storageRoot: string;
  readonly workspaceRoot: string;
  readonly ledger: RunMutationLedger;
  readonly warnings: string[];
  /** Run ids the count and the ledger both treat as live. Mutate in a test. */
  readonly live: Set<string>;
  service(): RunCheckpointService;
  /** Build a Run that the ledger will accept as observed from its first phase. */
  run(id: string, over?: Partial<WorkflowRun>): WorkflowRun;
  /**
   * A Run reloaded mid-pipeline after a window restart: it began before this
   * ledger did and already has a completed phase, so no amount of observing it
   * from here on makes its history complete.
   */
  resumedRun(id: string): WorkflowRun;
  /**
   * Open a phase window, run `body`, close it — the driver's bracket, by hand.
   *
   * The closing report declares whatever `write()` touched inside the window,
   * which is what a well-behaved CLI does: its audit record names the files it
   * created and modified. Pass `declared` to model one that does not — an empty
   * list is a phase that wrote a file and did not say so, and `null` is a phase
   * that produced no audit record at all.
   */
  phase(
    run: WorkflowRun,
    body: () => Promise<void>,
    declared?: readonly string[] | null
  ): Promise<void>;
  /** Make `readDiff` throw for the duration of `body` — observation going blind. */
  breakObservation(body: () => Promise<void>): Promise<void>;
  /**
   * A phase that wrote nothing and declared nothing. A sibling that is in flight
   * has dispatched at least one phase under observation, and a checkpoint refuses
   * to partition a tree around a live Run it has never seen — so a test that
   * stands a sibling up without ever dispatching it is testing the decline, not
   * the attribution.
   */
  idlePhase(run: WorkflowRun): Promise<void>;
  write(relative: string, body: string): Promise<void>;
  commitAll(message: string): Promise<void>;
  head(): Promise<string>;
  artifacts(runId: string): Promise<readonly string[]>;
  read(runId: string, name: string): Promise<string>;
  metadata(runId: string, name: string): Promise<Record<string, unknown>>;
  dispose(): Promise<void>;
}

export async function makeCheckpointHarness(): Promise<CheckpointHarness> {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-attr-store-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-attr-work-'));
  await git('git', ['init', '-q'], { cwd: workspaceRoot });
  await git('git', ['config', 'user.email', 'test@example.com'], { cwd: workspaceRoot });
  await git('git', ['config', 'user.name', 'Test'], { cwd: workspaceRoot });
  await git('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: workspaceRoot });

  const warnings: string[] = [];
  const logger = {
    warn: (message: string) => warnings.push(message)
  } as unknown as SanitizedLogger;

  const live = new Set<string>();
  let observationBroken = false;
  /** Every path `write()` has touched, so a phase can declare its own writes. */
  const written: string[] = [];
  const ledger = new RunMutationLedger({
    readDiff: async () => {
      if (observationBroken) throw new Error('git unavailable');
      return (
        await git('git', ['diff', '--binary', '--no-ext-diff', 'HEAD'], { cwd: workspaceRoot })
      ).stdout;
    },
    listInFlightRunIds: () => [...live],
    workspaceRoot,
    now: () => LEDGER_CREATED_AT
  });

  const runRootOf = (runId: string): string =>
    path.join(storageRoot, 'checkpoints', runId.replace(/[^a-zA-Z0-9_-]/g, '_'));

  const makeRun = (id: string, over: Partial<WorkflowRun> = {}): WorkflowRun => {
    live.add(id);
    return {
      id,
      featureId: `feat-${id}`,
      featureDir: `specs/001-${id}`,
      status: 'running',
      currentPhase: 'speckit-implement',
      currentIteration: 0,
      // At or after the ledger's own creation, so evidence can be complete.
      startedAt: LEDGER_CREATED_AT + 1,
      lastTransitionAt: LEDGER_CREATED_AT + 1,
      phasesCompleted: [],
      lastError: null,
      delayedRetryCount: 0,
      pendingRetryAt: null,
      pendingRetryCause: null,
      phaseOverrides: [],
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      resumeTargetPhaseId: null,
      ...over
    } as WorkflowRun;
  };

  return {
    storageRoot,
    workspaceRoot,
    ledger,
    warnings,
    live,
    service: () =>
      new RunCheckpointService(storageRoot, workspaceRoot, logger, () => live.size, ledger),
    run: makeRun,
    resumedRun: (id) =>
      makeRun(id, {
        startedAt: LEDGER_CREATED_AT - 60_000,
        lastTransitionAt: LEDGER_CREATED_AT - 60_000,
        // Only the count is read; the record's other fields are inert here.
        phasesCompleted: [
          {
            phase: 'speckit-plan',
            iteration: 0,
            startedAt: LEDGER_CREATED_AT - 60_000,
            endedAt: LEDGER_CREATED_AT - 30_000,
            result: 'clean',
            terminationReason: 'token',
            exitCode: 0,
            stdoutSummary: '',
            stderrSummary: '',
            auditEntryId: null
          }
        ] as WorkflowRun['phasesCompleted']
      }),
    breakObservation: async (body) => {
      observationBroken = true;
      try {
        await body();
      } finally {
        observationBroken = false;
      }
    },
    phase: async (run, body, declared) => {
      await ledger.observeBeforePhase(run);
      const before = written.length;
      try {
        await body();
      } finally {
        const report =
          declared === null
            ? null
            : { declaredPaths: declared ?? written.slice(before) };
        await ledger.observeAfterPhase(run, report);
      }
    },
    idlePhase: async (run) => {
      await ledger.observeBeforePhase(run);
      await ledger.observeAfterPhase(run, { declaredPaths: [] });
    },
    write: async (relative, body) => {
      written.push(relative);
      const target = path.join(workspaceRoot, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body, 'utf8');
      // `git diff HEAD` reports tracked paths only, and so does a checkpoint
      // patch. Staging is what makes a new file visible to both.
      await git('git', ['add', '-A'], { cwd: workspaceRoot });
    },
    commitAll: async (message) => {
      await git('git', ['add', '-A'], { cwd: workspaceRoot });
      await git('git', ['commit', '-q', '-m', message], { cwd: workspaceRoot });
    },
    head: async () => (await git('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot })).stdout.trim(),
    artifacts: async (runId) => {
      try {
        return (await fs.readdir(runRootOf(runId))).sort();
      } catch {
        return [];
      }
    },
    read: (runId, name) => fs.readFile(path.join(runRootOf(runId), name), 'utf8'),
    metadata: async (runId, name) =>
      JSON.parse(await fs.readFile(path.join(runRootOf(runId), name), 'utf8')),
    dispose: async () => {
      await fs.rm(storageRoot, { recursive: true, force: true });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  };
}

/** The single `.patch` a Run wrote, or `null` when it declined. */
export async function onlyPatch(
  harness: CheckpointHarness,
  runId: string
): Promise<string | null> {
  const name = (await harness.artifacts(runId)).find((file) => file.endsWith('.patch'));
  return name === undefined ? null : harness.read(runId, name);
}

/** The single `.declined.json` a Run wrote, or `null` when it did not decline. */
export async function onlyDecline(
  harness: CheckpointHarness,
  runId: string
): Promise<Record<string, unknown> | null> {
  const name = (await harness.artifacts(runId)).find((file) => file.endsWith('.declined.json'));
  return name === undefined ? null : harness.metadata(runId, name);
}

/** The metadata beside the single `.patch`. */
export async function onlyMetadata(
  harness: CheckpointHarness,
  runId: string
): Promise<Record<string, unknown> | null> {
  const name = (await harness.artifacts(runId)).find(
    (file) => file.endsWith('.json') && !file.endsWith('.declined.json')
  );
  return name === undefined ? null : harness.metadata(runId, name);
}
