/**
 * FR-R6-F12 (FR-007; research R3) — the comparison revision a review is bound to.
 *
 * The revision hashes the five values that define what a reviewer saw. The values are encoded as
 * a JSON array before hashing, so text cannot move between fields and keep the same revision.
 */

import { createHash } from 'node:crypto';

const REVISION_PREFIX = 'cr1-';

export interface BoundValues {
  readonly candidateCommit: string;
  readonly targetRef: string;
  readonly targetCommit: string;
  readonly profileRevision: number;
  readonly profileDigest: string;
}

/** `cr1-` followed by the SHA-256 of the five bound values. */
export function comparisonRevision(values: BoundValues): string {
  const encoded = JSON.stringify([
    values.candidateCommit,
    values.targetRef,
    values.targetCommit,
    values.profileRevision,
    values.profileDigest
  ]);
  return `${REVISION_PREFIX}${createHash('sha256').update(encoded, 'utf8').digest('hex')}`;
}
