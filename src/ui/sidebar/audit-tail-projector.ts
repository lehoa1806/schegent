// Feature 013 — Wave 7 (US7 / T092): audit-tail projection extracted from
// state-projector.ts. Pure functions only; the orchestrator owns the
// ring buffer mutation and calls `projectAuditEntry` to convert from
// the persisted audit entry shape to the tail-entry shape rendered in
// the sidebar.

import type { AuditEntry, AuditEventType, AuditOutcome } from '../../audit/audit-entry';
import type { Phase } from '../../controller/phase';
import { truncateLabel } from './queue-projector';
import type { AuditCategory, AuditTailEntry, PhaseName } from './snapshot';

export function projectAuditEntry(entry: AuditEntry): AuditTailEntry {
  return Object.freeze({
    id: entry.id,
    timestamp: entry.timestamp,
    phase: phaseForTail(entry.phase),
    category: categorize(entry.eventType, entry.outcome),
    summary: summarize(entry)
  });
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
