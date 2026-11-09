/**
 * FR-R6-F06 (T049, FR-013, research R8) — the legacy epoch.
 *
 * The first-terminal rollup (`metrics-rollup.jsonl`) is imported once into its own labelled
 * epoch, never into observations, so legacy totals cannot be counted twice and carry no
 * backend, model or phase. The rollup file is only read.
 *
 * The import:
 * 1. answers the stored result when the epoch is already `complete`;
 * 2. reads the rollup and opens the epoch row in state `importing`;
 * 3. inserts runs in batches of 500, one transaction each, with `INSERT OR IGNORE`, so an
 *    interrupted import resumes to the same rows;
 * 4. reads the rollup a second time and reconciles the stored runs against it: `empty` when
 *    nothing is stored and the rollup is absent or empty, otherwise `matched`, or `mismatch` with
 *    counts-only detail when the stored runs and the second read differ (a run landed between
 *    reads, or the rollup shrank or vanished after an interrupted import stored part of it), a
 *    read skipped bytes or records, or a run was excluded;
 * 5. completes the epoch in one transaction under a `legacy-import` revision, with the
 *    carry-forward header kept verbatim and the newest run as the boundary. That transaction
 *    re-reads the epoch first, so of two overlapping imports only one completes it; the other
 *    answers the stored result.
 *
 * A rollup that exists but cannot be read is refused (`store-unavailable`) and the epoch stays
 * open, so a failed read is never sealed as "no history". A run whose id is over 256 bytes or
 * holds a control character is excluded and counted; a cost over $1,000,000 is stored unknown.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { AccountingResult, EpochState, Reconciliation } from '../../contracts/usage-accounting/accounting-types';
import type { MetricsRollupRecord } from '../../metrics/metrics-rollup';
import { type MetricsRollupReadResult, readMetricsRollup } from '../../metrics/metrics-rollup-reader';
import type { NodeSqliteConnection } from '../sqlite-store';
import { inImmediateTransaction } from './accounting-transaction';
import { appendRevision } from './projection';

/** Where the import reads the rollup from; production reads the workspace file. */
export interface LegacyRollupSource {
  read(): Promise<MetricsRollupReadResult>;
}

export interface LegacyEpochResult {
  readonly state: EpochState;
  readonly importedRuns: number;
  readonly reconciliation: Reconciliation;
}

export interface LegacyImportContext {
  readonly nowUtc: string;
  /** Tests only: called after each committed batch, 1-based; throwing interrupts the import. */
  readonly failpoint?: ((batch: number) => void) | undefined;
}

/** research R8: runs per import transaction. */
export const LEGACY_IMPORT_BATCH = 500;
const MICROS_PER_USD = 1_000_000;
const MAX_HEADER_BYTES = 4096;
/** The longest legacy run id imported, in UTF-8 bytes; the observation identity bound. */
const MAX_LEGACY_RUN_ID_BYTES = 256;
/** A per-run legacy cost above this ($1,000,000) is not a credible run cost; it is stored unknown. */
const MAX_LEGACY_RUN_COST_MICROS = 1_000_000 * MICROS_PER_USD;
/** C0 controls end below this code point; DEL and the C1 controls span the next range. */
const C0_CONTROL_END = 0x20;
const DEL_AND_C1_FIRST = 0x7f;
const DEL_AND_C1_LAST = 0x9f;

function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code < C0_CONTROL_END || (code >= DEL_AND_C1_FIRST && code <= DEL_AND_C1_LAST);
}

interface LegacyRun {
  readonly runId: string;
  readonly terminalUtc: string;
  readonly outcome: string;
  readonly costMicros: number | null;
}

interface RollupTally {
  readonly runs: number;
  readonly costMicros: number;
}

interface StoredEpoch {
  readonly state: EpochState;
  readonly imported_runs: number | bigint;
  readonly reconciliation: Reconciliation | null;
}

export function metricsRollupLegacySource(workspaceRoot: string): LegacyRollupSource {
  return { read: () => readMetricsRollup(workspaceRoot) };
}

