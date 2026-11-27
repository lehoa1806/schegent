import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { escalateAndReportTree, trackGroupAtExit } from '../../../src/runner/process-tree';
import type {
  MonitorSidecarEvent,
  TreeTeardownOutcome
} from '../../../src/contracts/backend-runner';

// FR-R4-F06 (P4) -- the win32 cases drive `taskkill`, which the ladder SPAWNS as a real
// child. Nothing in this file may start one, so `spawn` is replaced by a double that
// reports the arguments it was given and exits at once. The POSIX cases never call it.
const taskkillCalls: string[][] = [];
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((_command: string, args: readonly string[]) => {
      taskkillCalls.push([...args]);
      const killer = new EventEmitter();
      queueMicrotask(() => killer.emit('exit', 0));
      return killer;
    })
  };
});

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

/**
 * The ladder's SIGTERM->SIGKILL delay, restated here because the constant is
 * module-private in `process-tree.ts` — deliberately, so nothing imports it and
 * re-implements the ladder against it. This copy is a test's own clock, not a second
 * definition: it only has to be >= the real one for the timer advance to pass it.
 */
const SIGKILL_DELAY_FOR_TEST = 2_000;

interface Harness {
  readonly child: ChildProcess;
  readonly events: MonitorSidecarEvent[];
  readonly warnings: string[];
  readonly reported: Set<ChildProcess>;
  run(): Promise<TreeTeardownOutcome>;
}

