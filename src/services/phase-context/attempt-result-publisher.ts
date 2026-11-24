/**
 * FR-R6-F15 (F15-B; F15-FR-04, F15-FR-08, F15-FR-14, F15-FR-20, F15-FR-23, F15-FR-24, US10, AC-12) —
 * attempt-scoped result staging, validation, atomic immutable capture, and checked F05 registration.
 *
 * - Allocates bounded per-attempt staging paths under the execution root:
 *     `.schegent/results/<rootAlias>/<attemptAlias>/contribution.json`
 *     `.schegent/results/<rootAlias>/<attemptAlias>/review-report.json`
 *     `.schegent/results/<rootAlias>/<attemptAlias>/fix-claims.json`
 * - Inspects the staging directory (strictly contained, non-following) before accepting any staged
 *   publication and fails closed whenever any leftover temporary file (`*.tmp`, `*.part`) is present.
 * - Reads files strictly via `openWithinRoot` (`flags: 'r'`), classifying only `ENOENT` as absent,
 *   enforcing regular-file containment, probing `maxBytes + 1` bytes with proper short-read offset
 *   accumulation, strict JSON depth/value bounds, and exact `ProducerRef` match (`AC-12`).
 * - Publishes immutable captures atomically under primary `workspaceRoot` via a unique sibling temp
 *   file + contained rename, and checks F05 `registerArtifact` / `addReference` outcomes.
 * - Supports opt-in attempt/iteration-scoped legacy `phase-message.env` sidecar import ONLY when
 *   explicitly requested (`legacySidecarOptIn === true`, `F15-FR-20`), parsed through
 *   `PhaseSidecarReader` key/value rules and `SanitizedLogger.sanitizeRecord`.
 *
 * Zero `vscode` imports (docs/hard-rules.md rules 13, 69).
 */
import { createHash } from 'node:crypto';
import { readdir, type FileHandle } from 'node:fs/promises';
import * as path from 'node:path';

import {
  PHASE_CONTEXT_CONTRIBUTION_VERSION,
  PHASE_CONTEXT_LIMITS,
  type ArtifactRef,
  type ProducerRef,
  type Refusal,
  type SourceContribution
} from '../../contracts/phase-context/context-policy';
import type { FixClaims, ReviewReport } from '../../contracts/phase-context/review-loop';
import { composePhaseMessagePath, PhaseSidecarReader } from '../../controller/phase-sidecar-reader';
import { SanitizedLogger } from '../../lib/logger';
import { resolveContainedTarget } from '../../lib/path-containment';
import { openWithinRoot, segmentsUnderRoot, walkDirectoriesWithinRoot } from '../../lib/safe-open';
import type { ArtifactLifecycleService } from '../artifact-lifecycle';
import { nodeExportFs, publishPartial, removePartials } from '../reporting/export-publisher';
import { sanitizePhaseContextToken } from './phase-context-helpers';
import { refuse } from './primitives';
import { parseFixClaims, parseReviewReport } from './review-report';
import { parseSourceContribution } from './source-contribution';
import { parseStrictJson, type StrictJsonLimits } from './strict-json';

const STAGED_JSON_LIMITS: StrictJsonLimits = Object.freeze({
  maxBytes: PHASE_CONTEXT_LIMITS.reviewArtifactBytesMax,
  maxDepth: PHASE_CONTEXT_LIMITS.jsonDepthMax,
  maxValues: PHASE_CONTEXT_LIMITS.jsonValuesMax
});

/** Aligned with `PhaseSidecarReader`'s 4 KiB sidecar payload bound (`FR-020`). */
const LEGACY_SIDECAR_MAX_BYTES = 4 * 1024;
const LEFTOVER_TEMP_FILE_RE = /\.(?:tmp|part)$/i;
const LEGACY_SIDECAR_SANITIZER = new SanitizedLogger();

let immutableTempCounter = 0;

export interface AttemptStagingPaths {
  readonly stagingDirSegments: readonly string[];
  readonly stagingDirAbsPath: string;
  readonly contributionSegments: readonly string[];
  readonly contributionRelPath: string;
  readonly contributionAbsPath: string;
  readonly reviewReportSegments: readonly string[];
  readonly reviewReportRelPath: string;
  readonly reviewReportAbsPath: string;
  readonly fixClaimsSegments: readonly string[];
  readonly fixClaimsRelPath: string;
  readonly fixClaimsAbsPath: string;
  readonly legacySidecarSegments: readonly string[];
  readonly legacySidecarAbsPath: string;
}

