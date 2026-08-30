import {
  CMD_CANCEL,
  CMD_CLEAR_ALL,
  CMD_CLEAR_COMPLETED,
  CMD_CLEAR_PHASE_BREAKPOINT,
  CMD_CONTINUE_WORKFLOW,
  CMD_CREATE_QUEUE,
  CMD_DELETE_QUEUE,
  CMD_DEACTIVATE_DEFINITION,
  CMD_DISABLE_PHASE,
  CMD_DISCARD_DEFINITION_DRAFT,
  CMD_ENABLE_PHASE,
  CMD_LAUNCH_PIPELINE,
  CMD_LAUNCH_WORKFLOW,
  CMD_MODIFY_TASK,
  CMD_MOVE_QUEUE_ITEM_DOWN,
  CMD_MOVE_QUEUE_ITEM_UP,
  CMD_MOVE_TASK,
  CMD_PAUSE_PHASE,
  CMD_PAUSE_QUEUE,
  CMD_PUBLISH_DEFINITION,
  CMD_PUBLISH_PACKAGE,
  CMD_REMOVE_QUEUE_ITEM,
  CMD_REMOVE_TASK_PHASE,
  CMD_RENAME_QUEUE,
  CMD_REORDER_TASK,
  CMD_RERUN_FROM_HISTORY,
  CMD_RESTART_CANCELED_TASK,
  CMD_RESTART_PHASE,
  CMD_RESTORE_DEFINITION_VERSION,
  CMD_RESUME_PHASE,
  CMD_RESUME_QUEUE,
  CMD_RETRY_PHASE_NOW,
  CMD_RETRY_QUEUE_ITEM,
  CMD_SAVE_DEFINITION_DRAFT,
  CMD_SAVE_GENERAL_SETTINGS,
  CMD_SAVE_MODELS,
  CMD_SAVE_QUEUE_SETTINGS,
  CMD_SET_CONFIRM_SUPPRESSION,
  CMD_SET_PHASE_BREAKPOINT,
  CMD_SKIP_PHASE,
  CMD_START,
  CMD_START_QUEUE,
  type CommandType
} from './sidebar-ipc';

