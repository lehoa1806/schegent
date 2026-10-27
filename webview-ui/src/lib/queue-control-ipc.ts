// Feature 095 (T005–T007, FR-014) — the SINGLE webview call site for the five
// queue-management commands feature 092 registered without one.
//
// Same shape as `phase-breakpoint-ipc.ts`, `phase-log-ipc.ts`,
// `save-general-settings.ts` and `metrics-ipc.ts`: post, mark pending, one-shot
// ack, 5-second timeout, one `finalise` guard so a late ack after a timeout is a
// no-op. Components import these functions and never the `CMD_` constants;
// `tests/lint/queue-command-reachability.test.ts` fails the build on drift.
//
// Two commands are deliberately absent. `CMD_CREATE_QUEUE` and
// `CMD_RENAME_QUEUE` already have call sites (`QueuesTier`, `QueueDetailTier`)
// and this feature does not relocate them — moving working code to satisfy a
// tidiness instinct is a diff with no requirement behind it.

import {
  CMD_CLEAR_COMPLETED,
  CMD_CLEAR_QUEUE,
  CMD_DELETE_QUEUE,
  CMD_MOVE_TASK,
  CMD_SAVE_QUEUE_SETTINGS,
  CMD_SET_QUEUE_FAILURE_POLICY
} from './messages';
import type { QueueFailurePolicy } from './generated/queue-failure-policy';
import { snapshotStore } from './snapshot-store.svelte';
import type { AckResult } from './snapshot-store.svelte';
import { useConfirm } from './use-confirm';
import type { ActionCopyContext } from './action-copy';
import { postCommand } from './vscode-api';

const ACK_TIMEOUT_MS = 5000;

export type QueueControlResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly reason: string };

/**
 * What deleting a queue would cost, as the host counts it. Never derived from a
 * snapshot: the snapshot the operator is looking at may already be stale, and
 * the prompt must state what the delete will actually do.
 */
export interface QueueDeletionImpact {
  readonly queueId: string;
  readonly pendingTaskCount: number;
  readonly boundConnectedRunIds: readonly string[];
}

export type DeleteQueueProbeResult =
  | { readonly status: 'impact'; readonly impact: QueueDeletionImpact }
  | { readonly status: 'rejected'; readonly reason: string };

export type DeleteQueueOutcome =
  | { readonly status: 'deleted' }
  | { readonly status: 'declined' }
  | { readonly status: 'refused'; readonly reason: string };

/**
 * The whole two-phase delete: probe, confirm, delete. One function, deliberately.
 *
 * Splitting it would put each of the two delete posts in a scope with no
 * `useConfirm(` above it, and `tests/lint/destructive-actions.lint.test.ts`
 * scans by command name and walks *enclosing brace blocks* for the gate — so a
 * correctly-gated delete spread across a helper and a component reads to the
 * lint as an ungated one. Keeping the sequence in one body satisfies the lint
 * and the rule it enforces at the same time, which is why the alternative
 * (a payload-sensitive exemption for the unconfirmed probe) was rejected in
 * plan §R1. It also happens to be the honest shape: two posts either side of an
 * operator decision are one interaction, not three.
 *
 * That same scan is why this comment names neither the command constant nor the
 * post helper together: the regex reads comments as code, and a prose mention at
 * module level sits outside every brace block, so it can only ever be reported
 * as an ungated call that does not exist.
 *
 * The probe answers `rejected` / `confirmation-required` with the impact. A
 * refusal *ahead* of the confirmation gate — default queue, in-flight Task —
 * comes back as a plain refusal and must be shown to the operator instead of a
 * confirmation prompt: there is nothing to confirm.
 */
export async function confirmAndDeleteQueue(
  queueId: string,
  queueName: string,
  originatingElement: HTMLElement | null = null
): Promise<DeleteQueueOutcome> {
  const probe = await correlated<DeleteQueueProbeResult>(
    () => postCommand(CMD_DELETE_QUEUE, { queueId }).correlationId,
    readProbeAck,
    { status: 'rejected', reason: 'timeout' }
  );
  if (probe.status === 'rejected') {
    return { status: 'refused', reason: probe.reason };
  }

  const confirmed = await useConfirm('queue.delete', {
    originatingElement,
    context: {
      queueName,
      pendingTaskCount: probe.impact.pendingTaskCount,
      connectedRunCount: probe.impact.boundConnectedRunIds.length
    }
  });
  if (!confirmed) {
    return { status: 'declined' };
  }

  const deleted = await correlated<QueueControlResult>(
    () => postCommand(CMD_DELETE_QUEUE, { queueId, confirmed: true }).correlationId,
    toQueueControlResult,
    { status: 'rejected', reason: 'timeout' }
  );
  return deleted.status === 'accepted'
    ? { status: 'deleted' }
    : { status: 'refused', reason: deleted.reason };
}

