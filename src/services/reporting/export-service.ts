/**
 * FR-R6-F11 (FR-011..FR-018, NFR-003; research R8, R9) — one export of a live report to a file.
 *
 * Each export ends in exactly one outcome, recorded on its `report_exports` row:
 *
 * 1. The destination directory resolves to its anchor; nothing creates a directory. The resolved
 *    file is classified against the evidence store again, so a directory swapped for a link into
 *    the store after `resolveExportDestination` checked it is refused. Without overwrite, an
 *    existing data or manifest file refuses `destination-exists`.
 * 2. The row is inserted `pending`; a second export in the workspace is refused `export-busy`.
 *    The anchor is resolved first because the row stores it for reconciliation.
 * 3. Both partials are opened, the data is written in sliced chunks through an 8 MiB buffer and
 *    hashed as it is written, and cancellation, the clock and the caps are checked per row.
 * 4. The manifest partial is written, both files are synced, then the data is published before
 *    the manifest. A data file whose manifest cannot publish stays, visibly incomplete.
 * 5. Every outcome then removes only this export's own partials.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { createHash, type Hash } from 'node:crypto';
import * as path from 'node:path';
import type { ExportFormat, ExportReceipt } from '../../contracts/reporting/report-manifest';
import {
  reportCancelled,
  reportFailed,
  reportLimited,
  reportOk,
  reportRefused,
  type ReportFailure,
  type ReportProgressListener,
  type ReportResult
} from '../../contracts/reporting/report-outcomes';
import { classifyDestination, resolveWritableAnchor } from '../../lib/path-containment';
import { buildReportManifest, manifestText } from './export-manifest';
import { openPartial, partialNames, publishPartial, removePartials, type ExportFileHandle, type ExportFs } from './export-publisher';
import { createExportSerializer, type ExportSerializer } from './export-serializer';
import type { ExportOutcomeReason, ExportStore, ExportTerminalState } from './export-store';
import type { ReportingLogger } from './report-capture';
import type { LiveReport } from './report-snapshots';
import { DEFAULT_SLICE_MS } from './work-slicer';

const MIB = 1024 * 1024;
const MANIFEST_SUFFIX = '.manifest.json';
const EXPORT_FAILED = 'reporting: export failed';
const OPERATION = 'exportReport';

export interface ExportCaps {
  readonly maxRows: number;
  readonly maxBytes: number;
  readonly maxMs: number;
}

/** NFR-003: 100,000 data rows, 64 MiB of output, 60 seconds. */
export const DEFAULT_EXPORT_CAPS: ExportCaps = Object.freeze({ maxRows: 100_000, maxBytes: 64 * MIB, maxMs: 60_000 });
/** NFR-003: buffering stays within 8 MiB. */
export const EXPORT_BUFFER_BYTES = 8 * MIB;

export interface ExportRequest {
  readonly report: LiveReport;
  readonly workspaceId: string;
  /** An absolute file path already accepted by `resolveExportDestination`. */
  readonly destinationPath: string;
  /** The workspace's evidence store; the resolved destination is checked against it again. */
  readonly evidenceStore: string;
  readonly format: ExportFormat;
  readonly overwrite: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: ReportProgressListener;
}

export interface ExportDeps {
  readonly store: ExportStore;
  readonly fs: ExportFs;
  readonly nowMs: () => number;
  readonly monotonicMs: () => number;
  readonly newExportId: () => string;
  readonly logger?: ReportingLogger;
  readonly caps?: Partial<ExportCaps>;
  readonly bufferBytes?: number;
  readonly sliceMs?: number;
  /** Yields to the event loop; `setImmediate` when absent. */
  readonly yieldNow?: () => Promise<void>;
}

interface Target {
  readonly anchor: string;
  readonly finalName: string;
}

interface Written {
  readonly byteLength: number;
  readonly sha256: string;
}

const yieldImmediate = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function resolveTarget(request: ExportRequest, filesystem: ExportFs): Promise<ReportResult<Target>> {
  if (!path.isAbsolute(request.destinationPath)) return reportRefused('destination-unresolvable');
  const finalName = path.basename(request.destinationPath);
  const resolved = await resolveWritableAnchor(path.dirname(request.destinationPath), filesystem);
  if (resolved === null || resolved.tail.length > 0) return reportRefused('destination-unresolvable');
  const placed = await classifyDestination(path.join(resolved.anchor, finalName), [request.evidenceStore], filesystem);
  if (placed === 'inside') return reportRefused('destination-in-evidence-store');
  if (placed === 'unresolvable') return reportRefused('destination-unresolvable');
  const target = { anchor: resolved.anchor, finalName };
  if (request.overwrite) return reportOk(target);
  try {
    const dataTaken = await filesystem.exists(path.join(resolved.anchor, finalName));
    const manifestTaken = await filesystem.exists(path.join(resolved.anchor, finalName + MANIFEST_SUFFIX));
    return dataTaken || manifestTaken ? reportRefused('destination-exists') : reportOk(target);
  } catch {
    return reportRefused('destination-unresolvable');
  }
}

