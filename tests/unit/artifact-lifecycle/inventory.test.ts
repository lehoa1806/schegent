// FR-R6-F05 (T023; AC-04, FR-009, FR-012, NFR-001) — the storage inventory.
//
// Registered artifacts page by keyset on `(retention_class, artifact_id)`;
// files a declared root holds but no record names come from a bounded,
// `lstat`-only scan. Unclassified bytes are counted and never eligible, links
// are never followed, and an interrupted or bounded scan says it is partial.

import { describe, expect, it } from 'vitest';
import {
  INVENTORY_PAGE_MAX_BYTES,
  INVENTORY_PAGE_MAX_ENTRIES,
  SCAN_MAX_DEPTH,
  SCAN_MAX_ENTRIES_PER_PASS,
  type StorageInventoryEntry,
  type StorageInventoryPage
} from '../../../src/contracts/artifact-lifecycle/lifecycle-types';
import { boundInventoryPage } from '../../../src/services/artifact-lifecycle/inventory';
import type { ArtifactLifecycleService } from '../../../src/services/artifact-lifecycle';
import {
  CHECKPOINT_CLASS,
  CHECKPOINT_ROOT,
  CHECKPOINT_SCAN_ROOT,
  checkpointArtifact,
  lifecycleFixture,
  NOW,
  seedCheckpoint,
  SESSION_ROOT
} from './lifecycle-fixture';

function page(service: ArtifactLifecycleService, request: Parameters<ArtifactLifecycleService['listInventory']>[0]): StorageInventoryPage {
  const result = service.listInventory(request);
  if (!result.ok) throw new Error(`listInventory refused: ${result.refusal.code}`);
  return result.value;
}

function ids(entries: readonly StorageInventoryEntry[]): (string | null)[] {
  return entries.map((entry) => entry.artifactId);
}

function register(service: ArtifactLifecycleService, artifactId: string, overrides = {}): void {
  const result = service.registerArtifact(checkpointArtifact(artifactId, overrides));
  if (!result.ok) throw new Error(`register failed: ${result.refusal.code}`);
}

describe('FR-R6-F05 storage inventory paging (NFR-001)', () => {
  it('pages at most 200 entries and keeps each page under 1 MiB serialized', () => {
    const fx = lifecycleFixture();
    const service = fx.build({ scanRoots: [] });
    for (let n = 0; n < 205; n += 1) register(service, `art-${String(n).padStart(3, '0')}`);
    const first = page(service, {});
    expect(first.entries).toHaveLength(INVENTORY_PAGE_MAX_ENTRIES);
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(INVENTORY_PAGE_MAX_BYTES);
    expect(first.nextCursor).not.toBeNull();
    const second = page(service, { cursor: first.nextCursor ?? undefined });
    expect(second.entries).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...ids(first.entries), ...ids(second.entries)]).size).toBe(205);
  });

  it('refuses a page size above 200 and a cursor it did not issue', () => {
    const service = lifecycleFixture().build({ scanRoots: [] });
    const tooBig = service.listInventory({ pageSize: INVENTORY_PAGE_MAX_ENTRIES + 1 });
    expect(tooBig.ok ? null : tooBig.refusal.code).toBe('invalid-input');
    const forged = service.listInventory({ cursor: 'not-a-cursor' });
    expect(forged.ok ? null : forged.refusal.code).toBe('invalid-input');
  });

  it('stops a page before the byte budget, whatever the entry count', () => {
    const entry: StorageInventoryEntry = {
      artifactId: 'x'.repeat(100),
      source: 'registered',
      rootId: null,
      retentionClass: CHECKPOINT_CLASS,
      storeKind: 'checkpoint',
      byteSize: 1,
      availability: 'present',
      protected: false,
      eligible: true
    };
    const budget = Buffer.byteLength(JSON.stringify(entry), 'utf8') * 3 + 10;
    const bounded = boundInventoryPage(Array.from({ length: 10 }, () => entry), INVENTORY_PAGE_MAX_ENTRIES, budget);
    expect(bounded.length).toBeGreaterThan(0);
    expect(bounded.length).toBeLessThan(10);
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(budget);
  });

  it('keeps a keyset cursor stable across inserts on either side of it', () => {
    const fx = lifecycleFixture();
    const service = fx.build({ scanRoots: [] });
    for (const id of ['a-01', 'a-03', 'a-05', 'a-07']) register(service, id);
    const first = page(service, { pageSize: 2 });
    expect(ids(first.entries)).toEqual(['a-01', 'a-03']);
    register(service, 'a-02');
    register(service, 'a-06');
    const second = page(service, { pageSize: 2, cursor: first.nextCursor ?? undefined });
    expect(ids(second.entries)).toEqual(['a-05', 'a-06']);
    const third = page(service, { pageSize: 2, cursor: second.nextCursor ?? undefined });
    expect(ids(third.entries)).toEqual(['a-07']);
    expect(third.nextCursor).toBeNull();
  });
});

