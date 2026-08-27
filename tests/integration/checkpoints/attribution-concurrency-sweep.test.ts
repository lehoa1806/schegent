// FR-R3-124 (FR-005, T1468) — what the attribution machinery does at concurrency
// 1, 2, 4 and 8, measured rather than reasoned about.
//
// WHY THIS EXISTS. The repository audit of 2026-08-27 called shared-tree
// parallelism architectural: attribution "cannot provide workspace isolation or
// prevent semantic conflicts". `FR-R3-081` already measured the RESOURCE half at
// the ceiling (`docs/operations/concurrent-run-resource-measurement.md`, 400 MiB
// asserted). Nobody had measured the half the audit's objection is actually about:
// at each concurrency, how often can the machinery still decompose the tree, and
// what does an operator get when it cannot?
//
// WHAT IT DRIVES. The real `RunMutationLedger` and the real
// `RunCheckpointService`, against a real temporary Git repository, with N Runs
// whose phase windows genuinely overlap — every window is opened before any Run
// writes, and closed after all of them have. Serializing them would measure a
// situation concurrency does not produce.
//
// WHY NOT `tests/perf/`. `FR-R3-042` separated `vitest.perf.config.ts` to keep
// wall-clock assertions out of the hermetic suite. Everything asserted here is a
// deterministic attribution outcome with no timing in it, so it belongs in the
// hermetic suite; the per-level resource figures are **observed and printed, never
// asserted**, because a heap assertion here would be exactly the environment-
// dependent failure that separation exists to prevent. The asserted resource bound
// stays `tests/perf/aggregate-resource-soak.test.ts`.
//
// WHAT THE NUMBERS MEAN, and the limit is the interesting part. The fixture is
// synthetic and deterministic on purpose: the attribution question turns on
// whether two Runs' DECLARED PATH SETS overlap, not on tree size or history
// depth, so a large real workspace would move the resource figures and not the
// outcome distribution. Large-workspace behaviour is `FR-R3-130`'s subject. This
// file's figures are recorded in
// `docs/operations/concurrent-run-isolation-measurement.md`; this file is what
// keeps them from going stale.
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

const git = promisify(execFile);

/** The concurrency levels the item names. 1 is the control, not a data point. */
const LEVELS = [1, 2, 4, 8] as const;

/**
 * Two write patterns, which are the two things that can happen in one tree.
 *
 *  - `disjoint`     — every Run declares and writes only its own paths.
 *  - `overlapping`  — every Run additionally writes one shared path. This is the
 *                     semantic conflict, in its simplest true form.
 */
type Pattern = 'disjoint' | 'overlapping';

interface Outcome {
  readonly runId: string;
  /** `sole-run` | `scoped` | `no-sibling-work-present`, or a decline reason. */
  readonly result: string;
  readonly wrotePatch: boolean;
}

interface LevelResult {
  readonly level: number;
  readonly pattern: Pattern;
  readonly outcomes: readonly Outcome[];
  readonly heapDeltaBytes: number;
  readonly elapsedMs: number;
}

let storageRoot: string;
let workspaceRoot: string;
let logger: SanitizedLogger;

/**
 * A fresh repository and a fresh checkpoint store, per measurement.
 *
 * The first version reset and cleaned one reused fixture between levels. Two
 * reasons that was wrong and both are worth naming: those are tree-destroying git
 * commands, and a test has no business running them even inside a temporary
 * directory it made — the constitution's forbidden list exists so that shape never
 * becomes normal. And a reused tree carries the previous level's baseline into the
 * next one, which is precisely the state this measurement reads.
 */
