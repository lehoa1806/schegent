// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Registers a read-only TextDocumentContentProvider for `schegent-review` URIs and builds lazy
// adapters over `SqliteCutoverCoordinator`. Nothing here opens a store, spawns a process, writes a
// file or arms a timer at wiring time; mutating IPC routes pass the router's trust + primacy gates.

import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  placeholderRead,
  reviewRefused,
  type ChangeEntry,
  type ReviewOpened
} from '../contracts/change-review';
import type { ExportFormat } from '../contracts/reporting/report-manifest';
import { reportCancelled, reportRefused } from '../contracts/reporting/report-outcomes';
import type { HostReportExportResult } from '../contracts/sidebar-ipc/reporting';
import { createChangeReviewApi, type ChangeReviewApi } from '../headless/change-review-api';
import {
  createExecutionVisibilityApi,
  type ExecutionVisibilityApi
} from '../headless/execution-visibility-api';
import { createPhaseContextApi, type PhaseContextApi } from '../headless/phase-context-api';
import { createReportingApi, type ReportingApi } from '../headless/reporting-api';
import type { ChangeReviewService } from '../services/change-review';
import type { WorkspaceStateStore } from '../state/workspace-state';
import {
  createVscodeEditorPort,
  registerChangeReviewProvider
} from '../ui/change-review/review-editor-binding';
import { openReviewInEditor, type OpenedInEditor } from '../ui/change-review/review-opener';
import { getSqliteCutoverCoordinator } from './sqlite-cutover-wiring';

export interface Round6VisibilityWiringDeps {
  readonly workspaceRoot: string;
  readonly store: WorkspaceStateStore;
  /** Optional trust reader; defaults to `() => vscode.workspace.isTrusted`. */
  readonly isWorkspaceTrusted?: () => boolean;
  /** Primacy reader; fails closed (`false`) when omitted so missing wiring never falls open. */
  readonly hasPrimacy?: () => boolean | Promise<boolean>;
  /** Optional subscription invoked when workspace trust or window primacy is lost. */
  readonly onTrustOrPrimacyLost?: (listener: () => void) => vscode.Disposable;
}

export interface Round6VisibilityWiring {
  readonly reportingApi: () => ReportingApi | null;
  readonly exportReportWithDialog: (request: {
    readonly reportId: string;
    readonly format: ExportFormat;
  }) => Promise<HostReportExportResult>;
  readonly executionVisibility: ExecutionVisibilityApi;
  readonly changeReviewApi: () => ChangeReviewApi;
  readonly openReviewInEditor: (
    opened: ReviewOpened,
    entries: readonly ChangeEntry[]
  ) => Promise<OpenedInEditor>;
  readonly phaseContextApi: () => PhaseContextApi | null;
  /** Cancels any in-flight open and closes every tracked active host change review. */
  readonly closeAllActiveReviews: () => number;
  readonly disposable: vscode.Disposable;
}

function createExportReportWithDialog(deps: {
  readonly workspaceRoot: string;
  readonly isDisposed: () => boolean;
  readonly isWorkspaceTrusted: () => boolean;
  readonly checkPrimacy: () => Promise<boolean>;
  readonly getLifecycleEpoch: () => number;
  readonly isEpochInvalidated: (epoch: number) => boolean;
  readonly getReportingApi: () => ReportingApi | null;
}): Round6VisibilityWiring['exportReportWithDialog'] {
  let exportDialogInFlight = false;
  return async ({ reportId, format }) => {
    if (deps.isDisposed()) return { outcome: 'completed', result: reportCancelled() };
    if (!deps.isWorkspaceTrusted()) {
      return { outcome: 'completed', result: reportRefused('workspace-untrusted') };
    }
    if (exportDialogInFlight) {
      return { outcome: 'completed', result: reportRefused('export-busy') };
    }
    exportDialogInFlight = true;
    try {
      const epoch = deps.getLifecycleEpoch();
      if (!(await deps.checkPrimacy()) || deps.isEpochInvalidated(epoch)) {
        return { outcome: 'completed', result: reportCancelled() };
      }
      if (deps.getReportingApi() === null) {
        return { outcome: 'completed', result: reportRefused('accounting-unavailable') };
      }
      const ext = format === 'csv' ? 'csv' : 'json';
      const suggestedName = `schegent-report-${reportId.slice(0, 12)}.${ext}`;
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(deps.workspaceRoot, suggestedName)),
        filters: format === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] },
        saveLabel: 'Export report'
      });
      if (!target) return { outcome: 'dialog-canceled' };
      // SR-A2 #3: re-verify workspace trust, primacy, and lifecycle epoch after the Save dialog
      // closes so trust or primacy loss during the dialog never proceeds to write an export file.
      if (deps.isDisposed()) return { outcome: 'completed', result: reportCancelled() };
      if (!deps.isWorkspaceTrusted()) {
        return { outcome: 'completed', result: reportRefused('workspace-untrusted') };
      }
      if (!(await deps.checkPrimacy()) || deps.isEpochInvalidated(epoch)) {
        return { outcome: 'completed', result: reportCancelled() };
      }
      const api = deps.getReportingApi();
      if (api === null) {
        return { outcome: 'completed', result: reportRefused('accounting-unavailable') };
      }
      const result = await api.exportReport({
        reportId,
        format,
        destination: { scheme: target.scheme, fsPath: target.fsPath },
        overwrite: true
      });
      return { outcome: 'completed', result };
    } finally {
      exportDialogInFlight = false;
    }
  };
}

