// Family 5: history-evidence (6 commands)

import { d } from '../descriptor-dsl.mjs';

const QUEUE_ID_MAX = 256;

export const HISTORY_EVIDENCE_COMMANDS = Object.freeze([
  d.command({
    type: 'CMD_RERUN_FROM_HISTORY',
    interfaceName: 'RerunFromHistoryCommand',
    validatorName: 'validateRerunFromHistory',
    family: 'history-evidence',
    doc: 'Rerun a historical run by runId with optional force flag for legacy preview entries.',
    payloadMode: 'required',
    payload: d.obj(
      {
        runId: d.str({ minLen: 1, maxLen: QUEUE_ID_MAX, err: 'invalid-runId' }),
        force: d.field(d.bool({ err: 'force-not-boolean' }), { optional: true, omitIfFalse: true })
      },
      { allowArray: true }
    )
  }),

  d.command({
    type: 'CMD_OPEN_HISTORY_ITEM_DETAILS',
    interfaceName: 'OpenHistoryItemDetailsCommand',
    validatorName: 'validateOpenHistoryItemDetails',
    family: 'history-evidence',
    doc: 'Open detail view for a recorded history item by id.',
    payloadMode: 'required',
    payload: d.obj(
      {
        id: d.str({ minLen: 1, maxLen: QUEUE_ID_MAX, err: 'invalid-id' })
      },
      { allowArray: true }
    )
  }),

  d.command({
    type: 'CMD_RESOLVE_AUDIT_POINTER',
    interfaceName: 'ResolveAuditPointerCommand',
    validatorName: 'validateResolveAuditPointer',
    family: 'history-evidence',
    doc: 'Resolve a completed run auditLogPointer to its audit records.',
    payloadMode: 'required',
    payload: d.obj(
      {
        runId: d.str({ minLen: 1, maxLen: QUEUE_ID_MAX, err: 'invalid-runId' })
      },
      { allowArray: true }
    )
  }),

  d.command({
    type: 'CMD_RESOLVE_HISTORY_DESCRIPTION',
    interfaceName: 'ResolveHistoryDescriptionCommand',
    validatorName: 'validateResolveHistoryDescription',
    family: 'history-evidence',
    doc: 'Resolve a completed run stored description for replay.',
    payloadMode: 'required',
    payload: d.obj(
      {
        runId: d.str({ minLen: 1, maxLen: QUEUE_ID_MAX, err: 'invalid-runId' })
      },
      { allowArray: true }
    )
  }),

  d.command({
    type: 'CMD_READ_FAILURE_RECORD',
    interfaceName: 'ReadFailureRecordCommand',
    validatorName: 'validateReadFailureRecord',
    family: 'history-evidence',
    doc: 'Read the newest failure record for a (queueId, taskId) row.',
    payloadMode: 'required',
    payload: d.obj({
      queueId: d.str({ format: 'recordIdentifier', err: 'invalid-queueId' }),
      taskId: d.str({ format: 'recordIdentifier', err: 'invalid-taskId' })
    })
  }),

  d.command({
    type: 'CMD_OPEN_DECISION_RECORD',
    interfaceName: 'OpenDecisionRecordCommand',
    validatorName: 'validateOpenDecisionRecord',
    family: 'history-evidence',
    doc: 'Open the decisions.md record for a blocked row.',
    payloadMode: 'required',
    payload: d.obj({
      rowId: d.str({ format: 'recordIdentifier', err: 'invalid-rowId' })
    })
  })
]);
