import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BackendRunner, RunnerLabel } from '../../../src/contracts/backend-runner';
import { SanitizedLogger } from '../../../src/lib/logger';
import { AgyCliRunner } from '../../../src/runner/agy-cli';
import { ClaudeCliRunner, type SpawnFn } from '../../../src/runner/claude-cli';
import { CodexCliRunner } from '../../../src/runner/codex-cli';

/**
 * FR-R4-F06 (FR-020; T21; contract S, S1 and S2) -- a runner can be awaited.
 *
 * THE GAP. Every ladder was fired and forgotten: `terminate()` returned nothing, the timers are
 * `unref`'d, and `cancelActive()` returns a boolean. So shutdown could not wait for a tree to be
 * gone, and released ownership while a child was still being killed. `settleTeardowns()` resolves
 * to the outcome of every ladder the runner started and has not yet reported, including one a
 * timeout started before shutdown, and never rejects.
 *
 * ONE SUITE FOR THREE RUNNERS. Codex and Agy delegate to `ProcessLifecycleRunner`; Claude owns
 * its own copy of the ladder bookkeeping. The same cases run over all three, so a fourth that
 * forgot the method, or a delegate that dropped it, fails here by name.
 *
 * The child is a double and `process.kill` is stubbed, because this suite is about what the
 * runner reports. The real-process half is T14 and T23.
 */
const PID = 4242;
const RUN_ID = 'run-teardown';
const PHASE = 'speckit-implement';
const ITERATION = 3;

interface Subject {
  readonly name: string;
  readonly label: RunnerLabel;
  make(spawnFn: SpawnFn, logger: SanitizedLogger): BackendRunner;
}

const SUBJECTS: readonly Subject[] = [
  {
    name: 'ClaudeCliRunner',
    label: 'claude-cli',
    make: (spawnFn, logger) => new ClaudeCliRunner(spawnFn, null, undefined, logger)
  },
  {
    name: 'CodexCliRunner',
    label: 'codex-cli',
    make: (spawnFn, logger) => new CodexCliRunner(spawnFn, null, logger)
  },
  {
    name: 'AgyCliRunner',
    label: 'agy-cli',
    make: (spawnFn, logger) => new AgyCliRunner(spawnFn, null, logger)
  }
];

type FakeChild = EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  pid: number;
  killed: boolean;
  exitCode: number | null;
  signalCode: string | null;
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = new Writable({ write: (_c, _e, cb) => cb() });
  child.pid = PID;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => true);
  return child;
}

function quietLogger(): SanitizedLogger {
  const logger = new SanitizedLogger();
  logger.info = vi.fn();
  logger.warn = vi.fn();
  return logger;
}

/**
 * What the probes answer. The leader's pid is always free (`ESRCH`): it was reaped, and a pid held
 * by another process would, rightly, settle the ladder as `group-gone` with no signal. The GROUP
 * is what varies. Signals other than 0 are swallowed, so no real group is ever signalled.
 */
function stubKill(group: 'absent' | 'present' | 'eperm'): void {
  vi.spyOn(process, 'kill').mockImplementation(((target: number, signal?: string | number) => {
    if (signal !== 0) return true;
    if (target > 0 || group === 'absent') {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    }
    if (group === 'present') return true;
    throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
  }) as unknown as typeof process.kill);
}

afterEach(() => {
  const pending = vi.isFakeTimers() ? vi.getTimerCount() : 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
  expect(pending, 'a ladder rung would have fired against the real process.kill').toBe(0);
});

