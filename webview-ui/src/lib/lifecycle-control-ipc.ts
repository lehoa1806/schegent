// FR-R3-154 (T1646) — the operator's half of the mutation ACK.
//
// The host end of this was the defect FR-R3-154 filed: five lifecycle routes
// ACKed `accepted` unconditionally because the commands behind them returned
// `void`. That is closed — `src/contracts/command-outcome.ts` now carries the
// four-word vocabulary and each route ACKs what its command actually answered.
//
// Closing it exposed the other half. The host can now say "refused, the Run is
// already paused", and nothing listens: these six dispatch sites called
// `postCommand(...)` and dropped the returned `correlationId` on the floor.
// `snapshotStore.applyAck` then cleared the pending flag and discarded the
// message, so a truthful refusal died one layer below the operator. A control
// that silently does nothing is the same experience whether the lie is told at
// the host boundary or swallowed at the webview one.
//
// Same shape as `phase-breakpoint-ipc.ts`, `phase-log-ipc.ts`,
// `queue-control-ipc.ts`, `save-general-settings.ts` and `metrics-ipc.ts`:
// post, mark pending, one-shot ack, 5-second timeout, one `finalise` guard so a
// late ack after a timeout is a no-op. Each of those five carries its own copy
// of that scaffolding; this module follows the convention rather than
// refactoring five working modules onto a shared one, which is a change no
// requirement here asks for.
//
// The scaffolding is exported (`correlatedLifecycle`) rather than wrapped in
// six dispatch functions, because two of the six posts cannot move into a lib
// module: `tests/lint/destructive-actions.lint.test.ts` walks the *enclosing
// brace block* of a destructive command's `postCommand` for a `useConfirm(`
// sibling, and retry-phase-now's confirm needs component-level context. Those
// call sites keep their `postCommand` where the lint requires it and pass it in
// as the `post` callback. See `phase-control.ts` for the same reasoning applied
// from the other direction.

import { snapshotStore } from './snapshot-store.svelte';
import type { AckResult } from './snapshot-store.svelte';

const ACK_TIMEOUT_MS = 5000;

/**
 * What a lifecycle control did, in the host's own four words.
 *
 * `no-op` is kept distinct from `refused` because they are different things to
 * tell an operator: a refusal means the request was rejected, a no-op means the
 * queue was already in the requested state and the request was redundant. The
 * host draws that distinction (`CommandOutcome`); collapsing it here would
 * discard it at the last possible moment.
 *
 * `message` is always a full sentence, never a reason code: `refusalText`'s
 * counterpart in `queue-control-ipc.ts` falls through to `The host refused:
 * <code>` for an unknown key, and `queue-refusal-vocabulary.test.ts` exists
 * because that fall-through hid six invented keys for an entire feature. The
 * test at the bottom of this module's own coverage pins these keys the same way.
 */
export type LifecycleControlResult =
  | { readonly outcome: 'accepted' }
  | { readonly outcome: 'no-op'; readonly message: string }
  | { readonly outcome: 'refused'; readonly message: string }
  | { readonly outcome: 'failed'; readonly message: string };

/**
 * One sentence per reason the five lifecycle commands can actually answer.
 *
 * Every key below is a code some host site emits, and the emitting site is
 * named. That is not a formality: `REFUSAL_TEXT` in `queue-control-ipc.ts` was
 * first written from the refusals as the spec *named* them, and not one of six
 * such keys was a code any host site produced — the commonest refusal in that
 * feature reached the operator as raw kebab-case for a whole release, because
 * the fall-through made a wrong key an error nowhere.
 *
 * Emitting sites, so the pairing can be re-checked rather than trusted:
 *   - `controller/sole-run-resolver.ts` (`resolveControlTarget`) — the
 *     queue-addressing refusals every phase control passes through first
 *   - `controller/phase-control-decision.ts` (`decidePhaseControl`) — the
 *     'pause' / 'resume' / 'restart' eligibility branches, and only those
 *     three: the other operations in that classifier are posted by controls
 *     this module does not dispatch
 *   - `controller/phase-control-service.ts` — its own pre-decision guards
 *   - `controller/manual-retry-override.ts` — the three retry-now refusals
 *   - `commands/retry-phase-now.ts` — the primary-window guard
 *   - `guarded-run-service`'s `applyStartQueueIntent` — the start-intent
 *     outcomes, renamed once on the way out (`noop` → `start-intent-no-change`,
 *     see `commands/start-queue.ts` for why that one gets a name of its own)
 *   - `commands/start-queue.ts`'s `outcomeAfterDrain`, on both branches that
 *     drain — `queue-halted-on-failed-task` (Feature 195, FR-021) and
 *     `queue-blocked-by-stranded-run` (BUG-004), each read from the drain's own
 *     report rather than from a second predicate
 *   - `contracts/command-outcome.ts` — the three transport reasons it
 *     synthesises, and `commands/*.ts`'s five `*-failed` codes
 *   - `ui/sidebar/message-router.ts` — the primacy gate
 * `timeout` is the one this module synthesises itself.
 */
