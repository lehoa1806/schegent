// Feature 083 (US1, T027) — revisioned, intent-declaring Workflow save.
// Contract: specs/083-workflow-graph-builder/contracts/save-workflows-ipc.md
//
// The third catalog save. It reuses the payload shape, the gate order, and the
// intent algebra already shipped by `CMD_SAVE_PHASES` (081) and
// `CMD_SAVE_PIPELINES` (082) rather than inventing a parallel mechanism
// (research R10). Two gates run before this handler, exactly as they do for the
// Pipeline save: gate 2 is the ingress validator
// (`contracts/validators/save-workflows.ts`) and gate 13 is the router's
// workspace-trust gate over `MUTATING_COMMAND_TYPES`.
//
// Two deliberate differences from `cmd-save-pipelines.ts`:
//   * Gates 4-8 accumulate into ONE `workflow-validation` rejection instead of
//     returning at the first defect (FR-019). An operator repairing a graph one
//     error per round-trip is the failure mode this feature exists to avoid.
//   * There is no removal gate. A Workflow definition is the top of the
//     reference chain here — no stored artifact points at one — so nothing can
//     be stranded by removing it. The reverse direction is gated on the
//     Pipeline side.
//
// Feature 099 (T493d, FR-042a) — the commit writes the versioned catalog store
// rather than the retired Workflow settings key, which is deleted. Two gates went with the
// layer tier: gate 10's `built-in-immutable` (there is no built-in layer left to
// aim at) and gate 14's `workflowOverrides` capability, which asked whether this
// layer could redefine what another declares — a question one layer cannot pose
// (FR-046). Gate 12's version echo and gate 3's revision gate are untouched: the
// single-intent, expected-revision contract is exactly what FR-047 keeps.

import { resolvePipelineCatalog } from '../../../config/pipeline-catalog';
import { resolvePhaseCatalog } from '../../../config/process-catalog';
import {
  invalidPipelineCauses,
  type WorkflowPipelineContext
} from '../../../config/workflow-catalog';
import {
  WORKFLOW_ERROR_FIELD_MAX,
  WORKFLOW_ID_MAX_LEN,
  WORKFLOW_NAME_MAX_LEN,
  validateWorkflowDefinition,
  workflowFieldError
} from '../../../config/workflow-definition-validator';
import { validateWorkflowGraph } from '../../../config/workflow-graph-validator';
import type {
  WorkflowCatalogMutation,
  WorkflowDefinition,
  WorkflowFieldError
} from '../../../contracts/workflow-definitions';
import { commitCatalogLayer } from './catalog-layer-commit';
import {
  auditImportRefused,
  type ImportCommitTarget
} from './process-exchange-commit-audit';
import type { SaveWorkflowsCommand } from '../messages';
import type { CommandHandler, HandlerContext } from './handler-contract';
import { ack } from './handler-helpers';
import {
  definitionMap,
  identityRepairTarget,
  layerDiff,
  layerIdentities,
  layerShapeMatches,
  mutationMatches,
  withHostVersions,
  workflowIntentAdapter,
  type LayerMutationIntent
} from './save-layer-intent';

const ERROR_CODE_MAX = 64;
const ERROR_MESSAGE_MAX = 512;
const REPORTED_ERROR_MAX = 20;

/** Authored keys a row may carry beyond the recognized set, kept for FR-007 round-trip fidelity. */
type UnrecognizedFields = ReadonlyMap<string, Readonly<Record<string, unknown>>>;

interface NormalizedLayer {
  readonly definitions: readonly WorkflowDefinition[];
  readonly unrecognized: UnrecognizedFields;
  readonly errors: readonly WorkflowFieldError[];
}

/**
 * Projects a Workflow mutation onto the entity-agnostic intent the algebra reads.
 *
 * `import-package` (feature 086, FR-046) names a SET rather than a single id, so
 * it carries `targetIds` and no `targetId` at all. The algebra itself needed no
 * change for the third layer — it was extracted entity-agnostic in 082 and takes
 * the adapter as an argument.
 */
