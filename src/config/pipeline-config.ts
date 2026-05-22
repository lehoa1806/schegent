export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export interface PhaseDef {
  readonly id: string;
  readonly name: string;
  readonly instruction: string;
  readonly model?: string;
  readonly effort?: Effort;
  readonly timeoutSeconds?: number;
  // Feature 010 — when set and the phase invocation produces a well-formed
  // audit-log block, the controller evaluates this DSL expression against the
  // entry's metrics map to decide loop-vs-advance. Captured in the
  // WorkflowRun.pipeline snapshot so mid-run settings edits cannot retarget it
  // (preserved 009 FR-013).
  readonly retryCondition?: string;
}

export interface PipelineDef {
  readonly id: string;
  readonly name: string;
  readonly phases: readonly string[];
}

export interface PipelineCatalog {
  readonly phases: readonly PhaseDef[];
  readonly pipelines: readonly PipelineDef[];
  readonly models: readonly string[];
  readonly defaultPipelineId: string;
  readonly phasesById: ReadonlyMap<string, PhaseDef>;
  readonly pipelinesById: ReadonlyMap<string, PipelineDef>;
}

export interface ValidationError {
  readonly source: 'phase' | 'pipeline' | 'defaultPipelineId';
  readonly id?: string;
  readonly field?: string;
  readonly message: string;
}

export interface ValidationWarning {
  readonly source: 'phase' | 'pipeline' | 'limit';
  readonly id?: string;
  readonly message: string;
}

export interface ValidationReport {
  readonly errors: readonly ValidationError[];
  readonly warnings: readonly ValidationWarning[];
}

export const BUILT_IN_PHASE_IDS = [
  'speckit-specify',
  'speckit-clarify',
  'speckit-plan',
  'speckit-tasks',
  'speckit-analyze',
  'speckit-implement',
  'finalize',
  'done',
  'bugfix-report',
  'bugfix-patch',
  'bugfix-verify-pre',
  'bugfix-implement',
  'bugfix-verify-post'
] as const;

export const PHASE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const ID_MAX_LEN = 64;
export const NAME_MAX_LEN = 80;
export const INSTRUCTION_MAX_LEN = 8192;
export const TIMEOUT_MIN = 1;
export const TIMEOUT_MAX = 3600;
export const SOFT_CAP_PHASES = 50;
export const SOFT_CAP_PIPELINES = 20;
export const SOFT_CAP_PIPELINE_PHASES = 50;

export const PHASE_INSTRUCTIONS: Readonly<Record<string, string>> = {
  'speckit-specify': 'Run /speckit-specify with the feature description below. Produce specs/<NNN-name>/spec.md.',
  'speckit-clarify':
    'Run /speckit-clarify on the active feature spec. Resolve ambiguities. Emit the termination token only when no critical ambiguities remain. Inside the SCHEGENT AUDIT LOG block emit `open_questions: <N>` and `resolved_questions: <N>` as top-level integer metric lines so the controller can observe progress. IMPORTANT: place these metric lines at the top level — never indented under and never immediately after a sub-block heading (`Notes:`, `Findings:`, `Open Questions:`, `Remaining Issues:`) unless a blank line separates them. If you use any sub-block heading, insert a blank line before the next top-level metric line.',
  'speckit-plan': 'Run /speckit-plan on the active feature. Produce plan.md, research.md, data-model.md, contracts/, and quickstart.md.',
  'speckit-tasks': 'Run /speckit-tasks on the active feature. Produce tasks.md.',
  'speckit-analyze':
    'Run /speckit-analyze on the active feature. Apply remediation. Emit the termination token only when no CRITICAL and HIGH issues remain.',
  'speckit-implement': 'Run /speckit-implement on the active feature.',
  finalize:
    'Verify the implementation: run build/typecheck/test commands, summarize results, and emit the termination token if all pass.',
  done: '(no-op)',
  'bugfix-report':
    'Run /speckit-bugfix-report on the active feature. Capture the operator-reported bug and trace it across spec.md, plan.md, and tasks.md. Emit the termination token only when the report is complete.',
  'bugfix-patch':
    'Run /speckit-bugfix-patch on the active feature. Apply surgical patches to spec.md, plan.md, and tasks.md so the recorded bug has matching artifact updates. Emit the termination token when the patch is applied.',
  'bugfix-verify-pre':
    'Run /speckit-bugfix-verify on the active feature. Verify cross-artifact consistency BEFORE implementation begins. Emit the termination token only when no CRITICAL issues remain.',
  'bugfix-implement': 'Run /speckit-implement on the active feature using the patched tasks.',
  'bugfix-verify-post':
    'Run /speckit-bugfix-verify on the active feature. Verify cross-artifact consistency AFTER implementation completes. Emit the termination token only when no CRITICAL issues remain.'
};

