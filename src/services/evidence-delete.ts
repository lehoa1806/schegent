// FR-R3-085 (PRIV-01) — remove one Run's evidence, and say what happened.
//
// TWO RULES, BOTH FROM THE ITEM.
//
//   "Delete on a run with an active writer REFUSES rather than racing, and says
//   so." Racing a live writer produces a half-deleted Run and a file that
//   reappears a second later; refusing produces an operator who knows to stop
//   the Run first. The refusal names the artifact, because "something is still
//   being written" is not actionable.
//
//   "One command that removes a run's evidence and reports what it removed and
//   what it could not, rather than best-effort silence." A partial delete that
//   reports success is how an operator comes to believe evidence is gone when it
//   is not — which, for a privacy control, is the worst available outcome.
//
// FR-R4-F04 (contract D, FR-010 to FR-013) — three things this module now does that it did not:
//
//   * REMOVES DIRECTORIES. The walk always listed a Run's directories as targets, and removal used a
//     non-recursive `rm`, which refuses a directory (ERR_EISDIR): every Run's diagnostics tree was
//     reported "could not be removed" and stayed. Targets are in walk order, children before their
//     directory, so each directory is emptied first and then removed with `rmdir`, never recursively.
//   * REMOVES THE RUN'S PRIVATE CHECKPOINT. The Run's recovery checkpoint holds unredacted Git diffs in
//     the extension's private storage, outside the workspace, and no deletion reached it. It is removed
//     after the workspace evidence, by the same contained steps, and only when nothing refused.
//   * KEEPS RUN HISTORY, AND SAYS SO. `.schegent/history/<runId>.txt` is the Run's full description, kept
//     so the Run stays listed, and it is reported as retained with a reason of its own. The stores a Run's
//     deletion never touches are listed on every outcome, so "deleted" is never read as "gone from the
//     machine".
import { isRunId } from '../contracts/run-id';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { resolveContainedLink } from '../lib/path-containment';
import { RUN_CHECKPOINT_DIRECTORY, safeRunSegment } from './run-checkpoint-paths';

/** Why one entry was not removed. Bounded, and safe to show an operator. */
export type RetainedReason =
  /** A directory that still holds an entry. */
  | 'not-empty'
  /** The containment oracle refused it. */
  | 'not-contained'
  | 'resolve-failed'
  | 'absent'
  /** A checkpoint directory that is a link; never followed. */
  | 'symlink'
  /** `.schegent/history/<runId>.txt`, kept on purpose. */
  | 'run-history'
  /** Any other failure, by its code. */
  | `errno:${string}`;

export interface RetainedItem {
  /** Workspace-relative, or `<private storage>/checkpoints/<id>` for the checkpoint. Never absolute. */
  readonly path: string;
  readonly reason: RetainedReason;
}

/** A store a Run's deletion never touches, named so the result cannot read as "gone from the machine". */
export type KeptStore =
  | { readonly store: 'audit-log' | 'runtime-log' | 'metrics-rollup' | 'run-history' }
  | { readonly store: 'legacy-transport'; readonly agesOutBy: string | null };

export type DeleteOutcome =
  | { readonly outcome: 'refused'; readonly reason: 'active-writer'; readonly artifact: string }
  | { readonly outcome: 'refused'; readonly reason: 'no-evidence'; readonly artifact: string }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-run-id'; readonly artifact: string }
  | {
      readonly outcome: 'completed';
      readonly removed: readonly string[];
      readonly retained: readonly RetainedItem[];
      /** `retained` always comes with a `RetainedItem` saying why. */
      readonly checkpoint: 'removed' | 'absent' | 'retained';
      readonly keptStores: readonly KeptStore[];
    };

/** What the checkpoint is called in anything an operator reads: never its absolute location. */
const PRIVATE_STORAGE_LABEL = '<private storage>';

/** The directory under `.schegent/` that holds each Run's full history description. */
const HISTORY_PREFIX = '.schegent/history/';

/** Anything under the in-flight spool is, by definition, being written. */
const ACTIVE_MARKERS = [/(^|\/)\.pending(\/|$)/, /\.lock$/] as const;

export interface DeleteDeps {
  /**
   * Whether a Run is executing. Injected rather than imported so the refusal can
   * be exercised without standing up a controller — the same shape every other
   * decision in this evidence path uses.
   */
  readonly isRunActive: (runId: string) => boolean;
  /**
   * FR-R4-F04 (D4) — the extension's private storage, whose `checkpoints/` directory holds each Run's
   * recovery checkpoint. Absent means the caller has none to offer, and the checkpoint step reports
   * `absent`.
   */
  readonly checkpointRoot?: string;
  /**
   * FR-R4-F04 (D5) — when the legacy shared transport generations age out, or `null` when none exists.
   * Asked of the transport router, which measured them; a probe that throws reads as `null`.
   */
  readonly legacyAgesOutBy?: () => string | null;
}

