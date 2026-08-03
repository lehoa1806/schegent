// Feature 083 (US1, T027) — scoped, revisioned, intent-declaring Workflow save.
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
// Feature 059's I-2 invariant is preserved as gate 14: a layer-emptying `reset`
// and a payload byte-equal to `BUILT_IN_WORKFLOWS` both bypass
// `workflowOverrides`, so an operator can always return to defaults from a
// denied state.

import { BUILT_IN_PHASES, BUILT_IN_PIPELINES } from '../../../config/pipeline-config';
import { resolvePipelineCatalog } from '../../../config/pipeline-catalog';
import { resolvePhaseCatalog } from '../../../config/process-catalog';
import {
  BUILT_IN_WORKFLOWS,
  equalsBuiltInWorkflows,
  writeWorkflowLayer
} from '../../../config/workflow-config';
import {
  invalidPipelineCauses,
  workflowLayerRevision,
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
  WorkflowFieldError,
  WritableWorkflowDefinitionScope
} from '../../../contracts/workflow-definitions';
import { isCapabilityAllowed } from '../../../state/capability-trust-resolver';
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
import { denyAndAudit } from './trust-gate';

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

/** Projects a Workflow mutation onto the entity-agnostic intent the algebra reads. */
function workflowIntent(mutation: WorkflowCatalogMutation): LayerMutationIntent {
  return { kind: mutation.kind, targetId: mutation.kind === 'reset' ? null : mutation.workflowId };
}

/**
 * The effective Pipeline catalog every node binds against, resolved the same way
 * `loadCatalog` resolves it: Phases first, then Pipelines against those Phases. Resolving here
 * rather than accepting a cached catalog keeps the repository hard rule intact — a binding, and
 * now a node, is only ever checked against the effective layer.
 */
