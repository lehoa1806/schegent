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
import { historyErrorCode } from './error-code';
import { openWithinRoot, openWithinRootByPath } from '../../lib/safe-open';
import {
  resolveContainedForWrite,
  resolveContainedLink,
  resolveContainedTarget
} from '../../lib/path-containment';

/** Directory under `.schegent/`, relative to the workspace root. */
export const HISTORY_DESCRIPTION_DIR = path.join('.schegent', 'history');

/**
 * FR-R3-111 (FR-115) — how old an unreferenced description must be before it is swept.
 *
 * A description is written BEFORE its history entry is persisted, so a file with no referencing
 * entry may simply be mid-write. Sweeping on absence alone would delete the description of the
 * run that is starting right now. Twenty-four hours is far longer than any write window and far
 * shorter than "forever", which is what these files got before this existed.
 */
export const HISTORY_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1_000;

/**
 * FR-R3-111 (FR-117) — how many orphans one activation may remove.
 *
 * Activation walks are bounded (`FR-R3-082`). A directory that somehow accumulated thousands of
 * orphans is drained over several sessions rather than stalling one, and the count is reported so
 * a backlog is visible rather than merely slow.
 */
export const HISTORY_SWEEP_MAX_REMOVALS = 200;

/**
 * The run id a description filename encodes, or `null` if the name is not one of ours.
 *
 * The inverse of `historyDescriptionRef`, and deliberately as strict: a file this store did not
 * write is left alone. A sweep that deleted unrecognised files would be a sweep that could delete
 * anything someone put in that directory.
 */
export function runIdFromDescriptionFile(fileName: string): string | null {
  if (!fileName.endsWith('.txt')) return null;
  const runId = fileName.slice(0, -'.txt'.length);
  return SAFE_RUN_ID.test(runId) ? runId : null;
}

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

/**
 * FR-R3-080 (T1063) — the same reference, as the segments the checked walk
 * walks.
 *
 * Derived from the ref rather than composed independently, so the path an
 * operator is shown and the one actually opened cannot diverge — the same rule
 * `raw-transcript-writer.ts` keeps between `filePathFor` and `segmentsFor`.
 */
function refSegments(ref: string): readonly string[] {
  return ref.split('/');
}

export interface HistoryDescriptionStoreDeps {
  readonly workspaceRoot: string;
  readonly logger: Pick<SanitizedLogger, 'warn'>;
}

/**
 * FR-R3-071 — what a sidecar read established. `missing` is a valid contained
 * path whose file is not there (swept, or never written); `refused` is a
 * reference outside `.schegent/history/` or the workspace; `unreadable` is any
 * other I/O failure, carrying its code and never a message.
 */
