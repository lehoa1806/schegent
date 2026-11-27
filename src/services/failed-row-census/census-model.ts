// ---------------------------------------------------------------------------
// FR-R4-F16 (feature 244, contract E; data-model §1, §3 to §7) — the failed-row census's types and
// closed sets.
//
// Types and constants only: no I/O, no clock, no import from an acting layer. The census reads the
// audit chain into a compact `CensusLog` (pass 1, `census-log.ts`), reads the queue state into a
// `QueueSnapshot` (`census-snapshot.ts`), and gives every failure episode exactly one `Disposition`
// or one `UnknownReason` (pass 2). Nothing here is persisted.
//
// GROWTH RULE. Both closed sets are written and read in the order below, because the report's tables
// print their members in that order. A member is a token, never a sentence: the report writes only
// closed-set tokens, numbers and ids that pass their patterns, so nothing in it needs escaping.
// ---------------------------------------------------------------------------

import type { FailureCause } from '../../contracts/failure-cause';
import type { QueueFailurePolicy } from '../../contracts/queue-failure-policy';
import type { FeatureRequestStatus } from '../../queue/feature-request';

/** The most episodes the report lists (D10 item 5). Totals always count every episode. */
export const CENSUS_EPISODE_LIST_MAX = 200;

/** How a failed row left the failed state, or was found at the cutoff (D8). */
export const DISPOSITIONS = [
  'resumed',
  'restarted-fresh',
  'attested-removed',
  'removed-failed',
  'removed-other',
  'queue-deleted',
  'queue-cleared',
  'attested-kept',
  'still-failed',
  'retry-requested'
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** Why an episode has no disposition (D9). */
export const UNKNOWN_REASONS = [
  'provenance-not-recorded',
  'completed-without-attestation',
  'row-absent',
  'snapshot-mismatch',
  'history-gap',
  'queue-unresolved'
] as const;
export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

/** A failure cause, or the stand-in for a Run that failed before the cause was recorded. */
export type CensusCause = FailureCause | 'not-recorded';

/** How a `task-removed` entry carried `completionProvenance`, as the log builder reads it. */
export type CensusProvenance = 'absent' | 'null' | 'attested';

/**
 * One census-relevant entry, reduced to its closed fields. `seq` is a counter over every event
 * appended, gaps included, so it is the order of the log. A `gap` is a place where history is
 * missing or unreadable; an unparseable or malformed one carries the stamp of the next parsed entry
 * so the procedure can tell damage before the cutoff from damage after it.
 */
export type CensusEvent =
  | {
      readonly kind: 'ended';
      readonly seq: number;
      readonly stampMs: number;
      readonly runId: string;
      readonly taskId: string;
      readonly failed: boolean;
      readonly cause: CensusCause;
    }
  | {
      readonly kind: 'started';
      readonly seq: number;
      readonly stampMs: number;
      readonly runId: string;
      readonly taskId: string;
      readonly queueId: string;
      readonly isResume: boolean;
    }
  | {
      readonly kind: 'removed';
      readonly seq: number;
      readonly stampMs: number;
      readonly taskId: string;
      readonly queueId: string | null;
      readonly runId: string | null;
      readonly priorStatus: string | null;
      readonly provenance: CensusProvenance;
    }
  | {
      readonly kind: 'moved';
      readonly seq: number;
      readonly stampMs: number;
      readonly taskId: string;
      readonly toQueueId: string;
    }
  | {
      readonly kind: 'queue-deleted' | 'queue-cleared';
      readonly seq: number;
      readonly stampMs: number;
      readonly queueId: string;
    }
  | { readonly kind: 'queue-cleared-all'; readonly seq: number; readonly stampMs: number }
  | { readonly kind: 'gap'; readonly seq: number; readonly cause: 'cut' | 'unreadable-segment' }
  | {
      readonly kind: 'gap';
      readonly seq: number;
      readonly cause: 'unparseable' | 'malformed';
      readonly nextStampMs: number | null;
    };

/** What pass 1 found: the census events in log order, and how complete the reading was. */
export interface CensusLog {
  /** Log order; `seq` strictly increasing. */
  readonly events: readonly CensusEvent[];
  /** Archives plus the live log that were read to the end. The cut file does not count. */
  readonly segmentsRead: number;
  readonly unreadableSegments: number;
  readonly cutRecords: number;
  /** Includes framer-cut lines, unparseable stamps and malformed census entries. */
  readonly unparseableLines: number;
  /** The sub-count of `unparseableLines` that were census entries missing a field they need. */
  readonly malformedCensusEntries: number;
  readonly backwardsStamps: number;
  /** Over every parsed entry, of any type. */
  readonly oldestStampMs: number | null;
  readonly newestStampMs: number | null;
  /** `collectChainFiles`' unrecognized names. Counted, never opened. */
  readonly unrecognizedNames: number;
  /** The stamp of the first `task-removed` entry that carries the key at all. */
  readonly firstProvenanceRemovalMs: number | null;
}

/** One queue row at the cutoff. Nothing but these four fields is copied from the queue state. */
export interface SnapshotRow {
  readonly taskId: string;
  readonly status: FeatureRequestStatus;
  readonly runId: string | null;
  /** `isCompletionProvenance(row.completionProvenance)`. */
  readonly attested: boolean;
}

export interface SnapshotQueue {
  readonly queueId: string;
  /** `null`: the queue states no override, so the workspace default applies. */
  readonly storedPolicy: QueueFailurePolicy | null;
  readonly rows: readonly SnapshotRow[];
}

export interface QueueSnapshot {
  readonly cutoffMs: number;
  /** The keys of `getQueueStates()`, sorted. */
  readonly queues: readonly SnapshotQueue[];
  readonly workspaceDefaultPolicy: QueueFailurePolicy;
}

/** One failed terminal record, followed to its first next event and given one outcome. */
export interface Episode {
  readonly runId: string;
  /** 1-based among that Run's episodes. */
  readonly position: number;
  readonly taskId: string;
  /** The failure's position in the log. */
  readonly seq: number;
  readonly failedAtMs: number;
  readonly cause: CensusCause;
  /** After moves; `null` when unresolved. */
  readonly queueId: string | null;
  readonly outcome:
    | { readonly kind: 'disposition'; readonly disposition: Disposition }
    | { readonly kind: 'unknown'; readonly reason: UnknownReason };
  /** The next event's `seq`, or `null` when none ended the episode. */
  readonly endedBySeq: number | null;
  /** Starts of other tasks in the queue after the failure. */
  readonly laterStartsInQueue: number;
  /** Shown for `history-gap` only; `null` for every other outcome. */
  readonly snapshotStatus: FeatureRequestStatus | 'absent' | null;
}

export interface CensusResult {
  /** Log order. */
  readonly episodes: readonly Episode[];
  /** Valid failed `ended` events, whatever their stamp. */
  readonly failedEndsRead: number;
  readonly failedEndsAfterCutoff: number;
  readonly collapsedDuplicates: number;
  /** Census events of any kind stamped after the cutoff. */
  readonly entriesAfterCutoff: number;
  /** Zero in every valid result (SC-004). */
  readonly removalsEndingMoreThanOne: number;
  readonly totals: Readonly<Record<CensusCause, Readonly<Record<Disposition | 'unknown', number>>>>;
  readonly unknownsByReason: Readonly<Record<UnknownReason, number>>;
  /** Coverage, carried through without the events. */
  readonly log: Omit<CensusLog, 'events'>;
}

export interface ReportIdentity {
  readonly cutoffMs: number;
  /** A version string, or `'unknown'`. */
  readonly extensionVersion: string;
  /** For the queue table and the policies. */
  readonly snapshot: QueueSnapshot;
}
