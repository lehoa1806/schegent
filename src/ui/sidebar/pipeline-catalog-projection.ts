// Feature 082 (US1, T027) — host → webview projection of the resolved Pipeline
// catalog. Contract:
// `specs/082-pipeline-contracts-builder/contracts/pipeline-catalog-snapshot.md`
//
// Extracted from `snapshot-composer.ts` rather than inlined: the composer sits
// under a 300-line budget pinned by `tests/lint/source-loc-budget.test.ts`, and
// this projection is a self-contained responsibility.
//
// Every string crossing to the webview is sanitized exactly once, here (C5), and
// bounded to its declared cap (C7). The projection is derived state only — it is
// never persisted, never written to `WorkflowRun`, and never audited (C10).

import type { ResolvedPipelineCatalog } from '../../config/pipeline-catalog';
import { NO_BUILDER_LIFECYCLE, type BuilderLifecycleLookup } from './builder-lifecycle';
import { DISPLAY_TEXT_MAX, projectAuthoredDisplay } from './display-projection';
import type {
  PipelineDefinition,
  PipelineInputPort,
  PipelineOutputPort
} from '../../contracts/pipeline-definitions';
import type {
  PipelineCatalogProjection,
  PipelineCatalogSourceProjection
} from './snapshot';

const ID_MAX = 64;
/**
 * The record key, which is not an id (T489a). It is `${pipelineId}::${index}`,
 * and `ID_MAX` is the cap for the id alone — a legal 64-character id would fill
 * it exactly and the `::index` that distinguishes two rows sharing one id would
 * be truncated away, keying both records identically in the Builder's `{#each}`.
 * Matches `phase-catalog-projection.ts`, which has always bounded the two apart.
 */
const KEY_MAX = 160;
const NAME_MAX = 80;
const LABEL_MAX = 80;
const DESCRIPTION_MAX = 1024;
const FIELD_MAX = 32;
const CODE_MAX = 64;
const MESSAGE_MAX = 512;
const ERRORS_PER_RECORD_MAX = 20;
const CONSUMERS_PER_RECORD_MAX = 50;

type Sanitize = (value: string) => string;

function text(value: string, sanitize: Sanitize, max: number): string {
  return sanitize(value).slice(0, max);
}

function projectInput(port: PipelineInputPort, sanitize: Sanitize): PipelineInputPort {
  return Object.freeze({
    portId: text(port.portId, sanitize, ID_MAX),
    label: text(port.label, sanitize, LABEL_MAX),
    type: port.type,
    ...(port.required !== undefined ? { required: port.required } : {}),
    ...(port.description !== undefined
      ? { description: text(port.description, sanitize, DESCRIPTION_MAX) }
      : {})
  });
}

function projectOutput(port: PipelineOutputPort, sanitize: Sanitize): PipelineOutputPort {
  return Object.freeze({
    portId: text(port.portId, sanitize, ID_MAX),
    label: text(port.label, sanitize, LABEL_MAX),
    type: port.type,
    ...(port.description !== undefined
      ? { description: text(port.description, sanitize, DESCRIPTION_MAX) }
      : {})
  });
}

/**
 * Bindings carry operator-authored port keys, so every string in them is
 * sanitized too; the numeric positions are host-validated indices and pass
 * through unchanged.
 */
function projectBindings(
  definition: PipelineDefinition,
  sanitize: Sanitize
): PipelineDefinition['bindings'] {
  return Object.freeze(
    definition.bindings.map((binding) =>
      binding.kind === 'output'
        ? Object.freeze({
            kind: 'output' as const,
            phaseIndex: binding.phaseIndex,
            portId: text(binding.portId, sanitize, ID_MAX),
            outputKey: text(binding.outputKey, sanitize, ID_MAX)
          })
        : Object.freeze({
            kind: 'input' as const,
            phaseIndex: binding.phaseIndex,
            inputKey: text(binding.inputKey, sanitize, ID_MAX),
            source: Object.freeze(
              binding.source.from === 'pipeline-input'
                ? {
                    from: 'pipeline-input' as const,
                    portId: text(binding.source.portId, sanitize, ID_MAX)
                  }
                : {
                    from: 'phase-output' as const,
                    phaseIndex: binding.source.phaseIndex,
                    portId: text(binding.source.portId, sanitize, ID_MAX)
                  }
            )
          })
    )
  );
}

