/**
 * FR-R6-F12, FR-R6-F10, FR-R6-F13, FR-R6-F14, FR-R6-F15 — sidebar IPC contract for execution
 * visibility, immutable candidate change review, runtime/telemetry health, and manual phase
 * handoff approval/editing.
 *
 * Zero filesystem paths, prompts, transcripts or findings prose cross this boundary.
 * Node-free and `vscode`-free so both host and webview bundle it cleanly.
 */
import type {
  CMD_DECIDE_PHASE_HANDOFF,
  CMD_OPEN_CHANGE_REVIEW,
  CMD_READ_EXECUTION_VISIBILITY,
  CommandBase
} from '../sidebar-ipc';
import type {
  ReviewDescriptor,
  ReviewOpened,
  ReviewPage,
  ReviewResult
} from '../change-review';
import type { AcceptedRevision, HandoffExplanation } from '../phase-context/context-manifest';
import type { Refusal as PhaseContextRefusal } from '../phase-context/context-policy';
import type {
  ReportEvidenceReference,
  RootReviewLoopSummary
} from '../reporting/report-rows';

export type VisibilityDataQuality = 'authoritative' | 'partial' | 'unknown';
export type VisibilityStreamState = 'captured' | 'partial' | 'not-captured' | 'unknown';
export type VisibilityRecoveryPosture = 'verified' | 'degraded' | 'uncertain' | 'not-recorded';
export type NormalizedAcpActivityState =
  | 'connected'
  | 'disconnected'
  | 'awaiting-permission'
  | 'canceled'
  | 'uncertain'
  | 'not-recorded';

export interface AttemptVisibilityRow {
  readonly attemptId: string;
  readonly stepIndex: number;
  readonly phaseId: string | null;
  readonly attemptNumber: number;
  readonly status: string;
  readonly exitCode: number | null;
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
  readonly backendKind: string | null;
  readonly modelId: string | null;
  readonly profileId: string | null;
  readonly laneId: string | null;
  readonly failureCause: string | null;
}

export interface ExecutionHierarchySummary {
  readonly rootStatus: string | null;
  readonly workflowId: string | null;
  readonly frozenDefinitionId: string | null;
  readonly invocationCount: number;
  readonly attemptCount: number;
  readonly dataQuality: VisibilityDataQuality;
  readonly attempts: readonly AttemptVisibilityRow[];
}

export interface ExecutionLiveLogVisibility {
  readonly streamState: VisibilityStreamState;
  readonly segmentCount: number;
  readonly gapCount: number;
}

export interface ExecutionRecoveryVisibility {
  readonly posture: VisibilityRecoveryPosture;
  readonly reasonCode: string | null;
}

export interface ExecutionAcpVisibility {
  readonly runtimeState: NormalizedAcpActivityState;
  readonly profileId: string | null;
  readonly backendKind: string | null;
  readonly modelId: string | null;
  readonly liveObservations: number;
  readonly pendingPermissions: number;
}

export interface ExecutionLaneCandidateVisibility {
  readonly mode: 'isolated-lane' | 'shared-workspace';
  readonly laneId: string | null;
  readonly laneState: string | null;
  readonly candidateId: string | null;
  readonly integrationRequestId: string | null;
  readonly integrationState: string | null;
  readonly targetRef: string | null;
  readonly comparisonRevision: string | null;
}

export interface ExecutionAttemptVisibility {
  readonly available: boolean;
  readonly unavailableReason: 'store-unavailable' | null;
  readonly rootExecutionId: string;
  readonly hierarchy: ExecutionHierarchySummary;
  readonly evidence: readonly ReportEvidenceReference[];
  readonly liveLog: ExecutionLiveLogVisibility;
  readonly recovery: ExecutionRecoveryVisibility;
  readonly acp: ExecutionAcpVisibility;
  readonly lane: ExecutionLaneCandidateVisibility;
  readonly handoffs: readonly HandoffExplanation[];
  readonly reviewLoops: readonly RootReviewLoopSummary[];
}