/** Buffers encoded text up to `limit` bytes before each write, hashing every byte once. */
class ChunkSink {
  private readonly hash: Hash = createHash('sha256');
  private chunks: Buffer[] = [];
  private buffered = 0;
  public byteLength = 0;

  public constructor(
    private readonly handle: ExportFileHandle,
    private readonly limit: number
  ) {}

  public async append(text: string): Promise<void> {
    const bytes = Buffer.from(text, 'utf8');
    this.hash.update(bytes);
    this.byteLength += bytes.length;
    this.chunks.push(bytes);
    this.buffered += bytes.length;
    if (this.buffered >= this.limit) await this.flush();
  }

  public async flush(): Promise<void> {
    if (this.buffered === 0) return;
    const bytes = Buffer.concat(this.chunks, this.buffered);
    this.chunks = [];
    this.buffered = 0;
    await this.handle.write(bytes);
  }

  public digest(): string {
    return this.hash.digest('hex');
  }
}

class ExportRun {
  private readonly caps: ExportCaps;
  private readonly startMs: number;
  private sliceStartMs: number;

  public constructor(
    private readonly request: ExportRequest,
    private readonly deps: ExportDeps
  ) {
    this.caps = { ...DEFAULT_EXPORT_CAPS, ...deps.caps };
    this.startMs = deps.monotonicMs();
    this.sliceStartMs = this.startMs;
  }

  private aborted(): boolean {
    return this.request.signal?.aborted === true;
  }

  public progress(phase: 'writing' | 'publishing', rowsDone: number, rowsTotal: number): void {
    const elapsedMs = this.deps.monotonicMs() - this.startMs;
    this.request.onProgress?.({ phase, rowsDone, rowsTotal, elapsedMs });
  }

  /** Cancellation and the clock, then a yield once the slice is spent. */
  private async checkpoint(rowsDone: number, rowsTotal: number): Promise<ReportFailure | null> {
    if (this.aborted()) return reportCancelled();
    const now = this.deps.monotonicMs();
    if (now - this.startMs > this.caps.maxMs) return reportLimited('export-time');
    if (now - this.sliceStartMs < (this.deps.sliceMs ?? DEFAULT_SLICE_MS)) return null;
    this.progress('writing', rowsDone, rowsTotal);
    await (this.deps.yieldNow ?? yieldImmediate)();
    this.sliceStartMs = this.deps.monotonicMs();
    return this.aborted() ? reportCancelled() : null;
  }

  /** Writes the whole data file; a cap, a cancellation or the clock ends it early. */
  public async writeData(serializer: ExportSerializer, handle: ExportFileHandle): Promise<ReportResult<Written>> {
    const total = serializer.rowCount;
    const sink = new ChunkSink(handle, this.deps.bufferBytes ?? EXPORT_BUFFER_BYTES);
    this.progress('writing', 0, total);
    await sink.append(serializer.head());
    for (let index = 0; index < total; index += 1) {
      const stop = await this.checkpoint(index, total);
      if (stop !== null) return stop;
      if (index >= this.caps.maxRows) return reportLimited('export-rows');
      await sink.append(serializer.row(index));
      if (sink.byteLength > this.caps.maxBytes) return reportLimited('export-bytes');
    }
    await sink.append(serializer.tail());
    if (sink.byteLength > this.caps.maxBytes) return reportLimited('export-bytes');
    const stop = await this.checkpoint(total, total);
    if (stop !== null) return stop;
    await sink.flush();
    return reportOk({ byteLength: sink.byteLength, sha256: sink.digest() });
  }
}

/** The record's terminal state and reason for an incomplete outcome. */
function terminalOf(failure: ReportFailure): { readonly state: ExportTerminalState; readonly reason: ExportOutcomeReason | null } {
  switch (failure.outcome) {
    case 'cancelled':
      return { state: 'cancelled', reason: null };
    case 'limited':
      return { state: 'limited', reason: failure.limit };
    case 'failed':
      return { state: 'failed', reason: failure.reason };
    case 'refused':
      return { state: 'failed', reason: failure.reason === 'destination-exists' ? 'destination-exists' : 'write-failed' };
    case 'expired':
      return { state: 'failed', reason: 'write-failed' };
  }
}

