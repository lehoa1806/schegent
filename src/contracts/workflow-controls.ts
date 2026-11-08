import type { DecisionFieldType, TypedCondition } from './decision-results';

/**
 * Canonical Workflow Control contracts (`D1`, `D3`, `D6`, `D9`, `SPEC-03`).
 *
 * Defines `CandidateBlockControl` (on `WorkflowDefinition.control`),
 * `WorkflowDecisionResults` (on `WorkflowDefinition.decisionResults`),
 * `RepeatControl` and `ForEachControl` (on `WorkflowNode.control`),
 * and their closed bounds and default-resolution helpers.
 */

export const CONTROL_CONTRACT_VERSION = 1 as const;
export const WORKFLOW_CONTROL_SCHEMA_VERSION = CONTROL_CONTRACT_VERSION;

export const MIN_CANDIDATES_PER_BLOCK = 1;
export const MAX_CANDIDATES_PER_BLOCK = 8;

export const MIN_CANDIDATE_MAX_ATTEMPTS = 1;
export const MAX_CANDIDATE_MAX_ATTEMPTS = 20;
export const DEFAULT_CANDIDATE_MAX_ATTEMPTS = 3;

export const MIN_CANDIDATE_BLOCK_DISPATCHES = 1;
export const MAX_CANDIDATE_BLOCK_DISPATCHES = 40;

export const MIN_CANDIDATE_PRIORITY = 1;
export const MAX_CANDIDATE_PRIORITY = 1_000;

export const MIN_CANDIDATE_RETRY_DELAY_MS = 1_000;
export const MAX_CANDIDATE_RETRY_DELAY_MS = 3_600_000;
export const DEFAULT_CANDIDATE_INITIAL_DELAY_MS = 5_000;
export const DEFAULT_CANDIDATE_MAX_DELAY_MS = 60_000;

export const MIN_CANDIDATE_RETRY_MULTIPLIER = 1;
export const MAX_CANDIDATE_RETRY_MULTIPLIER = 10;
export const DEFAULT_CANDIDATE_RETRY_MULTIPLIER = 2;

export const MIN_MONITORING_WINDOW_MS = 60_000;
export const MAX_MONITORING_WINDOW_MS = 172_800_000;
export const DEFAULT_MONITORING_WINDOW_MS = 86_400_000;

export const DEFAULT_ALLOW_UNVERIFIED_TRIAL = false;

export const MIN_STRICT_USD_LIMIT_MICROUSD = 1;
export const MAX_STRICT_USD_LIMIT_MICROUSD = 1_000_000_000_000;

export const MIN_REPEAT_ITERATIONS = 1;
export const MAX_REPEAT_ITERATIONS = 25;
export const MAX_REPEAT_CARRY_MAPPINGS = 32;

export const MIN_FOR_EACH_MAX_ITEMS = 1;
export const MAX_FOR_EACH_MAX_ITEMS = 100;
export const DEFAULT_FOR_EACH_MAX_ITEMS = 50;
export const MAX_FOR_EACH_COLLECTION_BYTES = 262_144;
export const MAX_FOR_EACH_ITEM_BYTES = 8_192;
export const MAX_FOR_EACH_ITEM_FIELDS = 32;
export const MAX_FOR_EACH_ITEM_KEY_BYTES = 128;

export const MAX_CONTROL_NESTING_DEPTH = 2;
export const MAX_ROOT_CONTROL_DISPATCHES = 100;
export const DEFAULT_ROOT_MAX_PHASE_ATTEMPTS = MAX_ROOT_CONTROL_DISPATCHES;
export const MAX_WORKFLOW_DECISION_RESULT_FIELDS = 32;

export const WORKFLOW_CONTROL_KINDS = Object.freeze([
  'candidate-block',
  'repeat',
  'for-each'
] as const);
export type WorkflowControlKind = (typeof WORKFLOW_CONTROL_KINDS)[number];

export const WORKFLOW_NODE_CONTROL_KINDS = Object.freeze(['repeat', 'for-each'] as const);
export type WorkflowNodeControlKind = (typeof WORKFLOW_NODE_CONTROL_KINDS)[number];

