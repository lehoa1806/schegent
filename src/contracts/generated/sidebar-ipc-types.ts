// GENERATED FILE — do not edit.
//
// Emitted from scripts/contracts/ipc-descriptors/index.mjs by scripts/generate-contract-schemas.mjs.
// Edit the descriptor and run: npm run contracts:generate

import type { BackendRunnerKind } from '../backend-kinds';
import type { DeactivateRequest, DiscardDraftRequest, PackagePublishRequest, PublishRequest, RestoreRequest, SaveDraftRequest } from '../catalog-lifecycle';
import type { CatalogKind } from '../catalog-store';
import type { CommandAckOutcome } from '../command-outcome';
import type { QueueFailurePolicy } from '../queue-failure-policy';
import type { RunRequest } from '../run-request';
import type { PreflightProcessYamlRequest } from '../sidebar-ipc/process-yaml';
import type { ControlCommandEnvelope, WorkflowControlAction } from '../sidebar-ipc/workflow-run';
import type { EnqueueStartIntent, StartQueueIntent } from '../start-intent-types';

export const GENERATED_SIDEBAR_IPC_SCHEMA_VERSION = 3 as const;

export interface GeneratedCommandBase<T extends string> {
  readonly type: T;
  readonly correlationId: string;
}

/**
 * Enqueue a new feature request onto a queue with optional pipeline, position, and start-intent overrides.
 */
export interface StartCommand extends GeneratedCommandBase<'CMD_START'> {
  readonly payload: {
    readonly description: string;
    readonly pipelineId?: string;
    /** Optional target queue identifier. */
    readonly queueId?: string;
    /** Optional zero-based insertion index. */
    readonly position?: number;
    /** Optional start-mode intent (Feature 065). */
    readonly startIntent?: EnqueueStartIntent;
  };
}

/** Cancel a target task/run resolved explicitly by FeatureRequest.id. */
export interface CancelCommand extends GeneratedCommandBase<'CMD_CANCEL'> {
  readonly payload: {
    readonly taskId: string;
  };
}

/** Remove an item from a queue after explicit operator confirmation. */
export interface RemoveQueueItemCommand extends GeneratedCommandBase<'CMD_REMOVE_QUEUE_ITEM'> {
  readonly payload: {
    readonly id: string;
    readonly confirmed: true;
  };
}

/** Retry a failed or canceled queue item by id. */
export interface RetryQueueItemCommand extends GeneratedCommandBase<'CMD_RETRY_QUEUE_ITEM'> {
  readonly payload: {
    readonly id: string;
  };
}

/** Move a pending queue item one position earlier. */
export interface MoveQueueItemUpCommand extends GeneratedCommandBase<'CMD_MOVE_QUEUE_ITEM_UP'> {
  readonly payload: {
    readonly id: string;
  };
}

/** Move a pending queue item one position later. */
export interface MoveQueueItemDownCommand extends GeneratedCommandBase<'CMD_MOVE_QUEUE_ITEM_DOWN'> {
  readonly payload: {
    readonly id: string;
  };
}

/** Pause a queue with an optional operator-supplied reason. */
export interface PauseQueueCommand extends GeneratedCommandBase<'CMD_PAUSE_QUEUE'> {
  readonly payload?: {
    readonly queueId?: string;
    readonly reason?: string;
  } | undefined;
}

/** Resume a paused queue (canonized to live validator allowlist: queueId only). */
export interface ResumeQueueCommand extends GeneratedCommandBase<'CMD_RESUME_QUEUE'> {
  readonly payload?: {
    readonly queueId?: string;
  } | undefined;
}

/** Offer a queue a drain pass or apply an explicit start/schedule intent. */
export interface StartQueueCommand extends GeneratedCommandBase<'CMD_START_QUEUE'> {
  readonly payload?: {
    readonly queueId?: string;
    readonly startIntent?: StartQueueIntent;
  } | Record<string, never>;
}

/** Clear completed items from the explicitly addressed queue. */
export interface ClearCompletedCommand extends GeneratedCommandBase<'CMD_CLEAR_COMPLETED'> {
  readonly payload: {
    readonly queueId: string;
  };
}

/** Queue-scoped Clean All addressing one explicit queueId. */
export interface ClearQueueCommand extends GeneratedCommandBase<'CMD_CLEAR_QUEUE'> {
  readonly payload: {
    readonly queueId: string;
  };
}

