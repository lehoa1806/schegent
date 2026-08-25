import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { escalateAndReportTree } from '../../../src/runner/process-tree';
import type { MonitorSidecarEvent } from '../../../src/contracts/backend-runner';

/**
 * FR-R3-083 — the escalation ladder, behaviourally.
 *
 * Before this file the ladder was asserted only by source-text lint gates: one
 * checked that the literal `kind: 'tree-unconfirmed'` still appeared in
 * `process-tree.ts`, another that both runners called into it. Neither could tell
 * whether the event was ever emitted, whether the guard prevented a second one, or
 * whether the ladder still escalated. A refactor that dropped `deps.emit(...)`,
 * inverted the `processTreeIsGone` check, or removed the report guard would have
 * left every gate green.
 *
 * A REAL process is not used. This suite is about the ladder's decisions, and a
 * genuinely unkillable process group is not something a test may create -- the one
 * arrangement that produces the report on real hardware is precisely the one this
 * product cannot manufacture on demand. So the child is a double whose
 * `exitCode`/`signalCode` and pid are set by the test, and `process.kill` is
 * stubbed so the tree probe answers what each case needs.
 */
const attribution = { runId: 'run-1', phase: 'implement', iteration: 1 } as const;

interface Harness {
  readonly child: ChildProcess;
  readonly events: MonitorSidecarEvent[];
  readonly warnings: string[];
  readonly reported: Set<ChildProcess>;
  run(): void;
}

/** A child double. `pid` is what the tree probe targets. */
function fakeChild(pid: number | undefined, exited: boolean): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, {
    pid,
    exitCode: exited ? 0 : null,
    signalCode: null,
    kill: () => true
  });
  return child;
}

function harness(child: ChildProcess): Harness {
  const events: MonitorSidecarEvent[] = [];
  const warnings: string[] = [];
  const reported = new Set<ChildProcess>();
  return {
    child,
    events,
    warnings,
    reported,
    run: () =>
      escalateAndReportTree({
        child,
        attribution,
        runner: 'codex-cli',
        warn: (m) => void warnings.push(m),
        emit: (e) => void events.push(e),
        alreadyReported: () => reported.has(child),
        markReported: () => void reported.add(child)
      })
  };
}

/**
 * Stub `process.kill` so the tree probe answers deterministically.
 *
 * `signal 0` is the probe. `alive: true` means it succeeds (the group is there);
 * `alive: false` means it throws ESRCH (the group is gone). Real signals are
 * swallowed.
 */
function stubKill(alive: boolean): void {
  vi.spyOn(process, 'kill').mockImplementation(((_pid: number, signal?: string | number) => {
    if (signal === 0) {
      if (alive) return true;
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    }
    return true;
  }) as unknown as typeof process.kill);
}

afterEach(() => {
  // NOTHING PENDING before the stub comes off. A rung left scheduled fires against
  // the REAL `process.kill` once `restoreAllMocks` runs, which for a fake child means
  // signalling whatever process group happens to hold that pid on this machine. One
  // test in this file did exactly that. `getTimerCount` catches the next one.
  const pending = vi.isFakeTimers() ? vi.getTimerCount() : 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
  expect(pending, 'a scheduled ladder rung would have fired against the real process.kill').toBe(0);
});

/**
 * POSIX ONLY, and skipped rather than adapted.
 *
 * `stubKill` stubs `process.kill`, which is the whole mechanism on POSIX. On Windows
 * `signalProcessTree` routes through `killWindowsTree`, which SPAWNS `taskkill /pid
 * <pid> /T` as a real child — the stub never sees it, every `-4242` assertion fails,
 * and the fixture issues real `taskkill` commands at whatever process holds pid 4242
 * on that machine. The Windows behaviour has its own fixture in
 * `tests/unit/platform/`, which is where it belongs.
 */
