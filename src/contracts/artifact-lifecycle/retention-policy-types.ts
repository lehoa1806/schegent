/**
 * FR-R6-F05 (US4) — contract types for retention-policy adoption and terminal
 * Task archival (FR-008, FR-016..FR-019).
 *
 * Revision 0 is implicit: before any adoption every artifact keeps its existing
 * class policy and no Task archives. A request carries what the caller holds
 * (the policy it previewed, the Tasks its queue memento lists); the service
 * never reads a queue itself (research R9).
 *
 * Zero `vscode` imports and no runtime import from an acting layer
 * (docs/hard-rules.md rule 13).
 */

import type { ControlFrameStatus } from '../control-ledger';
import { NEW_METADATA_RETENTION_MAX_AGE_DAYS } from '../shared-memory-storage/inventories';
import type { FeatureRequestStatus } from '../../queue/feature-request';
import {
  ARCHIVAL_DEFAULT_AGE_MS,
  ARCHIVAL_DEFAULT_HOT_LIST_BOUND,
  type ArchivedTaskSummary,
  type MutationRequestBase,
  type RetentionPolicy
} from './lifecycle-types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The policy an operator adopts unless they preview a different one (FR-016, F02 inventory). */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = Object.freeze({
  schemaVersion: 1,
  terminalDetailMaxAgeMs: NEW_METADATA_RETENTION_MAX_AGE_DAYS * MS_PER_DAY,
  archivalHotListBound: ARCHIVAL_DEFAULT_HOT_LIST_BOUND,
  archivalMaxAgeMs: ARCHIVAL_DEFAULT_AGE_MS
});

/** The revision in force before any adoption; it is never stored. */
export const IMPLICIT_POLICY_REVISION = 0 as const;

/** The adopted policy and its revision; `null` stands for revision 0. */
export interface AdoptedRetentionPolicy {
  readonly policyRevision: number;
  readonly policy: RetentionPolicy;
}

export interface PolicyAdoptionRequest extends MutationRequestBase {
  /** The exact policy the named preview was taken for; any difference makes the preview stale. */
  readonly policy: RetentionPolicy;
}

export interface PolicyAdoptionResult {
  readonly policyRevision: number;
}

/** Control frame statuses that settle a frame; any other status keeps a Task out of the archive (FR-017). */
export const RESOLVED_CONTROL_FRAME_STATUSES: readonly ControlFrameStatus[] = ['completed', 'failed', 'canceled'];

/** Every control frame status of a run; an unknown run answers an empty list. Injected by the host. */
export type RunFrameStatusLookup = (runId: string) => readonly ControlFrameStatus[];

/** One Task as the queue memento holds it, projected to what archival reads. */
export interface ArchivalTaskInput {
  readonly taskId: string;
  readonly status: FeatureRequestStatus;
  readonly runId: string | null;
  /** The terminal-resolution time (`FeatureRequest.completedAt`); the age origin (clarification 4). */
  readonly terminalResolvedAtMs: number | null;
  /** Copied verbatim into the summary; archival never recomputes it (FR-017). */
  readonly outcome: string;
  /** Metadata-only detail kept until `detailExpiresAtMs`. */
  readonly summary: ArchivedTaskSummary['summary'];
  readonly retainedReferenceIds: readonly string[];
}

export interface ArchivalQueueInput {
  readonly queueId: string;
  readonly tasks: readonly ArchivalTaskInput[];
}

export interface ArchivalRequest extends MutationRequestBase {
  readonly queues: readonly ArchivalQueueInput[];
}

/** A Task the caller removes from its hot list; its summary row is already committed. */
export interface ArchivalRemoval {
  readonly queueId: string;
  readonly taskId: string;
}

export interface ArchivalResult {
  /** Summary rows this call wrote. */
  readonly archived: number;
  /** Eligible by age or rank, kept because the Task's run still holds an unresolved control frame. */
  readonly skipped: number;
  /** Includes Tasks archived by an earlier call that the hot list still holds. */
  readonly removalSet: readonly ArchivalRemoval[];
}

/** `aggregates-only` once the detail has expired: only the row's aggregates and availability remain (FR-019). */
export type ArchivedDetailCoverage = 'full' | 'aggregates-only';

export interface ArchivedTaskEntry extends ArchivedTaskSummary {
  readonly coverage: ArchivedDetailCoverage;
}

export interface ArchivedTaskListRequest {
  readonly queueId: string;
  readonly cursor?: string | undefined;
  readonly pageSize?: number | undefined;
}

export interface ArchivedTaskPage {
  readonly entries: readonly ArchivedTaskEntry[];
  readonly nextCursor: string | null;
}

export interface ArchivedDetailExpiry {
  readonly expired: number;
}
