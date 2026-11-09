/**
 * FR-R6-F06 (T048, FR-013, research R8, F06-AC-05) — the legacy epoch. The first-terminal
 * rollup is imported once, in 500-run batches, into its own labelled epoch: an interrupted
 * import resumes to the same rows, a repeat is a no-op, the carry-forward header is kept, the
 * boundary is the newest run, the reconciliation reports what a second read saw, legacy
 * buckets carry no backend, model or phase, a legacy run id cannot become a new root, and the
 * rollup file is never written.
 */
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serializeCarryForward, serializeMetricsRollupRecord } from '../../../src/metrics/metrics-rollup';
import { metricsRollupPath, readMetricsRollup } from '../../../src/metrics/metrics-rollup-reader';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import { type LegacyRollupSource, metricsRollupLegacySource } from '../../../src/services/usage-accounting/legacy-epoch';
import {
  type UsageAccountingService,
  createUsageAccountingService
} from '../../../src/services/usage-accounting/usage-accounting-service';
import {
  LEGACY_CARRY_FORWARD,
  LEGACY_RUN_COUNT,
  legacyCostMicros,
  legacyRecord,
  legacyRunId,
  writeLegacyRollup
} from '../../fixtures/usage-accounting/legacy-rollup';

const NOW = '2026-11-10T12:00:00.000Z';
const NEWEST = LEGACY_RUN_COUNT - 1;

let conn: NodeSqliteConnection;
let workspaceRoot: string;
let failAfterBatch: number | undefined;

beforeEach(async () => {
  failAfterBatch = undefined;
  conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(NOW));
  workspaceRoot = await mkdtemp(join(tmpdir(), 'schegent-legacy-epoch-'));
});

