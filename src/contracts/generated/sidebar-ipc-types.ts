// GENERATED FILE — do not edit.
//
// Emitted from scripts/contracts/ipc-descriptors/index.mjs by scripts/generate-contract-schemas.mjs.
// Edit the descriptor and run: npm run contracts:generate

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

/** Persist the Model Catalog with optional import revision and mutation tag. */
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
    readonly runner: 'claude' | 'codex' | 'agy';
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
