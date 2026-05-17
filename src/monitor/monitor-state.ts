import type { PhaseName } from '../ui/sidebar/snapshot';

export type MonitorStatus =
  | 'starting'
  | 'running'
  | 'stalled'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'canceled'
  | 'paused';

export interface CliMonitorState {
  readonly runId: string;
  readonly phase: PhaseName;
  readonly status: MonitorStatus;
  readonly pid: number | null;
  readonly startedAt: string;
  readonly lastStdoutAt: string | null;
  readonly lastStderrAt: string | null;
  readonly lastProgressAt: string | null;
  readonly stdoutLines: number;
  readonly stderrLines: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly detectedIssues: ReadonlyArray<'rate_limited' | 'stall'>;
  readonly msSinceLastStdout: number | null;
  readonly msSinceLastStderr: number | null;
}

export function buildIdleMonitorState(runId: string, phase: PhaseName, startedAt: string): CliMonitorState {
  return Object.freeze({
    runId,
    phase,
    status: 'starting' as const,
    pid: null,
    startedAt,
    lastStdoutAt: null,
    lastStderrAt: null,
    lastProgressAt: null,
    stdoutLines: 0,
    stderrLines: 0,
    exitCode: null,
    signal: null,
    detectedIssues: Object.freeze([]) as ReadonlyArray<'rate_limited' | 'stall'>,
    msSinceLastStdout: null,
    msSinceLastStderr: null
  });
}
