import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { withHostGitConfig } from '../../lib/host-git-config';
import { spawnCommandFor } from '../../lib/spawn-command';
import type { AttemptOutcome } from '../../contracts/decision-results';
import type { PhaseSideEffects } from '../../contracts/process-definitions';
import {
  MAX_CAPTURE_CANDIDATE_PATHS,
  MAX_CAPTURE_DURATION_MS,
  MAX_CAPTURE_FILE_BYTES,
  MAX_CAPTURE_TOTAL_BYTES,
  MAX_RECOVERY_PATH_BYTES,
  MAX_RECOVERY_REF_BYTES,
  MAX_RECOVERY_REFS_PER_ARRAY,
  RECOVERY_ENVELOPE_VERSION,
  isValidContainedWorkspacePath,
  isValidOpaqueRef,
  isValidRepositoryId,
  serializeRecoveryEnvelope,
  type RecoveryEffectCertainty,
  type RecoveryEnvelope,
  type RecoveryEnvelopeSerializeResult,
  type RecoveryPreviousOutcome,
  type RecoveryWorkspaceAttribution,
  type RecoveryWorkspaceCoverage,
  type RecoveryWorkspaceEntry
} from '../../contracts/recovery-envelope';
import { readBoundedRange } from '../../lib/bounded-read';
import { SanitizedLogger } from '../../lib/logger';
import { openWithinRoot } from '../../lib/safe-open';

const execFileAsync = promisify(execFile);
const DEFAULT_SANITIZER = new SanitizedLogger();

function sanitizeLogText(value: string): string {
  return DEFAULT_SANITIZER.sanitize(value);
}

function lookupRecord<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export interface CapturedFileObservation {
  readonly path: string;
  readonly existed: boolean;
  readonly dirtyInGit: boolean;
  readonly sha256?: string | undefined;
  readonly sizeBytes?: number | undefined;
  readonly mtimeMs?: number | undefined;
  readonly unreadable?: boolean | undefined;
  readonly symlinkOrSpecial?: boolean | undefined;
  readonly oversized?: boolean | undefined;
}

export interface WorkspaceObservationSnapshot {
  readonly repositoryId: string;
  readonly head?: string | undefined;
  readonly isGitRepository: boolean;
  readonly coverage: RecoveryWorkspaceCoverage;
  readonly omittedCount: number;
  readonly files: Readonly<Record<string, CapturedFileObservation>>;
  readonly timedOut: boolean;
  readonly capturedAtMs: number;
}

export interface CaptureWorkspaceObservationOptions {
  readonly workspaceRoot: string;
  readonly candidatePaths?: readonly string[] | undefined;
  readonly explicitDirtyPaths?: ReadonlySet<string> | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly maxCandidatePaths?: number | undefined;
  readonly maxFileBytes?: number | undefined;
  readonly maxTotalBytes?: number | undefined;
  readonly maxDurationMs?: number | undefined;
  readonly fileReadHook?: ((relativePath: string) => Promise<void> | void) | undefined;
}

export interface BuildRecoveryEnvelopeOptions {
  readonly invocationId: string;
  readonly previousAttemptId?: string | undefined;
  readonly previousOutcome?: AttemptOutcome | RecoveryPreviousOutcome | undefined;
  readonly upstreamArtifactRefs?: readonly string[] | undefined;
  readonly partialArtifactRefs?: readonly string[] | undefined;
  readonly beforeObservation?: WorkspaceObservationSnapshot | undefined;
  readonly afterObservation?: WorkspaceObservationSnapshot | undefined;
  readonly concurrentPaths?: ReadonlySet<string> | readonly string[] | undefined;
  readonly sideEffects?: PhaseSideEffects | undefined;
  readonly hasAttributableTeardown?: boolean | undefined;
  readonly verifiedReconciliation?: boolean | undefined;
  readonly effectEvidenceRefs?: readonly string[] | undefined;
}

const IGNORED_DIRECTORY_NAMES = new Set(['.git', '.schegent', 'node_modules']);

export function deriveOpaqueRepositoryId(workspaceRoot: string): string {
  const normalized = path.resolve(workspaceRoot);
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
  return `repo-${digest}`;
}

