// FR-R6-F11 T031 (FR-011..FR-018, NFR-003; F11-AC-04..06) — an export ends in exactly one outcome,
// publishes the data before its manifest and leaves no partial file behind.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReportManifest } from '../../../src/contracts/reporting/report-manifest';
import type { ReportProgress } from '../../../src/contracts/reporting/report-outcomes';
import { nodeExportFs, type ExportFileHandle, type ExportFs } from '../../../src/services/reporting/export-publisher';
import { runExport, type ExportDeps, type ExportRequest } from '../../../src/services/reporting/export-service';
import { ExportStore } from '../../../src/services/reporting/export-store';
import type { NodeSqliteConnection } from '../../../src/services/sqlite-store';
import { EXPORT_CUTOFF_MS, HOSTILE_ROOT_ROWS, liveReport } from './export-fixture';
import { FIXTURE_WORKSPACE, withStoreAsync } from './report-fixture';

const EXPORT_ID = '1'.padStart(32, '0');
const FAILED_CODE = 'reporting: export failed';

let sandbox = '';
let outDir = '';

beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'export-service-')));
  outDir = path.join(sandbox, 'out');
  fs.mkdirSync(outDir);
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

type Warning = { readonly code: string; readonly context: { readonly operation: string; readonly reason: string } };

interface Harness {
  readonly deps: ExportDeps;
  readonly store: ExportStore;
  readonly warnings: Warning[];
}

function harness(conn: NodeSqliteConnection, overrides: Partial<ExportDeps> = {}): Harness {
  const warnings: Warning[] = [];
  const store = new ExportStore(conn);
  const deps: ExportDeps = {
    store,
    fs: nodeExportFs,
    nowMs: () => EXPORT_CUTOFF_MS + 1_000,
    monotonicMs: () => 0,
    newExportId: () => EXPORT_ID,
    logger: { warn: (code, context) => warnings.push({ code, context: { ...context } }) },
    yieldNow: () => Promise.resolve(),
    ...overrides
  };
  return { deps, store, warnings };
}

function request(fileName: string, overrides: Partial<ExportRequest> = {}): ExportRequest {
  return {
    report: liveReport(HOSTILE_ROOT_ROWS),
    workspaceId: FIXTURE_WORKSPACE,
    destinationPath: path.join(outDir, fileName),
    evidenceStore: path.join(sandbox, 'ws', '.schegent'),
    format: fileName.endsWith('.csv') ? 'csv' : 'json',
    overwrite: false,
    ...overrides
  };
}

const entries = (): readonly string[] => fs.readdirSync(outDir).sort();
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function readManifest(fileName: string): ReportManifest {
  return JSON.parse(fs.readFileSync(path.join(outDir, `${fileName}.manifest.json`), 'utf8')) as ReportManifest;
}

function injected(code: string): Error {
  return Object.assign(new Error('injected'), { code });
}

/** The host filesystem with some operations replaced. */
function withFault(patch: Partial<ExportFs>): ExportFs {
  return { ...nodeExportFs, ...patch };
}

/** Opens real partials whose `operation` fails on the `failAt`-th call (1-based) for the `nth` opened file. */
function handleFault(operation: keyof ExportFileHandle, nth: number, failAt = 1): ExportFs {
  let opened = 0;
  return withFault({
    async open(anchor, name) {
      const handle = await nodeExportFs.open(anchor, name);
      opened += 1;
      if (handle === null || opened !== nth) return handle;
      let calls = 0;
      return {
        ...handle,
        [operation]: (...args: Parameters<ExportFileHandle['write']>) => {
          calls += 1;
          if (calls >= failAt && operation !== 'close') return Promise.reject(injected('EIO'));
          return (handle[operation] as (...inner: typeof args) => Promise<void>)(...args);
        }
      };
    }
  });
}

/** A monotonic clock that moves `stepMs` each time it is read. */
function steppingClock(stepMs: number): () => number {
  let now = 0;
  return () => {
    now += stepMs;
    return now;
  };
}

