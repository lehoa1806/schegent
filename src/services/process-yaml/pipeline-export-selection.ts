// Feature 085 T021 — which Pipeline definition a references-only export writes.
//
// Two requirements pull against each other here, and research R11 records how
// they are reconciled:
//
//   * FR-014 — export reads the EFFECTIVE catalog, so the bytes are the
//     definition this installation actually runs and not a shadowed layer's copy.
//   * FR-018 — a references-only export MUST NOT require the referenced Phases
//     to resolve. A Pipeline naming Phases this machine does not have is still
//     exportable, sequence intact, because references are all the document
//     carries.
//
// `resolvePipelineCatalog` nulls a row's definition and marks it `invalid` on ANY
// error, and two of its errors are reference-class: `unknown-phase` (from the
// `phaseIds` sequence) and `binding-unknown-phase`. Under FR-018's own case the
// effective catalog is therefore empty, and reading it alone would refuse.
//
// The resolution is strict first, reference-relaxed second:
//
//   1. Resolve normally. If an effective record exists, that is the answer, and
//      FR-014 holds by construction.
//   2. Only when step 1 found nothing, resolve again with the Phase catalog
//      augmented by identifier-only placeholders for the Phases the target row
//      names. `validatePipelineBindings` reads its Phase-catalog argument for
//      exactly one thing — the set of known Phase ids — so placeholders suppress
//      those two reference codes and nothing else. A structural defect
//      (`binding-unknown-input-port`, `binding-phase-out-of-range`,
//      `sequence-ambiguous`, a bad `version`) is computed from the definition's
//      own shape and stays fatal.
//
// Ordering is the load-bearing half. Relaxing first would let a workspace row
// whose only defect is a missing Phase outrank a user row that genuinely
// resolves, and export would emit bytes this installation does not run — FR-014
// broken in the exact case FR-014 exists for. Running the relaxed pass only after
// the strict pass came up empty makes that promotion unreachable.
//
// The relaxed resolution feeds serialization and nothing else. It is never
// persisted, never handed to run creation, never shown as authoring state, and
// never used for US2's FR-017 inclusion check, which needs the Phases to resolve
// for real.

import { pipelineSourceIdentity, resolvePipelineCatalog } from '../../config/pipeline-catalog';
import type { PipelineDef } from '../../config/pipeline-config';
import { validatePipelineDefinition } from '../../config/pipeline-definition-validator';
import type {
  PipelineDefinition,
  PipelineDefinitionScope
} from '../../contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../contracts/process-definitions';

export interface PipelineExportSelectionInput {
  readonly builtIn: readonly PipelineDef[];
  readonly user: readonly unknown[];
  readonly workspace: readonly unknown[];
  /** The effective Phase catalog, per the project rule on binding resolution. */
  readonly phaseCatalog: readonly PhaseDefinition[];
  readonly pipelineId: string;
}

export type PipelineExportSelection =
  | {
      readonly outcome: 'selected';
      readonly definition: PipelineDefinition;
      readonly scope: PipelineDefinitionScope;
    }
  | { readonly outcome: 'unavailable'; readonly reason: 'does-not-resolve' | 'not-found' };

/**
 * The Phase ids the target row names, read by the same structural parse the
 * resolver performs. A row whose structure does not parse yields nothing, which
 * is correct: there is no reference defect to relax past.
 */
function referencedPhaseIds(rows: readonly unknown[], pipelineId: string): string[] {
  const ids: string[] = [];
  rows.forEach((row, index) => {
    if (pipelineSourceIdentity(row, index) !== pipelineId) return;
    const result = validatePipelineDefinition(row, { allowLegacyId: true, defaultVersion: 1 });
    if (result.definition) ids.push(...result.definition.phaseIds);
  });
  return ids;
}

/**
 * An identifier-only stand-in. Only its `phaseId` is ever read — the resolver
 * turns the catalog into a set of ids — so the remaining fields exist solely to
 * satisfy the type.
 */
function placeholderPhase(phaseId: string): PhaseDefinition {
  return { phaseId, name: phaseId, version: 1, instruction: '' };
}

export function selectPipelineForExport(
  input: PipelineExportSelectionInput
): PipelineExportSelection {
  const resolve = (phaseCatalog: readonly PhaseDefinition[]) =>
    resolvePipelineCatalog({
      builtIn: input.builtIn,
      user: input.user,
      workspace: input.workspace,
      phaseCatalog
    });

  const strict = resolve(input.phaseCatalog);
  let record = strict.records.find(
    (row) => row.pipelineId === input.pipelineId && row.status === 'effective'
  );

  if (!record?.definition) {
    const referenced = [
      ...input.builtIn
        .filter((pipeline) => pipeline.id === input.pipelineId)
        .flatMap((pipeline) => [...pipeline.phases]),
      ...referencedPhaseIds(input.user, input.pipelineId),
      ...referencedPhaseIds(input.workspace, input.pipelineId)
    ];
    const known = new Set(input.phaseCatalog.map((phase) => phase.phaseId));
    const placeholders = [...new Set(referenced)]
      .filter((phaseId) => !known.has(phaseId))
      .map(placeholderPhase);
    if (placeholders.length > 0) {
      const relaxed = resolve([...input.phaseCatalog, ...placeholders]);
      record = relaxed.records.find(
        (row) => row.pipelineId === input.pipelineId && row.status === 'effective'
      );
    }
  }

  if (record?.definition) {
    return { outcome: 'selected', definition: record.definition, scope: record.scope };
  }

  // FR-015 — two different absences, told apart so the reason is stated rather
  // than guessed. A row that exists but carries no usable definition is
  // `'does-not-resolve'`; an id no layer mentions at all is `'not-found'`.
  return {
    outcome: 'unavailable',
    reason: strict.records.some((row) => row.pipelineId === input.pipelineId)
      ? 'does-not-resolve'
      : 'not-found'
  };
}