function workflowIntent(mutation: WorkflowCatalogMutation): LayerMutationIntent {
  if (mutation.kind === 'import-package') {
    return { kind: 'import-package', targetId: null, targetIds: mutation.workflowIds };
  }
  return { kind: mutation.kind, targetId: mutation.kind === 'reset' ? null : mutation.workflowId };
}

/**
 * Restores the version each imported row declared (feature 086, FR-003a).
 *
 * `withHostVersions` is right for every other kind and wrong for this one: an id
 * absent from the layer is brand new to it, so the host assigns 1 — which is
 * correct for a Workflow the operator just created and lossy for one read out of
 * a document that already numbered it. Applied to the declared set only, so a row
 * carried across from the current layer keeps the version the host issued it.
 *
 * The same post-processing `cmd-save-pipelines.ts` does, for the same reason. It
 * stays at the command layer rather than moving into the algebra: the algebra
 * knows nothing about documents, and giving it a "trust the proposal's version"
 * mode would be a mode every other kind must then be proven not to reach.
 */
function withImportedVersion(
  versioned: readonly WorkflowDefinition[],
  proposedById: ReadonlyMap<string, WorkflowDefinition>,
  mutation: WorkflowCatalogMutation
): readonly WorkflowDefinition[] {
  if (mutation.kind !== 'import-package') return versioned;
  const importedIds = new Set(mutation.workflowIds);
  return versioned.map((definition) => {
    if (!importedIds.has(definition.workflowId)) return definition;
    const authored = proposedById.get(definition.workflowId);
    return authored === undefined
      ? definition
      : Object.freeze({ ...definition, version: authored.version });
  });
}

/**
 * The effective Pipeline catalog every node binds against, resolved the same way
 * `loadCatalog` resolves it: Phases first, then Pipelines against those Phases. Resolving here
 * rather than accepting a cached catalog keeps the repository hard rule intact — a binding, and
 * now a node, is only ever checked against the effective layer.
 */
function effectivePipelineContext(ctx: HandlerContext): WorkflowPipelineContext {
  const storedPhases = ctx.deps.readPhaseConfig?.() ?? { rows: [], revision: '' };
  const storedPipelines = ctx.deps.readPipelineConfig?.() ?? { rows: [], revision: '' };
  return resolvePipelineCatalog({
    rows: storedPipelines.rows,
    revision: storedPipelines.revision,
    phaseCatalog: resolvePhaseCatalog({
      rows: storedPhases.rows,
      revision: storedPhases.revision
    }).effective
  });
}

/**
 * Gates 4-8 as a single accumulating pass (FR-019). Per row: field validation, then — only when
 * the row parsed — the cross-reference, port, graph, and condition checks. The duplicate-id check
 * closes it because only a whole layer can see a repeat (FR-009).
 *
 * `validateWorkflowGraph` owns gates 5-8 internally, including the one ordering dependency: it
 * skips the condition checks when the graph is cyclic, because ancestry is undefined in a cycle.
 */
function validateProposedLayer(
  rows: readonly unknown[],
  pipelines: WorkflowPipelineContext
): NormalizedLayer {
  const invalidPipelines = invalidPipelineCauses(pipelines);
  const definitions: WorkflowDefinition[] = [];
  const unrecognized = new Map<string, Readonly<Record<string, unknown>>>();
  const errors: WorkflowFieldError[] = [];
  const counts = new Map<string, number>();
  for (const row of rows) {
    const result = validateWorkflowDefinition(row, { allowLegacyId: true, defaultVersion: 1 });
    errors.push(...result.errors);
    if (!result.definition) continue;
    errors.push(
      ...validateWorkflowGraph(result.definition, pipelines.effective, invalidPipelines)
    );
    definitions.push(result.definition);
    const workflowId = result.definition.workflowId;
    counts.set(workflowId, (counts.get(workflowId) ?? 0) + 1);
    if (Object.keys(result.unrecognized).length > 0) {
      unrecognized.set(workflowId, result.unrecognized);
    }
  }
  for (const [workflowId, count] of counts) {
    if (count < 2) continue;
    errors.push(
      workflowFieldError(
        workflowId,
        'workflowId',
        'duplicate-in-scope',
        `Workflow id '${workflowId.slice(0, WORKFLOW_ID_MAX_LEN)}' appears more than once in this scope`
      )
    );
  }
  return { definitions, unrecognized, errors };
}

