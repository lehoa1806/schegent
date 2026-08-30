// Feature FR-R3-006 (T342–T345, T347, T348) — reset, as a coordinated
// transaction rather than a key wipe.
//
// What this file used to be: a prompt, `store.reset()`, a toast. Twenty-two
// lines that asked nothing to stop. A CLI subprocess mid-phase kept running, its
// driver wrote on completion, the schedule watchdog kept ticking, and the drain
// coordinator kept promoting queues — all against state the operator had just
// been told was cleared. The store half of the fix (T339–T341) made the clear
// atomic, complete, and marked; it cannot make the *rest of the process* stop,
// because the store does not know the process exists.
//
// So the order lives here, and it is the order in `reset-transaction.ts`:
//
//   quiesce → stop-producers → mark → clear → commit → reload
//
// `mark`, `clear` and `commit` are one call — `store.reset()` — because they
// belong inside one serialized section and splitting them would put a window
// between the marker and the thing it describes. The three phases this file
// owns are the ones outside the store: stopping the work, stopping the writers,
// and starting them again.
//
// ## Why the stage-2 seam
//
// `schegent.reset` is registered in activation **stage 1**, before a workspace
// folder is known and therefore before a controller, a watchdog, or an audit
// writer exists. It has to be: reset is the command an operator is pointed at
// when stage 2 *cannot* come up, and a command that only exists once the
// workspace is healthy is no use for recovering a workspace that is not.
//
// The capabilities it needs are all stage-2 ones. So they arrive as a `ResetHost`
// resolved lazily at call time, and its absence is a real state rather than a
// missing dependency: no stage 2 means no runs to cancel, no producers to stop,
// and no audit log to write to — the clear is the whole transaction. That is
// exactly the pre-feature behaviour, kept for exactly the case it was correct in.

import * as vscode from 'vscode';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { SanitizedLogger } from '../lib/logger';
import type { ResetPhase, ResetRefusalReason } from '../state/reset-transaction';
import type { WorkspaceStateResetPayload } from '../contracts/audit-events';
import type { AuditLogWriter } from '../audit/audit-log-writer';

/**
 * The confirmation an operator reads before this runs (T347).
 *
 * The text it replaces — "Queue, run, lock, and watchdog will be cleared. Audit
 * log file is preserved." — was wrong in both directions at once: it named four
 * of the sixteen keys the clear touches, and it said nothing about the runs this
 * command now cancels. An operator who reads a confirmation and gets something
 * other than what it described has been misled by the product, which is worse
 * than not being asked.
 *
 * Three clauses, in the order they matter to someone deciding: what stops, what
 * goes, what stays.
 */
export const RESET_CONFIRMATION_MESSAGE =
  'Schegent: reset workspace state? Any running phase is cancelled first. ' +
  'All workspace state is cleared — queues, runs, history, leases, schedules, ' +
  'and saved prompt choices. The audit log, its archives, and the per-run ' +
  'session transcripts are preserved. This cannot be undone.';

export const RESET_CONFIRM_LABEL = 'Reset';
export const RESET_CANCEL_LABEL = 'Cancel';

/** Refused before the clear: the quiesce window elapsed with work still live. */
export const RESET_REFUSED_TOAST =
  'Schegent: reset refused — a phase is still running. Cancel it, wait for it to stop, then try again.';

export const RESET_COMPLETED_TOAST = 'Schegent: workspace state reset.';

/** What `quiesce` concluded. */
export type ResetQuiesceOutcome =
  | { readonly ok: true; readonly canceledRunCount: number }
  | { readonly ok: false; readonly reason: ResetRefusalReason };

/**
 * The stage-2 capabilities the transaction needs, as the narrowest port that
 * expresses them.
 *
 * Deliberately not "give me the controller and the audit writer". Reset needs
 * two verbs and one of them — `recordReset` — has to resolve its writer at call
 * time rather than close over one, because the writer it should use after a
 * reload is the *new* stage 2's, and the one it closed over belongs to a stage 2
 * that has since been disposed.
 */
export interface ResetStageSupport {
  /**
   * Cancel every Run in the window and wait for the CLI subprocesses to stop.
   * Resolves `ok: false` rather than throwing when the window elapses — a
   * refusal is an outcome of the transaction, not an error in it.
   */
  quiesce(): Promise<ResetQuiesceOutcome>;
  /** Append the bounded reset event. Best-effort: never fails the transaction. */
  recordReset(payload: WorkspaceStateResetPayload): Promise<void>;
}