function sanitizeOpaqueToken(raw: string, fallbackPrefix: string): string {
  const sanitized = sanitizeLogText(raw).replace(/[\r\n\0]+/g, '_').trim();
  if (sanitized.length === 0) {
    return `${fallbackPrefix}-redacted`;
  }
  if (Buffer.byteLength(sanitized, 'utf8') <= MAX_RECOVERY_REF_BYTES && isValidOpaqueRef(sanitized)) {
    return sanitized;
  }
  const truncated = Buffer.from(sanitized, 'utf8')
    .subarray(0, MAX_RECOVERY_REF_BYTES)
    .toString('utf8')
    .trim();
  return truncated.length > 0 && isValidOpaqueRef(truncated)
    ? truncated
    : `${fallbackPrefix}-${createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16)}`;
}

function sanitizeRelativeWorkspacePath(rawPath: string): string | undefined {
  const normalizedSlashes = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const redacted = sanitizeLogText(normalizedSlashes).replace(/[\r\n\0]+/g, '');
  if (!isValidContainedWorkspacePath(redacted)) {
    return undefined;
  }
  return redacted;
}

interface GitWorkspaceStatus {
  readonly isGitRepository: boolean;
  readonly head?: string | undefined;
  readonly dirtyPaths: ReadonlySet<string>;
}

async function inspectGitWorkspace(workspaceRoot: string, remainingMs: number): Promise<GitWorkspaceStatus> {
  const timeoutMs = Math.max(50, Math.min(remainingMs, MAX_CAPTURE_DURATION_MS));
  try {
    const { stdout: statusOut } = await execFileAsync(
      spawnCommandFor('git'),
      withHostGitConfig(['-C', workspaceRoot, 'status', '--porcelain=v1', '-z', '-uall']),
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true
      }
    );

    const dirtyPaths = new Set<string>();
    const tokens = statusOut.split('\0');
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens.at(index);
      if (token === undefined || token.length < 4) {
        continue;
      }
      const statusPrefix = token.slice(0, 2);
      const pathPart = token.slice(3);
      if (pathPart.length > 0) {
        const normalized = pathPart.replace(/\\/g, '/');
        if (isValidContainedWorkspacePath(normalized)) {
          dirtyPaths.add(normalized);
        }
      }
      if (statusPrefix.includes('R') || statusPrefix.includes('C')) {
        const origPath = tokens.at(index + 1);
        if (origPath !== undefined && origPath.length > 0) {
          const normalizedOrig = origPath.replace(/\\/g, '/');
          if (isValidContainedWorkspacePath(normalizedOrig)) {
            dirtyPaths.add(normalizedOrig);
          }
          index += 1;
        }
      }
    }

    let head: string | undefined;
    try {
      const { stdout: headOut } = await execFileAsync(
        spawnCommandFor('git'),
        withHostGitConfig(['-C', workspaceRoot, 'rev-parse', '--verify', 'HEAD']),
        {
          encoding: 'utf8',
          timeout: Math.max(50, Math.min(500, timeoutMs)),
          windowsHide: true
        }
      );
      const trimmedHead = headOut.trim().toLowerCase();
      if (/^[0-9a-f]{7,64}$/.test(trimmedHead)) {
        head = trimmedHead;
      }
    } catch {
      // Unborn HEAD or repository with no commits yet; head remains undefined.
    }

    return {
      isGitRepository: true,
      ...(head !== undefined ? { head } : {}),
      dirtyPaths
    };
  } catch {
    return {
      isGitRepository: false,
      dirtyPaths: new Set<string>()
    };
  }
}

interface EnumeratedWorkspacePaths {
  readonly paths: readonly string[];
  readonly omittedCount: number;
  readonly hitLimitOrError: boolean;
  readonly timedOut: boolean;
}

