import {
  CMD_ATTEST_TASK_COMPLETED,
  CMD_CANCEL,
  CMD_CLEAR_QUEUE,
  CMD_CLEAR_COMPLETED,
  CMD_CLEAR_PHASE_BREAKPOINT,
  CMD_CONTINUE_WORKFLOW,
  CMD_CREATE_QUEUE,
  CMD_DELETE_QUEUE,
  CMD_DEACTIVATE_DEFINITION,
  CMD_DISABLE_PHASE,
  CMD_DISCARD_DEFINITION_DRAFT,
  CMD_DISMISS_MIGRATION_NOTICE,
  CMD_ENABLE_PHASE,
  CMD_EXPORT_PROCESS_YAML,
  CMD_LAUNCH_PIPELINE,
  CMD_LAUNCH_WORKFLOW,
  CMD_MODIFY_TASK,
  CMD_MOVE_QUEUE_ITEM_DOWN,
  CMD_MOVE_QUEUE_ITEM_UP,
  CMD_MOVE_TASK,
  CMD_OPEN_AUDIT_LOG,
  CMD_OPEN_DASHBOARD,
  CMD_OPEN_HISTORY_ITEM_DETAILS,
  CMD_OPEN_TRUST_SETTINGS,
  CMD_OPEN_VERBOSE_SETTING,
  CMD_PAUSE_PHASE,
  CMD_PAUSE_QUEUE,
  CMD_PING_BACKEND,
  CMD_PREFLIGHT_PROCESS_YAML,
  CMD_PUBLISH_DEFINITION,
  CMD_PUBLISH_PACKAGE,
  CMD_READ_DEFINITION_VERSION,
  CMD_READ_FAILURE_RECORD,
  CMD_OPEN_DECISION_RECORD,
  CMD_READ_METRICS,
  CMD_READ_PHASE_LOG,
  CMD_REMOVE_QUEUE_ITEM,
  CMD_REMOVE_TASK_PHASE,
  CMD_RENAME_QUEUE,
  CMD_REORDER_TASK,
  CMD_RERUN_FROM_HISTORY,
  CMD_RESOLVE_AUDIT_POINTER,
  CMD_RESOLVE_HISTORY_DESCRIPTION,
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
  CMD_SET_QUEUE_FAILURE_POLICY,
  CMD_SET_PHASE_BREAKPOINT,
  CMD_SET_UNCONTAINED_BACKEND_GRANT,
  CMD_SKIP_PHASE,
  CMD_START,
  CMD_START_PHASE_LOG_TAIL,
  CMD_START_QUEUE,
  CMD_STOP_PHASE_LOG_TAIL,
  COMMAND_TYPES,
  type CommandType
} from './sidebar-ipc';

// FR-R4-F05 (FR-001, FR-002, FR-003) — the authority of every webview command.
//
// WHY THIS IS A TOTAL TABLE. This file used to hold `MUTATING_COMMAND_REASONS`,
// typed `satisfies Partial<Record<CommandType, string>>`: a command left out of
// it compiled, and was then treated as read-only by the router with no record
// that anyone had decided so. `CMD_PING_BACKEND` went that way and could start a
// child process in an untrusted workspace. The table below is typed
// `satisfies Record<CommandType, CommandAuthority>`, so an omitted command, and a
// key that is not a command, is a compile error naming the line.
//
// TWO AUTHORITIES. `gated` commands meet the router's workspace-trust check and
// then its primary-window check, in that order, before their handler runs.
// `read-only` commands meet neither. FR-003's rule decides which: a command that
// starts a process, writes persisted state, writes a file or appends an audit
// row is gated. A `read-only` entry's reason says why none of the four applies.
//
// WHY `execution`. How a gated command runs is not who may run it. `serialized`
// commands run one at a time in the executor's chain, which is what a queue
// mutation needs. `concurrent` ones keep the identity handling (a repeat of the
// same correlation id joins or replays) but skip the chain, because they wait on
// something other than the host's own state — a child process, or an operator's
// dialog — and would otherwise hold every queue mutation behind it.
//
// The derived sets at the foot of the file are the only lists of gated and
// read-only commands; `tests/unit/ui/sidebar/mutating-commands-pinned-list.test.ts`
// is a hand-written pin of the gated set, which is a check on this table, not a
// second source.

export type CommandAuthority =
  | {
      readonly authority: 'gated';
      readonly execution: 'serialized' | 'concurrent';
      readonly reason: string;
    }
  | { readonly authority: 'read-only'; readonly reason: string };

