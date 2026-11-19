// Family 2: queue-management (7 commands)

import { d } from '../descriptor-dsl.mjs';
import { QUEUE_FAILURE_POLICIES } from '../canonical-enums.mjs';

const QUEUE_ID_MAX = 256;
const MAX_QUEUE_NAME_LENGTH = 64;
const MAX_QUEUES = 20;

const queueIdField = (err = 'invalid-queueId') =>
  d.str({ minLen: 1, maxLen: QUEUE_ID_MAX, err });

const queueNameField = () =>
  d.str({
    trim: true,
    minLen: 1,
    maxLen: MAX_QUEUE_NAME_LENGTH,
    err: 'invalid-queue-name'
  });

export const QUEUE_MANAGEMENT_COMMANDS = Object.freeze([
  d.command({
    type: 'CMD_CREATE_QUEUE',
    interfaceName: 'CreateQueueCommand',
    validatorName: 'validateCreateQueue',
    family: 'queue-management',
    emitInterface: false,
    doc: 'Create a new named queue.',
    payloadMode: 'required',
    payload: d.obj({ name: queueNameField() })
  }),

  d.command({
    type: 'CMD_RENAME_QUEUE',
    interfaceName: 'RenameQueueCommand',
    validatorName: 'validateRenameQueue',
    family: 'queue-management',
    emitInterface: false,
    doc: 'Rename an existing queue.',
    payloadMode: 'required',
    payload: d.obj({
      queueId: queueIdField(),
      name: queueNameField()
    })
  }),

  d.command({
    type: 'CMD_DELETE_QUEUE',
    interfaceName: 'DeleteQueueCommand',
    validatorName: 'validateDeleteQueue',
    family: 'queue-management',
    emitInterface: false,
    doc: 'Two-phase queue deletion (preview without confirmed, execute with confirmed: true).',
    payloadMode: 'required',
    payload: d.obj({
      queueId: queueIdField(),
      confirmed: d.field(d.lit(true, { err: 'invalid-confirmation' }), {
        optional: true,
        omitIfFalse: true
      })
    })
  }),

  d.command({
    type: 'CMD_SAVE_QUEUE_SETTINGS',
    interfaceName: 'SaveQueueSettingsCommand',
    validatorName: 'validateSaveQueueSettings',
    family: 'queue-management',
    emitInterface: false,
    doc: 'Persist workspace queue concurrency cap and default queue id.',
    payloadMode: 'required',
    payload: d.obj({
      globalConcurrencyCap: d.int({ min: 1, max: MAX_QUEUES, err: 'invalid-concurrency-cap' }),
      defaultQueueId: queueIdField()
    })
  }),

  d.command({
    type: 'CMD_SET_QUEUE_FAILURE_POLICY',
    interfaceName: 'SetQueueFailurePolicyCommand',
    validatorName: 'validateSetQueueFailurePolicy',
    family: 'queue-management',
    emitInterface: false,
    doc: 'Set a queue-level halt-on-failure override or null to inherit workspace default.',
    payloadMode: 'required',
    payload: d.obj({
      queueId: queueIdField(),
      policy: d.field(
        d.enum(QUEUE_FAILURE_POLICIES, { err: 'invalid-failure-policy' }),
        { nullable: true }
      )
    })
  }),

  d.command({
    type: 'CMD_ATTEST_TASK_COMPLETED',
    interfaceName: 'AttestTaskCompletedCommand',
    validatorName: 'validateAttestTaskCompleted',
    family: 'queue-management',
    emitInterface: false,
    doc: 'Operator attests that a failed task completed externally.',
    payloadMode: 'required',
    payload: d.obj({
      taskId: d.str({ minLen: 1, maxLen: QUEUE_ID_MAX, err: 'invalid-taskId' }),
      confirmed: d.lit(true, { err: 'missing-confirmation' })
    })
  }),

  d.command({
    type: 'CMD_MOVE_TASK',
    interfaceName: 'MoveTaskCommand',
    validatorName: 'validateMoveTask',
    family: 'queue-management',
    emitInterface: false,
    doc: 'Move a task across queues with an optional insertion position.',
    payloadMode: 'required',
    payload: d.obj({
      taskId: d.str({ minLen: 1, maxLen: QUEUE_ID_MAX, err: 'invalid-taskId' }),
      targetQueueId: queueIdField(),
      position: d.field(d.int({ min: 0, err: 'invalid-position' }), { optional: true })
    })
  })
]);
