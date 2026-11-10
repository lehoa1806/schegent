// FR-R6-F11 T032 (FR-015, FR-018; research R8) — a pending export left by an earlier host loses only
// its own partials and ends failed with host-stopped.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeExportFs, partialNames } from '../../../src/services/reporting/export-publisher';
import { EXPORT_STALE_AFTER_MS, reconcileExports } from '../../../src/services/reporting/export-reconciler';
import { ExportStore, type PendingExport } from '../../../src/services/reporting/export-store';
import { FIXTURE_NOW, FIXTURE_WORKSPACE, withStoreAsync } from './report-fixture';

const EXPORT_ID = 'c'.repeat(32);
const STALE_MS = FIXTURE_NOW - EXPORT_STALE_AFTER_MS - 1;

let sandbox = '';
let outDir = '';

beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'export-reconciler-')));
  outDir = path.join(sandbox, 'out');
  fs.mkdirSync(outDir);
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function pending(stagingDir: string, createdMs = STALE_MS, exportId = EXPORT_ID): PendingExport {
  const names = partialNames('report.csv', exportId);
  return {
    exportId,
    workspaceId: FIXTURE_WORKSPACE,
    reportId: 'a'.repeat(32),
    format: 'csv',
    stagingDir,
    finalName: 'report.csv',
    dataPartialName: names.data,
    manifestPartialName: names.manifest,
    overwrite: false,
    createdMs
  };
}

function touch(dir: string, name: string): void {
  fs.writeFileSync(path.join(dir, name), 'x');
}

