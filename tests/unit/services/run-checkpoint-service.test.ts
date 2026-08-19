// Feature 093 (T053, T054, US1) — FR-022a / SC-015.
//
// A checkpoint is a `git diff --binary HEAD` of the one shared worktree, and
// this project forbids `git worktree`. So the moment a second Run holds
// uncommitted work, a snapshot taken for Run A necessarily contains Run B's
// in-progress edits, and applying it later reverts B's work. There is no
// in-product restore path — an operator restores by applying the patch file by
// hand — so "never offered for restore" is a guarantee about what gets written,
// which is what these tests assert.
//
// Driven against a real temporary git repository rather than a stubbed
// `execFile`, because the property under test is what lands on disk.
//
// **Superseded in part by FR-R3-004.** Concurrency no longer forces the decline:
// a Run whose writes were observed gets a scoped patch, and the attribution
// tests live in `run-checkpoint-attribution.test.ts`. What survives here is the
// half that was never about concurrency — a decline writes no `.patch` and does
// not block its phase, and a genuine capture failure still does. The service
// below is built with a ledger that observed nothing, which is exactly the
// residual unattributable case, so these Runs still decline; only the recorded
// *reason* moved from `concurrent-runs-share-one-worktree` to
// `attribution-evidence-incomplete`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SanitizedLogger } from '../../../src/lib/logger';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { RunCheckpointService } from '../../../src/services/run-checkpoint-service';
import { RunMutationLedger } from '../../../src/services/run-mutation-ledger';

const run = promisify(execFile);

let storageRoot: string;
let workspaceRoot: string;
let warnings: string[];
let logger: SanitizedLogger;

const RUN: WorkflowRun = {
  id: 'run-a',
  featureId: 'feat-a',
  featureDir: 'specs/001-x',
  status: 'running',
  currentPhase: 'speckit-implement',
  currentIteration: 0,
  startedAt: 1_700_000_000_000,
  lastTransitionAt: 1_700_000_000_000,
  phasesCompleted: [],
  lastError: null,
  delayedRetryCount: 0,
  pendingRetryAt: null,
  pendingRetryCause: null,
  phaseOverrides: [],
  manualPauseAt: null,
  manualPauseCause: null,
  phaseBreakpoints: [],
  resumeTargetPhaseId: null
};

beforeEach(async () => {
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-checkpoint-store-'));
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-checkpoint-work-'));
  await run('git', ['init', '-q'], { cwd: workspaceRoot });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: workspaceRoot });
  await run('git', ['config', 'user.name', 'Test'], { cwd: workspaceRoot });
  await run('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: workspaceRoot });
  warnings = [];
  logger = { warn: (message: string) => warnings.push(message) } as unknown as SanitizedLogger;
});

afterEach(async () => {
  await fs.rm(storageRoot, { recursive: true, force: true });
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

/** A ledger that has observed nothing: the residual unattributable case. */
function blindLedger(root = workspaceRoot): RunMutationLedger {
  return new RunMutationLedger({
    readDiff: async () =>
      (
        await run('git', ['diff', '--binary', '--no-ext-diff', 'HEAD'], { cwd: root })
      ).stdout,
    listInFlightRunIds: () => [],
    workspaceRoot: root
  });
}

function service(countInFlightRuns: () => number): RunCheckpointService {
  return new RunCheckpointService(
    storageRoot,
    workspaceRoot,
    logger,
    countInFlightRuns,
    blindLedger()
  );
}

async function artifacts(): Promise<readonly string[]> {
  const runRoot = path.join(storageRoot, 'checkpoints', 'run-a');
  try {
    return (await fs.readdir(runRoot)).sort();
  } catch {
    return [];
  }
}

describe('RunCheckpointService — sole in-flight Run (T053, FR-022a)', () => {
  it('records a restorable snapshot when this Run is the only one in flight', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'a.txt'), 'edit by run-a\n');
    await run('git', ['add', '-A'], { cwd: workspaceRoot });

    await service(() => 1).checkpoint(RUN, 'speckit-implement');

    const files = await artifacts();
    expect(files.filter((name) => name.endsWith('.patch'))).toHaveLength(1);
    expect(files.filter((name) => name.endsWith('.declined.json'))).toHaveLength(0);
    const patch = await fs.readFile(
      path.join(storageRoot, 'checkpoints', 'run-a', files.find((n) => n.endsWith('.patch'))!),
      'utf8'
    );
    expect(patch).toContain('edit by run-a');
    expect(warnings).toEqual([]);
  });
});

describe('RunCheckpointService — concurrency (T053, T054, FR-022a, SC-015)', () => {
  it('declines to record a snapshot while a second Run is in flight', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'a.txt'), 'edit by run-a\n');
    await fs.writeFile(path.join(workspaceRoot, 'b.txt'), 'edit by run-b\n');
    await run('git', ['add', '-A'], { cwd: workspaceRoot });

    await service(() => 2).checkpoint(RUN, 'speckit-implement');

    // The guarantee is about what exists on disk: with no patch file there is
    // nothing for an operator to apply, so a snapshot taken under concurrency
    // is never offered for restore.
    const files = await artifacts();
    expect(files.filter((name) => name.endsWith('.patch'))).toHaveLength(0);
    for (const name of files) {
      const body = await fs.readFile(path.join(storageRoot, 'checkpoints', 'run-a', name), 'utf8');
      expect(body).not.toContain('edit by run-b');
    }
  });

  it('records why the snapshot was declined', async () => {
    await service(() => 3).checkpoint(RUN, 'speckit-implement');

    const files = await artifacts();
    const marker = files.find((name) => name.endsWith('.declined.json'));
    expect(marker).toBeDefined();
    const recorded = JSON.parse(
      await fs.readFile(path.join(storageRoot, 'checkpoints', 'run-a', marker!), 'utf8')
    );
    expect(recorded).toMatchObject({
      runId: 'run-a',
      phaseId: 'speckit-implement',
      reason: 'attribution-evidence-incomplete',
      inFlightRuns: 3,
      restorable: false
    });
    expect(warnings.join('\n')).toContain('attribution-evidence-incomplete');
  });

  it('does not block the Git-capable phase it declined to snapshot', async () => {
    // A declined snapshot is not a failed one. `checkpoint()` throws
    // `checkpoint-unavailable` when it cannot capture, and the driver blocks the
    // phase on that; declining under concurrency must return normally, or the
    // refusal would serialize Git-capable phases across queues — the
    // serialization SC-013 forbids, reintroduced to protect a safety net that
    // this very code path has just established cannot be taken.
    await expect(service(() => 2).checkpoint(RUN, 'speckit-implement')).resolves.toBeUndefined();
  });

  it('still surfaces a genuine capture failure while sole in flight', async () => {
    // Not a git repository, so `git diff` fails. The pre-feature contract holds:
    // a snapshot that cannot be taken blocks the phase.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-checkpoint-nogit-'));
    const broken = new RunCheckpointService(
      storageRoot,
      outside,
      logger,
      () => 1,
      blindLedger(outside)
    );
    await expect(broken.checkpoint(RUN, 'speckit-implement')).rejects.toThrow(
      'checkpoint-unavailable'
    );
    await fs.rm(outside, { recursive: true, force: true });
  });
});
