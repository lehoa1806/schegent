import type { PhaseDefinitionEffort } from './process-definitions';

export const PIPELINE_DEFINITION_SCOPES = ['built-in', 'user', 'workspace'] as const;
export type PipelineDefinitionScope = (typeof PIPELINE_DEFINITION_SCOPES)[number];
export type WritablePipelineDefinitionScope = Exclude<PipelineDefinitionScope, 'built-in'>;

export const PIPELINE_WRITABLE_SCOPES = ['user', 'workspace'] as const;

export function isPipelineDefinitionScope(value: unknown): value is PipelineDefinitionScope {
  return (
    typeof value === 'string' &&
    (PIPELINE_DEFINITION_SCOPES as readonly string[]).includes(value)
  );
}

export function isWritablePipelineDefinitionScope(
  value: unknown
): value is WritablePipelineDefinitionScope {
  return typeof value === 'string' && (PIPELINE_WRITABLE_SCOPES as readonly string[]).includes(value);
}

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

export type PipelineSourceStatus = 'effective' | 'shadowed' | 'invalid';

export interface PipelineSourceRecord {
  readonly key: string;
  readonly pipelineId: string;
  readonly scope: PipelineDefinitionScope;
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
  readonly revisions: Readonly<Record<WritablePipelineDefinitionScope, string>>;
  readonly warnings: readonly PipelineCatalogWarning[];
}

export type PipelineCatalogMutation =
  | { readonly kind: 'create'; readonly pipelineId: string }
  | { readonly kind: 'edit'; readonly pipelineId: string }
  | {
      readonly kind: 'duplicate';
      readonly sourceScope: PipelineDefinitionScope;
      readonly sourcePipelineId: string;
      readonly pipelineId: string;
    }
  | { readonly kind: 'remove'; readonly pipelineId: string }
  | { readonly kind: 'reset' };

export interface ScopedPipelineSavePayload {
  readonly scope: WritablePipelineDefinitionScope;
  readonly expectedRevision: string;
  readonly mutation: PipelineCatalogMutation;
  readonly pipelines: readonly unknown[];
}