export function createRound6VisibilityWiring(
  deps: Round6VisibilityWiringDeps
): Round6VisibilityWiring {
  const { workspaceRoot, store } = deps;
  const readWorkspaceTrusted = deps.isWorkspaceTrusted ?? ((): boolean => vscode.workspace.isTrusted);
  const activeReviewIds = new Set<string>();
  let cancelPendingOpen: (() => void) | null = null;
  let lifecycleEpoch = 0;
  let primacyVerifiedEpoch = -1;
  let disposed = false;

  const isDisposed = (): boolean => disposed;
  const isEpochInvalidated = (epoch: number): boolean => disposed || lifecycleEpoch !== epoch;

  const closeAllActiveReviews = (): number => {
    lifecycleEpoch += 1;
    primacyVerifiedEpoch = -1;
    cancelPendingOpen?.();
    const ids = [...activeReviewIds];
    activeReviewIds.clear();
    const svc = getSqliteCutoverCoordinator(store)?.getChangeReviewService() ?? null;
    if (svc === null) return 0;
    let closedCount = 0;
    for (const reviewId of ids) {
      if (svc.closeReview(reviewId).closed) {
        closedCount += 1;
      }
    }
    return closedCount;
  };

  const isWorkspaceTrusted = (): boolean => {
    const trustedNow = readWorkspaceTrusted();
    if (!trustedNow) {
      closeAllActiveReviews();
    }
    return trustedNow;
  };

  const checkPrimacy = async (): Promise<boolean> => {
    const epoch = lifecycleEpoch;
    let primaryNow = false;
    try {
      if (deps.hasPrimacy !== undefined) {
        primaryNow = (await deps.hasPrimacy()) === true;
      }
    } catch {
      primaryNow = false;
    }
    if (!primaryNow) {
      closeAllActiveReviews();
      return false;
    }
    if (!isEpochInvalidated(epoch)) {
      primacyVerifiedEpoch = epoch;
    }
    return true;
  };

  const dynamicChangeReviewService: ChangeReviewService = {
    openReview: async (input, signal) => {
      if (isDisposed()) {
        return reviewRefused('canceled');
      }
      if (!isWorkspaceTrusted()) {
        return reviewRefused('workspace-untrusted');
      }
      const epoch = lifecycleEpoch;
      if (!(await checkPrimacy()) || isEpochInvalidated(epoch)) {
        return reviewRefused('canceled');
      }
      const svc = getSqliteCutoverCoordinator(store)?.getChangeReviewService() ?? null;
      if (svc === null) {
        return reviewRefused('review-not-found');
      }
      const res = await svc.openReview(input, signal);
      if (res.ok && res.value.state !== 'unavailable') {
        const openedId = res.value.review.reviewId;
        if (isEpochInvalidated(epoch)) {
          void svc.closeReview(openedId);
          return reviewRefused('canceled');
        }
        if (!isWorkspaceTrusted()) {
          void svc.closeReview(openedId);
          closeAllActiveReviews();
          return reviewRefused('workspace-untrusted');
        }
        if (!(await checkPrimacy())) {
          void svc.closeReview(openedId);
          closeAllActiveReviews();
          return reviewRefused('canceled');
        }
        if (isEpochInvalidated(epoch)) {
          void svc.closeReview(openedId);
          return reviewRefused('canceled');
        }
        activeReviewIds.add(openedId);
      } else if (isEpochInvalidated(epoch)) {
        return reviewRefused('canceled');
      }
      return res;
    },
    refreshReview: async (reviewId, signal) => {
      if (isDisposed()) {
        return reviewRefused('canceled');
      }
      if (!isWorkspaceTrusted()) {
        return reviewRefused('workspace-untrusted');
      }
      const epoch = lifecycleEpoch;
      if (!(await checkPrimacy()) || isEpochInvalidated(epoch)) {
        return reviewRefused('canceled');
      }
      const svc = getSqliteCutoverCoordinator(store)?.getChangeReviewService() ?? null;
      if (svc === null) {
        return reviewRefused('review-not-found');
      }
      const res = await svc.refreshReview(reviewId, signal);
      if (res.ok && res.value.state !== 'unavailable') {
        const openedId = res.value.review.reviewId;
        if (isEpochInvalidated(epoch)) {
          void svc.closeReview(openedId);
          return reviewRefused('canceled');
        }
        if (!isWorkspaceTrusted()) {
          void svc.closeReview(openedId);
          closeAllActiveReviews();
          return reviewRefused('workspace-untrusted');
        }
        if (!(await checkPrimacy())) {
          void svc.closeReview(openedId);
          closeAllActiveReviews();
          return reviewRefused('canceled');
        }
        if (isEpochInvalidated(epoch)) {
          void svc.closeReview(openedId);
          return reviewRefused('canceled');
        }
        activeReviewIds.add(openedId);
      } else if (isEpochInvalidated(epoch)) {
        return reviewRefused('canceled');
      }
      return res;
    },
    classifyReview: async (reviewId) => {
      if (isDisposed()) {
        return reviewRefused('review-not-found');
      }
      if (!isWorkspaceTrusted()) {
        return reviewRefused('workspace-untrusted');
      }
      const epoch = lifecycleEpoch;
      if (!(await checkPrimacy()) || isEpochInvalidated(epoch)) {
        return reviewRefused('review-not-found');
      }
      if (!isWorkspaceTrusted()) {
        return reviewRefused('workspace-untrusted');
      }
      const svc = getSqliteCutoverCoordinator(store)?.getChangeReviewService() ?? null;
      if (svc === null) {
        return reviewRefused('review-not-found');
      }
      const res = await svc.classifyReview(reviewId);
      if (isEpochInvalidated(epoch)) {
        return reviewRefused('review-not-found');
      }
      if (!isWorkspaceTrusted()) {
        return reviewRefused('workspace-untrusted');
      }
      if (!(await checkPrimacy()) || isEpochInvalidated(epoch)) {
        return reviewRefused('review-not-found');
      }
      if (!isWorkspaceTrusted()) {
        return reviewRefused('workspace-untrusted');
      }
      return res;
    },
    readPage: (cursor) => {
      if (isDisposed()) {
        return reviewRefused('review-not-found');
      }
      if (!isWorkspaceTrusted()) {
        return reviewRefused('workspace-untrusted');
      }
      if (deps.hasPrimacy === undefined || primacyVerifiedEpoch !== lifecycleEpoch) {
        return reviewRefused('review-not-found');
      }
      const epoch = lifecycleEpoch;
      let rawPrimacy: boolean | Promise<boolean>;
      try {
        rawPrimacy = deps.hasPrimacy();
      } catch {
        closeAllActiveReviews();
        return reviewRefused('review-not-found');
      }
      if (rawPrimacy === false) {
        closeAllActiveReviews();
        return reviewRefused('review-not-found');
      }
      if (rawPrimacy !== true) {
        const maybePromise: unknown = rawPrimacy;
        if (
          maybePromise !== null &&
          typeof maybePromise === 'object' &&
          'then' in maybePromise &&
          typeof maybePromise.then === 'function'
        ) {
          void Promise.resolve(rawPrimacy).then(
            (ok) => {
              if (ok !== true && !isEpochInvalidated(epoch)) {
                closeAllActiveReviews();
              }
            },
            () => {
              if (!isEpochInvalidated(epoch)) {
                closeAllActiveReviews();
              }
            }
          );
        } else {
          closeAllActiveReviews();
          return reviewRefused('review-not-found');
        }
      }
      if (isEpochInvalidated(epoch)) {
        return reviewRefused('review-not-found');
      }
      const svc = getSqliteCutoverCoordinator(store)?.getChangeReviewService() ?? null;
      return svc === null ? reviewRefused('review-not-found') : svc.readPage(cursor);
    },
    readContent: async (handle) => {
      if (isDisposed()) {
        return placeholderRead('unavailable');
      }
      if (!isWorkspaceTrusted()) {
        return placeholderRead('unavailable');
      }
      const epoch = lifecycleEpoch;
      if (!(await checkPrimacy()) || isEpochInvalidated(epoch)) {
        return placeholderRead('unavailable');
      }
      const svc = getSqliteCutoverCoordinator(store)?.getChangeReviewService() ?? null;
      if (svc === null) {
        return placeholderRead('unavailable');
      }
      const content = await svc.readContent(handle);
      if (
        isEpochInvalidated(epoch) ||
        !isWorkspaceTrusted() ||
        !(await checkPrimacy()) ||
        isEpochInvalidated(epoch)
      ) {
        return placeholderRead('unavailable');
      }
      return content;
    },
    closeReview: (reviewId) => {
      activeReviewIds.delete(reviewId);
      const svc = getSqliteCutoverCoordinator(store)?.getChangeReviewService() ?? null;
      return svc === null ? { closed: false } : svc.closeReview(reviewId);
    },
    entriesOf: (reviewId) => {
      const svc = getSqliteCutoverCoordinator(store)?.getChangeReviewService() ?? null;
      return svc === null ? null : svc.entriesOf(reviewId);
    },
    liveReviews: () => {
      const svc = getSqliteCutoverCoordinator(store)?.getChangeReviewService() ?? null;
      return svc === null ? 0 : svc.liveReviews();
    }
  };

  const reviewDisposable = registerChangeReviewProvider(dynamicChangeReviewService);
  const editorPort = createVscodeEditorPort();
  const persistentChangeReviewApi = createChangeReviewApi(dynamicChangeReviewService, {
    isWorkspaceTrusted
  });
  cancelPendingOpen = (): void => {
    persistentChangeReviewApi.cancelOpen({});
  };
  const trustOrPrimacySub = deps.onTrustOrPrimacyLost?.(() => {
    closeAllActiveReviews();
  });
  const disposable: vscode.Disposable = {
    dispose: () => {
      disposed = true;
      closeAllActiveReviews();
      trustOrPrimacySub?.dispose();
      reviewDisposable.dispose();
    }
  };

  let cachedReportingService: ReturnType<
    NonNullable<ReturnType<typeof getSqliteCutoverCoordinator>>['getReportingService']
  > = null;
  let cachedReportingApi: ReportingApi | null = null;

  const getReportingApi = (): ReportingApi | null => {
    const svc = getSqliteCutoverCoordinator(store)?.getReportingService() ?? null;
    if (svc === null) {
      cachedReportingService = null;
      cachedReportingApi = null;
      return null;
    }
    if (svc !== cachedReportingService || cachedReportingApi === null) {
      cachedReportingService = svc;
      cachedReportingApi = createReportingApi(svc, { isWorkspaceTrusted });
    }
    return cachedReportingApi;
  };

  const unavailablePhaseContextApi = createPhaseContextApi(() => null);

  const executionVisibility: ExecutionVisibilityApi = {
    readAttemptVisibility: (request) => {
      const coord = getSqliteCutoverCoordinator(store);
      return createExecutionVisibilityApi({
        scopeId: coord?.scopeId ?? 'unavailable',
        getSqliteStore: () => coord?.getSqliteStore() ?? null,
        getPhaseContextApi: () => (coord ? coord.getPhaseContextApi() : unavailablePhaseContextApi),
        getTelemetryHost: () => coord?.getTelemetryHost() ?? null,
        isLanesEnabled: () =>
          vscode.workspace
            .getConfiguration('schegent.lanes', vscode.Uri.file(workspaceRoot))
            .get<boolean>('enabled') === true
      }).readAttemptVisibility(request);
    },
    readRuntimePosture: () => {
      const coord = getSqliteCutoverCoordinator(store);
      return createExecutionVisibilityApi({
        scopeId: coord?.scopeId ?? 'unavailable',
        getSqliteStore: () => coord?.getSqliteStore() ?? null,
        getPhaseContextApi: () => (coord ? coord.getPhaseContextApi() : unavailablePhaseContextApi),
        getTelemetryHost: () => coord?.getTelemetryHost() ?? null,
        isLanesEnabled: () =>
          vscode.workspace
            .getConfiguration('schegent.lanes', vscode.Uri.file(workspaceRoot))
            .get<boolean>('enabled') === true
      }).readRuntimePosture();
    }
  };

  const exportReportWithDialog = createExportReportWithDialog({
    workspaceRoot,
    isDisposed,
    isWorkspaceTrusted,
    checkPrimacy,
    getLifecycleEpoch: () => lifecycleEpoch,
    isEpochInvalidated,
    getReportingApi
  });

  return {
    reportingApi: getReportingApi,
    exportReportWithDialog,
    executionVisibility,
    changeReviewApi: () => persistentChangeReviewApi,
    openReviewInEditor: (opened, entries) => openReviewInEditor(editorPort, opened, entries),
    phaseContextApi: () => getSqliteCutoverCoordinator(store)?.getPhaseContextApi() ?? null,
    closeAllActiveReviews,
    disposable
  };
}