export interface LegacySidecarScope {
  readonly pipelineId: string;
  readonly phaseId: string;
  readonly iteration: number;
}

export interface PublishedArtifactCapture {
  readonly artifactRef: ArtifactRef;
  readonly immutableRelPath: string;
  readonly immutableAbsPath: string;
  readonly rawText: string;
}

export type StagedContributionOutcome =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'accepted';
      readonly contribution: SourceContribution;
      readonly capture: PublishedArtifactCapture;
    }
  | ({ readonly kind: 'refused' } & Refusal);

export type StagedReviewReportOutcome =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'accepted';
      readonly report: ReviewReport;
      readonly capture: PublishedArtifactCapture;
    }
  | ({ readonly kind: 'refused' } & Refusal);

export type StagedFixClaimsOutcome =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'accepted';
      readonly claims: FixClaims;
      readonly capture: PublishedArtifactCapture;
    }
  | ({ readonly kind: 'refused' } & Refusal);

export interface CaptureAttemptPublicationsInput {
  readonly runId: string;
  readonly executionRoot: string;
  readonly primaryWorkspaceRoot: string;
  readonly producer: ProducerRef;
  readonly legacySidecarOptIn?: boolean;
  /** Optional canonical iteration scope compatible with `composePhaseMessagePath`. */
  readonly legacySidecarScope?: LegacySidecarScope;
  /** Optional explicit attempt-bound segments relative to `executionRoot`. */
  readonly legacySidecarSegments?: readonly string[];
  /**
   * FR-027 / FR-029 — explicit host-bound authorization to publish `review-report.json`.
   * When `false` (e.g. Fixer or non-reviewer phase), any staged `review-report.json` is refused.
   */
  readonly allowReviewReport?: boolean;
  readonly lifecycle?: ArtifactLifecycleService | null;
}

export interface CaptureAttemptPublicationsResult {
  readonly staging: AttemptStagingPaths;
  readonly contribution: StagedContributionOutcome;
  readonly reviewReport: StagedReviewReportOutcome;
  readonly fixClaims: StagedFixClaimsOutcome;
}

export type BoundedReadResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly text: string; readonly byteSize: number; readonly digestHex: string }
  | ({ readonly kind: 'refused' } & Refusal);

function errnoOf(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'unknown';
}

function clipUtf8Safe(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let bytes = 0;
  let out = '';
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (bytes + chBytes > maxBytes) break;
    out += ch;
    bytes += chBytes;
  }
  return out;
}

export function allocateAttemptStagingPaths(
  executionRoot: string,
  runId: string,
  attemptId: string
): AttemptStagingPaths {
  const rootAlias = sanitizePhaseContextToken(runId, 'run');
  const attemptAlias = sanitizePhaseContextToken(attemptId, 'attempt');
  const stagingDirSegments = ['.schegent', 'results', rootAlias, attemptAlias] as const;
  const contributionSegments = [...stagingDirSegments, 'contribution.json'] as const;
  const reviewReportSegments = [...stagingDirSegments, 'review-report.json'] as const;
  const fixClaimsSegments = [...stagingDirSegments, 'fix-claims.json'] as const;
  const legacySidecarSegments = [...stagingDirSegments, 'phase-message.env'] as const;
  return Object.freeze({
    stagingDirSegments,
    stagingDirAbsPath: path.join(executionRoot, ...stagingDirSegments),
    contributionSegments,
    contributionRelPath: contributionSegments.join('/'),
    contributionAbsPath: path.join(executionRoot, ...contributionSegments),
    reviewReportSegments,
    reviewReportRelPath: reviewReportSegments.join('/'),
    reviewReportAbsPath: path.join(executionRoot, ...reviewReportSegments),
    fixClaimsSegments,
    fixClaimsRelPath: fixClaimsSegments.join('/'),
    fixClaimsAbsPath: path.join(executionRoot, ...fixClaimsSegments),
    legacySidecarSegments,
    legacySidecarAbsPath: path.join(executionRoot, ...legacySidecarSegments)
  });
}

