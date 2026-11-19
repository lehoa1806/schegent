// GENERATED FILE — do not edit.
//
// Emitted from scripts/contracts/ipc-descriptors/phase-control.mjs by scripts/generate-contract-schemas.mjs.
// Edit the descriptor and run: npm run contracts:generate

import {
  CMD_CLEAR_PHASE_BREAKPOINT,
  CMD_DISABLE_PHASE,
  CMD_ENABLE_PHASE,
  CMD_PAUSE_PHASE,
  CMD_RESTART_PHASE,
  CMD_RESUME_PHASE,
  CMD_RETRY_PHASE_NOW,
  CMD_SET_PHASE_BREAKPOINT,
  CMD_SKIP_PHASE,
  type ClearPhaseBreakpointCommand,
  type DisablePhaseCommand,
  type EnablePhaseCommand,
  type PausePhaseCommand,
  type RestartPhaseCommand,
  type ResumePhaseCommand,
  type RetryPhaseNowCommand,
  type SetPhaseBreakpointCommand,
  type SkipPhaseCommand
} from '../../sidebar-ipc';
import { fail, hasUnexpectedKeys, ok, type IpcValidationResult } from '../../validators/shared';

export function validateRetryPhaseNow(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_RETRY_PHASE_NOW, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['queueId'])) {
    return fail('unexpected-payload-fields', { type: CMD_RETRY_PHASE_NOW, correlationId });
  }
  const validated_queueIdRaw: unknown = validatedObj['queueId'];
  if (typeof validated_queueIdRaw !== 'string') {
    return fail('invalid-queueId', { type: CMD_RETRY_PHASE_NOW, correlationId });
  }
  if (validated_queueIdRaw.length < 1 || validated_queueIdRaw.length > 256) {
    return fail('invalid-queueId', { type: CMD_RETRY_PHASE_NOW, correlationId });
  }
  const validated_queueId: string = validated_queueIdRaw;
  const validated = { queueId: validated_queueId };
  const command: RetryPhaseNowCommand = { type: CMD_RETRY_PHASE_NOW, correlationId, payload: validated };
  return ok(command);
}

export function validatePausePhase(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_PAUSE_PHASE, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['queueId'])) {
    return fail('unexpected-payload-fields', { type: CMD_PAUSE_PHASE, correlationId });
  }
  const validated_queueIdRaw: unknown = validatedObj['queueId'];
  if (typeof validated_queueIdRaw !== 'string') {
    return fail('invalid-queueId', { type: CMD_PAUSE_PHASE, correlationId });
  }
  if (validated_queueIdRaw.length < 1 || validated_queueIdRaw.length > 256) {
    return fail('invalid-queueId', { type: CMD_PAUSE_PHASE, correlationId });
  }
  const validated_queueId: string = validated_queueIdRaw;
  const validated = { queueId: validated_queueId };
  const command: PausePhaseCommand = { type: CMD_PAUSE_PHASE, correlationId, payload: validated };
  return ok(command);
}

export function validateResumePhase(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_RESUME_PHASE, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['queueId', 'prompt'])) {
    return fail('unexpected-payload-fields', { type: CMD_RESUME_PHASE, correlationId });
  }
  const validated_queueIdRaw: unknown = validatedObj['queueId'];
  if (typeof validated_queueIdRaw !== 'string') {
    return fail('invalid-queueId', { type: CMD_RESUME_PHASE, correlationId });
  }
  if (validated_queueIdRaw.length < 1 || validated_queueIdRaw.length > 256) {
    return fail('invalid-queueId', { type: CMD_RESUME_PHASE, correlationId });
  }
  const validated_queueId: string = validated_queueIdRaw;
  const validated_promptRaw: unknown = validatedObj['prompt'];
  let validated_prompt: string | undefined;
  if (validated_promptRaw !== undefined) {
    if (typeof validated_promptRaw !== 'string') {
      return fail('invalid-prompt', { type: CMD_RESUME_PHASE, correlationId });
    }
    if (validated_promptRaw.length > 4096) {
      return fail('invalid-prompt', { type: CMD_RESUME_PHASE, correlationId });
    }
    const validated_promptChecked: string = validated_promptRaw;
    validated_prompt = validated_promptChecked;
  }
  const validated = { queueId: validated_queueId, ...(validated_prompt === undefined ? {} : { prompt: validated_prompt }) };
  const command: ResumePhaseCommand = { type: CMD_RESUME_PHASE, correlationId, payload: validated };
  return ok(command);
}

