import * as path from 'node:path';

/**
 * FR-R3-004 — attribution of working-tree changes to one Run.
 *
 * FR-R3-062 — the cited decision record
 * (`docs/architecture/checkpoint-attribution-decision.md`) does not exist and did
 * not when this comment was written. Retargeted rather than restored: the
 * reasoning is already stated below in full, so a page whose only purpose is to
 * be the destination of this link would add a maintenance burden and no
 * information. See `docs/operations/recovery-checkpoints.md` for the operator
 * view of checkpoints.
 * The short version: a checkpoint is a diff of one shared working tree, so a
 * patch is only attributable if something knows who wrote what. Two sources are
 * available and this ledger uses both, in different roles.
 *
 * FR-R3-124 (2026-08-27) — this docblock used to say "this project forbids
 * `git worktree`". The flat ban is gone: `AGENTS.md` now permits it narrowly, for
 * Schegent-provisioned per-Run execution roots only, and
 * `docs/architecture/run-isolation-decision.md` chose that as the shape of
 * execution isolation. **The mechanism does not exist** — §9 of that record gates
 * building it — so everything below is unchanged and remains the operative
 * behaviour. When it does exist, §8b Q1 is the position this file inherits: a
 * Run whose worktree is its own takes the cap-1 path and this ledger is not
 * consulted for its checkpoint, moving to make merge-back reviewable instead.
 *
 * **The declaration is the attribution source.** Each phase's audit record names
 * the files it created, modified, and deleted, and those paths — canonicalised
 * against the workspace root — are the Run's claim on the tree. That is the
 * mechanism FR-R3-004 names: "scope the diff to the paths one Run touched,
 * derived from the run's own audit record".
 *
 * **The observation is the completeness check.** A diff of the whole tree is read
 * at every window edge, and the checkpoint seam requires every section it finds
 * to be claimed by exactly one Run, or to have been dirty before this host
 * looked. A section nobody claims is a hole in the declaration, and the answer is
 * a decline rather than a patch that quietly omits it.
 *
 * Observation alone was tried first and cannot work: under real concurrency the
 * phase windows of two Runs overlap almost entirely, so a change seen inside a
 * window belongs to any of the Runs whose window was open, and every section
 * becomes contested. Declaration alone would trust an operator-influenced file to
 * be complete. Together they degrade to a decline whenever either is unusable,
 * which is the outcome the checkpoint hard rule asks for.
 */

/**
 * One file's worth of `git diff` output: everything from a `diff --git` header
 * line up to the next one.
 *
 * `key` is the header line verbatim and is what identifies a section for
 * splitting and rejoining: git quotes paths with C-style escapes when they
 * contain unusual bytes and renames put two paths on one header, so parsing and
 * re-emitting a path is a round trip that can silently lose a file.
 *
 * `path` is the best-effort display path, and it is what ownership is decided on,
 * because a declaration names a path and not a header line. The two jobs are
 * deliberately separate: a header this function cannot reduce to a plain path
 * yields a `path` no declaration will match, so the section reads as unclaimed
 * and the checkpoint declines. That is the safe direction — the failure of the
 * best-effort half is a refusal, never a misattribution.
 */
export interface DiffSection {
  readonly key: string;
  readonly path: string;
  readonly body: string;
}

const HEADER_PREFIX = 'diff --git ';

/**
 * An audit record's own account of what a phase wrote.
 *
 * `null` in {@link RunMutationLedger.observeAfterPhase} is not the same as an
 * empty list: an empty list is a phase that says it wrote nothing, while `null`
 * is a phase that said nothing at all — a malformed invocation, a crash, or a
 * cancellation. The first is usable evidence and the second is a hole.
 */
export interface PhaseMutationReport {
  /** `files_created` + `files_modified` + `files_deleted`, verbatim. */
  readonly declaredPaths: readonly string[];
}

/**
 * A phase declaring more paths than this is treated as a hole rather than
 * truncated. Truncation would drop real claims and surface as
 * `unattributed-worktree-change`, which points an operator at a file when the
 * actual problem is the record; marking the evidence incomplete says so.
 */
const MAX_DECLARED_PATHS_PER_PHASE = 1000;

/** Best-effort display path from a `diff --git` header. */
function displayPath(header: string): string {
  const quoted = header.lastIndexOf(' "b/');
  if (quoted !== -1 && header.endsWith('"')) {
    return header.slice(quoted + 4, header.length - 1);
  }
  const plain = header.lastIndexOf(' b/');
  if (plain !== -1) return header.slice(plain + 3);
  return header.slice(HEADER_PREFIX.length);
}