async function enumerateContainedPaths(
  canonicalRoot: string,
  seedPaths: ReadonlySet<string>,
  maxCandidatePaths: number,
  deadlineExceeded: () => boolean
): Promise<EnumeratedWorkspacePaths> {
  const discovered = new Set<string>();
  let omittedCount = 0;
  let hitLimitOrError = false;
  let timedOut = false;

  for (const seed of seedPaths) {
    if (isValidContainedWorkspacePath(seed)) {
      discovered.add(seed);
    } else {
      omittedCount += 1;
      hitLimitOrError = true;
    }
  }

  const walkDirectory = async (relativeDir: string): Promise<void> => {
    if (deadlineExceeded()) {
      timedOut = true;
      hitLimitOrError = true;
      return;
    }
    const targetDir = relativeDir.length === 0 ? canonicalRoot : path.join(canonicalRoot, relativeDir);
    let dirEntries: fs.Dirent[];
    try {
      dirEntries = await fs.promises.readdir(targetDir, { withFileTypes: true });
    } catch {
      omittedCount += 1;
      hitLimitOrError = true;
      return;
    }

    dirEntries.sort((left, right) =>
      Buffer.compare(Buffer.from(left.name, 'utf8'), Buffer.from(right.name, 'utf8'))
    );

    for (const dirent of dirEntries) {
      if (deadlineExceeded()) {
        timedOut = true;
        hitLimitOrError = true;
        return;
      }
      if (IGNORED_DIRECTORY_NAMES.has(dirent.name)) {
        continue;
      }
      const relPath = relativeDir.length === 0 ? dirent.name : `${relativeDir}/${dirent.name}`;
      if (Buffer.byteLength(relPath, 'utf8') > MAX_RECOVERY_PATH_BYTES || !isValidContainedWorkspacePath(relPath)) {
        omittedCount += 1;
        hitLimitOrError = true;
        continue;
      }
      if (dirent.isDirectory()) {
        await walkDirectory(relPath);
        if (timedOut) {
          return;
        }
        continue;
      }
      if (!discovered.has(relPath)) {
        if (discovered.size >= maxCandidatePaths) {
          omittedCount += 1;
          hitLimitOrError = true;
          continue;
        }
        discovered.add(relPath);
      }
    }
  };

  await walkDirectory('');

  const sortedAll = [...discovered].sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
  );

  if (sortedAll.length > maxCandidatePaths) {
    omittedCount += sortedAll.length - maxCandidatePaths;
    hitLimitOrError = true;
  }

  return {
    paths: sortedAll.slice(0, maxCandidatePaths),
    omittedCount,
    hitLimitOrError,
    timedOut
  };
}

/**
 * Captures a bounded, contained workspace observation snapshot (`D5`).
 *
 * Uses `lstat` to refuse symlinks and non-regular files, and hashes contained regular
 * files via `openWithinRoot(canonicalRoot, segments, { flags: 'r' })` + `readBoundedRange`
 * within `1,000` candidate paths, `1 MiB` per file, `8 MiB` total bytes, and a `2,000 ms`
 * capture deadline. Never invokes destructive Git commands (`reset`, `checkout`, `restore`,
 * `clean`, `stash`).
 */
