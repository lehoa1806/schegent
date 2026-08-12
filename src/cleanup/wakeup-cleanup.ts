// Feature 091 T020/T021 — one-time removal of the scheduled entries and
// invocable artefacts left behind by the withdrawn Wake-up capability.
//
// This module is the reason `src/cleanup/` exists at all: the operating
// system entries installed by releases 014/024/031 cannot be removed
// without removal code, and that code has to outlive the deletion of
// `src/wakeup/`.
//
// It imports no `vscode` symbol. Every host capability it needs arrives
// through `WakeUpCleanupDeps`, which is what makes the containment
// guarantee of contract C-06 testable: a test can force every scheduler
// operation and every filesystem call to throw and still observe that
// activation completes.

import * as path from 'node:path';
import { promises as nodeFs } from 'node:fs';
import type { HostMemento } from '../host-services/types';
import {
  CLEANUP_ARTEFACTS,
  commitCleanupRecord,
  isTerminalOutcome,
  readCleanupRecord,
  type CleanupArtefact,
  type CleanupOutcome,
  type WakeUpCleanupRecord
} from './cleanup-record';
import { describeFailure, type SchedulerAttempt, type SchedulerName } from './schedulers/types';
import { remove as removeLaunchd } from './schedulers/launchd-remove';
import { remove as removeSystemdUser } from './schedulers/systemd-user-remove';
import { remove as removeCron } from './schedulers/cron-remove';
import { remove as removeTaskScheduler } from './schedulers/task-scheduler-remove';

/**
 * Contract C-08 / FR-016 — END OF LIFE.
 *
 * This whole directory is scaffolding for one upgrade. It MUST be
 * deleted at v0.6.0: `src/cleanup/`, its tests, and the dispatch in
 * `src/extension.ts`. It must also have shipped in at least three
 * consecutive minor releases before that deletion, so v0.6.0 is a
 * deadline, not a target.
 *
 * This constant is the marker a contributor will actually find while
 * working in the code. The other two records FR-016 requires are the
 * release note and the dated backlog entry under `docs/plans/`.
 */
export const WAKEUP_CLEANUP_END_OF_LIFE_VERSION = '0.6.0';

/** The Wake-up data directory, relative to global storage. */
export const WAKEUP_DATA_DIR_NAME = 'wakeup';

/**
 * Contract C-07 — the single operator-facing string. It names the
 * removal, carries no stack trace, and names no path.
 */
export const CLEANUP_FAILURE_MESSAGE =
  'Schegent: Wake-up has been removed. A scheduled entry left on this machine could not be removed automatically — the upgrade note has manual removal steps for your operating system.';

/** Contract C-07 — exactly one action. */
export const CLEANUP_FAILURE_ACTION = 'Open upgrade note';

/**
 * Contract C-07 / FR-012 — where the one action goes.
 *
 * Anchored at the manual-removal instructions rather than the top of the
 * note, because an operator who sees this message has a live entry and
 * needs the per-operating-system steps, not the summary.
 *
 * The published note is linked rather than packaged: shipping a docs
 * file inside the extension would add bytes to a release whose whole
 * point is to remove them (SC-011), and the note has to stay reachable
 * from an operator who has already uninstalled.
 */
export const CLEANUP_UPGRADE_NOTE_URL =
  'https://github.com/lehoa1806/schegent/blob/develop/docs/operations/release-notes.md#removing-a-leftover-entry-by-hand';

export interface CleanupFileSystem {
  unlink(filePath: string): Promise<void>;
}

export interface CleanupLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  sanitize(input: string): string;
}

export interface CleanupNotifier {
  /** One warning, one action. Resolves to the action label if chosen. */
  warn(message: string, action: string): Promise<string | undefined>;
}

export type SchedulerRemover = () => Promise<SchedulerAttempt>;

export interface WakeUpCleanupDeps {
  /** Machine-scoped global state, via the host-services memento abstraction. */
  readonly store: HostMemento;
  /** `<globalStorageUri>/wakeup`. */
  readonly wakeUpHomeDir: string;
  readonly logger: CleanupLogger;
  readonly notifier: CleanupNotifier;
  /** Opens the FR-022 upgrade note at the manual-removal instructions. */
  readonly openUpgradeNote: () => Promise<void> | void;
  readonly platform?: string;
  readonly now?: () => Date;
  readonly removers?: Partial<Record<SchedulerName, SchedulerRemover>>;
  readonly fs?: CleanupFileSystem;
}

