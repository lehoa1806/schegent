/**
 * FR-R6-F15 (F15-A; FR-019, FR-022, FR-034, SC-007) — a handoff and a review loop explained
 * from metadata, and the observation of one lifecycle event.
 *
 * Nothing here holds context text. A source is shown by who made it, why it was taken and how
 * many entries it has; a finding by its identity, severity, status and claim kinds. Every value
 * copied from a stored record is first checked to be an identifier, a digest, a whole number or
 * a member of a closed list, so a record that was altered in storage is refused and never
 * quoted.
 *
 * Two observations of one transfer carry the same key: the key is derived from the handoff, the
 * revision, the event and, for a dispatch event, the target attempt, and from nothing that
 * changes when the record is written again.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  HANDOFF_EVENTS,
  type AcceptedRevision,
  type ExplainedRevision,
  type ExplainedSource,
  type HandoffEvent,
  type HandoffExplanation,
  type HandoffManifest,
  type HandoffObservation,
  type HandoffRecord,
  type ManifestSource,
  type PreparedHandoff
} from '../../contracts/phase-context/context-manifest';
import { IDENTIFIER_PATTERN, PHASE_CONTEXT_LIMITS, type Refusal } from '../../contracts/phase-context/context-policy';
import type { ExplainedFinding, Finding, ReviewLoopExplanation } from '../../contracts/phase-context/review-loop';
import { soundRecord, storedManifest } from './acceptance';
import type { FindingLedger } from './finding-ledger';
import { isOneOf, matchesPattern, refuse, taggedDigest } from './primitives';
import { utf8Bytes } from './text-bounds';

/** Names the layout of the values an observation key is derived from. */
const OBSERVATION_KEY_TAG = 'pco1';
/** The attempt part of the key of an event that is not a dispatch. */
const NO_ATTEMPT = '';

export type ExplainResult = { readonly ok: true; readonly explanation: HandoffExplanation } | Refusal;

/** The manifest of a stored revision, when its text is the manifest of that handoff and revision. */
function manifestOf(record: HandoffRecord, stored: AcceptedRevision): HandoffManifest | null {
  const manifest = storedManifest(stored);
  if (manifest === null) return null;
  return manifest.handoffId === record.handoffId && manifest.revision === stored.revision ? manifest : null;
}

function explainedRevision(entry: AcceptedRevision): ExplainedRevision {
  return {
    revision: entry.revision,
    manifestDigest: entry.manifestDigest,
    rendererVersion: entry.rendererVersion,
    renderedDigest: entry.renderedDigest,
    renderedBytes: entry.renderedBytes,
    state: entry.state
  };
}

function explainedSource(source: ManifestSource): ExplainedSource {
  return {
    producer: source.producer,
    coverage: source.coverage,
    required: source.required,
    selectedBy: source.selectedBy,
    outcomes: source.outcomes.length,
    decisions: source.decisions.length,
    constraints: source.constraints.length,
    unresolvedIssues: source.unresolvedIssues.length,
    hasSummary: source.summary !== null,
    artifacts: source.artifacts.length
  };
}

function explanationOf(record: HandoffRecord, manifest: HandoffManifest): HandoffExplanation {
  return {
    handoffId: record.handoffId,
    recordVersion: record.version,
    identity: manifest.identity,
    revisions: record.revisions.map(explainedRevision),
    revision: manifest.revision,
    origin: manifest.origin,
    approval: manifest.approval,
    session: manifest.session,
    policyDigest: manifest.policyDigest,
    cutoffSequence: manifest.cutoffSequence,
    renderedBytesMax: manifest.renderedBytesMax,
    sources: manifest.sources.map(explainedSource),
    omissions: manifest.omissions,
    omissionsUnlisted: manifest.omissionsUnlisted,
    approvals: record.approvals.map((entry) => ({ revision: entry.revision, decisionId: entry.decisionId })),
    dispatches: record.dispatches.map((entry) => ({
      revision: entry.revision,
      targetAttemptId: entry.targetAttemptId,
      representationDigest: entry.representationDigest,
      state: entry.state
    }))
  };
}

/**
 * FR-019: explains one revision of a handoff, the latest unless another is named.
 *
 * Refused as `storage-unavailable` when the record or the stored manifest is not what
 * acceptance wrote, as `stale-revision` when the record does not hold the revision, and as
 * `capacity-exceeded` when the explanation would pass 64 KiB serialized.
 */
