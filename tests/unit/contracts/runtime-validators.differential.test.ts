// Differential equivalence & exhaustive per-field validation suite for
// FR-R7-05 (FR-003, SC-001) and FR-R7-11 (Task 12).
//
// Proves accept/reject decisions, normalized payloads, and exact failure reason
// codes across all 71 inbound commands AND mechanically proves via
// `ALL_IPC_COMMANDS` that every validated field and every discriminated-union
// arm has valid, boundary, and isolated rejected/hostile coverage (zero
// constant-held or omitted fields).
//
// Intended sparse-array rejection policy (FR-R7-11 Task 12):
// Generated validators iterate array fields with `for (const el of arr)` rather
// than `.every()` (which skips holes). Holes in sparse arrays yield `undefined`
// and fail closed with `{ ok: false, reason: 'invalid-payload' }` for
// `CMD_PUBLISH_PACKAGE.layers`, `CMD_PUBLISH_PACKAGE.layers[].definitions`, and
// `CMD_SAVE_MODELS.models[k]`, matching JSON wire semantics where holes
// serialize as `null` while rejecting sparse in-process payloads too.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMAND_TYPES, type CommandType } from '../../../src/contracts/sidebar-ipc';
import { validateInboundMessage } from '../../../src/contracts/runtime-validators';
import { validateAgainstSchema, type JsonSchemaNode } from '../../helpers/json-schema-validator';

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
const STR_160 = 'g'.repeat(160);
const STR_161 = 'g'.repeat(161);
const STR_256 = 'c'.repeat(256);
const STR_257 = 'c'.repeat(257);
const STR_500 = 'd'.repeat(500);
const STR_501 = 'd'.repeat(501);
const STR_512 = 'e'.repeat(512);
const STR_513 = 'e'.repeat(513);
const STR_4096 = 'f'.repeat(4096);
const STR_4097 = 'f'.repeat(4097);
const STR_65536 = 'h'.repeat(65536);
const STR_65537 = 'h'.repeat(65537);

const MAX_PACKAGE_DEFINITIONS = Array.from({ length: 500 }, (_, i) => ({
  id: i === 0 ? STR_64 : `p${i}`,
  body: {}
}));
const OVER_MAX_PACKAGE_DEFINITIONS = Array.from({ length: 501 }, (_, i) => ({
  id: `p${i}`,
  body: {}
}));
const MAX_RUN_IDS = Array.from({ length: 64 }, (_, i) => `r${i}`);

const MIN_RUN_REQUEST = {
  pipelineId: 'default',
  inputs: [],
  supplemental: [],
  outputs: []
};