function readProbeAck(ack: AckResult): DeleteQueueProbeResult {
  if (ack.status === 'accepted') {
    // Cannot happen: an unconfirmed delete never deletes. Reported rather than
    // assumed away, so a host that ever changed this is visible.
    return { status: 'rejected', reason: 'unexpected-accept' };
  }
  const reason = ack.reason ?? 'rejected';
  if (reason === 'confirmation-required' && isQueueDeletionImpact(ack.result)) {
    return { status: 'impact', impact: ack.result };
  }
  return { status: 'rejected', reason };
}

/**
 * Both workspace queue settings under one command. The cap's accepted range is
 * the host validator's and is not restated here (FR-011); an out-of-range value
 * reaches the host and comes back as a refusal.
 */
export function saveQueueSettings(
  globalConcurrencyCap: number,
  defaultQueueId: string
): Promise<QueueControlResult> {
  return correlatedRequest(
    () =>
      postCommand(CMD_SAVE_QUEUE_SETTINGS, { globalConcurrencyCap, defaultQueueId }).correlationId
  );
}

/**
 * Move a pending Task to another queue. No `position` (FR-016) — the command
 * accepts one, but this feature offers no affordance for choosing it, and a
 * parameter no caller can fill meaningfully is a shape waiting to be guessed at.
 * Adding it later is additive.
 */
export function moveTask(taskId: string, targetQueueId: string): Promise<QueueControlResult> {
  return correlatedRequest(() => postCommand(CMD_MOVE_TASK, { taskId, targetQueueId }).correlationId);
}

/**
 * Feature 195 (T040, FR-018, FR-019) — this queue's own halt-on-failure
 * answer, or `null` to follow the workspace default. A three-way outcome
 * rather than `QueueControlResult`'s two: the host distinguishes a committed
 * write from a redundant one (`no-op`, when the queue already read the way
 * the operator asked), and collapsing that into `refused` would tell the
 * operator their unchanged request was declined.
 */
export type SetQueueFailurePolicyOutcome =
  | { readonly status: 'accepted' }
  | { readonly status: 'no-op'; readonly reason: string }
  | { readonly status: 'refused'; readonly reason: string };

function toSetQueueFailurePolicyOutcome(ack: AckResult): SetQueueFailurePolicyOutcome {
  if (ack.status === 'accepted') return { status: 'accepted' };
  const reason = ack.reason ?? 'rejected';
  return ack.outcome === 'no-op' ? { status: 'no-op', reason } : { status: 'refused', reason };
}

export function setQueueFailurePolicy(
  queueId: string,
  policy: QueueFailurePolicy | null
): Promise<SetQueueFailurePolicyOutcome> {
  return correlated<SetQueueFailurePolicyOutcome>(
    () => postCommand(CMD_SET_QUEUE_FAILURE_POLICY, { queueId, policy }).correlationId,
    toSetQueueFailurePolicyOutcome,
    { status: 'refused', reason: 'timeout' }
  );
}

export type ClearQueueOutcome =
  | { readonly status: 'cleared' }
  | { readonly status: 'declined' }
  | { readonly status: 'refused'; readonly reason: string };

// Code-review finding (iteration 4, FR-R3-150/FR-011) — `CMD_CLEAR_QUEUE` and
// `CMD_CLEAR_COMPLETED` are outside the feature-092 five this module's header
// enumerates, but `QueueDetailTier.svelte`'s `onClean`/`onClearDone` posted
// them fire-and-forget after their own separate `useConfirm(...)` call, so
// the `unknown-queue-id` refusal this feature adds (a queue deleted from
// another window between opening the confirmation and confirming it) reached
// no listener: `applyAck()` just clears the pending flag and drops the ack.
// `cmd-clear-queue.ts`'s own comment says the sidebar IPC boundary — here —
// is where FR-011 expects the refusal to surface; nothing did.
//
// The confirm call moves in here rather than staying at the call site,
// mirroring `confirmAndDeleteQueue` above and for the same reason:
// `destructive-actions.lint.test.ts` walks the *enclosing brace block* of a
// destructive command's `postCommand` call for a `useConfirm(` sibling, so a
// post correlated in this module needs its own gate in this module — a gate
// upstream in the caller is invisible to that scan, exactly the shape the
// comment on `confirmAndDeleteQueue` above already explains for delete.
export async function clearQueue(
  queueId: string,
  context: ActionCopyContext['queue.clean-all'],
  originatingElement: HTMLElement | null = null
): Promise<ClearQueueOutcome> {
  const confirmed = await useConfirm('queue.clean-all', { originatingElement, context });
  if (!confirmed) return { status: 'declined' };
  const result = await correlatedRequest(() =>
    postCommand(CMD_CLEAR_QUEUE, { queueId }).correlationId
  );
  return result.status === 'accepted'
    ? { status: 'cleared' }
    : { status: 'refused', reason: result.reason };
}

