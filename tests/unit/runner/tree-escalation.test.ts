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

  it('still confirms when the DIRECT CHILD exited but the group did not', async () => {
    // The arrangement this evidence path exists for, and the one an earlier version
    // skipped entirely: the CLI handles SIGTERM and exits while the helper it forked
    // ignores it and keeps writing. The child's status is the right trigger for
    // whether to ESCALATE; it was never the right trigger for whether to ASK.
    vi.useFakeTimers();
    stubKill(true);
    const h = harness(fakeChild(4242, true));
    h.run();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.events).toHaveLength(1);
    const event = h.events[0];
    // And it says SO. SIGKILL targets a leader that has already exited, so it is not
    // sent -- and stamping the full-ladder value here would make the record claim a
    // signal that was never delivered. The warning says the same thing.
    if (event.kind === 'tree-unconfirmed') {
      expect(event.escalation).toBe('sigterm-only-child-exited');
    }
    expect(h.warnings[0]).toContain('SIGKILL was not sent');
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
