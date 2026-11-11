/**
 * FR-R6-F15 (F15-B; F15-FR-08, F15-FR-26, F15-NFR-07) — cross-root streaming artifact materializer.
 *
 * Copies immutable source artifacts into a target execution root's protected handoff directory
 * (`.schegent/handoff-materialized/<attemptAlias>/<fileName>`) using `openWithinRoot`:
 * - Enforces `PHASE_CONTEXT_LIMITS`: <= 64 files, <= 16 MiB per file, <= 64 MiB aggregate per
 *   target attempt, <= 1 MiB streaming copy buffer, and <= 30,000 ms wall-clock deadline.
 * - Verifies exact byte length and SHA-256 digest on the open source descriptor BEFORE creating
 *   the destination file, and re-verifies SHA-256 while streaming into the destination descriptor
 *   so unverified bytes are never exposed to a target agent.
 * - Registers and pins materialized copies in F05 `ArtifactLifecycleService` when present.
 *
 * Zero `vscode` or `node:fs` imports (docs/hard-rules.md rules 13, 69).
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PHASE_CONTEXT_LIMITS,
  type ArtifactRef,
  type Refusal
} from '../../contracts/phase-context/context-policy';
import { openWithinRoot } from '../../lib/safe-open';
import type { ArtifactLifecycleService } from '../artifact-lifecycle';
import { refuse } from './primitives';

export interface MaterializationSource {
  readonly ref: ArtifactRef;
  readonly sourceRoot: string;
  readonly sourceSegments: readonly string[];
}

export interface MaterializedArtifactEntry {
  readonly artifactId: string;
  readonly immutableVersion: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly fileUri: string;
  readonly byteSize: number;
  readonly digestHex: string;
}

export interface MaterializeBatchInput {
  readonly runId: string;
  readonly handoffId: string;
  readonly targetAttemptId: string;
  readonly targetRoot: string;
  readonly sources: readonly MaterializationSource[];
  readonly lifecycle?: ArtifactLifecycleService | null;
  readonly nowMs?: () => number;
}

export type MaterializeBatchResult =
  | {
      readonly ok: true;
      readonly entries: readonly MaterializedArtifactEntry[];
      readonly byArtifactKey: ReadonlyMap<string, MaterializedArtifactEntry>;
      readonly totalBytes: number;
    }
  | Refusal;

function sanitizeSegment(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function artifactVersionKey(artifactId: string, immutableVersion: string): string {
  return `${artifactId}@${immutableVersion}`;
}

export async function materializeHandoffArtifacts(
  input: MaterializeBatchInput
): Promise<MaterializeBatchResult> {
  const clock = input.nowMs ?? (() => Date.now());
  const deadlineAtMs = clock() + PHASE_CONTEXT_LIMITS.materializationDeadlineMs;

  if (input.sources.length > PHASE_CONTEXT_LIMITS.materializedFilesMax) {
    return refuse('capacity-exceeded', 'materialized-file-count');
  }

  let plannedTotalBytes = 0;
  for (const item of input.sources) {
    if (item.ref.byteSize < 0 || item.ref.byteSize > PHASE_CONTEXT_LIMITS.materializedFileBytesMax) {
      return refuse('capacity-exceeded', 'materialized-file-bytes');
    }
    plannedTotalBytes += item.ref.byteSize;
    if (plannedTotalBytes > PHASE_CONTEXT_LIMITS.materializedTotalBytesMax) {
      return refuse('capacity-exceeded', 'materialized-total-bytes');
    }
  }

  const attemptAlias = sanitizeSegment(input.targetAttemptId, 'attempt');
  const entries: MaterializedArtifactEntry[] = [];
  const byArtifactKey = new Map<string, MaterializedArtifactEntry>();
  let copiedTotalBytes = 0;

  const streamChunkCap = PHASE_CONTEXT_LIMITS.materializationStreamBytesMax;
  const buffer = Buffer.allocUnsafe(Math.min(streamChunkCap, Math.max(64 * 1024, plannedTotalBytes || 4096)));

  for (let idx = 0; idx < input.sources.length; idx += 1) {
    if (clock() > deadlineAtMs) {
      return refuse('capacity-exceeded', 'materialization-deadline');
    }
    const item = input.sources[idx]!;
    const key = artifactVersionKey(item.ref.artifactId, item.ref.immutableVersion);
    const existing = byArtifactKey.get(key);
    if (existing !== undefined) {
      entries.push(existing);
      continue;
    }

    const fileName = `${String(idx + 1).padStart(2, '0')}-${sanitizeSegment(item.ref.artifactId, 'artifact')}-${item.ref.digestHex.slice(0, 12)}.copy`;
    const destSegments = ['.schegent', 'handoff-materialized', attemptAlias, fileName] as const;
    const relativePath = destSegments.join('/');
    const absolutePath = path.join(input.targetRoot, ...destSegments);

    // Idempotent check: if destination already exists and matches digest + byteSize, reuse it cleanly.
    const existingDest = await openWithinRoot(input.targetRoot, destSegments, { flags: 'r' });
    if (existingDest.outcome === 'opened') {
      try {
        const stat = await existingDest.handle.stat();
        if (stat.size === item.ref.byteSize) {
          const checkHash = createHash('sha256');
          let pos = 0;
          while (pos < stat.size) {
            if (clock() > deadlineAtMs) {
              return refuse('capacity-exceeded', 'materialization-deadline');
            }
            const toRead = Math.min(buffer.length, stat.size - pos);
            const { bytesRead } = await existingDest.handle.read(buffer, 0, toRead, pos);
            if (bytesRead <= 0) break;
            checkHash.update(buffer.subarray(0, bytesRead));
            pos += bytesRead;
          }
          if (pos === item.ref.byteSize && checkHash.digest('hex') === item.ref.digestHex) {
            const reused: MaterializedArtifactEntry = Object.freeze({
              artifactId: item.ref.artifactId,
              immutableVersion: item.ref.immutableVersion,
              absolutePath,
              relativePath,
              fileUri: pathToFileURL(absolutePath).href,
              byteSize: item.ref.byteSize,
              digestHex: item.ref.digestHex
            });
            entries.push(reused);
            byArtifactKey.set(key, reused);
            copiedTotalBytes += item.ref.byteSize;
            continue;
          }
        }
      } finally {
        await existingDest.handle.close().catch(() => undefined);
      }
    }

    const openedSource = await openWithinRoot(item.sourceRoot, item.sourceSegments, { flags: 'r' });
    if (openedSource.outcome === 'refused') {
      return refuse('required-context-unavailable', 'source-open-refused');
    }

    try {
      const sourceStat = await openedSource.handle.stat();
      if (sourceStat.size > PHASE_CONTEXT_LIMITS.materializedFileBytesMax) {
        return refuse('capacity-exceeded', 'materialized-file-bytes');
      }
      if (sourceStat.size !== item.ref.byteSize) {
        return refuse('required-context-unavailable', 'source-size-mismatch');
      }

      // Pass 1: verify SHA-256 on the held descriptor before touching targetRoot.
      const pass1Hash = createHash('sha256');
      let readOffset = 0;
      while (readOffset < sourceStat.size) {
        if (clock() > deadlineAtMs) {
          return refuse('capacity-exceeded', 'materialization-deadline');
        }
        const toRead = Math.min(buffer.length, sourceStat.size - readOffset);
        const { bytesRead } = await openedSource.handle.read(buffer, 0, toRead, readOffset);
        if (bytesRead <= 0) {
          return refuse('required-context-unavailable', 'source-truncated');
        }
        pass1Hash.update(buffer.subarray(0, bytesRead));
        readOffset += bytesRead;
      }
      if (pass1Hash.digest('hex') !== item.ref.digestHex) {
        return refuse('required-context-unavailable', 'source-digest-mismatch');
      }

      if (copiedTotalBytes + sourceStat.size > PHASE_CONTEXT_LIMITS.materializedTotalBytesMax) {
        return refuse('capacity-exceeded', 'materialized-total-bytes');
      }

      // Pass 2: stream-copy from the held source descriptor into the protected destination descriptor.
      const openedDest = await openWithinRoot(input.targetRoot, destSegments, {
        flags: 'w',
        createDirs: true,
        dirMode: 0o700,
        fileMode: 0o600
      });
      if (openedDest.outcome === 'refused') {
        return refuse('required-context-unavailable', 'destination-open-refused');
      }

      let copySucceeded = false;
      try {
        const pass2Hash = createHash('sha256');
        let copyOffset = 0;
        while (copyOffset < sourceStat.size) {
          if (clock() > deadlineAtMs) {
            return refuse('capacity-exceeded', 'materialization-deadline');
          }
          const toRead = Math.min(buffer.length, sourceStat.size - copyOffset);
          const { bytesRead } = await openedSource.handle.read(buffer, 0, toRead, copyOffset);
          if (bytesRead <= 0) {
            return refuse('required-context-unavailable', 'source-mutated-during-copy');
          }
          pass2Hash.update(buffer.subarray(0, bytesRead));
          let written = 0;
          while (written < bytesRead) {
            const res = await openedDest.handle.write(buffer, written, bytesRead - written, copyOffset + written);
            if (res.bytesWritten <= 0) {
              return refuse('storage-unavailable', 'destination-write-stalled');
            }
            written += res.bytesWritten;
          }
          copyOffset += bytesRead;
        }
        if (pass2Hash.digest('hex') !== item.ref.digestHex) {
          return refuse('required-context-unavailable', 'source-mutated-during-copy');
        }
        copySucceeded = true;
      } finally {
        if (!copySucceeded) {
          await openedDest.handle.truncate(0).catch(() => undefined);
        }
        await openedDest.handle.close().catch(() => undefined);
      }

      copiedTotalBytes += sourceStat.size;
      const copyArtifactId = `mat-${sanitizeSegment(item.ref.artifactId, 'art')}-${attemptAlias}`.slice(0, 120);
      if (input.lifecycle) {
        input.lifecycle.registerArtifact({
          artifactId: copyArtifactId,
          ownerRunId: input.runId,
          ownerAttemptId: input.targetAttemptId,
          sensitivity: 'content',
          retentionClass: 'generated-reports-handoff-exports',
          storeKind: 'handoff-context',
          immutability: 'immutable',
          digest: { algorithm: 'sha256', value: item.ref.digestHex },
          byteSize: sourceStat.size,
          mediaType: item.ref.kind === 'text' ? 'text/plain' : 'application/octet-stream',
          displayName: fileName,
          producerIdentity: input.handoffId,
          locator: { storageTier: 'workspace_file', uriOrRelpath: relativePath }
        });
        input.lifecycle.addReference({
          artifactId: copyArtifactId,
          ownerType: 'attempt',
          ownerId: input.targetAttemptId,
          purpose: 'phase-context',
          protective: true
        });
      }

      const materialized: MaterializedArtifactEntry = Object.freeze({
        artifactId: item.ref.artifactId,
        immutableVersion: item.ref.immutableVersion,
        absolutePath,
        relativePath,
        fileUri: pathToFileURL(absolutePath).href,
        byteSize: sourceStat.size,
        digestHex: item.ref.digestHex
      });
      entries.push(materialized);
      byArtifactKey.set(key, materialized);
    } finally {
      await openedSource.handle.close().catch(() => undefined);
    }
  }

  return {
    ok: true,
    entries: Object.freeze(entries),
    byArtifactKey,
    totalBytes: copiedTotalBytes
  };
}
