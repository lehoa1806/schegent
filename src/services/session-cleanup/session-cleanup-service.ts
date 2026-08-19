// Feature 034 T004 — pure best-effort cleanup of the per-runId
// session tree and the sibling raw transcript file.
//
// Contract: specs/034-task-deletion-cleanup/contracts/session-cleanup.md
//
// Invariants:
//   - ALWAYS resolves; never throws.
//   - `cleaned: true`  iff BOTH the session-root directory and the raw
//                     transcript file are absent after the call (either
//                     successfully removed or already absent — `force:
//                     true` converts ENOENT to success).
//   - `cleaned: false` iff at least one sub-op caught an error or was
//                     refused on containment. Exactly one
//                     `logger.warn(...)` line is emitted per cause,
//                     aggregating the sub-op failures into a single
//                     sanitized line (single sanitization point at
//                     `SanitizedLogger.warn` → `SECRET_PATTERNS`).
//   - `refusal`       is set only for the containment cause, and is a
//                     bounded code with no path in it.
//   - No second sanitizer is introduced; the existing logger pipeline
//     is the canonical funnel.
//
// Feature FR-R3-005 (T326/T327) — both targets are now proven contained
// before they are removed.
//
// This is the *operator-triggered* delete, reached with fewer preconditions
// than activation-time retention, and it had no guard at all: both paths were
// assembled lexically from `workspaceRoot` + `runId` and handed straight to a
// recursive `rm`. A workspace whose `.schegent` is a symlink out of the tree
// therefore had its target removed, by a click, with the operator told the
// cleanup succeeded.
//
// A refusal is not a failure to retry. Nothing is removed, a bounded reason
// code comes back for the audit payload, one sanitized warn names the reason,
// and — per the standing rule — the queue removal that triggered the cleanup
// still stands. The Task is gone from the queue whether or not its evidence
// could be reached; rolling that back on an I/O outcome would make deletion
// depend on the shape of the filesystem.

import { rm as nodeFsRm, realpath as nodeFsRealpath } from 'node:fs/promises';
import type { SanitizedLogger } from '../../lib/logger';
import {
  resolveContainedTarget,
  type ContainmentFs,
  type ContainmentRefusal
} from '../../lib/path-containment';
import {
  resolveRawTranscriptPath,
  resolveSessionRootPath
} from '../phase-log/phase-log-path';

export type SessionCleanupFsRm = (
  path: string,
  opts: { recursive: true; force: true }
) => Promise<void>;

export interface SessionCleanupOutcome {
  /** True iff both targets are absent afterwards. */
  readonly cleaned: boolean;
  /**
   * Set when containment could not be proven for at least one target, so it
   * was not removed. Bounded and path-free — this is what reaches the audit
   * log. Absent when the cleanup ran, whether or not it succeeded.
   */
  readonly refusal?: ContainmentRefusal;
}

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
  /**
   * The containment oracle's seam, on the same terms as `fsRm`: production
   * never passes it, and a test drives an escaping layout without asking the
   * machine that runs the suite to have a symlink on it.
   */
  readonly filesystem?: ContainmentFs;
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

type SubOpResult =
  | { readonly kind: 'done' }
  | { readonly kind: 'failed'; readonly failure: SubOpFailure }
  | { readonly kind: 'refused'; readonly reason: ContainmentRefusal };

/**
 * Prove the target is inside the workspace, then remove it.
 *
 * `resolveContainedTarget` rather than the link form: an evidence tree that is
 * a symlink out of the workspace is not this host's to unlink on an operator's
 * behalf, and the operator asked to delete a Task, not to alter whatever
 * arrangement of links their repository ships.
 */
async function guardedRm(
  fsRm: SessionCleanupFsRm,
  filesystem: ContainmentFs,
  workspaceRoot: string,
  target: string
): Promise<SubOpResult> {
  const verdict = await resolveContainedTarget(target, [workspaceRoot], filesystem);
  if (verdict.outcome === 'refused') return { kind: 'refused', reason: verdict.reason };
  // An absent target still goes to `rm`, unchanged: `force: true` converts
  // ENOENT to success, and a run that wrote no diagnostics has always taken
  // that path. Skipping the call here would be the same outcome by a different
  // route, and "the added resolution is the only difference" is the property
  // this feature is supposed to preserve. A contained target is removed by its
  // *resolved* path, so the removal acts on what was proven rather than
  // re-walking the links a second time.
  const removable = verdict.outcome === 'contained' ? verdict.resolved : target;
  try {
    await fsRm(removable, { recursive: true, force: true });
    return { kind: 'done' };
  } catch (err) {
    return { kind: 'failed', failure: { path: target, message: describeError(err) } };
  }
}

/**
 * The reason that reaches the audit payload when the two targets disagree.
 * `not-contained` outranks `resolve-failed`: it is the finding an operator has
 * to act on, and the other is its I/O-flavoured cousin.
 */
function pickRefusal(results: readonly SubOpResult[]): ContainmentRefusal | undefined {
  const reasons = results.flatMap((r) => (r.kind === 'refused' ? [r.reason] : []));
  if (reasons.length === 0) return undefined;
  return reasons.includes('not-contained') ? 'not-contained' : reasons[0];
}

/**
 * Best-effort cleanup of the per-runId session tree and sibling raw
 * transcript file. Always resolves; never throws.
 */
export async function cleanupSessionArtifacts(
  input: SessionCleanupInput
): Promise<SessionCleanupOutcome> {
  const fsRm: SessionCleanupFsRm =
    input.fsRm ?? (nodeFsRm as unknown as SessionCleanupFsRm);
  const filesystem: ContainmentFs = input.filesystem ?? { realpath: nodeFsRealpath };
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
  const dirResult = await guardedRm(fsRm, filesystem, input.workspaceRoot, sessionRoot);
  const fileResult = await guardedRm(fsRm, filesystem, input.workspaceRoot, rawTranscript);

  const results = [dirResult, fileResult];
  const refusal = pickRefusal(results);
  if (refusal) {
    // Its own line, and no path in it. The refused path is the one thing that
    // would name a location outside the workspace in a diagnostic log, and the
    // reason is what tells the operator what to do about it.
    input.logger.warn(
      `session-cleanup: refused to remove per-runId artifacts — containment ${refusal}; the queue entry was still removed`
    );
  }

  const failures = results.flatMap((r) => (r.kind === 'failed' ? [r.failure] : []));
  if (failures.length > 0) {
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
  }

  if (refusal) return { cleaned: false, refusal };
  return { cleaned: failures.length === 0 };
}
