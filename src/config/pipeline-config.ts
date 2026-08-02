export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];
export type PhaseSideEffects = 'none' | 'workspace' | 'git' | 'unrestricted';
export type PhaseEvidencePolicy = 'required' | 'best-effort' | 'none';
import { SUPPORTED_BACKENDS, isBackendRunnerKind, type BackendRunnerKind } from '../runner/backend-runner-factory';
import { phaseRunnerPolicyError } from './phase-runner-policy';
import { mergePhaseRunnerPolicy } from './pipeline-snapshot';
export interface PhaseDef {
  readonly id: string;
  readonly name: string;
  readonly instruction: string;
  readonly model?: string;
  readonly effort?: Effort;
  readonly timeoutSeconds?: number;
  readonly loopable?: boolean;
  readonly retryCondition?: string;
  readonly isRequired?: boolean;
  readonly runner?: BackendRunnerKind;
  readonly sideEffects?: PhaseSideEffects; // Custom omission => unrestricted.
  readonly evidencePolicy?: PhaseEvidencePolicy;
  readonly promptVersion?: string;
}
export interface PipelineDef {
  readonly id: string;
  readonly name: string;
  readonly phases: readonly string[];
}
export interface PipelineCatalog {
  readonly phases: readonly PhaseDef[];
  readonly pipelines: readonly PipelineDef[];
  readonly models: Record<BackendRunnerKind, readonly string[]>;
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
  'speckit-checklist',
  'speckit-analyze',
  'speckit-implement',
  'speckit-review',
  'finalize',
  'bugfix-report',
  'bugfix-patch',
  'bugfix-verify-pre',
  'bugfix-implement',
  'bugfix-verify-post',
  'specify-brainstorm',
  'superpowers-implement',
  'superpowers-review-close'
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
  'speckit-specify': '/speckit-specify',
  'speckit-clarify': [
    'Run /speckit-clarify on the active feature spec.',
    '',
    'NON-SKIPPABLE: You MUST actually invoke /speckit-clarify — never infer "no ambiguities" without an executed run. A "clean" result is valid ONLY when it comes from a real /speckit-clarify Completion Report.',
    '',
    'Auto-accept mode: For every question, accept the recommended/suggested answer automatically:',
    '- For multiple-choice with "Recommended: Option [X]" → respond with that option letter or "recommended".',
    '- For short-answer with "Suggested:" → respond with "suggested".',
    '- Process ALL questions in the iteration without pausing. Do NOT ask the user.',
    '',
    'Evidence gate: The iteration counts only if /speckit-clarify actually ran and produced evidence — EITHER a Completion Report with a coverage summary table, OR the explicit "No critical ambiguities detected" message.',
    '',
    'Result determination (from the actual run output only):',
    '- If "No critical ambiguities detected" AND no questions asked → emit [SCHEGENT_STATUS: CLEAR]',
    '- If all coverage categories are Clear AND no questions asked → emit [SCHEGENT_STATUS: CLEAR]',
    '- If ANY questions were asked and auto-accepted → emit "Open questions:" followed by a summary (controller will re-loop)',
    '',
    'Inside the SCHEGENT AUDIT LOG block, emit `open_questions: <N>` and `resolved_questions: <N>` as top-level integer metric lines so the controller can observe progress.'
  ].join('\n'),
  'speckit-plan': '/speckit-plan',
  'speckit-tasks': '/speckit-tasks',
  'speckit-checklist': [
    'Run /speckit-checklist on the active feature.',
    '',
    'Auto-select: Depth=Standard, Audience=Reviewer, Focus=Top 2 relevance clusters. For all clarifying questions, choose the most comprehensive option automatically.',
    '',
    'Verify (soft — non-blocking): Confirm the run produced a checklist under <feature_dir>/checklists/. If missing, note the warning but proceed.',
    '',
    'Always emit [SCHEGENT_STATUS: CLEAR] when complete — checklist is non-blocking.',
    '',
    'Inside the SCHEGENT AUDIT LOG block, emit `checklist_items: <N>` as a top-level integer metric line.'
  ].join('\n'),
  'speckit-analyze': [
    'Run /speckit-analyze on the active feature.',
    '',
    'NON-SKIPPABLE: You MUST actually invoke /speckit-analyze at least once — never assume "0 CRITICAL issues" without an executed run. /speckit-analyze is READ-ONLY (writes no files), so a skipped run leaves NO artifact trace. A "clean" result is valid ONLY when it comes from a real Specification Analysis Report whose Metrics block reports Critical Issues Count: 0.',
    '',
    'Evidence gate: The iteration counts only if /speckit-analyze actually ran and produced a Specification Analysis Report with its findings table and Metrics block (Total Requirements, Total Tasks, Coverage %, Critical Issues Count).',
    '',
    'Result determination (from the actual report only):',
    '- If 0 CRITICAL issues AND no remediation performed → emit [SCHEGENT_STATUS: CLEAR]',
    '- If CRITICAL issues exist → apply auto-remediation (see below), then emit "Remaining issues:" listing unresolved criticals',
    '',
    'Auto-remediation (when issues exist):',
    '- Respond "Yes, suggest and apply remediation for ALL issues including HIGH severity."',
    '- Apply ALL suggested edits to spec.md, plan.md, and/or tasks.md.',
    '- Do NOT assume remediation fixed everything — the controller will re-loop to verify.',
    '',
    'REQUIRED METRIC OUTPUT: Inside the SCHEGENT AUDIT LOG block, you MUST emit `critical_issues: <N>` and `high_issues: <N>` as top-level integer metric lines (NOT nested under Notes:, Findings:, or any other heading). These lines MUST appear even when the count is 0. Example:',
    'critical_issues: 0',
    'high_issues: 2',
    'The controller uses these metrics to decide whether to re-loop. Missing metrics cause incorrect advancement.'
  ].join('\n'),
  'speckit-implement': [
    'Run /speckit-implement on the active feature.',
    '',
    'After implementation completes, load <feature_dir>/tasks.md and count every task NOT marked complete.',
    '',
    'Result determination:',
    '- If 0 pending tasks remain → emit [SCHEGENT_STATUS: CLEAR]',
    '- If any tasks are still pending → emit "Remaining issues:" listing the incomplete tasks',
    '',
    'REQUIRED METRIC OUTPUT: Inside the SCHEGENT AUDIT LOG block, you MUST emit `pending_tasks: <N>` as a top-level integer metric line (NOT nested under Notes: or any other heading). This line MUST appear even when the count is 0. The controller uses this metric to decide whether to re-loop.'
  ].join('\n'),
  'speckit-review': [
    'Review the implementation and finish all pending tasks:',
    '1. Load <feature_dir>/tasks.md and list every task not marked complete.',
    '2. Cross-check the implementation against spec.md and plan.md for gaps.',
    '3. Implement every remaining or incomplete task to completion.',
    '',
    'Then trigger code review — fix EVERY finding, loop until clean:',
    '- Run /code-review against the current diff with --fix.',
    '- Fix every finding regardless of severity or confidence level.',
    '- After applying fixes, re-run /code-review until zero findings, up to 10 iterations.',
    '',
    'Then trigger security review — fix EVERY finding, loop until clean:',
    '- Run /security-review against the current diff.',
    '- Apply a fix for every finding.',
    '- After applying fixes, re-run /security-review until zero findings, up to 10 iterations.',
    '',
    'False-positive carve-out: The only finding you may leave unedited is a demonstrated false positive with a recorded one-line justification.',
    '',
    'Result determination:',
    '- If all tasks complete AND both reviews report zero findings → emit [SCHEGENT_STATUS: CLEAR]',
    '- If any findings remain → emit "Remaining issues:" listing residuals',
    '',
    'Inside the SCHEGENT AUDIT LOG block, emit `code_review_findings: <N>`, `security_review_findings: <N>`, and `pending_tasks: <N>` as top-level integer metric lines.'
  ].join('\n'),
  finalize: [
    'Verify the implementation and drive it to green:',
    '',
    '1. Format FIRST: Run the project formatter in write mode (e.g. cargo fmt, npm run format) exactly once before the check set.',
    '2. Run the full check set — build, tests, lint, typecheck. Capture pass/fail for each.',
    '3. If any check fails: diagnose root cause, apply a real fix, re-run affected checks, repeat until all green (max 10 iterations). Do NOT mask failures (no skipped tests, no eslint-disable, no loosened types).',
    '4. Standard fallbacks when plan.md lists no explicit commands:',
    '   - Rust: cargo build, cargo test, cargo clippy -- -D warnings, cargo fmt --check',
    '   - Node/TS: npm run build, npm test, npm run lint, npx tsc --noEmit',
    '   - Python: test runner, ruff/flake8, mypy/pyright',
    '',
    '5. Commit all changes with conventional commit format: feat(<feature_name>): <summary>',
    '6. Merge to local develop branch: git switch develop && git merge --no-ff <feature_branch>',
    '',
    'Result determination:',
    '- If all checks green → emit [SCHEGENT_STATUS: CLEAR]',
    '- If checks still failing after 10 iterations → emit "Remaining issues:" listing failures',
    '',
    'Inside the SCHEGENT AUDIT LOG block, emit `checks_passing: <N>` and `checks_failing: <N>` as top-level integer metric lines.'
  ].join('\n'),
  'bugfix-report': '/speckit-bugfix-report',
  'bugfix-patch': '/speckit-bugfix-patch',
  'bugfix-verify-pre': '/speckit-bugfix-verify',
  'bugfix-implement': '/speckit-implement',
  'bugfix-verify-post': '/speckit-bugfix-verify',
  'specify-brainstorm':
    "Let's brainstorm the idea from the input and run /speckit-specify",
  'superpowers-implement':
    "Use git worktree for this feature. Get the 'feature_directory' from .specify/feature.json. Don't re-plan, execute the tasks.md in that 'feature_directory' using subagent-driven development with TDD",
  'superpowers-review-close':
    "Get the 'feature_directory' from .specify/feature.json. Don't re-plan, analyze the implementation, identify open tasks, evaluate them, and implement them. Mark all implemented tasks to done. After that, perform a code review and finish the development branch. At the end, create commits for the pending changes if necessary. Merge all new commits to develop, then checkout to develop"
};
export const BUILT_IN_PHASES: readonly PhaseDef[] = Object.freeze([
  Object.freeze({
    id: 'speckit-specify',
    name: 'Spec-kit Specify',
    instruction: PHASE_INSTRUCTIONS['speckit-specify'],
    model: 'claude-opus-5',
    runner: 'claude'
  }),
  Object.freeze({
    id: 'speckit-clarify',
    name: 'Spec-kit Clarify',
    instruction: PHASE_INSTRUCTIONS['speckit-clarify'],
    retryCondition: 'open_questions > 0',
    model: 'claude-opus-5'
  }),
  Object.freeze({
    id: 'speckit-plan',
    name: 'Spec-kit Plan',
    instruction: PHASE_INSTRUCTIONS['speckit-plan'],
    model: 'claude-opus-5'
  }),
  Object.freeze({
    id: 'speckit-tasks',
    name: 'Spec-kit Tasks',
    instruction: PHASE_INSTRUCTIONS['speckit-tasks'],
    model: 'claude-opus-5'
  }),
  Object.freeze({
    id: 'speckit-checklist',
    name: 'Spec-kit Checklist',
    instruction: PHASE_INSTRUCTIONS['speckit-checklist'],
    model: 'claude-opus-5'
  }),
  Object.freeze({
    id: 'speckit-analyze',
    name: 'Spec-kit Analyze',
    instruction: PHASE_INSTRUCTIONS['speckit-analyze'],
    retryCondition: 'critical_issues > 0',
    model: 'claude-opus-5'
  }),
  Object.freeze({
    id: 'speckit-implement',
    name: 'Spec-kit Implement',
    instruction: PHASE_INSTRUCTIONS['speckit-implement'],
    retryCondition: 'pending_tasks > 0',
    model: 'claude-opus-5'
  }),
  Object.freeze({
    id: 'speckit-review',
    name: 'Spec-kit Review',
    instruction: PHASE_INSTRUCTIONS['speckit-review'],
    retryCondition: 'pending_tasks > 0 || code_review_findings > 0 || security_review_findings > 0',
    model: 'claude-opus-5'
  }),
  Object.freeze({
    id: 'finalize',
    name: 'Finalize',
    instruction: PHASE_INSTRUCTIONS.finalize,
    model: 'claude-opus-5',
    runner: 'claude'
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
  }),
  Object.freeze({
    id: 'specify-brainstorm',
    name: 'Specify with Brainstorm',
    instruction: PHASE_INSTRUCTIONS['specify-brainstorm'],
    runner: 'claude'
  }),
  Object.freeze({
    id: 'superpowers-implement',
    name: 'Superpowers Implement',
    instruction: PHASE_INSTRUCTIONS['superpowers-implement'],
    runner: 'claude'
  }),
  Object.freeze({
    id: 'superpowers-review-close',
    name: 'Superpowers Review and Close',
    instruction: PHASE_INSTRUCTIONS['superpowers-review-close'],
    runner: 'claude'
  })
]);

