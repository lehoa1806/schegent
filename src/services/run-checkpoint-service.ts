import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SanitizedLogger } from '../lib/logger';
import { resolveContainedLink } from '../lib/path-containment';
import type { WorkflowRun } from '../state/workflow-run';
import { ensureDirWithinRoot, openWithinRoot } from '../lib/safe-open';
import {
  joinDiffSections,
  splitDiffSections,
  type DiffSection,
  type RunMutationLedger
} from './run-mutation-ledger';

const runExecFile = promisify(execFile);
/**
 * Artifacts kept inside one run's directory, declines included.
 *
 * FR-R3-012 (T435) deliberately left this and the decline path below unchanged.
 * That feature added the bound this one never had — the *number* of run
 * directories — in `src/services/run-checkpoint-retention.ts`, which removes
 * whole directories under an age and total-size policy and never reaches inside
 * one. The two bounds compose and neither is the other's business.
 */
const PER_RUN_LIMIT = 20;
/** Markers name the paths an operator has to deal with; they do not list a tree. */
const MAX_REPORTED_PATHS = 50;

/**
 * Feature 093 (T053, FR-022a) — the reason every checkpoint above one in-flight
 * Run used to carry.
 *
 * FR-R3-004 removed the condition that forced it, so nothing emits it any more.
 * It is kept, exported and named, because markers written before that change are
 * still on disk and the runbook still has to explain what an operator is looking
 * at when they find one.
 */
export const HISTORICAL_DECLINE_REASON = 'concurrent-runs-share-one-worktree';

/**
 * FR-R3-004 — the four ways attribution can fail. Each is a *decline*: no
 * `.patch`, a `.declined.json` marker, and the Git-capable phase proceeds.
 */
export type CheckpointDeclineReason =
  /** This Run's history, or a live sibling's, was not observed end to end. */
  | 'attribution-evidence-incomplete'
  /** The tree holds a change no Run declared and no baseline accounts for. */
  | 'unattributed-worktree-change'
  /** Two Runs both declared writing the same file. */
  | 'path-mutated-by-multiple-runs'
  /** Nothing this Run declared is still in the tree. */
  | 'no-attributable-changes-observed';

/** How the patch that was written relates to the tree it came from. */
export type CheckpointAttributionMode =
  /** One Run in flight: the whole-tree diff, ledger not consulted. */
  | 'sole-run'
  /** Several in flight, but no other Run's work is in the tree right now. */
  | 'no-sibling-work-present'
  /** Several in flight: only the sections this Run declared. */
  | 'scoped';

interface CheckpointCapture {
  readonly diff: string;
  readonly sections: readonly DiffSection[];
  readonly status: string;
  readonly baseCommit: string;
}

type CheckpointDecision =
  | { readonly kind: 'write'; readonly mode: CheckpointAttributionMode; readonly body: string; readonly paths: readonly string[] }
  | { readonly kind: 'decline'; readonly reason: CheckpointDeclineReason; readonly detail: Record<string, unknown> };

/** Private recovery checkpoints captured immediately before Git-capable phases. */
export class RunCheckpointService {
  /**
   * @param countInFlightRuns Feature 093 (T053, FR-022a) — how many Runs could
   *   currently hold uncommitted work in the shared worktree. Required rather
   *   than defaulted: a default of "one Run" would be a guess that reads as a
   *   valid snapshot, which is the exact failure this parameter exists to
   *   prevent. FR-R3-004 keeps it required and gives it a second job — it is
   *   what selects the sole-run path, on which behaviour is unchanged.
   * @param ledger FR-R3-004 — the record of which Run declared which file, and
   *   of what the tree held before any of them started. Also required, and for
   *   the same reason: a service without one could only fall back to guessing,
   *   and the fallback would be invisible.
   */
  constructor(
    private readonly root: string,
    private readonly workspaceRoot: string,
    private readonly logger: SanitizedLogger,
    private readonly countInFlightRuns: () => number,
    private readonly ledger: RunMutationLedger
  ) {}

