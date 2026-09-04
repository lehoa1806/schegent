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
import { correlatedLifecycle } from './lifecycle-control-ipc';
import type { LifecycleControlResult } from './lifecycle-control-ipc';

// Feature 093 (FR-018 / T080) — every lifecycle control names the queue whose
// Run it addresses. The host refuses an unaddressed control at the IPC
// boundary, so `queueId` is a required parameter here rather than an optional
// one: a component that cannot say which Run it is acting on has no business
// posting the command at all.

// FR-R3-154 (T1646) — Pause, Resume and Restart return what the host answered.
// They used to return `void`, which was not a simplification but a discard: the
// `correlationId` `postCommand` hands back was dropped on the next line, so the
// ACK reached `snapshotStore.applyAck`, cleared the pending flag, and was
// thrown away. `run-already-paused`, `run-not-paused` and `run-terminal` are
// refusals the host has always been able to answer, and no caller could see any
// of them.
//
// The three below stay in this module — their `postCommand`s are not gated by
// a `useConfirm`, so the `destructive-actions.lint.test.ts` constraint that
// keeps retry-now in its component (see the note further down) does not apply.

export function pausePhase(queueId: string): Promise<LifecycleControlResult> {
  return correlatedLifecycle(() => postCommand(CMD_PAUSE_PHASE, { queueId }).correlationId);
}

export function resumePhase(queueId: string, prompt?: string): Promise<LifecycleControlResult> {
  return correlatedLifecycle(
    () =>
      postCommand(CMD_RESUME_PHASE, prompt === undefined ? { queueId } : { queueId, prompt })
        .correlationId
  );
}

export function restartPhase(phaseId: string, queueId: string): Promise<LifecycleControlResult> {
  return correlatedLifecycle(
    () => postCommand(CMD_RESTART_PHASE, { queueId, phaseId }).correlationId
  );
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

// Retry-now is deliberately absent from this module. It is one of the fifteen
// destructive commands, so `tests/lint/destructive-actions.lint.test.ts`
// requires its `postCommand` to sit in the same scope as the `useConfirm` that
// gates it — and that confirm needs component-level context (the originating
// element and the active phase's display label) which does not belong in a lib
// module. That reason has never changed, and is why the dispatcher lives in a
// component while its six siblings above live here.
//
// The component is `PhaseControlMenu.svelte`. It used to be `PhaseTracker.svelte`,
// which FR-R3-140 deleted as unreachable from either bundle entry point, leaving
// the capability built and routable and reachable by nobody — the state the
// lifecycle round-check of 2026-08-30 recorded as finding C. The replacement is
// reachable: `RunDetailTier` renders `PhaseProgression`, which renders the menu.

// Phase removal addresses a queued Task by id, not an in-flight Run, so it
// stays queue-free: the host resolves the owning queue from the Task row.
export function removeTaskPhase(taskId: string, phaseId: string): void {
  postCommand(CMD_REMOVE_TASK_PHASE, { taskId, phaseId, confirmed: true });
}