afterEach(async () => {
  if (conn.db.isOpen) conn.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

function service(): UsageAccountingService {
  return createUsageAccountingService({
    conn,
    nowUtc: () => NOW,
    monotonicMs: () => 1,
    workspaceId: 'ws-1',
    legacyImportFailpoint: (batch) => {
      if (batch === failAfterBatch) throw new Error('failpoint');
    }
  });
}

function legacyRows() {
  return conn.all<Record<string, unknown>>('SELECT * FROM accounting_legacy_runs ORDER BY run_id');
}

function epoch() {
  return conn.get<Record<string, unknown>>('SELECT * FROM accounting_legacy_epoch WHERE epoch_id = 1');
}

function count(sql: string): number {
  return Number(conn.scalar(sql) ?? 0);
}

describe('importLegacyEpoch (T048)', () => {
  it('imports every run once into a complete epoch, and a second call is a no-op', async () => {
    await writeLegacyRollup(workspaceRoot);
    const accounting = service();
    const source = metricsRollupLegacySource(workspaceRoot);

    const first = await accounting.importLegacyEpoch(source);
    expect(first).toStrictEqual({ ok: true, value: { state: 'complete', importedRuns: LEGACY_RUN_COUNT, reconciliation: 'matched' } });
    expect(count('SELECT count(*) FROM accounting_legacy_runs')).toBe(LEGACY_RUN_COUNT);
    expect(epoch()).toMatchObject({ state: 'complete', imported_runs: LEGACY_RUN_COUNT, legacy_cost_micros: legacyCostMicros() });
    expect(count("SELECT count(*) FROM accounting_revisions WHERE cause = 'legacy-import'")).toBe(1);

    const revisions = count('SELECT count(*) FROM accounting_revisions');
    expect(await accounting.importLegacyEpoch(source)).toStrictEqual(first);
    expect(count('SELECT count(*) FROM accounting_revisions')).toBe(revisions);
    expect(count('SELECT count(*) FROM accounting_legacy_runs')).toBe(LEGACY_RUN_COUNT);
  });

  it('stores each run as the rollup recorded it, with legacy-float cost and no tokens', async () => {
    await writeLegacyRollup(workspaceRoot);
    await service().importLegacyEpoch(metricsRollupLegacySource(workspaceRoot));
    const byId = new Map(legacyRows().map((row) => [row.run_id, row]));
    expect({ ...byId.get(legacyRunId(1)) }).toStrictEqual({
      run_id: legacyRunId(1),
      terminal_utc: legacyRecord(1).endedAt,
      outcome: 'failed',
      cost_micros: 15_000,
      cost_origin: 'legacy-float',
      input_tokens: null,
      output_tokens: null
    });
    expect(byId.get(legacyRunId(7))).toMatchObject({ cost_micros: null, outcome: 'failed' });
  });

  it('resumes an import interrupted after its first batch to the same rows', async () => {
    await writeLegacyRollup(workspaceRoot);
    const source = metricsRollupLegacySource(workspaceRoot);
    failAfterBatch = 1;
    expect(await service().importLegacyEpoch(source)).toMatchObject({ ok: false, refusal: { code: 'store-error' } });
    expect(epoch()).toMatchObject({ state: 'importing' });
    expect(count('SELECT count(*) FROM accounting_legacy_runs')).toBe(500);

    failAfterBatch = undefined;
    const resumed = await service().importLegacyEpoch(source);
    expect(resumed).toMatchObject({ ok: true, value: { state: 'complete', importedRuns: LEGACY_RUN_COUNT } });
    const interrupted = legacyRows();

    conn.close();
    conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(NOW));
    await service().importLegacyEpoch(source);
    expect(legacyRows()).toStrictEqual(interrupted);
  });

  it('copies the carry-forward header verbatim and marks the newest run as the boundary', async () => {
    await writeLegacyRollup(workspaceRoot);
    await service().importLegacyEpoch(metricsRollupLegacySource(workspaceRoot));
    expect(epoch()).toMatchObject({
      carry_forward_header: serializeCarryForward(LEGACY_CARRY_FORWARD).trimEnd(),
      boundary_run_id: legacyRunId(NEWEST),
      boundary_terminal_utc: legacyRecord(NEWEST).endedAt
    });
  });

  it('reconciles mismatch, with counts, when a run is appended between the two reads', async () => {
    const file = await writeLegacyRollup(workspaceRoot);
    const real = metricsRollupLegacySource(workspaceRoot);
    let reads = 0;
    const racing: LegacyRollupSource = {
      async read() {
        const result = await real.read();
        reads += 1;
        if (reads === 1) await appendFile(file, serializeMetricsRollupRecord(legacyRecord(LEGACY_RUN_COUNT)), 'utf8');
        return result;
      }
    };
    expect(await service().importLegacyEpoch(racing)).toMatchObject({
      ok: true,
      value: { importedRuns: LEGACY_RUN_COUNT, reconciliation: 'mismatch' }
    });
    expect(JSON.parse(String(epoch()?.reconciliation_detail))).toStrictEqual({
      importedRuns: LEGACY_RUN_COUNT,
      rereadRuns: LEGACY_RUN_COUNT + 1,
      importedCostMicros: legacyCostMicros(),
      rereadCostMicros: legacyCostMicros(LEGACY_RUN_COUNT + 1)
    });
  });

  it('completes an empty epoch for an absent rollup', async () => {
    expect(await service().importLegacyEpoch(metricsRollupLegacySource(workspaceRoot))).toStrictEqual({
      ok: true,
      value: { state: 'complete', importedRuns: 0, reconciliation: 'empty' }
    });
    expect(epoch()).toMatchObject({ boundary_run_id: null, carry_forward_header: null, legacy_cost_micros: 0 });
  });

  it('lists legacy runs only in the labelled legacy summary, never in grouped rows', async () => {
    await writeLegacyRollup(workspaceRoot);
    const accounting = service();
    await accounting.importLegacyEpoch(metricsRollupLegacySource(workspaceRoot));
    for (const dimension of ['backend', 'model', 'phaseId']) {
      const answer = accounting.query({ groupBy: [dimension], includeLegacy: true });
      if (!answer.ok) throw new Error(answer.refusal.code);
      expect(answer.value.rows).toHaveLength(0);
      expect(answer.value.legacy).toStrictEqual({
        runCount: LEGACY_RUN_COUNT,
        costMicros: String(legacyCostMicros()),
        boundaryRunId: legacyRunId(NEWEST),
        boundaryTerminalUtc: legacyRecord(NEWEST).endedAt,
        reconciliation: 'matched',
        detail: 'unavailable'
      });
    }
  });

  it('refuses a legacy run id as a new root with legacy-epoch-overlap', async () => {
    await writeLegacyRollup(workspaceRoot);
    const accounting = service();
    await accounting.importLegacyEpoch(metricsRollupLegacySource(workspaceRoot));
    expect(accounting.recordRootOutcome({ rootId: legacyRunId(3), outcome: 'succeeded', terminalUtc: NOW })).toStrictEqual({
      ok: false,
      refusal: { code: 'legacy-epoch-overlap' }
    });
    expect(count('SELECT count(*) FROM accounting_root_outcomes')).toBe(0);
    expect(accounting.recordRootOutcome({ rootId: 'run-new-1', outcome: 'succeeded', terminalUtc: NOW })).toMatchObject({ ok: true });
  });

  it('leaves the rollup file byte-identical', async () => {
    const file = await writeLegacyRollup(workspaceRoot);
    const before = await readFile(file);
    await service().importLegacyEpoch(metricsRollupLegacySource(workspaceRoot));
    expect((await readFile(file)).equals(before)).toBe(true);
    expect((await readMetricsRollup(workspaceRoot)).records).toHaveLength(LEGACY_RUN_COUNT);
  });
});

describe('importLegacyEpoch: an unreadable or partial rollup (review S1, S2)', () => {
  const SMALL = 3;

  it('refuses, and leaves the epoch open, when the rollup exists but cannot be read', async () => {
    await mkdir(metricsRollupPath(workspaceRoot), { recursive: true });
    expect(await service().importLegacyEpoch(metricsRollupLegacySource(workspaceRoot))).toStrictEqual({
      ok: false,
      refusal: { code: 'store-unavailable', detail: 'legacy-rollup-unreadable' }
    });
    expect(epoch()?.state ?? 'absent').not.toBe('complete');
    await rm(metricsRollupPath(workspaceRoot), { recursive: true });
    await writeLegacyRollup(workspaceRoot);
    expect(await service().importLegacyEpoch(metricsRollupLegacySource(workspaceRoot))).toMatchObject({
      ok: true,
      value: { state: 'complete', importedRuns: LEGACY_RUN_COUNT, reconciliation: 'matched' }
    });
  });

  it('reconciles the stored runs, not the resume read, after the rollup shrank mid-import (review R4)', async () => {
    const file = await writeLegacyRollup(workspaceRoot);
    failAfterBatch = 1;
    expect(await service().importLegacyEpoch(metricsRollupLegacySource(workspaceRoot))).toMatchObject({ ok: false });
    await rm(file);
    await appendFile(file, Array.from({ length: SMALL }, (_, index) => serializeMetricsRollupRecord(legacyRecord(index))).join(''), 'utf8');
    failAfterBatch = undefined;
    expect(await service().importLegacyEpoch(metricsRollupLegacySource(workspaceRoot))).toMatchObject({
      ok: true,
      value: { importedRuns: 500, reconciliation: 'mismatch' }
    });
    expect(JSON.parse(String(epoch()?.reconciliation_detail))).toMatchObject({ importedRuns: 500, rereadRuns: SMALL });
  });

  it('reconciles mismatch, not empty, when the rollup vanished after part of it was stored (review R4)', async () => {
    const file = await writeLegacyRollup(workspaceRoot);
    failAfterBatch = 1;
    expect(await service().importLegacyEpoch(metricsRollupLegacySource(workspaceRoot))).toMatchObject({ ok: false });
    await rm(file);
    failAfterBatch = undefined;
    expect(await service().importLegacyEpoch(metricsRollupLegacySource(workspaceRoot))).toMatchObject({
      ok: true,
      value: { importedRuns: 500, reconciliation: 'mismatch' }
    });
    expect(JSON.parse(String(epoch()?.reconciliation_detail))).toMatchObject({ importedRuns: 500, rereadRuns: 0 });
  });

  it('reconciles mismatch, with counts, when a read skipped bytes or records', async () => {
    const file = metricsRollupPath(workspaceRoot);
    await mkdir(join(workspaceRoot, '.schegent'), { recursive: true });
    await appendFile(file, Array.from({ length: SMALL }, (_, index) => serializeMetricsRollupRecord(legacyRecord(index))).join(''), 'utf8');
    const real = metricsRollupLegacySource(workspaceRoot);
    const lossy: LegacyRollupSource = {
      async read() {
        return { ...(await real.read()), unreadableRecords: 2, skippedBytes: 4096 };
      }
    };
    expect(await service().importLegacyEpoch(lossy)).toMatchObject({
      ok: true,
      value: { importedRuns: SMALL, reconciliation: 'mismatch' }
    });
    expect(JSON.parse(String(epoch()?.reconciliation_detail))).toMatchObject({ unreadableRecords: 2, skippedBytes: 4096 });
  });

  it('excludes a run id over 256 bytes or with a control character, and caps an absurd cost', async () => {
    const file = metricsRollupPath(workspaceRoot);
    await mkdir(join(workspaceRoot, '.schegent'), { recursive: true });
    const records = [
      legacyRecord(0),
      { ...legacyRecord(1), runId: 'r'.repeat(257) },
      { ...legacyRecord(2), runId: `run-${String.fromCodePoint(7)}-bell` },
      { ...legacyRecord(3), costUsd: 5_000_000 }
    ];
    await appendFile(file, records.map((record) => serializeMetricsRollupRecord(record)).join(''), 'utf8');
    expect(await service().importLegacyEpoch(metricsRollupLegacySource(workspaceRoot))).toMatchObject({
      ok: true,
      value: { importedRuns: 2, reconciliation: 'mismatch' }
    });
    expect(legacyRows().map((row) => [row.run_id, row.cost_micros])).toStrictEqual([
      [legacyRunId(0), null],
      [legacyRunId(3), null]
    ]);
    expect(JSON.parse(String(epoch()?.reconciliation_detail))).toMatchObject({ excludedRuns: 2 });
  });
});

describe('importLegacyEpoch: concurrent callers (review S9)', () => {
  it('completes the epoch once when two imports overlap', async () => {
    await writeLegacyRollup(workspaceRoot);
    const accounting = service();
    const source = metricsRollupLegacySource(workspaceRoot);
    const [left, right] = await Promise.all([accounting.importLegacyEpoch(source), accounting.importLegacyEpoch(source)]);
    const complete = { ok: true, value: { state: 'complete', importedRuns: LEGACY_RUN_COUNT, reconciliation: 'matched' } };
    expect(left).toStrictEqual(complete);
    expect(right).toStrictEqual(complete);
    expect(count("SELECT count(*) FROM accounting_revisions WHERE cause = 'legacy-import'")).toBe(1);
    expect(count('SELECT count(*) FROM accounting_legacy_runs')).toBe(LEGACY_RUN_COUNT);
  });
});
