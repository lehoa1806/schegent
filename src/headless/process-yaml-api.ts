// Feature 089 T010/T011/T012 — preview, import, and export a portable document.
// Contract: specs/089-headless-parity-qualification/contracts/headless-api.md §2
//
// Three entrypoints over the two extracted exchange services. None of them
// performs I/O: a document arrives as bytes and leaves as bytes, and the caller
// owns every read and write (R7). No request or result carries a filesystem
// path, which is the repository's standing process-YAML rule holding on a second
// adapter (FR-006).
//
// `retryCondition` is inert text on this path, exactly as it is on the sidebar's.
// Nothing here parses it, normalizes it, or decides whether it "really" needs the
// capability; the field's presence is what the gate keys on, and its grammar is
// read only by the sandboxed evaluator at run time.
//
// This module imports no editor host API (FR-007).

import type {
  PackageLayer,
  PackagePublishOutcome,
  PackagePublishRequest
} from '../contracts/catalog-lifecycle';
import type { SaveModelsCommand } from '../contracts/sidebar-ipc';
import type {
  ExportProcessYamlRequest,
  ExportProcessYamlResult,
  PreflightProcessYamlResult
} from '../contracts/sidebar-ipc/process-yaml';
import {
  appendExportAudit,
  MODEL_CATALOG_EXPORT_RESOURCE_ID,
  selectProcessExportDocument
} from '../services/process-yaml/export-service';
import { preflightProcessDocument } from '../services/process-yaml/preflight-service';
import type { ExchangeDeps } from '../services/process-yaml/service-ports';
import type { ImportPlan, ImportPlanRow } from '../services/process-yaml/types';
import {
  checkDocumentBytes,
  checkExportSelection,
  type BoundaryRefusal
} from './process-api-validators';

// -- Preview (T010) ---------------------------------------------------------

export interface PreviewProcessDocumentInput {
  readonly bytes: Uint8Array;
}

/**
 * What importing this document would do, changing nothing (FR-002).
 *
 * The gates it inherits are the preflight service's, in the service's order:
 * size, then encoding, then disallowed syntax, then kind dispatch, then per-kind
 * planning, then defect bounding. Presence is resolved against the **stored
 * rows** of every layer at every status — `shadowed` and `invalid` included —
 * never against the effective catalog, because a shadowed row read as absent is
 * how an import overwrites work its author is midway through fixing.
 */
export async function previewProcessDocument(
  deps: ExchangeDeps,
  input: PreviewProcessDocumentInput
): Promise<PreflightProcessYamlResult | BoundaryRefusal> {
  const refusal = checkDocumentBytes(input?.bytes);
  if (refusal !== null) return refusal;
  return preflightProcessDocument(deps, { bytes: input.bytes });
}

// -- Import (T011) ----------------------------------------------------------

/** One layer save, as the router's own handler answers it. */
export type LayerSaveAck =
  | { readonly status: 'accepted'; readonly result?: unknown }
  | { readonly status: 'rejected'; readonly reason: string; readonly result?: unknown };

/**
 * The two writes, injected.
 *
 * Feature 100 (T511) — the three ordered layer saves became **one** package
 * publish. The ordering this module used to own moved into the operation itself
 * (FR-035): `publishPackage` drafts every layer in dependency order and then
 * publishes exactly the ids it drafted, which is what makes an import land as a
 * set rather than as three independently-gated writes that can stop between two
 * of them (FR-041, FR-042).
 *
 * That is also why an import can no longer leave a Pipeline live against Phases
 * that never landed: the second pass runs only over what the first pass wrote.
 * What can still happen is the whole thing stopping partway, and that is reported
 * rather than repaired — FR-042c forbids a compensating delete, and FR-039a leaves
 * whatever landed as a Draft for the operator to publish or re-import over.
 *
 * The Model Catalog keeps its own write because it never shares a document with
 * the other three (FR-015) and is still configuration-backed (099 FR-054).
 */
export interface ImportWritePort {
  publishPackage(request: PackagePublishRequest): Promise<PackagePublishOutcome>;
  saveModels(payload: SaveModelsCommand['payload']): Promise<LayerSaveAck>;
}