export const BUILT_IN_PHASES: readonly PhaseDef[] = Object.freeze([
  Object.freeze({
    id: 'speckit-specify',
    name: 'Spec-kit Specify',
    instruction: PHASE_INSTRUCTIONS['speckit-specify']
  }),
  Object.freeze({
    id: 'speckit-clarify',
    name: 'Spec-kit Clarify',
    instruction: PHASE_INSTRUCTIONS['speckit-clarify'],
    retryCondition: 'open_questions > 0'
  }),
  Object.freeze({
    id: 'speckit-plan',
    name: 'Spec-kit Plan',
    instruction: PHASE_INSTRUCTIONS['speckit-plan']
  }),
  Object.freeze({
    id: 'speckit-tasks',
    name: 'Spec-kit Tasks',
    instruction: PHASE_INSTRUCTIONS['speckit-tasks']
  }),
  Object.freeze({
    id: 'speckit-analyze',
    name: 'Spec-kit Analyze',
    instruction: PHASE_INSTRUCTIONS['speckit-analyze'],
    retryCondition: 'critical_issues > 0'
  }),
  Object.freeze({
    id: 'speckit-implement',
    name: 'Spec-kit Implement',
    instruction: PHASE_INSTRUCTIONS['speckit-implement']
  }),
  Object.freeze({
    id: 'finalize',
    name: 'Finalize',
    instruction: PHASE_INSTRUCTIONS.finalize
  }),
  Object.freeze({
    id: 'done',
    name: 'Done',
    instruction: PHASE_INSTRUCTIONS.done
  }),
  Object.freeze({
    id: 'bugfix-report',
    name: 'Spec-kit Bugfix Report',
    instruction: PHASE_INSTRUCTIONS['bugfix-report']
  }),
  Object.freeze({
    id: 'bugfix-patch',
    name: 'Spec-kit Bugfix Patch',
    instruction: PHASE_INSTRUCTIONS['bugfix-patch']
  }),
  Object.freeze({
    id: 'bugfix-verify-pre',
    name: 'Spec-kit Bugfix Verify (pre)',
    instruction: PHASE_INSTRUCTIONS['bugfix-verify-pre']
  }),
  Object.freeze({
    id: 'bugfix-implement',
    name: 'Spec-kit Implement (bugfix)',
    instruction: PHASE_INSTRUCTIONS['bugfix-implement']
  }),
  Object.freeze({
    id: 'bugfix-verify-post',
    name: 'Spec-kit Bugfix Verify (post)',
    instruction: PHASE_INSTRUCTIONS['bugfix-verify-post']
  })
]);

export const BUILT_IN_PIPELINE_ID = 'speckit-new-feature';

export const BUILT_IN_BUGFIX_PIPELINE_ID = 'speckit-bugfix';

export const BUILT_IN_PIPELINE: PipelineDef = Object.freeze({
  id: BUILT_IN_PIPELINE_ID,
  name: 'Spec-kit New Feature',
  phases: Object.freeze([
    'speckit-specify',
    'speckit-clarify',
    'speckit-plan',
    'speckit-tasks',
    'speckit-analyze',
    'speckit-implement',
    'finalize',
    'done'
  ]) as readonly string[]
});

export const BUILT_IN_BUGFIX_PIPELINE: PipelineDef = Object.freeze({
  id: BUILT_IN_BUGFIX_PIPELINE_ID,
  name: 'Spec-kit Bugfix',
  phases: Object.freeze([
    'bugfix-report',
    'bugfix-patch',
    'bugfix-verify-pre',
    'bugfix-implement',
    'bugfix-verify-post'
  ]) as readonly string[]
});

export const BUILT_IN_PIPELINES: readonly PipelineDef[] = Object.freeze([
  BUILT_IN_PIPELINE,
  BUILT_IN_BUGFIX_PIPELINE
]);

