// FR-R6-F11 (FR-016..FR-022, NFR-006) — historical reporting IPC helper.
//
// The SINGLE webview call site for `CMD_READ_REPORT` and `CMD_MUTATE_REPORT`. Components MUST NOT
// import either command constant or call `postCommand` directly: they route through the typed
// helpers below. Zero filesystem paths cross this boundary in either direction.

import {
  CMD_MUTATE_REPORT,
  CMD_READ_REPORT,
  type MutateReportRequest,
  type MutateReportResponse,
  type ReadReportRequest,
  type ReadReportResponse
} from './messages';
import { untrack } from 'svelte';
import { postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';
import {
  isValidMutateReportResponse,
  isValidReadReportResponse
} from '../../../src/contracts/runtime-validators';
import { boundaryRefusalText } from './boundary-refusal-text';

const ACK_TIMEOUT_MS = 10_000;

export interface ReportCallEnvelope<T> {
  readonly response: T;
  readonly boundaryRefusal: string | null;
}

function defaultReadFallback(request: ReadReportRequest): ReadReportResponse {
  const unavailable = { ok: false as const, outcome: 'refused' as const, reason: 'accounting-unavailable' as const };
  switch (request.op) {
    case 'run':
      return { op: 'run', result: unavailable };
    case 'page':
      return { op: 'page', result: unavailable };
    case 'drillDown':
      return { op: 'drillDown', result: unavailable };
    case 'close':
      return { op: 'close', result: unavailable };
    case 'listSaved':
      return { op: 'listSaved', result: unavailable };
    case 'rerunSaved':
      return { op: 'rerunSaved', result: unavailable };
    case 'reproduceSaved':
      return { op: 'reproduceSaved', result: unavailable };
    case 'cancelActive':
      return { op: 'cancelActive', canceled: false };
  }
}

function defaultMutateFallback(request: MutateReportRequest): MutateReportResponse {
  const unavailable = { ok: false as const, outcome: 'refused' as const, reason: 'accounting-unavailable' as const };
  switch (request.op) {
    case 'export':
      return { op: 'export', exportOutcome: { outcome: 'completed', result: unavailable } };
    case 'save':
      return { op: 'save', result: unavailable };
    case 'deleteSaved':
      return { op: 'deleteSaved', result: unavailable };
  }
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

export function requestReadReport(
  payload: ReadReportRequest
): Promise<ReportCallEnvelope<ReadReportResponse>> {
  const fallback: ReportCallEnvelope<ReadReportResponse> = {
    response: defaultReadFallback(payload),
    boundaryRefusal: null
  };
  return correlatedRequest(
    () => postCommand(CMD_READ_REPORT, payload).correlationId,
    (ack) => {
      const refusal = gateRefusal(ack.reason);
      const response = isValidReadReportResponse(ack.result)
        ? ack.result
        : defaultReadFallback(payload);
      return { response, boundaryRefusal: refusal };
    },
    fallback
  );
}

export function requestMutateReport(
  payload: MutateReportRequest
): Promise<ReportCallEnvelope<MutateReportResponse>> {
  const fallback: ReportCallEnvelope<MutateReportResponse> = {
    response: defaultMutateFallback(payload),
    boundaryRefusal: null
  };
  return correlatedRequest(
    () => postCommand(CMD_MUTATE_REPORT, payload).correlationId,
    (ack) => {
      const refusal = gateRefusal(ack.reason);
      const response = isValidMutateReportResponse(ack.result)
        ? ack.result
        : defaultMutateFallback(payload);
      return { response, boundaryRefusal: refusal };
    },
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
