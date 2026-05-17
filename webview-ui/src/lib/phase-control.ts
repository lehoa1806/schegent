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

export function pausePhase(): void {
  postCommand(CMD_PAUSE_PHASE);
}

export function resumePhase(): void {
  postCommand(CMD_RESUME_PHASE);
}

export function restartPhase(phaseId: string): void {
  postCommand(CMD_RESTART_PHASE, { phaseId });
}

export function skipPhase(phaseId: string): void {
  postCommand(CMD_SKIP_PHASE, { phaseId });
}

export function disablePhase(phaseId: string): void {
  postCommand(CMD_DISABLE_PHASE, { phaseId });
}

export function enablePhase(phaseId: string): void {
  postCommand(CMD_ENABLE_PHASE, { phaseId });
}

export function removeTaskPhase(taskId: string, phaseId: string): void {
  postCommand(CMD_REMOVE_TASK_PHASE, { taskId, phaseId, confirmed: true });
}