// Feature 059 — default-detection helpers used by the per-capability
// trust gate in `cmd-save-phases.ts` and `cmd-save-pipelines.ts`. The
// I-2 invariant of the save-command contract requires that saving the
// built-in payload bypasses the gate unconditionally so an operator can
// always reset-to-defaults from a denied state.
//
// `stableJsonStringify` produces a key-sorted, deterministic JSON
// rendering so byte equality is independent of object-property order
// from the wire (the webview emits properties in declaration order, but
// that order is a JS-engine implementation detail). Stable across runs.
function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableJsonStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map((k) => JSON.stringify(k) + ':' + stableJsonStringify(obj[k]));
  return '{' + parts.join(',') + '}';
}

/**
 * Returns `true` iff `payload` is byte-equivalent (after key-sorted
 * JSON normalization) to the `BUILT_IN_PHASES` catalog. Used by the
 * trust gate to recognize a reset-to-defaults save.
 */
export function equalsBuiltInPhases(payload: readonly unknown[]): boolean {
  return stableJsonStringify(payload) === stableJsonStringify(BUILT_IN_PHASES);
}

/**
 * Returns `true` iff `payload` is byte-equivalent (after key-sorted
 * JSON normalization) to the `BUILT_IN_PIPELINES` catalog. Used by the
 * trust gate to recognize a reset-to-defaults save.
 */
export function equalsBuiltInPipelines(payload: readonly unknown[]): boolean {
  return stableJsonStringify(payload) === stableJsonStringify(BUILT_IN_PIPELINES);
}

/**
 * Returns the `retryCondition` declared on the built-in phase with the
 * given id, or `undefined` if the phase has no default retry condition
 * (built-in phases currently do not declare retry conditions). Used by
 * the row-granularity retry-condition gate in `cmd-save-phases.ts`: a
 * payload row whose `retryCondition` matches this value is considered
 * "default" and bypasses the per-row gate.
 */
export function defaultRetryConditionForPhaseId(phaseId: string): string | undefined {
  const phase = BUILT_IN_PHASES.find((p) => p.id === phaseId);
  return phase?.retryCondition;
}

export const ALLOWED_PHASE_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'instruction',
  'model',
  'effort',
  'timeoutSeconds',
  'retryCondition'
]);

const ALLOWED_PIPELINE_FIELDS = new Set(['id', 'name', 'phases']);

export function isPhaseDef(value: unknown): value is PhaseDef {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.instruction === 'string' &&
    (v.model === undefined || typeof v.model === 'string') &&
    (v.effort === undefined ||
      (typeof v.effort === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v.effort))) &&
    (v.timeoutSeconds === undefined || typeof v.timeoutSeconds === 'number') &&
    (v.retryCondition === undefined ||
      (typeof v.retryCondition === 'string' && v.retryCondition.length > 0))
  );
}

export function isPipelineDef(value: unknown): value is PipelineDef {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    Array.isArray(v.phases) &&
    v.phases.every((p) => typeof p === 'string')
  );
}

interface MergeInput {
  readonly phases?: readonly PhaseDef[];
  readonly pipelines?: readonly PipelineDef[];
  readonly models?: readonly string[];
  readonly defaultPipelineId?: string;
}

export function mergeCatalog(
  builtin: MergeInput,
  user: MergeInput,
  workspace: MergeInput
): {
  catalog: {
    phases: readonly PhaseDef[];
    pipelines: readonly PipelineDef[];
    models: readonly string[];
    defaultPipelineId: string;
  };
  duplicateWarnings: readonly ValidationWarning[];
} {
  const duplicateWarnings: ValidationWarning[] = [];
  const phasesMap = new Map<string, PhaseDef>();
  const pipelinesMap = new Map<string, PipelineDef>();
  const modelsSet = new Set<string>();

  const layers: ReadonlyArray<{ name: string; input: MergeInput }> = [
    { name: 'builtin', input: builtin },
    { name: 'workspace', input: workspace },
    { name: 'user', input: user }
  ];

  for (const { name, input } of layers) {
    const layerPhaseIds = new Set<string>();
    for (const p of input.phases ?? []) {
      if (layerPhaseIds.has(p.id) && name !== 'builtin') {
        duplicateWarnings.push({
          source: 'phase',
          id: p.id,
          message: `Duplicate phase id '${p.id}' in ${name} settings; last-defined wins`
        });
      }
      layerPhaseIds.add(p.id);
      phasesMap.set(p.id, p);
    }

    const layerPipelineIds = new Set<string>();
    for (const pl of input.pipelines ?? []) {
      if (layerPipelineIds.has(pl.id) && name !== 'builtin') {
        duplicateWarnings.push({
          source: 'pipeline',
          id: pl.id,
          message: `Duplicate pipeline id '${pl.id}' in ${name} settings; last-defined wins`
        });
      }
      layerPipelineIds.add(pl.id);
      pipelinesMap.set(pl.id, pl);
    }

    for (const m of input.models ?? []) {
      modelsSet.add(m);
    }
  }

  const defaultPipelineId =
    user.defaultPipelineId ??
    workspace.defaultPipelineId ??
    builtin.defaultPipelineId ??
    BUILT_IN_PIPELINE_ID;

  return {
    catalog: {
      phases: Array.from(phasesMap.values()),
      pipelines: Array.from(pipelinesMap.values()),
      models: Array.from(modelsSet),
      defaultPipelineId
    },
    duplicateWarnings
  };
}

