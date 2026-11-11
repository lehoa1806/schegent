/**
 * FR-R6-F15 (F15-B; F15-FR-04, F15-FR-08, F15-FR-14, F15-FR-20, F15-FR-23, F15-FR-24, US10) —
 * attempt-scoped result staging, validation, immutable capture, and F05 registration.
 *
 * - Allocates bounded per-attempt staging paths under the execution root:
 *     `.schegent/results/<rootAlias>/<attemptAlias>/contribution.json`
 *     `.schegent/results/<rootAlias>/<attemptAlias>/review-report.json`
 *     `.schegent/results/<rootAlias>/<attemptAlias>/fix-claims.json`
 * - Reads files strictly via `openWithinRoot` (`flags: 'r'`), enforcing regular-file containment,
 *   the 256 KiB review/contribution byte ceiling BEFORE buffering, strict JSON depth/value bounds,
 *   and exact `ProducerRef` (`attemptId`, `nodePath`, `occurrenceId`, `invocationFrameId`) match so
 *   partial, oversized, or stale previous-attempt files are rejected without model calls (`US10`).
 * - Captures verified bytes immutably under primary `workspaceRoot` and registers + pins them in
 *   F05 `ArtifactLifecycleService`.
 * - Supports opt-in legacy `.schegent/phase-message.env` sidecar import ONLY when explicitly
 *   requested (`legacySidecarOptIn === true`, `F15-FR-20`).
 *
 * Zero `vscode` or `node:fs` imports (docs/hard-rules.md rules 13, 69).
 */
import { createHash } from 'node:crypto';
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
import { openWithinRoot } from '../../lib/safe-open';
import type { ArtifactLifecycleService } from '../artifact-lifecycle';
import { refuse } from './primitives';
import { parseFixClaims, parseReviewReport } from './review-report';
import { parseSourceContribution } from './source-contribution';
import { parseStrictJson, type StrictJsonLimits } from './strict-json';

const STAGED_JSON_LIMITS: StrictJsonLimits = Object.freeze({
  maxBytes: PHASE_CONTEXT_LIMITS.reviewArtifactBytesMax,
  maxDepth: PHASE_CONTEXT_LIMITS.jsonDepthMax,
  maxValues: PHASE_CONTEXT_LIMITS.jsonValuesMax
});

const LEGACY_SIDECAR_MAX_BYTES = 16 * 1024;

export interface AttemptStagingPaths {
  readonly contributionSegments: readonly string[];
  readonly contributionRelPath: string;
  readonly contributionAbsPath: string;
  readonly reviewReportSegments: readonly string[];
  readonly reviewReportRelPath: string;
  readonly reviewReportAbsPath: string;
  readonly fixClaimsSegments: readonly string[];
  readonly fixClaimsRelPath: string;
  readonly fixClaimsAbsPath: string;
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
  readonly lifecycle?: ArtifactLifecycleService | null;
}

export interface CaptureAttemptPublicationsResult {
  readonly staging: AttemptStagingPaths;
  readonly contribution: StagedContributionOutcome;
  readonly reviewReport: StagedReviewReportOutcome;
  readonly fixClaims: StagedFixClaimsOutcome;
}

function sanitizeToken(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function allocateAttemptStagingPaths(
  executionRoot: string,
  runId: string,
  attemptId: string
): AttemptStagingPaths {
  const rootAlias = sanitizeToken(runId, 'run');
  const attemptAlias = sanitizeToken(attemptId, 'attempt');
  const base = ['.schegent', 'results', rootAlias, attemptAlias] as const;
  const contributionSegments = [...base, 'contribution.json'] as const;
  const reviewReportSegments = [...base, 'review-report.json'] as const;
  const fixClaimsSegments = [...base, 'fix-claims.json'] as const;
  return Object.freeze({
    contributionSegments,
    contributionRelPath: contributionSegments.join('/'),
    contributionAbsPath: path.join(executionRoot, ...contributionSegments),
    reviewReportSegments,
    reviewReportRelPath: reviewReportSegments.join('/'),
    reviewReportAbsPath: path.join(executionRoot, ...reviewReportSegments),
    fixClaimsSegments,
    fixClaimsRelPath: fixClaimsSegments.join('/'),
    fixClaimsAbsPath: path.join(executionRoot, ...fixClaimsSegments)
  });
}

type BoundedReadResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly text: string; readonly byteSize: number; readonly digestHex: string }
  | ({ readonly kind: 'refused' } & Refusal);

