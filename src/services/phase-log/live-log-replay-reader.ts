/**
 * FR-R7-16 (`16-09`, FR-009) — contained segment-replay reader over `LiveLogIndex.restartReplay()`.
 *
 * Traces finalized segments from the SQLite live-log index to bytes on disk through:
 *   1. Strict lexical `artifact_ref` validation BEFORE any filesystem probe (Hard Rule 53);
 *   2. Handle-based `openWithinRoot(trustedRoot, segments, { flags: 'r' })` (Hard Rule 69 bare literal);
 *   3. Descriptor extent check (`stat.size >= endOffset`, `0 <= startOffset <= endOffset`);
 *   4. Bounded range read via `readBoundedRange` capped across the pass at `LIVE_LOG_REPLAY_PASS_MAX_BYTES`.
 *
 * Unverified segments (`durable = 0`) are never opened. Invalid, escaping, absolute, Windows-drive,
 * NUL/control-bearing, or symlinked `artifact_ref` rows are refused as `permission-refused` without
 * accessing outside `trustedRoot`.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import * as path from 'node:path';
import { LIVE_LOG_REPLAY_PASS_MAX_BYTES } from '../../contracts/phase-log-bounds';
import { readBoundedRange } from '../../lib/bounded-read';
import { openWithinRoot } from '../../lib/safe-open';
import {
  LIVE_LOG_ARTIFACT_REF_MAX_LENGTH,
  type LiveLogIndex,
  type LiveLogUnavailableRange
} from './live-log-index';
import type { LiveLogCaptureMode } from './live-log-index-schema';

/** Alias matching the FR-R7-16 Section 3 contract name for coverage ranges. */
export type LiveLogCoverageRange = LiveLogUnavailableRange;

export type LiveLogReplaySegmentOutcome =
  | 'read'
  | 'permission-refused'
  | 'artifact-expired'
  | 'extent-invalid'
  | 'budget-exceeded';

export interface LiveLogReplaySegmentRead {
  readonly segmentSeq: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly durable: boolean;
  readonly outcome: LiveLogReplaySegmentOutcome;
  readonly text?: string;
  readonly bytesRead: number;
}

export interface LiveLogContainedReplayResult {
  readonly streamKey: string;
  readonly generation: string | null;
  readonly captureMode: LiveLogCaptureMode | null;
  readonly segments: readonly LiveLogReplaySegmentRead[];
  readonly unavailable: readonly LiveLogCoverageRange[];
  readonly truncated: boolean;
}

export interface ReadContainedLiveLogReplayOptions {
  readonly index: Pick<LiveLogIndex, 'restartReplay'>;
  readonly streamKey: string;
  readonly trustedRoot: string;
  /** Maximum total bytes read across one replay pass; defaults to `LIVE_LOG_REPLAY_PASS_MAX_BYTES` (8 MiB). */
  readonly maxPassBytes?: number;
}

const WINDOWS_DRIVE_PREFIX_RE = /^[A-Za-z]:/;

/**
 * Lexically validates a stored `artifact_ref` before any filesystem probe (Hard Rule 53).
 *
 * Accepts only 1..1024 UTF-16 character relative POSIX paths with:
 *   - zero NUL (`\0`) or ASCII control characters (`0x00..0x1F`, `0x7F`),
 *   - zero backslashes (`\`),
 *   - no POSIX absolute, Windows absolute, drive-relative (`C:foo`), or UNC forms,
 *   - non-empty `/` segments containing no `.` or `..` traversal components.
 *
 * Returns the validated forward segments, or `null` when refused.
 */
export function parseContainedArtifactRef(artifactRef: string): readonly string[] | null {
  if (artifactRef.length === 0 || artifactRef.length > LIVE_LOG_ARTIFACT_REF_MAX_LENGTH) {
    return null;
  }
  for (let i = 0; i < artifactRef.length; i += 1) {
    const code = artifactRef.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return null;
    }
  }
  if (
    artifactRef.includes('\\') ||
    artifactRef.startsWith('/') ||
    WINDOWS_DRIVE_PREFIX_RE.test(artifactRef) ||
    path.posix.isAbsolute(artifactRef) ||
    path.win32.isAbsolute(artifactRef)
  ) {
    return null;
  }
  const segments = artifactRef.split('/');
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      WINDOWS_DRIVE_PREFIX_RE.test(segment)
    ) {
      return null;
    }
  }
  return segments;
}

function errnoCodeOf(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
}

function isValidExtent(startOffset: number, endOffset: number): boolean {
  return (
    Number.isSafeInteger(startOffset) &&
    Number.isSafeInteger(endOffset) &&
    startOffset >= 0 &&
    endOffset >= startOffset
  );
}

/**
 * Traces `LiveLogIndex.restartReplay()` through strict lexical + handle-based containment
 * and bounded range reads under `trustedRoot`.
 */