/**
 * Contract C-04 — selection is a pure function of the operating-system
 * family.
 *
 * Linux gets BOTH schedulers, unconditionally. It deliberately consults
 * no capability probe, no stored installer choice, and no binary
 * presence check (FR-007a): the probe that chose the scheduler at
 * install time may answer differently now — a machine that had
 * `systemctl` when the entry was written may not have it today — and a
 * probe-driven selection would then walk past the very entry cleanup
 * exists to remove. Attempting both is cheap because each operation is
 * idempotent and reports `absent` rather than failing.
 */
export function selectSchedulers(platform: string): readonly SchedulerName[] {
  switch (platform) {
    case 'darwin':
      return ['launchd'];
    case 'win32':
      return ['task-scheduler'];
    case 'linux':
      return ['systemd-user', 'cron'];
    default:
      return [];
  }
}

const DEFAULT_REMOVERS: Record<SchedulerName, SchedulerRemover> = {
  launchd: () => removeLaunchd(),
  'systemd-user': () => removeSystemdUser(),
  cron: () => removeCron(),
  'task-scheduler': () => removeTaskScheduler()
};

/**
 * Data-model derivation rules (plan D-03).
 *
 * `absent` is a success: a machine that never enabled Wake-up reports
 * `absent` everywhere and must stay silent (FR-014).
 */
export function deriveOutcome(
  attempts: readonly SchedulerAttempt[],
  artefactsRemoved: readonly string[],
  artefactFailureCount = 0
): CleanupOutcome {
  if (attempts.some((a) => a.result === 'failed') || artefactFailureCount > 0) return 'failed';
  if (attempts.some((a) => a.result === 'removed') || artefactsRemoved.length > 0) {
    return 'succeeded';
  }
  return 'skipped';
}

interface ArtefactDeletionResult {
  readonly removed: readonly CleanupArtefact[];
  readonly failures: readonly string[];
}

/**
 * Contract C-05 — delete exactly the three named artefacts from the
 * Wake-up data directory.
 *
 * The iteration is over a closed literal list, so there is no recursion,
 * no globbing, and no way for this to reach a file the contract does not
 * name. The invocation log, the session log, and the directory itself
 * are retained as historical records (FR-015).
 */
export async function deleteInvocableArtefacts(
  wakeUpHomeDir: string,
  fs: CleanupFileSystem
): Promise<ArtefactDeletionResult> {
  const removed: CleanupArtefact[] = [];
  const failures: string[] = [];

  for (const filename of CLEANUP_ARTEFACTS) {
    try {
      await fs.unlink(path.join(wakeUpHomeDir, filename));
      // Bare filename only — never the path we just built (FR-012).
      removed.push(filename);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      failures.push(filename);
    }
  }

  return { removed, failures };
}

