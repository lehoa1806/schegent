import {
  BUILT_IN_CATALOG,
  BUILT_IN_PHASES,
  BUILT_IN_PIPELINES,
  BUILT_IN_PIPELINE_ID,
  buildCatalog,
  mergeCatalog,
  validateCatalog,
  type PhaseDef,
  type PipelineCatalog,
  type ValidationError,
  type ValidationWarning
} from './pipeline-config';
import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../runner/backend-runner-factory';
import {
  phaseDefinitionToPhaseDef,
  resolvePhaseCatalog,
  type ResolvedPhaseCatalog
} from './process-catalog';
import { resolvePipelineCatalog, type ResolvedPipelineCatalog } from './pipeline-catalog';

export interface CatalogConfigReader {
  getPhases(scope: 'user' | 'workspace'): readonly unknown[] | undefined;
  getPipelines(scope: 'user' | 'workspace'): readonly unknown[] | undefined;
  getModels(scope: 'user' | 'workspace'): readonly unknown[] | undefined;
  getDefaultPipelineId(scope: 'user' | 'workspace'): string | undefined;
}

export interface LoadCatalogResult {
  readonly catalog: PipelineCatalog;
  readonly errors: readonly ValidationError[];
  readonly warnings: readonly ValidationWarning[];
  readonly defaultPipelineId: string;
  readonly usedFallback: boolean;
  /**
   * Feature 026 — per-layer phase arrays surfaced for downstream
   * precedence projection. The state projector consumes these to compute
   * the UI-only `phasePrecedence` map; nothing else should depend on
   * the per-layer split (catalog consumers should read the merged
   * `catalog.phases`).
   */
  readonly builtInPhases: readonly PhaseDef[];
  readonly userPhases: readonly PhaseDef[];
  readonly workspacePhases: readonly PhaseDef[];
  readonly phaseCatalog: ResolvedPhaseCatalog;
  /**
   * Feature 082 — the layered Pipeline resolution. Retains every source row
   * (including invalid ones) so the Library can render them for repair, and
   * carries the per-scope revisions the Builder echoes back on save.
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
 * become catalog errors, so a single malformed row cannot discard the layer
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

function coerceModels(raw: unknown): Record<BackendRunnerKind, readonly string[]> {
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

export function loadCatalog(reader?: CatalogConfigReader): LoadCatalogResult {
  const builtInPhaseCatalog = resolvePhaseCatalog({
    builtIn: BUILT_IN_PHASES,
    user: [],
    workspace: []
  });
  if (!reader) {
    return {
      catalog: BUILT_IN_CATALOG,
      errors: [],
      warnings: [],
      defaultPipelineId: BUILT_IN_PIPELINE_ID,
      usedFallback: false,
      builtInPhases: BUILT_IN_PHASES,
      userPhases: [],
      workspacePhases: [],
      phaseCatalog: builtInPhaseCatalog,
      pipelineCatalog: resolvePipelineCatalog({
        builtIn: BUILT_IN_PIPELINES,
        user: [],
        workspace: [],
        phaseCatalog: builtInPhaseCatalog.effective
      })
    };
  }

  const userPhasesRaw = reader.getPhases('user');
  const userPipelinesRaw = reader.getPipelines('user');
  const userModelsRaw = reader.getModels('user');
  const userDefault = reader.getDefaultPipelineId('user');

  const workspacePhasesRaw = reader.getPhases('workspace');
  const workspacePipelinesRaw = reader.getPipelines('workspace');
  const workspaceModelsRaw = reader.getModels('workspace');
  const workspaceDefault = reader.getDefaultPipelineId('workspace');

  const userModels = coerceModels(userModelsRaw);
  const workspaceModels = coerceModels(workspaceModelsRaw);
  const phaseCatalog = resolvePhaseCatalog({
    builtIn: BUILT_IN_PHASES,
    user: userPhasesRaw,
    workspace: workspacePhasesRaw
  });
  // Pipeline bindings and Phase references resolve against the effective Phase
  // catalog, so the Phase layer must be resolved first (FR-011).
  const pipelineCatalog = resolvePipelineCatalog({
    builtIn: BUILT_IN_PIPELINES,
    user: userPipelinesRaw,
    workspace: workspacePipelinesRaw,
    phaseCatalog: phaseCatalog.effective
  });
  const builtInById = new Map(BUILT_IN_PHASES.map((phase) => [phase.id, phase]));
  const userPhases = phaseCatalog.records
    .filter((record) => record.scope === 'user' && record.definition !== null)
    .map((record) => phaseDefinitionToPhaseDef(record.definition!, 'user', builtInById));
  const workspacePhases = phaseCatalog.records
    .filter((record) => record.scope === 'workspace' && record.definition !== null)
    .map((record) => phaseDefinitionToPhaseDef(record.definition!, 'workspace', builtInById));

  // Pipelines arrive already resolved and validated per row, so they enter the
  // merge as a single settled layer; only models and defaultPipelineId still
  // merge across scopes here.
  const merge = mergeCatalog(
    {
      phases: phaseCatalog.effectivePhaseDefs,
      pipelines: pipelineCatalog.effectivePipelineDefs,
      models: [],
      defaultPipelineId: BUILT_IN_PIPELINE_ID
    },
    { pipelines: [], models: userModels, defaultPipelineId: userDefault },
    { pipelines: [], models: workspaceModels, defaultPipelineId: workspaceDefault }
  );

  const report = validateCatalog(merge.catalog);
  const phaseWarnings: ValidationWarning[] = phaseCatalog.warnings.map((warning) => ({
    source: warning.code === 'phase-soft-cap' ? 'limit' : 'phase',
    message: warning.message
  }));
  for (const record of phaseCatalog.records) {
    for (const error of record.errors) {
      phaseWarnings.push({ source: 'phase', id: record.phaseId, message: error.message });
    }
  }
  const allWarnings = [
    ...phaseWarnings,
    ...pipelineResolutionWarnings(pipelineCatalog),
    ...merge.duplicateWarnings,
    ...report.warnings
  ];

  if (report.errors.length > 0) {
    const fallbackCatalog = buildCatalog(
      phaseCatalog.effectivePhaseDefs,
      BUILT_IN_PIPELINES,
      merge.catalog.models,
      BUILT_IN_PIPELINE_ID
    );
    return {
      catalog: fallbackCatalog,
      errors: report.errors,
      warnings: allWarnings,
      defaultPipelineId: BUILT_IN_PIPELINE_ID,
      usedFallback: true,
      builtInPhases: BUILT_IN_PHASES,
      userPhases,
      workspacePhases,
      phaseCatalog,
      pipelineCatalog
    };
  }

  let resolvedDefaultId = merge.catalog.defaultPipelineId;
  if (!merge.catalog.pipelines.some((p) => p.id === resolvedDefaultId)) {
    resolvedDefaultId = BUILT_IN_PIPELINE_ID;
  }

  const catalog = buildCatalog(
    merge.catalog.phases,
    merge.catalog.pipelines,
    merge.catalog.models,
    resolvedDefaultId
  );

  return {
    catalog,
    errors: [],
    warnings: allWarnings,
    defaultPipelineId: resolvedDefaultId,
    usedFallback: false,
    builtInPhases: BUILT_IN_PHASES,
    userPhases,
    workspacePhases,
    phaseCatalog,
    pipelineCatalog
  };
}
