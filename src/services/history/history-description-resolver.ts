// FR-R3-071 (feature 152) — the read half FR-R3-010 built and never wired.
//
// T405 moved the full sanitized description out of the memento into a sidecar:
// `buildHistoryEntry` stopped emitting `originalDescription`, `withDescriptionRef`
// stamps `descriptionRef`, and `HistoryDescriptionStore.read` existed with zero
// callers — so every entry the build wrote took the replay commands' legacy
// branch, refusing normal replay and substituting the 80-char preview under
// force. This module is the single decision site those commands consult; they
// MUST NOT read `originalDescription` or `descriptionRef` directly for replay
// decisions (contracts/description-resolution.md rule 2).

import type { HistoryEntry } from '../../state/history-entry';
import type { SanitizedLogger } from '../../lib/logger';
import type {
  HistoryDescriptionReadOutcome,
  HistoryDescriptionStore
} from './history-description-store';

/**
 * What resolving an entry's description established.
 *
 * `resolved` is the sidecar's bytes, exactly as the recorder wrote them — no
 * re-sanitization, no trimming (the store's contents were sanitized once, at
 * `buildHistoryEntry`). `legacy` is a pre-FR-R3-010 entry's inline text, or an
 * entry whose reference no longer answers but whose inline text does — the
 * authored text either way. `missing` and `unreadable` are the two refusal
 * wordings the commands already carry.
 */
export type DescriptionResolution =
  | { readonly outcome: 'resolved'; readonly description: string }
  | { readonly outcome: 'legacy'; readonly description: string }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'unreadable' };

export interface DescriptionResolverDeps {
  readonly descriptions: Pick<HistoryDescriptionStore, 'read'>;
  readonly logger: Pick<SanitizedLogger, 'warn'>;
}

type ResolvableEntry = Pick<HistoryEntry, 'runId' | 'descriptionRef' | 'originalDescription'>;

/**
 * The reference wins when it resolves; the inline text answers when it exists
 * and the reference does not; neither is a silent truncation — the preview is
 * never returned from here, because "replay the preview knowingly" is `force`'s
 * meaning and force is the caller's decision, not this function's.
 */
export async function resolveHistoryDescription(
  entry: ResolvableEntry,
  deps: DescriptionResolverDeps
): Promise<DescriptionResolution> {
  const inline = typeof entry.originalDescription === 'string' ? entry.originalDescription : null;
  if (entry.descriptionRef === undefined) {
    return inline !== null ? { outcome: 'legacy', description: inline } : { outcome: 'missing' };
  }
  const read = await deps.descriptions.read(entry.descriptionRef);
  if (read.outcome === 'read') return { outcome: 'resolved', description: read.text };
  if (inline !== null) {
    // A dangling or refused reference on an entry that also carries the
    // authored text: the text answers, and the reference's failure is recorded
    // rather than silently absorbed — a refused ref on a readable entry is the
    // tampered-ref shape worth a line in the log.
    deps.logger.warn(
      `history-description: ref did not resolve (${describeFailure(read)}) runId=${entry.runId}; using inline legacy text`
    );
    return { outcome: 'legacy', description: inline };
  }
  return read.outcome === 'missing' ? { outcome: 'missing' } : { outcome: 'unreadable' };
}

function describeFailure(read: Exclude<HistoryDescriptionReadOutcome, { outcome: 'read' }>): string {
  return read.outcome === 'unreadable' ? `unreadable ${read.code}` : read.outcome;
}