/**
 * The host seam. Every member resolves against whatever stage 2 exists *now*,
 * which is why they are functions on a port rather than captured objects.
 */
export interface ResetHost {
  /** The live stage-2 support, or `null` when stage 2 is not up. */
  support(): ResetStageSupport | null;
  /** Tear stage 2 down: watchdogs, drain triggers, heartbeats, leases, primacy. */
  stopProducers(): Promise<void>;
  /** Bring it back up, which is also what re-acquires primacy. */
  reload(): Promise<void>;
}

/**
 * Write the one reset event (T348).
 *
 * Shared by the command path and the activation path, which record the same
 * event about the same transaction from either side of a host restart, and
 * which must therefore write it the same way. `runId: ''` follows the
 * state-migration events: there is no Run to resolve, and inventing a
 * Run-shaped identifier for a workspace-scoped fact would make the entry look
 * reachable from a Run that does not exist.
 *
 * Best-effort at every call site — the caller catches. A reset that happened is
 * not undone by an audit append that did not.
 */
export async function appendResetAuditEvent(
  audit: Pick<AuditLogWriter, 'append'>,
  logger: Pick<SanitizedLogger, 'warn'>,
  payload: WorkspaceStateResetPayload
): Promise<void> {
  try {
    await audit.append({
      runId: '',
      phase: 'reset',
      iteration: 0,
      eventType: 'workspace-state-reset',
      payload: { ...payload },
      // A refusal is `info`, not `failure`: refusing to clear state out from
      // under a live subprocess is the transaction working, and grading it as a
      // failure would put it alongside the entries that mean something broke.
      outcome:
        payload.outcome === 'completed'
          ? 'success'
          : payload.outcome === 'refused'
            ? 'info'
            : 'failure'
    });
  } catch (err) {
    logger.warn(`workspace-state-reset audit append failed: ${(err as Error).message}`);
  }
}

export type ResetOutcome =
  | { readonly status: 'declined' }
  | { readonly status: 'completed'; readonly generation: number }
  | { readonly status: 'refused'; readonly reason: ResetRefusalReason; readonly phase: ResetPhase }
  | { readonly status: 'failed'; readonly reason: ResetRefusalReason; readonly phase: ResetPhase };

export interface ResetContext {
  readonly store: WorkspaceStateStore;
  readonly logger: SanitizedLogger;
  /** Absent in stage 1 and in tests that exercise the clear alone. */
  readonly host?: ResetHost;
}

/**
 * Record the attempt, whatever it concluded.
 *
 * Best-effort by design, and the `catch` is the reason this is a helper rather
 * than three inline `await`s: an audit append that fails must not turn a
 * completed reset into a reported failure, and must not turn a refusal into a
 * thrown error the operator sees as something else. The clear already happened
 * or already did not; the entry is evidence about it, not part of it.
 */
async function record(
  ctx: ResetContext,
  payload: WorkspaceStateResetPayload
): Promise<void> {
  try {
    await ctx.host?.support()?.recordReset(payload);
  } catch (err) {
    ctx.logger.warn(`reset: audit append failed: ${(err as Error).message}`);
  }
}