async function readBoundedUtf8File(
  root: string,
  segments: readonly string[],
  maxBytes: number
): Promise<BoundedReadResult> {
  const opened = await openWithinRoot(root, segments, { flags: 'r' });
  if (opened.outcome === 'refused') {
    if (opened.reason === 'io-failed') {
      return { kind: 'absent' };
    }
    return { kind: 'refused', ...refuse('invalid-source', `staging-${opened.reason}`) };
  }
  try {
    const stat = await opened.handle.stat();
    if (stat.size > maxBytes) {
      return { kind: 'refused', ...refuse('capacity-exceeded', 'artifact-oversized') };
    }
    const buf = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await opened.handle.read(buf, 0, stat.size - offset, offset);
      if (bytesRead <= 0) {
        return { kind: 'refused', ...refuse('invalid-source', 'artifact-truncated') };
      }
      offset += bytesRead;
    }
    const text = buf.toString('utf8');
    const digestHex = createHash('sha256').update(buf).digest('hex');
    return { kind: 'ok', text, byteSize: stat.size, digestHex };
  } finally {
    await opened.handle.close().catch(() => undefined);
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
  const attemptAlias = sanitizeToken(params.attemptId, 'attempt');
  const fileName = `${params.artifactKindLabel}-${params.digestHex.slice(0, 12)}.json`;
  const segments = ['.schegent', 'immutable-results', attemptAlias, fileName] as const;
  const relPath = segments.join('/');
  const absPath = path.join(params.primaryWorkspaceRoot, ...segments);

  const opened = await openWithinRoot(params.primaryWorkspaceRoot, segments, {
    flags: 'w',
    createDirs: true,
    dirMode: 0o700,
    fileMode: 0o600
  });
  if (opened.outcome === 'refused') {
    return refuse('storage-unavailable', 'immutable-capture-refused');
  }
  try {
    await opened.handle.writeFile(Buffer.from(params.rawText, 'utf8'));
  } catch {
    return refuse('storage-unavailable', 'immutable-capture-write-failed');
  } finally {
    await opened.handle.close().catch(() => undefined);
  }

  const artifactId = `res-${params.artifactKindLabel}-${attemptAlias}`.slice(0, 120);
  const immutableVersion = `v1-${params.digestHex.slice(0, 16)}`;

  if (params.lifecycle) {
    params.lifecycle.registerArtifact({
      artifactId,
      ownerRunId: params.runId,
      ownerAttemptId: params.attemptId,
      sensitivity: 'content',
      retentionClass: 'generated-reports-handoff-exports',
      storeKind: params.storeKind,
      immutability: 'immutable',
      digest: { algorithm: 'sha256', value: params.digestHex },
      byteSize: params.byteSize,
      mediaType: 'application/json',
      displayName: fileName,
      producerIdentity: params.attemptId,
      locator: { storageTier: 'workspace_file', uriOrRelpath: relPath }
    });
    params.lifecycle.addReference({
      artifactId,
      ownerType: 'attempt',
      ownerId: params.attemptId,
      purpose: 'phase-context',
      protective: true
    });
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

function parseLegacySidecarText(rawText: string, producer: ProducerRef): SourceContribution | null {
  const outcomes: string[] = [];
  for (const rawLine of rawText.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const clipped = Buffer.from(trimmed, 'utf8')
      .subarray(0, PHASE_CONTEXT_LIMITS.textEntryBytesMax)
      .toString('utf8');
    if (clipped.length > 0 && outcomes.length < PHASE_CONTEXT_LIMITS.collectionEntriesMax) {
      outcomes.push(clipped);
    }
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
  const parsed = parseSourceContribution(candidate, producer);
  return parsed.ok ? parsed.contribution : null;
}

export async function captureAttemptPublications(
  input: CaptureAttemptPublicationsInput
): Promise<CaptureAttemptPublicationsResult> {
  const staging = allocateAttemptStagingPaths(
    input.executionRoot,
    input.runId,
    input.producer.attemptId
  );

  // 1. Source contribution (staged JSON first, or opt-in legacy sidecar when absent)
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
    const legacyRead = await readBoundedUtf8File(
      input.executionRoot,
      ['.schegent', 'phase-message.env'],
      LEGACY_SIDECAR_MAX_BYTES
    );
    if (legacyRead.kind === 'ok') {
      const converted = parseLegacySidecarText(legacyRead.text, input.producer);
      if (converted !== null) {
        const serialized = JSON.stringify(converted);
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
        if (!('ok' in capture)) {
          contributionOutcome = {
            kind: 'accepted',
            contribution: converted,
            capture
          };
        }
      }
    }
  }

  // 2. Review report (optional unless role produces one; invalid file always refuses)
  let reviewReportOutcome: StagedReviewReportOutcome = { kind: 'absent' };
  const rawReport = await readBoundedUtf8File(
    input.executionRoot,
    staging.reviewReportSegments,
    PHASE_CONTEXT_LIMITS.reviewArtifactBytesMax
  );
  if (rawReport.kind === 'refused') {
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
