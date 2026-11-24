/**
 * FR-R6-F11, F12, F10, F14, F15 (R7-17-01, R7-17-03, R7-17-06) — Svelte 5 UI, keyboard/ARIA
 * semantics, non-numeric availability phrasing, lease retention, stale-response guards,
 * hide/reveal resynchronisation, inert-text repository filename rendering, primacy propagation,
 * and telemetry refusal disclosure tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';

import { buildIdleSnapshot } from '../../../../src/ui/sidebar/snapshot';
import type { SavedReportView } from '../../../../src/contracts/reporting/report-manifest';
import type { ReportView, RunOutcome } from '../../../../src/contracts/reporting/report-query';
import type {
  AttemptRow,
  Distribution,
  GroupRow,
  ReportPage,
  RootDrillDown,
  RootRow,
  UsageRow
} from '../../../../src/contracts/reporting/report-rows';
import type { ReviewDescriptor, ReviewOpened } from '../../../../src/contracts/change-review';
import type { HandoffExplanation } from '../../../../src/contracts/phase-context/context-manifest';
import ChangeReviewPanel from '../ChangeReviewPanel.svelte';
import ExecutionVisibilityPanel from '../ExecutionVisibilityPanel.svelte';
import HistoryRunDetail from '../HistoryRunDetail.svelte';
import HistoricalReportsPanel from '../MetricsDashboard/HistoricalReportsPanel.svelte';
import ReportDrillDownPanel from '../MetricsDashboard/ReportDrillDownPanel.svelte';
import ReportRowsTable from '../MetricsDashboard/ReportRowsTable.svelte';
import TelemetryRuntimeHealthPanel from '../TelemetryRuntimeHealthPanel.svelte';
import RunDetailTier from '../drilldown/RunDetailTier.svelte';
import { isMenuItemOff } from '../sg/__tests__/menu-item-state';
import { resetHostTransport, setHostTransport } from '../../lib/host-transport';
import type { HistoryRow } from '../../lib/history-rows';
import {
  STATE_SNAPSHOT,
  type DecidePhaseHandoffRequest,
  type DecidePhaseHandoffResponse,
  type ExecutionAttemptVisibility,
  type ExecutionLaneCandidateVisibility,
  type MutateReportRequest,
  type MutateReportResponse,
  type OpenChangeReviewRequest,
  type OpenChangeReviewResponse,
  type ReadExecutionVisibilityRequest,
  type ReadExecutionVisibilityResponse,
  type ReadReportRequest,
  type ReadReportResponse,
  type RuntimePostureVisibility
} from '../../lib/messages';
import type { ReportCallEnvelope } from '../../lib/reporting-ipc';
import type { VisibilityCallEnvelope } from '../../lib/execution-visibility-ipc';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import type { QueueItem, WorkflowSnapshot } from '../../lib/snapshot-types';
import { buildInFlightRun, buildQueueRuntime } from '../../lib/__tests__/queue-runtime-fixture';

const mockReadReport =
  vi.fn<(req: ReadReportRequest) => Promise<ReportCallEnvelope<ReadReportResponse>>>();
const mockMutateReport =
  vi.fn<(req: MutateReportRequest) => Promise<ReportCallEnvelope<MutateReportResponse>>>();
const mockExecVisibility =
  vi.fn<
    (
      req: ReadExecutionVisibilityRequest
    ) => Promise<VisibilityCallEnvelope<ReadExecutionVisibilityResponse>>
  >();
const mockChangeReview =
  vi.fn<
    (req: OpenChangeReviewRequest) => Promise<VisibilityCallEnvelope<OpenChangeReviewResponse>>
  >();
const mockDecideHandoff =
  vi.fn<
    (
      req: DecidePhaseHandoffRequest
    ) => Promise<VisibilityCallEnvelope<DecidePhaseHandoffResponse>>
  >();

vi.mock('../../lib/reporting-ipc', () => ({
  requestReadReport: (req: ReadReportRequest) => mockReadReport(req),
  requestMutateReport: (req: MutateReportRequest) => mockMutateReport(req)
}));

vi.mock('../../lib/execution-visibility-ipc', () => ({
  requestExecutionVisibility: (req: ReadExecutionVisibilityRequest) => mockExecVisibility(req),
  requestChangeReview: (req: OpenChangeReviewRequest) => mockChangeReview(req),
  requestDecidePhaseHandoff: (req: DecidePhaseHandoffRequest) => mockDecideHandoff(req)
}));

vi.mock('../../lib/metrics-ipc', () => ({
  readRunSummary: vi.fn(async () => ({ outcome: 'read' as const, summary: null }))
}));

vi.mock('../../lib/history-evidence-ipc', () => ({
  resolveAuditPointer: vi.fn(async (runId: string) => ({
    outcome: 'no-evidence-recorded' as const,
    runId
  }))
}));

vi.mock('../../lib/phase-log-ipc', () => ({
  readPhaseLog: vi.fn(async () => ({
    outcome: 'no-log-file' as const,
    entries: [],
    hasMore: false,
    nextCursor: null
  })),
  startPhaseLogTail: vi.fn(),
  stopPhaseLogTail: vi.fn(),
  subscribePhaseLogBatch: () => () => {},
  ackPhaseLogTail: vi.fn(),
  openVerboseSetting: vi.fn()
}));

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'round6-test-corr' })),
  onHostMessage: () => () => {},
  getWebviewState: () => undefined,
  setWebviewState: () => {}
}));

vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true)
}));

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

function restoreDocumentVisibility(): void {
  if (originalVisibilityDescriptor !== undefined) {
    Object.defineProperty(document, 'visibilityState', originalVisibilityDescriptor);
  } else {
    delete (document as unknown as Record<string, unknown>).visibilityState;
  }
}

function makeSnapshot(overrides: { isPrimary?: boolean; producedAt?: string } = {}): WorkflowSnapshot {
  return buildIdleSnapshot({
    isPrimary: overrides.isPrimary ?? true,
    producedAt: overrides.producedAt ?? '2026-11-11T00:00:00.000Z'
  }) as unknown as WorkflowSnapshot;
}

function applyFullSnapshot(revision: number, isPrimary = true): void {
  snapshotStore.apply({
    type: STATE_SNAPSHOT,
    payload: makeSnapshot({
      isPrimary,
      producedAt: `2026-11-11T00:00:${String(revision).padStart(2, '0')}.000Z`
    }),
    sync: { mode: 'full', revision }
  });
  flushSync();
}

function triggerSnapshotResync(nextRevision: number, isPrimary = true): void {
  const prevResync = snapshotStore.resyncCount;
  // A routine delta whose baseRevision does not match lastRevision forces resync-needed and
  // increments snapshotStore.resyncCount; the subsequent full snapshot delivers the resynced state.
  snapshotStore.apply({
    type: STATE_SNAPSHOT,
    payload: makeSnapshot({ isPrimary }),
    sync: {
      mode: 'routine',
      revision: nextRevision,
      baseRevision: nextRevision - 1,
      omittedSlices: []
    }
  });
  expect(snapshotStore.resyncCount).toBe(prevResync + 1);
  applyFullSnapshot(nextRevision + 1, isPrimary);
}

afterEach(() => {
  cleanup();
  restoreDocumentVisibility();
  snapshotStore.resetSyncState();
  resetHostTransport();
});

beforeEach(() => {
  mockReadReport.mockReset();
  mockMutateReport.mockReset();
  mockExecVisibility.mockReset();
  mockChangeReview.mockReset();
  mockDecideHandoff.mockReset();
  snapshotStore.resetSyncState();
  resetHostTransport();
  setHostTransport({
    postMessage() {},
    onMessage() {
      return () => {};
    },
    getState() {
      return undefined;
    },
    setState() {}
  });
});

function makeOutcomes(overrides: Partial<Record<RunOutcome, number>> = {}): Readonly<Record<RunOutcome, number>> {
  return {
    queued: 0,
    running: 0,
    paused: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    aborted: 0,
    ...overrides
  };
}

function makeDistribution(overrides: Partial<Distribution> = {}): Distribution {
  return {
    unit: 'ms',
    basis: 'root-wall-clock',
    samples: 2,
    known: 2,
    missing: 0,
    p50: 1200,
    p90: 2400,
    p99: 3000,
    method: 'nearest-rank',
    ...overrides
  };
}

function makeSavedReport(reportId = 'rep-saved-1'): SavedReportView {
  const query = {
    view: 'execution-summary' as const,
    range: { startMs: 1_000, endMs: 2_000 },
    timezone: 'UTC',
    filters: {},
    groupBy: [] as const,
    sort: 'root-created-desc' as const,
    pageSize: 50
  };
  return {
    reportId,
    rerunOf: null,
    view: 'execution-summary',
    query,
    manifestSha256: 'b'.repeat(64),
    createdUtc: '2026-11-11T00:00:00.000Z',
    manifest: {
      schema: 'schegent.report-manifest',
      manifestVersion: 1,
      reportId,
      exportId: null,
      rerunOf: null,
      view: 'execution-summary',
      query,
      queryDigest: 'c'.repeat(64),
      generatedUtc: '2026-11-11T00:00:00.000Z',
      sourceCutoffUtc: '2026-11-11T00:00:00.000Z',
      timezone: 'UTC',
      timeBasis: 'root-created',
      versions: {
        source: 'sqlite-store/7',
        schema: 1,
        calculation: 1,
        accountingPolicy: null,
        accountingCalculation: null
      },
      accountingRevision: null,
      rowCount: 1,
      units: ['ms'],
      privacyProfile: 'metadata-only',
      retention: 'outside-managed-retention',
      populationDigest: 'a'.repeat(64),
      coverage: {
        roots: 1,
        attempts: 1,
        unknownDurations: 1,
        unattributed: null,
        gaps: []
      },
      omissions: []
    }
  };
}

function makeRootPage(overrides: Partial<ReportPage> = {}): ReportPage {
  return {
    reportId: 'rep-live-1',
    outcome: 'complete',
    view: 'execution-summary',
    sourceCutoffUtc: '2026-11-11T01:00:00.000Z',
    timeBasis: 'root-created',
    accountingRevision: null,
    calculationVersion: 1,
    rowCount: 1,
    coverage: { roots: 1, attempts: 1, unknownDurations: 0 },
    omissions: [],
    rows: [
      {
        kind: 'root',
        rootId: 'run-alpha',
        workflowId: 'wf-deploy',
        frozenDefinitionId: 'fc-1',
        outcome: 'succeeded',
        createdUtc: '2026-11-11T00:30:00.000Z',
        durationMs: 1_200,
        attempts: 1
      }
    ],
    cursor: null,
    ...overrides
  };
}

function makeDrillDown(overrides: Partial<RootDrillDown> = {}): RootDrillDown {
  return {
    reportId: 'rep-live-1',
    root: {
      kind: 'root',
      rootId: 'run-alpha',
      workflowId: 'wf-deploy',
      frozenDefinitionId: 'fc-1',
      outcome: 'succeeded',
      createdUtc: '2026-11-11T00:30:00.000Z',
      durationMs: null,
      attempts: 1
    },
    frozenDefinitionId: 'fc-1',
    outcomeLineage: [{ source: 'run-store', outcome: 'succeeded' }],
    attempts: [
      {
        kind: 'attempt',
        attemptId: 'att-1',
        rootId: 'run-alpha',
        stepIndex: 0,
        phaseId: 'implement',
        attemptNumber: 1,
        status: 'succeeded',
        exitCode: 0,
        startedUtc: '2026-11-11T00:30:00.000Z',
        completedUtc: null,
        durationMs: null
      }
    ],
    usage: null,
    omissions: [],
    evidenceRefs: [],
    acpAttributions: [],
    handoffSummaries: [],
    reviewSummaries: [],
    ...overrides
  };
}

function makeLane(
  overrides: Partial<ExecutionLaneCandidateVisibility> = {}
): ExecutionLaneCandidateVisibility {
  return {
    mode: 'isolated-lane',
    laneId: '1'.repeat(32),
    laneState: 'completed',
    candidateId: 'cand-1',
    integrationRequestId: '4'.repeat(32),
    integrationState: 'awaiting-review',
    targetRef: 'refs/heads/main',
    comparisonRevision: `cr1-${'e'.repeat(64)}`,
    ...overrides
  };
}

function makeDescriptor(overrides: Partial<ReviewDescriptor> = {}): ReviewDescriptor {
  return {
    reviewId: 'rev_123456789012345678',
    requestId: '4'.repeat(32),
    candidateId: 'cand-1',
    candidateCommit: 'c'.repeat(40),
    targetRef: 'refs/heads/main',
    targetCommit: 'a'.repeat(40),
    profileRevision: 1,
    profileDigest: 'd'.repeat(64),
    comparisonRevision: `cr1-${'e'.repeat(64)}`,
    total: 1,
    loaded: 1,
    truncated: false,
    state: 'current',
    reason: null,
    approval: { eligible: true, reason: null },
    landing: { eligible: false, reason: 'receipt-missing' },
    createdAt: '2026-11-11T00:00:00.000Z',
    ...overrides
  };
}

function makeOpenedReview(
  descriptorOverrides: Partial<ReviewDescriptor> = {},
  filePath = 'src/app.ts',
  nextCursor: string | null = null
): ReviewOpened {
  const review = makeDescriptor(descriptorOverrides);
  return {
    state: review.state,
    reason: review.reason,
    review,
    firstPage: {
      reviewId: review.reviewId,
      entries: [
        {
          index: 0,
          kind: 'modified',
          oldPath: filePath,
          newPath: filePath,
          binary: false,
          oldHandle: 'h-old',
          newHandle: 'h-new',
          similarity: null
        }
      ],
      nextCursor
    }
  };
}

function makeWaitingHandoff(handoffId = 'ho-99', rootExecutionId = 'run-99'): HandoffExplanation {
  return {
    handoffId,
    recordVersion: 1,
    identity: {
      workspaceId: 'ws-1',
      rootExecutionId,
      sourceInvocationId: 'frame-99',
      targetNodePath: 'verify',
      targetOccurrenceId: 'occ-1',
      inputEnvelopeRevision: 1,
      sourceAttempts: []
    },
    revisions: [
      {
        revision: 1,
        manifestDigest: 'a'.repeat(64),
        rendererVersion: 1,
        renderedDigest: 'b'.repeat(64),
        renderedBytes: 128,
        state: 'waiting-approval'
      }
    ],
    revision: 1,
    origin: 'selected',
    approval: 'manual',
    session: 'fresh',
    policyDigest: 'c'.repeat(64),
    cutoffSequence: 1,
    renderedBytesMax: 32 * 1024,
    sources: [],
    omissions: [],
    omissionsUnlisted: 0,
    approvals: [],
    dispatches: []
  };
}

function makeVisibilityDetail(
  overrides: Partial<ExecutionAttemptVisibility> = {}
): ExecutionAttemptVisibility {
  return {
    available: true,
    unavailableReason: null,
    rootExecutionId: 'run-99',
    hierarchy: {
      rootStatus: 'paused',
      workflowId: 'wf-main',
      frozenDefinitionId: 'fc-99',
      invocationCount: 2,
      attemptCount: 2,
      dataQuality: 'partial',
      attempts: []
    },
    evidence: [],
    liveLog: { streamState: 'partial', segmentCount: 3, gapCount: 1 },
    recovery: { posture: 'uncertain', reasonCode: 'restart-before-ack' },
    acp: {
      runtimeState: 'awaiting-permission',
      profileId: 'claude-acp',
      backendKind: 'claude',
      modelId: 'claude-sonnet-4-6',
      liveObservations: 5,
      pendingPermissions: 1
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
    reviewLoops: [],
    ...overrides
  };
}

function makeRuntimePosture(
  overrides: {
    available?: boolean;
    lanes?: Partial<RuntimePostureVisibility['lanes']>;
    telemetry?: Partial<RuntimePostureVisibility['telemetry']>;
  } = {}
): RuntimePostureVisibility {
  return {
    available: overrides.available ?? true,
    lanes: {
      enabled: true,
      liveLaneCap: 4,
      activeLanes: 2,
      totalLanes: 5,
      pendingIntegrations: 1,
      ...overrides.lanes
    },
    telemetry: {
      enabled: true,
      stateKind: 'healthy',
      reasonCode: null,
      protocol: 'otlp-http-json',
      contentPolicyMode: 'metadata-only',
      pendingCopyCount: 0,
      exportedCopyCount: 14,
      droppedCopyCount: 0,
      spooledBatchCount: 1,
      spooledBytes: 2048,
      spoolCeilingBytes: 10 * 1024 * 1024,
      activeSeriesCount: 12,
      seriesCap: 256,
      overflowCount: 0,
      previewSummary: 'Metadata-only OTLP export active.',
      ...overrides.telemetry
    }
  };
}

function makeHistoryRow(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return Object.freeze({
    runId: 'run-hist-1',
    queueId: 'alpha',
    queueName: 'Alpha',
    source: 'recorded',
    status: 'completed',
    definitionId: 'pipe-deploy',
    catalogVersion: { kind: 'pipeline', id: 'pipe-deploy', versionId: 'ver-3' },
    origin: { kind: 'standalone' },
    descriptionPreview: 'Deploy release candidate',
    descriptionLength: 24,
    orderingKey: '2026-11-11T00:01:00.000Z',
    startedAt: '2026-11-11T00:00:00.000Z',
    completedAt: '2026-11-11T00:01:00.000Z',
    durationMs: 60_000,
    ...overrides
  }) as HistoryRow;
}

/** The reads the reports panel makes as it mounts: no saved reports, and a page of one row. */
function answerMountReads(req: ReadReportRequest): ReportCallEnvelope<ReadReportResponse> {
  if (req.op === 'listSaved') {
    return {
      boundaryRefusal: null,
      response: { op: 'listSaved', result: { ok: true, value: { items: [], cursor: null } } }
    };
  }
  if (req.op === 'run') {
    return {
      boundaryRefusal: null,
      response: {
        op: 'run',
        result: {
          ok: true,
          value: makeRootPage()
        }
      }
    };
  }
  return {
    boundaryRefusal: null,
    response: { op: 'close', result: { ok: true, value: { released: true } } }
  };
}

