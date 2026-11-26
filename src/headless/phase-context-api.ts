/**
 * FR-R6-F15 (F15-B; F15-FR-12, F15-FR-15, F15-FR-19, F15-FR-34) — headless inspection and
 * manual approval/edit API for phase-to-phase context handoffs and review loops.
 *
 * Bounded metadata-only projections (<= 64 KiB per explanation, zero finding/context prose).
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type {
  AcceptedRevision,
  HandoffExplanation,
  HandoffRevisionDiff
} from '../contracts/phase-context/context-manifest';
import type { Refusal } from '../contracts/phase-context/context-policy';
import { compareHandoffRevisions } from '../services/phase-context/explanation';
import type {
  PhaseHandoffCoordinator,
  ReviewLoopInspection
} from '../services/phase-context/phase-handoff-coordinator';

export interface PhaseContextApi {
  inspectHandoff(
    handoffId: string,
    revision?: number
  ): { readonly ok: true; readonly explanation: HandoffExplanation } | Refusal;
  compareHandoffRevisions?(
    handoffId: string,
    fromRevision: number,
    toRevision: number
  ): { readonly ok: true; readonly diff: HandoffRevisionDiff } | Refusal;
  inspectReviewLoop(loopId: string): ReviewLoopInspection | null;
  listRunHandoffs(runId: string): readonly HandoffExplanation[];
  listRunReviewLoops(runId: string): readonly ReviewLoopInspection[];
  editHandoff(
    handoffId: string,
    baseRevision: number,
    replacementSources: unknown
  ): { readonly ok: true; readonly revision: AcceptedRevision } | Refusal;
  editHandoffSummary?(
    handoffId: string,
    baseRevision: number,
    summary: string,
    producerAttemptId?: string
  ): { readonly ok: true; readonly revision: AcceptedRevision } | Refusal;
  approveHandoff(
    handoffId: string,
    revision: number,
    decisionId: string
  ): { readonly ok: true; readonly revision: number } | Refusal;
}

export function createPhaseContextApi(
  getCoordinator: () => PhaseHandoffCoordinator | null
): Required<PhaseContextApi> {
  const unavailable = (): Refusal => ({
    ok: false,
    failure: 'storage-unavailable',
    detail: 'handoff-coordinator-unavailable'
  });

  return {
    inspectHandoff(handoffId, revision) {
      const coord = getCoordinator();
      return coord === null ? unavailable() : coord.inspectHandoff(handoffId, revision);
    },
    compareHandoffRevisions(handoffId, fromRevision, toRevision) {
      const coord = getCoordinator();
      if (coord === null) return unavailable();
      const maybeWithDiff = coord as PhaseHandoffCoordinator & {
        readonly compareHandoffRevisions?: (
          id: string,
          fromRev: number,
          toRev: number
        ) => { readonly ok: true; readonly diff: HandoffRevisionDiff } | Refusal;
      };
      if (typeof maybeWithDiff.compareHandoffRevisions === 'function') {
        return maybeWithDiff.compareHandoffRevisions(handoffId, fromRevision, toRevision);
      }
      const inspected = coord.acceptance.inspect(handoffId);
      if (!inspected.ok) return inspected;
      if (inspected.record === null) {
        return { ok: false, failure: 'stale-revision', detail: 'unknown-handoff' };
      }
      return compareHandoffRevisions(inspected.record, fromRevision, toRevision);
    },
    inspectReviewLoop(loopId) {
      const coord = getCoordinator();
      return coord === null ? null : coord.inspectReviewLoop(loopId);
    },
    listRunHandoffs(runId) {
      const coord = getCoordinator();
      return coord === null ? [] : coord.listRunHandoffs(runId);
    },
    listRunReviewLoops(runId) {
      const coord = getCoordinator();
      return coord === null ? [] : coord.listRunReviewLoops(runId);
    },
    editHandoff(handoffId, baseRevision, replacementSources) {
      const coord = getCoordinator();
      return coord === null ? unavailable() : coord.editHandoff(handoffId, baseRevision, replacementSources);
    },
    editHandoffSummary(handoffId, baseRevision, summary, producerAttemptId) {
      const coord = getCoordinator();
      return coord === null
        ? unavailable()
        : coord.editHandoffSummary(handoffId, baseRevision, summary, producerAttemptId);
    },
    approveHandoff(handoffId, revision, decisionId) {
      const coord = getCoordinator();
      return coord === null ? unavailable() : coord.approveHandoff(handoffId, revision, decisionId);
    }
  };
}

