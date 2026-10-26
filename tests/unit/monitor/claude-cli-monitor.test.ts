import { describe, it, expect, beforeEach } from 'vitest';
import { ClaudeCliMonitor } from '../../../src/monitor/claude-cli-monitor';
import type { CliTransportRecord } from '../../../src/monitor/cli-transport-sink';
import type { AuditEntry } from '../../../src/audit/audit-entry';

interface FakeTimer {
  cb: () => void;
  ms: number;
  fireAt: number;
}

class FakeClock {
  private t = 1_000;
  public advance(ms: number): void {
    this.t += ms;
  }
  public now(): number {
    return this.t;
  }
}

class FakeSetTimeout {
  public timers: FakeTimer[] = [];
  private nextHandle = 1;
  constructor(private clock: FakeClock) {}

  public setTimeoutFn = (cb: () => void, ms: number): unknown => {
    const handle = this.nextHandle++;
    this.timers.push({ cb, ms, fireAt: this.clock.now() + ms });
    (this.timers[this.timers.length - 1] as unknown as { handle: number }).handle = handle;
    return handle;
  };

  public clearTimeoutFn = (handle: unknown): void => {
    this.timers = this.timers.filter((t) => (t as unknown as { handle: number }).handle !== handle);
  };

  public fireDue(): void {
    const now = this.clock.now();
    const due = this.timers.filter((t) => t.fireAt <= now);
    this.timers = this.timers.filter((t) => t.fireAt > now);
    for (const t of due) t.cb();
  }
}

class FakeAudit {
  public entries: Array<Partial<AuditEntry>> = [];
  public append = async (entry: Partial<AuditEntry>): Promise<AuditEntry> => {
    this.entries.push(entry);
    return { ...entry, id: String(this.entries.length), timestamp: new Date().toISOString() } as AuditEntry;
  };
}

class FakeLogger {
  public warnings: string[] = [];
  public sanitize = (s: string): string => s;
  public warn = (msg: string): void => {
    this.warnings.push(msg);
  };
}

/**
 * Feature FR-R3-007 — the destination the per-line audit writer was replaced by.
 * One method, no filesystem: what these tests care about is which Run a line was
 * attributed to, which is the property the audit entry used to carry.
 */
class FakeTransport {
  public records: CliTransportRecord[] = [];
  public record = (entry: CliTransportRecord): void => {
    this.records.push(entry);
  };
}

const RATE_LIMIT_MATCHERS = [
  { regex: /429.*too many requests/i, cause: 'rate-limit-429' }
];

function makeMonitor(): {
  monitor: ClaudeCliMonitor;
  clock: FakeClock;
  fakeTimer: FakeSetTimeout;
  audit: FakeAudit;
  transport: FakeTransport;
  logger: FakeLogger;
  advance: (ms: number) => void;
} {
  const clock = new FakeClock();
  const fakeTimer = new FakeSetTimeout(clock);
  const audit = new FakeAudit();
  const logger = new FakeLogger();
  const transport = new FakeTransport();
  const monitor = new ClaudeCliMonitor({
    stallThresholdMs: 90_000,
    rateLimitMatchers: RATE_LIMIT_MATCHERS,
    monotonicNow: () => clock.now(),
    now: () => new Date('2026-05-10T12:00:00.000Z'),
    audit,
    transport,
    activity: { record: () => {} },
    logger,
    setTimeout: fakeTimer.setTimeoutFn,
    clearTimeout: fakeTimer.clearTimeoutFn,
    rateLimitClusterMs: 5_000
  });
  const advance = (ms: number): void => {
    clock.advance(ms);
    fakeTimer.fireDue();
  };
  return { monitor, clock, fakeTimer, audit, transport, logger, advance };
}