export async function runReset(ctx: ResetContext): Promise<ResetOutcome> {
  // Non-modal, as before — and the ONLY confirmation a reset gets. This comment
  // used to say the sidebar path puts a `useConfirm('workspace.reset')` dialog in
  // front of it, and used that to justify the modality; the sender was deleted,
  // and the only caller of that key left in the tree is a test. `schegent.reset`
  // is reached from the Command Palette, so this prompt is host-side and
  // unconditional: `schegent.ui.confirmations.enable` cannot suppress it.
  const choice = await vscode.window.showInformationMessage(
    RESET_CONFIRMATION_MESSAGE,
    RESET_CONFIRM_LABEL,
    RESET_CANCEL_LABEL
  );
  if (choice !== RESET_CONFIRM_LABEL) return { status: 'declined' };

  // Phase 1 — quiesce. Before anything is torn down, because a refusal here must
  // leave the window exactly as it found it: an operator who is told "no" gets a
  // working window back, not a half-dismantled one.
  let canceledRunCount = 0;
  const support = ctx.host?.support() ?? null;
  if (support) {
    let quiesced: ResetQuiesceOutcome;
    try {
      quiesced = await support.quiesce();
    } catch (err) {
      ctx.logger.error(`reset: quiesce failed: ${(err as Error).message}`);
      quiesced = { ok: false, reason: 'quiesce-failed' };
    }
    if (!quiesced.ok) {
      // T343 — refuse, and clear nothing. The toast names the reason because
      // `runner-still-active` is the one an operator can act on.
      await record(ctx, {
        outcome: 'refused',
        phaseReached: 'quiesce',
        generation: null,
        refusalReason: quiesced.reason,
        canceledRunCount: 0
      });
      ctx.logger.warn(`reset: refused at quiesce (${quiesced.reason})`);
      void vscode.window.showWarningMessage(
        quiesced.reason === 'runner-still-active'
          ? RESET_REFUSED_TOAST
          : `Schegent: reset refused — ${quiesced.reason}.`
      );
      return { status: 'refused', reason: quiesced.reason, phase: 'quiesce' };
    }
    canceledRunCount = quiesced.canceledRunCount;
  }

  // Phase 2 — stop the producers. Tearing stage 2 down is what stops the
  // schedule watchdog, the retry watchdog, the drain triggers and the lease
  // heartbeat, and its `dispose()` is already the path that releases every
  // execution lease this window holds and then primacy (T344, T345). Composing
  // with the existing lifecycle rather than adding a second stop path is the
  // point: a second one would have to be kept in step with this one forever, and
  // the failure of drifting apart is a producer that keeps writing.
  //
  // Releasing primacy here is permitted — reset is workspace maintenance, not a
  // Run-scoped path — but only because phase 6 re-acquires it. `release()` stops
  // the heartbeat and nulls the record and nothing but `tryAcquire()` restores
  // either, so a transaction that stopped after the commit would leave the
  // window non-primary for the rest of the session.
  if (ctx.host) {
    try {
      await ctx.host.stopProducers();
    } catch (err) {
      // A teardown that throws has still disposed some of what it owns, so the
      // window is not in a state to keep executing. Reload and report rather
      // than clearing on top of a half-stopped host.
      ctx.logger.error(`reset: stop-producers failed: ${(err as Error).message}`);
      await reload(ctx);
      await record(ctx, {
        outcome: 'failed',
        phaseReached: 'stop-producers',
        generation: null,
        refusalReason: 'quiesce-failed',
        canceledRunCount
      });
      void vscode.window.showErrorMessage(
        'Schegent: reset failed while stopping background work; no state was cleared.'
      );
      return { status: 'failed', reason: 'quiesce-failed', phase: 'stop-producers' };
    }
  }

  // Phases 3–5 — mark, clear, commit. One call, one serialized section.
  let generation: number;
  try {
    generation = await ctx.store.reset();
  } catch (err) {
    ctx.logger.error(`reset: clear failed: ${(err as Error).message}`);
    // Reload first. The clear may have partially applied and the marker is
    // therefore `in-progress`; the activation path finishes such a reset, and
    // `reload()` is what runs it. Reporting without reloading would leave both
    // the marker unresolved and the window non-primary.
    await reload(ctx);
    await record(ctx, {
      outcome: 'failed',
      phaseReached: 'clear',
      generation: null,
      refusalReason: 'clear-failed',
      canceledRunCount
    });
    void vscode.window.showErrorMessage(
      `Schegent: reset failed — ${(err as Error).message}`
    );
    return { status: 'failed', reason: 'clear-failed', phase: 'clear' };
  }

  // Phase 6 — reload.
  await reload(ctx);
  await record(ctx, {
    outcome: 'completed',
    phaseReached: 'reload',
    generation,
    refusalReason: null,
    canceledRunCount
  });
  ctx.logger.info(`reset: completed generation ${generation}`);
  void vscode.window.showInformationMessage(RESET_COMPLETED_TOAST);
  return { status: 'completed', generation };
}

/**
 * Bring stage 2 back, and never let its failure become the transaction's.
 *
 * A reload that throws leaves a window with no wiring, which is bad — but it is
 * the same bad state an operator reaches by opening a workspace stage 2 cannot
 * come up in, and the product already handles that with the placeholder
 * projector. Rethrowing here would instead report a *completed* reset as failed,
 * which would send the operator to run it again against already-clear state.
 */
async function reload(ctx: ResetContext): Promise<void> {
  try {
    await ctx.host?.reload();
  } catch (err) {
    ctx.logger.error(`reset: reload failed: ${(err as Error).message}`);
  }
}
