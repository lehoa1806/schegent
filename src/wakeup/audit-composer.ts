// Feature 031 T013 — `wakeup-runner-invocation` audit payload composer.
//
// Pure projection from an `InvocationRecord` (014 JSONL record, extended by
// 031 with five OPTIONAL fields) onto the flat audit payload defined in
// `specs/031-advanced-wakeup-logs-models/contracts/wakeup-runner-invocation-audit.diff.md`.
//
// Adds three scalar fields when the source record carries them:
//   - correlationId    (UUIDv4)
//   - requestedModel   (operator selection, verbatim — may be invalid)
//   - actualModel      ('runner-default' | 'claude-sonnet-5' | 'claude-opus-5' | 'claude-fable-5' | 'claude-opus-4-7' | 'claude-opus-4-8' | 'claude-sonnet-4-6' | 'claude-haiku-4-6')
//
// Explicitly NOT added (preserves the 014 paths-free + audit-enum invariants):
//   - sessionLogBytesAppended / sessionLogTrimmed (byte counters; JSONL only)
//   - any path-shaped field (workspace, session-log, mirror, cwd, …)
//
// This module is pure. No `vscode` import. No I/O. The redaction boundary
// is the audit writer's `SanitizedLogger.sanitize` call, which runs after
// this composer returns. Model identifiers and UUIDs do not match
// `SECRET_PATTERNS`, so no new redaction signature is introduced.

import type { InvocationRecord } from './invocation-log';

export interface WakeupRunnerInvocationAuditPayload {
  readonly eventType: 'wakeup-runner-invocation';
  readonly correlationId?: string;
  readonly requestedModel?: string;
  readonly actualModel?: string;
}

/**
 * Project an `InvocationRecord` onto the `wakeup-runner-invocation` audit
 * event payload. Returns the audit-event-payload subset that this feature
 * controls. The audit writer composes the full event envelope
 * (`runId` / `phase` / `iteration` / `outcome`) at the emission site.
 *
 * Three rules pinned by the contract:
 *   1. The scalar fields appear iff the source record carries them.
 *      Legacy 014/024 records produce an output with only `eventType`.
 *   2. Byte counters (`sessionLogBytesAppended`, `sessionLogTrimmed`) and
 *      every path-shaped key are OMITTED. Constructed explicitly here, so
 *      passing extra fields on the source can never leak them in.
 *   3. `requestedModel` is the operator's verbatim selection (audit
 *      reflects intent, not the runner's resolution). `actualModel` is
 *      what the runner ran with.
 */
export function composeWakeupRunnerInvocationAudit(
  record: InvocationRecord
): WakeupRunnerInvocationAuditPayload {
  const payload: {
    eventType: 'wakeup-runner-invocation';
    correlationId?: string;
    requestedModel?: string;
    actualModel?: string;
  } = { eventType: 'wakeup-runner-invocation' };

  if (typeof record.correlationId === 'string') {
    payload.correlationId = record.correlationId;
  }
  if (typeof record.requestedModel === 'string') {
    payload.requestedModel = record.requestedModel;
  }
  if (typeof record.actualModel === 'string') {
    payload.actualModel = record.actualModel;
  }

  return Object.freeze(payload);
}
