// Catalog loading for activation. Extracted from `extension.ts` so the merged
// Phase/Pipeline catalog, its precedence projection, and the loader diagnostics
// have a focused owner alongside the other Stage-2 wiring modules.

import { projectPhasePrecedence, type PhasePrecedenceProjection } from '../config/phase-precedence';
import type { ResolvedPipelineCatalog } from '../config/pipeline-catalog';
import type { PipelineCatalog } from '../config/pipeline-config';
import { loadCatalog, type CatalogConfigReader } from '../config/pipeline-config-loader';
import type { ResolvedPhaseCatalog } from '../config/process-catalog';
import type { SanitizedLogger } from '../lib/logger';

export interface LoadedCatalog {
  readonly catalog: PipelineCatalog;
  readonly phasePrecedence: PhasePrecedenceProjection;
  readonly phaseCatalog: ResolvedPhaseCatalog;
  readonly pipelineCatalog: ResolvedPipelineCatalog;
}

/**
 * Loads the merged catalog and reports loader diagnostics to the debug log.
 * Called once during activation and again on every `schegent.phases` /
 * `schegent.pipelines` configuration change.
 */
export function loadAndReportCatalog(
  reader: CatalogConfigReader,
  logger: Pick<SanitizedLogger, 'debug'>
): LoadedCatalog {
  const result = loadCatalog(reader);
  if (result.errors.length > 0) {
    logger.debug(
      `pipeline-config: ${result.errors.length} error(s) found in schegent.phases/pipelines; falling back to built-in catalog`
    );
    for (const err of result.errors.slice(0, 3)) {
      logger.debug(
        `pipeline-config: ${err.source}${err.id ? `[${err.id}]` : ''}${err.field ? `.${err.field}` : ''}: ${err.message}`
      );
    }
    if (result.errors.length > 3) {
      logger.debug(`pipeline-config: ${result.errors.length - 3} additional error(s) suppressed`);
    }
  }
  for (const w of result.warnings) {
    logger.debug(
      `pipeline-config: ${w.source}${w.id ? `[${w.id}]` : ''}: ${w.message}`
    );
  }
  // Feature 026 — surface the per-phase precedence projection alongside
  // the merged catalog. Computed once per catalog reload; the projector
  // reads it on every snapshot.
  const phasePrecedence = projectPhasePrecedence(
    result.builtInPhases,
    result.userPhases,
    result.workspacePhases
  );
  const { catalog, phaseCatalog, pipelineCatalog } = result;
  return { catalog, phasePrecedence, phaseCatalog, pipelineCatalog };
}
