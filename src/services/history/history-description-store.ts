// ---------------------------------------------------------------------------
// FR-R3-010 (T405) — where a completed run's full description lives.
//
// It used to live in the memento, as `HistoryEntry.originalDescription`. The
// field is operator-authored and bounded only by `MAX_DESCRIPTION_LENGTH`
// (32,000 characters), and the array holding it is rewritten whole on every
// completion, so the cost of recording that a run finished was a function of
// the *content* of the 50 runs before it. At the cap that is roughly 1.6 MB of
// serialization per completed run, for a change that adds one row.
//
// The text is not evidence of what a run did — the audit log is that — it is
// the input the run was given, kept so a rerun can replay it byte-identically
// (the FR-029 requirement, unchanged). What changed is only where it is kept.
//
// Every operation here is best-effort. A run whose description file could not
// be written still gets its history entry; the rerun path then reports the
// description as unavailable exactly as it already does for an entry written
// before feature 013 Wave 6. A history record is worth more than the replay
// convenience attached to it, so nothing in this module can fail a run.
// ---------------------------------------------------------------------------

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import type { SanitizedLogger } from '../../lib/logger';
import {
  resolveContainedForWrite,
  resolveContainedLink,
  resolveContainedTarget
} from '../../lib/path-containment';

/** Directory under `.schegent/`, relative to the workspace root. */
export const HISTORY_DESCRIPTION_DIR = path.join('.schegent', 'history');

/**
 * The run ids this store will build a path from.
 *
 * Run ids are host-minted, so in practice they are already this shape. The
 * check is here for the read path: a `descriptionRef` arrives from persisted
 * state, which an operator can edit, and a ref naming `../../etc/passwd` must
 * be refused *before* it becomes a path rather than after. The containment
 * oracle below is the second half of the same guard — this one bounds the
 * character set, that one bounds where the result can land.
 */
const SAFE_RUN_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The reference stored on a history entry for `runId`, or `null` when the run
 * id is not a shape this store will address.
 *
 * Workspace-relative and POSIX-separated, so nothing that crosses IPC or lands
 * in persisted state carries a machine-specific absolute path. It is fully
 * derivable from the run id, which is deliberate: the reference is what the
 * entry *claims*, and a resolver that recomputes it from the run id can tell a
 * tampered ref from an honest one by comparing the two.
 */
export function historyDescriptionRef(runId: string): string | null {
  return SAFE_RUN_ID.test(runId) ? `.schegent/history/${runId}.txt` : null;
}

export interface HistoryDescriptionStoreDeps {
  readonly workspaceRoot: string;
  readonly logger: Pick<SanitizedLogger, 'warn'>;
}

export class HistoryDescriptionStore {
  private readonly workspaceRoot: string;
  private readonly logger: Pick<SanitizedLogger, 'warn'>;

  constructor(deps: HistoryDescriptionStoreDeps) {
    this.workspaceRoot = deps.workspaceRoot;
    this.logger = deps.logger;
  }

  /**
   * Write `text` for `runId` and return the reference to store on the entry.
   *
   * `null` means the caller writes an entry without a reference. It is not an
   * error path the caller has to handle differently — an entry with no
   * reference is the same shape as a legacy entry with no
   * `originalDescription`, and the rerun path already knows what to do with it.
   */
  public async write(runId: string, text: string): Promise<string | null> {
    const ref = historyDescriptionRef(runId);
    if (ref === null) {
      this.logger.warn(`history-description: refusing to address run id of unexpected shape`);
      return null;
    }
    const absolute = await this.containedPathFor(ref, 'write');
    if (absolute === null) return null;
    try {
      await fs.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
      // 0600 rather than the default: the text is operator-authored input to a
      // run and sits beside the session evidence, which is already 0600. A
      // description can name internal systems, ticket numbers, or hostnames.
      await fs.writeFile(absolute, text, { encoding: 'utf8', mode: 0o600 });
      return ref;
    } catch (err) {
      this.logger.warn(`history-description: write failed (${(err as Error).message})`);
      return null;
    }
  }

  /**
   * The full description an entry references, or `null` when it cannot be read.
   *
   * `null` covers every unreachable case with one answer — no reference, a
   * reference that resolves outside the workspace, a file the retention sweep
   * or an operator removed, an unreadable file. The caller's next step is the
   * same for all of them, and distinguishing them would mean reporting a
   * filesystem condition to an operator who asked to rerun a task.
   */
  public async read(ref: string): Promise<string | null> {
    const absolute = await this.containedPathFor(ref, 'read');
    if (absolute === null) return null;
    try {
      return await fs.readFile(absolute, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Remove the file for `runId`, if it is there.
   *
   * Called when the per-queue cap evicts an entry, so the on-disk set stays
   * bounded by the same cap as the memento rather than growing for the life of
   * the workspace. Silent on every failure including absence: this is cleanup
   * after a record that no longer exists, and there is no one left to tell.
   */
  public async remove(runId: string): Promise<void> {
    const ref = historyDescriptionRef(runId);
    if (ref === null) return;
    const contained = await this.containedPathFor(ref, 'remove');
    if (contained === null) return;
    try {
      await fs.rm(contained, { force: true });
    } catch {
      // Best-effort. An orphaned description file is inert.
    }
  }

  /**
   * Resolve a stored reference to a proven-contained absolute path, or refuse.
   *
   * Two conditions, and both must hold. The reference must sit under
   * `.schegent/history/`, which is what stops a ref pointing at the audit log
   * or at a source file, and it must resolve inside the workspace. Neither
   * subsumes the other: containment alone would admit any file in the
   * repository, and the prefix check alone would admit `.schegent/history/../..`.
   *
   * The `intent` picks the oracle entry point, because the kernel treats the
   * final component differently per operation and one check cannot be right for
   * all three. `remove` uses the link form — `fs.rm` on a file unlinks the entry
   * without following it, so resolving the leaf would refuse the legitimate
   * cleanup of a symlink someone dropped in the directory. `write` uses the
   * write form, which resolves an existing leaf and so refuses writing the
   * description *through* a planted symlink, while still admitting the first
   * write to a path that is not there yet. `read` follows the leaf, so it takes
   * the target form.
   *
   * A refusal is `null`, which every caller already treats as "not available" —
   * a stored ref is operator-editable state, and the guard has to answer before
   * the path is used rather than after.
   */
  private async containedPathFor(
    ref: string,
    intent: 'read' | 'write' | 'remove'
  ): Promise<string | null> {
    const normalized = path.normalize(ref);
    if (path.isAbsolute(normalized)) return null;
    if (!normalized.startsWith(`${HISTORY_DESCRIPTION_DIR}${path.sep}`)) return null;
    const candidate = path.resolve(this.workspaceRoot, normalized);
    const roots = [this.workspaceRoot];
    const verdict =
      intent === 'remove'
        ? await resolveContainedLink(candidate, roots)
        : intent === 'write'
          ? await resolveContainedForWrite(candidate, roots)
          : await resolveContainedTarget(candidate, roots);
    return verdict.outcome === 'contained' ? verdict.resolved : null;
  }
}
