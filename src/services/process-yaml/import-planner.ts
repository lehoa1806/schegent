// Feature 084 T029 — the import planner.
//
// Pure, total, and free of I/O: parse and validate happen before it, the write
// happens after it. What it decides is one thing — for the resource a document
// declared, does this installation already claim that id, and if not, what
// would importing it do.
//
// THE PRESENCE ORACLE (FR-030, data-model "PhaseIdPresence"). Presence is
// computed from the STORED ROWS OF EVERY LAYER, whatever each row's
// `PhaseSourceStatus` — `'effective'`, `'shadowed'`, or `'invalid'`. It is NOT
// computed from the resolved effective catalog. A shadowed or malformed row
// still claims its id, so an import cannot take an id the operator is part-way
// through repairing. The rows are the argument, and `PhaseSourceRecord` is the
// only shape this module accepts, so a later change cannot pass
// `resolution.effective` here without failing to typecheck.
//
// Note the deliberate asymmetry with export, which reads the EFFECTIVE catalog
// (FR-014) because it must describe what this installation would actually run.
//
// Decision (084, autonomous): when more than one stored row claims an id, the
// reported claimant is the first in the order the oracle is written in —
// built-in, then user, then workspace. Precedence order was rejected: the
// highest-precedence non-invalid row is always promoted to `'effective'`, which
// would make `presentRowStatus: 'shadowed'` unreachable and turn the field into
// a constant. Presence is a gate, not a routing decision; the reported row is
// evidence for the skip.
//
// Errors are values. Nothing here throws.

import type {
  PhaseDefinitionScope,
  PhaseSourceRecord,
  PhaseSourceStatus
} from '../../contracts/process-definitions';
import { phaseDefinitionFromDocument } from './phase-yaml-mapper';
import type { PhaseYamlValidationResult } from './phase-yaml-validator';
import type {
  DocumentRefusal,
  ImportPlan,
  ImportPlanCounts,
  ImportPlanRow,
  ProcessYamlLayerRevisions
} from './types';

/** The layer order the presence union is written in (data-model). */
const PRESENCE_SCAN_ORDER: readonly PhaseDefinitionScope[] = ['built-in', 'user', 'workspace'];

export interface PhaseIdPresence {
  readonly scope: PhaseDefinitionScope;
  readonly status: PhaseSourceStatus;
}

/**
 * A document-level refusal carries no plan, not even an empty one, so a partial
 * plan for a document this build refused is unrepresentable (FR-027).
 */
export type PlanPhaseImportResult =
  | { readonly outcome: 'refused'; readonly refusal: DocumentRefusal }
  | { readonly outcome: 'planned'; readonly plan: ImportPlan };

/**
 * Does any stored row in any layer claim `phaseId`?
 *
 * Exported so the rule has a name and a direct test, rather than being an
 * anonymous `.some(...)` inside the planner.
 */
export function findPhaseIdPresence(
  storedRows: readonly PhaseSourceRecord[],
  phaseId: string
): PhaseIdPresence | null {
  for (const scope of PRESENCE_SCAN_ORDER) {
    const claimant = storedRows.find((row) => row.scope === scope && row.phaseId === phaseId);
    if (claimant !== undefined) {
      return Object.freeze({ scope: claimant.scope, status: claimant.status });
    }
  }
  return null;
}

function countRows(rows: readonly ImportPlanRow[]): ImportPlanCounts {
  let importCount = 0;
  let skipCount = 0;
  let invalidCount = 0;
  for (const row of rows) {
    if (row.outcome === 'import') importCount += 1;
    else if (row.outcome === 'skip') skipCount += 1;
    else invalidCount += 1;
  }
  // Derived by walking the same list the operator sees, so the counts cannot
  // describe a different set of rows than the ones reported (FR-028).
  return Object.freeze({ import: importCount, skip: skipCount, invalid: invalidCount });
}

function planned(rows: readonly ImportPlanRow[], revisions: ProcessYamlLayerRevisions): PlanPhaseImportResult {
  return {
    outcome: 'planned',
    plan: Object.freeze({
      rows: Object.freeze(rows),
      counts: countRows(rows),
      computedAgainstRevision: revisions
    })
  };
}

/**
 * Turn one validated document into the plan an operator confirms or abandons.
 *
 * `revisions` records BOTH writable layers, because the target scope is chosen
 * after preflight; recording one would leave the staleness gate unable to fire
 * for whichever scope the operator actually picks (FR-033).
 */
export function planPhaseImport(
  validation: PhaseYamlValidationResult,
  storedRows: readonly PhaseSourceRecord[],
  revisions: ProcessYamlLayerRevisions
): PlanPhaseImportResult {
  if (!validation.ok && validation.kind === 'document') {
    return { outcome: 'refused', refusal: validation.refusal };
  }

  if (!validation.ok) {
    // Every defect the validator collected, in one pass (FR-026). The planner
    // adds none of its own: a malformed resource is not also checked for
    // presence, because the id it claims may itself be the defect.
    return planned(
      [
        Object.freeze({
          outcome: 'invalid' as const,
          resourceId: validation.resourceId,
          defects: validation.defects,
          totalDefects: validation.defects.length
        })
      ],
      revisions
    );
  }

  const { metadata, spec } = validation.document;
  const presence = findPhaseIdPresence(storedRows, metadata.phaseId);
  if (presence !== null) {
    // Never overwritten, merged, renamed, or versioned (FR-024).
    return planned(
      [
        Object.freeze({
          outcome: 'skip' as const,
          resourceId: metadata.phaseId,
          name: metadata.name,
          presentIn: presence.scope,
          presentRowStatus: presence.status
        })
      ],
      revisions
    );
  }

  return planned(
    [
      Object.freeze({
        outcome: 'import' as const,
        resourceId: metadata.phaseId,
        name: metadata.name,
        // Advisory only. The capability gate is re-evaluated at commit time and
        // is never answered from this value (FR-012a).
        requiresRetryConditionCapability: spec.retryCondition !== undefined,
        // What the commit writes, exactly as the document authored it (FR-046a).
        // The plan carries it because nothing here is retained past the read
        // that produced it (FR-031); see `ImportPlanRow` for why it is the one
        // field on the row that is not sanitized or bounded.
        definition: phaseDefinitionFromDocument(validation.document)
      })
    ],
    revisions
  );
}
