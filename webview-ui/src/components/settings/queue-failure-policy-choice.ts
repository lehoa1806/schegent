// Feature 195 (T040, FR-014) -- what a queue's "When a task fails" select offers: the two concrete
// policies, read from the generated mirror rather than restated, and one webview-local choice
// (`FOLLOW_DEFAULT`) that names "no override", the third arm the wire vocabulary spells as
// `policy: null` (contract section 6). Shared by the Settings page's Queues section, which holds
// the drafts and writes them, and the table that shows them (`QueueFailurePolicyTable.svelte`).

import type { QueueFailurePolicy } from '../../lib/generated/queue-failure-policy';

/** The choice that removes a queue's override, so the queue follows the workspace default. */
export const FOLLOW_DEFAULT = 'follow-default' as const;

export type FailurePolicyChoice = QueueFailurePolicy | typeof FOLLOW_DEFAULT;

/** Each concrete policy in the redesign's words. */
export const FAILURE_POLICY_LABEL: Readonly<Record<QueueFailurePolicy, string>> = Object.freeze({
  'halt-on-failure': 'Stop the queue',
  continue: 'Continue with the next task'
});

/** The workspace default names what it resolves to, so "follow" is never a blind choice. */
export function followDefaultLabel(resolved: QueueFailurePolicy): string {
  return `Use the workspace default (${FAILURE_POLICY_LABEL[resolved].toLowerCase()})`;
}

/** What a queue's last write needs said: a refusal, a no-op, or an answer not yet known. */
export interface FailurePolicyMessage {
  readonly text: string;
  /** True for a refusal, which reads as an error; a no-op or a wait that ran out does not. */
  readonly refused: boolean;
}

/** One queue's row in the table, as the Queues section derives it. */
export interface FailurePolicyRow {
  readonly queueId: string;
  readonly name: string;
  /** The choice the select shows: the draft while there is one, otherwise the saved choice. */
  readonly choice: FailurePolicyChoice;
  /** True while the choice shown differs from the saved one. */
  readonly changed: boolean;
  /** The policy the workspace default resolves to for this queue. */
  readonly resolved: QueueFailurePolicy;
  readonly message: FailurePolicyMessage | null;
}