async function freshFixture(): Promise<void> {
  await fs.rm(storageRoot, { recursive: true, force: true });
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-sweep-store-'));
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-sweep-work-'));
  await git('git', ['init', '-q'], { cwd: workspaceRoot });
  await git('git', ['config', 'user.email', 'test@example.com'], { cwd: workspaceRoot });
  await git('git', ['config', 'user.name', 'Test'], { cwd: workspaceRoot });
  await git('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: workspaceRoot });
}

function runFixture(id: string, startedAt: number): WorkflowRun {
  return {
    id,
    featureId: `feat-${id}`,
    featureDir: `specs/001-${id}`,
    status: 'running',
    currentPhase: 'speckit-implement',
    currentIteration: 0,
    startedAt,
    lastTransitionAt: startedAt,
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
}

beforeEach(async () => {
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-sweep-store-'));
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-sweep-work-'));
  await git('git', ['init', '-q'], { cwd: workspaceRoot });
  await git('git', ['config', 'user.email', 'test@example.com'], { cwd: workspaceRoot });
  await git('git', ['config', 'user.name', 'Test'], { cwd: workspaceRoot });
  await git('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: workspaceRoot });
  logger = { warn: () => {} } as unknown as SanitizedLogger;
});

afterEach(async () => {
  await fs.rm(storageRoot, { recursive: true, force: true });
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

/** What landed on disk for one Run: the patch, or the marker's reason. */
async function outcomeFor(runId: string): Promise<Outcome> {
  const runRoot = path.join(storageRoot, 'checkpoints', runId);
  let files: string[];
  try {
    files = (await fs.readdir(runRoot)).sort();
  } catch {
    return { runId, result: 'no-artifact', wrotePatch: false };
  }
  const patch = files.find((name) => name.endsWith('.patch'));
  if (patch !== undefined) {
    const manifest = files.find((name) => name.endsWith('.json') && !name.endsWith('.declined.json'));
    if (manifest === undefined) return { runId, result: 'patch-without-manifest', wrotePatch: true };
    const body = JSON.parse(await fs.readFile(path.join(runRoot, manifest), 'utf8')) as {
      attribution?: { mode?: string };
    };
    return { runId, result: body.attribution?.mode ?? 'unknown-mode', wrotePatch: true };
  }
  const declined = files.find((name) => name.endsWith('.declined.json'));
  if (declined === undefined) return { runId, result: 'no-artifact', wrotePatch: false };
  const body = JSON.parse(await fs.readFile(path.join(runRoot, declined), 'utf8')) as {
    reason?: string;
  };
  return { runId, result: body.reason ?? 'unknown-reason', wrotePatch: false };
}

/**
 * One measurement: N Runs, overlapping windows, one checkpoint each.
 *
 * The order below is the whole fixture. Every window opens before any Run writes,
 * and every window closes after all of them have — which is what real concurrency
 * looks like and is why the DECLARATION and not the window is what attributes.
 */
async function measure(level: number, pattern: Pattern): Promise<LevelResult> {
  const ids = Array.from({ length: level }, (_, index) => `run-${index + 1}`);

  const ledger = new RunMutationLedger({
    readDiff: async () =>
      (await git('git', ['diff', '--binary', '--no-ext-diff', 'HEAD'], { cwd: workspaceRoot }))
        .stdout,
    listInFlightRunIds: () => ids,
    workspaceRoot
  });
  // After the ledger exists, so `observedFromStart` is true: a Run that began
  // before the ledger did has writes no ledger saw, and its evidence is
  // deliberately incomplete. That case is asserted separately below.
  const runs = ids.map((id) => runFixture(id, Date.now()));

  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();

  for (const run of runs) await ledger.observeBeforePhase(run);

  for (const run of runs) {
    await fs.writeFile(path.join(workspaceRoot, `${run.id}.txt`), `written by ${run.id}\n`);
    if (pattern === 'overlapping') {
      await fs.appendFile(path.join(workspaceRoot, 'shared.txt'), `touched by ${run.id}\n`);
    }
  }
  // Staged so `git diff HEAD` reports them: an untracked file is invisible to it,
  // which would make every level report an empty tree.
  await git('git', ['add', '-A'], { cwd: workspaceRoot });

  for (const run of runs) {
    const declaredPaths =
      pattern === 'overlapping' ? [`${run.id}.txt`, 'shared.txt'] : [`${run.id}.txt`];
    await ledger.observeAfterPhase(run, { declaredPaths });
  }

  const service = new RunCheckpointService(
    storageRoot,
    workspaceRoot,
    logger,
    () => level,
    ledger
  );
  for (const run of runs) await service.checkpoint(run, 'speckit-implement');

  const elapsedMs = performance.now() - startedAt;
  const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;

  const outcomes: Outcome[] = [];
  for (const id of ids) outcomes.push(await outcomeFor(id));
  return { level, pattern, outcomes, heapDeltaBytes, elapsedMs };
}

function distribution(outcomes: readonly Outcome[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) counts[outcome.result] = (counts[outcome.result] ?? 0) + 1;
  return counts;
}

function report(results: readonly LevelResult[]): void {
  const lines = results.map((result) => {
    const counts = Object.entries(distribution(result.outcomes))
      .map(([name, count]) => `${name}=${count}`)
      .sort()
      .join(' ');
    const declined = result.outcomes.filter((o) => !o.wrotePatch).length;
    return (
      `  N=${String(result.level).padStart(2)} ${result.pattern.padEnd(11)} ` +
      `declined=${declined}/${result.outcomes.length} ` +
      `heapDelta=${(result.heapDeltaBytes / 1024 / 1024).toFixed(2)}MiB ` +
      `elapsed=${result.elapsedMs.toFixed(0)}ms  ${counts}`
    );
  });
  // The figures are the deliverable; they are transcribed into
  // docs/operations/concurrent-run-isolation-measurement.md.
  console.log(
    ['[FR-R3-124] attribution outcome sweep (heap/elapsed are OBSERVATIONS, not budgets):', ...lines].join('\n')
  );
}

describe('FR-R3-124 — attribution at concurrency 1/2/4/8', () => {
  it('measures both write patterns at every level and reports the distribution', async () => {
    const results: LevelResult[] = [];
    for (const level of LEVELS) {
      results.push(await measure(level, 'disjoint'));
      await freshFixture();
      results.push(await measure(level, 'overlapping'));
      await freshFixture();
    }
    report(results);

    // Vacuity control: eight measurements, each with its level's worth of
    // outcomes. A loop that measured nothing would satisfy every assertion below.
    expect(results).toHaveLength(8);
    expect(results.reduce((total, r) => total + r.outcomes.length, 0)).toBe(2 * (1 + 2 + 4 + 8));
    expect(results.every((r) => r.outcomes.every((o) => o.result !== 'no-artifact'))).toBe(true);
  });

  it('at concurrency 1 the whole-tree diff is written and the ledger is not consulted', async () => {
    // The control, and `FR-R3-004`'s cap-1 invariant: both patterns must produce
    // the sole-run mode, because at one in-flight Run there is no sibling for an
    // overlapping write to contest with.
    for (const pattern of ['disjoint', 'overlapping'] as const) {
      const result = await measure(1, pattern);
      expect(distribution(result.outcomes), `pattern=${pattern}`).toEqual({ 'sole-run': 1 });
      await freshFixture();
    }
  });

  it('with disjoint declarations every Run gets its own scoped patch, at every level', async () => {
    // This is the machinery working, and it is worth stating plainly: disjoint
    // concurrent work is attributable at 8 Runs exactly as it is at 2. The
    // architectural objection is not that attribution is unreliable.
    for (const level of [2, 4, 8] as const) {
      const result = await measure(level, 'disjoint');
      expect(distribution(result.outcomes), `N=${level}`).toEqual({ scoped: level });
      expect(result.outcomes.every((o) => o.wrotePatch)).toBe(true);
      await freshFixture();
    }
  });

  it('one shared path costs every Run its checkpoint, at every level', async () => {
    // THE FINDING. A single contested path is not a partial loss: `decide()`
    // declines for EVERY Run that declared it, so at N Runs sharing one file the
    // operator gets N declines and zero recovery patches. That is the correct
    // behaviour — an unattributable patch is worse than none — and it is also
    // precisely what "attribution is not isolation" means in outcomes rather
    // than in the abstract.
    for (const level of [2, 4, 8] as const) {
      const result = await measure(level, 'overlapping');
      expect(distribution(result.outcomes), `N=${level}`).toEqual({
        'path-mutated-by-multiple-runs': level
      });
      expect(result.outcomes.every((o) => o.wrotePatch)).toBe(false);
      await freshFixture();
    }
  });
});