/** Start an invocation that hangs, and give it the microtask turns it needs to spawn. */
async function startInvocation(
  runner: BackendRunner,
  timeoutMs = 600_000
): Promise<{ readonly invocation: Promise<unknown> }> {
  const invocation = runner.invoke({
    runId: RUN_ID,
    phase: PHASE,
    iteration: ITERATION,
    prompt: 'do the work',
    timeoutMs,
    cliPath: 'backend',
    cwd: '/repo'
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(runner.hasActiveProcess, 'the fixture must have spawned').toBe(true);
  // Wrapped: an async function returning a promise would be flattened, and awaiting it would
  // wait for the invocation to finish.
  return { invocation };
}

/** The child exits the way a SIGTERM'd child does, so the invocation can finish. */
function exitOnSigterm(child: FakeChild): void {
  child.signalCode = 'SIGTERM';
  child.emit('exit', null, 'SIGTERM');
  child.emit('close', null, 'SIGTERM');
}

const posixDescribe = process.platform === 'win32' ? describe.skip : describe;

posixDescribe.each(SUBJECTS)(
  '$name settles its ladders (T21)',
  (subject) => {
    function build(child: FakeChild, logger = quietLogger()) {
      const spawnFn: SpawnFn = () => child as unknown as ChildProcess;
      return subject.make(spawnFn, logger);
    }

    it('gives no outcome when no ladder was started', async () => {
      vi.useFakeTimers();
      stubKill('absent');
      const runner = build(fakeChild());
      await expect(runner.settleTeardowns()).resolves.toEqual([]);
    });

    it('gives one outcome, attributed to the invocation, after a cancel', async () => {
      vi.useFakeTimers();
      stubKill('absent');
      const child = fakeChild();
      const runner = build(child);
      const { invocation } = await startInvocation(runner);

      runner.cancelActive();
      const settled = runner.settleTeardowns();
      exitOnSigterm(child);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(await settled).toEqual([
        {
          attribution: { runId: RUN_ID, phase: PHASE, iteration: ITERATION },
          runner: subject.label,
          pid: PID,
          result: 'group-gone'
        }
      ]);
      await invocation;
    });

    it('includes a ladder an idle timeout started before shutdown', async () => {
      vi.useFakeTimers();
      stubKill('absent');
      const child = fakeChild();
      const runner = build(child);
      const { invocation } = await startInvocation(runner, 100);

      // The timeout fires and starts the ladder; shutdown has not begun.
      await vi.advanceTimersByTimeAsync(150);
      const settled = runner.settleTeardowns();
      exitOnSigterm(child);
      await vi.advanceTimersByTimeAsync(5_000);

      const outcomes = await settled;
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.attribution).toEqual({ runId: RUN_ID, phase: PHASE, iteration: ITERATION });
      await invocation;
    });

    it('does not report a settled ladder twice', async () => {
      vi.useFakeTimers();
      stubKill('absent');
      const child = fakeChild();
      const runner = build(child);
      const { invocation } = await startInvocation(runner);

      runner.cancelActive();
      const first = runner.settleTeardowns();
      exitOnSigterm(child);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await first).toHaveLength(1);

      await expect(runner.settleTeardowns()).resolves.toEqual([]);
      await invocation;
    });

    it('resolves, never rejects, when the ladder cannot complete its report', async () => {
      // The group survives, so the ladder reports through `warn` -- which throws here. A
      // throwing hook must not leave the registry waiting on a promise that never settles.
      vi.useFakeTimers();
      stubKill('present');
      const logger = quietLogger();
      logger.warn = vi.fn(() => {
        throw new Error('the log sink is gone');
      });
      const child = fakeChild();
      const runner = build(child, logger);
      const { invocation } = await startInvocation(runner);

      runner.cancelActive();
      const settled = runner.settleTeardowns();
      exitOnSigterm(child);
      await vi.advanceTimersByTimeAsync(5_000);

      const outcomes = await settled;
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.result).toBe('tree-unconfirmed');
      await invocation;
    });

    it('resolves with tree-unconfirmed when the probe answers EPERM', async () => {
      vi.useFakeTimers();
      stubKill('eperm');
      const child = fakeChild();
      const runner = build(child);
      const { invocation } = await startInvocation(runner);

      runner.cancelActive();
      const settled = runner.settleTeardowns();
      exitOnSigterm(child);
      await vi.advanceTimersByTimeAsync(5_000);

      const outcomes = await settled;
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.result).toBe('tree-unconfirmed');
      await invocation;
    });

    it('reports bound-elapsed, with the attribution it started with, for a ladder still pending at the deadline', async () => {
      // The registry owns the deadline and hands it down; the runner alone knows each ladder's
      // attribution, so it stamps the outcome when the deadline passes first.
      vi.useFakeTimers();
      stubKill('present');
      const child = fakeChild();
      const runner = build(child);
      const { invocation } = await startInvocation(runner);

      runner.cancelActive();
      let reachDeadline: () => void = () => undefined;
      const deadline = new Promise<void>((resolve) => {
        reachDeadline = resolve;
      });
      const settled = runner.settleTeardowns(deadline);
      // The ladder needs 2.5 s; the deadline arrives first.
      await vi.advanceTimersByTimeAsync(500);
      reachDeadline();

      expect(await settled).toEqual([
        {
          attribution: { runId: RUN_ID, phase: PHASE, iteration: ITERATION },
          runner: subject.label,
          pid: PID,
          result: 'bound-elapsed'
        }
      ]);

      // Let the ladder finish so no rung is left pending against the stubbed kill.
      exitOnSigterm(child);
      await vi.advanceTimersByTimeAsync(5_000);
      await invocation;
    });

    it('prefers the ladder outcome when it settles before the deadline', async () => {
      vi.useFakeTimers();
      stubKill('absent');
      const child = fakeChild();
      const runner = build(child);
      const { invocation } = await startInvocation(runner);

      runner.cancelActive();
      const deadline = new Promise<void>(() => undefined);
      const settled = runner.settleTeardowns(deadline);
      exitOnSigterm(child);
      await vi.advanceTimersByTimeAsync(5_000);

      expect((await settled)[0]?.result).toBe('group-gone');
      await invocation;
    });
  }
);