export const BUILT_IN_PIPELINE_ID = 'speckit-new-feature';

export const BUILT_IN_BUGFIX_PIPELINE_ID = 'speckit-bugfix';

export const BUILT_IN_DEV_NEW_FEATURE_PIPELINE_ID = 'dev-new-feature';

export const DEFAULT_PIPELINE_ID = BUILT_IN_PIPELINE_ID;

export const BUILT_IN_PIPELINE: PipelineDef = Object.freeze({
  id: BUILT_IN_PIPELINE_ID,
  name: 'Spec-kit New Feature',
  phases: Object.freeze([
    'speckit-specify',
    'speckit-clarify',
    'speckit-plan',
    'speckit-tasks',
    'speckit-checklist',
    'speckit-analyze',
    'speckit-implement',
    'speckit-review',
    'finalize'
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

export const BUILT_IN_DEV_NEW_FEATURE_PIPELINE: PipelineDef = Object.freeze({
  id: BUILT_IN_DEV_NEW_FEATURE_PIPELINE_ID,
  name: 'Dev New Feature',
  phases: Object.freeze([
    'specify-brainstorm',
    'speckit-clarify',
    'speckit-plan',
    'speckit-tasks',
    'speckit-analyze',
    'superpowers-implement',
    'superpowers-review-close'
  ]) as readonly string[]
});

export const BUILT_IN_PIPELINES: readonly PipelineDef[] = Object.freeze([
  BUILT_IN_PIPELINE,
  BUILT_IN_BUGFIX_PIPELINE,
  BUILT_IN_DEV_NEW_FEATURE_PIPELINE
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
  'loopable',
  'retryCondition',
  'isRequired',
  'runner'
]);

const ALLOWED_PIPELINE_FIELDS = new Set(['id', 'name', 'phases']);

export function isPhaseDef(value: unknown): value is PhaseDef {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const structurallyValid = (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.instruction === 'string' &&
    (v.model === undefined || typeof v.model === 'string') &&
    (v.effort === undefined ||
      (typeof v.effort === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v.effort))) &&
    (v.timeoutSeconds === undefined || typeof v.timeoutSeconds === 'number') &&
    (v.loopable === undefined || typeof v.loopable === 'boolean') &&
    (v.retryCondition === undefined ||
      (typeof v.retryCondition === 'string' && v.retryCondition.length > 0)) &&
    (v.isRequired === undefined || typeof v.isRequired === 'boolean') &&
    (v.runner === undefined || isBackendRunnerKind(v.runner))
  );
  return structurallyValid && phaseRunnerPolicyError(v.id as string, v.runner as BackendRunnerKind | undefined) === null;
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
  readonly models?: Record<BackendRunnerKind, readonly string[]> | readonly string[]; // support migration from array
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
    models: Record<BackendRunnerKind, readonly string[]>;
    defaultPipelineId: string;
  };
  duplicateWarnings: readonly ValidationWarning[];
} {
  const duplicateWarnings: ValidationWarning[] = [];
  const phasesMap = new Map<string, PhaseDef>();
  const pipelinesMap = new Map<string, PipelineDef>();
  const modelsMap = new Map<BackendRunnerKind, Set<string>>();

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
      phasesMap.set(p.id, mergePhaseRunnerPolicy(phasesMap.get(p.id), p));
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

    if (input.models) {
      if (Array.isArray(input.models)) {
        let set = modelsMap.get('claude');
        if (!set) {
          set = new Set<string>();
          modelsMap.set('claude', set);
        }
        for (const m of input.models) set.add(m);
      } else {
        for (const kind of SUPPORTED_BACKENDS) {
          const arr = (input.models as Record<BackendRunnerKind, readonly string[]>)[kind];
          if (arr) {
            let set = modelsMap.get(kind);
            if (!set) {
              set = new Set<string>();
              modelsMap.set(kind, set);
            }
            for (const m of arr) set.add(m);
          }
        }
      }
    }
  }

  const defaultPipelineId =
    workspace.defaultPipelineId ??
    user.defaultPipelineId ??
    builtin.defaultPipelineId ??
    BUILT_IN_PIPELINE_ID;

  const mergedModels: Record<BackendRunnerKind, readonly string[]> = {
    claude: Object.freeze(Array.from(modelsMap.get('claude') ?? [])),
    codex: Object.freeze(Array.from(modelsMap.get('codex') ?? [])),
    agy: Object.freeze(Array.from(modelsMap.get('agy') ?? []))
  };

  return {
    catalog: {
      phases: Array.from(phasesMap.values()),
      pipelines: Array.from(pipelinesMap.values()),
      models: mergedModels,
      defaultPipelineId
    },
    duplicateWarnings
  };
}

export function buildCatalog(
  phases: readonly PhaseDef[],
  pipelines: readonly PipelineDef[],
  models: Record<BackendRunnerKind, readonly string[]>,
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
    models: Object.freeze(models),
    defaultPipelineId,
    phasesById,
    pipelinesById
  });
}

export const BUILT_IN_CATALOG: PipelineCatalog = buildCatalog(
  BUILT_IN_PHASES,
  BUILT_IN_PIPELINES,
  { claude: [], codex: [], agy: [] },
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

  if (v.loopable !== undefined && typeof v.loopable !== 'boolean') {
    errors.push({
      source: 'phase',
      id,
      field: 'loopable',
      message: 'Phase.loopable must be a boolean when set'
    });
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

  if (v.isRequired !== undefined && typeof v.isRequired !== 'boolean') {
    errors.push({
      source: 'phase',
      id,
      field: 'isRequired',
      message: 'Phase.isRequired must be a boolean when set'
    });
  }

  const runnerValid = v.runner === undefined || isBackendRunnerKind(v.runner);
  if (!runnerValid) {
    errors.push({
      source: 'phase',
      id,
      field: 'runner',
      message: `Phase.runner must be one of ${SUPPORTED_BACKENDS.join(', ')}`
    });
  }

  if (typeof v.id === 'string' && runnerValid) {
    const policyError = phaseRunnerPolicyError(
      v.id,
      v.runner as BackendRunnerKind | undefined
    );
    if (policyError !== null) {
      errors.push({
        source: 'phase',
        id,
        field: 'runner',
        message: policyError
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
