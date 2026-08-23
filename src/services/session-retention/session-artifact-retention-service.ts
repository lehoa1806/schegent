import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AuditLogWriter } from '../../audit/audit-log-writer';
import type { SanitizedLogger } from '../../lib/logger';
import {
  resolveContainedTarget,
  type ContainmentRefusal
} from '../../lib/path-containment';

export interface SessionArtifactRetentionPolicy {
  readonly maxAgeMs: number;
  readonly maxBytes: number;
}

export interface SessionArtifactUsage {
  readonly artifactCount: number;
  readonly totalBytes: number;
  readonly lastSweepAt: string | null;
  readonly lastSweepFailures: number;
}

export interface SessionArtifactRetentionResult extends SessionArtifactUsage {
  readonly removedArtifactCount: number;
  readonly removedBytes: number;
  readonly protectedArtifactCount: number;
}

interface ArtifactTarget {
  readonly fullPath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

interface ArtifactGroup {
  readonly runId: string;
  readonly targets: ArtifactTarget[];
  size: number;
  mtimeMs: number;
  scanFailed: boolean;
}

/**
 * FR-R3-050 (M-12) — the shared staging directory for default-mode transcripts.
 *
 * Mirrors the path `raw-transcript-writer.ts` writes to. Named here rather than
 * inlined so the one place retention has to recognise it is visible, and so a
 * rename shows up as a mismatch rather than as a silently unrecognised directory
 * that reverts to being one unprotectable group.
 */
const PENDING_STAGING_DIR_NAME = '.pending';

/** `raw-<runId>.log` — the writer/retention filename contract. */
const RAW_TRANSCRIPT_NAME = /^raw-(.+)\.log$/;

interface FsLike {
  readdir(target: string, options: { withFileTypes: true }): Promise<readonly import('node:fs').Dirent[]>;
  lstat(target: string): Promise<import('node:fs').Stats>;
  rm(target: string, options: { recursive: true; force: true }): Promise<void>;
  realpath(target: string): Promise<string>;
}

export interface SessionArtifactRetentionDeps {
  readonly workspaceRoot: string;
  readonly policy: () => SessionArtifactRetentionPolicy;
  readonly logger: Pick<SanitizedLogger, 'warn'>;
  readonly audit?: Pick<AuditLogWriter, 'append'> | null;
  readonly now?: () => Date;
  readonly filesystem?: FsLike;
}

const EMPTY_USAGE: SessionArtifactUsage = Object.freeze({
  artifactCount: 0,
  totalBytes: 0,
  lastSweepAt: null,
  lastSweepFailures: 0
});

function errnoCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
}

function normalizedPolicy(policy: SessionArtifactRetentionPolicy): SessionArtifactRetentionPolicy {
  return {
    maxAgeMs: Number.isFinite(policy.maxAgeMs) ? Math.max(0, policy.maxAgeMs) : 0,
    maxBytes: Number.isSafeInteger(policy.maxBytes) ? Math.max(0, policy.maxBytes) : 0
  };
}

/**
 * Feature 098 (SEC-01) — the sweep's root is assembled lexically from operator-
 * controlled workspace content, and the sweep's terminal operation is a
 * recursive `rm`. Those two facts together mean the root MUST be proven to sit
 * inside the workspace *after* symlink resolution, never before: a repository
 * that ships `.schegent/sessions` — or `.schegent` — as a symlink pointing at
 * `$HOME` would otherwise have its target enumerated and age-pruned, because
 * `readdir` follows the path it is given.
 *
 * Feature FR-R3-005 (T324/T325) moved the comparison itself into
 * `src/lib/path-containment.ts` and extended it to every candidate.
 *
 * The argument this file used to make — that entries *inside* the root need no
 * guard, because `measure()` reaches them through `lstat` and `fs.rm` on a
 * symlink unlinks the link rather than its target — was true about what `rm`
 * does and wrong about what the sweep should do. A run directory that is a
 * symlink out of the workspace is not the host's to remove even when removing
 * it is harmless to the target, and the operator gets no signal that their
 * evidence was silently dropped from the sweep. Under FR-R3-005 each candidate
 * is resolved through the oracle before it is removed: contained candidates are
 * pruned exactly as before, a candidate that resolves out is skipped and
 * recorded, and its siblings still prune.
 *
 * A refusal is not a failed sweep in the "retry harder" sense — it is a
 * deliberate no-op recorded as a failure so evidence health surfaces it, and no
 * path is logged, because the path is the thing that would name the operator's
 * home directory in a diagnostic log.
 */

