// The controls the webview sends against a live queue: its Run's phases, that
// Run's breakpoints, and the queued tasks behind it. Wire shapes only — the
// literals and the runtime guards stay in the barrel, which is where every
// command in this extension declares itself.
//
// Feature 100 (FR-R3-016) extracted these. The barrel's per-file ceiling is a
// forcing function, and the ratchet it enforces is stated in
// tests/lint/source-loc-budget.test.ts: the barrel retains literals and guards
// while domain wire shapes live in focused modules. Nine phase controls, two
// breakpoint commands, and four task edits were the largest family still
// declared inline, so they are what left rather than the lifecycle family that
// arrived — a family whose guards read their payloads cannot leave (they would
// need the literals as runtime values, which is the import cycle the barrel
// exists to prevent).
//
// The command literals arrive `import type`, so this module holds no runtime
// dependency on the barrel and the barrel's own import of it is a leaf edge.

import type {
  CMD_CLEAR_PHASE_BREAKPOINT,
  CMD_DISABLE_PHASE,
  CMD_ENABLE_PHASE,
  CMD_MODIFY_TASK,
  CMD_PAUSE_PHASE,
  CMD_REMOVE_TASK_PHASE,
  CMD_REORDER_TASK,
  CMD_RESTART_CANCELED_TASK,
  CMD_RESTART_PHASE,
  CMD_RESUME_PHASE,
  CMD_RETRY_PHASE_NOW,
  CMD_SET_PHASE_BREAKPOINT,
  CMD_SKIP_PHASE,
  CommandBase
} from '../sidebar-ipc';

// Feature 011 — operates on one queue's active run. Rejections:
// 'no-active-run', 'not-pending-retry', 'already-retrying',
// 'secondary-window-readonly'.
//
// Feature 093 (FR-018 / T080) — every lifecycle control below names the queue
// whose Run it addresses. With N Runs concurrent there is no ambient "the"
// active Run to fall back on, and a control that omits the queue is refused at
// the boundary rather than resolved to a guess. `queueId` is required even
// where the old payload was optional or absent, which is why
// `ResumePhaseCommand`'s payload is no longer optional.
export interface RetryPhaseNowCommand extends CommandBase<typeof CMD_RETRY_PHASE_NOW> {
  readonly payload: { readonly queueId: string };
}

export interface PausePhaseCommand extends CommandBase<typeof CMD_PAUSE_PHASE> {
  readonly payload: { readonly queueId: string };
}

export interface ResumePhaseCommand extends CommandBase<typeof CMD_RESUME_PHASE> {
  readonly payload: { readonly queueId: string; readonly prompt?: string };
}

export interface RestartPhaseCommand extends CommandBase<typeof CMD_RESTART_PHASE> {
  readonly payload: { readonly queueId: string; readonly phaseId: string };
}

export interface SkipPhaseCommand extends CommandBase<typeof CMD_SKIP_PHASE> {
  readonly payload: { readonly queueId: string; readonly phaseId: string };
}

export interface DisablePhaseCommand extends CommandBase<typeof CMD_DISABLE_PHASE> {
  readonly payload: { readonly queueId: string; readonly phaseId: string };
}

export interface EnablePhaseCommand extends CommandBase<typeof CMD_ENABLE_PHASE> {
  readonly payload: { readonly queueId: string; readonly phaseId: string };
}

export interface RemoveTaskPhaseCommand extends CommandBase<typeof CMD_REMOVE_TASK_PHASE> {
  readonly payload: { readonly taskId: string; readonly phaseId: string; readonly confirmed: true };
}

export interface ModifyTaskCommand extends CommandBase<typeof CMD_MODIFY_TASK> {
  readonly payload: { readonly taskId: string; readonly description: string };
}

export interface ReorderTaskCommand extends CommandBase<typeof CMD_REORDER_TASK> {
  readonly payload: { readonly taskId: string; readonly newPosition: number };
}

// Feature 017 — BUG-001. Transitions a `canceled` `FeatureRequest` back
// to `pending`. Host rejects with `not-found` when no task matches, or
// `illegal-state` when the matched task is not in `canceled` status.
export interface RestartCanceledTaskCommand
  extends CommandBase<typeof CMD_RESTART_CANCELED_TASK> {
  readonly payload: { readonly taskId: string };
}

// Feature 028 — set/clear future-phase breakpoint. Both commands carry
// `{ runId, phaseId }` payloads. The host validates the (runId, phaseId)
// tuple against the run's immutable pipeline snapshot before mutating
// `WorkflowRun.phaseBreakpoints`. Failure codes are enumerated in
// specs/028-advanced-phase-pausing/contracts/ipc.md.
export interface SetPhaseBreakpointCommand
  extends CommandBase<typeof CMD_SET_PHASE_BREAKPOINT> {
  readonly payload: {
    readonly queueId: string;
    readonly runId: string;
    readonly phaseId: string;
  };
}

export interface ClearPhaseBreakpointCommand
  extends CommandBase<typeof CMD_CLEAR_PHASE_BREAKPOINT> {
  readonly payload: {
    readonly queueId: string;
    readonly runId: string;
    readonly phaseId: string;
  };
}

/**
 * The family as one arm of `SidebarCommand`.
 *
 * Declared here rather than spelled out thirteen times in the barrel's union:
 * the barrel's job is to say which families exist, and a family that moved out
 * whole should cost it one line, not thirteen.
 */
export type RunControlCommand =
  | RetryPhaseNowCommand
  | PausePhaseCommand
  | ResumePhaseCommand
  | RestartPhaseCommand
  | SkipPhaseCommand
  | DisablePhaseCommand
  | EnablePhaseCommand
  | RemoveTaskPhaseCommand
  | ModifyTaskCommand
  | ReorderTaskCommand
  | RestartCanceledTaskCommand
  | SetPhaseBreakpointCommand
  | ClearPhaseBreakpointCommand;
