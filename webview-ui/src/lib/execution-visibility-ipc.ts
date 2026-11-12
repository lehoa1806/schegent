// FR-R6-F12, FR-R6-F10, FR-R6-F14, FR-R6-F15 — execution visibility, immutable candidate change
// review, runtime telemetry posture, and manual phase-handoff decision IPC helper.
//
// The SINGLE webview call site for `CMD_READ_EXECUTION_VISIBILITY`, `CMD_OPEN_CHANGE_REVIEW`, and
// `CMD_DECIDE_PHASE_HANDOFF`. Components MUST NOT import these command constants or call
// `postCommand` directly.

import {
  CMD_DECIDE_PHASE_HANDOFF,
  CMD_OPEN_CHANGE_REVIEW,
  CMD_READ_EXECUTION_VISIBILITY,
  type DecidePhaseHandoffRequest,
  type DecidePhaseHandoffResponse,
  type ExecutionAttemptVisibility,
  type OpenChangeReviewRequest,
  type OpenChangeReviewResponse,
  type ReadExecutionVisibilityRequest,
  type ReadExecutionVisibilityResponse,
  type RuntimePostureVisibility
} from './messages';
import { untrack } from 'svelte';
import { postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';
import {
  isValidDecidePhaseHandoffResponse,
  isValidOpenChangeReviewResponse,
  isValidReadExecutionVisibilityResponse
} from '../../../src/contracts/runtime-validators';
import { boundaryRefusalText } from './boundary-refusal-text';

const ACK_TIMEOUT_MS = 8_000;

export interface VisibilityCallEnvelope<T> {
  readonly response: T;
  readonly boundaryRefusal: string | null;
}

function unavailableAttemptDetail(rootExecutionId: string): ExecutionAttemptVisibility {
  return {
    available: false,
    unavailableReason: 'store-unavailable',
    rootExecutionId,
    hierarchy: {
      rootStatus: null,
      workflowId: null,
      frozenDefinitionId: null,
      invocationCount: 0,
      attemptCount: 0,
      dataQuality: 'unknown',
      attempts: []
    },
    evidence: [],
    liveLog: { streamState: 'unknown', segmentCount: 0, gapCount: 0 },
    recovery: { posture: 'not-recorded', reasonCode: null },
    acp: {
      runtimeState: 'not-recorded',
      profileId: null,
      backendKind: null,
      modelId: null,
      liveObservations: 0,
      pendingPermissions: 0
    },
    lane: {
      mode: 'shared-workspace',
      laneId: null,
      laneState: null,
      candidateId: null,
      integrationRequestId: null,
      integrationState: null,
      targetRef: null,
      comparisonRevision: null
    },
    handoffs: [],
    reviewLoops: []
  };
}

const UNAVAILABLE_RUNTIME_POSTURE: RuntimePostureVisibility = {
  available: false,
  lanes: {
    enabled: false,
    liveLaneCap: 4,
    activeLanes: 0,
    totalLanes: 0,
    pendingIntegrations: 0
  },
  telemetry: {
    enabled: false,
    stateKind: 'disabled',
    reasonCode: null,
    protocol: null,
    contentPolicyMode: 'metadata-only',
    pendingCopyCount: 0,
    exportedCopyCount: 0,
    droppedCopyCount: 0,
    spooledBatchCount: 0,
    spooledBytes: 0,
    spoolCeilingBytes: 10 * 1024 * 1024,
    activeSeriesCount: 0,
    seriesCap: 256,
    overflowCount: 0,
    previewSummary: 'Metrics only (metadata-only allowlist). Content export is unsupported and refused.'
  }
};

function defaultVisibilityFallback(
  payload: ReadExecutionVisibilityRequest
): ReadExecutionVisibilityResponse {
  return payload.op === 'attemptDetail'
    ? { op: 'attemptDetail', detail: unavailableAttemptDetail(payload.rootExecutionId) }
    : { op: 'runtimePosture', posture: UNAVAILABLE_RUNTIME_POSTURE };
}

function defaultChangeReviewFallback(payload: OpenChangeReviewRequest): OpenChangeReviewResponse {
  const refused = { ok: false as const, kind: 'refused' as const, reason: 'review-not-found' as const };
  switch (payload.op) {
    case 'open':
      return { op: 'open', result: refused, editor: { mode: 'none', opened: 0 } };
    case 'refresh':
      return { op: 'refresh', result: refused, editor: { mode: 'none', opened: 0 } };
    case 'classify':
      return { op: 'classify', result: refused };
    case 'page':
      return { op: 'page', result: refused };
    case 'close':
      return { op: 'close', closed: false };
    case 'cancelOpen':
      return { op: 'cancelOpen', canceled: false };
  }
}

function defaultHandoffFallback(payload: DecidePhaseHandoffRequest): DecidePhaseHandoffResponse {
  const refusal = {
    ok: false as const,
    failure: 'storage-unavailable' as const,
    detail: 'unavailable'
  };
  return payload.op === 'approve'
    ? { op: 'approve', result: refusal }
    : { op: 'edit', result: refusal };
}

function gateRefusal(reason: string | undefined): string | null {
  if (
    reason === 'untrusted-workspace' ||
    reason === 'workspace-not-trusted' ||
    reason === 'secondary-window-readonly'
  ) {
    return boundaryRefusalText(reason);
  }
  return null;
}

export function requestExecutionVisibility(
  payload: ReadExecutionVisibilityRequest
): Promise<VisibilityCallEnvelope<ReadExecutionVisibilityResponse>> {
  const fallback: VisibilityCallEnvelope<ReadExecutionVisibilityResponse> = {
    response: defaultVisibilityFallback(payload),
    boundaryRefusal: null
  };
  return correlatedRequest(
    () => postCommand(CMD_READ_EXECUTION_VISIBILITY, payload).correlationId,
    (ack) => ({
      response: isValidReadExecutionVisibilityResponse(ack.result)
        ? ack.result
        : defaultVisibilityFallback(payload),
      boundaryRefusal: gateRefusal(ack.reason)
    }),
    fallback
  );
}

export function requestChangeReview(
  payload: OpenChangeReviewRequest
): Promise<VisibilityCallEnvelope<OpenChangeReviewResponse>> {
  const fallback: VisibilityCallEnvelope<OpenChangeReviewResponse> = {
    response: defaultChangeReviewFallback(payload),
    boundaryRefusal: null
  };
  return correlatedRequest(
    () => postCommand(CMD_OPEN_CHANGE_REVIEW, payload).correlationId,
    (ack) => ({
      response: isValidOpenChangeReviewResponse(ack.result)
        ? ack.result
        : defaultChangeReviewFallback(payload),
      boundaryRefusal: gateRefusal(ack.reason)
    }),
    fallback
  );
}

export function requestDecidePhaseHandoff(
  payload: DecidePhaseHandoffRequest
): Promise<VisibilityCallEnvelope<DecidePhaseHandoffResponse>> {
  const fallback: VisibilityCallEnvelope<DecidePhaseHandoffResponse> = {
    response: defaultHandoffFallback(payload),
    boundaryRefusal: null
  };
  return correlatedRequest(
    () => postCommand(CMD_DECIDE_PHASE_HANDOFF, payload).correlationId,
    (ack) => ({
      response: isValidDecidePhaseHandoffResponse(ack.result)
        ? ack.result
        : defaultHandoffFallback(payload),
      boundaryRefusal: gateRefusal(ack.reason)
    }),
    fallback
  );
}

function correlatedRequest<T>(
  post: () => string,
  project: (ack: {
    readonly status: 'accepted' | 'rejected';
    readonly reason?: string;
    readonly result?: unknown;
  }) => T,
  onTimeout: T
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: T): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (unsubscribe !== null) {
        try {
          unsubscribe();
        } catch {
          // one-shot listener errors must not leak
        }
        unsubscribe = null;
      }
      resolve(result);
    };

    untrack(() => {
      const correlationId = post();
      snapshotStore.markPending(correlationId);
      unsubscribe = snapshotStore.onceAck(correlationId, (ack) => {
        finalise(project(ack));
      });
    });

    timer = setTimeout(() => {
      finalise(onTimeout);
    }, ACK_TIMEOUT_MS);
  });
}
