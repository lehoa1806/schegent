/**
 * FR-R7-14 (14-06) — Restart-independent durable ACP observation identities against a schema-9
 * SQLite database across two fresh host lifetimes, pre-existing legacy rows, true-replay
 * deduplication, restore re-seeding, `readAttemptVisibility` (`execution-visibility-api.ts`),
 * and historical snapshot reports (`reporting-service.ts`).
 */
import { mkdir, mkdtemp } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { AcpObservation } from '../../src/contracts/acp-runtime';
import { createExecutionVisibilityApi } from '../../src/headless/execution-visibility-api';
import { createPhaseContextApi } from '../../src/headless/phase-context-api';
import { createSqliteAcpDurableRuntimeStore } from '../../src/services/acp-runtime/acp-durable-runtime-store';
import { createReportingService } from '../../src/services/reporting';
import { toUtcIso } from '../../src/services/reporting/report-time';
import {
  NodeSqliteConnection,
  SchemaBootstrapService,
  type SqliteApplicationStore
} from '../../src/services/sqlite-store';
import { createUsageAccountingService } from '../../src/services/usage-accounting/usage-accounting-service';
import { removeTempRoot } from '../temp-root-cleanup';

const SCOPE_ID = 'scope-1406-restart';
const PROFILE_ID = 'claude-acp-bridge';
const BASE_NOW_MS = 1_800_000_000_000;
const DAY_MS = 86_400_000;

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!;
    await removeTempRoot(dir);
  }
});

function seedRunAndAttempt(
  conn: NodeSqliteConnection,
  params: {
    readonly runId: string;
    readonly stepId: string;
    readonly attemptId: string;
    readonly createdAtMs: number;
    readonly completedAtMs: number | null;
    readonly status: 'running' | 'succeeded';
  }
): void {
  conn.run(
    `INSERT INTO runs (
      run_id, workspace_id, workflow_id, status, revision,
      created_at_ms, updated_at_ms, backend_kind, model_id, profile_id
    ) VALUES (?, ?, 'wf-1406', ?, 1, ?, ?, 'claude', 'claude-sonnet-4-6', ?)`,
    params.runId,
    SCOPE_ID,
    params.status,
    params.createdAtMs,
    params.createdAtMs + 100,
    PROFILE_ID
  );
  conn.run(
    `INSERT INTO steps (
      step_id, run_id, step_index, phase_id, status, revision, updated_at_ms
    ) VALUES (?, ?, 0, 'implement', ?, 1, ?)`,
    params.stepId,
    params.runId,
    params.status,
    params.createdAtMs + 100
  );
  conn.run(
    `INSERT INTO attempts (
      attempt_id, run_id, step_id, attempt_number, status, exit_code,
      started_at_ms, completed_at_ms, backend_kind, model_id, profile_id
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'claude', 'claude-sonnet-4-6', ?)`,
    params.attemptId,
    params.runId,
    params.stepId,
    params.status,
    params.status === 'succeeded' ? 0 : null,
    params.createdAtMs + 50,
    params.completedAtMs,
    PROFILE_ID
  );
}

function makeMessageObservation(params: {
  readonly generation: number;
  readonly hostReceiveSeq: number;
  readonly acpSessionId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly text: string;
}): AcpObservation {
  return {
    kind: 'display',
    generation: params.generation,
    hostReceiveSeq: params.hostReceiveSeq,
    observedAtUtc: toUtcIso(BASE_NOW_MS),
    origin: 'live',
    acpSessionId: params.acpSessionId,
    turnId: params.turnId,
    attemptId: params.attemptId,
    binding: null,
    event: {
      connectionGeneration: String(params.generation),
      attemptId: params.attemptId,
      origin: 'live',
      kind: 'message',
      sourceEventId: null,
      text: params.text
    }
  };
}