interface Target {
  readonly relative: string;
  readonly isDirectory: boolean;
}

export async function deleteRunEvidence(
  workspaceRoot: string,
  runId: string,
  deps: DeleteDeps
): Promise<DeleteOutcome> {
  if (!isRunId(runId)) {
    return {
      outcome: 'refused',
      reason: 'invalid-run-id',
      artifact: 'run id is not a UUID; refusing rather than matching evidence by substring'
    };
  }
  // The cheapest refusal first: a Run the controller still owns is not a
  // filesystem question at all.
  if (deps.isRunActive(runId)) {
    return { outcome: 'refused', reason: 'active-writer', artifact: `run ${runId} is still executing` };
  }

  const targets: Target[] = [];
  /** The Run's history description, which is never a target (D2) and is reported instead. */
  const history: string[] = [];

  /**
   * Walk `.schegent`, collecting this Run's artifacts and stopping at the first
   * sign that something still holds one open.
   *
   * Two shapes matter and an earlier draft got both wrong:
   *
   *   * The spool directory `.pending` does not itself carry a run id, so a walk
   *     that skips directories whose NAME lacks the id never descends into it —
   *     and never sees the mid-write file that is the whole reason to refuse.
   *     Non-matching directories are always descended into; only LEAVES are
   *     matched against the run id.
   *   * A directory whose name carries the run id is an artifact in its own
   *     right. Descending into it and never listing it left it behind while the
   *     result reported success.
   */
  const walk = async (relativeDir: string): Promise<string | null> => {
    const absolute = path.join(workspaceRoot, relativeDir);
    let entries;
    try {
      entries = await fsp.readdir(absolute, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.posix.join(relativeDir, entry.name);
      const mine = relative.includes(runId);

      // An active marker naming this Run means something holds it open. Refuse
      // and name it: "something is still being written" is not actionable.
      if (mine && ACTIVE_MARKERS.some((marker) => marker.test(relative))) return relative;

      if (entry.isDirectory()) {
        // Descend regardless of the directory's own name — the spool is the case
        // this exists for. A run-matching directory is ALSO a target, so it is
        // not silently left behind once emptied.
        const blocked = await walk(relative);
        if (blocked !== null) return blocked;
        if (mine) targets.push({ relative, isDirectory: true });
        continue;
      }

      if (mine && relative.startsWith(HISTORY_PREFIX)) history.push(relative);
      else if (mine) targets.push({ relative, isDirectory: false });
    }
    return null;
  };

  const blocked = await walk('.schegent');
  if (blocked !== null) {
    return { outcome: 'refused', reason: 'active-writer', artifact: blocked };
  }
  if (targets.length === 0) {
    return { outcome: 'refused', reason: 'no-evidence', artifact: `no evidence found for run ${runId}` };
  }

  const removed: string[] = [];
  const retained: RetainedItem[] = [];
  for (const target of targets) {
    const absolute = path.join(workspaceRoot, target.relative);
    // Containment before removal, every time, through the shared oracle — and
    // the removal acts on the RESOLVED path the oracle returned, not on the name
    // that was judged. A verdict about a name followed by an operation on that
    // name is the SEC-03 shape: a concurrent writer swaps a parent component in
    // between and the operation lands outside the root the verdict was about.
    //
    // `resolveContainedLink` is the right form here: `rm` acts on the directory
    // entry and does not follow it, so resolving the leaf would refuse a removal
    // that never touches the link's target.
    const verdict = await resolveContainedLink(absolute, [workspaceRoot]);
    if (verdict.outcome !== 'contained') {
      retained.push({
        path: target.relative,
        reason: verdict.outcome === 'refused' ? verdict.reason : verdict.outcome
      });
      continue;
    }
    try {
      // A directory is removed with `rmdir`, never recursively: the walk lists its children first, so
      // by now it is empty, and one that is not (a child was retained, or something arrived) says so.
      if (target.isDirectory) await fsp.rmdir(verdict.resolved);
      else await fsp.rm(verdict.resolved, { force: false });
      removed.push(target.relative);
    } catch (error) {
      retained.push({ path: target.relative, reason: retainedReason(error) });
    }
  }
  for (const relative of history) retained.push({ path: relative, reason: 'run-history' });

  const checkpoint = await removeCheckpoint(deps.checkpointRoot, runId);
  removed.push(...checkpoint.removed);
  retained.push(...checkpoint.retained);

  // Both halves, always. Best-effort silence is what this replaces.
  return {
    outcome: 'completed',
    removed,
    retained,
    checkpoint: checkpoint.status,
    keptStores: keptStores(deps)
  };
}

/** The stores this deletion never touches (D5). The legacy transport is listed exactly when one exists. */
function keptStores(deps: DeleteDeps): readonly KeptStore[] {
  const kept: KeptStore[] = [
    { store: 'audit-log' },
    { store: 'runtime-log' },
    { store: 'metrics-rollup' },
    { store: 'run-history' }
  ];
  let agesOutBy: string | null = null;
  try {
    agesOutBy = deps.legacyAgesOutBy?.() ?? null;
  } catch {
    // A probe that cannot answer is "none exists": the list must never be the reason a deletion fails.
  }
  if (agesOutBy !== null) kept.push({ store: 'legacy-transport', agesOutBy });
  return kept;
}

interface CheckpointStep {
  readonly status: 'removed' | 'absent' | 'retained';
  readonly removed: readonly string[];
  readonly retained: readonly RetainedItem[];
}

const errnoOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
};

