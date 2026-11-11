/**
 * FR-R6-F15 (F15-A; FR-011, FR-012, FR-015, FR-021, NFR-004) — acceptance of a prepared handoff
 * over a store port: revisions, edits, manual approvals and dispatch intents.
 *
 * Acceptance, approval and a dispatch intent are idempotent by identity (FR-011): asking again
 * returns what is stored and writes nothing. An edit is not: it is a compare-and-set on the
 * current revision, so the same edit asked a second time is refused as stale. A revision, once
 * stored, keeps its serialized manifest; a later revision only marks it superseded. An approval
 * names one revision and does not carry to the next. Reading a handoff writes nothing. No
 * exactly-once delivery is claimed: a dispatch intent says a send may have happened, and an
 * attempt whose delivery is uncertain gets no second intent.
 *
 * A record is checked when it is loaded. One whose entries do not have the shape acceptance
 * writes, or that belongs to another handoff, is refused before any operation reads it.
 *
 * A prepared handoff is taken from its serialized text alone. The text is parsed, checked to be
 * the one serialization of its manifest and rendered again, so the stored digests are of what
 * the host computed here, not of what the caller says beside it.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  DISPATCH_STATES,
  REVISION_STATES,
  type AcceptedRevision,
  type ApprovalRecord,
  type DispatchRecord,
  type HandoffManifest,
  type HandoffRecord,
  type HandoffStorePort,
  type PreparedHandoff
} from '../../contracts/phase-context/context-manifest';
import { DIGEST_PATTERN, IDENTIFIER_PATTERN, PHASE_CONTEXT_LIMITS, type Refusal } from '../../contracts/phase-context/context-policy';
import { manifestDigestOf, parseManifest, serializeManifest } from './manifest';
import { isOneOf, isWholeNumber, listOf, matchesPattern, plainRecord, refuse } from './primitives';
import { renderContext } from './renderer';
import { editRevision } from './revision-edit';
import { utf8Bytes } from './text-bounds';

export type AcceptResult = { readonly ok: true; readonly revision: AcceptedRevision; readonly created: boolean } | Refusal;
export type EditOutcome = { readonly ok: true; readonly revision: AcceptedRevision; readonly prepared: PreparedHandoff } | Refusal;
export type ApproveResult = { readonly ok: true; readonly approval: ApprovalRecord; readonly created: boolean } | Refusal;
export type InspectResult = { readonly ok: true; readonly record: HandoffRecord | null } | Refusal;
export type DispatchIntentResult = { readonly ok: true; readonly dispatch: DispatchRecord; readonly created: boolean } | Refusal;
export type SettleResult = { readonly ok: true; readonly dispatch: DispatchRecord } | Refusal;

export interface AcceptanceService {
  accept(prepared: PreparedHandoff): AcceptResult;
  edit(handoffId: string, baseRevision: number, replacementSources: unknown): EditOutcome;
  approve(handoffId: string, revision: number, decisionId: string): ApproveResult;
  inspect(handoffId: string): InspectResult;
  recordDispatchIntent(handoffId: string, revision: number, targetAttemptId: string, representationDigest: string): DispatchIntentResult;
  settleDispatch(handoffId: string, revision: number, targetAttemptId: string, outcome: 'delivered' | 'uncertain'): SettleResult;
}

/** A lost version race is tried once more; a second loss is reported. */
const SAVE_ATTEMPTS = 2;
const NEW_RECORD_VERSION = 0;
const FIRST_REVISION = 1;
/** What a dispatch intent may be settled as. The value arrives from a caller, so it is checked. */
const SETTLED_OUTCOMES = ['delivered', 'uncertain'] as const;

/** What one operation decides from the stored record: its answer, and the record to store. */
interface Step<T> {
  readonly result: T | Refusal;
  readonly write?: HandoffRecord;
}

function parseJson(text: string): { readonly value: unknown } | null {
  try {
    const value: unknown = JSON.parse(text);
    return { value };
  } catch {
    return null;
  }
}

