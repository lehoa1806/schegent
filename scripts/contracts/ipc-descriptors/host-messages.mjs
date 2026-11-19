// Host-to-webview push message descriptors (3 message types)
// Plus shared IPC payload `$defs` for Draft 2020-12 JSON Schema generation.

import { d } from '../descriptor-dsl.mjs';
import {
  COMMAND_ACK_OUTCOMES,
  PIPELINE_INPUT_PORT_TYPES
} from '../canonical-enums.mjs';

export const SIDEBAR_IPC_SCHEMA_VERSION = 3;

export const HOST_MESSAGES = Object.freeze([
  d.hostMessage({
    type: 'STATE_SNAPSHOT',
    interfaceName: 'StateSnapshotMessage',
    doc: 'Host pushes an authoritative WorkflowSnapshot envelope with optional sync metadata.',
    schema: d.obj({
      type: d.lit('STATE_SNAPSHOT'),
      payload: d.ref('WorkflowSnapshot'),
      sync: d.field(d.ref('SnapshotSyncMeta'), { optional: true })
    })
  }),

  d.hostMessage({
    type: 'CMD_ACK',
    interfaceName: 'CommandAckMessage',
    doc: 'Host acknowledges acceptance or rejection of a correlated webview command.',
    schema: d.obj({
      type: d.lit('CMD_ACK'),
      correlationId: d.str({ minLen: 1, maxLen: 64 }),
      status: d.enum(['accepted', 'rejected']),
      outcome: d.field(d.enum(COMMAND_ACK_OUTCOMES), { optional: true }),
      reason: d.field(d.str(), { optional: true }),
      result: d.field(d.unknown(), { optional: true })
    })
  }),

  d.hostMessage({
    type: 'MSG_PHASE_LOG_BATCH',
    interfaceName: 'PhaseLogBatchPushMessage',
    doc: 'Host pushes a bounded, positioned batch of live phase log entries.',
    schema: d.obj({
      type: d.lit('MSG_PHASE_LOG_BATCH'),
      payload: d.ref('PhaseLogBatchPayload')
    })
  })
]);

const IPC_SCHEDULED_START_SOURCES = Object.freeze([
  'operator-chooser',
  'operator-restart',
  'programmatic-now',
  'programmatic-scheduled',
  'migration-default'
]);

export const SHARED_IPC_DEFS = Object.freeze({
  SnapshotSyncMeta: d.obj(
    {
      snapshotSeq: d.int({ min: 0 }),
      omittedSlices: d.field(d.arr(d.str()), { optional: true }),
      fullSync: d.field(d.bool(), { optional: true })
    },
    { closed: false }
  ),

  PhaseLogBatchPayload: d.obj(
    {
      sessionId: d.str({ minLen: 1 }),
      batchSeq: d.int({ min: 0 }),
      mode: d.enum(['live', 'catchup', 'resync']),
      entries: d.arr(
        d.obj(
          {
            pos: d.int({ min: 0 }),
            entry: d.obj({}, { closed: false })
          },
          { closed: false }
        )
      ),
      cursor: d.field(d.str(), { optional: true, nullable: true }),
      truncated: d.field(d.bool(), { optional: true })
    },
    { closed: false }
  ),

  EnqueueStartIntent: d.discUnion('startMode', {
    now: d.obj({
      startMode: d.lit('now'),
      source: d.enum(IPC_SCHEDULED_START_SOURCES)
    }),
    scheduled: d.obj({
      startMode: d.lit('scheduled'),
      scheduledStartAt: d.num({ exclusiveMin: 0 }),
      source: d.enum(IPC_SCHEDULED_START_SOURCES)
    })
  }),

  StartQueueIntent: d.discUnion('startMode', {
    now: d.obj({
      startMode: d.lit('now'),
      source: d.lit('operator-restart')
    }),
    scheduled: d.obj({
      startMode: d.lit('scheduled'),
      scheduledStartAt: d.num({ exclusiveMin: 0 }),
      source: d.lit('operator-restart')
    }),
    'cancel-schedule': d.obj({
      startMode: d.lit('cancel-schedule'),
      source: d.lit('operator-restart')
    })
  }),

  RunRequestInput: d.obj({
    portId: d.str({ minLen: 1, maxLen: 64 }),
    type: d.enum(PIPELINE_INPUT_PORT_TYPES),
    value: d.str()
  }),

  RunRequestSupplemental: d.discUnion('kind', {
    'local-file': d.obj({ kind: d.lit('local-file'), path: d.str({ minLen: 1 }) }),
    'local-folder': d.obj({ kind: d.lit('local-folder'), path: d.str({ minLen: 1 }) }),
    url: d.obj({ kind: d.lit('url'), url: d.str({ minLen: 1 }) }),
    text: d.obj({ kind: d.lit('text'), text: d.str() }),
    instruction: d.obj({ kind: d.lit('instruction'), text: d.str() }),
    'prior-output': d.obj({
      kind: d.lit('prior-output'),
      reference: d.obj({
        sourceRunId: d.str({ minLen: 1 }),
        outputName: d.str({ minLen: 1 })
      })
    })
  }),

  RunRequestOutput: d.obj({
    portId: d.str({ minLen: 1, maxLen: 64 }),
    target: d.str(),
    overwriteConfirmed: d.field(d.bool(), { optional: true }),
    externalSideEffectConfirmed: d.field(d.bool(), { optional: true })
  }),

  RunRequest: d.obj({
    pipelineId: d.field(d.str({ minLen: 1, maxLen: 64 }), { optional: true }),
    workflowId: d.field(d.str({ minLen: 1, maxLen: 64 }), { optional: true }),
    entryNodeId: d.field(d.str({ minLen: 1, maxLen: 64 }), { optional: true }),
    inputs: d.arr(d.ref('RunRequestInput'), { maxItems: 64 }),
    supplemental: d.arr(d.ref('RunRequestSupplemental'), { maxItems: 256 }),
    outputs: d.arr(d.ref('RunRequestOutput'), { maxItems: 64 }),
    instructions: d.field(d.str(), { optional: true })
  }),

  ControlCommandEnvelope: d.obj(
    {
      version: d.int({ min: 1 }),
      commandId: d.str({ minLen: 1 }),
      action: d.obj({ kind: d.str({ minLen: 1 }) }, { closed: false })
    },
    { closed: false }
  )
});
