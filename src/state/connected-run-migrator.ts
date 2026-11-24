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
  MAX_OPERATIONAL_JSON_DEPTH,
  deepFreezeValue,
  isDeepFrozenSnapshot,
  isPlainRecord,
  setOwnProp,
  toSafeIntOrDefault
} from '../lib/operational-value-helpers';
import { assertConnectedRunStructure } from './connected-run-invariants';
import { MAX_COMMAND_RECEIPTS, type ConnectedWorkflowRun } from './connected-workflow-run';

/** Dedicated upper bounds for preserved refused connected-run records (FR-R8-01). */
export const CONNECTED_RUNS_REFUSED_MAX_COUNT = 256;
export const CONNECTED_RUNS_REFUSED_MAX_BYTES = 16 * 1024 * 1024;

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

export type ConnectedRunEntryClassification =
  | { readonly ok: true; readonly run: ConnectedWorkflowRun }
  | { readonly ok: false; readonly reason: ConnectedRunRefusalReason };

/**
 * Cache of deeply immutable snapshots (`DEEP_FROZEN_SNAPSHOTS`) that already passed
 * `classifyConnectedRunEntry`, keyed to their validated `connectedRunId`.
 */
const VALIDATED_FROZEN_RUN_ID = new WeakMap<object, string>();

function sanitizeDiagnosticId(key: string): string {
  let cleaned = '';
  const limit = Math.min(key.length, DIAGNOSTIC_ID_MAX);
  for (let i = 0; i < limit; i += 1) {
    const code = key.charCodeAt(i);
    cleaned += code <= 0x1f || code === 0x7f ? '?' : key.charAt(i);
  }
  return key.length > DIAGNOSTIC_ID_MAX ? `${cleaned}...` : cleaned;
}

function isLegacyOrUnsupportedSchemaShape(value: Record<string, unknown>): boolean {
  if (Object.hasOwn(value, 'schemaVersion') && value.schemaVersion !== undefined) return true;
  if (Object.hasOwn(value, 'version') && value.version !== undefined) return true;
  if (Object.hasOwn(value, 'featureId') && !Object.hasOwn(value, 'connectedRunId')) return true;
  if (Object.hasOwn(value, 'phases') && !Object.hasOwn(value, 'graph')) return true;
  const controlState = Object.hasOwn(value, 'controlState') ? value.controlState : undefined;
  if (
    isPlainRecord(controlState) &&
    Object.hasOwn(controlState, 'version') &&
    controlState.version !== 1
  ) {
    return true;
  }
  return false;
}

/**
 * Single source of truth for classifying one persisted `KEYS.connectedRuns` entry into
 * either a valid deeply-frozen `ConnectedWorkflowRun` or an isolated refusal reason.
 *
 * Refused entries are never mutated or frozen; unexpected per-entry errors are caught and
 * isolated as `'invariant-violation'` so one malformed record can never abort sibling work.
 */
export function classifyConnectedRunEntry(
  key: string,
  value: unknown
): ConnectedRunEntryClassification {
  if (isDeepFrozenSnapshot(value) && VALIDATED_FROZEN_RUN_ID.get(value as object) === key) {
    return { ok: true, run: value as ConnectedWorkflowRun };
  }
  try {
    if (!isPlainRecord(value)) {
      return { ok: false, reason: 'invariant-violation' };
    }
    if (isLegacyOrUnsupportedSchemaShape(value)) {
      return { ok: false, reason: 'unsupported-run-schema-version' };
    }
    assertConnectedRunStructure(value, {
      requireFrozen: false,
      maxCommandReceipts: MAX_COMMAND_RECEIPTS
    });
    if (value.connectedRunId !== key) {
      return { ok: false, reason: 'invariant-violation' };
    }
    const candidate = deepFreezeValue(value) as ConnectedWorkflowRun;
    if (isDeepFrozenSnapshot(candidate)) {
      VALIDATED_FROZEN_RUN_ID.set(candidate, key);
    }
    return { ok: true, run: candidate };
  } catch {
    return { ok: false, reason: 'invariant-violation' };
  }
}

export function sanitizeConnectedRunDiagnosticId(key: string): string {
  return sanitizeDiagnosticId(key);
}

