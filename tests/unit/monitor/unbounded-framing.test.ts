import { describe, it, expect } from 'vitest';
import { ClaudeCliMonitor } from '../../../src/monitor/claude-cli-monitor';

/**
 * FR-R3-052 (H-03) — a logical line has no bound.
 *
 * `splitLines` returns the ENTIRE buffer as the remainder when it finds no
 * newline, and the caller assigns that remainder straight back to
 * `state.stdoutBuffer`. So a stream that never emits a newline accumulates every
 * byte the CLI has produced, in one string, for the life of the invocation. The
 * 64 MiB compressed capture bound does not help: it bounds what is CAPTURED, not
 * what the framer retains while deciding what a line is.
 *
 * The oracle is the retained buffer's own length, read from monitor state. Heap
 * sampling would measure the garbage collector's mood as much as the defect.
 */
const RUN = 'run-framing';

function monitorUnderTest(): ClaudeCliMonitor {
  let t = 1_000;
  return new ClaudeCliMonitor({
    stallThresholdMs: 90_000,
    rateLimitMatchers: [],
    monotonicNow: () => (t += 1),
    now: () => new Date('2026-08-24T00:00:00.000Z'),
    audit: { append: async () => undefined } as never,
    transport: { record: () => {} } as never,
    activity: { record: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    setTimeout: () => 1 as unknown as NodeJS.Timeout,
    clearTimeout: () => {},
    rateLimitClusterMs: 5_000
  });
}

/** The retained framing buffer for a run, read off monitor state. */
function retained(monitor: ClaudeCliMonitor, runId: string): number {
  const states = (monitor as unknown as { states: Map<string, { stdoutBuffer: string }> }).states;
  return states.get(runId)?.stdoutBuffer.length ?? -1;
}

describe('the monitor bounds what it retains while framing (H-03)', () => {
  it('does not retain an unbounded newline-free record', () => {
    const monitor = monitorUnderTest();
    monitor.onStart(RUN, 'implement' as never, 4242);

    // 8 MiB of newline-free output, the shape a single huge JSON record takes.
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 128; i += 1) monitor.onStdoutChunk(RUN, chunk);

    const held = retained(monitor, RUN);
    expect(held).toBeGreaterThanOrEqual(0);
    // Any bound at all. 1 MiB is generous for one logical line and still two
    // orders of magnitude below what an unbounded framer holds here.
    expect(held).toBeLessThanOrEqual(1024 * 1024);
  });

  it('still frames a conforming stream exactly as before', () => {
    const monitor = monitorUnderTest();
    monitor.onStart(RUN, 'implement' as never, 4242);
    monitor.onStdoutChunk(RUN, 'one\ntwo\nthr');
    monitor.onStdoutChunk(RUN, 'ee\n');
    expect(retained(monitor, RUN)).toBe(0);
  });
});

describe('the monitor bounds retained per-run state (M-10)', () => {
  const stateCount = (monitor: ClaudeCliMonitor): number =>
    (monitor as unknown as { states: Map<string, unknown> }).states.size;

  it('does not grow its state map without bound across completed runs', () => {
    // A long-lived host session. Every run was retained until `dispose()`, so
    // the map grew for as long as the extension stayed loaded.
    const monitor = monitorUnderTest();
    for (let i = 0; i < 500; i += 1) {
      const id = `run-${i}`;
      monitor.onStart(id, 'implement' as never, 1000 + i);
      monitor.onStdoutChunk(id, 'work\n');
      monitor.onExit(id, { exitCode: 0, signal: null, killed: false, timedOut: false });
    }
    expect(stateCount(monitor)).toBeLessThanOrEqual(64);
  });

  it('keeps the most recent completed run readable', () => {
    // The bound must not cost the sidebar the state it displays after a run ends.
    const monitor = monitorUnderTest();
    for (let i = 0; i < 100; i += 1) {
      const id = `run-${i}`;
      monitor.onStart(id, 'implement' as never, 1000 + i);
      monitor.onExit(id, { exitCode: 0, signal: null, killed: false, timedOut: false });
    }
    expect(monitor.getCurrentState('run-99')).not.toBeNull();
  });

  it('releases a completed run framing buffer instead of holding it', () => {
    const monitor = monitorUnderTest();
    monitor.onStart('held', 'implement' as never, 7);
    monitor.onStdoutChunk('held', 'x'.repeat(500 * 1024));
    expect(retained(monitor, 'held')).toBeGreaterThan(0);
    monitor.onExit('held', { exitCode: 0, signal: null, killed: false, timedOut: false });
    // The partial line is not coming back: the process has exited. Holding half a
    // megabyte per completed run for the life of the session buys nothing.
    expect(retained(monitor, 'held')).toBe(0);
  });
});
