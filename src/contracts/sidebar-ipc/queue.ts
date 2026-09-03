// Feature 092 (US1, FR-019/FR-020) — the multi-queue mutation wire contract.
//
// Lives in a sub-module for the same reason `workflow-run.ts` and
// `run-launcher.ts` do: the barrel is at its LOC ceiling, and only the five
// mandatory registration edits per command belong there (the literal, the
// `SIDEBAR_COMMAND_TYPES` entry, the type re-export, the `SidebarCommand`
// member, and the `COMMAND_GUARDS` entry). See
// specs/092-multi-queue-concurrency/contracts/queue-registry-and-migration.md.
//
// These seven commands are the surface feature 030 removed for the single-queue
// collapse and this feature reinstates. The command literals are imported
// `import type` — a value import would close the cycle feature 085 recorded, so
// the guards that need them as runtime values stay in the barrel.
//
// Three rules govern every shape below:
//
//   * **A queue is addressed by identifier, never by name.** Names are
//     operator-authored; the host resolves them for display and the audit log
//     never learns them (FR-023a, FR-038a). `CMD_CREATE_QUEUE` and
//     `CMD_RENAME_QUEUE` carry a name because supplying one is the whole point
//     of those two commands.
//   * **No bound is declared here.** These are transport shapes; the length and
//     format bounds are `src/contracts/validators/queue.ts`'s, which is the
//     ingress gate, and restating one here would create a second oracle that
//     drifts.
//   * **No filesystem path crosses this boundary**, in either direction — the
//     same rule the process-YAML and connected-run families hold.

import type {
  CMD_CREATE_QUEUE,
  CMD_DELETE_QUEUE,
  CMD_MOVE_TASK,
  CMD_RENAME_QUEUE,
  CMD_SAVE_QUEUE_SETTINGS,
  CMD_SET_QUEUE_FAILURE_POLICY,
  CommandBase
} from '../sidebar-ipc';
import type { QueueFailurePolicy } from '../queue-failure-policy';

export interface CreateQueueCommand extends CommandBase<typeof CMD_CREATE_QUEUE> {
  readonly payload: { readonly name: string };
}

export interface RenameQueueCommand extends CommandBase<typeof CMD_RENAME_QUEUE> {
  readonly payload: { readonly queueId: string; readonly name: string };
}

/**
 * Feature 092 (US1, FR-014) — two-phase, like `RemoveTaskPhaseCommand`.
 *
 * Without `confirmed`, the host answers `rejected` / `confirmation-required`
 * and returns the impact — the pending-Task count and every connected run
 * bound to the queue — so the webview can name it in the prompt. The host
 * stays the single oracle for that count; the webview never derives it from
 * a snapshot that may have moved on.
 */
export interface DeleteQueueCommand extends CommandBase<typeof CMD_DELETE_QUEUE> {
  readonly payload: { readonly queueId: string; readonly confirmed?: true };
}

export interface SaveQueueSettingsCommand extends CommandBase<typeof CMD_SAVE_QUEUE_SETTINGS> {
  readonly payload: {
    readonly globalConcurrencyCap: number;
    readonly defaultQueueId: string;
  };
}

/** Feature 092 (US1, FR-017) — move a pending Task to another queue. */
export interface MoveTaskCommand extends CommandBase<typeof CMD_MOVE_TASK> {
  readonly payload: {
    readonly taskId: string;
    readonly targetQueueId: string;
    readonly position?: number;
  };
}

/**
 * Feature 195 (T035, FR-018, FR-019) — this queue's own answer to the
 * halt-on-failure question, or `null` to follow the workspace default.
 * `policy: null` MUST remove the stored `QueueState.failurePolicy` field
 * rather than write a concrete value: FR-018's stated/unstated distinction
 * is what lets a later change to the workspace default reach exactly the
 * queues that never stated an opinion (data-model.md §2).
 */
export interface SetQueueFailurePolicyCommand
  extends CommandBase<typeof CMD_SET_QUEUE_FAILURE_POLICY> {
  readonly payload: {
    readonly queueId: string;
    readonly policy: QueueFailurePolicy | null;
  };
}