describe('ClaudeCliMonitor state machine', () => {
  let mc: ReturnType<typeof makeMonitor>;
  beforeEach(() => {
    mc = makeMonitor();
  });

  it('onStart -> starting', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1234);
    const state = mc.monitor.getCurrentState()!;
    expect(state.status).toBe('starting');
    expect(state.runId).toBe('run-1');
    expect(state.phase).toBe('speckit-specify');
    expect(state.pid).toBe(1234);
    expect(mc.audit.entries[0]?.eventType).toBe('monitor-invocation-started');
  });

  it('first stdout chunk transitions starting -> running and increments stdoutLines', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onStdoutChunk('run-1', 'hello\n');
    const state = mc.monitor.getCurrentState()!;
    expect(state.status).toBe('running');
    expect(state.stdoutLines).toBe(1);
  });

  it('lines without trailing newline are buffered until next chunk', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onStdoutChunk('run-1', 'partial');
    expect(mc.monitor.getCurrentState()!.stdoutLines).toBe(0);
    mc.monitor.onStdoutChunk('run-1', '-line\nnext\n');
    expect(mc.monitor.getCurrentState()!.stdoutLines).toBe(2);
  });

  it('90s of silence transitions to stalled and emits stall event', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onStdoutChunk('run-1', 'hi\n');
    mc.advance(90_000);
    const state = mc.monitor.getCurrentState()!;
    expect(state.status).toBe('stalled');
    expect(state.detectedIssues).toContain('stall');
    expect(mc.audit.entries.find((e) => e.eventType === 'monitor-stall')).toBeDefined();
  });

  // The detector was constructed in `onStart` and armed only by the first chunk, so it
  // measured gaps BETWEEN outputs and could not measure the gap before the first one. A
  // phase that never wrote a byte was invisible to it for as long as it lived — 2h26m in
  // the workspace this was found in, with `status` still 'starting' the whole time.
  //
  // `handleStall` has always carried the arm for this case:
  //   `state.lastStdoutMonotonic !== null ? … : monotonic - state.startedAtMonotonic`
  // and it was unreachable, because arming required the output whose absence is the bug.
  it('a child that never writes a byte stalls at the threshold', () => {
    mc.monitor.onStart('run-1', 'speckit-review', 1);
    mc.advance(90_000);
    const state = mc.monitor.getCurrentState()!;
    expect(state.status).toBe('stalled');
    expect(state.detectedIssues).toContain('stall');
    const stall = mc.audit.entries.find((e) => e.eventType === 'monitor-stall');
    expect(stall).toBeDefined();
    // Measured from spawn, since there is no last-output instant to measure from.
    expect((stall!.payload as { msSinceLastStdout: number }).msSinceLastStdout).toBe(90_000);
  });

  it('first output withdraws a no-output stall', () => {
    mc.monitor.onStart('run-1', 'speckit-review', 1);
    mc.advance(90_000);
    expect(mc.monitor.getCurrentState()!.status).toBe('stalled');
    mc.monitor.onStdoutChunk('run-1', 'finally\n');
    expect(mc.monitor.getCurrentState()!.status).toBe('running');
  });

  // The other direction: arming at spawn must not declare a stall against a child that
  // simply took a while to warm up. The first chunk rearms rather than double-arming,
  // because `armTimer` clears any timer it finds.
  it('a slow first byte inside the threshold is not a stall', () => {
    mc.monitor.onStart('run-1', 'speckit-review', 1);
    mc.advance(60_000);
    mc.monitor.onStdoutChunk('run-1', 'hello\n');
    expect(mc.monitor.getCurrentState()!.status).toBe('running');
    mc.advance(60_000);
    expect(mc.monitor.getCurrentState()!.status).toBe('running');
    expect(mc.fakeTimer.timers).toHaveLength(1);
  });

  // Pausing before the first output used to be a no-op, because `pause()` only banks
  // remaining time when a timer is armed. The paused stretch now stays uncounted here too.
  it('a pause before the first output does not consume the threshold', () => {
    mc.monitor.onStart('run-1', 'speckit-review', 1);
    mc.advance(30_000);
    mc.monitor.onWorkflowPaused();
    mc.advance(600_000);
    mc.monitor.onWorkflowResumed();
    mc.advance(50_000);
    expect(mc.monitor.getCurrentState()!.status).not.toBe('stalled');
    mc.advance(15_000);
    expect(mc.monitor.getCurrentState()!.status).toBe('stalled');
  });

  // FR-R3-106 (FR-072, FR-074) — REPLACES `stderr activity during silence does NOT reset
  // stall timer`, which asserted the defect as behaviour and carried no rationale.
  //
  // The stall detector had exactly one rearm call site and it was on stdout, and the
  // recovery branch that clears a stall existed only there too. So a CLI doing legitimate
  // stderr-only work — a build logging progress, a tool writing diagnostics — was declared
  // stalled at 90 s and **stayed** declared however long it kept writing. A program that
  // logs to stderr is a normal program, and the product called it stuck.
  //
  // THE TRADE THIS ACCEPTS, stated rather than discovered later: a child that emits stderr
  // forever while genuinely hung is now never declared stalled. That is the cost of not
  // lying about the legitimate case, and it is bounded elsewhere — the absolute run timeout
  // is the outer limit, and it is not this detector's job.
  it('stderr activity resets the stall timer, because a stderr-only child is working', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onStdoutChunk('run-1', 'hi\n');
    mc.advance(50_000);
    mc.monitor.onStderrChunk('run-1', 'warn\n');
    mc.advance(40_000);
    expect(
      mc.monitor.getCurrentState()!.status,
      '40s after stderr activity is inside the 90s threshold, so this child is not stalled'
    ).toBe('running');
  });

  it('a genuinely silent child still stalls at the threshold — the other direction', () => {
    // The rearm must not become "never stall". Both directions are asserted, because a
    // detector that cannot fire is as useless as one that fires wrongly.
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onStderrChunk('run-1', 'warn\n');
    mc.advance(90_000);
    expect(mc.monitor.getCurrentState()!.status).toBe('stalled');
  });

  it('stderr after a stall CLEARS it — recovery, not only rearm', () => {
    // The recovery half. Before this, a stall declared during a stderr-only stretch could
    // never be withdrawn by the very output that disproved it.
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onStdoutChunk('run-1', 'hi\n');
    mc.advance(90_000);
    expect(mc.monitor.getCurrentState()!.status).toBe('stalled');
    mc.monitor.onStderrChunk('run-1', 'still working\n');
    expect(mc.monitor.getCurrentState()!.status).toBe('running');
  });

  it('a stderr-only child runs far past the threshold without a stall verdict', () => {
    // The realistic shape: a long build that only ever writes to stderr. Three minutes at
    // the 90s threshold, so a single missed rearm would show up as a stall.
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    for (let i = 0; i < 6; i++) {
      mc.monitor.onStderrChunk('run-1', `step ${i}\n`);
      mc.advance(30_000);
    }
    expect(mc.monitor.getCurrentState()!.status).toBe('running');
  });

  it('stdout chunk after stalled returns to running', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onStdoutChunk('run-1', 'hi\n');
    mc.advance(90_000);
    expect(mc.monitor.getCurrentState()!.status).toBe('stalled');
    mc.monitor.onStdoutChunk('run-1', 'back\n');
    expect(mc.monitor.getCurrentState()!.status).toBe('running');
  });

  it('onWorkflowPaused while running shows derived paused status and suspends timer', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onStdoutChunk('run-1', 'hi\n');
    mc.monitor.onWorkflowPaused();
    expect(mc.monitor.getCurrentState()!.status).toBe('paused');
    mc.advance(120_000);
    expect(mc.monitor.getCurrentState()!.status).toBe('paused');
  });

  it('onWorkflowResumed re-arms stall timer without counting paused interval', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onStdoutChunk('run-1', 'hi\n');
    mc.advance(30_000);
    mc.monitor.onWorkflowPaused();
    mc.advance(120_000);
    mc.monitor.onWorkflowResumed();
    mc.advance(50_000);
    expect(mc.monitor.getCurrentState()!.status).not.toBe('stalled');
    mc.advance(15_000);
    expect(mc.monitor.getCurrentState()!.status).toBe('stalled');
  });

  it('onExit(0,null,false,false) -> completed + summary', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onExit('run-1', { exitCode: 0, signal: null, killed: false, timedOut: false });
    expect(mc.monitor.getCurrentState()!.status).toBe('completed');
    expect(mc.audit.entries.find((e) => e.eventType === 'monitor-invocation-completed')).toBeDefined();
    expect(mc.audit.entries.find((e) => e.eventType === 'monitor-invocation-summary')).toBeDefined();
  });

  it('onExit(1,null,false,false) -> failed', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onExit('run-1', { exitCode: 1, signal: null, killed: false, timedOut: false });
    expect(mc.monitor.getCurrentState()!.status).toBe('failed');
    expect(mc.audit.entries.find((e) => e.eventType === 'monitor-invocation-failed')).toBeDefined();
  });

  it('onExit(null,SIGTERM,true,false) -> canceled', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onExit('run-1', { exitCode: null, signal: 'SIGTERM', killed: true, timedOut: false });
    expect(mc.monitor.getCurrentState()!.status).toBe('canceled');
    expect(mc.audit.entries.find((e) => e.eventType === 'monitor-invocation-canceled')).toBeDefined();
  });

  it('onExit(null,SIGTERM,false,true) -> timed_out and emits invocation-failed', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onExit('run-1', { exitCode: null, signal: 'SIGTERM', killed: false, timedOut: true });
    expect(mc.monitor.getCurrentState()!.status).toBe('timed_out');
    expect(mc.audit.entries.find((e) => e.eventType === 'monitor-invocation-failed')).toBeDefined();
  });

  it('rate-limit pattern emits exactly once within cluster window', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onStderrChunk('run-1', '429 too many requests\n');
    mc.monitor.onStderrChunk('run-1', '429 too many requests\n');
    mc.monitor.onStderrChunk('run-1', '429 too many requests\n');
    const events = mc.audit.entries.filter((e) => e.eventType === 'monitor-rate-limited');
    expect(events).toHaveLength(1);
  });

  it('rate-limit re-emits after cluster window elapses', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onStderrChunk('run-1', '429 too many requests\n');
    mc.advance(6_000);
    mc.monitor.onStderrChunk('run-1', '429 too many requests\n');
    const events = mc.audit.entries.filter((e) => e.eventType === 'monitor-rate-limited');
    expect(events).toHaveLength(2);
  });

  it('duplicate exit emissions are suppressed', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onExit('run-1', { exitCode: 0, signal: null, killed: false, timedOut: false });
    mc.monitor.onExit('run-1', { exitCode: 1, signal: null, killed: false, timedOf: false } as unknown as { exitCode: number; signal: null; killed: boolean; timedOut: boolean });
    const completed = mc.audit.entries.filter((e) => e.eventType === 'monitor-invocation-completed');
    const failed = mc.audit.entries.filter((e) => e.eventType === 'monitor-invocation-failed');
    expect(completed).toHaveLength(1);
    expect(failed).toHaveLength(0);
  });
});