function toIsoUtc(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Run cleanup once.
 *
 * Contract C-06: this never rejects. It is dispatched fire-and-forget
 * after activation completes and is never awaited on the activation
 * path, so a rejection would surface as an unhandled rejection rather
 * than as anything an operator could act on. Every failure is caught,
 * recorded, and — on the first failure only — surfaced once.
 */
export async function runWakeUpCleanup(deps: WakeUpCleanupDeps): Promise<void> {
  try {
    await runCleanupInner(deps);
  } catch (err) {
    // Containment of last resort. Reaching here means a bug in this
    // module rather than an expected environment failure, so it is
    // logged and swallowed: startup must be unaffected (FR-011).
    try {
      deps.logger.warn(
        `wakeup-cleanup: aborted unexpectedly — ${deps.logger.sanitize(describeFailure(err))}`
      );
    } catch {
      // Even the logger is not allowed to break activation.
    }
  }
}

async function runCleanupInner(deps: WakeUpCleanupDeps): Promise<void> {
  const existing = readCleanupRecord(deps.store);
  if (existing !== undefined && isTerminalOutcome(existing.outcome)) {
    // Already done on this machine (FR-010). A second window that
    // observes the terminal marker returns immediately (plan D-04).
    return;
  }

  const now = deps.now ?? ((): Date => new Date());
  const platform = deps.platform ?? process.platform;
  const fs = deps.fs ?? nodeFs;
  const removers = { ...DEFAULT_REMOVERS, ...(deps.removers ?? {}) };

  const attempts: SchedulerAttempt[] = [];
  for (const scheduler of selectSchedulers(platform)) {
    attempts.push(await attemptRemoval(scheduler, removers[scheduler]));
  }

  const artefacts = await deleteArtefactsSafely(deps.wakeUpHomeDir, fs);
  const outcome = deriveOutcome(attempts, artefacts.removed, artefacts.failures.length);

  const { record, shouldNotify } = await commitCleanupRecord(
    deps.store,
    {
      outcome,
      attemptedAt: toIsoUtc(now()),
      schedulers: attempts.map((a) => redactAttempt(deps, a)),
      artefactsRemoved: artefacts.removed
    },
    { nowIso: toIsoUtc(now()) }
  );

  emitRuntimeLogLine(deps, record, artefacts.failures);

  if (shouldNotify) await notifyOnce(deps);
}

/**
 * Contract C-01 guarantee 4 — nothing reaches the stored record that has
 * not passed the redaction set.
 *
 * `describeFailure` has already elided filesystem paths and dropped the
 * stack; this is the second half, and it runs on the way IN to storage
 * rather than only on the way out to the log, because the record
 * outlives any one session.
 */
function redactAttempt(deps: WakeUpCleanupDeps, attempt: SchedulerAttempt): SchedulerAttempt {
  if (attempt.reason === undefined) return attempt;
  try {
    return { ...attempt, reason: deps.logger.sanitize(attempt.reason) };
  } catch {
    // A sanitizer that throws must not put an unredacted value in the
    // record; drop the detail rather than store it raw.
    return { scheduler: attempt.scheduler, result: attempt.result };
  }
}

/**
 * Each scheduler is attempted independently (contract C-02 guarantee 4).
 * The modules are already total, so a throw here means an injected
 * double misbehaved — it is still contained, because one scheduler's
 * failure must not stop its siblings from being attempted.
 */
async function attemptRemoval(
  scheduler: SchedulerName,
  remover: SchedulerRemover
): Promise<SchedulerAttempt> {
  try {
    return await remover();
  } catch (err) {
    return { scheduler, result: 'failed', reason: describeFailure(err) };
  }
}

async function deleteArtefactsSafely(
  wakeUpHomeDir: string,
  fs: CleanupFileSystem
): Promise<ArtefactDeletionResult> {
  try {
    return await deleteInvocableArtefacts(wakeUpHomeDir, fs);
  } catch {
    // `deleteInvocableArtefacts` catches per file; this guards against a
    // filesystem double that throws outside the per-file try.
    return { removed: [], failures: [...CLEANUP_ARTEFACTS] };
  }
}

/**
 * FR-013 — a redacted runtime-log line, so a support conversation can
 * establish what happened on the operator's machine.
 *
 * `skipped` writes nothing at all: that is the machine that never
 * enabled Wake-up, and FR-014 requires it to be a silent no-op. The
 * failure reasons already passed `describeFailure`, and are sanitized
 * again here because the redaction set — not this module — is the
 * source of truth for what may be written.
 */
function emitRuntimeLogLine(
  deps: WakeUpCleanupDeps,
  record: WakeUpCleanupRecord,
  artefactFailures: readonly string[]
): void {
  if (record.outcome === 'skipped') return;

  const schedulers = record.schedulers
    .map((a) => `${a.scheduler}=${a.result}${a.reason ? ` (${deps.logger.sanitize(a.reason)})` : ''}`)
    .join(', ');

  const detail = [
    `attempt=${record.attemptCount}`,
    schedulers === '' ? 'schedulers=none' : `schedulers=[${schedulers}]`,
    `artefactsRemoved=[${record.artefactsRemoved.join(', ')}]`,
    ...(artefactFailures.length > 0 ? [`artefactsFailed=[${artefactFailures.join(', ')}]`] : [])
  ].join(' ');

  const line = `wakeup-cleanup: ${record.outcome} ${detail}`;
  if (record.outcome === 'failed') deps.logger.warn(line);
  else deps.logger.info(line);
}

/**
 * Contract C-07 — exactly one warning, carrying exactly one action.
 *
 * Reached only when `commitCleanupRecord` reported that this run is the
 * one that set `notifiedAt`, so the suppression is decided by the same
 * compare-then-write that persists it rather than by a second read.
 */
async function notifyOnce(deps: WakeUpCleanupDeps): Promise<void> {
  try {
    const choice = await deps.notifier.warn(CLEANUP_FAILURE_MESSAGE, CLEANUP_FAILURE_ACTION);
    if (choice === CLEANUP_FAILURE_ACTION) await deps.openUpgradeNote();
  } catch {
    // A notification surface that rejects must not turn a recorded
    // failure into an unhandled one.
  }
}