async function closeAll(handles: readonly (ExportFileHandle | null)[]): Promise<void> {
  for (const handle of handles) {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
}

interface Staged {
  readonly request: ExportRequest;
  readonly deps: ExportDeps;
  readonly target: Target;
  readonly exportId: string;
  readonly names: { readonly data: string; readonly manifest: string };
}

/** Writes both partials and publishes them; any throw from a write or sync is `write-failed`. */
async function stageAndPublish(staged: Staged): Promise<ReportResult<ExportReceipt>> {
  const { request, deps, target, exportId, names } = staged;
  const run = new ExportRun(request, deps);
  const report = request.report;
  const dataHandle = await openPartial(deps.fs, target.anchor, names.data);
  const manifestHandle = dataHandle === null ? null : await openPartial(deps.fs, target.anchor, names.manifest);
  let open = true;
  try {
    if (dataHandle === null || manifestHandle === null) return reportFailed('write-failed');
    const serializer = createExportSerializer(
      { reportId: report.reportId, view: report.query.view, calculationVersion: report.calculationVersion, rows: report.rows },
      request.format
    );
    const written = await run.writeData(serializer, dataHandle);
    if (!written.ok) return written;
    await dataHandle.sync();
    const transformations = serializer.transformations();
    const manifest = buildReportManifest(report, {
      exportId,
      rerunOf: report.rerunOf ?? null,
      generatedMs: deps.nowMs(),
      data: { format: request.format, fileName: target.finalName, ...written.value },
      ...(transformations !== undefined ? { transformations } : {})
    });
    await manifestHandle.write(Buffer.from(manifestText(manifest), 'utf8'));
    await manifestHandle.sync();
    open = false;
    await closeAll([dataHandle, manifestHandle]);
    run.progress('publishing', serializer.rowCount, serializer.rowCount);
    const manifestFileName = target.finalName + MANIFEST_SUFFIX;
    const data = await publishPartial(deps.fs, target.anchor, names.data, target.finalName, request.overwrite);
    if (data === 'exists') return reportRefused('destination-exists');
    if (data === 'failed') return reportFailed('publish-failed');
    const published = await publishPartial(deps.fs, target.anchor, names.manifest, manifestFileName, request.overwrite);
    if (published !== 'published') return reportFailed('manifest-publish-failed');
    const rowCount = serializer.rowCount;
    // Reconciliation may have ended the record first (a host clock that jumped); the record wins.
    if (!deps.store.complete(exportId, { rowCount, ...written.value, completedMs: deps.nowMs() })) {
      return reportFailed('host-stopped');
    }
    return reportOk({
      exportId,
      reportId: report.reportId,
      format: request.format,
      fileName: target.finalName,
      manifestFileName,
      rowCount,
      ...written.value,
      manifest
    });
  } catch {
    return reportFailed('write-failed');
  } finally {
    if (open) await closeAll([dataHandle, manifestHandle]);
  }
}

/** Exports `request.report`; see the module comment for the steps. */
export async function runExport(request: ExportRequest, deps: ExportDeps): Promise<ReportResult<ExportReceipt>> {
  const target = await resolveTarget(request, deps.fs);
  if (!target.ok) return target;
  const exportId = deps.newExportId();
  const names = partialNames(target.value.finalName, exportId);
  const admitted = deps.store.insertPending({
    exportId,
    workspaceId: request.workspaceId,
    reportId: request.report.reportId,
    format: request.format,
    stagingDir: target.value.anchor,
    finalName: target.value.finalName,
    dataPartialName: names.data,
    manifestPartialName: names.manifest,
    overwrite: request.overwrite,
    createdMs: deps.nowMs()
  });
  if (!admitted.ok) return reportRefused(admitted.reason);
  const outcome = await stageAndPublish({ request, deps, target: target.value, exportId, names });
  await removePartials(deps.fs, target.value.anchor, [names.data, names.manifest]);
  if (outcome.ok) return outcome;
  finishRecord(deps, exportId, outcome);
  if (outcome.outcome === 'failed') deps.logger?.warn(EXPORT_FAILED, { operation: OPERATION, reason: outcome.reason });
  return outcome;
}

/**
 * Ends the record of an incomplete export. A store that cannot be written leaves the record
 * `pending`; the reconciler ends it `host-stopped` once it is stale, so the caller still gets the
 * outcome rather than a rejection.
 */
function finishRecord(deps: ExportDeps, exportId: string, outcome: ReportFailure): void {
  const terminal = terminalOf(outcome);
  try {
    deps.store.finish(exportId, terminal.state, terminal.reason, deps.nowMs());
  } catch {
    deps.logger?.warn(EXPORT_FAILED, { operation: OPERATION, reason: 'write-failed' });
  }
}