// Code-review finding (iteration 4, FR-R3-150/FR-011) — see `clearQueue`
// above; the same gap and the same fix, for Clear Done.
export async function clearCompleted(
  queueId: string,
  context: ActionCopyContext['queue.clear-done'],
  originatingElement: HTMLElement | null = null
): Promise<ClearQueueOutcome> {
  const confirmed = await useConfirm('queue.clear-done', { originatingElement, context });
  if (!confirmed) return { status: 'declined' };
  const result = await correlatedRequest(() =>
    postCommand(CMD_CLEAR_COMPLETED, { queueId }).correlationId
  );
  return result.status === 'accepted'
    ? { status: 'cleared' }
    : { status: 'refused', reason: result.reason };
}

// FR-013 — one refusal vocabulary for all four control groups, so a reason the
// host answers reads the same wherever it surfaces. Unknown codes fall through
// verbatim rather than being swallowed: a refusal the operator cannot act on is
// still better than a control that silently does nothing.
//
// Every key below is a string the host actually emits. That is not a truism: the
// first version of this table was written from the refusals as the spec *names*
// them — `default-queue`, `in-flight-task`, `unknown-queue`, `connected-run-child`,
// `invalid-expression`, `out-of-range` — and not one of those six is a code any
// host site produces. `cmd-delete-queue.ts` acks `impact.reason` verbatim, so the
// commonest refusal in the feature reached the operator as "The host refused:
// default-queue-undeletable". The fall-through hid it: every entry looked
// plausible and nothing was silently wrong, so only reading both ends together
// finds it. `queue-refusal-vocabulary.test.ts` now pins each key to its emitting
// site, which is the check that would have caught it.
//
// Emitting sites, so the pairing can be re-checked rather than trusted:
//   - `contracts/validators/queue-management.ts` — payload refusals, ahead of
//     every handler
//   - `QueueManager.queueDeletionImpact` — the delete refusals
//   - `QueueManager.moveTask`, `WorkspaceState.movePendingRequest` and the one
//     rename in `taskErrorReason` (`task-not-found` → `unknown-task-id`)
//   - `parseSchedule` (`lib/schedule-parser.ts`) — the five `ScheduleParseError`
//     codes. Feature 097 removed this module's only caller (`setQueueSchedule`,
//     FR-013); kept dormant rather than deleted in case a caller returns.
//   - `QueueManager.saveQueueSettings` — the settings refusals
//   - `commands/constants.ts` and each `cmd-*.ts` guard — transport refusals
//   - `commands/clear-queue.ts` (`runClearQueue`) — the two orchestrator
//     refusals the queue-scoped Clean All relays through `cmd-clear-queue.ts`
// `timeout` and `unexpected-accept` are the two this module synthesises itself.
//
// `invalid-queue-name` is deliberately absent: it belongs to create and rename,
// which this module does not post (see the header).
const REFUSAL_TEXT: Readonly<Record<string, string>> = Object.freeze({
  // Payload — reachable only from a control that sent something malformed.
  'missing-payload': 'The request was incomplete and was not sent.',
  'unexpected-payload-fields': 'The request carried unexpected fields and was not sent.',
  'invalid-confirmation': 'The confirmation could not be read. Try the action again.',
  'invalid-position': 'That position is not valid for the target queue.',
  // Delete
  'default-queue-undeletable':
    'The default queue cannot be deleted. Make another queue the default first.',
  'queue-has-in-flight-task':
    'This queue has a Task in flight. Wait for it to finish, or cancel it first.',
  // FR-R4-F01 (spec 239, US3, FR-013) — a queue whose Run is still live. Each names the state
  // the Run is in and the one control that clears it, because deleting the queue would leave
  // that Run with nothing to own it. `QueueManager.queueDeletionImpact` emits all three.
  'queue-has-running-run':
    "This queue's Run is still running. Cancel the Run first, then delete the queue.",
  'queue-has-retry-pending-run':
    "This queue's Run is waiting to retry. Cancel the Run first, then delete the queue.",
  'queue-has-paused-run':
    "This queue's Run is paused (at a breakpoint, at its spend limit, or by you). Cancel the Run first, then delete the queue.",
  'unknown-queue-id': 'That queue no longer exists.',
  // Move
  'task-bound-to-connected-run': 'This Task belongs to a connected run and moves with it.',
  'unknown-task-id': 'That Task no longer exists.',
  'task-not-in-pending-state': 'Only a pending Task can be moved to another queue.',
  'task-cap-reached': 'The target queue is already full.',
  'position-out-of-range': 'That position is not valid for the target queue.',
  // Schedule
  'empty-input': 'Enter a schedule, such as "in 30m" or "at 14:00".',
  'mixed-units': 'A schedule takes one unit only — "in 2h" or "in 30m", not "in 2h30m".',
  'value-out-of-range': 'That schedule is too far off, or not a positive whole number.',
  'invalid-time-of-day': 'That time of day could not be read. Use HH:MM between 00:00 and 23:59.',
  'unrecognized-format':
    'That schedule expression could not be read. Try "in 30m", "in 2h", or "at 14:00".',
  // Settings
  'invalid-concurrency-cap': 'That value is outside the range this setting accepts.',
  'config-write-failed': 'The setting could not be saved. Try again.',
  // Feature 195 (T035) — `CMD_SET_QUEUE_FAILURE_POLICY`'s payload validator
  // (`validateSetQueueFailurePolicy`, `contracts/validators/queue-management.ts`).
  'invalid-failure-policy': 'That is not a recognized failure policy.',
  // Clean All orchestration (`runClearQueue`). Both reach the operator through
  // `cmd-clear-queue.ts`, which relays the orchestrator's `reason` verbatim —
  // without these two entries they render as "The host refused: not-primary",
  // which is the exact fall-through defect the header above records.
  'not-primary': 'This window is not the primary one, so it cannot change the queue.',
  'persistence-error': 'The queue could not be cleared — workspace state could not be written.',
  // Shared outcome vocabulary — `command-outcome.ts` and `handler-helpers.ts`,
  // reachable here since `cmd-clear-queue.ts` relays through `execAndAck`
  // (code-review finding, iteration 5). Same three the lifecycle table carries,
  // worded for a queue rather than a Run: the trust gate's `undefined`, a
  // dispatch that threw, and a result shape no reading covers. Without them the
  // first would render as "The host refused: workspace-not-trusted".
  'workspace-not-trusted': 'The workspace is not trusted, so this control is unavailable.',
  'command-dispatch-failed': 'The queue could not be cleared. Check the log and try again.',
  'command-result-unrecognized':
    'The host answered in a way this view could not read, and nothing was changed.',
  // Transport
  'secondary-window-readonly': 'This window is not the primary one, so it cannot change the queue.',
  unsupported: 'This host build does not support that operation.',
  'operation-rejected': 'The host refused the operation.',
  timeout: 'The host did not answer. Try again.',
  'unexpected-accept': 'The host answered unexpectedly and the queue was left unchanged.'
});

