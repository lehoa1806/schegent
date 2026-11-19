// Differential equivalence test suite for FR-R7-05 (FR-003, SC-001).
//
// Pinned BEFORE migrating `validateInboundMessage` to descriptor-generated
// validators, then run unchanged against the generated validators to prove
// identical accept/reject decisions, normalized payloads, and exact failure
// reason codes across all 71 inbound commands (valid, boundary, and hostile
// inputs per field).

import { describe, expect, it } from 'vitest';
import { COMMAND_TYPES, type CommandType } from '../../../src/contracts/sidebar-ipc';
import { validateInboundMessage } from '../../../src/contracts/runtime-validators';

interface DifferentialCase {
  readonly label: string;
  readonly raw: Record<string, unknown>;
  readonly expected:
    | { readonly ok: true; readonly payload?: unknown; readonly hasPayloadKey?: boolean }
    | { readonly ok: false; readonly reason: string };
}

const CID = 'corr-diff-1';
const STR_64 = 'a'.repeat(64);
const STR_65 = 'a'.repeat(65);
const STR_128 = 'b'.repeat(128);
const STR_129 = 'b'.repeat(129);
const STR_256 = 'c'.repeat(256);
const STR_257 = 'c'.repeat(257);
const STR_500 = 'd'.repeat(500);
const STR_501 = 'd'.repeat(501);
const STR_512 = 'e'.repeat(512);
const STR_513 = 'e'.repeat(513);
const STR_4096 = 'f'.repeat(4096);
const STR_4097 = 'f'.repeat(4097);

const MIN_RUN_REQUEST = {
  pipelineId: 'default',
  inputs: [],
  supplemental: [],
  outputs: []
};

const VALID_SELECTION_READ = {
  queueId: 'default',
  taskId: 'task-1',
  pipelineId: 'pipe-1',
  phaseId: 'phase-1',
  iterationN: null
};

const VALID_SELECTION_TAIL = {
  queueId: 'default',
  taskId: 'task-1',
  pipelineId: 'pipe-1',
  phaseId: 'phase-1',
  iterationN: 1
};

const msg = (type: CommandType, payload?: unknown): Record<string, unknown> =>
  payload === undefined ? { type, correlationId: CID } : { type, correlationId: CID, payload };