export function validateRestartPhase(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_RESTART_PHASE, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['queueId', 'phaseId'])) {
    return fail('unexpected-payload-fields', { type: CMD_RESTART_PHASE, correlationId });
  }
  const validated_queueIdRaw: unknown = validatedObj['queueId'];
  if (typeof validated_queueIdRaw !== 'string') {
    return fail('invalid-queueId', { type: CMD_RESTART_PHASE, correlationId });
  }
  if (validated_queueIdRaw.length < 1 || validated_queueIdRaw.length > 256) {
    return fail('invalid-queueId', { type: CMD_RESTART_PHASE, correlationId });
  }
  const validated_queueId: string = validated_queueIdRaw;
  const validated_phaseIdRaw: unknown = validatedObj['phaseId'];
  if (typeof validated_phaseIdRaw !== 'string') {
    return fail('invalid-phaseId', { type: CMD_RESTART_PHASE, correlationId });
  }
  if (validated_phaseIdRaw.length < 1 || validated_phaseIdRaw.length > 256) {
    return fail('invalid-phaseId', { type: CMD_RESTART_PHASE, correlationId });
  }
  const validated_phaseId: string = validated_phaseIdRaw;
  const validated = { queueId: validated_queueId, phaseId: validated_phaseId };
  const command: RestartPhaseCommand = { type: CMD_RESTART_PHASE, correlationId, payload: validated };
  return ok(command);
}

export function validateSkipPhase(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_SKIP_PHASE, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['queueId', 'runId', 'phaseId'])) {
    return fail('unexpected-payload-fields', { type: CMD_SKIP_PHASE, correlationId });
  }
  const validated_queueIdRaw: unknown = validatedObj['queueId'];
  if (typeof validated_queueIdRaw !== 'string') {
    return fail('invalid-queueId', { type: CMD_SKIP_PHASE, correlationId });
  }
  if (validated_queueIdRaw.length < 1 || validated_queueIdRaw.length > 256) {
    return fail('invalid-queueId', { type: CMD_SKIP_PHASE, correlationId });
  }
  const validated_queueId: string = validated_queueIdRaw;
  const validated_runIdRaw: unknown = validatedObj['runId'];
  if (typeof validated_runIdRaw !== 'string') {
    return fail('invalid-runId', { type: CMD_SKIP_PHASE, correlationId });
  }
  if (validated_runIdRaw.length < 1 || validated_runIdRaw.length > 256) {
    return fail('invalid-runId', { type: CMD_SKIP_PHASE, correlationId });
  }
  const validated_runId: string = validated_runIdRaw;
  const validated_phaseIdRaw: unknown = validatedObj['phaseId'];
  if (typeof validated_phaseIdRaw !== 'string') {
    return fail('invalid-phaseId', { type: CMD_SKIP_PHASE, correlationId });
  }
  if (validated_phaseIdRaw.length < 1 || validated_phaseIdRaw.length > 256) {
    return fail('invalid-phaseId', { type: CMD_SKIP_PHASE, correlationId });
  }
  const validated_phaseId: string = validated_phaseIdRaw;
  const validated = { queueId: validated_queueId, runId: validated_runId, phaseId: validated_phaseId };
  const command: SkipPhaseCommand = { type: CMD_SKIP_PHASE, correlationId, payload: validated };
  return ok(command);
}

export function validateDisablePhase(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_DISABLE_PHASE, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['queueId', 'phaseId'])) {
    return fail('unexpected-payload-fields', { type: CMD_DISABLE_PHASE, correlationId });
  }
  const validated_queueIdRaw: unknown = validatedObj['queueId'];
  if (typeof validated_queueIdRaw !== 'string') {
    return fail('invalid-queueId', { type: CMD_DISABLE_PHASE, correlationId });
  }
  if (validated_queueIdRaw.length < 1 || validated_queueIdRaw.length > 256) {
    return fail('invalid-queueId', { type: CMD_DISABLE_PHASE, correlationId });
  }
  const validated_queueId: string = validated_queueIdRaw;
  const validated_phaseIdRaw: unknown = validatedObj['phaseId'];
  if (typeof validated_phaseIdRaw !== 'string') {
    return fail('invalid-phaseId', { type: CMD_DISABLE_PHASE, correlationId });
  }
  if (validated_phaseIdRaw.length < 1 || validated_phaseIdRaw.length > 256) {
    return fail('invalid-phaseId', { type: CMD_DISABLE_PHASE, correlationId });
  }
  const validated_phaseId: string = validated_phaseIdRaw;
  const validated = { queueId: validated_queueId, phaseId: validated_phaseId };
  const command: DisablePhaseCommand = { type: CMD_DISABLE_PHASE, correlationId, payload: validated };
  return ok(command);
}

