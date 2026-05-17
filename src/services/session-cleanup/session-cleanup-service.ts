// Feature 034 T004 — pure best-effort cleanup of the per-runId
// session tree and the sibling raw transcript file.
//
// Contract: specs/034-task-deletion-cleanup/contracts/session-cleanup.md
//
// Invariants:
//   - ALWAYS resolves; never throws.
//   - Returns `true`  iff BOTH the session-root directory and the raw
//                     transcript file are absent after the call (either
//                     successfully removed or already absent — `force:
//                     true` converts ENOENT to success).
//   - Returns `false` iff at least one sub-op caught an error. Exactly
//                     one `logger.warn(...)` line is emitted in that
//                     case, aggregating both sub-op failures into a
//                     single sanitized line (single sanitization point
//                     at `SanitizedLogger.warn` → `SECRET_PATTERNS`).
//   - No second sanitizer is introduced; the existing logger pipeline
//     is the canonical funnel.

import { rm as nodeFsRm } from 'node:fs/promises';
import type { SanitizedLogger } from '../../lib/logger';
import {
  resolveRawTranscriptPath,
  resolveSessionRootPath
} from '../phase-log/phase-log-path';

export type SessionCleanupFsRm = (
  path: string,
  opts: { recursive: true; force: true }
) => Promise<void>;

export interface SessionCleanupInput {
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly logger: Pick<SanitizedLogger, 'warn'>;
  /**
   * Test seam. Defaults to `fs.rm` from `node:fs/promises`. Production
   * code never passes this argument; tests inject a mock to exercise
   * the failure branch deterministically.
   */
  readonly fsRm?: SessionCleanupFsRm;
}

interface SubOpFailure {
  readonly path: string;
  readonly message: string;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

async function tryRm(
  fsRm: SessionCleanupFsRm,
  target: string
): Promise<SubOpFailure | null> {
  try {
    await fsRm(target, { recursive: true, force: true });
    return null;
  } catch (err) {
    return { path: target, message: describeError(err) };
  }
}

/**
 * Best-effort cleanup of the per-runId session tree and sibling raw
 * transcript file. Always resolves a boolean; never throws.
 */
export async function cleanupSessionArtifacts(
  input: SessionCleanupInput
): Promise<boolean> {
  const fsRm: SessionCleanupFsRm =
    input.fsRm ?? (nodeFsRm as unknown as SessionCleanupFsRm);
  const sessionRoot = resolveSessionRootPath({
    workspaceRoot: input.workspaceRoot,
    runId: input.runId
  });
  const rawTranscript = resolveRawTranscriptPath({
    workspaceRoot: input.workspaceRoot,
    runId: input.runId
  });

  // Run both sub-ops independently — do NOT short-circuit on first
  // failure so the second target is still attempted.
  const dirFailure = await tryRm(fsRm, sessionRoot);
  const fileFailure = await tryRm(fsRm, rawTranscript);

  const failures: SubOpFailure[] = [];
  if (dirFailure) failures.push(dirFailure);
  if (fileFailure) failures.push(fileFailure);
  if (failures.length === 0) return true;

  // Aggregate both failures into a SINGLE warn line so the operator
  // sees one entry per cleanup attempt regardless of how many sub-ops
  // failed. The SanitizedLogger.warn pipeline applies SECRET_PATTERNS
  // redaction at emit time (single sanitization point).
  const summary = failures
    .map((f) => `${f.path}: ${f.message}`)
    .join('; ');
  input.logger.warn(
    `session-cleanup: failed to remove per-runId artifacts — ${summary}`
  );
  return false;
}