describe('FR-R6-F05 storage inventory classification (FR-009, FR-012)', () => {
  it('splits each class into reclaimable and protected bytes and counts unclassified apart', () => {
    const fx = lifecycleFixture();
    const service = fx.build({ scanRoots: [], pinnedRunIds: new Set(['run-2']) });
    register(service, 'art-free', { byteSize: 40 });
    register(service, 'art-held', { byteSize: 50 });
    register(service, 'art-pinned-run', { byteSize: 60, ownerRunId: 'run-2' });
    register(service, 'art-audit', { byteSize: 70, storeKind: 'audit' });
    register(service, 'art-unclassified', { byteSize: 80, storeKind: 'unclassified' });
    service.addReference({ artifactId: 'art-held', ownerType: 'run', ownerId: 'run-1', purpose: 'paused-recovery', protective: true });

    const entries = new Map(page(service, {}).entries.map((entry) => [entry.artifactId, entry]));
    expect(entries.get('art-free')).toMatchObject({ protected: false, eligible: true });
    expect(entries.get('art-held')).toMatchObject({ protected: true, eligible: false });
    expect(entries.get('art-pinned-run')).toMatchObject({ protected: true, eligible: false });
    expect(entries.get('art-audit')).toMatchObject({ protected: false, eligible: false });
    expect(entries.get('art-unclassified')).toMatchObject({ retentionClass: null, eligible: false });

    const report = service.getPressureReport();
    if (!report.ok) throw new Error('pressure refused');
    expect(report.value.perClass).toEqual([
      { retentionClass: CHECKPOINT_CLASS, totalBytes: 220, reclaimableBytes: 40, protectedBytes: 110 }
    ]);
    expect(report.value.unclassifiedBytes).toBe(80);
    expect(report.value.totalBytes).toBe(300);
    expect(report.value.coverage).toBe('complete');
  });
});