export async function captureWorkspaceObservation(
  options: CaptureWorkspaceObservationOptions
): Promise<WorkspaceObservationSnapshot> {
  const nowMs = options.nowMs ?? (() => Date.now());
  const startMs = nowMs();
  const maxCandidatePaths = options.maxCandidatePaths ?? MAX_CAPTURE_CANDIDATE_PATHS;
  const maxFileBytes = options.maxFileBytes ?? MAX_CAPTURE_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_CAPTURE_TOTAL_BYTES;
  const maxDurationMs = options.maxDurationMs ?? MAX_CAPTURE_DURATION_MS;
  const deadlineExceeded = (): boolean => nowMs() - startMs > maxDurationMs;

  const repositoryId = deriveOpaqueRepositoryId(options.workspaceRoot);

  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.promises.realpath(options.workspaceRoot);
  } catch {
    return {
      repositoryId,
      isGitRepository: false,
      coverage: 'unavailable',
      omittedCount: 0,
      files: {},
      timedOut: false,
      capturedAtMs: startMs
    };
  }

  const remainingForGit = Math.max(0, maxDurationMs - (nowMs() - startMs));
  const gitStatus = await inspectGitWorkspace(canonicalRoot, remainingForGit);
  const dirtyPaths = new Set<string>(gitStatus.dirtyPaths);
  if (options.explicitDirtyPaths !== undefined) {
    for (const dirtyPath of options.explicitDirtyPaths) {
      if (isValidContainedWorkspacePath(dirtyPath)) {
        dirtyPaths.add(dirtyPath);
      }
    }
  }

  let candidatePaths: readonly string[];
  let omittedCount = 0;
  let partialCoverage = false;
  let timedOut = false;

  if (options.candidatePaths !== undefined) {
    const validInputPaths: string[] = [];
    const seen = new Set<string>();
    for (const rawCandidate of options.candidatePaths) {
      const clean = sanitizeRelativeWorkspacePath(rawCandidate);
      if (clean === undefined) {
        omittedCount += 1;
        partialCoverage = true;
        continue;
      }
      if (!seen.has(clean)) {
        seen.add(clean);
        validInputPaths.push(clean);
      }
    }
    validInputPaths.sort((left, right) =>
      Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
    );
    if (validInputPaths.length > maxCandidatePaths) {
      omittedCount += validInputPaths.length - maxCandidatePaths;
      partialCoverage = true;
      candidatePaths = validInputPaths.slice(0, maxCandidatePaths);
    } else {
      candidatePaths = validInputPaths;
    }
  } else {
    const enumerated = await enumerateContainedPaths(
      canonicalRoot,
      dirtyPaths,
      maxCandidatePaths,
      deadlineExceeded
    );
    candidatePaths = enumerated.paths;
    omittedCount += enumerated.omittedCount;
    if (enumerated.hitLimitOrError) {
      partialCoverage = true;
    }
    if (enumerated.timedOut) {
      timedOut = true;
    }
  }

  const files: Record<string, CapturedFileObservation> = {};
  let totalBytesHashed = 0;

  for (let index = 0; index < candidatePaths.length; index += 1) {
    const relPath = candidatePaths.at(index);
    if (relPath === undefined) {
      continue;
    }
    if (deadlineExceeded()) {
      timedOut = true;
      partialCoverage = true;
      omittedCount += candidatePaths.length - index;
      break;
    }

    if (options.fileReadHook !== undefined) {
      await options.fileReadHook(relPath);
      if (deadlineExceeded()) {
        timedOut = true;
        partialCoverage = true;
        omittedCount += candidatePaths.length - index;
        break;
      }
    }

    const absPath = path.join(canonicalRoot, relPath);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(absPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        files[relPath] = {
          path: relPath,
          existed: false,
          dirtyInGit: dirtyPaths.has(relPath)
        };
        continue;
      }
      partialCoverage = true;
      omittedCount += 1;
      files[relPath] = {
        path: relPath,
        existed: true,
        dirtyInGit: dirtyPaths.has(relPath),
        unreadable: true
      };
      continue;
    }

    if (stat.isSymbolicLink() || !stat.isFile()) {
      partialCoverage = true;
      omittedCount += 1;
      files[relPath] = {
        path: relPath,
        existed: true,
        dirtyInGit: dirtyPaths.has(relPath),
        symlinkOrSpecial: true
      };
      continue;
    }

    if (stat.size > maxFileBytes || totalBytesHashed + stat.size > maxTotalBytes) {
      partialCoverage = true;
      omittedCount += 1;
      files[relPath] = {
        path: relPath,
        existed: true,
        dirtyInGit: dirtyPaths.has(relPath),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        oversized: true
      };
      continue;
    }

    const segments = relPath.split('/');
    let handle: fs.promises.FileHandle | undefined;
    try {
      const opened = await openWithinRoot(canonicalRoot, segments, { flags: 'r' });
      if (opened.outcome === 'refused') {
        if (opened.errno === 'ENOENT') {
          files[relPath] = {
            path: relPath,
            existed: false,
            dirtyInGit: dirtyPaths.has(relPath)
          };
          continue;
        }
        partialCoverage = true;
        omittedCount += 1;
        files[relPath] = {
          path: relPath,
          existed: true,
          dirtyInGit: dirtyPaths.has(relPath),
          unreadable: true
        };
        continue;
      }
      handle = opened.handle;
      const postOpenStat = await handle.stat();
      if (!postOpenStat.isFile() || postOpenStat.size > maxFileBytes || totalBytesHashed + postOpenStat.size > maxTotalBytes) {
        partialCoverage = true;
        omittedCount += 1;
        files[relPath] = {
          path: relPath,
          existed: true,
          dirtyInGit: dirtyPaths.has(relPath),
          sizeBytes: postOpenStat.size,
          mtimeMs: postOpenStat.mtimeMs,
          oversized: true
        };
        continue;
      }
      const range = await readBoundedRange(handle, 0, postOpenStat.size);
      totalBytesHashed += range.bytes.byteLength;
      const sha256 = createHash('sha256').update(range.bytes).digest('hex');
      files[relPath] = {
        path: relPath,
        existed: true,
        dirtyInGit: dirtyPaths.has(relPath),
        sha256,
        sizeBytes: postOpenStat.size,
        mtimeMs: postOpenStat.mtimeMs
      };
    } catch {
      partialCoverage = true;
      omittedCount += 1;
      files[relPath] = {
        path: relPath,
        existed: true,
        dirtyInGit: dirtyPaths.has(relPath),
        unreadable: true
      };
    } finally {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          // Ignore close error on read handle
        }
      }
    }
  }

  return {
    repositoryId,
    ...(gitStatus.head !== undefined ? { head: gitStatus.head } : {}),
    isGitRepository: gitStatus.isGitRepository,
    coverage: partialCoverage ? 'partial' : 'complete',
    omittedCount,
    files,
    timedOut,
    capturedAtMs: startMs
  };
}

