/**
 * FR-R6-F08 (FR-012, FR-016, NFR-004, research R9) — the read-only explanation of one handoff.
 *
 * `buildExplanation` is pure: it reads the rows it is handed and the stored manifest, and returns
 * a bounded, path-free account of what the handoff carries, what it left out and why, what was
 * delivered and decided, and what an operator can do next. It writes nothing and calls nothing.
 *
 * Bounded: above `MAX_HANDOFF_EXPLANATION_BYTES` the lists are trimmed from their ends, heaviest
 * list first, and `truncatedCounts` records how many items each lost. Trimming is never an error.
 * Deliveries and decisions are listed newest first, so trimming drops the oldest.
 *
 * Path-free: workspace attribution is reported as counts by category, never as paths, and any
 * string that still looks like an absolute path throws `HandoffExplanationContentError`, which
 * names the field and never the value.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type { AttemptOutcomeReason, AttemptOutcomeStatus } from '../../contracts/decision-results';
import {
  RECOVERY_WORKSPACE_ATTRIBUTION_VALUES,
  type RecoveryEffectCertainty,
  type RecoveryWorkspaceAttribution,
  type RecoveryWorkspaceCoverage
} from '../../contracts/recovery-envelope';
import { validateHandoffManifest, type HandoffManifest } from '../../contracts/recovery-handoff/handoff-manifest';
import {
  HANDOFF_MANIFEST_VERSION,
  MAX_HANDOFF_EXPLANATION_BYTES,
  type DecisionOutcome,
  type DeliveryOutcome,
  type DeliveryOutcomeReason,
  type DeliveryTransport,
  type FreshSessionReason,
  type HandoffClosedReason,
  type HandoffDecision,
  type HandoffExcludedReason,
  type HandoffReferenceRole,
  type HandoffResolution,
  type HandoffState,
  type NextAction,
  type SessionPlanKind
} from '../../contracts/recovery-handoff/handoff-types';
import type { DecisionRow, DeliveryRow, HandoffRow, ReferenceRow, RevisionRow } from './handoff-store-rows';

/** The rows one explanation is built from; the service reads them, this module never does. */
export interface HandoffExplanationSnapshot {
  readonly handoff: HandoffRow;
  /** The current revision, or the newest one when none is issued yet. */
  readonly revision: RevisionRow | null;
  /** The reference rows of `revision`. */
  readonly references: readonly ReferenceRow[];
  readonly deliveries: readonly DeliveryRow[];
  readonly decisions: readonly DecisionRow[];
}

export interface ExplainedReference {
  readonly artifactId: string;
  readonly role: HandoffReferenceRole;
  readonly required: boolean;
  readonly lastResolution: HandoffResolution | null;
}

/** An optional reference whose last resolution was anything but `available`. */
export interface ExplainedOmission {
  readonly artifactId: string;
  readonly role: HandoffReferenceRole;
  readonly resolution: HandoffResolution;
}

export interface ExplainedExclusion {
  readonly itemId: string;
  readonly reason: HandoffExcludedReason;
}

/** No session id, owner digest, connection id or digest: those identify, they do not explain. */
export interface ExplainedDelivery {
  readonly targetAttemptId: string;
  readonly revisionNo: number;
  readonly transport: DeliveryTransport;
  readonly outcome: DeliveryOutcome;
  readonly outcomeReason: DeliveryOutcomeReason | null;
  readonly sessionPlan: SessionPlanKind;
  readonly sessionReason: FreshSessionReason | null;
}

export interface ExplainedDecision {
  readonly revisionNo: number;
  readonly decision: HandoffDecision;
  readonly outcome: DecisionOutcome;
  readonly consumed: boolean;
}

export interface ExplainedAttribution {
  readonly counts: Readonly<Record<RecoveryWorkspaceAttribution, number>>;
  readonly omittedCount: number;
}

export interface HandoffExplanationTruncation {
  readonly references: number;
  readonly omitted: number;
  readonly excluded: number;
  readonly deliveries: number;
  readonly decisions: number;
}

export interface HandoffExplanation {
  readonly handoffId: string;
  /** The stored state, or `unsupported` when the revision was written by a newer build. */
  readonly state: HandoffState;
  readonly paused: boolean;
  readonly closedReason: HandoffClosedReason | null;
  readonly currentRevision: number | null;
  /** The revision this explanation describes. */
  readonly revisionNo: number | null;
  readonly sourceOutcome: { readonly status: AttemptOutcomeStatus; readonly reason: AttemptOutcomeReason } | null;
  readonly certainty: RecoveryEffectCertainty | null;
  readonly coverage: RecoveryWorkspaceCoverage | null;
  readonly attribution: ExplainedAttribution | null;
  readonly references: readonly ExplainedReference[];
  readonly omitted: readonly ExplainedOmission[];
  readonly excluded: readonly ExplainedExclusion[];
  readonly deliveries: readonly ExplainedDelivery[];
  readonly decisions: readonly ExplainedDecision[];
  readonly nextActions: readonly NextAction[];
  readonly truncatedCounts: HandoffExplanationTruncation;
}

