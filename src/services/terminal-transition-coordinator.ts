import type { QueueManager } from '../queue/queue-manager';
import type { SanitizedLogger } from '../lib/logger';
import {
  isTerminalRunStatus,
  type TerminalTransitionIntent,
  type WorkflowRun
} from '../state/workflow-run';
import type { FeatureRequestStatus, TerminalRequestStatus } from '../queue/feature-request';
import { decideTaskTransition } from '../queue/task-transition-decision';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { HistoryRecorder } from './history-recorder';

/** Why an intent was dropped without writing anything: its Run has moved on, or the table refuses the finish. */
type DropReason = 'resumed' | 'other-run' | 'other-status' | 'refused';

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
 * before the terminal run record. FR-R3-196 — `complete` then reads the task row
 * once and resolves the intent to one of five outcomes before it writes anything:
 * the row is gone, in flight for another Run, already in the intent's status, updated
 * since the intent was journalled, or untouched. Only an interrupted transition (the
 * untouched row) writes the Run and the row, and activation replay takes that path to
 * repair a crash at any intermediate step. The intent clears once the projection has
 * landed and history is durable, and is dropped without a write when its Run has
 * moved on.
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

  /**
   * The journalled intent for a Run, or undefined. Read through a `Partial` so the absence is part
   * of the type: the guards that follow are then meaningful both to `npm run lint`, where a bare
   * indexed read is typed present, and to the strictness ratchet, where it is typed possibly absent.
   */
  private journalledIntent(runId: string): TerminalTransitionIntent | undefined {
    const intents: Readonly<Partial<Record<string, TerminalTransitionIntent>>> =
      this.store.getTerminalTransitionIntents();
    return intents[runId];
  }

  public async begin(run: WorkflowRun, description?: string): Promise<void> {
    if (!isTerminalRunStatus(run.status)) return;
    const existing = this.journalledIntent(run.id);
    if (existing && existing.run.status === run.status) {
      if (existing.description !== undefined || description === undefined) return;
      // FR-R3-071 — an intent journalled early (the controller's begin carries no
      // description) is upgraded when `complete()` re-begins with one, so a crash
      // after this point replays the operator's text rather than the feature id.
      // FR-R3-196 — the upgrade keeps the first `createdAt`: replay compares the task
      // row's `updatedAt` against it, and a re-stamp would move the clock past a resume.
      await this.store.setTerminalTransitionIntent(run.id, { ...existing, description });
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
    // FR-R3-196 — the task row is read once, before anything is written, and says whether this
    // transition still has anything to project. `settle` finishes the row before `complete` runs,
    // so a row already in the intent's status has landed: finishing it again is refused by the
    // closed table, and that refusal is not a queue write that never landed.
    const row = this.store.getRequest(run.featureId);
    const journalled = this.journalledIntent(run.id);
    try {
      if (row === null) {
        await this.projectRowGone(run, description);
      } else if (row.status === 'in-flight' && row.runId !== run.id) {
        await this.drop(run, 'other-run');
      } else if (row.status === run.status) {
        await this.projectLanded(run, description);
      } else if (journalled !== undefined && row.updatedAt > journalled.createdAt) {
        // Every way a Run resumes, retries or returns to pending ends in a row write that
        // re-stamps `updatedAt`, and a host that crashed mid-transition wrote nothing after
        // journalling. Only the row can tell a resume that has not yet advanced a phase.
        await this.drop(run, row.status === 'in-flight' ? 'resumed' : 'other-status');
      } else if (!(await this.projectInterrupted(run, description, row.status))) {
        return;
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

  /** The Run has moved on, or the table refuses the finish: nothing is written and the intent goes. */
  private async drop(run: WorkflowRun, reason: DropReason): Promise<void> {
    await this.store.setTerminalTransitionIntent(run.id, null);
    this.logger.info(`terminal-transition: intent for run ${run.id.slice(0, 8)} dropped: ${reason}`);
  }

  /**
   * The task was removed. There is nothing to project to the queue, and the Run record is never
   * written: without a row nothing can tell a resumed or later-canceled Run from an interrupted one.
   */
  private async projectRowGone(run: WorkflowRun, description: string): Promise<void> {
    if (!(await this.recordHistoryIfAbsent(run, description))) return;
    await this.store.setTerminalTransitionIntent(run.id, null);
    this.logger.info(
      `terminal-transition: intent for run ${run.id.slice(0, 8)} cleared: task row gone`
    );
  }

  /** The row is already in the intent's status: only history can still be missing. */
  private async projectLanded(run: WorkflowRun, description: string): Promise<void> {
    if (await this.recordHistoryIfAbsent(run, description)) {
      await this.store.setTerminalTransitionIntent(run.id, null);
    }
  }

  /**
   * Today's projection for a transition a crash interrupted: the Run, then the row, then history.
   * Returns false when the Run write was refused, which ends `complete` before the rollup append,
   * as it always has.
   */
  private async projectInterrupted(
    run: WorkflowRun,
    description: string,
    rowStatus: FeatureRequestStatus
  ): Promise<boolean> {
    // FR-R3-196 — ask the queue's own table before writing anything. A finish it would refuse
    // (`paused → failed`, say) can never land, so the Run is not written for it either.
    const decision = decideTaskTransition({
      operation: 'finish',
      currentStatus: rowStatus,
      targetStatus: run.status as TerminalRequestStatus,
      queueAlreadyHasDifferentInFlight: false
    });
    if (!decision.eligible) {
      await this.drop(run, 'refused');
      return true;
    }
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
        return false;
      }
    }
    // FR-R3-153 (T1638) — `finish` is now typed to `TerminalRequestStatus`
    // itself, so this cast names that shared type instead of repeating an
    // inline literal union. It cannot be dropped outright: `isTerminalRunStatus`
    // is a plain boolean check, not a type predicate, so TypeScript does not
    // narrow `run.status` from `WorkflowRunStatus` on its own — widening that
    // guard's signature is a separate, unrelated file's concern.
    const finished = await this.queue.finish(run.featureId, run.status as TerminalRequestStatus);
    // FR-R3-153 — `finish` refuses a transition outside the closed table by
    // returning `{ ok: false, reason }` rather than throwing, so the caller's
    // `catch` never sees that refusal. The pre-check above admitted this finish, so a refusal
    // here means the row changed in between: the projection can never land, and the intent goes.
    if (finished.ok === false) {
      await this.drop(run, 'refused');
      return true;
    }
    if (await this.recordHistoryIfAbsent(run, description)) {
      await this.store.setTerminalTransitionIntent(run.id, null);
    }
    return true;
  }

  /**
   * FR-R3-196 — true once history is durable for this ending: an entry for the Run id and terminal
   * status is already held in any queue partition, or `record` has just made one. False keeps the
   * intent journalled. The scan is across partitions because a row-less entry is filed under
   * `__unattributed__`, which the store's own per-partition repeat check does not see.
   */
  private async recordHistoryIfAbsent(run: WorkflowRun, description: string): Promise<boolean> {
    const held = this.store.getHistory().some((entry) => {
      const candidate = entry as { runId?: unknown; terminalStatus?: unknown };
      return candidate.runId === run.id && candidate.terminalStatus === run.status;
    });
    if (held) return true;
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
      return false;
    }
    return true;
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