function isOperationalJsonTreeSafe(
  value: unknown,
  depth: number,
  seen: WeakSet<object>
): boolean {
  if (value === null || typeof value !== 'object') {
    return typeof value !== 'bigint' && typeof value !== 'symbol' && typeof value !== 'function';
  }
  if (depth > MAX_OPERATIONAL_JSON_DEPTH) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        if (!isOperationalJsonTreeSafe(value[i], depth + 1, seen)) return false;
      }
      return true;
    }
    if (!isPlainRecord(value)) return false;
    for (const key of Object.keys(value)) {
      if (!isOperationalJsonTreeSafe(value[key], depth + 1, seen)) return false;
    }
    return true;
  } finally {
    seen.delete(value);
  }
}

/**
 * Verifies a preserved refused connected-run entry is JSON-serializable, acyclic,
 * plain-structured, and safe to freeze within `MAX_OPERATIONAL_JSON_DEPTH` as a child of
 * the top-level `KEYS.connectedRuns` map, without mutating `value`.
 */
export function measureSafeRefusedEntry(
  value: unknown
): { readonly ok: true; readonly bytes: number } | { readonly ok: false } {
  try {
    if (!isOperationalJsonTreeSafe(value, 1, new WeakSet<object>())) {
      return { ok: false };
    }
    const serialized: unknown = JSON.stringify(value);
    if (typeof serialized !== 'string') return { ok: false };
    return { ok: true, bytes: Buffer.byteLength(serialized, 'utf8') };
  } catch {
    return { ok: false };
  }
}

export interface PreservedRefusedSelection {
  readonly entries: readonly (readonly [string, unknown])[];
  readonly totalBytes: number;
  readonly quarantinedUnsafeCount: number;
  readonly quarantinedBudgetCount: number;
  readonly quarantinedKeys: readonly string[];
}

/**
 * Selects serializable, depth-safe refused connected-run entries within explicit count and byte
 * budgets so cyclic, unserializable, over-depth, or unbounded refused entries can never wedge
 * writes to healthy sibling runs or bypass the operational total byte cap.
 */
export function selectPreservedRefusedEntries(
  refused: Readonly<Record<string, unknown>>,
  remainingTotalBytes: number
): PreservedRefusedSelection {
  const entries: Array<readonly [string, unknown]> = [];
  const quarantinedKeys: string[] = [];
  let refusedBytes = 0;
  let quarantinedUnsafeCount = 0;
  let quarantinedBudgetCount = 0;
  const noteKey = (key: string): void => {
    if (quarantinedKeys.length < CONNECTED_RUN_DIAGNOSTIC_CAP) {
      quarantinedKeys.push(sanitizeDiagnosticId(key));
    }
  };
  for (const [id, rawRefused] of Object.entries(refused)) {
    const measured = measureSafeRefusedEntry(rawRefused);
    if (!measured.ok) {
      quarantinedUnsafeCount += 1;
      noteKey(id);
      continue;
    }
    if (
      entries.length >= CONNECTED_RUNS_REFUSED_MAX_COUNT ||
      refusedBytes + measured.bytes > CONNECTED_RUNS_REFUSED_MAX_BYTES ||
      refusedBytes + measured.bytes > remainingTotalBytes
    ) {
      quarantinedBudgetCount += 1;
      noteKey(id);
      continue;
    }
    entries.push([id, rawRefused]);
    refusedBytes += measured.bytes;
  }
  return {
    entries,
    totalBytes: refusedBytes,
    quarantinedUnsafeCount,
    quarantinedBudgetCount,
    quarantinedKeys
  };
}

const FROZEN_CONNECTED_RUN_BYTES = new WeakMap<object, number>();

export function serializedConnectedRunBytes(run: ConnectedWorkflowRun): number {
  if (isDeepFrozenSnapshot(run)) {
    const cached = FROZEN_CONNECTED_RUN_BYTES.get(run);
    if (cached !== undefined) return cached;
    const bytes = Buffer.byteLength(JSON.stringify(run), 'utf8');
    FROZEN_CONNECTED_RUN_BYTES.set(run, bytes);
    return bytes;
  }
  return Buffer.byteLength(JSON.stringify(run), 'utf8');
}

export function isConnectedRunTerminal(
  run: ConnectedWorkflowRun,
  activeFeatureIds: ReadonlySet<string>
): boolean {
  if (!isPlainRecord(run)) return false;
  if (run.pendingHandoff !== undefined && run.pendingHandoff !== null) return false;
  if (isPlainRecord(run.invocations)) {
    const frames = Object.values(run.invocations);
    if (frames.length > 0) {
      return frames.every(
        (frame) =>
          isPlainRecord(frame) &&
          (frame.status === 'completed' || frame.status === 'failed' || frame.status === 'canceled')
      );
    }
  }
  if (!isPlainRecord(run.nodes)) return false;
  for (const node of Object.values(run.nodes)) {
    if (!isPlainRecord(node) || !Array.isArray(node.attempts)) return false;
    for (const attempt of node.attempts) {
      if (
        isPlainRecord(attempt) &&
        typeof attempt.queueItemId === 'string' &&
        activeFeatureIds.has(attempt.queueItemId)
      ) {
        return false;
      }
    }
  }
  return Object.keys(run.nodes).length > 0;
}