/**
 * Owns lifecycle enforcement for unredacted raw transcripts and verbose
 * diagnostic trees. The append-only structured audit log is outside this
 * service's root and can never be selected by a sweep.
 */
export class SessionArtifactRetentionService {
  private readonly sessionsRoot: string;
  private readonly fs: FsLike;
  private readonly now: () => Date;
  private usage: SessionArtifactUsage = EMPTY_USAGE;
  private sweepTail: Promise<void> = Promise.resolve();

  /**
   * Containment refusals seen during the sweep in progress. Reset per sweep and
   * safe as instance state because `sweepTail` serializes sweeps. Two closed
   * values at most, and neither is a path — this is what reaches the audit log.
   */
  private refusals = new Set<ContainmentRefusal>();

  constructor(private readonly deps: SessionArtifactRetentionDeps) {
    this.sessionsRoot = path.join(deps.workspaceRoot, '.schegent', 'sessions');
    this.fs = deps.filesystem ?? fs;
    this.now = deps.now ?? (() => new Date());
  }

  public getUsage(): SessionArtifactUsage {
    return this.usage;
  }

  public sweep(protectedRunIds: ReadonlySet<string> = new Set()): Promise<SessionArtifactRetentionResult> {
    const protectedSnapshot = new Set(protectedRunIds);
    const operation = this.sweepTail.then(
      () => this.performSweep(protectedSnapshot),
      () => this.performSweep(protectedSnapshot)
    );
    this.sweepTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async performSweep(protectedRunIds: ReadonlySet<string>): Promise<SessionArtifactRetentionResult> {
    const policy = normalizedPolicy(this.deps.policy());
    const sweptAt = this.now();
    let failures = 0;
    const groups = new Map<string, ArtifactGroup>();
    this.refusals = new Set();

    const root = await this.resolveContainedRoot();
    if (root.status === 'absent') {
      return this.finish([], policy, protectedRunIds, sweptAt, failures, 0, 0);
    }
    if (root.status !== 'ok') {
      failures += 1;
      this.refusals.add(
        root.status === 'root-not-contained' ? 'not-contained' : 'resolve-failed'
      );
      this.deps.logger.warn(
        `session-retention: ${root.status} failed`,
        { errno: root.errno }
      );
      return this.finish([], policy, protectedRunIds, sweptAt, failures, 0, 0);
    }
    const sessionsRoot = root.path;

    let entries: readonly import('node:fs').Dirent[];
    try {
      entries = await this.fs.readdir(sessionsRoot, { withFileTypes: true });
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') {
        failures += 1;
        this.warnFailure('scan-root', error);
      }
      return this.finish([], policy, protectedRunIds, sweptAt, failures, 0, 0);
    }

    for (const entry of entries) {
      // FR-R3-050 (M-12) — the shared staging directory is enumerated one level
      // down, so each pending transcript becomes its own candidate group.
      //
      // Default-mode transcripts stage in ONE directory shared by every run
      // (`raw-transcript-writer.ts`: `sessions/.pending/raw-<runId>.log`). The
      // `??` fallback below keys a directory by its own name, which is right for
      // the always-mode layout where a directory IS a run — and catastrophic
      // here, because it made the whole staging area a single group keyed
      // `.pending`. `sweep()` receives real Run IDs and can never receive a
      // directory name, so that group was unprotectable BY CONSTRUCTION: an age
      // or byte-pressure sweep deleted every active transcript in one pass.
      // Measured before the fix: three staged transcripts, all three protected,
      // zero survivors.
      //
      // Recursing here rather than widening the fallback keeps that fallback
      // doing the one job it is correct for. And it introduces no new coupling:
      // the `raw-<runId>.log` expression below is already the contract between
      // the writer and this enumeration for files in the sessions root; this
      // applies the same expression one directory further in.
      if (entry.isDirectory() && entry.name === PENDING_STAGING_DIR_NAME) {
        failures += await this.enumeratePendingStaging(
          path.join(sessionsRoot, entry.name),
          groups
        );
        continue;
      }
      // FR-R3-005 (T325) — `readdir` reports a symlink as neither file nor
      // directory, so an entry that is one used to drop out of this
      // enumeration entirely: silently skipped, which is the opposite of
      // "skipped and recorded", and no way for an operator to learn their
      // sessions directory had an entry retention would never touch. It is
      // admitted as a candidate now and the oracle decides — a link that stays
      // inside the sessions root is pruned like any other entry (`rm` unlinks
      // the link, not its target), one that leaves is refused and recorded.
      const named = entry.isFile() || entry.isSymbolicLink();
      const rawMatch = named ? RAW_TRANSCRIPT_NAME.exec(entry.name) : null;
      const runId = rawMatch?.[1]
        ?? (entry.isDirectory() || entry.isSymbolicLink() ? entry.name : null);
      if (!runId || runId === '.' || runId === '..') continue;
      const group = groups.get(runId) ?? {
        runId,
        targets: [],
        size: 0,
        mtimeMs: 0,
        scanFailed: false
      };
      groups.set(runId, group);
      const fullPath = path.join(sessionsRoot, entry.name);
      try {
        const measured = await this.measure(fullPath);
        group.targets.push(measured);
        group.size += measured.size;
        group.mtimeMs = Math.max(group.mtimeMs, measured.mtimeMs);
      } catch (error) {
        group.scanFailed = true;
        failures += 1;
        this.warnFailure('scan-artifact', error);
      }
    }

    const candidates = [...groups.values()]
      .filter((group) => !group.scanFailed && !protectedRunIds.has(group.runId))
      .sort((a, b) => a.mtimeMs - b.mtimeMs || a.runId.localeCompare(b.runId));
    const removed = new Set<string>();
    let removedBytes = 0;

    for (const group of candidates) {
      if (sweptAt.getTime() - group.mtimeMs <= policy.maxAgeMs) continue;
      const outcome = await this.removeGroup(group, sessionsRoot);
      failures += outcome.failures;
      removedBytes += outcome.removedBytes;
      if (outcome.complete) removed.add(group.runId);
    }

    let retainedBytes = [...groups.values()]
      .filter((group) => !removed.has(group.runId))
      .reduce((sum, group) => sum + group.size, 0);
    for (const group of candidates) {
      if (retainedBytes <= policy.maxBytes) break;
      if (removed.has(group.runId)) continue;
      const outcome = await this.removeGroup(group, sessionsRoot);
      failures += outcome.failures;
      removedBytes += outcome.removedBytes;
      retainedBytes = Math.max(0, retainedBytes - outcome.removedBytes);
      if (outcome.complete) removed.add(group.runId);
    }

    return this.finish(
      [...groups.values()],
      policy,
      protectedRunIds,
      sweptAt,
      failures,
      removed.size,
      removedBytes
    );
  }