export function buildCatalog(
  phases: readonly PhaseDef[],
  pipelines: readonly PipelineDef[],
  models: readonly string[],
  defaultPipelineId: string
): PipelineCatalog {
  const phasesById = new Map<string, PhaseDef>();
  for (const p of phases) {
    phasesById.set(p.id, p);
  }
  const pipelinesById = new Map<string, PipelineDef>();
  for (const pl of pipelines) {
    pipelinesById.set(pl.id, pl);
  }
  return Object.freeze({
    phases: Object.freeze([...phases]),
    pipelines: Object.freeze([...pipelines]),
    models: Object.freeze([...models]),
    defaultPipelineId,
    phasesById,
    pipelinesById
  });
}

export const BUILT_IN_CATALOG: PipelineCatalog = buildCatalog(
  BUILT_IN_PHASES,
  BUILT_IN_PIPELINES,
  Object.freeze([]),
  BUILT_IN_PIPELINE_ID
);

export function validatePhaseRaw(value: unknown): readonly ValidationError[] {
  const errors: ValidationError[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ source: 'phase', message: 'Phase entry must be an object' });
    return errors;
  }
  const v = value as Record<string, unknown>;
  const id = typeof v.id === 'string' ? v.id : undefined;

  for (const key of Object.keys(v)) {
    if (!ALLOWED_PHASE_FIELDS.has(key)) {
      errors.push({
        source: 'phase',
        id,
        field: key,
        message: `Unknown property '${key}' on phase definition`
      });
    }
  }

  if (typeof v.id !== 'string' || v.id.length === 0) {
    errors.push({ source: 'phase', id, field: 'id', message: 'Phase.id is required' });
  } else if (!PHASE_ID_PATTERN.test(v.id)) {
    errors.push({
      source: 'phase',
      id,
      field: 'id',
      message: `Phase.id '${v.id}' must match ${PHASE_ID_PATTERN.source}`
    });
  }

  if (typeof v.name !== 'string' || v.name.length === 0 || v.name.length > NAME_MAX_LEN) {
    errors.push({
      source: 'phase',
      id,
      field: 'name',
      message: `Phase.name must be a non-empty string ≤ ${NAME_MAX_LEN} chars`
    });
  }

  if (
    typeof v.instruction !== 'string' ||
    v.instruction.length === 0 ||
    v.instruction.length > INSTRUCTION_MAX_LEN
  ) {
    errors.push({
      source: 'phase',
      id,
      field: 'instruction',
      message: `Phase.instruction must be a non-empty string ≤ ${INSTRUCTION_MAX_LEN} chars`
    });
  }

  if (v.model !== undefined) {
    if (typeof v.model !== 'string' || v.model.length === 0) {
      errors.push({
        source: 'phase',
        id,
        field: 'model',
        message: 'Phase.model must be a non-empty string when set'
      });
    }
  }

  if (v.effort !== undefined) {
    if (typeof v.effort !== 'string' || !(EFFORT_LEVELS as readonly string[]).includes(v.effort)) {
      errors.push({
        source: 'phase',
        id,
        field: 'effort',
        message: `Phase.effort must be one of ${EFFORT_LEVELS.join(', ')}`
      });
    }
  }

  if (v.timeoutSeconds !== undefined) {
    if (
      typeof v.timeoutSeconds !== 'number' ||
      !Number.isInteger(v.timeoutSeconds) ||
      v.timeoutSeconds < TIMEOUT_MIN ||
      v.timeoutSeconds > TIMEOUT_MAX
    ) {
      errors.push({
        source: 'phase',
        id,
        field: 'timeoutSeconds',
        message: `Phase.timeoutSeconds must be an integer in [${TIMEOUT_MIN}, ${TIMEOUT_MAX}]`
      });
    }
  }

  if (v.retryCondition !== undefined) {
    if (typeof v.retryCondition !== 'string' || v.retryCondition.length === 0) {
      errors.push({
        source: 'phase',
        id,
        field: 'retryCondition',
        message: 'Phase.retryCondition must be a non-empty string when set'
      });
    }
  }

  return errors;
}

