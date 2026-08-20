import {
  EMPTY_CATALOG,
  buildCatalog,
  mergeRuntimePolicy,
  validateCatalog,
  type PipelineCatalog,
  type ValidationError,
  type ValidationWarning
} from './pipeline-config';
import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../runner/backend-runner-factory';
import { resolvePhaseCatalog, type ResolvedPhaseCatalog } from './process-catalog';
import { resolvePipelineCatalog, type ResolvedPipelineCatalog } from './pipeline-catalog';
import { storedRows } from '../catalog';
import type { CatalogSnapshot } from '../contracts/catalog-store';

/**
 * The configuration this loader still reads.
 *
 * Feature 099 (T494, FR-054) — `getPhases` and `getPipelines` are gone. Phase and
 * Pipeline definitions come from the store snapshot now, and the two retired
 * definition settings keys are deleted rather than drained: there is no installed base
 * to migrate, so a read-once path would be a migration for nobody that outlives
 * the release it was written for (FR-055).
 *
 * `schegent.models` and `schegent.defaultPipelineId` are **not** retired keys and
 * keep both scopes. Neither is a definition — one names what a Pipeline may
 * select, the other which Pipeline the surfaces open on — so neither belongs in a
 * store of versioned definitions.
 */
export interface CatalogConfigReader {
  getModels(scope: 'user' | 'workspace'): readonly unknown[] | undefined;
  getDefaultPipelineId(scope: 'user' | 'workspace'): string | undefined;
}

export interface LoadCatalogResult {
  readonly catalog: PipelineCatalog;
  readonly errors: readonly ValidationError[];
  readonly warnings: readonly ValidationWarning[];
  readonly defaultPipelineId: string;
  readonly usedFallback: boolean;
  readonly phaseCatalog: ResolvedPhaseCatalog;
  /**
   * Feature 082 — the Pipeline resolution. Retains every source row (including
   * invalid ones) so the Library can render them for repair, and carries the
   * revision the Builder echoes back on save.
   */
  readonly pipelineCatalog: ResolvedPipelineCatalog;
}

const PIPELINE_LIMIT_WARNING_CODES: ReadonlySet<string> = new Set([
  'pipeline-soft-cap',
  'pipeline-phase-soft-cap'
]);

/**
 * Projects the Pipeline resolution onto the legacy warning channel: catalog-level
 * advisories plus one warning per retained field error. Invalid rows never
 * become catalog errors, so a single malformed row cannot discard the catalog
 * (FR-002).
 */
function pipelineResolutionWarnings(
  pipelineCatalog: ResolvedPipelineCatalog
): ValidationWarning[] {
  const warnings: ValidationWarning[] = pipelineCatalog.warnings.map((warning) => ({
    source: PIPELINE_LIMIT_WARNING_CODES.has(warning.code) ? 'limit' : 'pipeline',
    message: warning.message
  }));
  for (const record of pipelineCatalog.records) {
    for (const error of record.errors) {
      warnings.push({ source: 'pipeline', id: record.pipelineId, message: error.message });
    }
  }
  return warnings;
}

/**
 * Feature 096 — exported so `readModelsConfig` (extension.ts) can apply the
 * exact same legacy-array-migration + trim/filter coercion the Pipeline
 * catalog loader already uses, rather than a second copy of this logic.
 */
export function coerceModels(raw: unknown): Record<BackendRunnerKind, readonly string[]> {
  const out: Record<BackendRunnerKind, string[]> = {
    claude: [],
    codex: [],
    agy: []
  };

  if (!raw) return out;

  // Migration for old array format (assumes claude models)
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string' && entry.trim().length > 0) {
        out.claude.push(entry.trim());
      }
    }
    return out;
  }

  // New object format
  if (typeof raw === 'object' && raw !== null) {
    for (const kind of SUPPORTED_BACKENDS) {
      const arr = (raw as Record<string, unknown>)[kind];
      if (Array.isArray(arr)) {
        for (const entry of arr) {
          if (typeof entry === 'string' && entry.trim().length > 0) {
            out[kind].push(entry.trim());
          }
        }
      }
    }
  }

  return out;
}

/**
 * Resolve the Phase and Pipeline catalogs out of one store snapshot.
 *
 * Feature 099 (T489/T494, FR-027a, FR-042) — was `loadCatalog(reader?)`, which
 * read six configuration values and resolved three layers. The snapshot is read
 * once, asynchronously, by the wiring (`activation/catalog-store-wiring.ts`) and
 * handed here already in memory, which is what lets this function and both
 * resolvers keep their synchronous signatures.
 *
 * An absent store is an empty snapshot, not a failure (FR-001a): the honest
 * catalog for a workspace nobody has saved into is the empty one, and with no
 * Pipelines there is no default to name. That is the same answer the `!reader`
 * branch used to give, now reached by the store being empty rather than by a
 * missing reader.
 */