export const CANDIDATE_AVAILABILITY_POLICIES = Object.freeze([
  'first-ready',
  'wait-for-selected',
  'stop-on-unavailability'
] as const);
export type CandidateAvailabilityPolicy = (typeof CANDIDATE_AVAILABILITY_POLICIES)[number];
export const DEFAULT_CANDIDATE_AVAILABILITY_POLICY: CandidateAvailabilityPolicy = 'first-ready';

export const CANDIDATE_BUDGET_MODES = Object.freeze(['count-only', 'strict-usd'] as const);
export type CandidateBudgetMode = (typeof CANDIDATE_BUDGET_MODES)[number];

export const REPEAT_ON_EXHAUSTED_POLICIES = Object.freeze(['pause', 'fail'] as const);
export type RepeatExhaustedPolicy = (typeof REPEAT_ON_EXHAUSTED_POLICIES)[number];
export const DEFAULT_REPEAT_ON_EXHAUSTED: RepeatExhaustedPolicy = 'pause';

export const FOR_EACH_ON_ITEM_ERROR_POLICIES = Object.freeze(['stop', 'continue'] as const);
export type ForEachItemErrorPolicy = (typeof FOR_EACH_ON_ITEM_ERROR_POLICIES)[number];
export const DEFAULT_FOR_EACH_ON_ITEM_ERROR: ForEachItemErrorPolicy = 'stop';

export const FOR_EACH_COLLECTION_SOURCES = Object.freeze([
  'workflow-input',
  'node-output'
] as const);
export type ForEachCollectionSourceKind = (typeof FOR_EACH_COLLECTION_SOURCES)[number];

export const DECISION_RESULT_BINDING_SOURCE_KINDS = Object.freeze([
  'node-result',
  'selected-candidate'
] as const);
export type DecisionResultBindingSourceKind =
  (typeof DECISION_RESULT_BINDING_SOURCE_KINDS)[number];

export interface CandidateRetryConfig {
  readonly initialDelayMs?: number; // 1_000..3_600_000, default 5_000
  readonly multiplier?: number; // 1..10 finite number, default 2
  readonly maxDelayMs?: number; // 1_000..3_600_000, default 60_000; initialDelayMs <= maxDelayMs
}

export interface ResolvedCandidateRetryConfig {
  readonly initialDelayMs: number;
  readonly multiplier: number;
  readonly maxDelayMs: number;
}

export type CandidateBlockBudget =
  | { readonly mode: 'count-only' }
  | { readonly mode: 'strict-usd'; readonly limitMicrousd: number };

export interface RootControlBudget {
  readonly version: typeof WORKFLOW_CONTROL_SCHEMA_VERSION;
  readonly maxPhaseAttempts: number;
  readonly strictUsdBudget?: Extract<CandidateBlockBudget, { readonly mode: 'strict-usd' }>;
}

export interface CandidateSpec {
  readonly candidateId: string;
  readonly nodeId: string;
  readonly priority?: number; // 1..1000, default index + 1
  readonly maxAttempts?: number; // 1..20, default 3
  readonly retry?: CandidateRetryConfig;
  readonly allowUnverifiedTrial?: boolean; // default false
}

export interface ResolvedCandidateSpec {
  readonly candidateId: string;
  readonly nodeId: string;
  readonly priority: number;
  readonly maxAttempts: number;
  readonly retry: ResolvedCandidateRetryConfig;
  readonly allowUnverifiedTrial: boolean;
}

export interface CandidateBlockControl {
  readonly version: 1;
  readonly kind: 'candidate-block';
  readonly candidates: readonly CandidateSpec[]; // 1..8
  readonly availabilityPolicy?: CandidateAvailabilityPolicy;
  readonly maxDispatches?: number; // 1..40, default min(40, sum(maxAttempts))
  readonly monitoringWindowMs?: number; // 60_000..172_800_000, default 86_400_000
  readonly budget?: CandidateBlockBudget; // default { mode: 'count-only' }
}

export interface ResolvedCandidateBlockControl {
  readonly version: 1;
  readonly kind: 'candidate-block';
  readonly candidates: readonly ResolvedCandidateSpec[];
  readonly availabilityPolicy: CandidateAvailabilityPolicy;
  readonly maxDispatches: number;
  readonly monitoringWindowMs: number;
  readonly budget: CandidateBlockBudget;
}