/**
 * Reads an already-opened regular file handle into a UTF-8 string up to `maxBytes`.
 *
 * - Accumulates short reads at `offset` (never overwriting byte 0).
 * - Probes up to `maxBytes + 1` bytes so concurrent file growth past `maxBytes` is caught cleanly.
 */
export async function readBoundedUtf8FromHandle(
  handle: Pick<FileHandle, 'stat' | 'read'>,
  maxBytes: number
): Promise<BoundedReadResult> {
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { kind: 'refused', ...refuse('invalid-source', 'staging-not-a-regular-file') };
    }
    if (stat.size > maxBytes) {
      return { kind: 'refused', ...refuse('capacity-exceeded', 'artifact-oversized') };
    }
    const probeLimit = maxBytes + 1;
    let buf = Buffer.alloc(Math.min(probeLimit, Math.max(stat.size + 1, 1)));
    let offset = 0;
    for (;;) {
      if (offset === buf.length) {
        if (buf.length >= probeLimit) {
          return { kind: 'refused', ...refuse('capacity-exceeded', 'artifact-oversized') };
        }
        const nextCap = Math.min(probeLimit, Math.max(buf.length * 2, buf.length + 4096));
        const grown = Buffer.alloc(nextCap);
        buf.copy(grown, 0, 0, offset);
        buf = grown;
      }
      const { bytesRead } = await handle.read(buf, offset, buf.length - offset, offset);
      if (bytesRead <= 0) {
        break;
      }
      offset += bytesRead;
      if (offset > maxBytes) {
        return { kind: 'refused', ...refuse('capacity-exceeded', 'artifact-oversized') };
      }
    }
    if (offset < stat.size) {
      return { kind: 'refused', ...refuse('invalid-source', 'artifact-truncated') };
    }
    const slice = buf.subarray(0, offset);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(slice);
    } catch {
      // AC-12: invalid UTF-8 byte sequences fail closed rather than silently substituting U+FFFD.
      return { kind: 'refused', ...refuse('invalid-source', 'artifact-invalid-utf8') };
    }
    const digestHex = createHash('sha256').update(slice).digest('hex');
    return { kind: 'ok', text, byteSize: offset, digestHex };
  } catch (err) {
    return {
      kind: 'refused',
      ...refuse('storage-unavailable', `staging-read-${errnoOf(err).toLowerCase()}`)
    };
  }
}

