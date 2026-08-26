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
import { isRunId } from '../contracts/run-id';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { resolveContainedLink } from '../lib/path-containment';

export type DeleteOutcome =
  | { readonly outcome: 'refused'; readonly reason: 'active-writer'; readonly artifact: string }
  | { readonly outcome: 'refused'; readonly reason: 'no-evidence'; readonly artifact: string }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-run-id'; readonly artifact: string }
  | {
      readonly outcome: 'completed';
      readonly removed: readonly string[];
      readonly retained: readonly { readonly path: string; readonly reason: string }[];
    };


/** Anything under the in-flight spool is, by definition, being written. */
const ACTIVE_MARKERS = [/(^|\/)\.pending(\/|$)/, /\.lock$/] as const;

export interface DeleteDeps {
  /**
   * Whether a Run is executing. Injected rather than imported so the refusal can
   * be exercised without standing up a controller — the same shape every other
   * decision in this evidence path uses.
   */
  readonly isRunActive: (runId: string) => boolean;
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

  const targets: string[] = [];

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
        if (mine) targets.push(relative);
        continue;
      }

      if (mine) targets.push(relative);
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
  const retained: { path: string; reason: string }[] = [];
  for (const relative of targets) {
    const absolute = path.join(workspaceRoot, relative);
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
        path: relative,
        reason: verdict.outcome === 'refused' ? verdict.reason : verdict.outcome
      });
      continue;
    }
    try {
      await fsp.rm(verdict.resolved, { force: false });
      removed.push(relative);
    } catch (error) {
      retained.push({ path: relative, reason: describe(error) });
    }
  }
  // Both halves, always. Best-effort silence is what this replaces.
  return { outcome: 'completed', removed, retained };
}

function describe(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : 'unknown-error';
}
