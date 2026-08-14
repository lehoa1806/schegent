import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkflowRun } from '../state/workflow-run';

const runExecFile = promisify(execFile);
const PER_RUN_LIMIT = 20;

/** Feature 093 (T053, FR-022a) — the one reason a checkpoint is ever declined. */
const DECLINE_REASON = 'concurrent-runs-share-one-worktree';

/** Private recovery checkpoints captured immediately before Git-capable phases. */
export class RunCheckpointService {
  /**
   * @param countInFlightRuns Feature 093 (T053, FR-022a) — how many Runs could
   *   currently hold uncommitted work in the shared worktree. A checkpoint is a
   *   `git diff --binary HEAD` of that **one** worktree, and this project
   *   forbids `git worktree`, so at a count above one the diff necessarily
   *   contains a sibling Run's in-progress edits. Required rather than
   *   defaulted: a default of "one Run" would be a guess that reads as a valid
   *   snapshot, which is the exact failure this parameter exists to prevent.
   */
  constructor(
    private readonly root: string,
    private readonly workspaceRoot: string,
    private readonly logger: SanitizedLogger,
    private readonly countInFlightRuns: () => number
  ) {}

  public async checkpoint(run: WorkflowRun, phaseId: string): Promise<void> {
    const safeRun = run.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safePhase = phaseId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const runRoot = path.join(this.root, 'checkpoints', safeRun);
    const inFlight = this.countInFlightRuns();
    if (inFlight > 1) {
      await this.recordDeclined(runRoot, run, phaseId, safePhase, inFlight);
      return;
    }
    try {
      await fs.mkdir(runRoot, { recursive: true, mode: 0o700 });
      await fs.chmod(runRoot, 0o700);
      const [{ stdout: diff }, { stdout: status }] = await Promise.all([
        runExecFile('git', ['diff', '--binary', '--no-ext-diff', 'HEAD'], {
          cwd: this.workspaceRoot,
          maxBuffer: 20 * 1024 * 1024
        }),
        runExecFile('git', ['status', '--porcelain=v1'], {
          cwd: this.workspaceRoot,
          maxBuffer: 1024 * 1024
        })
      ]);
      const prefix = `${Date.now()}-${safePhase}`;
      await fs.writeFile(path.join(runRoot, `${prefix}.patch`), diff, { mode: 0o600 });
      await fs.writeFile(
        path.join(runRoot, `${prefix}.json`),
        JSON.stringify({ runId: run.id, phaseId, capturedAt: Date.now(), status }, null, 2),
        { mode: 0o600 }
      );
      await this.prune(runRoot);
    } catch (error) {
      this.logger.warn(`checkpoint failed; Git-capable phase blocked: ${(error as Error).message}`);
      throw new Error('checkpoint-unavailable');
    }
  }

  /**
   * Feature 093 (T053/T054, FR-022a, SC-015) — record that no restorable
   * snapshot was taken, and why.
   *
   * Deliberately writes **no** `.patch`, because T054's guarantee is delivered
   * here at the write side: there is no in-product restore path, so a
   * checkpoint is restored by an operator applying that file by hand, and the
   * only way one taken under concurrency is never offered is for it never to
   * exist. The marker carries its own `.declined.json` suffix rather than
   * hiding a flag inside the normal metadata file, so the refusal is legible in
   * a directory listing — the moment an operator goes looking is a moment they
   * are about to revert something.
   *
   * A failure to write the marker warns and returns rather than throwing: the
   * caller blocks its Git-capable phase when a *snapshot* fails, and a decline
   * is not a failed snapshot. The warning is then the record FR-022a requires.
   */
  private async recordDeclined(
    runRoot: string,
    run: WorkflowRun,
    phaseId: string,
    safePhase: string,
    inFlightRuns: number
  ): Promise<void> {
    this.logger.warn(
      `checkpoint declined: ${DECLINE_REASON} runId=${run.id} phaseId=${phaseId} inFlightRuns=${inFlightRuns}`
    );
    try {
      await fs.mkdir(runRoot, { recursive: true, mode: 0o700 });
      await fs.chmod(runRoot, 0o700);
      await fs.writeFile(
        path.join(runRoot, `${Date.now()}-${safePhase}.declined.json`),
        JSON.stringify(
          {
            runId: run.id,
            phaseId,
            declinedAt: Date.now(),
            reason: DECLINE_REASON,
            inFlightRuns,
            restorable: false
          },
          null,
          2
        ),
        { mode: 0o600 }
      );
      // Markers are pruned on the same per-Run budget as snapshots — a Run that
      // spends its whole life beside a sibling writes one per Git-capable phase
      // and would otherwise be the one path here that grows without a bound.
      await this.prune(runRoot);
    } catch (error) {
      this.logger.warn(`checkpoint decline marker failed: ${(error as Error).message}`);
    }
  }

  private async prune(runRoot: string): Promise<void> {
    const files = (await fs.readdir(runRoot)).sort();
    const prefixes = [...new Set(files.map((name) => name.replace(/\.(patch|json)$/, '')))];
    for (const prefix of prefixes.slice(0, Math.max(0, prefixes.length - PER_RUN_LIMIT))) {
      await Promise.all([
        fs.rm(path.join(runRoot, `${prefix}.patch`), { force: true }),
        fs.rm(path.join(runRoot, `${prefix}.json`), { force: true })
      ]);
    }
  }
}
