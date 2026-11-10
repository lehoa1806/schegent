// FR-R6-F11 T036 (FR-015, NFR-003) — export records: one pending per workspace, terminal states final.
import { describe, expect, it } from 'vitest';
import { ExportStore, type PendingExport } from '../../../src/services/reporting/export-store';
import { FIXTURE_NOW, FIXTURE_WORKSPACE, withStore } from './report-fixture';

function pending(exportId: string, workspaceId = FIXTURE_WORKSPACE): PendingExport {
  return {
    exportId,
    workspaceId,
    reportId: 'a'.repeat(32),
    format: 'csv',
    stagingDir: '/exports',
    finalName: 'report.csv',
    dataPartialName: `.report.csv.${exportId}.data.partial`,
    manifestPartialName: `.report.csv.${exportId}.manifest.partial`,
    overwrite: false,
    createdMs: FIXTURE_NOW
  };
}

const FIRST = '1'.repeat(32);
const SECOND = '2'.repeat(32);

describe('export store', () => {
  it('records a pending export and refuses a second one in the same workspace', () => {
    withStore((conn) => {
      const store = new ExportStore(conn);
      expect(store.insertPending(pending(FIRST))).toEqual({ ok: true });
      expect(store.insertPending(pending(SECOND))).toEqual({ ok: false, reason: 'export-busy' });
      expect(store.insertPending(pending(SECOND, 'ws-2'))).toEqual({ ok: true });
      expect(store.pendingRows(FIXTURE_WORKSPACE).map((row) => row.exportId)).toEqual([FIRST]);
    });
  });

  it('admits a new export once the earlier one is complete', () => {
    withStore((conn) => {
      const store = new ExportStore(conn);
      store.insertPending(pending(FIRST));
      expect(store.complete(FIRST, { rowCount: 2, byteLength: 10, sha256: 'f'.repeat(64), completedMs: FIXTURE_NOW + 1 })).toBe(true);
      expect(store.insertPending(pending(SECOND))).toEqual({ ok: true });
      expect(store.get(FIRST)).toMatchObject({ state: 'completed', rowCount: 2, byteLength: 10, sha256: 'f'.repeat(64), reason: null });
    });
  });

  it.each(['cancelled', 'limited', 'failed'] as const)('ends a pending export %s with its reason', (state) => {
    withStore((conn) => {
      const store = new ExportStore(conn);
      store.insertPending(pending(FIRST));
      expect(store.finish(FIRST, state, 'write-failed', FIXTURE_NOW + 2)).toBe(true);
      expect(store.get(FIRST)).toMatchObject({ state, reason: 'write-failed', completedMs: FIXTURE_NOW + 2 });
      expect(store.pendingRows(FIXTURE_WORKSPACE)).toEqual([]);
    });
  });

  it('never leaves a terminal state', () => {
    withStore((conn) => {
      const store = new ExportStore(conn);
      store.insertPending(pending(FIRST));
      store.finish(FIRST, 'cancelled', null, FIXTURE_NOW + 1);
      expect(store.finish(FIRST, 'failed', 'host-stopped', FIXTURE_NOW + 2)).toBe(false);
      expect(store.complete(FIRST, { rowCount: 0, byteLength: 0, sha256: 'f'.repeat(64), completedMs: FIXTURE_NOW + 3 })).toBe(false);
      expect(store.get(FIRST)?.state).toBe('cancelled');
    });
  });

  it('reads back the staging names for reconciliation', () => {
    withStore((conn) => {
      const store = new ExportStore(conn);
      store.insertPending(pending(FIRST));
      expect(store.pendingRows(FIXTURE_WORKSPACE).at(0)).toEqual({ ...pending(FIRST), state: 'pending' });
      expect(store.get('9'.repeat(32))).toBeNull();
    });
  });
});
