import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { SanitizedLogger } from '../lib/logger';
import { resolveContainedTarget, type ContainmentRefusal } from '../lib/path-containment';

/**
 * FR-R3-012 — the outer bound on the checkpoint store.
 *
 * `RunCheckpointService.prune()` bounds one run directory to `PER_RUN_LIMIT`
 * artifacts and is only ever called with the directory of the run that just
 * wrote. Nothing bounded the *number* of run directories, so
 * `${globalStorageUri}/checkpoints/` grew without any ceiling at all — in a
 * location outside the workspace, shared across every workspace the extension
 * has ever opened, that no `.gitignore` covers and no other sweeper visits. Each
 * `.patch` there is a `git diff --binary HEAD` of the operator's uncommitted
 * source.
 *
 * This service is the outer bound only. It does not decide whether an artifact
 * was valid, does not read a `.patch`, and does not treat a `.declined.json`
 * marker as more disposable than a snapshot — the marker is the evidence that a
 * checkpoint was declined, and FR-R3-004 owns what that means.
 */

/**
 * Two bounds and a floor, as constants rather than settings.
 *
 * A setting would need a `package.json` contribution, a schema row, and the
 * parity tests that go with them, and it would hand an operator a knob whose
 * wrong setting is silent data loss in a directory they never open. The policy
 * is instead documented in `docs/operations/recovery-checkpoints.md`, where an
 * operator can read it before they need it rather than after.
 */
export const CHECKPOINT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Shorter than the 30-day session-artifact age bound on purpose. A checkpoint
 * answers "undo what this run just did to my working tree", and a working tree
 * two weeks on has moved far enough that a stale patch is more likely to
 * conflict than to help. A raw transcript stays readable indefinitely.
 */
export const CHECKPOINT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * Run directories always kept, newest first, regardless of the **size** bound.
 *
 * It does not protect against the age bound, and the asymmetry is deliberate:
 * "recent but over budget" is plausibly still wanted, while "old" is the bound
 * saying nobody wants it however few of them there are. A floor that covered
 * both would leave an unreapable residue of ancient diffs forever, which is the
 * thing this feature exists to stop.
 */
export const CHECKPOINT_RECENT_RUN_FLOOR = 10;

export interface RunCheckpointRetentionPolicy {
  readonly maxAgeMs: number;
  readonly maxTotalBytes: number;
  readonly recentRunFloor: number;
}

/**
 * The shipped policy. Production constructs the service without a `policy`, so
 * this is what every operator gets; the parameter exists so a test can state a
 * bound in bytes it can actually write, rather than producing 256 MiB of
 * fixture data to cross the real one.
 */
export const DEFAULT_CHECKPOINT_RETENTION_POLICY: RunCheckpointRetentionPolicy = Object.freeze({
  maxAgeMs: CHECKPOINT_MAX_AGE_MS,
  maxTotalBytes: CHECKPOINT_MAX_TOTAL_BYTES,
  recentRunFloor: CHECKPOINT_RECENT_RUN_FLOOR
});

/** Which bound removed a directory. Reported so a reap is never unexplained. */
export type CheckpointReapTrigger = 'age' | 'total-bytes';

export interface RunCheckpointRetentionResult {
  /** Run directories left under the checkpoint root. */
  readonly retainedRunCount: number;
  readonly retainedBytes: number;
  readonly removedRunCount: number;
  readonly removedBytes: number;
  /** Per-bound removal counts, so the log names what triggered the reap. */
  readonly removedByTrigger: Readonly<Record<CheckpointReapTrigger, number>>;
  /** Directories the recent floor held back from the size bound. */
  readonly protectedByFloorCount: number;
  /** Scan or removal faults, plus containment refusals. Never throws. */
  readonly failures: number;
  readonly containmentRefusals: readonly ContainmentRefusal[];
}

interface FsLike {
  readdir(target: string, options: { withFileTypes: true }): Promise<readonly import('node:fs').Dirent[]>;
  lstat(target: string): Promise<import('node:fs').Stats>;
  rm(target: string, options: { recursive: true; force: true }): Promise<void>;
  realpath(target: string): Promise<string>;
}

export interface RunCheckpointRetentionDeps {
  /** `context.globalStorageUri.fsPath` — the same root the service writes under. */
  readonly globalStorageRoot: string;
  readonly logger: Pick<SanitizedLogger, 'info' | 'warn'>;
  /** Omitted in production; see `DEFAULT_CHECKPOINT_RETENTION_POLICY`. */
  readonly policy?: RunCheckpointRetentionPolicy;
  readonly now?: () => number;
  readonly filesystem?: FsLike;
}

interface RunDirectory {
  readonly name: string;
  readonly fullPath: string;
  readonly bytes: number;
  /** Newest mtime anywhere in the directory — when this run last checkpointed. */
  readonly mtimeMs: number;
}

