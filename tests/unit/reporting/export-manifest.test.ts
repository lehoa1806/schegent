// FR-R6-F11 T029 (FR-012, FR-014) — the manifest names every FR-012 field and detects a changed byte.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CSV_STATEMENT } from '../../../src/contracts/reporting/report-manifest';
import {
  buildReportManifest,
  manifestSha256,
  manifestText,
  manifestUnits
} from '../../../src/services/reporting/export-manifest';
import {
  EXPORT_CUTOFF_MS,
  EXPORT_REPORT_ID,
  HOSTILE_ROOT_ROWS,
  UNSAFE_USAGE_ROW,
  liveReport
} from './export-fixture';

const EXPORT_ID = 'e'.repeat(32);
const DATA_BYTES = Buffer.from('{"rows":[]}\n', 'utf8');
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const CSV_COUNTS = Object.freeze([
  { name: 'text-prefix', count: 18 },
  { name: 'control-escaped', count: 1 },
  { name: 'truncated', count: 0 },
  { name: 'number-prefixed', count: 0 }
] as const);

function csvManifest(): ReturnType<typeof buildReportManifest> {
  return buildReportManifest(liveReport(HOSTILE_ROOT_ROWS), {
    exportId: EXPORT_ID,
    rerunOf: null,
    generatedMs: EXPORT_CUTOFF_MS + 5_000,
    data: { format: 'csv', fileName: 'report.csv', byteLength: DATA_BYTES.length, sha256: sha256(DATA_BYTES) },
    transformations: CSV_COUNTS
  });
}

describe('report manifest (FR-012)', () => {
  it('records every FR-012 field', () => {
    const manifest = csvManifest();
    expect(manifest).toMatchObject({
      schema: 'schegent.report-manifest',
      manifestVersion: 1,
      reportId: EXPORT_REPORT_ID,
      exportId: EXPORT_ID,
      rerunOf: null,
      view: 'attempt-detail',
      queryDigest: 'd'.repeat(64),
      generatedUtc: '2027-01-15T08:00:05.000Z',
      sourceCutoffUtc: '2027-01-15T08:00:00.000Z',
      timezone: 'UTC',
      timeBasis: 'root-created',
      versions: {
        source: 'sqlite-store/7',
        schema: 1,
        calculation: 1,
        accountingPolicy: null,
        accountingCalculation: null,
        csvProfile: 1
      },
      accountingRevision: null,
      coverage: { roots: 2, attempts: 2, unknownDurations: 1, unattributed: null, gaps: [] },
      omissions: [{ what: 'accountingRevision', reason: 'accounting-unavailable' }],
      rowCount: 2,
      units: ['ms'],
      privacyProfile: 'metadata-only',
      retention: 'outside-managed-retention',
      populationDigest: 'p'.repeat(64),
      data: { format: 'csv', fileName: 'report.csv', byteLength: DATA_BYTES.length, sha256: sha256(DATA_BYTES) }
    });
    expect(manifest.query.view).toBe('attempt-detail');
  });

  it('describes the CSV transformations and states that JSON is exact (FR-014)', () => {
    const manifest = csvManifest();
    expect(manifest.transformations).toEqual(CSV_COUNTS);
    expect(manifest.csvStatement).toBe(CSV_STATEMENT);
    expect(manifest.csvStatement).toMatch(/JSON export is the exact format/);
  });

  it('omits the CSV entries for a JSON export and the data entry for a saved report', () => {
    const json = buildReportManifest(liveReport(HOSTILE_ROOT_ROWS), {
      exportId: EXPORT_ID,
      rerunOf: null,
      generatedMs: EXPORT_CUTOFF_MS,
      data: { format: 'json', fileName: 'report.json', byteLength: 1, sha256: 'f'.repeat(64) },
      transformations: CSV_COUNTS
    });
    expect(json.transformations).toBeUndefined();
    expect(json.csvStatement).toBeUndefined();
    expect(json.versions.csvProfile).toBeUndefined();
    const saved = buildReportManifest(liveReport(HOSTILE_ROOT_ROWS), { exportId: null, rerunOf: null, generatedMs: 0 });
    expect(saved.data).toBeUndefined();
    expect(saved.exportId).toBeNull();
  });

  it('names the F06 versions only when a revision was pinned, with usage coverage', () => {
    const report = liveReport([UNSAFE_USAGE_ROW], {
      accountingRevision: 9,
      timeBasis: 'accounting-event',
      coverage: { roots: 1, attempts: 2, unknownDurations: 0, unattributed: 3, gaps: [{ kind: 'missing-usage', count: 1 }] }
    });
    const manifest = buildReportManifest(report, { exportId: null, rerunOf: 'b'.repeat(32), generatedMs: 0 });
    expect(manifest.versions.accountingPolicy).toBe(1);
    expect(manifest.versions.accountingCalculation).toBe(1);
    expect(manifest.coverage).toEqual({ roots: 1, attempts: 2, unknownDurations: 0, unattributed: 3, gaps: [{ kind: 'missing-usage', count: 1 }] });
    expect(manifest.units).toEqual(['count', 'usd']);
    expect(manifest.rerunOf).toBe('b'.repeat(32));
  });

  it('holds no directory', () => {
    expect(manifestText(csvManifest())).not.toMatch(/[\\/](Users|home|tmp|private)[\\/]/);
  });
});

describe('manifest hashing', () => {
  it('detects a one-byte change in the data file', () => {
    const changed = Buffer.from(DATA_BYTES);
    changed.writeUInt8(changed.readUInt8(2) ^ 0x01, 2);
    expect(csvManifest().data?.sha256).toBe(sha256(DATA_BYTES));
    expect(sha256(changed)).not.toBe(csvManifest().data?.sha256);
  });

  it('is compact JSON with a final newline, and its digest is stable', () => {
    const text = manifestText(csvManifest());
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).not.toMatch(/\n./);
    expect(manifestSha256(csvManifest())).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
  });

  it('lists units distinct and in code-point order', () => {
    expect(manifestUnits([UNSAFE_USAGE_ROW, ...HOSTILE_ROOT_ROWS])).toEqual(['count', 'ms', 'usd']);
    expect(manifestUnits([])).toEqual([]);
  });
});
