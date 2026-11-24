/**
 * FR-R6-F15 (F15-B; F15-FR-08, F15-FR-26, F15-NFR-03, F15-NFR-07, AC-14) — atomic cross-root
 * streaming artifact materializer.
 *
 * Copies immutable source artifacts into a target execution root's protected handoff directory
 * (`.schegent/handoff-materialized/<attemptAlias>/<fileName>`) using `openWithinRoot`:
 * - Deduplicates `sources` by `artifactVersionKey` BEFORE enforcing `PHASE_CONTEXT_LIMITS`:
 *   <= 64 unique files, <= 16 MiB per file (checked on both `ref.byteSize` and actual `stat.size`),
 *   <= 64 MiB aggregate per target attempt, <= 1 MiB streaming copy buffer, and <= 30,000 ms
 *   wall-clock deadline.
 * - Verifies exact byte length and SHA-256 digest on the held source descriptor (Pass 1), streams
 *   into a unique sibling temp file while recomputing SHA-256 and exact byte count (Pass 2), and
 *   ONLY THEN atomically renames the sibling temp file to the exposed destination path.
 * - On any error (deadline, size/digest mismatch, source mutation, write stall, `ENOSPC`/I/O error,
 *   or F05 registration/pin refusal), unlinks the sibling temp file and rolls back every earlier
 *   newly copied file and newly added copy pin from the same batch so zero partial or 0-byte files
 *   ever become exposed destinations while original source pins remain untouched.
 * - On restart reuse of a verified destination copy, still ensures F05 artifact registration and
 *   protective pin exist and verifies their results.
 * - Optionally shares NFR-003 `PreparationAdmission` slots and 8 MiB working-set budget.
 *
 * Zero `vscode` or raw `node:fs` path-creating imports (docs/hard-rules.md rules 13, 69).
 */
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  IDENTIFIER_PATTERN,
  PHASE_CONTEXT_LIMITS,
  type ArtifactRef,
  type Refusal
} from '../../contracts/phase-context/context-policy';
import { resolveContainedTarget } from '../../lib/path-containment';
import { openWithinRoot } from '../../lib/safe-open';
import type { ArtifactLifecycleService } from '../artifact-lifecycle';
import { nodeExportFs, publishPartial, removePartials } from '../reporting/export-publisher';
import { materializedCopyArtifactId, sanitizePhaseContextToken } from './phase-context-helpers';
import type { PreparationAdmission } from './preparation-admission';
import { matchesPattern, refuse } from './primitives';

let tempFileCounter = 0;

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

export interface MaterializedChunkInfo {
  readonly fileIndex: number;
  readonly artifactId: string;
  readonly chunkBytes: number;
  readonly copiedBytes: number;
  readonly totalFileBytes: number;
}

export interface MaterializeBatchInput {
  readonly runId: string;
  readonly handoffId: string;
  readonly targetAttemptId: string;
  readonly targetRoot: string;
  readonly sources: readonly MaterializationSource[];
  readonly lifecycle?: ArtifactLifecycleService | null;
  readonly nowMs?: () => number;
  /** Optional shared NFR-003 admission gate for active slots and 8 MiB working-set budget. */
  readonly admission?: PreparationAdmission;
  readonly admissionOwner?: string;
  /** Optional chunk callback for streaming diagnostics and deterministic tests. */
  readonly onChunkCopied?: (info: MaterializedChunkInfo) => void | Promise<void>;
  /** Optional destination handle write hook (receives the already-opened `FileHandle`). */
  readonly writeChunk?: (
    handle: Pick<FileHandle, 'write'>,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ) => Promise<{ readonly bytesWritten: number }>;
}

export type MaterializeHandoffArtifactsInput = MaterializeBatchInput;

export type MaterializeBatchResult =
  | {
      readonly ok: true;
      readonly entries: readonly MaterializedArtifactEntry[];
      readonly byArtifactKey: ReadonlyMap<string, MaterializedArtifactEntry>;
      readonly totalBytes: number;
    }
  | Refusal;

interface CommittedCopyRollback {
  readonly anchor: string;
  readonly fileName: string;
  readonly copyArtifactId: string;
  readonly addedPin: boolean;
}

function errnoOf(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'unknown';
}

function classifyIoError(error: unknown, prefix: string): Refusal {
  const code = errnoOf(error).toLowerCase();
  return refuse('storage-unavailable', `${prefix}-${code}`);
}