export function connectedRunLastUpdatedMs(run: ConnectedWorkflowRun): number {
  if (!isPlainRecord(run)) return 0;
  let latest = toSafeIntOrDefault(run.startedAt, 0);
  if (isPlainRecord(run.invocations)) {
    for (const frame of Object.values(run.invocations)) {
      if (!isPlainRecord(frame)) continue;
      const completed = toSafeIntOrDefault(frame.completedAt, -1);
      const started = toSafeIntOrDefault(frame.startedAt, -1);
      if (completed > latest) latest = completed;
      else if (started > latest) latest = started;
    }
  }
  if (Array.isArray(run.decisions)) {
    for (const decision of run.decisions) {
      if (!isPlainRecord(decision)) continue;
      const decided = toSafeIntOrDefault(decision.decidedAt, -1);
      if (decided > latest) latest = decided;
    }
  }
  return latest;
}

export interface ConnectedRunsFreezeResult {
  readonly value: unknown;
  readonly quarantinedCount: number;
  readonly quarantinedKeys: readonly string[];
}

/**
 * Deeply freezes a parsed `KEYS.connectedRuns` document with per-entry isolation: if whole-map
 * freezing fails (for example, one entry exceeds `MAX_OPERATIONAL_JSON_DEPTH`), falls back to
 * freezing each top-level own entry individually so healthy sibling runs remain readable while
 * only offending entries are quarantined with bounded metadata-only diagnostics.
 */
export function deepFreezeConnectedRunsDocument(parsed: unknown): ConnectedRunsFreezeResult {
  try {
    return {
      value: deepFreezeValue(parsed),
      quarantinedCount: 0,
      quarantinedKeys: Object.freeze([])
    };
  } catch (wholeDocError) {
    if (!isPlainRecord(parsed)) throw wholeDocError;
  }
  const isolated: Record<string, unknown> = {};
  const quarantinedKeys: string[] = [];
  let quarantinedCount = 0;
  for (const key of Object.keys(parsed)) {
    try {
      const frozenEntry = deepFreezeValue(parsed[key], 1);
      setOwnProp(isolated, key, frozenEntry);
    } catch {
      quarantinedCount += 1;
      if (quarantinedKeys.length < CONNECTED_RUN_DIAGNOSTIC_CAP) {
        quarantinedKeys.push(sanitizeDiagnosticId(key));
      }
    }
  }
  return {
    value: deepFreezeValue(isolated),
    quarantinedCount,
    quarantinedKeys: Object.freeze(quarantinedKeys)
  };
}

/**
 * Narrow the persisted memento value into the connected-run collection.
 *
 * Absent, null, or shape-invalid reads as empty — the correct state for every
 * workspace that predates this feature, and a corrupt key must not stop the
 * extension from opening.
 */
export function migrateConnectedRuns(raw: unknown): ConnectedRunsMigrationResult {
  if (!isPlainRecord(raw)) return EMPTY;

  const runs: Record<string, ConnectedWorkflowRun> = {};
  const dropped: string[] = [];
  const refused: Record<string, unknown> = {};
  const diagnostics: ConnectedRunRefusalDiagnostic[] = [];
  const refuse = (key: string, value: unknown, reason: ConnectedRunRefusalReason): void => {
    dropped.push(key);
    setOwnProp(refused, key, value);
    if (diagnostics.length < CONNECTED_RUN_DIAGNOSTIC_CAP) {
      diagnostics.push(Object.freeze({ connectedRunId: sanitizeDiagnosticId(key), reason }));
    }
  };

  for (const key of Object.keys(raw)) {
    let value: unknown;
    try {
      value = raw[key];
    } catch {
      refuse(key, null, 'invariant-violation');
      continue;
    }
    const classified = classifyConnectedRunEntry(key, value);
    if (!classified.ok) {
      refuse(key, value, classified.reason);
      continue;
    }
    setOwnProp(runs, key, classified.run);
  }

  return Object.freeze({
    runs: Object.freeze(runs),
    dropped: Object.freeze(dropped),
    refused: Object.freeze(refused),
    diagnostics: Object.freeze(diagnostics)
  });
}
