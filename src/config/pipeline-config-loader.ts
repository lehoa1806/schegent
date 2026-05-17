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
  type PipelineDef,
  type ValidationError,
  type ValidationWarning
} from './pipeline-config';
import { validate as validateRetryCondition } from '../lib/retry-condition';

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
}

function coercePhase(raw: unknown, warnings: ValidationWarning[]): PhaseDef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== 'string') return null;
  if (typeof v.name !== 'string') return null;
  if (typeof v.instruction !== 'string') return null;
  if (typeof v.loopable !== 'boolean') return null;

  // Feature 010 — FR-014: validate retryCondition at load time; on parse
  // failure strip the field, keep the PhaseDef, surface ONE warning naming
  // the offending phase id, and never block activation.
  let retryCondition: string | undefined;
  if (typeof v.retryCondition === 'string' && v.retryCondition.trim().length > 0) {
    const result = validateRetryCondition(v.retryCondition);
    if (result.ok) {
      retryCondition = v.retryCondition;
    } else {
      warnings.push({
        source: 'phase',
        id: v.id,
        message: `retryCondition rejected: ${result.error}`
      });
    }
  }

  const def: PhaseDef = {
    id: v.id,
    name: v.name,
    instruction: v.instruction,
    loopable: v.loopable,
    ...(typeof v.model === 'string' && v.model.length > 0 ? { model: v.model } : {}),
    ...(typeof v.effort === 'string' ? { effort: v.effort as PhaseDef['effort'] } : {}),
    ...(typeof v.timeoutSeconds === 'number' ? { timeoutSeconds: v.timeoutSeconds } : {}),
    ...(retryCondition !== undefined ? { retryCondition } : {})
  };
  return def;
}

function coercePipeline(raw: unknown): PipelineDef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== 'string') return null;
  if (typeof v.name !== 'string') return null;
  if (!Array.isArray(v.phases)) return null;
  const phaseIds: string[] = [];
  for (const ref of v.phases) {
    if (typeof ref !== 'string') return null;
    phaseIds.push(ref);
  }
  return { id: v.id, name: v.name, phases: phaseIds };
}

function coercePhases(
  raw: readonly unknown[] | undefined,
  warnings: ValidationWarning[]
): readonly PhaseDef[] {
  if (!raw) return [];
  const out: PhaseDef[] = [];
  for (const entry of raw) {
    const phase = coercePhase(entry, warnings);
    if (phase) out.push(phase);
  }
  return out;
}

function coercePipelines(raw: readonly unknown[] | undefined): readonly PipelineDef[] {
  if (!raw) return [];
  const out: PipelineDef[] = [];
  for (const entry of raw) {
    const pipeline = coercePipeline(entry);
    if (pipeline) out.push(pipeline);
  }
  return out;
}

function coerceModels(raw: readonly unknown[] | undefined): readonly string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      out.push(entry.trim());
    }
  }
  return out;
}

export function loadCatalog(reader?: CatalogConfigReader): LoadCatalogResult {
  if (!reader) {
    return {
      catalog: BUILT_IN_CATALOG,
      errors: [],
      warnings: [],
      defaultPipelineId: BUILT_IN_PIPELINE_ID,
      usedFallback: false,
      builtInPhases: BUILT_IN_PHASES,
      userPhases: [],
      workspacePhases: []
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

  const retryWarnings: ValidationWarning[] = [];
  const userPhases = coercePhases(userPhasesRaw, retryWarnings);
  const userPipelines = coercePipelines(userPipelinesRaw);
  const userModels = coerceModels(userModelsRaw);
  const workspacePhases = coercePhases(workspacePhasesRaw, retryWarnings);
  const workspacePipelines = coercePipelines(workspacePipelinesRaw);
  const workspaceModels = coerceModels(workspaceModelsRaw);

  const merge = mergeCatalog(
    { phases: BUILT_IN_PHASES, pipelines: BUILT_IN_PIPELINES, models: [], defaultPipelineId: BUILT_IN_PIPELINE_ID },
    { phases: userPhases, pipelines: userPipelines, models: userModels, defaultPipelineId: userDefault },
    { phases: workspacePhases, pipelines: workspacePipelines, models: workspaceModels, defaultPipelineId: workspaceDefault }
  );

  const report = validateCatalog(merge.catalog);
  const allWarnings = [...retryWarnings, ...merge.duplicateWarnings, ...report.warnings];

  if (report.errors.length > 0) {
    return {
      catalog: BUILT_IN_CATALOG,
      errors: report.errors,
      warnings: allWarnings,
      defaultPipelineId: BUILT_IN_PIPELINE_ID,
      usedFallback: true,
      builtInPhases: BUILT_IN_PHASES,
      userPhases,
      workspacePhases
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
    workspacePhases
  };
}