describe('a complete export', () => {
  it.each(['report.json', 'report.csv'])('publishes %s and its manifest, and records the hash', async (fileName) => {
    await withStoreAsync(async (conn) => {
      const { deps, store, warnings } = harness(conn, { bufferBytes: 16 });
      const progress: ReportProgress[] = [];
      const result = await runExport(request(fileName, { onProgress: (entry) => progress.push(entry) }), deps);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const bytes = fs.readFileSync(path.join(outDir, fileName));
      const format = fileName.endsWith('.csv') ? 'csv' : 'json';
      expect(result.value).toMatchObject({
        exportId: EXPORT_ID,
        reportId: 'a'.repeat(32),
        format,
        fileName,
        manifestFileName: `${fileName}.manifest.json`,
        rowCount: 2,
        byteLength: bytes.length,
        sha256: sha256(bytes)
      });
      const manifest = readManifest(fileName);
      expect(manifest.data).toEqual({ format, fileName, byteLength: bytes.length, sha256: sha256(bytes) });
      expect(manifest.exportId).toBe(EXPORT_ID);
      expect(result.value.manifest).toEqual(manifest);
      expect(entries()).toEqual([fileName, `${fileName}.manifest.json`]);
      expect(store.get(EXPORT_ID)).toMatchObject({ state: 'completed', byteLength: bytes.length, sha256: sha256(bytes) });
      expect(progress.map((entry) => entry.phase)).toContain('writing');
      expect(progress.at(-1)).toMatchObject({ phase: 'publishing', rowsDone: 2, rowsTotal: 2 });
      expect(JSON.stringify(result.value)).not.toContain(sandbox);
      expect(warnings).toEqual([]);
    });
  });

  it('writes the same bytes for the same snapshot and format', async () => {
    await withStoreAsync(async (conn) => {
      let id = 0;
      const { deps } = harness(conn, { newExportId: () => String((id += 1)).padStart(32, '0') });
      const first = await runExport(request('one.csv'), deps);
      const second = await runExport(request('two.csv'), deps);
      expect(first.ok && second.ok).toBe(true);
      expect(fs.readFileSync(path.join(outDir, 'one.csv'))).toEqual(fs.readFileSync(path.join(outDir, 'two.csv')));
    });
  });

  it('replaces an existing file only with overwrite', async () => {
    await withStoreAsync(async (conn) => {
      fs.writeFileSync(path.join(outDir, 'report.json'), 'old');
      const { deps } = harness(conn);
      const result = await runExport(request('report.json', { overwrite: true }), deps);
      expect(result.ok).toBe(true);
      expect(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8')).not.toBe('old');
    });
  });
});

describe('a refused export', () => {
  it('refuses a missing destination directory and creates nothing', async () => {
    await withStoreAsync(async (conn) => {
      const { deps, store } = harness(conn);
      const result = await runExport(request('report.json', { destinationPath: path.join(outDir, 'missing', 'r.json') }), deps);
      expect(result).toEqual({ ok: false, outcome: 'refused', reason: 'destination-unresolvable' });
      expect(fs.existsSync(path.join(outDir, 'missing'))).toBe(false);
      expect(store.get(EXPORT_ID)).toBeNull();
    });
  });

  it('refuses a directory that resolves into the evidence store after the destination was checked', async () => {
    await withStoreAsync(async (conn) => {
      const { deps, store } = harness(conn);
      const inner = path.join(sandbox, 'ws', '.schegent', 'inner');
      fs.mkdirSync(inner, { recursive: true });
      fs.symlinkSync(inner, path.join(outDir, 'swapped'), 'dir');
      const result = await runExport(request('report.json', { destinationPath: path.join(outDir, 'swapped', 'r.json') }), deps);
      expect(result).toEqual({ ok: false, outcome: 'refused', reason: 'destination-in-evidence-store' });
      expect(fs.readdirSync(inner)).toEqual([]);
      expect(store.get(EXPORT_ID)).toBeNull();
    });
  });

  it.each(['report.json', 'report.json.manifest.json'])('refuses at start when %s exists', async (existing) => {
    await withStoreAsync(async (conn) => {
      fs.writeFileSync(path.join(outDir, existing), 'keep');
      const { deps, store } = harness(conn);
      const result = await runExport(request('report.json'), deps);
      expect(result).toEqual({ ok: false, outcome: 'refused', reason: 'destination-exists' });
      expect(fs.readFileSync(path.join(outDir, existing), 'utf8')).toBe('keep');
      expect(entries()).toEqual([existing]);
      expect(store.get(EXPORT_ID)).toBeNull();
    });
  });

  it('refuses at publication when the file appeared during the write', async () => {
    await withStoreAsync(async (conn) => {
      const { deps, store } = harness(conn, {
        fs: withFault({
          linkContained: (existing, created) => {
            fs.writeFileSync(created, 'raced');
            return nodeExportFs.linkContained(existing, created);
          }
        })
      });
      const result = await runExport(request('report.json'), deps);
      expect(result).toEqual({ ok: false, outcome: 'refused', reason: 'destination-exists' });
      expect(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8')).toBe('raced');
      expect(entries()).toEqual(['report.json']);
      expect(store.get(EXPORT_ID)).toMatchObject({ state: 'failed', reason: 'destination-exists' });
    });
  });

  it('refuses a second export in the same workspace', async () => {
    await withStoreAsync(async (conn) => {
      const { deps, store } = harness(conn);
      store.insertPending({
        exportId: 'b'.repeat(32),
        workspaceId: FIXTURE_WORKSPACE,
        reportId: 'a'.repeat(32),
        format: 'json',
        stagingDir: outDir,
        finalName: 'other.json',
        dataPartialName: '.d',
        manifestPartialName: '.m',
        overwrite: false,
        createdMs: 0
      });
      const result = await runExport(request('report.json'), deps);
      expect(result).toEqual({ ok: false, outcome: 'refused', reason: 'export-busy' });
      expect(entries()).toEqual([]);
    });
  });
});

describe('an export that stops before publication', () => {
  it('ends cancelled when the signal aborts mid-write', async () => {
    await withStoreAsync(async (conn) => {
      const controller = new AbortController();
      const { deps, store } = harness(conn, {
        monotonicMs: steppingClock(10),
        yieldNow: () => {
          controller.abort();
          return Promise.resolve();
        }
      });
      const result = await runExport(request('report.json', { signal: controller.signal }), deps);
      expect(result).toEqual({ ok: false, outcome: 'cancelled' });
      expect(entries()).toEqual([]);
      expect(store.get(EXPORT_ID)).toMatchObject({ state: 'cancelled', reason: null });
    });
  });

  it.each([
    ['export-rows', { caps: { maxRows: 1 } }],
    ['export-bytes', { caps: { maxBytes: 8 } }],
    ['export-time', { caps: { maxMs: 25 }, monotonicMs: steppingClock(10) }]
  ] as const)('ends limited %s', async (limit, overrides) => {
    await withStoreAsync(async (conn) => {
      const { deps, store, warnings } = harness(conn, overrides);
      const result = await runExport(request('report.csv'), deps);
      expect(result).toEqual({ ok: false, outcome: 'limited', limit });
      expect(entries()).toEqual([]);
      expect(store.get(EXPORT_ID)).toMatchObject({ state: 'limited', reason: limit });
      expect(warnings).toEqual([]);
    });
  });

  it.each([
    ['the partial open', withFault({ open: () => Promise.reject(injected('EACCES')) })],
    ['a refused partial open', withFault({ open: () => Promise.resolve(null) })],
    ['the first data write', handleFault('write', 1)],
    ['a later data write', handleFault('write', 1, 2)],
    ['the data fsync', handleFault('sync', 1)],
    ['the manifest write', handleFault('write', 2)],
    ['the manifest fsync', handleFault('sync', 2)]
  ])('ends failed write-failed on a fault at %s', async (_where, faulty) => {
    await withStoreAsync(async (conn) => {
      const { deps, store, warnings } = harness(conn, { fs: faulty, bufferBytes: 16 });
      const result = await runExport(request('report.json'), deps);
      expect(result).toEqual({ ok: false, outcome: 'failed', reason: 'write-failed' });
      expect(entries()).toEqual([]);
      expect(store.get(EXPORT_ID)).toMatchObject({ state: 'failed', reason: 'write-failed' });
      expect(warnings).toEqual([{ code: FAILED_CODE, context: { operation: 'exportReport', reason: 'write-failed' } }]);
    });
  });
});

describe('an export that fails at publication', () => {
  it('ends publish-failed and leaves no file when the data publish fails', async () => {
    await withStoreAsync(async (conn) => {
      const { deps, store } = harness(conn, { fs: withFault({ linkContained: () => Promise.reject(injected('EIO')) }) });
      const result = await runExport(request('report.json'), deps);
      expect(result).toEqual({ ok: false, outcome: 'failed', reason: 'publish-failed' });
      expect(entries()).toEqual([]);
      expect(store.get(EXPORT_ID)).toMatchObject({ state: 'failed', reason: 'publish-failed' });
    });
  });

  it('ends manifest-publish-failed and keeps the data file without a manifest', async () => {
    await withStoreAsync(async (conn) => {
      let links = 0;
      const { deps, store, warnings } = harness(conn, {
        fs: withFault({
          linkContained: (existing, created) => {
            links += 1;
            return links === 2 ? Promise.reject(injected('EIO')) : nodeExportFs.linkContained(existing, created);
          }
        })
      });
      const result = await runExport(request('report.json'), deps);
      expect(result).toEqual({ ok: false, outcome: 'failed', reason: 'manifest-publish-failed' });
      expect(entries()).toEqual(['report.json']);
      expect(store.get(EXPORT_ID)).toMatchObject({ state: 'failed', reason: 'manifest-publish-failed' });
      expect(warnings.map((warning) => warning.context.reason)).toEqual(['manifest-publish-failed']);
    });
  });

  it('answers host-stopped, as the record does, when reconciliation ended the export before it completed', async () => {
    await withStoreAsync(async (conn) => {
      class ReconciledFirst extends ExportStore {
        override complete(exportId: string, result: Parameters<ExportStore['complete']>[1]): boolean {
          this.finish(exportId, 'failed', 'host-stopped', result.completedMs);
          return super.complete(exportId, result);
        }
      }
      const store = new ReconciledFirst(conn);
      const { deps, warnings } = harness(conn, { store });
      const result = await runExport(request('report.json'), deps);
      expect(result).toEqual({ ok: false, outcome: 'failed', reason: 'host-stopped' });
      expect(store.get(EXPORT_ID)).toMatchObject({ state: 'failed', reason: 'host-stopped' });
      expect(warnings.map((warning) => warning.context.reason)).toEqual(['host-stopped']);
    });
  });

  it('answers a typed failure, never a rejection, when the record cannot be written', async () => {
    await withStoreAsync(async (conn) => {
      class BusyStore extends ExportStore {
        override complete(): boolean {
          throw injected('SQLITE_BUSY');
        }
        override finish(): boolean {
          throw injected('SQLITE_BUSY');
        }
      }
      const store = new BusyStore(conn);
      const { deps, warnings } = harness(conn, { store });
      const result = await runExport(request('report.json'), deps);
      expect(result).toEqual({ ok: false, outcome: 'failed', reason: 'write-failed' });
      expect(store.get(EXPORT_ID)).toMatchObject({ state: 'pending' });
      expect(entries()).toEqual(['report.json', 'report.json.manifest.json']);
      expect(warnings.map((warning) => warning.context.reason)).toEqual(['write-failed', 'write-failed']);
      expect(JSON.stringify(warnings)).not.toContain('SQLITE_BUSY');
    });
  });

  it('ends write-failed, records it and leaves no partial when serialization throws', async () => {
    await withStoreAsync(async (conn) => {
      const { deps, store } = harness(conn);
      const report = liveReport(HOSTILE_ROOT_ROWS);
      const throwing = Object.defineProperty({ ...report }, 'rows', {
        get: () => {
          throw new Error('injected');
        }
      });
      const result = await runExport(request('report.json', { report: throwing }), deps);
      expect(result).toEqual({ ok: false, outcome: 'failed', reason: 'write-failed' });
      expect(store.get(EXPORT_ID)).toMatchObject({ state: 'failed', reason: 'write-failed' });
      expect(entries()).toEqual([]);
    });
  });

  it('never touches an unrelated file in the directory', async () => {
    await withStoreAsync(async (conn) => {
      fs.writeFileSync(path.join(outDir, 'notes.txt'), 'keep');
      const { deps } = harness(conn, { fs: withFault({ linkContained: () => Promise.reject(injected('EIO')) }) });
      await runExport(request('report.json'), deps);
      expect(entries()).toEqual(['notes.txt']);
      expect(fs.readFileSync(path.join(outDir, 'notes.txt'), 'utf8')).toBe('keep');
    });
  });
});