/**
 * The manifest a stored revision holds, or `null` when the stored text is not one. The text is
 * read only when it is text, within the manifest size limit, and the text the recorded digest
 * was taken of.
 */
export function storedManifest(revision: AcceptedRevision): HandoffManifest | null {
  const text: unknown = revision.serializedManifest;
  if (typeof text !== 'string' || utf8Bytes(text) > PHASE_CONTEXT_LIMITS.manifestBytesMax) return null;
  if (manifestDigestOf(text) !== revision.manifestDigest) return null;
  const parsed = parseJson(text);
  if (parsed === null) return null;
  const manifest = parseManifest(parsed.value);
  return manifest.kind === 'valid' ? manifest.manifest : null;
}

/** A stored revision in its place: revisions are numbered from 1 in the order they were written. */
function soundRevision(value: unknown, index: number): boolean {
  const entry = plainRecord(value);
  return (
    entry !== null &&
    entry.revision === index + FIRST_REVISION &&
    matchesPattern(DIGEST_PATTERN, entry.manifestDigest) &&
    isWholeNumber(entry.rendererVersion, 1) &&
    matchesPattern(DIGEST_PATTERN, entry.renderedDigest) &&
    isWholeNumber(entry.renderedBytes, 0) &&
    isOneOf(REVISION_STATES, entry.state)
  );
}

function soundApproval(value: unknown): boolean {
  const entry = plainRecord(value);
  return entry !== null && isWholeNumber(entry.revision, 1) && matchesPattern(IDENTIFIER_PATTERN, entry.decisionId);
}

function soundDispatch(value: unknown): boolean {
  const entry = plainRecord(value);
  return (
    entry !== null &&
    isWholeNumber(entry.revision, 1) &&
    matchesPattern(IDENTIFIER_PATTERN, entry.targetAttemptId) &&
    matchesPattern(DIGEST_PATTERN, entry.representationDigest) &&
    isOneOf(DISPATCH_STATES, entry.state)
  );
}

/**
 * True when the value is a handoff record whose every entry has the shape it was stored with,
 * and whose revisions stand in the order they were written.
 * Each list is copied before it is walked, so an entry that was never set is seen and refused.
 */
export function soundRecord(value: unknown): boolean {
  const record = plainRecord(value);
  if (record === null) return false;
  const revisions = listOf(record.revisions, PHASE_CONTEXT_LIMITS.revisionsMax);
  const approvals = listOf(record.approvals, PHASE_CONTEXT_LIMITS.revisionsMax);
  const dispatches = listOf(record.dispatches, PHASE_CONTEXT_LIMITS.dispatchesMax);
  if (revisions === null || approvals === null || dispatches === null) return false;
  return (
    matchesPattern(DIGEST_PATTERN, record.handoffId) &&
    isWholeNumber(record.version, 0) &&
    Array.from(revisions).every(soundRevision) &&
    Array.from(approvals).every(soundApproval) &&
    Array.from(dispatches).every(soundDispatch)
  );
}

/**
 * The prepared handoff as the host computes it from the serialized text. The manifest object
 * beside the text is not read: the text is what gets stored.
 */
function checkPrepared(prepared: unknown): { readonly ok: true; readonly prepared: PreparedHandoff } | Refusal {
  const record = plainRecord(prepared);
  if (record === null) return refuse('invalid-source', 'prepared-shape');
  const { serialized, manifestDigest } = record;
  const claimed = plainRecord(record.rendered);
  if (typeof serialized !== 'string' || claimed === null) return refuse('invalid-source', 'prepared-shape');
  if (utf8Bytes(serialized) > PHASE_CONTEXT_LIMITS.manifestBytesMax) return refuse('capacity-exceeded', 'manifest-bytes');

  const json = parseJson(serialized);
  if (json === null) return refuse('invalid-source', 'prepared-manifest');
  const parsed = parseManifest(json.value);
  if (parsed.kind === 'unsupported-version') return refuse('unsupported-version', 'manifest-version');
  if (parsed.kind === 'invalid') return refuse('invalid-source', parsed.detail);
  const { manifest } = parsed;
  if (serializeManifest(manifest) !== serialized) return refuse('invalid-source', 'prepared-not-canonical');
  const digest = manifestDigestOf(serialized);
  if (manifestDigest !== digest) return refuse('invalid-source', 'prepared-digest');

  const rendered = renderContext(manifest);
  const sameRendering =
    claimed.rendererVersion === rendered.rendererVersion &&
    claimed.digestHex === rendered.digestHex &&
    claimed.bytes === rendered.bytes &&
    claimed.text === rendered.text;
  if (!sameRendering) return refuse('invalid-source', 'prepared-rendered');
  if (rendered.bytes > manifest.renderedBytesMax) return refuse('capacity-exceeded', 'rendered-bytes');
  return { ok: true, prepared: { manifest, serialized, manifestDigest: digest, rendered } };
}

