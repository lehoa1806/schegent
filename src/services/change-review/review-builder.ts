/**
 * FR-R6-F12 (FR-004, FR-005; research R1 to R3) — building a review's inventory from a request.
 *
 * The request's values are re-checked against their grammars before any Git call, so a malformed
 * record reads `record-invalid` and never reaches Git. Each Git failure maps to one unavailable
 * reason; no partial inventory is ever kept.
 */

import { CHANGE_REVIEW_LIMITS, type ChangeEntry, type UnavailableReason } from '../../contracts/change-review';
import type { RequestRecord } from '../execution-lanes/integration-store-rows';
import type { BoundValues } from './comparison-revision';
import { opaqueId, type ContentResource, type RandomBytes } from './content-handles';
import { parseInventory, type InventoryRecord } from './diff-inventory-parser';
import { commitExists, isAncestorOf, isObjectId, isTargetRef, readInventory, type ReviewGitContext } from './review-git';

/** The five values a review binds to, exactly as the request holds them. */
export function rawBoundValues(request: RequestRecord): BoundValues {
  return {
    candidateCommit: request.candidateCommit,
    targetRef: request.targetRef,
    targetCommit: request.expectedTargetCommit,
    profileRevision: request.profileRevision,
    profileDigest: request.profileDigest
  };
}

/** Whether every bound value matches its grammar. */
export function boundValuesValid(values: BoundValues): boolean {
  return (
    isObjectId(values.candidateCommit) &&
    isObjectId(values.targetCommit) &&
    isTargetRef(values.targetRef) &&
    Number.isSafeInteger(values.profileRevision) &&
    values.profileRevision >= 0 &&
    typeof values.profileDigest === 'string' &&
    values.profileDigest.length > 0
  );
}

export type InventoryBuild =
  | { readonly ok: true; readonly total: number; readonly records: readonly InventoryRecord[] }
  | { readonly ok: false; readonly reason: UnavailableReason };

function unavailable(reason: UnavailableReason): InventoryBuild {
  return { ok: false, reason };
}

async function missingCommit(ctx: ReviewGitContext, values: BoundValues): Promise<UnavailableReason | null> {
  for (const id of [values.candidateCommit, values.targetCommit]) {
    const exists = await commitExists(ctx, id);
    if (exists === null) return 'inventory-failed';
    if (!exists) return 'commit-missing';
  }
  return null;
}

/** The changed paths between the bound target and candidate, or why there are none to show. */
export async function buildInventory(ctx: ReviewGitContext, values: BoundValues): Promise<InventoryBuild> {
  const missing = await missingCommit(ctx, values);
  if (missing !== null) return unavailable(missing);
  const ancestor = await isAncestorOf(ctx, values.targetCommit, values.candidateCommit);
  if (ancestor === null) return unavailable('inventory-failed');
  if (!ancestor) return unavailable('target-diverged');
  const read = await readInventory(ctx, values.targetCommit, values.candidateCommit);
  if (!read.ok) {
    if (read.failure === 'deadline') return unavailable('inventory-deadline');
    if (read.failure === 'oversized') return unavailable('inventory-oversized');
    return unavailable('inventory-failed');
  }
  const parsed = parseInventory(read.value, CHANGE_REVIEW_LIMITS.loadedEntriesMax);
  return parsed.ok ? { ok: true, total: parsed.total, records: parsed.records } : unavailable('inventory-failed');
}

export interface IssuedEntries {
  readonly entries: readonly ChangeEntry[];
  readonly resources: readonly ContentResource[];
}

/** The entries of one review, with a fresh handle for every side that exists. */
export function issueEntries(reviewId: string, records: readonly InventoryRecord[], random: RandomBytes): IssuedEntries {
  const resources: ContentResource[] = [];
  const side = (blob: string | null, mode: string | null, binary: boolean): string | null => {
    if (blob === null || mode === null) return null;
    const handle = opaqueId(random);
    resources.push({ handle, reviewId, blob, mode, binary });
    return handle;
  };
  const entries = records.map((record, index): ChangeEntry => ({
    index,
    kind: record.kind,
    oldPath: record.oldPath,
    newPath: record.newPath,
    binary: record.binary,
    oldHandle: side(record.oldBlob, record.oldMode, record.binary),
    newHandle: side(record.newBlob, record.newMode, record.binary),
    similarity: record.similarity
  }));
  return { entries, resources };
}