/**
 * Canonicalise one declared path to the workspace-relative, forward-slashed form
 * git prints, or `null` if it does not name a place inside the workspace.
 *
 * Purely lexical, and that is the point rather than a shortcut. These strings
 * arrive from CLI stdout and are operator-influenced, so a `realpath` here would
 * be a filesystem read at an attacker-nameable location performed only to make a
 * *string comparison* succeed. A path that does not lexically match a section git
 * already printed simply matches nothing, the section reads as unclaimed, and the
 * checkpoint declines.
 */
function canonicalizeDeclaredPath(workspaceRoot: string, declared: string): string | null {
  if (typeof declared !== 'string' || declared.length === 0) return null;
  const relative = path.relative(workspaceRoot, path.resolve(workspaceRoot, declared));
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/**
 * Split raw `git diff` output into per-file sections.
 *
 * Every body is normalised to "each of its lines, each terminated by `\n`", and
 * only the *final* flush drops the sentinel the text's own trailing newline
 * leaves behind. A binary section legitimately ends with a blank line before the
 * next header, and dropping that would corrupt the base85 literal a reassembled
 * patch has to carry.
 *
 * Text before the first header — git emits none today, but a future preamble
 * would otherwise vanish — is dropped rather than misattributed, because it
 * belongs to no file and a patch that carried it under some file's name would
 * not apply.
 */
export function splitDiffSections(diff: string): readonly DiffSection[] {
  const sections: DiffSection[] = [];
  let header: string | null = null;
  let body: string[] = [];
  const flush = (final: boolean): void => {
    if (header === null) return;
    const lines = final && body[body.length - 1] === '' ? body.slice(0, -1) : body;
    sections.push({
      key: header,
      path: displayPath(header),
      body: lines.map((line) => `${line}\n`).join('')
    });
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith(HEADER_PREFIX)) {
      flush(false);
      header = line;
      body = [line];
      continue;
    }
    if (header !== null) body.push(line);
  }
  flush(true);
  return sections;
}

/** Concatenate sections back into a patch. A patch file *is* this concatenation. */
export function joinDiffSections(sections: readonly DiffSection[]): string {
  return sections.map((section) => section.body).join('');
}

function pathsOf(sections: readonly DiffSection[]): Set<string> {
  return new Set(sections.map((section) => section.path));
}

export type LedgerEvidence =
  | { readonly complete: true; readonly paths: ReadonlySet<string> }
  | {
      readonly complete: false;
      readonly reason: 'run-not-observed-from-start' | 'observation-failed';
    };

/** The subset of a Run the ledger reads. Kept structural so tests need no fixture. */
export interface LedgerRunView {
  readonly id: string;
  readonly startedAt: number;
  readonly phasesCompleted: readonly unknown[];
}

export interface RunMutationLedgerDeps {
  /** Raw `git diff --binary --no-ext-diff HEAD` output for the shared tree. */
  readonly readDiff: () => Promise<string>;
  /** Run ids that could currently hold uncommitted work. Bounds ledger memory. */
  readonly listInFlightRunIds: () => readonly string[];
  /** Declared paths are canonicalised against this root and must stay inside it. */
  readonly workspaceRoot: string;
  readonly now?: () => number;
}

interface LedgerEntry {
  readonly observedFromStart: boolean;
  observationFailed: boolean;
  windowOpen: boolean;
  readonly paths: Set<string>;
}

/**
 * Per-extension-host, in-memory. It is deliberately not persisted: a ledger
 * restored from disk would claim to have observed phases this host never saw,
 * which is the one thing `observedFromStart` exists to detect.
 */