/** FR-012: a revision of a manual handoff waits for its own approval. */
function revisionOf(prepared: PreparedHandoff): AcceptedRevision {
  return {
    revision: prepared.manifest.revision,
    manifestDigest: prepared.manifestDigest,
    serializedManifest: prepared.serialized,
    rendererVersion: prepared.rendered.rendererVersion,
    renderedDigest: prepared.rendered.digestHex,
    renderedBytes: prepared.rendered.bytes,
    state: prepared.manifest.approval === 'manual' ? 'waiting-approval' : 'ready'
  };
}

/** FR-015: the record with one more revision. Every earlier revision is superseded, its text kept. */
function withRevision(record: HandoffRecord | null, handoffId: string, revision: AcceptedRevision): HandoffRecord {
  const earlier = (record?.revisions ?? []).map((entry): AcceptedRevision => ({ ...entry, state: 'superseded' }));
  return {
    handoffId,
    version: record?.version ?? NEW_RECORD_VERSION,
    revisions: [...earlier, revision],
    approvals: record?.approvals ?? [],
    dispatches: record?.dispatches ?? []
  };
}

/**
 * Why a revision cannot follow the current one, or `null`. A later revision selects again or
 * edits; it does not change the rules the handoff was accepted under, so a manual handoff
 * cannot become automatic by being prepared again.
 */
function successorFault(current: AcceptedRevision, next: HandoffManifest): Refusal | null {
  const basis = storedManifest(current);
  if (basis === null) return refuse('storage-unavailable', 'stored-manifest');
  const sameBasis =
    basis.policyDigest === next.policyDigest &&
    basis.approval === next.approval &&
    basis.session === next.session &&
    basis.targetInstructionsDigest === next.targetInstructionsDigest;
  return sameBasis ? null : refuse('stale-revision', 'revision-basis');
}

function placeRevision(record: HandoffRecord | null, prepared: PreparedHandoff): Step<AcceptResult> {
  const { manifest } = prepared;
  const revisions = record?.revisions ?? [];
  const stored = revisions.find((entry) => entry.revision === manifest.revision);
  if (stored !== undefined) {
    if (stored.manifestDigest !== prepared.manifestDigest) return { result: refuse('stale-revision', 'revision-conflict') };
    return { result: { ok: true, revision: stored, created: false } };
  }
  const current = revisions.at(-1);
  const expected = current === undefined ? FIRST_REVISION : current.revision + 1;
  if (manifest.revision !== expected) return { result: refuse('stale-revision', 'revision-number') };
  const fault = current === undefined ? null : successorFault(current, manifest);
  if (fault !== null) return { result: fault };
  if (revisions.length >= PHASE_CONTEXT_LIMITS.revisionsMax) return { result: refuse('capacity-exceeded', 'revision-count') };
  const revision = revisionOf(prepared);
  return { result: { ok: true, revision, created: true }, write: withRevision(record, manifest.handoffId, revision) };
}