export interface WorkflowDecisionResultField {
  readonly fieldId: string;
  readonly type: DecisionFieldType;
  readonly required: boolean; // default true
}

export type DecisionResultBindingSource =
  | { readonly kind: 'node-result'; readonly nodeId: string; readonly fieldId: string }
  | { readonly kind: 'selected-candidate'; readonly fieldId: string };

export interface DecisionResultBinding {
  readonly fieldId: string;
  readonly source: DecisionResultBindingSource;
}

export interface WorkflowDecisionResults {
  readonly version: 1;
  readonly fields: readonly WorkflowDecisionResultField[];
  readonly bindings: readonly DecisionResultBinding[];
}

export type WorkflowDecisionResultsContract = WorkflowDecisionResults;

export interface RepeatCarryMapping {
  readonly fieldId: string;
  readonly inputPortId: string;
}

export interface RepeatControl {
  readonly version: 1;
  readonly kind: 'repeat';
  readonly maxIterations: number; // 1..25
  readonly until: TypedCondition;
  readonly carry: readonly RepeatCarryMapping[]; // 0..32
  readonly onExhausted?: RepeatExhaustedPolicy; // default 'pause'
}

export interface ResolvedRepeatControl {
  readonly version: 1;
  readonly kind: 'repeat';
  readonly maxIterations: number;
  readonly until: TypedCondition;
  readonly carry: readonly RepeatCarryMapping[];
  readonly onExhausted: RepeatExhaustedPolicy;
}

export type ForEachCollectionSource =
  | { readonly source: 'workflow-input'; readonly portId: string }
  | { readonly source: 'node-output'; readonly nodeId: string; readonly portId: string };

export interface ForEachControl {
  readonly version: 1;
  readonly kind: 'for-each';
  readonly collection: ForEachCollectionSource;
  readonly itemKeyField?: string;
  readonly itemInputPortId: string;
  readonly maxItems?: number; // 1..100, default 50
  readonly onItemError?: ForEachItemErrorPolicy; // default 'stop'
}

export interface ResolvedForEachControl {
  readonly version: 1;
  readonly kind: 'for-each';
  readonly collection: ForEachCollectionSource;
  readonly itemKeyField?: string;
  readonly itemInputPortId: string;
  readonly maxItems: number;
  readonly onItemError: ForEachItemErrorPolicy;
}

export type WorkflowNodeControl = RepeatControl | ForEachControl;
export type ResolvedWorkflowNodeControl = ResolvedRepeatControl | ResolvedForEachControl;
export type WorkflowControl = CandidateBlockControl | RepeatControl | ForEachControl;

export function isCandidateAvailabilityPolicy(
  value: unknown
): value is CandidateAvailabilityPolicy {
  return (
    typeof value === 'string' &&
    (CANDIDATE_AVAILABILITY_POLICIES as readonly string[]).includes(value)
  );
}

export function isRepeatExhaustedPolicy(value: unknown): value is RepeatExhaustedPolicy {
  return (
    typeof value === 'string' &&
    (REPEAT_ON_EXHAUSTED_POLICIES as readonly string[]).includes(value)
  );
}

export function isForEachItemErrorPolicy(value: unknown): value is ForEachItemErrorPolicy {
  return (
    typeof value === 'string' &&
    (FOR_EACH_ON_ITEM_ERROR_POLICIES as readonly string[]).includes(value)
  );
}

export function resolveCandidateMaxAttempts(spec: Pick<CandidateSpec, 'maxAttempts'>): number {
  return spec.maxAttempts ?? DEFAULT_CANDIDATE_MAX_ATTEMPTS;
}

export function resolveCandidatePriority(
  spec: Pick<CandidateSpec, 'priority'>,
  index: number
): number {
  return spec.priority ?? index + 1;
}

export function resolveCandidateRetryConfig(
  retry: CandidateRetryConfig | undefined
): ResolvedCandidateRetryConfig {
  return Object.freeze({
    initialDelayMs: retry?.initialDelayMs ?? DEFAULT_CANDIDATE_INITIAL_DELAY_MS,
    multiplier: retry?.multiplier ?? DEFAULT_CANDIDATE_RETRY_MULTIPLIER,
    maxDelayMs: retry?.maxDelayMs ?? DEFAULT_CANDIDATE_MAX_DELAY_MS
  });
}