/** Edit the description of a queued task. */
export interface ModifyTaskCommand extends GeneratedCommandBase<'CMD_MODIFY_TASK'> {
  readonly payload: {
    readonly taskId: string;
    readonly description: string;
  };
}

/** Reorder a pending task within its queue to a new zero-based position. */
export interface ReorderTaskCommand extends GeneratedCommandBase<'CMD_REORDER_TASK'> {
  readonly payload: {
    readonly taskId: string;
    readonly newPosition: number;
  };
}

/** Transition a canceled task back to pending by taskId. */
export interface RestartCanceledTaskCommand extends GeneratedCommandBase<'CMD_RESTART_CANCELED_TASK'> {
  readonly payload: {
    readonly taskId: string;
  };
}

/** Remove a phase from a task after explicit operator confirmation. */
export interface RemoveTaskPhaseCommand extends GeneratedCommandBase<'CMD_REMOVE_TASK_PHASE'> {
  readonly payload: {
    readonly taskId: string;
    readonly phaseId: string;
    readonly confirmed: true;
  };
}

/** Create a new named queue. */
export interface CreateQueueCommand extends GeneratedCommandBase<'CMD_CREATE_QUEUE'> {
  readonly payload: {
    readonly name: string;
  };
}

/** Rename an existing queue. */
export interface RenameQueueCommand extends GeneratedCommandBase<'CMD_RENAME_QUEUE'> {
  readonly payload: {
    readonly queueId: string;
    readonly name: string;
  };
}

/** Two-phase queue deletion (preview without confirmed, execute with confirmed: true). */
export interface DeleteQueueCommand extends GeneratedCommandBase<'CMD_DELETE_QUEUE'> {
  readonly payload: {
    readonly queueId: string;
    readonly confirmed?: true;
  };
}

/** Persist workspace queue concurrency cap and default queue id. */
export interface SaveQueueSettingsCommand extends GeneratedCommandBase<'CMD_SAVE_QUEUE_SETTINGS'> {
  readonly payload: {
    readonly globalConcurrencyCap: number;
    readonly defaultQueueId: string;
  };
}

/** Set a queue-level halt-on-failure override or null to inherit workspace default. */
export interface SetQueueFailurePolicyCommand extends GeneratedCommandBase<'CMD_SET_QUEUE_FAILURE_POLICY'> {
  readonly payload: {
    readonly queueId: string;
    readonly policy: QueueFailurePolicy | null;
  };
}

/** Operator attests that a failed task completed externally. */
export interface AttestTaskCompletedCommand extends GeneratedCommandBase<'CMD_ATTEST_TASK_COMPLETED'> {
  readonly payload: {
    readonly taskId: string;
    readonly confirmed: true;
  };
}

/** Move a task across queues with an optional insertion position. */
export interface MoveTaskCommand extends GeneratedCommandBase<'CMD_MOVE_TASK'> {
  readonly payload: {
    readonly taskId: string;
    readonly targetQueueId: string;
    readonly position?: number;
  };
}

/** Trigger an immediate retry for a delayed-retry phase on the addressed queue. */
export interface RetryPhaseNowCommand extends GeneratedCommandBase<'CMD_RETRY_PHASE_NOW'> {
  readonly payload: {
    readonly queueId: string;
  };
}

/** Pause the active phase on the addressed queue. */
export interface PausePhaseCommand extends GeneratedCommandBase<'CMD_PAUSE_PHASE'> {
  readonly payload: {
    readonly queueId: string;
  };
}

/** Resume a paused phase on the addressed queue with an optional operator prompt. */
export interface ResumePhaseCommand extends GeneratedCommandBase<'CMD_RESUME_PHASE'> {
  readonly payload: {
    readonly queueId: string;
    readonly prompt?: string;
  };
}

/** Restart a specific phase on the addressed queue. */
export interface RestartPhaseCommand extends GeneratedCommandBase<'CMD_RESTART_PHASE'> {
  readonly payload: {
    readonly queueId: string;
    readonly phaseId: string;
  };
}

/** Skip a phase on a specific run and queue. */
export interface SkipPhaseCommand extends GeneratedCommandBase<'CMD_SKIP_PHASE'> {
  readonly payload: {
    readonly queueId: string;
    readonly runId: string;
    readonly phaseId: string;
  };
}

/** Disable a phase on the addressed queue. */
export interface DisablePhaseCommand extends GeneratedCommandBase<'CMD_DISABLE_PHASE'> {
  readonly payload: {
    readonly queueId: string;
    readonly phaseId: string;
  };
}

