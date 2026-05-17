import { describe, it, expect } from 'vitest';
import {
  makeInvocationStarted,
  makeStdoutLine,
  makeStderrLine,
  makeProgressDetected,
  makeStallWarning,
  makeRateLimited,
  makeInvocationCompleted,
  makeInvocationFailed,
  makeInvocationCanceled,
  makeInvocationSummary,
  type EventClock,
  type MonitorEvent
} from '../../../src/monitor/monitor-event';

const fixedNow = '2026-05-10T12:00:00.000Z';
const clock: EventClock = {
  now: () => fixedNow,
  monotonicNow: () => 1_234.5
};

describe('monitor-event factories', () => {
  it('produces a discriminated union covering each kind', () => {
    const started = makeInvocationStarted({ runId: 'r1', phase: 'speckit-specify', pid: 100, clock });
    const stdout = makeStdoutLine({ runId: 'r1', phase: 'speckit-specify', line: 'hello', clock });
    const stderr = makeStderrLine({ runId: 'r1', phase: 'speckit-specify', line: 'oops', clock });
    const progress = makeProgressDetected({ runId: 'r1', phase: 'speckit-specify', summary: '50%', clock });
    const stall = makeStallWarning({ runId: 'r1', phase: 'speckit-specify', msSinceLastStdout: 95_000, clock });
    const rate = makeRateLimited({ runId: 'r1', phase: 'speckit-specify', cause: 'rate-limit', clock });
    const completed = makeInvocationCompleted({
      runId: 'r1', phase: 'speckit-specify', exitCode: 0, signal: null, durationMs: 1_000, clock
    });
    const failed = makeInvocationFailed({
      runId: 'r1', phase: 'speckit-specify', exitCode: 1, signal: null, reason: 'non_zero_exit', durationMs: 1_000, clock
    });
    const canceled = makeInvocationCanceled({
      runId: 'r1', phase: 'speckit-specify', signal: 'SIGTERM', durationMs: 1_000, clock
    });
    const summary = makeInvocationSummary({
      runId: 'r1',
      phase: 'speckit-specify',
      status: 'completed',
      durationMs: 1_000,
      exitCode: 0,
      signal: null,
      stdoutLines: 1,
      stderrLines: 0,
      detectedIssues: [],
      clock
    });
    const events: ReadonlyArray<MonitorEvent> = [
      started, stdout, stderr, progress, stall, rate, completed, failed, canceled, summary
    ];
    expect(events.length).toBe(10);
    expect(started.kind).toBe('invocation_started');
    expect(stdout.kind).toBe('stdout_line');
    expect(stderr.kind).toBe('stderr_line');
    expect(progress.kind).toBe('progress_detected');
    expect(stall.kind).toBe('stall_warning');
    expect(rate.kind).toBe('rate_limited');
    expect(completed.kind).toBe('invocation_completed');
    expect(failed.kind).toBe('invocation_failed');
    expect(canceled.kind).toBe('invocation_canceled');
    expect(summary.kind).toBe('invocation_summary');
  });

  it('every event carries runId, phase, at, atMonotonic', () => {
    const started = makeInvocationStarted({ runId: 'r1', phase: 'speckit-plan', pid: null, clock });
    expect(started.runId).toBe('r1');
    expect(started.phase).toBe('speckit-plan');
    expect(started.at).toBe(fixedNow);
    expect(started.atMonotonic).toBe(1_234.5);
  });

  it('invocation_completed carries exitCode, signal, durationMs', () => {
    const completed = makeInvocationCompleted({
      runId: 'r1', phase: 'speckit-specify', exitCode: 0, signal: null, durationMs: 2_500, clock
    });
    expect(completed.exitCode).toBe(0);
    expect(completed.signal).toBe(null);
    expect(completed.durationMs).toBe(2_500);
  });

  it('invocation_failed carries reason discriminator', () => {
    const f1 = makeInvocationFailed({
      runId: 'r1', phase: 'speckit-specify', exitCode: 1, signal: null, reason: 'non_zero_exit', durationMs: 100, clock
    });
    const f2 = makeInvocationFailed({
      runId: 'r1', phase: 'speckit-specify', exitCode: null, signal: null, reason: 'timed_out', durationMs: 100, clock
    });
    const f3 = makeInvocationFailed({
      runId: 'r1', phase: 'speckit-specify', exitCode: null, signal: null, reason: 'spawn_error', durationMs: 100, clock
    });
    expect(f1.reason).toBe('non_zero_exit');
    expect(f2.reason).toBe('timed_out');
    expect(f3.reason).toBe('spawn_error');
  });

  it('stall_warning carries msSinceLastStdout >= 90_000', () => {
    const stall = makeStallWarning({
      runId: 'r1', phase: 'speckit-specify', msSinceLastStdout: 95_000, clock
    });
    expect(stall.msSinceLastStdout).toBeGreaterThanOrEqual(90_000);
  });

  it('events are frozen', () => {
    const ev = makeStdoutLine({ runId: 'r1', phase: 'speckit-specify', line: 'x', clock });
    expect(Object.isFrozen(ev)).toBe(true);
  });
});
