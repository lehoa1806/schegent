// FR-R6-F11 T028 (research R6, R7; NFR-006) — one snapshot serialises to the same bytes every time.
import { describe, expect, it } from 'vitest';
import type { ExportFormat } from '../../../src/contracts/reporting/report-manifest';
import type { ReportRow } from '../../../src/contracts/reporting/report-rows';
import {
  columnsOf,
  createExportSerializer,
  flattenRow,
  type ReportData
} from '../../../src/services/reporting/export-serializer';
import { EXPORT_REPORT_ID, HOSTILE_ROOT_ROWS, UNSAFE_USAGE_ROW } from './export-fixture';

function dataOf(rows: readonly ReportRow[], view: ReportData['view'] = 'attempt-detail'): ReportData {
  return { reportId: EXPORT_REPORT_ID, view, calculationVersion: 1, rows };
}

function serialise(data: ReportData, format: ExportFormat): string {
  const serializer = createExportSerializer(data, format);
  let text = serializer.head();
  for (let index = 0; index < serializer.rowCount; index += 1) {
    text += serializer.row(index);
  }
  return text + serializer.tail();
}

describe('export serializer, JSON (R7)', () => {
  it('equals the compact JSON of the whole data object, in fixed key order, with a final newline', () => {
    const data = dataOf(HOSTILE_ROOT_ROWS);
    const text = serialise(data, 'json');
    const expected = JSON.stringify({
      schema: 'schegent.report-data',
      schemaVersion: 1,
      reportId: EXPORT_REPORT_ID,
      view: 'attempt-detail',
      calculationVersion: 1,
      columns: columnsOf(HOSTILE_ROOT_ROWS),
      rows: HOSTILE_ROOT_ROWS
    });
    expect(text).toBe(expected + '\n');
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      'schema',
      'schemaVersion',
      'reportId',
      'view',
      'calculationVersion',
      'columns',
      'rows'
    ]);
  });

  it('keeps unsafe totals as the exact strings F06 returned', () => {
    const parsed = JSON.parse(serialise(dataOf([UNSAFE_USAGE_ROW], 'usage'), 'json')) as { rows: readonly UsageLike[] };
    const cost = parsed.rows.at(0)?.measures.find((entry) => entry.measure === 'cost');
    expect(cost?.total).toBe('90071992547409930.123456');
  });

  it('holds no export identity and no time', () => {
    const text = serialise(dataOf(HOSTILE_ROOT_ROWS), 'json');
    expect(text).not.toMatch(/exportId|generated/);
  });

  it('writes an empty rows array for a zero-row snapshot', () => {
    const parsed = JSON.parse(serialise(dataOf([]), 'json')) as { columns: unknown; rows: unknown };
    expect(parsed.rows).toEqual([]);
    expect(parsed.columns).toEqual(['kind']);
  });
});

interface UsageLike {
  readonly measures: readonly { readonly measure: string; readonly total: string }[];
}

describe('export serializer, CSV (R6)', () => {
  it('writes the header and every row through the profile, unknown as ""', () => {
    const text = serialise(dataOf(HOSTILE_ROOT_ROWS), 'csv');
    const lines = text.split('\r\n');
    expect(lines.at(0)).toBe(
      '"text:kind","text:rootId","text:workflowId","text:frozenDefinitionId","text:outcome",' +
        '"text:createdUtc","text:durationMs","text:attempts"'
    );
    expect(lines.at(1)).toBe('"text:root","text:r1","text:build","","text:succeeded","text:2027-01-15T08:00:00.000Z","1200","1"');
    expect(lines.at(2)).toBe(
      '"text:root","text:r2","text:=HYPERLINK(""x"")\\u{202E}evil","","text:succeeded",' +
        '"text:2027-01-15T08:00:00.000Z","","1"'
    );
    expect(lines.at(3)).toBe('');
    expect(lines.length).toBe(4);
  });

  it('keys usage measures by name and prefixes unsafe decimals', () => {
    const text = serialise(dataOf([UNSAFE_USAGE_ROW], 'usage'), 'csv');
    const records = text.split('\r\n');
    const header = records.at(0);
    const record = records.at(1);
    const columns = (header ?? '').split(',');
    const cells = (record ?? '').split(',');
    const cellOf = (name: string): string | undefined => cells.at(columns.indexOf(`"text:${name}"`));
    expect(cellOf('measures.cost.total')).toBe('"number:90071992547409930.123456"');
    expect(cellOf('measures.input_tokens.total')).toBe('"12"');
    expect(cellOf('key.model')).toBe('""');
    expect(cellOf('measures.cost.coverage.known')).toBe('"1"');
  });

  it('counts its transformations for the manifest', () => {
    const serializer = createExportSerializer(dataOf(HOSTILE_ROOT_ROWS), 'csv');
    serializer.head();
    serializer.row(0);
    serializer.row(1);
    expect(serializer.transformations()).toEqual([
      { name: 'text-prefix', count: 8 + 5 + 5 },
      { name: 'control-escaped', count: 1 },
      { name: 'truncated', count: 0 },
      { name: 'number-prefixed', count: 0 }
    ]);
    expect(createExportSerializer(dataOf(HOSTILE_ROOT_ROWS), 'json').transformations()).toBeUndefined();
  });
});

describe('export serializer, both formats', () => {
  it.each(['json', 'csv'] as const)('is byte-identical across two serialisations (%s)', (format) => {
    const rows = [...HOSTILE_ROOT_ROWS, UNSAFE_USAGE_ROW];
    expect(serialise(dataOf(rows), format)).toBe(serialise(dataOf(rows), format));
  });

  it('holds the same rows in the same order in both formats', () => {
    const rows = [...HOSTILE_ROOT_ROWS, UNSAFE_USAGE_ROW];
    const json = JSON.parse(serialise(dataOf(rows), 'json')) as { rows: readonly { kind: string }[] };
    const csvRecords = serialise(dataOf(rows), 'csv').split('\r\n').slice(1, -1);
    expect(csvRecords.length).toBe(json.rows.length);
    expect(csvRecords.map((record) => record.split(',').at(0))).toEqual(json.rows.map((row) => `"text:${row.kind}"`));
  });

  it('flattens columns in first-seen order over the rows', () => {
    expect([...flattenRow(UNSAFE_USAGE_ROW).keys()].slice(0, 5)).toEqual([
      'kind',
      'key.backend',
      'key.model',
      'attempts',
      'roots'
    ]);
    const columns = columnsOf([...HOSTILE_ROOT_ROWS, UNSAFE_USAGE_ROW]);
    expect(columns.indexOf('rootId')).toBeLessThan(columns.indexOf('key.backend'));
  });
});
