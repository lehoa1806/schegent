// Host-to-webview push message descriptors (3 message types)
// Plus shared IPC payload `$defs` for Draft 2020-12 JSON Schema generation.

import { d } from '../descriptor-dsl.mjs';
import {
  CANDIDATE_AVAILABILITY_POLICIES,
  COMMAND_ACK_OUTCOMES,
  PIPELINE_INPUT_PORT_TYPES,
  SUPPRESSIBLE_SNAPSHOT_SLICES
} from '../canonical-enums.mjs';

export const SIDEBAR_IPC_SCHEMA_VERSION = 3;

const snapshotSyncModes = ['full', 'routine'];
const suppressibleSliceList = d.arr(d.enum(SUPPRESSIBLE_SNAPSHOT_SLICES));
const snapshotSyncFull = d.obj({
  mode: d.lit('full'),
  revision: d.int({ min: 0 })
});
const snapshotSyncRoutine = d.obj({
  mode: d.lit('routine'),
  revision: d.int({ min: 0 }),
  baseRevision: d.int({ min: 0 }),
  omittedSlices: suppressibleSliceList
});
const snapshotSyncMeta = d.discUnion(
  'mode',
  {
    full: d.obj({
      mode: d.lit('full'),
      revision: d.int({ min: 0 }),
      baseRevision: d.field(d.unknown({ tsType: 'never' }), { optional: true }),
      omittedSlices: d.field(d.unknown({ tsType: 'never' }), { optional: true })
    }),
    routine: snapshotSyncRoutine
  },
  {
    doc: "Synchronizes STATE_SNAPSHOT with the consumer's baseline. Full mode resets the baseline to revision; routine mode reconstructs omittedSlices from baseRevision."
  }
);
const snapshotSyncMetaJson = d.discUnion(
  'mode',
  {
    full: snapshotSyncFull,
    routine: snapshotSyncRoutine
  },
  {
    doc: "Synchronizes STATE_SNAPSHOT with the consumer's baseline. Full mode resets the baseline to revision (forbidding baseRevision and omittedSlices); routine mode reconstructs omittedSlices from baseRevision (requiring both)."
  }
);

const stateSnapshotFields = {
  type: d.lit('STATE_SNAPSHOT'),
  payload: d.ref('WorkflowSnapshot', { tsType: 'S' }),
  sync: d.field(d.ref('SnapshotSyncMeta'), { optional: true })
};

function snapshotWireSchema(mode) {
  const { sync, ...fields } = stateSnapshotFields;
  if (mode === undefined) return d.obj(fields);
  return d.obj({
    ...fields,
    payload: mode === 'routine' ? d.ref('WorkflowSnapshotRoutinePayload') : fields.payload,
    sync: mode === 'routine' ? snapshotSyncRoutine : snapshotSyncFull
  });
}

const commandAckOutcomeField = d.field(
  d.enum(COMMAND_ACK_OUTCOMES, {
    refName: 'CommandAckOutcome',
    refImport: '../command-outcome'
  }),
  { optional: true }
);

