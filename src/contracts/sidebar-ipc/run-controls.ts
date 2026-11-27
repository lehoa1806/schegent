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
  ClearPhaseBreakpointCommand,
  DisablePhaseCommand,
  EnablePhaseCommand,
  ModifyTaskCommand,
  PausePhaseCommand,
  RemoveTaskPhaseCommand,
  ReorderTaskCommand,
  RestartCanceledTaskCommand,
  RestartPhaseCommand,
  ResumePhaseCommand,
  RetryPhaseNowCommand,
  SetPhaseBreakpointCommand,
  SkipPhaseCommand
} from '../generated/sidebar-ipc-types';

export type {
  RetryPhaseNowCommand,
  PausePhaseCommand,
  ResumePhaseCommand,
  RestartPhaseCommand,
  SkipPhaseCommand,
  DisablePhaseCommand,
  EnablePhaseCommand,
  RemoveTaskPhaseCommand,
  ModifyTaskCommand,
  ReorderTaskCommand,
  RestartCanceledTaskCommand,
  SetPhaseBreakpointCommand,
  ClearPhaseBreakpointCommand
};

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
