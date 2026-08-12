// Feature 091 T019 — the Wake-up cleanup record (contract C-01).
//
// Machine-scoped, stored in `context.globalState` under a versioned key.
// It is the single source of truth for whether cleanup has reached a
// terminal outcome on this machine, and it is deliberately NOT written
// to workspace state, the audit log, or the operator's configuration
// (FR-013a, FR-015a).
//
// This module is withdrawn together with the rest of `src/cleanup/` at
// the version named by `WAKEUP_CLEANUP_END_OF_LIFE_VERSION` in
// `wakeup-cleanup.ts`.

import type { HostMemento } from '../host-services/types';
import type { SchedulerAttempt, SchedulerName, SchedulerResult } from './schedulers/types';

// The scheduler shapes live in `schedulers/types.ts` so Phase 2 could be
// written and tested before `src/wakeup/` was deleted. Re-exported here
// because the data model documents this file as their home.
export type { SchedulerAttempt, SchedulerName, SchedulerResult };

/** Machine-scoped `globalState` key (contract C-01). */
export const CLEANUP_RECORD_KEY = 'schegent.wakeUpCleanup.v1';

export const CLEANUP_RECORD_VERSION = 1;

/**
 * `attempted` is deliberately absent: it is the transient state of a run
 * in progress and is never persisted, so a process killed mid-cleanup
 * re-attempts on the next start rather than resuming (FR-013).
 */
export type CleanupOutcome = 'succeeded' | 'failed' | 'skipped';

/**
 * The closed set of invocable artefacts cleanup may delete (contract
 * C-05). The invocation log and the session log are NOT here — they are
 * historical records and are retained (FR-015).
 */
export const CLEANUP_ARTEFACTS = ['runner.js', 'settings.json', 'workspace-roots.json'] as const;

export type CleanupArtefact = (typeof CLEANUP_ARTEFACTS)[number];

export interface WakeUpCleanupRecord {
  readonly version: typeof CLEANUP_RECORD_VERSION;
  readonly outcome: CleanupOutcome;
  /** ISO-8601 UTC. */
  readonly attemptedAt: string;
  /** Integer >= 1, monotonically increasing. */
  readonly attemptCount: number;
  readonly schedulers: readonly SchedulerAttempt[];
  /** Bare filenames only — never a path (FR-012 redaction). */
  readonly artefactsRemoved: readonly CleanupArtefact[];
  /** Set the first time a failure is surfaced; presence suppresses all later messages. */
  readonly notifiedAt?: string;
}

/**
 * `succeeded` and `skipped` are terminal because FR-010 caps cleanup at
 * one run to a successful outcome. `failed` is deliberately not terminal
 * — the operator still has a live entry, and retrying is the only
 * in-product path to removing it (plan D-03).
 */
export function isTerminalOutcome(outcome: CleanupOutcome): boolean {
  return outcome === 'succeeded' || outcome === 'skipped';
}

const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isIsoUtc(value: unknown): value is string {
  return typeof value === 'string' && ISO_8601_UTC.test(value) && !Number.isNaN(Date.parse(value));
}

const SCHEDULER_NAMES: readonly SchedulerName[] = [
  'launchd',
  'systemd-user',
  'cron',
  'task-scheduler'
];
const SCHEDULER_RESULTS: readonly SchedulerResult[] = ['removed', 'absent', 'failed'];
const OUTCOMES: readonly CleanupOutcome[] = ['succeeded', 'failed', 'skipped'];

function isSchedulerAttempt(value: unknown): value is SchedulerAttempt {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  if (!SCHEDULER_NAMES.includes(a.scheduler as SchedulerName)) return false;
  if (!SCHEDULER_RESULTS.includes(a.result as SchedulerResult)) return false;
  if (a.reason !== undefined && typeof a.reason !== 'string') return false;
  return true;
}

/**
 * Parse a stored value into a record, or `undefined` if it is absent,
 * malformed, or of an unknown version.
 *
 * Treating a bad record as absent — rather than as an error — is what
 * keeps a corrupted value from affecting startup (FR-011). It is safe
 * because every removal operation in contract C-02 is idempotent, so a
 * needless re-attempt costs nothing and changes nothing.
 */