const LIFECYCLE_REFUSAL_TEXT: Readonly<Record<string, string>> = Object.freeze({
  // Queue addressing — `resolveControlTarget`.
  'ambiguous-run-target':
    'More than one Run is in flight, so this control could not tell which one you meant.',
  // Phase-control eligibility — `decidePhaseControl`'s 'pause' / 'resume' /
  // 'restart' arms, and the three service methods' own `!run` guard.
  //
  // `run-not-in-flight`, `unknown-phase-id`, `phase-already-removed` and
  // `unknown-task-id` are deliberately absent. `PhaseControlService` does emit
  // all four, but from `removeTaskPhase` and the breakpoint pair — controls
  // this module does not dispatch. They were in this table's first version,
  // and `tests/lint/lifecycle-refusal-vocabulary.test.ts`'s A2 direction
  // caught them on its first run: four sentences no operator could ever have
  // been shown, which is the same defect as a missing one seen from the other
  // side. Their controls surface refusals through their own paths.
  'no-run-in-flight': 'There is no Run in flight on this queue.',
  'run-already-paused': 'This Run is already paused.',
  'run-not-paused': 'This Run is not paused, so there is nothing to resume.',
  'run-terminal': 'This Run has already finished, so its phases can no longer be changed.',
  'phase-not-active': "That phase is not the Run's current one.",
  // Retry now — `applyManualRetryOverride` and the command's own guard.
  'no-active-run': 'There is no active Run to retry.',
  'not-pending-retry': 'This phase is not waiting for a retry, so there is nothing to bring forward.',
  'already-retrying': 'A retry is already under way.',
  'not-primary-window': 'This window is not the primary one, so it cannot retry the phase.',
  // Start queue — `applyStartQueueIntent`.
  'rejected-horizon': 'That start time is outside the range this queue accepts.',
  'rejected-untrusted': 'The workspace is not trusted, so the queue cannot be started.',
  'start-intent-no-change': 'The queue was already set that way, so nothing changed.',
  // Feature 195 (T018, FR-021, SC-011, SC-012) — the no-intent branch's one
  // exception: `runStartQueueCommand` reads the drain's own halt report
  // rather than evaluating a predicate of its own (`commands/start-queue.ts`).
  'queue-halted-on-failed-task':
    'This queue is halted because a task failed. Retry or remove it to continue.',
  // BUG-004 — the second such reading, from both branches of the same command.
  // It names the recovery because there is no control that performs it: the run
  // holding the queue has no task row left, so nothing in the UI addresses it,
  // and the reconciler that ends it runs when the workspace state is loaded.
  'queue-blocked-by-stranded-run':
    'A run with no task is holding this queue. Reload the window to release it.',
  // Transport — `command-outcome.ts` and the router's primacy gate.
  'workspace-not-trusted': 'The workspace is not trusted, so this control is unavailable.',
  'command-dispatch-failed': 'The control could not be carried out. Check the log and try again.',
  'command-result-unrecognized':
    'The host answered in a way this view could not read, and nothing was changed.',
  'operation-rejected': 'The host refused the operation.',
  'secondary-window-readonly': 'This window is not the primary one, so it cannot change the Run.',
  // Per-command failure codes — the five `catch` blocks in `commands/`.
  'pause-phase-failed': 'Pausing the phase failed. Check the log and try again.',
  'resume-phase-failed': 'Resuming the phase failed. Check the log and try again.',
  'restart-phase-failed': 'Restarting the phase failed. Check the log and try again.',
  'retry-phase-now-failed': 'Retrying the phase failed. Check the log and try again.',
  'start-queue-failed': 'Starting the queue failed. Check the log and try again.',
  // Synthesised here.
  timeout: 'The host did not answer. Try again.'
});

export function lifecycleRefusalText(reason: string): string {
  return LIFECYCLE_REFUSAL_TEXT[reason] ?? `The host refused: ${reason}`;
}

/**
 * Read one ACK as a lifecycle result.
 *
 * `status` decides acceptance, because every other consumer in the webview
 * reads that field and a second opinion here could disagree with them.
 * `outcome` only refines a rejection into which of the three non-accepting
 * words it was — and it is optional on the wire, so an ACK without it (any
 * command outside these five, or a host that predates the field) reads as a
 * plain refusal rather than as an error.
 */
function toLifecycleResult(ack: AckResult): LifecycleControlResult {
  if (ack.status === 'accepted') return { outcome: 'accepted' };
  const message = lifecycleRefusalText(ack.reason ?? 'operation-rejected');
  if (ack.outcome === 'no-op') return { outcome: 'no-op', message };
  if (ack.outcome === 'failed') return { outcome: 'failed', message };
  return { outcome: 'refused', message };
}

/**
 * The correlated-request scaffolding, resolving to a lifecycle result. Every
 * caller resolves exactly once: `settled` guards the ack path, the timeout
 * path, and a late ack arriving after the timeout.
 */
export function correlatedLifecycle(post: () => string): Promise<LifecycleControlResult> {
  return new Promise<LifecycleControlResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: LifecycleControlResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (unsubscribe !== null) {
        try {
          unsubscribe();
        } catch {
          // one-shot listener errors must not leak
        }
        unsubscribe = null;
      }
      resolve(result);
    };

    const correlationId = post();
    snapshotStore.markPending(correlationId);
    unsubscribe = snapshotStore.onceAck(correlationId, (ack) => {
      finalise(toLifecycleResult(ack));
    });

    timer = setTimeout(() => {
      finalise({ outcome: 'failed', message: lifecycleRefusalText('timeout') });
    }, ACK_TIMEOUT_MS);
  });
}

/**
 * The one sentence to show the operator, or `null` when the control committed.
 *
 * A `no-op` returns its sentence like a refusal does: "nothing changed" is
 * exactly what the operator needs told, and it is the case this whole feature
 * exists to make visible.
 */
export function lifecycleMessage(result: LifecycleControlResult): string | null {
  return result.outcome === 'accepted' ? null : result.message;
}
