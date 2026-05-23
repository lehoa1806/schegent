// Feature 013 — Wave 7 (US7 / T092): audit-tail projection extracted from
// state-projector.ts. Pure functions only; the orchestrator owns the
// ring buffer mutation and calls `projectAuditEntry` to convert from
// the persisted audit entry shape to the tail-entry shape rendered in
// the sidebar.
//
// Feature 068 — additive extraction of `taskId`, `phaseId`, `outcome`, and
// (for `cli-invocation` events only) `command` so the System tab can
// render structured per-entry metadata and the CLI command block.

import type { AuditEntry, AuditEventType, AuditOutcome } from '../../audit/audit-entry';
import { classifyAuditEvent } from '../../contracts/audit-events';
import type { Phase } from '../../controller/phase';
import { truncateLabel } from './queue-projector';
import type { AuditCategory, AuditTailEntry, PhaseName } from './snapshot';

export function projectAuditEntry(entry: AuditEntry): AuditTailEntry {
  const taskId = extractTaskId(entry.payload);
  const phaseId = extractPhaseId(entry);
  const outcome = normalizeOutcome(entry.outcome);
  const command = entry.eventType === 'cli-invocation' ? extractCommand(entry.payload) : undefined;
  return Object.freeze({
    id: entry.id,
    timestamp: entry.timestamp,
    phase: phaseForTail(entry.phase),
    category: categorize(entry.eventType, entry.outcome),
    summary: summarize(entry),
    runId: entry.runId,
    scope: classifyAuditEvent(entry.eventType),
    taskId,
    phaseId,
    outcome,
    command
  });
}

function extractTaskId(payload: Record<string, unknown>): string | undefined {
  for (const key of ['taskId', 'taskID', 'queueItemId']) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function extractPhaseId(entry: AuditEntry): string | undefined {
  const payloadPhaseId = entry.payload.phaseId;
  if (typeof payloadPhaseId === 'string' && payloadPhaseId.length > 0) return payloadPhaseId;
  const payloadPhase = entry.payload.phase;
  if (typeof payloadPhase === 'string' && payloadPhase.length > 0) return payloadPhase;
  if (typeof entry.phase === 'string' && entry.phase.length > 0 && entry.phase !== 'done') {
    return entry.phase;
  }
  return undefined;
}

function normalizeOutcome(outcome: AuditOutcome): 'success' | 'error' | 'pending' | undefined {
  if (outcome === 'success') return 'success';
  if (outcome === 'failure') return 'error';
  return undefined;
}

function extractCommand(payload: Record<string, unknown>): string | undefined {
  const value = payload.command;
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}

function phaseForTail(phase: Phase): PhaseName | null {
  if (phase === 'done') return null;
  return phase as PhaseName;
}

function categorize(eventType: AuditEventType, outcome: AuditOutcome): AuditCategory {
  if (eventType === 'error' || outcome === 'failure') return 'error';
  if (eventType === 'warning') return 'warning';
  if (eventType === 'cli-invocation') return 'cli-invocation';
  if (eventType === 'file-write') return 'file-write';
  if (eventType === 'phase-start' || eventType === 'phase-end' || eventType === 'loop-iteration') {
    return 'phase-transition';
  }
  return 'system';
}

function summarize(entry: AuditEntry): string {
  const base = `${entry.eventType} ${entry.phase}#${entry.iteration}`;
  const note = typeof entry.payload?.summary === 'string' ? `: ${entry.payload.summary as string}` : '';
  return truncateLabel(`${base}${note}`);
}
