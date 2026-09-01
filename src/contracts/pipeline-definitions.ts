import type { PhaseDefinitionEffort } from './process-definitions';

/** How long a Pipeline id may be. See `PHASE_ID_MAX_LEN` for why it lives here. */
export const PIPELINE_ID_MAX_LEN = 64;

/**
 * FR-R3-128 (T1485) — moved here from `src/services/process-yaml/types.ts`.
 *
 * `src/contracts/sidebar-ipc/process-yaml.ts` imported it from a **services**
 * module, which `dependency-direction.test.ts` carried as a dated exception:
 * "a bound is contract-shaped". It is, and it now sits beside
 * `PIPELINE_ID_MAX_LEN`, which bounds the same kind of thing for the same
 * consumers. The exception is deleted rather than renewed.
 *
 * MOVED, NOT COPIED. A second copy of a bound is how two copies come to disagree
 * about what a valid model id is.
 *
 * Longer than the other kinds' uniform 64 on purpose: a model id is a free-form
 * provider string, not a slug.
 *
 * NOT THE SAME CONSTANT as the module-private `MODEL_ID_MAX_LEN = 64` in
 * `src/config/pipeline-catalog.ts`. Two constants share the name and bound
 * different things — that one truncates a model id for a warning MESSAGE, this one
 * validates a Model Catalog document. FR-R3-128 recorded the collision rather than
 * tidying it into agreement, because making them equal would change one of the two
 * behaviours to make a name look consistent.
 */
export const MODEL_ID_MAX_LEN = 128;

/**
 * Closed union of session-input port types (FR-012). `pipeline-output` is the
 * declared type an input port uses when an earlier Phase's output feeds it
 * rather than the operator at session start.
 */
export const PIPELINE_INPUT_PORT_TYPES = [
  'text',
  'source',
  'source-list',
  'local-file',
  'local-folder',
  'web-url',
  'pipeline-output',
  'repository-context'
] as const;
export type PipelineInputPortType = (typeof PIPELINE_INPUT_PORT_TYPES)[number];

/** Closed union of declared artifact types a Pipeline produces (FR-013). */
export const PIPELINE_OUTPUT_PORT_TYPES = [
  'markdown',
  'file',
  'file-set',
  'structured-data',
  'run-request',
  'external-reference'
] as const;
export type PipelineOutputPortType = (typeof PIPELINE_OUTPUT_PORT_TYPES)[number];

export function isPipelineInputPortType(value: unknown): value is PipelineInputPortType {
  return typeof value === 'string' && (PIPELINE_INPUT_PORT_TYPES as readonly string[]).includes(value);
}

