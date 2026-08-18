import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AuditLogWriter } from '../../audit/audit-log-writer';
import type { SanitizedLogger } from '../../lib/logger';

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
 * Resolution is what makes the comparison sound. `path.relative` on unresolved
 * paths is a lexical hop count that a symlink hops straight over, so the check
 * is `realpath(sessionsRoot)` against `realpath(workspaceRoot)`, and only then
 * lexical. Entries *inside* the root need no equivalent guard and deliberately
 * do not get one: `measure()` reaches them through `lstat`, which reports a
 * symlink as a non-directory and stops the descent, and `fs.rm` on a symlink
 * unlinks the link rather than its target. The root was the only opening.
 *
 * A refusal is not a failed sweep in the "retry harder" sense — it is a
 * deliberate no-op recorded as a failure so evidence health surfaces it, and no
 * path is logged, because the path is the thing that would name the operator's
 * home directory in a diagnostic log.
 */
function isContainedIn(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

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

    const root = await this.resolveContainedRoot();
    if (root.status === 'absent') {
      return this.finish([], policy, protectedRunIds, sweptAt, failures, 0, 0);
    }
    if (root.status !== 'ok') {
      failures += 1;
      this.warnFailure(root.status, root.error ?? null);
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
      const rawMatch = entry.isFile() ? /^raw-(.+)\.log$/.exec(entry.name) : null;
      const runId = rawMatch?.[1] ?? (entry.isDirectory() ? entry.name : null);
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
      const outcome = await this.removeGroup(group);
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
      const outcome = await this.removeGroup(group);
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
   */
  private async resolveContainedRoot(): Promise<
    | { readonly status: 'ok'; readonly path: string }
    | { readonly status: 'absent' }
    | { readonly status: 'root-not-contained' | 'resolve-root'; readonly error?: unknown }
  > {
    let resolvedRoot: string;
    try {
      resolvedRoot = await this.fs.realpath(this.sessionsRoot);
    } catch (error) {
      // The sessions tree has not been created yet, which is every workspace
      // before its first run. Nothing to sweep and nothing wrong.
      if (errnoCode(error) === 'ENOENT') return { status: 'absent' };
      return { status: 'resolve-root', error };
    }

    let resolvedWorkspace: string;
    try {
      resolvedWorkspace = await this.fs.realpath(this.deps.workspaceRoot);
    } catch (error) {
      // Without a resolved workspace there is nothing to compare against, so
      // containment is unproven and the sweep must not proceed.
      return { status: 'resolve-root', error };
    }

    if (!isContainedIn(resolvedRoot, resolvedWorkspace)) {
      return { status: 'root-not-contained' };
    }
    return { status: 'ok', path: resolvedRoot };
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

  private async removeGroup(group: ArtifactGroup): Promise<{
    readonly complete: boolean;
    readonly failures: number;
    readonly removedBytes: number;
  }> {
    let failures = 0;
    let removedBytes = 0;
    for (const target of group.targets) {
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
          maxBytes: policy.maxBytes
        }
      });
    } catch (error) {
      this.warnFailure('append-audit', error);
    }
  }

  private warnFailure(operation: string, error: unknown = null): void {
    this.deps.logger.warn(
      `session-retention: ${operation} failed`,
      { errno: errnoCode(error) }
    );
  }
}