function normalizeAdmissionOwner(raw: string | undefined, targetAttemptId: string): string {
  const base = (raw ?? `mat-${sanitizePhaseContextToken(targetAttemptId, 'attempt')}`)
    .trim()
    .replace(/[^A-Za-z0-9._:-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 128);
  return matchesPattern(IDENTIFIER_PATTERN, base) ? base : 'mat-attempt';
}

export function artifactVersionKey(artifactId: string, immutableVersion: string): string {
  return `${artifactId}@${immutableVersion}`;
}

function ensureCopyRegisteredAndPinned(params: {
  readonly lifecycle: ArtifactLifecycleService;
  readonly copyArtifactId: string;
  readonly runId: string;
  readonly handoffId: string;
  readonly targetAttemptId: string;
  readonly ref: ArtifactRef;
  readonly byteSize: number;
  readonly fileName: string;
  readonly relativePath: string;
}): Refusal | null {
  try {
    const reg = params.lifecycle.registerArtifact({
      artifactId: params.copyArtifactId,
      ownerRunId: params.runId,
      ownerAttemptId: params.targetAttemptId,
      sensitivity: 'content',
      retentionClass: 'generated-reports-handoff-exports',
      storeKind: 'handoff-context',
      immutability: 'immutable',
      digest: { algorithm: 'sha256', value: params.ref.digestHex },
      byteSize: params.byteSize,
      mediaType: params.ref.kind === 'text' ? 'text/plain' : 'application/octet-stream',
      displayName: params.fileName,
      producerIdentity: params.handoffId,
      locator: { storageTier: 'workspace_file', uriOrRelpath: params.relativePath }
    });
    if (!reg.ok) {
      if (reg.refusal.code === 'identity-conflict') {
        const existing = params.lifecycle.getArtifact(params.copyArtifactId);
        const matches =
          existing.ok &&
          existing.value.immutability === 'immutable' &&
          existing.value.digest?.value === params.ref.digestHex &&
          existing.value.byteSize === params.byteSize;
        if (!matches) {
          return refuse('storage-unavailable', 'artifact-registration-conflict');
        }
      } else {
        return refuse('storage-unavailable', 'artifact-registration-failed');
      }
    }

    const pinned = params.lifecycle.addReference({
      artifactId: params.copyArtifactId,
      ownerType: 'attempt',
      ownerId: params.targetAttemptId,
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

async function cleanupTempFile(
  targetRoot: string,
  destDirAbsPath: string,
  tempName: string
): Promise<void> {
  const verdict = await resolveContainedTarget(destDirAbsPath, [targetRoot]);
  if (verdict.outcome === 'contained') {
    await removePartials(nodeExportFs, verdict.resolved, [tempName]).catch(() => undefined);
  }
}

async function acquireAdmissionSlot(params: {
  readonly admission: PreparationAdmission;
  readonly ownerKey: string;
  readonly workingSetBytes: number;
  readonly clock: () => number;
  readonly deadlineAtMs: number;
}): Promise<{ readonly ok: true; readonly ownsSlot: boolean } | Refusal> {
  const { admission, ownerKey, workingSetBytes, clock, deadlineAtMs } = params;
  admission.expire();
  const snapBefore = admission.snapshot();
  const initial = admission.request(ownerKey, workingSetBytes);
  if (!initial.ok) return initial;
  const snapAfter = admission.snapshot();
  const ownsSlot =
    snapAfter.active !== snapBefore.active || snapAfter.queued !== snapBefore.queued;
  if (initial.state === 'active') {
    return { ok: true, ownsSlot };
  }

  const wallStopMs = Date.now() + PHASE_CONTEXT_LIMITS.preparationDeadlineMs;
  while (clock() <= deadlineAtMs && Date.now() <= wallStopMs) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    admission.expire();
    const check = admission.request(ownerKey, workingSetBytes);
    if (!check.ok) {
      if (ownsSlot) admission.release(ownerKey);
      return check;
    }
    if (check.state === 'active') {
      return { ok: true, ownsSlot };
    }
  }
  if (ownsSlot) admission.release(ownerKey);
  return refuse('capacity-exceeded', 'materialization-deadline');
}

export async function materializeHandoffArtifacts(
  input: MaterializeBatchInput
): Promise<MaterializeBatchResult> {
  const clock = input.nowMs ?? (() => Date.now());
  const deadlineAtMs = clock() + PHASE_CONTEXT_LIMITS.materializationDeadlineMs;

  // Deduplicate by `artifactVersionKey` BEFORE enforcing file-count and aggregate-byte caps.
  const uniqueSources: MaterializationSource[] = [];
  const uniqueByKey = new Map<string, MaterializationSource>();
  for (const item of input.sources) {
    const key = artifactVersionKey(item.ref.artifactId, item.ref.immutableVersion);
    const prior = uniqueByKey.get(key);
    if (prior !== undefined) {
      if (prior.ref.digestHex !== item.ref.digestHex || prior.ref.byteSize !== item.ref.byteSize) {
        return refuse('invalid-source', 'artifact-conflict');
      }
      continue;
    }
    uniqueByKey.set(key, item);
    uniqueSources.push(item);
  }

  if (uniqueSources.length > PHASE_CONTEXT_LIMITS.materializedFilesMax) {
    return refuse('capacity-exceeded', 'materialized-file-count');
  }

  let plannedTotalBytes = 0;
  for (const item of uniqueSources) {
    if (
      !Number.isSafeInteger(item.ref.byteSize) ||
      item.ref.byteSize < 0 ||
      item.ref.byteSize > PHASE_CONTEXT_LIMITS.materializedFileBytesMax
    ) {
      return refuse('capacity-exceeded', 'materialized-file-bytes');
    }
    plannedTotalBytes += item.ref.byteSize;
    if (plannedTotalBytes > PHASE_CONTEXT_LIMITS.materializedTotalBytesMax) {
      return refuse('capacity-exceeded', 'materialized-total-bytes');
    }
  }

  const streamChunkCap = PHASE_CONTEXT_LIMITS.materializationStreamBytesMax;
  const bufferSize = Math.min(streamChunkCap, Math.max(64 * 1024, plannedTotalBytes || 4096));

  let ownedAdmissionOwner: string | null = null;
  if (input.admission !== undefined) {
    const ownerKey = normalizeAdmissionOwner(input.admissionOwner, input.targetAttemptId);
    const acquired = await acquireAdmissionSlot({
      admission: input.admission,
      ownerKey,
      workingSetBytes: bufferSize,
      clock,
      deadlineAtMs
    });
    if (!acquired.ok) return acquired;
    if (acquired.ownsSlot) {
      ownedAdmissionOwner = ownerKey;
    }
  }

  const newlyPublishedInBatch: CommittedCopyRollback[] = [];
  const rollbackBatch = async (): Promise<void> => {
    for (const committed of [...newlyPublishedInBatch].reverse()) {
      try {
        await removePartials(nodeExportFs, committed.anchor, [committed.fileName]);
      } catch {
        // Best-effort cleanup of newly published destination copies on batch rollback.
      }
      if (committed.addedPin && input.lifecycle) {
        try {
          input.lifecycle.releaseReference({
            artifactId: committed.copyArtifactId,
            ownerType: 'attempt',
            ownerId: input.targetAttemptId,
            purpose: 'phase-context',
            reason: 'owner-durable'
          });
        } catch {
          // Best-effort release of newly added copy pin on batch rollback (original pins stay intact).
        }
      }
    }
    newlyPublishedInBatch.length = 0;
  };

  const failAndRollback = async (refusal: Refusal): Promise<Refusal> => {
    await rollbackBatch();
    return refusal;
  };

  const doWrite =
    input.writeChunk ??
    ((handle: Pick<FileHandle, 'write'>, buf: Buffer, offset: number, length: number, pos: number) =>
      handle.write(buf, offset, length, pos));

  try {
    const attemptAlias = sanitizePhaseContextToken(input.targetAttemptId, 'attempt');
    const destDirSegments = ['.schegent', 'handoff-materialized', attemptAlias] as const;
    const destDirAbsPath = path.join(input.targetRoot, ...destDirSegments);
    const byArtifactKey = new Map<string, MaterializedArtifactEntry>();
    let copiedTotalBytes = 0;

    const buffer = Buffer.allocUnsafe(bufferSize);

    for (const [uniqueIdx, item] of uniqueSources.entries()) {
      if (clock() > deadlineAtMs) {
        return await failAndRollback(refuse('capacity-exceeded', 'materialization-deadline'));
      }
      const key = artifactVersionKey(item.ref.artifactId, item.ref.immutableVersion);
      const fileName = `${String(uniqueIdx + 1).padStart(2, '0')}-${sanitizePhaseContextToken(item.ref.artifactId, 'artifact')}-${item.ref.digestHex.slice(0, 12)}.copy`;
      const destSegments = [...destDirSegments, fileName] as const;
      const relativePath = destSegments.join('/');
      const absolutePath = path.join(input.targetRoot, ...destSegments);
      const copyArtifactId = materializedCopyArtifactId(
        item.ref.artifactId,
        input.targetAttemptId,
        item.ref.digestHex
      );

      // Restart reuse check: verify existing destination copy matches exact size + SHA-256,
      // and STILL ensure F05 registration and protective pin exist before reusing it.
      const existingDest = await openWithinRoot(input.targetRoot, destSegments, { flags: 'r' });
      if (existingDest.outcome === 'refused') {
        if (existingDest.reason !== 'io-failed' || existingDest.errno !== 'ENOENT') {
          if (existingDest.reason === 'io-failed') {
            return await failAndRollback(
              refuse('storage-unavailable', `destination-open-${existingDest.errno.toLowerCase()}`)
            );
          }
          return await failAndRollback(
            refuse('required-context-unavailable', `destination-${existingDest.reason}`)
          );
        }
      } else {
        let reuseMatched = false;
        let reuseRefusal: Refusal | null = null;
        try {
          const stat = await existingDest.handle.stat();
          if (stat.isFile() && stat.size === item.ref.byteSize) {
            const checkHash = createHash('sha256');
            let pos = 0;
            while (pos < stat.size) {
              if (clock() > deadlineAtMs) {
                reuseRefusal = refuse('capacity-exceeded', 'materialization-deadline');
                break;
              }
              const toRead = Math.min(buffer.length, stat.size - pos);
              const { bytesRead } = await existingDest.handle.read(buffer, 0, toRead, pos);
              if (bytesRead <= 0) break;
              checkHash.update(buffer.subarray(0, bytesRead));
              pos += bytesRead;
            }
            if (reuseRefusal === null && pos === item.ref.byteSize) {
              const trailingProbe = await existingDest.handle.read(buffer, 0, 1, stat.size);
              if (
                trailingProbe.bytesRead === 0 &&
                checkHash.digest('hex') === item.ref.digestHex
              ) {
                reuseMatched = true;
              }
            }
          }
        } catch (err) {
          reuseRefusal = classifyIoError(err, 'destination-read');
        } finally {
          await existingDest.handle.close().catch(() => undefined);
        }

        if (reuseRefusal !== null) {
          return await failAndRollback(reuseRefusal);
        }
        if (reuseMatched) {
          if (copiedTotalBytes + item.ref.byteSize > PHASE_CONTEXT_LIMITS.materializedTotalBytesMax) {
            return await failAndRollback(refuse('capacity-exceeded', 'materialized-total-bytes'));
          }
          if (input.lifecycle) {
            const pinFault = ensureCopyRegisteredAndPinned({
              lifecycle: input.lifecycle,
              copyArtifactId,
              runId: input.runId,
              handoffId: input.handoffId,
              targetAttemptId: input.targetAttemptId,
              ref: item.ref,
              byteSize: item.ref.byteSize,
              fileName,
              relativePath
            });
            if (pinFault !== null) {
              return await failAndRollback(pinFault);
            }
          }
          const reused: MaterializedArtifactEntry = Object.freeze({
            artifactId: item.ref.artifactId,
            immutableVersion: item.ref.immutableVersion,
            absolutePath,
            relativePath,
            fileUri: pathToFileURL(absolutePath).href,
            byteSize: item.ref.byteSize,
            digestHex: item.ref.digestHex
          });
          byArtifactKey.set(key, reused);
          copiedTotalBytes += item.ref.byteSize;
          continue;
        }
      }

      const openedSource = await openWithinRoot(item.sourceRoot, item.sourceSegments, { flags: 'r' });
      if (openedSource.outcome === 'refused') {
        if (openedSource.reason === 'io-failed' && openedSource.errno !== 'ENOENT') {
          return await failAndRollback(
            refuse('storage-unavailable', `source-open-${openedSource.errno.toLowerCase()}`)
          );
        }
        return await failAndRollback(
          refuse('required-context-unavailable', 'source-open-refused')
        );
      }

      try {
        let sourceSize: number;
        try {
          const sourceStat = await openedSource.handle.stat();
          if (!sourceStat.isFile()) {
            return await failAndRollback(
              refuse('required-context-unavailable', 'source-not-a-regular-file')
            );
          }
          sourceSize = sourceStat.size;
        } catch (err) {
          return await failAndRollback(classifyIoError(err, 'source-stat'));
        }

        if (sourceSize > PHASE_CONTEXT_LIMITS.materializedFileBytesMax) {
          return await failAndRollback(refuse('capacity-exceeded', 'materialized-file-bytes'));
        }
        if (sourceSize !== item.ref.byteSize) {
          return await failAndRollback(
            refuse('required-context-unavailable', 'source-size-mismatch')
          );
        }

        // Pass 1: verify SHA-256 on the held descriptor before creating any destination file.
        try {
          const pass1Hash = createHash('sha256');
          let readOffset = 0;
          while (readOffset < sourceSize) {
            if (clock() > deadlineAtMs) {
              return await failAndRollback(refuse('capacity-exceeded', 'materialization-deadline'));
            }
            const toRead = Math.min(buffer.length, sourceSize - readOffset);
            const { bytesRead } = await openedSource.handle.read(buffer, 0, toRead, readOffset);
            if (bytesRead <= 0) {
              return await failAndRollback(
                refuse('required-context-unavailable', 'source-truncated')
              );
            }
            pass1Hash.update(buffer.subarray(0, bytesRead));
            readOffset += bytesRead;
          }
          const extraPass1 = await openedSource.handle.read(buffer, 0, 1, sourceSize);
          if (extraPass1.bytesRead > 0) {
            return await failAndRollback(
              refuse('required-context-unavailable', 'source-size-mismatch')
            );
          }
          if (pass1Hash.digest('hex') !== item.ref.digestHex) {
            return await failAndRollback(
              refuse('required-context-unavailable', 'source-digest-mismatch')
            );
          }
        } catch (err) {
          return await failAndRollback(classifyIoError(err, 'source-read'));
        }

        if (copiedTotalBytes + sourceSize > PHASE_CONTEXT_LIMITS.materializedTotalBytesMax) {
          return await failAndRollback(refuse('capacity-exceeded', 'materialized-total-bytes'));
        }

        // Pass 2: stream-copy from the held source descriptor into a unique sibling temp file.
        tempFileCounter += 1;
        const tempName = `.${fileName}.${process.pid}.${tempFileCounter}.tmp`;
        const tempSegments = [...destDirSegments, tempName] as const;

        const openedDest = await openWithinRoot(input.targetRoot, tempSegments, {
          flags: 'wx',
          createDirs: true,
          dirMode: 0o700,
          fileMode: 0o600
        });
        if (openedDest.outcome === 'refused') {
          if (openedDest.reason === 'io-failed') {
            return await failAndRollback(
              refuse('storage-unavailable', `destination-open-${openedDest.errno.toLowerCase()}`)
            );
          }
          return await failAndRollback(
            refuse('required-context-unavailable', 'destination-open-refused')
          );
        }

        let copySucceeded = false;
        let copyFailure: Refusal | null = null;
        try {
          const pass2Hash = createHash('sha256');
          let copyOffset = 0;
          while (copyOffset < sourceSize) {
            if (clock() > deadlineAtMs) {
              copyFailure = refuse('capacity-exceeded', 'materialization-deadline');
              break;
            }
            const toRead = Math.min(buffer.length, sourceSize - copyOffset);
            const { bytesRead } = await openedSource.handle.read(buffer, 0, toRead, copyOffset);
            if (bytesRead <= 0) {
              copyFailure = refuse('required-context-unavailable', 'source-mutated-during-copy');
              break;
            }
            pass2Hash.update(buffer.subarray(0, bytesRead));
            let written = 0;
            while (written < bytesRead) {
              const res = await doWrite(
                openedDest.handle,
                buffer,
                written,
                bytesRead - written,
                copyOffset + written
              );
              if (res.bytesWritten <= 0) {
                copyFailure = refuse('storage-unavailable', 'destination-write-stalled');
                break;
              }
              written += res.bytesWritten;
            }
            if (copyFailure !== null) break;
            copyOffset += bytesRead;
            if (input.onChunkCopied !== undefined) {
              await input.onChunkCopied({
                fileIndex: uniqueIdx,
                artifactId: item.ref.artifactId,
                chunkBytes: bytesRead,
                copiedBytes: copyOffset,
                totalFileBytes: sourceSize
              });
            }
          }
          if (copyFailure === null) {
            const extraPass2 = await openedSource.handle.read(buffer, 0, 1, sourceSize);
            if (extraPass2.bytesRead > 0) {
              copyFailure = refuse('required-context-unavailable', 'source-mutated-during-copy');
            } else if (pass2Hash.digest('hex') !== item.ref.digestHex) {
              copyFailure = refuse('required-context-unavailable', 'source-mutated-during-copy');
            } else {
              copySucceeded = true;
            }
          }
        } catch (err) {
          copyFailure = classifyIoError(err, 'destination-write');
        } finally {
          if (!copySucceeded) {
            await openedDest.handle.truncate(0).catch(() => undefined);
          }
          await openedDest.handle.close().catch(() => undefined);
        }

        if (!copySucceeded || copyFailure !== null) {
          await cleanupTempFile(input.targetRoot, destDirAbsPath, tempName);
          return await failAndRollback(
            copyFailure ?? refuse('storage-unavailable', 'destination-copy-failed')
          );
        }

        if (clock() > deadlineAtMs) {
          await cleanupTempFile(input.targetRoot, destDirAbsPath, tempName);
          return await failAndRollback(refuse('capacity-exceeded', 'materialization-deadline'));
        }

        const dirVerdict = await resolveContainedTarget(destDirAbsPath, [input.targetRoot]);
        if (dirVerdict.outcome !== 'contained') {
          return await failAndRollback(
            refuse('storage-unavailable', 'destination-containment-failed')
          );
        }

        const published = await publishPartial(
          nodeExportFs,
          dirVerdict.resolved,
          tempName,
          fileName,
          true
        );
        if (published !== 'published') {
          await removePartials(nodeExportFs, dirVerdict.resolved, [tempName]).catch(() => undefined);
          return await failAndRollback(refuse('storage-unavailable', 'destination-publish-failed'));
        }

        const rollbackIndex = newlyPublishedInBatch.length;
        newlyPublishedInBatch.push({
          anchor: dirVerdict.resolved,
          fileName,
          copyArtifactId,
          addedPin: false
        });

        if (input.lifecycle) {
          const pinFault = ensureCopyRegisteredAndPinned({
            lifecycle: input.lifecycle,
            copyArtifactId,
            runId: input.runId,
            handoffId: input.handoffId,
            targetAttemptId: input.targetAttemptId,
            ref: item.ref,
            byteSize: sourceSize,
            fileName,
            relativePath
          });
          if (pinFault !== null) {
            return await failAndRollback(pinFault);
          }
          newlyPublishedInBatch[rollbackIndex] = {
            anchor: dirVerdict.resolved,
            fileName,
            copyArtifactId,
            addedPin: true
          };
        }

        copiedTotalBytes += sourceSize;
        const materialized: MaterializedArtifactEntry = Object.freeze({
          artifactId: item.ref.artifactId,
          immutableVersion: item.ref.immutableVersion,
          absolutePath,
          relativePath,
          fileUri: pathToFileURL(absolutePath).href,
          byteSize: sourceSize,
          digestHex: item.ref.digestHex
        });
        byArtifactKey.set(key, materialized);
      } finally {
        await openedSource.handle.close().catch(() => undefined);
      }
    }

    const entries: MaterializedArtifactEntry[] = [];
    for (const item of input.sources) {
      const entry = byArtifactKey.get(
        artifactVersionKey(item.ref.artifactId, item.ref.immutableVersion)
      );
      if (entry !== undefined) {
        entries.push(entry);
      }
    }

    return {
      ok: true,
      entries: Object.freeze(entries),
      byArtifactKey,
      totalBytes: copiedTotalBytes
    };
  } catch (err) {
    return await failAndRollback(classifyIoError(err, 'materialization-io'));
  } finally {
    if (ownedAdmissionOwner !== null && input.admission !== undefined) {
      input.admission.release(ownedAdmissionOwner);
    }
  }
}