const EMPTY_RESULT: RunCheckpointRetentionResult = Object.freeze({
  retainedRunCount: 0,
  retainedBytes: 0,
  removedRunCount: 0,
  removedBytes: 0,
  removedByTrigger: Object.freeze({ age: 0, 'total-bytes': 0 }),
  protectedByFloorCount: 0,
  failures: 0,
  containmentRefusals: Object.freeze([])
});

function errnoCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
}

/** Bounds the store across runs. Best effort: it never throws and never blocks. */
export class RunCheckpointRetentionService {
  private readonly checkpointsRoot: string;
  private readonly fs: FsLike;
  private readonly now: () => number;
  private readonly policy: RunCheckpointRetentionPolicy;
  private sweepTail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RunCheckpointRetentionDeps) {
    this.checkpointsRoot = path.join(deps.globalStorageRoot, 'checkpoints');
    this.fs = deps.filesystem ?? fs;
    this.now = deps.now ?? (() => Date.now());
    this.policy = deps.policy ?? DEFAULT_CHECKPOINT_RETENTION_POLICY;
  }

  /**
   * Serialized against itself, like the session sweep: activation schedules one
   * and nothing stops a second being requested while it runs, and two concurrent
   * sweeps would each measure directories the other is removing and double-count
   * the bytes they freed.
   */
  public sweep(): Promise<RunCheckpointRetentionResult> {
    const operation = this.sweepTail.then(
      () => this.performSweep(),
      () => this.performSweep()
    );
    this.sweepTail = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async performSweep(): Promise<RunCheckpointRetentionResult> {
    try {
      return await this.runSweep();
    } catch (error) {
      // T433 — the outermost net. Retention runs on activation and after runs;
      // an unanticipated fault here must cost a sweep, never a phase, a run, or
      // the activation that scheduled it.
      this.deps.logger.warn('checkpoint-retention: sweep failed', {
        errno: errnoCode(error)
      });
      return { ...EMPTY_RESULT, failures: 1 };
    }
  }

  private async runSweep(): Promise<RunCheckpointRetentionResult> {
    const refusals = new Set<ContainmentRefusal>();

    // The root is assembled from `globalStorageUri` and its sweep ends in a
    // recursive `rm`, so it is proven contained *after* symlink resolution —
    // `readdir` follows the path it is given, and a `checkpoints` symlink
    // pointing at `$HOME` would otherwise be enumerated and reaped.
    const rootVerdict = await resolveContainedTarget(
      this.checkpointsRoot,
      [this.deps.globalStorageRoot],
      this.fs
    );
    if (rootVerdict.outcome === 'absent') {
      // No checkpoint has ever been written. Nothing to sweep, nothing wrong.
      return EMPTY_RESULT;
    }
    if (rootVerdict.outcome === 'refused') {
      // T433 — the "checkpoint root is unreadable" case: exactly one warning,
      // no traversal, no removal.
      refusals.add(rootVerdict.reason);
      this.deps.logger.warn('checkpoint-retention: root refused', {
        reason: rootVerdict.reason,
        errno: rootVerdict.errno
      });
      return { ...EMPTY_RESULT, failures: 1, containmentRefusals: [rootVerdict.reason] };
    }
    const root = rootVerdict.resolved;

    let entries: readonly import('node:fs').Dirent[];
    try {
      entries = await this.fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return EMPTY_RESULT;
      this.deps.logger.warn('checkpoint-retention: scan-root failed', {
        errno: errnoCode(error)
      });
      return { ...EMPTY_RESULT, failures: 1 };
    }

    let failures = 0;
    const directories: RunDirectory[] = [];
    for (const entry of entries) {
      // A symlink is admitted as a candidate rather than filtered out here, so
      // that the containment oracle refuses it *and records the refusal*. The
      // alternative — skipping it at the `readdir` — is a silent no-op on an
      // entry an operator would want to know about.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name === '.' || entry.name === '..') continue;
      const fullPath = path.join(root, entry.name);
      try {
        const measured = await this.measure(fullPath);
        directories.push({ name: entry.name, fullPath, ...measured });
      } catch (error) {
        // Unmeasurable is un-reapable: a directory whose size and age are
        // unknown cannot be weighed against either bound, so it is left alone
        // and counted as a failure rather than removed on a guess.
        failures += 1;
        this.deps.logger.warn('checkpoint-retention: scan-run failed', {
          errno: errnoCode(error)
        });
      }
    }

    // Oldest first, so both bounds remove in the same order and the recent floor
    // is simply the tail of this list.
    const ordered = [...directories].sort(
      (a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name)
    );
    const floorStart = Math.max(0, ordered.length - Math.max(0, this.policy.recentRunFloor));
    const protectedFromSize = new Set(ordered.slice(floorStart).map((dir) => dir.name));

    const sweptAt = this.now();
    const removed = new Set<string>();
    const removedByTrigger: Record<CheckpointReapTrigger, number> = { age: 0, 'total-bytes': 0 };
    let removedBytes = 0;

    for (const dir of ordered) {
      // The age bound ignores the floor by design — see the constant.
      if (sweptAt - dir.mtimeMs <= this.policy.maxAgeMs) continue;
      const outcome = await this.removeRun(dir, root, refusals);
      failures += outcome.failures;
      if (!outcome.removed) continue;
      removed.add(dir.name);
      removedBytes += dir.bytes;
      removedByTrigger.age += 1;
    }

    let retainedBytes = ordered
      .filter((dir) => !removed.has(dir.name))
      .reduce((sum, dir) => sum + dir.bytes, 0);
    for (const dir of ordered) {
      if (retainedBytes <= this.policy.maxTotalBytes) break;
      if (removed.has(dir.name) || protectedFromSize.has(dir.name)) continue;
      const outcome = await this.removeRun(dir, root, refusals);
      failures += outcome.failures;
      if (!outcome.removed) continue;
      removed.add(dir.name);
      removedBytes += dir.bytes;
      retainedBytes = Math.max(0, retainedBytes - dir.bytes);
      removedByTrigger['total-bytes'] += 1;
    }

    const result: RunCheckpointRetentionResult = Object.freeze({
      retainedRunCount: ordered.length - removed.size,
      retainedBytes,
      removedRunCount: removed.size,
      removedBytes,
      removedByTrigger: Object.freeze({ ...removedByTrigger }),
      protectedByFloorCount: [...protectedFromSize].filter((name) => !removed.has(name)).length,
      failures,
      containmentRefusals: Object.freeze([...refusals].sort())
    });
    this.report(result);
    return result;
  }

  /**
   * T432 — a reap deletes the only copy of a diff that may exist nowhere else,
   * because there is no in-product restore path. So every sweep that removed
   * something says how much and under which bound, and it says it through the
   * sanitized logger rather than the audit log: the audit log must never carry a
   * workspace path, and the only interesting thing about a run directory here is
   * its name, which is a run id.
   *
   * A sweep that removed nothing is not logged at all. Activation runs one every
   * time, and a line per activation saying "0" is noise that trains an operator
   * to skip the line that matters.
   */
  private report(result: RunCheckpointRetentionResult): void {
    if (result.removedRunCount === 0 && result.failures === 0) return;
    this.deps.logger.info('checkpoint-retention: sweep complete', {
      removedRunCount: result.removedRunCount,
      removedBytes: result.removedBytes,
      removedByAge: result.removedByTrigger.age,
      removedByTotalBytes: result.removedByTrigger['total-bytes'],
      retainedRunCount: result.retainedRunCount,
      retainedBytes: result.retainedBytes,
      protectedByFloorCount: result.protectedByFloorCount,
      failures: result.failures,
      maxAgeMs: this.policy.maxAgeMs,
      maxTotalBytes: this.policy.maxTotalBytes,
      recentRunFloor: this.policy.recentRunFloor
    });
  }

  /**
   * Total bytes and newest mtime of one run directory.
   *
   * `lstat`, never `stat`: a symlink reports as not-a-directory and its size is
   * taken without descending, so a link planted inside a run directory is
   * measured as an entry rather than traversed into whatever it points at.
   */
  private async measure(target: string): Promise<{ bytes: number; mtimeMs: number }> {
    const stat = await this.fs.lstat(target);
    if (!stat.isDirectory()) {
      return { bytes: stat.size, mtimeMs: stat.mtimeMs };
    }
    let bytes = stat.size;
    let mtimeMs = stat.mtimeMs;
    const entries = await this.fs.readdir(target, { withFileTypes: true });
    for (const entry of entries) {
      const child = await this.measure(path.join(target, entry.name));
      bytes += child.bytes;
      mtimeMs = Math.max(mtimeMs, child.mtimeMs);
    }
    return { bytes, mtimeMs };
  }

  /**
   * T430 — prove the candidate still resolves inside the checkpoint root before
   * removing it.
   *
   * The root check cannot answer this. It establishes where `checkpoints/`
   * leads; a run directory placed inside it as a symlink out of the store is a
   * separate path with a separate answer, and `readdir` reports it under a name
   * indistinguishable from a real one. A refusal skips that one directory and is
   * recorded; every sibling still sweeps.
   */
  private async removeRun(
    dir: RunDirectory,
    root: string,
    refusals: Set<ContainmentRefusal>
  ): Promise<{ readonly removed: boolean; readonly failures: number }> {
    const verdict = await resolveContainedTarget(dir.fullPath, [root], this.fs);
    if (verdict.outcome === 'refused') {
      refusals.add(verdict.reason);
      this.deps.logger.warn('checkpoint-retention: remove-run refused', {
        reason: verdict.reason,
        errno: verdict.errno
      });
      return { removed: false, failures: 1 };
    }
    if (verdict.outcome === 'absent') {
      // Vanished between the measure and the removal. `rm` with `force` treated
      // this as success before the guard existed, and it still is.
      return { removed: true, failures: 0 };
    }
    try {
      await this.fs.rm(verdict.resolved, { recursive: true, force: true });
      return { removed: true, failures: 0 };
    } catch (error) {
      this.deps.logger.warn('checkpoint-retention: remove-run failed', {
        errno: errnoCode(error)
      });
      return { removed: false, failures: 1 };
    }
  }
}
