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
}

const EMPTY: ConnectedRunsMigrationResult = Object.freeze({
  runs: Object.freeze({}),
  dropped: Object.freeze([] as string[])
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
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') {
      dropped.push(key);
      continue;
    }
    const candidate = deepFreeze(value) as ConnectedWorkflowRun;
    try {
      assertConnectedRunInvariants(candidate);
    } catch (err) {
      if (!(err instanceof ConnectedRunInvariantError)) throw err;
      dropped.push(key);
      continue;
    }
    if (candidate.connectedRunId !== key) {
      dropped.push(key);
      continue;
    }
    runs[key] = candidate;
  }

  return Object.freeze({ runs: Object.freeze(runs), dropped: Object.freeze(dropped) });
}