describe('export reconciliation', () => {
  it('removes only the owned partials and ends the row failed host-stopped', async () => {
    await withStoreAsync(async (conn) => {
      const store = new ExportStore(conn);
      const entry = pending(outDir);
      store.insertPending(entry);
      touch(outDir, entry.dataPartialName);
      touch(outDir, entry.manifestPartialName);
      const lookalike = partialNames('report.csv', 'd'.repeat(32)).data;
      touch(outDir, lookalike);
      touch(outDir, 'report.csv');
      const warnings: string[] = [];
      const result = await reconcileExports({
        store,
        fs: nodeExportFs,
        workspaceId: FIXTURE_WORKSPACE,
        nowMs: () => FIXTURE_NOW,
        logger: { warn: (code) => warnings.push(code) }
      });
      expect(result).toEqual({ reconciled: 1 });
      expect(fs.readdirSync(outDir).sort()).toEqual([lookalike, 'report.csv'].sort());
      expect(store.get(EXPORT_ID)).toMatchObject({ state: 'failed', reason: 'host-stopped', completedMs: FIXTURE_NOW });
      expect(warnings).toEqual([]);
    });
  });

  it('treats absent partials as clean', async () => {
    await withStoreAsync(async (conn) => {
      const store = new ExportStore(conn);
      store.insertPending(pending(outDir));
      const result = await reconcileExports({ store, fs: nodeExportFs, workspaceId: FIXTURE_WORKSPACE, nowMs: () => FIXTURE_NOW });
      expect(result).toEqual({ reconciled: 1 });
      expect(store.get(EXPORT_ID)).toMatchObject({ state: 'failed', reason: 'host-stopped' });
    });
  });

  it('leaves a recent pending export, which another window may still be writing', async () => {
    await withStoreAsync(async (conn) => {
      const store = new ExportStore(conn);
      const entry = pending(outDir, FIXTURE_NOW - 1_000);
      store.insertPending(entry);
      touch(outDir, entry.dataPartialName);
      const result = await reconcileExports({ store, fs: nodeExportFs, workspaceId: FIXTURE_WORKSPACE, nowMs: () => FIXTURE_NOW });
      expect(result).toEqual({ reconciled: 0 });
      expect(fs.readdirSync(outDir)).toEqual([entry.dataPartialName]);
      expect(store.get(EXPORT_ID)).toMatchObject({ state: 'pending' });
    });
  });

  it.each([
    ['a symlinked staging directory', true],
    ['a relative staging directory', false]
  ])('never touches %s, and still ends the row', async (_case, symlinked) => {
    await withStoreAsync(async (conn) => {
      const elsewhere = path.join(sandbox, 'elsewhere');
      fs.mkdirSync(elsewhere);
      const link = path.join(sandbox, 'link');
      fs.symlinkSync(elsewhere, link);
      const store = new ExportStore(conn);
      const entry = pending(symlinked ? link : path.relative(process.cwd(), elsewhere));
      store.insertPending(entry);
      touch(elsewhere, entry.dataPartialName);
      const warnings: { code: string; reason: string }[] = [];
      const result = await reconcileExports({
        store,
        fs: nodeExportFs,
        workspaceId: FIXTURE_WORKSPACE,
        nowMs: () => FIXTURE_NOW,
        logger: { warn: (code, context) => warnings.push({ code, reason: context.reason }) }
      });
      expect(result).toEqual({ reconciled: 1 });
      expect(fs.readdirSync(elsewhere)).toEqual([entry.dataPartialName]);
      expect(store.get(EXPORT_ID)).toMatchObject({ state: 'failed', reason: 'host-stopped' });
      expect(warnings).toEqual([{ code: 'reporting: reconcile failed', reason: 'partials-not-removed' }]);
    });
  });

  it.each([
    ['a data name that is not its own partial', { dataPartialName: 'notes.txt' }],
    ['a manifest name that is not its own partial', { manifestPartialName: 'notes.txt' }]
  ])('removes nothing for a row with %s, and still ends the row', async (_case, change) => {
    await withStoreAsync(async (conn) => {
      const store = new ExportStore(conn);
      const entry = { ...pending(outDir), ...change };
      store.insertPending(entry);
      touch(outDir, 'notes.txt');
      touch(outDir, entry.dataPartialName);
      touch(outDir, entry.manifestPartialName);
      const before = fs.readdirSync(outDir).sort();
      const warnings: string[] = [];
      const result = await reconcileExports({
        store,
        fs: nodeExportFs,
        workspaceId: FIXTURE_WORKSPACE,
        nowMs: () => FIXTURE_NOW,
        logger: { warn: (_code, context) => warnings.push(context.reason) }
      });
      expect(result).toEqual({ reconciled: 1 });
      expect(fs.readdirSync(outDir).sort()).toEqual(before);
      expect(store.get(EXPORT_ID)).toMatchObject({ state: 'failed', reason: 'host-stopped' });
      expect(warnings).toEqual(['partials-not-removed']);
    });
  });

  it('removes nothing below the staging directory for a final name with a directory part', async () => {
    await withStoreAsync(async (conn) => {
      const store = new ExportStore(conn);
      const names = partialNames('sub/report.csv', EXPORT_ID);
      store.insertPending({ ...pending(outDir), finalName: 'sub/report.csv', dataPartialName: names.data, manifestPartialName: names.manifest });
      const nested = path.join(outDir, '.sub');
      fs.mkdirSync(nested);
      touch(outDir, names.data);
      touch(outDir, names.manifest);
      const before = fs.readdirSync(nested).sort();
      const warnings: string[] = [];
      const result = await reconcileExports({
        store,
        fs: nodeExportFs,
        workspaceId: FIXTURE_WORKSPACE,
        nowMs: () => FIXTURE_NOW,
        logger: { warn: (_code, context) => warnings.push(context.reason) }
      });
      expect(result).toEqual({ reconciled: 1 });
      expect(before).toHaveLength(2);
      expect(fs.readdirSync(nested).sort()).toEqual(before);
      expect(store.get(EXPORT_ID)).toMatchObject({ state: 'failed', reason: 'host-stopped' });
      expect(warnings).toEqual(['partials-not-removed']);
    });
  });

  it('reconciles only its own workspace', async () => {
    await withStoreAsync(async (conn) => {
      const store = new ExportStore(conn);
      store.insertPending({ ...pending(outDir), workspaceId: 'ws-2' });
      const result = await reconcileExports({ store, fs: nodeExportFs, workspaceId: FIXTURE_WORKSPACE, nowMs: () => FIXTURE_NOW });
      expect(result).toEqual({ reconciled: 0 });
      expect(store.get(EXPORT_ID)).toMatchObject({ state: 'pending' });
    });
  });
});
