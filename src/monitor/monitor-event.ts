import type { PhaseName } from '../contracts/phase-identity';

interface BaseFields {
  readonly runId: string;
  readonly phase: PhaseName;
  readonly at: string;
  readonly atMonotonic: number;
}

export interface InvocationStartedEvent extends BaseFields {
  readonly kind: 'invocation_started';
  readonly pid: number | null;
}

export interface StdoutLineEvent extends BaseFields {
  readonly kind: 'stdout_line';
  readonly line: string;
}

export interface StderrLineEvent extends BaseFields {
  readonly kind: 'stderr_line';
  readonly line: string;
}

export interface ProgressDetectedEvent extends BaseFields {
  readonly kind: 'progress_detected';
  readonly summary: string;
}

export interface StallWarningEvent extends BaseFields {
  readonly kind: 'stall_warning';
  readonly msSinceLastStdout: number;
}

export interface RateLimitedEvent extends BaseFields {
  readonly kind: 'rate_limited';
  readonly cause: string;
}

export interface InvocationCompletedEvent extends BaseFields {
  readonly kind: 'invocation_completed';
  readonly exitCode: number;
  readonly signal: string | null;
  readonly durationMs: number;
}

export interface InvocationFailedEvent extends BaseFields {
  readonly kind: 'invocation_failed';
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly reason: 'non_zero_exit' | 'timed_out' | 'spawn_error';
  readonly durationMs: number;
}

export interface InvocationCanceledEvent extends BaseFields {
  readonly kind: 'invocation_canceled';
  readonly signal: string | null;
  readonly durationMs: number;
}

export interface InvocationSummaryEvent extends BaseFields {
  readonly kind: 'invocation_summary';
  readonly status: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdoutLines: number;
  readonly stderrLines: number;
  readonly detectedIssues: ReadonlyArray<'rate_limited' | 'stall'>;
}

export type MonitorEvent =
  | InvocationStartedEvent
  | StdoutLineEvent
  | StderrLineEvent
  | ProgressDetectedEvent
  | StallWarningEvent
  | RateLimitedEvent
  | InvocationCompletedEvent
  | InvocationFailedEvent
  | InvocationCanceledEvent
  | InvocationSummaryEvent;

export interface EventClock {
  readonly now: () => string;
  readonly monotonicNow: () => number;
}

export function makeInvocationStarted(args: { runId: string; phase: PhaseName; pid: number | null; clock: EventClock }): InvocationStartedEvent {
  return Object.freeze({
    kind: 'invocation_started' as const,
    runId: args.runId,
    phase: args.phase,
    pid: args.pid,
    at: args.clock.now(),
    atMonotonic: args.clock.monotonicNow()
  });
}

export function makeStdoutLine(args: { runId: string; phase: PhaseName; line: string; clock: EventClock }): StdoutLineEvent {
  return Object.freeze({
    kind: 'stdout_line' as const,
    runId: args.runId,
    phase: args.phase,
    line: args.line,
    at: args.clock.now(),
    atMonotonic: args.clock.monotonicNow()
  });
}

export function makeStderrLine(args: { runId: string; phase: PhaseName; line: string; clock: EventClock }): StderrLineEvent {
  return Object.freeze({
    kind: 'stderr_line' as const,
    runId: args.runId,
    phase: args.phase,
    line: args.line,
    at: args.clock.now(),
    atMonotonic: args.clock.monotonicNow()
  });
}

export function makeProgressDetected(args: { runId: string; phase: PhaseName; summary: string; clock: EventClock }): ProgressDetectedEvent {
  return Object.freeze({
    kind: 'progress_detected' as const,
    runId: args.runId,
    phase: args.phase,
    summary: args.summary,
    at: args.clock.now(),
    atMonotonic: args.clock.monotonicNow()
  });
}

export function makeStallWarning(args: { runId: string; phase: PhaseName; msSinceLastStdout: number; clock: EventClock }): StallWarningEvent {
  return Object.freeze({
    kind: 'stall_warning' as const,
    runId: args.runId,
    phase: args.phase,
    msSinceLastStdout: args.msSinceLastStdout,
    at: args.clock.now(),
    atMonotonic: args.clock.monotonicNow()
  });
}

export function makeRateLimited(args: { runId: string; phase: PhaseName; cause: string; clock: EventClock }): RateLimitedEvent {
  return Object.freeze({
    kind: 'rate_limited' as const,
    runId: args.runId,
    phase: args.phase,
    cause: args.cause,
    at: args.clock.now(),
    atMonotonic: args.clock.monotonicNow()
  });
}

export function makeInvocationCompleted(args: {
  runId: string;
  phase: PhaseName;
  exitCode: number;
  signal: string | null;
  durationMs: number;
  clock: EventClock;
}): InvocationCompletedEvent {
  return Object.freeze({
    kind: 'invocation_completed' as const,
    runId: args.runId,
    phase: args.phase,
    exitCode: args.exitCode,
    signal: args.signal,
    durationMs: args.durationMs,
    at: args.clock.now(),
    atMonotonic: args.clock.monotonicNow()
  });
}

export function makeInvocationFailed(args: {
  runId: string;
  phase: PhaseName;
  exitCode: number | null;
  signal: string | null;
  reason: 'non_zero_exit' | 'timed_out' | 'spawn_error';
  durationMs: number;
  clock: EventClock;
}): InvocationFailedEvent {
  return Object.freeze({
    kind: 'invocation_failed' as const,
    runId: args.runId,
    phase: args.phase,
    exitCode: args.exitCode,
    signal: args.signal,
    reason: args.reason,
    durationMs: args.durationMs,
    at: args.clock.now(),
    atMonotonic: args.clock.monotonicNow()
  });
}

export function makeInvocationCanceled(args: {
  runId: string;
  phase: PhaseName;
  signal: string | null;
  durationMs: number;
  clock: EventClock;
}): InvocationCanceledEvent {
  return Object.freeze({
    kind: 'invocation_canceled' as const,
    runId: args.runId,
    phase: args.phase,
    signal: args.signal,
    durationMs: args.durationMs,
    at: args.clock.now(),
    atMonotonic: args.clock.monotonicNow()
  });
}

export function makeInvocationSummary(args: {
  runId: string;
  phase: PhaseName;
  status: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  stdoutLines: number;
  stderrLines: number;
  detectedIssues: ReadonlyArray<'rate_limited' | 'stall'>;
  clock: EventClock;
}): InvocationSummaryEvent {
  return Object.freeze({
    kind: 'invocation_summary' as const,
    runId: args.runId,
    phase: args.phase,
    status: args.status,
    durationMs: args.durationMs,
    exitCode: args.exitCode,
    signal: args.signal,
    stdoutLines: args.stdoutLines,
    stderrLines: args.stderrLines,
    detectedIssues: Object.freeze(args.detectedIssues.slice()),
    at: args.clock.now(),
    atMonotonic: args.clock.monotonicNow()
  });
}
