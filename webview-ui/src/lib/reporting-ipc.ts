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
import { boundaryRefusalText, OUTCOME_NOT_YET_KNOWN_TEXT } from './boundary-refusal-text';

const ACK_TIMEOUT_MS = 10_000;
/**
 * Finite liveness backstop for interactive native Save dialogs (`op: 'export'`). Matches the
 * process-YAML dialog backstop (`5 min`) and live-report lease lifetime so a long Save dialog
 * never trips the 10 s RPC timer while a dead or dropped extension host still cannot wedge the UI.
 */
export const EXPORT_ACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface ReportCallEnvelope<T> {
  readonly response: T;
  readonly boundaryRefusal: string | null;
}

export interface ReportRequestOptions {
  readonly signal?: AbortSignal;
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
    reason === 'secondary-window-readonly' ||
    reason === 'command-dispatch-failed'
  ) {
    return boundaryRefusalText(reason);
  }
  return null;
}

export function requestReadReport(
  payload: ReadReportRequest,
  options?: ReportRequestOptions
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
    fallback,
    ACK_TIMEOUT_MS,
    options?.signal
  );
}

export function requestMutateReport(
  payload: MutateReportRequest,
  options?: ReportRequestOptions
): Promise<ReportCallEnvelope<MutateReportResponse>> {
  const isExport = payload.op === 'export';
  const fallback: ReportCallEnvelope<MutateReportResponse> = {
    response: defaultMutateFallback(payload),
    boundaryRefusal: isExport ? OUTCOME_NOT_YET_KNOWN_TEXT : null
  };
  const timeoutMs = isExport ? EXPORT_ACK_TIMEOUT_MS : ACK_TIMEOUT_MS;
  return correlatedRequest(
    () => postCommand(CMD_MUTATE_REPORT, payload).correlationId,
    (ack) => {
      const refusal = gateRefusal(ack.reason);
      const response = isValidMutateReportResponse(ack.result)
        ? ack.result
        : defaultMutateFallback(payload);
      return { response, boundaryRefusal: refusal };
    },
    fallback,
    timeoutMs,
    options?.signal
  );
}

function correlatedRequest<T>(
  post: () => string,
  project: (ack: {
    readonly status: 'accepted' | 'rejected';
    readonly reason?: string;
    readonly result?: unknown;
  }) => T,
  onTimeout: T,
  timeoutMs: number = ACK_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) {
    return Promise.resolve(onTimeout);
  }
  return new Promise<T>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    let correlationId: string | null = null;

    const onAbort = (): void => {
      finalise(onTimeout);
    };

    const finalise = (result: T): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal !== undefined) {
        signal.removeEventListener('abort', onAbort);
      }
      if (unsubscribe !== null) {
        try {
          unsubscribe();
        } catch {
          // one-shot listener errors must not leak
        }
        unsubscribe = null;
      }
      if (correlationId !== null) {
        snapshotStore.clearPending(correlationId);
        correlationId = null;
      }
      resolve(result);
    };

    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      untrack(() => {
        correlationId = post();
        snapshotStore.markPending(correlationId);
        unsubscribe = snapshotStore.onceAck(correlationId, (ack) => {
          finalise(project(ack));
        });
      });
    } catch {
      finalise(onTimeout);
      return;
    }

    timer = setTimeout(() => {
      finalise(onTimeout);
    }, timeoutMs);
  });
}