/** An explanation string looked like an absolute path. Carries the field, never the value. */
export class HandoffExplanationContentError extends Error {
  constructor(readonly field: string) {
    super(`handoff explanation field ${field} carries an absolute path`);
    this.name = 'HandoffExplanationContentError';
  }
}

type ListKey = keyof HandoffExplanationTruncation;
const LIST_KEYS: readonly ListKey[] = ['references', 'omitted', 'excluded', 'deliveries', 'decisions'];
const OPEN_STATES: ReadonlySet<HandoffState> = new Set<HandoffState>(['preparing', 'ready', 'delivering', 'uncertain']);
const ABSOLUTE_PATH = /(^|[\s"'=(])(\/[^\s/]|~\/|[A-Za-z]:[\\/]|\\\\)/;

type ManifestReading =
  | { readonly kind: 'none' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'read'; readonly manifest: HandoffManifest };

function readManifest(handoff: HandoffRow, revision: RevisionRow | null): ManifestReading {
  if (handoff.state === 'unsupported') return { kind: 'unsupported' };
  if (revision === null) return { kind: 'none' };
  if (revision.manifestVersion > HANDOFF_MANIFEST_VERSION) return { kind: 'unsupported' };
  let raw: unknown;
  try {
    raw = JSON.parse(revision.manifestJson);
  } catch {
    return { kind: 'unreadable' };
  }
  const validated = validateHandoffManifest(raw);
  if (validated.ok) return { kind: 'read', manifest: validated.manifest };
  return validated.code === 'unsupported-version' ? { kind: 'unsupported' } : { kind: 'unreadable' };
}

function attributionOf(manifest: HandoffManifest): ExplainedAttribution {
  const counts = new Map<RecoveryWorkspaceAttribution, number>(
    RECOVERY_WORKSPACE_ATTRIBUTION_VALUES.map((value) => [value, 0])
  );
  for (const entry of manifest.workspace.entries) {
    counts.set(entry.attribution, (counts.get(entry.attribution) ?? 0) + 1);
  }
  return {
    counts: Object.fromEntries(counts) as Record<RecoveryWorkspaceAttribution, number>,
    omittedCount: manifest.workspace.omittedCount
  };
}

function isBlocking(reference: ReferenceRow): boolean {
  return reference.required && reference.lastResolution !== null && reference.lastResolution !== 'available';
}

function baseActions(state: HandoffState): NextAction[] {
  if (state === 'ready') return ['deliver'];
  if (state === 'delivering') return ['await-acknowledgement'];
  if (state === 'uncertain') return ['decide', 'inspect-evidence'];
  if (state === 'unsupported') return ['inspect-evidence'];
  return ['none'];
}

/** R9: a blocked required reference, or an unreadable manifest, turns delivery into inspection. */
function nextActionsFor(state: HandoffState, blocked: boolean): readonly NextAction[] {
  const base = baseActions(state);
  if (!blocked || !OPEN_STATES.has(state) || base.includes('inspect-evidence')) return base;
  const kept = base.filter((action) => action !== 'deliver' && action !== 'none');
  return [...kept, 'inspect-evidence'];
}

function newestFirst<Row extends { readonly recordedAtMs: number }>(rows: readonly Row[], id: (row: Row) => string): Row[] {
  return [...rows].sort((a, b) => b.recordedAtMs - a.recordedAtMs || id(b).localeCompare(id(a)));
}

function explainDelivery(row: DeliveryRow): ExplainedDelivery {
  return {
    targetAttemptId: row.targetAttemptId,
    revisionNo: row.revisionNo,
    transport: row.transport,
    outcome: row.outcome,
    outcomeReason: row.outcomeReason,
    sessionPlan: row.sessionPlan,
    sessionReason: row.sessionReason
  };
}

function explainDecision(row: DecisionRow): ExplainedDecision {
  return {
    revisionNo: row.revisionNo,
    decision: row.decision,
    outcome: row.outcome,
    consumed: row.consumedByIntentId !== null
  };
}

function omissionsOf(references: readonly ReferenceRow[]): ExplainedOmission[] {
  const omitted: ExplainedOmission[] = [];
  for (const row of references) {
    if (row.required || row.lastResolution === null || row.lastResolution === 'available') continue;
    omitted.push({ artifactId: row.artifactId, role: row.role, resolution: row.lastResolution });
  }
  return omitted;
}

/** Throws on the first string that looks like an absolute path; names the field only. */
function assertPathFree(value: unknown, field: string): void {
  if (typeof value === 'string') {
    if (ABSOLUTE_PATH.test(value)) throw new HandoffExplanationContentError(field);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) assertPathFree(child, field === '' ? key : `${field}.${key}`);
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

type Lists = { [Key in ListKey]: HandoffExplanation[Key] };

function heaviestList(totals: ReadonlyMap<ListKey, number>): ListKey | null {
  let heaviest: ListKey | null = null;
  let heaviestBytes = 0;
  for (const key of LIST_KEYS) {
    const total = totals.get(key) ?? 0;
    if (total > heaviestBytes) {
      heaviest = key;
      heaviestBytes = total;
    }
  }
  return heaviest;
}

/** Drops items from the end of the heaviest list until the explanation fits the bound. */
function trimToBound(explanation: HandoffExplanation): HandoffExplanation {
  let bytes = bytesOf(explanation);
  if (bytes <= MAX_HANDOFF_EXPLANATION_BYTES) return explanation;
  const lists: Lists = { ...explanation };
  const kept = new Map<ListKey, unknown[]>(LIST_KEYS.map((key) => [key, [...lists[key]]]));
  const sizes = new Map<ListKey, number[]>(
    LIST_KEYS.map((key) => [key, lists[key].map((item: unknown) => bytesOf(item) + 1)])
  );
  const totals = new Map<ListKey, number>(
    LIST_KEYS.map((key) => [key, (sizes.get(key) ?? []).reduce((sum, size) => sum + size, 0)])
  );
  const dropped = new Map<ListKey, number>(LIST_KEYS.map((key) => [key, 0]));
  const assemble = (): HandoffExplanation => ({
    ...explanation,
    ...(Object.fromEntries(kept) as unknown as Lists),
    truncatedCounts: Object.fromEntries(dropped) as unknown as HandoffExplanationTruncation
  });
  while (bytes > MAX_HANDOFF_EXPLANATION_BYTES) {
    const key = heaviestList(totals);
    if (key === null) break;
    kept.get(key)?.pop();
    const size = sizes.get(key)?.pop() ?? 0;
    totals.set(key, (totals.get(key) ?? 0) - size);
    bytes -= size;
    dropped.set(key, (dropped.get(key) ?? 0) + 1);
    if (bytes <= MAX_HANDOFF_EXPLANATION_BYTES) bytes = bytesOf(assemble());
  }
  return assemble();
}

const NO_TRUNCATION: HandoffExplanationTruncation = Object.freeze({
  references: 0,
  omitted: 0,
  excluded: 0,
  deliveries: 0,
  decisions: 0
});

/** Builds the bounded, path-free explanation of one handoff from its rows. Writes nothing. */
export function buildExplanation(snapshot: HandoffExplanationSnapshot): HandoffExplanation {
  const { handoff, revision } = snapshot;
  const reading = readManifest(handoff, revision);
  const manifest = reading.kind === 'read' ? reading.manifest : null;
  const state: HandoffState = reading.kind === 'unsupported' ? 'unsupported' : handoff.state;
  const blocked = reading.kind === 'unreadable' || snapshot.references.some(isBlocking);
  const explanation: HandoffExplanation = {
    handoffId: handoff.handoffId,
    state,
    paused: handoff.paused,
    closedReason: handoff.closedReason,
    currentRevision: handoff.currentRevision,
    revisionNo: revision === null ? null : revision.revisionNo,
    sourceOutcome: manifest === null ? null : { ...manifest.sourceOutcome },
    certainty: manifest === null ? null : manifest.certainty,
    coverage: manifest === null ? null : manifest.coverage,
    attribution: manifest === null ? null : attributionOf(manifest),
    references: snapshot.references.map((row) => ({
      artifactId: row.artifactId,
      role: row.role,
      required: row.required,
      lastResolution: row.lastResolution
    })),
    omitted: omissionsOf(snapshot.references),
    excluded: manifest === null ? [] : manifest.excluded.map((item) => ({ itemId: item.itemId, reason: item.reason })),
    deliveries: newestFirst(snapshot.deliveries, (row) => row.intentId).map(explainDelivery),
    decisions: newestFirst(snapshot.decisions, (row) => row.decisionId).map(explainDecision),
    nextActions: nextActionsFor(state, blocked),
    truncatedCounts: NO_TRUNCATION
  };
  assertPathFree(explanation, '');
  return trimToBound(explanation);
}