export async function readContainedLiveLogReplay(
  options: ReadContainedLiveLogReplayOptions
): Promise<LiveLogContainedReplayResult> {
  if (options.trustedRoot.length === 0 || !path.isAbsolute(options.trustedRoot)) {
    throw new TypeError('trustedRoot must be a non-empty absolute path');
  }
  const maxPassBytes = options.maxPassBytes ?? LIVE_LOG_REPLAY_PASS_MAX_BYTES;
  if (!Number.isSafeInteger(maxPassBytes) || maxPassBytes < 0) {
    throw new RangeError('maxPassBytes must be a non-negative safe integer');
  }

  const replay = options.index.restartReplay({ streamKey: options.streamKey });
  if (replay === null) {
    return {
      streamKey: options.streamKey,
      generation: null,
      captureMode: null,
      segments: [],
      unavailable: [],
      truncated: false
    };
  }

  if (replay.captureMode === 'disabled') {
    return {
      streamKey: options.streamKey,
      generation: replay.generation,
      captureMode: 'disabled',
      segments: [],
      unavailable: replay.unavailable,
      truncated: replay.truncated
    };
  }

  const segments: LiveLogReplaySegmentRead[] = [];
  const unavailable: LiveLogCoverageRange[] = [...replay.unavailable];
  let remainingPassBytes = maxPassBytes;

  for (const extent of replay.readable) {
    // 1. Strict lexical validation before ANY filesystem probe (Hard Rule 53).
    const pathSegments = parseContainedArtifactRef(extent.artifactRef);
    if (pathSegments === null) {
      segments.push({
        segmentSeq: extent.segmentSeq,
        startOffset: extent.startOffset,
        endOffset: extent.endOffset,
        durable: true,
        outcome: 'permission-refused',
        bytesRead: 0
      });
      unavailable.push({
        generation: replay.generation,
        reason: 'permission-refused',
        fromOffset: extent.startOffset,
        toOffset: extent.endOffset,
        count: 1
      });
      continue;
    }

    // 2. Extent sanity check before opening.
    if (!isValidExtent(extent.startOffset, extent.endOffset)) {
      segments.push({
        segmentSeq: extent.segmentSeq,
        startOffset: extent.startOffset,
        endOffset: extent.endOffset,
        durable: true,
        outcome: 'extent-invalid',
        bytesRead: 0
      });
      continue;
    }

    // 3. Pass-wide byte budget check before opening/allocating.
    const wantedBytes = extent.endOffset - extent.startOffset;
    if (wantedBytes > remainingPassBytes) {
      segments.push({
        segmentSeq: extent.segmentSeq,
        startOffset: extent.startOffset,
        endOffset: extent.endOffset,
        durable: true,
        outcome: 'budget-exceeded',
        bytesRead: 0
      });
      unavailable.push({
        generation: replay.generation,
        reason: 'range-skipped',
        fromOffset: extent.startOffset,
        toOffset: extent.endOffset,
        count: 1
      });
      continue;
    }

    // 4. Handle-based open within trustedRoot (bare `{ flags: 'r' }` literal per Hard Rule 69).
    const opened = await openWithinRoot(options.trustedRoot, pathSegments, { flags: 'r' });
    if (opened.outcome === 'refused') {
      const outcome =
        opened.reason === 'io-failed' && opened.errno === 'ENOENT'
          ? 'artifact-expired'
          : 'permission-refused';
      segments.push({
        segmentSeq: extent.segmentSeq,
        startOffset: extent.startOffset,
        endOffset: extent.endOffset,
        durable: true,
        outcome,
        bytesRead: 0
      });
      unavailable.push({
        generation: replay.generation,
        reason: outcome,
        fromOffset: extent.startOffset,
        toOffset: extent.endOffset,
        count: 1
      });
      continue;
    }

    const handle = opened.handle;
    try {
      const stat = await handle.stat();
      if (stat.size < extent.endOffset) {
        segments.push({
          segmentSeq: extent.segmentSeq,
          startOffset: extent.startOffset,
          endOffset: extent.endOffset,
          durable: true,
          outcome: 'extent-invalid',
          bytesRead: 0
        });
        continue;
      }
      const range = await readBoundedRange(handle, extent.startOffset, wantedBytes, remainingPassBytes);
      if (range.bytes.length !== wantedBytes) {
        segments.push({
          segmentSeq: extent.segmentSeq,
          startOffset: extent.startOffset,
          endOffset: extent.endOffset,
          durable: true,
          outcome: 'extent-invalid',
          bytesRead: range.bytes.length
        });
        continue;
      }
      remainingPassBytes -= range.bytes.length;
      segments.push({
        segmentSeq: extent.segmentSeq,
        startOffset: extent.startOffset,
        endOffset: extent.endOffset,
        durable: true,
        outcome: 'read',
        text: range.bytes.toString('utf8'),
        bytesRead: range.bytes.length
      });
    } catch (err) {
      const outcome = errnoCodeOf(err) === 'ENOENT' ? 'artifact-expired' : 'permission-refused';
      segments.push({
        segmentSeq: extent.segmentSeq,
        startOffset: extent.startOffset,
        endOffset: extent.endOffset,
        durable: true,
        outcome,
        bytesRead: 0
      });
      unavailable.push({
        generation: replay.generation,
        reason: outcome,
        fromOffset: extent.startOffset,
        toOffset: extent.endOffset,
        count: 1
      });
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  return {
    streamKey: options.streamKey,
    generation: replay.generation,
    captureMode: 'captured',
    segments,
    unavailable,
    truncated: replay.truncated
  };
}