/**
 * Feature 093 (T046) — the monitor tracks one state per Run, not one per window.
 *
 * Every assertion here fails against the pre-feature single-slot monitor: it
 * kept `state`/`detector` as scalars, so a second `onStart` overwrote the first
 * Run's state and disposed its stall detector, and every subsequent anonymous
 * chunk landed on whichever Run had started most recently.
 */
describe('ClaudeCliMonitor per-Run isolation (Feature 093 FR-024)', () => {
  let mc: ReturnType<typeof makeMonitor>;
  beforeEach(() => {
    mc = makeMonitor();
  });

  it('keeps both Runs addressable after a second onStart', () => {
    mc.monitor.onStart('run-a', 'speckit-specify', 11);
    mc.monitor.onStart('run-b', 'speckit-plan', 22);

    const a = mc.monitor.getCurrentState('run-a')!;
    const b = mc.monitor.getCurrentState('run-b')!;
    expect(a.runId).toBe('run-a');
    expect(a.phase).toBe('speckit-specify');
    expect(a.pid).toBe(11);
    expect(b.runId).toBe('run-b');
    expect(b.phase).toBe('speckit-plan');
    expect(b.pid).toBe(22);
  });

  it('attributes each stdout chunk to the Run that produced it', () => {
    mc.monitor.onStart('run-a', 'speckit-specify', 11);
    mc.monitor.onStart('run-b', 'speckit-plan', 22);

    mc.monitor.onStdoutChunk('run-a', 'one\ntwo\n');
    mc.monitor.onStdoutChunk('run-b', 'only\n');

    expect(mc.monitor.getCurrentState('run-a')!.stdoutLines).toBe(2);
    expect(mc.monitor.getCurrentState('run-b')!.stdoutLines).toBe(1);
  });

  /**
   * Feature FR-R3-007 (T358) — this assertion used to read the
   * `monitor-stdout-line` audit entry, which no longer exists. The property it
   * protects is feature 093's, not the destination's: a line must be attributed
   * to the Run that produced it and not to the latest starter. So it follows the
   * content to the transport sink rather than being deleted with the writer.
   */
  it('stamps each transported line with the emitting Run', () => {
    mc.monitor.onStart('run-a', 'speckit-specify', 11);
    mc.monitor.onStart('run-b', 'speckit-plan', 22);
    mc.monitor.onStdoutChunk('run-a', 'from-a\n');

    expect(mc.transport.records).toHaveLength(1);
    expect(mc.transport.records[0]?.runId).toBe('run-a');
    expect(mc.transport.records[0]?.phase).toBe('speckit-specify');
    expect(mc.transport.records[0]?.stream).toBe('stdout');
    expect(mc.transport.records[0]?.line).toBe('from-a');
  });

  it("a sibling's start does not destroy an already-armed stall detector", () => {
    mc.monitor.onStart('run-a', 'speckit-specify', 11);
    mc.monitor.onStdoutChunk('run-a', 'hi\n');
    // B starts mid-flight; pre-feature this disposed A's detector.
    mc.monitor.onStart('run-b', 'speckit-plan', 22);
    mc.monitor.onStdoutChunk('run-b', 'hi\n');

    mc.advance(90_000);

    expect(mc.monitor.getCurrentState('run-a')!.status).toBe('stalled');
    expect(mc.monitor.getCurrentState('run-b')!.status).toBe('stalled');
    const stalls = mc.audit.entries.filter((e) => e.eventType === 'monitor-stall');
    expect(stalls.map((e) => e.runId).sort()).toEqual(['run-a', 'run-b']);
  });

  it("one Run's stdout does not reset a sibling's stall deadline", () => {
    mc.monitor.onStart('run-a', 'speckit-specify', 11);
    mc.monitor.onStart('run-b', 'speckit-plan', 22);
    mc.monitor.onStdoutChunk('run-a', 'hi\n');
    mc.monitor.onStdoutChunk('run-b', 'hi\n');

    mc.advance(50_000);
    mc.monitor.onStdoutChunk('run-b', 'still-working\n');
    mc.advance(45_000);

    expect(mc.monitor.getCurrentState('run-a')!.status).toBe('stalled');
    expect(mc.monitor.getCurrentState('run-b')!.status).toBe('running');
  });

  it('exiting one Run leaves the sibling running', () => {
    mc.monitor.onStart('run-a', 'speckit-specify', 11);
    mc.monitor.onStart('run-b', 'speckit-plan', 22);
    mc.monitor.onStdoutChunk('run-a', 'hi\n');
    mc.monitor.onStdoutChunk('run-b', 'hi\n');

    mc.monitor.onExit('run-a', { exitCode: 0, signal: null, killed: false, timedOut: false });

    expect(mc.monitor.getCurrentState('run-a')!.status).toBe('completed');
    expect(mc.monitor.getCurrentState('run-b')!.status).toBe('running');
    const summaries = mc.audit.entries.filter((e) => e.eventType === 'monitor-invocation-summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.runId).toBe('run-a');
  });

  it('pausing one Run does not pause the sibling', () => {
    mc.monitor.onStart('run-a', 'speckit-specify', 11);
    mc.monitor.onStart('run-b', 'speckit-plan', 22);
    mc.monitor.onStdoutChunk('run-a', 'hi\n');
    mc.monitor.onStdoutChunk('run-b', 'hi\n');

    mc.monitor.onWorkflowPaused('run-a');

    expect(mc.monitor.getCurrentState('run-a')!.status).toBe('paused');
    expect(mc.monitor.getCurrentState('run-b')!.status).toBe('running');
  });

  it('drops an event that names no Run rather than guessing the latest starter', () => {
    mc.monitor.onStart('run-a', 'speckit-specify', 11);
    mc.monitor.onStdoutChunk(null, 'orphan\n');

    expect(mc.monitor.getCurrentState('run-a')!.stdoutLines).toBe(0);
    // Feature FR-R3-007 — asserted against the sink, because after the writer's
    // removal the old audit-entry assertion passes for the wrong reason: there
    // is no such entry for any Run. The unattributed line must reach neither.
    expect(mc.transport.records).toHaveLength(0);
    expect(mc.audit.entries.filter((e) => e.eventType === 'monitor-stdout-line')).toHaveLength(0);
  });

  it('drops an event naming a Run the monitor never saw start', () => {
    mc.monitor.onStart('run-a', 'speckit-specify', 11);
    mc.monitor.onStdoutChunk('run-ghost', 'orphan\n');

    expect(mc.monitor.getCurrentState('run-ghost')).toBeNull();
    expect(mc.monitor.getCurrentState('run-a')!.stdoutLines).toBe(0);
  });

  it('getCurrentState() without an id keeps reading the most recently started Run', () => {
    mc.monitor.onStart('run-a', 'speckit-specify', 11);
    expect(mc.monitor.getCurrentState()!.runId).toBe('run-a');
    mc.monitor.onStart('run-b', 'speckit-plan', 22);
    expect(mc.monitor.getCurrentState()!.runId).toBe('run-b');
  });

  it('getStateMap() projects every live Run at once', () => {
    mc.monitor.onStart('run-a', 'speckit-specify', 11);
    mc.monitor.onStart('run-b', 'speckit-plan', 22);
    mc.monitor.onStdoutChunk('run-a', 'x\n');

    const map = mc.monitor.getStateMap();
    expect(Object.keys(map).sort()).toEqual(['run-a', 'run-b']);
    expect(map['run-a']?.stdoutLines).toBe(1);
    expect(map['run-b']?.stdoutLines).toBe(0);
  });

  it('dispose() tears down every Run and its detector', () => {
    mc.monitor.onStart('run-a', 'speckit-specify', 11);
    mc.monitor.onStart('run-b', 'speckit-plan', 22);
    mc.monitor.onStdoutChunk('run-a', 'hi\n');
    mc.monitor.onStdoutChunk('run-b', 'hi\n');

    mc.monitor.dispose();

    expect(mc.monitor.getStateMap()).toEqual({});
    expect(mc.monitor.getCurrentState()).toBeNull();
    expect(mc.fakeTimer.timers).toHaveLength(0);
  });
});

/**
 * Feature 093 BUG-001 (T099) — one `onStart`, two subprocesses.
 *
 * Every other test in this file drives exactly one subprocess per `onStart`, which
 * is why the whole suite is green against a defect that cost a Run six hours of
 * monitoring. These are the first that do not.
 *
 * The shape in the field: `runPhase` compacts the session before it invokes the
 * phase, T057 stamps the Run's id onto that compaction child so its transcript is
 * attributed to the Run, and the compaction exits in seconds. `onExit` latches
 * `terminal` on the FIRST exit it sees under a run id, so the compaction's exit
 * ended the Run as far as the monitor was concerned: the phase child ran for
 * 21600129 ms with its output uncounted, its status reading `completed`, its stall
 * detector disposed, and nothing but the 6-hour absolute deadline left to stop it.
 *
 * The monitor cannot be told which invocation is the phase's in advance — `onStart`
 * fires before anything is spawned. It has to recognise it on arrival, from the
 * `started` event, which is why these tests speak through `onSpawnPid`.
 */
describe('ClaudeCliMonitor helper-invocation adoption (Feature 093 BUG-001)', () => {
  let mc: ReturnType<typeof makeMonitor>;
  beforeEach(() => {
    mc = makeMonitor();
  });

  /** The pre-phase compaction: a host-internal helper spawned on the Run's behalf. */
  const HELPER = { id: 'claude-cli#1', helperInvocation: true, maxDurationMs: null };
  /** The phase invocation itself — the one whose lifetime IS the Run's phase. */
  const PHASE = { id: 'claude-cli#2', helperInvocation: false, maxDurationMs: null };
  const OK = { exitCode: 0, signal: null, killed: false, timedOut: false };
  const FAILED = { exitCode: 1, signal: null, killed: false, timedOut: false };
  const TERMINAL_EVENTS = [
    'monitor-invocation-completed',
    'monitor-invocation-failed',
    'monitor-invocation-canceled'
  ];

  function terminalEvents(): Array<string | undefined> {
    return mc.audit.entries
      .map((e) => e.eventType)
      .filter((t) => TERMINAL_EVENTS.includes(t ?? ''));
  }

  function declinedEntries(): Array<Partial<AuditEntry>> {
    return mc.audit.entries.filter((e) => e.eventType === 'monitor-chunk-declined');
  }

  /** The driver's sequence for one phase preceded by a compaction, up to the phase's spawn. */
  function compactThenSpawnPhase(): void {
    mc.monitor.onStart('run-1', 'speckit-review', null);
    mc.monitor.onSpawnPid('run-1', 501, HELPER);
    mc.monitor.onStdoutChunk('run-1', 'compacting\n', HELPER.id);
    mc.monitor.onExit('run-1', OK, HELPER.id);
    mc.monitor.onSpawnPid('run-1', 502, PHASE);
  }

  it('counts and forwards the phase invocation\'s output after a helper has exited', () => {
    compactThenSpawnPhase();
    mc.monitor.onStdoutChunk('run-1', 'phase line 1\nphase line 2\n', PHASE.id);

    const state = mc.monitor.getCurrentState('run-1')!;
    // Three: the helper's line counts too. A compaction is work done on the Run's
    // behalf and its transcript is the Run's evidence — that is why T057 stamped the
    // run id onto it in the first place. What must not happen is the helper's *exit*
    // ending the Run; attribution of its output was never the problem.
    expect(state.stdoutLines).toBe(3);
    const lines = mc.transport.records.filter((r) => r.runId === 'run-1').map((r) => r.line);
    expect(lines).toEqual(['compacting', 'phase line 1', 'phase line 2']);
  });

  it('does not read completed while the phase child is still alive', () => {
    compactThenSpawnPhase();
    mc.monitor.onStdoutChunk('run-1', 'working\n', PHASE.id);

    const state = mc.monitor.getCurrentState('run-1')!;
    expect(state.status).toBe('running');
    expect(state.exitCode).toBeNull();
  });

  it('keeps the stall detector armed after the helper exits', () => {
    compactThenSpawnPhase();
    mc.monitor.onStdoutChunk('run-1', 'working\n', PHASE.id);
    mc.advance(90_000);

    const state = mc.monitor.getCurrentState('run-1')!;
    expect(state.status).toBe('stalled');
    expect(state.detectedIssues).toContain('stall');
    expect(mc.audit.entries.find((e) => e.eventType === 'monitor-stall')).toBeDefined();
  });

  it('reports the helper\'s exit against the Run without ending the Run', () => {
    compactThenSpawnPhase();

    // Visible — a compaction that crashes is a fact about the Run, and swallowing it
    // would trade one silence for another.
    const helperExit = mc.audit.entries.find(
      (e) => (e.payload as { invocationId?: string } | undefined)?.invocationId === HELPER.id
    );
    expect(helperExit).toBeDefined();
    // But not terminal: no invocation-completed/failed/canceled, no summary.
    expect(terminalEvents()).toEqual([]);
    expect(mc.audit.entries.filter((e) => e.eventType === 'monitor-invocation-summary')).toHaveLength(0);
  });

  it('treats the phase invocation\'s exit as the Run\'s one terminal event', () => {
    compactThenSpawnPhase();
    mc.monitor.onStdoutChunk('run-1', 'working\n', PHASE.id);
    mc.monitor.onExit('run-1', FAILED, PHASE.id);

    const state = mc.monitor.getCurrentState('run-1')!;
    // The phase's outcome, not the helper's. Today this reads `completed` — the
    // compaction's exit code, reported as the Run's.
    expect(state.status).toBe('failed');
    expect(state.exitCode).toBe(1);
    expect(terminalEvents()).toEqual(['monitor-invocation-failed']);
    expect(mc.audit.entries.filter((e) => e.eventType === 'monitor-invocation-summary')).toHaveLength(1);
    expect(mc.fakeTimer.timers).toHaveLength(0);
  });

  // FR-018a — the instrumentation half. `cli-transport-sink.ts` was cleared as a
  // suspect from the field logs in minutes because it counts and reports its own
  // drops; the monitor could not be, because `if (!state || state.terminal) return;`
  // discarded six hours of output without leaving a single record that it had.
  it('counts declined chunks and reports them once per cause', () => {
    compactThenSpawnPhase();
    mc.monitor.onExit('run-1', OK, PHASE.id);
    mc.monitor.onStdoutChunk('run-1', 'after the end\n', PHASE.id);
    mc.monitor.onStderrChunk('run-1', 'also after the end\n', PHASE.id);

    const state = mc.monitor.getCurrentState('run-1')!;
    expect(state.declinedChunks).toBe(2);
    const declined = declinedEntries();
    expect(declined).toHaveLength(1);
    expect((declined[0]?.payload as { cause?: string } | undefined)?.cause).toBe('run-terminal');
  });

  // The other decline site, and the one the audit cannot hold: there is no Run to
  // file it under, so it goes to the host log — once, however many arrive.
  it('reports a chunk for an unknown Run rather than dropping it in silence', () => {
    mc.monitor.onStdoutChunk('run-never-started', 'orphan\n', PHASE.id);
    mc.monitor.onStdoutChunk('run-never-started', 'orphan again\n', PHASE.id);

    expect(mc.logger.warnings).toHaveLength(1);
    expect(mc.logger.warnings[0]).toContain('run-never-started');
    expect(declinedEntries()).toHaveLength(0);
    // Never the chunk's content: that belongs to the bounded transport sink alone.
    expect(mc.logger.warnings[0]).not.toContain('orphan');
  });

  // The inverse, and the reason T104 can revert the latch and watch this stay green:
  // a Run with no helper must behave exactly as it did before any of this landed.
  it('a Run whose whole life is one invocation is unchanged', () => {
    mc.monitor.onStart('run-1', 'speckit-review', null);
    mc.monitor.onSpawnPid('run-1', 502, PHASE);
    mc.monitor.onStdoutChunk('run-1', 'hello\n', PHASE.id);
    mc.monitor.onExit('run-1', OK, PHASE.id);

    const state = mc.monitor.getCurrentState('run-1')!;
    expect(state.status).toBe('completed');
    expect(state.pid).toBe(502);
    expect(state.stdoutLines).toBe(1);
    expect(terminalEvents()).toEqual(['monitor-invocation-completed']);
    expect(mc.audit.entries.filter((e) => e.eventType === 'monitor-invocation-summary')).toHaveLength(1);
    expect(mc.fakeTimer.timers).toHaveLength(0);

    // A duplicate exit for the adopted invocation is still suppressed.
    mc.monitor.onExit('run-1', FAILED, PHASE.id);
    expect(terminalEvents()).toEqual(['monitor-invocation-completed']);
  });
});

/**
 * Feature 211 (T011) — the approach record.
 *
 * Three timers bound a CLI invocation and all three were terminal-or-nothing.
 * A phase that keeps producing output resets the idle window on every chunk and
 * never reaches `MONITOR_STALL_THRESHOLD_MS`, so `maxDurationSeconds` used to
 * terminate it with nothing written beforehand — the field incident read as a
 * six-hour hang because that is exactly what the log showed.
 *
 * These tests drive the monitor's injectable clock and `setTimeout`, as the
 * stall tests above do. No real long-running child, and no six-hour fixture:
 * the bound under test is 100_000 ms and the threshold falls at 80_000.
 */
describe('ClaudeCliMonitor deadline-approach record (Feature 211)', () => {
  let mc: ReturnType<typeof makeMonitor>;
  beforeEach(() => {
    mc = makeMonitor();
  });

  const BOUND_MS = 100_000;
  const THRESHOLD_MS = 80_000;
  /** A phase invocation with a wall-clock bound in force. */
  const BOUNDED = { id: 'claude-cli#2', helperInvocation: false, maxDurationMs: BOUND_MS };
  /** The same invocation with no bound — the pre-152 idle-only shape. */
  const UNBOUNDED = { id: 'claude-cli#2', helperInvocation: false, maxDurationMs: null };
  const OK = { exitCode: 0, signal: null, killed: false, timedOut: false };

  function approachRecords(): Array<Partial<AuditEntry>> {
    return mc.audit.entries.filter((e) => e.eventType === 'monitor-deadline-approaching');
  }

  it('records the approach exactly once, at the threshold, carrying elapsed and the bound', () => {
    mc.monitor.onStart('run-1', 'speckit-review', null);
    mc.monitor.onSpawnPid('run-1', 501, BOUNDED);

    mc.advance(THRESHOLD_MS - 1);
    expect(approachRecords()).toHaveLength(0);

    mc.advance(1);
    const records = approachRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.outcome).toBe('info');
    expect(records[0]?.payload).toMatchObject({
      elapsedMs: THRESHOLD_MS,
      maxDurationMs: BOUND_MS,
      invocationId: BOUNDED.id,
      helperInvocation: false
    });
  });

  it('does not record a second time as the invocation runs on', () => {
    mc.monitor.onStart('run-1', 'speckit-review', null);
    mc.monitor.onSpawnPid('run-1', 501, BOUNDED);

    mc.advance(THRESHOLD_MS);
    expect(approachRecords()).toHaveLength(1);

    // Output keeps arriving and the clock keeps running: neither re-arms it.
    mc.monitor.onStdoutChunk('run-1', 'still working\n', BOUNDED.id);
    mc.advance(BOUND_MS);
    mc.advance(BOUND_MS);
    expect(approachRecords()).toHaveLength(1);
  });

  it('records nothing when the invocation exits before the threshold', () => {
    mc.monitor.onStart('run-1', 'speckit-review', null);
    mc.monitor.onSpawnPid('run-1', 501, BOUNDED);
    mc.advance(THRESHOLD_MS - 5_000);
    mc.monitor.onExit('run-1', OK, BOUNDED.id);

    // The timer is released on the terminal path, so time passing after the exit
    // cannot produce a warning about a deadline the invocation will never reach.
    mc.advance(BOUND_MS);
    expect(approachRecords()).toHaveLength(0);
    expect(mc.fakeTimer.timers).toHaveLength(0);
  });

  it('arms no timer and records nothing when no bound is in force', () => {
    mc.monitor.onStart('run-1', 'speckit-review', null);
    const before = mc.fakeTimer.timers.length;
    mc.monitor.onSpawnPid('run-1', 501, UNBOUNDED);
    expect(mc.fakeTimer.timers.length).toBe(before);

    mc.advance(BOUND_MS * 3);
    expect(approachRecords()).toHaveLength(0);
  });

  it('fires on wall-clock time across a suspension, unlike the stall detector', () => {
    mc.monitor.onStart('run-1', 'speckit-review', null);
    mc.monitor.onSpawnPid('run-1', 501, BOUNDED);

    // Suspended for most of the window. The stall detector banks this time and
    // resumes where it left off; the absolute deadline does not, and neither may
    // the warning that predicts it — a warning that arrived after the kill would
    // be worse than none.
    mc.monitor.onWorkflowPaused('run-1');
    mc.advance(THRESHOLD_MS);
    expect(approachRecords()).toHaveLength(1);
    expect(approachRecords()[0]?.payload).toMatchObject({ maxDurationMs: BOUND_MS });

    mc.monitor.onWorkflowResumed('run-1');
    mc.advance(BOUND_MS);
    expect(approachRecords()).toHaveLength(1);
  });

  it('measures the elapsed it observed, not the nominal threshold', () => {
    mc.monitor.onStart('run-1', 'speckit-review', null);
    mc.monitor.onSpawnPid('run-1', 501, BOUNDED);

    // The fake timer fires on the first advance at or past its due time, so a
    // coarse advance lands late — exactly as a busy event loop does. The record
    // must report what the clock said, so an operator can check the arithmetic
    // rather than trust it (FR-002).
    mc.advance(THRESHOLD_MS + 1_500);
    expect(approachRecords()[0]?.payload).toMatchObject({ elapsedMs: THRESHOLD_MS + 1_500 });
  });

  it('distinguishes a helper invocation from the phase invocation', () => {
    const helper = { id: 'claude-cli#1', helperInvocation: true, maxDurationMs: BOUND_MS };
    mc.monitor.onStart('run-1', 'speckit-review', null);
    mc.monitor.onSpawnPid('run-1', 500, helper);
    mc.advance(THRESHOLD_MS);

    const records = approachRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toMatchObject({
      invocationId: helper.id,
      helperInvocation: true
    });
  });

  it('flips deadlineApproaching on the projected state when the phase invocation crosses', () => {
    mc.monitor.onStart('run-1', 'speckit-review', null);
    mc.monitor.onSpawnPid('run-1', 501, BOUNDED);
    expect(mc.monitor.getCurrentState()?.deadlineApproaching).toBe(false);

    mc.advance(THRESHOLD_MS);
    expect(mc.monitor.getCurrentState()?.deadlineApproaching).toBe(true);
    expect(mc.monitor.getCurrentState()?.maxDurationMs).toBe(BOUND_MS);
  });

  it('a helper crossing its own bound leaves the Run flag alone', () => {
    // The flag describes the invocation the Run will be killed with, and the
    // helper is not it. A surface reading "approaching its deadline" because a
    // 10 s compaction crossed 8 s would be worse than no flag.
    const helper = { id: 'claude-cli#1', helperInvocation: true, maxDurationMs: 10_000 };
    mc.monitor.onStart('run-1', 'speckit-review', null);
    mc.monitor.onSpawnPid('run-1', 500, helper);
    mc.advance(8_000);

    expect(approachRecords()).toHaveLength(1);
    expect(mc.monitor.getCurrentState()?.deadlineApproaching).toBe(false);
  });

  it('a helper crossing its own bound does not consume the phase invocation latch', () => {
    // The pre-phase compaction is bounded at 60s while the phase it precedes has
    // six hours. One latch per Run would let the helper's approach suppress the
    // phase's — the record that actually matters.
    const helper = { id: 'claude-cli#1', helperInvocation: true, maxDurationMs: 10_000 };
    mc.monitor.onStart('run-1', 'speckit-review', null);
    mc.monitor.onSpawnPid('run-1', 500, helper);
    mc.monitor.onSpawnPid('run-1', 501, BOUNDED);

    mc.advance(8_000);
    expect(approachRecords()).toHaveLength(1);

    mc.advance(THRESHOLD_MS - 8_000);
    const records = approachRecords();
    expect(records).toHaveLength(2);
    expect(records[1]?.payload).toMatchObject({
      invocationId: BOUNDED.id,
      helperInvocation: false,
      maxDurationMs: BOUND_MS
    });
  });
});