function projectExecutionDefaults(
  definition: PipelineDefinition,
  sanitize: Sanitize
): PipelineDefinition['executionDefaults'] {
  const defaults = definition.executionDefaults;
  if (defaults === undefined) return undefined;
  return Object.freeze({
    ...(defaults.runner !== undefined ? { runner: text(defaults.runner, sanitize, ID_MAX) } : {}),
    ...(defaults.model !== undefined ? { model: text(defaults.model, sanitize, 512) } : {}),
    ...(defaults.effort !== undefined ? { effort: defaults.effort } : {}),
    ...(defaults.timeoutSeconds !== undefined ? { timeoutSeconds: defaults.timeoutSeconds } : {})
  });
}

export function projectPipelineDefinition(
  definition: PipelineDefinition,
  sanitize: Sanitize
): PipelineDefinition {
  const executionDefaults = projectExecutionDefaults(definition, sanitize);
  return Object.freeze({
    pipelineId: text(definition.pipelineId, sanitize, ID_MAX),
    name: text(definition.name, sanitize, NAME_MAX),
    ...(definition.description !== undefined
      ? { description: text(definition.description, sanitize, DESCRIPTION_MAX) }
      : {}),
    version: definition.version,
    phaseIds: Object.freeze(definition.phaseIds.map((id) => text(id, sanitize, ID_MAX))),
    inputs: Object.freeze(definition.inputs.map((port) => projectInput(port, sanitize))),
    outputs: Object.freeze(definition.outputs.map((port) => projectOutput(port, sanitize))),
    bindings: projectBindings(definition, sanitize),
    ...(executionDefaults !== undefined ? { executionDefaults } : {}),
    recommendedNext: Object.freeze(
      definition.recommendedNext.map((id) => text(id, sanitize, ID_MAX))
    )
  });
}

/**
 * An invalid row has no `definition`, so `display` is the operator's only view of
 * what they typed — including `phases`, which is what an invalid Pipeline's phase
 * list is repaired from and what blocks deleting the Phases it names.
 */
function projectDisplay(
  display: Readonly<Record<string, unknown>>,
  sanitize: Sanitize
): Readonly<Record<string, unknown>> {
  return projectAuthoredDisplay(display, sanitize, (field) =>
    field === 'description' ? DESCRIPTION_MAX : DISPLAY_TEXT_MAX
  );
}

// Feature 099 (T489a, FR-043) — `projectionKey` stood here, composing
// `${scope}:${pipelineId}` and adding a positional suffix when two rows in one
// scope claimed the same id. The resolver's own `key` is already
// `${pipelineId}::${index}`, which is unique by construction over the one layer
// and needs no de-duplication pass, so the projection carries it through rather
// than composing a second key from a scope that no longer exists.

export interface PipelineCatalogProjectionOptions {
  readonly sanitize: Sanitize;
  /** Effective model ids per runner, used only for the advisory `modelAvailable` cue. */
  readonly availableModels: Readonly<Record<string, readonly string[]>>;
  readonly defaultRunnerKind: string;
  /**
   * FR-002 — Workflow → Pipeline references from `collectWorkflowPipelineRefs`,
   * the same list gate 13 blocks removals against. Omitted by a host that
   * exposes none, which projects no `consumingWorkflowIds` at all.
   */
  readonly workflowRefs?: readonly { readonly workflowId: string; readonly pipelineId: string }[];
  /**
   * Feature 101 (T015) — the lifecycle facts for this kind. Optional so a host
   * with no catalog store wired keeps projecting rows; every record then omits
   * `lifecycle`, which is the truth rather than a filled-in default.
   */
  readonly lifecycle?: BuilderLifecycleLookup;
}

/**
 * `pipelineId` → its consuming Workflow ids, sorted and deduplicated. A
 * reference names an id, so every record sharing that id reports the same
 * consumers — including an invalid one, whose operator is the person most likely
 * to need to know who depends on the id.
 */
function consumersByPipelineId(
  refs: readonly { readonly workflowId: string; readonly pipelineId: string }[],
  sanitize: Sanitize
): Map<string, readonly string[]> {
  const collected = new Map<string, Set<string>>();
  for (const ref of refs) {
    const pipelineId = text(ref.pipelineId, sanitize, ID_MAX);
    const existing = collected.get(pipelineId) ?? new Set<string>();
    existing.add(text(ref.workflowId, sanitize, ID_MAX));
    collected.set(pipelineId, existing);
  }
  const bounded = new Map<string, readonly string[]>();
  for (const [pipelineId, workflowIds] of collected) {
    bounded.set(pipelineId, Object.freeze([...workflowIds].sort().slice(0, CONSUMERS_PER_RECORD_MAX)));
  }
  return bounded;
}