/** USD as reported, in integer micro-units; `null` when absent, negative or not finite. */
function costMicrosOf(costUsd: number | undefined): number | null {
  if (costUsd === undefined || !Number.isFinite(costUsd) || costUsd < 0) return null;
  const micros = Math.round(costUsd * MICROS_PER_USD);
  return Number.isSafeInteger(micros) && micros <= MAX_LEGACY_RUN_COST_MICROS ? micros : null;
}

function isImportableRunId(runId: string): boolean {
  return Buffer.byteLength(runId, 'utf8') <= MAX_LEGACY_RUN_ID_BYTES && ![...runId].some(isControlCharacter);
}

interface DistinctRuns {
  readonly runs: LegacyRun[];
  /** Records whose run id was refused, counted once per record. */
  readonly excluded: number;
}

/** One row per run id, the first record winning, as `INSERT OR IGNORE` keeps it. */
function distinctRuns(records: readonly MetricsRollupRecord[]): DistinctRuns {
  const byId = new Map<string, LegacyRun>();
  let excluded = 0;
  for (const record of records) {
    if (!isImportableRunId(record.runId)) {
      excluded += 1;
      continue;
    }
    if (byId.has(record.runId)) continue;
    byId.set(record.runId, {
      runId: record.runId,
      terminalUtc: new Date(Date.parse(record.endedAt)).toISOString(),
      outcome: record.terminalStatus,
      costMicros: costMicrosOf(record.costUsd)
    });
  }
  return { runs: [...byId.values()], excluded };
}

function tally(runs: readonly LegacyRun[]): RollupTally {
  return { runs: runs.length, costMicros: runs.reduce((sum, run) => sum + (run.costMicros ?? 0), 0) };
}

/** What either read lost: skipped bytes, unreadable records, excluded runs. Zero counts are omitted. */
function lossesOf(first: MetricsRollupReadResult, second: MetricsRollupReadResult, excludedRuns: number) {
  const skippedBytes = Math.max(first.skippedBytes ?? 0, second.skippedBytes ?? 0);
  const unreadableRecords = Math.max(first.unreadableRecords, second.unreadableRecords);
  return {
    ...(skippedBytes > 0 ? { skippedBytes } : {}),
    ...(unreadableRecords > 0 ? { unreadableRecords } : {}),
    ...(excludedRuns > 0 ? { excludedRuns } : {})
  };
}

function isEmptyRollup(read: MetricsRollupReadResult): boolean {
  return !read.available || (read.records.length === 0 && read.carryForward === undefined);
}

/** The header line exactly as the rollup holds it; `null` when absent or over 4 KiB. */
function headerOf(read: MetricsRollupReadResult): string | null {
  const header = read.carryForwardLine;
  if (header === undefined) return null;
  return Buffer.byteLength(header, 'utf8') <= MAX_HEADER_BYTES ? header : null;
}

function readEpoch(conn: NodeSqliteConnection): StoredEpoch | undefined {
  return conn.get<StoredEpoch>('SELECT state, imported_runs, reconciliation FROM accounting_legacy_epoch WHERE epoch_id = 1');
}

function storedResult(stored: StoredEpoch): LegacyEpochResult {
  return { state: 'complete', importedRuns: Number(stored.imported_runs), reconciliation: stored.reconciliation ?? 'empty' };
}

function insertBatches(conn: NodeSqliteConnection, runs: readonly LegacyRun[], context: LegacyImportContext): void {
  for (let start = 0, batch = 1; start < runs.length; start += LEGACY_IMPORT_BATCH, batch += 1) {
    const slice = runs.slice(start, start + LEGACY_IMPORT_BATCH);
    inImmediateTransaction(conn, () => {
      for (const run of slice) {
        conn.run(
          `INSERT OR IGNORE INTO accounting_legacy_runs (run_id, terminal_utc, outcome, cost_micros, cost_origin, input_tokens, output_tokens)
           VALUES (?, ?, ?, ?, 'legacy-float', NULL, NULL)`,
          run.runId,
          run.terminalUtc,
          run.outcome,
          run.costMicros
        );
      }
    });
    context.failpoint?.(batch);
  }
}