const VALID_CONTROL_COMMAND = {
  version: 1,
  commandId: '11111111-1111-1111-1111-111111111111',
  rootRunId: 'cr1',
  queueId: 'default',
  invocationId: 'inv-1',
  expectedGeneration: 0,
  action: { kind: 'pause' }
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

const VALID_PACKAGE_LAYER = {
  kind: 'phase',
  expectedRevision: 'rev1',
  definitions: [{ id: 'p1', body: {} }]
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
      label: 'valid min-len boundaries',
      raw: msg('CMD_START', { description: '  a  ', queueId: 'q' }),
      expected: { ok: true, payload: { description: 'a', queueId: 'q' } }
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
    {
      label: 'padding is excluded from the maximum description length',
      raw: msg('CMD_START', { description: `\u00a0${STR_4096}\n` }),
      expected: { ok: true, payload: { description: STR_4096 } }
    },
    { label: 'missing payload', raw: msg('CMD_START'), expected: { ok: false, reason: 'missing-payload' } },
    { label: 'extra field', raw: msg('CMD_START', { description: 'ok', extra: 1 }), expected: { ok: false, reason: 'unexpected-payload-fields' } },
    { label: 'non-string description', raw: msg('CMD_START', { description: 42 }), expected: { ok: false, reason: 'description-not-string' } },
    { label: 'whitespace description', raw: msg('CMD_START', { description: '   ' }), expected: { ok: false, reason: 'description-out-of-range' } },
    { label: 'over-length description', raw: msg('CMD_START', { description: STR_4097 }), expected: { ok: false, reason: 'description-out-of-range' } },
    { label: 'bad pipelineId', raw: msg('CMD_START', { description: 'ok', pipelineId: 1 }), expected: { ok: false, reason: 'pipelineId-not-string' } },
    { label: 'empty queueId', raw: msg('CMD_START', { description: 'ok', queueId: '' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'over-length queueId', raw: msg('CMD_START', { description: 'ok', queueId: STR_257 }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'negative position', raw: msg('CMD_START', { description: 'ok', position: -1 }), expected: { ok: false, reason: 'invalid-position' } },
    { label: 'hostile startIntent', raw: msg('CMD_START', { description: 'ok', startIntent: { startMode: 'scheduled', source: 'system-rate-limit-recovery', scheduledStartAt: 100 } }), expected: { ok: false, reason: 'invalid-start-intent' } }
  ],

  CMD_CANCEL: [
    { label: 'valid min boundary', raw: msg('CMD_CANCEL', { taskId: 't' }), expected: { ok: true, payload: { taskId: 't' } } },
    { label: 'valid boundary', raw: msg('CMD_CANCEL', { taskId: STR_256 }), expected: { ok: true, payload: { taskId: STR_256 } } },
    { label: 'empty taskId', raw: msg('CMD_CANCEL', { taskId: '' }), expected: { ok: false, reason: 'invalid-taskId' } },
    { label: 'over-length taskId', raw: msg('CMD_CANCEL', { taskId: STR_257 }), expected: { ok: false, reason: 'invalid-taskId' } },
    { label: 'extra field', raw: msg('CMD_CANCEL', { taskId: 't1', x: 1 }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_REMOVE_QUEUE_ITEM: [
    { label: 'valid min boundary', raw: msg('CMD_REMOVE_QUEUE_ITEM', { id: 'q', confirmed: true }), expected: { ok: true, payload: { id: 'q', confirmed: true } } },
    { label: 'valid confirmed', raw: msg('CMD_REMOVE_QUEUE_ITEM', { id: STR_256, confirmed: true }), expected: { ok: true, payload: { id: STR_256, confirmed: true } } },
    { label: 'missing confirmation', raw: msg('CMD_REMOVE_QUEUE_ITEM', { id: 'q1', confirmed: false }), expected: { ok: false, reason: 'missing-confirmation' } },
    { label: 'empty id', raw: msg('CMD_REMOVE_QUEUE_ITEM', { id: '', confirmed: true }), expected: { ok: false, reason: 'invalid-id' } },
    { label: 'over-length id', raw: msg('CMD_REMOVE_QUEUE_ITEM', { id: STR_257, confirmed: true }), expected: { ok: false, reason: 'invalid-id' } },
    { label: 'extra field', raw: msg('CMD_REMOVE_QUEUE_ITEM', { id: 'q1', confirmed: true, x: 1 }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_RETRY_QUEUE_ITEM: [
    { label: 'valid min boundary', raw: msg('CMD_RETRY_QUEUE_ITEM', { id: 'q' }), expected: { ok: true, payload: { id: 'q' } } },
    { label: 'valid', raw: msg('CMD_RETRY_QUEUE_ITEM', { id: STR_256 }), expected: { ok: true, payload: { id: STR_256 } } },
    { label: 'empty id', raw: msg('CMD_RETRY_QUEUE_ITEM', { id: '' }), expected: { ok: false, reason: 'invalid-id' } },
    { label: 'over-length id', raw: msg('CMD_RETRY_QUEUE_ITEM', { id: STR_257 }), expected: { ok: false, reason: 'invalid-id' } },
    { label: 'missing payload', raw: msg('CMD_RETRY_QUEUE_ITEM'), expected: { ok: false, reason: 'missing-payload' } }
  ],

  CMD_MOVE_QUEUE_ITEM_UP: [
    { label: 'valid min boundary', raw: msg('CMD_MOVE_QUEUE_ITEM_UP', { id: 'q' }), expected: { ok: true, payload: { id: 'q' } } },
    { label: 'valid', raw: msg('CMD_MOVE_QUEUE_ITEM_UP', { id: STR_256 }), expected: { ok: true, payload: { id: STR_256 } } },
    { label: 'empty id', raw: msg('CMD_MOVE_QUEUE_ITEM_UP', { id: '' }), expected: { ok: false, reason: 'invalid-id' } },
    { label: 'over-length id', raw: msg('CMD_MOVE_QUEUE_ITEM_UP', { id: STR_257 }), expected: { ok: false, reason: 'invalid-id' } },
    { label: 'extra field', raw: msg('CMD_MOVE_QUEUE_ITEM_UP', { id: 'item-1', extra: true }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_MOVE_QUEUE_ITEM_DOWN: [
    { label: 'valid min boundary', raw: msg('CMD_MOVE_QUEUE_ITEM_DOWN', { id: 'q' }), expected: { ok: true, payload: { id: 'q' } } },
    { label: 'valid', raw: msg('CMD_MOVE_QUEUE_ITEM_DOWN', { id: STR_256 }), expected: { ok: true, payload: { id: STR_256 } } },
    { label: 'empty id', raw: msg('CMD_MOVE_QUEUE_ITEM_DOWN', { id: '' }), expected: { ok: false, reason: 'invalid-id' } },
    { label: 'non-string id', raw: msg('CMD_MOVE_QUEUE_ITEM_DOWN', { id: 123 }), expected: { ok: false, reason: 'invalid-id' } },
    { label: 'over-length id', raw: msg('CMD_MOVE_QUEUE_ITEM_DOWN', { id: STR_257 }), expected: { ok: false, reason: 'invalid-id' } }
  ],

  CMD_PAUSE_QUEUE: [
    { label: 'no payload', raw: msg('CMD_PAUSE_QUEUE'), expected: { ok: true, hasPayloadKey: false } },
    { label: 'empty object payload', raw: msg('CMD_PAUSE_QUEUE', {}), expected: { ok: true, payload: undefined } },
    { label: 'empty array payload normalizes as an empty object', raw: msg('CMD_PAUSE_QUEUE', []), expected: { ok: true, payload: undefined } },
    { label: 'populated array has unexpected indexed fields', raw: msg('CMD_PAUSE_QUEUE', [1]), expected: { ok: false, reason: 'unexpected-payload-fields' } },
    { label: 'valid min queueId', raw: msg('CMD_PAUSE_QUEUE', { queueId: 'q' }), expected: { ok: true, payload: { queueId: 'q' } } },
    { label: 'valid boundary reason and max queueId', raw: msg('CMD_PAUSE_QUEUE', { queueId: STR_256, reason: STR_500 }), expected: { ok: true, payload: { queueId: STR_256, reason: STR_500 } } },
    { label: 'null payload', raw: msg('CMD_PAUSE_QUEUE', null), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'reason too long', raw: msg('CMD_PAUSE_QUEUE', { reason: STR_501 }), expected: { ok: false, reason: 'reason-too-long' } },
    { label: 'reason non-string', raw: msg('CMD_PAUSE_QUEUE', { reason: 42 }), expected: { ok: false, reason: 'reason-not-string' } },
    { label: 'bad queueId', raw: msg('CMD_PAUSE_QUEUE', { queueId: '' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'over-length queueId', raw: msg('CMD_PAUSE_QUEUE', { queueId: STR_257 }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'extra field', raw: msg('CMD_PAUSE_QUEUE', { extra: 1 }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_RESUME_QUEUE: [
    { label: 'no payload', raw: msg('CMD_RESUME_QUEUE'), expected: { ok: true, hasPayloadKey: false } },
    { label: 'valid min queueId', raw: msg('CMD_RESUME_QUEUE', { queueId: 'q' }), expected: { ok: true, payload: { queueId: 'q' } } },
    { label: 'valid max queueId', raw: msg('CMD_RESUME_QUEUE', { queueId: STR_256 }), expected: { ok: true, payload: { queueId: STR_256 } } },
    { label: 'empty object', raw: msg('CMD_RESUME_QUEUE', {}), expected: { ok: true, payload: undefined } },
    { label: 'empty array payload normalizes as an empty object', raw: msg('CMD_RESUME_QUEUE', []), expected: { ok: true, payload: undefined } },
    { label: 'populated array has unexpected indexed fields', raw: msg('CMD_RESUME_QUEUE', [1]), expected: { ok: false, reason: 'unexpected-payload-fields' } },
    { label: 'rejects unaccepted prompt field', raw: msg('CMD_RESUME_QUEUE', { queueId: 'default', prompt: 'hi' }), expected: { ok: false, reason: 'unexpected-payload-fields' } },
    { label: 'empty queueId', raw: msg('CMD_RESUME_QUEUE', { queueId: '' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'bad queueId', raw: msg('CMD_RESUME_QUEUE', { queueId: STR_257 }), expected: { ok: false, reason: 'invalid-queueId' } }
  ],

  CMD_START_QUEUE: [
    { label: 'absent payload yields empty obj', raw: msg('CMD_START_QUEUE'), expected: { ok: true, payload: {} } },
    { label: 'empty obj', raw: msg('CMD_START_QUEUE', {}), expected: { ok: true, payload: {} } },
    { label: 'valid min queueId', raw: msg('CMD_START_QUEUE', { queueId: 'q' }), expected: { ok: true, payload: { queueId: 'q' } } },
    { label: 'valid max queueId + intent', raw: msg('CMD_START_QUEUE', { queueId: STR_256, startIntent: { startMode: 'cancel-schedule', source: 'operator-restart' } }), expected: { ok: true, payload: { queueId: STR_256, startIntent: { startMode: 'cancel-schedule', source: 'operator-restart' } } } },
    { label: 'array payload rejected', raw: msg('CMD_START_QUEUE', []), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'extra key', raw: msg('CMD_START_QUEUE', { queueID: 'q1' }), expected: { ok: false, reason: 'unexpected-payload-fields' } },
    { label: 'empty queueId', raw: msg('CMD_START_QUEUE', { queueId: '' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'over-length queueId', raw: msg('CMD_START_QUEUE', { queueId: STR_257 }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'invalid intent', raw: msg('CMD_START_QUEUE', { startIntent: { startMode: 'leave-pending', source: 'operator-immediate' } }), expected: { ok: false, reason: 'invalid-start-intent' } }
  ],

  CMD_CLEAR_COMPLETED: [
    { label: 'valid min queueId', raw: msg('CMD_CLEAR_COMPLETED', { queueId: 'q' }), expected: { ok: true, payload: { queueId: 'q' } } },
    { label: 'valid max queueId', raw: msg('CMD_CLEAR_COMPLETED', { queueId: STR_256 }), expected: { ok: true, payload: { queueId: STR_256 } } },
    { label: 'empty queueId', raw: msg('CMD_CLEAR_COMPLETED', { queueId: '' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'over-length queueId', raw: msg('CMD_CLEAR_COMPLETED', { queueId: STR_257 }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'missing payload', raw: msg('CMD_CLEAR_COMPLETED'), expected: { ok: false, reason: 'missing-payload' } }
  ],

  CMD_CLEAR_QUEUE: [
    { label: 'valid min queueId', raw: msg('CMD_CLEAR_QUEUE', { queueId: 'q' }), expected: { ok: true, payload: { queueId: 'q' } } },
    { label: 'valid', raw: msg('CMD_CLEAR_QUEUE', { queueId: STR_256 }), expected: { ok: true, payload: { queueId: STR_256 } } },
    { label: 'empty queueId', raw: msg('CMD_CLEAR_QUEUE', { queueId: '' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'over-length queueId', raw: msg('CMD_CLEAR_QUEUE', { queueId: STR_257 }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'extra key', raw: msg('CMD_CLEAR_QUEUE', { queueId: 'default', force: true }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_MODIFY_TASK: [
    { label: 'valid trimmed', raw: msg('CMD_MODIFY_TASK', { taskId: 't1', description: '  edited  ' }), expected: { ok: true, payload: { taskId: 't1', description: 'edited' } } },
    { label: 'valid min boundaries', raw: msg('CMD_MODIFY_TASK', { taskId: 't', description: 'a' }), expected: { ok: true, payload: { taskId: 't', description: 'a' } } },
    { label: 'valid boundary', raw: msg('CMD_MODIFY_TASK', { taskId: STR_256, description: STR_4096 }), expected: { ok: true, payload: { taskId: STR_256, description: STR_4096 } } },
    { label: 'bad taskId', raw: msg('CMD_MODIFY_TASK', { taskId: '', description: 'ok' }), expected: { ok: false, reason: 'invalid-taskId' } },
    { label: 'over-length taskId', raw: msg('CMD_MODIFY_TASK', { taskId: STR_257, description: 'ok' }), expected: { ok: false, reason: 'invalid-taskId' } },
    { label: 'non-string desc', raw: msg('CMD_MODIFY_TASK', { taskId: 't1', description: null }), expected: { ok: false, reason: 'description-not-string' } },
    { label: 'whitespace desc', raw: msg('CMD_MODIFY_TASK', { taskId: 't1', description: '   ' }), expected: { ok: false, reason: 'description-out-of-range' } },
    { label: 'over-length desc', raw: msg('CMD_MODIFY_TASK', { taskId: 't1', description: STR_4097 }), expected: { ok: false, reason: 'description-out-of-range' } }
  ],

  CMD_REORDER_TASK: [
    { label: 'valid min taskId and zero pos', raw: msg('CMD_REORDER_TASK', { taskId: 't', newPosition: 0 }), expected: { ok: true, payload: { taskId: 't', newPosition: 0 } } },
    { label: 'valid boundary taskId', raw: msg('CMD_REORDER_TASK', { taskId: STR_256, newPosition: 3 }), expected: { ok: true, payload: { taskId: STR_256, newPosition: 3 } } },
    { label: 'empty taskId', raw: msg('CMD_REORDER_TASK', { taskId: '', newPosition: 0 }), expected: { ok: false, reason: 'invalid-taskId' } },
    { label: 'over-length taskId', raw: msg('CMD_REORDER_TASK', { taskId: STR_257, newPosition: 0 }), expected: { ok: false, reason: 'invalid-taskId' } },
    { label: 'negative pos', raw: msg('CMD_REORDER_TASK', { taskId: 't1', newPosition: -1 }), expected: { ok: false, reason: 'invalid-position' } },
    { label: 'float pos', raw: msg('CMD_REORDER_TASK', { taskId: 't1', newPosition: 1.5 }), expected: { ok: false, reason: 'invalid-position' } }
  ],

  CMD_RESTART_CANCELED_TASK: [
    { label: 'valid min boundary', raw: msg('CMD_RESTART_CANCELED_TASK', { taskId: 't' }), expected: { ok: true, payload: { taskId: 't' } } },
    { label: 'valid boundary', raw: msg('CMD_RESTART_CANCELED_TASK', { taskId: STR_256 }), expected: { ok: true, payload: { taskId: STR_256 } } },
    { label: 'empty taskId', raw: msg('CMD_RESTART_CANCELED_TASK', { taskId: '' }), expected: { ok: false, reason: 'invalid-taskId' } },
    { label: 'over-length taskId', raw: msg('CMD_RESTART_CANCELED_TASK', { taskId: STR_257 }), expected: { ok: false, reason: 'invalid-taskId' } }
  ],

  CMD_REMOVE_TASK_PHASE: [
    { label: 'valid min boundaries', raw: msg('CMD_REMOVE_TASK_PHASE', { taskId: 't', phaseId: 'p', confirmed: true }), expected: { ok: true, payload: { taskId: 't', phaseId: 'p', confirmed: true } } },
    { label: 'valid max boundaries', raw: msg('CMD_REMOVE_TASK_PHASE', { taskId: STR_256, phaseId: STR_256, confirmed: true }), expected: { ok: true, payload: { taskId: STR_256, phaseId: STR_256, confirmed: true } } },
    { label: 'empty taskId', raw: msg('CMD_REMOVE_TASK_PHASE', { taskId: '', phaseId: 'p1', confirmed: true }), expected: { ok: false, reason: 'invalid-taskId' } },
    { label: 'over-length taskId', raw: msg('CMD_REMOVE_TASK_PHASE', { taskId: STR_257, phaseId: 'p1', confirmed: true }), expected: { ok: false, reason: 'invalid-taskId' } },
    { label: 'bad phaseId', raw: msg('CMD_REMOVE_TASK_PHASE', { taskId: 't1', phaseId: '', confirmed: true }), expected: { ok: false, reason: 'invalid-phaseId' } },
    { label: 'over-length phaseId', raw: msg('CMD_REMOVE_TASK_PHASE', { taskId: 't1', phaseId: STR_257, confirmed: true }), expected: { ok: false, reason: 'invalid-phaseId' } },
    { label: 'missing confirmation', raw: msg('CMD_REMOVE_TASK_PHASE', { taskId: 't1', phaseId: 'p1' }), expected: { ok: false, reason: 'missing-confirmation' } }
  ],

  // ---- Family 2: queue-management (7) ---------------------------------------
  CMD_CREATE_QUEUE: [
    { label: 'valid trimmed', raw: msg('CMD_CREATE_QUEUE', { name: '  Alpha  ' }), expected: { ok: true, payload: { name: 'Alpha' } } },
    { label: 'valid min boundary', raw: msg('CMD_CREATE_QUEUE', { name: 'a' }), expected: { ok: true, payload: { name: 'a' } } },
    { label: 'boundary 64', raw: msg('CMD_CREATE_QUEUE', { name: STR_64 }), expected: { ok: true, payload: { name: STR_64 } } },
    { label: 'over-length 65', raw: msg('CMD_CREATE_QUEUE', { name: STR_65 }), expected: { ok: false, reason: 'invalid-queue-name' } },
    { label: 'whitespace only', raw: msg('CMD_CREATE_QUEUE', { name: '   ' }), expected: { ok: false, reason: 'invalid-queue-name' } },
    { label: 'array payload', raw: msg('CMD_CREATE_QUEUE', []), expected: { ok: false, reason: 'missing-payload' } }
  ],

  CMD_RENAME_QUEUE: [
    { label: 'valid', raw: msg('CMD_RENAME_QUEUE', { queueId: 'q1', name: ' Beta ' }), expected: { ok: true, payload: { queueId: 'q1', name: 'Beta' } } },
    { label: 'valid min boundaries', raw: msg('CMD_RENAME_QUEUE', { queueId: 'q', name: 'a' }), expected: { ok: true, payload: { queueId: 'q', name: 'a' } } },
    { label: 'valid max boundaries', raw: msg('CMD_RENAME_QUEUE', { queueId: STR_256, name: STR_64 }), expected: { ok: true, payload: { queueId: STR_256, name: STR_64 } } },
    { label: 'bad queueId', raw: msg('CMD_RENAME_QUEUE', { queueId: '', name: 'Beta' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'over-length queueId', raw: msg('CMD_RENAME_QUEUE', { queueId: STR_257, name: 'Beta' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'bad name', raw: msg('CMD_RENAME_QUEUE', { queueId: 'q1', name: '' }), expected: { ok: false, reason: 'invalid-queue-name' } },
    { label: 'over-length name', raw: msg('CMD_RENAME_QUEUE', { queueId: 'q1', name: STR_65 }), expected: { ok: false, reason: 'invalid-queue-name' } }
  ],

  CMD_DELETE_QUEUE: [
    { label: 'valid preview min queueId', raw: msg('CMD_DELETE_QUEUE', { queueId: 'q' }), expected: { ok: true, payload: { queueId: 'q' } } },
    { label: 'valid confirmed max queueId', raw: msg('CMD_DELETE_QUEUE', { queueId: STR_256, confirmed: true }), expected: { ok: true, payload: { queueId: STR_256, confirmed: true } } },
    { label: 'confirmed false rejected', raw: msg('CMD_DELETE_QUEUE', { queueId: 'q1', confirmed: false }), expected: { ok: false, reason: 'invalid-confirmation' } },
    { label: 'empty queueId', raw: msg('CMD_DELETE_QUEUE', { queueId: '' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'bad queueId', raw: msg('CMD_DELETE_QUEUE', { queueId: STR_257 }), expected: { ok: false, reason: 'invalid-queueId' } }
  ],

  CMD_SAVE_QUEUE_SETTINGS: [
    { label: 'valid min', raw: msg('CMD_SAVE_QUEUE_SETTINGS', { globalConcurrencyCap: 1, defaultQueueId: 'q' }), expected: { ok: true, payload: { globalConcurrencyCap: 1, defaultQueueId: 'q' } } },
    { label: 'valid max', raw: msg('CMD_SAVE_QUEUE_SETTINGS', { globalConcurrencyCap: 20, defaultQueueId: STR_256 }), expected: { ok: true, payload: { globalConcurrencyCap: 20, defaultQueueId: STR_256 } } },
    { label: 'cap 0 rejected', raw: msg('CMD_SAVE_QUEUE_SETTINGS', { globalConcurrencyCap: 0, defaultQueueId: 'default' }), expected: { ok: false, reason: 'invalid-concurrency-cap' } },
    { label: 'cap 21 rejected', raw: msg('CMD_SAVE_QUEUE_SETTINGS', { globalConcurrencyCap: 21, defaultQueueId: 'default' }), expected: { ok: false, reason: 'invalid-concurrency-cap' } },
    { label: 'bad defaultQueueId', raw: msg('CMD_SAVE_QUEUE_SETTINGS', { globalConcurrencyCap: 2, defaultQueueId: '' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'over-length defaultQueueId', raw: msg('CMD_SAVE_QUEUE_SETTINGS', { globalConcurrencyCap: 2, defaultQueueId: STR_257 }), expected: { ok: false, reason: 'invalid-queueId' } }
  ],

  CMD_SET_QUEUE_FAILURE_POLICY: [
    { label: 'valid min queueId halt-on-failure', raw: msg('CMD_SET_QUEUE_FAILURE_POLICY', { queueId: 'q', policy: 'halt-on-failure' }), expected: { ok: true, payload: { queueId: 'q', policy: 'halt-on-failure' } } },
    { label: 'valid continue', raw: msg('CMD_SET_QUEUE_FAILURE_POLICY', { queueId: 'q1', policy: 'continue' }), expected: { ok: true, payload: { queueId: 'q1', policy: 'continue' } } },
    { label: 'valid max queueId null', raw: msg('CMD_SET_QUEUE_FAILURE_POLICY', { queueId: STR_256, policy: null }), expected: { ok: true, payload: { queueId: STR_256, policy: null } } },
    { label: 'empty queueId', raw: msg('CMD_SET_QUEUE_FAILURE_POLICY', { queueId: '', policy: 'halt-on-failure' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'over-length queueId', raw: msg('CMD_SET_QUEUE_FAILURE_POLICY', { queueId: STR_257, policy: 'halt-on-failure' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'unknown policy', raw: msg('CMD_SET_QUEUE_FAILURE_POLICY', { queueId: 'q1', policy: 'ignore' }), expected: { ok: false, reason: 'invalid-failure-policy' } }
  ],

  CMD_ATTEST_TASK_COMPLETED: [
    { label: 'valid min taskId', raw: msg('CMD_ATTEST_TASK_COMPLETED', { taskId: 't', confirmed: true }), expected: { ok: true, payload: { taskId: 't', confirmed: true } } },
    { label: 'valid max taskId', raw: msg('CMD_ATTEST_TASK_COMPLETED', { taskId: STR_256, confirmed: true }), expected: { ok: true, payload: { taskId: STR_256, confirmed: true } } },
    { label: 'coerced confirmation rejected', raw: msg('CMD_ATTEST_TASK_COMPLETED', { taskId: 't1', confirmed: 'yes' }), expected: { ok: false, reason: 'missing-confirmation' } },
    { label: 'empty taskId', raw: msg('CMD_ATTEST_TASK_COMPLETED', { taskId: '', confirmed: true }), expected: { ok: false, reason: 'invalid-taskId' } },
    { label: 'over-length taskId', raw: msg('CMD_ATTEST_TASK_COMPLETED', { taskId: STR_257, confirmed: true }), expected: { ok: false, reason: 'invalid-taskId' } }
  ],

  CMD_MOVE_TASK: [
    { label: 'valid minimal', raw: msg('CMD_MOVE_TASK', { taskId: 't', targetQueueId: 'q' }), expected: { ok: true, payload: { taskId: 't', targetQueueId: 'q' } } },
    { label: 'valid max boundaries with position 0', raw: msg('CMD_MOVE_TASK', { taskId: STR_256, targetQueueId: STR_256, position: 0 }), expected: { ok: true, payload: { taskId: STR_256, targetQueueId: STR_256, position: 0 } } },
    { label: 'empty taskId', raw: msg('CMD_MOVE_TASK', { taskId: '', targetQueueId: 'q2' }), expected: { ok: false, reason: 'invalid-taskId' } },
    { label: 'over-length taskId', raw: msg('CMD_MOVE_TASK', { taskId: STR_257, targetQueueId: 'q2' }), expected: { ok: false, reason: 'invalid-taskId' } },
    { label: 'bad targetQueueId', raw: msg('CMD_MOVE_TASK', { taskId: 't1', targetQueueId: '' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'over-length targetQueueId', raw: msg('CMD_MOVE_TASK', { taskId: 't1', targetQueueId: STR_257 }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'bad position', raw: msg('CMD_MOVE_TASK', { taskId: 't1', targetQueueId: 'q2', position: -1 }), expected: { ok: false, reason: 'invalid-position' } }
  ],

  // ---- Family 3: phase-control (9) ------------------------------------------
  CMD_RETRY_PHASE_NOW: [
    { label: 'valid min queueId', raw: msg('CMD_RETRY_PHASE_NOW', { queueId: 'q' }), expected: { ok: true, payload: { queueId: 'q' } } },
    { label: 'valid max queueId', raw: msg('CMD_RETRY_PHASE_NOW', { queueId: STR_256 }), expected: { ok: true, payload: { queueId: STR_256 } } },
    { label: 'empty queueId', raw: msg('CMD_RETRY_PHASE_NOW', { queueId: '' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'over-length queueId', raw: msg('CMD_RETRY_PHASE_NOW', { queueId: STR_257 }), expected: { ok: false, reason: 'invalid-queueId' } }
  ],

  CMD_PAUSE_PHASE: [
    { label: 'valid min queueId', raw: msg('CMD_PAUSE_PHASE', { queueId: 'q' }), expected: { ok: true, payload: { queueId: 'q' } } },
    { label: 'valid boundary queueId', raw: msg('CMD_PAUSE_PHASE', { queueId: STR_256 }), expected: { ok: true, payload: { queueId: STR_256 } } },
    { label: 'empty queueId', raw: msg('CMD_PAUSE_PHASE', { queueId: '' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'over-length queueId', raw: msg('CMD_PAUSE_PHASE', { queueId: STR_257 }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'extra key', raw: msg('CMD_PAUSE_PHASE', { queueId: 'default', x: 1 }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_RESUME_PHASE: [
    { label: 'valid min queueId', raw: msg('CMD_RESUME_PHASE', { queueId: 'q' }), expected: { ok: true, payload: { queueId: 'q' } } },
    { label: 'valid empty prompt', raw: msg('CMD_RESUME_PHASE', { queueId: 'default', prompt: '' }), expected: { ok: true, payload: { queueId: 'default', prompt: '' } } },
    { label: 'valid max queueId and max prompt', raw: msg('CMD_RESUME_PHASE', { queueId: STR_256, prompt: STR_4096 }), expected: { ok: true, payload: { queueId: STR_256, prompt: STR_4096 } } },
    { label: 'empty queueId', raw: msg('CMD_RESUME_PHASE', { queueId: '' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'over-length queueId', raw: msg('CMD_RESUME_PHASE', { queueId: STR_257 }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'over-length prompt', raw: msg('CMD_RESUME_PHASE', { queueId: 'default', prompt: STR_4097 }), expected: { ok: false, reason: 'invalid-prompt' } }
  ],

  CMD_RESTART_PHASE: [
    { label: 'valid min boundaries', raw: msg('CMD_RESTART_PHASE', { queueId: 'q', phaseId: 'p' }), expected: { ok: true, payload: { queueId: 'q', phaseId: 'p' } } },
    { label: 'valid max boundaries', raw: msg('CMD_RESTART_PHASE', { queueId: STR_256, phaseId: STR_256 }), expected: { ok: true, payload: { queueId: STR_256, phaseId: STR_256 } } },
    { label: 'empty queueId', raw: msg('CMD_RESTART_PHASE', { queueId: '', phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'over-length queueId', raw: msg('CMD_RESTART_PHASE', { queueId: STR_257, phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'empty phaseId', raw: msg('CMD_RESTART_PHASE', { queueId: 'default', phaseId: '' }), expected: { ok: false, reason: 'invalid-phaseId' } },
    { label: 'over-length phaseId', raw: msg('CMD_RESTART_PHASE', { queueId: 'default', phaseId: STR_257 }), expected: { ok: false, reason: 'invalid-phaseId' } }
  ],

  CMD_SKIP_PHASE: [
    { label: 'valid min boundaries', raw: msg('CMD_SKIP_PHASE', { queueId: 'q', runId: 'r', phaseId: 'p' }), expected: { ok: true, payload: { queueId: 'q', runId: 'r', phaseId: 'p' } } },
    { label: 'valid max boundaries', raw: msg('CMD_SKIP_PHASE', { queueId: STR_256, runId: STR_256, phaseId: STR_256 }), expected: { ok: true, payload: { queueId: STR_256, runId: STR_256, phaseId: STR_256 } } },
    { label: 'empty queueId', raw: msg('CMD_SKIP_PHASE', { queueId: '', runId: 'r1', phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'over-length queueId', raw: msg('CMD_SKIP_PHASE', { queueId: STR_257, runId: 'r1', phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'empty runId', raw: msg('CMD_SKIP_PHASE', { queueId: 'default', runId: '', phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-runId' } },
    { label: 'over-length runId', raw: msg('CMD_SKIP_PHASE', { queueId: 'default', runId: STR_257, phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-runId' } },
    { label: 'empty phaseId', raw: msg('CMD_SKIP_PHASE', { queueId: 'default', runId: 'r1', phaseId: '' }), expected: { ok: false, reason: 'invalid-phaseId' } },
    { label: 'over-length phaseId', raw: msg('CMD_SKIP_PHASE', { queueId: 'default', runId: 'r1', phaseId: STR_257 }), expected: { ok: false, reason: 'invalid-phaseId' } }
  ],

  CMD_DISABLE_PHASE: [
    { label: 'valid min boundaries', raw: msg('CMD_DISABLE_PHASE', { queueId: 'q', phaseId: 'p' }), expected: { ok: true, payload: { queueId: 'q', phaseId: 'p' } } },
    { label: 'valid max boundaries', raw: msg('CMD_DISABLE_PHASE', { queueId: STR_256, phaseId: STR_256 }), expected: { ok: true, payload: { queueId: STR_256, phaseId: STR_256 } } },
    { label: 'bad queueId', raw: msg('CMD_DISABLE_PHASE', { queueId: '', phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'over-length queueId', raw: msg('CMD_DISABLE_PHASE', { queueId: STR_257, phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'bad phaseId', raw: msg('CMD_DISABLE_PHASE', { queueId: 'default', phaseId: '' }), expected: { ok: false, reason: 'invalid-phaseId' } },
    { label: 'over-length phaseId', raw: msg('CMD_DISABLE_PHASE', { queueId: 'default', phaseId: STR_257 }), expected: { ok: false, reason: 'invalid-phaseId' } }
  ],

  CMD_ENABLE_PHASE: [
    { label: 'valid min boundaries', raw: msg('CMD_ENABLE_PHASE', { queueId: 'q', phaseId: 'p' }), expected: { ok: true, payload: { queueId: 'q', phaseId: 'p' } } },
    { label: 'valid max boundaries', raw: msg('CMD_ENABLE_PHASE', { queueId: STR_256, phaseId: STR_256 }), expected: { ok: true, payload: { queueId: STR_256, phaseId: STR_256 } } },
    { label: 'bad queueId', raw: msg('CMD_ENABLE_PHASE', { queueId: '', phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'over-length queueId', raw: msg('CMD_ENABLE_PHASE', { queueId: STR_257, phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'empty phaseId', raw: msg('CMD_ENABLE_PHASE', { queueId: 'default', phaseId: '' }), expected: { ok: false, reason: 'invalid-phaseId' } },
    { label: 'bad phaseId', raw: msg('CMD_ENABLE_PHASE', { queueId: 'default', phaseId: STR_257 }), expected: { ok: false, reason: 'invalid-phaseId' } }
  ],

  CMD_SET_PHASE_BREAKPOINT: [
    { label: 'valid min boundaries', raw: msg('CMD_SET_PHASE_BREAKPOINT', { queueId: 'q', runId: 'r', phaseId: 'p' }), expected: { ok: true, payload: { queueId: 'q', runId: 'r', phaseId: 'p' } } },
    { label: 'valid max boundaries', raw: msg('CMD_SET_PHASE_BREAKPOINT', { queueId: STR_256, runId: STR_256, phaseId: STR_256 }), expected: { ok: true, payload: { queueId: STR_256, runId: STR_256, phaseId: STR_256 } } },
    { label: 'bad queueId', raw: msg('CMD_SET_PHASE_BREAKPOINT', { queueId: '', runId: 'r1', phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'over-length queueId', raw: msg('CMD_SET_PHASE_BREAKPOINT', { queueId: STR_257, runId: 'r1', phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'empty runId', raw: msg('CMD_SET_PHASE_BREAKPOINT', { queueId: 'default', runId: '', phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-runId' } },
    { label: 'bad runId', raw: msg('CMD_SET_PHASE_BREAKPOINT', { queueId: 'default', runId: 12, phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-runId' } },
    { label: 'over-length runId', raw: msg('CMD_SET_PHASE_BREAKPOINT', { queueId: 'default', runId: STR_257, phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-runId' } },
    { label: 'bad phaseId', raw: msg('CMD_SET_PHASE_BREAKPOINT', { queueId: 'default', runId: 'r1', phaseId: '' }), expected: { ok: false, reason: 'invalid-phaseId' } },
    { label: 'over-length phaseId', raw: msg('CMD_SET_PHASE_BREAKPOINT', { queueId: 'default', runId: 'r1', phaseId: STR_257 }), expected: { ok: false, reason: 'invalid-phaseId' } }
  ],

  CMD_CLEAR_PHASE_BREAKPOINT: [
    { label: 'valid min boundaries', raw: msg('CMD_CLEAR_PHASE_BREAKPOINT', { queueId: 'q', runId: 'r', phaseId: 'p' }), expected: { ok: true, payload: { queueId: 'q', runId: 'r', phaseId: 'p' } } },
    { label: 'valid max boundaries', raw: msg('CMD_CLEAR_PHASE_BREAKPOINT', { queueId: STR_256, runId: STR_256, phaseId: STR_256 }), expected: { ok: true, payload: { queueId: STR_256, runId: STR_256, phaseId: STR_256 } } },
    { label: 'bad queueId', raw: msg('CMD_CLEAR_PHASE_BREAKPOINT', { queueId: '', runId: 'r1', phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'over-length queueId', raw: msg('CMD_CLEAR_PHASE_BREAKPOINT', { queueId: STR_257, runId: 'r1', phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'bad runId', raw: msg('CMD_CLEAR_PHASE_BREAKPOINT', { queueId: 'default', runId: '', phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-runId' } },
    { label: 'over-length runId', raw: msg('CMD_CLEAR_PHASE_BREAKPOINT', { queueId: 'default', runId: STR_257, phaseId: 'plan' }), expected: { ok: false, reason: 'invalid-runId' } },
    { label: 'empty phaseId', raw: msg('CMD_CLEAR_PHASE_BREAKPOINT', { queueId: 'default', runId: 'r1', phaseId: '' }), expected: { ok: false, reason: 'invalid-phaseId' } },
    { label: 'bad phaseId', raw: msg('CMD_CLEAR_PHASE_BREAKPOINT', { queueId: 'default', runId: 'r1', phaseId: STR_257 }), expected: { ok: false, reason: 'invalid-phaseId' } },
    { label: 'extra key', raw: msg('CMD_CLEAR_PHASE_BREAKPOINT', { queueId: 'default', runId: 'r1', phaseId: 'plan', extra: 1 }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  // ---- Family 4: navigation-settings (10) -----------------------------------
  CMD_OPEN_AUDIT_LOG: [
    { label: 'valid', raw: msg('CMD_OPEN_AUDIT_LOG'), expected: { ok: true, hasPayloadKey: false } },
    { label: 'unexpected payload', raw: msg('CMD_OPEN_AUDIT_LOG', {}), expected: { ok: false, reason: 'unexpected-payload' } }
  ],

  CMD_OPEN_DASHBOARD: [
    { label: 'valid', raw: msg('CMD_OPEN_DASHBOARD'), expected: { ok: true, hasPayloadKey: false } },
    { label: 'ignores unused envelope fields', raw: { ...msg('CMD_OPEN_DASHBOARD'), extensionField: true }, expected: { ok: true, hasPayloadKey: false } },
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
    { label: 'non-string actionKey', raw: msg('CMD_SET_CONFIRM_SUPPRESSION', { actionKey: 42, suppressed: true }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'non-boolean suppressed', raw: msg('CMD_SET_CONFIRM_SUPPRESSION', { actionKey: 'k', suppressed: 'true' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'missing payload', raw: msg('CMD_SET_CONFIRM_SUPPRESSION'), expected: { ok: false, reason: 'invalid-payload' } }
  ],

  CMD_SAVE_MODELS: [
    { label: 'valid manual', raw: msg('CMD_SAVE_MODELS', { models: { claude: ['sonnet'] } }), expected: { ok: true, payload: { models: { claude: ['sonnet'] } } } },
    { label: 'valid manual-edit mutation', raw: msg('CMD_SAVE_MODELS', { models: { codex: ['gpt-5'] }, mutation: { kind: 'manual-edit' } }), expected: { ok: true, payload: { models: { codex: ['gpt-5'] }, mutation: { kind: 'manual-edit' } } } },
    { label: 'valid import with revision & mutation', raw: msg('CMD_SAVE_MODELS', { models: { agy: ['m1'] }, expectedRevision: 'r1', mutation: { kind: 'import-package' } }), expected: { ok: true, payload: { models: { agy: ['m1'] }, expectedRevision: 'r1', mutation: { kind: 'import-package' } } } },
    { label: 'ignoreInvalid non-string expectedRevision stripped', raw: msg('CMD_SAVE_MODELS', { models: { claude: ['sonnet'] }, expectedRevision: 123 }), expected: { ok: true, payload: { models: { claude: ['sonnet'] } } } },
    { label: 'ignoreInvalid non-object mutation stripped', raw: msg('CMD_SAVE_MODELS', { models: { claude: ['sonnet'] }, mutation: 'bad' }), expected: { ok: true, payload: { models: { claude: ['sonnet'] } } } },
    { label: 'ignoreInvalid unknown mutation.kind stripped', raw: msg('CMD_SAVE_MODELS', { models: { claude: ['sonnet'] }, mutation: { kind: 'bogus' } }), expected: { ok: true, payload: { models: { claude: ['sonnet'] } } } },
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
    { label: 'valid codex', raw: msg('CMD_PING_BACKEND', { runner: 'codex' }), expected: { ok: true, payload: { runner: 'codex' } } },
    { label: 'valid agy', raw: msg('CMD_PING_BACKEND', { runner: 'agy' }), expected: { ok: true, payload: { runner: 'agy' } } },
    { label: 'unknown runner', raw: msg('CMD_PING_BACKEND', { runner: 'other' }), expected: { ok: false, reason: 'invalid-runner' } },
    { label: 'extra field', raw: msg('CMD_PING_BACKEND', { runner: 'claude', extra: 1 }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_SET_UNCONTAINED_BACKEND_GRANT: [
    { label: 'valid grant', raw: msg('CMD_SET_UNCONTAINED_BACKEND_GRANT', { kind: 'codex', granted: true }), expected: { ok: true, payload: { kind: 'codex', granted: true } } },
    { label: 'valid revoke', raw: msg('CMD_SET_UNCONTAINED_BACKEND_GRANT', { kind: 'claude', granted: false }), expected: { ok: true, payload: { kind: 'claude', granted: false } } },
    { label: 'bad kind', raw: msg('CMD_SET_UNCONTAINED_BACKEND_GRANT', { kind: 'nope', granted: true }), expected: { ok: false, reason: 'invalid-backend-kind' } },
    { label: 'string granted rejected', raw: msg('CMD_SET_UNCONTAINED_BACKEND_GRANT', { kind: 'claude', granted: 'true' }), expected: { ok: false, reason: 'invalid-granted' } }
  ],

  // ---- Family 5: history-evidence (6) ---------------------------------------
  CMD_RERUN_FROM_HISTORY: [
    { label: 'valid min runId', raw: msg('CMD_RERUN_FROM_HISTORY', { runId: 'r' }), expected: { ok: true, payload: { runId: 'r' } } },
    { label: 'valid max runId force false omitted', raw: msg('CMD_RERUN_FROM_HISTORY', { runId: STR_256, force: false }), expected: { ok: true, payload: { runId: STR_256 } } },
    { label: 'valid force true kept', raw: msg('CMD_RERUN_FROM_HISTORY', { runId: 'r1', force: true }), expected: { ok: true, payload: { runId: 'r1', force: true } } },
    { label: 'force non-boolean', raw: msg('CMD_RERUN_FROM_HISTORY', { runId: 'r1', force: 'yes' }), expected: { ok: false, reason: 'force-not-boolean' } },
    { label: 'bad runId', raw: msg('CMD_RERUN_FROM_HISTORY', { runId: '' }), expected: { ok: false, reason: 'invalid-runId' } },
    { label: 'over-length runId', raw: msg('CMD_RERUN_FROM_HISTORY', { runId: STR_257 }), expected: { ok: false, reason: 'invalid-runId' } }
  ],

  CMD_OPEN_HISTORY_ITEM_DETAILS: [
    { label: 'valid min boundary', raw: msg('CMD_OPEN_HISTORY_ITEM_DETAILS', { id: 'i' }), expected: { ok: true, payload: { id: 'i' } } },
    { label: 'valid boundary', raw: msg('CMD_OPEN_HISTORY_ITEM_DETAILS', { id: STR_256 }), expected: { ok: true, payload: { id: STR_256 } } },
    { label: 'empty id', raw: msg('CMD_OPEN_HISTORY_ITEM_DETAILS', { id: '' }), expected: { ok: false, reason: 'invalid-id' } },
    { label: 'over-length id', raw: msg('CMD_OPEN_HISTORY_ITEM_DETAILS', { id: STR_257 }), expected: { ok: false, reason: 'invalid-id' } }
  ],

  CMD_RESOLVE_AUDIT_POINTER: [
    { label: 'valid min boundary', raw: msg('CMD_RESOLVE_AUDIT_POINTER', { runId: 'r' }), expected: { ok: true, payload: { runId: 'r' } } },
    { label: 'valid boundary', raw: msg('CMD_RESOLVE_AUDIT_POINTER', { runId: STR_256 }), expected: { ok: true, payload: { runId: STR_256 } } },
    { label: 'empty runId', raw: msg('CMD_RESOLVE_AUDIT_POINTER', { runId: '' }), expected: { ok: false, reason: 'invalid-runId' } },
    { label: 'over-length runId', raw: msg('CMD_RESOLVE_AUDIT_POINTER', { runId: STR_257 }), expected: { ok: false, reason: 'invalid-runId' } }
  ],

  CMD_RESOLVE_HISTORY_DESCRIPTION: [
    { label: 'valid min boundary', raw: msg('CMD_RESOLVE_HISTORY_DESCRIPTION', { runId: 'r' }), expected: { ok: true, payload: { runId: 'r' } } },
    { label: 'valid boundary', raw: msg('CMD_RESOLVE_HISTORY_DESCRIPTION', { runId: STR_256 }), expected: { ok: true, payload: { runId: STR_256 } } },
    { label: 'empty runId', raw: msg('CMD_RESOLVE_HISTORY_DESCRIPTION', { runId: '' }), expected: { ok: false, reason: 'invalid-runId' } },
    { label: 'over-length runId', raw: msg('CMD_RESOLVE_HISTORY_DESCRIPTION', { runId: STR_257 }), expected: { ok: false, reason: 'invalid-runId' } },
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
    { label: 'valid min boundaries', raw: msg('CMD_SAVE_DEFINITION_DRAFT', { kind: 'phase', id: 'p', expectedDraftVersion: 'v', body: {} }), expected: { ok: true, payload: { kind: 'phase', id: 'p', expectedDraftVersion: 'v', body: {} } } },
    { label: 'valid null body with note', raw: msg('CMD_SAVE_DEFINITION_DRAFT', { kind: 'phase', id: STR_64, expectedDraftVersion: STR_128, body: null, note: STR_512 }), expected: { ok: true, payload: { kind: 'phase', id: STR_64, expectedDraftVersion: STR_128, body: null, note: STR_512 } } },
    { label: 'bad kind', raw: msg('CMD_SAVE_DEFINITION_DRAFT', { kind: 'bogus', id: 'p1', expectedDraftVersion: 'no-draft', body: {} }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'empty id', raw: msg('CMD_SAVE_DEFINITION_DRAFT', { kind: 'phase', id: '', expectedDraftVersion: 'no-draft', body: {} }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-length id', raw: msg('CMD_SAVE_DEFINITION_DRAFT', { kind: 'phase', id: STR_65, expectedDraftVersion: 'no-draft', body: {} }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'empty expectedDraftVersion', raw: msg('CMD_SAVE_DEFINITION_DRAFT', { kind: 'phase', id: 'p1', expectedDraftVersion: '', body: {} }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-length expectedDraftVersion', raw: msg('CMD_SAVE_DEFINITION_DRAFT', { kind: 'phase', id: 'p1', expectedDraftVersion: STR_129, body: {} }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'missing body rejected', raw: msg('CMD_SAVE_DEFINITION_DRAFT', { kind: 'phase', id: 'p1', expectedDraftVersion: 'no-draft' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'note 513 rejected', raw: msg('CMD_SAVE_DEFINITION_DRAFT', { kind: 'phase', id: 'p1', expectedDraftVersion: 'no-draft', body: {}, note: STR_513 }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'missing payload', raw: msg('CMD_SAVE_DEFINITION_DRAFT'), expected: { ok: false, reason: 'missing-payload' } }
  ],

  CMD_PUBLISH_DEFINITION: [
    { label: 'valid min boundaries', raw: msg('CMD_PUBLISH_DEFINITION', { kind: 'pipeline', id: 'p', expectedDraftVersion: 'v' }), expected: { ok: true, payload: { kind: 'pipeline', id: 'p', expectedDraftVersion: 'v' } } },
    { label: 'valid pipeline kind', raw: msg('CMD_PUBLISH_DEFINITION', { kind: 'pipeline', id: STR_64, expectedDraftVersion: STR_128 }), expected: { ok: true, payload: { kind: 'pipeline', id: STR_64, expectedDraftVersion: STR_128 } } },
    { label: 'missing payload collapses to invalid-payload', raw: msg('CMD_PUBLISH_DEFINITION'), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'bad kind', raw: msg('CMD_PUBLISH_DEFINITION', { kind: 'bogus', id: 'p1', expectedDraftVersion: 'v1' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'empty id', raw: msg('CMD_PUBLISH_DEFINITION', { kind: 'pipeline', id: '', expectedDraftVersion: 'v1' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-length id', raw: msg('CMD_PUBLISH_DEFINITION', { kind: 'pipeline', id: STR_65, expectedDraftVersion: 'v1' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'empty expectedDraftVersion', raw: msg('CMD_PUBLISH_DEFINITION', { kind: 'pipeline', id: 'p1', expectedDraftVersion: '' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-length expectedDraftVersion', raw: msg('CMD_PUBLISH_DEFINITION', { kind: 'pipeline', id: 'p1', expectedDraftVersion: STR_129 }), expected: { ok: false, reason: 'invalid-payload' } }
  ],

  CMD_DEACTIVATE_DEFINITION: [
    { label: 'valid min boundaries', raw: msg('CMD_DEACTIVATE_DEFINITION', { kind: 'workflow', id: 'w', expectedDraftVersion: 'v' }), expected: { ok: true, payload: { kind: 'workflow', id: 'w', expectedDraftVersion: 'v' } } },
    { label: 'valid', raw: msg('CMD_DEACTIVATE_DEFINITION', { kind: 'workflow', id: STR_64, expectedDraftVersion: STR_128 }), expected: { ok: true, payload: { kind: 'workflow', id: STR_64, expectedDraftVersion: STR_128 } } },
    { label: 'bad kind', raw: msg('CMD_DEACTIVATE_DEFINITION', { kind: 'bogus', id: 'w1', expectedDraftVersion: 'v2' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'empty id', raw: msg('CMD_DEACTIVATE_DEFINITION', { kind: 'workflow', id: '', expectedDraftVersion: 'v2' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-length id', raw: msg('CMD_DEACTIVATE_DEFINITION', { kind: 'workflow', id: STR_65, expectedDraftVersion: 'v2' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'empty expectedDraftVersion', raw: msg('CMD_DEACTIVATE_DEFINITION', { kind: 'workflow', id: 'w1', expectedDraftVersion: '' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-length expectedDraftVersion', raw: msg('CMD_DEACTIVATE_DEFINITION', { kind: 'workflow', id: 'w1', expectedDraftVersion: STR_129 }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'extra key', raw: msg('CMD_DEACTIVATE_DEFINITION', { kind: 'workflow', id: 'w1', expectedDraftVersion: 'v2', x: 1 }), expected: { ok: false, reason: 'invalid-payload' } }
  ],

  CMD_RESTORE_DEFINITION_VERSION: [
    { label: 'valid min boundaries', raw: msg('CMD_RESTORE_DEFINITION_VERSION', { kind: 'phase', id: 'p', expectedDraftVersion: 'v', fromVersionId: 'f' }), expected: { ok: true, payload: { kind: 'phase', id: 'p', expectedDraftVersion: 'v', fromVersionId: 'f' } } },
    { label: 'valid max boundaries', raw: msg('CMD_RESTORE_DEFINITION_VERSION', { kind: 'phase', id: STR_64, expectedDraftVersion: STR_128, fromVersionId: STR_128 }), expected: { ok: true, payload: { kind: 'phase', id: STR_64, expectedDraftVersion: STR_128, fromVersionId: STR_128 } } },
    { label: 'missing payload', raw: msg('CMD_RESTORE_DEFINITION_VERSION'), expected: { ok: false, reason: 'missing-payload' } },
    { label: 'bad kind', raw: msg('CMD_RESTORE_DEFINITION_VERSION', { kind: 'bogus', id: 'p1', expectedDraftVersion: 'no-draft', fromVersionId: 'v1' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'empty id', raw: msg('CMD_RESTORE_DEFINITION_VERSION', { kind: 'phase', id: '', expectedDraftVersion: 'no-draft', fromVersionId: 'v1' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-length id', raw: msg('CMD_RESTORE_DEFINITION_VERSION', { kind: 'phase', id: STR_65, expectedDraftVersion: 'no-draft', fromVersionId: 'v1' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'empty expectedDraftVersion', raw: msg('CMD_RESTORE_DEFINITION_VERSION', { kind: 'phase', id: 'p1', expectedDraftVersion: '', fromVersionId: 'v1' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-length expectedDraftVersion', raw: msg('CMD_RESTORE_DEFINITION_VERSION', { kind: 'phase', id: 'p1', expectedDraftVersion: STR_129, fromVersionId: 'v1' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'empty fromVersionId', raw: msg('CMD_RESTORE_DEFINITION_VERSION', { kind: 'phase', id: 'p1', expectedDraftVersion: 'no-draft', fromVersionId: '' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-length fromVersionId', raw: msg('CMD_RESTORE_DEFINITION_VERSION', { kind: 'phase', id: 'p1', expectedDraftVersion: 'no-draft', fromVersionId: STR_129 }), expected: { ok: false, reason: 'invalid-payload' } }
  ],

  CMD_DISCARD_DEFINITION_DRAFT: [
    { label: 'valid min boundaries', raw: msg('CMD_DISCARD_DEFINITION_DRAFT', { kind: 'phase', id: 'p', expectedDraftVersion: 'v' }), expected: { ok: true, payload: { kind: 'phase', id: 'p', expectedDraftVersion: 'v' } } },
    { label: 'valid', raw: msg('CMD_DISCARD_DEFINITION_DRAFT', { kind: 'phase', id: STR_64, expectedDraftVersion: STR_128 }), expected: { ok: true, payload: { kind: 'phase', id: STR_64, expectedDraftVersion: STR_128 } } },
    { label: 'missing payload', raw: msg('CMD_DISCARD_DEFINITION_DRAFT'), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'bad kind', raw: msg('CMD_DISCARD_DEFINITION_DRAFT', { kind: 'bogus', id: 'p1', expectedDraftVersion: 'v1' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'empty id', raw: msg('CMD_DISCARD_DEFINITION_DRAFT', { kind: 'phase', id: '', expectedDraftVersion: 'v1' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-length id', raw: msg('CMD_DISCARD_DEFINITION_DRAFT', { kind: 'phase', id: STR_65, expectedDraftVersion: 'v1' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'empty expectedDraftVersion', raw: msg('CMD_DISCARD_DEFINITION_DRAFT', { kind: 'phase', id: 'p1', expectedDraftVersion: '' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-length expectedDraftVersion', raw: msg('CMD_DISCARD_DEFINITION_DRAFT', { kind: 'phase', id: 'p1', expectedDraftVersion: STR_129 }), expected: { ok: false, reason: 'invalid-payload' } }
  ],

  CMD_PUBLISH_PACKAGE: [
    { label: 'valid min boundaries', raw: msg('CMD_PUBLISH_PACKAGE', { layers: [{ kind: 'phase', expectedRevision: 'r', definitions: [{ id: 'p', body: {} }] }] }), expected: { ok: true, payload: { layers: [{ kind: 'phase', expectedRevision: 'r', definitions: [{ id: 'p', body: {} }] }] } } },
    { label: 'valid max 500 definitions and max lengths', raw: msg('CMD_PUBLISH_PACKAGE', { layers: [{ kind: 'phase', expectedRevision: STR_128, definitions: MAX_PACKAGE_DEFINITIONS }] }), expected: { ok: true, payload: { layers: [{ kind: 'phase', expectedRevision: STR_128, definitions: MAX_PACKAGE_DEFINITIONS }] } } },
    { label: 'empty layers rejected', raw: msg('CMD_PUBLISH_PACKAGE', { layers: [] }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'bad layer kind rejected', raw: msg('CMD_PUBLISH_PACKAGE', { layers: [{ ...VALID_PACKAGE_LAYER, kind: 'bogus' }] }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'empty layer expectedRevision rejected', raw: msg('CMD_PUBLISH_PACKAGE', { layers: [{ ...VALID_PACKAGE_LAYER, expectedRevision: '' }] }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-length layer expectedRevision rejected', raw: msg('CMD_PUBLISH_PACKAGE', { layers: [{ ...VALID_PACKAGE_LAYER, expectedRevision: STR_129 }] }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'empty definitions rejected', raw: msg('CMD_PUBLISH_PACKAGE', { layers: [{ ...VALID_PACKAGE_LAYER, definitions: [] }] }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-cap 501 definitions rejected', raw: msg('CMD_PUBLISH_PACKAGE', { layers: [{ ...VALID_PACKAGE_LAYER, definitions: OVER_MAX_PACKAGE_DEFINITIONS }] }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'empty definition id rejected', raw: msg('CMD_PUBLISH_PACKAGE', { layers: [{ ...VALID_PACKAGE_LAYER, definitions: [{ id: '', body: {} }] }] }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-length definition id rejected', raw: msg('CMD_PUBLISH_PACKAGE', { layers: [{ ...VALID_PACKAGE_LAYER, definitions: [{ id: STR_65, body: {} }] }] }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'missing definition body rejected', raw: msg('CMD_PUBLISH_PACKAGE', { layers: [{ ...VALID_PACKAGE_LAYER, definitions: [{ id: 'p1' }] }] }), expected: { ok: false, reason: 'invalid-payload' } }
  ],

  CMD_READ_DEFINITION_VERSION: [
    { label: 'valid min boundaries', raw: msg('CMD_READ_DEFINITION_VERSION', { kind: 'phase', id: 'p', versionId: 'v' }), expected: { ok: true, payload: { kind: 'phase', id: 'p', versionId: 'v' } } },
    { label: 'valid', raw: msg('CMD_READ_DEFINITION_VERSION', { kind: 'phase', id: STR_64, versionId: STR_64 }), expected: { ok: true, payload: { kind: 'phase', id: STR_64, versionId: STR_64 } } },
    { label: 'pipeline rejected (canonical kinds only)', raw: msg('CMD_READ_DEFINITION_VERSION', { kind: 'pipeline', id: 'p1', versionId: 'v2' }), expected: { ok: false, reason: 'invalid-payload-field' } },
    { label: 'empty id', raw: msg('CMD_READ_DEFINITION_VERSION', { kind: 'phase', id: '', versionId: 'v2' }), expected: { ok: false, reason: 'invalid-payload-field' } },
    { label: 'over-length id', raw: msg('CMD_READ_DEFINITION_VERSION', { kind: 'phase', id: STR_65, versionId: 'v2' }), expected: { ok: false, reason: 'invalid-payload-field' } },
    { label: 'empty versionId', raw: msg('CMD_READ_DEFINITION_VERSION', { kind: 'phase', id: 'p1', versionId: '' }), expected: { ok: false, reason: 'invalid-payload-field' } },
    { label: 'over-length versionId', raw: msg('CMD_READ_DEFINITION_VERSION', { kind: 'phase', id: 'p1', versionId: STR_65 }), expected: { ok: false, reason: 'invalid-payload-field' } },
    { label: 'extra field (path smuggling)', raw: msg('CMD_READ_DEFINITION_VERSION', { kind: 'phase', id: 'p1', versionId: 'v2', filePath: '/etc' }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_EXPORT_PROCESS_YAML: [
    { label: 'valid modelCatalog', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'modelCatalog' }), expected: { ok: true, payload: { resourceKind: 'modelCatalog' } } },
    { label: 'valid phase min resourceId', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'phase', resourceId: 'p' }), expected: { ok: true, payload: { resourceKind: 'phase', resourceId: 'p' } } },
    { label: 'valid phase', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'phase', resourceId: STR_64 }), expected: { ok: true, payload: { resourceKind: 'phase', resourceId: STR_64 } } },
    { label: 'valid workflow min resourceId', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'workflow', resourceId: 'w', inclusion: 'references-only' }), expected: { ok: true, payload: { resourceKind: 'workflow', resourceId: 'w', inclusion: 'references-only' } } },
    { label: 'valid workflow max resourceId', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'workflow', resourceId: STR_64, inclusion: 'include-closure' }), expected: { ok: true, payload: { resourceKind: 'workflow', resourceId: STR_64, inclusion: 'include-closure' } } },
    { label: 'phase with inclusion rejected unexpected-payload-fields', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'phase', resourceId: 'p1', inclusion: 'references-only' }), expected: { ok: false, reason: 'unexpected-payload-fields' } },
    { label: 'modelCatalog with resourceId rejected unexpected-payload-fields', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'modelCatalog', resourceId: 'm1' }), expected: { ok: false, reason: 'unexpected-payload-fields' } },
    { label: 'modelCatalog with inclusion rejected invalid-inclusion', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'modelCatalog', inclusion: 'references-only' }), expected: { ok: false, reason: 'invalid-inclusion' } },
    { label: 'phase empty resourceId rejected', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'phase', resourceId: '' }), expected: { ok: false, reason: 'invalid-resource-id' } },
    { label: 'phase resourceId 65 rejected resource-id-too-long', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'phase', resourceId: STR_65 }), expected: { ok: false, reason: 'resource-id-too-long' } },
    { label: 'workflow empty resourceId rejected', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'workflow', resourceId: '', inclusion: 'references-only' }), expected: { ok: false, reason: 'invalid-resource-id' } },
    { label: 'workflow resourceId 65 rejected resource-id-too-long', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'workflow', resourceId: STR_65, inclusion: 'references-only' }), expected: { ok: false, reason: 'resource-id-too-long' } },
    { label: 'workflow bad inclusion rejected', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'workflow', resourceId: 'w1', inclusion: 'all-files' }), expected: { ok: false, reason: 'invalid-inclusion' } },
    { label: 'bad resourceKind', raw: msg('CMD_EXPORT_PROCESS_YAML', { resourceKind: 'pipeline', resourceId: 'p1' }), expected: { ok: false, reason: 'invalid-resource-kind' } }
  ],

  CMD_PREFLIGHT_PROCESS_YAML: [
    { label: 'valid empty obj', raw: msg('CMD_PREFLIGHT_PROCESS_YAML', {}), expected: { ok: true, payload: {} } },
    { label: 'any field rejected', raw: msg('CMD_PREFLIGHT_PROCESS_YAML', { filePath: '/tmp/x.yaml' }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  // ---- Family 7: phase-log (4) ----------------------------------------------
  CMD_READ_PHASE_LOG: [
    { label: 'valid null iteration', raw: msg('CMD_READ_PHASE_LOG', { selection: VALID_SELECTION_READ }), expected: { ok: true, payload: { selection: VALID_SELECTION_READ } } },
    { label: 'valid min iteration 1', raw: msg('CMD_READ_PHASE_LOG', { selection: VALID_SELECTION_TAIL }), expected: { ok: true, payload: { selection: VALID_SELECTION_TAIL } } },
    { label: 'valid omitted iteration normalizes to null', raw: msg('CMD_READ_PHASE_LOG', { selection: { queueId: 'default', taskId: 't1', pipelineId: 'p1', phaseId: 'ph1' } }), expected: { ok: true, payload: { selection: { queueId: 'default', taskId: 't1', pipelineId: 'p1', phaseId: 'ph1', iterationN: null } } } },
    { label: 'non-object selection rejected', raw: msg('CMD_READ_PHASE_LOG', { selection: null }), expected: { ok: false, reason: 'invalid-selection' } },
    { label: 'bad selection.queueId', raw: msg('CMD_READ_PHASE_LOG', { selection: { ...VALID_SELECTION_READ, queueId: '../q' } }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'bad selection.taskId', raw: msg('CMD_READ_PHASE_LOG', { selection: { ...VALID_SELECTION_READ, taskId: '../t' } }), expected: { ok: false, reason: 'invalid-taskId' } },
    { label: 'bad selection.pipelineId', raw: msg('CMD_READ_PHASE_LOG', { selection: { ...VALID_SELECTION_READ, pipelineId: '../p' } }), expected: { ok: false, reason: 'invalid-pipelineId' } },
    { label: 'path traversal selection.phaseId rejected', raw: msg('CMD_READ_PHASE_LOG', { selection: { ...VALID_SELECTION_READ, phaseId: '../etc' } }), expected: { ok: false, reason: 'invalid-phaseId' } },
    { label: 'iteration 0 rejected', raw: msg('CMD_READ_PHASE_LOG', { selection: { ...VALID_SELECTION_READ, iterationN: 0 } }), expected: { ok: false, reason: 'invalid-iterationN' } }
  ],

  CMD_START_PHASE_LOG_TAIL: [
    { label: 'valid min consumer & cursor', raw: msg('CMD_START_PHASE_LOG_TAIL', { selection: VALID_SELECTION_TAIL, consumer: 'c', fromCursor: 'a' }), expected: { ok: true, payload: { selection: VALID_SELECTION_TAIL, consumer: 'c', fromCursor: 'a' } } },
    { label: 'valid max consumer & cursor 160', raw: msg('CMD_START_PHASE_LOG_TAIL', { selection: VALID_SELECTION_TAIL, consumer: STR_64, fromCursor: STR_160 }), expected: { ok: true, payload: { selection: VALID_SELECTION_TAIL, consumer: STR_64, fromCursor: STR_160 } } },
    { label: 'non-object selection rejected', raw: msg('CMD_START_PHASE_LOG_TAIL', { selection: null }), expected: { ok: false, reason: 'invalid-selection' } },
    { label: 'bad selection.queueId', raw: msg('CMD_START_PHASE_LOG_TAIL', { selection: { ...VALID_SELECTION_TAIL, queueId: '../q' } }), expected: { ok: false, reason: 'invalid-queueId' } },
    { label: 'bad selection.taskId', raw: msg('CMD_START_PHASE_LOG_TAIL', { selection: { ...VALID_SELECTION_TAIL, taskId: '../t' } }), expected: { ok: false, reason: 'invalid-taskId' } },
    { label: 'bad selection.pipelineId', raw: msg('CMD_START_PHASE_LOG_TAIL', { selection: { ...VALID_SELECTION_TAIL, pipelineId: '../p' } }), expected: { ok: false, reason: 'invalid-pipelineId' } },
    { label: 'bad selection.phaseId', raw: msg('CMD_START_PHASE_LOG_TAIL', { selection: { ...VALID_SELECTION_TAIL, phaseId: '../ph' } }), expected: { ok: false, reason: 'invalid-phaseId' } },
    { label: 'iteration 0 rejected', raw: msg('CMD_START_PHASE_LOG_TAIL', { selection: { ...VALID_SELECTION_TAIL, iterationN: 0 } }), expected: { ok: false, reason: 'invalid-iterationN' } },
    { label: 'null iteration rejected', raw: msg('CMD_START_PHASE_LOG_TAIL', { selection: VALID_SELECTION_READ }), expected: { ok: false, reason: 'invalid-iterationN' } },
    { label: 'empty fromCursor rejected', raw: msg('CMD_START_PHASE_LOG_TAIL', { selection: VALID_SELECTION_TAIL, fromCursor: '' }), expected: { ok: false, reason: 'invalid-fromCursor' } },
    { label: 'over-length fromCursor 161 rejected', raw: msg('CMD_START_PHASE_LOG_TAIL', { selection: VALID_SELECTION_TAIL, fromCursor: STR_161 }), expected: { ok: false, reason: 'invalid-fromCursor' } },
    { label: 'control char in fromCursor rejected', raw: msg('CMD_START_PHASE_LOG_TAIL', { selection: VALID_SELECTION_TAIL, fromCursor: 'bad\ncursor' }), expected: { ok: false, reason: 'invalid-fromCursor' } },
    { label: 'empty consumer rejected', raw: msg('CMD_START_PHASE_LOG_TAIL', { selection: VALID_SELECTION_TAIL, consumer: '' }), expected: { ok: false, reason: 'invalid-consumer' } },
    { label: 'over-length consumer', raw: msg('CMD_START_PHASE_LOG_TAIL', { selection: VALID_SELECTION_TAIL, consumer: STR_65 }), expected: { ok: false, reason: 'invalid-consumer' } }
  ],

  CMD_STOP_PHASE_LOG_TAIL: [
    { label: 'valid min boundary', raw: msg('CMD_STOP_PHASE_LOG_TAIL', { sessionId: 's' }), expected: { ok: true, payload: { sessionId: 's' } } },
    { label: 'valid boundary', raw: msg('CMD_STOP_PHASE_LOG_TAIL', { sessionId: STR_256 }), expected: { ok: true, payload: { sessionId: STR_256 } } },
    { label: 'empty sessionId', raw: msg('CMD_STOP_PHASE_LOG_TAIL', { sessionId: '' }), expected: { ok: false, reason: 'invalid-sessionId' } },
    { label: 'over-length sessionId', raw: msg('CMD_STOP_PHASE_LOG_TAIL', { sessionId: STR_257 }), expected: { ok: false, reason: 'invalid-sessionId' } }
  ],

  CMD_ACK_PHASE_LOG_TAIL: [
    { label: 'valid min sessionId with flags', raw: msg('CMD_ACK_PHASE_LOG_TAIL', { sessionId: 's', batchSeq: 0, resync: true, duplicate: false }), expected: { ok: true, payload: { sessionId: 's', batchSeq: 0, resync: true, duplicate: false } } },
    { label: 'valid max sessionId', raw: msg('CMD_ACK_PHASE_LOG_TAIL', { sessionId: STR_256, batchSeq: 1 }), expected: { ok: true, payload: { sessionId: STR_256, batchSeq: 1 } } },
    { label: 'empty sessionId', raw: msg('CMD_ACK_PHASE_LOG_TAIL', { sessionId: '', batchSeq: 0 }), expected: { ok: false, reason: 'invalid-sessionId' } },
    { label: 'over-length sessionId', raw: msg('CMD_ACK_PHASE_LOG_TAIL', { sessionId: STR_257, batchSeq: 0 }), expected: { ok: false, reason: 'invalid-sessionId' } },
    { label: 'negative batchSeq', raw: msg('CMD_ACK_PHASE_LOG_TAIL', { sessionId: 's1', batchSeq: -1 }), expected: { ok: false, reason: 'invalid-batchSeq' } },
    { label: 'largest safe batchSeq', raw: msg('CMD_ACK_PHASE_LOG_TAIL', { sessionId: 's1', batchSeq: Number.MAX_SAFE_INTEGER }), expected: { ok: true, payload: { sessionId: 's1', batchSeq: Number.MAX_SAFE_INTEGER } } },
    { label: 'unsafe batchSeq', raw: msg('CMD_ACK_PHASE_LOG_TAIL', { sessionId: 's1', batchSeq: Number.MAX_SAFE_INTEGER + 1 }), expected: { ok: false, reason: 'invalid-batchSeq' } },
    { label: 'bad resync', raw: msg('CMD_ACK_PHASE_LOG_TAIL', { sessionId: 's1', batchSeq: 1, resync: 'yes' }), expected: { ok: false, reason: 'invalid-resync' } },
    { label: 'bad duplicate', raw: msg('CMD_ACK_PHASE_LOG_TAIL', { sessionId: 's1', batchSeq: 1, duplicate: 'no' }), expected: { ok: false, reason: 'invalid-duplicate' } }
  ],

  // ---- Family 8: analytics-reporting (5) ------------------------------------
  CMD_READ_METRICS: [
    { label: 'valid empty', raw: msg('CMD_READ_METRICS', {}), expected: { ok: true, payload: {} } },
    { label: 'empty array payload normalizes as an empty object', raw: msg('CMD_READ_METRICS', []), expected: { ok: true, payload: {} } },
    { label: 'populated array has unexpected indexed fields', raw: msg('CMD_READ_METRICS', [1]), expected: { ok: false, reason: 'unexpected-payload-fields' } },
    { label: 'valid with flags', raw: msg('CMD_READ_METRICS', { includeArchives: true, runIds: ['r1'] }), expected: { ok: true, payload: { includeArchives: true, runIds: ['r1'] } } },
    { label: 'valid max 64 runIds', raw: msg('CMD_READ_METRICS', { runIds: MAX_RUN_IDS }), expected: { ok: true, payload: { runIds: MAX_RUN_IDS } } },
    { label: 'non-boolean includeArchives', raw: msg('CMD_READ_METRICS', { includeArchives: 'yes' }), expected: { ok: false, reason: 'invalid-payload-field' } },
    { label: 'over-cap runIds', raw: msg('CMD_READ_METRICS', { runIds: Array.from({ length: 65 }, (_, i) => `r${i}`) }), expected: { ok: false, reason: 'invalid-payload-field' } },
    { label: 'extra key', raw: msg('CMD_READ_METRICS', { unknown: 1 }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_READ_STORAGE_DETAILS: [
    { label: 'valid empty', raw: msg('CMD_READ_STORAGE_DETAILS', {}), expected: { ok: true, payload: {} } },
    { label: 'valid min cursor', raw: msg('CMD_READ_STORAGE_DETAILS', { cursor: 'a' }), expected: { ok: true, payload: { cursor: 'a' } } },
    { label: 'valid max cursor 512', raw: msg('CMD_READ_STORAGE_DETAILS', { cursor: STR_512 }), expected: { ok: true, payload: { cursor: STR_512 } } },
    { label: 'empty cursor rejected', raw: msg('CMD_READ_STORAGE_DETAILS', { cursor: '' }), expected: { ok: false, reason: 'invalid-cursor' } },
    { label: 'over-length cursor 513 rejected', raw: msg('CMD_READ_STORAGE_DETAILS', { cursor: STR_513 }), expected: { ok: false, reason: 'invalid-cursor' } },
    { label: 'bad cursor chars', raw: msg('CMD_READ_STORAGE_DETAILS', { cursor: '../bad' }), expected: { ok: false, reason: 'invalid-cursor' } }
  ],

  CMD_READ_USAGE_ACCOUNTING: [
    { label: 'valid opaque query', raw: msg('CMD_READ_USAGE_ACCOUNTING', { query: { groupBy: ['backend'] } }), expected: { ok: true, payload: { query: { groupBy: ['backend'] } } } },
    { label: 'missing query', raw: msg('CMD_READ_USAGE_ACCOUNTING', {}), expected: { ok: false, reason: 'missing-query' } },
    { label: 'extra key', raw: msg('CMD_READ_USAGE_ACCOUNTING', { query: {}, extra: 1 }), expected: { ok: false, reason: 'unexpected-payload-fields' } }
  ],

  CMD_READ_REPORT: [
    { label: 'valid run', raw: msg('CMD_READ_REPORT', { op: 'run', query: { kind: 'summary' } }), expected: { ok: true, payload: { op: 'run', query: { kind: 'summary' } } } },
    { label: 'valid page min cursor', raw: msg('CMD_READ_REPORT', { op: 'page', cursor: 'a' }), expected: { ok: true, payload: { op: 'page', cursor: 'a' } } },
    { label: 'valid page max cursor 512', raw: msg('CMD_READ_REPORT', { op: 'page', cursor: STR_512 }), expected: { ok: true, payload: { op: 'page', cursor: STR_512 } } },
    { label: 'valid drillDown', raw: msg('CMD_READ_REPORT', { op: 'drillDown', reportId: 'rep-1', rootId: 'root-1' }), expected: { ok: true, payload: { op: 'drillDown', reportId: 'rep-1', rootId: 'root-1' } } },
    { label: 'valid close', raw: msg('CMD_READ_REPORT', { op: 'close', reportId: 'rep-1' }), expected: { ok: true, payload: { op: 'close', reportId: 'rep-1' } } },
    { label: 'valid rerunSaved', raw: msg('CMD_READ_REPORT', { op: 'rerunSaved', reportId: 'rep-1' }), expected: { ok: true, payload: { op: 'rerunSaved', reportId: 'rep-1' } } },
    { label: 'valid reproduceSaved', raw: msg('CMD_READ_REPORT', { op: 'reproduceSaved', reportId: 'rep-1' }), expected: { ok: true, payload: { op: 'reproduceSaved', reportId: 'rep-1' } } },
    { label: 'valid listSaved minimal', raw: msg('CMD_READ_REPORT', { op: 'listSaved' }), expected: { ok: true, payload: { op: 'listSaved' } } },
    { label: 'valid listSaved with request', raw: msg('CMD_READ_REPORT', { op: 'listSaved', request: { limit: 10 } }), expected: { ok: true, payload: { op: 'listSaved', request: { limit: 10 } } } },
    { label: 'valid cancelActive', raw: msg('CMD_READ_REPORT', { op: 'cancelActive' }), expected: { ok: true, payload: { op: 'cancelActive' } } },
    { label: 'missing op', raw: msg('CMD_READ_REPORT', {}), expected: { ok: false, reason: 'missing-op' } },
    { label: 'invalid op', raw: msg('CMD_READ_REPORT', { op: 'drop' }), expected: { ok: false, reason: 'invalid-op' } },
    { label: 'run missing query', raw: msg('CMD_READ_REPORT', { op: 'run' }), expected: { ok: false, reason: 'missing-query' } },
    { label: 'page empty cursor rejected', raw: msg('CMD_READ_REPORT', { op: 'page', cursor: '' }), expected: { ok: false, reason: 'invalid-cursor' } },
    { label: 'page bad cursor (over-length 513)', raw: msg('CMD_READ_REPORT', { op: 'page', cursor: STR_513 }), expected: { ok: false, reason: 'invalid-cursor' } },
    { label: 'drillDown bad reportId', raw: msg('CMD_READ_REPORT', { op: 'drillDown', reportId: '../x', rootId: 'r1' }), expected: { ok: false, reason: 'invalid-reportId' } },
    { label: 'drillDown bad rootId', raw: msg('CMD_READ_REPORT', { op: 'drillDown', reportId: 'rep-1', rootId: '../r' }), expected: { ok: false, reason: 'invalid-rootId' } },
    { label: 'close bad reportId', raw: msg('CMD_READ_REPORT', { op: 'close', reportId: '../x' }), expected: { ok: false, reason: 'invalid-reportId' } },
    { label: 'rerunSaved bad reportId', raw: msg('CMD_READ_REPORT', { op: 'rerunSaved', reportId: '../x' }), expected: { ok: false, reason: 'invalid-reportId' } },
    { label: 'reproduceSaved bad reportId', raw: msg('CMD_READ_REPORT', { op: 'reproduceSaved', reportId: '../x' }), expected: { ok: false, reason: 'invalid-reportId' } }
  ],

  CMD_MUTATE_REPORT: [
    { label: 'valid export', raw: msg('CMD_MUTATE_REPORT', { op: 'export', reportId: 'rep-1', format: 'csv' }), expected: { ok: true, payload: { op: 'export', reportId: 'rep-1', format: 'csv' } } },
    { label: 'valid save', raw: msg('CMD_MUTATE_REPORT', { op: 'save', reportId: 'rep-1' }), expected: { ok: true, payload: { op: 'save', reportId: 'rep-1' } } },
    { label: 'valid deleteSaved', raw: msg('CMD_MUTATE_REPORT', { op: 'deleteSaved', reportId: 'rep-1', confirmed: true }), expected: { ok: true, payload: { op: 'deleteSaved', reportId: 'rep-1', confirmed: true } } },
    { label: 'invalid op', raw: msg('CMD_MUTATE_REPORT', { op: 'drop' }), expected: { ok: false, reason: 'invalid-op' } },
    { label: 'export with path rejected', raw: msg('CMD_MUTATE_REPORT', { op: 'export', reportId: 'rep-1', format: 'json', destination: '/tmp/out' }), expected: { ok: false, reason: 'unexpected-payload-fields' } },
    { label: 'export bad reportId', raw: msg('CMD_MUTATE_REPORT', { op: 'export', reportId: '../rep', format: 'json' }), expected: { ok: false, reason: 'invalid-reportId' } },
    { label: 'export bad format', raw: msg('CMD_MUTATE_REPORT', { op: 'export', reportId: 'rep-1', format: 'xml' }), expected: { ok: false, reason: 'invalid-format' } },
    { label: 'save bad reportId', raw: msg('CMD_MUTATE_REPORT', { op: 'save', reportId: '../rep' }), expected: { ok: false, reason: 'invalid-reportId' } },
    { label: 'deleteSaved bad reportId', raw: msg('CMD_MUTATE_REPORT', { op: 'deleteSaved', reportId: '../rep', confirmed: true }), expected: { ok: false, reason: 'invalid-reportId' } },
    { label: 'deleteSaved missing confirmation', raw: msg('CMD_MUTATE_REPORT', { op: 'deleteSaved', reportId: 'rep-1', confirmed: false }), expected: { ok: false, reason: 'missing-confirmation' } }
  ],

  // ---- Family 9: execution-workflow (6) -------------------------------------
  CMD_LAUNCH_PIPELINE: [
    { label: 'valid minimal', raw: msg('CMD_LAUNCH_PIPELINE', { request: MIN_RUN_REQUEST }), expected: { ok: true, payload: { request: MIN_RUN_REQUEST } } },
    { label: 'valid min queueId', raw: msg('CMD_LAUNCH_PIPELINE', { request: MIN_RUN_REQUEST, queueId: 'q' }), expected: { ok: true, payload: { request: MIN_RUN_REQUEST, queueId: 'q' } } },
    { label: 'valid max queueId', raw: msg('CMD_LAUNCH_PIPELINE', { request: MIN_RUN_REQUEST, queueId: STR_256 }), expected: { ok: true, payload: { request: MIN_RUN_REQUEST, queueId: STR_256 } } },
    { label: 'empty queueId rejected', raw: msg('CMD_LAUNCH_PIPELINE', { request: MIN_RUN_REQUEST, queueId: '' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-length queueId rejected', raw: msg('CMD_LAUNCH_PIPELINE', { request: MIN_RUN_REQUEST, queueId: STR_257 }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'hostile catalogVersion injection rejected', raw: msg('CMD_LAUNCH_PIPELINE', { request: { ...MIN_RUN_REQUEST, catalogVersion: { kind: 'pipeline', id: 'default', versionId: 'v1' } } }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'missing payload', raw: msg('CMD_LAUNCH_PIPELINE'), expected: { ok: false, reason: 'missing-payload' } }
  ],

  CMD_LAUNCH_WORKFLOW: [
    { label: 'valid min boundaries', raw: msg('CMD_LAUNCH_WORKFLOW', { workflowId: 'w', startNodeId: 'n', request: MIN_RUN_REQUEST, queueId: 'q' }), expected: { ok: true, payload: { workflowId: 'w', startNodeId: 'n', request: MIN_RUN_REQUEST, queueId: 'q' } } },
    { label: 'valid max boundaries', raw: msg('CMD_LAUNCH_WORKFLOW', { workflowId: STR_64, startNodeId: STR_64, request: MIN_RUN_REQUEST, queueId: STR_256 }), expected: { ok: true, payload: { workflowId: STR_64, startNodeId: STR_64, request: MIN_RUN_REQUEST, queueId: STR_256 } } },
    { label: 'empty workflowId', raw: msg('CMD_LAUNCH_WORKFLOW', { workflowId: '', startNodeId: 'n1', request: MIN_RUN_REQUEST }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-length workflowId', raw: msg('CMD_LAUNCH_WORKFLOW', { workflowId: STR_65, startNodeId: 'n1', request: MIN_RUN_REQUEST }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'empty startNodeId', raw: msg('CMD_LAUNCH_WORKFLOW', { workflowId: 'wf1', startNodeId: '', request: MIN_RUN_REQUEST }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-length startNodeId', raw: msg('CMD_LAUNCH_WORKFLOW', { workflowId: 'wf1', startNodeId: STR_65, request: MIN_RUN_REQUEST }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'invalid request', raw: msg('CMD_LAUNCH_WORKFLOW', { workflowId: 'wf1', startNodeId: 'n1', request: null }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'empty queueId', raw: msg('CMD_LAUNCH_WORKFLOW', { workflowId: 'wf1', startNodeId: 'n1', request: MIN_RUN_REQUEST, queueId: '' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-length queueId', raw: msg('CMD_LAUNCH_WORKFLOW', { workflowId: 'wf1', startNodeId: 'n1', request: MIN_RUN_REQUEST, queueId: STR_257 }), expected: { ok: false, reason: 'invalid-payload' } }
  ],

  CMD_CONTINUE_WORKFLOW: [
    { label: 'valid min boundaries', raw: msg('CMD_CONTINUE_WORKFLOW', { connectedRunId: 'c', expectedRevision: 0, nodeId: 'n', request: MIN_RUN_REQUEST, invocationId: 'i', commandId: 'k' }), expected: { ok: true, payload: { connectedRunId: 'c', expectedRevision: 0, nodeId: 'n', request: MIN_RUN_REQUEST, invocationId: 'i', commandId: 'k' } } },
    {
      label: 'valid maximal with control fields and 65536 control ids',
      raw: msg('CMD_CONTINUE_WORKFLOW', {
        connectedRunId: STR_128,
        expectedRevision: 2,
        nodeId: STR_64,
        request: MIN_RUN_REQUEST,
        invocationId: STR_65536,
        operation: 'pause',
        commandId: STR_65536,
        controlCommand: VALID_CONTROL_COMMAND
      }),
      expected: {
        ok: true,
        payload: {
          connectedRunId: STR_128,
          expectedRevision: 2,
          nodeId: STR_64,
          request: MIN_RUN_REQUEST,
          invocationId: STR_65536,
          operation: 'pause',
          commandId: STR_65536,
          controlCommand: VALID_CONTROL_COMMAND
        }
      }
    },
    { label: 'empty connectedRunId rejected', raw: msg('CMD_CONTINUE_WORKFLOW', { connectedRunId: '', expectedRevision: 0, nodeId: 'n1', request: MIN_RUN_REQUEST }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-length connectedRunId rejected', raw: msg('CMD_CONTINUE_WORKFLOW', { connectedRunId: STR_129, expectedRevision: 0, nodeId: 'n1', request: MIN_RUN_REQUEST }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'negative revision rejected', raw: msg('CMD_CONTINUE_WORKFLOW', { connectedRunId: 'cr1', expectedRevision: -1, nodeId: 'n1', request: MIN_RUN_REQUEST }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'empty nodeId rejected', raw: msg('CMD_CONTINUE_WORKFLOW', { connectedRunId: 'cr1', expectedRevision: 0, nodeId: '', request: MIN_RUN_REQUEST }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-length nodeId rejected', raw: msg('CMD_CONTINUE_WORKFLOW', { connectedRunId: 'cr1', expectedRevision: 0, nodeId: STR_65, request: MIN_RUN_REQUEST }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'invalid request rejected', raw: msg('CMD_CONTINUE_WORKFLOW', { connectedRunId: 'cr1', expectedRevision: 0, nodeId: 'n1', request: {} }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'empty invocationId rejected', raw: msg('CMD_CONTINUE_WORKFLOW', { connectedRunId: 'cr1', expectedRevision: 0, nodeId: 'n1', request: MIN_RUN_REQUEST, invocationId: '' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-length invocationId 65537 rejected', raw: msg('CMD_CONTINUE_WORKFLOW', { connectedRunId: 'cr1', expectedRevision: 0, nodeId: 'n1', request: MIN_RUN_REQUEST, invocationId: STR_65537 }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'bad operation rejected', raw: msg('CMD_CONTINUE_WORKFLOW', { connectedRunId: 'cr1', expectedRevision: 1, nodeId: 'n1', request: MIN_RUN_REQUEST, operation: 'bogus' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'empty commandId rejected', raw: msg('CMD_CONTINUE_WORKFLOW', { connectedRunId: 'cr1', expectedRevision: 0, nodeId: 'n1', request: MIN_RUN_REQUEST, commandId: '' }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'over-length commandId 65537 rejected', raw: msg('CMD_CONTINUE_WORKFLOW', { connectedRunId: 'cr1', expectedRevision: 0, nodeId: 'n1', request: MIN_RUN_REQUEST, commandId: STR_65537 }), expected: { ok: false, reason: 'invalid-payload' } },
    { label: 'invalid controlCommand rejected', raw: msg('CMD_CONTINUE_WORKFLOW', { connectedRunId: 'cr1', expectedRevision: 0, nodeId: 'n1', request: MIN_RUN_REQUEST, controlCommand: { version: 2 } }), expected: { ok: false, reason: 'invalid-payload' } }
  ],

  CMD_READ_EXECUTION_VISIBILITY: [
    { label: 'valid attemptDetail', raw: msg('CMD_READ_EXECUTION_VISIBILITY', { op: 'attemptDetail', rootExecutionId: 'root:1', invocationId: 'inv-1', attemptId: 'att-1' }), expected: { ok: true, payload: { op: 'attemptDetail', rootExecutionId: 'root:1', invocationId: 'inv-1', attemptId: 'att-1' } } },
    { label: 'valid runtimePosture', raw: msg('CMD_READ_EXECUTION_VISIBILITY', { op: 'runtimePosture' }), expected: { ok: true, payload: { op: 'runtimePosture' } } },
    { label: 'bad op', raw: msg('CMD_READ_EXECUTION_VISIBILITY', { op: 'other' }), expected: { ok: false, reason: 'invalid-op' } },
    { label: 'traversal rootExecutionId', raw: msg('CMD_READ_EXECUTION_VISIBILITY', { op: 'attemptDetail', rootExecutionId: '../x' }), expected: { ok: false, reason: 'invalid-rootExecutionId' } },
    { label: 'traversal invocationId', raw: msg('CMD_READ_EXECUTION_VISIBILITY', { op: 'attemptDetail', rootExecutionId: 'root:1', invocationId: '../inv' }), expected: { ok: false, reason: 'invalid-invocationId' } },
    { label: 'traversal attemptId', raw: msg('CMD_READ_EXECUTION_VISIBILITY', { op: 'attemptDetail', rootExecutionId: 'root:1', attemptId: '../att' }), expected: { ok: false, reason: 'invalid-attemptId' } }
  ],

  CMD_OPEN_CHANGE_REVIEW: [
    { label: 'valid open', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'open', requestId: 'req-1', expectedRevision: 'rev-1', openInEditor: true }), expected: { ok: true, payload: { op: 'open', requestId: 'req-1', expectedRevision: 'rev-1', openInEditor: true } } },
    { label: 'valid refresh', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'refresh', reviewId: 'rev-1', openInEditor: false }), expected: { ok: true, payload: { op: 'refresh', reviewId: 'rev-1', openInEditor: false } } },
    { label: 'valid classify', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'classify', reviewId: 'rev-1' }), expected: { ok: true, payload: { op: 'classify', reviewId: 'rev-1' } } },
    { label: 'valid close', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'close', reviewId: 'rev-1' }), expected: { ok: true, payload: { op: 'close', reviewId: 'rev-1' } } },
    { label: 'valid page min cursor', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'page', cursor: 'a' }), expected: { ok: true, payload: { op: 'page', cursor: 'a' } } },
    { label: 'valid page max cursor 256', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'page', cursor: STR_256 }), expected: { ok: true, payload: { op: 'page', cursor: STR_256 } } },
    { label: 'valid cancelOpen', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'cancelOpen' }), expected: { ok: true, payload: { op: 'cancelOpen' } } },
    { label: 'open bad requestId', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'open', requestId: '../req' }), expected: { ok: false, reason: 'invalid-requestId' } },
    { label: 'open bad expectedRevision', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'open', requestId: 'req-1', expectedRevision: '../rev' }), expected: { ok: false, reason: 'invalid-expectedRevision' } },
    { label: 'open bad openInEditor', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'open', requestId: 'req-1', openInEditor: 'yes' }), expected: { ok: false, reason: 'invalid-openInEditor' } },
    { label: 'refresh bad reviewId', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'refresh', reviewId: '../rev' }), expected: { ok: false, reason: 'invalid-reviewId' } },
    { label: 'refresh bad openInEditor', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'refresh', reviewId: 'rev-1', openInEditor: 'yes' }), expected: { ok: false, reason: 'invalid-openInEditor' } },
    { label: 'classify bad reviewId', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'classify', reviewId: '../rev' }), expected: { ok: false, reason: 'invalid-reviewId' } },
    { label: 'close bad reviewId', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'close', reviewId: '../rev' }), expected: { ok: false, reason: 'invalid-reviewId' } },
    { label: 'empty cursor rejected', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'page', cursor: '' }), expected: { ok: false, reason: 'invalid-cursor' } },
    { label: 'over-length cursor 257 rejected', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'page', cursor: STR_257 }), expected: { ok: false, reason: 'invalid-cursor' } },
    { label: 'bad cursor', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'page', cursor: 'bad/cursor' }), expected: { ok: false, reason: 'invalid-cursor' } },
    { label: 'bad op', raw: msg('CMD_OPEN_CHANGE_REVIEW', { op: 'nope' }), expected: { ok: false, reason: 'invalid-op' } }
  ],

  CMD_DECIDE_PHASE_HANDOFF: [
    { label: 'valid approve', raw: msg('CMD_DECIDE_PHASE_HANDOFF', { op: 'approve', handoffId: 'h-1', expectedRevision: 1, decisionId: 'd-1' }), expected: { ok: true, payload: { op: 'approve', handoffId: 'h-1', expectedRevision: 1, decisionId: 'd-1' } } },
    { label: 'valid edit min baseRevision 1', raw: msg('CMD_DECIDE_PHASE_HANDOFF', { op: 'edit', handoffId: 'h-1', baseRevision: 1, replacementSources: [{ kind: 'a' }] }), expected: { ok: true, payload: { op: 'edit', handoffId: 'h-1', baseRevision: 1, replacementSources: [{ kind: 'a' }] } } },
    { label: 'bad op', raw: msg('CMD_DECIDE_PHASE_HANDOFF', { op: 'reject' }), expected: { ok: false, reason: 'invalid-op' } },
    { label: 'approve bad handoffId', raw: msg('CMD_DECIDE_PHASE_HANDOFF', { op: 'approve', handoffId: '../h', expectedRevision: 1, decisionId: 'd-1' }), expected: { ok: false, reason: 'invalid-handoffId' } },
    { label: 'approve revision 0 rejected', raw: msg('CMD_DECIDE_PHASE_HANDOFF', { op: 'approve', handoffId: 'h-1', expectedRevision: 0, decisionId: 'd-1' }), expected: { ok: false, reason: 'invalid-expectedRevision' } },
    { label: 'approve bad decisionId', raw: msg('CMD_DECIDE_PHASE_HANDOFF', { op: 'approve', handoffId: 'h-1', expectedRevision: 1, decisionId: '../d' }), expected: { ok: false, reason: 'invalid-decisionId' } },
    { label: 'edit bad handoffId', raw: msg('CMD_DECIDE_PHASE_HANDOFF', { op: 'edit', handoffId: '../h', baseRevision: 1, replacementSources: [] }), expected: { ok: false, reason: 'invalid-handoffId' } },
    { label: 'edit baseRevision 0 rejected', raw: msg('CMD_DECIDE_PHASE_HANDOFF', { op: 'edit', handoffId: 'h-1', baseRevision: 0, replacementSources: [] }), expected: { ok: false, reason: 'invalid-baseRevision' } },
    { label: 'non-array replacementSources', raw: msg('CMD_DECIDE_PHASE_HANDOFF', { op: 'edit', handoffId: 'h-1', baseRevision: 1, replacementSources: 'bad' }), expected: { ok: false, reason: 'invalid-replacementSources' } }
  ]
};

interface DescriptorFieldNode {
  readonly kind: 'field';
  readonly optional?: boolean;
  readonly nullable?: boolean;
  readonly ignoreInvalid?: boolean;
  readonly schema: DescriptorSchemaNode;
}

interface DescriptorSchemaNode {
  readonly kind: string;
  readonly fields?: Readonly<Record<string, DescriptorFieldNode>>;
  readonly discriminator?: string;
  readonly arms?: Readonly<Record<string, DescriptorSchemaNode>>;
  readonly item?: DescriptorSchemaNode;
  readonly minLen?: number;
  readonly maxLen?: number;
  readonly min?: number;
  readonly max?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly trim?: boolean;
  readonly jsonSchema?: {
    readonly minItems?: number;
    readonly maxItems?: number;
  };
}

interface DescriptorCommand {
  readonly type: CommandType;
  readonly payloadMode: 'none' | 'optional' | 'optional-empty-object' | 'required';
  readonly payload?: DescriptorSchemaNode;
}

interface FieldTarget {
  readonly arm?: { readonly discriminator: string; readonly value: string };
  readonly path: readonly string[]; // segments; `'[]'` indexes element 0 of an array
  readonly optional: boolean;
  readonly ignoreInvalid: boolean;
  readonly isUnknownLeaf: boolean;
  readonly schema: DescriptorSchemaNode;
}

function collectFieldTargets(
  schema: DescriptorSchemaNode | undefined,
  arm?: { readonly discriminator: string; readonly value: string },
  prefix: readonly string[] = [],
  parentIgnoreInvalid = false
): FieldTarget[] {
  if (!schema) return [];
  if (schema.kind === 'discUnion' && schema.discriminator && schema.arms) {
    const out: FieldTarget[] = [];
    for (const [armValue, armSchema] of Object.entries(schema.arms)) {
      out.push(
        ...collectFieldTargets(armSchema, { discriminator: schema.discriminator, value: armValue })
      );
    }
    return out;
  }
  if (schema.kind === 'object' && schema.fields) {
    const out: FieldTarget[] = [];
    for (const [key, field] of Object.entries(schema.fields)) {
      if (arm && prefix.length === 0 && key === arm.discriminator) continue;
      const nextPath = [...prefix, key];
      const ignoreInvalid = parentIgnoreInvalid || Boolean(field.ignoreInvalid);
      out.push({
        ...(arm ? { arm } : {}),
        path: nextPath,
        optional: Boolean(field.optional),
        ignoreInvalid,
        isUnknownLeaf: field.schema.kind === 'unknown',
        schema: field.schema
      });
      if (field.schema.kind === 'object') {
        out.push(...collectFieldTargets(field.schema, arm, nextPath, ignoreInvalid));
      } else if (field.schema.kind === 'array' && field.schema.item?.kind === 'object') {
        out.push(...collectFieldTargets(field.schema.item, arm, [...nextPath, '[]'], ignoreInvalid));
      }
    }
    return out;
  }
  return [];
}

function getAtPath(root: unknown, segments: readonly string[]): { present: boolean; value: unknown } {
  let current: unknown = root;
  for (const seg of segments) {
    if (seg === '[]') {
      if (!Array.isArray(current) || current.length === 0) return { present: false, value: undefined };
      current = current[0];
      continue;
    }
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return { present: false, value: undefined };
    }
    const rec = current as Record<string, unknown>;
    if (!(seg in rec)) return { present: false, value: undefined };
    current = rec[seg];
  }
  return { present: true, value: current };
}

function patchAtPath(root: Record<string, unknown>, segments: readonly string[], value: unknown): Record<string, unknown> | null {
  const cloned = structuredClone(root);
  let current: unknown = cloned['payload'];
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i]!;
    if (seg === '[]') {
      if (!Array.isArray(current) || current.length === 0) return null;
      current = current[0];
      continue;
    }
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[seg];
  }
  if (current === null || typeof current !== 'object' || Array.isArray(current)) return null;
  const leaf = segments[segments.length - 1]!;
  (current as Record<string, unknown>)[leaf] = structuredClone(value);
  return cloned;
}

describe('FR-R7-05 (SC-001) & FR-R7-11 (Task 12) — 71-command differential validation corpus', () => {
  it('covers all 71 commands declared in COMMAND_TYPES without omissions', () => {
    const covered = Object.keys(CORPUS).sort();
    const declared = [...COMMAND_TYPES].sort();
    expect(covered).toEqual(declared);
    expect(covered).toHaveLength(71);
  });

  it('matches the pinned inbound acceptance decisions after JSON serialization', () => {
    const schemaPath = path.resolve(__dirname, '../../../src/contracts/generated/schemas/sidebar-ipc.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as JsonSchemaNode;
    for (const [command, cases] of Object.entries(CORPUS)) {
      for (const tc of cases) {
        const wire: unknown = JSON.parse(JSON.stringify(tc.raw));
        const result = validateAgainstSchema(schema, wire, `#/$defs/Command_${command}`);
        expect(result.valid, `${command}: ${tc.label}`).toBe(tc.expected.ok);
      }
    }
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

  it('enforces the intended sparse-array rejection policy (invalid-payload on array holes)', () => {
    // 1. CMD_PUBLISH_PACKAGE.layers with leading and trailing holes
    const sparseLayersLeading = new Array<unknown>(2);
    sparseLayersLeading[1] = VALID_PACKAGE_LAYER;
    expect(validateInboundMessage(msg('CMD_PUBLISH_PACKAGE', { layers: sparseLayersLeading }))).toEqual({
      ok: false,
      reason: 'invalid-payload',
      type: 'CMD_PUBLISH_PACKAGE',
      correlationId: CID
    });

    const sparseLayersTrailing = new Array<unknown>(2);
    sparseLayersTrailing[0] = VALID_PACKAGE_LAYER;
    expect(validateInboundMessage(msg('CMD_PUBLISH_PACKAGE', { layers: sparseLayersTrailing }))).toEqual({
      ok: false,
      reason: 'invalid-payload',
      type: 'CMD_PUBLISH_PACKAGE',
      correlationId: CID
    });

    // 2. CMD_PUBLISH_PACKAGE.layers[].definitions with a hole
    const sparseDefs = new Array<unknown>(2);
    sparseDefs[1] = { id: 'p1', body: {} };
    expect(
      validateInboundMessage(
        msg('CMD_PUBLISH_PACKAGE', {
          layers: [{ ...VALID_PACKAGE_LAYER, definitions: sparseDefs }]
        })
      )
    ).toEqual({
      ok: false,
      reason: 'invalid-payload',
      type: 'CMD_PUBLISH_PACKAGE',
      correlationId: CID
    });

    // 3. CMD_SAVE_MODELS.models[k] with a hole
    const sparseModels = new Array<unknown>(2);
    sparseModels[1] = 'claude-sonnet-5-5';
    expect(validateInboundMessage(msg('CMD_SAVE_MODELS', { models: { claude: sparseModels } }))).toEqual({
      ok: false,
      reason: 'invalid-payload',
      type: 'CMD_SAVE_MODELS',
      correlationId: CID
    });
  });

  it('structurally proves every validated field, union arm, and declared bound across all 71 commands is exercised in isolation', async () => {
    const descriptorsUrl = pathToFileURL(
      path.resolve(__dirname, '../../../scripts/contracts/ipc-descriptors/index.mjs')
    ).href;
    const { ALL_IPC_COMMANDS } = (await import(descriptorsUrl)) as {
      ALL_IPC_COMMANDS: readonly DescriptorCommand[];
    };
    expect(ALL_IPC_COMMANDS).toHaveLength(71);

    const gaps: string[] = [];

    for (const cmd of ALL_IPC_COMMANDS) {
      const cases = CORPUS[cmd.type];
      const okCases = cases.filter((tc) => tc.expected.ok);
      const failCases = cases.filter((tc) => !tc.expected.ok);

      if (okCases.length === 0) {
        gaps.push(`${cmd.type}: no accepted case`);
        continue;
      }
      if (failCases.length === 0) {
        gaps.push(`${cmd.type}: no rejected case`);
        continue;
      }

      if (cmd.payloadMode === 'none') {
        continue;
      }

      // Discriminated union arm coverage + invalid discriminator rejection
      if (cmd.payload?.kind === 'discUnion' && cmd.payload.discriminator && cmd.payload.arms) {
        const disc = cmd.payload.discriminator;
        const armNames = Object.keys(cmd.payload.arms);
        const hasInvalidDisc = failCases.some((tc) => {
          const payload = tc.raw['payload'];
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
          const val = (payload as Record<string, unknown>)[disc];
          return typeof val === 'string' && !armNames.includes(val);
        });
        if (!hasInvalidDisc) {
          gaps.push(`${cmd.type}: missing invalid discriminator rejection for '${disc}'`);
        }
        for (const armName of armNames) {
          const armOk = okCases.filter((tc) => {
            const payload = tc.raw['payload'];
            return Boolean(payload && typeof payload === 'object' && (payload as Record<string, unknown>)[disc] === armName);
          });
          if (armOk.length === 0) {
            gaps.push(`${cmd.type}: union arm ${disc}='${armName}' has no accepted case`);
          }
        }
      }

      const targets = collectFieldTargets(cmd.payload);
      for (const target of targets) {
        const fieldLabel = target.arm
          ? `${cmd.type}[${target.arm.discriminator}=${target.arm.value}].${target.path.join('.')}`
          : `${cmd.type}.${target.path.join('.')}`;

        const matchingScope = (tc: DifferentialCase): boolean => {
          if (!target.arm) return true;
          const payload = tc.raw['payload'];
          return Boolean(
            payload &&
              typeof payload === 'object' &&
              (payload as Record<string, unknown>)[target.arm.discriminator] === target.arm.value
          );
        };

        const scopedOk = okCases.filter(matchingScope);
        const scopedFail = failCases.filter(matchingScope);

        // 1. At least one valid case must populate the field with a valid value.
        const validProvider = scopedOk.find((tc) => {
          const found = getAtPath(tc.raw['payload'], target.path);
          return found.present && found.value !== undefined;
        });
        if (!validProvider) {
          gaps.push(`${fieldLabel}: no accepted case supplies a value`);
          continue;
        }
        const goodValue = getAtPath(validProvider.raw['payload'], target.path).value;

        // 2. Optional `unknown` fields accept any value when present; require both omitted & supplied valid cases.
        if (target.optional && target.isUnknownLeaf) {
          const hasOmitted = scopedOk.some((tc) => !getAtPath(tc.raw['payload'], target.path).present);
          if (!hasOmitted) {
            gaps.push(`${fieldLabel}: optional unknown field missing omitted-field accepted case`);
          }
          continue;
        }

        // 3. `ignoreInvalid` fields strip invalid inputs rather than failing; require an accepted case
        //    where the raw field is present with an invalid value and stripped from expected.payload.
        if (target.ignoreInvalid) {
          const topKey = target.path[0]!;
          const hasStripped = scopedOk.some((tc) => {
            const rawPresent = getAtPath(tc.raw['payload'], target.path).present;
            const outPayload = tc.expected.ok ? tc.expected.payload : undefined;
            const outPresent =
              outPayload !== undefined &&
              outPayload !== null &&
              typeof outPayload === 'object' &&
              topKey in (outPayload as Record<string, unknown>);
            return rawPresent && !outPresent;
          });
          if (!hasStripped) {
            gaps.push(`${fieldLabel}: ignoreInvalid field missing invalid-input-stripped case`);
          }
          continue;
        }

        // 4. Every other validated field must have an isolated rejection case where patching ONLY
        //    this field to `goodValue` flips `validateInboundMessage` from `ok: false` to `ok: true`.
        const isIsolatedFailure = (tc: DifferentialCase): boolean => {
          const patched = patchAtPath(tc.raw, target.path, goodValue);
          if (!patched) return false;
          return validateInboundMessage(patched).ok;
        };

        const hasIsolatedRejection = scopedFail.some((tc) => {
          const current = getAtPath(tc.raw['payload'], target.path);
          if (current.present && JSON.stringify(current.value) === JSON.stringify(goodValue)) {
            return false;
          }
          return isIsolatedFailure(tc);
        });

        if (!hasIsolatedRejection) {
          gaps.push(`${fieldLabel}: missing isolated rejection case (constant-held or untested)`);
        }

        // 5. Structural boundary enforcement: every declared numeric/length/array bound
        //    (`minLen`, `maxLen`, `min`, `max`, `minItems`, `maxItems`) must have at-bound valid
        //    AND isolated over/under-bound rejection vectors in CORPUS.
        const s = target.schema;
        const effectiveStrLen = (value: unknown): number | null => {
          if (typeof value !== 'string') return null;
          return s.trim ? value.trim().length : value.length;
        };

        if (s.minLen !== undefined) {
          const minLen = s.minLen;
          const hasAtMinLen = scopedOk.some((tc) => {
            const f = getAtPath(tc.raw['payload'], target.path);
            return f.present && effectiveStrLen(f.value) === minLen;
          });
          if (!hasAtMinLen) {
            gaps.push(`${fieldLabel}: missing at-bound valid case for minLen=${minLen}`);
          }
          if (minLen > 0) {
            const hasUnderMinLen = scopedFail.some((tc) => {
              const f = getAtPath(tc.raw['payload'], target.path);
              const len = f.present ? effectiveStrLen(f.value) : null;
              return len !== null && len < minLen && isIsolatedFailure(tc);
            });
            if (!hasUnderMinLen) {
              gaps.push(`${fieldLabel}: missing isolated under-bound rejection case for minLen=${minLen}`);
            }
          }
        }

        if (s.maxLen !== undefined) {
          const maxLen = s.maxLen;
          const hasAtMaxLen = scopedOk.some((tc) => {
            const f = getAtPath(tc.raw['payload'], target.path);
            return f.present && effectiveStrLen(f.value) === maxLen;
          });
          if (!hasAtMaxLen) {
            gaps.push(`${fieldLabel}: missing at-bound valid case for maxLen=${maxLen}`);
          }
          const hasOverMaxLen = scopedFail.some((tc) => {
            const f = getAtPath(tc.raw['payload'], target.path);
            if (!f.present || typeof f.value !== 'string') return false;
            const len = effectiveStrLen(f.value);
            if (len !== maxLen + 1 || !isIsolatedFailure(tc)) return false;
            const trimmedToBound = (s.trim ? f.value.trim() : f.value).slice(0, maxLen);
            const patchedAtBound = patchAtPath(tc.raw, target.path, trimmedToBound);
            return patchedAtBound !== null && validateInboundMessage(patchedAtBound).ok;
          });
          if (!hasOverMaxLen) {
            gaps.push(`${fieldLabel}: missing isolated over-bound rejection case for maxLen=${maxLen} (len=${maxLen + 1})`);
          }
        }

        if (s.min !== undefined) {
          const minVal = s.min;
          const hasAtMin = scopedOk.some((tc) => {
            const f = getAtPath(tc.raw['payload'], target.path);
            return f.present && typeof f.value === 'number' && f.value === minVal;
          });
          if (!hasAtMin) {
            gaps.push(`${fieldLabel}: missing at-bound valid case for min=${minVal}`);
          }
          const hasUnderMin = scopedFail.some((tc) => {
            const f = getAtPath(tc.raw['payload'], target.path);
            if (!f.present || typeof f.value !== 'number') return false;
            const under = s.kind === 'integer' ? f.value === minVal - 1 : f.value < minVal;
            return under && isIsolatedFailure(tc);
          });
          if (!hasUnderMin) {
            gaps.push(`${fieldLabel}: missing isolated under-bound rejection case for min=${minVal}`);
          }
        }

        if (s.max !== undefined) {
          const maxVal = s.max;
          const hasAtMax = scopedOk.some((tc) => {
            const f = getAtPath(tc.raw['payload'], target.path);
            return f.present && typeof f.value === 'number' && f.value === maxVal;
          });
          if (!hasAtMax) {
            gaps.push(`${fieldLabel}: missing at-bound valid case for max=${maxVal}`);
          }
          const hasOverMax = scopedFail.some((tc) => {
            const f = getAtPath(tc.raw['payload'], target.path);
            if (!f.present || typeof f.value !== 'number') return false;
            const over = s.kind === 'integer' ? f.value === maxVal + 1 : f.value > maxVal;
            return over && isIsolatedFailure(tc);
          });
          if (!hasOverMax) {
            gaps.push(`${fieldLabel}: missing isolated over-bound rejection case for max=${maxVal}`);
          }
        }

        const minItems = s.minItems ?? s.jsonSchema?.minItems;
        if (minItems !== undefined) {
          const hasAtMinItems = scopedOk.some((tc) => {
            const f = getAtPath(tc.raw['payload'], target.path);
            return f.present && Array.isArray(f.value) && f.value.length === minItems;
          });
          if (!hasAtMinItems) {
            gaps.push(`${fieldLabel}: missing at-bound valid case for minItems=${minItems}`);
          }
          if (minItems > 0) {
            const hasUnderMinItems = scopedFail.some((tc) => {
              const f = getAtPath(tc.raw['payload'], target.path);
              return f.present && Array.isArray(f.value) && f.value.length < minItems && isIsolatedFailure(tc);
            });
            if (!hasUnderMinItems) {
              gaps.push(`${fieldLabel}: missing isolated under-bound rejection case for minItems=${minItems}`);
            }
          }
        }

        const maxItems = s.maxItems ?? s.jsonSchema?.maxItems;
        if (maxItems !== undefined) {
          const hasAtMaxItems = scopedOk.some((tc) => {
            const f = getAtPath(tc.raw['payload'], target.path);
            return f.present && Array.isArray(f.value) && f.value.length === maxItems;
          });
          if (!hasAtMaxItems) {
            gaps.push(`${fieldLabel}: missing at-bound valid case for maxItems=${maxItems}`);
          }
          const hasOverMaxItems = scopedFail.some((tc) => {
            const f = getAtPath(tc.raw['payload'], target.path);
            if (!f.present || !Array.isArray(f.value)) return false;
            if (f.value.length !== maxItems + 1 || !isIsolatedFailure(tc)) return false;
            const patchedAtBound = patchAtPath(tc.raw, target.path, f.value.slice(0, maxItems));
            return patchedAtBound !== null && validateInboundMessage(patchedAtBound).ok;
          });
          if (!hasOverMaxItems) {
            gaps.push(`${fieldLabel}: missing isolated over-bound rejection case for maxItems=${maxItems} (len=${maxItems + 1})`);
          }
        }
      }
    }

    expect(gaps, `Per-field differential coverage gaps:\n- ${gaps.join('\n- ')}`).toEqual([]);
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