  /**
   * Resolve the sweep root through every symlink and prove the result still
   * sits inside the workspace. `absent` is the ordinary pre-first-run state and
   * is not a failure; `root-not-contained` is a refusal; `resolve-root` is an
   * I/O fault that leaves containment unproven, which is treated the same way.
   *
   * The status names predate the shared oracle and are kept: they are what the
   * runtime log has said since feature 098, and an operator matching a warning
   * against a runbook should not have to learn a second vocabulary for the same
   * event.
   */
  private async resolveContainedRoot(): Promise<
    | { readonly status: 'ok'; readonly path: string }
    | { readonly status: 'absent' }
    | { readonly status: 'root-not-contained' | 'resolve-root'; readonly errno: string }
  > {
    const verdict = await resolveContainedTarget(
      this.sessionsRoot,
      [this.deps.workspaceRoot],
      this.fs
    );
    // The sessions tree has not been created yet, which is every workspace
    // before its first run. Nothing to sweep and nothing wrong.
    if (verdict.outcome === 'absent') return { status: 'absent' };
    if (verdict.outcome === 'contained') return { status: 'ok', path: verdict.resolved };
    return {
      status: verdict.reason === 'not-contained' ? 'root-not-contained' : 'resolve-root',
      errno: verdict.errno
    };
  }

