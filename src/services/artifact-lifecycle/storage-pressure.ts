/**
 * FR-R6-F05 — the storage pressure report (FR-009, FR-020, AC-08).
 *
 * Registered bytes come from the lifecycle records; bytes no record names come
 * from the last complete scan checkpoint (or the latest partial one before any
 * scan completed). Over the target, F05 offers only eligible content for
 * reclamation and never evicts a recovery dependency; when nothing is
 * reclaimable, admission is left to the shared F02 pin-quota check and F03
 * backpressure.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type {
  LifecycleResult,
  RetentionClassId,
  ScanCoverage,
  StorageAdmission,
  StoragePressureClassLine,
  StoragePressureReport,
  StorageScanFigures
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import {
  adoptedPolicyRevision,
  forEachManagedRecord,
  pinnedRunsOf,
  standingOf,
  workspaceIdOf,
  type LifecycleContext
} from './lifecycle-context';
import { ok } from './lifecycle-results';
import type { StorageScanTotals } from './storage-scan';

/** What decides admission once F05 has nothing it may reclaim. */
export const SHARED_ADMISSION_AUTHORITY =
  'F02 checkPinQuotaAdmission and F03 backpressure decide admission; F05 never evicts a recovery dependency';

interface CheckpointRow {
  readonly completed_at_ms: number | null;
  readonly started_at_ms: number;
  readonly coverage: ScanCoverage;
  readonly totals_json: string;
}

type ClassTally = { totalBytes: number; reclaimableBytes: number; protectedBytes: number };

interface Tallies {
  readonly perClass: Map<RetentionClassId, ClassTally>;
  unclassifiedBytes: number;
}

function addLine(tallies: Tallies, line: StoragePressureClassLine): void {
  const tally = tallies.perClass.get(line.retentionClass) ?? { totalBytes: 0, reclaimableBytes: 0, protectedBytes: 0 };
  tally.totalBytes += line.totalBytes;
  tally.reclaimableBytes += line.reclaimableBytes;
  tally.protectedBytes += line.protectedBytes;
  tallies.perClass.set(line.retentionClass, tally);
}

function registeredTallies(ctx: LifecycleContext): Tallies {
  const tallies: Tallies = { perClass: new Map(), unclassifiedBytes: 0 };
  const pinnedRuns = pinnedRunsOf(ctx);
  forEachManagedRecord(ctx, (record) => {
    const standing = standingOf(ctx, record, pinnedRuns);
    if (standing.gone) return;
    if (standing.unclassified) {
      tallies.unclassifiedBytes += record.byteSize;
      return;
    }
    addLine(tallies, {
      retentionClass: record.retentionClass,
      totalBytes: record.byteSize,
      reclaimableBytes: standing.eligible ? record.byteSize : 0,
      protectedBytes: standing.protected ? record.byteSize : 0
    });
  });
  return tallies;
}

function parseTotals(row: CheckpointRow | undefined): StorageScanTotals | null {
  if (row === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(row.totals_json);
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as StorageScanTotals).perClass)) return null;
    return parsed as StorageScanTotals;
  } catch {
    return null;
  }
}

function latestCheckpoint(ctx: LifecycleContext, coverage?: ScanCoverage): CheckpointRow | undefined {
  return ctx.deps.conn.get<CheckpointRow>(
    `SELECT started_at_ms, completed_at_ms, coverage, totals_json FROM storage_scan_checkpoints
     WHERE workspace_id = ? AND (? IS NULL OR coverage = ?)
     ORDER BY started_at_ms DESC, rowid DESC LIMIT 1`,
    workspaceIdOf(ctx),
    coverage ?? null,
    coverage ?? null
  );
}

function admissionFor(overTarget: boolean, reclaimableBytes: number): StorageAdmission {
  const behavior = !overTarget ? 'admit' : reclaimableBytes > 0 ? 'reclaim-eligible-only' : 'shared-admission';
  return {
    behavior,
    evictsRecoveryDependencies: false,
    settlementReservePreserved: true,
    sharedAdmission: SHARED_ADMISSION_AUTHORITY
  };
}

function figuresOf(totals: StorageScanTotals | null): StorageScanFigures | null {
  if (totals === null) return null;
  return {
    entriesVisited: totals.entriesVisited,
    rootsCompleted: totals.rootsCompleted,
    rootsDeclared: totals.rootsDeclared
  };
}

export function buildPressureReport(ctx: LifecycleContext): LifecycleResult<StoragePressureReport> {
  const tallies = registeredTallies(ctx);
  const latest = latestCheckpoint(ctx);
  const lastComplete = latestCheckpoint(ctx, 'complete');
  const scanTotals = parseTotals(lastComplete ?? latest);
  if (scanTotals !== null) {
    scanTotals.perClass.forEach((line) => addLine(tallies, line));
    tallies.unclassifiedBytes += scanTotals.unclassifiedBytes;
  }
  const perClass = [...tallies.perClass.entries()]
    .filter(([, tally]) => tally.totalBytes > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([retentionClass, tally]) => ({ retentionClass, ...tally }));
  const classBytes = perClass.reduce((sum, line) => sum + line.totalBytes, 0);
  const reclaimableBytes = perClass.reduce((sum, line) => sum + line.reclaimableBytes, 0);
  const totalBytes = classBytes + tallies.unclassifiedBytes;
  const targetBytes = ctx.deps.storageTargetBytes ?? null;
  const overTarget = targetBytes !== null && totalBytes > targetBytes;
  const lastCompleteAt = lastComplete === undefined ? null : (lastComplete.completed_at_ms ?? lastComplete.started_at_ms);
  const latestPartialAt =
    latest !== undefined && latest.coverage === 'partial' ? (latest.completed_at_ms ?? latest.started_at_ms) : null;
  return ok({
    perClass,
    totalBytes,
    unclassifiedBytes: tallies.unclassifiedBytes,
    policyRevision: adoptedPolicyRevision(ctx.deps.conn),
    lastCompleteScanAtMs: lastCompleteAt,
    latestPartialScanAtMs: latestPartialAt,
    coverage: inventoryCoverage(ctx, latest),
    targetBytes,
    overTarget,
    admission: admissionFor(overTarget, reclaimableBytes),
    scanFigures: figuresOf(parseTotals(latest))
  });
}

/** `complete` when no root is declared; otherwise the latest scan's coverage, `partial` before any scan. */
export function inventoryCoverage(ctx: LifecycleContext, latest = latestCheckpoint(ctx)): ScanCoverage {
  if (ctx.deps.scanRoots.length === 0) return 'complete';
  return latest?.coverage ?? 'partial';
}
