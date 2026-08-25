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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('escalateAndReportTree (FR-R3-083)', () => {
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

  it('SIGKILLs the group even when the direct child has exited', async () => {
    // The arrangement this feature exists for: the CLI installs a SIGTERM handler
    // and exits while its forked helper ignores it and keeps writing.
    //
    // An earlier version returned here, reasoning that SIGKILL "targets a leader
    // that has already exited". It does not -- `signalProcessTree` signals the
    // GROUP, and a POSIX group outlives its leader while any member remains. That
    // version declined to send the one signal that would have reaped the helper and
    // then filed an audit entry describing the survivor it chose not to kill.
    vi.useFakeTimers();
    stubKill(true);
    const killSpy = vi.spyOn(process, 'kill');
    const h = harness(fakeChild(4242, true));
    h.run();
    await vi.advanceTimersByTimeAsync(5_000);
    // The group was signalled with SIGKILL, negative pid, despite the exited child.
    expect(
      killSpy.mock.calls.some(([pid, signal]) => pid === -4242 && signal === 'SIGKILL')
    ).toBe(true);
    expect(h.events).toHaveLength(1);
  });

  it('still SIGTERMs a child that leads no group, rather than reading ESRCH as gone', () => {
    // FR-R3-054 §4 finding 1, relearned the hard way. `processTreeIsGone` answers for
    // the GROUP, so a child with no group of its own -- an injected double, or a real
    // child from a spawn path the migration has not reached -- makes `kill(-pid, 0)`
    // throw ESRCH, which reads as "gone". An earlier version probed before the first
    // signal and therefore stopped signalling those children entirely: thirty-one
    // runner tests failed, and a real unmigrated child would have gone unsignalled
    // too. The signals are unconditional; only the ESCALATION consults the probe.
    stubKill(false);
    const killSpy = vi.spyOn(process, 'kill');
    const h = harness(fakeChild(4242, false));
    h.run();
    // The group signal was attempted despite the probe answering "gone".
    expect(killSpy.mock.calls.some(([pid, sig]) => pid === -4242 && sig === 'SIGTERM')).toBe(true);
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