export interface RuntimeLanePosture {
  readonly enabled: boolean;
  readonly liveLaneCap: number;
  readonly activeLanes: number;
  readonly totalLanes: number;
  readonly pendingIntegrations: number;
}

export interface RuntimeTelemetryPosture {
  readonly enabled: boolean;
  readonly stateKind: string;
  readonly reasonCode: string | null;
  readonly protocol: string | null;
  readonly contentPolicyMode: string;
  readonly pendingCopyCount: number;
  readonly exportedCopyCount: number;
  readonly droppedCopyCount: number;
  readonly spooledBatchCount: number;
  readonly spooledBytes: number;
  readonly spoolCeilingBytes: number;
  readonly activeSeriesCount: number;
  readonly seriesCap: number;
  readonly overflowCount: number;
  readonly previewSummary: string;
}

export interface RuntimePostureVisibility {
  readonly available: boolean;
  readonly lanes: RuntimeLanePosture;
  readonly telemetry: RuntimeTelemetryPosture;
}

export type ReadExecutionVisibilityRequest =
  | {
      readonly op: 'attemptDetail';
      readonly rootExecutionId: string;
      readonly invocationId?: string;
      readonly attemptId?: string;
    }
  | { readonly op: 'runtimePosture' };

export interface ReadExecutionVisibilityCommand
  extends CommandBase<typeof CMD_READ_EXECUTION_VISIBILITY> {
  readonly payload: ReadExecutionVisibilityRequest;
}

export type ReadExecutionVisibilityResponse =
  | { readonly op: 'attemptDetail'; readonly detail: ExecutionAttemptVisibility }
  | { readonly op: 'runtimePosture'; readonly posture: RuntimePostureVisibility };

export type OpenChangeReviewRequest =
  | {
      readonly op: 'open';
      readonly requestId: string;
      readonly expectedRevision?: string;
      readonly openInEditor?: boolean;
    }
  | { readonly op: 'refresh'; readonly reviewId: string; readonly openInEditor?: boolean }
  | { readonly op: 'classify'; readonly reviewId: string }
  | { readonly op: 'page'; readonly cursor: string }
  | { readonly op: 'close'; readonly reviewId: string }
  | { readonly op: 'cancelOpen' };

export interface OpenChangeReviewCommand extends CommandBase<typeof CMD_OPEN_CHANGE_REVIEW> {
  readonly payload: OpenChangeReviewRequest;
}

export interface ChangeReviewEditorOpenOutcome {
  readonly mode: 'native' | 'fallback' | 'none';
  readonly opened: number;
}

export type OpenChangeReviewResponse =
  | {
      readonly op: 'open';
      readonly result: ReviewResult<ReviewOpened>;
      readonly editor: ChangeReviewEditorOpenOutcome;
    }
  | {
      readonly op: 'refresh';
      readonly result: ReviewResult<ReviewOpened>;
      readonly editor: ChangeReviewEditorOpenOutcome;
    }
  | { readonly op: 'classify'; readonly result: ReviewResult<ReviewDescriptor> }
  | { readonly op: 'page'; readonly result: ReviewResult<ReviewPage> }
  | { readonly op: 'close'; readonly closed: boolean }
  | { readonly op: 'cancelOpen'; readonly canceled: boolean };

export type DecidePhaseHandoffRequest =
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
      readonly replacementSources: unknown;
    };

export interface DecidePhaseHandoffCommand extends CommandBase<typeof CMD_DECIDE_PHASE_HANDOFF> {
  readonly payload: DecidePhaseHandoffRequest;
}

export type DecidePhaseHandoffResponse =
  | {
      readonly op: 'approve';
      readonly result: { readonly ok: true; readonly revision: number } | PhaseContextRefusal;
    }
  | {
      readonly op: 'edit';
      readonly result:
        | { readonly ok: true; readonly revision: AcceptedRevision }
        | PhaseContextRefusal;
    };
