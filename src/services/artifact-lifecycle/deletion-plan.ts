/**
 * FR-R6-F05 — the deletion plan and its preview (FR-008, FR-009, FR-010).
 *
 * The plan is computed the same way for the preview and for the execution, so
 * the preview's basis revision matches only while nothing that decides the
 * plan has changed. Protected, pinned-run, never-eligible, live-writer and
 * unclassified artifacts are never targets; each is counted and, up to a
 * bound, named as an exception with its reason.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { createHash } from 'node:crypto';
import {
  DELETION_SELECTION_MAX_IDS,
  type ArtifactRecord,
  type DeletionSelection,
  type LifecycleResult,
  type RetentionClassId,
  type RetentionDecisionAction,
  type RetentionPreview,
  type RetentionPreviewClassLine,
  type RetentionPreviewSummary
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import { RETENTION_CLASS_IDS } from '../../contracts/shared-memory-storage/consumer-and-retention-inventories';
import { forEachManagedRecord, pinnedRunsOf, standingOf, type LifecycleContext } from './lifecycle-context';
import { includesValue, isOpaqueId, ok, refuse } from './lifecycle-results';
import { evaluateSweepCandidate } from './sweep-delegation';

/** The most protected exceptions a preview names; the rest are counted only. */
export const DELETION_PREVIEW_MAX_EXCEPTIONS = 100;

export type { DeletionSelection };

export interface DeletionPlanTarget {
  readonly artifactId: string;
  /** Host-private workspace-relative locator; persisted as the target key, never returned. */
  readonly relpath: string;
}

export interface DeletionPlan {
  readonly basis: string;
  readonly summary: RetentionPreviewSummary;
  readonly targets: readonly DeletionPlanTarget[];
}

type Decision =
  | { readonly kind: 'gone' }
  | { readonly kind: 'unclassified' }
  | { readonly kind: 'target'; readonly relpath: string }
  | { readonly kind: 'exception'; readonly reason: RetentionDecisionAction; readonly protected: boolean };

type ClassTally = { affectedCount: number; affectedBytes: number; protectedCount: number; protectedBytes: number };

function decide(ctx: LifecycleContext, record: ArtifactRecord, pinnedRuns: ReadonlySet<string>): Decision {
  const standing = standingOf(ctx, record, pinnedRuns);
  if (standing.gone) return { kind: 'gone' };
  if (standing.unclassified) return { kind: 'unclassified' };
  if (standing.protected) {
    const unresolved = standing.diagnostic?.code === 'ownership-unresolved';
    return { kind: 'exception', reason: unresolved ? 'preserve-ownership-unresolved' : 'preserve-protected', protected: true };
  }
  if (standing.neverEligible) return { kind: 'exception', reason: 'preserve-never-eligible', protected: false };
  const locator = ctx.records.locatorOf(record.artifactId);
  if (standing.liveWriter || locator === null || locator.storageTier !== 'workspace_file') {
    return { kind: 'exception', reason: 'preserve-ineligible', protected: false };
  }
  const references = ctx.references.list(record.artifactId);
  const verdict = evaluateSweepCandidate({
    record,
    references: references.ok ? references.value : [],
    eligibleByAgeOrSize: true
  });
  if (verdict.action !== 'collected') return { kind: 'exception', reason: 'preserve-protected', protected: true };
  return { kind: 'target', relpath: locator.uriOrRelpath };
}

function selectedRecords(ctx: LifecycleContext, selection: DeletionSelection): LifecycleResult<ArtifactRecord[]> {
  const { artifactIds, retentionClass } = selection;
  if (retentionClass !== undefined && !includesValue(RETENTION_CLASS_IDS, retentionClass)) {
    return refuse('invalid-input', 'retention class is not recognised');
  }
  if (artifactIds === undefined) {
    const all: ArtifactRecord[] = [];
    forEachManagedRecord(ctx, (record) => all.push(record), retentionClass);
    return ok(all);
  }
  if (!Array.isArray(artifactIds) || artifactIds.length > DELETION_SELECTION_MAX_IDS) {
    return refuse('invalid-input', `a selection names at most ${DELETION_SELECTION_MAX_IDS} artifacts`);
  }
  const records: ArtifactRecord[] = [];
  for (const artifactId of [...new Set(artifactIds)].sort()) {
    if (!isOpaqueId(artifactId)) return refuse('invalid-input', 'artifact id is malformed');
    const found = ctx.records.get(artifactId);
    if (!found.ok || !found.value.managed) return refuse('not-found', 'artifact is not under lifecycle management', artifactId);
    if (retentionClass === undefined || found.value.retentionClass === retentionClass) records.push(found.value);
  }
  return ok(records);
}