/** Re-enable a disabled phase on the addressed queue. */
export interface EnablePhaseCommand extends GeneratedCommandBase<'CMD_ENABLE_PHASE'> {
  readonly payload: {
    readonly queueId: string;
    readonly phaseId: string;
  };
}

/** Set a future-phase breakpoint on a specific run and queue. */
export interface SetPhaseBreakpointCommand extends GeneratedCommandBase<'CMD_SET_PHASE_BREAKPOINT'> {
  readonly payload: {
    readonly queueId: string;
    readonly runId: string;
    readonly phaseId: string;
  };
}

/** Clear a future-phase breakpoint on a specific run and queue. */
export interface ClearPhaseBreakpointCommand extends GeneratedCommandBase<'CMD_CLEAR_PHASE_BREAKPOINT'> {
  readonly payload: {
    readonly queueId: string;
    readonly runId: string;
    readonly phaseId: string;
  };
}

/** Open the workspace audit log in VS Code. */
export interface OpenAuditLogCommand extends GeneratedCommandBase<'CMD_OPEN_AUDIT_LOG'> {}

/** Open the full Schegent dashboard webview panel. */
export interface OpenDashboardCommand extends GeneratedCommandBase<'CMD_OPEN_DASHBOARD'> {}

/** Open VS Code Settings scoped to schegent.logging.verbose. */
export interface OpenVerboseSettingCommand extends GeneratedCommandBase<'CMD_OPEN_VERBOSE_SETTING'> {}

/** Open VS Code Settings scoped to the read-only schegent.trust.* keys. */
export interface OpenTrustSettingsCommand extends GeneratedCommandBase<'CMD_OPEN_TRUST_SETTINGS'> {}

/** Dismiss the one-time post-migration notice. */
export interface DismissMigrationNoticeCommand extends GeneratedCommandBase<'CMD_DISMISS_MIGRATION_NOTICE'> {}

/** Persist per-action confirmation suppression state in workspace memento. */
export interface SetConfirmSuppressionCommand extends GeneratedCommandBase<'CMD_SET_CONFIRM_SUPPRESSION'> {
  readonly payload: {
    readonly actionKey: string;
    readonly suppressed: boolean;
  };
}

/** Persist a revision-checked workspace model edit or additive import. */
export interface SaveModelsCommand extends GeneratedCommandBase<'CMD_SAVE_MODELS'> {
  readonly payload: {
    readonly models: Record<string, readonly string[]>;
    readonly expectedRevision?: string;
    readonly mutation?: {
      readonly kind: 'manual-edit' | 'import-package';
    };
  };
}

/**
 * Save a batch of unprefixed scalar schegent.* settings validated against KEY_SPECS downstream.
 */
export interface SaveGeneralSettingsCommand extends GeneratedCommandBase<'CMD_SAVE_GENERAL_SETTINGS'> {
  readonly payload: {
    readonly updates: Readonly<Record<string, unknown>>;
  };
}

/** Probe connectivity and availability for a single supported backend. */
export interface PingBackendCommand extends GeneratedCommandBase<'CMD_PING_BACKEND'> {
  readonly payload: {
    readonly runner: BackendRunnerKind;
  };
}

/** Grant or revoke uncontained execution posture for a single supported backend. */
export interface SetUncontainedBackendGrantCommand extends GeneratedCommandBase<'CMD_SET_UNCONTAINED_BACKEND_GRANT'> {
  readonly payload: {
    readonly kind: BackendRunnerKind;
    readonly granted: boolean;
  };
}

/** Rerun a historical run by runId with optional force flag for legacy preview entries. */
export interface RerunFromHistoryCommand extends GeneratedCommandBase<'CMD_RERUN_FROM_HISTORY'> {
  readonly payload: {
    readonly runId: string;
    readonly force?: boolean;
  };
}

/** Open detail view for a recorded history item by id. */
export interface OpenHistoryItemDetailsCommand extends GeneratedCommandBase<'CMD_OPEN_HISTORY_ITEM_DETAILS'> {
  readonly payload: {
    readonly id: string;
  };
}

/** Resolve a completed run auditLogPointer to its audit records. */
export interface ResolveAuditPointerCommand extends GeneratedCommandBase<'CMD_RESOLVE_AUDIT_POINTER'> {
  readonly payload: {
    readonly runId: string;
  };
}

