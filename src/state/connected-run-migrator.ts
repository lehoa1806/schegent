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

/** How many refused records a diagnostic names; the rest are counted, not listed. */
const CONNECTED_RUN_DIAGNOSTIC_CAP = 20;

/** The longest key a diagnostic repeats. A key this reader refused can be any length. */
const DIAGNOSTIC_ID_MAX = 128;

export interface ConnectedRunsMigrationResult {
  readonly runs: Readonly<Record<string, ConnectedWorkflowRun>>;
  /**
   * Ids of persisted records that did not satisfy the aggregate's invariants.
   *
   * Named rather than silently discarded: a record this reader cannot honor is
   * a defect worth a WARN, and the id is host-generated so naming it leaks
   * nothing. It is not handed to readers, because every consumer of a connected
   * run — the projector, the launcher gate, the evaluator — reads it assuming
   * the invariants hold.
   */
  readonly dropped: readonly string[];
  /**
   * The refused records themselves, as stored, keyed as stored.
   *
   * For the store's write path and nothing else: a write rebuilds the whole key,
   * so one built from `runs` alone would erase these on the next unrelated launch.
   * Feature 261 FR-011 refuses them "without auto-deleting developer state files",
   * so they stay until an explicit reset.
   */
  readonly refused: Readonly<Record<string, unknown>>;
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
  refused: Object.freeze({}),
  diagnostics: Object.freeze([] as ConnectedRunRefusalDiagnostic[])
});

/** The WARN naming a set of refused records: a reason per id, capped, the rest counted. */
export function connectedRunRefusalWarning(result: ConnectedRunsMigrationResult): string {
  const named = result.diagnostics
    .map((entry) => `${entry.connectedRunId} (${entry.reason})`)
    .join(', ');
  const unnamed = result.dropped.length - result.diagnostics.length;
  const more = unnamed > 0 ? `, and ${unnamed} more` : '';
  return `workspace-state: refused ${result.dropped.length} connected run(s) from persisted state and kept them in place: ${named}${more}`;
}

/**
 * What the key holds once `ids` are removed, and how many were.
 *
 * Readable runs only. A refused record is no run this reader can honor, so it stays even
 * when named here, and only an explicit reset clears it (feature 261 FR-011).
 */
export function connectedRunsWithout(
  collection: ConnectedRunsMigrationResult,
  ids: readonly string[]
): { readonly stored: Readonly<Record<string, unknown>>; readonly removed: number } {
  const runs = { ...collection.runs };
  let removed = 0;
  for (const id of ids) {
    if (!Object.hasOwn(runs, id)) continue;
    delete runs[id];
    removed += 1;
  }
  return { stored: { ...collection.refused, ...runs }, removed };
}

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
  // Entries rather than a record: `Object.fromEntries` defines each key, so a
  // stored `__proto__` stays a key to preserve instead of reaching the setter.
  const refused: [string, unknown][] = [];
  const diagnostics: ConnectedRunRefusalDiagnostic[] = [];
  const refuse = (key: string, value: unknown, reason: ConnectedRunRefusalReason): void => {
    dropped.push(key);
    refused.push([key, value]);
    if (diagnostics.length < CONNECTED_RUN_DIAGNOSTIC_CAP) {
      const connectedRunId =
        key.length > DIAGNOSTIC_ID_MAX ? `${key.slice(0, DIAGNOSTIC_ID_MAX)}...` : key;
      diagnostics.push(Object.freeze({ connectedRunId, reason }));
    }
  };

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      refuse(key, value, 'invariant-violation');
      continue;
    }
    const record = value as Record<string, unknown>;
    if (isLegacyOrUnsupportedSchemaShape(record)) {
      refuse(key, value, 'unsupported-run-schema-version');
      continue;
    }
    const candidate = deepFreeze(value) as ConnectedWorkflowRun;
    try {
      assertConnectedRunInvariants(candidate);
    } catch (err) {
      if (!(err instanceof ConnectedRunInvariantError)) throw err;
      refuse(key, value, 'invariant-violation');
      continue;
    }
    if (candidate.connectedRunId !== key) {
      refuse(key, value, 'invariant-violation');
      continue;
    }
    runs[key] = candidate;
  }

  return Object.freeze({
    runs: Object.freeze(runs),
    dropped: Object.freeze(dropped),
    refused: Object.freeze(Object.fromEntries(refused)),
    diagnostics: Object.freeze(diagnostics)
  });
}
