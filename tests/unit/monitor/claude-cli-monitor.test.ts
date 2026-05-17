import { describe, it, expect, beforeEach } from 'vitest';
import { ClaudeCliMonitor } from '../../../src/monitor/claude-cli-monitor';
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
  public sanitize = (s: string): string => s;
  public warn = (_msg: string): void => { /* swallow */ };
}

const RATE_LIMIT_MATCHERS = [
  { regex: /429.*too many requests/i, cause: 'rate-limit-429' }
];

function makeMonitor(): {
  monitor: ClaudeCliMonitor;
  clock: FakeClock;
  fakeTimer: FakeSetTimeout;
  audit: FakeAudit;
  advance: (ms: number) => void;
} {
  const clock = new FakeClock();
  const fakeTimer = new FakeSetTimeout(clock);
  const audit = new FakeAudit();
  const logger = new FakeLogger();
  const monitor = new ClaudeCliMonitor({
    stallThresholdMs: 90_000,
    rateLimitMatchers: RATE_LIMIT_MATCHERS,
    monotonicNow: () => clock.now(),
    now: () => new Date('2026-05-10T12:00:00.000Z'),
    audit,
    logger,
    setTimeout: fakeTimer.setTimeoutFn,
    clearTimeout: fakeTimer.clearTimeoutFn,
    rateLimitClusterMs: 5_000
  });
  const advance = (ms: number): void => {
    clock.advance(ms);
    fakeTimer.fireDue();
  };
  return { monitor, clock, fakeTimer, audit, advance };
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
    mc.monitor.onStdoutChunk('hello\n');
    const state = mc.monitor.getCurrentState()!;
    expect(state.status).toBe('running');
    expect(state.stdoutLines).toBe(1);
  });

  it('lines without trailing newline are buffered until next chunk', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onStdoutChunk('partial');
    expect(mc.monitor.getCurrentState()!.stdoutLines).toBe(0);
    mc.monitor.onStdoutChunk('-line\nnext\n');
    expect(mc.monitor.getCurrentState()!.stdoutLines).toBe(2);
  });

  it('90s of silence transitions to stalled and emits stall event', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onStdoutChunk('hi\n');
    mc.advance(90_000);
    const state = mc.monitor.getCurrentState()!;
    expect(state.status).toBe('stalled');
    expect(state.detectedIssues).toContain('stall');
    expect(mc.audit.entries.find((e) => e.eventType === 'monitor-stall')).toBeDefined();
  });

  it('stderr activity during silence does NOT reset stall timer', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onStdoutChunk('hi\n');
    mc.advance(50_000);
    mc.monitor.onStderrChunk('warn\n');
    mc.advance(40_000);
    expect(mc.monitor.getCurrentState()!.status).toBe('stalled');
  });

  it('stdout chunk after stalled returns to running', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onStdoutChunk('hi\n');
    mc.advance(90_000);
    expect(mc.monitor.getCurrentState()!.status).toBe('stalled');
    mc.monitor.onStdoutChunk('back\n');
    expect(mc.monitor.getCurrentState()!.status).toBe('running');
  });

  it('onWorkflowPaused while running shows derived paused status and suspends timer', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onStdoutChunk('hi\n');
    mc.monitor.onWorkflowPaused();
    expect(mc.monitor.getCurrentState()!.status).toBe('paused');
    mc.advance(120_000);
    expect(mc.monitor.getCurrentState()!.status).toBe('paused');
  });

  it('onWorkflowResumed re-arms stall timer without counting paused interval', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onStdoutChunk('hi\n');
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
    mc.monitor.onExit({ exitCode: 0, signal: null, killed: false, timedOut: false });
    expect(mc.monitor.getCurrentState()!.status).toBe('completed');
    expect(mc.audit.entries.find((e) => e.eventType === 'monitor-invocation-completed')).toBeDefined();
    expect(mc.audit.entries.find((e) => e.eventType === 'monitor-invocation-summary')).toBeDefined();
  });

  it('onExit(1,null,false,false) -> failed', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onExit({ exitCode: 1, signal: null, killed: false, timedOut: false });
    expect(mc.monitor.getCurrentState()!.status).toBe('failed');
    expect(mc.audit.entries.find((e) => e.eventType === 'monitor-invocation-failed')).toBeDefined();
  });

  it('onExit(null,SIGTERM,true,false) -> canceled', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onExit({ exitCode: null, signal: 'SIGTERM', killed: true, timedOut: false });
    expect(mc.monitor.getCurrentState()!.status).toBe('canceled');
    expect(mc.audit.entries.find((e) => e.eventType === 'monitor-invocation-canceled')).toBeDefined();
  });

  it('onExit(null,SIGTERM,false,true) -> timed_out and emits invocation-failed', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onExit({ exitCode: null, signal: 'SIGTERM', killed: false, timedOut: true });
    expect(mc.monitor.getCurrentState()!.status).toBe('timed_out');
    expect(mc.audit.entries.find((e) => e.eventType === 'monitor-invocation-failed')).toBeDefined();
  });

  it('rate-limit pattern emits exactly once within cluster window', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onStderrChunk('429 too many requests\n');
    mc.monitor.onStderrChunk('429 too many requests\n');
    mc.monitor.onStderrChunk('429 too many requests\n');
    const events = mc.audit.entries.filter((e) => e.eventType === 'monitor-rate-limited');
    expect(events).toHaveLength(1);
  });

  it('rate-limit re-emits after cluster window elapses', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onStderrChunk('429 too many requests\n');
    mc.advance(6_000);
    mc.monitor.onStderrChunk('429 too many requests\n');
    const events = mc.audit.entries.filter((e) => e.eventType === 'monitor-rate-limited');
    expect(events).toHaveLength(2);
  });

  it('duplicate exit emissions are suppressed', () => {
    mc.monitor.onStart('run-1', 'speckit-specify', 1);
    mc.monitor.onExit({ exitCode: 0, signal: null, killed: false, timedOut: false });
    mc.monitor.onExit({ exitCode: 1, signal: null, killed: false, timedOf: false } as unknown as { exitCode: number; signal: null; killed: boolean; timedOut: boolean });
    const completed = mc.audit.entries.filter((e) => e.eventType === 'monitor-invocation-completed');
    const failed = mc.audit.entries.filter((e) => e.eventType === 'monitor-invocation-failed');
    expect(completed).toHaveLength(1);
    expect(failed).toHaveLength(0);
  });
});
