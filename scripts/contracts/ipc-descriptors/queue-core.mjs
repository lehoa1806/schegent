// Family 1: queue-core (15 commands)
// Source of truth for host types, zero-cast inbound validators, and JSON Schema.

import { d } from '../descriptor-dsl.mjs';

const QUEUE_ID_MAX = 256;
const DESCRIPTION_MAX = 4096;
const PAUSED_REASON_MAX_LENGTH = 500;

const idField = (err = 'invalid-id') =>
  d.str({ minLen: 1, maxLen: QUEUE_ID_MAX, err });

const queueIdField = (err = 'invalid-queueId') =>
  d.str({ minLen: 1, maxLen: QUEUE_ID_MAX, err });

const taskIdField = (err = 'invalid-taskId') =>
  d.str({ minLen: 1, maxLen: QUEUE_ID_MAX, err });

const phaseIdField = (err = 'invalid-phaseId') =>
  d.str({ minLen: 1, maxLen: QUEUE_ID_MAX, err });

export const QUEUE_CORE_COMMANDS = Object.freeze([
  d.command({
    type: 'CMD_START',
    interfaceName: 'StartCommand',
    validatorName: 'validateStart',
    family: 'queue-core',
    doc: 'Enqueue a new feature request onto a queue with optional pipeline, position, and start-intent overrides.',
    payloadMode: 'required',
    payload: d.obj(
      {
        description: d.str({
          trim: true,
          minLen: 1,
          maxLen: DESCRIPTION_MAX,
          typeErr: 'description-not-string',
          rangeErr: 'description-out-of-range',
          doc: 'Operator-authored task description (trimmed, 1..4096 chars).'
        }),
        pipelineId: d.field(
          d.str({ typeErr: 'pipelineId-not-string', doc: 'Optional catalog pipeline override.' }),
          { optional: true, omitIfEmpty: true }
        ),
        queueId: d.field(queueIdField('invalid-queueId'), {
          optional: true,
          omitIfEmpty: true,
          doc: 'Optional target queue identifier.'
        }),
        position: d.field(d.int({ min: 0, err: 'invalid-position' }), {
          optional: true,
          doc: 'Optional zero-based insertion index.'
        }),
        startIntent: d.field(
          d.ref('EnqueueStartIntent', {
            tsType: 'EnqueueStartIntent',
            tsImport: '../start-intent-types',
            predicate: {
              fn: 'isValidEnqueueStartIntent',
              importFrom: '../../start-intent-types',
              err: 'invalid-start-intent'
            }
          }),
          { optional: true, doc: 'Optional start-mode intent (Feature 065).' }
        )
      },
      { allowArray: true }
    )
  }),

  d.command({
    type: 'CMD_CANCEL',
    interfaceName: 'CancelCommand',
    validatorName: 'validateCancel',
    family: 'queue-core',
    doc: 'Cancel a target task/run resolved explicitly by FeatureRequest.id.',
    payloadMode: 'required',
    payload: d.obj({ taskId: taskIdField() }, { allowArray: true })
  }),

  d.command({
    type: 'CMD_REMOVE_QUEUE_ITEM',
    interfaceName: 'RemoveQueueItemCommand',
    validatorName: 'validateRemoveQueueItem',
    family: 'queue-core',
    doc: 'Remove an item from a queue after explicit operator confirmation.',
    payloadMode: 'required',
    payload: d.obj(
      {
        id: idField(),
        confirmed: d.lit(true, { err: 'missing-confirmation' })
      },
      { allowArray: true }
    )
  }),

  d.command({
    type: 'CMD_RETRY_QUEUE_ITEM',
    interfaceName: 'RetryQueueItemCommand',
    validatorName: 'validateRetryQueueItem',
    family: 'queue-core',
    doc: 'Retry a failed or canceled queue item by id.',
    payloadMode: 'required',
    payload: d.obj({ id: idField() }, { allowArray: true })
  }),

  d.command({
    type: 'CMD_MOVE_QUEUE_ITEM_UP',
    interfaceName: 'MoveQueueItemUpCommand',
    validatorName: 'validateMoveQueueItemUp',
    family: 'queue-core',
    doc: 'Move a pending queue item one position earlier.',
    payloadMode: 'required',
    payload: d.obj({ id: idField() }, { allowArray: true })
  }),

  d.command({
    type: 'CMD_MOVE_QUEUE_ITEM_DOWN',
    interfaceName: 'MoveQueueItemDownCommand',
    validatorName: 'validateMoveQueueItemDown',
    family: 'queue-core',
    doc: 'Move a pending queue item one position later.',
    payloadMode: 'required',
    payload: d.obj({ id: idField() }, { allowArray: true })
  }),

  d.command({
    type: 'CMD_PAUSE_QUEUE',
    interfaceName: 'PauseQueueCommand',
    validatorName: 'validatePauseQueue',
    family: 'queue-core',
    doc: 'Pause a queue with an optional operator-supplied reason.',
    payloadMode: 'optional',
    emptyPayloadValue: 'undefined',
    payloadInvalidErr: 'invalid-payload',
    payload: d.obj(
      {
        queueId: d.field(queueIdField(), { optional: true, omitIfEmpty: true }),
        reason: d.field(
          d.str({
            maxLen: PAUSED_REASON_MAX_LENGTH,
            typeErr: 'reason-not-string',
            rangeErr: 'reason-too-long'
          }),
          { optional: true }
        )
      },
      { allowArray: true }
    )
  }),

  d.command({
    type: 'CMD_RESUME_QUEUE',
    interfaceName: 'ResumeQueueCommand',
    validatorName: 'validateResumeQueue',
    family: 'queue-core',
    doc: 'Resume a paused queue (canonized to live validator allowlist: queueId only).',
    payloadMode: 'optional',
    emptyPayloadValue: 'undefined',
    payloadInvalidErr: 'invalid-payload',
    payload: d.obj(
      {
        queueId: d.field(queueIdField(), { optional: true, omitIfEmpty: true })
      },
      { allowArray: true }
    )
  }),

  d.command({
    type: 'CMD_START_QUEUE',
    interfaceName: 'StartQueueCommand',
    validatorName: 'validateStartQueue',
    family: 'queue-core',
    doc: 'Offer a queue a drain pass or apply an explicit start/schedule intent.',
    payloadMode: 'optional-empty-object',
    payloadInvalidErr: 'invalid-payload',
    payload: d.obj(
      {
        queueId: d.field(queueIdField(), { optional: true, omitIfEmpty: true }),
        startIntent: d.field(
          d.ref('StartQueueIntent', {
            tsType: 'StartQueueIntent',
            tsImport: '../start-intent-types',
            predicate: {
              fn: 'isValidStartQueueIntent',
              importFrom: '../../start-intent-types',
              err: 'invalid-start-intent'
            }
          }),
          { optional: true }
        )
      },
      { allowArray: false }
    )
  }),

  d.command({
    type: 'CMD_CLEAR_COMPLETED',
    interfaceName: 'ClearCompletedCommand',
    validatorName: 'validateClearCompleted',
    family: 'queue-core',
    doc: 'Clear completed items from the explicitly addressed queue.',
    payloadMode: 'required',
    payload: d.obj({ queueId: queueIdField() }, { allowArray: true })
  }),

  d.command({
    type: 'CMD_CLEAR_QUEUE',
    interfaceName: 'ClearQueueCommand',
    validatorName: 'validateClearQueue',
    family: 'queue-core',
    doc: 'Queue-scoped Clean All addressing one explicit queueId.',
    payloadMode: 'required',
    payload: d.obj({ queueId: queueIdField() }, { allowArray: true })
  }),

  d.command({
    type: 'CMD_MODIFY_TASK',
    interfaceName: 'ModifyTaskCommand',
    validatorName: 'validateModifyTask',
    family: 'queue-core',
    doc: 'Edit the description of a queued task.',
    payloadMode: 'required',
    payload: d.obj(
      {
        taskId: taskIdField(),
        description: d.str({
          trim: true,
          minLen: 1,
          maxLen: DESCRIPTION_MAX,
          typeErr: 'description-not-string',
          rangeErr: 'description-out-of-range'
        })
      },
      { allowArray: true }
    )
  }),

  d.command({
    type: 'CMD_REORDER_TASK',
    interfaceName: 'ReorderTaskCommand',
    validatorName: 'validateReorderTask',
    family: 'queue-core',
    doc: 'Reorder a pending task within its queue to a new zero-based position.',
    payloadMode: 'required',
    payload: d.obj(
      {
        taskId: taskIdField(),
        newPosition: d.int({ min: 0, err: 'invalid-position' })
      },
      { allowArray: true }
    )
  }),

  d.command({
    type: 'CMD_RESTART_CANCELED_TASK',
    interfaceName: 'RestartCanceledTaskCommand',
    validatorName: 'validateRestartCanceledTask',
    family: 'queue-core',
    doc: 'Transition a canceled task back to pending by taskId.',
    payloadMode: 'required',
    payload: d.obj({ taskId: taskIdField() }, { allowArray: true })
  }),

  d.command({
    type: 'CMD_REMOVE_TASK_PHASE',
    interfaceName: 'RemoveTaskPhaseCommand',
    validatorName: 'validateRemoveTaskPhase',
    family: 'queue-core',
    doc: 'Remove a phase from a task after explicit operator confirmation.',
    payloadMode: 'required',
    payload: d.obj(
      {
        taskId: taskIdField(),
        phaseId: phaseIdField(),
        confirmed: d.lit(true, { err: 'missing-confirmation' })
      },
      { allowArray: true }
    )
  })
]);