export class RunMutationLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly createdAt: number;
  /** Dirty when this host first looked — typically the operator's own work. */
  private baseline = new Set<string>();
  private baselineTaken = false;
  /** Left behind by a Run that terminated without committing. */
  private readonly retired = new Set<string>();

  constructor(private readonly deps: RunMutationLedgerDeps) {
    this.createdAt = (deps.now ?? Date.now)();
  }

  /**
   * Open `run`'s window and capture the tree as it stands before it is
   * dispatched.
   *
   * The read is what establishes the baseline, and it has to happen *before* a
   * phase runs: taken afterwards, the Run's own first write would land in the
   * set of changes nobody is expected to claim.
   *
   * A failure here is recorded as failed evidence rather than thrown. Observing
   * the tree is not the phase's job, and a Run whose evidence is unusable
   * declines its next checkpoint — which is the outcome that keeps a partial
   * patch from being written.
   */
  public async observeBeforePhase(run: LedgerRunView): Promise<void> {
    this.syncLiveness();
    let entry = this.entries.get(run.id);
    if (entry === undefined) {
      entry = {
        // Complete evidence needs both: nothing completed yet, *and* the Run
        // began after this ledger did. The second clause is what catches a Run
        // resumed from a previous window — the ledger is per-host and in-memory,
        // so a reloaded Run has writes no ledger ever saw, and an empty entry
        // must not read as a clean history.
        observedFromStart: run.phasesCompleted.length === 0 && run.startedAt >= this.createdAt,
        observationFailed: false,
        windowOpen: false,
        paths: new Set<string>()
      };
      this.entries.set(run.id, entry);
    }
    try {
      const present = pathsOf(splitDiffSections(await this.deps.readDiff()));
      entry.windowOpen = true;
      if (!this.baselineTaken) {
        this.baseline = new Set(present);
        this.baselineTaken = true;
      }
      this.forgetAbsent(present);
    } catch {
      entry.observationFailed = true;
      entry.windowOpen = false;
    }
  }

  /**
   * Close the window opened by {@link observeBeforePhase} and record what the
   * phase declared it wrote.
   *
   * Callers invoke this from a `finally`, so a phase that threw or was cancelled
   * still closes its window — and passes `null`, because a phase that did not
   * finish did not produce an audit record and its writes are therefore unknown.
   * An unclosed window is a hole in the record, and a hole is indistinguishable
   * from a sibling's write.
   */
  public async observeAfterPhase(
    run: LedgerRunView,
    report: PhaseMutationReport | null
  ): Promise<void> {
    const entry = this.entries.get(run.id);
    if (entry === undefined) return;
    const opened = entry.windowOpen;
    entry.windowOpen = false;
    if (!opened) {
      entry.observationFailed = true;
      return;
    }
    if (report === null || report.declaredPaths.length > MAX_DECLARED_PATHS_PER_PHASE) {
      entry.observationFailed = true;
    } else {
      for (const declared of report.declaredPaths) {
        const canonical = canonicalizeDeclaredPath(this.deps.workspaceRoot, declared);
        if (canonical !== null) entry.paths.add(canonical);
      }
    }
    try {
      this.forgetAbsent(pathsOf(splitDiffSections(await this.deps.readDiff())));
    } catch {
      entry.observationFailed = true;
    }
  }

  public evidenceFor(runId: string): LedgerEvidence {
    const entry = this.entries.get(runId);
    if (entry === undefined) return { complete: false, reason: 'run-not-observed-from-start' };
    if (entry.observationFailed) return { complete: false, reason: 'observation-failed' };
    if (!entry.observedFromStart) return { complete: false, reason: 'run-not-observed-from-start' };
    return { complete: true, paths: new Set(entry.paths) };
  }

  /**
   * Every in-flight Run other than `runId` whose evidence is unusable.
   *
   * A sibling the ledger cannot account for may have written anywhere, including
   * into the baseline captured at this ledger's first observation, so its
   * presence invalidates the *whole* partition rather than one Run's share of it.
   * A live Run with no entry counts: it has not dispatched under observation yet,
   * and if it was resumed its earlier work is already in the tree.
   */
  public unaccountedSiblings(runId: string): readonly string[] {
    return this.deps
      .listInFlightRunIds()
      .filter((id) => id !== runId && !this.evidenceFor(id).complete);
  }

  /**
   * Paths claimed by some Run other than `runId` — live siblings, plus whatever a
   * Run that terminated without committing left in the tree. Both block a
   * whole-tree patch for the same reason: it is not this Run's work.
   */
  public pathsAttributedToOthers(runId: string): ReadonlySet<string> {
    const others = new Set<string>(this.retired);
    for (const [id, entry] of this.entries) {
      if (id === runId) continue;
      for (const claimed of entry.paths) others.add(claimed);
    }
    return others;
  }

  /** Explained without being any Run's: dirty before this host looked. */
  public baselinePaths(): ReadonlySet<string> {
    return new Set(this.baseline);
  }

  /**
   * A terminated Run's work does not leave the tree with it — a failed or
   * cancelled Run leaves uncommitted edits behind. Its paths move to `retired`
   * rather than being dropped, so they stay *explained* (a sibling's scoped patch
   * may exclude them) while still blocking a whole-tree patch that would swallow
   * them.
   *
   * Public because the checkpoint seam reads the ledger without observing it — a
   * sibling that terminated since the last observation must be retired before its
   * work is judged, not after.
   */
  public syncLiveness(): void {
    const live = new Set(this.deps.listInFlightRunIds());
    for (const [id, entry] of this.entries) {
      if (live.has(id)) continue;
      for (const claimed of entry.paths) this.retired.add(claimed);
      this.entries.delete(id);
    }
  }

  /**
   * Drop every remembered path the tree no longer shows. A committed or reverted
   * path leaves the diff, and keeping a stale claim on it would make the next Run
   * to touch that path look like a second writer to someone else's file. It is
   * also what bounds this ledger's memory against a declaration naming files that
   * never reach the diff at all.
   */
  private forgetAbsent(present: ReadonlySet<string>): void {
    const keep = (paths: Set<string>): void => {
      for (const claimed of paths) {
        if (!present.has(claimed)) paths.delete(claimed);
      }
    };
    keep(this.baseline);
    keep(this.retired);
    for (const entry of this.entries.values()) keep(entry.paths);
  }
}