export function loadCatalog(
  snapshot: CatalogSnapshot,
  reader?: CatalogConfigReader
): LoadCatalogResult {
  const phaseCatalog = resolvePhaseCatalog({
    rows: storedRows(snapshot, 'phase'),
    revision: snapshot.revisions.phase
  });
  // Pipeline bindings and Phase references resolve against the effective Phase
  // catalog, so the Phase catalog must be resolved first (FR-011).
  const pipelineCatalog = resolvePipelineCatalog({
    rows: storedRows(snapshot, 'pipeline'),
    revision: snapshot.revisions.pipeline,
    phaseCatalog: phaseCatalog.effective
  });

  const phaseWarnings: ValidationWarning[] = phaseCatalog.warnings.map((warning) => ({
    source: warning.code === 'phase-soft-cap' ? 'limit' : 'phase',
    message: warning.message
  }));
  for (const record of phaseCatalog.records) {
    for (const error of record.errors) {
      phaseWarnings.push({ source: 'phase', id: record.phaseId, message: error.message });
    }
  }

  // A missing reader is read as a reader supplying nothing, rather than as its own
  // branch. It used to be one because it answered with a constant catalog — there
  // were no definitions without a reader to hold them. There are: they came out of
  // the store above, before this line, and all the reader still decides is which
  // models a Pipeline may select and which Pipeline the surfaces open on. Its
  // absence must move those two answers and nothing else, and a second return path
  // is how it would come to move a third — the branch this replaces returned
  // `errors: []` without validating the catalog at all.
  const policy = mergeRuntimePolicy(
    {
      models: coerceModels(reader?.getModels('user')),
      defaultPipelineId: reader?.getDefaultPipelineId('user')
    },
    {
      models: coerceModels(reader?.getModels('workspace')),
      defaultPipelineId: reader?.getDefaultPipelineId('workspace')
    }
  );

  const merged = buildCatalog(
    phaseCatalog.effectivePhaseDefs,
    pipelineCatalog.effectivePipelineDefs,
    policy.models,
    policy.defaultPipelineId
  );
  const report = validateCatalog(merged);
  const allWarnings = [
    ...phaseWarnings,
    ...pipelineResolutionWarnings(pipelineCatalog),
    ...report.warnings
  ];

  // Feature 098 (T028, US3, FR-026) — a whole-catalog validation failure used to
  // fall back to `BUILT_IN_PIPELINES` under `BUILT_IN_PIPELINE_ID`, so a host whose
  // settings did not validate came up offering Pipelines the operator had not
  // configured, with the errors reported alongside. The errors are still reported;
  // what is no longer reported is a substituted set to execute in the meantime.
  //
  // Reachability, recorded because it bears on how this is tested: nothing driving
  // `loadCatalog` can reach this branch today. `resolvePhaseCatalog` and
  // `resolvePipelineCatalog` quarantine per row *before* `validateCatalog` sees the
  // catalog, so `report.errors` is empty for every input — six adversarial readers
  // (a Pipeline naming an unknown Phase, an empty phase list, an out-of-range
  // timeout, an id with spaces, a default naming nothing, a duplicated Phase) each
  // produced `errors: []`. The branch is kept and corrected rather than deleted:
  // `validateCatalog` is a separate oracle whose reachability is a property of
  // upstream quarantine, and a substituting fallback sitting behind it would be a
  // live defect the moment that changes.
  if (report.errors.length > 0) {
    return {
      catalog: EMPTY_CATALOG,
      errors: report.errors,
      warnings: allWarnings,
      defaultPipelineId: '',
      usedFallback: true,
      phaseCatalog,
      pipelineCatalog
    };
  }

  // Feature 098 (T027/T028, FR-027, FR-033) — a configured default that names no
  // effective Pipeline re-anchored to `BUILT_IN_PIPELINE_ID`, which is the same
  // substitution the branch above just lost, applied to the default rather than to
  // the catalog. `''` means "no default" throughout.
  const defaultNamesAPipeline = merged.pipelines.some((p) => p.id === merged.defaultPipelineId);
  const resolvedDefaultId = defaultNamesAPipeline ? merged.defaultPipelineId : '';

  return {
    catalog: defaultNamesAPipeline
      ? merged
      : buildCatalog(merged.phases, merged.pipelines, merged.models, ''),
    errors: [],
    warnings: allWarnings,
    defaultPipelineId: resolvedDefaultId,
    usedFallback: false,
    phaseCatalog,
    pipelineCatalog
  };
}