function placeEdit(record: HandoffRecord | null, baseRevision: number, replacementSources: unknown): Step<EditOutcome> {
  if (record === null) return { result: refuse('stale-revision', 'unknown-handoff') };
  const current = record.revisions.at(-1);
  if (current?.revision !== baseRevision) return { result: refuse('stale-revision', 'revision-not-current') };
  if (record.revisions.length >= PHASE_CONTEXT_LIMITS.revisionsMax) return { result: refuse('capacity-exceeded', 'revision-count') };
  const base = storedManifest(current);
  if (base === null) return { result: refuse('storage-unavailable', 'stored-manifest') };
  const edited = editRevision(base, replacementSources);
  if (!edited.ok) return { result: edited };
  const revision = revisionOf(edited.prepared);
  return { result: { ok: true, revision, prepared: edited.prepared }, write: withRevision(record, record.handoffId, revision) };
}

function placeApproval(record: HandoffRecord | null, revision: number, decisionId: string): Step<ApproveResult> {
  if (record === null) return { result: refuse('stale-revision', 'unknown-handoff') };
  const named = record.revisions.find((entry) => entry.revision === revision);
  if (named === undefined) return { result: refuse('stale-revision', 'unknown-revision') };
  const manifest = storedManifest(named);
  if (manifest === null) return { result: refuse('storage-unavailable', 'stored-manifest') };
  if (manifest.approval !== 'manual') return { result: refuse('invalid-policy', 'approval-not-required') };
  if (record.revisions.at(-1)?.revision !== revision) return { result: refuse('stale-revision', 'revision-not-current') };
  const stored = record.approvals.find((entry) => entry.revision === revision);
  if (stored !== undefined) {
    if (stored.decisionId !== decisionId) return { result: refuse('stale-revision', 'approval-conflict') };
    return { result: { ok: true, approval: stored, created: false } };
  }
  const approval: ApprovalRecord = { revision, decisionId };
  const revisions = record.revisions.map((entry): AcceptedRevision => (entry.revision === revision ? { ...entry, state: 'ready' } : entry));
  return { result: { ok: true, approval, created: true }, write: { ...record, revisions, approvals: [...record.approvals, approval] } };
}

function placeIntent(record: HandoffRecord | null, intent: DispatchRecord): Step<DispatchIntentResult> {
  if (record === null) return { result: refuse('stale-revision', 'unknown-handoff') };
  // One target attempt gets one dispatch record, whichever revision it was for.
  const stored = record.dispatches.find((entry) => entry.targetAttemptId === intent.targetAttemptId);
  if (stored?.state === 'uncertain') return { result: refuse('uncertain-delivery', 'dispatch-uncertain') };
  const named = record.revisions.find((entry) => entry.revision === intent.revision);
  if (named?.state !== 'ready') return { result: refuse('stale-revision', 'revision-not-ready') };
  if (stored !== undefined) {
    const same = stored.revision === intent.revision && stored.representationDigest === intent.representationDigest;
    return { result: same ? { ok: true, dispatch: stored, created: false } : refuse('stale-revision', 'dispatch-conflict') };
  }
  if (record.dispatches.length >= PHASE_CONTEXT_LIMITS.dispatchesMax) return { result: refuse('capacity-exceeded', 'dispatch-count') };
  return { result: { ok: true, dispatch: intent, created: true }, write: { ...record, dispatches: [...record.dispatches, intent] } };
}

function placeSettlement(
  record: HandoffRecord | null,
  revision: number,
  targetAttemptId: string,
  outcome: 'delivered' | 'uncertain'
): Step<SettleResult> {
  if (record === null) return { result: refuse('stale-revision', 'unknown-handoff') };
  const stored = record.dispatches.find((entry) => entry.revision === revision && entry.targetAttemptId === targetAttemptId);
  if (stored === undefined) return { result: refuse('stale-revision', 'unknown-dispatch') };
  if (stored.state === outcome) return { result: { ok: true, dispatch: stored } };
  // A settled dispatch keeps its outcome; reconciling an uncertain one is F15-B.
  if (stored.state !== 'intent') return { result: refuse('stale-revision', 'dispatch-settled') };
  const settled: DispatchRecord = { ...stored, state: outcome };
  const dispatches = record.dispatches.map((entry) => (entry === stored ? settled : entry));
  return { result: { ok: true, dispatch: settled }, write: { ...record, dispatches } };
}

