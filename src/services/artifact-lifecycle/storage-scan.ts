/**
 * FR-R6-F05 — the bounded scan of declared storage roots (FR-012, NFR-001).
 *
 * It finds bytes a root holds that no record names. The walk uses `lstat` and
 * `readdir` only: a link is counted as unclassified and never followed or
 * resolved. A pass visits at most `SCAN_MAX_ENTRIES_PER_PASS` entries and goes
 * no deeper than `SCAN_MAX_DEPTH`; hitting either bound, an unreadable root or
 * a cancellation makes the scan `partial`, never silently empty.
 *
 * The result is persisted as a checkpoint row (totals only, no paths). The
 * entries themselves stay in memory for the inventory to page.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import * as path from 'node:path';
import {
  NEVER_ELIGIBLE_STORE_KINDS,
  SCAN_MAX_DEPTH,
  SCAN_MAX_ENTRIES_PER_PASS,
  type LifecycleResult,
  type RetentionClassId,
  type ScanCoverage,
  type StoragePressureClassLine,
  type StorageInventoryEntry,
  type StorageScanResult
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import { adoptedPolicyRevision, pinnedRunsOf, workspaceIdOf, type LifecycleContext } from './lifecycle-context';
import type { LifecycleFsEntry, StorageScanRoot } from './lifecycle-ports';
import { ok } from './lifecycle-results';

/** The entries of the latest scan this service instance took; the inventory pages them. */
export interface StorageScanSnapshot {
  readonly scanId: string;
  readonly entries: readonly StorageInventoryEntry[];
}

/** Totals persisted with each checkpoint; the pressure report reads them back. */
export interface StorageScanTotals {
  readonly perClass: readonly StoragePressureClassLine[];
  readonly unclassifiedBytes: number;
  readonly entriesVisited: number;
  readonly rootsCompleted: number;
  readonly rootsDeclared: number;
}

interface Frame {
  readonly dir: string;
  readonly depth: number;
  readonly segments: readonly string[];
}

type ClassTally = { totalBytes: number; reclaimableBytes: number; protectedBytes: number };

class ScanWalk {
  public readonly entries: StorageInventoryEntry[] = [];
  public visited = 0;
  public rootsCompleted = 0;
  public partial = false;
  public stopped = false;
  public unclassifiedBytes = 0;
  public readonly perClass = new Map<RetentionClassId, ClassTally>();

  public constructor(
    private readonly ctx: LifecycleContext,
    private readonly registered: ReadonlySet<string>,
    private readonly pinnedRuns: ReadonlySet<string>,
    private readonly signal: AbortSignal | undefined
  ) {}

  public async walkRoot(root: StorageScanRoot): Promise<void> {
    const top = await this.ctx.deps.fs.lstat(root.root);
    if (this.cancelled()) return;
    if (top === null) {
      this.rootsCompleted += 1;
      return;
    }
    if (top.kind !== 'directory') {
      this.partial = true;
      return;
    }
    const complete = await this.walkTree(root);
    if (complete && !this.stopped) this.rootsCompleted += 1;
  }

  /** True when the walk must end now; marks the scan partial. */
  public cancelled(): boolean {
    if (this.signal?.aborted !== true) return false;
    this.partial = true;
    this.stopped = true;
    return true;
  }

  private async walkTree(root: StorageScanRoot): Promise<boolean> {
    const stack: Frame[] = [{ dir: root.root, depth: 0, segments: [] }];
    let complete = true;
    for (let frame = stack.pop(); frame !== undefined && !this.stopped; frame = stack.pop()) {
      let names: readonly string[];
      try {
        names = await this.ctx.deps.fs.readdir(frame.dir);
      } catch {
        this.partial = true;
        complete = false;
        continue;
      }
      if (this.cancelled()) return false;
      const deeper = await this.visitChildren(root, frame, names, stack);
      if (!deeper) complete = false;
    }
    return complete;
  }

  /** Visits one directory's children; false when a bound left part of the tree unread. */
  private async visitChildren(
    root: StorageScanRoot,
    frame: Frame,
    names: readonly string[],
    stack: Frame[]
  ): Promise<boolean> {
    let complete = true;
    for (const name of names) {
      if (this.visited >= SCAN_MAX_ENTRIES_PER_PASS) {
        this.partial = true;
        this.stopped = true;
        return false;
      }
      const absolute = path.join(frame.dir, name);
      const entry = await this.ctx.deps.fs.lstat(absolute);
      if (this.cancelled()) return false;
      this.visited += 1;
      if (entry === null) continue;
      const segments = [...frame.segments, name];
      if (entry.kind !== 'directory') {
        this.record(root, absolute, segments, entry);
        continue;
      }
      if (frame.depth + 1 > SCAN_MAX_DEPTH) {
        this.partial = true;
        complete = false;
        continue;
      }
      stack.push({ dir: absolute, depth: frame.depth + 1, segments });
    }
    return complete;
  }

