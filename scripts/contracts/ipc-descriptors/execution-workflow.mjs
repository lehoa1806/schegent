// Family 9: execution-workflow (6 commands)

import { d } from '../descriptor-dsl.mjs';
import { WORKFLOW_CONTROL_ACTIONS } from '../canonical-enums.mjs';

const ID_MAX = 64;
const RUN_ID_MAX = 128;
const QUEUE_ID_MAX = 256;
const CURSOR_MAX = 256;
const CONTROL_ID_MAX = 65536;

export const EXECUTION_WORKFLOW_COMMANDS = Object.freeze([
  d.command({
    type: 'CMD_LAUNCH_PIPELINE',
    interfaceName: 'LaunchPipelineCommand',
    validatorName: 'validateLaunchPipeline',
    family: 'execution-workflow',
    doc: 'Compose, validate, freeze, and enqueue a Pipeline RunRequest.',
    payloadMode: 'required',
    payload: d.obj(
      {
        request: d.ref('RunRequest', {
          tsType: 'RunRequest',
          tsImport: '../run-request',
          predicate: {
            fn: 'validRunRequest',
            importFrom: '../../validators/run-request-shape',
            err: 'invalid-payload'
          }
        }),
        queueId: d.field(d.str({ minLen: 1, maxLen: QUEUE_ID_MAX, err: 'invalid-payload' }), {
          optional: true
        })
      },
      { collapseInvalidErr: 'invalid-payload', missingErr: 'missing-payload' }
    )
  }),

  d.command({
    type: 'CMD_LAUNCH_WORKFLOW',
    interfaceName: 'LaunchWorkflowCommand',
    validatorName: 'validateLaunchWorkflow',
    family: 'execution-workflow',
    doc: 'Launch a connected Workflow run from a declared startNodeId.',
    payloadMode: 'required',
    payload: d.obj(
      {
        workflowId: d.str({ minLen: 1, maxLen: ID_MAX, err: 'invalid-payload' }),
        startNodeId: d.str({ minLen: 1, maxLen: ID_MAX, err: 'invalid-payload' }),
        request: d.ref('RunRequest', {
          tsType: 'RunRequest',
          tsImport: '../run-request',
          predicate: {
            fn: 'validRunRequest',
            importFrom: '../../validators/run-request-shape',
            err: 'invalid-payload'
          }
        }),
        queueId: d.field(d.str({ minLen: 1, maxLen: QUEUE_ID_MAX, err: 'invalid-payload' }), {
          optional: true
        })
      },
      { collapseInvalidErr: 'invalid-payload', missingErr: 'missing-payload' }
    )
  }),

  d.command({
    type: 'CMD_CONTINUE_WORKFLOW',
    interfaceName: 'ContinueWorkflowCommand',
    validatorName: 'validateContinueWorkflow',
    family: 'execution-workflow',
    doc: 'Continue or apply a control operation to a connected Workflow run.',
    payloadMode: 'required',
    extraTypeImports: {
      '../../sidebar-ipc/workflow-run': ['ControlCommandEnvelope', 'WorkflowControlAction']
    },
    payload: d.obj(
      {
        connectedRunId: d.str({ minLen: 1, maxLen: RUN_ID_MAX, err: 'invalid-payload' }),
        expectedRevision: d.int({ min: 0, err: 'invalid-payload' }),
        nodeId: d.str({ minLen: 1, maxLen: ID_MAX, err: 'invalid-payload' }),
        request: d.ref('RunRequest', {
          tsType: 'RunRequest',
          tsImport: '../run-request',
          predicate: {
            fn: 'validRunRequest',
            importFrom: '../../validators/run-request-shape',
            err: 'invalid-payload'
          }
        }),
        invocationId: d.field(d.str({ minLen: 1, maxLen: CONTROL_ID_MAX, err: 'invalid-payload' }), {
          optional: true
        }),
        operation: d.field(
          d.enum(WORKFLOW_CONTROL_ACTIONS, {
            refName: 'WorkflowControlAction',
            refImport: '../sidebar-ipc/workflow-run',
            err: 'invalid-payload'
          }),
          { optional: true }
        ),
        commandId: d.field(d.str({ minLen: 1, maxLen: CONTROL_ID_MAX, err: 'invalid-payload' }), {
          optional: true
        }),
        controlCommand: d.field(
          d.ref('ControlCommandEnvelope', {
            tsType: 'ControlCommandEnvelope',
            tsImport: '../sidebar-ipc/workflow-run',
            predicate: {
              fn: 'isControlCommandEnvelope',
              importFrom: '../../sidebar-ipc/workflow-run',
              err: 'invalid-payload'
            }
          }),
          { optional: true }
        )
      },
      { collapseInvalidErr: 'invalid-payload', missingErr: 'missing-payload' }
    )
  }),

  d.command({
    type: 'CMD_READ_EXECUTION_VISIBILITY',
    interfaceName: 'ReadExecutionVisibilityCommand',
    validatorName: 'validateReadExecutionVisibility',
    family: 'execution-workflow',
    doc: 'Read attempt visibility details or runtime lane/telemetry posture.',
    payloadMode: 'required',
    payload: d.discUnion(
      'op',
      {
        attemptDetail: d.obj({
          op: d.lit('attemptDetail'),
          rootExecutionId: d.str({ format: 'boundedIdentifier', err: 'invalid-rootExecutionId' }),
          invocationId: d.field(d.str({ format: 'boundedIdentifier', err: 'invalid-invocationId' }), {
            optional: true
          }),
          attemptId: d.field(d.str({ format: 'boundedIdentifier', err: 'invalid-attemptId' }), {
            optional: true
          })
        }),
        runtimePosture: d.obj({
          op: d.lit('runtimePosture')
        })
      },
      { invalidDiscErr: 'invalid-op' }
    )
  }),

  d.command({
    type: 'CMD_OPEN_CHANGE_REVIEW',
    interfaceName: 'OpenChangeReviewCommand',
    validatorName: 'validateOpenChangeReview',
    family: 'execution-workflow',
    doc: 'Open, refresh, classify, page, close, or cancel an immutable candidate change review.',
    payloadMode: 'required',
    payload: d.discUnion(
      'op',
      {
        open: d.obj({
          op: d.lit('open'),
          requestId: d.str({ format: 'boundedIdentifier', err: 'invalid-requestId' }),
          expectedRevision: d.field(
            d.str({ format: 'boundedIdentifier', err: 'invalid-expectedRevision' }),
            { optional: true }
          ),
          openInEditor: d.field(d.bool({ err: 'invalid-openInEditor' }), { optional: true })
        }),
        refresh: d.obj({
          op: d.lit('refresh'),
          reviewId: d.str({ format: 'boundedIdentifier', err: 'invalid-reviewId' }),
          openInEditor: d.field(d.bool({ err: 'invalid-openInEditor' }), { optional: true })
        }),
        classify: d.obj({
          op: d.lit('classify'),
          reviewId: d.str({ format: 'boundedIdentifier', err: 'invalid-reviewId' })
        }),
        close: d.obj({
          op: d.lit('close'),
          reviewId: d.str({ format: 'boundedIdentifier', err: 'invalid-reviewId' })
        }),
        page: d.obj({
          op: d.lit('page'),
          cursor: d.str({
            minLen: 1,
            maxLen: CURSOR_MAX,
            format: 'base64urlCursor',
            err: 'invalid-cursor'
          })
        }),
        cancelOpen: d.obj({
          op: d.lit('cancelOpen')
        })
      },
      { invalidDiscErr: 'invalid-op' }
    )
  }),

  d.command({
    type: 'CMD_DECIDE_PHASE_HANDOFF',
    interfaceName: 'DecidePhaseHandoffCommand',
    validatorName: 'validateDecidePhaseHandoff',
    family: 'execution-workflow',
    doc: 'Approve or edit a manual phase-to-phase context handoff revision.',
    payloadMode: 'required',
    payload: d.discUnion(
      'op',
      {
        approve: d.obj({
          op: d.lit('approve'),
          handoffId: d.str({ format: 'boundedIdentifier', err: 'invalid-handoffId' }),
          expectedRevision: d.int({ safe: true, min: 1, err: 'invalid-expectedRevision' }),
          decisionId: d.str({ format: 'boundedIdentifier', err: 'invalid-decisionId' })
        }),
        edit: d.obj({
          op: d.lit('edit'),
          handoffId: d.str({ format: 'boundedIdentifier', err: 'invalid-handoffId' }),
          baseRevision: d.int({ safe: true, min: 1, err: 'invalid-baseRevision' }),
          replacementSources: d.arr(d.unknown(), { err: 'invalid-replacementSources' })
        }),
        editSummary: d.obj({
          op: d.lit('editSummary'),
          handoffId: d.str({ format: 'boundedIdentifier', err: 'invalid-handoffId' }),
          baseRevision: d.int({ safe: true, min: 1, err: 'invalid-baseRevision' }),
          summary: d.str({ minLen: 1, maxLen: 8192, err: 'invalid-summary' }),
          producerAttemptId: d.field(
            d.str({ format: 'boundedIdentifier', err: 'invalid-producerAttemptId' }),
            { optional: true }
          )
        })
      },
      { invalidDiscErr: 'invalid-op' }
    )
  })
]);
