// Feature 093 (T057-T068a, US1) — two Runs executing at once in one window.
//
// This is the file the whole feature is for. Every other test in the suite
// asserts that a *reshaped* seam still behaves; this one asserts the behavior
// that could not exist before the reshape, and it is the only place where the
// two-Runs-in-one-window condition is actually constructed.
//
// **Determinism (T057, research R10).** The host is single-threaded, so the
// interleavings of two Runs are enumerable and reproducible — but only if the
// test chooses them. Every CLI invocation therefore parks at a gate and waits
// for the test to step it; `step(runId)` releases exactly one parked
// invocation. That makes "step Run A to an await point, advance Run B, resume
// A" a literal sequence of statements rather than a hope about scheduling.
// There is **no** `setTimeout`-based sleep anywhere here, and no assertion
// depends on one Run being faster than another: a sleep-calibrated concurrency
// test passes on an idle laptop and flakes under full-suite CPU contention,
// which is the worst possible failure mode for a suite whose whole subject is
// interleaving. `drainUntil` below is a bounded microtask pump, not a sleep —
// it advances the loop until a stated condition holds and fails by *naming what
// it waited for* rather than hanging.
//
// **Why the drain is not the entry point.** Drain step 4b still refuses a
// second start until T081 deletes it, so a test driven through `drainAll()`
// would pass vacuously — one Run, no interleaving, no claim made. These tests
// enter at `controller.admitNew()`, which is the seam T049a split out precisely
// so admission and completion stopped being the same event. When T081 lands,
// the drain reaches this same seam and these tests keep their meaning unchanged.
//
// **Scope.** Runs, not the cap. The concurrency cap becoming a real ceiling is
// User Story 3 (Phase 5) and has its own file; here the cap is set high enough
// to be irrelevant so that a failure means "two Runs cannot execute", never
// "the cap refused the second one".

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unfencedCommit } from '../../src/state/ownership-claim';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  FakeMemento,
  QUEUE_A,
  QUEUE_B,
  drainUntil,
  fatalOutput,
  cleanOutput,
  initGitRepo,
  makeHarness,
  noopScheduler,
  rateLimitedOutput,
  removeWorkspace,
  type AdmittedRun,
  type Harness
} from './concurrent-run-harness';
import { ExecutionLeaseManager } from '../../src/state/execution-lease';
import { WorkspaceLockManager, STALENESS_THRESHOLD_MS } from '../../src/state/lock';
import { createDiskOwnershipFs } from '../../src/state/ownership-fs';
import { WorkspaceStateStore } from '../../src/state/workspace-state';
import { runCancel } from '../../src/commands/cancel';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import type { Notifier } from '../../src/ui/notifications';
import { RETRY_BUFFER_MS } from '../../src/controller/retry-constants';
import { isTerminalRunStatus, type WorkflowRun } from '../../src/state/workflow-run';

let tmpRoot: string;
let h: Harness;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-concurrent-runs-'));
  await initGitRepo(tmpRoot);
  // High enough that the cap is never the reason a start is refused. The cap as
  // a real ceiling is US3's subject, in `concurrency-cap.test.ts`.
  h = await makeHarness(tmpRoot, { concurrencyCap: 5, queues: [QUEUE_B] });
});

afterEach(async () => {
  // Most of these tests end with Runs still mid-flight, by design — the
  // assertion is about two Runs executing, so of course they are. Quiesce before
  // deleting the workspace: `completed` settles at each Run's terminal
  // transition or at its pause, and either way `driveSession`'s `finally` has
  // disposed the session by then.
  await h.quiesce();
  await removeWorkspace(tmpRoot);
});

const runToTerminal = (queueId: string, runId: string): Promise<WorkflowRun> =>
  h.runToTerminal(queueId, runId);

/** Both queues admitted and both parked in their first phase. */
async function bothExecuting(): Promise<{ a: AdmittedRun; b: AdmittedRun }> {
  const a = await h.admit(QUEUE_A, 'work on queue A');
  const b = await h.admit(QUEUE_B, 'work on queue B');
  await h.atGate(a.runId);
  await h.atGate(b.runId);
  return { a, b };
}