/**
 * Evaluates `effects.certainty` (`'safe' | 'uncertain' | 'unknown'`) per `D5`.
 *
 * - `'safe'` requires positive existing evidence: either `verifiedReconciliation === true`
 *   with non-empty `evidenceRefs`, or declared contained workspace-only effects
 *   (`sideEffects === 'none' || sideEffects === 'workspace'`) with attributable teardown/checkpoint
 *   evidence (`hasAttributableTeardown === true` and `evidenceRefs.length > 0`) and no
 *   `'concurrent'` or `'unknown'` workspace attributions or `'unavailable'` coverage.
 * - `'uncertain'` when external/Git side effects (`'git' | 'unrestricted'`) lack resolved
 *   reconciliation evidence.
 * - `'unknown'` when concurrent/unattributed changes exist or teardown/checkpoint evidence
 *   is absent.
 */
export function evaluateEffectCertainty(options: {
  readonly sideEffects?: PhaseSideEffects | undefined;
  readonly hasAttributableTeardown?: boolean | undefined;
  readonly verifiedReconciliation?: boolean | undefined;
  readonly evidenceRefs: readonly string[];
  readonly workspaceCoverage: RecoveryWorkspaceCoverage;
  readonly entries: readonly RecoveryWorkspaceEntry[];
}): RecoveryEffectCertainty {
  const hasConcurrentOrUnknownEntry = options.entries.some(
    (entry) => entry.attribution === 'concurrent' || entry.attribution === 'unknown'
  );

  if (
    options.verifiedReconciliation === true &&
    options.evidenceRefs.length > 0 &&
    !hasConcurrentOrUnknownEntry &&
    options.workspaceCoverage !== 'unavailable'
  ) {
    return 'safe';
  }

  if (options.sideEffects === 'git' || options.sideEffects === 'unrestricted') {
    return 'uncertain';
  }

  if (hasConcurrentOrUnknownEntry || options.workspaceCoverage === 'unavailable') {
    return 'unknown';
  }

  if (
    (options.sideEffects === 'none' || options.sideEffects === 'workspace') &&
    options.hasAttributableTeardown === true &&
    options.evidenceRefs.length > 0
  ) {
    return 'safe';
  }

  return 'unknown';
}

/**
 * Builds, redacts, and deterministically bounds a `RecoveryEnvelope` (`D5`).
 */