/** A gated command that runs one at a time in the executor's chain. */
const gated = (reason: string): CommandAuthority => ({
  authority: 'gated',
  execution: 'serialized',
  reason
});

/** A gated command that keeps the identity handling but skips the chain. */
const gatedConcurrent = (reason: string): CommandAuthority => ({
  authority: 'gated',
  execution: 'concurrent',
  reason
});

/** A command with none of the four effects FR-003 names. */
const readOnly = (reason: string): CommandAuthority => ({ authority: 'read-only', reason });

export const COMMAND_AUTHORITY = Object.freeze({
  [CMD_REMOVE_QUEUE_ITEM]: gated('queue item removal'),
  [CMD_RETRY_QUEUE_ITEM]: gated('queue item retry'),
  [CMD_MOVE_QUEUE_ITEM_UP]: gated('queue reorder'),
  [CMD_MOVE_QUEUE_ITEM_DOWN]: gated('queue reorder'),
  [CMD_CLEAR_COMPLETED]: gated('queue cleanup'),
  [CMD_PAUSE_QUEUE]: gated('queue pause state'),
  [CMD_RESUME_QUEUE]: gated('queue pause state'),
  [CMD_RERUN_FROM_HISTORY]: gated('queue enqueue from history'),
  [CMD_START]: gated('workflow start'),
  [CMD_CANCEL]: gated('workflow cancellation'),
  [CMD_RETRY_PHASE_NOW]: gated('phase retry'),
  [CMD_PAUSE_PHASE]: gated('phase pause'),
  [CMD_RESUME_PHASE]: gated('phase resume'),
  [CMD_RESTART_PHASE]: gated('phase restart'),
  [CMD_SKIP_PHASE]: gated('phase override'),
  [CMD_DISABLE_PHASE]: gated('phase override'),
  [CMD_ENABLE_PHASE]: gated('phase override'),
  [CMD_REMOVE_TASK_PHASE]: gated('phase override'),
  [CMD_MODIFY_TASK]: gated('task mutation'),
  [CMD_REORDER_TASK]: gated('task reorder'),
  [CMD_SAVE_GENERAL_SETTINGS]: gated('general settings write'),
  // Feature 100 (T509) — the Model Catalog is the only catalog still written
  // through configuration. Phase, Pipeline, and Workflow saves became the six
  // lifecycle commands below.
  [CMD_SAVE_MODELS]: gated('catalog settings write'),
  // Feature 100 (T507, FR-047, FR-048) — the per-definition lifecycle. All six
  // write the catalog store, so all six are gated in a secondary window. Only
  // `SAVE_DEFINITION_DRAFT` carries a verb the `mutating-command-name-gate` lint
  // recognises; the other five would have passed that lint while omitted here,
  // so their registration is deliberate, not incidental.
  //
  // A draft write is separated from a publication in the reason text on purpose:
  // a draft changes nothing a run can reach, and a publication is the one
  // operation that makes a definition triggerable (FR-013).
  [CMD_SAVE_DEFINITION_DRAFT]: gated('catalog draft write'),
  [CMD_RESTORE_DEFINITION_VERSION]: gated('catalog draft write'),
  [CMD_DISCARD_DEFINITION_DRAFT]: gated('catalog draft discard'),
  [CMD_PUBLISH_DEFINITION]: gated('catalog publication'),
  [CMD_PUBLISH_PACKAGE]: gated('catalog publication'),
  [CMD_DEACTIVATE_DEFINITION]: gated('catalog deactivation'),
  [CMD_RESTART_CANCELED_TASK]: gated('canceled task restart'),
  [CMD_SET_PHASE_BREAKPOINT]: gated('phase breakpoint write'),
  [CMD_CLEAR_PHASE_BREAKPOINT]: gated('phase breakpoint write'),
  // BUG-002 (FR-012a) — start-queue trigger. Mutating because it promotes
  // a pending task to in-flight and kicks off a controller run.
  [CMD_START_QUEUE]: gated('queue start'),
  // FR-R3-150 (T1618) — queue-scoped Clean All. Drops every task belonging
  // to the addressed queue, cancels its active run if any, and clears its
  // pause and scheduled-start state in a single batched memento write.
  [CMD_CLEAR_QUEUE]: gated('queue reset'),
  // Feature 063 — confirmation suppression preference write. Mutating
  // because it persists to the `schegent.ui.confirmSuppression` memento.
  [CMD_SET_CONFIRM_SUPPRESSION]: gated('confirmation suppression preference write'),
  // Feature 087 (T009) — Pipeline run composition. Unlike the two exchange
  // commands, which read a document or write one the operator named, this
  // admits a queue item and a Run: it appends to the queue memento and
  // creates durable state. Its name carries no mutating verb prefix, so the
  // naming-convention lint would not have caught the omission — the entry is
  // deliberate, not incidental.
  [CMD_LAUNCH_PIPELINE]: gated('run enqueue'),
  // Feature 088 (T032) — connected Workflow runs. The launch creates the
  // aggregate and enqueues its first child; the continuation enqueues a child
  // and increments the run's revision. Both create durable state, and neither
  // name carries a mutating verb prefix, so the naming-convention lint would
  // not have caught an omission here.
  [CMD_LAUNCH_WORKFLOW]: gated('connected run enqueue'),
  [CMD_CONTINUE_WORKFLOW]: gated('connected run enqueue'),
  // Feature 092 (T030, US1, FR-021) — the seven reinstated multi-queue
  // commands. Only four of the names carry a verb the
  // `mutating-command-name-gate` lint recognises (`SAVE_`, `SET_`, `CLEAR_`,
  // `MOVE_`); `CREATE`, `RENAME` and `DELETE` match no pattern, so their
  // registration here is what a secondary window's read-only mode rests on
  // and `tests/integration/queue-mutations.test.ts` asserts it behaviourally.
  [CMD_CREATE_QUEUE]: gated('queue registry write'),
  [CMD_RENAME_QUEUE]: gated('queue registry write'),
  [CMD_DELETE_QUEUE]: gated('queue registry write'),
  [CMD_SAVE_QUEUE_SETTINGS]: gated('queue settings write'),
  // Feature 195 (T035, FR-018, FR-019) — this queue's own halt-on-failure
  // answer, or the removal of it (`policy: null`, "follow the workspace
  // default"). Mutating: writes or removes `QueueState.failurePolicy`.
  [CMD_SET_QUEUE_FAILURE_POLICY]: gated('queue failure-policy write'),
  // Feature 195 (T064, FR-025) — attested completion. Mutating: it writes the
  // task's status, and out of `failed` into a status no transition returns from
  // (192's invariant 4), so it is also the least reversible of the three exits
  // from a halt. `ATTEST_` matches no `mutating-command-name-gate` pattern, so
  // the lint would not have caught an omission here — this entry is deliberate.
  [CMD_ATTEST_TASK_COMPLETED]: gated('attested task completion'),
  [CMD_MOVE_TASK]: gated('task move between queues'),
  // FR-R3-144 (T017, D-2) — grant or revoke one backend's uncontained posture.
  // The most consequential write in this table: it decides whether a backend
  // with no OS-enforced bound may spawn at all, and it is application-scoped, so
  // it applies to every workspace in the installation. Gated in a secondary
  // window for the same reason every other write here is — one host owns the
  // write — and the name carries a `SET_` prefix, so
  // `mutating-command-name-gate` would also have caught an omission. Registered
  // deliberately rather than relying on that.
  [CMD_SET_UNCONTAINED_BACKEND_GRANT]: gated('uncontained backend grant'),

  // FR-R4-F05 (FR-003, research R5) — the 17 commands the old partial table left
  // out. FR-003's rule decides each: a command that starts a process, writes
  // persisted state, writes a file or appends an audit row is gated. Eight do.
  //
  // Ping starts the backend CLI in the workspace folder; it was reachable with no
  // gate because nothing here said otherwise. It is `concurrent`: its handler
  // awaits a child process bounded by the probe timeout and the service already
  // answers a second Ping with `already-in-progress`, so serializing it would hold
  // every queue mutation behind a probe (research R3).
  [CMD_PING_BACKEND]: gatedConcurrent(
    'starts the backend CLI with --help in the workspace and appends a backend-ping row'
  ),
  // Writes the queue memento: the dismissal is persisted UI state, so it joins the
  // chain with the other memento writers.
  [CMD_DISMISS_MIGRATION_NOTICE]: gated(
    'writes the queue memento to record that the migration notice was dismissed'
  ),
  // Export writes the file the operator picks in a host dialog and appends a row for
  // every outcome; preflight appends a row on its refusal path. Each waits on an
  // operator's dialog, so neither joins the chain.
  [CMD_EXPORT_PROCESS_YAML]: gatedConcurrent(
    'writes the file the operator picks and appends an export row for every outcome'
  ),
  [CMD_PREFLIGHT_PROCESS_YAML]: gatedConcurrent('appends an audit row when a preflight is refused'),
  // Feature 020 kept the phase-log commands out of the mutating set so that a
  // secondary window could read phase logs, and `CMD_READ_METRICS` gated itself in
  // its handler. FR-003 reaches all four, because each appends an audit row, so a
  // secondary window and an untrusted workspace can no longer read phase logs or
  // open the metrics view. The audit writer already refused those rows outside the
  // owner window; the router now refuses the read as well (research R5). They are
  // concurrent: each is a short read with no state the chain protects.
  [CMD_READ_METRICS]: gatedConcurrent('appends a metrics-view-opened row once per session'),
  [CMD_READ_PHASE_LOG]: gatedConcurrent('appends a phase-log-read row on every read'),
  [CMD_START_PHASE_LOG_TAIL]: gatedConcurrent('appends a phase-log-tail-started row'),
  [CMD_STOP_PHASE_LOG_TAIL]: gatedConcurrent('appends a phase-log-tail-stopped row'),

  // The nine that stay read-only. Each reason says what the command does and that it
  // has none of the four effects (`tests/unit/contracts/sidebar-command-metadata.test.ts`
  // matches the three phrases). Opening an editor view or a settings page is not one.
  [CMD_OPEN_AUDIT_LOG]: readOnly(
    'runs the read-only schegent.showAuditLog to open the audit log document; starts no process, writes no persisted state or file and appends no audit row'
  ),
  [CMD_OPEN_DASHBOARD]: readOnly(
    'runs the read-only schegent.openDashboard to open the dashboard panel; starts no process, writes no persisted state or file and appends no audit row'
  ),
  [CMD_OPEN_HISTORY_ITEM_DETAILS]: readOnly(
    'runs the read-only schegent.showActiveRun to reveal a view; starts no process, writes no persisted state or file and appends no audit row'
  ),
  [CMD_OPEN_VERBOSE_SETTING]: readOnly(
    'opens the settings editor at a fixed query; starts no process, writes no persisted state or file and appends no audit row'
  ),
  [CMD_OPEN_TRUST_SETTINGS]: readOnly(
    'opens the settings editor at the schegent.trust query; starts no process, writes no persisted state or file and appends no audit row'
  ),
  [CMD_READ_DEFINITION_VERSION]: readOnly(
    'reads one catalog definition version for display; starts no process, writes no persisted state or file and appends no audit row'
  ),
  [CMD_RESOLVE_AUDIT_POINTER]: readOnly(
    'reads the audit evidence a pointer names and keeps its health state in memory; starts no process, writes no persisted state or file and appends no audit row'
  ),
  [CMD_RESOLVE_HISTORY_DESCRIPTION]: readOnly(
    'reads a history entry description from its evidence file; starts no process, writes no persisted state or file and appends no audit row'
  ),
  [CMD_READ_FAILURE_RECORD]: readOnly(
    'reads a queue item and its newest failure record; starts no process, writes no persisted state or file and appends no audit row'
  ),
  [CMD_OPEN_DECISION_RECORD]: readOnly(
    'reads one decision record file under the workspace root and shows it in a read-only document; starts no process, writes no persisted state or file and appends no audit row; refuses itself when the workspace is untrusted'
  )
} satisfies Record<CommandType, CommandAuthority>);

