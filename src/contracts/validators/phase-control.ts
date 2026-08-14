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
  type SidebarCommand
} from '../sidebar-ipc';
import { QUEUE_ID_MAX, fail, hasUnexpectedKeys, ok, type IpcValidationResult } from './shared';

// The operator's continuation prompt shares the description bound the rest of
// the boundary applies to free text.
const PROMPT_MAX = 4096;

// Feature 093 (FR-018 / T080) — every lifecycle control names the queue whose
// Run it addresses. This module is the single boundary check for that: a
// control that arrives without a queue is refused here rather than defaulted
// downstream, because a default is ambient resolution wearing a different name
// and, with N Runs in flight, it would act on a Run the operator never pointed
// at.
function readQueueId(p: Record<string, unknown>): string | null {
  const queueId = p['queueId'];
  if (typeof queueId !== 'string' || queueId.length === 0 || queueId.length > QUEUE_ID_MAX) {
    return null;
  }
  return queueId;
}

/** Lifecycle controls whose only payload is the queue they address. */
export type QueueOnlyCommandType = typeof CMD_PAUSE_PHASE | typeof CMD_RETRY_PHASE_NOW;

export function validateQueueIdPayload(
  type: QueueOnlyCommandType,
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(p, ['queueId'])) {
    return fail('unexpected-payload-fields', { type, correlationId });
  }
  const queueId = readQueueId(p);
  if (queueId === null) {
    return fail('invalid-queueId', { type, correlationId });
  }
  return ok({ type, correlationId, payload: { queueId } } as SidebarCommand);
}

/** Resume carries the queue plus the operator's optional continuation prompt. */
export function validateResumePhasePayload(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const type = CMD_RESUME_PHASE;
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(p, ['queueId', 'prompt'])) {
    return fail('unexpected-payload-fields', { type, correlationId });
  }
  const queueId = readQueueId(p);
  if (queueId === null) {
    return fail('invalid-queueId', { type, correlationId });
  }
  const prompt = p['prompt'];
  if (prompt !== undefined && (typeof prompt !== 'string' || prompt.length > PROMPT_MAX)) {
    return fail('invalid-prompt', { type, correlationId });
  }
  return ok({
    type,
    correlationId,
    payload: prompt === undefined ? { queueId } : { queueId, prompt }
  } as SidebarCommand);
}

/**
 * Feature 017 — phase-control commands that carry a single `phaseId` string,
 * widened by feature 093 to carry the addressed `queueId` alongside it.
 */
export type PhaseIdCommandType =
  | typeof CMD_RESTART_PHASE
  | typeof CMD_SKIP_PHASE
  | typeof CMD_DISABLE_PHASE
  | typeof CMD_ENABLE_PHASE;

export function validatePhaseIdPayload(
  type: PhaseIdCommandType,
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(p, ['queueId', 'phaseId'])) {
    return fail('unexpected-payload-fields', { type, correlationId });
  }
  const queueId = readQueueId(p);
  if (queueId === null) {
    return fail('invalid-queueId', { type, correlationId });
  }
  const phaseId = p['phaseId'];
  if (typeof phaseId !== 'string' || phaseId.length === 0 || phaseId.length > QUEUE_ID_MAX) {
    return fail('invalid-phaseId', { type, correlationId });
  }
  return ok({ type, correlationId, payload: { queueId, phaseId } } as SidebarCommand);
}

/** Feature 028 — phase breakpoint commands, queue-addressed since feature 093. */
export type PhaseBreakpointCommandType =
  | typeof CMD_SET_PHASE_BREAKPOINT
  | typeof CMD_CLEAR_PHASE_BREAKPOINT;

export function validatePhaseBreakpointPayload(
  type: PhaseBreakpointCommandType,
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(p, ['queueId', 'runId', 'phaseId'])) {
    return fail('unexpected-payload-fields', { type, correlationId });
  }
  const queueId = readQueueId(p);
  if (queueId === null) {
    return fail('invalid-queueId', { type, correlationId });
  }
  const runId = p['runId'];
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > QUEUE_ID_MAX) {
    return fail('invalid-runId', { type, correlationId });
  }
  const phaseId = p['phaseId'];
  if (typeof phaseId !== 'string' || phaseId.length === 0 || phaseId.length > QUEUE_ID_MAX) {
    return fail('invalid-phaseId', { type, correlationId });
  }
  return ok({ type, correlationId, payload: { queueId, runId, phaseId } } as SidebarCommand);
}