export function explainHandoff(record: HandoffRecord, revision?: number): ExplainResult {
  if (!soundRecord(record)) return refuse('storage-unavailable', 'stored-record');
  const stored = revision === undefined ? record.revisions.at(-1) : record.revisions.find((entry) => entry.revision === revision);
  if (stored === undefined) return refuse('stale-revision', 'unknown-revision');
  const manifest = manifestOf(record, stored);
  if (manifest === null) return refuse('storage-unavailable', 'stored-manifest');
  const explanation = explanationOf(record, manifest);
  if (utf8Bytes(JSON.stringify(explanation)) > PHASE_CONTEXT_LIMITS.explanationBytesMax) {
    return refuse('capacity-exceeded', 'explanation-bytes');
  }
  return { ok: true, explanation };
}

function observation(event: HandoffEvent, manifest: HandoffManifest, renderedBytes: number, attempt: string): HandoffObservation {
  return {
    key: taggedDigest([OBSERVATION_KEY_TAG, manifest.handoffId, manifest.revision, event, attempt]),
    event,
    handoffId: manifest.handoffId,
    revision: manifest.revision,
    sourceCount: manifest.sources.length,
    omissionCount: manifest.omissions.length + manifest.omissionsUnlisted,
    renderedBytes
  };
}

/**
 * The attempt part of the key when the record shows the event happened to the revision, or
 * `null` when it does not. Only a dispatch event is keyed by an attempt.
 */
function attemptOf(event: HandoffEvent, record: HandoffRecord, stored: AcceptedRevision, targetAttemptId: unknown): string | null {
  if (event === 'prepared' || event === 'accepted') return NO_ATTEMPT;
  if (event === 'approved') return record.approvals.some((entry) => entry.revision === stored.revision) ? NO_ATTEMPT : null;
  if (event === 'superseded') return stored.state === 'superseded' ? NO_ATTEMPT : null;
  if (!matchesPattern(IDENTIFIER_PATTERN, targetAttemptId)) return null;
  const dispatch = record.dispatches.find((entry) => entry.revision === stored.revision && entry.targetAttemptId === targetAttemptId);
  if (dispatch === undefined) return null;
  if (event === 'dispatch-intent') return targetAttemptId;
  return dispatch.state === event ? targetAttemptId : null;
}

/**
 * FR-022: the observation of an event of a stored revision, or `null` when the record does not
 * show that the event happened. The intent of a dispatch stays observable after it is settled.
 */
export function observationOf(event: HandoffEvent, record: HandoffRecord, revision: number, targetAttemptId?: string): HandoffObservation | null {
  const named: unknown = event;
  if (!isOneOf(HANDOFF_EVENTS, named) || !soundRecord(record)) return null;
  const stored = record.revisions.find((entry) => entry.revision === revision);
  if (stored === undefined) return null;
  const manifest = manifestOf(record, stored);
  if (manifest === null) return null;
  const attempt = attemptOf(named, record, stored, targetAttemptId);
  return attempt === null ? null : observation(named, manifest, stored.renderedBytes, attempt);
}

/** FR-022: the `prepared` event of a handoff not yet accepted, under the key it keeps once it is. */
export function observePrepared(prepared: PreparedHandoff): HandoffObservation {
  return observation('prepared', prepared.manifest, prepared.rendered.bytes, NO_ATTEMPT);
}

function explainedFinding(finding: Finding): ExplainedFinding {
  return {
    id: finding.id,
    severity: finding.severity,
    status: finding.status,
    openedInPass: finding.openedInPass,
    claims: finding.claims.map((entry) => entry.claim)
  };
}

/**
 * FR-034: the state of a review loop by identities, severities, statuses and counts. The loop
 * id is the caller's; `null` when it is not an identifier, so no prose is echoed under it.
 */
export function explainReviewLoop(ledger: FindingLedger, loopId: string): ReviewLoopExplanation | null {
  if (!matchesPattern(IDENTIFIER_PATTERN, loopId)) return null;
  const passes = ledger.passes();
  const latest = passes.at(-1);
  return {
    loopId,
    passes: passes.length,
    latestVerdict: latest?.verdict ?? null,
    blockingCount: latest?.blockingCount ?? 0,
    open: latest?.open ?? 0,
    resolved: latest?.resolved ?? 0,
    findings: ledger.findings().map(explainedFinding)
  };
}