/** The detail code of the first value that is not what an operation takes, or `null`. */
function inputFault(handoffId: unknown, revision?: unknown): string | null {
  if (!matchesPattern(DIGEST_PATTERN, handoffId)) return 'handoff-id';
  if (revision !== undefined && !isWholeNumber(revision, FIRST_REVISION)) return 'revision';
  return null;
}

/**
 * The acceptance operations over one store. The service keeps nothing itself: a second service
 * over the same store sees the same state, as a restarted host would.
 */
export function createAcceptanceService(store: HandoffStorePort): AcceptanceService {
  // A store that throws is reported by a fixed code; no text of the error is kept (FR-021).
  // A record the store returns is not trusted: every operation reads only one that is sound
  // and is the record of the handoff asked for.
  function load(handoffId: string): { readonly record: HandoffRecord | null } | Refusal {
    try {
      const record = store.load(handoffId);
      if (record !== null && (!soundRecord(record) || record.handoffId !== handoffId)) return refuse('storage-unavailable', 'stored-record');
      return { record };
    } catch {
      return refuse('storage-unavailable', 'store-failure');
    }
  }

  function mutate<T>(handoffId: string, decide: (record: HandoffRecord | null) => Step<T>): T | Refusal {
    for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
      const loaded = load(handoffId);
      if ('ok' in loaded) return loaded;
      const step = decide(loaded.record);
      if (step.write === undefined) return step.result;
      try {
        if (store.save(step.write, loaded.record?.version ?? NEW_RECORD_VERSION)) return step.result;
      } catch {
        return refuse('storage-unavailable', 'store-failure');
      }
    }
    return refuse('storage-unavailable', 'version-race');
  }

  return {
    accept(prepared) {
      const checked = checkPrepared(prepared);
      if (!checked.ok) return checked;
      return mutate(checked.prepared.manifest.handoffId, (record) => placeRevision(record, checked.prepared));
    },
    edit(handoffId, baseRevision, replacementSources) {
      const fault = inputFault(handoffId, baseRevision);
      if (fault !== null) return refuse('invalid-source', fault);
      return mutate(handoffId, (record) => placeEdit(record, baseRevision, replacementSources));
    },
    approve(handoffId, revision, decisionId) {
      const fault = inputFault(handoffId, revision) ?? (matchesPattern(IDENTIFIER_PATTERN, decisionId) ? null : 'decision-id');
      if (fault !== null) return refuse('invalid-source', fault);
      return mutate(handoffId, (record) => placeApproval(record, revision, decisionId));
    },
    inspect(handoffId) {
      const fault = inputFault(handoffId);
      if (fault !== null) return refuse('invalid-source', fault);
      const loaded = load(handoffId);
      return 'ok' in loaded ? loaded : { ok: true, record: loaded.record };
    },
    recordDispatchIntent(handoffId, revision, targetAttemptId, representationDigest) {
      const fault =
        inputFault(handoffId, revision) ??
        (matchesPattern(IDENTIFIER_PATTERN, targetAttemptId) ? null : 'target-attempt') ??
        (matchesPattern(DIGEST_PATTERN, representationDigest) ? null : 'representation-digest');
      if (fault !== null) return refuse('invalid-source', fault);
      return mutate(handoffId, (record) => placeIntent(record, { revision, targetAttemptId, representationDigest, state: 'intent' }));
    },
    settleDispatch(handoffId, revision, targetAttemptId, outcome) {
      const fault =
        inputFault(handoffId, revision) ??
        (matchesPattern(IDENTIFIER_PATTERN, targetAttemptId) ? null : 'target-attempt') ??
        (isOneOf(SETTLED_OUTCOMES, outcome) ? null : 'outcome');
      if (fault !== null) return refuse('invalid-source', fault);
      return mutate(handoffId, (record) => placeSettlement(record, revision, targetAttemptId, outcome));
    }
  };
}
