// Feature 083 (US1, T030) — host → webview projection of the resolved Workflow
// catalog. Contract:
// `specs/083-workflow-graph-builder/contracts/workflow-catalog-snapshot.md`.
//
// Placed flat beside `pipeline-catalog-projection.ts` rather than under a new
// `projectors/` directory: the ≤300-line sidebar-projector rule in
// `tests/lint/source-loc-budget.test.ts` reads `src/ui/sidebar` non-recursively,
// so a nested module would silently escape the very budget this file respects.
// The definition-shape half lives in `workflow-definition-projector.ts` for the
// same reason.
//
// Every string crossing to the webview is sanitized exactly once (C5) and
// bounded to its declared cap (C7). The projection is derived state only — never
// persisted, never written to a `WorkflowRun`, never audited (C10).

import type { PipelineDefinition } from '../../contracts/pipeline-definitions';
import type { WorkflowCatalogResolution } from '../../contracts/workflow-definitions';
import { deriveWorkflowPorts } from '../../config/workflow-derived-ports';
import type {
  WorkflowCatalogProjection,
  WorkflowCatalogSourceProjection
} from './snapshot';
import {
  CODE_MAX,
  DESCRIPTION_MAX,
  FIELD_MAX,
  ID_MAX,
  MESSAGE_MAX,
  projectWorkflowDefinition,
  projectWorkflowPort,
  text,
  type Sanitize
} from './workflow-definition-projector';

const ERRORS_PER_RECORD_MAX = 20;
const PORTS_PER_RECORD_MAX = 100;

/**
 * Only recognized authored scalars reach the webview. An invalid row has no
 * `definition`, so `display` is the operator's only view of what they typed.
 */
function projectDisplay(
  display: Readonly<Record<string, unknown>>,
  sanitize: Sanitize
): Readonly<Record<string, unknown>> {
  const projected: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(display)) {
    if (typeof value === 'string') {
      projected[field] = text(value, sanitize, field === 'description' ? DESCRIPTION_MAX : 512);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      projected[field] = value;
    }
  }
  return Object.freeze(projected);
}

/**
 * The contract keys a record `${scope}:${workflowId}`. Two rows in one scope may
 * still claim the same id (both are then invalid), so a repeat occurrence gets a
 * positional suffix and the key stays usable as a list key.
 */
function projectionKey(scope: string, workflowId: string, seen: Map<string, number>): string {
  const base = `${scope}:${workflowId}`;
  const occurrence = seen.get(base) ?? 0;
  seen.set(base, occurrence + 1);
  return occurrence === 0 ? base : `${base}:${occurrence}`;
}

export interface WorkflowCatalogProjectionOptions {
  readonly sanitize: Sanitize;
  /**
   * C11 — the same effective Pipeline catalog the graph validator resolved
   * against, so the projected port surface and the recorded defects cannot
   * disagree. A record with no definition derives nothing.
   */
  readonly effectivePipelines: readonly PipelineDefinition[];
}

/** C1–C8: every source row retained, bounded, sanitized once, advisories as warnings. */
export function projectWorkflowCatalog(
  catalog: WorkflowCatalogResolution,
  options: WorkflowCatalogProjectionOptions
): WorkflowCatalogProjection {
  const { sanitize } = options;
  const seenKeys = new Map<string, number>();
  const records: WorkflowCatalogSourceProjection[] = catalog.records.map((record) => {
    const derived = record.definition
      ? deriveWorkflowPorts(record.definition, options.effectivePipelines)
      : { inputs: [], outputs: [] };
    const workflowId = text(record.workflowId, sanitize, ID_MAX);
    return Object.freeze({
      key: projectionKey(record.scope, workflowId, seenKeys),
      workflowId,
      scope: record.scope,
      status: record.status,
      definition: record.definition
        ? projectWorkflowDefinition(record.definition, sanitize)
        : null,
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
      derivedInputs: Object.freeze(
        derived.inputs
          .slice(0, PORTS_PER_RECORD_MAX)
          .map((port) => projectWorkflowPort(port, sanitize))
      ),
      derivedOutputs: Object.freeze(
        derived.outputs
          .slice(0, PORTS_PER_RECORD_MAX)
          .map((port) => projectWorkflowPort(port, sanitize))
      )
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
        code: 'workflow-errors-truncated',
        message: `${truncated} Workflow row${truncated === 1 ? '' : 's'} reported more than ${ERRORS_PER_RECORD_MAX} problems; only the first ${ERRORS_PER_RECORD_MAX} are shown`
      })
    );
  }

  return Object.freeze({
    state: 'ready' as const,
    records: Object.freeze(records),
    effective: Object.freeze(
      catalog.effective.map((definition) => projectWorkflowDefinition(definition, sanitize))
    ),
    revisions: Object.freeze({
      user: catalog.revisions.user,
      workspace: catalog.revisions.workspace
    }),
    warnings: Object.freeze(warnings)
  });
}

/**
 * C9: a whole-catalog resolution failure, not a per-row problem. `records` and
 * `effective` are empty and the cause is sanitized before it reaches the UI.
 */
function workflowCatalogFailureProjection(
  error: unknown,
  sanitize: Sanitize
): WorkflowCatalogProjection {
  return Object.freeze({
    state: 'error' as const,
    records: Object.freeze([]),
    effective: Object.freeze([]),
    revisions: Object.freeze({ user: '', workspace: '' }),
    warnings: Object.freeze([]),
    error: Object.freeze({
      code: 'workflow-catalog-unavailable',
      message: text(
        (error as Error)?.message ?? 'Workflow catalog could not be resolved',
        sanitize,
        MESSAGE_MAX
      )
    })
  });
}

/**
 * The two catalog accessors the composer already holds, named structurally so
 * this module does not depend on the whole projector dependency surface. Both
 * are read inside the guarded block below, so a host whose Pipeline catalog
 * throws reports a Workflow catalog failure rather than failing the snapshot.
 */
export interface WorkflowCatalogSources {
  readonly getWorkflowCatalog?: () => WorkflowCatalogResolution | undefined;
  readonly getPipelineCatalog?: () =>
    | { readonly effective: readonly PipelineDefinition[] }
    | undefined;
}

/**
 * Composer entry point, kept to one call site line: the composer sits under a
 * 300-line budget and T031 is delegation only. A host that has not resolved a
 * catalog yet projects no field at all, while a resolution failure projects
 * `state: 'error'` (C9) rather than dropping the field — the Builder can then
 * explain itself instead of rendering an indefinite loading state.
 */
export function composeWorkflowCatalogProjection(
  sources: WorkflowCatalogSources,
  sanitize: Sanitize,
  onError?: (message: string) => void
): WorkflowCatalogProjection | undefined {
  try {
    const catalog = sources.getWorkflowCatalog?.();
    if (!catalog) return undefined;
    return projectWorkflowCatalog(catalog, {
      sanitize,
      effectivePipelines: sources.getPipelineCatalog?.()?.effective ?? []
    });
  } catch (error) {
    onError?.(`projector: failed to resolve workflow catalog: ${(error as Error).message}`);
    return workflowCatalogFailureProjection(error, sanitize);
  }
}
