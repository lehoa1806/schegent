// FR-R4-F06 (FR-020; contract S, S1 and S2; research R28) -- the ladders a runner has started and
// not yet reported, kept so shutdown can wait for them.
//
// THE GAP. `terminate()` fired the termination ladder and forgot it: the ladder's timers are
// `unref`'d, `cancelActive()` returns a boolean, and nothing anywhere held a promise for "the tree
// is gone". So shutdown could not wait for a tree, and released ownership while one was still being
// killed. A runner now keeps each ladder's promise here, keyed by child, until it settles.
//
// WHY ONE MODULE. `ClaudeCliRunner` owns its ladder bookkeeping and `ProcessLifecycleRunner` (under
// Codex and Agy) owns its own. The same map, the same deadline race and the same "report each
// ladder once" rule written twice is two places to forget the next change, which is the duplication
// `process-tree.ts` already removed for the ladder itself.
//
// WHAT IT DOES NOT DO. It decides nothing about signals or outcomes; the ladder does. It never
// rejects, and it writes no evidence: the registry collects, and `host-teardown-recorder.ts` records.
import type { ChildProcess } from 'node:child_process';

import type { TreeTeardownOutcome } from '../contracts/backend-runner';

/** Everything an outcome carries except how the ladder ended: known when the ladder starts. */
export type LadderSeed = Omit<TreeTeardownOutcome, 'result'>;

interface OpenLadder {
  readonly seed: LadderSeed;
  readonly settled: Promise<TreeTeardownOutcome>;
}

/** The ladders one runner has started and not yet reported. */
export class TeardownLedger {
  private readonly open = new Map<ChildProcess, OpenLadder>();

  /**
   * Keep `ladder` until it settles. A second ladder for a child whose first is still pending is
   * not kept: one tree has one outcome, the first ladder's, and the second reaches the same truth.
   */
  public track(child: ChildProcess, seed: LadderSeed, ladder: Promise<TreeTeardownOutcome>): void {
    if (this.open.has(child)) return;
    const entry: OpenLadder = { seed, settled: ladder };
    this.open.set(child, entry);
    const forget = (): void => {
      if (this.open.get(child) === entry) this.open.delete(child);
    };
    ladder.then(forget, forget);
  }

  /**
   * The outcomes of the ladders open now, each reported once. With a `deadline`, a ladder still
   * pending when it resolves is reported `bound-elapsed` with the seed it started with. Never
   * rejects: a ladder that cannot say how it ended is `tree-unconfirmed`, the weaker claim.
   */
  public settle(deadline?: Promise<void>): Promise<readonly TreeTeardownOutcome[]> {
    return Promise.all([...this.open.values()].map((entry) => this.outcomeOf(entry, deadline)));
  }

  private outcomeOf(entry: OpenLadder, deadline?: Promise<void>): Promise<TreeTeardownOutcome> {
    const unsayable = (): TreeTeardownOutcome => ({ ...entry.seed, result: 'tree-unconfirmed' });
    const ladder = entry.settled.catch(unsayable);
    if (deadline === undefined) return ladder;
    const elapsed = deadline.then(
      (): TreeTeardownOutcome => ({ ...entry.seed, result: 'bound-elapsed' }),
      unsayable
    );
    return Promise.race([ladder, elapsed]);
  }
}
