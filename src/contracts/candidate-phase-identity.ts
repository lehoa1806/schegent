/**
 * FR-R5-F32 (F32-T01, F32-T02) — pure read-only Phase identity projection for candidate rows,
 * shared by host workflow-control projections and sidebar UI projectors without a
 * `services/ -> ui/` reverse dependency (`tests/lint/architecture-layers.ts`).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
export interface CandidatePhaseIdentityProjection {
  readonly phaseId: string;
  readonly phaseName: string;
  readonly runner?: string;
  readonly model?: string;
  readonly instructionSummary?: string;
  readonly operatorKind?: string;
}

/** Read-only Phase identity for a candidate row, preserving absence. */
export function projectCandidatePhaseIdentity(
  phase: {
    readonly phaseId?: string;
    readonly id?: string;
    readonly name?: string;
    readonly runner?: string;
    readonly model?: string;
    readonly instruction?: string;
    readonly resultContract?: {
      readonly operator?: string | { readonly kind?: string };
    };
  } | null | undefined
): CandidatePhaseIdentityProjection | null {
  if (!phase) return null;
  const phaseId = phase.phaseId ?? phase.id;
  if (!phaseId) return null;
  const instruction = phase.instruction?.trim();
  const op = phase.resultContract?.operator;
  const operatorKind = typeof op === 'string' ? op : op?.kind;
  return Object.freeze({
    phaseId,
    phaseName: phase.name || phaseId,
    ...(phase.runner !== undefined ? { runner: phase.runner } : {}),
    ...(phase.model !== undefined ? { model: phase.model } : {}),
    ...(instruction ? { instructionSummary: instruction.slice(0, 120) } : {}),
    ...(operatorKind !== undefined ? { operatorKind } : {})
  });
}