function boundedValidationResult(
  errors: readonly WorkflowFieldError[],
  sanitize: (value: string) => string
): unknown {
  return {
    errors: errors.slice(0, REPORTED_ERROR_MAX).map((error) => ({
      workflowId: sanitize(error.workflowId).slice(0, WORKFLOW_ID_MAX_LEN),
      field: sanitize(error.field).slice(0, WORKFLOW_ERROR_FIELD_MAX),
      code: sanitize(error.code).slice(0, ERROR_CODE_MAX),
      message: sanitize(error.message).slice(0, ERROR_MESSAGE_MAX)
    })),
    total: errors.length,
    // Ancestry is undefined in a cyclic graph, so gate 8's FR-023 scope check
    // alone did not run — every other condition check is graph-independent and
    // is already included above. Saying so here keeps the `not-ancestor`
    // defects that may appear after the cycle is cut from reading as a second,
    // unexplained round of errors.
    ...(errors.some((error) => error.code === 'graph-cycle')
      ? { ancestryChecksSuppressed: true }
      : {})
  };
}

function currentMetadata(
  mutation: WorkflowCatalogMutation,
  current: ReadonlyMap<string, WorkflowDefinition>,
  sanitize: (value: string) => string
): unknown {
  if (mutation.kind === 'reset') return { legalActions: ['refresh'] };
  // A package names a set, not a row, and `reapply` is not offered: the plan was
  // computed against the revision this gate just rejected, so its skip and
  // blocked decisions may no longer hold. The operator re-runs the preflight.
  if (mutation.kind === 'import-package') return { legalActions: ['refresh'] };
  const workflowId =
    mutation.kind === 'duplicate' ? mutation.sourceWorkflowId : mutation.workflowId;
  const definition = current.get(workflowId);
  return {
    workflowId: sanitize(workflowId).slice(0, WORKFLOW_ID_MAX_LEN),
    ...(definition
      ? { name: sanitize(definition.name).slice(0, WORKFLOW_NAME_MAX_LEN), version: definition.version }
      : {}),
    legalActions: ['refresh', 'reapply']
  };
}

/**
 * The authored row shape, as the store holds it. Unrecognized authored keys are
 * re-emitted first so a recognized field can never be shadowed by one (FR-007):
 * they round-trip, they are never interpreted. Feature 099 changes nothing here —
 * the store takes a body verbatim and never normalises it (FR-010, FR-011).
 */
function persistedRow(
  definition: WorkflowDefinition,
  unrecognized: UnrecognizedFields
): Record<string, unknown> {
  return {
    ...(unrecognized.get(definition.workflowId) ?? {}),
    id: definition.workflowId,
    name: definition.name,
    version: definition.version,
    ...(definition.description !== undefined ? { description: definition.description } : {}),
    nodes: [...definition.nodes],
    connections: [...definition.connections],
    startNodeIds: [...definition.startNodeIds]
  };
}