/** A child double. `pid` is what the tree probe targets. */
function fakeChild(
  pid: number | undefined,
  exited: boolean,
  kill: () => boolean = () => true
): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, {
    pid,
    exitCode: exited ? 0 : null,
    signalCode: null,
    kill
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
    void h.run();
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
    void h.run();
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
    void h.run();
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
    void h.run();
    // The group signal was attempted despite the probe answering "gone".
    expect(killSpy.mock.calls.some(([pid, sig]) => pid === -4242 && sig === 'SIGTERM')).toBe(true);
    // Drain the scheduled rungs against the stub, so nothing is left pending when
    // `afterEach` restores the real `process.kill`.
    await vi.advanceTimersByTimeAsync(5_000);
  });

  it.each([
    ['a live group', true],
    ['a dead group', false]
  ])('sends no signal for a reaped child with no anchor, whatever the group says (%s)', async (_label, alive) => {
    // FR-R4-F06 (P3) -- this was "skips SIGKILL for a reaped child", and it is the
    // UNANCHORED half of the split T15 asks for. A child reaped before the ladder began,
    // with no exit-time observation of its group, has nothing that says the group is
    // ours, so the pid is not signalled at all: that is the safety property that held
    // before this feature, and it still holds. What changed is that the ladder now
    // ANSWERS (one probe, below) instead of returning nothing.
    vi.useFakeTimers();
    stubKill(alive);
    const killSpy = vi.spyOn(process, 'kill');
    const h = harness(fakeChild(4242, true));
    const outcome = h.run();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(killSpy.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
    expect((await outcome).result).toBe(alive ? 'tree-unconfirmed' : 'group-gone');
  });

  it('REPORTS a surviving group even though the child was reaped by our own SIGKILL', async () => {
    // The case the feature exists for, and the one an earlier version suppressed by
    // reusing the signal gate here: 500 ms after the ladder's own SIGKILL the child
    // is reaped by definition, so gating the report on that produced no warning and
    // no audit entry for any real survivor.
    //
    // Signalling and reporting have different costs -- one destroys an unrelated
    // process tree, the other writes an observational entry an operator can check --
    // so they get different gates.
    vi.useFakeTimers();
    const child = fakeChild(4242, false);
    stubKill(true);
    const h = harness(child);
    void h.run();
    // The ladder's SIGKILL lands and the child is reaped, exactly as in production.
    await vi.advanceTimersByTimeAsync(SIGKILL_DELAY_FOR_TEST + 10);
    Object.assign(child, { signalCode: 'SIGKILL' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.events).toHaveLength(1);
    expect(h.warnings[0]).toContain('not confirmed gone after SIGKILL');
  });

  it('emits ONE entry when two cancel paths hit one hung child', async () => {
    vi.useFakeTimers();
    stubKill(true);
    const h = harness(fakeChild(4242, false));
    void h.run();
    void h.run();
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
    void h.run();
    const afterFirst = killSpy.mock.calls.length;
    void h.run();
    expect(killSpy.mock.calls.length).toBeGreaterThan(afterFirst);
    await vi.advanceTimersByTimeAsync(5_000);
  });

  it('treats a child with no pid as gone rather than reporting it', async () => {
    // `processTreeIsGone` returns true for an undefined pid: a spawn that never
    // produced a process has no group to survive.
    vi.useFakeTimers();
    stubKill(true);
    const h = harness(fakeChild(undefined, false));
    void h.run();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FR-R4-F06 (FR-015, FR-017; T15; contract P, P2 to P4) -- ownership evidence
// ---------------------------------------------------------------------------
//
// A group signal needs EVIDENCE that the group is ours. For a leader still unreaped when the
// ladder starts, Node holds the pid, so it cannot be anyone else's. For a leader already
// reaped, the evidence is an ANCHOR (the exit-time observation `trackGroupAtExit` records:
// the group answered while the pid was free) plus a FRESH CHECK made immediately before
// each signal (the pid is still free and the group still answers). `EPERM` from either probe
// means a member the host may not signal, so no signal is sent.
//
// `process.kill` is stubbed per target, because the cases differ in what the pid probe
// (`kill(N, 0)`) and the group probe (`kill(-N, 0)`) answer at each moment, not in one
// alive-or-not switch. A real signal to the group optionally empties it, which is what lets
// one case show "SIGKILL delivered, then confirmed gone".

type Answer = 'present' | 'absent' | 'eperm';

interface ProbeTable {
  /** What `kill(N, 0)` answers: is the pid held by some process? */
  pid: Answer;
  /** What `kill(-N, 0)` answers: does the group have a signalable member? */
  group: Answer;
  /** A SIGKILL to the group empties it. */
  sigkillEmptiesGroup: boolean;
}

interface Stubbed {
  readonly table: ProbeTable;
  readonly realSignals: Array<readonly [number, string | number | undefined]>;
  probes(): number;
}

function stubTable(initial: Partial<ProbeTable> = {}): Stubbed {
  const table: ProbeTable = {
    pid: 'absent',
    group: 'present',
    sigkillEmptiesGroup: true,
    ...initial
  };
  const realSignals: Array<readonly [number, string | number | undefined]> = [];
  let probes = 0;
  vi.spyOn(process, 'kill').mockImplementation(((target: number, signal?: string | number) => {
    if (signal === 0) {
      probes += 1;
      const answer = target > 0 ? table.pid : table.group;
      if (answer === 'present') return true;
      throw Object.assign(new Error(answer === 'absent' ? 'no such process' : 'not permitted'), {
        code: answer === 'absent' ? 'ESRCH' : 'EPERM'
      });
    }
    realSignals.push([target, signal]);
    if (signal === 'SIGKILL' && target < 0 && table.sigkillEmptiesGroup) table.group = 'absent';
    return true;
  }) as unknown as typeof process.kill);
  return { table, realSignals, probes: () => probes };
}

/** A tracked child that has exited, with the group still answering and the pid free: anchored. */
function anchoredReapedChild(kill: () => boolean = () => true): ChildProcess {
  const child = fakeChild(4242, false, kill);
  trackGroupAtExit(child);
  Object.assign(child, { exitCode: 0 });
  child.emit('exit', 0, null);
  return child;
}

describe.skipIf(process.platform === 'win32')(
  'a reaped leader needs ownership evidence before its group is signalled (T15)',
  () => {
    it('SIGTERMs, SIGKILLs and confirms an anchored group whose pid is still free', async () => {
      vi.useFakeTimers();
      const stub = stubTable();
      const kill = vi.fn(() => true);
      const h = harness(anchoredReapedChild(kill));

      const outcome = h.run();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(stub.realSignals).toEqual([
        [-4242, 'SIGTERM'],
        [-4242, 'SIGKILL']
      ]);
      // The direct child is reaped, so it is never signalled.
      expect(kill).not.toHaveBeenCalled();
      expect((await outcome).result).toBe('group-gone');
      expect(h.events).toEqual([]);
    });

    it('places the group SIGKILL at the SIGKILL rung, not before', async () => {
      vi.useFakeTimers();
      const stub = stubTable();
      const h = harness(anchoredReapedChild());

      const outcome = h.run();
      await vi.advanceTimersByTimeAsync(SIGKILL_DELAY_FOR_TEST - 1);
      expect(stub.realSignals).toEqual([[-4242, 'SIGTERM']]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(stub.realSignals).toEqual([
        [-4242, 'SIGTERM'],
        [-4242, 'SIGKILL']
      ]);
      await outcome;
    });

    it('reports an anchored group that survives the SIGKILL, once', async () => {
      vi.useFakeTimers();
      stubTable({ sigkillEmptiesGroup: false });
      const h = harness(anchoredReapedChild());

      const first = h.run();
      const second = h.run();
      await vi.advanceTimersByTimeAsync(5_000);

      expect((await first).result).toBe('tree-unconfirmed');
      expect((await second).result).toBe('tree-unconfirmed');
      // The newly reachable case: leader reaped, group escalated, group survived.
      expect(h.events).toHaveLength(1);
      expect(h.warnings).toHaveLength(1);
    });

    it('escalates a leader that was unreaped at the start and exited on SIGTERM', async () => {
      // The T14 scenario with a double: the leader handles SIGTERM and exits inside the
      // grace window, the helper in its group does not. Before this feature the SIGKILL
      // rung returned at `childIsReaped` and nothing was sent or reported.
      vi.useFakeTimers();
      const stub = stubTable();
      const kill = vi.fn(() => true);
      const child = fakeChild(4242, false, kill);
      const h = harness(child);

      const outcome = h.run();
      await vi.advanceTimersByTimeAsync(1_000);
      Object.assign(child, { exitCode: 0 });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(stub.realSignals.filter(([target]) => target === -4242)).toEqual([
        [-4242, 'SIGTERM'],
        [-4242, 'SIGKILL']
      ]);
      // The direct child was signalled once, at the start, while it was still unreaped.
      expect(kill).toHaveBeenCalledTimes(1);
      expect((await outcome).result).toBe('group-gone');
    });

    it('sends no group signal when pid N is held by another process, and settles group-gone', async () => {
      vi.useFakeTimers();
      // Anchored at exit under the default table (pid free, group answering)...
      const stub = stubTable();
      const child = anchoredReapedChild();
      // ...but by the time the ladder runs, the number belongs to a stranger.
      Object.assign(stub.table, { pid: 'present', group: 'present' });
      const h = harness(child);

      const outcome = h.run();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(stub.realSignals).toEqual([]);
      expect((await outcome).result).toBe('group-gone');
      expect(h.events).toEqual([]);
    });

    it.each([
      ['the pid probe', { pid: 'eperm', group: 'present' }],
      ['the group probe', { pid: 'absent', group: 'eperm' }]
    ] as const)('sends no signal and settles tree-unconfirmed on EPERM from %s', async (_label, table) => {
      vi.useFakeTimers();
      const stub = stubTable();
      const child = anchoredReapedChild();
      Object.assign(stub.table, table);
      const h = harness(child);

      const outcome = h.run();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(stub.realSignals).toEqual([]);
      expect((await outcome).result).toBe('tree-unconfirmed');
    });

    it('settles group-gone at once when an anchored group is already empty', async () => {
      vi.useFakeTimers();
      const stub = stubTable();
      const child = anchoredReapedChild();
      Object.assign(stub.table, { pid: 'absent', group: 'absent' });
      const h = harness(child);

      const outcome = h.run();
      await vi.advanceTimersByTimeAsync(0);

      expect(stub.realSignals).toEqual([]);
      expect((await outcome).result).toBe('group-gone');
    });

    it('does not anchor on a group that was already gone at exit', async () => {
      vi.useFakeTimers();
      // At exit the group is empty, so nothing is recorded as ours.
      const stub = stubTable({ pid: 'absent', group: 'absent' });
      const child = fakeChild(4242, false);
      trackGroupAtExit(child);
      Object.assign(child, { exitCode: 0 });
      child.emit('exit', 0, null);
      // A helper appears under the number later: still no anchor, so no signal.
      stub.table.group = 'present';
      const h = harness(child);

      const outcome = h.run();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(stub.realSignals).toEqual([]);
      expect((await outcome).result).toBe('tree-unconfirmed');
    });

    it('asks one probe of an unanchored reaped child and files no report', async () => {
      vi.useFakeTimers();
      const stub = stubTable({ pid: 'absent', group: 'present' });
      const h = harness(fakeChild(4242, true));

      const outcome = h.run();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(stub.probes()).toBe(1);
      expect(stub.realSignals).toEqual([]);
      expect((await outcome).result).toBe('tree-unconfirmed');
      // The evidence is too weak to file.
      expect(h.events).toEqual([]);
      expect(h.warnings).toEqual([]);
    });
  }
);

describe('Windows keeps its ladder and answers platform-unanswerable (T15, P4)', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  afterEach(() => {
    // Restored whatever the case did: a leaked `win32` would switch every later file in this
    // worker onto the Windows branch.
    if (originalPlatform !== undefined) Object.defineProperty(process, 'platform', originalPlatform);
  });

  /** The platform is read at call time, so redefining the property is enough. */
  function asWin32(): void {
    taskkillCalls.length = 0;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  }

  it('sends no signal for a reaped child and settles platform-unanswerable', async () => {
    vi.useFakeTimers();
    asWin32();
    const h = harness(fakeChild(4242, true));

    const outcome = h.run();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(taskkillCalls).toEqual([]);
    expect((await outcome).result).toBe('platform-unanswerable');
    expect(h.events).toEqual([]);
  });

  it('runs taskkill /T then /T /F, runs no confirmation, and settles platform-unanswerable', async () => {
    vi.useFakeTimers();
    asWin32();
    const h = harness(fakeChild(4242, false));

    const outcome = h.run();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(taskkillCalls).toEqual([
      ['/pid', '4242', '/T'],
      ['/pid', '4242', '/T', '/F']
    ]);
    expect((await outcome).result).toBe('platform-unanswerable');
    expect(h.events).toEqual([]);
    expect(h.warnings).toEqual([]);
  });
});