describe.skipIf(process.platform === 'win32')('escalateAndReportTree (FR-R3-083)', () => {
  it('reports a surviving group after the full ladder', async () => {
    vi.useFakeTimers();
    stubKill(true);
    const h = harness(fakeChild(4242, false));
    h.run();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('not confirmed gone after SIGKILL');
    expect(h.events).toHaveLength(1);
    const event = h.events[0];
    expect(event.kind).toBe('tree-unconfirmed');
    if (event.kind === 'tree-unconfirmed') {
      expect(event.runId).toBe('run-1');
      expect(event.pid).toBe(4242);
      expect(event.runner).toBe('codex-cli');
      // The whole payload, so a widened event is caught here and not by a reader
      // downstream. `cancelActive` once passed an object carrying the live
      // ChildProcess, which a spread would have admitted silently.
      expect(Object.keys(event).sort()).toEqual([
        'escalation',
        'iteration',
        'kind',
        'phase',
        'pid',
        'runId',
        'runner'
      ]);
      expect(event.escalation).toBe('sigterm-then-sigkill');
    }
  });

  it('reports NOTHING when the group is confirmed gone', async () => {
    vi.useFakeTimers();
    stubKill(false);
    const h = harness(fakeChild(4242, false));
    h.run();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.events).toEqual([]);
    expect(h.warnings).toEqual([]);
  });

  it('does NOTHING once the direct child has been reaped', async () => {
    // The safety property, restored after two rounds of trying to have it both ways.
    //
    // The tempting version escalates while the group still answers, so a CLI that
    // handles SIGTERM and exits -- leaving a forked helper that ignores it -- still
    // gets its group SIGKILLed. But the address is the exited child's pid, and once
    // Node reaps it that pid is the OS's to reuse: a new group leader can hold it,
    // `kill(-pid, 0)` answers "alive" about a stranger, and the ladder would SIGKILL
    // that stranger's whole tree and then file an audit entry against a Run that no
    // longer owns the pid.
    //
    // Killing an unrelated process tree, and recording a false lead, are both worse
    // than missing a detection. What is lost is named as a permanent limit rather
    // than quietly absorbed.
    vi.useFakeTimers();
    stubKill(true);
    const killSpy = vi.spyOn(process, 'kill');
    const h = harness(fakeChild(4242, true));
    h.run();
    await vi.advanceTimersByTimeAsync(5_000);
    const realSignals = killSpy.mock.calls.filter(([, signal]) => signal !== 0);
    expect(realSignals).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.warnings).toEqual([]);
  });

  it('still SIGTERMs a child that leads no group, rather than reading ESRCH as gone', async () => {
    // FR-R3-054 §4 finding 1, relearned the hard way. `processTreeIsGone` answers for
    // the GROUP, so a child with no group of its own -- an injected double, or a real
    // child from a spawn path the migration has not reached -- makes `kill(-pid, 0)`
    // throw ESRCH, which reads as "gone". An earlier version probed before the first
    // signal and therefore stopped signalling those children entirely: thirty-one
    // runner tests failed, and a real unmigrated child would have gone unsignalled
    // too. The signals are unconditional; only the ESCALATION consults the probe.
    // FAKE TIMERS, like every other case here, and not optional. `escalateAndReportTree`
    // schedules a real 2 s `setTimeout` for the SIGKILL rung. Without fake timers this
    // test returns immediately, `afterEach` restores `process.kill`, and two seconds
    // later the callback fires an UNSTUBBED `process.kill(-4242, 'SIGKILL')` at
    // whatever process group 4242 is on the machine running the suite. `.unref()` does
    // not stop a timer firing -- it only stops it holding the loop open -- and a full
    // `test:host` run lives far longer than 2.5 s.
    vi.useFakeTimers();
    stubKill(false);
    const killSpy = vi.spyOn(process, 'kill');
    const h = harness(fakeChild(4242, false));
    h.run();
    // The group signal was attempted despite the probe answering "gone".
    expect(killSpy.mock.calls.some(([pid, sig]) => pid === -4242 && sig === 'SIGTERM')).toBe(true);
    // Drain the scheduled rungs against the stub, so nothing is left pending when
    // `afterEach` restores the real `process.kill`.
    await vi.advanceTimersByTimeAsync(5_000);
  });

  it('skips SIGKILL only when the child has exited AND the group is gone', async () => {
    vi.useFakeTimers();
    stubKill(false);
    const killSpy = vi.spyOn(process, 'kill');
    const h = harness(fakeChild(4242, true));
    h.run();
    killSpy.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    const escalations = killSpy.mock.calls.filter(([, sig]) => sig === 'SIGKILL');
    expect(escalations).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('emits ONE entry when two cancel paths hit one hung child', async () => {
    vi.useFakeTimers();
    stubKill(true);
    const h = harness(fakeChild(4242, false));
    h.run();
    h.run();
    await vi.advanceTimersByTimeAsync(5_000);
    // Two ladders, one surviving group, one audit entry.
    expect(h.events).toHaveLength(1);
  });

  it('still signals on a second pass, because the guard is on the REPORT', async () => {
    // The distinction the guard's placement makes. `signalProcessTree` swallows a
    // failed group signal by design, so a first pass failing silently is ordinary --
    // and a later, genuinely different trigger must still be able to reach the tree.
    vi.useFakeTimers();
    stubKill(true);
    const killSpy = vi.spyOn(process, 'kill');
    const h = harness(fakeChild(4242, false));
    h.run();
    const afterFirst = killSpy.mock.calls.length;
    h.run();
    expect(killSpy.mock.calls.length).toBeGreaterThan(afterFirst);
    await vi.advanceTimersByTimeAsync(5_000);
  });

  it('treats a child with no pid as gone rather than reporting it', async () => {
    // `processTreeIsGone` returns true for an undefined pid: a spawn that never
    // produced a process has no group to survive.
    vi.useFakeTimers();
    stubKill(true);
    const h = harness(fakeChild(undefined, false));
    h.run();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.events).toEqual([]);
  });
});