/**
 * What a confirmed import needs, which is the plan and nothing else.
 *
 * Feature 100 (T511, FR-039a) — the stored rows of the target catalogs used to
 * arrive here too, because a layer write replaced a whole array and the untouched
 * rows had to be carried back in to survive it. A publication addresses
 * definitions by id, so there is no envelope for an unnamed row to fall out of
 * and nothing left for a caller to supply: naming a stored id would publish that
 * id's head, which is the side effect FR-039a forbids.
 */
export interface ImportProcessDocumentInput {
  /**
   * The plan the caller accepted. It IS the confirmation: a caller that did not
   * accept it does not pass it, and the revisions each write gates on are read
   * from it rather than taken as a separate argument — see `layerRevisions`.
   */
  readonly plan: ImportPlan;
}

export type ImportLayerKey = 'phases' | 'pipelines' | 'workflows' | 'models';

/**
 * The layer keys in write order — the one place this module states the order.
 *
 * `'models'` has no ordering relationship with the other three: FR-015 rules
 * out cross-catalog references, so a Model Catalog document never shares a
 * plan with Phase/Pipeline/Workflow rows (contract §1, research.md Decision
 * 4). Its position here is therefore unconstrained; it is listed last only
 * because it was added last.
 */
export const IMPORT_LAYER_ORDER: readonly ImportLayerKey[] = [
  'phases',
  'pipelines',
  'workflows',
  'models'
];

export interface ImportLayerResult {
  readonly key: ImportLayerKey;
  readonly ack: LayerSaveAck;
}

/** What a confirmed import did, taken as a whole (FR-042a). */
export type ImportCommitOutcome = 'imported' | 'partial' | 'failed';

export interface ImportProcessDocumentResult {
  readonly outcome: ImportCommitOutcome;
  readonly results: readonly ImportLayerResult[];
}

type ImportRowOf<K extends ImportPlanRow['resourceKind']> = Extract<
  ImportPlanRow,
  { outcome: 'import'; resourceKind: K }
>;

function importRows<K extends ImportPlanRow['resourceKind']>(
  plan: ImportPlan,
  resourceKind: K
): readonly ImportRowOf<K>[] {
  return plan.rows.filter(
    (row): row is ImportRowOf<K> => row.outcome === 'import' && row.resourceKind === resourceKind
  );
}

/**
 * Group `import`-outcome Model Catalog rows into the delta `CMD_SAVE_MODELS`
 * expects (contract §4 / Implementation Note 2): only the candidate entries
 * the plan classified, never a pre-merged catalog. The server re-plans against
 * the freshly-read current catalog and merges; this port sends the delta the
 * same way the sidebar's import-confirm call site does.
 */
function modelsDeltaByBackend(
  rows: readonly ImportRowOf<'modelCatalog'>[]
): Record<string, readonly string[]> {
  const delta: Record<string, string[]> = {};
  for (const row of rows) {
    (delta[row.backend] ??= []).push(row.modelId);
  }
  return delta;
}

/** The layer key each catalog kind reports under. */
const LAYER_KEY_OF: Readonly<Record<PackageLayer['kind'], ImportLayerKey>> = {
  phase: 'phases',
  pipeline: 'pipelines',
  workflow: 'workflows'
};

/**
 * One package outcome, reported as the per-layer results this module has always
 * returned (FR-042a).
 *
 * The shape is kept because it is what an operator's report is built from — which
 * layers went live and which did not — and because a package that stops partway
 * is exactly the case where "the import failed" is the wrong thing to say. The
 * three cases:
 *
 *   published → every declared layer is live.
 *   partial   → the layers named in `published` are live; the rest were written
 *               and are Drafts (FR-039a). Reported per layer so the operator can
 *               see the boundary, never repaired.
 *   refused   → nothing was written, so every declared layer is refused under the
 *               refusal's own reason.
 */