export function validateEnablePhase(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_ENABLE_PHASE, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['queueId', 'phaseId'])) {
    return fail('unexpected-payload-fields', { type: CMD_ENABLE_PHASE, correlationId });
  }
  const validated_queueIdRaw: unknown = validatedObj['queueId'];
  if (typeof validated_queueIdRaw !== 'string') {
    return fail('invalid-queueId', { type: CMD_ENABLE_PHASE, correlationId });
  }
  if (validated_queueIdRaw.length < 1 || validated_queueIdRaw.length > 256) {
    return fail('invalid-queueId', { type: CMD_ENABLE_PHASE, correlationId });
  }
  const validated_queueId: string = validated_queueIdRaw;
  const validated_phaseIdRaw: unknown = validatedObj['phaseId'];
  if (typeof validated_phaseIdRaw !== 'string') {
    return fail('invalid-phaseId', { type: CMD_ENABLE_PHASE, correlationId });
  }
  if (validated_phaseIdRaw.length < 1 || validated_phaseIdRaw.length > 256) {
    return fail('invalid-phaseId', { type: CMD_ENABLE_PHASE, correlationId });
  }
  const validated_phaseId: string = validated_phaseIdRaw;
  const validated = { queueId: validated_queueId, phaseId: validated_phaseId };
  const command: EnablePhaseCommand = { type: CMD_ENABLE_PHASE, correlationId, payload: validated };
  return ok(command);
}

export function validateSetPhaseBreakpoint(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_SET_PHASE_BREAKPOINT, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['queueId', 'runId', 'phaseId'])) {
    return fail('unexpected-payload-fields', { type: CMD_SET_PHASE_BREAKPOINT, correlationId });
  }
  const validated_queueIdRaw: unknown = validatedObj['queueId'];
  if (typeof validated_queueIdRaw !== 'string') {
    return fail('invalid-queueId', { type: CMD_SET_PHASE_BREAKPOINT, correlationId });
  }
  if (validated_queueIdRaw.length < 1 || validated_queueIdRaw.length > 256) {
    return fail('invalid-queueId', { type: CMD_SET_PHASE_BREAKPOINT, correlationId });
  }
  const validated_queueId: string = validated_queueIdRaw;
  const validated_runIdRaw: unknown = validatedObj['runId'];
  if (typeof validated_runIdRaw !== 'string') {
    return fail('invalid-runId', { type: CMD_SET_PHASE_BREAKPOINT, correlationId });
  }
  if (validated_runIdRaw.length < 1 || validated_runIdRaw.length > 256) {
    return fail('invalid-runId', { type: CMD_SET_PHASE_BREAKPOINT, correlationId });
  }
  const validated_runId: string = validated_runIdRaw;
  const validated_phaseIdRaw: unknown = validatedObj['phaseId'];
  if (typeof validated_phaseIdRaw !== 'string') {
    return fail('invalid-phaseId', { type: CMD_SET_PHASE_BREAKPOINT, correlationId });
  }
  if (validated_phaseIdRaw.length < 1 || validated_phaseIdRaw.length > 256) {
    return fail('invalid-phaseId', { type: CMD_SET_PHASE_BREAKPOINT, correlationId });
  }
  const validated_phaseId: string = validated_phaseIdRaw;
  const validated = { queueId: validated_queueId, runId: validated_runId, phaseId: validated_phaseId };
  const command: SetPhaseBreakpointCommand = { type: CMD_SET_PHASE_BREAKPOINT, correlationId, payload: validated };
  return ok(command);
}

export function validateClearPhaseBreakpoint(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_CLEAR_PHASE_BREAKPOINT, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['queueId', 'runId', 'phaseId'])) {
    return fail('unexpected-payload-fields', { type: CMD_CLEAR_PHASE_BREAKPOINT, correlationId });
  }
  const validated_queueIdRaw: unknown = validatedObj['queueId'];
  if (typeof validated_queueIdRaw !== 'string') {
    return fail('invalid-queueId', { type: CMD_CLEAR_PHASE_BREAKPOINT, correlationId });
  }
  if (validated_queueIdRaw.length < 1 || validated_queueIdRaw.length > 256) {
    return fail('invalid-queueId', { type: CMD_CLEAR_PHASE_BREAKPOINT, correlationId });
  }
  const validated_queueId: string = validated_queueIdRaw;
  const validated_runIdRaw: unknown = validatedObj['runId'];
  if (typeof validated_runIdRaw !== 'string') {
    return fail('invalid-runId', { type: CMD_CLEAR_PHASE_BREAKPOINT, correlationId });
  }
  if (validated_runIdRaw.length < 1 || validated_runIdRaw.length > 256) {
    return fail('invalid-runId', { type: CMD_CLEAR_PHASE_BREAKPOINT, correlationId });
  }
  const validated_runId: string = validated_runIdRaw;
  const validated_phaseIdRaw: unknown = validatedObj['phaseId'];
  if (typeof validated_phaseIdRaw !== 'string') {
    return fail('invalid-phaseId', { type: CMD_CLEAR_PHASE_BREAKPOINT, correlationId });
  }
  if (validated_phaseIdRaw.length < 1 || validated_phaseIdRaw.length > 256) {
    return fail('invalid-phaseId', { type: CMD_CLEAR_PHASE_BREAKPOINT, correlationId });
  }
  const validated_phaseId: string = validated_phaseIdRaw;
  const validated = { queueId: validated_queueId, runId: validated_runId, phaseId: validated_phaseId };
  const command: ClearPhaseBreakpointCommand = { type: CMD_CLEAR_PHASE_BREAKPOINT, correlationId, payload: validated };
  return ok(command);
}