describe('HistoricalReportsPanel, ReportRowsTable & ReportDrillDownPanel (FR-R6-F11 / R7-17-01)', () => {
  it('renders cutoff-pinned rows with aria-sort, non-numeric unknown duration phrasing, drill-down metadata, and saved report confirmation', async () => {
    mockReadReport.mockImplementation(
      async (req: ReadReportRequest): Promise<ReportCallEnvelope<ReadReportResponse>> => {
        if (req.op === 'listSaved') {
          return {
            boundaryRefusal: null,
            response: {
              op: 'listSaved',
              result: {
                ok: true,
                value: {
                  items: [makeSavedReport('rep-saved-1')],
                  cursor: null
                }
              }
            }
          };
        }
        if (req.op === 'run') {
          return {
            boundaryRefusal: null,
            response: {
              op: 'run',
              result: {
                ok: true,
                value: makeRootPage({
                  coverage: { roots: 1, attempts: 2, unknownDurations: 1 },
                  omissions: [{ what: 'accounting', reason: 'accounting-unavailable' }],
                  rows: [
                    {
                      kind: 'root',
                      rootId: 'run-alpha',
                      workflowId: 'wf-deploy',
                      frozenDefinitionId: 'fc-1',
                      outcome: 'succeeded',
                      createdUtc: '2026-11-11T00:30:00.000Z',
                      durationMs: null,
                      attempts: 2
                    }
                  ]
                })
              }
            }
          };
        }
        if (req.op === 'drillDown') {
          return {
            boundaryRefusal: null,
            response: {
              op: 'drillDown',
              result: {
                ok: true,
                value: makeDrillDown({
                  evidenceRefs: [
                    {
                      artifactId: 'art-1',
                      rootId: 'run-alpha',
                      attemptId: 'att-1',
                      storeKind: 'diagnostic',
                      availability: 'present',
                      byteSize: 256,
                      retentionClass: 'transcripts-diagnostics-checkpoints-audit-catalog'
                    }
                  ],
                  acpAttributions: [
                    {
                      attemptId: 'att-1',
                      rootId: 'run-alpha',
                      backendKind: 'claude',
                      modelId: 'claude-sonnet-4-6',
                      profileId: 'claude-acp',
                      laneId: 'lane-1',
                      liveObservations: 4
                    }
                  ]
                })
              }
            }
          };
        }
        return {
          boundaryRefusal: null,
          response: { op: 'close', result: { ok: true, value: { released: true } } }
        };
      }
    );

    mockMutateReport.mockResolvedValue({
      boundaryRefusal: null,
      response: { op: 'deleteSaved', result: { ok: true, value: { deleted: true } } }
    });

    const { findByTestId, getByTestId, container } = render(HistoricalReportsPanel);

    const table = await findByTestId('report-rows-table');
    const firstHeader = table.querySelector('th');
    expect(firstHeader?.getAttribute('aria-sort')).toBe('descending');
    expect(getByTestId('report-status-notice').getAttribute('aria-live')).toBe('polite');

    // Unknown duration renders digit-free availabilityPhrase ('Unknown: not measured'), never '0ms'
    expect(table.textContent).toContain('Unknown: not measured');
    expect(getByTestId('report-coverage-strip').textContent).toContain('Unavailable: cannot be shown');

    // Open drill-down and verify ACP live attributions + evidence metadata
    await fireEvent.click(getByTestId('report-drilldown-open-run-alpha'));
    const drillPanel = await findByTestId('report-drilldown-panel');
    expect(drillPanel.textContent).toContain('claude-acp:4 live');
    expect(drillPanel.textContent).toContain('diagnostic:present');

    // Close drill-down restores focus
    await fireEvent.click(getByTestId('report-drilldown-close'));
    await tick();

    // Saved report delete requires explicit two-step confirmation
    await fireEvent.click(getByTestId('saved-delete-rep-saved-1'));
    const confirmBtn = await findByTestId('saved-confirm-delete-rep-saved-1');
    await fireEvent.click(confirmBtn);
    expect(mockMutateReport).toHaveBeenCalledWith({
      op: 'deleteSaved',
      reportId: 'rep-saved-1',
      confirmed: true
    });
    expect(container.querySelectorAll('img').length).toBe(0);
  });

  // The export items, not the menu's button, wait out an export, and they wait in
  // `aria-disabled`: a keyboard user who opens the menu meanwhile can still reach
  // them, and the menu refuses a second export (decision 5 of the port review,
  // 2026-11-14).
  it('holds both export items off, and in reach, while an export is out', async () => {
    mockReadReport.mockImplementation((req) => Promise.resolve(answerMountReads(req)));
    let finishExport: (envelope: ReportCallEnvelope<MutateReportResponse>) => void = () => {};
    mockMutateReport.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishExport = resolve;
        })
    );

    const { findByTestId, getByTestId } = render(HistoricalReportsPanel);
    await findByTestId('report-rows-table');
    const csv = getByTestId('report-export-csv');
    const json = getByTestId('report-export-json');
    expect(csv.textContent.trim()).toBe('Export CSV…');
    expect(json.textContent.trim()).toBe('Export JSON…');
    expect(csv.querySelector('use')?.getAttribute('href')).toBe('#i-export');
    expect(json.querySelector('use')?.getAttribute('href')).toBe('#i-export');
    expect([isMenuItemOff(csv), isMenuItemOff(json)]).toEqual([false, false]);

    await fireEvent.click(csv);
    expect(mockMutateReport).toHaveBeenCalledTimes(1);
    expect([isMenuItemOff(csv), isMenuItemOff(json)]).toEqual([true, true]);

    await fireEvent.click(json);
    expect(mockMutateReport).toHaveBeenCalledTimes(1);

    finishExport({
      boundaryRefusal: null,
      response: { op: 'export', exportOutcome: { outcome: 'dialog-canceled' } }
    });
    await vi.waitFor(() => {
      expect(isMenuItemOff(csv)).toBe(false);
    });
    expect(isMenuItemOff(json)).toBe(false);
    expect(getByTestId('report-status-notice').textContent).toContain('Export canceled');
  });

  // Finding 2 of the webview port review: the availability phrase became a
  // sentence of its own, and the heading pasted it in mid-sentence, so it read
  // "(Unavailable: cannot be shown never shown as zero)".
  it('heads the stated omissions with one sentence, the phrase quoted in it', () => {
    const { getByTestId } = render(ReportDrillDownPanel, {
      drillDown: {
        reportId: 'rep-live-1',
        root: {
          kind: 'root',
          rootId: 'run-alpha',
          workflowId: 'wf-deploy',
          frozenDefinitionId: null,
          outcome: 'succeeded',
          createdUtc: '2026-11-11T00:30:00.000Z',
          durationMs: null,
          attempts: 0
        },
        attempts: [],
        frozenDefinitionId: null,
        outcomeLineage: [],
        usage: null,
        omissions: [{ what: 'accounting', reason: 'accounting-unavailable' }]
      },
      onClose: () => undefined
    });
    const omissions = getByTestId('report-drilldown-omissions');
    expect(omissions.querySelector('strong')?.textContent).toBe(
      'Stated omissions (each shown as \u201cUnavailable: cannot be shown\u201d, never as zero):'
    );
    expect(omissions.querySelector('li')?.textContent).toBe('accounting \u2014 accounting-unavailable');
  });

  it('switches across all 6 reporting views and renders all 4 row shapes (root, attempt, group, usage)', async () => {
    const pagesByView: Record<ReportView, ReportPage> = {
      'execution-summary': makeRootPage({
        reportId: 'rep-view-exec',
        view: 'execution-summary'
      }),
      'attempt-detail': makeRootPage({
        reportId: 'rep-view-attempt',
        view: 'attempt-detail',
        rows: [
          {
            kind: 'attempt',
            attemptId: 'att-42',
            rootId: 'run-alpha',
            attemptNumber: 2,
            stepIndex: 1,
            phaseId: null,
            status: 'timed_out',
            exitCode: 124,
            startedUtc: '2026-11-11T00:30:00.000Z',
            completedUtc: '2026-11-11T00:31:00.000Z',
            durationMs: null
          }
        ]
      }),
      'failure-cause': makeRootPage({
        reportId: 'rep-view-failure',
        view: 'failure-cause',
        rows: [
          {
            kind: 'group',
            key: { failureCause: 'backend-timeout' },
            roots: 3,
            attempts: 5,
            outcomes: makeOutcomes({ failed: 3 }),
            rootDuration: makeDistribution({ basis: 'root-wall-clock', p50: 1500, p90: 2500, p99: 'unavailable' })
          }
        ]
      }),
      'workflow-revision': makeRootPage({
        reportId: 'rep-view-wfrev',
        view: 'workflow-revision',
        rows: [
          {
            kind: 'group',
            key: { workflowId: 'wf-deploy', frozenDefinitionId: 'fc-v2' },
            roots: 4,
            attempts: 6,
            outcomes: makeOutcomes({ succeeded: 4 }),
            rootDuration: makeDistribution({ basis: 'root-wall-clock', p50: 4000, p90: 6000, p99: 7000 }),
            attemptDuration: makeDistribution({ basis: 'attempt-own', p50: 900, p90: 1300, p99: 1500 })
          }
        ]
      }),
      'time-series': makeRootPage({
        reportId: 'rep-view-timeseries',
        view: 'time-series',
        rows: [
          {
            kind: 'group',
            key: { localDay: '2026-11-11' },
            roots: 7,
            attempts: 9,
            outcomes: makeOutcomes({ succeeded: 6, failed: 1 }),
            rootDuration: makeDistribution({ basis: 'root-wall-clock', p50: 2000, p90: 4000, p99: 5000 }),
            attemptDuration: makeDistribution({ basis: 'attempt-own', p50: 800, p90: 1200, p99: 1400 })
          }
        ]
      }),
      usage: makeRootPage({
        reportId: 'rep-view-usage',
        view: 'usage',
        timeBasis: 'accounting-event',
        accountingRevision: 12,
        rows: [
          {
            kind: 'usage',
            key: { backend: 'claude', model: 'claude-sonnet-4-6' },
            roots: 2,
            attempts: 3,
            invocations: 'not-recorded',
            measures: [
              {
                measure: 'cost',
                unit: 'USD',
                total: '1.500000',
                reportedTotal: '1.000000',
                estimatedTotal: '0.500000',
                completeness: 'partial',
                coverage: { known: 2, denominator: 3 }
              }
            ]
          }
        ]
      })
    };

    const requestedViews: ReportView[] = [];
    mockReadReport.mockImplementation(async (req) => {
      if (req.op === 'listSaved') {
        return {
          boundaryRefusal: null,
          response: { op: 'listSaved', result: { ok: true, value: { items: [], cursor: null } } }
        };
      }
      if (req.op === 'run') {
        const view = (req.query as { view: ReportView }).view;
        requestedViews.push(view);
        return {
          boundaryRefusal: null,
          response: { op: 'run', result: { ok: true, value: pagesByView[view] } }
        };
      }
      return {
        boundaryRefusal: null,
        response: { op: 'close', result: { ok: true, value: { released: true } } }
      };
    });

    const { findByTestId, getByTestId, queryByTestId, container } = render(HistoricalReportsPanel);

    // 1. execution-summary -> root row
    const initialTable = await findByTestId('report-rows-table');
    expect(container.querySelector('#report-results-heading')?.textContent).toBe('Run summary');
    expect(initialTable.textContent).toContain('run-alpha');
    expect(getByTestId('report-filter-workflow')).toBeTruthy();
    expect(queryByTestId('report-filter-backend')).toBeNull();

    const viewSelect = getByTestId('report-view-select') as HTMLSelectElement;
    const runBtn = getByTestId('report-run-button');

    // 2. attempt-detail -> attempt row
    await fireEvent.change(viewSelect, { target: { value: 'attempt-detail' } });
    await tick();
    await fireEvent.click(runBtn);
    await vi.waitFor(() => {
      expect(container.querySelector('#report-results-heading')?.textContent).toBe('Attempts');
    });
    const attemptTable = getByTestId('report-rows-table');
    expect(attemptTable.textContent).toContain('att-42');
    expect(attemptTable.textContent).toContain('Attempt 2');
    expect(attemptTable.textContent).toContain('Not recorded');
    expect(attemptTable.textContent).toContain('Timed out');
    expect(attemptTable.textContent).toContain('Unknown: not measured');

    // 3. failure-cause -> group row
    await fireEvent.change(viewSelect, { target: { value: 'failure-cause' } });
    await tick();
    await fireEvent.click(runBtn);
    await vi.waitFor(() => {
      expect(container.querySelector('#report-results-heading')?.textContent).toBe('Failure causes');
    });
    const failureTable = getByTestId('report-rows-table');
    expect(failureTable.textContent).toContain('failureCause=backend-timeout');
    expect(failureTable.textContent).toContain('root-wall-clock: p50 1500ms');
    expect(failureTable.textContent).toContain('Unavailable: cannot be shown');

    // 4. workflow-revision -> group row with attemptDuration
    await fireEvent.change(viewSelect, { target: { value: 'workflow-revision' } });
    await tick();
    await fireEvent.click(runBtn);
    await vi.waitFor(() => {
      expect(container.querySelector('#report-results-heading')?.textContent).toBe('Workflow versions');
    });
    const wfRevTable = getByTestId('report-rows-table');
    expect(wfRevTable.textContent).toContain('workflowId=wf-deploy, frozenDefinitionId=fc-v2');
    expect(wfRevTable.textContent).toContain('root-wall-clock: p50 4000ms');
    expect(wfRevTable.textContent).toContain('attempt-own: p50 900ms');

    // 5. time-series -> group row with attemptDuration
    await fireEvent.change(viewSelect, { target: { value: 'time-series' } });
    await tick();
    await fireEvent.click(runBtn);
    await vi.waitFor(() => {
      expect(container.querySelector('#report-results-heading')?.textContent).toBe('Daily totals');
    });
    const tsTable = getByTestId('report-rows-table');
    expect(tsTable.textContent).toContain('localDay=2026-11-11');
    expect(tsTable.textContent).toContain('attempt-own: p50 800ms');

    // 6. usage -> usage row and backend filter swap
    await fireEvent.change(viewSelect, { target: { value: 'usage' } });
    await tick();
    expect(getByTestId('report-filter-backend')).toBeTruthy();
    expect(queryByTestId('report-filter-workflow')).toBeNull();
    await fireEvent.click(runBtn);
    await vi.waitFor(() => {
      expect(container.querySelector('#report-results-heading')?.textContent).toBe('Usage and cost');
    });
    const usageTable = getByTestId('report-rows-table');
    expect(usageTable.textContent).toContain('backend=claude, model=claude-sonnet-4-6');
    expect(usageTable.textContent).toContain('Not recorded');
    expect(usageTable.textContent).toContain('cost: 1.500000 USD [reported 1.000000, estimated 0.500000] (partial)');

    expect(requestedViews).toEqual([
      'execution-summary',
      'attempt-detail',
      'failure-cause',
      'workflow-revision',
      'time-series',
      'usage'
    ]);
  });

  it('ReportRowsTable moves aria-sort to the sorted column and renders non-numeric availability, duration bases, invocations, and cost lanes', async () => {
    const rootRows: readonly RootRow[] = [
      {
        kind: 'root',
        rootId: 'run-1',
        workflowId: 'wf-1',
        frozenDefinitionId: 'fc-1',
        outcome: 'succeeded',
        createdUtc: '2026-11-11T00:00:00.000Z',
        durationMs: 2500,
        attempts: 1
      }
    ];
    const readSortCols = (el: HTMLElement) =>
      Array.from(el.querySelectorAll('thead th')).map((th) => th.getAttribute('aria-sort'));

    // Root row sorts: aria-sort moves from Run (0) -> Status (2) -> Duration (4)
    const { getByTestId, rerender } = render(ReportRowsTable, {
      props: { rows: rootRows, sort: 'root-created-desc', onOpenRoot: () => undefined }
    });
    expect(readSortCols(getByTestId('report-rows-table'))).toEqual([
      'descending',
      null,
      null,
      null,
      null,
      null
    ]);

    await rerender({ rows: rootRows, sort: 'outcome-asc', onOpenRoot: () => undefined });
    expect(readSortCols(getByTestId('report-rows-table'))).toEqual([
      null,
      null,
      'ascending',
      null,
      null,
      null
    ]);

    await rerender({ rows: rootRows, sort: 'duration-desc', onOpenRoot: () => undefined });
    expect(readSortCols(getByTestId('report-rows-table'))).toEqual([
      null,
      null,
      null,
      null,
      'descending',
      null
    ]);

    // Attempt row sort: aria-sort sits on Run (col 4), not col 0
    const attemptRows: readonly AttemptRow[] = [
      {
        kind: 'attempt',
        attemptId: 'att-9',
        rootId: 'run-1',
        attemptNumber: 1,
        stepIndex: 0,
        phaseId: 'plan',
        status: 'succeeded',
        exitCode: 0,
        startedUtc: '2026-11-11T00:00:00.000Z',
        completedUtc: '2026-11-11T00:00:01.000Z',
        durationMs: 1000
      }
    ];
    await rerender({ rows: attemptRows, sort: 'root-created-asc', onOpenRoot: () => undefined });
    expect(readSortCols(getByTestId('report-rows-table'))).toEqual([
      null,
      null,
      null,
      null,
      'ascending'
    ]);

    // Group row sort: aria-sort moves from Group (0) to Runs (1); non-numeric Unavailable (no n/a),
    // duration basis + attemptDuration both displayed
    const groupRows: readonly GroupRow[] = [
      {
        kind: 'group',
        key: { workflowId: 'wf-1' },
        roots: 5,
        attempts: 8,
        outcomes: makeOutcomes({ succeeded: 5 }),
        rootDuration: makeDistribution({
          basis: 'root-wall-clock',
          samples: 5,
          known: 0,
          missing: 5,
          p50: 'unavailable',
          p90: 'unavailable',
          p99: 'unavailable'
        }),
        attemptDuration: makeDistribution({
          basis: 'attempt-own',
          samples: 8,
          known: 6,
          missing: 2,
          p50: 420,
          p90: 950,
          p99: 'unavailable'
        })
      }
    ];
    await rerender({ rows: groupRows, sort: 'key-asc', onOpenRoot: () => undefined });
    expect(readSortCols(getByTestId('report-rows-table'))).toEqual(['ascending', null, null, null]);

    await rerender({ rows: groupRows, sort: 'roots-desc', onOpenRoot: () => undefined });
    expect(readSortCols(getByTestId('report-rows-table'))).toEqual([null, 'descending', null, null]);
    const groupText = getByTestId('report-rows-table').textContent;
    expect(groupText).toContain(
      'root-wall-clock: p50 Unavailable: cannot be shown, p90 Unavailable: cannot be shown, p99 Unavailable: cannot be shown (0/5 known)'
    );
    expect(groupText).toContain(
      'attempt-own: p50 420ms, p90 950ms, p99 Unavailable: cannot be shown (6/8 known)'
    );
    expect(groupText.toLowerCase()).not.toContain('n/a');

    // Usage rows: aria-sort moves to Runs (1), Not recorded for invocations, reported vs estimated
    // cost totals, and unknown cost never rendered as 0
    const usageRows: readonly UsageRow[] = [
      {
        kind: 'usage',
        key: { backend: 'claude', model: 'sonnet' },
        roots: 4,
        attempts: 5,
        invocations: 'not-recorded',
        measures: [
          {
            measure: 'cost',
            unit: 'USD',
            total: '2.750000',
            reportedTotal: '2.000000',
            estimatedTotal: '0.750000',
            completeness: 'partial',
            coverage: { known: 3, denominator: 5 }
          }
        ]
      },
      {
        kind: 'usage',
        key: { backend: 'codex', model: null },
        roots: 2,
        attempts: 2,
        invocations: 'not-recorded',
        measures: [
          {
            measure: 'cost',
            unit: 'USD',
            total: '0.000000',
            completeness: 'unknown',
            coverage: { known: 0, denominator: 2 }
          }
        ]
      },
      {
        kind: 'usage',
        key: { backend: 'agy', model: 'gemini' },
        roots: 1,
        attempts: 1,
        invocations: 'not-recorded',
        measures: [
          {
            measure: 'cost',
            unit: 'USD',
            total: '0.000000',
            estimatedTotal: '0.250000',
            completeness: 'unknown',
            coverage: { known: 0, denominator: 1 }
          }
        ]
      }
    ];
    await rerender({ rows: usageRows, sort: 'roots-desc', onOpenRoot: () => undefined });
    expect(readSortCols(getByTestId('report-rows-table'))).toEqual([
      null,
      'descending',
      null,
      null,
      null
    ]);
    const bodyRows = Array.from(getByTestId('report-rows-table').querySelectorAll('tbody tr'));
    expect(bodyRows).toHaveLength(3);
    expect(bodyRows[0]?.querySelectorAll('td')[3]?.textContent).toBe('Not recorded');
    expect(bodyRows[0]?.textContent).toContain(
      'cost: 2.750000 USD [reported 2.000000, estimated 0.750000] (partial)'
    );
    // Unknown cost with zero known coverage renders Unknown: not measured, never 0.000000 USD or 0 USD
    const unknownNoEstText = bodyRows[1]?.textContent ?? '';
    expect(unknownNoEstText).toContain('cost: Unknown: not measured (unknown)');
    expect(unknownNoEstText).not.toContain('0.000000');
    expect(unknownNoEstText).not.toContain('0 USD');
    // Unknown cost with positive estimate still surfaces Unknown: not measured plus estimate, never 0
    const unknownWithEstText = bodyRows[2]?.textContent ?? '';
    expect(unknownWithEstText).toContain(
      'cost: Unknown: not measured [estimated 0.250000 USD] (unknown)'
    );
    expect(unknownWithEstText).not.toContain('0.000000');
  });

  it('retains the last complete report and its active host lease across non-ok run/rerunSaved outcomes, closing only after an ok replacement', async () => {
    const replacementRunOutcomes: ReportCallEnvelope<ReadReportResponse>[] = [
      { boundaryRefusal: null, response: { op: 'run', result: { ok: false, outcome: 'cancelled' } } },
      {
        boundaryRefusal: null,
        response: { op: 'run', result: { ok: false, outcome: 'limited', limit: 'working-data' } }
      },
      {
        boundaryRefusal: null,
        response: { op: 'run', result: { ok: false, outcome: 'limited', limit: 'deadline-exceeded' } }
      },
      {
        boundaryRefusal: null,
        response: { op: 'run', result: { ok: false, outcome: 'refused', reason: 'query-busy' } }
      },
      {
        boundaryRefusal: 'Workspace is untrusted.',
        response: { op: 'run', result: { ok: false, outcome: 'refused', reason: 'workspace-untrusted' } }
      }
    ];
    const replacementRerunOutcomes: ReportCallEnvelope<ReadReportResponse>[] = [
      { boundaryRefusal: null, response: { op: 'rerunSaved', result: { ok: false, outcome: 'cancelled' } } },
      {
        boundaryRefusal: null,
        response: { op: 'rerunSaved', result: { ok: false, outcome: 'limited', limit: 'working-data' } }
      },
      {
        boundaryRefusal: null,
        response: { op: 'rerunSaved', result: { ok: false, outcome: 'limited', limit: 'deadline-exceeded' } }
      },
      {
        boundaryRefusal: null,
        response: { op: 'rerunSaved', result: { ok: false, outcome: 'refused', reason: 'report-lease-limit' } }
      },
      {
        boundaryRefusal: 'Host boundary refused rerun.',
        response: { op: 'rerunSaved', result: { ok: false, outcome: 'refused', reason: 'query-busy' } }
      }
    ];

    let runCalls = 0;
    let rerunCalls = 0;
    const closedIds: string[] = [];

    mockReadReport.mockImplementation(async (req) => {
      if (req.op === 'listSaved') {
        return {
          boundaryRefusal: null,
          response: { op: 'listSaved', result: { ok: true, value: { items: [makeSavedReport('rep-saved-1')], cursor: null } } }
        };
      }
      if (req.op === 'run') {
        runCalls += 1;
        if (runCalls === 1) {
          return {
            boundaryRefusal: null,
            response: {
              op: 'run',
              result: {
                ok: true,
                value: makeRootPage({
                  reportId: 'rep-live-1',
                  rowCount: 2,
                  cursor: 'cur-p2'
                })
              }
            }
          };
        }
        const nextFailure = replacementRunOutcomes.shift();
        if (nextFailure !== undefined) return nextFailure;
        return {
          boundaryRefusal: null,
          response: {
            op: 'run',
            result: {
              ok: true,
              value: makeRootPage({
                reportId: 'rep-live-2',
                rowCount: 1,
                rows: [
                  {
                    kind: 'root',
                    rootId: 'run-gamma',
                    workflowId: 'wf-new',
                    frozenDefinitionId: 'fc-2',
                    outcome: 'succeeded',
                    createdUtc: '2026-11-11T02:00:00.000Z',
                    durationMs: 900,
                    attempts: 1
                  }
                ]
              })
            }
          }
        };
      }
      if (req.op === 'rerunSaved') {
        rerunCalls += 1;
        const nextFailure = replacementRerunOutcomes.shift();
        if (nextFailure !== undefined) return nextFailure;
      }
      if (req.op === 'page') {
        return {
          boundaryRefusal: null,
          response: {
            op: 'page',
            result: {
              ok: true,
              value: makeRootPage({
                reportId: 'rep-live-1',
                rowCount: 2,
                cursor: null,
                rows: [
                  {
                    kind: 'root',
                    rootId: 'run-beta',
                    workflowId: 'wf-deploy',
                    frozenDefinitionId: 'fc-1',
                    outcome: 'succeeded',
                    createdUtc: '2026-11-11T00:20:00.000Z',
                    durationMs: 800,
                    attempts: 1
                  }
                ]
              })
            }
          }
        };
      }
      if (req.op === 'drillDown') {
        return {
          boundaryRefusal: null,
          response: { op: 'drillDown', result: { ok: true, value: makeDrillDown({ reportId: req.reportId }) } }
        };
      }
      if (req.op === 'close') {
        closedIds.push(req.reportId);
        return { boundaryRefusal: null, response: { op: 'close', result: { ok: true, value: { released: true } } } };
      }
      return { boundaryRefusal: null, response: { op: 'cancelActive', canceled: false } };
    });

    mockMutateReport.mockResolvedValue({
      boundaryRefusal: null,
      response: { op: 'export', exportOutcome: { outcome: 'dialog-canceled' } }
    });

    const { findByTestId, getByTestId } = render(HistoricalReportsPanel);
    await findByTestId('report-rows-table');

    const runBtn = getByTestId('report-run-button');
    const rerunBtn = await findByTestId('saved-rerun-rep-saved-1');
    const notice = getByTestId('report-status-notice');

    // Every non-ok replacement `run` keeps rep-live-1 rendered and NEVER dispatches `close`
    const expectedRunNotices = [
      'Canceled active report query.',
      'Report unavailable: working-data.',
      'Report unavailable: deadline-exceeded.',
      'Report unavailable: query-busy.',
      'Workspace is untrusted.'
    ];
    for (const expectedNotice of expectedRunNotices) {
      await fireEvent.click(runBtn);
      await vi.waitFor(() => expect(notice.textContent).toBe(expectedNotice));
      expect(closedIds).toEqual([]);
      expect(getByTestId('report-rows-table').textContent).toContain('run-alpha');
    }

    // Every non-ok replacement `rerunSaved` also keeps rep-live-1 and NEVER dispatches `close`
    const expectedRerunNotices = [
      'Canceled active report query.',
      'Re-run refused: working-data.',
      'Re-run refused: deadline-exceeded.',
      'Re-run refused: report-lease-limit.',
      'Host boundary refused rerun.'
    ];
    for (const expectedNotice of expectedRerunNotices) {
      await fireEvent.click(rerunBtn);
      await vi.waitFor(() => expect(notice.textContent).toBe(expectedNotice));
      expect(closedIds).toEqual([]);
      expect(getByTestId('report-rows-table').textContent).toContain('run-alpha');
    }
    expect(rerunCalls).toBe(5);

    // Retained report still supports paging, drill-down, and export using its live lease (rep-live-1)
    await fireEvent.click(getByTestId('report-next-page'));
    await vi.waitFor(() => {
      expect(getByTestId('report-rows-table').textContent).toContain('run-beta');
    });
    expect(mockReadReport).toHaveBeenCalledWith({ op: 'page', cursor: 'cur-p2' });

    await fireEvent.click(getByTestId('report-drilldown-open-run-alpha'));
    await findByTestId('report-drilldown-panel');
    expect(mockReadReport).toHaveBeenCalledWith({
      op: 'drillDown',
      reportId: 'rep-live-1',
      rootId: 'run-alpha'
    });

    await fireEvent.click(getByTestId('report-export-json'));
    expect(mockMutateReport).toHaveBeenCalledWith({
      op: 'export',
      reportId: 'rep-live-1',
      format: 'json'
    });
    expect(closedIds).toEqual([]);

    // Only once a replacement returns ok: true does the panel release rep-live-1
    await fireEvent.click(runBtn);
    await vi.waitFor(() => {
      expect(getByTestId('report-rows-table').textContent).toContain('run-gamma');
    });
    expect(closedIds).toEqual(['rep-live-1']);
  });

  it('discloses external-file retention outside managed retention and saved-report deletion boundaries', async () => {
    mockReadReport.mockImplementation((req) => Promise.resolve(answerMountReads(req)));
    const { findByTestId, getByTestId } = render(HistoricalReportsPanel);
    await findByTestId('report-rows-table');

    const retentionDisclosure = getByTestId('report-retention-disclosure').textContent.replace(
      /\s+/g,
      ' '
    );
    expect(retentionDisclosure).toContain('outside-managed-retention');
    expect(retentionDisclosure).toContain('not deleted by retention sweeps');
    expect(retentionDisclosure).toContain('deleting saved reports');

    const savedRetentionNote = getByTestId('saved-reports-retention-note').textContent.replace(
      /\s+/g,
      ' '
    );
    expect(savedRetentionNote).toContain('saved definition and manifest');
    expect(savedRetentionNote).toContain('previously exported files on disk are not touched');
  });

  it('preserves focus via aria-disabled while loading/saving, restores focus on drill-down close with null frozenDefinitionId and handoff/review summaries, and announces loadMore errors politely', async () => {
    const pendingRun = createDeferred<ReportCallEnvelope<ReadReportResponse>>();
    const pendingSave = createDeferred<ReportCallEnvelope<MutateReportResponse>>();
    const pageResponses: ReportCallEnvelope<ReadReportResponse>[] = [
      {
        boundaryRefusal: null,
        response: {
          op: 'page',
          result: { ok: false, outcome: 'expired', instruction: 'restart-report-query' }
        }
      },
      {
        boundaryRefusal: null,
        response: {
          op: 'page',
          result: { ok: false, outcome: 'refused', reason: 'invalid-cursor' }
        }
      },
      {
        boundaryRefusal: 'Primary window required.',
        response: {
          op: 'page',
          result: { ok: false, outcome: 'refused', reason: 'query-busy' }
        }
      }
    ];

    let runCount = 0;
    mockReadReport.mockImplementation((req) => {
      if (req.op === 'listSaved') {
        return Promise.resolve({
          boundaryRefusal: null,
          response: { op: 'listSaved', result: { ok: true, value: { items: [], cursor: null } } }
        });
      }
      if (req.op === 'run') {
        runCount += 1;
        if (runCount === 1) {
          return Promise.resolve({
            boundaryRefusal: null,
            response: {
              op: 'run',
              result: {
                ok: true,
                value: makeRootPage({ reportId: 'rep-a11y-1', rowCount: 3, cursor: 'cur-next' })
              }
            }
          });
        }
        return pendingRun.promise;
      }
      if (req.op === 'drillDown') {
        return Promise.resolve({
          boundaryRefusal: null,
          response: {
            op: 'drillDown',
            result: {
              ok: true,
              value: makeDrillDown({
                reportId: 'rep-a11y-1',
                frozenDefinitionId: null,
                handoffSummaries: [
                  {
                    handoffId: 'ho-1',
                    rootId: 'run-alpha',
                    sourceAttemptId: 'att-1',
                    targetPhaseId: 'verify',
                    revision: 1,
                    status: 'accepted',
                    recordBytes: 512
                  },
                  {
                    handoffId: 'ho-2',
                    rootId: 'run-alpha',
                    sourceAttemptId: 'att-1',
                    targetPhaseId: 'finalize',
                    revision: 2,
                    status: 'accepted',
                    recordBytes: 640
                  }
                ],
                reviewSummaries: [
                  {
                    loopId: 'loop-1',
                    rootId: 'run-alpha',
                    nodeId: 'review-code',
                    iteration: 1,
                    verdict: 'passed',
                    candidateRef: 'cand-1',
                    openFindings: 0,
                    resolvedFindings: 2,
                    totalFindings: 2
                  }
                ]
              })
            }
          }
        });
      }
      if (req.op === 'page') {
        const next = pageResponses.shift();
        if (next !== undefined) return Promise.resolve(next);
      }
      return Promise.resolve({
        boundaryRefusal: null,
        response: { op: 'close', result: { ok: true, value: { released: true } } }
      });
    });

    mockMutateReport.mockImplementation(() => pendingSave.promise);

    const { findByTestId, getByTestId, queryByTestId } = render(HistoricalReportsPanel);
    await findByTestId('report-rows-table');

    // Focus preserved on Run button via aria-disabled (not disabled) while loading
    const runBtn = getByTestId('report-run-button');
    runBtn.focus();
    expect(document.activeElement).toBe(runBtn);
    await fireEvent.click(runBtn);
    expect(runBtn.getAttribute('aria-disabled')).toBe('true');
    expect(runBtn.hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(runBtn);
    expect(getByTestId('report-cancel-button')).toBeTruthy();

    // Clicking again while loading does not dispatch a duplicate run
    await fireEvent.click(runBtn);
    expect(runCount).toBe(2);

    pendingRun.resolve({
      boundaryRefusal: null,
      response: { op: 'run', result: { ok: false, outcome: 'cancelled' } }
    });
    await vi.waitFor(() => expect(runBtn.getAttribute('aria-disabled')).toBeNull());

    // Focus preserved on Save button via aria-disabled (not disabled) while saving
    const saveBtn = getByTestId('report-save-button');
    saveBtn.focus();
    expect(document.activeElement).toBe(saveBtn);
    await fireEvent.click(saveBtn);
    expect(saveBtn.getAttribute('aria-disabled')).toBe('true');
    expect(saveBtn.hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(saveBtn);

    // Duplicate click while mutating is ignored
    await fireEvent.click(saveBtn);
    expect(mockMutateReport).toHaveBeenCalledTimes(1);

    pendingSave.resolve({
      boundaryRefusal: null,
      response: { op: 'save', result: { ok: true, value: makeSavedReport('rep-a11y-1') } }
    });
    await vi.waitFor(() => expect(saveBtn.getAttribute('aria-disabled')).toBeNull());

    // Drill-down renders frozenDefinitionId: null, handoffSummaries, reviewSummaries, and restores focus
    const triggerBtn = getByTestId('report-drilldown-open-run-alpha');
    triggerBtn.focus();
    await fireEvent.click(triggerBtn);
    const drillPanel = await findByTestId('report-drilldown-panel');
    expect(drillPanel.textContent).toContain('Frozen definition Not recorded');
    expect(drillPanel.textContent).toContain('Accepted handoffs: 2');
    expect(drillPanel.textContent).toContain('Review loops: 1');

    const closeBtn = getByTestId('report-drilldown-close');
    closeBtn.focus();
    expect(document.activeElement).toBe(closeBtn);
    await fireEvent.click(closeBtn);
    await vi.waitFor(() => {
      expect(queryByTestId('report-drilldown-panel')).toBeNull();
      expect(document.activeElement).toBe(triggerBtn);
    });

    // Polite live-region announcements on loadMore() expiration, refusal, and boundaryRefusal
    const notice = getByTestId('report-status-notice');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.getAttribute('aria-live')).toBe('polite');

    const nextPageBtn = getByTestId('report-next-page');
    await fireEvent.click(nextPageBtn);
    await vi.waitFor(() => {
      expect(notice.textContent).toBe('Report snapshot expired. Run the report again to restart paging.');
    });

    await fireEvent.click(nextPageBtn);
    await vi.waitFor(() => {
      expect(notice.textContent).toBe('Could not load next page: invalid-cursor.');
    });

    await fireEvent.click(nextPageBtn);
    await vi.waitFor(() => {
      expect(notice.textContent).toBe('Primary window required.');
    });
  });

  it('closes a cancelled runReplacement that still resolves ok: true without replacing the prior report or closing its lease (CR-310-2)', async () => {
    const pendingRun = createDeferred<ReportCallEnvelope<ReadReportResponse>>();
    const pendingRerun = createDeferred<ReportCallEnvelope<ReadReportResponse>>();
    const pendingCancelForRerun = createDeferred<ReportCallEnvelope<ReadReportResponse>>();
    const closedIds: string[] = [];
    let runCalls = 0;
    let cancelCalls = 0;

    mockReadReport.mockImplementation((req) => {
      if (req.op === 'listSaved') {
        return Promise.resolve({
          boundaryRefusal: null,
          response: { op: 'listSaved', result: { ok: true, value: { items: [makeSavedReport('rep-saved-1')], cursor: null } } }
        });
      }
      if (req.op === 'run') {
        runCalls += 1;
        if (runCalls === 1) {
          return Promise.resolve({
            boundaryRefusal: null,
            response: {
              op: 'run',
              result: {
                ok: true,
                value: makeRootPage({
                  reportId: 'rep-prior-1',
                  rows: [{
                    kind: 'root',
                    rootId: 'run-prior',
                    workflowId: 'wf-prior',
                    frozenDefinitionId: 'fc-1',
                    outcome: 'succeeded',
                    createdUtc: '2026-11-11T00:30:00.000Z',
                    durationMs: 1_200,
                    attempts: 1
                  }]
                })
              }
            }
          });
        }
        return pendingRun.promise;
      }
      if (req.op === 'rerunSaved') return pendingRerun.promise;
      if (req.op === 'cancelActive') {
        cancelCalls += 1;
        if (cancelCalls === 1) {
          return Promise.resolve({ boundaryRefusal: null, response: { op: 'cancelActive', canceled: true } });
        }
        return pendingCancelForRerun.promise;
      }
      if (req.op === 'drillDown') {
        return Promise.resolve({
          boundaryRefusal: null,
          response: { op: 'drillDown', result: { ok: true, value: makeDrillDown({ reportId: req.reportId }) } }
        });
      }
      if (req.op === 'close') {
        closedIds.push(req.reportId);
        return Promise.resolve({ boundaryRefusal: null, response: { op: 'close', result: { ok: true, value: { released: true } } } });
      }
      return Promise.resolve({ boundaryRefusal: null, response: { op: 'close', result: { ok: true, value: { released: true } } } });
    });

    const { findByTestId, getByTestId } = render(HistoricalReportsPanel);
    await findByTestId('report-rows-table');
    const notice = getByTestId('report-status-notice');

    // Case 1: cancelActive resolves BEFORE replacement run resolves ok: true
    await fireEvent.click(getByTestId('report-run-button'));
    await fireEvent.click(getByTestId('report-cancel-button'));
    await vi.waitFor(() => expect(notice.textContent).toBe('Canceled active report query.'));

    pendingRun.resolve({
      boundaryRefusal: null,
      response: {
        op: 'run',
        result: {
          ok: true,
          value: makeRootPage({
            reportId: 'rep-canceled-2',
            rows: [{
              kind: 'root',
              rootId: 'run-late-canceled',
              workflowId: 'wf-late',
              frozenDefinitionId: 'fc-2',
              outcome: 'succeeded',
              createdUtc: '2026-11-11T02:00:00.000Z',
              durationMs: 500,
              attempts: 1
            }]
          })
        }
      }
    });
    await vi.waitFor(() => expect(closedIds).toEqual(['rep-canceled-2']));
    expect(getByTestId('report-rows-table').textContent).toContain('run-prior');
    expect(getByTestId('report-rows-table').textContent).not.toContain('run-late-canceled');
    expect(notice.textContent).toBe('Canceled active report query.');

    // Case 2: rerunSaved resolves ok: true BEFORE cancelActive returns { canceled: false }
    await fireEvent.click(await findByTestId('saved-rerun-rep-saved-1'));
    await fireEvent.click(getByTestId('report-cancel-button'));
    pendingRerun.resolve({
      boundaryRefusal: null,
      response: {
        op: 'rerunSaved',
        result: {
          ok: true,
          value: makeRootPage({
            reportId: 'rep-canceled-rerun-3',
            rows: [{
              kind: 'root',
              rootId: 'run-late-rerun',
              workflowId: 'wf-late',
              frozenDefinitionId: 'fc-3',
              outcome: 'succeeded',
              createdUtc: '2026-11-11T03:00:00.000Z',
              durationMs: 400,
              attempts: 1
            }]
          })
        }
      }
    });
    await vi.waitFor(() => expect(closedIds).toEqual(['rep-canceled-2', 'rep-canceled-rerun-3']));
    pendingCancelForRerun.resolve({ boundaryRefusal: null, response: { op: 'cancelActive', canceled: false } });
    await tick();
    expect(notice.textContent).toBe('Canceled active report query.');
    expect(getByTestId('report-rows-table').textContent).toContain('run-prior');
    expect(getByTestId('report-rows-table').textContent).not.toContain('run-late-rerun');

    // Prior lease rep-prior-1 remains open and usable
    await fireEvent.click(getByTestId('report-drilldown-open-run-prior'));
    await findByTestId('report-drilldown-panel');
    expect(mockReadReport).toHaveBeenCalledWith({ op: 'drillDown', reportId: 'rep-prior-1', rootId: 'run-prior' });
    expect(closedIds).not.toContain('rep-prior-1');
  });

  it('ignores stale loadMore from report A resolving after switching to report B and mismatched reportId pages (CR-310-2)', async () => {
    const stalePageA = createDeferred<ReportCallEnvelope<ReadReportResponse>>();
    const closedIds: string[] = [];
    const requestedCursors: string[] = [];
    let runCalls = 0;
    let pageBCalls = 0;

    mockReadReport.mockImplementation((req) => {
      if (req.op === 'listSaved') {
        return Promise.resolve({
          boundaryRefusal: null,
          response: { op: 'listSaved', result: { ok: true, value: { items: [], cursor: null } } }
        });
      }
      if (req.op === 'run') {
        runCalls += 1;
        if (runCalls === 1) {
          return Promise.resolve({
            boundaryRefusal: null,
            response: {
              op: 'run',
              result: {
                ok: true,
                value: makeRootPage({
                  reportId: 'rep-A',
                  rowCount: 2,
                  cursor: 'cur-A-2',
                  rows: [{
                    kind: 'root',
                    rootId: 'run-A-1',
                    workflowId: 'wf-A',
                    frozenDefinitionId: 'fc-A',
                    outcome: 'succeeded',
                    createdUtc: '2026-11-11T00:10:00.000Z',
                    durationMs: 1_000,
                    attempts: 1
                  }]
                })
              }
            }
          });
        }
        return Promise.resolve({
          boundaryRefusal: null,
          response: {
            op: 'run',
            result: {
              ok: true,
              value: makeRootPage({
                reportId: 'rep-B',
                rowCount: 2,
                cursor: 'cur-B-2',
                rows: [{
                  kind: 'root',
                  rootId: 'run-B-1',
                  workflowId: 'wf-B',
                  frozenDefinitionId: 'fc-B',
                  outcome: 'succeeded',
                  createdUtc: '2026-11-11T01:10:00.000Z',
                  durationMs: 2_000,
                  attempts: 1
                }]
              })
            }
          }
        });
      }
      if (req.op === 'cancelActive') {
        return Promise.resolve({ boundaryRefusal: null, response: { op: 'cancelActive', canceled: true } });
      }
      if (req.op === 'page') {
        requestedCursors.push(req.cursor);
        if (req.cursor === 'cur-A-2') return stalePageA.promise;
        pageBCalls += 1;
        if (pageBCalls === 1) {
          return Promise.resolve({
            boundaryRefusal: null,
            response: {
              op: 'page',
              result: {
                ok: true,
                value: makeRootPage({
                  reportId: 'rep-WRONG',
                  rowCount: 2,
                  cursor: null,
                  rows: [{
                    kind: 'root',
                    rootId: 'run-WRONG',
                    workflowId: 'wf-wrong',
                    frozenDefinitionId: 'fc-wrong',
                    outcome: 'succeeded',
                    createdUtc: '2026-11-11T01:15:00.000Z',
                    durationMs: 1_900,
                    attempts: 1
                  }]
                })
              }
            }
          });
        }
        return Promise.resolve({
          boundaryRefusal: null,
          response: {
            op: 'page',
            result: {
              ok: true,
              value: makeRootPage({
                reportId: 'rep-B',
                rowCount: 2,
                cursor: null,
                rows: [{
                  kind: 'root',
                  rootId: 'run-B-2',
                  workflowId: 'wf-B',
                  frozenDefinitionId: 'fc-B',
                  outcome: 'succeeded',
                  createdUtc: '2026-11-11T01:20:00.000Z',
                  durationMs: 2_100,
                  attempts: 1
                }]
              })
            }
          }
        });
      }
      if (req.op === 'close') {
        closedIds.push(req.reportId);
      }
      return Promise.resolve({ boundaryRefusal: null, response: { op: 'close', result: { ok: true, value: { released: true } } } });
    });

    const { findByTestId, getByTestId } = render(HistoricalReportsPanel);
    await findByTestId('report-rows-table');
    expect(getByTestId('report-rows-table').textContent).toContain('run-A-1');

    // Start paging report A, cancel it, then switch to report B
    await fireEvent.click(getByTestId('report-next-page'));
    await fireEvent.click(getByTestId('report-cancel-button'));
    await vi.waitFor(() => expect(getByTestId('report-run-button').getAttribute('aria-disabled')).toBeNull());

    await fireEvent.click(getByTestId('report-run-button'));
    await vi.waitFor(() => expect(getByTestId('report-rows-table').textContent).toContain('run-B-1'));
    expect(closedIds).toEqual(['rep-A']);

    // Stale page response from report A now resolves with ok: true and cursor: null
    stalePageA.resolve({
      boundaryRefusal: null,
      response: {
        op: 'page',
        result: {
          ok: true,
          value: makeRootPage({
            reportId: 'rep-A',
            rowCount: 2,
            cursor: null,
            rows: [{
              kind: 'root',
              rootId: 'run-A-2',
              workflowId: 'wf-A',
              frozenDefinitionId: 'fc-A',
              outcome: 'succeeded',
              createdUtc: '2026-11-11T00:20:00.000Z',
              durationMs: 1_100,
              attempts: 1
            }]
          })
        }
      }
    });
    await tick();
    await Promise.resolve();

    // Report B rows and cursor must remain completely intact
    expect(getByTestId('report-rows-table').textContent).toContain('run-B-1');
    expect(getByTestId('report-rows-table').textContent).not.toContain('run-A-2');
    const nextBtnB = getByTestId('report-next-page');

    // A page response with a mismatched reportId is also ignored without corrupting rows or cursor
    await fireEvent.click(nextBtnB);
    await vi.waitFor(() => expect(pageBCalls).toBe(1));
    await tick();
    expect(getByTestId('report-rows-table').textContent).not.toContain('run-WRONG');
    expect(getByTestId('report-next-page')).toBeTruthy();

    // Matching reportId page appends cleanly
    await fireEvent.click(getByTestId('report-next-page'));
    await vi.waitFor(() => expect(getByTestId('report-rows-table').textContent).toContain('run-B-2'));
    expect(requestedCursors).toEqual(['cur-A-2', 'cur-B-2', 'cur-B-2']);
  });

  it('closes the resolved reportId lease when unmounted while a replacement query is in flight (CR-310-2)', async () => {
    const inFlightReplacement = createDeferred<ReportCallEnvelope<ReadReportResponse>>();
    const closedIds: string[] = [];
    let runCalls = 0;

    mockReadReport.mockImplementation((req) => {
      if (req.op === 'listSaved') {
        return Promise.resolve({
          boundaryRefusal: null,
          response: { op: 'listSaved', result: { ok: true, value: { items: [], cursor: null } } }
        });
      }
      if (req.op === 'run') {
        runCalls += 1;
        if (runCalls === 1) {
          return Promise.resolve({
            boundaryRefusal: null,
            response: { op: 'run', result: { ok: true, value: makeRootPage({ reportId: 'rep-mount-1' }) } }
          });
        }
        return inFlightReplacement.promise;
      }
      if (req.op === 'close') {
        closedIds.push(req.reportId);
      }
      return Promise.resolve({ boundaryRefusal: null, response: { op: 'close', result: { ok: true, value: { released: true } } } });
    });

    const { findByTestId, getByTestId, unmount } = render(HistoricalReportsPanel);
    await findByTestId('report-rows-table');

    await fireEvent.click(getByTestId('report-run-button'));
    expect(runCalls).toBe(2);

    // Unmount before replacement resolves: closes rep-mount-1 immediately
    unmount();
    expect(closedIds).toEqual(['rep-mount-1']);

    // Replacement resolves after unmount: must immediately close rep-after-unmount-2 without leaking
    inFlightReplacement.resolve({
      boundaryRefusal: null,
      response: { op: 'run', result: { ok: true, value: makeRootPage({ reportId: 'rep-after-unmount-2' }) } }
    });
    await vi.waitFor(() => expect(closedIds).toEqual(['rep-mount-1', 'rep-after-unmount-2']));
  });

  it('ignores cancelled or superseded reproduceSaved responses and never clears a newer query loading state (CR-310-2)', async () => {
    const reproduce1 = createDeferred<ReportCallEnvelope<ReadReportResponse>>();
    const reproduce2 = createDeferred<ReportCallEnvelope<ReadReportResponse>>();
    const newerRun = createDeferred<ReportCallEnvelope<ReadReportResponse>>();
    const closedIds: string[] = [];
    let runCalls = 0;
    let reproduceCalls = 0;

    mockReadReport.mockImplementation((req) => {
      if (req.op === 'listSaved') {
        return Promise.resolve({
          boundaryRefusal: null,
          response: { op: 'listSaved', result: { ok: true, value: { items: [makeSavedReport('rep-saved-1')], cursor: null } } }
        });
      }
      if (req.op === 'run') {
        runCalls += 1;
        if (runCalls === 1) {
          return Promise.resolve({
            boundaryRefusal: null,
            response: { op: 'run', result: { ok: true, value: makeRootPage({ reportId: 'rep-base-1' }) } }
          });
        }
        return newerRun.promise;
      }
      if (req.op === 'reproduceSaved') {
        reproduceCalls += 1;
        return reproduceCalls === 1 ? reproduce1.promise : reproduce2.promise;
      }
      if (req.op === 'cancelActive') {
        return Promise.resolve({ boundaryRefusal: null, response: { op: 'cancelActive', canceled: true } });
      }
      if (req.op === 'close') {
        closedIds.push(req.reportId);
      }
      return Promise.resolve({ boundaryRefusal: null, response: { op: 'close', result: { ok: true, value: { released: true } } } });
    });

    const { findByTestId, getByTestId } = render(HistoricalReportsPanel);
    await findByTestId('report-rows-table');
    const notice = getByTestId('report-status-notice');
    const runBtn = getByTestId('report-run-button');
    const reproBtn = await findByTestId('saved-reproduce-rep-saved-1');

    // Part A: cancelled reproduceSaved must not overwrite notice when it resolves ok: true
    await fireEvent.click(reproBtn);
    expect(runBtn.getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(getByTestId('report-cancel-button'));
    await vi.waitFor(() => expect(notice.textContent).toBe('Canceled active report query.'));

    reproduce1.resolve({
      boundaryRefusal: null,
      response: { op: 'reproduceSaved', result: { ok: true, value: { verdict: 'reproduced' } } }
    });
    await tick();
    await Promise.resolve();
    expect(notice.textContent).toBe('Canceled active report query.');
    expect(getByTestId('report-rows-table').textContent).toContain('run-alpha');

    // Part B: superseded reproduceSaved resolving while newer run is in flight must NOT clear loading or notice
    await fireEvent.click(reproBtn);
    await fireEvent.click(getByTestId('report-cancel-button'));
    await vi.waitFor(() => expect(runBtn.getAttribute('aria-disabled')).toBeNull());

    await fireEvent.click(runBtn);
    expect(runBtn.getAttribute('aria-disabled')).toBe('true');
    expect(getByTestId('report-cancel-button')).toBeTruthy();
    expect(notice.textContent).toBe('Running pinned historical report…');

    reproduce2.resolve({
      boundaryRefusal: null,
      response: { op: 'reproduceSaved', result: { ok: true, value: { verdict: 'reproduced' } } }
    });
    await tick();
    await Promise.resolve();

    // Newer query stays loading and its notice is preserved
    expect(runBtn.getAttribute('aria-disabled')).toBe('true');
    expect(getByTestId('report-cancel-button')).toBeTruthy();
    expect(notice.textContent).toBe('Running pinned historical report…');

    // When newer query resolves, it commits cleanly and closes rep-base-1
    newerRun.resolve({
      boundaryRefusal: null,
      response: {
        op: 'run',
        result: {
          ok: true,
          value: makeRootPage({
            reportId: 'rep-newer-2',
            rows: [{
              kind: 'root',
              rootId: 'run-newer',
              workflowId: 'wf-newer',
              frozenDefinitionId: 'fc-2',
              outcome: 'succeeded',
              createdUtc: '2026-11-11T04:00:00.000Z',
              durationMs: 700,
              attempts: 1
            }]
          })
        }
      }
    });
    await vi.waitFor(() => expect(getByTestId('report-rows-table').textContent).toContain('run-newer'));
    expect(runBtn.getAttribute('aria-disabled')).toBeNull();
    expect(closedIds).toEqual(['rep-base-1']);
  });
});