export const HOST_MESSAGES = Object.freeze([
  d.hostMessage({
    type: 'STATE_SNAPSHOT',
    interfaceName: 'StateSnapshotMessage',
    typeParams: '<S>',
    doc: 'Host pushes an authoritative WorkflowSnapshot envelope with optional sync metadata.',
    schema: d.obj(stateSnapshotFields),
    jsonSchema: d.oneOf(
      [snapshotWireSchema(), ...snapshotSyncModes.map(snapshotWireSchema)],
      {
        doc: 'Host pushes an authoritative WorkflowSnapshot envelope; mode=routine permits omitting unchanged SUPPRESSIBLE_SNAPSHOT_SLICES and requires baseRevision and omittedSlices, while mode=full forbids them.'
      }
    )
  }),

  d.hostMessage({
    type: 'CMD_ACK',
    interfaceName: 'CommandAckMessage',
    doc: 'Host acknowledges acceptance or rejection of a correlated webview command.',
    schema: d.obj({
      type: d.lit('CMD_ACK'),
      correlationId: d.str({ minLen: 1, maxLen: 64 }),
      status: d.enum(['accepted', 'rejected']),
      outcome: commandAckOutcomeField,
      reason: d.field(d.str(), { optional: true }),
      result: d.field(d.unknown(), { optional: true })
    }),
    jsonSchema: d.oneOf(
      [
        d.obj({
          type: d.lit('CMD_ACK'),
          correlationId: d.str({ minLen: 1, maxLen: 64 }),
          status: d.lit('accepted'),
          outcome: d.field(d.lit('accepted'), { optional: true }),
          result: d.field(d.unknown(), { optional: true })
        }),
        d.obj({
          type: d.lit('CMD_ACK'),
          correlationId: d.str({ minLen: 1, maxLen: 64 }),
          status: d.lit('rejected'),
          outcome: d.field(d.enum(['no-op', 'refused', 'failed']), { optional: true }),
          reason: d.field(d.str(), { optional: true }),
          result: d.field(d.unknown(), { optional: true })
        })
      ],
      {
        doc: 'Host acknowledges acceptance or rejection of a correlated webview command; accepted acknowledgements forbid reason (T28) and pair wire status with matching CommandAckOutcome values.'
      }
    )
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

const PHASE_LOG_WIRE_ENTRY_KINDS = Object.freeze([
  'assistant-text',
  'tool-use',
  'tool-result',
  'system',
  'result',
  'truncated-head',
  'tail-ended',
  'coverage-gap'
]);

export const HOST_MESSAGE_DEFINITIONS = Object.freeze({
  SnapshotSyncMeta: snapshotSyncMeta,

  PhaseLogWireEntry: d.obj({
    seq: d.int({ min: 0 }),
    kind: d.enum(PHASE_LOG_WIRE_ENTRY_KINDS),
    ts: d.field(d.str(), { nullable: true }),
    body: d.rec(d.unknown()),
    bodyTruncated: d.field(
      d.rec(d.obj({ originalLength: d.int({ min: 0 }) })),
      { nullable: true }
    )
  }, { doc: 'A display entry as it crosses the boundary: sanitized and budgeted.' }),

  LiveLogBatchEntry: d.obj({
    at: d.int({ min: 0 }),
    n: d.int({ min: 0 }),
    entry: d.ref('PhaseLogWireEntry')
  }, {
    doc: "One entry with its source position. The at field is the end byte offset of its record, and n is the entry's ordinal within that record."
  }),

  LiveLogBatchMode: d.enum(['continue', 'resume', 'reset']),

  PhaseLogBatchPayload: d.obj({
    protocol: d.lit(1),
    tailSessionId: d.str({ minLen: 1 }),
    batchSeq: d.int({ min: 0 }),
    generation: d.str({ minLen: 1 }),
    mode: d.ref('LiveLogBatchMode'),
    toCursor: d.field(d.str(), { nullable: true }),
    entries: d.arr(d.ref('LiveLogBatchEntry'))
  }, { doc: 'The MSG_PHASE_LOG_BATCH payload, at most 256 KiB serialized.' })
});

export const SHARED_IPC_DEFS = Object.freeze({
  ...HOST_MESSAGE_DEFINITIONS,
  SnapshotSyncMeta: snapshotSyncMetaJson,

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

  RunRequest: d.obj(
    {
      pipelineId: d.field(d.str({ minLen: 1, maxLen: 64 }), { optional: true }),
      workflowId: d.field(d.str({ minLen: 1, maxLen: 64 }), { optional: true }),
      entryNodeId: d.field(d.str({ minLen: 1, maxLen: 64 }), { optional: true }),
      inputs: d.arr(d.ref('RunRequestInput'), { maxItems: 64 }),
      supplemental: d.arr(d.ref('RunRequestSupplemental'), { maxItems: 256 }),
      outputs: d.arr(d.ref('RunRequestOutput'), { maxItems: 64 }),
      instructions: d.field(d.str(), { optional: true })
    },
    {
      anyOf: [{ required: ['pipelineId'] }, { required: ['workflowId'] }]
    }
  ),

  ControlAction: d.discUnion('kind', {
    'check-now': d.obj({
      kind: d.lit('check-now'),
      candidateId: d.field(d.str({ minLen: 1, maxLen: 64 }), { optional: true })
    }),
    'try-now': d.obj({
      kind: d.lit('try-now'),
      candidateId: d.str({ minLen: 1, maxLen: 64 })
    }),
    'select-candidate': d.obj({
      kind: d.lit('select-candidate'),
      candidateId: d.str({ minLen: 1, maxLen: 64 })
    }),
    'set-policy': d.obj({
      kind: d.lit('set-policy'),
      availabilityPolicy: d.enum(CANDIDATE_AVAILABILITY_POLICIES)
    }),
    'set-allowed-candidates': d.obj({
      kind: d.lit('set-allowed-candidates'),
      candidateIds: d.arr(d.str({ minLen: 1, maxLen: 64 }), {
        minItems: 1,
        maxItems: 8,
        unique: true
      })
    }),
    'renew-monitoring': d.obj({
      kind: d.lit('renew-monitoring'),
      durationMs: d.int({ min: 60_000, max: 172_800_000 })
    }),
    pause: d.obj({ kind: d.lit('pause') }),
    resume: d.obj({ kind: d.lit('resume') }),
    cancel: d.obj({ kind: d.lit('cancel') })
  }),

  ControlCommandEnvelope: d.obj({
    version: d.lit(1),
    commandId: d.str({ minLen: 1 }),
    rootRunId: d.str({ minLen: 1, maxLen: 128 }),
    queueId: d.str({ minLen: 1, maxLen: 64 }),
    invocationId: d.str({ minLen: 1, maxLen: 65536 }),
    expectedGeneration: d.int({ min: 0 }),
    action: d.ref('ControlAction')
  })
});