  private record(root: StorageScanRoot, absolute: string, segments: readonly string[], entry: LifecycleFsEntry): void {
    if (entry.kind === 'file' && this.registered.has(absolute)) return;
    const ownerRunId = root.ownerRunId === undefined ? null : root.ownerRunId(segments);
    if (entry.kind !== 'file' || ownerRunId === undefined) {
      this.addUnclassified(root, entry.sizeBytes);
      return;
    }
    const isProtected = ownerRunId !== null && this.pinnedRuns.has(ownerRunId);
    const eligible = !isProtected && !NEVER_ELIGIBLE_STORE_KINDS.includes(root.storeKind);
    this.entries.push({
      artifactId: null,
      source: 'scan',
      rootId: root.rootId,
      retentionClass: root.retentionClass,
      storeKind: root.storeKind,
      byteSize: entry.sizeBytes,
      availability: 'present',
      protected: isProtected,
      eligible
    });
    const tally = this.perClass.get(root.retentionClass) ?? { totalBytes: 0, reclaimableBytes: 0, protectedBytes: 0 };
    tally.totalBytes += entry.sizeBytes;
    if (isProtected) tally.protectedBytes += entry.sizeBytes;
    if (eligible) tally.reclaimableBytes += entry.sizeBytes;
    this.perClass.set(root.retentionClass, tally);
  }

  private addUnclassified(root: StorageScanRoot, sizeBytes: number): void {
    this.unclassifiedBytes += sizeBytes;
    this.entries.push({
      artifactId: null,
      source: 'scan',
      rootId: root.rootId,
      retentionClass: null,
      storeKind: 'unclassified',
      byteSize: sizeBytes,
      availability: 'present',
      protected: false,
      eligible: false
    });
  }
}

function registeredPaths(ctx: LifecycleContext): ReadonlySet<string> {
  const workspaceRoot = ctx.deps.workspaceRoot;
  if (workspaceRoot === undefined) return new Set();
  return new Set(ctx.records.workspaceFileLocators().map((relpath) => path.resolve(workspaceRoot, relpath)));
}

function totalsOf(walk: ScanWalk, rootsDeclared: number): StorageScanTotals {
  const perClass = [...walk.perClass.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([retentionClass, tally]) => ({ retentionClass, ...tally }));
  return {
    perClass,
    unclassifiedBytes: walk.unclassifiedBytes,
    entriesVisited: walk.visited,
    rootsCompleted: walk.rootsCompleted,
    rootsDeclared
  };
}

/** Walks every declared root once, persists a checkpoint, and returns the result with its entries. */
export async function scanDeclaredRoots(
  ctx: LifecycleContext,
  signal?: AbortSignal
): Promise<{ readonly result: LifecycleResult<StorageScanResult>; readonly snapshot: StorageScanSnapshot }> {
  const startedAtMs = ctx.deps.nowMs();
  const walk = new ScanWalk(ctx, registeredPaths(ctx), pinnedRunsOf(ctx), signal);
  for (const root of ctx.deps.scanRoots) {
    if (walk.stopped || walk.cancelled()) break;
    await walk.walkRoot(root);
  }
  const rootsDeclared = ctx.deps.scanRoots.length;
  const coverage: ScanCoverage = walk.partial || walk.rootsCompleted < rootsDeclared ? 'partial' : 'complete';
  const totals = totalsOf(walk, rootsDeclared);
  const scanId = ctx.newId();
  const completedAtMs = ctx.deps.nowMs();
  ctx.deps.conn.run(
    `INSERT INTO storage_scan_checkpoints
       (scan_id, workspace_id, policy_revision, started_at_ms, completed_at_ms, coverage, cursor_json, totals_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    scanId,
    workspaceIdOf(ctx),
    adoptedPolicyRevision(ctx.deps.conn),
    startedAtMs,
    completedAtMs,
    coverage,
    JSON.stringify({ rootsCompleted: walk.rootsCompleted }),
    JSON.stringify(totals)
  );
  return {
    result: ok({
      scanId,
      coverage,
      startedAtMs,
      completedAtMs,
      entriesVisited: walk.visited,
      rootsCompleted: walk.rootsCompleted,
      rootsDeclared
    }),
    snapshot: { scanId, entries: walk.entries }
  };
}