describe('FR-R6-F05 declared-root scan (FR-012, NFR-001)', () => {
  it('counts unmatched files and links as unclassified, never follows a link, and skips registered bytes', async () => {
    const fx = lifecycleFixture();
    const service = fx.build({ pinnedRunIds: new Set(['run-8']) });
    seedCheckpoint(service, fx.fs, 'art-registered');
    fx.fs
      .file(`${CHECKPOINT_ROOT}/run-9/x.patch`, 100)
      .file(`${CHECKPOINT_ROOT}/run-8/y.patch`, 200)
      .file(`${CHECKPOINT_ROOT}/stray.bin`, 7)
      .file(`${CHECKPOINT_ROOT}/run-9/deep/z.patch`, 5)
      .symlink(`${CHECKPOINT_ROOT}/run-9/escape`, '/etc');

    const scan = await service.scanDeclaredRoots();
    if (!scan.ok) throw new Error('scan refused');
    expect(scan.value.coverage).toBe('complete');

    const scanned = page(service, {}).entries.filter((entry) => entry.source === 'scan');
    expect(scanned.every((entry) => entry.rootId === 'checkpoints' && entry.artifactId === null)).toBe(true);
    const bySize = new Map(scanned.map((entry) => [entry.byteSize, entry]));
    expect(scanned).toHaveLength(5);
    expect(bySize.get(100)).toMatchObject({ retentionClass: CHECKPOINT_CLASS, protected: false, eligible: true });
    expect(bySize.get(200)).toMatchObject({ retentionClass: CHECKPOINT_CLASS, protected: true, eligible: false });
    for (const size of [7, 5, 12]) {
      expect(bySize.get(size)).toMatchObject({ retentionClass: null, storeKind: 'unclassified', eligible: false });
    }
    expect(fx.fs.calls.some(([op, target]) => target === '/etc' || (op === 'readdir' && target.endsWith('/escape')))).toBe(false);
    expect(fx.fs.calls.some(([op]) => op === 'realpath' || op === 'unlink')).toBe(false);

    const report = service.getPressureReport();
    if (!report.ok) throw new Error('pressure refused');
    expect(report.value.unclassifiedBytes).toBe(7 + 5 + 12);
    expect(report.value.perClass).toEqual([
      { retentionClass: CHECKPOINT_CLASS, totalBytes: 40 + 100 + 200, reclaimableBytes: 40 + 100, protectedBytes: 200 }
    ]);
  });

  it('reports a scan cancelled mid-walk as partial and keeps the last complete scan time apart', async () => {
    const fx = lifecycleFixture();
    fx.fs.file(`${CHECKPOINT_ROOT}/run-9/x.patch`, 100).file(`${SESSION_ROOT}/s-1/log.txt`, 3);
    const roots = [
      CHECKPOINT_SCAN_ROOT,
      { rootId: 'sessions', root: SESSION_ROOT, retentionClass: CHECKPOINT_CLASS, storeKind: 'transcript' as const }
    ];
    const complete = await fx.build({ scanRoots: roots }).scanDeclaredRoots();
    expect(complete.ok && complete.value.coverage).toBe('complete');

    const later = fx.build({ scanRoots: roots, nowMs: NOW + 1_000 });
    const controller = new AbortController();
    fx.fs.beforeReaddir = (dir) => {
      if (dir === SESSION_ROOT) controller.abort();
    };
    const partial = await later.scanDeclaredRoots(controller.signal);
    if (!partial.ok) throw new Error('scan refused');
    expect(partial.value).toMatchObject({ coverage: 'partial', rootsCompleted: 1, rootsDeclared: 2 });

    const report = later.getPressureReport();
    if (!report.ok) throw new Error('pressure refused');
    expect(report.value.coverage).toBe('partial');
    expect(report.value.lastCompleteScanAtMs).toBe(NOW);
    expect(report.value.latestPartialScanAtMs).toBe(NOW + 1_000);
    expect(report.value.scanFigures).toMatchObject({ rootsCompleted: 1, rootsDeclared: 2 });
    expect(page(later, {}).coverage).toBe('partial');
  });

  it('stops at SCAN_MAX_ENTRIES_PER_PASS entries and reports partial coverage', async () => {
    const fx = lifecycleFixture();
    for (let n = 0; n <= SCAN_MAX_ENTRIES_PER_PASS; n += 1) fx.fs.file(`${CHECKPOINT_ROOT}/run-1/f-${n}.patch`, 1);
    const scan = await fx.build().scanDeclaredRoots();
    if (!scan.ok) throw new Error('scan refused');
    expect(scan.value.coverage).toBe('partial');
    expect(scan.value.entriesVisited).toBe(SCAN_MAX_ENTRIES_PER_PASS);
  });

  it('does not descend below SCAN_MAX_DEPTH and reports partial coverage', async () => {
    const fx = lifecycleFixture();
    const segments = Array.from({ length: SCAN_MAX_DEPTH + 2 }, (_, n) => `d${n}`);
    fx.fs.file(`${CHECKPOINT_ROOT}/${segments.join('/')}/leaf.bin`, 1);
    const scan = await fx.build().scanDeclaredRoots();
    if (!scan.ok) throw new Error('scan refused');
    expect(scan.value.coverage).toBe('partial');
    expect(fx.fs.calls.some(([op, target]) => op === 'readdir' && target.endsWith(`/d${SCAN_MAX_DEPTH}`))).toBe(false);
  });

  it('reports a root it cannot read as partial, not empty', async () => {
    const fx = lifecycleFixture();
    fx.fs.dir(CHECKPOINT_ROOT);
    fx.fs.readdirErrors.add(CHECKPOINT_ROOT);
    const scan = await fx.build().scanDeclaredRoots();
    expect(scan.ok && scan.value.coverage).toBe('partial');
  });
});