/** Resolve a completed run stored description for replay. */
export interface ResolveHistoryDescriptionCommand extends GeneratedCommandBase<'CMD_RESOLVE_HISTORY_DESCRIPTION'> {
  readonly payload: {
    readonly runId: string;
  };
}

/** Read the newest failure record for a (queueId, taskId) row. */
export interface ReadFailureRecordCommand extends GeneratedCommandBase<'CMD_READ_FAILURE_RECORD'> {
  readonly payload: {
    readonly queueId: string;
    readonly taskId: string;
  };
}

/** Open the decisions.md record for a blocked row. */
export interface OpenDecisionRecordCommand extends GeneratedCommandBase<'CMD_OPEN_DECISION_RECORD'> {
  readonly payload: {
    readonly rowId: string;
  };
}

/** Save an authored draft body for one catalog definition. */
export interface SaveDefinitionDraftCommand extends GeneratedCommandBase<'CMD_SAVE_DEFINITION_DRAFT'> {
  readonly payload: SaveDraftRequest;
}

/** Publish the current draft of one catalog definition. */
export interface PublishDefinitionCommand extends GeneratedCommandBase<'CMD_PUBLISH_DEFINITION'> {
  readonly payload: PublishRequest;
}

/** Deactivate one published catalog definition. */
export interface DeactivateDefinitionCommand extends GeneratedCommandBase<'CMD_DEACTIVATE_DEFINITION'> {
  readonly payload: DeactivateRequest;
}

/** Copy a historical published version back into a draft. */
export interface RestoreDefinitionVersionCommand extends GeneratedCommandBase<'CMD_RESTORE_DEFINITION_VERSION'> {
  readonly payload: RestoreRequest;
}

/** Discard an unpublished draft for one catalog definition. */
export interface DiscardDefinitionDraftCommand extends GeneratedCommandBase<'CMD_DISCARD_DEFINITION_DRAFT'> {
  readonly payload: DiscardDraftRequest;
}

/** Commit a multi-layer imported catalog package. */
export interface PublishPackageCommand extends GeneratedCommandBase<'CMD_PUBLISH_PACKAGE'> {
  readonly payload: PackagePublishRequest;
}

/** Read a historical definition version body by (kind, id, versionId). */
export interface ReadDefinitionVersionCommand extends GeneratedCommandBase<'CMD_READ_DEFINITION_VERSION'> {
  readonly payload: {
    readonly kind: CatalogKind;
    readonly id: string;
    readonly versionId: string;
  };
}

/**
 * Export a Phase, Workflow, or Model Catalog to a host-dialog YAML file (never carries a path).
 */
export interface ExportProcessYamlCommand extends GeneratedCommandBase<'CMD_EXPORT_PROCESS_YAML'> {
  readonly payload:
    | {
        readonly resourceKind: 'modelCatalog';
      }
    | {
        readonly resourceKind: 'phase';
        readonly resourceId: string;
      }
    | {
        readonly resourceKind: 'workflow';
        readonly resourceId: string;
        readonly inclusion: 'references-only' | 'include-closure';
      };
}

/** Open host dialog to preflight an imported process YAML document (empty payload only). */
export interface PreflightProcessYamlCommand extends GeneratedCommandBase<'CMD_PREFLIGHT_PROCESS_YAML'> {
  readonly payload: PreflightProcessYamlRequest;
}

/** Read persisted phase log entries for a safe-path-segment tuple. */
export interface ReadPhaseLogCommand extends GeneratedCommandBase<'CMD_READ_PHASE_LOG'> {
  readonly payload: {
    readonly selection: {
      readonly queueId: string;
      readonly taskId: string;
      readonly pipelineId: string;
      readonly phaseId: string;
      readonly iterationN: number | null;
    };
  };
}

/** Start a live phase log tail session for a concrete iteration. */
export interface StartPhaseLogTailCommand extends GeneratedCommandBase<'CMD_START_PHASE_LOG_TAIL'> {
  readonly payload: {
    readonly selection: {
      readonly queueId: string;
      readonly taskId: string;
      readonly pipelineId: string;
      readonly phaseId: string;
      readonly iterationN: number;
    };
    readonly consumer?: string;
    readonly fromCursor?: string;
  };
}

/** Stop an active live phase log tail session. */
export interface StopPhaseLogTailCommand extends GeneratedCommandBase<'CMD_STOP_PHASE_LOG_TAIL'> {
  readonly payload: {
    readonly sessionId: string;
  };
}