/** Every command the router gates (trust, then primacy). Derived from `COMMAND_AUTHORITY`. */
export const MUTATING_COMMAND_TYPES: readonly CommandType[] = Object.freeze(
  COMMAND_TYPES.filter((type) => COMMAND_AUTHORITY[type].authority === 'gated')
);

/** Every command the router leaves ungated. Derived from `COMMAND_AUTHORITY`. */
export const READ_ONLY_COMMAND_TYPES: readonly CommandType[] = Object.freeze(
  COMMAND_TYPES.filter((type) => COMMAND_AUTHORITY[type].authority === 'read-only')
);

const AUTHORITY_BY_TYPE: ReadonlyMap<string, CommandAuthority> = new Map(
  Object.entries(COMMAND_AUTHORITY)
);

// A type the table does not hold (a validator drift) is gated, never read-only:
// the table is total at compile time, so this is a second line, not the gate.
const UNDECLARED_AUTHORITY: CommandAuthority = gated('undeclared');

/**
 * The declared authority of a command type, fail-closed: a `type` with no entry
 * (not a `CommandType` at runtime) is `gated` and `serialized`. The lookup goes
 * through a `Map`, so no index access by `string` is unchecked.
 */
export function commandAuthorityOf(type: string): CommandAuthority {
  return AUTHORITY_BY_TYPE.get(type) ?? UNDECLARED_AUTHORITY;
}
