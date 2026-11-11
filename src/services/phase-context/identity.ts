/**
 * FR-R6-F15 (F15-A; FR-002, FR-014) — the identity of one handoff: the lineage values that
 * make it distinct, and the digest that names it. Two handoffs share an identity only when
 * every value is equal; the order the source attempts arrive in does not matter.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  IDENTIFIER_PATTERN,
  NODE_PATH_PATTERN,
  PHASE_CONTEXT_LIMITS,
  type HandoffIdentity,
  type ProducerRef,
  type Refusal
} from '../../contracts/phase-context/context-policy';
import { compareText, hasExactKeys, isWholeNumber, listOf, matchesPattern, plainRecord, refuse, taggedDigest } from './primitives';

export type IdentityParse = { readonly ok: true; readonly identity: HandoffIdentity; readonly handoffId: string } | Refusal;

const IDENTITY_KEYS = [
  'workspaceId',
  'rootExecutionId',
  'sourceInvocationId',
  'targetNodePath',
  'targetOccurrenceId',
  'inputEnvelopeRevision',
  'sourceAttempts'
] as const;
const PRODUCER_KEYS = ['nodePath', 'occurrenceId', 'attemptId'] as const;
const IDENTITY_DIGEST_TAG = 'pch1';

/** One exact producer attempt, or `null` when the value is not one. */
export function parseProducerRef(value: unknown): ProducerRef | null {
  const record = plainRecord(value);
  if (record === null || !hasExactKeys(record, PRODUCER_KEYS)) return null;
  const { nodePath, occurrenceId, attemptId } = record;
  if (!matchesPattern(NODE_PATH_PATTERN, nodePath)) return null;
  if (!matchesPattern(IDENTIFIER_PATTERN, occurrenceId)) return null;
  if (!matchesPattern(IDENTIFIER_PATTERN, attemptId)) return null;
  return { nodePath, occurrenceId, attemptId };
}

/** Node path, then occurrence, then attempt, each by code unit. */
export function compareProducers(left: ProducerRef, right: ProducerRef): number {
  const byNodePath = compareText(left.nodePath, right.nodePath);
  if (byNodePath !== 0) return byNodePath;
  const byOccurrence = compareText(left.occurrenceId, right.occurrenceId);
  if (byOccurrence !== 0) return byOccurrence;
  return compareText(left.attemptId, right.attemptId);
}

export function sameProducer(left: ProducerRef, right: ProducerRef): boolean {
  return compareProducers(left, right) === 0;
}

/** One text per producer attempt, for sets and maps. */
export function producerKey(producer: ProducerRef): string {
  return JSON.stringify([producer.nodePath, producer.occurrenceId, producer.attemptId]);
}

export function handoffIdOf(identity: HandoffIdentity): string {
  const attempts = [...identity.sourceAttempts].sort(compareProducers);
  return taggedDigest([
    IDENTITY_DIGEST_TAG,
    identity.workspaceId,
    identity.rootExecutionId,
    identity.sourceInvocationId,
    identity.targetNodePath,
    identity.targetOccurrenceId,
    identity.inputEnvelopeRevision,
    attempts.map((attempt) => [attempt.nodePath, attempt.occurrenceId, attempt.attemptId])
  ]);
}

/** The source attempts, sorted, or the detail code of what is wrong with them. */
function parseSourceAttempts(value: unknown): readonly ProducerRef[] | string {
  const items = listOf(value, PHASE_CONTEXT_LIMITS.sourceContributionsMax);
  if (items === null || items.length === 0) return 'source-attempt-count';
  const attempts: ProducerRef[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const attempt = parseProducerRef(item);
    if (attempt === null) return 'source-attempt';
    const key = producerKey(attempt);
    if (seen.has(key)) return 'source-attempt-duplicate';
    seen.add(key);
    attempts.push(attempt);
  }
  return attempts.sort(compareProducers);
}

export function parseHandoffIdentity(value: unknown): IdentityParse {
  const record = plainRecord(value);
  if (record === null || !hasExactKeys(record, IDENTITY_KEYS)) return refuse('invalid-source', 'identity-shape');
  const { workspaceId, rootExecutionId, sourceInvocationId, targetNodePath, targetOccurrenceId, inputEnvelopeRevision } = record;
  const fieldsValid =
    matchesPattern(IDENTIFIER_PATTERN, workspaceId) &&
    matchesPattern(IDENTIFIER_PATTERN, rootExecutionId) &&
    matchesPattern(IDENTIFIER_PATTERN, sourceInvocationId) &&
    matchesPattern(NODE_PATH_PATTERN, targetNodePath) &&
    matchesPattern(IDENTIFIER_PATTERN, targetOccurrenceId) &&
    isWholeNumber(inputEnvelopeRevision, 1);
  if (!fieldsValid) return refuse('invalid-source', 'identity-field');
  const sourceAttempts = parseSourceAttempts(record.sourceAttempts);
  if (typeof sourceAttempts === 'string') return refuse('invalid-source', sourceAttempts);
  const identity: HandoffIdentity = {
    workspaceId,
    rootExecutionId,
    sourceInvocationId,
    targetNodePath,
    targetOccurrenceId,
    inputEnvelopeRevision,
    sourceAttempts
  };
  return { ok: true, identity, handoffId: handoffIdOf(identity) };
}