async function readBoundedUtf8File(
  root: string,
  segments: readonly string[],
  maxBytes: number
): Promise<BoundedReadResult> {
  const opened = await openWithinRoot(root, segments, { flags: 'r' });
  if (opened.outcome === 'refused') {
    if (opened.reason === 'io-failed') {
      if (opened.errno === 'ENOENT') {
        return { kind: 'absent' };
      }
      if (opened.errno === 'EISDIR' || opened.errno === 'ENOTDIR') {
        return {
          kind: 'refused',
          ...refuse('invalid-source', `staging-${opened.errno.toLowerCase()}`)
        };
      }
      return {
        kind: 'refused',
        ...refuse('storage-unavailable', `staging-io-${opened.errno.toLowerCase()}`)
      };
    }
    return { kind: 'refused', ...refuse('invalid-source', `staging-${opened.reason}`) };
  }
  try {
    return await readBoundedUtf8FromHandle(opened.handle, maxBytes);
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/**
 * Inspects `.schegent/results/<rootAlias>/<attemptAlias>/` without following symlinks.
 * Fails closed if the staging path is redirected/unreadable or contains any leftover
 * `*.tmp` or `*.part` file (AC-12, Clarification Q4).
 */
async function inspectStagingDirectory(
  executionRoot: string,
  stagingDirSegments: readonly string[]
): Promise<Refusal | null> {
  const walked = await walkDirectoriesWithinRoot(executionRoot, stagingDirSegments);
  if (walked.outcome === 'refused') {
    if (walked.reason === 'io-failed') {
      if (walked.errno === 'ENOENT') {
        return null;
      }
      if (walked.errno === 'ENOTDIR') {
        return refuse('invalid-source', 'staging-enotdir');
      }
      return refuse('storage-unavailable', `staging-dir-io-${walked.errno.toLowerCase()}`);
    }
    return refuse('invalid-source', `staging-${walked.reason}`);
  }
  let entries: string[];
  try {
    entries = await readdir(walked.directory);
  } catch (err) {
    const code = errnoOf(err);
    if (code === 'ENOENT') return null;
    if (code === 'ENOTDIR') return refuse('invalid-source', 'staging-enotdir');
    return refuse('storage-unavailable', `staging-dir-read-${code.toLowerCase()}`);
  }
  for (const name of entries) {
    if (LEFTOVER_TEMP_FILE_RE.test(name)) {
      return refuse('invalid-source', 'incomplete-staging-temp-file');
    }
  }
  return null;
}

function registerAndPinCapture(params: {
  readonly lifecycle: ArtifactLifecycleService;
  readonly artifactId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly storeKind: 'handoff-context' | 'review-report';
  readonly digestHex: string;
  readonly byteSize: number;
  readonly displayName: string;
  readonly relPath: string;
}): Refusal | null {
  try {
    const reg = params.lifecycle.registerArtifact({
      artifactId: params.artifactId,
      ownerRunId: params.runId,
      ownerAttemptId: params.attemptId,
      sensitivity: 'content',
      retentionClass: 'generated-reports-handoff-exports',
      storeKind: params.storeKind,
      immutability: 'immutable',
      digest: { algorithm: 'sha256', value: params.digestHex },
      byteSize: params.byteSize,
      mediaType: 'application/json',
      displayName: params.displayName,
      producerIdentity: params.attemptId,
      locator: { storageTier: 'workspace_file', uriOrRelpath: params.relPath }
    });
    if (!reg.ok) {
      if (reg.refusal.code === 'identity-conflict') {
        const existing = params.lifecycle.getArtifact(params.artifactId);
        const matches =
          existing.ok &&
          existing.value.immutability === 'immutable' &&
          existing.value.digest?.value === params.digestHex &&
          existing.value.byteSize === params.byteSize;
        if (!matches) {
          return refuse('storage-unavailable', 'artifact-registration-conflict');
        }
      } else {
        return refuse('storage-unavailable', 'artifact-registration-failed');
      }
    }

    const pinned = params.lifecycle.addReference({
      artifactId: params.artifactId,
      ownerType: 'attempt',
      ownerId: params.attemptId,
      purpose: 'phase-context',
      protective: true
    });
    if (!pinned.ok) {
      return pinned.refusal.code === 'pin-quota-reached'
        ? refuse('capacity-exceeded', 'pin-quota-reached')
        : refuse('storage-unavailable', 'artifact-pin-failed');
    }
    return null;
  } catch {
    return refuse('storage-unavailable', 'artifact-lifecycle-error');
  }
}

async function cleanupImmutableTemp(
  primaryWorkspaceRoot: string,
  dirAbsPath: string,
  tempName: string
): Promise<void> {
  const verdict = await resolveContainedTarget(dirAbsPath, [primaryWorkspaceRoot]);
  if (verdict.outcome === 'contained') {
    await removePartials(nodeExportFs, verdict.resolved, [tempName]).catch(() => undefined);
  }
}

async function persistImmutableCapture(params: {
  readonly primaryWorkspaceRoot: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly artifactKindLabel: 'contribution' | 'review-report' | 'fix-claims' | 'legacy-sidecar';
  readonly storeKind: 'handoff-context' | 'review-report';
  readonly rawText: string;
  readonly digestHex: string;
  readonly byteSize: number;
  readonly lifecycle?: ArtifactLifecycleService | null;
}): Promise<PublishedArtifactCapture | Refusal> {
  const attemptAlias = sanitizePhaseContextToken(params.attemptId, 'attempt');
  const dirSegments = ['.schegent', 'immutable-results', attemptAlias] as const;
  const fileName = `${params.artifactKindLabel}-${params.digestHex.slice(0, 12)}.json`;
  immutableTempCounter += 1;
  const tempName = `.${fileName}.${process.pid}.${immutableTempCounter}.tmp`;
  const tempSegments = [...dirSegments, tempName] as const;
  const finalSegments = [...dirSegments, fileName] as const;
  const relPath = finalSegments.join('/');
  const absPath = path.join(params.primaryWorkspaceRoot, ...finalSegments);
  const dirAbsPath = path.join(params.primaryWorkspaceRoot, ...dirSegments);

  const opened = await openWithinRoot(params.primaryWorkspaceRoot, tempSegments, {
    flags: 'wx',
    createDirs: true,
    dirMode: 0o700,
    fileMode: 0o600
  });
  if (opened.outcome === 'refused') {
    return refuse('storage-unavailable', 'immutable-capture-refused');
  }

  let writeOk = false;
  try {
    await opened.handle.writeFile(Buffer.from(params.rawText, 'utf8'));
    writeOk = true;
  } catch {
    return refuse('storage-unavailable', 'immutable-capture-write-failed');
  } finally {
    await opened.handle.close().catch(() => undefined);
    if (!writeOk) {
      await cleanupImmutableTemp(params.primaryWorkspaceRoot, dirAbsPath, tempName);
    }
  }

  const dirVerdict = await resolveContainedTarget(dirAbsPath, [params.primaryWorkspaceRoot]);
  if (dirVerdict.outcome !== 'contained') {
    return refuse('storage-unavailable', 'immutable-capture-containment-failed');
  }

  const published = await publishPartial(nodeExportFs, dirVerdict.resolved, tempName, fileName, true);
  if (published !== 'published') {
    await removePartials(nodeExportFs, dirVerdict.resolved, [tempName]).catch(() => undefined);
    return refuse('storage-unavailable', 'immutable-capture-publish-failed');
  }

  const artifactId = `res-${params.artifactKindLabel}-${attemptAlias}`.slice(0, 120);
  const immutableVersion = `v1-${params.digestHex.slice(0, 16)}`;

  if (params.lifecycle) {
    const lifecycleFault = registerAndPinCapture({
      lifecycle: params.lifecycle,
      artifactId,
      runId: params.runId,
      attemptId: params.attemptId,
      storeKind: params.storeKind,
      digestHex: params.digestHex,
      byteSize: params.byteSize,
      displayName: fileName,
      relPath
    });
    if (lifecycleFault !== null) {
      return lifecycleFault;
    }
  }

  const artifactRef: ArtifactRef = Object.freeze({
    artifactId,
    immutableVersion,
    digestHex: params.digestHex,
    byteSize: params.byteSize,
    kind: 'text'
  });

  return Object.freeze({
    artifactRef,
    immutableRelPath: relPath,
    immutableAbsPath: absPath,
    rawText: params.rawText
  });
}

function parseLegacySidecarText(
  rawText: string,
  producer: ProducerRef
): { readonly ok: true; readonly contribution: SourceContribution } | Refusal {
  const envParsed = PhaseSidecarReader.prototype.parsePhaseMessageEnv(rawText);
  if (envParsed.duplicateKey) {
    return refuse('invalid-source', 'legacy-sidecar-duplicate-key');
  }
  const sanitized = LEGACY_SIDECAR_SANITIZER.sanitizeRecord(envParsed.entries);
  const outcomes: string[] = [];
  for (const [key, value] of Object.entries(sanitized)) {
    if (typeof value !== 'string') continue;
    const clipped = clipUtf8Safe(`${key}=${value}`, PHASE_CONTEXT_LIMITS.textEntryBytesMax);
    if (clipped.length > 0 && outcomes.length < PHASE_CONTEXT_LIMITS.collectionEntriesMax) {
      outcomes.push(clipped);
    }
  }
  if (outcomes.length === 0) {
    return refuse('invalid-source', 'legacy-sidecar-unparseable');
  }
  const candidate = {
    schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
    producer,
    coverage: 'partial' as const,
    outcomes,
    decisions: [],
    constraints: [],
    unresolvedIssues: [],
    summary: null,
    artifacts: []
  };
  return parseSourceContribution(candidate, producer);
}

function resolveLegacySidecarSegments(
  input: CaptureAttemptPublicationsInput,
  staging: AttemptStagingPaths
): { readonly ok: true; readonly segments: readonly string[] } | Refusal {
  if (input.legacySidecarSegments !== undefined) {
    return { ok: true, segments: input.legacySidecarSegments };
  }
  if (input.legacySidecarScope !== undefined) {
    const composed = composePhaseMessagePath({
      cwd: input.executionRoot,
      runId: input.runId,
      pipelineId: input.legacySidecarScope.pipelineId,
      phaseId: input.legacySidecarScope.phaseId,
      iteration: input.legacySidecarScope.iteration
    });
    const segments = segmentsUnderRoot(input.executionRoot, composed);
    if (segments === null) {
      return refuse('invalid-source', 'legacy-sidecar-escapes-root');
    }
    return { ok: true, segments };
  }
  return { ok: true, segments: staging.legacySidecarSegments };
}

export async function captureAttemptPublications(
  input: CaptureAttemptPublicationsInput
): Promise<CaptureAttemptPublicationsResult> {
  const staging = allocateAttemptStagingPaths(
    input.executionRoot,
    input.runId,
    input.producer.attemptId
  );

  // 0. Fail closed if staging directory is redirected/unreadable or contains leftover temp files.
  const stagingFault = await inspectStagingDirectory(
    input.executionRoot,
    staging.stagingDirSegments
  );
  if (stagingFault !== null) {
    const refusedOutcome = { kind: 'refused' as const, ...stagingFault };
    return Object.freeze({
      staging,
      contribution: refusedOutcome,
      reviewReport: refusedOutcome,
      fixClaims: refusedOutcome
    });
  }

  // 1. Source contribution (staged JSON first, or opt-in attempt/iteration-scoped legacy sidecar)
  let contributionOutcome: StagedContributionOutcome = { kind: 'absent' };
  const rawContribution = await readBoundedUtf8File(
    input.executionRoot,
    staging.contributionSegments,
    PHASE_CONTEXT_LIMITS.reviewArtifactBytesMax
  );
  if (rawContribution.kind === 'refused') {
    contributionOutcome = rawContribution;
  } else if (rawContribution.kind === 'ok') {
    const strictJson = parseStrictJson(rawContribution.text, STAGED_JSON_LIMITS);
    if (!strictJson.ok) {
      contributionOutcome = {
        kind: 'refused',
        ...refuse('invalid-source', `contribution-${strictJson.reason}`)
      };
    } else {
      const parsed = parseSourceContribution(strictJson.value, input.producer);
      if (!parsed.ok) {
        contributionOutcome = { kind: 'refused', ...parsed };
      } else {
        const capture = await persistImmutableCapture({
          primaryWorkspaceRoot: input.primaryWorkspaceRoot,
          runId: input.runId,
          attemptId: input.producer.attemptId,
          artifactKindLabel: 'contribution',
          storeKind: 'handoff-context',
          rawText: rawContribution.text,
          digestHex: rawContribution.digestHex,
          byteSize: rawContribution.byteSize,
          ...(input.lifecycle !== undefined ? { lifecycle: input.lifecycle } : {})
        });
        if ('ok' in capture) {
          contributionOutcome = { kind: 'refused', ...capture };
        } else {
          contributionOutcome = {
            kind: 'accepted',
            contribution: parsed.contribution,
            capture
          };
        }
      }
    }
  } else if (input.legacySidecarOptIn === true) {
    const resolvedSidecar = resolveLegacySidecarSegments(input, staging);
    if (!resolvedSidecar.ok) {
      contributionOutcome = { kind: 'refused', ...resolvedSidecar };
    } else {
      const legacyRead = await readBoundedUtf8File(
        input.executionRoot,
        resolvedSidecar.segments,
        LEGACY_SIDECAR_MAX_BYTES
      );
      if (legacyRead.kind === 'refused') {
        contributionOutcome = legacyRead;
      } else if (legacyRead.kind === 'ok') {
        const converted = parseLegacySidecarText(legacyRead.text, input.producer);
        if (!converted.ok) {
          contributionOutcome = { kind: 'refused', ...converted };
        } else {
          const serialized = JSON.stringify(converted.contribution);
          const byteSize = Buffer.byteLength(serialized, 'utf8');
          const digestHex = createHash('sha256').update(serialized, 'utf8').digest('hex');
          const capture = await persistImmutableCapture({
            primaryWorkspaceRoot: input.primaryWorkspaceRoot,
            runId: input.runId,
            attemptId: input.producer.attemptId,
            artifactKindLabel: 'legacy-sidecar',
            storeKind: 'handoff-context',
            rawText: serialized,
            digestHex,
            byteSize,
            ...(input.lifecycle !== undefined ? { lifecycle: input.lifecycle } : {})
          });
          if ('ok' in capture) {
            contributionOutcome = { kind: 'refused', ...capture };
          } else {
            contributionOutcome = {
              kind: 'accepted',
              contribution: converted.contribution,
              capture
            };
          }
        }
      }
    }
  }

  // 2. Review report (optional unless role produces one; unauthorized or invalid file always refuses)
  let reviewReportOutcome: StagedReviewReportOutcome = { kind: 'absent' };
  const rawReport = await readBoundedUtf8File(
    input.executionRoot,
    staging.reviewReportSegments,
    PHASE_CONTEXT_LIMITS.reviewArtifactBytesMax
  );
  if (rawReport.kind !== 'absent' && input.allowReviewReport === false) {
    reviewReportOutcome = {
      kind: 'refused',
      ...refuse('invalid-source', 'reviewer-role-unauthorized')
    };
  } else if (rawReport.kind === 'refused') {
    reviewReportOutcome = rawReport;
  } else if (rawReport.kind === 'ok') {
    const parsedReport = parseReviewReport(rawReport.text);
    if (!parsedReport.ok) {
      reviewReportOutcome = { kind: 'refused', ...parsedReport };
    } else if (parsedReport.report.reviewerAttemptId !== input.producer.attemptId) {
      reviewReportOutcome = {
        kind: 'refused',
        ...refuse('invalid-source', 'reviewer-attempt-mismatch')
      };
    } else {
      const capture = await persistImmutableCapture({
        primaryWorkspaceRoot: input.primaryWorkspaceRoot,
        runId: input.runId,
        attemptId: input.producer.attemptId,
        artifactKindLabel: 'review-report',
        storeKind: 'review-report',
        rawText: rawReport.text,
        digestHex: rawReport.digestHex,
        byteSize: rawReport.byteSize,
        ...(input.lifecycle !== undefined ? { lifecycle: input.lifecycle } : {})
      });
      if ('ok' in capture) {
        reviewReportOutcome = { kind: 'refused', ...capture };
      } else {
        reviewReportOutcome = {
          kind: 'accepted',
          report: parsedReport.report,
          capture
        };
      }
    }
  }

  // 3. Fix claims (optional unless fixer produces one; invalid file always refuses)
  let fixClaimsOutcome: StagedFixClaimsOutcome = { kind: 'absent' };
  const rawClaims = await readBoundedUtf8File(
    input.executionRoot,
    staging.fixClaimsSegments,
    PHASE_CONTEXT_LIMITS.reviewArtifactBytesMax
  );
  if (rawClaims.kind === 'refused') {
    fixClaimsOutcome = rawClaims;
  } else if (rawClaims.kind === 'ok') {
    const parsedClaims = parseFixClaims(rawClaims.text);
    if (!parsedClaims.ok) {
      fixClaimsOutcome = { kind: 'refused', ...parsedClaims };
    } else if (parsedClaims.claims.fixerAttemptId !== input.producer.attemptId) {
      fixClaimsOutcome = {
        kind: 'refused',
        ...refuse('invalid-source', 'fixer-attempt-mismatch')
      };
    } else {
      const capture = await persistImmutableCapture({
        primaryWorkspaceRoot: input.primaryWorkspaceRoot,
        runId: input.runId,
        attemptId: input.producer.attemptId,
        artifactKindLabel: 'fix-claims',
        storeKind: 'review-report',
        rawText: rawClaims.text,
        digestHex: rawClaims.digestHex,
        byteSize: rawClaims.byteSize,
        ...(input.lifecycle !== undefined ? { lifecycle: input.lifecycle } : {})
      });
      if ('ok' in capture) {
        fixClaimsOutcome = { kind: 'refused', ...capture };
      } else {
        fixClaimsOutcome = {
          kind: 'accepted',
          claims: parsedClaims.claims,
          capture
        };
      }
    }
  }

  return Object.freeze({
    staging,
    contribution: contributionOutcome,
    reviewReport: reviewReportOutcome,
    fixClaims: fixClaimsOutcome
  });
}
