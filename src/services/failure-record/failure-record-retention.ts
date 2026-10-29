// ---------------------------------------------------------------------------
// FR-R4-F15 (feature 243, contract K1) — the record pass the session sweep runs.
//
// Two rules keep `.schegent/failure-records/` bounded: a record older than the session age setting is
// removed, and of what remains only the newest 200 are kept. Both read the record's NAME alone. The
// name carries the failure time and a suffix, so the pass lists one directory and opens no file: a
// record that is corrupt, oversized or hostile is aged out exactly like a good one, and nothing it
// contains can steer the sweep (K1.7).
//
// SAFETY. Only regular files whose names parse as records are candidates, so a symlink, a directory, a
// foreign file, a spool entry and a lock are never touched. The directory is resolved inside the
// workspace first, and every removal is checked again against the directory it is in, so a link
// swapped in after the listing is refused and not followed. A record another window's sweep already
// removed counts as removed, which is clarification Q1: two windows may sweep the same workspace, and
// the loser of a race has nothing left to do and nothing to report.
//
// A warning names a step and a code. It never names a path, a file, a Run or any content (K1.6).
// ---------------------------------------------------------------------------

import { promises as fsp, type Dirent } from 'node:fs';
import * as path from 'node:path';
import { FAILURE_RECORD_DIR, FAILURE_RECORD_RETAINED_MAX, type ParsedRecordName } from '../../contracts/failure-record';
import { parseRecordName } from '../../contracts/validators/failure-record';
import type { SanitizedLogger } from '../../lib/logger';
import { resolveContainedTarget } from '../../lib/path-containment';
import { historyErrorCode } from '../history/error-code';

/** The two filesystem calls a real directory cannot be made to fail on demand. */
export interface FailureRecordRetentionFs {
  readdir(directory: string): Promise<readonly Dirent[]>;
  rm(target: string): Promise<void>;
}

const NODE_FS: FailureRecordRetentionFs = {
  readdir: (directory) => fsp.readdir(directory, { withFileTypes: true }),
  rm: (target) => fsp.rm(target, { force: true })
};

export interface FailureRecordRetentionDeps {
  readonly workspaceRoot: string;
  readonly logger: Pick<SanitizedLogger, 'warn'>;
  readonly fs?: Partial<FailureRecordRetentionFs>;
}

/** What one pass did. Returned to the session sweep and discarded there (research R8). */
export interface FailureRecordSweepOutcome {
  /** Includes a record that was already gone. */
  readonly removed: number;
  /** Each failure is also one sanitized warning. */
  readonly failures: number;
}

interface Candidate {
  readonly name: string;
  readonly parsed: ParsedRecordName;
}

type Removal = 'removed' | 'failed';

/** Newest first: the greater stamp, then the greater suffix. Both are fixed width, so strings order. */
function newestFirst(left: Candidate, right: Candidate): number {
  if (left.parsed.stamp !== right.parsed.stamp) return left.parsed.stamp < right.parsed.stamp ? 1 : -1;
  if (left.parsed.suffix !== right.parsed.suffix) return left.parsed.suffix < right.parsed.suffix ? 1 : -1;
  return 0;
}

export async function sweepFailureRecords(
  deps: FailureRecordRetentionDeps,
  maxAgeMs: number,
  now: Date
): Promise<FailureRecordSweepOutcome> {
  const io: FailureRecordRetentionFs = { ...NODE_FS, ...deps.fs };
  const warn = (message: string, context: Record<string, string>): void => {
    try {
      deps.logger.warn(`failure-record-retention: ${message}`, context);
    } catch {
      // A sink that throws must not stop a retention pass.
    }
  };

  // K1.1 — the directory, inside the workspace, before anything is listed.
  const verdict = await resolveContainedTarget(path.join(deps.workspaceRoot, ...FAILURE_RECORD_DIR), [
    deps.workspaceRoot
  ]);
  if (verdict.outcome === 'absent') return { removed: 0, failures: 0 };
  if (verdict.outcome === 'refused') {
    warn('root refused', { reason: verdict.reason, errno: verdict.errno });
    return { removed: 0, failures: 1 };
  }
  const recordsRoot = verdict.resolved;

  let entries: readonly Dirent[];
  try {
    entries = await io.readdir(recordsRoot);
  } catch (error) {
    const code = historyErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { removed: 0, failures: 0 };
    warn('list failed', { errorCode: code });
    return { removed: 0, failures: 1 };
  }

  // K1.2 — regular files with a record's name, and nothing else.
  const candidates: Candidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parsed = parseRecordName(entry.name);
    if (parsed !== null) candidates.push({ name: entry.name, parsed });
  }

  // K1.5 — one removal, checked again against the directory it is in. `absent` and `ENOENT` are both
  // "already gone", which is a removal and not a failure.
  async function removeOne(candidate: Candidate): Promise<Removal> {
    const target = await resolveContainedTarget(path.join(recordsRoot, candidate.name), [recordsRoot]);
    if (target.outcome === 'absent') return 'removed';
    if (target.outcome === 'refused') {
      warn('remove failed', { errorCode: target.errno === 'none' ? target.reason : target.errno });
      return 'failed';
    }
    try {
      await io.rm(target.resolved);
      return 'removed';
    } catch (error) {
      const code = historyErrorCode(error);
      if (code === 'ENOENT') return 'removed';
      warn('remove failed', { errorCode: code });
      return 'failed';
    }
  }

  let removed = 0;
  let failures = 0;
  const gone = new Set<string>();
  const stuck = new Set<string>();
  const remove = async (candidate: Candidate): Promise<void> => {
    if ((await removeOne(candidate)) === 'removed') {
      removed += 1;
      gone.add(candidate.name);
    } else {
      failures += 1;
      stuck.add(candidate.name);
    }
  };

  // K1.3 — age. A stamp in the future gives a negative age and is kept.
  for (const candidate of candidates) {
    if (now.getTime() - candidate.parsed.failedAtMs > maxAgeMs) await remove(candidate);
  }

  // K1.4 — count, of what the age rule left, newest first. A record whose removal just failed is not
  // retried in the same pass: it would be a second warning for the same file.
  const present = candidates.filter((candidate) => !gone.has(candidate.name)).sort(newestFirst);
  for (const candidate of present.slice(FAILURE_RECORD_RETAINED_MAX)) {
    if (!stuck.has(candidate.name)) await remove(candidate);
  }
  return { removed, failures };
}