export function resolveCandidateSpecDefaults(
  spec: CandidateSpec,
  index: number
): ResolvedCandidateSpec {
  return Object.freeze({
    candidateId: spec.candidateId,
    nodeId: spec.nodeId,
    priority: resolveCandidatePriority(spec, index),
    maxAttempts: resolveCandidateMaxAttempts(spec),
    retry: resolveCandidateRetryConfig(spec.retry),
    allowUnverifiedTrial: spec.allowUnverifiedTrial ?? DEFAULT_ALLOW_UNVERIFIED_TRIAL
  });
}

export function resolveCandidateBlockMaxDispatches(
  control: Pick<CandidateBlockControl, 'candidates' | 'maxDispatches'>
): number {
  if (control.maxDispatches !== undefined) {
    return control.maxDispatches;
  }
  const sum = control.candidates.reduce(
    (acc, candidate) => acc + resolveCandidateMaxAttempts(candidate),
    0
  );
  return Math.min(MAX_CANDIDATE_BLOCK_DISPATCHES, Math.max(MIN_CANDIDATE_BLOCK_DISPATCHES, sum));
}

export function resolveCandidateBlockDefaults(
  control: CandidateBlockControl
): ResolvedCandidateBlockControl {
  const candidates = Object.freeze(
    control.candidates.map((spec, index) => resolveCandidateSpecDefaults(spec, index))
  );
  const budget: CandidateBlockBudget =
    control.budget?.mode === 'strict-usd'
      ? Object.freeze({ mode: 'strict-usd' as const, limitMicrousd: control.budget.limitMicrousd })
      : Object.freeze({ mode: 'count-only' as const });
  return Object.freeze({
    version: CONTROL_CONTRACT_VERSION,
    kind: 'candidate-block',
    candidates,
    availabilityPolicy: control.availabilityPolicy ?? DEFAULT_CANDIDATE_AVAILABILITY_POLICY,
    maxDispatches: resolveCandidateBlockMaxDispatches(control),
    monitoringWindowMs: control.monitoringWindowMs ?? DEFAULT_MONITORING_WINDOW_MS,
    budget
  });
}

export function resolveRepeatControlDefaults(control: RepeatControl): ResolvedRepeatControl {
  return Object.freeze({
    version: CONTROL_CONTRACT_VERSION,
    kind: 'repeat',
    maxIterations: control.maxIterations,
    until: control.until,
    carry: Object.freeze(control.carry.map((entry) => Object.freeze({ ...entry }))),
    onExhausted: control.onExhausted ?? DEFAULT_REPEAT_ON_EXHAUSTED
  });
}

export function resolveForEachControlDefaults(control: ForEachControl): ResolvedForEachControl {
  return Object.freeze({
    version: CONTROL_CONTRACT_VERSION,
    kind: 'for-each',
    collection: Object.freeze({ ...control.collection }),
    ...(control.itemKeyField !== undefined ? { itemKeyField: control.itemKeyField } : {}),
    itemInputPortId: control.itemInputPortId,
    maxItems: control.maxItems ?? DEFAULT_FOR_EACH_MAX_ITEMS,
    onItemError: control.onItemError ?? DEFAULT_FOR_EACH_ON_ITEM_ERROR
  });
}

export function deriveRootControlBudget(
  workflows: readonly { readonly control?: CandidateBlockControl }[]
): CandidateBlockBudget {
  let minStrictLimit: number | undefined;
  for (const wf of workflows) {
    if (wf.control?.budget?.mode === 'strict-usd') {
      const limit = wf.control.budget.limitMicrousd;
      if (minStrictLimit === undefined || limit < minStrictLimit) {
        minStrictLimit = limit;
      }
    }
  }
  if (minStrictLimit !== undefined) {
    return Object.freeze({ mode: 'strict-usd', limitMicrousd: minStrictLimit });
  }
  return Object.freeze({ mode: 'count-only' });
}