export function refusalText(reason: string): string {
  return REFUSAL_TEXT[reason] ?? `The host refused: ${reason}`;
}

function isQueueDeletionImpact(value: unknown): value is QueueDeletionImpact {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.queueId === 'string' &&
    typeof candidate.pendingTaskCount === 'number' &&
    Array.isArray(candidate.boundConnectedRunIds) &&
    candidate.boundConnectedRunIds.every((id) => typeof id === 'string')
  );
}

function toQueueControlResult(ack: AckResult): QueueControlResult {
  return ack.status === 'accepted'
    ? { status: 'accepted' }
    : { status: 'rejected', reason: ack.reason ?? 'rejected' };
}

function correlatedRequest(post: () => string): Promise<QueueControlResult> {
  return correlated<QueueControlResult>(post, toQueueControlResult, {
    status: 'rejected',
    reason: 'timeout'
  });
}

/**
 * The correlated-request scaffolding, parameterised by what an ack means. Every
 * caller resolves exactly once: `settled` guards the ack path, the timeout path,
 * and a late ack arriving after the timeout.
 */
function correlated<T>(post: () => string, fromAck: (ack: AckResult) => T, onTimeout: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: T): void => {
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
      finalise(fromAck(ack));
    });

    timer = setTimeout(() => {
      finalise(onTimeout);
    }, ACK_TIMEOUT_MS);
  });
}
