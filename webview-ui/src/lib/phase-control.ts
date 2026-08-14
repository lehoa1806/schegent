import {
  CMD_PAUSE_PHASE,
  CMD_RESTART_PHASE,
  CMD_RESUME_PHASE,
  CMD_SKIP_PHASE,
  CMD_DISABLE_PHASE,
  CMD_ENABLE_PHASE,
  CMD_REMOVE_TASK_PHASE
} from './messages';
import { postCommand } from './vscode-api';

// Feature 093 (FR-018 / T080) — every lifecycle control names the queue whose
// Run it addresses. The host refuses an unaddressed control at the IPC
// boundary, so `queueId` is a required parameter here rather than an optional
// one: a component that cannot say which Run it is acting on has no business
// posting the command at all.

export function pausePhase(queueId: string): void {
  postCommand(CMD_PAUSE_PHASE, { queueId });
}

export function resumePhase(queueId: string, prompt?: string): void {
  postCommand(CMD_RESUME_PHASE, prompt === undefined ? { queueId } : { queueId, prompt });
}

export function restartPhase(phaseId: string, queueId: string): void {
  postCommand(CMD_RESTART_PHASE, { queueId, phaseId });
}

export function skipPhase(phaseId: string, queueId: string): void {
  postCommand(CMD_SKIP_PHASE, { queueId, phaseId });
}

export function disablePhase(phaseId: string, queueId: string): void {
  postCommand(CMD_DISABLE_PHASE, { queueId, phaseId });
}

export function enablePhase(phaseId: string, queueId: string): void {
  postCommand(CMD_ENABLE_PHASE, { queueId, phaseId });
}

// Retry-now is deliberately absent from this module. It is one of the twelve
// destructive commands, so `tests/lint/destructive-actions.lint.test.ts`
// requires its `postCommand` to sit in the same scope as the `useConfirm` that
// gates it — and that confirm needs component-level context (the originating
// element and the active phase's display label) which does not belong in a lib
// module. It dispatches from `PhaseTracker.svelte`, where the queue arrives as
// a required prop, so the payload cannot lose its address.

// Phase removal addresses a queued Task by id, not an in-flight Run, so it
// stays queue-free: the host resolves the owning queue from the Task row.
export function removeTaskPhase(taskId: string, phaseId: string): void {
  postCommand(CMD_REMOVE_TASK_PHASE, { taskId, phaseId, confirmed: true });
}