export function buildRecoveryEnvelope(
  options: BuildRecoveryEnvelopeOptions
): RecoveryEnvelopeSerializeResult {
  const invocationId = sanitizeOpaqueToken(options.invocationId, 'inv');
  const previousAttemptId =
    options.previousAttemptId !== undefined
      ? sanitizeOpaqueToken(options.previousAttemptId, 'attempt')
      : undefined;

  const previousOutcome: RecoveryPreviousOutcome | undefined =
    options.previousOutcome !== undefined
      ? {
          status: options.previousOutcome.status,
          reason: options.previousOutcome.reason
        }
      : undefined;

  const sanitizeRefList = (refs: readonly string[] | undefined, prefix: string): {
    readonly items: readonly string[];
    readonly truncatedRefs: boolean;
  } => {
    if (refs === undefined || refs.length === 0) {
      return { items: [], truncatedRefs: false };
    }
    const items: string[] = [];
    for (let index = 0; index < Math.min(refs.length, MAX_RECOVERY_REFS_PER_ARRAY); index += 1) {
      const rawRef = refs.at(index);
      if (rawRef !== undefined) {
        items.push(sanitizeOpaqueToken(rawRef, prefix));
      }
    }
    return {
      items,
      truncatedRefs: refs.length > MAX_RECOVERY_REFS_PER_ARRAY
    };
  };

  const upstreamSanitized = sanitizeRefList(options.upstreamArtifactRefs, 'upstream');
  const partialSanitized = sanitizeRefList(options.partialArtifactRefs, 'partial');
  const evidenceSanitized = sanitizeRefList(options.effectEvidenceRefs, 'evidence');

  const concurrentSet = new Set<string>();
  if (options.concurrentPaths !== undefined) {
    for (const rawPath of options.concurrentPaths) {
      const clean = sanitizeRelativeWorkspacePath(rawPath);
      if (clean !== undefined) {
        concurrentSet.add(clean);
      }
    }
  }

  const beforeObs = options.beforeObservation;
  const afterObs = options.afterObservation;

  if (beforeObs === undefined && afterObs === undefined) {
    const emptyHandover: RecoveryEnvelope = {
      version: RECOVERY_ENVELOPE_VERSION,
      invocationId,
      ...(previousAttemptId !== undefined ? { previousAttemptId } : {}),
      ...(previousOutcome !== undefined ? { previousOutcome } : {}),
      upstreamArtifactRefs: upstreamSanitized.items,
      partialArtifactRefs: partialSanitized.items,
      workspace: {
        coverage: 'unavailable',
        omittedCount: 0,
        entries: []
      },
      effects: {
        certainty: evaluateEffectCertainty({
          sideEffects: options.sideEffects,
          hasAttributableTeardown: options.hasAttributableTeardown,
          verifiedReconciliation: options.verifiedReconciliation,
          evidenceRefs: evidenceSanitized.items,
          workspaceCoverage: 'unavailable',
          entries: []
        }),
        evidenceRefs: evidenceSanitized.items
      },
      truncated:
        upstreamSanitized.truncatedRefs ||
        partialSanitized.truncatedRefs ||
        evidenceSanitized.truncatedRefs
    };
    return serializeRecoveryEnvelope(emptyHandover);
  }

  const allPathsSet = new Set<string>();
  if (beforeObs !== undefined) {
    for (const key of Object.keys(beforeObs.files)) {
      allPathsSet.add(key);
    }
  }
  if (afterObs !== undefined) {
    for (const key of Object.keys(afterObs.files)) {
      allPathsSet.add(key);
    }
  }
  for (const concurrentPath of concurrentSet) {
    allPathsSet.add(concurrentPath);
  }

  const allPaths = [...allPathsSet].sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
  );

  const entries: RecoveryWorkspaceEntry[] = [];
  let extraOmitted = 0;
  let forcePartial = false;

  for (const rawPath of allPaths) {
    const sanitizedPath = sanitizeRelativeWorkspacePath(rawPath);
    if (sanitizedPath === undefined) {
      extraOmitted += 1;
      forcePartial = true;
      continue;
    }

    const beforeFile = beforeObs !== undefined ? lookupRecord(beforeObs.files, rawPath) : undefined;
    const afterFile = afterObs !== undefined ? lookupRecord(afterObs.files, rawPath) : undefined;

    const existedBefore = beforeFile?.existed === true;
    const existedAfter = afterFile?.existed === true;
    const dirtyBefore = beforeFile?.dirtyInGit === true;
    const beforeSha256 = beforeFile?.sha256;
    const afterSha256 = afterFile?.sha256;

    const hasCaptureAnomaly =
      beforeFile?.unreadable === true ||
      beforeFile?.symlinkOrSpecial === true ||
      beforeFile?.oversized === true ||
      afterFile?.unreadable === true ||
      afterFile?.symlinkOrSpecial === true ||
      afterFile?.oversized === true;

    const isConcurrent = concurrentSet.has(sanitizedPath) || concurrentSet.has(rawPath);
    if (isConcurrent || hasCaptureAnomaly) {
      forcePartial = true;
    }

    // Skip unchanged clean files that had no anomalies or concurrent edits
    const hashesEqual =
      existedBefore &&
      existedAfter &&
      beforeSha256 !== undefined &&
      afterSha256 !== undefined &&
      beforeSha256 === afterSha256;

    if (hashesEqual && !dirtyBefore && !isConcurrent && !hasCaptureAnomaly) {
      continue;
    }
    if (!existedBefore && !existedAfter && !dirtyBefore && !isConcurrent && !hasCaptureAnomaly) {
      continue;
    }

    let attribution: RecoveryWorkspaceAttribution;
    if (isConcurrent) {
      attribution = 'concurrent';
    } else if (beforeObs === undefined || afterObs === undefined || hasCaptureAnomaly) {
      attribution = 'unknown';
    } else if (existedBefore && beforeSha256 === undefined) {
      attribution = 'unknown';
    } else if (existedAfter && afterSha256 === undefined) {
      attribution = 'unknown';
    } else if (existedBefore && existedAfter && beforeSha256 === afterSha256) {
      // Dirty before the attempt, and content hash is unchanged after the attempt
      attribution = 'preexisting';
    } else {
      // Created, deleted, or modified (including already-dirty files modified again by the attempt)
      attribution = 'attempt';
    }

    entries.push({
      path: sanitizedPath,
      existedBefore,
      dirtyBefore,
      ...(beforeSha256 !== undefined ? { beforeSha256 } : {}),
      ...(afterSha256 !== undefined ? { afterSha256 } : {}),
      attribution
    });
  }

  entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'))
  );

  const baseOmitted = Math.max(beforeObs?.omittedCount ?? 0, afterObs?.omittedCount ?? 0) + extraOmitted;
  const rawCoverage: RecoveryWorkspaceCoverage =
    beforeObs?.coverage === 'unavailable' || afterObs?.coverage === 'unavailable'
      ? 'unavailable'
      : beforeObs === undefined ||
          afterObs === undefined ||
          beforeObs.coverage === 'partial' ||
          afterObs.coverage === 'partial' ||
          forcePartial ||
          baseOmitted > 0
        ? 'partial'
        : 'complete';

  const rawRepoId = afterObs?.repositoryId ?? beforeObs?.repositoryId;
  const repositoryId =
    rawRepoId !== undefined && isValidRepositoryId(sanitizeLogText(rawRepoId))
      ? sanitizeLogText(rawRepoId)
      : undefined;

  const rawHead = afterObs?.head ?? beforeObs?.head;
  const head =
    rawHead !== undefined && /^[0-9a-f]{7,64}$/i.test(sanitizeLogText(rawHead))
      ? sanitizeLogText(rawHead).toLowerCase()
      : undefined;

  const certainty = evaluateEffectCertainty({
    sideEffects: options.sideEffects,
    hasAttributableTeardown: options.hasAttributableTeardown,
    verifiedReconciliation: options.verifiedReconciliation,
    evidenceRefs: evidenceSanitized.items,
    workspaceCoverage: rawCoverage,
    entries
  });

  const candidateHandover: RecoveryEnvelope = {
    version: RECOVERY_ENVELOPE_VERSION,
    invocationId,
    ...(previousAttemptId !== undefined ? { previousAttemptId } : {}),
    ...(previousOutcome !== undefined ? { previousOutcome } : {}),
    upstreamArtifactRefs: upstreamSanitized.items,
    partialArtifactRefs: partialSanitized.items,
    workspace: {
      ...(repositoryId !== undefined ? { repositoryId } : {}),
      ...(head !== undefined ? { head } : {}),
      coverage: rawCoverage,
      omittedCount: baseOmitted,
      entries
    },
    effects: {
      certainty,
      evidenceRefs: evidenceSanitized.items
    },
    truncated:
      upstreamSanitized.truncatedRefs ||
      partialSanitized.truncatedRefs ||
      evidenceSanitized.truncatedRefs
  };

  return serializeRecoveryEnvelope(candidateHandover);
}
