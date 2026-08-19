// ---------------------------------------------------------------------------
// FR-R3-010 (T410) — the host seam behind `CMD_RESOLVE_AUDIT_POINTER`.
//
// The IPC request names a Run and nothing else, so something has to turn that
// name into the two facts the resolver needs — the stored pointer and the run's
// `completedAt`. That is this module's whole job: look the record up, hand the
// resolver what it stored, and hand back what came out.
//
// It exists as a seam rather than as code inside the handler for the reason
// every other reader seam in the router does (`phaseLogService`,
// `metricsService`): the workspace root reaches it once, at activation, from a
// caller that has already resolved one. A handler that constructed its own
// resolver would need a workspace root of its own, and the only ways a handler
// can get one are the ones `CLAUDE.md` forbids.
//
// It deliberately does **not** project to the wire shape. That belongs to the
// handler, which is the layer that owns the IPC boundary; a service that spoke
// wire types would be a second place the boundary is defined.
// ---------------------------------------------------------------------------

import type { HistoryStore } from '../../state/history-store';
import type { EvidenceHealthReporter } from '../evidence-health/evidence-health-monitor';
import type {
  AuditPointerResolution,
  AuditPointerResolver
} from './audit-pointer-resolver';

/**
 * The one outcome the resolver cannot produce, because it is about the history
 * record rather than the evidence: no row in any partition carries this run id.
 *
 * Reachable in ordinary use — a webview holding a stale snapshot asks about a
 * row the per-queue cap has since evicted — so it is an outcome rather than an
 * error, and distinct from `unaddressable`, which means the row exists and its
 * pointer names nothing this build can address.
 */
export interface UnknownRunResolution {
  readonly status: 'unknown-run';
}

export type HistoryEvidenceResolution = AuditPointerResolution | UnknownRunResolution;

export interface HistoryEvidenceServiceDeps {
  readonly historyStore: Pick<HistoryStore, 'findByRunId'>;
  readonly resolver: Pick<AuditPointerResolver, 'resolve'>;
  /**
   * FR-R3-010 (T412) — optional, on the same terms as every other sink's
   * reporter: health is a diagnostic, and a workspace without a monitor still
   * resolves pointers.
   */
  readonly evidenceHealth?: EvidenceHealthReporter;
}

export class HistoryEvidenceService {
  private readonly historyStore: Pick<HistoryStore, 'findByRunId'>;
  private readonly resolver: Pick<AuditPointerResolver, 'resolve'>;
  private readonly evidenceHealth: EvidenceHealthReporter | undefined;

  constructor(deps: HistoryEvidenceServiceDeps) {
    this.historyStore = deps.historyStore;
    this.resolver = deps.resolver;
    this.evidenceHealth = deps.evidenceHealth;
  }

  public async resolve(runId: string): Promise<HistoryEvidenceResolution> {
    const record = this.historyStore.findByRunId(runId);
    // Reported to neither side. An unknown run id says nothing about whether
    // the corpus is readable — the row was evicted, or the caller's snapshot is
    // stale — so it must not clear a real degradation, and it must not cause
    // one either.
    if (record === null) return { status: 'unknown-run' };
    // The pointer is read verbatim, never repaired. `ensureHistoryEntry` already
    // synthesises one for a row that stored none, so what arrives here is either
    // the pinned `runId:` form or a legacy value some earlier build wrote — and
    // a legacy value is precisely what `unaddressable` is for. Rewriting it to
    // the current form would resolve *this* run's id against a pointer that
    // never addressed it.
    const resolution = await this.resolver.resolve({
      pointer: record.auditLogPointer,
      completedAt: record.completedAt
    });
    this.reportHealth(resolution);
    return resolution;
  }

  /**
   * Only `unavailable` degrades the sink. `evidence-expired`,
   * `no-evidence-recorded` and `unaddressable` are definitive answers the
   * resolver reached by reading what it needed to read, so each of them clears
   * a prior degradation exactly as a successful resolve does — the corpus was
   * legible, and that is the question this sink answers.
   */
  private reportHealth(resolution: AuditPointerResolution): void {
    if (this.evidenceHealth === undefined) return;
    if (resolution.status === 'unavailable') {
      this.evidenceHealth.reportFailure('historyPointer', resolution.reason);
      return;
    }
    this.evidenceHealth.reportSuccess('historyPointer');
  }
}
