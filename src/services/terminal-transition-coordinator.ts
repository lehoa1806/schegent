import type { QueueManager } from '../queue/queue-manager';
import type { SanitizedLogger } from '../lib/logger';
import { isTerminalRunStatus, type WorkflowRun } from '../state/workflow-run';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { HistoryRecorder } from './history-recorder';

/**
 * FR-R3-009 — the durable cumulative-totals rollup's append hook.
 *
 * Structural, not an import of `metrics/`: the coordinator's job is the terminal
 * transition, and it should not learn what a rollup record contains. The
 * implementation lives in `metrics/terminal-run-rollup-recorder.ts`.
 */
export interface TerminalRollupHook {
  recordTerminalRun(run: WorkflowRun): Promise<void>;
}

/**
 * Durable, idempotent terminal transition journal. The intent is persisted
 * before the terminal run record. Activation replay completes queue/history
 * projection before clearing it, repairing crashes at any intermediate step.
 *
 * Feature 093 (T048) — one entry per in-flight transition, keyed by run id.
 * With one ambient intent, two Runs finishing at once meant the second `begin()`
 * overwrote the first's entry and the first `complete()` cleared the record for
 * both, so a crash before the second Run's queue/history projection had nothing
 * to replay.
 *
 * Keyed by **run id**, a deviation from the task's `queueId` wording recorded in
 * tasks.md: the key exists to keep two transitions from colliding, and every
 * call site holds the Run while none holds its queue. Resolving one would mean
 * falling back to the reserved queue when the Task row is gone — which is the
 * common case during replay, and would let a stranded entry collide with the
 * default queue's live one, reintroducing the very defect being removed. Run ids
 * are unique across queues, so an entry still names exactly one queue, and the
 * queue-addressed `setRun` below still resolves it from the Task row.
 */
export class TerminalTransitionCoordinator {
  constructor(
    private readonly store: WorkspaceStateStore,
    private readonly queue: Pick<QueueManager, 'finish'>,
    private readonly history: Pick<HistoryRecorder, 'record'>,
    private readonly logger: SanitizedLogger,
    /**
     * FR-R3-009 — optional so every existing harness that builds a coordinator
     * directly keeps working; a coordinator without it simply writes no rollup,
     * and cumulative totals then fall back to the retained audit corpus.
     */
    private readonly rollup?: TerminalRollupHook
  ) {}

  public async begin(run: WorkflowRun, description?: string): Promise<void> {
    if (!isTerminalRunStatus(run.status)) return;
    const existing = this.store.getTerminalTransitionIntents()[run.id];
    // FR-R3-071 — an intent journalled early (the controller's begin carries no
    // description) is upgraded when `complete()` re-begins with one, so a crash
    // after this point replays the operator's text rather than the feature id.
    if (
      existing &&
      existing.run.status === run.status &&
      (existing.description !== undefined || description === undefined)
    ) {
      return;
    }
    await this.store.setTerminalTransitionIntent(run.id, {
      schemaVersion: 1,
      run,
      createdAt: Date.now(),
      ...(description !== undefined ? { description } : {})
    });
  }

  public async complete(run: WorkflowRun, description: string): Promise<void> {
    if (!isTerminalRunStatus(run.status)) return;
    await this.begin(run, description);
    // Feature 093 (T039) — pattern C-2, and deliberately `findRunByTask` rather
    // than `queueIdForTask`: the latter falls back to the reserved queue when
    // the Task row is gone, which is safe for a mutation that then finds
    // nothing but not for a write, where it would stamp this terminal Run over
    // whatever the default queue holds in flight. Both halves or neither.
    //
    // A replay whose Run record has already been cleared resolves to nothing
    // and writes nothing — the queue and history projection below is the
    // durable half and still runs, which is exactly what replay is for.
    const active = this.store.findRunByTask(run.featureId);
    if (active !== null && active.run.id === run.id) {
      // FR-R3-077 made this commit point fenced, so it can now REFUSE — a lease
      // this window no longer holds, or an ownership record that could not be
      // read. The intent stays journalled either way, which is what the next
      // activation replays; what must NOT happen is the refusal escaping this
      // method. `RunDriver` calls `complete()` from a `finally`, so a throw here
      // skipped the execution-lease release and the auto-drain behind it and
      // left the queue holding a lease forever — a wedge, from a transient read.
      try {
        await this.store.setRun(active.queueId, run, this.store.runCommitClaim(active.queueId));
      } catch (error) {
        this.logger.warn(
          `terminal-transition: replay remains pending: ${(error as Error).message}`
        );
        return;
      }
    }
    try {
      await this.queue.finish(run.featureId, run.status as 'completed' | 'failed' | 'canceled');
      const recorded = await this.history.record(
        run,
        description,
        run.status as 'completed' | 'failed' | 'canceled'
      );
      // FR-R3-071 — the intent clears only when history is durable (or a store
      // is deliberately absent). `record` used to swallow its failures, so a
      // failed append still cleared the repair intent and the crash-replay this
      // journal exists for had nothing to replay.
      if (recorded.outcome === 'failed') {
        this.logger.warn(
          `terminal-transition: replay remains pending: history record failed (${recorded.code})`
        );
      } else {
        await this.store.setTerminalTransitionIntent(run.id, null);
      }
    } catch (error) {
      this.logger.warn(`terminal-transition: replay remains pending: ${(error as Error).message}`);
    }

    // FR-R3-009 (T390/T391) — one rollup record per terminal run, appended here
    // because both terminal callers and the crash-replay loop funnel through this
    // method; the writer's run-id idempotence keeps a repeat at zero appends.
    //
    // Outside the `try` above deliberately: the queue/history projection is the
    // durable half and owns the journalled intent, and a rollup failure must not
    // leave that intent uncleared. The rollup is a derived summary — best-effort
    // with respect to run progress, reported through evidence health, never a
    // reason a terminal transition does not complete.
    try {
      await this.rollup?.recordTerminalRun(run);
    } catch (error) {
      this.logger.warn(`terminal-transition: metrics rollup append failed: ${(error as Error).message}`);
    }
  }

  /**
   * Feature 093 (T048) — replay every pending transition, not just one.
   *
   * Sequential, and each entry is isolated by its own `try`: an entry whose
   * projection still cannot complete leaves itself journalled for the next
   * activation, and must not stop the entries behind it from replaying. A single
   * failure aborting the loop would strand transitions for reasons that have
   * nothing to do with them.
   */
  public async replay(): Promise<void> {
    for (const intent of Object.values(this.store.getTerminalTransitionIntents())) {
      try {
        // FR-R3-071 — the journalled description is what the interrupted
        // transition was completing with; only a legacy intent (or one written
        // by the controller's early begin) forces the featureId substitution,
        // and the substitution is logged rather than silent.
        if (intent.description === undefined) {
          this.logger.warn(
            `terminal-transition: intent for run ${intent.run.id} carries no description; replaying with featureId`
          );
        }
        await this.complete(intent.run, intent.description ?? intent.run.featureId);
      } catch (error) {
        this.logger.warn(
          `terminal-transition: replay of run ${intent.run.id} failed: ${(error as Error).message}`
        );
      }
    }
  }
}
