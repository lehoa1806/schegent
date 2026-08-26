import type { Phase } from '../controller/phase';
import {
  AUDIT_SCHEMA_VERSION,
  ALL_AUDIT_EVENT_TYPES,
  KNOWN_AUDIT_EVENT_TYPE_SET,
  isKnownAuditEventType,
  type AuditEventType,
  type AuditOutcome
} from '../contracts/audit-events';

export {
  AUDIT_SCHEMA_VERSION,
  ALL_AUDIT_EVENT_TYPES,
  KNOWN_AUDIT_EVENT_TYPE_SET,
  isKnownAuditEventType,
  type AuditEventType,
  type AuditOutcome
};

export interface AuditEntry {
  id: string;
  timestamp: string;
  runId: string;
  phase: Phase;
  iteration: number;
  eventType: AuditEventType;
  payload: Record<string, unknown>;
  outcome: AuditOutcome;
  schemaVersion?: number;
  correlationId?: string;
}

export interface AuditEntryFields {
  phase: Phase;
  filesCreated: string[];
  filesModified: string[];
  filesDeleted: string[];
  commandsExecuted: string[];
  networkCalls: string[];
  rulesetSwitches: string[];
  notes: string;
  metrics: Readonly<Record<string, number>>;
  warnings: ReadonlyArray<string>;
}

// Co-maintenance rule (feature 010 — see specs/010-pipeline-resilience/data-model.md §3):
//   Subset (a) "AuditEntry envelope fields" is MANDATORY. Any new top-level
//   `AuditEntry` field MUST be added to this set in the same change. The unit
//   test in tests/unit/audit/audit-entry.test.ts asserts this invariant.
//   Subset (b) "Well-known payload-field names" is RECOMMENDED. Extend when a
//   new payload name plausibly collides with an operator-authored metric.
export const RESERVED_METRIC_KEYS: ReadonlySet<string> = Object.freeze(
  new Set<string>([
    // (a) AuditEntry envelope fields — mandatory co-maintenance.
    'id',
    'timestamp',
    'runId',
    'phase',
    'iteration',
    'eventType',
    'payload',
    'outcome',
    'schemaVersion',
    'correlationId',
    // FR-R3-112 — the hash chain's two envelope fields. Added under the mandatory rule above:
    // they are written on every entry, so an operator-authored metric with either name would
    // collide with the field the verifier reads — and the collision would present as a broken
    // chain rather than as a naming clash.
    'prevDigest',
    'digestAlg',
    // (b) Well-known payload-field names — recommended co-maintenance.
    'status',
    'model',
    'effort',
    'pipelineId',
    'phaseId',
    'startTimestamp',
    'endTimestamp',
    'durationMs',
    'cliDurationMs',
    'numTurns',
    'totalCostUsd',
    'inputTokens',
    'outputTokens',
    'cacheCreationInputTokens',
    'cacheReadInputTokens',
    'type',
    'cause',
    'warnings',
    'prompt',
    'output'
  ])
);
