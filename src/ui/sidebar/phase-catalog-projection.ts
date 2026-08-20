// Feature 092 (T095) — host → webview projection of the resolved Phase catalog.
//
// Extracted from `snapshot-composer.ts`, not newly written: the composition and
// its three text helpers moved here verbatim. The composer sits under a physical
// LOC budget pinned by `tests/lint/source-loc-budget.test.ts`, and this
// projection was the one catalog still composed inline — its two siblings,
// `pipeline-catalog-projection.ts` and `workflow-catalog-projector.ts`, already
// own their own modules, so this is the shape the directory was converging on.
//
// Every string crossing to the webview is sanitized exactly once, here, and
// bounded to its declared cap. The projection is derived state only: never
// persisted, never written to `WorkflowRun`, never audited.

import type { PhaseDefinition } from '../../contracts/process-definitions';
import type { BackendRunnerKind } from '../../runner/backend-runner-factory';
import type { ResolvedPhaseCatalog } from '../../config/process-catalog';
import { NO_BUILDER_LIFECYCLE, type BuilderLifecycleLookup } from './builder-lifecycle';
import type { PhaseCatalogProjection } from './snapshot';

type Sanitize = (value: string) => string;

const KEY_MAX = 160;
const PHASE_ID_MAX = 64;
const NAME_MAX = 80;
const FIELD_MAX = 32;
const CODE_MAX = 64;
const MESSAGE_MAX = 512;
const MODEL_MAX = 512;
const DESCRIPTION_MAX = 1024;
const SKILL_MAX = 256;
const INSTRUCTION_MAX = 8192;

export interface PhaseCatalogComposeOptions {
  readonly sanitize: Sanitize;
  readonly availableModels: Record<BackendRunnerKind, readonly string[]>;
  readonly defaultRunnerKind: BackendRunnerKind;
  /**
   * Feature 101 (T014) — the lifecycle facts for this kind. Optional so a host
   * with no catalog store wired keeps projecting rows; every record then omits
   * `lifecycle`, which is the truth rather than a filled-in default.
   */
  readonly lifecycle?: BuilderLifecycleLookup;
}

function catalogText(value: string, sanitize: Sanitize, max: number): string {
  return sanitize(value).slice(0, max);
}

function projectPhaseDefinition(
  definition: PhaseDefinition,
  sanitize: Sanitize
): PhaseDefinition {
  const common = {
    phaseId: catalogText(definition.phaseId, sanitize, PHASE_ID_MAX),
    name: catalogText(definition.name, sanitize, NAME_MAX),
    version: definition.version,
    ...(definition.description !== undefined
      ? { description: catalogText(definition.description, sanitize, DESCRIPTION_MAX) }
      : {}),
    ...(definition.model !== undefined
      ? { model: catalogText(definition.model, sanitize, MODEL_MAX) }
      : {}),
    ...(definition.effort !== undefined ? { effort: definition.effort } : {}),
    ...(definition.timeoutSeconds !== undefined
      ? { timeoutSeconds: definition.timeoutSeconds }
      : {}),
    ...(definition.loopable !== undefined ? { loopable: definition.loopable } : {}),
    // Inert text on this path: the retry-condition grammar is owned by the
    // sandboxed DSL evaluator, and this projection neither parses nor inspects it.
    ...(definition.retryCondition !== undefined
      ? { retryCondition: catalogText(definition.retryCondition, sanitize, INSTRUCTION_MAX) }
      : {}),
    ...(definition.isRequired !== undefined ? { isRequired: definition.isRequired } : {}),
    ...(definition.runner !== undefined ? { runner: definition.runner } : {})
  };
  return Object.freeze(
    definition.instruction !== undefined
      ? { ...common, instruction: catalogText(definition.instruction, sanitize, INSTRUCTION_MAX) }
      : { ...common, skill: catalogText(definition.skill, sanitize, SKILL_MAX) }
  );
}

function projectDisplay(
  display: Readonly<Record<string, unknown>>,
  sanitize: Sanitize
): Readonly<Record<string, unknown>> {
  const projected: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(display)) {
    if (typeof value === 'string') {
      const max = field === 'instruction' || field === 'retryCondition'
        ? INSTRUCTION_MAX
        : field === 'description'
          ? DESCRIPTION_MAX
          : field === 'skill'
            ? SKILL_MAX
            : MODEL_MAX;
      projected[field] = catalogText(value, sanitize, max);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      projected[field] = value;
    }
  }
  return Object.freeze(projected);
}

/** Projects the resolved Phase catalog, or `undefined` when the host has none. */
export function composePhaseCatalogProjection(
  phaseCatalog: ResolvedPhaseCatalog | undefined,
  options: PhaseCatalogComposeOptions
): PhaseCatalogProjection | undefined {
  if (!phaseCatalog) return undefined;
  const { sanitize, availableModels, defaultRunnerKind } = options;
  const lifecycleOf = options.lifecycle ?? NO_BUILDER_LIFECYCLE;
  return Object.freeze({
    state: 'ready' as const,
    records: Object.freeze(phaseCatalog.records.map((record) => {
      const definition = record.definition
        ? projectPhaseDefinition(record.definition, sanitize)
        : null;
      const runner = definition?.runner ?? defaultRunnerKind;
      // Keyed by the record's own `phaseId`, not by its `key`: the key carries a
      // positional suffix for the Library's repair affordance, and the manifest
      // knows a definition only by its id.
      const lifecycle = lifecycleOf(record.phaseId);
      return Object.freeze({
        key: catalogText(record.key, sanitize, KEY_MAX),
        phaseId: catalogText(record.phaseId, sanitize, PHASE_ID_MAX),
        status: record.status,
        definition,
        display: projectDisplay(record.display, sanitize),
        errors: Object.freeze(record.errors.map((error) => Object.freeze({
          field: catalogText(error.field, sanitize, FIELD_MAX),
          code: catalogText(error.code, sanitize, CODE_MAX),
          message: catalogText(error.message, sanitize, MESSAGE_MAX)
        }))),
        ...(definition?.model !== undefined
          ? { modelAvailable: (availableModels[runner] ?? []).includes(definition.model) }
          : {}),
        ...(lifecycle !== undefined ? { lifecycle } : {})
      });
    })),
    effective: Object.freeze(
      phaseCatalog.effective.map((definition) => projectPhaseDefinition(definition, sanitize))
    ),
    revision: phaseCatalog.revision,
    warnings: Object.freeze(phaseCatalog.warnings.map((warning) => Object.freeze({
      code: catalogText(warning.code, sanitize, CODE_MAX),
      message: catalogText(warning.message, sanitize, MESSAGE_MAX)
    })))
  });
}
