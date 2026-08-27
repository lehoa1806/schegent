// Feature 033 — Aggressive Phase Pausing and Process Telemetry.
//
// Ephemeral per-subprocess telemetry record carried on the
// `WorkflowSnapshot.telemetry` field. Never persisted to WorkflowRun, never
// written to the audit log. Lives only on the live snapshot envelope; the

// FR-R3-132 (T1502) — moved to `src/contracts/snapshot-vocabulary.ts` so the webview
// imports them instead of restating them. Re-exported unchanged.
import type { TelemetryStatus, TelemetrySnapshot } from '../contracts/snapshot-vocabulary';

export type { TelemetryStatus, TelemetrySnapshot };

// projection clears to `null` one publish after the runner's `exited` hook.
//
// This module has NO `vscode` import and no I/O. It MUST be safe to load
// from `src/telemetry/`, which is policed by
// `tests/lint/no-vscode-import-in-telemetry.test.ts`.

export const TELEMETRY_SAMPLE_INTERVAL_MS = 2000 as const;





export interface ExitSampleArgs {
  readonly pid: number;
  readonly signal: NodeJS.Signals | null;
  readonly startedAt: number;
  readonly now: number;
  readonly lastLive: Pick<TelemetrySnapshot, 'cpuPercent' | 'memoryRssBytes'> | null;
}

/**
 * Synthesize the final telemetry sample after the runner's `exited` hook
 * fires. Re-uses the sampler's last live cache for the numeric fields when
 * available; otherwise the numeric fields are `null`.
 *
 * @returns A frozen `TelemetrySnapshot` with `status: 'killed'` when the
 *          runner reported a non-null signal (signal-terminated), or
 *          `status: 'exited'` for natural completion.
 */
export function synthesizeExitSample(args: ExitSampleArgs): TelemetrySnapshot {
  const status: TelemetryStatus = args.signal !== null ? 'killed' : 'exited';
  const uptimeMs = Math.max(0, args.now - args.startedAt);
  return Object.freeze({
    pid: args.pid,
    status,
    cpuPercent: args.lastLive?.cpuPercent ?? null,
    memoryRssBytes: args.lastLive?.memoryRssBytes ?? null,
    uptimeMs,
    sampledAt: new Date(args.now).toISOString()
  });
}