/**
 * D4 — remove one Run's checkpoint under private storage, after the workspace evidence. It looks at the
 * directory without following it (a link is retained as `symlink` and never entered), proves each entry
 * contained in the `checkpoints/` directory before acting on its resolved path, empties the directory,
 * then removes it. Any failure retains that entry with its reason and makes the whole step `retained`.
 */
async function removeCheckpoint(storageRoot: string | undefined, runId: string): Promise<CheckpointStep> {
  if (storageRoot === undefined) return { status: 'absent', removed: [], retained: [] };
  const checkpointsRoot = path.join(storageRoot, RUN_CHECKPOINT_DIRECTORY);
  const segment = safeRunSegment(runId);
  const directory = path.join(checkpointsRoot, segment);
  const display = `${PRIVATE_STORAGE_LABEL}/${RUN_CHECKPOINT_DIRECTORY}/${segment}`;

  let isLink = false;
  try {
    isLink = (await fsp.lstat(directory)).isSymbolicLink();
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(errnoOf(error))) return { status: 'absent', removed: [], retained: [] };
    return { status: 'retained', removed: [], retained: [{ path: display, reason: retainedReason(error) }] };
  }
  if (isLink) return { status: 'retained', removed: [], retained: [{ path: display, reason: 'symlink' }] };

  const verdict = await resolveContainedLink(directory, [checkpointsRoot]);
  if (verdict.outcome === 'absent') return { status: 'absent', removed: [], retained: [] };
  if (verdict.outcome === 'refused') {
    return { status: 'retained', removed: [], retained: [{ path: display, reason: verdict.reason }] };
  }

  const retained: RetainedItem[] = [];
  const removedDirectory = await removeTree(verdict.resolved, checkpointsRoot, display, retained);
  return {
    status: retained.length === 0 ? 'removed' : 'retained',
    removed: removedDirectory ? [display] : [],
    retained
  };
}

/** Empty `absolute`, then remove it. `true` when the directory itself is gone. */
async function removeTree(
  absolute: string,
  root: string,
  display: string,
  retained: RetainedItem[]
): Promise<boolean> {
  let entries;
  try {
    entries = await fsp.readdir(absolute, { withFileTypes: true });
  } catch (error) {
    retained.push({ path: display, reason: retainedReason(error) });
    return false;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const childDisplay = `${display}/${entry.name}`;
    const verdict = await resolveContainedLink(path.join(absolute, entry.name), [root]);
    if (verdict.outcome !== 'contained') {
      retained.push({ path: childDisplay, reason: verdict.outcome === 'refused' ? verdict.reason : verdict.outcome });
      continue;
    }
    // A link is a leaf here: `isDirectory()` is false for one, and `rm` removes the link without
    // touching what it points at.
    if (entry.isDirectory()) {
      await removeTree(verdict.resolved, root, childDisplay, retained);
      continue;
    }
    try {
      await fsp.rm(verdict.resolved, { force: false });
    } catch (error) {
      retained.push({ path: childDisplay, reason: retainedReason(error) });
    }
  }
  try {
    await fsp.rmdir(absolute);
    return true;
  } catch (error) {
    retained.push({ path: display, reason: retainedReason(error) });
    return false;
  }
}

/** `not-empty` for a directory that still holds an entry, otherwise the errno code, bounded. */
function retainedReason(error: unknown): RetainedReason {
  const code = errnoOf(error);
  if (code === 'ENOTEMPTY' || code === 'EEXIST') return 'not-empty';
  return /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? `errno:${code}` : 'errno:unknown';
}
