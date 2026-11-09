/**
 * FR-R6-F06 (T023) — audit rows in the shape the audit writer hands its subscribers: the
 * projected `cli-invocation` row (which carries the runner and model) and the projected
 * `phase-end` row (which carries the usage and the attempt id, but neither runner nor model).
 */
import type { AuditEntry } from '../../../src/audit/audit-entry';

export const CLAUDE_ATTEMPT = '0b6f6c1e-4a52-4f0e-9a1d-2f6a7c1d9e01';
export const CODEX_ATTEMPT = '1c7a7d2f-5b63-4a1f-8b2e-3a7b8d2eaf02';

const RUN_ID = 'run-f06-1';

export function cliInvocationRow(overrides: Partial<AuditEntry> & { payload?: Record<string, unknown> }): AuditEntry {
  return {
    id: 'a1000000-0000-4000-8000-000000000001',
    timestamp: '2026-11-10T10:00:00.000Z',
    runId: RUN_ID,
    phase: 'implement',
    iteration: 1,
    eventType: 'cli-invocation',
    outcome: 'info',
    ...overrides,
    payload: {
      runner: 'claude',
      operation: 'phase',
      permissionMode: 'unrestricted',
      continued: false,
      sessionReused: false,
      modelId: 'claude-opus-5-5',
      diagnosticsEnabled: false,
      ...(overrides.payload ?? {})
    }
  };
}

export function phaseEndRow(overrides: Partial<AuditEntry> & { payload?: Record<string, unknown> }): AuditEntry {
  return {
    id: 'b2000000-0000-4000-8000-000000000002',
    timestamp: '2026-11-10T10:05:00.000Z',
    runId: RUN_ID,
    phase: 'implement',
    iteration: 1,
    eventType: 'phase-end',
    outcome: 'success',
    ...overrides,
    payload: { outcome: 'clean', exitCode: 0, terminationReason: 'clean', ...(overrides.payload ?? {}) }
  };
}

/** A Claude row: usage nested under `metrics`, the parser's baseline marker beside it. */
export const CLAUDE_PHASE_END = phaseEndRow({
  payload: {
    attemptId: CLAUDE_ATTEMPT,
    costBaseline: 'subtracted',
    metrics: {
      durationMs: 1200,
      totalCostUsd: 0.4125,
      inputTokens: 1500,
      outputTokens: 300,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 900
    }
  }
});

/** A Codex row: flat legacy keys, tokens only, no cost. */
export const CODEX_INVOCATION = cliInvocationRow({
  runId: 'run-f06-2',
  phase: 'review',
  iteration: 2,
  payload: { runner: 'codex', modelId: 'gpt-5-codex', permissionMode: 'workspace-write' }
});

export const CODEX_PHASE_END = phaseEndRow({
  runId: 'run-f06-2',
  phase: 'review',
  iteration: 2,
  payload: { attemptId: CODEX_ATTEMPT, inputTokens: 800, outputTokens: 120, cacheReadInputTokens: 500 }
});

/** Content that must never reach a stored column, whatever key carries it. */
export const LEAK_MARKERS = Object.freeze({
  prompt: 'LEAK-PROMPT-please-summarise-the-secret-plan',
  path: '/Users/someone/LEAK-PATH/project/file.ts',
  error: 'LEAK-ERROR-stack-at-line-42'
});