export const MUTATING_COMMAND_REASONS = Object.freeze({
  [CMD_REMOVE_QUEUE_ITEM]: 'queue item removal',
  [CMD_RETRY_QUEUE_ITEM]: 'queue item retry',
  [CMD_MOVE_QUEUE_ITEM_UP]: 'queue reorder',
  [CMD_MOVE_QUEUE_ITEM_DOWN]: 'queue reorder',
  [CMD_CLEAR_COMPLETED]: 'queue cleanup',
  [CMD_PAUSE_QUEUE]: 'queue pause state',
  [CMD_RESUME_QUEUE]: 'queue pause state',
  [CMD_RERUN_FROM_HISTORY]: 'queue enqueue from history',
  [CMD_START]: 'workflow start',
  [CMD_CANCEL]: 'workflow cancellation',
  [CMD_RETRY_PHASE_NOW]: 'phase retry',
  [CMD_PAUSE_PHASE]: 'phase pause',
  [CMD_RESUME_PHASE]: 'phase resume',
  [CMD_RESTART_PHASE]: 'phase restart',
  [CMD_SKIP_PHASE]: 'phase override',
  [CMD_DISABLE_PHASE]: 'phase override',
  [CMD_ENABLE_PHASE]: 'phase override',
  [CMD_REMOVE_TASK_PHASE]: 'phase override',
  [CMD_MODIFY_TASK]: 'task mutation',
  [CMD_REORDER_TASK]: 'task reorder',
  [CMD_SAVE_GENERAL_SETTINGS]: 'general settings write',
  // Feature 100 (T509) — the Model Catalog is the only catalog still written
  // through configuration. Phase, Pipeline, and Workflow saves became the six
  // lifecycle commands below.
  [CMD_SAVE_MODELS]: 'catalog settings write',
  // Feature 100 (T507, FR-047, FR-048) — the per-definition lifecycle. All six
  // write the catalog store, so all six are gated in a secondary window. Only
  // `SAVE_DEFINITION_DRAFT` carries a verb the `mutating-command-name-gate` lint
  // recognises; the other five would have passed that lint while omitted here,
  // so their registration is deliberate, not incidental.
  //
  // A draft write is separated from a publication in the reason text on purpose:
  // a draft changes nothing a run can reach, and a publication is the one
  // operation that makes a definition triggerable (FR-013).
  [CMD_SAVE_DEFINITION_DRAFT]: 'catalog draft write',
  [CMD_RESTORE_DEFINITION_VERSION]: 'catalog draft write',
  [CMD_DISCARD_DEFINITION_DRAFT]: 'catalog draft discard',
  [CMD_PUBLISH_DEFINITION]: 'catalog publication',
  [CMD_PUBLISH_PACKAGE]: 'catalog publication',
  [CMD_DEACTIVATE_DEFINITION]: 'catalog deactivation',
  [CMD_RESTART_CANCELED_TASK]: 'canceled task restart',
  [CMD_SET_PHASE_BREAKPOINT]: 'phase breakpoint write',
  [CMD_CLEAR_PHASE_BREAKPOINT]: 'phase breakpoint write',
  // BUG-002 (FR-012a) — start-queue trigger. Mutating because it promotes
  // a pending task to in-flight and kicks off a controller run.
  [CMD_START_QUEUE]: 'queue start',
  // Feature 063 — atomic Clean All. Drops every queue item, cancels the
  // active runner if any, and clears the watchdog backoff window in a
  // single batched memento write.
  [CMD_CLEAR_ALL]: 'queue full reset',
  // Feature 063 — confirmation suppression preference write. Mutating
  // because it persists to the `schegent.ui.confirmSuppression` memento.
  [CMD_SET_CONFIRM_SUPPRESSION]: 'confirmation suppression preference write',
  // Feature 087 (T009) — Pipeline run composition. Unlike the two exchange
  // commands, which read a document or write one the operator named, this
  // admits a queue item and a Run: it appends to the queue memento and
  // creates durable state. Its name carries no mutating verb prefix, so the
  // naming-convention lint would not have caught the omission — the entry is
  // deliberate, not incidental.
  [CMD_LAUNCH_PIPELINE]: 'run enqueue',
  // Feature 088 (T032) — connected Workflow runs. The launch creates the
  // aggregate and enqueues its first child; the continuation enqueues a child
  // and increments the run's revision. Both create durable state, and neither
  // name carries a mutating verb prefix, so the naming-convention lint would
  // not have caught an omission here.
  [CMD_LAUNCH_WORKFLOW]: 'connected run enqueue',
  [CMD_CONTINUE_WORKFLOW]: 'connected run enqueue',
  // Feature 092 (T030, US1, FR-021) — the seven reinstated multi-queue
  // commands. Only four of the names carry a verb the
  // `mutating-command-name-gate` lint recognises (`SAVE_`, `SET_`, `CLEAR_`,
  // `MOVE_`); `CREATE`, `RENAME` and `DELETE` match no pattern, so their
  // registration here is what a secondary window's read-only mode rests on
  // and `tests/integration/queue-mutations.test.ts` asserts it behaviourally.
  [CMD_CREATE_QUEUE]: 'queue registry write',
  [CMD_RENAME_QUEUE]: 'queue registry write',
  [CMD_DELETE_QUEUE]: 'queue registry write',
  [CMD_SAVE_QUEUE_SETTINGS]: 'queue settings write',
  [CMD_MOVE_TASK]: 'task move between queues'
} satisfies Partial<Record<CommandType, string>>);

export const MUTATING_COMMAND_TYPES = Object.freeze(
  Object.keys(MUTATING_COMMAND_REASONS) as CommandType[]
);