function basisOf(selection: DeletionSelection, considered: readonly (readonly [string, number, string])[]): string {
  const normalized = {
    artifactIds: selection.artifactIds === undefined ? null : [...new Set(selection.artifactIds)].sort(),
    retentionClass: selection.retentionClass ?? null
  };
  return createHash('sha256').update(JSON.stringify({ selection: normalized, considered })).digest('hex');
}

class PlanBuilder {
  public readonly targets: DeletionPlanTarget[] = [];
  public readonly exceptions: { artifactId: string; reason: RetentionDecisionAction }[] = [];
  public readonly considered: (readonly [string, number, string])[] = [];
  public readonly perClass = new Map<RetentionClassId, ClassTally>();
  public exceptionCount = 0;
  public unclassifiedCount = 0;
  public unclassifiedBytes = 0;

  public add(record: ArtifactRecord, decision: Decision): void {
    const label = decision.kind === 'exception' ? decision.reason : decision.kind;
    this.considered.push([record.artifactId, record.lifecycleRevision, label]);
    if (decision.kind === 'gone') return;
    if (decision.kind === 'unclassified') {
      this.unclassifiedCount += 1;
      this.unclassifiedBytes += record.byteSize;
      return;
    }
    const tally = this.perClass.get(record.retentionClass) ?? {
      affectedCount: 0,
      affectedBytes: 0,
      protectedCount: 0,
      protectedBytes: 0
    };
    this.perClass.set(record.retentionClass, tally);
    if (decision.kind === 'target') {
      tally.affectedCount += 1;
      tally.affectedBytes += record.byteSize;
      this.targets.push({ artifactId: record.artifactId, relpath: decision.relpath });
      return;
    }
    if (decision.protected) {
      tally.protectedCount += 1;
      tally.protectedBytes += record.byteSize;
    }
    this.exceptionCount += 1;
    if (this.exceptions.length < DELETION_PREVIEW_MAX_EXCEPTIONS) {
      this.exceptions.push({ artifactId: record.artifactId, reason: decision.reason });
    }
  }

  public summary(): RetentionPreviewSummary {
    const perClass: RetentionPreviewClassLine[] = [...this.perClass.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([retentionClass, tally]) => ({ retentionClass, ...tally }));
    const sum = (pick: (line: RetentionPreviewClassLine) => number): number =>
      perClass.reduce((total, line) => total + pick(line), 0);
    const truncated = this.exceptionCount - this.exceptions.length;
    return {
      affectedCount: sum((line) => line.affectedCount),
      affectedBytes: sum((line) => line.affectedBytes),
      protectedCount: sum((line) => line.protectedCount),
      protectedBytes: sum((line) => line.protectedBytes),
      unclassifiedCount: this.unclassifiedCount,
      unclassifiedBytes: this.unclassifiedBytes,
      perClass,
      protectedExceptions: this.exceptions,
      coverage: 'complete',
      notes: truncated > 0 ? [`${truncated} further preserved artifacts are counted but not listed`] : []
    };
  }
}

/** The plan for `selection`; the preview and the execution both call it. */
export function planDeletion(ctx: LifecycleContext, selection: DeletionSelection): LifecycleResult<DeletionPlan> {
  const records = selectedRecords(ctx, selection);
  if (!records.ok) return records;
  const pinnedRuns = pinnedRunsOf(ctx);
  const builder = new PlanBuilder();
  for (const record of records.value) builder.add(record, decide(ctx, record, pinnedRuns));
  return ok({ basis: basisOf(selection, builder.considered), summary: builder.summary(), targets: builder.targets });
}

export function previewDeletion(ctx: LifecycleContext, selection: DeletionSelection): LifecycleResult<RetentionPreview> {
  const plan = planDeletion(ctx, selection);
  if (!plan.ok) return plan;
  return ok(ctx.previews.create('deletion', plan.value.basis, plan.value.summary));
}
