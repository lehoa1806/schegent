/**
 * FR-R6-F15 (F15-B; F15-FR-12, F15-FR-15, F15-FR-19, F15-FR-34) — headless inspection and
 * manual approval/edit API for phase-to-phase context handoffs and review loops.
 *
 * Bounded metadata-only projections (<= 64 KiB per explanation, zero finding/context prose).
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { AcceptedRevision, HandoffExplanation } from '../contracts/phase-context/context-manifest';
import type { Refusal } from '../contracts/phase-context/context-policy';
import type {
  PhaseHandoffCoordinator,
  ReviewLoopInspection
} from '../services/phase-context/phase-handoff-coordinator';

export interface PhaseContextApi {
  inspectHandoff(
    handoffId: string,
    revision?: number
  ): { readonly ok: true; readonly explanation: HandoffExplanation } | Refusal;
  inspectReviewLoop(loopId: string): ReviewLoopInspection | null;
  listRunHandoffs(runId: string): readonly HandoffExplanation[];
  listRunReviewLoops(runId: string): readonly ReviewLoopInspection[];
  editHandoff(
    handoffId: string,
    baseRevision: number,
    replacementSources: unknown
  ): { readonly ok: true; readonly revision: AcceptedRevision } | Refusal;
  approveHandoff(
    handoffId: string,
    revision: number,
    decisionId: string
  ): { readonly ok: true; readonly revision: number } | Refusal;
}

export function createPhaseContextApi(
  getCoordinator: () => PhaseHandoffCoordinator | null
): PhaseContextApi {
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
    approveHandoff(handoffId, revision, decisionId) {
      const coord = getCoordinator();
      return coord === null ? unavailable() : coord.approveHandoff(handoffId, revision, decisionId);
    }
  };
}