/** C1–C8: every source row retained, bounded, sanitized once, advisories as warnings. */
export function projectPipelineCatalog(
  catalog: ResolvedPipelineCatalog,
  options: PipelineCatalogProjectionOptions
): PipelineCatalogProjection {
  const { sanitize } = options;
  const consumers = consumersByPipelineId(options.workflowRefs ?? [], sanitize);
  const lifecycleOf = options.lifecycle ?? NO_BUILDER_LIFECYCLE;
  const records: PipelineCatalogSourceProjection[] = catalog.records.map((record) => {
    const definition = record.definition
      ? projectPipelineDefinition(record.definition, sanitize)
      : null;
    const runner = definition?.executionDefaults?.runner ?? options.defaultRunnerKind;
    const model = definition?.executionDefaults?.model;
    const pipelineId = text(record.pipelineId, sanitize, ID_MAX);
    const lifecycle = lifecycleOf(record.pipelineId);
    return Object.freeze({
      key: text(record.key, sanitize, KEY_MAX),
      pipelineId,
      status: record.status,
      definition,
      display: projectDisplay(record.display, sanitize),
      errors: Object.freeze(
        record.errors.slice(0, ERRORS_PER_RECORD_MAX).map((error) =>
          Object.freeze({
            field: text(error.field, sanitize, FIELD_MAX),
            code: text(error.code, sanitize, CODE_MAX),
            message: text(error.message, sanitize, MESSAGE_MAX)
          })
        )
      ),
      ...(model !== undefined
        ? { modelAvailable: (options.availableModels[runner] ?? []).includes(model) }
        : {}),
      ...(consumers.has(pipelineId) ? { consumingWorkflowIds: consumers.get(pipelineId) } : {}),
      // Looked up by the record's own id, before sanitizing and capping: the
      // manifest holds the authored id, and a capped one would miss every
      // definition whose id is longer than the display bound.
      ...(lifecycle !== undefined ? { lifecycle } : {})
    });
  });

  const truncated = catalog.records.filter(
    (record) => record.errors.length > ERRORS_PER_RECORD_MAX
  ).length;
  const warnings = catalog.warnings.map((warning) =>
    Object.freeze({
      code: text(warning.code, sanitize, CODE_MAX),
      message: text(warning.message, sanitize, MESSAGE_MAX)
    })
  );
  if (truncated > 0) {
    warnings.push(
      Object.freeze({
        code: 'pipeline-errors-truncated',
        message: `${truncated} Pipeline row${truncated === 1 ? '' : 's'} reported more than ${ERRORS_PER_RECORD_MAX} problems; only the first ${ERRORS_PER_RECORD_MAX} are shown`
      })
    );
  }

  return Object.freeze({
    state: 'ready' as const,
    records: Object.freeze(records),
    effective: Object.freeze(
      catalog.effective.map((definition) => projectPipelineDefinition(definition, sanitize))
    ),
    revision: catalog.revision,
    warnings: Object.freeze(warnings)
  });
}

/**
 * C9: a whole-catalog resolution failure, not a per-row problem. `records` and
 * `effective` are empty and the cause is sanitized before it reaches the UI.
 */
function pipelineCatalogFailureProjection(
  error: unknown,
  sanitize: Sanitize
): PipelineCatalogProjection {
  return Object.freeze({
    state: 'error' as const,
    records: Object.freeze([]),
    effective: Object.freeze([]),
    revision: '',
    warnings: Object.freeze([]),
    error: Object.freeze({
      code: 'pipeline-catalog-unavailable',
      message: text((error as Error)?.message ?? 'Pipeline catalog could not be resolved', sanitize, MESSAGE_MAX)
    })
  });
}

export interface PipelineCatalogComposeOptions extends PipelineCatalogProjectionOptions {
  readonly onError?: (message: string) => void;
}

/**
 * Composer entry point. A host that has not resolved a catalog yet projects no
 * field at all, while a resolution failure projects `state: 'error'` (C9) rather
 * than dropping the field — the editor can then explain itself instead of
 * rendering an indefinite loading state.
 */
export function composePipelineCatalogProjection(
  getPipelineCatalog: (() => ResolvedPipelineCatalog | undefined) | undefined,
  options: PipelineCatalogComposeOptions
): PipelineCatalogProjection | undefined {
  try {
    const catalog = getPipelineCatalog?.();
    return catalog ? projectPipelineCatalog(catalog, options) : undefined;
  } catch (error) {
    options.onError?.(
      `projector: failed to resolve pipeline catalog: ${(error as Error).message}`
    );
    return pipelineCatalogFailureProjection(error, options.sanitize);
  }
}