  /**
   * Prove one candidate is still inside the resolved sweep root before it is
   * removed (FR-R3-005 T325).
   *
   * The root check above cannot answer this. It establishes where the *root*
   * leads; a run directory placed inside that root as a symlink out of the
   * workspace is a separate path with a separate answer, and `readdir` reports
   * it with a name indistinguishable from a real one.
   */
  private async candidateContainmentVerdict(
    fullPath: string,
    sessionsRoot: string
  ): Promise<'remove' | 'gone' | ContainmentRefusal> {
    const verdict = await resolveContainedTarget(fullPath, [sessionsRoot], this.fs);
    if (verdict.outcome === 'contained') return 'remove';
    if (verdict.outcome === 'absent') return 'gone';
    return verdict.reason;
  }

  private async measure(target: string): Promise<ArtifactTarget> {
    const stat = await this.fs.lstat(target);
    if (!stat.isDirectory()) {
      return { fullPath: target, size: stat.size, mtimeMs: stat.mtimeMs };
    }
    let size = stat.size;
    let mtimeMs = stat.mtimeMs;
    const entries = await this.fs.readdir(target, { withFileTypes: true });
    for (const entry of entries) {
      const child = await this.measure(path.join(target, entry.name));
      size += child.size;
      mtimeMs = Math.max(mtimeMs, child.mtimeMs);
    }
    return { fullPath: target, size, mtimeMs };
  }

  private async removeGroup(
    group: ArtifactGroup,
    sessionsRoot: string
  ): Promise<{
    readonly complete: boolean;
    readonly failures: number;
    readonly removedBytes: number;
  }> {
    let failures = 0;
    let removedBytes = 0;
    for (const target of group.targets) {
      const verdict = await this.candidateContainmentVerdict(target.fullPath, sessionsRoot);
      if (verdict !== 'remove' && verdict !== 'gone') {
        // Skipped and recorded. The group stays incomplete, so it is not
        // reported as pruned, and every sibling in the sweep still runs.
        failures += 1;
        this.refusals.add(verdict);
        this.warnRefusal('remove-artifact', verdict);
        continue;
      }
      if (verdict === 'gone') {
        // Vanished between the measure and the removal. `rm` with `force`
        // treated this as success before the guard existed, and it still is.
        removedBytes += target.size;
        continue;
      }
      try {
        await this.fs.rm(target.fullPath, { recursive: true, force: true });
        removedBytes += target.size;
      } catch (error) {
        failures += 1;
        this.warnFailure('remove-artifact', error);
      }
    }
    return {
      complete: failures === 0 && group.targets.length > 0,
      failures,
      removedBytes
    };
  }

  private async finish(
    groups: readonly ArtifactGroup[],
    policy: SessionArtifactRetentionPolicy,
    protectedRunIds: ReadonlySet<string>,
    sweptAt: Date,
    failures: number,
    removedArtifactCount: number,
    removedBytes: number
  ): Promise<SessionArtifactRetentionResult> {
    const removedSetSize = removedArtifactCount;
    const retainedGroups = Math.max(0, groups.length - removedSetSize);
    const retainedBytes = Math.max(
      0,
      groups.reduce((sum, group) => sum + group.size, 0) - removedBytes
    );
    const result: SessionArtifactRetentionResult = Object.freeze({
      artifactCount: retainedGroups,
      totalBytes: retainedBytes,
      lastSweepAt: sweptAt.toISOString(),
      lastSweepFailures: failures,
      removedArtifactCount,
      removedBytes,
      protectedArtifactCount: groups.filter((group) => protectedRunIds.has(group.runId)).length
    });
    this.usage = result;
    await this.emitAudit(result, policy);
    return result;
  }

