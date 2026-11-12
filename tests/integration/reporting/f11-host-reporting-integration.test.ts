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
import { createReportingService, type ReportingService } from '../../../src/services/reporting';
import { toUtcIso } from '../../../src/services/reporting/report-time';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import { createUsageAccountingService } from '../../../src/services/usage-accounting/usage-accounting-service';
import { SECONDARY_REJECT, UNTRUSTED_REJECT } from '../../../src/ui/sidebar/commands/constants';
import type { RouterDeps } from '../../../src/ui/sidebar/commands/router-types';
import { MessageRouter } from '../../../src/ui/sidebar/message-router';
import type { CommandAckMessage, SidebarCommand } from '../../../src/ui/sidebar/messages';

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

    const accounting = createUsageAccountingService({
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
});
