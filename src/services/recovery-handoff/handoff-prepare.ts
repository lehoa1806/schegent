/**
 * FR-R6-F08 (FR-004..FR-008, research R2, R3, R4) — preparing and issuing a handoff revision.
 *
 * `prepare` finds or creates the handoff by identity and the revision by cutoff in one immediate
 * transaction, then pins every reference. The pins are F05 writes, each idempotent and each in
 * its own F05 transaction, so they run after the handoff transaction commits. An interruption
 * between any two leaves a state a repeated `prepare` or `reopen` completes.
 *
 * `issue` re-checks every required reference is pinned, then stamps the revision issued,
 * supersedes the previously issued one, sets the current revision and moves the handoff to
 * `ready`, all in one transaction. A superseded revision keeps its stored manifest unchanged.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import {
  CLOSED_HANDOFF_STATES,
  MAX_HANDOFF_LEGACY_PROVENANCE_BYTES,
  type HandoffCutoff,
  type HandoffLineage,
  type HandoffRefusal,
  type HandoffState,
  type ManifestRefusalCode
} from '../../contracts/recovery-handoff/handoff-types';
import { serializeHandoffManifest, type HandoffManifest } from '../../contracts/recovery-handoff/handoff-manifest';
import { isNonNegativeInteger, isOpaqueId } from '../artifact-lifecycle/lifecycle-results';
import type { NodeSqliteConnection } from '../sqlite-store';
import { cutoffKeyFor, handoffIdFor } from './handoff-identity';
import { isNewerBuildStore, pinPurposeFor, pinRevision, switchPurpose, type HandoffPinDeps, type PinRefusal } from './handoff-pins';
import type { HandoffRow } from './handoff-store-rows';

/** States from which `issue` may move the handoff to `ready`. */
const ISSUABLE_STATES: ReadonlySet<HandoffState> = new Set<HandoffState>(['preparing', 'ready', 'uncertain']);

export interface HandoffWriteDeps extends HandoffPinDeps {
  readonly conn: NodeSqliteConnection;
}

export type PrepareResult =
  | {
      readonly ok: true;
      readonly handoffId: string;
      readonly revisionNo: number;
      readonly state: HandoffState;
      /** True when this call created the revision. */
      readonly created: boolean;
      /** Optional references F05 refused to pin; they do not block the revision. */
      readonly pinRefusals: readonly PinRefusal[];
    }
  | (HandoffRefusal<ManifestRefusalCode> & { readonly field: string })
  | HandoffRefusal<'handoff-closed' | 'unsupported-version'>
  | RequiredPinRefusal;

export type RequiredPinRefusal = HandoffRefusal<'required-pin-refused'> & { readonly artifactIds: readonly string[] };

export type IssueResult =
  | {
      readonly ok: true;
      readonly state: HandoffState;
      readonly revisionNo: number;
      readonly supersededRevision?: number;
    }
  | HandoffRefusal<'not-found' | 'handoff-closed' | 'stale-revision' | 'conflict' | 'unsupported-version'>
  | RequiredPinRefusal;

type InvalidInput = HandoffRefusal<'invalid' | 'over-limit'> & { readonly field: string };

const LINEAGE_FIELDS = ['workspaceId', 'rootExecutionId', 'invocationId', 'sourceAttemptId'] as const;

function invalidInput(
  lineage: HandoffLineage,
  cutoff: HandoffCutoff,
  legacyProvenance: string | undefined
): InvalidInput | null {
  for (const field of LINEAGE_FIELDS) {
    if (!isOpaqueId(lineage[field])) return { ok: false, code: 'invalid', field: `lineage.${field}` };
  }
  if (!isOpaqueId(cutoff.executionRevision)) return { ok: false, code: 'invalid', field: 'cutoff.executionRevision' };
  if (!isNonNegativeInteger(cutoff.usageRevision)) return { ok: false, code: 'invalid', field: 'cutoff.usageRevision' };
  if (!isNonNegativeInteger(cutoff.factCutoffMs)) return { ok: false, code: 'invalid', field: 'cutoff.factCutoffMs' };
  if (legacyProvenance !== undefined) {
    if (Buffer.byteLength(legacyProvenance, 'utf8') > MAX_HANDOFF_LEGACY_PROVENANCE_BYTES) {
      return { ok: false, code: 'over-limit', field: 'legacyProvenance' };
    }
  }
  return null;
}

interface Located {
  readonly handoff: HandoffRow;
  readonly revisionNo: number;
  readonly created: boolean;
}

function insertRevision(
  deps: HandoffWriteDeps,
  handoffId: string,
  cutoff: HandoffCutoff,
  serialized: { readonly manifest: HandoffManifest; readonly json: string; readonly digest: string }
): number {
  const { store } = deps;
  const revisionNo = store.maxRevisionNo(handoffId) + 1;
  store.insertRevision({
    handoffId,
    revisionNo,
    cutoffKey: cutoffKeyFor(cutoff),
    executionRevision: cutoff.executionRevision,
    usageRevision: cutoff.usageRevision,
    factCutoffMs: cutoff.factCutoffMs,
    manifestVersion: serialized.manifest.version,
    manifestJson: serialized.json,
    manifestDigest: serialized.digest,
    certainty: serialized.manifest.certainty,
    coverage: serialized.manifest.coverage
  });
  for (const ref of serialized.manifest.references) {
    store.insertReference({
      handoffId,
      revisionNo,
      artifactId: ref.artifactId,
      role: ref.role,
      required: ref.required,
      expectedDigest: ref.digest ?? null
    });
  }
  return revisionNo;
}