export type HistoryDescriptionReadOutcome =
  | { readonly outcome: 'read'; readonly text: string }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'unreadable'; readonly code: string }
  | { readonly outcome: 'refused' };

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
    // FR-R3-080 (T1063) — one open that walks and refuses, replacing a cached
    // containment verdict followed by `fs.mkdir` + `fs.writeFile` on the same
    // composed pathname.
    //
    // `SEC-06`. The verdict was true when taken and the path was re-resolved by
    // name afterwards, so a workspace writer that swapped a component in between
    // redirected the write. What travels here is operator-authored description
    // text, which the file mode below already treats as sensitive.
    //
    // The reference is still validated first — `historyDescriptionRef` refuses a
    // run id of unexpected shape BEFORE it becomes a path, which is a different
    // and earlier check than containment, and neither subsumes the other.
    //
    // What is NOT kept on this path is the old `containedPathFor(ref, 'write')`
    // verdict. It was the first half of the check-then-act pair, and leaving it
    // in front of the walk would make it the deciding check again: it refuses
    // the same arrangements the walk refuses, one `realpath` earlier and one
    // resolution removed from the write. The two properties it enforced are both
    // still enforced — "under `.schegent/history/`" is structural here, because
    // the segments are derived from a ref this module minted from a
    // `SAFE_RUN_ID`, and "inside the workspace" is what the walk answers, at the
    // point of effect instead of before it. The READ and REMOVE paths keep it,
    // because their refs arrive from persisted state an operator can edit.
    try {
      // 0600 rather than the default: the text is operator-authored input to a
      // run and sits beside the session evidence, which is already 0600. A
      // description can name internal systems, ticket numbers, or hostnames.
      const opened = await openWithinRoot(this.workspaceRoot, refSegments(ref), {
        flags: 'w',
        createDirs: true,
        dirMode: 0o700,
        fileMode: 0o600
      });
      if (opened.outcome === 'refused') {
        // The refusal class AND the errno when there is one. `io-failed` alone
        // tells an operator nothing they can act on, and the errno is the half
        // that distinguishes "the parent is a file" from "the disk is gone".
        // Never the caught message: Node's quotes the absolute path it tried,
        // and FR-047 rules that out of a log line as firmly as out of a rendered
        // one — `ref` names the same file relative to a root the reader knows.
        const detail =
          opened.errno === undefined || opened.errno === 'none'
            ? opened.reason
            : `${opened.reason} ${opened.errno}`;
        this.logger.warn(`history-description: write refused (${detail}) ref=${ref}`);
        return null;
      }
      try {
        await opened.handle.write(text, null, 'utf8');
      } finally {
        await opened.handle.close().catch(() => undefined);
      }
      return ref;
    } catch (err) {
      // The code and the workspace-relative reference, never the caught
      // message: an fs failure here reports the absolute path it was addressing,
      // and FR-047 rules out the workspace root in a log line as firmly as in a
      // rendered one. Nothing diagnostic is lost — `ref` names the same file
      // relative to a root the reader already knows.
      this.logger.warn(
        `history-description: write failed (${historyErrorCode(err)}) ref=${ref}`
      );
      return null;
    }
  }

  /**
   * The full description an entry references, as a typed outcome.
   *
   * FR-R3-071 (feature 152) — the nullable this replaces collapsed every
   * unreachable case into one answer, which was defensible while nothing
   * called it and wrong the moment something did: the resolver has to tell an
   * operator-actionable absence (the retention sweep removed the file — a sweep that FR-R3-111
   * finally made exist; see `reconcile()` below, and note that until 2026-08-26 this sentence
   * cited a sweep covering only `.schegent/sessions/`) from a
   * refused reference (outside `.schegent/history/` or the workspace) and from
   * an I/O failure, because the replay commands word each differently. The
   * codes stay codes — never the caught message, which names the absolute path.
   */
  public async read(ref: string): Promise<HistoryDescriptionReadOutcome> {
    // The LINK form ('remove' picks that oracle entry point), not the target
    // form the old nullable used: the target form reports an absent file as
    // the same null as an escaping ref, and `missing` is exactly the arm the
    // resolver needs told apart. What the target form bought — refusing a leaf
    // replaced with a link out of the workspace — the safe walk below keeps:
    // its `O_NOFOLLOW` open refuses a symlinked leaf as `symlink-leaf`.
    const absolute = await this.containedPathFor(ref, 'remove');
    if (absolute === null) return { outcome: 'refused' };
    const opened = await openWithinRootByPath(this.workspaceRoot, absolute, { flags: 'r' });
    if (opened.outcome === 'refused') {
      if (opened.errno === 'ENOENT' || opened.errno === 'ENOTDIR') return { outcome: 'missing' };
      if (opened.reason === 'io-failed') return { outcome: 'unreadable', code: opened.errno };
      return { outcome: 'refused' };
    }
    try {
      return { outcome: 'read', text: await opened.handle.readFile({ encoding: 'utf8' }) };
    } catch (err) {
      return { outcome: 'unreadable', code: historyErrorCode(err) };
    } finally {
      await opened.handle.close().catch(() => undefined);
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
  /**
   * Reconcile the description directory against the entries that reference it.
   *
   * FR-R3-111 (FR-115, FR-116, FR-117) — the sweep this store's own `read()` docstring already
   * cited.
   *
   * WHAT WAS WRONG. `read()` distinguishes "the retention sweep removed the file" from a refused
   * reference and an I/O failure, and that distinction was the right one to draw — but **no sweep
   * covered this directory**. `SessionArtifactRetentionService` walks `.schegent/sessions/`, not
   * `.schegent/history/`. Eviction-edge removal exists in `history-recorder.ts` and is
   * best-effort with swallowed failures, so any removal that failed left a file nothing would
   * ever look at again. Each orphan is up to 32,000 characters of operator-authored text.
   *
   * BOUNDED, because activation is bounded (`FR-R3-082`). Three properties make this safe to run
   * on the activation path:
   *
   *   * one `readdir`, never a recursive walk — the directory is flat by construction;
   *   * a hard cap on removals per activation, so a directory that somehow accumulated thousands
   *     of orphans is drained over several sessions rather than stalling one;
   *   * a GRACE PERIOD, which is what separates an orphan from a young file. A description is
   *     written before its entry is persisted, so a file with no referencing entry may simply be
   *     mid-write. Sweeping on absence alone would delete the description of the run currently
   *     starting.
   *
   * Returns what it did, so the count can reach the evidence-health surface. A sweep that reports
   * nothing is indistinguishable from one that did not run.
   */
  public async reconcile(args: {
    readonly referenced: ReadonlySet<string>;
    readonly nowMs: number;
    readonly graceMs?: number;
    readonly maxRemovals?: number;
  }): Promise<{ readonly examined: number; readonly swept: number; readonly skippedYoung: number }> {
    const graceMs = args.graceMs ?? HISTORY_ORPHAN_GRACE_MS;
    const maxRemovals = args.maxRemovals ?? HISTORY_SWEEP_MAX_REMOVALS;
    let examined = 0;
    let swept = 0;
    let skippedYoung = 0;

    let names: readonly string[];
    try {
      names = await this.listDescriptionFiles();
    } catch {
      // An unreadable directory is not a failure worth surfacing: the common cause is that it
      // does not exist yet, which is every fresh workspace. `read()` already reports an absent
      // file as its own outcome.
      return { examined: 0, swept: 0, skippedYoung: 0 };
    }

    for (const name of names) {
      if (swept >= maxRemovals) break;
      examined += 1;
      const runId = runIdFromDescriptionFile(name);
      if (runId === null) continue;
      if (args.referenced.has(runId)) continue;
      const ageMs = await this.ageOfDescriptionFile(name, args.nowMs);
      if (ageMs === null) continue;
      if (ageMs < graceMs) {
        // Young and unreferenced is the normal shape of a description being written right now.
        skippedYoung += 1;
        continue;
      }
      await this.remove(runId);
      swept += 1;
    }
    return { examined, swept, skippedYoung };
  }

  /** The flat directory listing. One `readdir`, never a recursive walk. */
  private async listDescriptionFiles(): Promise<readonly string[]> {
    const dir = path.join(this.workspaceRoot, HISTORY_DESCRIPTION_DIR);
    return await fs.readdir(dir);
  }

  /**
   * How old a description file is, or `null` when it cannot be told.
   *
   * `null` rather than a guess: a file whose age is unknown is never swept. `mtime` rather than
   * `birthtime`, which is not reliable across platforms and filesystems — and mtime is the
   * conservative choice here, since a rewritten file reads as young and a young file is kept.
   */
  private async ageOfDescriptionFile(fileName: string, nowMs: number): Promise<number | null> {
    try {
      const stat = await fs.stat(path.join(this.workspaceRoot, HISTORY_DESCRIPTION_DIR, fileName));
      return nowMs - stat.mtimeMs;
    } catch {
      return null;
    }
  }

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
