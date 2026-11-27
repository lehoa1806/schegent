/**
 * FR-R6-F11 (F11-AC-01..09; FR-001..FR-023) — host integration test for historical reporting,
 * cross-source root drill-down, host-dialog exports, saved reports, active-query cancellation,
 * and window trust/primacy gating through the production `MessageRouter`.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CMD_MUTATE_REPORT,
  CMD_READ_REPORT,
  type HostReportExportResult,
  type MutateReportRequest,
  type ReadReportRequest,
  type ReadReportResponse
} from '../../../src/contracts/sidebar-ipc';
import {
  isValidMutateReportResponse,
  isValidReadReportResponse
} from '../../../src/contracts/runtime-validators';
import { createReportingApi } from '../../../src/headless/reporting-api';
import {
  createAcceptanceService,
  createSqliteHandoffStore,
  prepareHandoff
} from '../../../src/services/phase-context';
import { nodeExportFs, type ExportFs } from '../../../src/services/reporting/export-publisher';
import {
  createReportingService,
  type ReportingService,
  type ReportingServiceBounds
} from '../../../src/services/reporting';
import { toUtcIso } from '../../../src/services/reporting/report-time';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import {
  createUsageAccountingService,
  type UsageAccountingService
} from '../../../src/services/usage-accounting/usage-accounting-service';
import { SECONDARY_REJECT, UNTRUSTED_REJECT } from '../../../src/ui/sidebar/commands/constants';
import type { RouterDeps } from '../../../src/ui/sidebar/commands/router-types';
import { MessageRouter } from '../../../src/ui/sidebar/message-router';
import type { CommandAckMessage, SidebarCommand } from '../../../src/ui/sidebar/messages';
import { candidate, digestOf, identityFor, policy, profile } from '../../fixtures/phase-context/builders';

const WORKSPACE_ID = 'ws-f11-int';
const BASE_NOW_MS = 1_800_000_000_000;
const DAY_MS = 86_400_000;

describe('FR-R6-F11 host reporting integration through MessageRouter', () => {
  let tempDir: string;
  let workspaceRoot: string;
  let exportDir: string;
  let conn: NodeSqliteConnection;
  let nowMs: number;
  let trusted: boolean;
  let primary: boolean;
  let dialogTarget: string | null;
  let accounting: UsageAccountingService;
  let reportingService: ReportingService;
  let router: MessageRouter;
  let corrSeq: number;

  beforeEach(async () => {
    const rawTemp = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-f11-host-'));
    tempDir = await fs.realpath(rawTemp);
    workspaceRoot = path.join(tempDir, 'workspace');
    exportDir = path.join(tempDir, 'exports');
    await fs.mkdir(path.join(workspaceRoot, '.schegent'), { recursive: true });
    await fs.mkdir(exportDir, { recursive: true });

    nowMs = BASE_NOW_MS;
    trusted = true;
    primary = true;
    dialogTarget = null;
    corrSeq = 0;

    conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    SchemaBootstrapService.bootstrapAndMigrate(conn, () => nowMs);

    accounting = createUsageAccountingService({
      conn,
      nowUtc: () => toUtcIso(nowMs),
      monotonicMs: () => 1,
      workspaceId: WORKSPACE_ID,
      bounds: {}
    });

    reportingService = createReportingService({
      conn,
      workspaceId: WORKSPACE_ID,
      workspaceRoot,
      nowMs: () => nowMs,
      monotonicMs: () => 1,
      hostTimezone: 'UTC',
      accounting
    });

    const reportingApi = createReportingApi(reportingService, {
      isWorkspaceTrusted: () => trusted
    });

    const exportReportWithDialog = async (req: {
      readonly reportId: string;
      readonly format: 'json' | 'csv';
    }): Promise<HostReportExportResult> => {
      if (dialogTarget === null) {
        return { outcome: 'dialog-canceled' };
      }
      const result = await reportingApi.exportReport({
        reportId: req.reportId,
        format: req.format,
        destination: { scheme: 'file', fsPath: dialogTarget },
        overwrite: true
      });
      return { outcome: 'completed', result };
    };

    const deps = {
      executeCommand: vi.fn(async () => undefined),
      isPrimary: () => primary,
      isTrusted: () => trusted,
      notifyWarning: vi.fn(),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      },
      reportingApi: () => reportingApi,
      exportReportWithDialog
    } as unknown as RouterDeps;

    router = new MessageRouter(deps);
  });

  afterEach(async () => {
    conn.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function dispatchRead(payload: ReadReportRequest): Promise<CommandAckMessage> {
    const acks: CommandAckMessage[] = [];
    corrSeq += 1;
    const cmd: SidebarCommand = {
      type: CMD_READ_REPORT,
      correlationId: `read-${payload.op}-${String(corrSeq)}`,
      payload
    };
    await router.dispatch(cmd, async (ack) => {
      acks.push(ack);
      return true;
    });
    const first = acks.at(0);
    if (first === undefined) throw new Error('missing ack');
    return first;
  }

  async function dispatchMutate(payload: MutateReportRequest): Promise<CommandAckMessage> {
    const acks: CommandAckMessage[] = [];
    corrSeq += 1;
    const cmd: SidebarCommand = {
      type: CMD_MUTATE_REPORT,
      correlationId: `mut-${payload.op}-${String(corrSeq)}`,
      payload
    };
    await router.dispatch(cmd, async (ack) => {
      acks.push(ack);
      return true;
    });
    const first = acks.at(0);
    if (first === undefined) throw new Error('missing ack');
    return first;
  }

  function seedFullRun(runId: string, createdAtMs: number, workflowId = 'wf-ship'): void {
    conn.run(
      `INSERT INTO runs (
        run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
        current_step_id, started_at_ms, completed_at_ms, terminal_reason,
        created_at_ms, updated_at_ms, backend_kind, model_id, profile_id, lane_id, invocation_count
      ) VALUES (?, ?, ?, ?, 'succeeded', 1, NULL, ?, ?, NULL, ?, ?, 'claude', 'claude-sonnet-4-6', 'claude-acp', 'lane-1', 2)`,
      runId,
      WORKSPACE_ID,
      workflowId,
      `fc-${runId}`,
      createdAtMs + 100,
      createdAtMs + 5_100,
      createdAtMs,
      createdAtMs + 5_100
    );
    const stepId = `${runId}-step-0`;
    const attemptId = `${runId}-att-1`;
    conn.run(
      `INSERT INTO steps (step_id, run_id, step_index, phase_id, status, revision, current_attempt_id, updated_at_ms)
       VALUES (?, ?, 0, 'implement', 'succeeded', 1, ?, ?)`,
      stepId,
      runId,
      attemptId,
      createdAtMs + 5_100
    );
    conn.run(
      `INSERT INTO attempts (
        attempt_id, run_id, step_id, attempt_number, status, exit_code,
        started_at_ms, completed_at_ms, backend_kind, model_id, profile_id, lane_id, failure_cause
      ) VALUES (?, ?, ?, 1, 'succeeded', 0, ?, ?, 'claude', 'claude-sonnet-4-6', 'claude-acp', 'lane-1', NULL)`,
      attemptId,
      runId,
      stepId,
      createdAtMs + 100,
      createdAtMs + 5_100
    );
  }

  it('pins report snapshots against concurrent writes and serves cross-source drill-down with live-only ACP attribution (AC-01..04)', async () => {
    const t1 = BASE_NOW_MS - 3_600_000;
    seedFullRun('run-alpha', t1, '=cmd|calc');

    // Seed F05 artifact lifecycle row
    conn.run(
      `INSERT INTO artifacts (artifact_id, content_sha256, byte_length, media_type, kind, created_by_run_id, created_by_attempt_id, created_at_ms)
       VALUES ('art-alpha', ?, 512, 'application/json', 'diagnostic', 'run-alpha', 'run-alpha-att-1', ?)`,
      'a'.repeat(64),
      t1 + 500
    );
    conn.run(
      `INSERT INTO artifact_lifecycle (
        artifact_id, lifecycle_revision, owner_run_id, owner_attempt_id, sensitivity,
        retention_class, store_kind, immutability, digest_algorithm, digest_value,
        generation, extent_bytes, byte_size, availability, producer_identity,
        display_name, created_at_ms, terminal_settled_at_ms, expires_at_ms, updated_at_ms
      ) VALUES (
        'art-alpha', 1, 'run-alpha', 'run-alpha-att-1', 'metadata',
        'transcripts-diagnostics-checkpoints-audit-catalog', 'diagnostic', 'immutable', 'sha256', ?,
        NULL, NULL, 512, 'present', 'runner', 'diag.json', ?, ?, NULL, ?
      )`,
      'a'.repeat(64),
      t1 + 500,
      t1 + 5_100,
      t1 + 5_100
    );

    // Seed F13 ACP observations: 2 live + 1 history replay (history must NOT count!)
    for (const [seq, origin] of [
      [1, 'live'],
      [2, 'live'],
      [3, 'history']
    ] as const) {
      conn.run(
        `INSERT INTO acp_observation_ledger (
          observation_key, profile_id, connection_generation, host_receive_seq,
          acp_session_id, turn_id, attempt_id, origin, kind, payload_sha256, observed_at_ms
        ) VALUES (?, 'claude-acp', 1, ?, 'sess-1', 'turn-1', 'run-alpha-att-1', ?, 'message_chunk', ?, ?)`,
        `obs-${String(seq)}`,
        seq,
        origin,
        'b'.repeat(64),
        t1 + 1_000 + seq
      );
    }

    // Seed F15 handoff & review-loop ledger
    conn.run(
      `INSERT INTO phase_handoff_records (
        handoff_id, run_id, source_attempt_id, target_phase_id, revision, status, record_json, record_bytes, created_at_ms, updated_at_ms
      ) VALUES ('ho-alpha', 'run-alpha', 'run-alpha-att-1', 'verify', 1, 'accepted', '{}', 2, ?, ?)`,
      t1 + 2_000,
      t1 + 2_000
    );
    conn.run(
      `INSERT INTO phase_review_loop_ledgers (
        loop_id, run_id, node_id, iteration, verdict, ledger_json, updated_at_ms
      ) VALUES ('loop-alpha', 'run-alpha', 'review-node', 2, 'needs-fixes', ?, ?)`,
      JSON.stringify({
        schemaVersion: 1,
        candidateRef: 'cand-alpha',
        snapshot: {
          findings: [{ status: 'open' }, { status: 'resolved' }, { status: 'open' }]
        }
      }),
      t1 + 3_000
    );

    const runAck = await dispatchRead({
      op: 'run',
      query: {
        view: 'execution-summary',
        range: { startMs: BASE_NOW_MS - DAY_MS, endMs: BASE_NOW_MS },
        sort: 'root-created-desc',
        pageSize: 1
      }
    });
    expect(runAck.status).toBe('accepted');
    expect(isValidReadReportResponse(runAck.result)).toBe(true);
    const runRes = runAck.result as Extract<ReadReportResponse, { readonly op: 'run' }>;
    if (!runRes.result.ok) throw new Error('expected ok runReport');
    const reportId = runRes.result.value.reportId;
    expect(runRes.result.value.rowCount).toBe(1);

    // Concurrent write AFTER snapshot capture must not leak into drill-down or pages
    seedFullRun('run-beta', t1 + 10_000);

    const drillAck = await dispatchRead({
      op: 'drillDown',
      reportId,
      rootId: 'run-alpha'
    });
    expect(drillAck.status).toBe('accepted');
    expect(isValidReadReportResponse(drillAck.result)).toBe(true);
    const drillRes = drillAck.result as Extract<ReadReportResponse, { readonly op: 'drillDown' }>;
    if (!drillRes.result.ok) throw new Error('expected ok drillDown');
    const detail = drillRes.result.value;

    expect(detail.root.rootId).toBe('run-alpha');
    expect(detail.evidenceRefs).toHaveLength(1);
    expect(detail.evidenceRefs?.at(0)?.availability).toBe('present');
    expect(detail.acpAttributions).toHaveLength(1);
    expect(detail.acpAttributions?.at(0)?.liveObservations).toBe(2);
    expect(detail.handoffSummaries).toHaveLength(1);
    expect(detail.handoffSummaries?.at(0)?.targetPhaseId).toBe('verify');
    expect(detail.reviewSummaries).toHaveLength(1);
    expect(detail.reviewSummaries?.at(0)?.openFindings).toBe(2);
    expect(detail.reviewSummaries?.at(0)?.resolvedFindings).toBe(1);

    // Concurrent run-beta is unknown to the pinned snapshot
    const betaDrillAck = await dispatchRead({
      op: 'drillDown',
      reportId,
      rootId: 'run-beta'
    });
    expect(betaDrillAck.status).toBe('rejected');

    // Close releases the snapshot lease
    const closeAck = await dispatchRead({ op: 'close', reportId });
    expect(closeAck.status).toBe('accepted');
    expect(reportingService.resources().liveReports).toBe(0);
  });

  it('exports CSV and JSON with 0600 permissions, neutralizes spreadsheet formulas, handles dialog cancel, and manages saved reports (AC-05..09)', async () => {
    const t1 = BASE_NOW_MS - 7_200_000;
    seedFullRun('run-export-1', t1, '=SUM(A1:A2)');

    const runAck = await dispatchRead({
      op: 'run',
      query: {
        view: 'execution-summary',
        range: { startMs: BASE_NOW_MS - DAY_MS, endMs: BASE_NOW_MS }
      }
    });
    const runRes = runAck.result as Extract<ReadReportResponse, { readonly op: 'run' }>;
    if (!runRes.result.ok) throw new Error('expected report');
    const reportId = runRes.result.value.reportId;

    // 1. Dialog canceled writes nothing
    dialogTarget = null;
    const cancelExportAck = await dispatchMutate({ op: 'export', reportId, format: 'csv' });
    expect(cancelExportAck.status).toBe('rejected');
    expect(isValidMutateReportResponse(cancelExportAck.result)).toBe(true);
    expect((await fs.readdir(exportDir)).length).toBe(0);

    // 2. CSV export writes 0600 data + manifest sidecar and neutralizes leading `=`
    const csvTarget = path.join(exportDir, 'summary-report.csv');
    dialogTarget = csvTarget;
    const csvAck = await dispatchMutate({ op: 'export', reportId, format: 'csv' });
    expect(csvAck.status).toBe('accepted');
    expect(isValidMutateReportResponse(csvAck.result)).toBe(true);
    const csvStat = await fs.stat(csvTarget);
    expect(csvStat.mode & 0o777).toBe(0o600);
    const csvText = await fs.readFile(csvTarget, 'utf8');
    expect(csvText).toContain('"text:=SUM(A1:A2)"');
    // Verify no filesystem path leaked into IPC response
    expect(JSON.stringify(csvAck.result)).not.toContain(exportDir);

    // 3. JSON export writes 0600 JSON + manifest sidecar
    const jsonTarget = path.join(exportDir, 'summary-report.json');
    dialogTarget = jsonTarget;
    const jsonAck = await dispatchMutate({ op: 'export', reportId, format: 'json' });
    expect(jsonAck.status).toBe('accepted');
    const jsonStat = await fs.stat(jsonTarget);
    expect(jsonStat.mode & 0o777).toBe(0o600);

    // 4. Saved report lifecycle: save -> listSaved -> reproduceSaved -> rerunSaved -> deleteSaved
    const saveAck = await dispatchMutate({ op: 'save', reportId });
    expect(saveAck.status).toBe('accepted');

    const listAck = await dispatchRead({ op: 'listSaved', request: { limit: 10 } });
    expect(listAck.status).toBe('accepted');
    const listRes = listAck.result as Extract<ReadReportResponse, { readonly op: 'listSaved' }>;
    if (!listRes.result.ok) throw new Error('expected saved list');
    expect(listRes.result.value.items.map((i) => i.reportId)).toContain(reportId);

    const reproAck = await dispatchRead({ op: 'reproduceSaved', reportId });
    expect(reproAck.status).toBe('accepted');
    const reproRes = reproAck.result as Extract<
      ReadReportResponse,
      { readonly op: 'reproduceSaved' }
    >;
    if (!reproRes.result.ok) throw new Error('expected reproduce verdict');
    expect(reproRes.result.value.verdict).toBe('reproduced');

    nowMs += 60_000;
    const rerunAck = await dispatchRead({ op: 'rerunSaved', reportId });
    expect(rerunAck.status).toBe('accepted');

    const delAck = await dispatchMutate({ op: 'deleteSaved', reportId, confirmed: true });
    expect(delAck.status).toBe('accepted');

    // 5. CancelActive answers cleanly
    const cancelQueryAck = await dispatchRead({ op: 'cancelActive' });
    expect(cancelQueryAck.status).toBe('accepted');

    // 6. Untrusted & secondary window gating: mutating report commands refused before handler; reads allowed
    trusted = false;
    const untrustedMut = await dispatchMutate({ op: 'save', reportId });
    expect(untrustedMut.status).toBe('rejected');
    expect(untrustedMut.reason).toBe(UNTRUSTED_REJECT);
    const untrustedRead = await dispatchRead({ op: 'listSaved' });
    expect(untrustedRead.status).toBe('accepted');

    trusted = true;
    primary = false;
    const secondaryMut = await dispatchMutate({ op: 'save', reportId });
    expect(secondaryMut.status).toBe('rejected');
    expect(secondaryMut.reason).toBe(SECONDARY_REJECT);
  });

  function buildRouterWith(options: {
    readonly bounds?: ReportingServiceBounds;
    readonly monotonicMs?: () => number;
    readonly exportFs?: ExportFs;
  }): { readonly service: ReportingService; readonly customRouter: MessageRouter } {
    const svc = createReportingService({
      conn,
      workspaceId: WORKSPACE_ID,
      workspaceRoot,
      nowMs: () => nowMs,
      monotonicMs: options.monotonicMs ?? (() => 1),
      hostTimezone: 'UTC',
      accounting,
      ...(options.bounds === undefined ? {} : { bounds: options.bounds }),
      ...(options.exportFs === undefined ? {} : { exportFs: options.exportFs })
    });
    const api = createReportingApi(svc, { isWorkspaceTrusted: () => trusted });
    const customDeps = {
      executeCommand: vi.fn(async () => undefined),
      isPrimary: () => primary,
      isTrusted: () => trusted,
      notifyWarning: vi.fn(),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      },
      reportingApi: () => api,
      exportReportWithDialog: async (req: { readonly reportId: string; readonly format: 'json' | 'csv' }) => {
        if (dialogTarget === null) return { outcome: 'dialog-canceled' as const };
        const result = await api.exportReport({
          reportId: req.reportId,
          format: req.format,
          destination: { scheme: 'file', fsPath: dialogTarget },
          overwrite: true
        });
        return { outcome: 'completed' as const, result };
      }
    } as unknown as RouterDeps;
    return { service: svc, customRouter: new MessageRouter(customDeps) };
  }

  async function dispatchReadOn(
    targetRouter: MessageRouter,
    payload: ReadReportRequest
  ): Promise<CommandAckMessage> {
    const acks: CommandAckMessage[] = [];
    corrSeq += 1;
    await targetRouter.dispatch(
      { type: CMD_READ_REPORT, correlationId: `custom-read-${payload.op}-${String(corrSeq)}`, payload },
      async (ack) => {
        acks.push(ack);
        return true;
      }
    );
    const first = acks.at(0);
    if (first === undefined) throw new Error('missing ack');
    return first;
  }

  it('exercises all 6 reporting views, supported filters, typed unsupported-dimension refusals, and distinct counts/unknowns through MessageRouter (R7-17-01)', async () => {
    const tBase = BASE_NOW_MS - 3_600_000;
    // 1. Multi-attempt retry run (1 root, 2 attempts)
    seedFullRun('run-retry', tBase, 'wf-retry');
    conn.run(
      `INSERT INTO attempts (
        attempt_id, run_id, step_id, attempt_number, status, exit_code,
        started_at_ms, completed_at_ms, backend_kind, model_id, profile_id, lane_id, failure_cause
      ) VALUES ('run-retry-att-2', 'run-retry', 'run-retry-step-0', 2, 'failed', 1, ?, ?, 'claude', 'claude-sonnet-4-6', 'claude-acp', 'lane-1', 'timeout')`,
      tBase + 6_000,
      tBase + 12_000
    );
    // 2. Failed run (for failure-cause)
    conn.run(
      `INSERT INTO runs (
        run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
        current_step_id, started_at_ms, completed_at_ms, terminal_reason,
        created_at_ms, updated_at_ms, backend_kind, model_id, profile_id, lane_id, invocation_count
      ) VALUES ('run-fail', ?, 'wf-fail', 'fc-fail', 'failed', 1, NULL, ?, ?, 'timeout', ?, ?, 'codex', 'o3', 'codex-acp', 'lane-2', 1)`,
      WORKSPACE_ID,
      tBase + 10_000,
      tBase + 30_000,
      tBase + 10_000,
      tBase + 30_000
    );
    // 3. Running run with unknown duration + zero attempts
    conn.run(
      `INSERT INTO runs (
        run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
        current_step_id, started_at_ms, completed_at_ms, terminal_reason,
        created_at_ms, updated_at_ms, backend_kind, model_id, profile_id, lane_id, invocation_count
      ) VALUES ('run-open', ?, 'wf-open', 'fc-open', 'running', 1, NULL, ?, NULL, NULL, ?, ?, 'claude', 'claude-sonnet-4-6', 'claude-acp', NULL, 0)`,
      WORKSPACE_ID,
      tBase + 20_000,
      tBase + 20_000,
      tBase + 20_000
    );

    // Seed F06 usage (reported + unknown cost)
    const eventUtc = toUtcIso(tBase + 5_000);
    expect(
      accounting.ingestObservation({
        producerNamespace: 'schegent.phase-end/1',
        source: 'phase-end',
        sourceKind: 'phase-end',
        sourceIdentity: 'run-retry-att-1:0',
        rootId: 'run-retry',
        attemptId: 'run-retry-att-1',
        invocationOrdinal: 0,
        counterScope: 'invocation-delta',
        adapterVersion: 'test/1',
        dimensions: { backend: 'claude', modelRequested: 'claude-sonnet-4-6', phaseId: 'implement' },
        eventUtc,
        observedUtc: eventUtc,
        measures: [
          { measure: 'input_tokens', quantity: 250, unit: 'count', provenance: 'provider-reported' },
          { measure: 'cost', quantity: '0.12', unit: 'USD', provenance: 'provider-reported' }
        ]
      }).ok
    ).toBe(true);
    expect(
      accounting.ingestObservation({
        producerNamespace: 'schegent.phase-end/1',
        source: 'phase-end',
        sourceKind: 'phase-end',
        sourceIdentity: 'run-retry-att-2:0',
        rootId: 'run-retry',
        attemptId: 'run-retry-att-2',
        invocationOrdinal: 0,
        counterScope: 'invocation-delta',
        adapterVersion: 'test/1',
        dimensions: { backend: 'codex', modelRequested: 'o3', phaseId: 'implement' },
        eventUtc,
        observedUtc: eventUtc,
        measures: [
          { measure: 'input_tokens', quantity: 100, unit: 'count', provenance: 'provider-reported' },
          { measure: 'cost', quantity: null, unit: 'USD', provenance: 'provider-reported', completeness: 'unknown', unknownReason: 'not-reported' }
        ]
      }).ok
    ).toBe(true);

    const range = { startMs: BASE_NOW_MS - DAY_MS, endMs: BASE_NOW_MS };
    const views = [
      'execution-summary',
      'attempt-detail',
      'failure-cause',
      'workflow-revision',
      'time-series',
      'usage'
    ] as const;

    for (const view of views) {
      const ack = await dispatchRead({ op: 'run', query: { view, range, timezone: 'UTC' } });
      expect(ack.status).toBe('accepted');
      expect(isValidReadReportResponse(ack.result)).toBe(true);
      const res = ack.result as Extract<ReadReportResponse, { readonly op: 'run' }>;
      if (!res.result.ok) throw new Error(`expected ok for view ${view}`);
      expect(res.result.value.view).toBe(view);
      expect(res.result.value.rows.length).toBeGreaterThan(0);

      if (view === 'execution-summary') {
        expect(res.result.value.coverage).toMatchObject({ roots: 3, attempts: 2, unknownDurations: 1 });
      }
      if (view === 'attempt-detail') {
        expect(res.result.value.rows.every((r) => r.kind === 'attempt')).toBe(true);
        expect(res.result.value.rows).toHaveLength(2);
      }
      if (view === 'workflow-revision') {
        const openGroup = res.result.value.rows.find(
          (r) => r.kind === 'group' && r.key?.workflowId === 'wf-open'
        );
        expect(openGroup?.kind === 'group' && openGroup.rootDuration.p50).toBe('unavailable');
      }
      if (view === 'usage') {
        const usageRows = res.result.value.rows.filter((r) => r.kind === 'usage');
        expect(usageRows).toHaveLength(2);
        expect(usageRows.map((r) => r.invocations)).toEqual(['not-recorded', 'not-recorded']);
        const codexCost = usageRows.find((r) => r.key.backend === 'codex')?.measures.find((m) => m.measure === 'cost');
        expect(codexCost).toMatchObject({ completeness: 'unknown', coverage: { known: 0, denominator: 1 } });
      }

      await dispatchRead({ op: 'close', reportId: res.result.value.reportId });
    }

    // Supported filters through MessageRouter
    const filteredRunAck = await dispatchRead({
      op: 'run',
      query: { view: 'execution-summary', range, filters: { workflowId: ['wf-fail'], outcome: ['failed'] } }
    });
    expect(filteredRunAck.status).toBe('accepted');
    const filteredRunRes = filteredRunAck.result as Extract<ReadReportResponse, { readonly op: 'run' }>;
    if (!filteredRunRes.result.ok) throw new Error('expected ok filtered run');
    expect(filteredRunRes.result.value.rowCount).toBe(1);
    await dispatchRead({ op: 'close', reportId: filteredRunRes.result.value.reportId });

    const filteredUsageAck = await dispatchRead({
      op: 'run',
      query: { view: 'usage', range, filters: { rootId: ['run-retry'], backend: ['claude'], model: ['claude-sonnet-4-6'] } }
    });
    expect(filteredUsageAck.status).toBe('accepted');
    const filteredUsageRes = filteredUsageAck.result as Extract<ReadReportResponse, { readonly op: 'run' }>;
    if (!filteredUsageRes.result.ok) throw new Error('expected ok filtered usage');
    expect(filteredUsageRes.result.value.rowCount).toBe(1);
    await dispatchRead({ op: 'close', reportId: filteredUsageRes.result.value.reportId });

    // Unsupported-dimension refusals across all 6 views through MessageRouter
    const unsupportedQueries = [
      { view: 'execution-summary' as const, range, filters: { backend: ['claude'] } },
      { view: 'attempt-detail' as const, range, groupBy: ['workflowId' as const] },
      { view: 'failure-cause' as const, range, filters: { model: ['o3'] } },
      { view: 'workflow-revision' as const, range, groupBy: ['outcome' as const] },
      { view: 'time-series' as const, range, groupBy: ['frozenDefinitionId' as const] },
      { view: 'usage' as const, range, filters: { workflowId: ['wf-retry'] } },
      { view: 'usage' as const, range, groupBy: ['localDay' as const] }
    ];
    for (const query of unsupportedQueries) {
      const ack = await dispatchRead({ op: 'run', query });
      expect(ack.status).toBe('rejected');
      expect(isValidReadReportResponse(ack.result)).toBe(true);
      expect(ack.result).toEqual({
        op: 'run',
        result: { ok: false, outcome: 'refused', reason: 'unsupported-dimension' }
      });
    }
  });

  it('accepts null frozenDefinitionId drillDown through egress validator, excludes non-accepted handoffs & post-cutoff joins (R7-17-01)', async () => {
    const t1 = BASE_NOW_MS - 3_600_000;
    conn.run(
      `INSERT INTO runs (
        run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
        current_step_id, started_at_ms, completed_at_ms, terminal_reason,
        created_at_ms, updated_at_ms, backend_kind, model_id, profile_id, lane_id, invocation_count
      ) VALUES ('run-null-fz', ?, 'wf-null', NULL, 'succeeded', 1, NULL, ?, ?, NULL, ?, ?, 'claude', 'claude-sonnet-4-6', 'claude-acp', NULL, 1)`,
      WORKSPACE_ID,
      t1 + 100,
      t1 + 5_000,
      t1,
      t1 + 5_000
    );
    conn.run(
      `INSERT INTO steps (step_id, run_id, step_index, phase_id, status, revision, current_attempt_id, updated_at_ms)
       VALUES ('run-null-fz-s0', 'run-null-fz', 0, 'implement', 'succeeded', 1, 'run-null-fz-a1', ?)`,
      t1 + 5_000
    );
    conn.run(
      `INSERT INTO attempts (
        attempt_id, run_id, step_id, attempt_number, status, exit_code,
        started_at_ms, completed_at_ms, backend_kind, model_id, profile_id, lane_id, failure_cause
      ) VALUES ('run-null-fz-a1', 'run-null-fz', 'run-null-fz-s0', 1, 'succeeded', 0, ?, ?, 'claude', 'claude-sonnet-4-6', 'claude-acp', NULL, NULL)`,
      t1 + 100,
      t1 + 5_000
    );

    // Evidence refs across all 4 availability states + post-cutoff excluded + separator scrubbing
    for (const [artifactId, availability, createdMs] of [
      ['art/a\\present', 'present', t1 + 500],
      ['art-missing', 'missing', t1 + 600],
      ['art-deleted', 'deleted', t1 + 700],
      ['art-expired', 'expired', t1 + 800],
      ['art-post-cutoff', 'present', BASE_NOW_MS + 1_000]
    ] as const) {
      conn.run(
        `INSERT INTO artifacts (artifact_id, content_sha256, byte_length, media_type, kind, created_by_run_id, created_by_attempt_id, created_at_ms)
         VALUES (?, ?, 64, 'application/json', 'diagnostic', 'run-null-fz', 'run-null-fz-a1', ?)`,
        artifactId,
        'd'.repeat(64),
        createdMs
      );
      conn.run(
        `INSERT INTO artifact_lifecycle (
          artifact_id, lifecycle_revision, owner_run_id, owner_attempt_id, sensitivity,
          retention_class, store_kind, immutability, digest_algorithm, digest_value,
          generation, extent_bytes, byte_size, availability, producer_identity,
          display_name, created_at_ms, terminal_settled_at_ms, expires_at_ms, updated_at_ms
        ) VALUES (
          ?, 1, 'run-null-fz', 'run-null-fz-a1', 'metadata',
          'transcripts-diagnostics-checkpoints-audit-catalog', 'diagnostic', 'immutable', 'sha256', ?,
          NULL, NULL, 64, ?, 'runner', 'diag.json', ?, ?, NULL, ?
        )`,
        artifactId,
        'd'.repeat(64),
        availability,
        createdMs,
        createdMs,
        createdMs
      );
    }

    // Live vs history vs post-cutoff ACP observations
    for (const [seq, origin, observedMs] of [
      [1, 'live', t1 + 900],
      [2, 'history', t1 + 950],
      [3, 'live', BASE_NOW_MS + 1_000]
    ] as const) {
      conn.run(
        `INSERT INTO acp_observation_ledger (
          observation_key, profile_id, connection_generation, host_receive_seq,
          acp_session_id, turn_id, attempt_id, origin, kind, payload_sha256, observed_at_ms
        ) VALUES (?, 'claude-acp', 1, ?, 'sess-null', 'turn-1', 'run-null-fz-a1', ?, 'message_chunk', ?, ?)`,
        `obs-r-null-${String(seq)}`,
        seq,
        origin,
        'e'.repeat(64),
        observedMs
      );
    }

    // Non-accepted handoffs MUST be excluded; accepted pre-cutoff included; accepted post-cutoff excluded
    for (const [id, status, createdMs] of [
      ['ho-ok', 'accepted', t1 + 1_000],
      ['ho-draft', 'waiting-approval', t1 + 1_500],
      ['ho-denied', 'rejected', t1 + 2_000],
      ['ho-future', 'accepted', BASE_NOW_MS + 1_000]
    ] as const) {
      conn.run(
        `INSERT INTO phase_handoff_records (
          handoff_id, run_id, source_attempt_id, target_phase_id, revision, status, record_json, record_bytes, created_at_ms, updated_at_ms
        ) VALUES (?, 'run-null-fz', 'run-null-fz-a1', 'verify', 1, ?, '{}', 2, ?, ?)`,
        id,
        status,
        createdMs,
        createdMs
      );
    }

    // Review loops: pre-cutoff included, post-cutoff excluded
    conn.run(
      `INSERT INTO phase_review_loop_ledgers (loop_id, run_id, node_id, iteration, verdict, ledger_json, updated_at_ms)
       VALUES ('loop-pre', 'run-null-fz', 'review', 1, 'needs-fixes', ?, ?)`,
      JSON.stringify({ candidateRef: 'cand-pre', snapshot: { findings: [{ status: 'open' }] } }),
      t1 + 2_500
    );
    conn.run(
      `INSERT INTO phase_review_loop_ledgers (loop_id, run_id, node_id, iteration, verdict, ledger_json, updated_at_ms)
       VALUES ('loop-post', 'run-null-fz', 'review', 2, 'approved', ?, ?)`,
      JSON.stringify({ candidateRef: 'cand-post', snapshot: { findings: [{ status: 'resolved' }] } }),
      BASE_NOW_MS + 1_000
    );

    const runAck = await dispatchRead({
      op: 'run',
      query: { view: 'execution-summary', range: { startMs: BASE_NOW_MS - DAY_MS, endMs: BASE_NOW_MS }, filters: { rootId: ['run-null-fz'] } }
    });
    expect(runAck.status).toBe('accepted');
    const runRes = runAck.result as Extract<ReadReportResponse, { readonly op: 'run' }>;
    if (!runRes.result.ok) throw new Error('expected run ok');

    const drillAck = await dispatchRead({ op: 'drillDown', reportId: runRes.result.value.reportId, rootId: 'run-null-fz' });
    expect(drillAck.status).toBe('accepted');
    expect(isValidReadReportResponse(drillAck.result)).toBe(true);
    const drillRes = drillAck.result as Extract<ReadReportResponse, { readonly op: 'drillDown' }>;
    if (!drillRes.result.ok) throw new Error('expected drillDown ok');
    expect(drillRes.result.value.frozenDefinitionId).toBeNull();
    expect(drillRes.result.value.evidenceRefs?.map((e) => [e.artifactId, e.availability])).toEqual([
      ['art-deleted', 'deleted'],
      ['art-expired', 'expired'],
      ['art-missing', 'missing'],
      ['art:a:present', 'present']
    ]);
    expect(drillRes.result.value.acpAttributions?.at(0)?.liveObservations).toBe(1);
    expect(drillRes.result.value.handoffSummaries?.map((h) => [h.handoffId, h.status])).toEqual([['ho-ok', 'accepted']]);
    expect(drillRes.result.value.reviewSummaries?.map((r) => r.loopId)).toEqual(['loop-pre']);
    expect(JSON.stringify(drillRes.result.value)).not.toContain(workspaceRoot);
  });

  it('cancels an in-flight query via CMD_READ_REPORT cancelActive, isolates concurrent routers, and surfaces limited/invalid-query outcomes (R7-17-01)', async () => {
    // Seed enough runs so sliceMs: 0 yields across event-loop ticks
    for (let i = 0; i < 60; i += 1) {
      seedFullRun(`run-bulk-${String(i).padStart(3, '0')}`, BASE_NOW_MS - 3_600_000 + i * 1_000);
    }
    const range = { startMs: BASE_NOW_MS - DAY_MS, endMs: BASE_NOW_MS };

    // 1. In-flight cancelActive cancels a genuinely running query on the same router,
    //    while a concurrent second router's cancelActive cannot cancel routerA's active query
    const { customRouter: routerA } = buildRouterWith({ bounds: { sliceMs: 0 } });
    const { customRouter: routerB } = buildRouterWith({ bounds: { sliceMs: 0 } });

    const inFlightA = dispatchReadOn(routerA, { op: 'run', query: { view: 'execution-summary', range } });
    const inFlightB = dispatchReadOn(routerB, { op: 'run', query: { view: 'execution-summary', range } });

    // Cancel routerB only — routerB cancels, while routerA stays alive and completes!
    const cancelB = await dispatchReadOn(routerB, { op: 'cancelActive' });
    expect(cancelB.status).toBe('accepted');
    expect(isValidReadReportResponse(cancelB.result)).toBe(true);
    expect(cancelB.result).toEqual({ op: 'cancelActive', canceled: true });

    const [settledA, settledB] = await Promise.all([inFlightA, inFlightB]);
    expect(settledB.status).toBe('rejected');
    expect(isValidReadReportResponse(settledB.result)).toBe(true);
    expect(settledB.result).toEqual({ op: 'run', result: { ok: false, outcome: 'cancelled' } });
    expect(settledA.status).toBe('accepted');
    expect(isValidReadReportResponse(settledA.result)).toBe(true);
    const resA = settledA.result as Extract<ReadReportResponse, { readonly op: 'run' }>;
    if (!resA.result.ok) throw new Error('expected routerA to finish unaffected by routerB cancelActive');
    await dispatchReadOn(routerA, { op: 'close', reportId: resA.result.value.reportId });

    // 2. Limited: snapshot-rows through MessageRouter
    const { customRouter: snapCapRouter } = buildRouterWith({ bounds: { snapshotCap: 5 } });
    const snapCapAck = await dispatchReadOn(snapCapRouter, { op: 'run', query: { view: 'execution-summary', range } });
    expect(snapCapAck.status).toBe('rejected');
    expect(isValidReadReportResponse(snapCapAck.result)).toBe(true);
    expect(snapCapAck.result).toEqual({ op: 'run', result: { ok: false, outcome: 'limited', limit: 'snapshot-rows' } });

    // 3. Limited: working-data through MessageRouter
    const { customRouter: memCapRouter } = buildRouterWith({ bounds: { workingDataBytes: 256 } });
    const memCapAck = await dispatchReadOn(memCapRouter, { op: 'run', query: { view: 'execution-summary', range } });
    expect(memCapAck.status).toBe('rejected');
    expect(isValidReadReportResponse(memCapAck.result)).toBe(true);
    expect(memCapAck.result).toEqual({ op: 'run', result: { ok: false, outcome: 'limited', limit: 'working-data' } });

    // 4. Limited: deadline-exceeded through MessageRouter
    let fakeTick = 0;
    const { customRouter: deadlineRouter } = buildRouterWith({
      bounds: { queryDeadlineMs: 1, sliceMs: 0 },
      monotonicMs: () => {
        fakeTick += 5;
        return fakeTick;
      }
    });
    const deadlineAck = await dispatchReadOn(deadlineRouter, { op: 'run', query: { view: 'execution-summary', range } });
    expect(deadlineAck.status).toBe('rejected');
    expect(isValidReadReportResponse(deadlineAck.result)).toBe(true);
    expect(deadlineAck.result).toEqual({ op: 'run', result: { ok: false, outcome: 'limited', limit: 'deadline-exceeded' } });

    // 5. Refused: invalid-query through MessageRouter
    const invalidAck = await dispatchRead({ op: 'run', query: { view: 'execution-summary', range, pageSize: 201 } });
    expect(invalidAck.status).toBe('rejected');
    expect(isValidReadReportResponse(invalidAck.result)).toBe(true);
    expect(invalidAck.result).toEqual({ op: 'run', result: { ok: false, outcome: 'refused', reason: 'invalid-query' } });

    // 6. Active export root pinning through MessageRouter export dialog
    let notifyPaused: () => void = () => undefined;
    let releaseOpen: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => {
      notifyPaused = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let hooked = false;
    const { service: exportSvc, customRouter: exportRouter } = buildRouterWith({
      exportFs: {
        ...nodeExportFs,
        open: async (anchor, name) => {
          if (!hooked) {
            hooked = true;
            notifyPaused();
            await gate;
          }
          return nodeExportFs.open(anchor, name);
        }
      }
    });
    const pinnedRunAck = await dispatchReadOn(exportRouter, {
      op: 'run',
      query: { view: 'execution-summary', range, filters: { rootId: ['run-bulk-000'] } }
    });
    const pinnedRunRes = pinnedRunAck.result as Extract<ReadReportResponse, { readonly op: 'run' }>;
    if (!pinnedRunRes.result.ok) throw new Error('expected ok run for export pin');

    dialogTarget = path.join(exportDir, 'router-pinned.csv');
    const exportAcks: CommandAckMessage[] = [];
    const exportPromise = exportRouter.dispatch(
      {
        type: CMD_MUTATE_REPORT,
        correlationId: 'mut-export-pin',
        payload: { op: 'export', reportId: pinnedRunRes.result.value.reportId, format: 'csv' }
      },
      async (ack) => {
        exportAcks.push(ack);
        return true;
      }
    );
    await paused;
    expect(exportSvc.activeExportRootIds()).toEqual(new Set(['run-bulk-000']));
    releaseOpen();
    await exportPromise;
    expect(exportAcks.at(0)?.status).toBe('accepted');
    expect(exportSvc.activeExportRootIds().size).toBe(0);
  });

  it('includes real SqliteHandoffStore ready/intent/delivered/uncertain handoffs in drill-down while excluding waiting-approval/superseded/empty/post-cutoff rows (CR-310-1 / CR-314-6)', async () => {
    const runId = 'run-real-ho';
    const t1 = BASE_NOW_MS - 3_600_000;
    seedFullRun(runId, t1, 'wf-handoff');

    let writeNowMs = t1 + 1_000;
    const handoffStore = createSqliteHandoffStore(conn, () => writeNowMs);
    const acceptance = createAcceptanceService(handoffStore);

    const persistPrepared = (
      targetPhaseId: string,
      occurrenceId: string,
      approval: 'automatic' | 'manual',
      timestampMs: number
    ): string => {
      writeNowMs = timestampMs;
      const cand = candidate('plan', 1, {}, occurrenceId);
      const prep = prepareHandoff({
        policy: policy({ approval }),
        identity: identityFor([cand], {
          workspaceId: WORKSPACE_ID,
          rootExecutionId: runId,
          targetNodePath: targetPhaseId,
          targetOccurrenceId: occurrenceId
        }),
        cutoffSequence: 10,
        candidates: [cand],
        boundInputs: [],
        targetInstructions: `Execute ${targetPhaseId}.`,
        profile: profile()
      });
      if (prep.kind !== 'prepared') throw new Error(`expected prepared handoff, got ${prep.kind}`);
      const handoffId = prep.manifest.handoffId;
      handoffStore.bindRunMetadata(handoffId, {
        runId,
        sourceAttemptId: `${runId}-att-1`,
        targetPhaseId
      });
      const accepted = acceptance.accept(prep);
      if (!accepted.ok) throw new Error(`accept failed: ${accepted.failure}`);
      return handoffId;
    };

    // Real production states persisted by SqliteHandoffStore + AcceptanceService:
    const readyId = persistPrepared('phase-ready', 'occ-ready', 'automatic', t1 + 1_000);
    const intentId = persistPrepared('phase-intent', 'occ-intent', 'automatic', t1 + 1_100);
    expect(
      acceptance.recordDispatchIntent(intentId, 1, 'target-att-intent', digestOf('1')).ok
    ).toBe(true);

    const deliveredId = persistPrepared('phase-delivered', 'occ-delivered', 'automatic', t1 + 1_200);
    expect(
      acceptance.recordDispatchIntent(deliveredId, 1, 'target-att-delivered', digestOf('2')).ok
    ).toBe(true);
    expect(
      acceptance.settleDispatch(deliveredId, 1, 'target-att-delivered', 'delivered').ok
    ).toBe(true);

    const uncertainId = persistPrepared('phase-uncertain', 'occ-uncertain', 'manual', t1 + 1_300);
    expect(acceptance.approve(uncertainId, 1, 'dec-uncertain').ok).toBe(true);
    expect(
      acceptance.recordDispatchIntent(uncertainId, 1, 'target-att-uncertain', digestOf('3')).ok
    ).toBe(true);
    expect(
      acceptance.settleDispatch(uncertainId, 1, 'target-att-uncertain', 'uncertain').ok
    ).toBe(true);

    // Excluded real states: waiting-approval, superseded, empty, and post-cutoff ready
    const waitingId = persistPrepared('phase-waiting', 'occ-waiting', 'manual', t1 + 1_400);
    const futureReadyId = persistPrepared(
      'phase-future',
      'occ-future',
      'automatic',
      BASE_NOW_MS + 5_000
    );

    const supersededId = 'ho-real-superseded';
    writeNowMs = t1 + 1_500;
    handoffStore.bindRunMetadata(supersededId, {
      runId,
      sourceAttemptId: `${runId}-att-1`,
      targetPhaseId: 'phase-superseded'
    });
    expect(
      handoffStore.save(
        {
          handoffId: supersededId,
          version: 0,
          revisions: [
            {
              revision: 1,
              manifestDigest: digestOf('a'),
              serializedManifest: '{}',
              rendererVersion: 1,
              renderedDigest: digestOf('b'),
              renderedBytes: 2,
              state: 'superseded'
            }
          ],
          approvals: [],
          dispatches: []
        },
        0
      )
    ).toBe(true);

    const emptyId = 'ho-real-empty';
    writeNowMs = t1 + 1_600;
    handoffStore.bindRunMetadata(emptyId, {
      runId,
      sourceAttemptId: `${runId}-att-1`,
      targetPhaseId: 'phase-empty'
    });
    expect(
      handoffStore.save(
        { handoffId: emptyId, version: 0, revisions: [], approvals: [], dispatches: [] },
        0
      )
    ).toBe(true);

    // Confirm SqliteHandoffStore persisted the real production status vocabulary (never 'accepted')
    const persisted = conn.all<{ readonly handoff_id: string; readonly status: string }>(
      `SELECT handoff_id, status FROM phase_handoff_records WHERE run_id = ?`,
      runId
    );
    const statusById = new Map(persisted.map((r) => [r.handoff_id, r.status]));
    expect(statusById.get(readyId)).toBe('ready');
    expect(statusById.get(intentId)).toBe('intent');
    expect(statusById.get(deliveredId)).toBe('delivered');
    expect(statusById.get(uncertainId)).toBe('uncertain');
    expect(statusById.get(waitingId)).toBe('waiting-approval');
    expect(statusById.get(supersededId)).toBe('superseded');
    expect(statusById.get(emptyId)).toBe('empty');
    expect(statusById.get(futureReadyId)).toBe('ready');

    const runAck = await dispatchRead({
      op: 'run',
      query: {
        view: 'execution-summary',
        range: { startMs: BASE_NOW_MS - DAY_MS, endMs: BASE_NOW_MS },
        filters: { rootId: [runId] }
      }
    });
    expect(runAck.status).toBe('accepted');
    const runRes = runAck.result as Extract<ReadReportResponse, { readonly op: 'run' }>;
    if (!runRes.result.ok) throw new Error('expected run ok');

    const drillAck = await dispatchRead({
      op: 'drillDown',
      reportId: runRes.result.value.reportId,
      rootId: runId
    });
    expect(drillAck.status).toBe('accepted');
    expect(isValidReadReportResponse(drillAck.result)).toBe(true);
    const drillRes = drillAck.result as Extract<ReadReportResponse, { readonly op: 'drillDown' }>;
    if (!drillRes.result.ok) throw new Error('expected drillDown ok');

    const summaries = drillRes.result.value.handoffSummaries ?? [];
    const byTarget = new Map(summaries.map((h) => [h.targetPhaseId, h]));
    expect(summaries).toHaveLength(4);
    expect(byTarget.get('phase-ready')).toMatchObject({ handoffId: readyId, status: 'ready' });
    expect(byTarget.get('phase-intent')).toMatchObject({ handoffId: intentId, status: 'intent' });
    expect(byTarget.get('phase-delivered')).toMatchObject({
      handoffId: deliveredId,
      status: 'delivered'
    });
    expect(byTarget.get('phase-uncertain')).toMatchObject({
      handoffId: uncertainId,
      status: 'uncertain'
    });
    expect(summaries.some((h) => h.handoffId === waitingId)).toBe(false);
    expect(summaries.some((h) => h.handoffId === supersededId)).toBe(false);
    expect(summaries.some((h) => h.handoffId === emptyId)).toBe(false);
    expect(summaries.some((h) => h.handoffId === futureReadyId)).toBe(false);
  });

  it('surfaces auxiliary evidence truncation omissions across report page, last-root drill-down, and report export manifest (Post-merge Finding 4)', async () => {
    const t1 = BASE_NOW_MS - 3_600_000;
    const t2 = BASE_NOW_MS - 1_800_000;
    seedFullRun('run-aux-1', t1);
    seedFullRun('run-aux-2', t2);

    // Seed 3 valid artifacts across the 2 roots so cap=2 fits roots/attempts but overflows evidenceRefs,
    // leaving the last root (`run-aux-2`) missing its artifact reference.
    for (const [artifactId, ownerRunId, ownerAttemptId] of [
      ['art-1', 'run-aux-1', 'run-aux-1-att-1'],
      ['art-2', 'run-aux-1', 'run-aux-1-att-1'],
      ['art-3', 'run-aux-2', 'run-aux-2-att-1']
    ] as const) {
      conn.run(
        `INSERT INTO artifacts (artifact_id, content_sha256, byte_length, media_type, kind, created_by_run_id, created_by_attempt_id, created_at_ms)
         VALUES (?, ?, 64, 'application/json', 'diagnostic', ?, ?, ?)`,
        artifactId,
        'd'.repeat(64),
        ownerRunId,
        ownerAttemptId,
        t1 + 500
      );
      conn.run(
        `INSERT INTO artifact_lifecycle (
           artifact_id, lifecycle_revision, owner_run_id, owner_attempt_id, sensitivity,
           retention_class, store_kind, immutability, digest_algorithm, digest_value,
           generation, extent_bytes, byte_size, availability, producer_identity,
           display_name, created_at_ms, terminal_settled_at_ms, expires_at_ms, updated_at_ms
         ) VALUES (
           ?, 1, ?, ?, 'metadata',
           'transcripts-diagnostics-checkpoints-audit-catalog', 'diagnostic', 'immutable', 'sha256', ?,
           NULL, NULL, 64, 'present', 'runner', 'diag.json', ?, ?, NULL, ?
         )`,
        artifactId,
        ownerRunId,
        ownerAttemptId,
        'd'.repeat(64),
        t1 + 500,
        t1 + 500,
        t1 + 500
      );
    }

    const { customRouter, service: customService } = buildRouterWith({ bounds: { snapshotCap: 2 } });
    const runAck = await dispatchReadOn(customRouter, {
      op: 'run',
      query: {
        view: 'execution-summary',
        range: { startMs: BASE_NOW_MS - DAY_MS, endMs: BASE_NOW_MS }
      }
    });
    expect(runAck.status).toBe('accepted');
    expect(isValidReadReportResponse(runAck.result)).toBe(true);
    const runRes = runAck.result as Extract<ReadReportResponse, { readonly op: 'run' }>;
    if (!runRes.result.ok) throw new Error('expected run ok');
    expect(runRes.result.value.omissions).toContainEqual({
      what: 'evidenceRefs',
      reason: 'snapshot-rows-truncated'
    });

    // Drill down into the last affected root (`run-aux-2`): omission must be visible rather than empty.
    const drillAck = await dispatchReadOn(customRouter, {
      op: 'drillDown',
      reportId: runRes.result.value.reportId,
      rootId: 'run-aux-2'
    });
    expect(drillAck.status).toBe('accepted');
    expect(isValidReadReportResponse(drillAck.result)).toBe(true);
    const drillRes = drillAck.result as Extract<ReadReportResponse, { readonly op: 'drillDown' }>;
    if (!drillRes.result.ok) throw new Error('expected drillDown ok');
    expect(drillRes.result.value.evidenceRefs).toBeUndefined();
    expect(drillRes.result.value.omissions).toContainEqual({
      what: 'evidenceRefs',
      reason: 'snapshot-rows-truncated'
    });

    // Export manifest must also carry the auxiliary truncation omission.
    const exportDest = path.join(tempDir, 'aux-truncated-report.json');
    const exported = await customService.exportReport({
      reportId: runRes.result.value.reportId,
      format: 'json',
      destination: { scheme: 'file', fsPath: exportDest }
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) throw new Error('expected export ok');
    expect(exported.value.manifest.omissions).toContainEqual({
      what: 'evidenceRefs',
      reason: 'snapshot-rows-truncated'
    });
  });
});
