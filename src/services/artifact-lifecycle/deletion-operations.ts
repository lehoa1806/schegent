/**
 * FR-R6-F05 — the recoverable deletion operation (FR-010, FR-011, NFR-002,
 * NFR-004, NFR-005, AC-05) and FR-R7-16 hardening (`16-01`, `16-03`).
 *
 * An operation is persisted with its ordered targets before any byte moves.
 * Each target then passes the pinned effect-boundary sequence in this exact
 * order:
 *   1. fresh protection and lexical shared-locator standing re-check;
 *   2. lexical declared-root containment (zero filesystem calls outside roots);
 *   3. canonical parent containment via `resolveContainedLink`;
 *   4. non-following regular-file leaf verification via `lstat` (refusing
 *      symlinks, directories, and special files);
 *   5. canonical resolved-path shared-locator standing re-check (closing
 *      in-root parent symlink aliases) and fresh standing re-check with current
 *      `pinnedRunIds`;
 *   6. workspace sweep-lease / primacy fence verification (`fenceHolds`);
 *   7. durable `executing` intent write (`writeIntent`);
 *   8. path-based `unlink` of the canonical resolved path (`verdict.resolved`).
 * A failed intent write unlinks nothing.
 *
 * Residual path-based removal limit (`16-03`): Node's `node:fs/promises`
 * exposes only pathname-based `unlink` and not descriptor-relative
 * `openat`/`unlinkat`, so an irreducible TOCTOU window remains between the
 * final `resolveContainedLink`/`lstat` check and the `unlink` syscall. The
 * pinned sequence above is risk reduction, not a guarantee, and this residual
 * is a permanent stated limit under `docs/architecture/native-binding-decision.md`
 * — reevaluate descriptor-relative removal if stable `node:fs` adds it or if
 * the threat model changes.
 *
 * Accounting settlement (`16-01`): `recordOutcome` commits `deletion_targets`
 * and `artifact_lifecycle.availability = 'deleted'` in a single immediate
 * transaction, and `settlePass` commits operation state and lease release
 * atomically. `repairDeletionAccounting` heals any pre-existing split rows in
 * a bounded (`<= SWEEP_MAX_REMOVALS_PER_PASS`), repeatable, zero-filesystem
 * pass so backup manifests classify deleted artifacts as `tombstoned-deleted`.
 *
 * Outcomes are truthful: an absent target is `already-absent` and counts as
 * success; a target whose bytes are still present after a permission or busy
 * error is `retained`; any other failure is `unknown`. A pass removes at most
 * `SWEEP_MAX_REMOVALS_PER_PASS` targets; the rest stay `planned` and a later
 * reconcile resumes the same operation id. Every pass releases the lease and
 * emits one metadata-only audit record.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import * as path from 'node:path';
import {
  SWEEP_MAX_REMOVALS_PER_PASS,
  type DeletionExecuteRequest,
  type DeletionOperation,
  type DeletionOperationState,
  type DeletionTargetOutcomeKind,
  type LifecycleResult,
  type MutationAuthority
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import { resolveContainedLink } from '../../lib/path-containment';
import { segmentsUnderRoot } from '../../lib/safe-open';
import { planDeletion, type DeletionPlanTarget, type DeletionSelection } from './deletion-plan';
import { pinnedRunsOf, standingOf, workspaceIdOf, type LifecycleContext } from './lifecycle-context';
import { inImmediateTransaction, isOpaqueId, ok, refuse } from './lifecycle-results';
import { checkMutationAuthority, checkStandingAuthority, type LifecycleMutationResult } from './mutation-authority';

/** A lease older than this is abandoned and may be taken over by a reconcile. */
export const DELETION_LEASE_TTL_MS = 60_000;
/** The lease is renewed, and the event loop yielded, after this many targets. */
const LEASE_RENEW_EVERY_TARGETS = 50;
const RETAINED_ERRNOS: readonly string[] = ['EACCES', 'EPERM', 'EBUSY'];
const TERMINAL_STATES: readonly DeletionOperationState[] = ['completed', 'partial', 'refused', 'cancelled'];