/** What the epoch holds, which includes runs an earlier interrupted import stored. */
function storedTally(conn: NodeSqliteConnection): RollupTally {
  const row = conn.get<{ runs: number | bigint; cost: number | bigint }>(
    'SELECT count(*) AS runs, COALESCE(SUM(cost_micros), 0) AS cost FROM accounting_legacy_runs'
  );
  return { runs: Number(row?.runs ?? 0), costMicros: Number(row?.cost ?? 0) };
}

function reconcile(
  first: MetricsRollupReadResult,
  second: MetricsRollupReadResult,
  imported: RollupTally,
  excludedRuns: number
) {
  const losses = lossesOf(first, second, excludedRuns);
  const lossy = Object.keys(losses).length > 0;
  if (!lossy && imported.runs === 0 && isEmptyRollup(first) && isEmptyRollup(second)) return { reconciliation: 'empty' as const, detail: null };
  const reread = tally(distinctRuns(second.records).runs);
  if (!lossy && reread.runs === imported.runs && reread.costMicros === imported.costMicros) {
    return { reconciliation: 'matched' as const, detail: null };
  }
  const detail = JSON.stringify({
    importedRuns: imported.runs,
    rereadRuns: reread.runs,
    importedCostMicros: imported.costMicros,
    rereadCostMicros: reread.costMicros,
    ...losses
  });
  return { reconciliation: 'mismatch' as const, detail };
}

function completeEpoch(
  conn: NodeSqliteConnection,
  read: MetricsRollupReadResult,
  outcome: { reconciliation: Reconciliation; detail: string | null },
  nowUtc: string
): LegacyEpochResult {
  return inImmediateTransaction(conn, (): LegacyEpochResult => {
    const stored = readEpoch(conn);
    if (stored?.state === 'complete') return storedResult(stored);
    const importedRuns = Number(conn.scalar('SELECT count(*) FROM accounting_legacy_runs') ?? 0);
    const boundary = conn.get<{ run_id: string; terminal_utc: string }>(
      'SELECT run_id, terminal_utc FROM accounting_legacy_runs ORDER BY julianday(terminal_utc) DESC, run_id DESC LIMIT 1'
    );
    appendRevision(conn, 'legacy-import', nowUtc, 0);
    conn.run(
      `UPDATE accounting_legacy_epoch SET state = 'complete', boundary_run_id = ?, boundary_terminal_utc = ?, imported_runs = ?,
         legacy_cost_micros = (SELECT COALESCE(SUM(cost_micros), 0) FROM accounting_legacy_runs),
         carry_forward_header = ?, reconciliation = ?, reconciliation_detail = ?, completed_utc = ?
       WHERE epoch_id = 1`,
      boundary?.run_id ?? null,
      boundary?.terminal_utc ?? null,
      importedRuns,
      headerOf(read),
      outcome.reconciliation,
      outcome.detail,
      nowUtc
    );
    return { state: 'complete', importedRuns, reconciliation: outcome.reconciliation };
  });
}

const UNREADABLE_ROLLUP: AccountingResult<LegacyEpochResult> = Object.freeze({
  ok: false,
  refusal: Object.freeze({ code: 'store-unavailable', detail: 'legacy-rollup-unreadable' })
});

/** Imports the legacy rollup once; see the module comment. Store errors propagate to the facade. */
export async function importLegacyEpoch(
  conn: NodeSqliteConnection,
  source: LegacyRollupSource,
  context: LegacyImportContext
): Promise<AccountingResult<LegacyEpochResult>> {
  const stored = readEpoch(conn);
  if (stored?.state === 'complete') return { ok: true, value: storedResult(stored) };
  const first = await source.read();
  if (first.readFailed === true) return UNREADABLE_ROLLUP;
  if (stored === undefined) {
    conn.run(
      `INSERT OR IGNORE INTO accounting_legacy_epoch (epoch_id, state, imported_runs, legacy_cost_micros, started_utc)
       VALUES (1, 'importing', 0, 0, ?)`,
      context.nowUtc
    );
  }
  const { runs, excluded } = distinctRuns(first.records);
  insertBatches(conn, runs, context);
  const second = await source.read();
  if (second.readFailed === true) return UNREADABLE_ROLLUP;
  const outcome = reconcile(first, second, storedTally(conn), excluded);
  return { ok: true, value: completeEpoch(conn, first, outcome, context.nowUtc) };
}