export function packageResults(
  layers: readonly PackageLayer[],
  outcome: PackagePublishOutcome
): readonly ImportLayerResult[] {
  if (outcome.outcome === 'published') {
    return layers.map((layer) => ({
      key: LAYER_KEY_OF[layer.kind],
      ack: { status: 'accepted' } as const
    }));
  }
  if (outcome.outcome === 'refused') {
    const { refusal } = outcome;
    return layers.map((layer) => ({
      key: LAYER_KEY_OF[layer.kind],
      ack: { status: 'rejected', reason: refusal.reason, result: refusal } as const
    }));
  }
  const live = new Set(outcome.published.map((published) => published.kind));
  return layers.map((layer) => ({
    key: LAYER_KEY_OF[layer.kind],
    ack: live.has(layer.kind)
      ? ({ status: 'accepted' } as const)
      : ({ status: 'rejected', reason: 'package-partial', result: outcome } as const)
  }));
}

/**
 * The three outcomes, read off the acks that actually came back (FR-042a).
 *
 * `partial` exists because the writes are independently gated and an earlier one
 * can succeed while a later one is refused — two shapes as of feature 086, a
 * refused Pipeline write after a Phase write and a refused Workflow write after
 * both. Counting acks is total over either. It is reported rather than repaired:
 * FR-042c forbids a compensating delete, so the honest report is all this surface
 * owes its caller.
 *
 * An empty result list is `failed`, not `imported` — the commit sent nothing.
 */
export function importCommitOutcome(
  results: readonly ImportLayerResult[]
): ImportCommitOutcome {
  if (results.length === 0) return 'failed';
  const accepted = results.filter((result) => result.ack.status === 'accepted').length;
  if (accepted === results.length) return 'imported';
  return accepted === 0 ? 'failed' : 'partial';
}

/**
 * Apply a plan as ordered per-layer writes: Phases, then Pipelines, then
 * Workflows (FR-008, and the repository's standing package-write rule).
 *
 * The order is fixed by dependency and no write may precede the one it depends
 * on: a Pipeline's bindings are only satisfiable once its Phases are effective,
 * and a Workflow's nodes only resolve once its Pipelines are. Each write carries
 * its OWN expected revision — the one the PLAN was computed against, taken from
 * the plan and never read live, because a revision read at the moment of the
 * write leaves the staleness gate unable to fire (FR-040).
 * Each layer names its own target set through the ids it carries, so a document
 * supplying fewer layers writes fewer times and never merges two kinds into one
 * layer. The per-layer `import-package` mutation intent is gone with the intent
 * algebra (feature 100, FR-051): there is no whole-array diff left for a declared
 * intent to be reconciled against, and a layer's `kind` is what identifies it.
 *
 * Sequential and short-circuiting: a rejection stops the sequence, and stopping
 * is all it does. Whichever prefix landed stays written (FR-042c). Importing the
 * same document a second time is the recovery path, because the presence scan
 * turns the already-written rows into `skip` rows.
 */