describe('ChangeReviewPanel, ExecutionVisibilityPanel, HistoryRunDetail & RunDetailTier (FR-R6-F12, F10, F15 / R7-17-03)', () => {
  it('renders hostile repository paths strictly as inert text and cancels/closes live reviews on request switch (F12-FR-13, AC-09)', async () => {
    const reviewId = 'rev_123456789012345678';
    mockChangeReview.mockImplementation(async (req) => {
      if (req.op === 'open') {
        return {
          boundaryRefusal: null,
          response: {
            op: 'open',
            editor: { mode: 'none', opened: 0 },
            result: {
              ok: true,
              value: {
                state: 'current',
                reason: null,
                review: makeDescriptor({ reviewId, requestId: req.requestId }),
                firstPage: {
                  reviewId,
                  entries: [
                    {
                      index: 0,
                      kind: 'added',
                      oldPath: null,
                      newPath: '<img src=x onerror="alert(1)">/../../evil.ts',
                      binary: false,
                      oldHandle: null,
                      newHandle: 'h-1',
                      similarity: null
                    }
                  ],
                  nextCursor: null
                }
              }
            }
          }
        };
      }
      if (req.op === 'close') {
        return { boundaryRefusal: null, response: { op: 'close', closed: true } };
      }
      return { boundaryRefusal: null, response: { op: 'cancelOpen', canceled: true } };
    });

    const laneA = makeLane();

    const { getByTestId, findByTestId, rerender, container } = render(ChangeReviewPanel, {
      props: { lane: laneA, isPrimary: true }
    });

    await fireEvent.click(getByTestId('change-review-inspect-btn'));
    const fileList = await findByTestId('change-review-file-list');
    expect(fileList.textContent).toContain('<img src=x onerror="alert(1)">/../../evil.ts');
    // Zero injected DOM elements!
    expect(container.querySelectorAll('img').length).toBe(0);

    // Switching integrationRequestId after a settled open closes the previous reviewId without firing a spurious cancelOpen
    await rerender({
      lane: { ...laneA, integrationRequestId: '5'.repeat(32) },
      isPrimary: true
    });
    expect(mockChangeReview).not.toHaveBeenCalledWith({ op: 'cancelOpen' });
    expect(mockChangeReview).toHaveBeenCalledWith({ op: 'close', reviewId });
  });

  it('displays distinct evidence availability vs recovery certainty and dispatches manual handoff approval', async () => {
    const visibilityDetail = makeVisibilityDetail({
      handoffs: [makeWaitingHandoff('ho-99', 'run-99')]
    });

    mockExecVisibility.mockResolvedValue({
      boundaryRefusal: null,
      response: { op: 'attemptDetail', detail: visibilityDetail }
    });
    mockDecideHandoff.mockResolvedValue({
      boundaryRefusal: null,
      response: {
        op: 'approve',
        result: {
          ok: true,
          revision: 1
        }
      }
    });

    const { findByTestId, getByTestId } = render(ExecutionVisibilityPanel, {
      props: { rootExecutionId: 'run-99', isPrimary: true }
    });

    await findByTestId('execution-visibility-posture');
    expect(getByTestId('ev-evidence').textContent).toContain('Missing: not recorded');
    expect(getByTestId('ev-recovery').textContent).toContain('Uncertain: could not be confirmed');
    expect(getByTestId('ev-acp').textContent).toContain('awaiting-permission');

    const approveBtn = await findByTestId('ev-handoff-approve-ho-99');
    await fireEvent.click(approveBtn);
    expect(mockDecideHandoff).toHaveBeenCalledWith({
      op: 'approve',
      handoffId: 'ho-99',
      expectedRevision: 1,
      decisionId: 'approve-ho-99-r1'
    });
  });

  it('lists attempts and filters ExecutionVisibilityPanel by stable attemptId while keeping all attempts selectable', async () => {
    const attempt1 = {
      attemptId: 'att-stable-1',
      stepIndex: 0,
      phaseId: 'specify',
      attemptNumber: 1,
      status: 'failed',
      exitCode: 1,
      startedAtMs: 1_000,
      completedAtMs: 2_000,
      backendKind: 'claude',
      modelId: 'claude-sonnet-4-6',
      profileId: 'claude-acp',
      laneId: null,
      failureCause: 'tool-error'
    };
    const attempt2 = {
      attemptId: 'att-stable-2',
      stepIndex: 1,
      phaseId: 'implement',
      attemptNumber: 2,
      status: 'succeeded',
      exitCode: 0,
      startedAtMs: 3_000,
      completedAtMs: 5_000,
      backendKind: 'claude',
      modelId: 'claude-sonnet-4-6',
      profileId: 'claude-acp',
      laneId: null,
      failureCause: null
    };

    mockExecVisibility.mockImplementation(async (req) => {
      if (req.op === 'attemptDetail' && req.attemptId === 'att-stable-2') {
        return {
          boundaryRefusal: null,
          response: {
            op: 'attemptDetail',
            detail: makeVisibilityDetail({
              rootExecutionId: 'run-att',
              hierarchy: {
                rootStatus: 'succeeded',
                workflowId: 'wf-main',
                frozenDefinitionId: 'fc-1',
                invocationCount: 2,
                attemptCount: 2,
                dataQuality: 'authoritative',
                // Even if scoped response lists only the selected attempt, knownAttempts stays intact
                attempts: [attempt2]
              },
              recovery: { posture: 'verified', reasonCode: null }
            })
          }
        };
      }
      return {
        boundaryRefusal: null,
        response: {
          op: 'attemptDetail',
          detail: makeVisibilityDetail({
            rootExecutionId: 'run-att',
            hierarchy: {
              rootStatus: 'succeeded',
              workflowId: 'wf-main',
              frozenDefinitionId: 'fc-1',
              invocationCount: 2,
              attemptCount: 2,
              dataQuality: 'authoritative',
              attempts: [attempt1, attempt2]
            }
          })
        }
      };
    });

    const { findByTestId, getByTestId } = render(ExecutionVisibilityPanel, {
      props: { rootExecutionId: 'run-att', isPrimary: true }
    });

    await findByTestId('ev-attempts-section');
    const allBtn = getByTestId('ev-attempt-all');
    const att1Btn = getByTestId('ev-attempt-att-stable-1');
    const att2Btn = getByTestId('ev-attempt-att-stable-2');

    expect(allBtn.getAttribute('aria-pressed')).toBe('true');
    expect(att1Btn.getAttribute('aria-pressed')).toBe('false');
    expect(att2Btn.getAttribute('aria-pressed')).toBe('false');

    await fireEvent.click(att2Btn);
    await vi.waitFor(() => {
      expect(getByTestId('ev-recovery').textContent).toContain('Verified recovery handoff');
    });
    expect(mockExecVisibility).toHaveBeenCalledWith({
      op: 'attemptDetail',
      rootExecutionId: 'run-att',
      attemptId: 'att-stable-2'
    });
    expect(att2Btn.getAttribute('aria-pressed')).toBe('true');
    expect(allBtn.getAttribute('aria-pressed')).toBe('false');
    // Both stable attempt buttons remain rendered after selecting one
    expect(getByTestId('ev-attempt-att-stable-1')).toBeTruthy();

    await fireEvent.click(allBtn);
    await vi.waitFor(() => {
      expect(mockExecVisibility).toHaveBeenLastCalledWith({
        op: 'attemptDetail',
        rootExecutionId: 'run-att'
      });
    });
    expect(allBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('renders non-numeric evidence availability phrases (no 0 present / N recorded) and human-readable ACP & lane labels', async () => {
    const nonPresentEvidence = [
      {
        artifactId: 'a-exp',
        rootId: 'run-av',
        attemptId: 'att-1',
        storeKind: 'transcript',
        availability: 'expired',
        byteSize: 0,
        retentionClass: 'transcripts-diagnostics-checkpoints-audit-catalog'
      },
      {
        artifactId: 'a-miss',
        rootId: 'run-av',
        attemptId: 'att-1',
        storeKind: 'diagnostic',
        availability: 'missing',
        byteSize: 0,
        retentionClass: 'transcripts-diagnostics-checkpoints-audit-catalog'
      },
      {
        artifactId: 'a-part',
        rootId: 'run-av',
        attemptId: 'att-1',
        storeKind: 'checkpoint',
        availability: 'partial',
        byteSize: 64,
        retentionClass: 'transcripts-diagnostics-checkpoints-audit-catalog'
      },
      {
        artifactId: 'a-unc',
        rootId: 'run-av',
        attemptId: 'att-1',
        storeKind: 'audit',
        availability: 'uncertain',
        byteSize: 0,
        retentionClass: 'transcripts-diagnostics-checkpoints-audit-catalog'
      },
      {
        artifactId: 'a-unav',
        rootId: 'run-av',
        attemptId: 'att-1',
        storeKind: 'catalog',
        availability: 'unavailable',
        byteSize: 0,
        retentionClass: 'transcripts-diagnostics-checkpoints-audit-catalog'
      }
    ];

    const acpStates: ReadonlyArray<readonly [ExecutionAttemptVisibility['acp']['runtimeState'], string]> = [
      ['connected', 'Connected'],
      ['disconnected', 'Disconnected'],
      ['awaiting-permission', 'Awaiting permission (awaiting-permission)'],
      ['canceled', 'Canceled'],
      ['uncertain', 'Uncertain: could not be confirmed'],
      ['not-recorded', 'Not recorded']
    ];

    let stateIdx = 0;
    mockExecVisibility.mockImplementation(async () => {
      const [runtimeState] = acpStates[stateIdx] ?? ['connected'];
      return {
        boundaryRefusal: null,
        response: {
          op: 'attemptDetail',
          detail: makeVisibilityDetail({
            rootExecutionId: 'run-av',
            evidence: nonPresentEvidence,
            acp: {
              runtimeState,
              profileId: 'claude-acp',
              backendKind: 'claude',
              modelId: 'claude-sonnet-4-6',
              liveObservations: 2,
              pendingPermissions: 0
            }
          })
        }
      };
    });

    const { findByTestId, getByTestId } = render(ExecutionVisibilityPanel, {
      props: { rootExecutionId: 'run-av', isPrimary: true }
    });

    await findByTestId('execution-visibility-posture');
    const evidenceText = getByTestId('ev-evidence').textContent;
    expect(evidenceText).toContain('Expired: no longer kept');
    expect(evidenceText).toContain('Missing: not recorded');
    expect(evidenceText).toContain('Partial: some values are missing');
    expect(evidenceText).toContain('Uncertain: could not be confirmed');
    expect(evidenceText).toContain('Unavailable: cannot be shown');
    expect(evidenceText).not.toMatch(/0\s+present/i);
    expect(evidenceText).not.toMatch(/\d/);

    // Verify all human-readable ACP runtimeState labels
    for (let i = 0; i < acpStates.length; i += 1) {
      stateIdx = i;
      const [expectedState, expectedLabel] = acpStates[i]!;
      if (i > 0) {
        await fireEvent.click(getByTestId('execution-visibility-refresh'));
      }
      await vi.waitFor(() => {
        expect(getByTestId('ev-acp').getAttribute('data-acp-state')).toBe(expectedState);
        expect(getByTestId('ev-acp').textContent).toContain(expectedLabel);
      });
    }

    cleanup();

    // Verify human-readable lane labels in ChangeReviewPanel
    const laneCases: ReadonlyArray<readonly [string | null, string]> = [
      ['preparing', 'Preparing'],
      ['active', 'Active'],
      ['paused', 'Paused'],
      ['completed', 'Completed'],
      ['failed', 'Failed'],
      ['abandoned', 'Abandoned'],
      ['cleaned', 'Cleaned up'],
      ['unknown', 'Unknown: not measured'],
      [null, 'Unknown: not measured']
    ];
    const cr = render(ChangeReviewPanel, {
      props: { lane: makeLane({ laneId: 'lane-lbl', laneState: 'preparing' }), isPrimary: true }
    });
    expect(cr.getByTestId('lane-mode-badge').textContent.trim()).toBe('Isolated Git lane');
    for (const [rawState, expectedLabel] of laneCases) {
      await cr.rerender({
        lane: makeLane({ laneId: 'lane-lbl', laneState: rawState }),
        isPrimary: true
      });
      expect(cr.getByTestId('lane-state-value').textContent).toContain(`lane-lbl (${expectedLabel})`);
    }
  });

  it('guards ExecutionVisibilityPanel and ChangeReviewPanel against stale out-of-order responses and closes orphaned review handles', async () => {
    // Part 1: ExecutionVisibilityPanel supersession guard
    const slowDetail = createDeferred<VisibilityCallEnvelope<ReadExecutionVisibilityResponse>>();
    const fastDetail = createDeferred<VisibilityCallEnvelope<ReadExecutionVisibilityResponse>>();
    mockExecVisibility.mockImplementation((req) => {
      if (req.op === 'attemptDetail' && req.rootExecutionId === 'run-slow') {
        return slowDetail.promise;
      }
      return fastDetail.promise;
    });

    const ev = render(ExecutionVisibilityPanel, {
      props: { rootExecutionId: 'run-slow', isPrimary: true }
    });
    await ev.rerender({ rootExecutionId: 'run-fast', isPrimary: true });

    // Newer response resolves first
    fastDetail.resolve({
      boundaryRefusal: null,
      response: {
        op: 'attemptDetail',
        detail: makeVisibilityDetail({
          rootExecutionId: 'run-fast',
          recovery: { posture: 'verified', reasonCode: null },
          acp: {
            runtimeState: 'connected',
            profileId: 'claude-acp',
            backendKind: 'claude',
            modelId: null,
            liveObservations: 3,
            pendingPermissions: 0
          }
        })
      }
    });
    await ev.findByTestId('execution-visibility-posture');
    expect(ev.getByTestId('ev-recovery').textContent).toContain('Verified recovery handoff');
    expect(ev.getByTestId('ev-acp').textContent).toContain('Connected');

    // Older slow response resolves AFTER newer response — must be ignored
    slowDetail.resolve({
      boundaryRefusal: null,
      response: {
        op: 'attemptDetail',
        detail: makeVisibilityDetail({
          rootExecutionId: 'run-slow',
          recovery: { posture: 'degraded', reasonCode: 'stale-overwrite' },
          acp: {
            runtimeState: 'disconnected',
            profileId: 'old-acp',
            backendKind: 'claude',
            modelId: null,
            liveObservations: 0,
            pendingPermissions: 0
          }
        })
      }
    });
    await tick();
    expect(ev.getByTestId('ev-recovery').textContent).toContain('Verified recovery handoff');
    expect(ev.getByTestId('ev-acp').textContent).toContain('Connected');
    cleanup();

    // Part 2: ChangeReviewPanel stale open after cancel -> closes orphaned handle
    const laneA = makeLane({ integrationRequestId: '4'.repeat(32) });
    const laneB = makeLane({ integrationRequestId: '5'.repeat(32) });
    const canceledOpen = createDeferred<VisibilityCallEnvelope<OpenChangeReviewResponse>>();
    const switchedLaneAOpen = createDeferred<VisibilityCallEnvelope<OpenChangeReviewResponse>>();
    const laneBOpen = createDeferred<VisibilityCallEnvelope<OpenChangeReviewResponse>>();
    let openCall = 0;

    mockChangeReview.mockImplementation((req) => {
      if (req.op === 'open') {
        openCall += 1;
        if (openCall === 1) return canceledOpen.promise;
        if (openCall === 2) return switchedLaneAOpen.promise;
        return laneBOpen.promise;
      }
      if (req.op === 'cancelOpen') {
        return Promise.resolve({ boundaryRefusal: null, response: { op: 'cancelOpen', canceled: true } });
      }
      return Promise.resolve({ boundaryRefusal: null, response: { op: 'close', closed: true } });
    });

    const cr = render(ChangeReviewPanel, { props: { lane: laneA, isPrimary: true } });

    // 2a: Cancel while open is in flight, then late open resolves -> must close orphaned handle
    await fireEvent.click(cr.getByTestId('change-review-inspect-btn'));
    await fireEvent.click(await cr.findByTestId('change-review-cancel-btn'));
    canceledOpen.resolve({
      boundaryRefusal: null,
      response: {
        op: 'open',
        editor: { mode: 'none', opened: 0 },
        result: {
          ok: true,
          value: makeOpenedReview({ reviewId: 'rev_orphan_cancel', requestId: laneA.integrationRequestId! }, 'canceled.ts')
        }
      }
    });
    await vi.waitFor(() => {
      expect(mockChangeReview).toHaveBeenCalledWith({ op: 'close', reviewId: 'rev_orphan_cancel' });
    });
    expect(cr.queryByTestId('change-review-file-list')).toBeNull();

    // 2b: Switch lane while laneA open is in flight, open laneB fast, then laneA resolves late ->
    // laneA orphaned handle is closed and laneB state is preserved
    await fireEvent.click(cr.getByTestId('change-review-inspect-btn'));
    await cr.rerender({ lane: laneB, isPrimary: true });
    await fireEvent.click(cr.getByTestId('change-review-inspect-btn'));
    laneBOpen.resolve({
      boundaryRefusal: null,
      response: {
        op: 'open',
        editor: { mode: 'none', opened: 0 },
        result: {
          ok: true,
          value: makeOpenedReview({ reviewId: 'rev_lane_b', requestId: laneB.integrationRequestId! }, 'lane-b.ts')
        }
      }
    });
    await vi.waitFor(() => {
      expect(cr.getByTestId('change-review-file-list').textContent).toContain('lane-b.ts');
    });

    switchedLaneAOpen.resolve({
      boundaryRefusal: null,
      response: {
        op: 'open',
        editor: { mode: 'none', opened: 0 },
        result: {
          ok: true,
          value: makeOpenedReview({ reviewId: 'rev_orphan_switch', requestId: laneA.integrationRequestId! }, 'stale-lane-a.ts')
        }
      }
    });
    await vi.waitFor(() => {
      expect(mockChangeReview).toHaveBeenCalledWith({ op: 'close', reviewId: 'rev_orphan_switch' });
    });
    expect(cr.getByTestId('change-review-file-list').textContent).toContain('lane-b.ts');
    expect(cr.getByTestId('change-review-file-list').textContent).not.toContain('stale-lane-a.ts');
  });

  it('resynchronizes open ExecutionVisibilityPanel and ChangeReviewPanel on visibilitychange and snapshotStore resync', async () => {
    applyFullSnapshot(1, true);

    const attempt = {
      attemptId: 'att-keep',
      stepIndex: 0,
      phaseId: 'implement',
      attemptNumber: 1,
      status: 'running',
      exitCode: null,
      startedAtMs: 1_000,
      completedAtMs: null,
      backendKind: 'claude',
      modelId: null,
      profileId: 'claude-acp',
      laneId: '1'.repeat(32),
      failureCause: null
    };
    let evCall = 0;
    mockExecVisibility.mockImplementation(async () => {
      evCall += 1;
      return {
        boundaryRefusal: null,
        response: {
          op: 'attemptDetail',
          detail: makeVisibilityDetail({
            rootExecutionId: 'run-sync',
            hierarchy: {
              rootStatus: 'running',
              workflowId: 'wf-sync',
              frozenDefinitionId: 'fc-1',
              invocationCount: 1,
              attemptCount: 1,
              dataQuality: evCall >= 3 ? 'authoritative' : 'partial',
              attempts: [attempt]
            },
            lane: makeLane()
          })
        }
      };
    });

    let classifyCall = 0;
    mockChangeReview.mockImplementation(async (req) => {
      if (req.op === 'open') {
        return {
          boundaryRefusal: null,
          response: {
            op: 'open',
            editor: { mode: 'none', opened: 0 },
            result: { ok: true, value: makeOpenedReview({ reviewId: 'rev_sync_1' }, 'sync.ts') }
          }
        };
      }
      if (req.op === 'classify') {
        classifyCall += 1;
        return {
          boundaryRefusal: null,
          response: {
            op: 'classify',
            result: {
              ok: true,
              value: makeDescriptor({
                reviewId: 'rev_sync_1',
                state: classifyCall >= 2 ? 'stale' : 'current',
                reason: classifyCall >= 2 ? 'target-advanced' : null
              })
            }
          }
        };
      }
      return { boundaryRefusal: null, response: { op: 'close', closed: true } };
    });

    const { findByTestId, getByTestId } = render(ExecutionVisibilityPanel, {
      props: { rootExecutionId: 'run-sync', isPrimary: true }
    });
    await findByTestId('execution-visibility-posture');

    // Open the diagnostics disclosure, select a specific attempt, and open the embedded ChangeReviewPanel
    const detailsEl = getByTestId('execution-visibility-panel') as HTMLDetailsElement;
    detailsEl.open = true;
    await fireEvent.click(await findByTestId('ev-attempt-att-keep'));
    await vi.waitFor(() => expect(evCall).toBe(2));

    await fireEvent.click(getByTestId('change-review-inspect-btn'));
    await findByTestId('change-review-file-list');

    // Hiding the document must NOT trigger extra fetches
    setDocumentVisibility('hidden');
    await tick();
    expect(evCall).toBe(2);
    expect(classifyCall).toBe(0);

    // Revealing the document refreshes BOTH panels (preserving selectedAttemptId!)
    setDocumentVisibility('visible');
    await vi.waitFor(() => {
      expect(evCall).toBe(3);
      expect(classifyCall).toBe(1);
    });
    expect(mockExecVisibility).toHaveBeenLastCalledWith({
      op: 'attemptDetail',
      rootExecutionId: 'run-sync',
      attemptId: 'att-keep'
    });
    expect(mockChangeReview).toHaveBeenLastCalledWith({
      op: 'classify',
      reviewId: 'rev_sync_1'
    });

    // A snapshotStore resync refreshes BOTH panels again
    triggerSnapshotResync(3, true);
    await vi.waitFor(() => {
      expect(evCall).toBe(4);
      expect(classifyCall).toBe(2);
      expect(getByTestId('change-review-posture').getAttribute('data-review-state')).toBe('stale');
    });
    expect(mockExecVisibility).toHaveBeenLastCalledWith({
      op: 'attemptDetail',
      rootExecutionId: 'run-sync',
      attemptId: 'att-keep'
    });
  });

  it('supports ChangeReviewPanel refresh, truncated pagination, stale/uncertain/unavailable states, boundaryRefusal, focusable file list, non-focus-stealing live status, and secondary read-only notice', async () => {
    const classifyResults: Array<ReviewDescriptor> = [
      makeDescriptor({
        reviewId: 'rev_page_1',
        state: 'stale',
        reason: 'target-advanced',
        approval: { eligible: false, reason: 'review-not-current' },
        landing: { eligible: false, reason: 'review-not-current' }
      }),
      makeDescriptor({
        reviewId: 'rev_page_1',
        state: 'uncertain',
        reason: 'target-unreadable',
        approval: { eligible: false, reason: 'review-not-current' },
        landing: { eligible: false, reason: 'review-not-current' }
      })
    ];
    let refreshAttempt = 0;

    mockChangeReview.mockImplementation(async (req) => {
      if (req.op === 'open') {
        return {
          boundaryRefusal: null,
          response: {
            op: 'open',
            editor: { mode: 'none', opened: 0 },
            result: {
              ok: true,
              value: makeOpenedReview(
                {
                  reviewId: 'rev_page_1',
                  total: 3,
                  loaded: 1,
                  truncated: true
                },
                'src/first.ts',
                'cur-page-2'
              )
            }
          }
        };
      }
      if (req.op === 'page') {
        return {
          boundaryRefusal: null,
          response: {
            op: 'page',
            result: {
              ok: true,
              value: {
                reviewId: 'rev_page_1',
                entries: [
                  {
                    index: 1,
                    kind: 'added',
                    oldPath: null,
                    newPath: 'src/second.ts',
                    binary: false,
                    oldHandle: null,
                    newHandle: 'h-2',
                    similarity: null
                  }
                ],
                nextCursor: null
              }
            }
          }
        };
      }
      if (req.op === 'classify') {
        const next = classifyResults.shift()!;
        return {
          boundaryRefusal: null,
          response: { op: 'classify', result: { ok: true, value: next } }
        };
      }
      if (req.op === 'refresh') {
        refreshAttempt += 1;
        if (refreshAttempt === 1) {
          return {
            boundaryRefusal: null,
            response: {
              op: 'refresh',
              editor: { mode: 'none', opened: 0 },
              result: {
                ok: true,
                value: makeOpenedReview({ reviewId: 'rev_refreshed_2', state: 'current' }, 'src/refreshed.ts')
              }
            }
          };
        }
        if (refreshAttempt === 2) {
          return {
            boundaryRefusal: 'Primary window required for change review.',
            response: {
              op: 'refresh',
              editor: { mode: 'none', opened: 0 },
              result: { ok: false, reason: 'workspace-untrusted' }
            }
          };
        }
        return {
          boundaryRefusal: null,
          response: {
            op: 'refresh',
            editor: { mode: 'none', opened: 0 },
            result: {
              ok: true,
              value: {
                state: 'unavailable',
                reason: 'commit-missing',
                review: null,
                firstPage: null
              }
            }
          }
        };
      }
      if (req.op === 'close') {
        return { boundaryRefusal: null, response: { op: 'close', closed: true } };
      }
      return { boundaryRefusal: null, response: { op: 'cancelOpen', canceled: true } };
    });

    const lane = makeLane();
    const { findByTestId, getByTestId, queryByTestId } = render(ChangeReviewPanel, {
      props: { lane, isPrimary: true }
    });

    // Open truncated review
    await fireEvent.click(getByTestId('change-review-inspect-btn'));
    const fileList = await findByTestId('change-review-file-list');
    expect(fileList.classList.contains('cr-files')).toBe(true);
    expect(fileList.getAttribute('tabindex')).toBe('0');
    fileList.focus();
    expect(document.activeElement).toBe(fileList);

    expect(getByTestId('change-review-posture').textContent).toContain(
      'Partial: some values are missing (loaded 1 of 3)'
    );

    const statusEl = getByTestId('change-review-status');
    expect(statusEl.getAttribute('role')).toBe('status');
    expect(statusEl.getAttribute('aria-live')).toBe('polite');

    // Load more files appends entries and announces via live region
    const loadMoreBtn = getByTestId('change-review-load-more');
    await fireEvent.click(loadMoreBtn);
    await vi.waitFor(() => {
      expect(getByTestId('change-review-file-list').textContent).toContain('src/second.ts');
    });
    expect(mockChangeReview).toHaveBeenCalledWith({ op: 'page', cursor: 'cur-page-2' });
    expect(queryByTestId('change-review-load-more')).toBeNull();
    expect(statusEl.textContent).toContain('Showing 2 of 3 changed file(s).');

    // Re-check freshness -> stale, then uncertain; focus stays on the button (live region never steals focus)
    const recheckBtn = getByTestId('change-review-recheck-btn');
    recheckBtn.focus();
    expect(document.activeElement).toBe(recheckBtn);
    await fireEvent.click(recheckBtn);
    await vi.waitFor(() => {
      expect(getByTestId('change-review-posture').getAttribute('data-review-state')).toBe('stale');
    });
    expect(getByTestId('change-review-posture').textContent).toContain(
      'Stale: target or candidate moved (target-advanced)'
    );
    expect(document.activeElement).toBe(recheckBtn);

    await fireEvent.click(recheckBtn);
    await vi.waitFor(() => {
      expect(getByTestId('change-review-posture').getAttribute('data-review-state')).toBe('uncertain');
    });
    expect(getByTestId('change-review-posture').textContent).toContain(
      'Uncertain: could not be confirmed (target-unreadable)'
    );
    expect(document.activeElement).toBe(recheckBtn);

    // Refresh review (op: 'refresh') replaces descriptor and closes previous handle
    const refreshBtn = getByTestId('change-review-refresh-btn');
    refreshBtn.focus();
    await fireEvent.click(refreshBtn);
    await vi.waitFor(() => {
      expect(getByTestId('change-review-file-list').textContent).toContain('src/refreshed.ts');
    });
    expect(mockChangeReview).toHaveBeenCalledWith({
      op: 'refresh',
      reviewId: 'rev_page_1',
      openInEditor: false
    });
    expect(mockChangeReview).toHaveBeenCalledWith({ op: 'close', reviewId: 'rev_page_1' });
    expect(statusEl.textContent).toContain('Refreshed 1 of 1 changed file(s)');
    expect(document.activeElement).toBe(refreshBtn);

    // boundaryRefusal surfaces in polite live region
    await fireEvent.click(refreshBtn);
    await vi.waitFor(() => {
      expect(statusEl.textContent).toBe('Primary window required for change review.');
    });

    // unavailable clears descriptor & renders no partial file inventory, closing previous handle
    await fireEvent.click(refreshBtn);
    const unavail = await findByTestId('change-review-unavailable');
    expect(unavail.textContent).toContain(
      'Unavailable: cannot be shown: commit-missing (no partial file inventory is rendered).'
    );
    expect(queryByTestId('change-review-file-list')).toBeNull();
    expect(queryByTestId('change-review-posture')).toBeNull();
    expect(mockChangeReview).toHaveBeenCalledWith({ op: 'close', reviewId: 'rev_refreshed_2' });

    // Discoverable read-only explanation when !isPrimary
    cleanup();
    const secondary = render(ChangeReviewPanel, { props: { lane, isPrimary: false } });
    expect(secondary.getByTestId('change-review-readonly-note').textContent).toContain(
      'Read-only secondary window'
    );
    expect(secondary.queryByTestId('change-review-inspect-btn')).toBeNull();
    expect(secondary.queryByTestId('change-review-open-editor-btn')).toBeNull();
  });

  it('propagates !isPrimary through HistoryRunDetail (explicit prop and snapshotStore fallback) and passes active runId/primacy from RunDetailTier', async () => {
    mockExecVisibility.mockResolvedValue({
      boundaryRefusal: null,
      response: {
        op: 'attemptDetail',
        detail: makeVisibilityDetail({
          rootExecutionId: 'run-hist-1',
          lane: makeLane(),
          handoffs: [makeWaitingHandoff('ho-sec-1', 'run-hist-1')]
        })
      }
    });

    // 1. Explicit isPrimary={false} overrides even a primary snapshot in snapshotStore
    applyFullSnapshot(1, true);
    const explicitSecondary = render(HistoryRunDetail, {
      props: { row: makeHistoryRow(), onBack: () => undefined, isPrimary: false }
    });
    await explicitSecondary.findByTestId('execution-visibility-posture');
    expect(explicitSecondary.getByTestId('execution-visibility-readonly-note').textContent).toContain(
      'Read-only secondary window'
    );
    expect(explicitSecondary.getByTestId('ev-handoff-readonly-ho-sec-1').textContent).toContain(
      'Read-only secondary window'
    );
    expect(explicitSecondary.getByTestId('change-review-readonly-note').textContent).toContain(
      'Read-only secondary window'
    );
    expect(explicitSecondary.queryByTestId('ev-handoff-approve-ho-sec-1')).toBeNull();
    expect(explicitSecondary.queryByTestId('ev-handoff-edit-ho-sec-1')).toBeNull();
    expect(explicitSecondary.queryByTestId('change-review-inspect-btn')).toBeNull();
    expect(explicitSecondary.queryByTestId('change-review-open-editor-btn')).toBeNull();
    cleanup();

    // 2. Omitting isPrimary falls back to snapshotStore.isPrimary (false), NOT hardcoded true
    snapshotStore.resetSyncState();
    applyFullSnapshot(1, false);
    const fallbackSecondary = render(HistoryRunDetail, {
      props: { row: makeHistoryRow(), onBack: () => undefined }
    });
    await fallbackSecondary.findByTestId('execution-visibility-posture');
    expect(fallbackSecondary.getByTestId('execution-visibility-readonly-note')).toBeTruthy();
    expect(fallbackSecondary.getByTestId('change-review-readonly-note')).toBeTruthy();
    expect(fallbackSecondary.queryByTestId('ev-handoff-approve-ho-sec-1')).toBeNull();
    expect(fallbackSecondary.queryByTestId('change-review-inspect-btn')).toBeNull();
    cleanup();

    // 3. RunDetailTier passes inFlightRun.runId for the executing task, never borrows it for a
    // sibling pending task, and forwards isPrimary={false}
    const activeTask: QueueItem = {
      id: 'task-active',
      label: 'Active task',
      enqueuedAt: '2026-11-11T00:00:00.000Z',
      startedAt: '2026-11-11T00:00:05.000Z',
      updatedAt: '2026-11-11T00:00:05.000Z',
      completedAt: null,
      status: 'in-flight',
      retryCount: 0,
      lastErrorSummary: null,
      pausedReason: null,
      currentPhase: 'implement',
      position: 0,
      phaseProgress: null
    };
    const siblingTask: QueueItem = {
      ...activeTask,
      id: 'task-sibling',
      label: 'Pending sibling task',
      startedAt: null,
      status: 'pending',
      currentPhase: null,
      position: 1
    };
    const runtime = buildQueueRuntime({
      queueId: 'default',
      name: 'Default',
      lifecycle: 'running',
      tasks: [activeTask, siblingTask],
      inFlightRun: buildInFlightRun({
        runId: 'sql-run-uuid-999',
        status: 'running',
        feature: {
          id: 'task-active',
          label: 'Active task',
          startedAt: '2026-11-11T00:00:05.000Z'
        }
      })
    });
    const tierSnap: WorkflowSnapshot = {
      ...makeSnapshot({ isPrimary: false }),
      queues: [runtime]
    };

    mockExecVisibility.mockClear();
    const activeTier = render(RunDetailTier, {
      props: {
        snapshot: tierSnap,
        queueId: 'default',
        runId: 'task-active',
        isPrimary: false,
        onBack: () => undefined
      }
    });
    await fireEvent.click(activeTier.getByTestId('run-tab-context'));
    await activeTier.findByTestId('execution-visibility-posture');
    expect(mockExecVisibility).toHaveBeenCalledWith({
      op: 'attemptDetail',
      rootExecutionId: 'sql-run-uuid-999'
    });
    expect(activeTier.getByTestId('execution-visibility-readonly-note')).toBeTruthy();
    cleanup();

    mockExecVisibility.mockClear();
    const siblingTier = render(RunDetailTier, {
      props: {
        snapshot: tierSnap,
        queueId: 'default',
        runId: 'task-sibling',
        isPrimary: false,
        onBack: () => undefined
      }
    });
    await fireEvent.click(siblingTier.getByTestId('run-tab-context'));
    await siblingTier.findByTestId('execution-visibility-posture');
    expect(mockExecVisibility).toHaveBeenCalledWith({
      op: 'attemptDetail',
      rootExecutionId: 'task-sibling'
    });
  });
});

describe('TelemetryRuntimeHealthPanel (FR-R6-F14 & F10 / R7-17-06)', () => {
  it('renders OTLP authorization, spool bounds, cardinality guard, and live lane caps', async () => {
    mockExecVisibility.mockResolvedValue({
      boundaryRefusal: null,
      response: {
        op: 'runtimePosture',
        posture: makeRuntimePosture()
      }
    });

    const { findByTestId, getByTestId } = render(TelemetryRuntimeHealthPanel);
    await findByTestId('otlp-health-card');
    expect(getByTestId('otlp-health-card').textContent).toContain('Authorized');
    expect(getByTestId('otlp-health-card').textContent).toContain('14 exported');
    expect(getByTestId('lanes-health-card').textContent).toContain('2 / 4 active lane(s)');
  });

  it('surfaces telemetry refusal status and content-export-unsupported reason outside collapsed diagnostics', async () => {
    mockExecVisibility.mockResolvedValue({
      boundaryRefusal: null,
      response: {
        op: 'runtimePosture',
        posture: makeRuntimePosture({
          telemetry: {
            enabled: false,
            stateKind: 'disabled',
            reasonCode: 'content-export-unsupported',
            contentPolicyMode: 'content',
            protocol: null,
            exportedCopyCount: 0,
            previewSummary: 'OTLP export refused: content policy mode unsupported.'
          }
        })
      }
    });

    const { findByTestId, getByTestId } = render(TelemetryRuntimeHealthPanel);
    const otlpCard = await findByTestId('otlp-health-card');
    const refusalNotice = getByTestId('telemetry-refusal-notice');

    // Refusal notice is visibly rendered OUTSIDE the collapsed Diagnostics <details>
    expect(refusalNotice.closest('details')).toBeNull();
    const diagDetails = otlpCard.querySelector('details.diag') as HTMLDetailsElement | null;
    expect(diagDetails).not.toBeNull();
    expect(diagDetails?.open).toBe(false);

    expect(refusalNotice.textContent).toContain('content-export-unsupported');
    expect(refusalNotice.textContent).toContain('content');
    expect(refusalNotice.textContent).toContain('allowlisted metadata only');
    expect(otlpCard.textContent).toContain('Refused (content-export-unsupported)');
    expect(getByTestId('runtime-health-notice').textContent).toBe(
      'Updated runtime posture (refused: content-export-unsupported).'
    );
  });

  it('guards against stale out-of-order posture responses and resynchronizes on visibilitychange and snapshotStore resync', async () => {
    applyFullSnapshot(1, true);

    const slowInitial = createDeferred<VisibilityCallEnvelope<ReadExecutionVisibilityResponse>>();
    const fastReveal = createDeferred<VisibilityCallEnvelope<ReadExecutionVisibilityResponse>>();
    let callCount = 0;

    mockExecVisibility.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) return slowInitial.promise;
      if (callCount === 2) return fastReveal.promise;
      if (callCount === 3) {
        return Promise.resolve({
          boundaryRefusal: null,
          response: {
            op: 'runtimePosture',
            posture: makeRuntimePosture({ telemetry: { exportedCopyCount: 55 } })
          }
        });
      }
      return Promise.resolve({
        boundaryRefusal: null,
        response: {
          op: 'runtimePosture',
          posture: makeRuntimePosture({ telemetry: { exportedCopyCount: 77 } })
        }
      });
    });

    const { findByTestId, getByTestId, queryByTestId } = render(TelemetryRuntimeHealthPanel);
    expect(callCount).toBe(1);

    // Trigger a newer refresh while the initial request is still pending
    setDocumentVisibility('visible');
    await vi.waitFor(() => expect(callCount).toBe(2));

    // Newer response resolves first
    fastReveal.resolve({
      boundaryRefusal: null,
      response: {
        op: 'runtimePosture',
        posture: makeRuntimePosture({
          lanes: { activeLanes: 3 },
          telemetry: { exportedCopyCount: 42 }
        })
      }
    });
    await findByTestId('otlp-health-card');
    expect(getByTestId('otlp-health-card').textContent).toContain('42 exported');
    expect(getByTestId('lanes-health-card').textContent).toContain('3 / 4 active lane(s)');

    // Earlier slow response resolves AFTER newer response — must NOT overwrite state
    slowInitial.resolve({
      boundaryRefusal: null,
      response: {
        op: 'runtimePosture',
        posture: makeRuntimePosture({
          lanes: { activeLanes: 0 },
          telemetry: {
            enabled: false,
            stateKind: 'disabled',
            reasonCode: 'content-export-unsupported',
            contentPolicyMode: 'content',
            exportedCopyCount: 1
          }
        })
      }
    });
    await tick();
    expect(getByTestId('otlp-health-card').textContent).toContain('42 exported');
    expect(getByTestId('lanes-health-card').textContent).toContain('3 / 4 active lane(s)');
    expect(queryByTestId('telemetry-refusal-notice')).toBeNull();

    // Hiding document does not dispatch a refresh
    setDocumentVisibility('hidden');
    await tick();
    expect(callCount).toBe(2);

    // Revealing document dispatches refresh #3
    setDocumentVisibility('visible');
    await vi.waitFor(() => {
      expect(callCount).toBe(3);
      expect(getByTestId('otlp-health-card').textContent).toContain('55 exported');
    });

    // snapshotStore resync dispatches refresh #4
    triggerSnapshotResync(3, true);
    await vi.waitFor(() => {
      expect(callCount).toBe(4);
      expect(getByTestId('otlp-health-card').textContent).toContain('77 exported');
    });
  });
});