export const handler: CommandHandler<SaveWorkflowsCommand> = async (ctx, command) => {
  const { expectedRevision, mutation } = command.payload;
  // Feature 086 T056 (FR-054) — the one layer write a package import is about, or
  // null for every other mutation. Read before gate 1 so a refusal at any gate
  // leaves a record; every audit call below is a no-op when null. Three writes
  // that can succeed independently mean the catalog is no longer the record of
  // what an import did, which is the whole reason 085 added these — a workspace
  // holding the Phases and Pipelines and no Workflow is otherwise
  // indistinguishable from a two-layer document.
  const exchange: ImportCommitTarget | null =
    mutation.kind === 'import-package'
      ? { resourceKind: 'workflow', resourceIds: mutation.workflowIds }
      : null;

  // Gate 1 — somewhere to write. `null` is an untrusted workspace, where no
  // catalog is activated at all (FR-051); `undefined` is a window that wired no
  // store. Both mean this save has nowhere to land, and the Builder reports the
  // trust gate on its own surface rather than through a save refusal (FR-052).
  const store = ctx.deps.catalogStore;
  if (!store || !ctx.deps.readWorkflowConfig) {
    await auditImportRefused(ctx, exchange, 'config-ops-unavailable');
    await ack(ctx, 'rejected', 'config-ops-unavailable');
    return;
  }
  const sanitize = ctx.deps.logger.sanitize;

  const intent = workflowIntent(mutation);
  const stored = ctx.deps.readWorkflowConfig();
  const currentRows = stored.rows;
  const currentRevision = stored.revision;
  // Field validation only. A stored row that is well-formed but graph-invalid must stay
  // diffable, or the operator could never save the edit that repairs it.
  const currentDefinitions = currentRows
    .map((row) => workflowIntentAdapter.parse(row))
    .filter((definition): definition is WorkflowDefinition => definition !== null);
  const currentById = definitionMap(currentDefinitions, workflowIntentAdapter);
  const currentIdentities = layerIdentities(currentRows, workflowIntentAdapter);

  // Gate 3 — the operator acted on the layer the host still holds (FR-028). This precedes the
  // trust gates so a stale untrusted save reports the staleness (CLAUDE.md hard rule).
  if (expectedRevision !== currentRevision) {
    await auditImportRefused(ctx, exchange, 'stale-catalog');
    await ack(ctx, 'rejected', 'stale-catalog', {
      currentRevision,
      current: currentMetadata(mutation, currentById, sanitize)
    });
    return;
  }

  // Gates 4-8 — one accumulating validation pass over the complete proposed layer.
  const proposedLayer = validateProposedLayer(
    command.payload.workflows,
    effectivePipelineContext(ctx)
  );
  if (proposedLayer.errors.length > 0) {
    await auditImportRefused(ctx, exchange, 'workflow-validation');
    await ack(
      ctx,
      'rejected',
      'workflow-validation',
      boundedValidationResult(proposedLayer.errors, sanitize)
    );
    return;
  }

  // Gates 9, 10, and 11 — the observed diff must be exactly what the declared mutation is
  // allowed to produce, and nothing more (FR-029).
  const proposedById = definitionMap(proposedLayer.definitions, workflowIntentAdapter);
  const proposedIdentities = layerIdentities(command.payload.workflows, workflowIntentAdapter);
  const diff = layerDiff(currentById, proposedById);
  const repairTargetId = identityRepairTarget(
    intent, currentIdentities.counts, proposedIdentities.counts, diff
  );
  const mutationValid = (repairTargetId !== null || mutationMatches(
    intent, diff, proposedLayer.definitions.length,
    currentIdentities.counts, proposedIdentities.counts
  )) && layerShapeMatches(
    intent, currentRows, command.payload.workflows, repairTargetId, workflowIntentAdapter
  );
  if (!mutationValid) {
    // Gate 9 — an `edit` that renames the row's identity is a distinct operation the operator
    // must express as a duplicate (FR-005).
    if (
      mutation.kind === 'edit' &&
      (currentIdentities.counts.get(mutation.workflowId) ?? 0) === 1 &&
      (proposedIdentities.counts.get(mutation.workflowId) ?? 0) === 0 &&
      [...proposedIdentities.counts.keys()].some(
        (workflowId) => !currentIdentities.counts.has(workflowId)
      )
    ) {
      await ack(ctx, 'rejected', 'workflow-identity-immutable', {
        workflowId: sanitize(mutation.workflowId).slice(0, WORKFLOW_ID_MAX_LEN),
        legalActions: ['duplicate']
      });
      return;
    }
    // Feature 099 (FR-039, FR-046) — gate 10 is gone. It refused a mutation aimed
    // at a row the built-in layer owned, so that such a mutation named its cause
    // rather than falling through to a generic mismatch. `BUILT_IN_WORKFLOWS` was
    // empty for its whole life and the layer it guarded no longer exists.
    // Gate 11 — the declared intent and the observed diff disagree.
    const reported = (ids: readonly string[]) =>
      ids.slice(0, REPORTED_ERROR_MAX).map((id) => sanitize(id).slice(0, WORKFLOW_ID_MAX_LEN));
    await auditImportRefused(ctx, exchange, 'workflow-mutation-mismatch');
    await ack(ctx, 'rejected', 'workflow-mutation-mismatch', {
      expected: mutation.kind,
      actual: {
        added: reported(diff.added),
        removed: reported(diff.removed),
        changed: reported(diff.changed)
      }
    });
    return;
  }

  // Gate 12 — versions are host-owned, so a row may only assert one the host previously issued
  // (FR-001). Field validation already refused a non-positive integer; this refuses a
  // well-formed integer the host never wrote.
  const importedIds = new Set(
    mutation.kind === 'import-package' ? mutation.workflowIds : []
  );
  for (const raw of command.payload.workflows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const workflowId = typeof row.workflowId === 'string'
      ? row.workflowId
      : typeof row.id === 'string' ? row.id : null;
    if (workflowId === null || row.version === undefined) continue;
    // An imported identity declares its own version (086 FR-003a). Skipping the
    // echo check for those alone leaves it in force for every other row, so a
    // package cannot smuggle a version onto a row it does not name.
    if (importedIds.has(workflowId)) continue;
    const expectedVersions = currentIdentities.versions.get(
      workflowId === repairTargetId && mutation.kind === 'edit' ? mutation.workflowId : workflowId
    ) ?? new Set([1]);
    if (!expectedVersions.has(row.version as number)) {
      await auditImportRefused(ctx, exchange, 'workflow-version-invalid');
      await ack(ctx, 'rejected', 'workflow-version-invalid', {
        workflowId: sanitize(workflowId).slice(0, WORKFLOW_ID_MAX_LEN),
        expectedVersions: [...expectedVersions].sort((a, b) => a - b)
      });
      return;
    }
  }

  const versionSources = repairTargetId !== null && mutation.kind === 'edit'
    ? new Map([
        ...currentIdentities.versions,
        [repairTargetId, currentIdentities.versions.get(mutation.workflowId) ?? new Set([1])]
      ])
    : currentIdentities.versions;
  const versioned = withHostVersions(
    proposedLayer.definitions,
    currentById,
    currentIdentities.counts,
    versionSources,
    intent,
    workflowIntentAdapter
  );
  const persistedRows = withImportedVersion(versioned, proposedById, mutation).map((definition) =>
    persistedRow(definition, proposedLayer.unrecognized)
  );

  // Gate 15 — the single commit point (FR-030). One `saveLayer` call rather than
  // one `save` per row: the revision gate is per kind (FR-044), so N calls would
  // move the revision on the first and refuse themselves as stale on the second.
  //
  // No audit event for an ordinary catalog mutation — the audit log is the
  // run-history record (FR-047), and the store's own manifest is now the history
  // of the catalog. A package import still audits through `exchange` above, which
  // is null for every other kind (FR-054).
  await commitCatalogLayer(ctx, store, {
    kind: 'workflow',
    definitions: persistedRows.map((row) => ({ id: row.id as string, body: row })),
    expectedRevision,
    mutationKind: mutation.kind,
    exchange
  });
};