export function isPipelineOutputPortType(value: unknown): value is PipelineOutputPortType {
  return (
    typeof value === 'string' && (PIPELINE_OUTPUT_PORT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * The two authored spellings of a Pipeline's phase list, in precedence order.
 *
 * `phaseIds` is portable and wins; `phases` is the legacy key. The validator refuses
 * a body carrying both as `sequence-ambiguous`, so precedence only ever decides what
 * to SHOW for a row that is already invalid.
 *
 * Declared here because both a host reader and the Builder's repair path have to
 * agree with the validator about which key they are looking at. They each read one
 * spelling before this existed, and it was the wrong one for a row authored the
 * portable way.
 */
export const AUTHORED_PHASE_SEQUENCE_KEYS = ['phaseIds', 'phases'] as const;

function stringsAt(source: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return (value as readonly unknown[]).filter((entry): entry is string => typeof entry === 'string');
}

/**
 * The phase list an authored body declares, best-effort, by the validator's own
 * precedence.
 *
 * For a row with no parsed definition, where `display` is the only record of what the
 * operator typed. Empty when neither spelling holds a list.
 */
export function authoredPhaseSequence(
  source: Readonly<Record<string, unknown>>
): readonly string[] {
  for (const key of AUTHORED_PHASE_SEQUENCE_KEYS) {
    const ids = stringsAt(source, key);
    if (ids.length > 0) return ids;
  }
  return [];
}

/**
 * Where `phaseId` sits in whichever authored spelling names it, or `-1`.
 *
 * BOTH spellings are searched, not just the winning one, and that is deliberate: an
 * ambiguous body is invalid, the operator resolves it by deleting one of the two
 * keys, and either key may be the one that survives. A reference found only in the
 * loser is still a reference that goes live the moment they choose it — which is the
 * whole reason an invalid Pipeline blocks deleting the Phases it names.
 */
export function authoredPhasePosition(
  source: Readonly<Record<string, unknown>>,
  phaseId: string
): number {
  for (const key of AUTHORED_PHASE_SEQUENCE_KEYS) {
    const position = stringsAt(source, key).indexOf(phaseId);
    if (position !== -1) return position;
  }
  return -1;
}

export interface PipelineInputPort {
  readonly portId: string;
  readonly label: string;
  readonly type: PipelineInputPortType;
  readonly required?: boolean;
  readonly description?: string;
}

export interface PipelineOutputPort {
  readonly portId: string;
  readonly label: string;
  readonly type: PipelineOutputPortType;
  readonly description?: string;
}

/**
 * Bindings address a Phase *position* rather than a bare `phaseId` because
 * `phaseIds` may repeat the same Phase (research R3).
 */
export interface PhaseInputBinding {
  readonly kind: 'input';
  readonly phaseIndex: number;
  readonly inputKey: string;
  readonly source:
    | { readonly from: 'pipeline-input'; readonly portId: string }
    | { readonly from: 'phase-output'; readonly phaseIndex: number; readonly portId: string };
}

export interface PhaseOutputBinding {
  readonly kind: 'output';
  readonly phaseIndex: number;
  readonly portId: string;
  readonly outputKey: string;
}

export type PhaseBinding = PhaseInputBinding | PhaseOutputBinding;

/** Advisory Run-creation defaults; host-owned runtime policy is not authorable here (FR-018). */
export interface PipelineExecutionDefaults {
  readonly runner?: string;
  readonly model?: string;
  readonly effort?: PhaseDefinitionEffort;
  readonly timeoutSeconds?: number;
}

export interface PipelineDefinition {
  readonly pipelineId: string;
  readonly name: string;
  readonly description?: string;
  readonly version: number;
  readonly phaseIds: readonly string[];
  readonly inputs: readonly PipelineInputPort[];
  readonly outputs: readonly PipelineOutputPort[];
  readonly bindings: readonly PhaseBinding[];
  readonly executionDefaults?: PipelineExecutionDefaults;
  readonly recommendedNext: readonly string[];
}

export interface PipelineFieldError {
  readonly pipelineId: string;
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/** Feature 099 (FR-040) — two arms. See `PhaseSourceStatus` for why `shadowed` is gone. */
export type PipelineSourceStatus = 'effective' | 'invalid';

export interface PipelineSourceRecord {
  readonly key: string;
  readonly pipelineId: string;
  readonly status: PipelineSourceStatus;
  readonly definition: PipelineDefinition | null;
  /** Recognized authored fields only. This host-internal value is sanitized before IPC. */
  readonly display: Readonly<Record<string, unknown>>;
  readonly errors: readonly PipelineFieldError[];
}

export interface PipelineCatalogWarning {
  readonly code: string;
  readonly message: string;
}

export interface PipelineCatalogResolution {
  readonly records: readonly PipelineSourceRecord[];
  readonly effective: readonly PipelineDefinition[];
  /** One revision for the one layer (FR-044), derived from the store's manifest (FR-044a). */
  readonly revision: string;
  readonly warnings: readonly PipelineCatalogWarning[];
}

export type PipelineCatalogMutation =
  | { readonly kind: 'create'; readonly pipelineId: string }
  /**
   * Feature 085 (FR-036, FR-044) — the Pipeline half of one confirmed package
   * import, and the second of the two writes it performs (FR-038). Named ids
   * keep the version their document declared; every other row echoes its
   * current version as usual. Mirrors `PhaseCatalogMutation['import-package']`.
   */
  | { readonly kind: 'import-package'; readonly pipelineIds: readonly string[] }
  | { readonly kind: 'edit'; readonly pipelineId: string }
  | {
      readonly kind: 'duplicate';
      readonly sourcePipelineId: string;
      readonly pipelineId: string;
    }
  | { readonly kind: 'remove'; readonly pipelineId: string }
  | { readonly kind: 'reset' };

/** One save against the one layer. Formerly `ScopedPipelineSavePayload` (FR-043). */
export interface PipelineSavePayload {
  readonly expectedRevision: string;
  readonly mutation: PipelineCatalogMutation;
  readonly pipelines: readonly unknown[];
}