export async function importProcessDocument(
  deps: ImportWritePort,
  input: ImportProcessDocumentInput
): Promise<ImportProcessDocumentResult> {
  const { plan } = input;
  const phases = importRows(plan, 'phase');
  const pipelines = importRows(plan, 'pipeline');
  const workflows = importRows(plan, 'workflow');
  const models = importRows(plan, 'modelCatalog');
  const pipelineRevision = plan.computedAgainstPipelineRevision;
  const workflowRevision = plan.computedAgainstWorkflowRevision;
  const modelsRevision = plan.computedAgainstModelsRevision;

  // Half a package is the one outcome no requirement admits. A plan that carries
  // rows for a layer but no revision to gate that layer's write cannot be applied
  // at all, so nothing is sent — not the layers it happens to have a gate for.
  if (pipelines.length > 0 && pipelineRevision === undefined) {
    return { outcome: 'failed', results: [] };
  }
  if (workflows.length > 0 && workflowRevision === undefined) {
    return { outcome: 'failed', results: [] };
  }
  if (models.length > 0 && modelsRevision === undefined) {
    return { outcome: 'failed', results: [] };
  }

  const layerRequest: PackageLayer[] = [];
  if (phases.length > 0) {
    layerRequest.push({
      kind: 'phase',
      expectedRevision: plan.computedAgainstRevision,
      definitions: phases.map(({ definition }) => {
        const { phaseId, ...declared } = definition;
        return { id: phaseId, body: { id: phaseId, ...declared } };
      })
    });
  }
  if (pipelines.length > 0 && pipelineRevision !== undefined) {
    layerRequest.push({
      kind: 'pipeline',
      expectedRevision: pipelineRevision,
      definitions: pipelines.map(({ definition }) => {
        const { pipelineId, phaseIds, ...declared } = definition;
        return { id: pipelineId, body: { id: pipelineId, phases: [...phaseIds], ...declared } };
      })
    });
  }
  if (workflows.length > 0 && workflowRevision !== undefined) {
    layerRequest.push({
      kind: 'workflow',
      expectedRevision: workflowRevision,
      // Carried as declared: a rewritten connection or a reordered node list is
      // precisely the lossy round trip FR-046a forbids.
      definitions: workflows.map(({ definition }) => ({
        id: definition.workflowId,
        body: { ...definition }
      }))
    });
  }

  const results: ImportLayerResult[] = [];

  // One call, not three. The layers still go out in dependency order, but the
  // order is now inside the operation rather than in this sequence — see
  // `ImportWritePort`. The existing rows are no longer sent alongside the new
  // ones because a package addresses definitions by id: there is no whole-array
  // envelope left for an untouched row to fall out of.
  if (layerRequest.length > 0) {
    results.push(...packageResults(layerRequest, await deps.publishPackage({ layers: layerRequest })));
    if (results.some((result) => result.ack.status !== 'accepted')) {
      return { outcome: importCommitOutcome(results), results };
    }
  }

  // Independent of the three above (FR-015 rules out a mixed document), so it is
  // neither gated on their success nor required to precede or follow them — a
  // document that declares a Model Catalog declares nothing else. The revision
  // guard already ran above; `modelsRevision` is narrowed non-undefined here by
  // the same half-a-package check.
  if (models.length > 0 && modelsRevision !== undefined) {
    const ack = await deps.saveModels({
      models: modelsDeltaByBackend(models),
      expectedRevision: modelsRevision,
      mutation: { kind: 'import-package' }
    });
    results.push({ key: 'models', ack });
  }

  return { outcome: importCommitOutcome(results), results };
}

// -- Export (T012) ----------------------------------------------------------

export interface ExportProcessDefinitionsInput {
  readonly selection: ExportProcessYamlRequest;
}

export type ExportProcessDefinitionsResult =
  | { readonly outcome: 'serialized'; readonly bytes: Uint8Array }
  | Extract<ExportProcessYamlResult, { outcome: 'unavailable' }>;

/**
 * The document one definition and its declared closure serialize to (FR-009).
 *
 * Reads the **effective** catalog, so what it returns is the definition that
 * actually runs — deliberately the opposite of the presence scan the import path
 * performs. Writes nothing and names nowhere a file would go.
 *
 * The bytes are the UTF-8 encoding of the same text the sidebar's save seam
 * receives. Byte identity with the webview path therefore follows from string
 * identity plus one deterministic encoder per adapter, with no decode round trip
 * anywhere between the serializer and the caller.
 */
export async function exportProcessDefinitions(
  deps: ExchangeDeps,
  input: ExportProcessDefinitionsInput
): Promise<ExportProcessDefinitionsResult | BoundaryRefusal> {
  const refusal = checkExportSelection(input?.selection);
  if (refusal !== null) return refusal;

  const request = input.selection;
  // The 'modelCatalog' arm carries no `resourceId` (contract §3 — exactly one
  // catalog, nothing to identify); the audit envelope still needs a string.
  const resourceId =
    request.resourceKind === 'modelCatalog' ? MODEL_CATALOG_EXPORT_RESOURCE_ID : request.resourceId;
  const selection = selectProcessExportDocument(deps, request);
  if (selection.outcome === 'unavailable') {
    await appendExportAudit(deps, {
      resourceKind: request.resourceKind,
      resourceId,
      outcome: 'unavailable'
    });
    return { ...selection };
  }

  await appendExportAudit(deps, {
    resourceKind: request.resourceKind,
    resourceId,
    outcome: 'saved',
    ...(selection.includedPhaseCount !== undefined
      ? { includedPhaseCount: selection.includedPhaseCount }
      : {})
  });
  return { outcome: 'serialized', bytes: new TextEncoder().encode(selection.text) };
}