  public async checkpoint(run: WorkflowRun, phaseId: string): Promise<void> {
    const safeRun = run.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safePhase = phaseId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const runRoot = path.join(this.root, 'checkpoints', safeRun);
    const inFlight = this.countInFlightRuns();

    let capture: CheckpointCapture;
    try {
      await this.ensureRunRoot(safeRun);
      capture = await this.capture();
    } catch (error) {
      // A tree that cannot be read is a snapshot failure, not a decline, and the
      // two must stay different outcomes: this blocks the Git-capable phase.
      this.logger.warn(`checkpoint failed; Git-capable phase blocked: ${(error as Error).message}`);
      throw new Error('checkpoint-unavailable');
    }

    const decision = this.decide(run, inFlight, capture);
    if (decision.kind === 'decline') {
      await this.recordDeclined(runRoot, safeRun, run, phaseId, safePhase, inFlight, decision);
      return;
    }

    try {
      const prefix = `${Date.now()}-${safePhase}`;
      // FR-R3-053 — both artifacts through the walk. The patch first: if it is
      // refused there is no point writing a manifest that points at nothing.
      if (!(await this.writeCheckpointArtifact(safeRun, `${prefix}.patch`, decision.body))) return;
      await this.writeCheckpointArtifact(
        safeRun,
        `${prefix}.json`,
        JSON.stringify(
          {
            runId: run.id,
            phaseId,
            capturedAt: Date.now(),
            // FR-R3-004 (T314) — the commit the patch applies to. A scoped patch
            // is a subset of a tree that keeps moving, so "apply it to whatever
            // is checked out" was never a safe instruction; the runbook now
            // names this field.
            baseCommit: capture.baseCommit,
            status: capture.status,
            attribution: {
              mode: decision.mode,
              inFlightRuns: inFlight,
              paths: decision.paths.slice(0, MAX_REPORTED_PATHS)
            }
          },
          null,
          2
        )
      );
      await this.prune(runRoot);
    } catch (error) {
      this.logger.warn(`checkpoint failed; Git-capable phase blocked: ${(error as Error).message}`);
      throw new Error('checkpoint-unavailable');
    }
  }

  /**
   * FR-R3-004 — decide what, if anything, can honestly be written.
   *
   * The order of the checks is the order of decreasing certainty about the
   * partition: whether this Run's own history is usable, whether every live
   * sibling's is, whether the tree holds anything nobody accounts for, and only
   * then which sections belong to whom. Pure and synchronous so the whole
   * decision table is testable without a repository.
   */
  private decide(
    run: WorkflowRun,
    inFlight: number,
    capture: CheckpointCapture
  ): CheckpointDecision {
    // One Run in flight: the tree's uncommitted content is that Run's, and the
    // whole-tree diff is written exactly as it is today.
    if (inFlight <= 1) {
      return { kind: 'write', mode: 'sole-run', body: capture.diff, paths: [] };
    }

    this.ledger.syncLiveness();
    const evidence = this.ledger.evidenceFor(run.id);
    const unaccounted = this.ledger.unaccountedSiblings(run.id);
    if (!evidence.complete || unaccounted.length > 0) {
      return {
        kind: 'decline',
        reason: 'attribution-evidence-incomplete',
        detail: {
          ownEvidence: evidence.complete ? 'complete' : evidence.reason,
          unaccountedSiblings: unaccounted.slice(0, MAX_REPORTED_PATHS)
        }
      };
    }

    const others = this.ledger.pathsAttributedToOthers(run.id);
    const baseline = this.ledger.baselinePaths();
    const present = capture.sections;

    const unexplained = present.filter(
      (section) =>
        !evidence.paths.has(section.path) &&
        !others.has(section.path) &&
        !baseline.has(section.path)
    );
    if (unexplained.length > 0) {
      // The completeness half of the mechanism: a section present in the tree
      // that no Run's audit record claims. Possibly this Run's own write from a
      // subprocess that outlived its phase, or from a phase whose record
      // under-reported — in which case a scoped patch would be incomplete, and an
      // incomplete patch that presents as a checkpoint is worse than a decline.
      return {
        kind: 'decline',
        reason: 'unattributed-worktree-change',
        detail: { paths: unexplained.slice(0, MAX_REPORTED_PATHS).map((s) => s.path) }
      };
    }

    const contested = present.filter(
      (section) => evidence.paths.has(section.path) && others.has(section.path)
    );
    if (contested.length > 0) {
      return {
        kind: 'decline',
        reason: 'path-mutated-by-multiple-runs',
        detail: { paths: contested.slice(0, MAX_REPORTED_PATHS).map((s) => s.path) }
      };
    }

    const siblingWork = present.filter((section) => others.has(section.path));
    if (siblingWork.length === 0) {
      // Several Runs in flight, but only one of them has touched the tree. The
      // whole-tree diff *is* that Run's diff, so write it whole rather than
      // reconstruct it.
      return {
        kind: 'write',
        mode: 'no-sibling-work-present',
        body: capture.diff,
        paths: present.map((section) => section.path)
      };
    }

    // A section this Run declared may also be in the baseline — a path the
    // operator had already dirtied and the Run then wrote into. It stays in the
    // patch: `git diff HEAD` renders both edits as one set of hunks and they
    // cannot be split, so excluding it would drop this Run's own work. It is not
    // a sibling's work either way, which is what the guarantee is about.
    const mine = present.filter((section) => evidence.paths.has(section.path));
    if (mine.length === 0) {
      return {
        kind: 'decline',
        reason: 'no-attributable-changes-observed',
        detail: { siblingPaths: siblingWork.length }
      };
    }
    return {
      kind: 'write',
      mode: 'scoped',
      body: joinDiffSections(mine),
      paths: mine.map((section) => section.path)
    };
  }