function effectivePipelineContext(ctx: HandlerContext): WorkflowPipelineContext {
  const phaseLayers = ctx.deps.readPhaseConfig?.() ?? { user: [], workspace: [] };
  const pipelineLayers = ctx.deps.readPipelineConfig?.() ?? { user: [], workspace: [] };
  return resolvePipelineCatalog({
    builtIn: BUILT_IN_PIPELINES,
    user: pipelineLayers.user,
    workspace: pipelineLayers.workspace,
    phaseCatalog: resolvePhaseCatalog({
      builtIn: BUILT_IN_PHASES,
      user: phaseLayers.user,
      workspace: phaseLayers.workspace
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
  scope: WritableWorkflowDefinitionScope,
  sanitize: (value: string) => string
): unknown {
  if (mutation.kind === 'reset') return { scope, legalActions: ['refresh'] };
  const workflowId =
    mutation.kind === 'duplicate' ? mutation.sourceWorkflowId : mutation.workflowId;
  const definition = current.get(workflowId);
  return {
    scope,
    workflowId: sanitize(workflowId).slice(0, WORKFLOW_ID_MAX_LEN),
    ...(definition
      ? { name: sanitize(definition.name).slice(0, WORKFLOW_NAME_MAX_LEN), version: definition.version }
      : {}),
    legalActions: ['refresh', 'reapply']
  };
}

/**
 * The authored settings shape, matching the `schegent.workflows` JSON schema. Unrecognized
 * authored keys are re-emitted first so a recognized field can never be shadowed by one
 * (FR-007): they round-trip, they are never interpreted.
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
  // Gate 1 — host configuration operations.
  if (!ctx.deps.updateConfig || !ctx.deps.readWorkflowConfig) {
    await ack(ctx, 'rejected', 'config-ops-unavailable');
    return;
  }
  const updateConfig = ctx.deps.updateConfig;
  const sanitize = ctx.deps.logger.sanitize;

  const { scope, expectedRevision, mutation } = command.payload;
  const intent = workflowIntent(mutation);
  const layers = ctx.deps.readWorkflowConfig();
  const currentRows = layers[scope];
  const currentRevision = workflowLayerRevision(currentRows);
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
    await ack(ctx, 'rejected', 'stale-catalog', {
      currentRevision,
      current: currentMetadata(mutation, currentById, scope, sanitize)
    });
    return;
  }

  // Gates 4-8 — one accumulating validation pass over the complete proposed layer.
  const proposedLayer = validateProposedLayer(
    command.payload.workflows,
    effectivePipelineContext(ctx)
  );
  if (proposedLayer.errors.length > 0) {
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
    // Gate 10 — the built-in layer is never a save target (FR-026). `BUILT_IN_WORKFLOWS` is
    // empty today, so this cannot fire yet; the gate exists so the day a built-in Workflow
    // ships, a mutation aimed at it is refused with the reason that names the cause rather
    // than falling through to a generic mismatch.
    const builtInIds = new Set(BUILT_IN_WORKFLOWS.map((workflow) => workflow.workflowId));
    const targetId = mutation.kind === 'reset'
      ? null
      : mutation.kind === 'duplicate'
        ? mutation.sourceWorkflowId
        : mutation.workflowId;
    const builtInOnly = (mutation.kind === 'edit' || mutation.kind === 'remove')
      && targetId !== null
      && builtInIds.has(targetId)
      && !currentById.has(targetId);
    if (builtInOnly && targetId !== null) {
      await ack(ctx, 'rejected', 'built-in-immutable', {
        workflowId: sanitize(targetId).slice(0, WORKFLOW_ID_MAX_LEN)
      });
      return;
    }
    // Gate 11 — the declared intent and the observed diff disagree.
    const reported = (ids: readonly string[]) =>
      ids.slice(0, REPORTED_ERROR_MAX).map((id) => sanitize(id).slice(0, WORKFLOW_ID_MAX_LEN));
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
  for (const raw of command.payload.workflows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const workflowId = typeof row.workflowId === 'string'
      ? row.workflowId
      : typeof row.id === 'string' ? row.id : null;
    if (workflowId === null || row.version === undefined) continue;
    const expectedVersions = currentIdentities.versions.get(
      workflowId === repairTargetId && mutation.kind === 'edit' ? mutation.workflowId : workflowId
    ) ?? new Set([1]);
    if (!expectedVersions.has(row.version as number)) {
      await ack(ctx, 'rejected', 'workflow-version-invalid', {
        workflowId: sanitize(workflowId).slice(0, WORKFLOW_ID_MAX_LEN),
        expectedVersions: [...expectedVersions].sort((a, b) => a - b)
      });
      return;
    }
  }

  // Gate 14 — feature 059 I-2: returning to defaults is always allowed, whether expressed as a
  // layer-emptying `reset` or as a payload byte-equal to the built-ins. Everything else needs
  // the `workflowOverrides` capability, which is read fresh here and never cached (I-1).
  const reset = mutation.kind === 'reset' && proposedLayer.definitions.length === 0;
  const restoresDefaults = reset || equalsBuiltInWorkflows(command.payload.workflows);
  if (!restoresDefaults && !isCapabilityAllowed('workflowOverrides')) {
    await denyAndAudit(ctx, 'workflowOverrides');
    return;
  }

  const versionSources = repairTargetId !== null && mutation.kind === 'edit'
    ? new Map([
        ...currentIdentities.versions,
        [repairTargetId, currentIdentities.versions.get(mutation.workflowId) ?? new Set([1])]
      ])
    : currentIdentities.versions;
  const persistedRows = withHostVersions(
    proposedLayer.definitions,
    currentById,
    currentIdentities.counts,
    versionSources,
    intent,
    workflowIntentAdapter
  ).map((definition) => persistedRow(definition, proposedLayer.unrecognized));

  // Gate 15 — the single commit point for the targeted layer (FR-030).
  try {
    await writeWorkflowLayer(updateConfig, persistedRows, scope);
  } catch (error) {
    ctx.deps.logger.warn(
      `workflow catalog save failed: ${sanitize((error as Error).message)}`
    );
    await ack(ctx, 'rejected', 'persistence-failed');
    return;
  }

  // No audit event on success — a catalog mutation is a configuration write, and the audit log
  // is the run-history record (FR-047). A trust denial still audits, via `denyAndAudit`.
  await ack(ctx, 'accepted', undefined, {
    scope,
    revision: workflowLayerRevision(persistedRows),
    mutation: mutation.kind
  });
};
