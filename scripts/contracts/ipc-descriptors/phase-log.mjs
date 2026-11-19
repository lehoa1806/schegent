// Family 7: phase-log (4 commands)

import { d } from '../descriptor-dsl.mjs';

const QUEUE_ID_MAX = 256;
const CONSUMER_MAX_CHARS = 64;
const CURSOR_MAX_CHARS = 160;

const selectionFields = (iterationRequired) => ({
  queueId: d.str({ format: 'safePathSegment', err: 'invalid-queueId' }),
  taskId: d.str({ format: 'safePathSegment', err: 'invalid-taskId' }),
  pipelineId: d.str({ format: 'safePathSegment', err: 'invalid-pipelineId' }),
  phaseId: d.str({ format: 'safePathSegment', err: 'invalid-phaseId' }),
  iterationN: iterationRequired
    ? d.int({ min: 1, err: 'invalid-iterationN' })
    : d.field(d.int({ min: 1, err: 'invalid-iterationN' }), {
        nullable: true,
        nullWhenAbsent: true
      })
});

export const PHASE_LOG_COMMANDS = Object.freeze([
  d.command({
    type: 'CMD_READ_PHASE_LOG',
    interfaceName: 'ReadPhaseLogCommand',
    validatorName: 'validateReadPhaseLog',
    family: 'phase-log',
    emitInterface: false,
    doc: 'Read persisted phase log entries for a safe-path-segment tuple.',
    payloadMode: 'required',
    payload: d.obj(
      {
        selection: d.obj(selectionFields(false), {
          allowArray: true,
          missingErr: 'invalid-selection'
        })
      },
      { allowArray: true }
    )
  }),

  d.command({
    type: 'CMD_START_PHASE_LOG_TAIL',
    interfaceName: 'StartPhaseLogTailCommand',
    validatorName: 'validateStartPhaseLogTail',
    family: 'phase-log',
    emitInterface: false,
    doc: 'Start a live phase log tail session for a concrete iteration.',
    payloadMode: 'required',
    payload: d.obj(
      {
        selection: d.obj(selectionFields(true), {
          allowArray: true,
          missingErr: 'invalid-selection'
        }),
        consumer: d.field(
          d.str({ minLen: 1, maxLen: CONSUMER_MAX_CHARS, err: 'invalid-consumer' }),
          { optional: true }
        ),
        fromCursor: d.field(
          d.str({
            minLen: 1,
            maxLen: CURSOR_MAX_CHARS,
            format: 'printableAscii',
            err: 'invalid-fromCursor'
          }),
          { optional: true }
        )
      },
      { allowArray: true }
    )
  }),

  d.command({
    type: 'CMD_STOP_PHASE_LOG_TAIL',
    interfaceName: 'StopPhaseLogTailCommand',
    validatorName: 'validateStopPhaseLogTail',
    family: 'phase-log',
    emitInterface: false,
    doc: 'Stop an active live phase log tail session.',
    payloadMode: 'required',
    payload: d.obj(
      {
        sessionId: d.str({ minLen: 1, maxLen: QUEUE_ID_MAX, err: 'invalid-sessionId' })
      },
      { allowArray: true }
    )
  }),

  d.command({
    type: 'CMD_ACK_PHASE_LOG_TAIL',
    interfaceName: 'AckPhaseLogTailCommand',
    validatorName: 'validateAckPhaseLogTail',
    family: 'phase-log',
    emitInterface: false,
    doc: 'Acknowledge a live phase log batch with credit, resync, or duplicate flags.',
    payloadMode: 'required',
    payload: d.obj(
      {
        sessionId: d.str({ minLen: 1, maxLen: QUEUE_ID_MAX, err: 'invalid-sessionId' }),
        batchSeq: d.int({ safe: true, min: 0, err: 'invalid-batchSeq' }),
        resync: d.field(d.bool({ err: 'invalid-resync' }), { optional: true }),
        duplicate: d.field(d.bool({ err: 'invalid-duplicate' }), { optional: true })
      },
      { allowArray: true }
    )
  })
]);
