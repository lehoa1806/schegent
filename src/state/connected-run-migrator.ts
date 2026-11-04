// Feature 088 (T007) — the v8 → v9 forward-only step for connected runs.
//
// The step is additive and has exactly one interesting property: a workspace
// that predates this feature has no `schegent.connectedRuns` key, and an absent
// key reads as an empty collection (FR-007). Nothing in an existing
// `WorkflowRun` record moves, changes shape, or is re-read — the connected run
// is a different aggregate under a different key, which is what makes the
// migration a no-op for every pre-feature workspace.
//
// It lives here rather than in `workflow-run-migrator.ts` on purpose: that
// file's v1 → v5 chain describes the field history of *one* record, and folding
// an unrelated aggregate into it would make both harder to read. The source
// feature request's intent — one forward-only, additive step gated by
// `STATE_SCHEMA_VERSION` — is preserved exactly; only the site differs.
//
// Forward-only, like every migration here. There is no down-path.

import {
  ConnectedRunInvariantError,
  assertConnectedRunInvariants,
  type ConnectedWorkflowRun
} from './connected-workflow-run';

export type ConnectedRunRefusalReason =
  | 'unsupported-run-schema-version'
  | 'invariant-violation';

export interface ConnectedRunRefusalDiagnostic {
  readonly connectedRunId: string;
  readonly reason: ConnectedRunRefusalReason;
}

const DIAGNOSTIC_CAP = 20;

export interface ConnectedRunsMigrationResult {
  readonly runs: Readonly<Record<string, ConnectedWorkflowRun>>;
  /**
   * Ids of persisted records that did not satisfy the aggregate's invariants.
   *
   * Named rather than silently discarded: a record this reader cannot honor is
   * a defect worth a WARN, and the id is host-generated so naming it leaks
   * nothing. It is not carried forward, because every consumer of a connected
   * run — the projector, the launcher gate, the evaluator — reads it assuming
   * the invariants hold.
   */
  readonly dropped: readonly string[];
  /**
   * Bounded refusal diagnostics (`unsupported-run-schema-version` or
   * `invariant-violation`) for records that cannot be loaded as current-schema
   * `ConnectedWorkflowRun` aggregates (FR-R5-F02-T10).
   */
  readonly diagnostics: readonly ConnectedRunRefusalDiagnostic[];
}

const EMPTY: ConnectedRunsMigrationResult = Object.freeze({
  runs: Object.freeze({}),
  dropped: Object.freeze([] as string[]),
  diagnostics: Object.freeze([] as ConnectedRunRefusalDiagnostic[])
});

/**
 * Deep-freeze on the way out. The aggregate's helpers freeze what they produce,
 * but a record that has been through the memento is a fresh JSON object graph
 * with no freezing left on it — and `assertConnectedRunInvariants` requires the
 * snapshot to be frozen, because "frozen means frozen" has to survive a restart
 * to mean anything (FR-005, FR-006).
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

function isLegacyOrUnsupportedSchemaShape(value: Record<string, unknown>): boolean {
  if ('schemaVersion' in value) return true;
  if ('featureId' in value && !('connectedRunId' in value)) return true;
  if ('phases' in value && !('graph' in value)) return true;
  return false;
}

/**
 * Narrow the persisted memento value into the connected-run collection.
 *
 * Absent, null, or shape-invalid reads as empty — the correct state for every
 * workspace that predates this feature, and a corrupt key must not stop the
 * extension from opening.
 */
export function migrateConnectedRuns(raw: unknown): ConnectedRunsMigrationResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY;

  const runs: Record<string, ConnectedWorkflowRun> = {};
  const dropped: string[] = [];
  const diagnostics: ConnectedRunRefusalDiagnostic[] = [];
  const pushDiagnostic = (connectedRunId: string, reason: ConnectedRunRefusalReason): void => {
    if (diagnostics.length < DIAGNOSTIC_CAP) {
      diagnostics.push(Object.freeze({ connectedRunId, reason }));
    }
  };

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      dropped.push(key);
      pushDiagnostic(key, 'invariant-violation');
      continue;
    }
    const record = value as Record<string, unknown>;
    if (isLegacyOrUnsupportedSchemaShape(record)) {
      dropped.push(key);
      pushDiagnostic(key, 'unsupported-run-schema-version');
      continue;
    }
    const candidate = deepFreeze(value) as ConnectedWorkflowRun;
    try {
      assertConnectedRunInvariants(candidate);
    } catch (err) {
      if (!(err instanceof ConnectedRunInvariantError)) throw err;
      dropped.push(key);
      pushDiagnostic(key, 'invariant-violation');
      continue;
    }
    if (candidate.connectedRunId !== key) {
      dropped.push(key);
      pushDiagnostic(key, 'invariant-violation');
      continue;
    }
    runs[key] = candidate;
  }

  return Object.freeze({
    runs: Object.freeze(runs),
    dropped: Object.freeze(dropped),
    diagnostics: Object.freeze(diagnostics)
  });
}