export function parseCleanupRecord(raw: unknown): WakeUpCleanupRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;

  if (r.version !== CLEANUP_RECORD_VERSION) return undefined;
  if (!OUTCOMES.includes(r.outcome as CleanupOutcome)) return undefined;
  if (!isIsoUtc(r.attemptedAt)) return undefined;
  if (typeof r.attemptCount !== 'number') return undefined;
  if (!Number.isInteger(r.attemptCount) || r.attemptCount < 1) return undefined;
  if (!Array.isArray(r.schedulers) || !r.schedulers.every(isSchedulerAttempt)) return undefined;
  if (!Array.isArray(r.artefactsRemoved)) return undefined;
  if (!r.artefactsRemoved.every((f): f is CleanupArtefact =>
    CLEANUP_ARTEFACTS.includes(f as CleanupArtefact)
  )) {
    return undefined;
  }
  if (r.notifiedAt !== undefined && !isIsoUtc(r.notifiedAt)) return undefined;

  return {
    version: CLEANUP_RECORD_VERSION,
    outcome: r.outcome as CleanupOutcome,
    attemptedAt: r.attemptedAt,
    attemptCount: r.attemptCount,
    schedulers: r.schedulers as readonly SchedulerAttempt[],
    artefactsRemoved: r.artefactsRemoved as readonly CleanupArtefact[],
    ...(r.notifiedAt === undefined ? {} : { notifiedAt: r.notifiedAt as string })
  };
}

/** Read via the host-services memento abstraction; never throws. */
export function readCleanupRecord(store: HostMemento): WakeUpCleanupRecord | undefined {
  try {
    return parseCleanupRecord(store.get<unknown>(CLEANUP_RECORD_KEY));
  } catch {
    // An unreadable store is treated exactly like an absent record.
    return undefined;
  }
}

export interface CommitResult {
  readonly record: WakeUpCleanupRecord;
  /**
   * True only for the writer that set `notifiedAt` on this commit. The
   * caller uses it to decide whether to emit the one message FR-012
   * allows, so the decision and the write that suppresses it happen
   * together rather than as two racing steps.
   */
  readonly shouldNotify: boolean;
}

export interface CommitOptions {
  /** ISO-8601 UTC stamp used when this commit is the one that notifies. */
  readonly nowIso: string;
}

/**
 * Compare-then-write (plan D-04).
 *
 * Re-reads the stored record immediately before writing so a second
 * window that got there first is not overwritten: `attemptCount` is
 * lifted above whatever is stored, and an existing `notifiedAt` is
 * carried forward. A same-instant race therefore costs one redundant —
 * and idempotent — uninstall, never a duplicate record or a duplicate
 * message.
 */
export async function commitCleanupRecord(
  store: HostMemento,
  draft: Omit<WakeUpCleanupRecord, 'version' | 'attemptCount' | 'notifiedAt'>,
  options: CommitOptions
): Promise<CommitResult> {
  const current = readCleanupRecord(store);

  const attemptCount = (current?.attemptCount ?? 0) + 1;
  const carriedNotifiedAt = current?.notifiedAt;

  // FR-012 "once": notify only on a failure that has never been
  // surfaced. Retrying does not re-notify (plan D-03).
  const shouldNotify = draft.outcome === 'failed' && carriedNotifiedAt === undefined;
  const notifiedAt = shouldNotify ? options.nowIso : carriedNotifiedAt;

  const record: WakeUpCleanupRecord = {
    version: CLEANUP_RECORD_VERSION,
    outcome: draft.outcome,
    attemptedAt: draft.attemptedAt,
    attemptCount,
    schedulers: draft.schedulers,
    artefactsRemoved: draft.artefactsRemoved,
    ...(notifiedAt === undefined ? {} : { notifiedAt })
  };

  await store.update(CLEANUP_RECORD_KEY, record);
  return { record, shouldNotify };
}