  private async emitAudit(
    result: SessionArtifactRetentionResult,
    policy: SessionArtifactRetentionPolicy
  ): Promise<void> {
    if (!this.deps.audit) return;
    try {
      await this.deps.audit.append({
        runId: 'system',
        phase: 'done',
        iteration: 0,
        eventType: 'session-retention-applied',
        outcome: result.lastSweepFailures === 0 ? 'success' : 'failure',
        payload: {
          artifactCount: result.artifactCount,
          totalBytes: result.totalBytes,
          removedArtifactCount: result.removedArtifactCount,
          removedBytes: result.removedBytes,
          protectedArtifactCount: result.protectedArtifactCount,
          failures: result.lastSweepFailures,
          maxAgeMs: policy.maxAgeMs,
          maxBytes: policy.maxBytes,
          // FR-R3-005 — bounded reason codes, never the refused path. At most
          // the two members of `ContainmentRefusal`, sorted so the payload is
          // stable across sweeps that hit them in a different order.
          containmentRefusals: [...this.refusals].sort()
        }
      });
    } catch (error) {
      this.warnFailure('append-audit', error);
    }
  }

  /**
   * FR-R3-050 (M-12) — enumerate the shared staging directory one transcript at a
   * time, so each belongs to the run that produced it.
   *
   * Returns the number of scan failures to add to the caller's count, matching
   * how the outer loop accounts for them.
   *
   * An entry that does not match the filename contract gets its own group keyed
   * by the entry itself rather than falling back to the directory. That is
   * deliberate on both sides: it is not attributed to a run that did not produce
   * it (so a protected run cannot be made to shield someone else's file), and it
   * is not made blanket-immune either (so a stray file is still reclaimable). It
   * simply cannot be protected by a Run ID, because no run claims it.
   */
  private async enumeratePendingStaging(
    stagingRoot: string,
    groups: Map<string, ArtifactGroup>
  ): Promise<number> {
    let failures = 0;
    let entries: readonly import('node:fs').Dirent[];
    try {
      entries = await this.fs.readdir(stagingRoot, { withFileTypes: true });
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') {
        failures += 1;
        this.warnFailure('scan-root', error);
      }
      return failures;
    }

    for (const entry of entries) {
      // Same admission rule as the outer loop: a symlink is a candidate and the
      // containment oracle decides, rather than being silently skipped.
      const named = entry.isFile() || entry.isSymbolicLink();
      const match = named ? RAW_TRANSCRIPT_NAME.exec(entry.name) : null;
      const runId = match?.[1] ?? `${PENDING_STAGING_DIR_NAME}/${entry.name}`;
      if (entry.name === '.' || entry.name === '..') continue;
      const group = groups.get(runId) ?? {
        runId,
        targets: [],
        size: 0,
        mtimeMs: 0,
        scanFailed: false
      };
      groups.set(runId, group);
      try {
        const measured = await this.measure(path.join(stagingRoot, entry.name));
        group.targets.push(measured);
        group.size += measured.size;
        group.mtimeMs = Math.max(group.mtimeMs, measured.mtimeMs);
      } catch (error) {
        group.scanFailed = true;
        failures += 1;
        this.warnFailure('scan-artifact', error);
      }
    }
    return failures;
  }

  private warnFailure(operation: string, error: unknown = null): void {
    this.deps.logger.warn(
      `session-retention: ${operation} failed`,
      { errno: errnoCode(error) }
    );
  }

  /**
   * A containment refusal is reported as its own thing, not folded into
   * `warnFailure`. An operator reading `remove-artifact failed / ENOENT` is
   * looking for a disk problem; `remove-artifact refused / not-contained` is a
   * statement about the shape of their workspace, and the two lead to
   * different next steps.
   */
  private warnRefusal(operation: string, reason: ContainmentRefusal): void {
    this.deps.logger.warn(
      `session-retention: ${operation} refused`,
      { reason }
    );
  }
}