export type DeletionRequest = DeletionExecuteRequest;

export interface DeletionAccountingRepairResult {
  readonly repaired: number;
  readonly capped: boolean;
}

type PassMode = 'execute' | 'resume';
type StopReason = 'cancelled' | 'stale-fence';

interface TargetRow {
  readonly target_ordinal: number;
  readonly artifact_id: string | null;
  readonly target_key: string;
}

interface Lease {
  readonly operationId: string;
  readonly fence: string;
}

type TargetVerdict =
  | { readonly kind: 'outcome'; readonly outcome: DeletionTargetOutcomeKind; readonly reasonCode: string | null }
  | { readonly kind: 'stop'; readonly reason: StopReason }
  | { readonly kind: 'intent-failed' };

const outcome = (kind: DeletionTargetOutcomeKind, reasonCode: string | null = null): TargetVerdict => ({
  kind: 'outcome',
  outcome: kind,
  reasonCode
});

function errnoOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

// ---------------------------------------------------------------------------
// Lease
// ---------------------------------------------------------------------------

/** Takes the workspace lease unless an unexpired one is held; inside a write transaction. */
function claimLease(ctx: LifecycleContext, lease: Lease): boolean {
  const now = ctx.deps.nowMs();
  const workspaceId = workspaceIdOf(ctx);
  const held = ctx.deps.conn.get<{ expires_at_ms: number }>(
    `SELECT expires_at_ms FROM sweep_leases WHERE workspace_id = ?`,
    workspaceId
  );
  if (held !== undefined && held.expires_at_ms > now) return false;
  ctx.deps.conn.run(
    `INSERT INTO sweep_leases (workspace_id, operation_id, holder_id, acquired_at_ms, expires_at_ms)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET operation_id = excluded.operation_id, holder_id = excluded.holder_id,
       acquired_at_ms = excluded.acquired_at_ms, expires_at_ms = excluded.expires_at_ms`,
    workspaceId,
    lease.operationId,
    lease.fence,
    now,
    now + DELETION_LEASE_TTL_MS
  );
  return true;
}

function renewLease(ctx: LifecycleContext, lease: Lease): void {
  ctx.deps.conn.run(
    `UPDATE sweep_leases SET expires_at_ms = ? WHERE workspace_id = ? AND holder_id = ?`,
    ctx.deps.nowMs() + DELETION_LEASE_TTL_MS,
    workspaceIdOf(ctx),
    lease.fence
  );
}

function releaseLease(ctx: LifecycleContext, lease: Lease): void {
  ctx.deps.conn.run(`DELETE FROM sweep_leases WHERE workspace_id = ? AND holder_id = ?`, workspaceIdOf(ctx), lease.fence);
}