/** Acknowledge a live phase log batch with credit, resync, or duplicate flags. */
export interface AckPhaseLogTailCommand extends GeneratedCommandBase<'CMD_ACK_PHASE_LOG_TAIL'> {
  readonly payload: {
    readonly sessionId: string;
    readonly batchSeq: number;
    readonly resync?: boolean;
    readonly duplicate?: boolean;
  };
}

/**
 * Scan workspace audit/rollup metrics with optional archive inclusion and bounded runIds filter.
 */
export interface ReadMetricsCommand extends GeneratedCommandBase<'CMD_READ_METRICS'> {
  readonly payload: {
    readonly includeArchives?: boolean;
    readonly runIds?: readonly string[];
  };
}

/** Read storage pressure summary and one paginated artifact inventory page. */
export interface ReadStorageDetailsCommand extends GeneratedCommandBase<'CMD_READ_STORAGE_DETAILS'> {
  readonly payload: {
    readonly cursor?: string;
  };
}

/** Read one usage accounting page; query validation is delegated to the shared host validator. */
export interface ReadUsageAccountingCommand extends GeneratedCommandBase<'CMD_READ_USAGE_ACCOUNTING'> {
  readonly payload: {
    readonly query: unknown;
  };
}

/** Run, page, drill down, cancel, list, or reproduce historical reports. */
export interface ReadReportCommand extends GeneratedCommandBase<'CMD_READ_REPORT'> {
  readonly payload:
    | {
        readonly op: 'run';
        readonly query: unknown;
      }
    | {
        readonly op: 'page';
        readonly cursor: string;
      }
    | {
        readonly op: 'drillDown';
        readonly reportId: string;
        readonly rootId: string;
      }
    | {
        readonly op: 'close';
        readonly reportId: string;
      }
    | {
        readonly op: 'rerunSaved';
        readonly reportId: string;
      }
    | {
        readonly op: 'reproduceSaved';
        readonly reportId: string;
      }
    | {
        readonly op: 'listSaved';
        readonly request?: unknown;
      }
    | {
        readonly op: 'cancelActive';
      };
}

/** Export (via host dialog), save, or delete a saved report record. */
export interface MutateReportCommand extends GeneratedCommandBase<'CMD_MUTATE_REPORT'> {
  readonly payload:
    | {
        readonly op: 'export';
        readonly reportId: string;
        readonly format: 'json' | 'csv';
      }
    | {
        readonly op: 'save';
        readonly reportId: string;
      }
    | {
        readonly op: 'deleteSaved';
        readonly reportId: string;
        readonly confirmed: true;
      };
}

/** Compose, validate, freeze, and enqueue a Pipeline RunRequest. */
export interface LaunchPipelineCommand extends GeneratedCommandBase<'CMD_LAUNCH_PIPELINE'> {
  readonly payload: {
    readonly request: RunRequest;
    readonly queueId?: string;
  };
}

/** Launch a connected Workflow run from a declared startNodeId. */
export interface LaunchWorkflowCommand extends GeneratedCommandBase<'CMD_LAUNCH_WORKFLOW'> {
  readonly payload: {
    readonly workflowId: string;
    readonly startNodeId: string;
    readonly request: RunRequest;
    readonly queueId?: string;
  };
}

/** Continue or apply a control operation to a connected Workflow run. */
export interface ContinueWorkflowCommand extends GeneratedCommandBase<'CMD_CONTINUE_WORKFLOW'> {
  readonly payload: {
    readonly connectedRunId: string;
    readonly expectedRevision: number;
    readonly nodeId: string;
    readonly request: RunRequest;
    readonly invocationId?: string;
    readonly operation?: WorkflowControlAction;
    readonly commandId?: string;
    readonly controlCommand?: ControlCommandEnvelope;
  };
}

/** Read attempt visibility details or runtime lane/telemetry posture. */
export interface ReadExecutionVisibilityCommand extends GeneratedCommandBase<'CMD_READ_EXECUTION_VISIBILITY'> {
  readonly payload:
    | {
        readonly op: 'attemptDetail';
        readonly rootExecutionId: string;
        readonly invocationId?: string;
        readonly attemptId?: string;
      }
    | {
        readonly op: 'runtimePosture';
      };
}