function requiredRefusal(artifactIds: readonly string[]): RequiredPinRefusal {
  return { ok: false, code: 'required-pin-refused', artifactIds };
}

/** Steps 2 and 3 of `prepare`: one immediate transaction. */
function locate(
  deps: HandoffWriteDeps,
  lineage: HandoffLineage,
  cutoff: HandoffCutoff,
  serialized: { readonly manifest: HandoffManifest; readonly json: string; readonly digest: string },
  legacyProvenance: string | null
): Located | HandoffRefusal<'handoff-closed' | 'unsupported-version'> {
  const { store } = deps;
  const handoffId = handoffIdFor(lineage);
  return store.transaction(() => {
    store.insertHandoff({ handoffId, ...lineage, legacyProvenance, nowMs: deps.nowMs() });
    const handoff = store.getHandoff(handoffId);
    if (handoff === undefined) throw new Error('handoff row missing after insert');
    if (CLOSED_HANDOFF_STATES.has(handoff.state)) return { ok: false, code: 'handoff-closed' } as const;
    if (handoff.state === 'unsupported') return { ok: false, code: 'unsupported-version' } as const;
    const existing = store.getRevisionByCutoff(handoffId, cutoffKeyFor(cutoff));
    if (existing !== undefined) return { handoff, revisionNo: existing.revisionNo, created: false };
    return { handoff, revisionNo: insertRevision(deps, handoffId, cutoff, serialized), created: true };
  });
}

/** Contract `prepare`: validate, find or create, then pin. */
export function prepareRevision(
  deps: HandoffWriteDeps,
  lineage: HandoffLineage,
  cutoff: HandoffCutoff,
  rawManifest: unknown,
  legacyProvenance?: string
): PrepareResult {
  const invalid = invalidInput(lineage, cutoff, legacyProvenance);
  if (invalid !== null) return invalid;
  const serialized = serializeHandoffManifest(rawManifest);
  if (!serialized.ok) return serialized;
  if (isNewerBuildStore(deps.conn)) return { ok: false, code: 'unsupported-version' };
  const located = locate(deps, lineage, cutoff, serialized, legacyProvenance ?? null);
  if ('ok' in located) return located;
  const { handoffId } = located.handoff;
  const pins = pinRevision(deps, handoffId, located.revisionNo);
  const required = pins.refusals.filter((refusal) => refusal.required).map((refusal) => refusal.artifactId);
  if (required.length > 0) return requiredRefusal(required);
  return {
    ok: true,
    handoffId,
    revisionNo: located.revisionNo,
    state: deps.store.getHandoff(handoffId)?.state ?? located.handoff.state,
    created: located.created,
    pinRefusals: pins.refusals
  };
}

function unpinnedRequired(deps: HandoffWriteDeps, handoffId: string, revisionNo: number): readonly string[] {
  return deps.store
    .listReferences(handoffId, revisionNo)
    .filter((row) => row.required && row.pinState !== 'pinned')
    .map((row) => row.artifactId);
}

type IssueCheck = HandoffRefusal<'not-found' | 'handoff-closed' | 'stale-revision' | 'conflict' | 'unsupported-version'>;

/** The refusals `issue` makes before it writes, or `repeat` for an already issued current revision. */
function checkIssue(deps: HandoffWriteDeps, handoff: HandoffRow, revisionNo: number): IssueCheck | 'repeat' | null {
  if (CLOSED_HANDOFF_STATES.has(handoff.state)) return { ok: false, code: 'handoff-closed' };
  if (handoff.state === 'unsupported') return { ok: false, code: 'unsupported-version' };
  const revision = deps.store.getRevision(handoff.handoffId, revisionNo);
  if (revision === undefined) return { ok: false, code: 'not-found' };
  if (revision.status === 'superseded') return { ok: false, code: 'stale-revision' };
  if (revision.status === 'issued') {
    return handoff.currentRevision === revisionNo ? 'repeat' : { ok: false, code: 'stale-revision' };
  }
  if (handoff.currentRevision !== null && revisionNo < handoff.currentRevision) {
    return { ok: false, code: 'stale-revision' };
  }
  if (!ISSUABLE_STATES.has(handoff.state)) return { ok: false, code: 'conflict' };
  return null;
}

/** Contract `issue`. */
export function issueRevision(deps: HandoffWriteDeps, handoffId: string, revisionNo: number): IssueResult {
  const handoff = deps.store.getHandoff(handoffId);
  if (handoff === undefined) return { ok: false, code: 'not-found' };
  const check = checkIssue(deps, handoff, revisionNo);
  if (check === 'repeat') return { ok: true, state: handoff.state, revisionNo };
  if (check !== null) return check;
  pinRevision(deps, handoffId, revisionNo);
  const missing = unpinnedRequired(deps, handoffId, revisionNo);
  if (missing.length > 0) return requiredRefusal(missing);
  const previous = handoff.currentRevision;
  const nowMs = deps.nowMs();
  deps.store.transaction(() => {
    deps.store.issueRevision(handoffId, revisionNo, nowMs);
    if (previous !== null && previous !== revisionNo) deps.store.supersedeRevision(handoffId, previous, nowMs);
    deps.store.updateHandoff(handoffId, { state: 'ready', currentRevision: revisionNo }, nowMs);
  });
  const target = pinPurposeFor('ready', handoff.paused);
  if (target !== null && target !== handoff.pinPurpose) switchPurpose(deps, handoffId, target);
  const superseded = previous !== null && previous !== revisionNo ? { supersededRevision: previous } : {};
  return { ok: true, state: 'ready', revisionNo, ...superseded };
}