describe('FR-R7-14 (14-06) — restart-independent durable ACP observation ledger', () => {
  it('preserves pre-existing legacy rows and distinct equal process-local (gen=1, seq=1..N) events across two fresh host lifetimes, deduplicates true replays, surfaces all counts in visibility + snapshot reports, and re-seeds after restore', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'schegent-1406-ledger-'));
    tempRoots.push(root);
    const workspaceRoot = path.join(root, 'workspace');
    await mkdir(workspaceRoot, { recursive: true });
    const dbPath = path.join(root, 'schegent-state.db');

    const t0 = BASE_NOW_MS - 60_000;

    // --- Host Lifetime 1: seed schema-9 DB with a pre-existing legacy row at (gen=1, seq=1) ---
    const conn1 = new NodeSqliteConnection({ databasePath: dbPath });
    try {
      const boot = SchemaBootstrapService.bootstrapAndMigrate(conn1, () => t0);
      expect(boot.schemaVersion).toBe(9);

      seedRunAndAttempt(conn1, {
        runId: 'run-legacy',
        stepId: 'step-legacy',
        attemptId: 'att-legacy',
        createdAtMs: t0,
        completedAtMs: t0 + 5_000,
        status: 'succeeded'
      });
      seedRunAndAttempt(conn1, {
        runId: 'run-host1',
        stepId: 'step-host1',
        attemptId: 'att-host1',
        createdAtMs: t0 + 10_000,
        completedAtMs: t0 + 15_000,
        status: 'succeeded'
      });
      seedRunAndAttempt(conn1, {
        runId: 'run-host2',
        stepId: 'step-host2',
        attemptId: 'att-host2',
        createdAtMs: t0 + 20_000,
        completedAtMs: null,
        status: 'running'
      });

      // Pre-existing legacy schema-9 row written before 14-06 (no HWM row in operational_kv_documents yet).
      conn1.run(
        `INSERT INTO acp_observation_ledger (
          observation_key, profile_id, connection_generation, host_receive_seq,
          acp_session_id, turn_id, attempt_id, origin, kind, payload_sha256, observed_at_ms
        ) VALUES ('claude-acp-bridge:1:1', ?, 1, 1, 'acp-claude-session-1', 'turn-1-1', 'att-legacy', 'live', 'display:message', ?, ?)`,
        PROFILE_ID,
        'a'.repeat(64),
        t0 + 1_000
      );

      const host1Store = createSqliteAcpDurableRuntimeStore(conn1, SCOPE_ID, () => t0 + 11_000);
      // Host 1 allocates a durable generation -> must seed strictly above legacy MAX(connection_generation)=1.
      const host1AllocatedGen = host1Store.allocateConnectionGeneration();
      expect(host1AllocatedGen).toBe(2);

      // Host 1 records 3 observations under its allocated generation=2.
      for (const seq of [1, 2, 3]) {
        const res = host1Store.recordObservation(
          {
            profileId: PROFILE_ID,
            attemptId: 'att-host1',
            observation: makeMessageObservation({
              generation: host1AllocatedGen,
              hostReceiveSeq: seq,
              acpSessionId: 'acp-claude-session-1',
              turnId: `turn-${host1AllocatedGen}-1`,
              attemptId: 'att-host1',
              text: `host1 message ${seq}`
            })
          },
          t0 + 11_000 + seq
        );
        expect(res).toEqual({ persistedGeneration: 2, deduplicated: false });
      }
    } finally {
      conn1.close();
    }

    // --- Host Lifetime 2: fresh SQLite connection + fresh durable runtime store ---
    const conn2 = new NodeSqliteConnection({ databasePath: dbPath });
    try {
      const host2Store = createSqliteAcpDurableRuntimeStore(conn2, SCOPE_ID, () => t0 + 21_000);

      // 1. Distinct events emitted with colliding process-local (gen=1, seq=1..3) MUST NOT be
      //    silently dropped; they remap onto a fresh durable generation (> 2) while keeping legacy row!
      const remappedGens: number[] = [];
      const host2Event1 = makeMessageObservation({
        generation: 1,
        hostReceiveSeq: 1,
        acpSessionId: 'acp-claude-session-1',
        turnId: 'turn-1-1',
        attemptId: 'att-host2',
        text: 'host2 unallocated collision msg 1'
      });
      const r1 = host2Store.recordObservation(
        { profileId: PROFILE_ID, attemptId: 'att-host2', observation: host2Event1 },
        t0 + 21_000
      );
      expect(r1.deduplicated).toBe(false);
      expect(r1.persistedGeneration).toBeGreaterThan(2);
      remappedGens.push(r1.persistedGeneration);

      // True replay of the exact same event deduplicates to 1 row (no duplicate insertion).
      const replayR1 = host2Store.recordObservation(
        { profileId: PROFILE_ID, attemptId: 'att-host2', observation: host2Event1 },
        t0 + 21_000
      );
      expect(replayR1).toEqual({ persistedGeneration: r1.persistedGeneration, deduplicated: true });

      for (const seq of [2, 3]) {
        const rNext = host2Store.recordObservation(
          {
            profileId: PROFILE_ID,
            attemptId: 'att-host2',
            observation: makeMessageObservation({
              generation: 1,
              hostReceiveSeq: seq,
              acpSessionId: 'acp-claude-session-1',
              turnId: 'turn-1-1',
              attemptId: 'att-host2',
              text: `host2 unallocated collision msg ${seq}`
            })
          },
          t0 + 21_000
        );
        expect(rNext).toEqual({ persistedGeneration: r1.persistedGeneration, deduplicated: false });
        remappedGens.push(rNext.persistedGeneration);
      }

      // 2. True replay of Host 1's persisted event at (gen=2, seq=1) deduplicates across restart!
      const crossHostReplay = host2Store.recordObservation(
        {
          profileId: PROFILE_ID,
          attemptId: 'att-host1',
          observation: makeMessageObservation({
            generation: 2,
            hostReceiveSeq: 1,
            acpSessionId: 'acp-claude-session-1',
            turnId: 'turn-2-1',
            attemptId: 'att-host1',
            text: 'host1 message 1'
          })
        },
        t0 + 22_000
      );
      expect(crossHostReplay).toEqual({ persistedGeneration: 2, deduplicated: true });

      // Verify total ledger rows: 1 legacy + 3 host1 + 3 host2 = 7 distinct rows (zero silent drops, zero replay bloat).
      const totalRows = Number(conn2.scalar(`SELECT COUNT(*) FROM acp_observation_ledger`) ?? 0);
      expect(totalRows).toBe(7);

      // Verify deterministic secondary sort in `readAcpVisibility` when timestamps are tied:
      // insert a later generation/seq row at identical `observed_at_ms` with kind 'turn-cancelled'
      // (contains 'cancel') so `runtimeState` deterministically settles to `'canceled'`!
      const tieMs = t0 + 21_000;
      const gen4 = host2Store.allocateConnectionGeneration();
      expect(gen4).toBeGreaterThan(r1.persistedGeneration);
      conn2.run(
        `INSERT INTO acp_observation_ledger (
          observation_key, profile_id, connection_generation, host_receive_seq,
          acp_session_id, turn_id, attempt_id, origin, kind, payload_sha256, observed_at_ms
        ) VALUES (?, ?, ?, 1, 'acp-claude-session-1', ?, 'att-host2', 'live', 'turn-cancelled', ?, ?)`,
        `${PROFILE_ID}:${gen4}:1`,
        PROFILE_ID,
        gen4,
        `turn-${gen4}-1`,
        'c'.repeat(64),
        tieMs
      );

      // 3. Verify `ExecutionVisibilityApi.readAttemptVisibility` sees every surviving observation per attempt
      //    and applies deterministic `(observed_at_ms DESC, connection_generation DESC, host_receive_seq DESC)` tie-breaking.
      const fakeStore = { writerConnection: conn2 } as unknown as SqliteApplicationStore;
      const visibilityApi = createExecutionVisibilityApi({
        scopeId: SCOPE_ID,
        getSqliteStore: () => fakeStore,
        getPhaseContextApi: () => createPhaseContextApi(() => null),
        getTelemetryHost: () => null,
        isLanesEnabled: () => false
      });

      const legacyVis = visibilityApi.readAttemptVisibility({ rootExecutionId: 'run-legacy' });
      expect(legacyVis.acp.liveObservations).toBe(1);

      const host1Vis = visibilityApi.readAttemptVisibility({ rootExecutionId: 'run-host1' });
      expect(host1Vis.acp.liveObservations).toBe(3);

      const host2Vis = visibilityApi.readAttemptVisibility({ rootExecutionId: 'run-host2' });
      expect(host2Vis.acp.liveObservations).toBe(4);
      expect(host2Vis.acp.runtimeState).toBe('canceled');

      // 4. Verify `ReportingService` snapshot reports surface exact live observation counts across all runs.
      const accounting = createUsageAccountingService({
        conn: conn2,
        nowUtc: () => toUtcIso(BASE_NOW_MS),
        monotonicMs: () => 1,
        workspaceId: SCOPE_ID,
        bounds: {}
      });
      const reporting = createReportingService({
        conn: conn2,
        workspaceId: SCOPE_ID,
        workspaceRoot,
        nowMs: () => BASE_NOW_MS,
        monotonicMs: () => 1,
        hostTimezone: 'UTC',
        accounting
      });

      const report = await reporting.runReport({
        view: 'execution-summary',
        range: { startMs: BASE_NOW_MS - DAY_MS, endMs: BASE_NOW_MS },
        sort: 'root-created-desc',
        pageSize: 10
      });
      expect(report.ok).toBe(true);
      if (!report.ok) return;

      const countFor = (rootId: string): number => {
        const drill = reporting.drillDown({ reportId: report.value.reportId, rootId });
        expect(drill.ok, rootId).toBe(true);
        if (!drill.ok) return -1;
        return (drill.value.acpAttributions ?? []).reduce((sum, item) => sum + item.liveObservations, 0);
      };
      expect(countFor('run-legacy')).toBe(1);
      expect(countFor('run-host1')).toBe(3);
      expect(countFor('run-host2')).toBe(4);
      reporting.closeReport({ reportId: report.value.reportId });

      // 5. Restore re-seeding: simulate DB restore raising stored generation to 25 (e.g. from backup)
      //    and calling `resetInMemoryState()`; next allocation MUST jump strictly above 25!
      conn2.run(
        `INSERT INTO acp_authorization_receipts (
          receipt_id, profile_id, connection_generation, session_id, attempt_id,
          request_kind, idempotency_key, decision, reason_code, fenced_epoch, recorded_at_ms
        ) VALUES ('rcpt-restored-25', ?, 25, 'sess-restored', 'att-host2', 'permission', 'rcpt-restored-25', 'approved', 'authorized', 1, ?)`,
        PROFILE_ID,
        t0 + 25_000
      );
      host2Store.resetInMemoryState();
      expect(host2Store.allocateConnectionGeneration()).toBe(26);
    } finally {
      conn2.close();
    }
  });
});