  private async capture(): Promise<CheckpointCapture> {
    const [{ stdout: diff }, { stdout: status }, { stdout: head }] = await Promise.all([
      runExecFile('git', ['diff', '--binary', '--no-ext-diff', 'HEAD'], {
        cwd: this.workspaceRoot,
        maxBuffer: 20 * 1024 * 1024
      }),
      runExecFile('git', ['status', '--porcelain=v1'], {
        cwd: this.workspaceRoot,
        maxBuffer: 1024 * 1024
      }),
      runExecFile('git', ['rev-parse', 'HEAD'], { cwd: this.workspaceRoot, maxBuffer: 1024 })
    ]);
    return { diff, sections: splitDiffSections(diff), status, baseCommit: head.trim() };
  }

  /**
   * FR-R3-053 — the pre-flight, through the walk.
   *
   * Kept as a pre-flight rather than folded into the artifact writes: it runs
   * before `capture()` so a directory that cannot be created blocks the
   * Git-capable phase as `checkpoint-unavailable`, which is deliberately a
   * different outcome from a decline. Doing it only at write time would turn that
   * into a silent missing checkpoint after the work had already run.
   *
   * Throws on refusal, because the caller's `catch` is what maps it to
   * `checkpoint-unavailable`.
   */
  /**
   * FR-R3-053 — `this.root` is the trust anchor, and creating it is deliberately
   * outside the walk's remit.
   *
   * In production `this.root` is `context.globalStorageUri.fsPath` — VS Code's
   * per-extension global storage, which is **not under the workspace** and is a
   * directory the extension is expected to create. `openWithinRoot` bounds paths
   * beneath a root it trusts; it never creates that root, because the root is the
   * one path it does not verify. Those two facts fit together here: the anchor is
   * extension-owned storage outside the workspace, and everything beneath it —
   * `checkpoints/<runId>/…`, where an unredacted binary Git diff lands — goes
   * through the checked walk.
   *
   * An earlier attempt walked from `workspaceRoot` instead, on the assumption that
   * the root sat under it. It does not, and every checkpoint was refused. Recorded
   * because the assumption looks reasonable and is wrong.
   */
  private async ensureRunRoot(safeRun: string): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const ready = await ensureDirWithinRoot(this.root, ['checkpoints', safeRun], 0o700);
    if (ready.outcome === 'refused') {
      throw new Error(`checkpoint run root refused: ${ready.reason} (${ready.errno})`);
    }
  }

  /**
   * FR-R3-053 (H-02) — write one checkpoint artifact through the safe walk.
   *
   * A checkpoint patch can contain an **unredacted binary Git diff** — the threat
   * model says so — so a symlink at any component of
   * `<root>/checkpoints/<runId>/` redirects that content out of the workspace.
   * `mkdir -p` followed by `writeFile` on a composed path followed neither
   * component nor leaf safely.
   *
   * `createDirs` builds `checkpoints/<runId>` as part of the walk, which is what
   * `ensureRunRoot` was doing with `mkdir -p`; the chain is created with the same
   * 0o700 it had.
   *
   * Returns whether it wrote, so a caller reports a refusal rather than assuming
   * the artifact exists.
   */
  private async writeCheckpointArtifact(
    safeRun: string,
    leaf: string,
    body: string
  ): Promise<boolean> {
    const opened = await openWithinRoot(this.root, ['checkpoints', safeRun, leaf], {
      flags: 'w',
      createDirs: true,
      dirMode: 0o700,
      fileMode: 0o600
    });
    if (opened.outcome === 'refused') {
      this.logger.warn(
        `checkpoint artifact refused: ${opened.reason} (${opened.errno}); ` +
          'checkpoint not written'
      );
      return false;
    }
    try {
      await opened.handle.write(body, null, 'utf8');
      return true;
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }

  /**
   * Feature 093 (T053/T054, FR-022a, SC-015) — record that no restorable
   * snapshot was taken, and why.
   *
   * Deliberately writes **no** `.patch`, because the guarantee is delivered here
   * at the write side: there is no in-product restore path, so a checkpoint is
   * restored by an operator applying that file by hand, and the only way an
   * unattributable one is never applied is for it never to exist. The marker
   * carries its own `.declined.json` suffix rather than hiding a flag inside the
   * normal metadata file, so the refusal is legible in a directory listing — the
   * moment an operator goes looking is a moment they are about to revert
   * something.
   *
   * A failure to write the marker warns and returns rather than throwing: the
   * caller blocks its Git-capable phase when a *snapshot* fails, and a decline
   * is not a failed snapshot. The warning is then the record FR-022a requires.
   *
   * FR-R3-004 adds `detail`, which names the paths or Runs that made the
   * partition undecidable — the marker is the only place an operator learns what
   * to commit or stash to get checkpoints back. The warning line stays
   * counts-only: paths belong in a file beside the patches, not in the log.
   */
  private async recordDeclined(
    runRoot: string,
    // FR-R3-053 — the safe run SEGMENT, not only the composed `runRoot`. The walk
    // needs the segment; `runRoot` stays for `prune`, which is path-based.
    safeRun: string,
    run: WorkflowRun,
    phaseId: string,
    safePhase: string,
    inFlightRuns: number,
    decision: { readonly reason: CheckpointDeclineReason; readonly detail: Record<string, unknown> }
  ): Promise<void> {
    this.logger.warn(
      `checkpoint declined: ${decision.reason} runId=${run.id} phaseId=${phaseId} inFlightRuns=${inFlightRuns}`
    );
    try {
      // FR-R3-053 — the declined manifest through the same walk. It carries no
      // patch body, but it lands in the same directory, and a redirect that can
      // place a file there can place any file there.
      await this.writeCheckpointArtifact(
        safeRun,
        `${Date.now()}-${safePhase}.declined.json`,
        JSON.stringify(
          {
            runId: run.id,
            phaseId,
            declinedAt: Date.now(),
            reason: decision.reason,
            inFlightRuns,
            restorable: false,
            detail: decision.detail
          },
          null,
          2
        )
      );
      // Markers are pruned on the same per-Run budget as snapshots — a Run that
      // spends its whole life beside a sibling writes one per Git-capable phase
      // and would otherwise be the one path here that grows without a bound.
      await this.prune(runRoot);
    } catch (error) {
      this.logger.warn(`checkpoint decline marker failed: ${(error as Error).message}`);
    }
  }

  /**
   * Feature FR-R3-005 (T330) — prune is the one destructive path here, and the
   * names it removes come from a `readdir` of a directory an operator can
   * reach, so a link planted under `checkpoints/<run>/` would otherwise be
   * followed on the host's own initiative.
   *
   * The link form, because a `.patch` that is a symlink is removed as a link:
   * the entry is the host's to drop, and following the leaf would refuse the
   * cleanup instead. `this.root` is the containment root because everything
   * this service writes sits under it.
   *
   * A refusal skips that one file. Retention is best effort by design — a
   * skipped prune costs a directory entry, where failing the phase over it
   * would fail work that has already succeeded.
   */
  private async prune(runRoot: string): Promise<void> {
    const files = (await fs.readdir(runRoot)).sort();
    const prefixes = [...new Set(files.map((name) => name.replace(/\.(patch|json)$/, '')))];
    for (const prefix of prefixes.slice(0, Math.max(0, prefixes.length - PER_RUN_LIMIT))) {
      await Promise.all([
        this.removeIfContained(path.join(runRoot, `${prefix}.patch`)),
        this.removeIfContained(path.join(runRoot, `${prefix}.json`))
      ]);
    }
  }

  private async removeIfContained(victim: string): Promise<void> {
    const verdict = await resolveContainedLink(victim, [this.root]);
    if (verdict.outcome !== 'contained') {
      this.logger.warn(
        `checkpoint prune refused: containment ${
          verdict.outcome === 'refused' ? verdict.reason : verdict.outcome
        }`
      );
      return;
    }
    await fs.rm(verdict.resolved, { force: true });
  }
}
