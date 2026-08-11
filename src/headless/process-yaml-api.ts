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
  SavePhasesCommand,
  SavePipelinesCommand,
  SaveWorkflowsCommand
} from '../contracts/sidebar-ipc/catalog-save';
import type {
  ExportProcessYamlRequest,
  ExportProcessYamlResult,
  PreflightProcessYamlResult
} from '../contracts/sidebar-ipc/process-yaml';
import type { WritablePhaseDefinitionScope } from '../contracts/process-definitions';
import {
  appendExportAudit,
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
 * The three writes, injected.
 *
 * Injected rather than called directly because each one IS the existing
 * `CMD_SAVE_*` handler: the revision gate, the trust gate in that fixed order,
 * the intent algebra, and the audit envelope all stay where they are, and this
 * module adds none of them (R6). What it owns is the order the three are sent in
 * and what to say when one of them refuses.
 */
export interface ImportWritePort {
  savePhases(payload: SavePhasesCommand['payload']): Promise<LayerSaveAck>;
  savePipelines(payload: SavePipelinesCommand['payload']): Promise<LayerSaveAck>;
  saveWorkflows(payload: SaveWorkflowsCommand['payload']): Promise<LayerSaveAck>;
}

/** The stored rows of each catalog the import appends to, for the target scope. */
export interface ImportTargetLayers {
  readonly phases: readonly unknown[];
  readonly pipelines: readonly unknown[];
  readonly workflows: readonly unknown[];
}

export interface ImportProcessDocumentInput {
  /**
   * The plan the caller accepted. It IS the confirmation: a caller that did not
   * accept it does not pass it, and the revisions each write gates on are read
   * from it rather than taken as a separate argument — see `layerRevisions`.
   */
  readonly plan: ImportPlan;
  readonly scope: WritablePhaseDefinitionScope;
  readonly layers: ImportTargetLayers;
}

export type ImportLayerKey = 'phases' | 'pipelines' | 'workflows';

/** The layer keys in write order — the one place this module states the order. */
export const IMPORT_LAYER_ORDER: readonly ImportLayerKey[] = ['phases', 'pipelines', 'workflows'];

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
 * its OWN expected revision — the one the PLAN was computed against for the
 * chosen scope, taken from the plan and never read live, because a revision read
 * at the moment of the write leaves the staleness gate unable to fire (FR-040).
 * Each carries exactly one `import-package` intent naming that layer's target
 * set; a document supplying fewer layers writes fewer times and never merges two
 * layers into one intent.
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
  const { plan, scope, layers } = input;
  const phases = importRows(plan, 'phase');
  const pipelines = importRows(plan, 'pipeline');
  const workflows = importRows(plan, 'workflow');
  const pipelineRevisions = plan.computedAgainstPipelineRevision;
  const workflowRevisions = plan.computedAgainstWorkflowRevision;

  // Half a package is the one outcome no requirement admits. A plan that carries
  // rows for a layer but no revision to gate that layer's write cannot be applied
  // at all, so nothing is sent — not the layers it happens to have a gate for.
  if (pipelines.length > 0 && pipelineRevisions === undefined) {
    return { outcome: 'failed', results: [] };
  }
  if (workflows.length > 0 && workflowRevisions === undefined) {
    return { outcome: 'failed', results: [] };
  }

  const results: ImportLayerResult[] = [];

  // Awaited in sequence deliberately: each write is conditional on the one before
  // it. Issuing them together would send the Pipeline before its Phases exist and
  // the Workflow before its Pipelines do.
  if (phases.length > 0) {
    // `import` only for the single-Phase standalone document, `import-package`
    // for everything else — the same rule the sidebar applies, because the host
    // returns different legal actions per intent on a `stale-catalog` rejection
    // and relabelling one path would change an operator's recovery affordances.
    const standalone = phases.length === 1 && pipelines.length === 0 && workflows.length === 0;
    const ack = await deps.savePhases({
      scope,
      expectedRevision: plan.computedAgainstRevision[scope],
      mutation: standalone
        ? { kind: 'import', phaseId: phases[0].resourceId }
        : { kind: 'import-package', phaseIds: phases.map((row) => row.resourceId) },
      phases: [
        ...layers.phases,
        ...phases.map(({ definition }) => {
          const { phaseId, ...declared } = definition;
          return { id: phaseId, ...declared };
        })
      ]
    });
    results.push({ key: 'phases', ack });
    if (ack.status !== 'accepted') return { outcome: importCommitOutcome(results), results };
  }

  if (pipelines.length > 0 && pipelineRevisions !== undefined) {
    const ack = await deps.savePipelines({
      scope,
      expectedRevision: pipelineRevisions[scope],
      mutation: { kind: 'import-package', pipelineIds: pipelines.map((row) => row.resourceId) },
      pipelines: [
        ...layers.pipelines,
        ...pipelines.map(({ definition }) => {
          const { pipelineId, phaseIds, ...declared } = definition;
          return { id: pipelineId, phases: [...phaseIds], ...declared };
        })
      ]
    });
    results.push({ key: 'pipelines', ack });
    if (ack.status !== 'accepted') return { outcome: importCommitOutcome(results), results };
  }

  if (workflows.length > 0 && workflowRevisions !== undefined) {
    const ack = await deps.saveWorkflows({
      scope,
      expectedRevision: workflowRevisions[scope],
      mutation: { kind: 'import-package', workflowIds: workflows.map((row) => row.resourceId) },
      // Carried as declared: a rewritten connection or a reordered node list is
      // precisely the lossy round trip FR-046a forbids.
      workflows: [...layers.workflows, ...workflows.map(({ definition }) => ({ ...definition }))]
    });
    results.push({ key: 'workflows', ack });
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
  const selection = selectProcessExportDocument(deps, request);
  if (selection.outcome === 'unavailable') {
    await appendExportAudit(deps, {
      resourceKind: request.resourceKind,
      resourceId: request.resourceId,
      scope: null,
      outcome: 'unavailable'
    });
    return { ...selection };
  }

  await appendExportAudit(deps, {
    resourceKind: request.resourceKind,
    resourceId: request.resourceId,
    scope: selection.scope,
    outcome: 'saved',
    ...(selection.includedPhaseCount !== undefined
      ? { includedPhaseCount: selection.includedPhaseCount }
      : {})
  });
  return { outcome: 'serialized', bytes: new TextEncoder().encode(selection.text) };
}