export function validatePipelineRaw(
  value: unknown,
  knownPhaseIds: ReadonlySet<string>
): readonly ValidationError[] {
  const errors: ValidationError[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ source: 'pipeline', message: 'Pipeline entry must be an object' });
    return errors;
  }
  const v = value as Record<string, unknown>;
  const id = typeof v.id === 'string' ? v.id : undefined;

  for (const key of Object.keys(v)) {
    if (!ALLOWED_PIPELINE_FIELDS.has(key)) {
      errors.push({
        source: 'pipeline',
        id,
        field: key,
        message: `Unknown property '${key}' on pipeline definition`
      });
    }
  }

  if (typeof v.id !== 'string' || v.id.length === 0) {
    errors.push({ source: 'pipeline', id, field: 'id', message: 'Pipeline.id is required' });
  } else if (!PHASE_ID_PATTERN.test(v.id)) {
    errors.push({
      source: 'pipeline',
      id,
      field: 'id',
      message: `Pipeline.id '${v.id}' must match ${PHASE_ID_PATTERN.source}`
    });
  }

  if (typeof v.name !== 'string' || v.name.length === 0 || v.name.length > NAME_MAX_LEN) {
    errors.push({
      source: 'pipeline',
      id,
      field: 'name',
      message: `Pipeline.name must be a non-empty string ≤ ${NAME_MAX_LEN} chars`
    });
  }

  if (!Array.isArray(v.phases) || v.phases.length === 0) {
    errors.push({
      source: 'pipeline',
      id,
      field: 'phases',
      message: 'Pipeline.phases must be a non-empty array'
    });
  } else {
    for (let i = 0; i < v.phases.length; i++) {
      const ref = v.phases[i];
      if (typeof ref !== 'string') {
        errors.push({
          source: 'pipeline',
          id,
          field: `phases[${i}]`,
          message: 'Pipeline.phases entries must be strings'
        });
      } else if (!knownPhaseIds.has(ref)) {
        errors.push({
          source: 'pipeline',
          id,
          field: `phases[${i}]`,
          message: `Pipeline.phases[${i}] references unknown phase id '${ref}'`
        });
      }
    }
  }

  return errors;
}

export function validateCatalog(catalog: {
  phases: readonly PhaseDef[];
  pipelines: readonly PipelineDef[];
  defaultPipelineId: string;
}): ValidationReport {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  for (const p of catalog.phases) {
    errors.push(...validatePhaseRaw(p));
  }

  const knownPhaseIds = new Set(catalog.phases.map((p) => p.id));
  for (const pl of catalog.pipelines) {
    errors.push(...validatePipelineRaw(pl, knownPhaseIds));
  }

  if (
    catalog.defaultPipelineId &&
    !catalog.pipelines.some((p) => p.id === catalog.defaultPipelineId)
  ) {
    warnings.push({
      source: 'pipeline',
      id: catalog.defaultPipelineId,
      message: `defaultPipelineId '${catalog.defaultPipelineId}' references unknown pipeline; falling back to '${BUILT_IN_PIPELINE_ID}'`
    });
  }

  if (catalog.phases.length > SOFT_CAP_PHASES) {
    warnings.push({
      source: 'limit',
      message: `Catalog has ${catalog.phases.length} phases; soft cap is ${SOFT_CAP_PHASES}`
    });
  }
  if (catalog.pipelines.length > SOFT_CAP_PIPELINES) {
    warnings.push({
      source: 'limit',
      message: `Catalog has ${catalog.pipelines.length} pipelines; soft cap is ${SOFT_CAP_PIPELINES}`
    });
  }
  for (const pl of catalog.pipelines) {
    if (pl.phases.length > SOFT_CAP_PIPELINE_PHASES) {
      warnings.push({
        source: 'limit',
        id: pl.id,
        message: `Pipeline '${pl.id}' has ${pl.phases.length} phases; soft cap is ${SOFT_CAP_PIPELINE_PHASES}`
      });
    }
  }

  return { errors, warnings };
}