/** Open, refresh, classify, page, close, or cancel an immutable candidate change review. */
export interface OpenChangeReviewCommand extends GeneratedCommandBase<'CMD_OPEN_CHANGE_REVIEW'> {
  readonly payload:
    | {
        readonly op: 'open';
        readonly requestId: string;
        readonly expectedRevision?: string;
        readonly openInEditor?: boolean;
      }
    | {
        readonly op: 'refresh';
        readonly reviewId: string;
        readonly openInEditor?: boolean;
      }
    | {
        readonly op: 'classify';
        readonly reviewId: string;
      }
    | {
        readonly op: 'close';
        readonly reviewId: string;
      }
    | {
        readonly op: 'page';
        readonly cursor: string;
      }
    | {
        readonly op: 'cancelOpen';
      };
}

/** Approve or edit a manual phase-to-phase context handoff revision. */
export interface DecidePhaseHandoffCommand extends GeneratedCommandBase<'CMD_DECIDE_PHASE_HANDOFF'> {
  readonly payload:
    | {
        readonly op: 'approve';
        readonly handoffId: string;
        readonly expectedRevision: number;
        readonly decisionId: string;
      }
    | {
        readonly op: 'edit';
        readonly handoffId: string;
        readonly baseRevision: number;
        readonly replacementSources: readonly unknown[];
      }
    | {
        readonly op: 'editSummary';
        readonly handoffId: string;
        readonly baseRevision: number;
        readonly summary: string;
        readonly producerAttemptId?: string;
      };
}

/**
 * Synchronizes STATE_SNAPSHOT with the consumer's baseline. Full mode resets the baseline to revision; routine mode reconstructs omittedSlices from baseRevision.
 */
export type SnapshotSyncMeta =
  | {
      readonly mode: 'full';
      readonly revision: number;
      readonly baseRevision?: never;
      readonly omittedSlices?: never;
    }
  | {
      readonly mode: 'routine';
      readonly revision: number;
      readonly baseRevision: number;
      readonly omittedSlices: readonly ('history' | 'phaseCatalog' | 'pipelineCatalog' | 'workflowCatalog' | 'availablePhases' | 'availablePipelines' | 'auditTail' | 'debugLogTail')[];
    };

/** A display entry as it crosses the boundary: sanitized and budgeted. */
export interface PhaseLogWireEntry {
  readonly seq: number;
  readonly kind: 'assistant-text' | 'tool-use' | 'tool-result' | 'system' | 'result' | 'truncated-head' | 'tail-ended' | 'coverage-gap';
  readonly ts: string | null;
  readonly body: Readonly<Record<string, unknown>>;
  readonly bodyTruncated: Readonly<Record<string, {
    readonly originalLength: number;
  }>> | null;
}

/**
 * One entry with its source position. The at field is the end byte offset of its record, and n is the entry's ordinal within that record.
 */
export interface LiveLogBatchEntry {
  readonly at: number;
  readonly n: number;
  readonly entry: PhaseLogWireEntry;
}

export type LiveLogBatchMode = 'continue' | 'resume' | 'reset';

/** The MSG_PHASE_LOG_BATCH payload, at most 256 KiB serialized. */
export interface PhaseLogBatchPayload {
  readonly protocol: 1;
  readonly tailSessionId: string;
  readonly batchSeq: number;
  readonly generation: string;
  readonly mode: LiveLogBatchMode;
  readonly toCursor: string | null;
  readonly entries: readonly LiveLogBatchEntry[];
}

/** Host pushes an authoritative WorkflowSnapshot envelope with optional sync metadata. */
export interface StateSnapshotMessage<S> {
  readonly type: 'STATE_SNAPSHOT';
  readonly payload: S;
  readonly sync?: SnapshotSyncMeta;
}

/** Host acknowledges acceptance or rejection of a correlated webview command. */
export interface CommandAckMessage {
  readonly type: 'CMD_ACK';
  readonly correlationId: string;
  readonly status: 'accepted' | 'rejected';
  readonly outcome?: CommandAckOutcome;
  readonly reason?: string;
  readonly result?: unknown;
}

/** Host pushes a bounded, positioned batch of live phase log entries. */
export interface PhaseLogBatchPushMessage {
  readonly type: 'MSG_PHASE_LOG_BATCH';
  readonly payload: PhaseLogBatchPayload;
}

export type HostMessage<S> =
  | StateSnapshotMessage<S>
  | CommandAckMessage
  | PhaseLogBatchPushMessage;
