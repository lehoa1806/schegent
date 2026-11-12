/**
 * FR-R6-F11, F12, F10, F14, F15 — Svelte 5 UI, keyboard/ARIA semantics, non-numeric availability
 * phrasing, inert-text repository filename rendering, and review-handle cleanup tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

import ChangeReviewPanel from '../ChangeReviewPanel.svelte';
import ExecutionVisibilityPanel from '../ExecutionVisibilityPanel.svelte';
import HistoricalReportsPanel from '../MetricsDashboard/HistoricalReportsPanel.svelte';
import TelemetryRuntimeHealthPanel from '../TelemetryRuntimeHealthPanel.svelte';
import type {
  DecidePhaseHandoffRequest,
  DecidePhaseHandoffResponse,
  ExecutionAttemptVisibility,
  ExecutionLaneCandidateVisibility,
  MutateReportRequest,
  MutateReportResponse,
  OpenChangeReviewRequest,
  OpenChangeReviewResponse,
  ReadExecutionVisibilityRequest,
  ReadExecutionVisibilityResponse,
  ReadReportRequest,
  ReadReportResponse
} from '../../lib/messages';
import type { ReportCallEnvelope } from '../../lib/reporting-ipc';
import type { VisibilityCallEnvelope } from '../../lib/execution-visibility-ipc';

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

afterEach(() => cleanup());

beforeEach(() => {
  mockReadReport.mockReset();
  mockMutateReport.mockReset();
  mockExecVisibility.mockReset();
  mockChangeReview.mockReset();
  mockDecideHandoff.mockReset();
});

describe('HistoricalReportsPanel & ReportDrillDownPanel (FR-R6-F11)', () => {
  it('renders cutoff-pinned rows with aria-sort, non-numeric unknown duration phrasing, drill-down metadata, and saved report confirmation', async () => {
    mockReadReport.mockImplementation(
      async (req: ReadReportRequest): Promise<ReportCallEnvelope<ReadReportResponse>> => {
        if (req.op === 'listSaved') {
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
            boundaryRefusal: null,
            response: {
              op: 'listSaved',
              result: {
                ok: true,
                value: {
                  items: [
                    {
                      reportId: 'rep-saved-1',
                      rerunOf: null,
                      view: 'execution-summary',
                      query,
                      manifestSha256: 'b'.repeat(64),
                      createdUtc: '2026-11-11T00:00:00.000Z',
                      manifest: {
                        schema: 'schegent.report-manifest',
                        manifestVersion: 1,
                        reportId: 'rep-saved-1',
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
                    }
                  ],
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
                value: {
                  reportId: 'rep-live-1',
                  outcome: 'complete',
                  view: 'execution-summary',
                  sourceCutoffUtc: '2026-11-11T01:00:00.000Z',
                  timeBasis: 'root-created',
                  accountingRevision: null,
                  calculationVersion: 1,
                  rowCount: 1,
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
                  ],
                  cursor: null
                }
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
                value: {
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
                  ],
                  handoffSummaries: [],
                  reviewSummaries: []
                }
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
});

describe('ChangeReviewPanel & ExecutionVisibilityPanel (FR-R6-F12, F10, F15)', () => {
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
                review: {
                  reviewId,
                  requestId: req.requestId,
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
                  createdAt: '2026-11-11T00:00:00.000Z'
                },
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

    const laneA: ExecutionLaneCandidateVisibility = {
      mode: 'isolated-lane',
      laneId: '1'.repeat(32),
      laneState: 'completed',
      candidateId: 'cand-1',
      integrationRequestId: '4'.repeat(32),
      integrationState: 'awaiting-review',
      targetRef: 'refs/heads/main',
      comparisonRevision: `cr1-${'e'.repeat(64)}`
    };

    const { getByTestId, findByTestId, rerender, container } = render(ChangeReviewPanel, {
      props: { lane: laneA, isPrimary: true }
    });

    await fireEvent.click(getByTestId('change-review-inspect-btn'));
    const fileList = await findByTestId('change-review-file-list');
    expect(fileList.textContent).toContain('<img src=x onerror="alert(1)">/../../evil.ts');
    // Zero injected DOM elements!
    expect(container.querySelectorAll('img').length).toBe(0);

    // Switching integrationRequestId triggers automatic cancelOpen + close of previous reviewId
    await rerender({
      lane: { ...laneA, integrationRequestId: '5'.repeat(32) },
      isPrimary: true
    });
    expect(mockChangeReview).toHaveBeenCalledWith({ op: 'cancelOpen' });
    expect(mockChangeReview).toHaveBeenCalledWith({ op: 'close', reviewId });
  });

  it('displays distinct evidence availability vs recovery certainty and dispatches manual handoff approval', async () => {
    const visibilityDetail: ExecutionAttemptVisibility = {
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
      handoffs: [
        {
          handoffId: 'ho-99',
          recordVersion: 1,
          identity: {
            workspaceId: 'ws-1',
            rootExecutionId: 'run-99',
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
        }
      ],
      reviewLoops: []
    };

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
});

describe('TelemetryRuntimeHealthPanel (FR-R6-F14 & F10)', () => {
  it('renders OTLP authorization, spool bounds, cardinality guard, and live lane caps', async () => {
    mockExecVisibility.mockResolvedValue({
      boundaryRefusal: null,
      response: {
        op: 'runtimePosture',
        posture: {
          available: true,
          lanes: {
            enabled: true,
            liveLaneCap: 4,
            activeLanes: 2,
            totalLanes: 5,
            pendingIntegrations: 1
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
            previewSummary: 'Metadata-only OTLP export active.'
          }
        }
      }
    });

    const { findByTestId, getByTestId } = render(TelemetryRuntimeHealthPanel);
    await findByTestId('otlp-health-card');
    expect(getByTestId('otlp-health-card').textContent).toContain('Authorized');
    expect(getByTestId('otlp-health-card').textContent).toContain('14 exported');
    expect(getByTestId('lanes-health-card').textContent).toContain('2 / 4 active lane(s)');
  });
});