const CORPUS: Readonly<Record<CommandType, readonly DifferentialCase[]>> = {
  // ---- Family 1: queue-core (15) --------------------------------------------
  CMD_START: [
    {
      label: 'valid trimmed minimal',
      raw: msg('CMD_START', { description: '  Build feature  ' }),
      expected: { ok: true, payload: { description: 'Build feature' } }
    },
    {
      label: 'valid maximal with startIntent',
      raw: msg('CMD_START', {
        description: STR_4096,
        pipelineId: 'p1',
        queueId: STR_256,
        position: 0,
        startIntent: { startMode: 'now', source: 'operator-chooser' }
      }),
      expected: {
        ok: true,
        payload: {
          description: STR_4096,
          pipelineId: 'p1',
          queueId: STR_256,
          position: 0,
          startIntent: { startMode: 'now', source: 'operator-chooser' }
        }
      }
    },
    { label: 'missing payload', raw: msg('CMD_START'), expected: { ok: false, reason: 'missing-payload' } },
    { label: 'extra field', raw: msg('CMD_START', { description: 'ok', extra: 1 }), expected: { ok: false, reason: 'unexpected-payload-fields' } },
    { label: 'non-string description', raw: msg('CMD_START', { description: 42 }), expected: { ok: false, reason: 'description-not-string' } },
    { label: 'whitespace description', raw: msg('CMD_START', { description: '   ' }), expected: { ok: false, reason: 'description-out-of-range' } },
    { label: 'over-length description', raw: msg('CMD_START', { description: STR_4097 }), expected: { ok: false, reason: 'description-out-of-range' } },
    { label: 'bad pipelineId', raw: msg('CMD_START', { description: 'ok', pipelineId: 1 }), expected: { ok: false, reason: 'pipelineId-not-string' } },
    { label: 'over-length queueId', raw: msg('CMD_START', { description: 'ok', queueId: STR_257 }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'negative position', raw: msg('CMD_START', { description: 'ok', position: -1 }), expected: { ok: false, reason: 'invalid-position' } },
    { label: 'hostile startIntent', raw: msg('CMD_START', { description: 'ok', startIntent: { startMode: 'scheduled', source: 'system-rate-limit-recovery', scheduledStartAt: 100 } }), expected: { ok: false, reason: 'invalid-start-intent' } }
  ],

  CMD_CANCEL: [
    { label: 'valid boundary', raw: msg('CMD_CANCEL', { taskId: STR_256 }), expected: { ok: true, payload: { taskId: STR_256 } } },
    { label: 'over-length taskId', raw: msg('CMD_CANCEL', { taskId: STR_257 }), expected: { ok: false, reason: 'invalid-taskId' } },
    { label: 'extra field', raw: msg('CMD_CANCEL', { taskId: 't1', x: 1 }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_REMOVE_QUEUE_ITEM: [
    { label: 'valid confirmed', raw: msg('CMD_REMOVE_QUEUE_ITEM', { id: STR_256, confirmed: true }), expected: { ok: true, payload: { id: STR_256, confirmed: true } } },
    { label: 'missing confirmation', raw: msg('CMD_REMOVE_QUEUE_ITEM', { id: 'q1', confirmed: false }), expected: { ok: false, reason: 'missing-confirmation' } },
    { label: 'empty id', raw: msg('CMD_REMOVE_QUEUE_ITEM', { id: '', confirmed: true }), expected: { ok: false, reason: 'invalid-id' } },
    { label: 'extra field', raw: msg('CMD_REMOVE_QUEUE_ITEM', { id: 'q1', confirmed: true, x: 1 }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_RETRY_QUEUE_ITEM: [
    { label: 'valid', raw: msg('CMD_RETRY_QUEUE_ITEM', { id: STR_256 }), expected: { ok: true, payload: { id: STR_256 } } },
    { label: 'over-length id', raw: msg('CMD_RETRY_QUEUE_ITEM', { id: STR_257 }), expected: { ok: false, reason: 'invalid-id' } },
    { label: 'missing payload', raw: msg('CMD_RETRY_QUEUE_ITEM'), expected: { ok: false, reason: 'missing-payload' } }
  ],

  CMD_MOVE_QUEUE_ITEM_UP: [
    { label: 'valid', raw: msg('CMD_MOVE_QUEUE_ITEM_UP', { id: 'item-1' }), expected: { ok: true, payload: { id: 'item-1' } } },
    { label: 'empty id', raw: msg('CMD_MOVE_QUEUE_ITEM_UP', { id: '' }), expected: { ok: false, reason: 'invalid-id' } },
    { label: 'extra field', raw: msg('CMD_MOVE_QUEUE_ITEM_UP', { id: 'item-1', extra: true }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_MOVE_QUEUE_ITEM_DOWN: [
    { label: 'valid', raw: msg('CMD_MOVE_QUEUE_ITEM_DOWN', { id: 'item-1' }), expected: { ok: true, payload: { id: 'item-1' } } },
    { label: 'non-string id', raw: msg('CMD_MOVE_QUEUE_ITEM_DOWN', { id: 123 }), expected: { ok: false, reason: 'invalid-id' } }
  ],

  CMD_PAUSE_QUEUE: [
    { label: 'no payload', raw: msg('CMD_PAUSE_QUEUE'), expected: { ok: true, hasPayloadKey: false } },
    { label: 'empty object payload', raw: msg('CMD_PAUSE_QUEUE', {}), expected: { ok: true, payload: undefined } },
    { label: 'valid boundary reason', raw: msg('CMD_PAUSE_QUEUE', { queueId: 'default', reason: STR_500 }), expected: { ok: true, payload: { queueId: 'default', reason: STR_500 } } },
    { label: 'null payload', raw: msg('CMD_PAUSE_QUEUE', null), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'reason too long', raw: msg('CMD_PAUSE_QUEUE', { reason: STR_501 }), expected: { ok: false, reason: 'reason-too-long' } },
    { label: 'reason non-string', raw: msg('CMD_PAUSE_QUEUE', { reason: 42 }), expected: { ok: false, reason: 'reason-not-string' } },
    { label: 'bad queueId', raw: msg('CMD_PAUSE_QUEUE', { queueId: '' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'extra field', raw: msg('CMD_PAUSE_QUEUE', { extra: 1 }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_RESUME_QUEUE: [
    { label: 'no payload', raw: msg('CMD_RESUME_QUEUE'), expected: { ok: true, hasPayloadKey: false } },
    { label: 'valid queueId', raw: msg('CMD_RESUME_QUEUE', { queueId: 'default' }), expected: { ok: true, payload: { queueId: 'default' } } },
    { label: 'empty object', raw: msg('CMD_RESUME_QUEUE', {}), expected: { ok: true, payload: undefined } },
    { label: 'rejects unaccepted prompt field', raw: msg('CMD_RESUME_QUEUE', { queueId: 'default', prompt: 'hi' }), expected: { ok: false, reason: 'unexpected-payload-fields' } },
    { label: 'bad queueId', raw: msg('CMD_RESUME_QUEUE', { queueId: STR_257 }), expected: { ok: false, reason: 'invalid-queueId' } }
  ],

  CMD_START_QUEUE: [
    { label: 'absent payload yields empty obj', raw: msg('CMD_START_QUEUE'), expected: { ok: true, payload: {} } },
    { label: 'empty obj', raw: msg('CMD_START_QUEUE', {}), expected: { ok: true, payload: {} } },
    { label: 'valid with queueId + intent', raw: msg('CMD_START_QUEUE', { queueId: 'q1', startIntent: { startMode: 'cancel-schedule', source: 'operator-restart' } }), expected: { ok: true, payload: { queueId: 'q1', startIntent: { startMode: 'cancel-schedule', source: 'operator-restart' } } } },
    { label: 'array payload rejected', raw: msg('CMD_START_QUEUE', []), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'extra key', raw: msg('CMD_START_QUEUE', { queueID: 'q1' }), expected: { ok: false, reason: 'unexpected-payload-fields' } },
    { label: 'invalid intent', raw: msg('CMD_START_QUEUE', { startIntent: { startMode: 'leave-pending', source: 'operator-immediate' } }), expected: { ok: false, reason: 'invalid-start-intent' } }
  ],

  CMD_CLEAR_COMPLETED: [
    { label: 'valid', raw: msg('CMD_CLEAR_COMPLETED', { queueId: 'default' }), expected: { ok: true, payload: { queueId: 'default' } } },
    { label: 'empty queueId', raw: msg('CMD_CLEAR_COMPLETED', { queueId: '' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'missing payload', raw: msg('CMD_CLEAR_COMPLETED'), expected: { ok: false, reason: 'missing-payload' } }
  ],

  CMD_CLEAR_QUEUE: [
    { label: 'valid', raw: msg('CMD_CLEAR_QUEUE', { queueId: STR_256 }), expected: { ok: true, payload: { queueId: STR_256 } } },
    { label: 'over-length queueId', raw: msg('CMD_CLEAR_QUEUE', { queueId: STR_257 }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'extra key', raw: msg('CMD_CLEAR_QUEUE', { queueId: 'default', force: true }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_MODIFY_TASK: [
    { label: 'valid trimmed', raw: msg('CMD_MODIFY_TASK', { taskId: 't1', description: '  edited  ' }), expected: { ok: true, payload: { taskId: 't1', description: 'edited' } } },
    { label: 'bad taskId', raw: msg('CMD_MODIFY_TASK', { taskId: '', description: 'ok' }), expected: { ok: false, reason: 'invalid-taskId' } },
    { label: 'non-string desc', raw: msg('CMD_MODIFY_TASK', { taskId: 't1', description: null }), expected: { ok: false, reason: 'description-not-string' } },
    { label: 'over-length desc', raw: msg('CMD_MODIFY_TASK', { taskId: 't1', description: STR_4097 }), expected: { ok: false, reason: 'description-out-of-range' } }
  ],

  CMD_REORDER_TASK: [
    { label: 'valid zero pos', raw: msg('CMD_REORDER_TASK', { taskId: 't1', newPosition: 0 }), expected: { ok: true, payload: { taskId: 't1', newPosition: 0 } } },
    { label: 'negative pos', raw: msg('CMD_REORDER_TASK', { taskId: 't1', newPosition: -1 }), expected: { ok: false, reason: 'invalid-position' } },
    { label: 'float pos', raw: msg('CMD_REORDER_TASK', { taskId: 't1', newPosition: 1.5 }), expected: { ok: false, reason: 'invalid-position' } }
  ],

  CMD_RESTART_CANCELED_TASK: [
    { label: 'valid', raw: msg('CMD_RESTART_CANCELED_TASK', { taskId: 't1' }), expected: { ok: true, payload: { taskId: 't1' } } },
    { label: 'empty taskId', raw: msg('CMD_RESTART_CANCELED_TASK', { taskId: '' }), expected: { ok: false, reason: 'invalid-taskId' } }
  ],

  CMD_REMOVE_TASK_PHASE: [
    { label: 'valid', raw: msg('CMD_REMOVE_TASK_PHASE', { taskId: 't1', phaseId: 'p1', confirmed: true }), expected: { ok: true, payload: { taskId: 't1', phaseId: 'p1', confirmed: true } } },
    { label: 'bad phaseId', raw: msg('CMD_REMOVE_TASK_PHASE', { taskId: 't1', phaseId: '', confirmed: true }), expected: { ok: false, reason: 'invalid-phaseId' } },
    { label: 'missing confirmation', raw: msg('CMD_REMOVE_TASK_PHASE', { taskId: 't1', phaseId: 'p1' }), expected: { ok: false, reason: 'missing-confirmation' } }
  ],

  // ---- Family 2: queue-management (7) ---------------------------------------
  CMD_CREATE_QUEUE: [
    { label: 'valid trimmed', raw: msg('CMD_CREATE_QUEUE', { name: '  Alpha  ' }), expected: { ok: true, payload: { name: 'Alpha' } } },
    { label: 'boundary 64', raw: msg('CMD_CREATE_QUEUE', { name: STR_64 }), expected: { ok: true, payload: { name: STR_64 } } },
    { label: 'over-length 65', raw: msg('CMD_CREATE_QUEUE', { name: STR_65 }), expected: { ok: false, reason: 'invalid-queue-name' } },
    { label: 'whitespace only', raw: msg('CMD_CREATE_QUEUE', { name: '   ' }), expected: { ok: false, reason: 'invalid-queue-name' } },
    { label: 'array payload', raw: msg('CMD_CREATE_QUEUE', []), expected: { ok: false, reason: 'missing-payload' } }
  ],

  CMD_RENAME_QUEUE: [
    { label: 'valid', raw: msg('CMD_RENAME_QUEUE', { queueId: 'q1', name: ' Beta ' }), expected: { ok: true, payload: { queueId: 'q1', name: 'Beta' } } },
    { label: 'bad queueId', raw: msg('CMD_RENAME_QUEUE', { queueId: '', name: 'Beta' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'bad name', raw: msg('CMD_RENAME_QUEUE', { queueId: 'q1', name: '' }), expected: { ok: false, reason: 'invalid-queue-name' } }
  ],

  CMD_DELETE_QUEUE: [
    { label: 'valid preview (no confirmed)', raw: msg('CMD_DELETE_QUEUE', { queueId: 'q1' }), expected: { ok: true, payload: { queueId: 'q1' } } },
    { label: 'valid confirmed', raw: msg('CMD_DELETE_QUEUE', { queueId: 'q1', confirmed: true }), expected: { ok: true, payload: { queueId: 'q1', confirmed: true } } },
    { label: 'confirmed false rejected', raw: msg('CMD_DELETE_QUEUE', { queueId: 'q1', confirmed: false }), expected: { ok: false, reason: 'invalid-confirmation' } },
    { label: 'bad queueId', raw: msg('CMD_DELETE_QUEUE', { queueId: STR_257 }), expected: { ok: false, reason: 'invalid-queueId' } }
  ],

  CMD_SAVE_QUEUE_SETTINGS: [
    { label: 'valid min/max', raw: msg('CMD_SAVE_QUEUE_SETTINGS', { globalConcurrencyCap: 20, defaultQueueId: 'default' }), expected: { ok: true, payload: { globalConcurrencyCap: 20, defaultQueueId: 'default' } } },
    { label: 'cap 0 rejected', raw: msg('CMD_SAVE_QUEUE_SETTINGS', { globalConcurrencyCap: 0, defaultQueueId: 'default' }), expected: { ok: false, reason: 'invalid-concurrency-cap' } },
    { label: 'cap 21 rejected', raw: msg('CMD_SAVE_QUEUE_SETTINGS', { globalConcurrencyCap: 21, defaultQueueId: 'default' }), expected: { ok: false, reason: 'invalid-concurrency-cap' } },
    { label: 'bad defaultQueueId', raw: msg('CMD_SAVE_QUEUE_SETTINGS', { globalConcurrencyCap: 2, defaultQueueId: '' }), expected: { ok: false, reason: 'invalid-queueId' } }
  ],

  CMD_SET_QUEUE_FAILURE_POLICY: [
    { label: 'valid halt-on-failure', raw: msg('CMD_SET_QUEUE_FAILURE_POLICY', { queueId: 'q1', policy: 'halt-on-failure' }), expected: { ok: true, payload: { queueId: 'q1', policy: 'halt-on-failure' } } },
    { label: 'valid null', raw: msg('CMD_SET_QUEUE_FAILURE_POLICY', { queueId: 'q1', policy: null }), expected: { ok: true, payload: { queueId: 'q1', policy: null } } },
    { label: 'unknown policy', raw: msg('CMD_SET_QUEUE_FAILURE_POLICY', { queueId: 'q1', policy: 'ignore' }), expected: { ok: false, reason: 'invalid-failure-policy' } }
  ],

  CMD_ATTEST_TASK_COMPLETED: [
    { label: 'valid', raw: msg('CMD_ATTEST_TASK_COMPLETED', { taskId: 't1', confirmed: true }), expected: { ok: true, payload: { taskId: 't1', confirmed: true } } },
    { label: 'coerced confirmation rejected', raw: msg('CMD_ATTEST_TASK_COMPLETED', { taskId: 't1', confirmed: 'yes' }), expected: { ok: false, reason: 'missing-confirmation' } },
    { label: 'empty taskId', raw: msg('CMD_ATTEST_TASK_COMPLETED', { taskId: '', confirmed: true }), expected: { ok: false, reason: 'invalid-taskId' } }
  ],

  CMD_MOVE_TASK: [
    { label: 'valid minimal', raw: msg('CMD_MOVE_TASK', { taskId: 't1', targetQueueId: 'q2' }), expected: { ok: true, payload: { taskId: 't1', targetQueueId: 'q2' } } },
    { label: 'valid with position', raw: msg('CMD_MOVE_TASK', { taskId: 't1', targetQueueId: 'q2', position: 0 }), expected: { ok: true, payload: { taskId: 't1', targetQueueId: 'q2', position: 0 } } },
    { label: 'bad targetQueueId', raw: msg('CMD_MOVE_TASK', { taskId: 't1', targetQueueId: '' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'bad position', raw: msg('CMD_MOVE_TASK', { taskId: 't1', targetQueueId: 'q2', position: -2 }), expected: { ok: false, reason: 'invalid-position' } }
  ],

  // ---- Family 3: phase-control (9) ------------------------------------------
  CMD_RETRY_PHASE_NOW: [
    { label: 'valid', raw: msg('CMD_RETRY_PHASE_NOW', { queueId: 'default' }), expected: { ok: true, payload: { queueId: 'default' } } },
    { label: 'empty queueId', raw: msg('CMD_RETRY_PHASE_NOW', { queueId: '' }), expected: { ok: false, reason: 'invalid-queueId' } }
  ],

  CMD_PAUSE_PHASE: [
    { label: 'valid', raw: msg('CMD_PAUSE_PHASE', { queueId: 'default' }), expected: { ok: true, payload: { queueId: 'default' } } },
    { label: 'extra key', raw: msg('CMD_PAUSE_PHASE', { queueId: 'default', x: 1 }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_RESUME_PHASE: [
    { label: 'valid minimal', raw: msg('CMD_RESUME_PHASE', { queueId: 'default' }), expected: { ok: true, payload: { queueId: 'default' } } },
    { label: 'valid empty prompt', raw: msg('CMD_RESUME_PHASE', { queueId: 'default', prompt: '' }), expected: { ok: true, payload: { queueId: 'default', prompt: '' } } },
    { label: 'valid max prompt', raw: msg('CMD_RESUME_PHASE', { queueId: 'default', prompt: STR_4096 }), expected: { ok: true, payload: { queueId: 'default', prompt: STR_4096 } } },
    { label: 'over-length prompt', raw: msg('CMD_RESUME_PHASE', { queueId: 'default', prompt: STR_4097 }), expected: { ok: false, reason: 'invalid-prompt' } }
  ],

  CMD_RESTART_PHASE: [
    { label: 'valid', raw: msg('CMD_RESTART_PHASE', { queueId: 'default', phaseId: 'plan' }), expected: { ok: true, payload: { queueId: 'default', phaseId: 'plan' } } },
    { label: 'empty phaseId', raw: msg('CMD_RESTART_PHASE', { queueId: 'default', phaseId: '' }), expected: { ok: false, reason: 'invalid-phaseId' } }
  ],

  CMD_SKIP_PHASE: [
    { label: 'valid', raw: msg('CMD_SKIP_PHASE', { queueId: 'default', runId: 'r1', phaseId: 'plan' }), expected: { ok: true, payload: { queueId: 'default', runId: 'r1', phaseId: 'plan' } } },
    { label: 'empty runId', raw: msg('CMD_SKIP_PHASE', { queueId: 'default', runId: '', phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-runId' } }
  ],

  CMD_DISABLE_PHASE: [
    { label: 'valid', raw: msg('CMD_DISABLE_PHASE', { queueId: 'default', phaseId: 'plan' }), expected: { ok: true, payload: { queueId: 'default', phaseId: 'plan' } } },
    { label: 'bad queueId', raw: msg('CMD_DISABLE_PHASE', { queueId: '', phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-queueId' } }
  ],

  CMD_ENABLE_PHASE: [
    { label: 'valid', raw: msg('CMD_ENABLE_PHASE', { queueId: 'default', phaseId: 'plan' }), expected: { ok: true, payload: { queueId: 'default', phaseId: 'plan' } } },
    { label: 'bad phaseId', raw: msg('CMD_ENABLE_PHASE', { queueId: 'default', phaseId: STR_257 }), expected: { ok: false, reason: 'invalid-phaseId' } }
  ],

  CMD_SET_PHASE_BREAKPOINT: [
    { label: 'valid', raw: msg('CMD_SET_PHASE_BREAKPOINT', { queueId: 'default', runId: 'r1', phaseId: 'plan' }), expected: { ok: true, payload: { queueId: 'default', runId: 'r1', phaseId: 'plan' } } },
    { label: 'bad runId', raw: msg('CMD_SET_PHASE_BREAKPOINT', { queueId: 'default', runId: 12, phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-runId' } }
  ],

  CMD_CLEAR_PHASE_BREAKPOINT: [
    { label: 'valid', raw: msg('CMD_CLEAR_PHASE_BREAKPOINT', { queueId: 'default', runId: 'r1', phaseId: 'plan' }), expected: { ok: true, payload: { queueId: 'default', runId: 'r1', phaseId: 'plan' } } },
    { label: 'extra key', raw: msg('CMD_CLEAR_PHASE_BREAKPOINT', { queueId: 'default', runId: 'r1', phaseId: 'plan', extra: 1 }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  // ---- Family 4: navigation-settings (10) -----------------------------------
  CMD_OPEN_AUDIT_LOG: [
    { label: 'valid', raw: msg('CMD_OPEN_AUDIT_LOG'), expected: { ok: true, hasPayloadKey: false } },
    { label: 'unexpected payload', raw: msg('CMD_OPEN_AUDIT_LOG', {}), expected: { ok: false, reason: 'unexpected-payload' } }
  ],

  CMD_OPEN_DASHBOARD: [
    { label: 'valid', raw: msg('CMD_OPEN_DASHBOARD'), expected: { ok: true, hasPayloadKey: false } },
    { label: 'unexpected payload', raw: msg('CMD_OPEN_DASHBOARD', { a: 1 }), expected: { ok: false, reason: 'unexpected-payload' } }
  ],

  CMD_OPEN_VERBOSE_SETTING: [
    { label: 'valid', raw: msg('CMD_OPEN_VERBOSE_SETTING'), expected: { ok: true, hasPayloadKey: false } },
    { label: 'unexpected payload', raw: msg('CMD_OPEN_VERBOSE_SETTING', 'x'), expected: { ok: false, reason: 'unexpected-payload' } }
  ],

  CMD_OPEN_TRUST_SETTINGS: [
    { label: 'valid', raw: msg('CMD_OPEN_TRUST_SETTINGS'), expected: { ok: true, hasPayloadKey: false } },
    { label: 'unexpected payload', raw: msg('CMD_OPEN_TRUST_SETTINGS', { key: 'x' }), expected: { ok: false, reason: 'unexpected-payload' } }
  ],

  CMD_DISMISS_MIGRATION_NOTICE: [
    { label: 'valid', raw: msg('CMD_DISMISS_MIGRATION_NOTICE'), expected: { ok: true, hasPayloadKey: false } },
    { label: 'unexpected payload', raw: msg('CMD_DISMISS_MIGRATION_NOTICE', {}), expected: { ok: false, reason: 'unexpected-payload' } }
  ],

  CMD_SET_CONFIRM_SUPPRESSION: [
    { label: 'valid', raw: msg('CMD_SET_CONFIRM_SUPPRESSION', { actionKey: 'queue.clean-all', suppressed: true }), expected: { ok: true, payload: { actionKey: 'queue.clean-all', suppressed: true } } },
    { label: 'non-boolean suppressed', raw: msg('CMD_SET_CONFIRM_SUPPRESSION', { actionKey: 'k', suppressed: 'true' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'missing payload', raw: msg('CMD_SET_CONFIRM_SUPPRESSION'), expected: { ok: false, reason: 'invalid-payload' } }
  ],

  CMD_SAVE_MODELS: [
    { label: 'valid manual', raw: msg('CMD_SAVE_MODELS', { models: { claude: ['sonnet'] } }), expected: { ok: true, payload: { models: { claude: ['sonnet'] } } } },
    { label: 'valid import with revision & mutation', raw: msg('CMD_SAVE_MODELS', { models: { agy: ['m1'] }, expectedRevision: 'r1', mutation: { kind: 'import-package' } }), expected: { ok: true, payload: { models: { agy: ['m1'] }, expectedRevision: 'r1', mutation: { kind: 'import-package' } } } },
    { label: 'empty model string rejected', raw: msg('CMD_SAVE_MODELS', { models: { claude: [''] } }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'array models rejected', raw: msg('CMD_SAVE_MODELS', { models: [] }), expected: { ok: false, reason: 'invalid-payload' } }
  ],

  CMD_SAVE_GENERAL_SETTINGS: [
    { label: 'valid', raw: msg('CMD_SAVE_GENERAL_SETTINGS', { updates: { 'logging.verbose': true } }), expected: { ok: true, payload: { updates: { 'logging.verbose': true } } } },
    { label: 'array updates rejected', raw: msg('CMD_SAVE_GENERAL_SETTINGS', { updates: [] }), expected: { ok: false, reason: 'invalid-updates' } },
    { label: 'extra key', raw: msg('CMD_SAVE_GENERAL_SETTINGS', { updates: {}, extra: 1 }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_PING_BACKEND: [
    { label: 'valid claude', raw: msg('CMD_PING_BACKEND', { runner: 'claude' }), expected: { ok: true, payload: { runner: 'claude' } } },
    { label: 'valid agy', raw: msg('CMD_PING_BACKEND', { runner: 'agy' }), expected: { ok: true, payload: { runner: 'agy' } } },
    { label: 'unknown runner', raw: msg('CMD_PING_BACKEND', { runner: 'other' }), expected: { ok: false, reason: 'invalid-runner' } },
    { label: 'extra field', raw: msg('CMD_PING_BACKEND', { runner: 'claude', extra: 1 }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_SET_UNCONTAINED_BACKEND_GRANT: [
    { label: 'valid grant', raw: msg('CMD_SET_UNCONTAINED_BACKEND_GRANT', { kind: 'codex', granted: true }), expected: { ok: true, payload: { kind: 'codex', granted: true } } },
    { label: 'bad kind', raw: msg('CMD_SET_UNCONTAINED_BACKEND_GRANT', { kind: 'nope', granted: true }), expected: { ok: false, reason: 'invalid-backend-kind' } },
    { label: 'string granted rejected', raw: msg('CMD_SET_UNCONTAINED_BACKEND_GRANT', { kind: 'claude', granted: 'true' }), expected: { ok: false, reason: 'invalid-granted' } }
  ],

  // ---- Family 5: history-evidence (6) ---------------------------------------
  CMD_RERUN_FROM_HISTORY: [
    { label: 'valid minimal', raw: msg('CMD_RERUN_FROM_HISTORY', { runId: 'r1' }), expected: { ok: true, payload: { runId: 'r1' } } },
    { label: 'valid force false omitted', raw: msg('CMD_RERUN_FROM_HISTORY', { runId: 'r1', force: false }), expected: { ok: true, payload: { runId: 'r1' } } },
    { label: 'valid force true kept', raw: msg('CMD_RERUN_FROM_HISTORY', { runId: 'r1', force: true }), expected: { ok: true, payload: { runId: 'r1', force: true } } },
    { label: 'force non-boolean', raw: msg('CMD_RERUN_FROM_HISTORY', { runId: 'r1', force: 'yes' }), expected: { ok: false, reason: 'force-not-boolean' } },
    { label: 'bad runId', raw: msg('CMD_RERUN_FROM_HISTORY', { runId: '' }), expected: { ok: false, reason: 'invalid-runId' } }
  ],

  CMD_OPEN_HISTORY_ITEM_DETAILS: [
    { label: 'valid', raw: msg('CMD_OPEN_HISTORY_ITEM_DETAILS', { id: 'h1' }), expected: { ok: true, payload: { id: 'h1' } } },
    { label: 'empty id', raw: msg('CMD_OPEN_HISTORY_ITEM_DETAILS', { id: '' }), expected: { ok: false, reason: 'invalid-id' } }
  ],

  CMD_RESOLVE_AUDIT_POINTER: [
    { label: 'valid', raw: msg('CMD_RESOLVE_AUDIT_POINTER', { runId: 'r1' }), expected: { ok: true, payload: { runId: 'r1' } } },
    { label: 'over-length runId', raw: msg('CMD_RESOLVE_AUDIT_POINTER', { runId: STR_257 }), expected: { ok: false, reason: 'invalid-runId' } }
  ],

  CMD_RESOLVE_HISTORY_DESCRIPTION: [
    { label: 'valid', raw: msg('CMD_RESOLVE_HISTORY_DESCRIPTION', { runId: 'r1' }), expected: { ok: true, payload: { runId: 'r1' } } },
    { label: 'extra key', raw: msg('CMD_RESOLVE_HISTORY_DESCRIPTION', { runId: 'r1', path: '/etc' }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_READ_FAILURE_RECORD: [
    { label: 'valid boundary 128', raw: msg('CMD_READ_FAILURE_RECORD', { queueId: STR_128, taskId: 'task-1' }), expected: { ok: true, payload: { queueId: STR_128, taskId: 'task-1' } } },
    { label: 'traversal rejected', raw: msg('CMD_READ_FAILURE_RECORD', { queueId: '..', taskId: 'task-1' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'over-length 129 rejected', raw: msg('CMD_READ_FAILURE_RECORD', { queueId: 'q1', taskId: STR_129 }), expected: { ok: false, reason: 'invalid-taskId' } }
  ],

  CMD_OPEN_DECISION_RECORD: [
    { label: 'valid', raw: msg('CMD_OPEN_DECISION_RECORD', { rowId: 'row_1.a-b' }), expected: { ok: true, payload: { rowId: 'row_1.a-b' } } },
    { label: 'path traversal rejected', raw: msg('CMD_OPEN_DECISION_RECORD', { rowId: '../secret' }), expected: { ok: false, reason: 'invalid-rowId' } },
    { label: 'extra key', raw: msg('CMD_OPEN_DECISION_RECORD', { rowId: 'row1', extra: 1 }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  // ---- Family 6: catalog (9) ------------------------------------------------
  CMD_SAVE_DEFINITION_DRAFT: [
    { label: 'valid null body with note', raw: msg('CMD_SAVE_DEFINITION_DRAFT', { kind: 'phase', id: 'p1', expectedDraftVersion: 'no-draft', body: null, note: STR_512 }), expected: { ok: true, payload: { kind: 'phase', id: 'p1', expectedDraftVersion: 'no-draft', body: null, note: STR_512 } } },
    { label: 'missing body rejected', raw: msg('CMD_SAVE_DEFINITION_DRAFT', { kind: 'phase', id: 'p1', expectedDraftVersion: 'no-draft' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'note 513 rejected', raw: msg('CMD_SAVE_DEFINITION_DRAFT', { kind: 'phase', id: 'p1', expectedDraftVersion: 'no-draft', body: {}, note: STR_513 }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'missing payload', raw: msg('CMD_SAVE_DEFINITION_DRAFT'), expected: { ok: false, reason: 'missing-payload' } }
  ],

  CMD_PUBLISH_DEFINITION: [
    { label: 'valid pipeline kind', raw: msg('CMD_PUBLISH_DEFINITION', { kind: 'pipeline', id: 'p1', expectedDraftVersion: 'v1' }), expected: { ok: true, payload: { kind: 'pipeline', id: 'p1', expectedDraftVersion: 'v1' } } },
    { label: 'missing payload collapses to invalid-payload', raw: msg('CMD_PUBLISH_DEFINITION'), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'bad kind', raw: msg('CMD_PUBLISH_DEFINITION', { kind: 'bogus', id: 'p1', expectedDraftVersion: 'v1' }), expected: { ok: false, reason: 'invalid-payload' } }
  ],

  CMD_DEACTIVATE_DEFINITION: [
    { label: 'valid', raw: msg('CMD_DEACTIVATE_DEFINITION', { kind: 'workflow', id: 'w1', expectedDraftVersion: 'v2' }), expected: { ok: true, payload: { kind: 'workflow', id: 'w1', expectedDraftVersion: 'v2' } } },
    { label: 'extra key', raw: msg('CMD_DEACTIVATE_DEFINITION', { kind: 'workflow', id: 'w1', expectedDraftVersion: 'v2', x: 1 }), expected: { ok: false, reason: 'invalid-payload' } }
  ],

  CMD_RESTORE_DEFINITION_VERSION: [
    { label: 'valid', raw: msg('CMD_RESTORE_DEFINITION_VERSION', { kind: 'phase', id: 'p1', expectedDraftVersion: 'no-draft', fromVersionId: 'v1' }), expected: { ok: true, payload: { kind: 'phase', id: 'p1', expectedDraftVersion: 'no-draft', fromVersionId: 'v1' } } },
    { label: 'missing payload', raw: msg('CMD_RESTORE_DEFINITION_VERSION'), expected: { ok: false, reason: 'missing-payload' } },
    { label: 'empty fromVersionId', raw: msg('CMD_RESTORE_DEFINITION_VERSION', { kind: 'phase', id: 'p1', expectedDraftVersion: 'no-draft', fromVersionId: '' }), expected: { ok: false, reason: 'invalid-payload' } }
  ],

  CMD_DISCARD_DEFINITION_DRAFT: [
    { label: 'valid', raw: msg('CMD_DISCARD_DEFINITION_DRAFT', { kind: 'phase', id: 'p1', expectedDraftVersion: 'v1' }), expected: { ok: true, payload: { kind: 'phase', id: 'p1', expectedDraftVersion: 'v1' } } },
    { label: 'missing payload', raw: msg('CMD_DISCARD_DEFINITION_DRAFT'), expected: { ok: false, reason: 'invalid-payload' } }
  ],

  CMD_PUBLISH_PACKAGE: [
    { label: 'valid layer', raw: msg('CMD_PUBLISH_PACKAGE', { layers: [{ kind: 'phase', expectedRevision: 'rev1', definitions: [{ id: 'p1', body: {} }] }] }), expected: { ok: true, payload: { layers: [{ kind: 'phase', expectedRevision: 'rev1', definitions: [{ id: 'p1', body: {} }] }] } } },
    { label: 'empty layers rejected', raw: msg('CMD_PUBLISH_PACKAGE', { layers: [] }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'empty definitions rejected', raw: msg('CMD_PUBLISH_PACKAGE', { layers: [{ kind: 'phase', expectedRevision: 'rev1', definitions: [] }] }), expected: { ok: false, reason: 'invalid-payload' } }
  ],

  CMD_READ_DEFINITION_VERSION: [
    { label: 'valid', raw: msg('CMD_READ_DEFINITION_VERSION', { kind: 'phase', id: 'p1', versionId: 'v2' }), expected: { ok: true, payload: { kind: 'phase', id: 'p1', versionId: 'v2' } } },
    { label: 'pipeline rejected (canonical kinds only)', raw: msg('CMD_READ_DEFINITION_VERSION', { kind: 'pipeline', id: 'p1', versionId: 'v2' }), expected: { ok: false, reason: 'invalid-payload-field' } },
    { label: 'extra field (path smuggling)', raw: msg('CMD_READ_DEFINITION_VERSION', { kind: 'phase', id: 'p1', versionId: 'v2', filePath: '/etc' }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_EXPORT_PROCESS_YAML: [
    { label: 'valid modelCatalog', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'modelCatalog' }), expected: { ok: true, payload: { resourceKind: 'modelCatalog' } } },
    { label: 'valid phase', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'phase', resourceId: STR_64 }), expected: { ok: true, payload: { resourceKind: 'phase', resourceId: STR_64 } } },
    { label: 'valid workflow', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'workflow', resourceId: 'w1', inclusion: 'include-closure' }), expected: { ok: true, payload: { resourceKind: 'workflow', resourceId: 'w1', inclusion: 'include-closure' } } },
    { label: 'phase with inclusion rejected unexpected-payload-fields', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'phase', resourceId: 'p1', inclusion: 'references-only' }), expected: { ok: false, reason: 'unexpected-payload-fields' } },
    { label: 'modelCatalog with resourceId rejected unexpected-payload-fields', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'modelCatalog', resourceId: 'm1' }), expected: { ok: false, reason: 'unexpected-payload-fields' } },
    { label: 'modelCatalog with inclusion rejected invalid-inclusion', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'modelCatalog', inclusion: 'references-only' }), expected: { ok: false, reason: 'invalid-inclusion' } },
    { label: 'resourceId 65 rejected resource-id-too-long', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'phase', resourceId: STR_65 }), expected: { ok: false, reason: 'resource-id-too-long' } },
    { label: 'bad resourceKind', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'pipeline', resourceId: 'p1' }), expected: { ok: false, reason: 'invalid-resource-kind' } }
  ],

  CMD_PREFLIGHT_PROCESS_YAML: [
    { label: 'valid empty obj', raw: msg('CMD_PREFLIGHT_PROCESS_YAML', {}), expected: { ok: true, payload: {} } },
    { label: 'any field rejected', raw: msg('CMD_PREFLIGHT_PROCESS_YAML', { filePath: '/tmp/x.yaml' }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  // ---- Family 7: phase-log (4) ----------------------------------------------
  CMD_READ_PHASE_LOG: [
    { label: 'valid null iteration', raw: msg('CMD_READ_PHASE_LOG', { selection: VALID_SELECTION_READ }), expected: { ok: true, payload: { selection: VALID_SELECTION_READ } } },
    { label: 'valid omitted iteration normalizes to null', raw: msg('CMD_READ_PHASE_LOG', { selection: { queueId: 'default', taskId: 't1', pipelineId: 'p1', phaseId: 'ph1' } }), expected: { ok: true, payload: { selection: { queueId: 'default', taskId: 't1', pipelineId: 'p1', phaseId: 'ph1', iterationN: null } } } },
    { label: 'path traversal rejected', raw: msg('CMD_READ_PHASE_LOG', { selection: { ...VALID_SELECTION_READ, phaseId: '../etc' } }), expected: { ok: false, reason: 'invalid-phaseId' } },
    { label: 'iteration 0 rejected', raw: msg('CMD_READ_PHASE_LOG', { selection: { ...VALID_SELECTION_READ, iterationN: 0 } }), expected: { ok: false, reason: 'invalid-iterationN' } }
  ],

  CMD_START_PHASE_LOG_TAIL: [
    { label: 'valid with consumer & cursor', raw: msg('CMD_START_PHASE_LOG_TAIL', { selection: VALID_SELECTION_TAIL, consumer: 'activity-feed', fromCursor: 'abc123:0' }), expected: { ok: true, payload: { selection: VALID_SELECTION_TAIL, consumer: 'activity-feed', fromCursor: 'abc123:0' } } },
    { label: 'null iteration rejected', raw: msg('CMD_START_PHASE_LOG_TAIL', { selection: VALID_SELECTION_READ }), expected: { ok: false, reason: 'invalid-iterationN' } },
    { label: 'control char in fromCursor rejected', raw: msg('CMD_START_PHASE_LOG_TAIL', { selection: VALID_SELECTION_TAIL, fromCursor: 'bad\ncursor' }), expected: { ok: false, reason: 'invalid-fromCursor' } },
    { label: 'over-length consumer', raw: msg('CMD_START_PHASE_LOG_TAIL', { selection: VALID_SELECTION_TAIL, consumer: STR_65 }), expected: { ok: false, reason: 'invalid-consumer' } }
  ],

  CMD_STOP_PHASE_LOG_TAIL: [
    { label: 'valid', raw: msg('CMD_STOP_PHASE_LOG_TAIL', { sessionId: 'sess-1' }), expected: { ok: true, payload: { sessionId: 'sess-1' } } },
    { label: 'empty sessionId', raw: msg('CMD_STOP_PHASE_LOG_TAIL', { sessionId: '' }), expected: { ok: false, reason: 'invalid-sessionId' } }
  ],

  CMD_ACK_PHASE_LOG_TAIL: [
    { label: 'valid with flags', raw: msg('CMD_ACK_PHASE_LOG_TAIL', { sessionId: 's1', batchSeq: 0, resync: true, duplicate: false }), expected: { ok: true, payload: { sessionId: 's1', batchSeq: 0, resync: true, duplicate: false } } },
    { label: 'negative batchSeq', raw: msg('CMD_ACK_PHASE_LOG_TAIL', { sessionId: 's1', batchSeq: -1 }), expected: { ok: false, reason: 'invalid-batchSeq' } },
    { label: 'bad resync', raw: msg('CMD_ACK_PHASE_LOG_TAIL', { sessionId: 's1', batchSeq: 1, resync: 'yes' }), expected: { ok: false, reason: 'invalid-resync' } }
  ],

  // ---- Family 8: analytics-reporting (5) ------------------------------------
  CMD_READ_METRICS: [
    { label: 'valid empty', raw: msg('CMD_READ_METRICS', {}), expected: { ok: true, payload: {} } },
    { label: 'valid with flags', raw: msg('CMD_READ_METRICS', { includeArchives: true, runIds: ['r1'] }), expected: { ok: true, payload: { includeArchives: true, runIds: ['r1'] } } },
    { label: 'over-cap runIds', raw: msg('CMD_READ_METRICS', { runIds: Array.from({ length: 65 }, (_, i) => `r${i}`) }), expected: { ok: false, reason: 'invalid-payload-field' } },
    { label: 'extra key', raw: msg('CMD_READ_METRICS', { unknown: 1 }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_READ_STORAGE_DETAILS: [
    { label: 'valid empty', raw: msg('CMD_READ_STORAGE_DETAILS', {}), expected: { ok: true, payload: {} } },
    { label: 'valid cursor', raw: msg('CMD_READ_STORAGE_DETAILS', { cursor: 'page_1-ok' }), expected: { ok: true, payload: { cursor: 'page_1-ok' } } },
    { label: 'bad cursor chars', raw: msg('CMD_READ_STORAGE_DETAILS', { cursor: '../bad' }), expected: { ok: false, reason: 'invalid-cursor' } }
  ],

  CMD_READ_USAGE_ACCOUNTING: [
    { label: 'valid opaque query', raw: msg('CMD_READ_USAGE_ACCOUNTING', { query: { groupBy: ['backend'] } }), expected: { ok: true, payload: { query: { groupBy: ['backend'] } } } },
    { label: 'missing query', raw: msg('CMD_READ_USAGE_ACCOUNTING', {}), expected: { ok: false, reason: 'missing-query' } },
    { label: 'extra key', raw: msg('CMD_READ_USAGE_ACCOUNTING', { query: {}, extra: 1 }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_READ_REPORT: [
    { label: 'valid run', raw: msg('CMD_READ_REPORT', { op: 'run', query: { kind: 'summary' } }), expected: { ok: true, payload: { op: 'run', query: { kind: 'summary' } } } },
    { label: 'valid page', raw: msg('CMD_READ_REPORT', { op: 'page', cursor: STR_512 }), expected: { ok: true, payload: { op: 'page', cursor: STR_512 } } },
    { label: 'valid drillDown', raw: msg('CMD_READ_REPORT', { op: 'drillDown', reportId: 'rep-1', rootId: 'root-1' }), expected: { ok: true, payload: { op: 'drillDown', reportId: 'rep-1', rootId: 'root-1' } } },
    { label: 'valid listSaved minimal', raw: msg('CMD_READ_REPORT', { op: 'listSaved' }), expected: { ok: true, payload: { op: 'listSaved' } } },
    { label: 'valid cancelActive', raw: msg('CMD_READ_REPORT', { op: 'cancelActive' }), expected: { ok: true, payload: { op: 'cancelActive' } } },
    { label: 'missing op', raw: msg('CMD_READ_REPORT', {}), expected: { ok: false, reason: 'missing-op' } },
    { label: 'invalid op', raw: msg('CMD_READ_REPORT', { op: 'drop' }), expected: { ok: false, reason: 'invalid-op' } },
    { label: 'run missing query', raw: msg('CMD_READ_REPORT', { op: 'run' }), expected: { ok: false, reason: 'missing-query' } },
    { label: 'drillDown traversal', raw: msg('CMD_READ_REPORT', { op: 'drillDown', reportId: '../x', rootId: 'r1' }), expected: { ok: false, reason: 'invalid-reportId' } }
  ],

  CMD_MUTATE_REPORT: [
    { label: 'valid export', raw: msg('CMD_MUTATE_REPORT', { op: 'export', reportId: 'rep-1', format: 'csv' }), expected: { ok: true, payload: { op: 'export', reportId: 'rep-1', format: 'csv' } } },
    { label: 'valid save', raw: msg('CMD_MUTATE_REPORT', { op: 'save', reportId: 'rep-1' }), expected: { ok: true, payload: { op: 'save', reportId: 'rep-1' } } },
    { label: 'valid deleteSaved', raw: msg('CMD_MUTATE_REPORT', { op: 'deleteSaved', reportId: 'rep-1', confirmed: true }), expected: { ok: true, payload: { op: 'deleteSaved', reportId: 'rep-1', confirmed: true } } },
    { label: 'export with path rejected', raw: msg('CMD_MUTATE_REPORT', { op: 'export', reportId: 'rep-1', format: 'json', destination: '/tmp/out' }), expected: { ok: false, reason: 'unexpected-payload-fields' } },
    { label: 'export bad format', raw: msg('CMD_MUTATE_REPORT', { op: 'export', reportId: 'rep-1', format: 'xml' }), expected: { ok: false, reason: 'invalid-format' } },
    { label: 'deleteSaved missing confirmation', raw: msg('CMD_MUTATE_REPORT', { op: 'deleteSaved', reportId: 'rep-1', confirmed: false }), expected: { ok: false, reason: 'missing-confirmation' } }
  ],

  // ---- Family 9: execution-workflow (6) -------------------------------------
  CMD_LAUNCH_PIPELINE: [
    { label: 'valid minimal', raw: msg('CMD_LAUNCH_PIPELINE', { request: MIN_RUN_REQUEST }), expected: { ok: true, payload: { request: MIN_RUN_REQUEST } } },
    { label: 'valid with queueId', raw: msg('CMD_LAUNCH_PIPELINE', { request: MIN_RUN_REQUEST, queueId: 'q1' }), expected: { ok: true, payload: { request: MIN_RUN_REQUEST, queueId: 'q1' } } },
    { label: 'hostile catalogVersion injection rejected', raw: msg('CMD_LAUNCH_PIPELINE', { request: { ...MIN_RUN_REQUEST, catalogVersion: { kind: 'pipeline', id: 'default', versionId: 'v1' } } }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'missing payload', raw: msg('CMD_LAUNCH_PIPELINE'), expected: { ok: false, reason: 'missing-payload' } }
  ],

  CMD_LAUNCH_WORKFLOW: [
    { label: 'valid', raw: msg('CMD_LAUNCH_WORKFLOW', { workflowId: 'wf1', startNodeId: 'n1', request: MIN_RUN_REQUEST }), expected: { ok: true, payload: { workflowId: 'wf1', startNodeId: 'n1', request: MIN_RUN_REQUEST } } },
    { label: 'over-length workflowId', raw: msg('CMD_LAUNCH_WORKFLOW', { workflowId: STR_65, startNodeId: 'n1', request: MIN_RUN_REQUEST }), expected: { ok: false, reason: 'invalid-payload' } }
  ],

  CMD_CONTINUE_WORKFLOW: [
    { label: 'valid minimal', raw: msg('CMD_CONTINUE_WORKFLOW', { connectedRunId: 'cr1', expectedRevision: 0, nodeId: 'n1', request: MIN_RUN_REQUEST }), expected: { ok: true, payload: { connectedRunId: 'cr1', expectedRevision: 0, nodeId: 'n1', request: MIN_RUN_REQUEST } } },
    { label: 'negative revision rejected', raw: msg('CMD_CONTINUE_WORKFLOW', { connectedRunId: 'cr1', expectedRevision: -1, nodeId: 'n1', request: MIN_RUN_REQUEST }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'bad operation rejected', raw: msg('CMD_CONTINUE_WORKFLOW', { connectedRunId: 'cr1', expectedRevision: 1, nodeId: 'n1', request: MIN_RUN_REQUEST, operation: 'bogus' }), expected: { ok: false, reason: 'invalid-payload' } }
  ],

  CMD_READ_EXECUTION_VISIBILITY: [
    { label: 'valid attemptDetail', raw: msg('CMD_READ_EXECUTION_VISIBILITY', { op: 'attemptDetail', rootExecutionId: 'root:1', invocationId: 'inv-1', attemptId: 'att-1' }), expected: { ok: true, payload: { op: 'attemptDetail', rootExecutionId: 'root:1', invocationId: 'inv-1', attemptId: 'att-1' } } },
    { label: 'valid runtimePosture', raw: msg('CMD_READ_EXECUTION_VISIBILITY', { op: 'runtimePosture' }), expected: { ok: true, payload: { op: 'runtimePosture' } } },
    { label: 'bad op', raw: msg('CMD_READ_EXECUTION_VISIBILITY', { op: 'other' }), expected: { ok: false, reason: 'invalid-op' } },
    { label: 'traversal rootExecutionId', raw: msg('CMD_READ_EXECUTION_VISIBILITY', { op: 'attemptDetail', rootExecutionId: '../x' }), expected: { ok: false, reason: 'invalid-rootExecutionId' } }
  ],

  CMD_OPEN_CHANGE_REVIEW: [
    { label: 'valid open', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'open', requestId: 'req-1', openInEditor: true }), expected: { ok: true, payload: { op: 'open', requestId: 'req-1', openInEditor: true } } },
    { label: 'valid page', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'page', cursor: 'abc_1-2' }), expected: { ok: true, payload: { op: 'page', cursor: 'abc_1-2' } } },
    { label: 'valid cancelOpen', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'cancelOpen' }), expected: { ok: true, payload: { op: 'cancelOpen' } } },
    { label: 'bad cursor', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'page', cursor: 'bad/cursor' }), expected: { ok: false, reason: 'invalid-cursor' } },
    { label: 'bad op', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'nope' }), expected: { ok: false, reason: 'invalid-op' } }
  ],

  CMD_DECIDE_PHASE_HANDOFF: [
    { label: 'valid approve', raw: msg('CMD_DECIDE_PHASE_HANDOFF', { op: 'approve', handoffId: 'h-1', expectedRevision: 1, decisionId: 'd-1' }), expected: { ok: true, payload: { op: 'approve', handoffId: 'h-1', expectedRevision: 1, decisionId: 'd-1' } } },
    { label: 'valid edit', raw: msg('CMD_DECIDE_PHASE_HANDOFF', { op: 'edit', handoffId: 'h-1', baseRevision: 2, replacementSources: [{ kind: 'a' }] }), expected: { ok: true, payload: { op: 'edit', handoffId: 'h-1', baseRevision: 2, replacementSources: [{ kind: 'a' }] } } },
    { label: 'revision 0 rejected', raw: msg('CMD_DECIDE_PHASE_HANDOFF', { op: 'approve', handoffId: 'h-1', expectedRevision: 0, decisionId: 'd-1' }), expected: { ok: false, reason: 'invalid-expectedRevision' } },
    { label: 'non-array replacementSources', raw: msg('CMD_DECIDE_PHASE_HANDOFF', { op: 'edit', handoffId: 'h-1', baseRevision: 1, replacementSources: 'bad' }), expected: { ok: false, reason: 'invalid-replacementSources' } }
  ]
};

describe('FR-R7-05 (SC-001) — 71-command differential validation corpus', () => {
  it('covers all 71 commands declared in COMMAND_TYPES without omissions', () => {
    const covered = Object.keys(CORPUS).sort();
    const declared = [...COMMAND_TYPES].sort();
    expect(covered).toEqual(declared);
    expect(covered).toHaveLength(71);
  });

  it('enforces envelope front-door guards identically', () => {
    expect(validateInboundMessage(null)).toEqual({ ok: false, reason: 'not-an-object' });
    expect(validateInboundMessage({})).toEqual({ ok: false, reason: 'missing-or-non-string-type' });
    expect(validateInboundMessage({ type: 'CMD_OPEN_DASHBOARD', correlationId: '' })).toEqual({
      ok: false,
      reason: 'invalid-correlationId',
      type: 'CMD_OPEN_DASHBOARD'
    });
    expect(validateInboundMessage({ type: 'CMD_UNKNOWN', correlationId: CID })).toEqual({
      ok: false,
      reason: 'unknown-type',
      type: 'CMD_UNKNOWN',
      correlationId: CID
    });
  });

  for (const commandType of COMMAND_TYPES) {
    describe(commandType, () => {
      for (const tc of CORPUS[commandType]) {
        it(tc.label, () => {
          const result = validateInboundMessage(tc.raw);
          if (tc.expected.ok) {
            expect(result.ok, `expected ok for ${commandType} (${tc.label}), got ${JSON.stringify(result)}`).toBe(true);
            if (!result.ok) return;
            expect(result.command.type).toBe(commandType);
            expect(result.command.correlationId).toBe(CID);
            if (tc.expected.hasPayloadKey === false) {
              expect('payload' in result.command).toBe(false);
            } else {
              expect((result.command as { payload?: unknown }).payload).toEqual(tc.expected.payload);
            }
          } else {
            expect(result.ok, `expected failure '${tc.expected.reason}' for ${commandType} (${tc.label})`).toBe(false);
            if (result.ok) return;
            expect(result.reason).toBe(tc.expected.reason);
            expect(result.type).toBe(commandType);
            expect(result.correlationId).toBe(CID);
          }
        });
      }
    });
  }
});
