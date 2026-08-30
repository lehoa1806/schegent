// Feature 092 (T034, US1) — inbound validators for the multi-queue
// management commands feature 030 removed alongside the commands themselves.
// Five remain today: feature 097 removes the two schedule commands
// (`CMD_SET_QUEUE_SCHEDULE` / `CMD_CLEAR_QUEUE_SCHEDULE`) and their validators,
// down from the seven this file originally shipped with.
//
// These parse untrusted webview input at the boundary; they do not re-implement
// any domain rule. Name uniqueness, position compaction and the deletion refusal
// order all stay behind the queue registry, which remains the single site that
// owns them. What happens here is type, presence and bound checking only, so a
// malformed message is refused before `MessageRouter` dispatches it.

import {
  CMD_CREATE_QUEUE,
  CMD_DELETE_QUEUE,
  CMD_MOVE_TASK,
  CMD_RENAME_QUEUE,
  CMD_SAVE_QUEUE_SETTINGS,
  type SidebarCommand
} from '../sidebar-ipc';
import { MAX_QUEUES } from '../queue-bounds';
import { MAX_QUEUE_NAME_LENGTH } from '../queue-bounds';
import { QUEUE_ID_MAX, fail, hasUnexpectedKeys, ok, type IpcValidationResult } from './shared';

type QueueCommandType =
  | typeof CMD_CREATE_QUEUE
  | typeof CMD_RENAME_QUEUE
  | typeof CMD_DELETE_QUEUE
  | typeof CMD_SAVE_QUEUE_SETTINGS
  | typeof CMD_MOVE_TASK;

/** Every command below requires a payload object; none accepts the empty form. */
function requirePayload(
  type: QueueCommandType,
  obj: Record<string, unknown>,
  correlationId: string,
  allowedKeys: readonly string[]
): { readonly p: Record<string, unknown> } | { readonly failure: IpcValidationResult } {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { failure: fail('missing-payload', { type, correlationId }) };
  }
  const p = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(p, allowedKeys)) {
    return { failure: fail('unexpected-payload-fields', { type, correlationId }) };
  }
  return { p };
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= QUEUE_ID_MAX;
}

/**
 * Trims the way the registry does, so a name that is only whitespace is
 * refused here rather than deeper in. The uniqueness rule is not checked —
 * that needs the registry and stays there.
 */
function validName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_QUEUE_NAME_LENGTH) return null;
  return trimmed;
}

export function validateCreateQueue(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const got = requirePayload(CMD_CREATE_QUEUE, obj, correlationId, ['name']);
  if ('failure' in got) return got.failure;
  const name = validName(got.p['name']);
  if (name === null) {
    return fail('invalid-queue-name', { type: CMD_CREATE_QUEUE, correlationId });
  }
  return ok({ type: CMD_CREATE_QUEUE, correlationId, payload: { name } } as SidebarCommand);
}

export function validateRenameQueue(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const got = requirePayload(CMD_RENAME_QUEUE, obj, correlationId, ['queueId', 'name']);
  if ('failure' in got) return got.failure;
  const queueId = got.p['queueId'];
  if (!isValidId(queueId)) {
    return fail('invalid-queueId', { type: CMD_RENAME_QUEUE, correlationId });
  }
  const name = validName(got.p['name']);
  if (name === null) {
    return fail('invalid-queue-name', { type: CMD_RENAME_QUEUE, correlationId });
  }
  return ok({
    type: CMD_RENAME_QUEUE,
    correlationId,
    payload: { queueId, name }
  } as SidebarCommand);
}

/**
 * Two-phase, like `CMD_REMOVE_TASK_PHASE`: the first round trip carries no
 * `confirmed` and asks the host for the deletion impact, so absence is legal
 * here and only an explicit non-`true` value is a defect.
 */
export function validateDeleteQueue(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const got = requirePayload(CMD_DELETE_QUEUE, obj, correlationId, ['queueId', 'confirmed']);
  if ('failure' in got) return got.failure;
  const queueId = got.p['queueId'];
  if (!isValidId(queueId)) {
    return fail('invalid-queueId', { type: CMD_DELETE_QUEUE, correlationId });
  }
  const confirmed = got.p['confirmed'];
  if (confirmed !== undefined && confirmed !== true) {
    return fail('invalid-confirmation', { type: CMD_DELETE_QUEUE, correlationId });
  }
  return ok({
    type: CMD_DELETE_QUEUE,
    correlationId,
    payload: { queueId, ...(confirmed === true ? { confirmed: true } : {}) }
  } as SidebarCommand);
}

/**
 * The cap's authoritative validator lives in `QueueManager.saveQueueSettings`
 * alongside the settings-schema contribution; `MAX_QUEUES` is used here as the
 * structural upper bound because no workspace can run more queues than exist.
 *
 * Feature 094 — the authority for the cap admitting any value above one is
 * `docs/architecture/local-queue-parallelism-ratification.md`, which narrows
 * one clause of the remote/multi-user expansion gate for the local
 * single-operator shape only and enumerates the premises whose change reopens
 * it. This is the IPC-boundary member of the three sites that enforce the
 * bound. Before feature 094 this site named where the bound came from but not
 * what permitted it to be wider than one.
 *
 * FR-R3-145 — there are no longer any sites that merely advertise the bound to
 * an operator. `package.json`, `config/settings-schema.ts` and
 * `config/general-settings.ts` described a configuration key that no scheduling
 * path read, and were removed with it. This validator sits on the path the value
 * actually travels: the Queue configuration surface posts
 * `CMD_SAVE_QUEUE_SETTINGS`, this refuses an out-of-range cap, and the workspace
 * memento is what the drain predicates then read.
 */
export function validateSaveQueueSettings(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const got = requirePayload(CMD_SAVE_QUEUE_SETTINGS, obj, correlationId, [
    'globalConcurrencyCap',
    'defaultQueueId'
  ]);
  if ('failure' in got) return got.failure;
  const cap = got.p['globalConcurrencyCap'];
  if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1 || cap > MAX_QUEUES) {
    return fail('invalid-concurrency-cap', { type: CMD_SAVE_QUEUE_SETTINGS, correlationId });
  }
  const defaultQueueId = got.p['defaultQueueId'];
  if (!isValidId(defaultQueueId)) {
    return fail('invalid-queueId', { type: CMD_SAVE_QUEUE_SETTINGS, correlationId });
  }
  return ok({
    type: CMD_SAVE_QUEUE_SETTINGS,
    correlationId,
    payload: { globalConcurrencyCap: cap, defaultQueueId }
  } as SidebarCommand);
}

export function validateMoveTask(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const got = requirePayload(CMD_MOVE_TASK, obj, correlationId, [
    'taskId',
    'targetQueueId',
    'position'
  ]);
  if ('failure' in got) return got.failure;
  const taskId = got.p['taskId'];
  if (!isValidId(taskId)) {
    return fail('invalid-taskId', { type: CMD_MOVE_TASK, correlationId });
  }
  const targetQueueId = got.p['targetQueueId'];
  if (!isValidId(targetQueueId)) {
    return fail('invalid-queueId', { type: CMD_MOVE_TASK, correlationId });
  }
  const position = got.p['position'];
  if (
    position !== undefined &&
    (typeof position !== 'number' || !Number.isInteger(position) || position < 0)
  ) {
    return fail('invalid-position', { type: CMD_MOVE_TASK, correlationId });
  }
  return ok({
    type: CMD_MOVE_TASK,
    correlationId,
    payload: { taskId, targetQueueId, ...(position !== undefined ? { position } : {}) }
  } as SidebarCommand);
}
