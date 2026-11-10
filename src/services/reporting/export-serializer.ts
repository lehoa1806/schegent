/**
 * FR-R6-F11 (FR-011, FR-013, NFR-006; research R6, R7) — a report snapshot as JSON or CSV text.
 *
 * Both formats hold the same rows in the same order. Each row is flattened into dotted columns:
 * nested objects join their keys with `.`, and a usage row's measures are keyed by measure name.
 * The columns are every flattened name, in first-seen order over the rows; a snapshot with no
 * rows has the one column `kind`. A cell a row does not have is unknown.
 *
 * - **JSON** (R7): one object, `schema`, `schemaVersion`, `reportId`, `view`,
 *   `calculationVersion`, `columns`, then `rows`, compact, with a final newline. Rows are written
 *   as they are, so unsafe integers and decimals stay the strings F06 returned.
 * - **CSV** (R6): a header record, then one record per row, through the CSV profile.
 *
 * Neither holds an export identity or a time, so one snapshot's text is byte-identical across
 * exports. The serializer is chunked: the caller writes `head()`, each `row(i)`, then `tail()`.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  REPORT_DATA_SCHEMA,
  REPORT_DATA_SCHEMA_VERSION,
  type CsvTransformation,
  type ExportFormat
} from '../../contracts/reporting/report-manifest';
import type { ReportView } from '../../contracts/reporting/report-query';
import type { ReportRow } from '../../contracts/reporting/report-rows';
import { CsvTransformationCounter, csvHeader, csvRecord, type CsvCell } from './csv-profile';

/** The column of a snapshot with no rows. */
const EMPTY_COLUMNS: readonly string[] = Object.freeze(['kind']);
/** Fields whose string values are exact decimal numbers from F06. */
const NUMERIC_STRING_FIELDS = new Set(['total', 'reportedTotal', 'estimatedTotal', 'costMicros']);

/** What the serializer reads from a snapshot. */
export interface ReportData {
  readonly reportId: string;
  readonly view: ReportView;
  readonly calculationVersion: number;
  readonly rows: readonly ReportRow[];
}

export interface ExportSerializer {
  readonly format: ExportFormat;
  readonly columns: readonly string[];
  readonly rowCount: number;
  head(): string;
  row(index: number): string;
  tail(): string;
  /** CSV only: each transformation applied so far, with its count. */
  transformations(): readonly { readonly name: CsvTransformation; readonly count: number }[] | undefined;
}

type FlatCells = Map<string, CsvCell>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cellOf(field: string, value: unknown): CsvCell {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return { kind: 'number', value };
  }
  if (typeof value === 'string' && NUMERIC_STRING_FIELDS.has(field)) {
    return { kind: 'number', value };
  }
  return { kind: 'text', value: String(value) };
}

/** An array of measure totals is keyed by measure name; any other array by position. */
function arrayEntries(items: readonly unknown[]): readonly (readonly [string, unknown])[] {
  return items.map((item, index) => {
    if (isRecord(item) && typeof item.measure === 'string') {
      const rest = Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'measure'));
      return [item.measure, rest] as const;
    }
    return [String(index), item] as const;
  });
}

function flattenInto(cells: FlatCells, prefix: string, field: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const [key, inner] of arrayEntries(value)) {
      flattenInto(cells, `${prefix}${key}.`, key, inner);
    }
    return;
  }
  if (isRecord(value)) {
    for (const [key, inner] of Object.entries(value)) {
      flattenInto(cells, `${prefix}${key}.`, key, inner);
    }
    return;
  }
  cells.set(prefix.slice(0, -1), cellOf(field, value));
}

/** A row's cells by dotted column name, in field order. */
export function flattenRow(row: ReportRow): ReadonlyMap<string, CsvCell> {
  const cells: FlatCells = new Map();
  flattenInto(cells, '', '', row);
  return cells;
}

/** Every flattened column name over `rows`, in first-seen order. */
export function columnsOf(rows: readonly ReportRow[]): readonly string[] {
  if (rows.length === 0) {
    return EMPTY_COLUMNS;
  }
  const seen = new Set<string>();
  for (const row of rows) {
    for (const name of flattenRow(row).keys()) {
      seen.add(name);
    }
  }
  return Object.freeze([...seen]);
}

function jsonSerializer(data: ReportData, columns: readonly string[]): ExportSerializer {
  const opening = JSON.stringify({
    schema: REPORT_DATA_SCHEMA,
    schemaVersion: REPORT_DATA_SCHEMA_VERSION,
    reportId: data.reportId,
    view: data.view,
    calculationVersion: data.calculationVersion,
    columns
  });
  return {
    format: 'json',
    columns,
    rowCount: data.rows.length,
    head: () => `${opening.slice(0, -1)},"rows":[`,
    row: (index) => (index === 0 ? '' : ',') + JSON.stringify(data.rows.at(index) ?? null),
    tail: () => ']}\n',
    transformations: () => undefined
  };
}

function csvSerializer(data: ReportData, columns: readonly string[]): ExportSerializer {
  const counter = new CsvTransformationCounter();
  return {
    format: 'csv',
    columns,
    rowCount: data.rows.length,
    head: () => csvHeader(columns, counter),
    row: (index) => {
      const row = data.rows.at(index);
      const cells = row === undefined ? new Map<string, CsvCell>() : flattenRow(row);
      return csvRecord(
        columns.map((name) => cells.get(name) ?? null),
        counter
      );
    },
    tail: () => '',
    transformations: () => counter.snapshot()
  };
}

/** A chunked serializer of `data` in `format`. */
export function createExportSerializer(data: ReportData, format: ExportFormat): ExportSerializer {
  const columns = columnsOf(data.rows);
  return format === 'json' ? jsonSerializer(data, columns) : csvSerializer(data, columns);
}