async function readAuditLines(): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(path.join(tmpRoot, '.schegent', 'audit.log'), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('Feature 093 (T057) — the interleaving is chosen, not raced', () => {
  it('steps Run A to an await point, advances Run B, then resumes A', async () => {
    const { a, b } = await bothExecuting();

    // Both are suspended inside their first CLI call. Neither has advanced, and
    // neither can advance until this test says so — that is the whole mechanism.
    expect(h.parkedFor(a.runId)).toBe(1);
    expect(h.parkedFor(b.runId)).toBe(1);
    expect(h.invocations.map((inv) => inv.runId).sort()).toEqual([a.runId, b.runId].sort());

    // Advance B past A while A is held. B's second invocation must appear
    // before A's second one, which is an ordering no scheduler chose.
    h.step(b.runId);
    await drainUntil(
      () => h.invocations.filter((inv) => inv.runId === b.runId).length === 2,
      "run B's second phase to dispatch"
    );
    expect(h.invocations.filter((inv) => inv.runId === a.runId)).toHaveLength(1);

    // Now resume A. It picks up exactly where it parked, having lost nothing to
    // B's progress.
    h.step(a.runId);
    await drainUntil(
      () => h.invocations.filter((inv) => inv.runId === a.runId).length === 2,
      "run A's second phase to dispatch"
    );

    const order = h.invocations.map((inv) => inv.runId);
    expect(order.slice(0, 2).sort()).toEqual([a.runId, b.runId].sort());
    expect(order[2]).toBe(b.runId);
    expect(order[3]).toBe(a.runId);
  });
});

describe('Feature 093 (T058, SC-001) — two queues execute at the same time', () => {
  it('both queues start and are simultaneously executing', async () => {
    const { a, b } = await bothExecuting();

    // Simultaneity, stated four ways, because each one is a different thing
    // that could have collapsed to a single Run.
    expect(h.runKeys()).toEqual([QUEUE_A, QUEUE_B].sort());
    expect(h.store.getRun(QUEUE_A)?.status).toBe('running');
    expect(h.store.getRun(QUEUE_B)?.status).toBe('running');
    expect(h.store.getRun(QUEUE_A)?.id).toBe(a.runId);
    expect(h.store.getRun(QUEUE_B)?.id).toBe(b.runId);
    expect(a.runId).not.toBe(b.runId);

    // Each queue promoted exactly one Task, and both are in flight at once —
    // the per-queue sequential invariant and the cross-queue concurrency claim
    // holding together.
    expect(h.queue.inFlightCount(QUEUE_A)).toBe(1);
    expect(h.queue.inFlightCount(QUEUE_B)).toBe(1);
    expect(h.queue.findById(a.feature.id)?.status).toBe('in-flight');
    expect(h.queue.findById(b.feature.id)?.status).toBe('in-flight');

    // And both are genuinely inside a CLI call, not merely marked as started.
    expect(h.parkedFor(a.runId)).toBe(1);
    expect(h.parkedFor(b.runId)).toBe(1);
    expect(h.controller.running).toBe(true);
  });
});

describe('Feature 093 (T059, US1 scenario 2) — one Run ending leaves the other untouched', () => {
  it('the second Run continues and its record is unchanged', async () => {
    const { a, b } = await bothExecuting();
    const before = structuredClone(h.store.getRun(QUEUE_B)!);

    const finishedA = await runToTerminal(QUEUE_A, a.runId);
    expect(finishedA.status).toBe('completed');

    // B is byte-for-byte what it was. Not merely "still running": a terminal
    // transition that resolved the wrong queue would rewrite this record while
    // leaving its status alone.
    expect(h.store.getRun(QUEUE_B)).toEqual(before);
    expect(h.store.getRun(QUEUE_B)?.status).toBe('running');
    expect(h.queue.findById(b.feature.id)?.status).toBe('in-flight');
    expect(h.controller.running).toBe(true);

    // And it still finishes on its own terms afterwards.
    const finishedB = await runToTerminal(QUEUE_B, b.runId);
    expect(finishedB.status).toBe('completed');
    expect(finishedB.id).toBe(b.runId);
    expect(h.queue.findById(b.feature.id)?.status).toBe('completed');
  });
});

describe('Feature 093 (T060, SC-002) — nothing crosses between concurrent Runs', () => {
  it('no output, audit line, or transcript line is attributed to the wrong Run', async () => {
    const { a, b } = await bothExecuting();
    h.openGate();
    await Promise.all([a.completed, b.completed]);
    await drainUntil(
      () =>
        isTerminalRunStatus(h.store.getRun(QUEUE_A)?.status ?? 'running') &&
        isTerminalRunStatus(h.store.getRun(QUEUE_B)?.status ?? 'running'),
      'both runs to reach a terminal status'
    );

    // Phase output: each Run banked its own phases and no more. A shared
    // sequencer would have one Run's `phasesCompleted` carrying the other's.
    const runA = h.store.getRun(QUEUE_A)!;
    const runB = h.store.getRun(QUEUE_B)!;
    const phasesOf = (run: WorkflowRun): string[] => run.phasesCompleted.map((p) => p.phase);
    expect(phasesOf(runA).length).toBeGreaterThan(1);
    expect(phasesOf(runB).length).toBeGreaterThan(1);
    expect(phasesOf(runA)).toEqual((runA.pipeline?.phases ?? []).map((p) => p.id).slice(0, phasesOf(runA).length));

    // Audit lines: every run-scoped line names one of the two Runs, and each
    // Run's lines are a partition — no line appears under both.
    const lines = await readAuditLines();
    const withRun = lines.filter((line) => typeof line.runId === 'string' && line.runId !== '');
    expect(withRun.length).toBeGreaterThan(0);
    const foreign = withRun.filter((line) => line.runId !== a.runId && line.runId !== b.runId);
    expect(foreign).toEqual([]);
    expect(withRun.some((line) => line.runId === a.runId)).toBe(true);
    expect(withRun.some((line) => line.runId === b.runId)).toBe(true);

    // Raw transcripts: one file per Run, and neither names the other's Run id.
    const sessions = path.join(tmpRoot, '.schegent', 'sessions');
    const transcriptA = await fs.readFile(path.join(sessions, `raw-${a.runId}.log`), 'utf8');
    const transcriptB = await fs.readFile(path.join(sessions, `raw-${b.runId}.log`), 'utf8');
    expect(transcriptA).toContain(a.runId);
    expect(transcriptA).not.toContain(b.runId);
    expect(transcriptB).toContain(b.runId);
    expect(transcriptB).not.toContain(a.runId);
  });
});

describe('Feature 093 (T061, G-3) — interleaved whole-map writes preserve both entries', () => {
  it('two concurrent single-queue writes both survive', async () => {
    const { a, b } = await bothExecuting();

    // The read-modify-write hazard the per-queue record introduces: each write
    // reads the whole map, replaces one key, and writes the map back. Issued
    // without an intervening await, a lost update drops whichever entry the
    // second write's snapshot predated.
    const nextA = { ...h.store.getRun(QUEUE_A)!, currentIteration: 41 };
    const nextB = { ...h.store.getRun(QUEUE_B)!, currentIteration: 42 };
    await Promise.all([h.store.setRun(QUEUE_A, nextA, unfencedCommit('test-fixture')), h.store.setRun(QUEUE_B, nextB, unfencedCommit('test-fixture'))]);

    expect(h.runKeys()).toEqual([QUEUE_A, QUEUE_B].sort());
    expect(h.store.getRun(QUEUE_A)?.currentIteration).toBe(41);
    expect(h.store.getRun(QUEUE_B)?.currentIteration).toBe(42);
    expect(h.store.getRun(QUEUE_A)?.id).toBe(a.runId);
    expect(h.store.getRun(QUEUE_B)?.id).toBe(b.runId);

    // The reverse issue order must hold too — a guarantee that only worked one
    // way round would be an ordering coincidence.
    await Promise.all([
      h.store.setRun(QUEUE_B, { ...nextB, currentIteration: 52 }, unfencedCommit('test-fixture')),
      h.store.setRun(QUEUE_A, { ...nextA, currentIteration: 51 }, unfencedCommit('test-fixture'))
    ]);
    expect(h.store.getRun(QUEUE_A)?.currentIteration).toBe(51);
    expect(h.store.getRun(QUEUE_B)?.currentIteration).toBe(52);
  });
});

describe('Feature 093 (T062, FR-021) — shared sinks keep per-Run order and exact attribution', () => {
  it('per-Run ordering is preserved while cross-Run interleaving is permitted', async () => {
    const { a, b } = await bothExecuting();

    // Force interleaving at the sink by alternating the two Runs phase by
    // phase. Both append to the one `audit.log`, in an order neither controls.
    for (let round = 0; round < 3; round++) {
      if (h.parkedFor(a.runId) > 0) h.step(a.runId);
      await drainUntil(() => h.parkedFor(b.runId) > 0 || h.parkedFor(a.runId) > 0, 'a gate to refill');
      if (h.parkedFor(b.runId) > 0) h.step(b.runId);
      await drainUntil(() => h.parkedFor(a.runId) > 0 || h.parkedFor(b.runId) > 0, 'a gate to refill');
    }
    h.openGate();
    await Promise.all([a.completed, b.completed]);

    const lines = await readAuditLines();
    const runScoped = lines.filter((line) => line.runId === a.runId || line.runId === b.runId);
    expect(runScoped.length).toBeGreaterThan(2);

    // Attribution is exact: no third id, and no line without one.
    expect(runScoped.every((line) => typeof line.runId === 'string')).toBe(true);

    // Ordering, per Run: each Run's own subsequence of the shared file is
    // non-decreasing in phase index. This is the half FR-021 requires.
    const indexOfPhase = (run: WorkflowRun, phase: unknown): number =>
      (run.pipeline?.phases ?? []).findIndex((p) => p.id === phase);
    for (const [runId, queueId] of [
      [a.runId, QUEUE_A],
      [b.runId, QUEUE_B]
    ] as const) {
      const run = h.store.getRun(queueId)!;
      const indices = runScoped
        .filter((line) => line.runId === runId)
        .map((line) => indexOfPhase(run, line.phase))
        .filter((index) => index >= 0);
      expect(indices.length).toBeGreaterThan(1);
      expect([...indices].sort((x, y) => x - y)).toEqual(indices);
    }

    // Interleaving, across Runs: the file is not two contiguous blocks. This is
    // the half FR-021 *permits*, and asserting it stops a future change from
    // "fixing" ordering by serializing the two Runs onto the sink.
    const attributed = runScoped.map((line) => line.runId);
    const switches = attributed.filter((id, i) => i > 0 && id !== attributed[i - 1]).length;
    expect(switches).toBeGreaterThan(1);
  });
});

describe('Feature 093 (T063, FR-010) — a failing Run is a bulkhead, not a blast radius', () => {
  it("one Run's failure disposes only its own session", async () => {
    const { a, b } = await bothExecuting();
    h.script((req) => (req.runId === a.runId ? fatalOutput() : cleanOutput(req.phase)));

    h.step(a.runId);
    await drainUntil(
      () => isTerminalRunStatus(h.store.getRun(QUEUE_A)?.status ?? 'running'),
      'run A to fail'
    );

    expect(h.store.getRun(QUEUE_A)?.status).toBe('failed');
    // B did not notice. Its record, its Task, and its session all stand.
    expect(h.store.getRun(QUEUE_B)?.status).toBe('running');
    expect(h.store.getRun(QUEUE_B)?.id).toBe(b.runId);
    expect(h.queue.findById(b.feature.id)?.status).toBe('in-flight');
    expect(h.controller.running).toBe(true);

    // B still advances afterwards — a dead sibling did not take the driver, the
    // gate, or the record with it.
    const finishedB = await runToTerminal(QUEUE_B, b.runId);
    expect(finishedB.status).toBe('completed');

    // With both Runs ended, no session survives either: disposal is per Run,
    // and "only its own" cuts both ways.
    await drainUntil(() => h.controller.running === false, 'every session to be disposed');
  });
});

describe('Feature 093 (T064, SC-013) — no Run waits on another', () => {
  it('a Run advances to completion while a sibling is held mid-phase', async () => {
    const { a, b } = await bothExecuting();

    // A is parked and never stepped. If any part of B's advance were gated on
    // A — a shared driver, a shared gate, a workspace-wide lock around a drive
    // — B could not get past its first phase, and this would time out naming
    // what it waited for.
    const finishedB = await runToTerminal(QUEUE_B, b.runId);
    expect(finishedB.status).toBe('completed');

    // A is exactly where it was left: still running, still parked, nothing
    // about B's terminal transition having touched it.
    expect(h.store.getRun(QUEUE_A)?.status).toBe('running');
    expect(h.parkedFor(a.runId)).toBe(1);
    expect(h.invocations.filter((inv) => inv.runId === a.runId)).toHaveLength(1);

    // And A resumes normally once released, from its own phase position.
    const finishedA = await runToTerminal(QUEUE_A, a.runId);
    expect(finishedA.status).toBe('completed');
    expect(finishedA.phasesCompleted.length).toBe(finishedB.phasesCompleted.length);
  });

  it('a paused Run does not stall its sibling', async () => {
    const { a, b } = await bothExecuting();

    const paused = await h.controller.pauseActivePhase(QUEUE_A);
    expect(paused.ok).toBe(true);

    const finishedB = await runToTerminal(QUEUE_B, b.runId);
    expect(finishedB.status).toBe('completed');
    expect(h.store.getRun(QUEUE_A)?.id).toBe(a.runId);
  });
});

describe('Feature 093 (T065, SC-014) — rate-limit backoff stays a per-Run computation', () => {
  it('each rate-limited Run computes the backoff a solo Run would', async () => {
    const { a, b } = await bothExecuting();

    // One reported reset, both Runs. A shared gate would make the second Run's
    // wait a function of the first's — the failure this asserts against.
    const resetsAtSec = Math.floor(Date.now() / 1000) + 900;
    const resetsAtMs = resetsAtSec * 1000;
    h.script(() => rateLimitedOutput(resetsAtSec));

    h.step(a.runId);
    h.step(b.runId);
    await drainUntil(
      () =>
        h.store.getRun(QUEUE_A)?.pendingRetryAt != null &&
        h.store.getRun(QUEUE_B)?.pendingRetryAt != null,
      'both runs to arm a delayed retry'
    );

    const runA = h.store.getRun(QUEUE_A)!;
    const runB = h.store.getRun(QUEUE_B)!;
    expect(runA.pendingRetryCause).toBe('rate_limit');
    expect(runB.pendingRetryCause).toBe('rate_limit');

    // The solo answer for this reset is `resetsAtMs + RETRY_BUFFER_MS`, because
    // the delay is measured from now and then added back to now. Both Runs land
    // on it, and therefore on each other.
    const expected = resetsAtMs + RETRY_BUFFER_MS;
    expect(Math.abs(runA.pendingRetryAt! - expected)).toBeLessThan(5_000);
    expect(Math.abs(runB.pendingRetryAt! - expected)).toBeLessThan(5_000);
    expect(Math.abs(runA.pendingRetryAt! - runB.pendingRetryAt!)).toBeLessThan(5_000);

    // Neither waited for the other: each armed its own retry, and the counts
    // are per Run rather than a shared tally.
    expect(runA.delayedRetryCount).toBe(runB.delayedRetryCount);
    expect(runA.delayedRetryCount).toBeGreaterThan(0);
  });
});

describe('Feature 093 (T066, SC-015) — an unattributable snapshot is still declined', () => {
  it('records the reason and writes nothing an operator could restore', async () => {
    const { a } = await bothExecuting();

    // FR-R3-004 replaced the condition this test was originally written against.
    // A second live Run no longer makes a checkpoint impossible — each Run's
    // audit record declares the files it wrote, and the patch is scoped to that
    // declaration — so `concurrent-runs-share-one-worktree` is now a historical
    // reason nothing emits. SC-015 itself is unchanged, and is what this asserts:
    // a snapshot that cannot be attributed to one Run is declined, with a reason
    // recorded, and no `.patch` an operator could apply.
    //
    // The condition that produces one now is a change in the tree no Run claims.
    // Neither Run here declares anything (`cleanStdout` reports empty `files_*`
    // lists), so a staged edit belongs to nobody — which is exactly the hand edit
    // an operator makes while runs are live. Staged rather than merely written,
    // because `git diff HEAD` does not see an untracked file.
    await fs.writeFile(path.join(tmpRoot, 'stray.txt'), 'nobody declared this\n');
    await promisify(execFile)('git', ['add', 'stray.txt'], { cwd: tmpRoot });

    const runRoot = path.join(tmpRoot, '.checkpoint-storage', 'checkpoints', a.runId);
    // Measured as a delta, because Run A's first Git-capable phase may have run
    // while it was the only Run in flight and legitimately snapshotted — that
    // patch is restorable and SC-015 does not forbid it. What SC-015 forbids is a
    // patch whose partition is undecidable, so the assertion is about what this
    // next call adds, not about what the directory holds.
    //
    // Feature 098 T017 — "may have" rather than "did". The driver gates a
    // checkpoint on the phase's declared `sideEffects`, and the built-in rows
    // driving this fixture declare nothing, so they now freeze `workspace` and
    // Run A reaches no Git-capable phase at all. That makes the directory absent
    // rather than merely empty, which is a distinction with no bearing on the
    // claim: the delta is measured off whatever is already there, up to and
    // including nothing.
    const before = new Set(await fs.readdir(runRoot).catch(() => []));

    // The probe is the production one, reading the real record: two Runs are
    // genuinely in flight, so this is the count the service sees in the field.
    const run = h.store.getRun(QUEUE_A)!;
    await h.checkpoints.checkpoint(run, 'speckit-implement');

    const added = (await fs.readdir(runRoot)).filter((name) => !before.has(name));
    expect(added.filter((name) => name.endsWith('.patch'))).toHaveLength(0);

    const marker = added.find((name) => name.endsWith('.declined.json'));
    expect(marker).toBeDefined();
    const recorded = JSON.parse(await fs.readFile(path.join(runRoot, marker!), 'utf8'));
    expect(recorded).toMatchObject({
      runId: a.runId,
      reason: 'unattributed-worktree-change',
      inFlightRuns: 2,
      restorable: false
    });
    // The paths live in the marker, which is 0600 beside the checkpoints; the
    // runtime-log warning that accompanies it carries counts only.
    expect(recorded.detail.paths).toEqual(['stray.txt']);

    // Declining is not failing: the Git-capable phase it guards still proceeds.
    await expect(h.checkpoints.checkpoint(run, 'speckit-implement')).resolves.toBeUndefined();
  });
});

describe('Feature 093 (T067) — closing the window strands no queue', () => {
  it('releases every execution lease and leaves both records addressable', async () => {
    const { a, b } = await bothExecuting();

    expect((await h.lease.tryAcquire(QUEUE_A)).acquired).toBe(true);
    expect((await h.lease.tryAcquire(QUEUE_B)).acquired).toBe(true);
    expect([...h.lease.heldQueueIds()].sort()).toEqual([QUEUE_A, QUEUE_B].sort());

    // What `dispose()` does at window close.
    await h.lease.releaseAll();
    expect(h.lease.heldQueueIds()).toEqual([]);

    // A fresh window takes both queues immediately — neither is stranded behind
    // a lease with no process behind it.
    const nextWindow = new ExecutionLeaseManager(h.store, 'window-b', h.lockClock, noopScheduler);
    expect((await nextWindow.tryAcquire(QUEUE_A)).acquired).toBe(true);
    expect((await nextWindow.tryAcquire(QUEUE_B)).acquired).toBe(true);
    await nextWindow.releaseAll();

    // Both Run records survive the close, separately addressable, so recovery
    // sees two Runs rather than whichever one wrote last.
    expect(h.runKeys()).toEqual([QUEUE_A, QUEUE_B].sort());
    expect(h.store.getRun(QUEUE_A)?.id).toBe(a.runId);
    expect(h.store.getRun(QUEUE_B)?.id).toBe(b.runId);
  });

  it('makes every lease reclaimable when the window dies without releasing', async () => {
    await bothExecuting();
    await h.lease.tryAcquire(QUEUE_A);
    await h.lease.tryAcquire(QUEUE_B);

    // No `releaseAll` — the window is gone. Every lease must age out, not just
    // the first: a per-queue staleness that only reclaimed one would leave the
    // other queue permanently unrunnable.
    const survivor = new ExecutionLeaseManager(h.store, 'window-b', h.lockClock, noopScheduler);
    expect((await survivor.tryAcquire(QUEUE_A)).acquired).toBe(false);

    h.lockClock.advance(STALENESS_THRESHOLD_MS + 1);
    expect((await survivor.tryAcquire(QUEUE_A)).acquired).toBe(true);
    expect((await survivor.tryAcquire(QUEUE_B)).acquired).toBe(true);
  });
});

describe('Feature 093 (T068) — deleting a queue mid-Run orphans nothing', () => {
  it('refuses the deletion and leaves both Runs intact', async () => {
    const { a, b } = await bothExecuting();

    const result = await h.queue.deleteQueue(QUEUE_B);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('queue-has-in-flight-task');

    // The queue, its Run, and its Task are all still there — a refusal that
    // half-applied would be the silent orphan this guards against.
    expect(h.store.getQueueRegistry().entries.some((entry) => entry.id === QUEUE_B)).toBe(true);
    expect(h.store.getRun(QUEUE_B)?.id).toBe(b.runId);
    expect(h.queue.findById(b.feature.id)?.status).toBe('in-flight');

    // And queue A never noticed.
    expect(h.store.getRun(QUEUE_A)?.id).toBe(a.runId);
    expect(h.store.getRun(QUEUE_A)?.status).toBe('running');
    const finishedA = await runToTerminal(QUEUE_A, a.runId);
    expect(finishedA.status).toBe('completed');

    // Once B's Run ends the queue becomes deletable, so the refusal was about
    // the in-flight Task and not a permanent state the Run left behind.
    await runToTerminal(QUEUE_B, b.runId);
    const after = await h.queue.deleteQueue(QUEUE_B);
    expect(after.ok).toBe(true);
  });
});

describe('Feature 093 (T068a, FR-028, SC-009) — window primacy outlives a single Run', () => {
  it('one Run terminating leaves the window primary and rivals refused', async () => {
    // Activation acquires primacy. Nothing in a Run's lifecycle acquires or
    // releases it — that is FR-032a, and this is the first condition in the
    // codebase that can tell the difference.
    expect((await h.lock.tryAcquire()).acquired).toBe(true);

    const rival = new WorkspaceLockManager(h.lockStore, 'window-b', h.lockClock, noopScheduler);
    expect((await rival.tryAcquire()).acquired).toBe(false);

    const { a, b } = await bothExecuting();

    const finishedA = await runToTerminal(QUEUE_A, a.runId);
    expect(finishedA.status).toBe('completed');

    // The assertion the removed `withLock('drive-run', …)` wrapper failed: its
    // `finally` released a window-scoped lease at a Run-scoped moment, so the
    // first Run to finish dropped primacy for the window and for its sibling.
    expect(h.lock.isHeld()).toBe(true);
    expect(h.lock.ownerOfRecord()).toBe('window-a');
    expect((await rival.tryAcquire()).acquired).toBe(false);

    // Still primary with the second Run also done — tenure is the window's,
    // not the last Run's either.
    await runToTerminal(QUEUE_B, b.runId);
    expect(h.lock.isHeld()).toBe(true);
    expect((await rival.tryAcquire()).acquired).toBe(false);

    // It ends where FR-032a says it ends: at disposal.
    await h.lock.release();
    expect((await rival.tryAcquire()).acquired).toBe(true);
  });
});

describe('Feature 093 (T068c, FR-028, SC-009) — an operator ending one Run keeps primacy', () => {
  // T068a above covers the path a Run takes when nothing interrupts it. These
  // cover the paths an operator takes, which is where the remaining Run-scoped
  // releases were: 092's T136 removed `drive()`'s `withLock` wrapper on the
  // reasoning that primacy's tenure is the window's, but the same reasoning
  // condemned four more releases that were left standing — two in
  // `runCancel`, one in `deleteTask`, one in `handleUnexpectedStartFailure`.
  // Each fires on exactly one queue's Run while the window's other Runs are
  // mid-phase, and `WorkspaceLockManager.release()` keeps no reference count,
  // so any one of them handed the workspace to a rival window while this one
  // was still executing work.

  /** Primacy is held by this window and no rival can take it. */
  async function expectStillPrimary(rival: WorkspaceLockManager): Promise<void> {
    expect(h.lock.isHeld()).toBe(true);
    expect(h.lock.ownerOfRecord()).toBe('window-a');
    expect((await rival.tryAcquire()).acquired).toBe(false);
  }

  it('cancelling one queue s Run leaves the window primary and the sibling executing', async () => {
    expect((await h.lock.tryAcquire()).acquired).toBe(true);
    const rival = new WorkspaceLockManager(h.lockStore, 'window-b', h.lockClock, noopScheduler);

    const { a, b } = await bothExecuting();

    const result = await runCancel({
      controller: h.controller,
      store: h.store,
      queue: h.queue,
      audit: new AuditLogWriter({ workspaceRoot: tmpRoot }, h.logger),
      notifier: { info: () => {}, warn: () => {}, error: () => {} } as unknown as Notifier,
      logger: h.logger,
      taskId: a.feature.id
    });
    expect(result).toEqual({ ok: true });

    // The abort lands at the driver's phase-loop head, so A's parked
    // invocation has to be released before the loop comes round and sees it.
    h.step(a.runId);
    await drainUntil(
      () => h.store.getRun(QUEUE_A)?.status === 'canceled',
      () => `queue A s Run to reach canceled`
    );

    await expectStillPrimary(rival);

    // And the sibling is not merely un-cancelled — it can still finish, which
    // is the thing a lost primacy would have made unsafe.
    const finishedB = await runToTerminal(QUEUE_B, b.runId);
    expect(finishedB.status).toBe('completed');
    await expectStillPrimary(rival);

    // The assertions above are not vacuous: an explicit release flips every one
    // of them. That is precisely what a Run-scoped release did, one cancel
    // earlier, with B still parked mid-phase.
    await h.lock.release();
    expect(h.lock.isHeld()).toBe(false);
    expect((await rival.tryAcquire()).acquired).toBe(true);
  });

  it('deleting one queue s Task leaves the window primary and the sibling executing', async () => {
    expect((await h.lock.tryAcquire()).acquired).toBe(true);
    const rival = new WorkspaceLockManager(h.lockStore, 'window-b', h.lockClock, noopScheduler);

    const { a, b } = await bothExecuting();

    const deleted = await h.controller.deleteTask(a.feature.id);
    expect(deleted.ok).toBe(true);
    expect(h.store.getRun(QUEUE_A)?.status).toBe('canceled');

    await expectStillPrimary(rival);

    h.step(a.runId);
    const finishedB = await runToTerminal(QUEUE_B, b.runId);
    expect(finishedB.status).toBe('completed');
    await expectStillPrimary(rival);
  });

  it('one queue s Run failing unexpectedly leaves the window primary', async () => {
    expect((await h.lock.tryAcquire()).acquired).toBe(true);
    const rival = new WorkspaceLockManager(h.lockStore, 'window-b', h.lockClock, noopScheduler);

    const { a, b } = await bothExecuting();

    // Not a fatal CLI signature and not a non-zero exit — those are handled
    // failures with their own terminal path. This is the unhandled kind that
    // reaches `handleUnexpectedStartFailure`, which is where the fourth release
    // was.
    h.script((req) => {
      if (req.runId === a.runId) throw new Error('parser invariant exploded');
      return cleanOutput(req.phase);
    });
    h.step(a.runId);
    await drainUntil(
      () => isTerminalRunStatus(h.store.getRun(QUEUE_A)?.status ?? 'running'),
      () => `queue A s Run to reach a terminal status after an unexpected throw`
    );
    expect(h.store.getRun(QUEUE_A)?.status).toBe('failed');

    await expectStillPrimary(rival);

    const finishedB = await runToTerminal(QUEUE_B, b.runId);
    expect(finishedB.status).toBe('completed');
    await expectStillPrimary(rival);
  });
});

describe('Feature FR-R3-003 (T307, FR-028, SC-009) — the tenure holds under fencing', () => {
  // The blocks above build their rival as a second `WorkspaceLockManager` over
  // `h.lockStore` — one store, one memento, two managers. That was the strongest
  // rival available before this feature, and it is weaker than it looks: a
  // `Memento` is a per-extension-host cache, so two real windows never share the
  // record those tests share, and every refusal above was arbitrated by a
  // structure only one host can see. These re-assert the same property against a
  // rival that is a genuine second host — its own store over its own memento —
  // with nothing in common but the `.schegent/ownership` directory both are
  // pointed at. If the fenced mechanism arbitrated nothing, this rival would
  // acquire while queue B is still mid-phase.
  //
  // What fencing adds to SC-009 is that "still primary" becomes checkable rather
  // than inferable. A Run-scoped release followed by a re-acquire also ends with
  // the window holding primacy, and reads identical through `isHeld()` and
  // `ownerOfRecord()`; it differs only in the generation, and in the gap between
  // the two calls during which a rival could have taken the workspace. So the
  // assertion here is the *unchanged fence*, which no release-and-reacquire can
  // satisfy.

  interface RivalHost {
    readonly manager: WorkspaceLockManager;
    readonly store: WorkspaceStateStore;
  }

  const ownershipDir = (): string => path.join(tmpRoot, '.schegent', 'ownership');

  beforeEach(() => {
    // The seam activation stage 2 uses, pointed at the workspace this harness
    // already created. Managers read `store.ownership` per call, so `h.lock`
    // built in `makeHarness` lands on it too.
    h.lockStore.useOwnershipStorage(
      createDiskOwnershipFs({ workspaceRoot: tmpRoot, ownershipDir: ownershipDir() }),
      ownershipDir()
    );
  });

  /** A second extension host: its own memento, the same ownership directory. */
  async function rivalHost(): Promise<RivalHost> {
    const store = new WorkspaceStateStore(new FakeMemento());
    await store.initialize();
    store.useOwnershipStorage(
      createDiskOwnershipFs({ workspaceRoot: tmpRoot, ownershipDir: ownershipDir() }),
      ownershipDir()
    );
    return {
      manager: new WorkspaceLockManager(store, 'window-b', h.lockClock, noopScheduler),
      store
    };
  }

  async function expectFencedPrimacy(rival: RivalHost, fence: number): Promise<void> {
    expect(h.lock.isHeld()).toBe(true);
    expect(await h.lock.hasPrimacy()).toBe(true);
    expect(h.lock.fenceOfRecord()).toBe(fence);
    expect((await rival.manager.tryAcquire()).acquired).toBe(false);
  }

  it('holds one generation across both Runs reaching their terminal transition', async () => {
    expect((await h.lock.tryAcquire()).acquired).toBe(true);
    const fence = h.lock.fenceOfRecord();
    expect(fence).toBe(1);

    const rival = await rivalHost();
    expect(await rival.manager.tryAcquire()).toEqual({ acquired: false, ownerId: 'window-a' });
    // The rival's own mirror is empty and stays empty — it has never seen this
    // window's `KEYS.lock` and cannot. Its refusal came from the shared record,
    // which is the only thing a second host can read.
    expect(rival.store.getLock()).toBeNull();

    const { a, b } = await bothExecuting();
    expect((await runToTerminal(QUEUE_A, a.runId)).status).toBe('completed');
    await expectFencedPrimacy(rival, fence!);

    expect((await runToTerminal(QUEUE_B, b.runId)).status).toBe('completed');
    await expectFencedPrimacy(rival, fence!);

    // Disposal, and only disposal, ends it — and the rival's claim is issued at
    // the next generation, never at the one this window carried.
    await h.lock.release();
    expect(await h.lock.hasPrimacy()).toBe(false);
    expect((await rival.manager.tryAcquire()).acquired).toBe(true);
    expect(rival.manager.fenceOfRecord()).toBe(2);
  });

  it('holds one generation when an operator cancels one queue s Run', async () => {
    expect((await h.lock.tryAcquire()).acquired).toBe(true);
    const fence = h.lock.fenceOfRecord()!;
    const rival = await rivalHost();

    const { a, b } = await bothExecuting();
    const result = await runCancel({
      controller: h.controller,
      store: h.store,
      queue: h.queue,
      audit: new AuditLogWriter({ workspaceRoot: tmpRoot }, h.logger),
      notifier: { info: () => {}, warn: () => {}, error: () => {} } as unknown as Notifier,
      logger: h.logger,
      taskId: a.feature.id
    });
    expect(result).toEqual({ ok: true });

    h.step(a.runId);
    await drainUntil(
      () => h.store.getRun(QUEUE_A)?.status === 'canceled',
      () => `queue A s Run to reach canceled`
    );

    // `runCancel` was one of the four Run-scoped releases FR-028 condemned. A
    // release here would clear the fence outright; a release paired with a
    // re-acquire would bump it. Neither is what an unchanged generation looks
    // like.
    await expectFencedPrimacy(rival, fence);

    expect((await runToTerminal(QUEUE_B, b.runId)).status).toBe('completed');
    await expectFencedPrimacy(rival, fence);
  });

  it('shows the cost of a Run-scoped release: a second host takes the workspace', async () => {
    expect((await h.lock.tryAcquire()).acquired).toBe(true);
    const rival = await rivalHost();
    const { a, b } = await bothExecuting();
    await runToTerminal(QUEUE_A, a.runId);

    // Stand in for the release the removed `withLock('drive-run', …)` wrapper
    // performed in its `finally`, with queue B still mid-phase. The assertions
    // above are not vacuous: every one of them flips here.
    await h.lock.release();
    expect((await rival.manager.tryAcquire()).acquired).toBe(true);
    expect(h.lock.isHeld()).toBe(false);
    expect(await h.lock.hasPrimacy()).toBe(false);
    // And it is not recoverable by trying again. Under fencing the window does
    // not merely pause being primary — its generation is superseded, so the
    // token queue B's guarded writes carry is worthless from here.
    expect((await h.lock.tryAcquire()).acquired).toBe(false);
    expect(h.lock.fenceOfRecord()).toBeNull();

    // Queue B is still executing throughout, which is what makes it a defect
    // rather than an ordering detail.
    expect(isTerminalRunStatus(h.store.getRun(QUEUE_B)?.status ?? 'running')).toBe(false);
    await runToTerminal(QUEUE_B, b.runId);
  });
});
