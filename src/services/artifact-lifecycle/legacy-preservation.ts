/**
 * FR-R6-F05 US3 (T034, T036; FR-013..FR-015, F05-AC-06) — legacy catalog
 * preservation: classify residue, preview and run an opt-in quarantine,
 * reconcile an interrupted one, preview a re-import, and purge quarantined
 * copies.
 *
 * The default outcome for every residue is `preserved-in-place`. Nothing is
 * disposable, no manifest is written and no pointer is synthesized; the only
 * filesystem changes are the confirmed quarantine (copy, verify, contained
 * remove) and the confirmed purge (contained remove), each audited once.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type {
  LifecycleResult,
  RetentionPreview,
  SourcePreservationOperation
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import type {
  LegacyCatalogAdmissionPort,
  LegacyCatalogClassification,
  LegacyPurgeRequest,
  LegacyPurgeResult,
  LegacyQuarantineRequest,
  LegacyReimportPreview
} from '../../contracts/artifact-lifecycle/legacy-preservation-types';
import {
  legacyContext,
  preservationSummary,
  type LegacyContext,
  type LegacyPreservationDependencies
} from './legacy-preservation-context';
import { previewQuarantinePurge, purgeQuarantinedResidue } from './legacy-purge';
import { classify, quarantineLegacyResidue, reconcilePreservation } from './legacy-quarantine';
import { previewReimport } from './legacy-reimport';
import { ok, refuse } from './lifecycle-results';

export type { LegacyPreservationDependencies } from './legacy-preservation-context';

function quarantinePreviewSummary(classification: LegacyCatalogClassification) {
  const unresolved = classification.residue.filter((entry) => entry.disposition === 'unresolved');
  const protectedResidue = classification.residue.filter((entry) => entry.disposition === 'protected');
  const bytesOf = (entries: typeof unresolved): number =>
    entries.reduce((total, entry) => total + (entry.sizeBytes ?? 0), 0);
  return preservationSummary({
    affectedCount: unresolved.length,
    affectedBytes: bytesOf(unresolved),
    protectedCount: protectedResidue.length,
    protectedBytes: bytesOf(protectedResidue),
    coverage: classification.residue.some((entry) => entry.digest === null) ? 'partial' : 'complete',
    notes: ['residue stays preserved in place unless quarantined; referenced residue is never moved']
  });
}

export class LegacyPreservation {
  private readonly ctx: LegacyContext;

  public constructor(deps: LegacyPreservationDependencies) {
    this.ctx = legacyContext(deps);
  }

  /** Read-only classification of the legacy catalog (FR-013). */
  public classifyLegacyCatalogResidue(): Promise<LegacyCatalogClassification> {
    return classify(this.ctx);
  }

  /** A quarantine preview, refused `preview-stale` unless taken on the current source revision. */
  public async previewLegacyQuarantine(basisRevision: string): Promise<LifecycleResult<RetentionPreview>> {
    const classification = await classify(this.ctx);
    if (classification.manifestState === 'faulted') return refuse('unavailable', 'the legacy manifest is unreadable');
    if (basisRevision !== classification.basisRevision) {
      return refuse('preview-stale', 'the legacy catalog changed since it was classified');
    }
    const summary = quarantinePreviewSummary(classification);
    return ok(this.ctx.deps.previews.create('legacy-quarantine', classification.basisRevision, summary));
  }

  public quarantineLegacyResidue(request: LegacyQuarantineRequest): Promise<LifecycleResult<SourcePreservationOperation>> {
    return quarantineLegacyResidue(this.ctx, request);
  }

  public reconcilePreservation(operationId: string): Promise<LifecycleResult<SourcePreservationOperation>> {
    return reconcilePreservation(this.ctx, operationId);
  }

  public previewReimport(
    residueId: string,
    admission: LegacyCatalogAdmissionPort
  ): Promise<LifecycleResult<LegacyReimportPreview>> {
    return previewReimport(this.ctx, residueId, admission);
  }

  public previewQuarantinePurge(): Promise<LifecycleResult<RetentionPreview>> {
    return Promise.resolve(previewQuarantinePurge(this.ctx));
  }

  public purgeQuarantinedResidue(request: LegacyPurgeRequest): Promise<LifecycleResult<LegacyPurgeResult>> {
    return purgeQuarantinedResidue(this.ctx, request);
  }
}

export function createLegacyPreservation(deps: LegacyPreservationDependencies): LegacyPreservation {
  return new LegacyPreservation(deps);
}