function fenceHolds(ctx: LifecycleContext, lease: Lease): boolean {
  const row = ctx.deps.conn.get<{ held: number }>(
    `SELECT 1 AS held FROM sweep_leases WHERE workspace_id = ? AND operation_id = ? AND holder_id = ?`,
    workspaceIdOf(ctx),
    lease.operationId,
    lease.fence
  );
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// One target
// ---------------------------------------------------------------------------

/** The fresh protection re-check; null when the target may proceed. */
function recheckStanding(ctx: LifecycleContext, artifactId: string | null, pinnedRuns: ReadonlySet<string>): TargetVerdict | null {
  if (artifactId === null) return outcome('refused', 'not-found');
  const found = ctx.records.get(artifactId);
  if (!found.ok) return outcome('refused', 'not-found');
  const standing = standingOf(ctx, found.value, pinnedRuns);
  if (standing.protected) return outcome('refused', 'protected-reference');
  if (standing.neverEligible) return outcome('refused', 'never-eligible');
  if (standing.liveWriter) return outcome('retained', 'live-writer');
  return null;
}

const CASE_INSENSITIVE_PLATFORM = process.platform === 'win32' || process.platform === 'darwin';

function canonicalSharerPath(workspaceRoot: string | undefined, locator: string): string {
  const posix = locator.replaceAll('\\', '/');
  if (workspaceRoot !== undefined) {
    return path.resolve(workspaceRoot, posix);
  }
  const normalized = path.posix.normalize(posix);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return CASE_INSENSITIVE_PLATFORM
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/**
 * Another artifact recorded at the same workspace file shares its bytes: removing the file removes
 * them for it too, so its standing is re-checked as well. A sharer that is gone is no bar.
 * Matches sharers by canonical lexical path so non-canonical pre-existing rows (`./`, `//`, `\`)
 * cannot bypass standing checks before any filesystem probes.
 */
function recheckSharers(ctx: LifecycleContext, row: TargetRow, pinnedRuns: ReadonlySet<string>): TargetVerdict | null {
  if (row.artifact_id === null) return null;
  const workspaceRoot = ctx.deps.workspaceRoot;
  const targetCanonical = canonicalSharerPath(workspaceRoot, row.target_key);
  const candidates = ctx.deps.conn.all<{ artifact_id: string; uri_or_relpath: string }>(
    `SELECT artifact_id, uri_or_relpath FROM artifact_locations
     WHERE storage_tier = 'workspace_file' AND artifact_id <> ?
     ORDER BY artifact_id ASC`,
    row.artifact_id
  );
  const sharerIds = new Set<string>();
  for (const candidate of candidates) {
    const candidateCanonical = canonicalSharerPath(workspaceRoot, candidate.uri_or_relpath);
    const sameLexical =
      workspaceRoot !== undefined
        ? sameCanonicalPath(candidateCanonical, targetCanonical)
        : candidateCanonical === targetCanonical;
    if (candidate.uri_or_relpath === row.target_key || sameLexical) {
      sharerIds.add(candidate.artifact_id);
    }
  }
  for (const sharerId of sharerIds) {
    if (!ctx.records.get(sharerId).ok) continue;
    const verdict = recheckStanding(ctx, sharerId, pinnedRuns);
    if (verdict !== null) return verdict;
  }
  return null;
}

/**
 * Canonical resolved-path shared-locator check (`SR-304-1`): after `resolveContainedLink` resolves
 * any in-root parent symlink on the target to `resolvedTarget`, verify that no other `workspace_file`
 * artifact with blocking standing resolves to the same canonical path (whether registered via the
 * canonical path or via another in-root parent symlink). Fails closed if resolving an in-workspace
 * candidate with blocking standing fails.
 */
async function recheckResolvedSharers(
  ctx: LifecycleContext,
  workspaceRoot: string,
  declaredRoot: string,
  row: TargetRow,
  resolvedTarget: string
): Promise<TargetVerdict | null> {
  if (row.artifact_id === null) return null;
  const targetBasenameLower = path.basename(resolvedTarget).toLowerCase();
  const candidates = ctx.deps.conn.all<{ artifact_id: string; uri_or_relpath: string }>(
    `SELECT artifact_id, uri_or_relpath FROM artifact_locations
     WHERE storage_tier = 'workspace_file' AND artifact_id <> ?
     ORDER BY artifact_id ASC`,
    row.artifact_id
  );
  const matchedArtifactIds = new Set<string>();
  for (const candidate of candidates) {
    const candidateCanonical = canonicalSharerPath(workspaceRoot, candidate.uri_or_relpath);
    if (path.basename(candidateCanonical).toLowerCase() !== targetBasenameLower) continue;
    // Never probe the filesystem outside the workspace for malformed legacy rows.
    if (segmentsUnderRoot(workspaceRoot, candidateCanonical) === null) continue;
    if (!ctx.records.get(candidate.artifact_id).ok) continue;
    const preStanding = recheckStanding(ctx, candidate.artifact_id, pinnedRunsOf(ctx));
    const candidateVerdict = await resolveContainedLink(candidateCanonical, [declaredRoot], ctx.deps.fs);
    if (candidateVerdict.outcome === 'contained') {
      if (sameCanonicalPath(candidateVerdict.resolved, resolvedTarget)) {
        matchedArtifactIds.add(candidate.artifact_id);
        const freshStanding = recheckStanding(ctx, candidate.artifact_id, pinnedRunsOf(ctx));
        if (freshStanding !== null) return freshStanding;
      }
      continue;
    }
    if (candidateVerdict.outcome === 'refused' && candidateVerdict.reason !== 'not-contained') {
      const failClosedStanding = recheckStanding(ctx, candidate.artifact_id, pinnedRunsOf(ctx)) ?? preStanding;
      if (failClosedStanding !== null) return failClosedStanding;
    }
  }
  if (matchedArtifactIds.size > 0) {
    const freshPinnedRuns = pinnedRunsOf(ctx);
    for (const sharerId of matchedArtifactIds) {
      if (!ctx.records.get(sharerId).ok) continue;
      const verdict = recheckStanding(ctx, sharerId, freshPinnedRuns);
      if (verdict !== null) return verdict;
    }
  }
  return null;
}

function declaredRootOf(ctx: LifecycleContext, absolute: string): string | null {
  const root = ctx.deps.scanRoots.find((candidate) => segmentsUnderRoot(candidate.root, absolute) !== null);
  return root === undefined ? null : root.root;
}

function writeIntent(ctx: LifecycleContext, operationId: string, ordinal: number): boolean {
  try {
    ctx.deps.conn.run(
      `UPDATE deletion_targets SET outcome = ?, updated_at_ms = ? WHERE operation_id = ? AND target_ordinal = ?`,
      'executing',
      ctx.deps.nowMs(),
      operationId,
      ordinal
    );
    return true;
  } catch {
    return false;
  }
}

function markDeleted(ctx: LifecycleContext, artifactId: string | null): void {
  if (artifactId === null) return;
  const fresh = ctx.records.get(artifactId);
  if (!fresh.ok || !fresh.value.managed || fresh.value.availability === 'deleted') return;
  ctx.records.compareAndSetAvailability(artifactId, fresh.value.lifecycleRevision, 'deleted');
}

/**
 * Effect boundary for removing one planned target (`16-03`, `SR-304-1`, `SR-304-2`).
 * Pinned sequence: fresh standing/lexical sharers -> lexical root -> `resolveContainedLink`
 * -> non-following regular-file `lstat` -> canonical resolved-path sharers -> fresh standing
 * re-check -> `fenceHolds` -> `writeIntent` -> pathname `unlink(verdict.resolved)`. Residual
 * pathname-`unlink` TOCTOU between `lstat` and `unlink` is a permanent stated limit under
 * `docs/architecture/native-binding-decision.md`.
 */
async function removeTarget(
  ctx: LifecycleContext,
  lease: Lease,
  row: TargetRow
): Promise<TargetVerdict> {
  const initialPinnedRuns = pinnedRunsOf(ctx);
  const standing =
    recheckStanding(ctx, row.artifact_id, initialPinnedRuns) ?? recheckSharers(ctx, row, initialPinnedRuns);
  if (standing !== null) return standing;
  const workspaceRoot = ctx.deps.workspaceRoot;
  if (workspaceRoot === undefined) return outcome('refused', 'containment-violation');
  const absolute = path.resolve(workspaceRoot, row.target_key);
  const root = declaredRootOf(ctx, absolute);
  if (root === null) return outcome('refused', 'containment-violation');
  // The entry itself, never what it points at: a target that became a link is refused below
  // (`kind !== 'file'`) rather than followed to a file the plan never named.
  const verdict = await resolveContainedLink(absolute, [root], ctx.deps.fs);
  if (verdict.outcome === 'absent') return outcome('already-absent');
  if (verdict.outcome === 'refused') return outcome('refused', 'containment-violation');
  const entry = await ctx.deps.fs.lstat(verdict.resolved);
  if (entry === null) return outcome('already-absent');
  if (entry.kind !== 'file') return outcome('refused', 'containment-violation');
  const resolvedSharer = await recheckResolvedSharers(ctx, workspaceRoot, root, row, verdict.resolved);
  if (resolvedSharer !== null) return resolvedSharer;
  const finalPinnedRuns = pinnedRunsOf(ctx);
  const finalStanding =
    recheckStanding(ctx, row.artifact_id, finalPinnedRuns) ?? recheckSharers(ctx, row, finalPinnedRuns);
  if (finalStanding !== null) return finalStanding;
  if (!fenceHolds(ctx, lease)) return { kind: 'stop', reason: 'stale-fence' };
  if (!writeIntent(ctx, lease.operationId, row.target_ordinal)) return { kind: 'intent-failed' };
  try {
    // Only the path proven contained under its declared root above is removed.
    await ctx.deps.fs.unlink(verdict.resolved);
    return outcome('deleted');
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === 'ENOENT') return outcome('already-absent');
    return RETAINED_ERRNOS.includes(errno) ? outcome('retained', errno) : outcome('unknown', errno);
  }
}

/** Commits target outcome and `artifact_lifecycle.availability = 'deleted'` atomically (`16-01`). */
function recordOutcome(ctx: LifecycleContext, operationId: string, row: TargetRow, verdict: TargetVerdict): void {
  if (verdict.kind !== 'outcome') return;
  inImmediateTransaction(ctx.deps.conn, () => {
    ctx.deps.conn.run(
      `UPDATE deletion_targets SET outcome = ?, reason_code = ?, updated_at_ms = ? WHERE operation_id = ? AND target_ordinal = ?`,
      verdict.outcome,
      verdict.reasonCode,
      ctx.deps.nowMs(),
      operationId,
      row.target_ordinal
    );
    if (verdict.outcome === 'deleted' || verdict.outcome === 'already-absent') {
      markDeleted(ctx, row.artifact_id);
    }
  });
}

// ---------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------

function pendingTargets(ctx: LifecycleContext, operationId: string): readonly TargetRow[] {
  return ctx.deps.conn.all<TargetRow>(
    `SELECT target_ordinal, artifact_id, target_key FROM deletion_targets
     WHERE operation_id = ? AND outcome IN ('planned', 'executing')
     ORDER BY target_ordinal LIMIT ?`,
    operationId,
    SWEEP_MAX_REMOVALS_PER_PASS
  );
}

function refuseRemaining(ctx: LifecycleContext, operationId: string, reason: StopReason): void {
  ctx.deps.conn.run(
    `UPDATE deletion_targets SET outcome = 'refused', reason_code = ?, updated_at_ms = ?
     WHERE operation_id = ? AND outcome = 'planned'`,
    reason,
    ctx.deps.nowMs(),
    operationId
  );
}

function outcomeCounts(ctx: LifecycleContext, operationId: string): Record<DeletionTargetOutcomeKind, number> {
  const counts: Record<DeletionTargetOutcomeKind, number> = {
    planned: 0,
    executing: 0,
    deleted: 0,
    'already-absent': 0,
    retained: 0,
    unknown: 0,
    refused: 0
  };
  const rows = ctx.deps.conn.all<{ outcome: DeletionTargetOutcomeKind; n: number }>(
    `SELECT outcome, COUNT(*) AS n FROM deletion_targets WHERE operation_id = ? GROUP BY outcome`,
    operationId
  );
  for (const row of rows) counts[row.outcome] = row.n;
  return counts;
}

function stateAfterPass(counts: Record<DeletionTargetOutcomeKind, number>, cancelled: boolean): DeletionOperationState {
  // A target whose intent was written but whose outcome never was may still have been unlinked; the
  // operation stays resumable until a pass settles it, even when this pass was cancelled.
  if (counts.executing > 0) return 'executing';
  if (cancelled) return 'cancelled';
  if (counts.planned + counts.executing > 0) return 'executing';
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (total === 0) return 'completed';
  if (counts.refused === total) return 'refused';
  if (counts.deleted + counts['already-absent'] === total) return 'completed';
  return 'partial';
}

function auditResultOf(mode: PassMode, state: DeletionOperationState): LifecycleMutationResult {
  if (mode === 'resume') return 'resumed';
  if (state === 'completed' || state === 'refused') return state;
  return 'partial';
}

function settlePass(
  ctx: LifecycleContext,
  lease: Lease,
  mode: PassMode,
  stop: StopReason | null
): DeletionOperationState {
  const { counts, state } = inImmediateTransaction(ctx.deps.conn, () => {
    if (stop !== null) refuseRemaining(ctx, lease.operationId, stop);
    const passCounts = outcomeCounts(ctx, lease.operationId);
    const passState = stateAfterPass(passCounts, stop === 'cancelled');
    const now = ctx.deps.nowMs();
    ctx.deps.conn.run(
      `UPDATE deletion_operations SET state = ?, updated_at_ms = ?, finished_at_ms = ? WHERE operation_id = ?`,
      passState,
      now,
      TERMINAL_STATES.includes(passState) ? now : null,
      lease.operationId
    );
    releaseLease(ctx, lease);
    return { counts: passCounts, state: passState };
  });
  ctx.deps.audit.recordLifecycleMutation({
    operationKind: 'deletion',
    operationId: lease.operationId,
    counts: {
      deleted: counts.deleted,
      alreadyAbsent: counts['already-absent'],
      retained: counts.retained,
      unknown: counts.unknown,
      refused: counts.refused,
      remaining: counts.planned + counts.executing
    },
    result: auditResultOf(mode, state)
  });
  return state;
}

/** Ends a pass whose intent write failed: nothing was unlinked; the operation stays resumable. */
function abandonPass(ctx: LifecycleContext, lease: Lease): LifecycleResult<DeletionOperation> {
  releaseLease(ctx, lease);
  ctx.deps.audit.recordLifecycleMutation({
    operationKind: 'deletion',
    operationId: lease.operationId,
    counts: { remaining: pendingTargets(ctx, lease.operationId).length },
    result: 'refused'
  });
  return refuse('unavailable', 'the deletion intent could not be recorded; nothing was removed');
}

/** Whether this pass's fence is still the operation's; false once a resumed pass has taken it over. */
function ownsOperation(ctx: LifecycleContext, lease: Lease): boolean {
  const row = ctx.deps.conn.get<{ owned: number }>(
    `SELECT 1 AS owned FROM deletion_operations WHERE operation_id = ? AND fence_token = ?`,
    lease.operationId,
    lease.fence
  );
  return row !== undefined;
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function runPass(
  ctx: LifecycleContext,
  lease: Lease,
  mode: PassMode,
  signal: AbortSignal | undefined
): Promise<LifecycleResult<DeletionOperation>> {
  const rows = pendingTargets(ctx, lease.operationId);
  let stop: StopReason | null = null;
  for (const [index, row] of rows.entries()) {
    if (index > 0 && index % LEASE_RENEW_EVERY_TARGETS === 0) {
      renewLease(ctx, lease);
      await yieldToEventLoop();
    }
    if (signal?.aborted === true) {
      stop = 'cancelled';
      break;
    }
    const verdict = await removeTarget(ctx, lease, row);
    if (verdict.kind === 'intent-failed') return abandonPass(ctx, lease);
    if (verdict.kind === 'stop') {
      stop = verdict.reason;
      break;
    }
    recordOutcome(ctx, lease.operationId, row, verdict);
  }
  // Taken over: the targets and the state now belong to the pass holding the new fence.
  if (stop === 'stale-fence' && !ownsOperation(ctx, lease)) return getDeletionOperation(ctx, lease.operationId);
  settlePass(ctx, lease, mode, stop);
  return getDeletionOperation(ctx, lease.operationId);
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

function persistOperation(
  ctx: LifecycleContext,
  lease: Lease,
  previewId: string,
  targets: readonly DeletionPlanTarget[]
): void {
  const now = ctx.deps.nowMs();
  ctx.deps.conn.run(
    `INSERT INTO deletion_operations
       (operation_id, workspace_id, preview_id, state, fence_token, planned_count, created_at_ms, updated_at_ms, finished_at_ms)
     VALUES (?, ?, ?, 'executing', ?, ?, ?, ?, NULL)`,
    lease.operationId,
    workspaceIdOf(ctx),
    previewId,
    lease.fence,
    targets.length,
    now,
    now
  );
  targets.forEach((target, ordinal) => {
    ctx.deps.conn.run(
      `INSERT INTO deletion_targets (operation_id, target_ordinal, artifact_id, target_key, outcome, reason_code, updated_at_ms)
       VALUES (?, ?, ?, ?, 'planned', NULL, ?)`,
      lease.operationId,
      ordinal,
      target.artifactId,
      target.relpath,
      now
    );
  });
}

/** Gates, persists the operation and its targets under the lease, then runs the first pass. */
export async function executeDeletion(
  ctx: LifecycleContext,
  request: DeletionRequest,
  signal?: AbortSignal
): Promise<LifecycleResult<DeletionOperation>> {
  const selection: DeletionSelection = { artifactIds: request.artifactIds, retentionClass: request.retentionClass };
  const plan = planDeletion(ctx, selection);
  if (!plan.ok) return plan;
  const gate = checkMutationAuthority(ctx.previews, request, 'deletion', plan.value.basis);
  if (!gate.ok) return gate;
  const lease: Lease = { operationId: ctx.newId(), fence: ctx.newId() };
  const claimed = inImmediateTransaction(ctx.deps.conn, () => {
    if (!claimLease(ctx, lease)) return false;
    persistOperation(ctx, lease, request.previewId, plan.value.targets);
    return true;
  });
  if (!claimed) return refuse('sweep-in-progress', 'another lifecycle sweep holds the workspace lease');
  return runPass(ctx, lease, 'execute', signal);
}

/**
 * Bounded, repeatable, zero-filesystem accounting repair (`16-01`, `FR-001`):
 * heals any row where `deletion_targets.outcome` is `'deleted'` or
 * `'already-absent'` while `artifact_lifecycle.availability` is not `'deleted'`
 * (such as `'present'` or `'missing'`), preserving deletion outcomes and
 * compatibility with FR-R7-14 backup-manifest tombstone classification.
 */
export function repairDeletionAccounting(
  ctx: LifecycleContext,
  operationId?: string
): DeletionAccountingRepairResult {
  const workspaceId = workspaceIdOf(ctx);
  return inImmediateTransaction(ctx.deps.conn, () => {
    const rows =
      operationId === undefined
        ? ctx.deps.conn.all<{ artifact_id: string; lifecycle_revision: number }>(
            `SELECT DISTINCT l.artifact_id, l.lifecycle_revision
               FROM deletion_targets t
               JOIN deletion_operations o ON o.operation_id = t.operation_id
               JOIN artifact_lifecycle l ON l.artifact_id = t.artifact_id
              WHERE o.workspace_id = ?
                AND t.outcome IN ('deleted', 'already-absent')
                AND l.availability <> 'deleted'
              ORDER BY l.artifact_id ASC
              LIMIT ?`,
            workspaceId,
            SWEEP_MAX_REMOVALS_PER_PASS + 1
          )
        : ctx.deps.conn.all<{ artifact_id: string; lifecycle_revision: number }>(
            `SELECT DISTINCT l.artifact_id, l.lifecycle_revision
               FROM deletion_targets t
               JOIN deletion_operations o ON o.operation_id = t.operation_id
               JOIN artifact_lifecycle l ON l.artifact_id = t.artifact_id
              WHERE o.workspace_id = ?
                AND t.operation_id = ?
                AND t.outcome IN ('deleted', 'already-absent')
                AND l.availability <> 'deleted'
              ORDER BY l.artifact_id ASC
              LIMIT ?`,
            workspaceId,
            operationId,
            SWEEP_MAX_REMOVALS_PER_PASS + 1
          );
    const capped = rows.length > SWEEP_MAX_REMOVALS_PER_PASS;
    const batch = capped ? rows.slice(0, SWEEP_MAX_REMOVALS_PER_PASS) : rows;
    let repaired = 0;
    for (const row of batch) {
      if (ctx.records.compareAndSetAvailability(row.artifact_id, row.lifecycle_revision, 'deleted')) {
        repaired += 1;
      }
    }
    return { repaired, capped };
  });
}

/** Resumes an unfinished operation under its own id, taking over an expired lease (FR-010). */
export async function reconcileDeletionOperation(
  ctx: LifecycleContext,
  operationId: string,
  authority: MutationAuthority,
  signal?: AbortSignal
): Promise<LifecycleResult<DeletionOperation>> {
  const standing = checkStandingAuthority(authority);
  if (!standing.ok) return standing;
  if (!isOpaqueId(operationId)) return refuse('invalid-input', 'operation id is malformed');
  const current = getDeletionOperation(ctx, operationId);
  if (!current.ok) return current;
  if (TERMINAL_STATES.includes(current.value.state)) {
    repairDeletionAccounting(ctx, operationId);
    return current;
  }
  const lease: Lease = { operationId, fence: ctx.newId() };
  const claimed = inImmediateTransaction(ctx.deps.conn, () => {
    if (!claimLease(ctx, lease)) return false;
    ctx.deps.conn.run(
      `UPDATE deletion_operations SET state = 'executing', fence_token = ?, updated_at_ms = ? WHERE operation_id = ?`,
      lease.fence,
      ctx.deps.nowMs(),
      operationId
    );
    return true;
  });
  if (!claimed) return refuse('sweep-in-progress', 'another lifecycle sweep holds the workspace lease');
  repairDeletionAccounting(ctx, operationId);
  return runPass(ctx, lease, 'resume', signal);
}

interface OperationRow {
  readonly operation_id: string;
  readonly state: DeletionOperationState;
  readonly planned_count: number;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly finished_at_ms: number | null;
}

export function getDeletionOperation(ctx: LifecycleContext, operationId: string): LifecycleResult<DeletionOperation> {
  if (!isOpaqueId(operationId)) return refuse('invalid-input', 'operation id is malformed');
  const row = ctx.deps.conn.get<OperationRow>(
    `SELECT operation_id, state, planned_count, created_at_ms, updated_at_ms, finished_at_ms
     FROM deletion_operations WHERE operation_id = ? AND workspace_id = ?`,
    operationId,
    workspaceIdOf(ctx)
  );
  if (row === undefined) return refuse('not-found', 'no deletion operation has that id');
  const targets = ctx.deps.conn.all<{
    target_ordinal: number;
    artifact_id: string | null;
    outcome: DeletionTargetOutcomeKind;
    reason_code: string | null;
  }>(
    `SELECT target_ordinal, artifact_id, outcome, reason_code FROM deletion_targets
     WHERE operation_id = ? ORDER BY target_ordinal`,
    operationId
  );
  return ok({
    operationId: row.operation_id,
    state: row.state,
    plannedCount: row.planned_count,
    targets: targets.map((target) => ({
      ordinal: target.target_ordinal,
      artifactId: target.artifact_id,
      outcome: target.outcome,
      reasonCode: target.reason_code
    })),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    finishedAtMs: row.finished_at_ms
  });
}