// FR-R3-208 (T1893) — a hold the runner reports is not a stall.
describe('ClaudeCliMonitor background hold (FR-R3-208, T1893)', () => {
  let mc: ReturnType<typeof makeMonitor>;
  beforeEach(() => {
    mc = makeMonitor();
  });

  const STALL_MS = 90_000;
  const ID = 'run-1';
  /** The Run's own invocation, the one a hold is reported against. */
  const OWN = { id: 'claude-cli#1', helperInvocation: false, maxDurationMs: null };
  const HELPER = { id: 'claude-cli#1', helperInvocation: true, maxDurationMs: null };
  const PHASE = { id: 'claude-cli#2', helperInvocation: false, maxDurationMs: null };
  const OK = { exitCode: 0, signal: null, killed: false, timedOut: false };

  function startRun(runId: string, invocation = OWN): void {
    mc.monitor.onStart(runId, 'speckit-implement', null);
    mc.monitor.onSpawnPid(runId, 501, invocation);
  }

  function rowsOf(eventType: string, runId: string): Array<Partial<AuditEntry>> {
    return mc.audit.entries.filter((e) => e.eventType === eventType && e.runId === runId);
  }

  const stallRows = (runId = ID): number => rowsOf('monitor-stall', runId).length;

  it('declares no stall and writes no stall row while held, and a sibling Run still does (H1)', () => {
    startRun('run-a');
    startRun('run-b');
    mc.monitor.onStdoutChunk('run-a', 'line\n', OWN.id);
    mc.monitor.onStdoutChunk('run-b', 'line\n', OWN.id);

    mc.monitor.onBackgroundHold('run-a', true);
    mc.advance(120_000);

    expect(stallRows('run-a')).toBe(0);
    expect(rowsOf('pause', 'run-a')).toHaveLength(0);
    const held = mc.monitor.getCurrentState('run-a')!;
    expect(held.status).toBe('running');
    expect(held.held).toBe(true);
    expect(held.detectedIssues).not.toContain('stall');

    mc.monitor.onExit('run-a', OK, OWN.id);
    const completed = rowsOf('monitor-invocation-completed', 'run-a');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload).toMatchObject({ durationMs: 120_000 });
    const summary = rowsOf('monitor-invocation-summary', 'run-a');
    expect(summary).toHaveLength(1);
    expect(
      (summary[0]?.payload as { detectedIssues: ReadonlyArray<string> }).detectedIssues
    ).not.toContain('stall');

    // The control: the sibling that was not held stalled once, as before.
    expect(stallRows('run-b')).toBe(1);
  });

  it('counts the full threshold again from the hold ending (H2)', () => {
    startRun(ID);
    mc.monitor.onStdoutChunk(ID, 'line\n', OWN.id);
    mc.monitor.onBackgroundHold(ID, true);
    mc.advance(120_000);
    expect(stallRows()).toBe(0);

    mc.monitor.onBackgroundHold(ID, false);
    expect(mc.monitor.getCurrentState(ID)!.held).toBe(false);
    mc.advance(STALL_MS - 1);
    expect(stallRows()).toBe(0);
    mc.advance(1);
    expect(stallRows()).toBe(1);
  });

  it('keeps a hold quiet across a workflow pause, then counts from its ending (H3)', () => {
    startRun(ID);
    mc.monitor.onStdoutChunk(ID, 'line\n', OWN.id);
    mc.monitor.onBackgroundHold(ID, true);
    mc.monitor.onWorkflowPaused(ID);
    mc.advance(60_000);
    mc.monitor.onWorkflowResumed(ID);
    mc.advance(120_000);
    expect(stallRows()).toBe(0);

    mc.monitor.onBackgroundHold(ID, false);
    mc.advance(STALL_MS);
    expect(stallRows()).toBe(1);
  });

  it('counts the full threshold from the resume when a hold ends during a pause (H4)', () => {
    startRun(ID);
    mc.monitor.onStdoutChunk(ID, 'line\n', OWN.id);
    mc.monitor.onBackgroundHold(ID, true);
    mc.monitor.onWorkflowPaused(ID);
    mc.monitor.onBackgroundHold(ID, false);
    mc.advance(200_000);
    expect(stallRows()).toBe(0);

    mc.monitor.onWorkflowResumed(ID);
    mc.advance(STALL_MS - 1);
    expect(stallRows()).toBe(0);
    mc.advance(1);
    expect(stallRows()).toBe(1);
  });

  it('does not carry a hold into the next invocation of the same Run id (H5)', () => {
    startRun(ID);
    mc.monitor.onStdoutChunk(ID, 'line\n', OWN.id);
    mc.monitor.onBackgroundHold(ID, true);

    mc.monitor.onExit(ID, OK, OWN.id);
    expect(mc.monitor.getCurrentState(ID)?.held ?? false).toBe(false);
    expect(stallRows()).toBe(0);

    mc.monitor.onStart(ID, 'speckit-implement', null);
    mc.monitor.onSpawnPid(ID, 501, { id: 'claude-cli#2', helperInvocation: false, maxDurationMs: null });
    mc.advance(STALL_MS);
    expect(stallRows()).toBe(1);
  });

  it('releases a hold when the helper that was holding exits (H6)', () => {
    mc.monitor.onStart(ID, 'speckit-implement', null);
    mc.monitor.onSpawnPid(ID, 501, HELPER);
    mc.monitor.onStdoutChunk(ID, 'compacting\n', HELPER.id);
    mc.monitor.onBackgroundHold(ID, true);
    mc.advance(100_000);
    expect(stallRows()).toBe(0);

    mc.monitor.onExit(ID, OK, HELPER.id);
    mc.advance(STALL_MS - 1);
    expect(stallRows()).toBe(0);
    mc.advance(1);
    expect(stallRows()).toBe(1);
  });

  it('releases a hold when the Run spawns the phase invocation (H7)', () => {
    mc.monitor.onStart(ID, 'speckit-implement', null);
    mc.monitor.onSpawnPid(ID, 501, HELPER);
    mc.monitor.onStdoutChunk(ID, 'compacting\n', HELPER.id);
    mc.monitor.onBackgroundHold(ID, true);

    mc.monitor.onSpawnPid(ID, 502, PHASE);
    expect(mc.monitor.getCurrentState(ID)!.held).toBe(false);
    mc.advance(STALL_MS);
    expect(stallRows()).toBe(1);
  });

  it('ignores a release with no hold, repeated holds and unknown Runs, and notifies once per change (H8)', () => {
    startRun(ID);
    mc.monitor.onStdoutChunk(ID, 'line\n', OWN.id);

    // An unmatched release re-arms nothing: the original count still falls at 90 s.
    mc.advance(50_000);
    mc.monitor.onBackgroundHold(ID, false);
    mc.advance(40_000);
    expect(stallRows()).toBe(1);

    let notified = 0;
    const subscription = mc.monitor.subscribe(() => {
      notified += 1;
    });
    mc.monitor.onBackgroundHold(ID, true);
    mc.monitor.onBackgroundHold(ID, true);
    expect(mc.monitor.getCurrentState(ID)!.held).toBe(true);
    expect(notified).toBe(1);
    mc.monitor.onBackgroundHold(ID, false);
    expect(mc.monitor.getCurrentState(ID)!.held).toBe(false);
    expect(notified).toBe(2);
    subscription.dispose();

    expect(() => mc.monitor.onBackgroundHold('nope', true)).not.toThrow();
    expect(() => mc.monitor.onBackgroundHold(null, true)).not.toThrow();
    expect(mc.monitor.getCurrentState('nope')).toBeNull();

    mc.monitor.onBackgroundHold(ID, true);
    mc.monitor.onExit(ID, OK, OWN.id);
    expect(mc.monitor.getCurrentState(ID)?.held ?? false).toBe(false);
  });
});
