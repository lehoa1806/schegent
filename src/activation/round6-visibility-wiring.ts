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
import type { HostReportExportResult } from '../contracts/sidebar-ipc/reporting';
import { createChangeReviewApi, type ChangeReviewApi } from '../headless/change-review-api';
import {
  createExecutionVisibilityApi,
  type ExecutionVisibilityApi
} from '../headless/execution-visibility-api';
import type { PhaseContextApi } from '../headless/phase-context-api';
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
  readonly disposable: vscode.Disposable;
}

export function createRound6VisibilityWiring(
  deps: Round6VisibilityWiringDeps
): Round6VisibilityWiring {
  const { workspaceRoot, store } = deps;
  const isWorkspaceTrusted = (): boolean => vscode.workspace.isTrusted;

  const dynamicChangeReviewService: ChangeReviewService = {
    openReview: (input, signal) => {
      const svc = getSqliteCutoverCoordinator(store)?.getChangeReviewService() ?? null;
      return svc === null
        ? Promise.resolve(reviewRefused('review-not-found'))
        : svc.openReview(input, signal);
    },
    refreshReview: (reviewId, signal) => {
      const svc = getSqliteCutoverCoordinator(store)?.getChangeReviewService() ?? null;
      return svc === null
        ? Promise.resolve(reviewRefused('review-not-found'))
        : svc.refreshReview(reviewId, signal);
    },
    classifyReview: (reviewId) => {
      const svc = getSqliteCutoverCoordinator(store)?.getChangeReviewService() ?? null;
      return svc === null
        ? Promise.resolve(reviewRefused('review-not-found'))
        : svc.classifyReview(reviewId);
    },
    readPage: (cursor) => {
      const svc = getSqliteCutoverCoordinator(store)?.getChangeReviewService() ?? null;
      return svc === null ? reviewRefused('review-not-found') : svc.readPage(cursor);
    },
    readContent: (handle) => {
      if (!isWorkspaceTrusted()) {
        return Promise.resolve(placeholderRead('unavailable'));
      }
      const svc = getSqliteCutoverCoordinator(store)?.getChangeReviewService() ?? null;
      return svc === null
        ? Promise.resolve(placeholderRead('unavailable'))
        : svc.readContent(handle);
    },
    closeReview: (reviewId) => {
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

  const executionVisibility: ExecutionVisibilityApi = {
    readAttemptVisibility: (request) => {
      const coord = getSqliteCutoverCoordinator(store);
      return createExecutionVisibilityApi({
        scopeId: coord?.scopeId ?? 'unavailable',
        getSqliteStore: () => coord?.getSqliteStore() ?? null,
        getPhaseContextApi: () => {
          if (!coord) {
            return {
              inspectHandoff: () => ({
                ok: false,
                failure: 'storage-unavailable',
                detail: 'unavailable'
              }),
              inspectReviewLoop: () => null,
              listRunHandoffs: () => [],
              listRunReviewLoops: () => [],
              editHandoff: () => ({
                ok: false,
                failure: 'storage-unavailable',
                detail: 'unavailable'
              }),
              approveHandoff: () => ({
                ok: false,
                failure: 'storage-unavailable',
                detail: 'unavailable'
              })
            };
          }
          return coord.getPhaseContextApi();
        },
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
        getPhaseContextApi: () => {
          if (!coord) {
            return {
              inspectHandoff: () => ({
                ok: false,
                failure: 'storage-unavailable',
                detail: 'unavailable'
              }),
              inspectReviewLoop: () => null,
              listRunHandoffs: () => [],
              listRunReviewLoops: () => [],
              editHandoff: () => ({
                ok: false,
                failure: 'storage-unavailable',
                detail: 'unavailable'
              }),
              approveHandoff: () => ({
                ok: false,
                failure: 'storage-unavailable',
                detail: 'unavailable'
              })
            };
          }
          return coord.getPhaseContextApi();
        },
        getTelemetryHost: () => coord?.getTelemetryHost() ?? null,
        isLanesEnabled: () =>
          vscode.workspace
            .getConfiguration('schegent.lanes', vscode.Uri.file(workspaceRoot))
            .get<boolean>('enabled') === true
      }).readRuntimePosture();
    }
  };

  const exportReportWithDialog: Round6VisibilityWiring['exportReportWithDialog'] = async ({
    reportId,
    format
  }) => {
    const api = getReportingApi();
    if (api === null) {
      return {
        outcome: 'completed',
        result: { ok: false, outcome: 'refused', reason: 'accounting-unavailable' }
      };
    }
    const ext = format === 'csv' ? 'csv' : 'json';
    const suggestedName = `schegent-report-${reportId.slice(0, 12)}.${ext}`;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(workspaceRoot, suggestedName)),
      filters: format === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] },
      saveLabel: 'Export report'
    });
    if (!target) {
      return { outcome: 'dialog-canceled' };
    }
    const result = await api.exportReport({
      reportId,
      format,
      destination: { scheme: target.scheme, fsPath: target.fsPath },
      overwrite: true
    });
    return { outcome: 'completed', result };
  };

  return {
    reportingApi: getReportingApi,
    exportReportWithDialog,
    executionVisibility,
    changeReviewApi: () => persistentChangeReviewApi,
    openReviewInEditor: (opened, entries) => openReviewInEditor(editorPort, opened, entries),
    phaseContextApi: () => getSqliteCutoverCoordinator(store)?.getPhaseContextApi() ?? null,
    disposable: reviewDisposable
  };
}
