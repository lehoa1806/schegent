// Feature 087 — the Run Request and the frozen plan it becomes.
//
// The type split IS the feature (spec FR-007, FR-009, research §1). A
// `RunRequest` is what the operator is composing: transient, identity-free,
// never persisted, never enqueued. A `FrozenRunPlan` is what validation
// produces: the expanded definition plus resolved inputs and output targets,
// immutable from the moment it exists.
//
// Nothing but `validateRunRequest()` constructs a `FrozenRunPlan`, and the
// enqueue path accepts nothing else, so "validation is the only thing that
// creates durable state for a Run" holds structurally rather than by
// convention. Validation returns the more precise type instead of a boolean —
// there is no `isValid` flag a later mutation can leave stale.

import type { PipelineInputPortType, PipelineOutputPortType } from './pipeline-definitions';
import type { WorkflowRunPipeline } from '../state/workflow-run';

// -- Tier 1: transient ------------------------------------------------------

/**
 * A named output of a completed Run, addressed as structured data compared
 * field-wise (FR-028a).
 *
 * There is deliberately no string form. The project's Workflow conditions
 * settled the same question the same way: a string, however simple, needs a
 * grammar, and a grammar needs an evaluator over operator-authored content.
 */
export interface PriorOutputReference {
  readonly sourceRunId: string;
  readonly outputName: string;
}

/**
 * Supplemental inputs are NOT part of the Pipeline's contract (FR-003). They
 * are the operator's extra material for this session, and they are presented in
 * their own section precisely so the contract section stays a faithful
 * projection of the Pipeline's declared ports.
 */
export type SupplementalInput =
  | { readonly kind: 'local-file'; readonly path: string }
  | { readonly kind: 'local-folder'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'instruction'; readonly text: string }
  | { readonly kind: 'prior-output'; readonly reference: PriorOutputReference };

export const SUPPLEMENTAL_INPUT_KINDS = [
  'local-file',
  'local-folder',
  'url',
  'text',
  'instruction',
  'prior-output'
] as const;

export type SupplementalInputKind = (typeof SUPPLEMENTAL_INPUT_KINDS)[number];

/** A value the operator supplied for one contract input port. */
export interface RunInputValue {
  readonly portId: string;
  readonly type: PipelineInputPortType;
  readonly value: string;
}

/** A target the operator named for one declared output port. */
export interface RunOutputTargetRequest {
  readonly portId: string;
  /** Workspace-relative. An absolute path never crosses the IPC boundary. */
  readonly target: string;
  readonly overwriteConfirmed?: boolean;
  readonly externalSideEffectConfirmed?: boolean;
}

/**
 * The value being composed. Has no identity and is never written anywhere
 * (FR-007). It names its Pipeline by identifier only — no catalog layer, no
 * embedded copy of the definition (FR-008), so the definition that runs is
 * always the one the effective catalog resolves.
 */
export interface RunRequest {
  readonly pipelineId: string;
  readonly inputs: readonly RunInputValue[];
  readonly supplemental: readonly SupplementalInput[];
  readonly outputs: readonly RunOutputTargetRequest[];
  readonly instructions?: string;
}

// -- Validation outcome -----------------------------------------------------

export const RUN_REQUEST_ERROR_CODES = [
  'missing-required-input',
  'unknown-input-port',
  'phase-fed-input-port',
  'type-mismatch',
  'instructions-too-long',
  'path-escapes-workspace',
  'symlink-limit-exceeded',
  'file-not-found',
  'file-unreadable',
  'folder-file-count-exceeded',
  'folder-bytes-exceeded',
  'folder-extension-not-allowed',
  'url-malformed',
  'url-scheme-not-allowed',
  'output-target-missing',
  'output-target-duplicate',
  'output-overwrite-unconfirmed',
  'output-side-effect-unconfirmed',
  'unknown-output-port',
  'prior-run-not-found',
  'prior-output-not-found',
  'no-workspace-root'
] as const;

export type RunRequestErrorCode = (typeof RUN_REQUEST_ERROR_CODES)[number];

/**
 * A single failing field. `field` names the offending input, and the message
 * never carries a resolved absolute path (FR-020, SC-005) — an operator who
 * mistyped a path needs to know which field, not where the host looked.
 */
export interface RunRequestFieldError {
  readonly field: string;
  readonly code: RunRequestErrorCode;
  readonly message: string;
  readonly limit?: number;
  readonly actual?: number;
}

// -- Tier 2: frozen ---------------------------------------------------------

export interface FrozenInputBinding {
  readonly portId: string;
  readonly type: PipelineInputPortType;
  readonly value: string;
}

export interface FrozenSupplementalInput {
  readonly kind: SupplementalInputKind;
  /** Workspace-relative path, URL, or literal text, by kind. */
  readonly value: string;
  readonly reference?: PriorOutputReference;
}

export interface FrozenOutputRequest {
  readonly portId: string;
  readonly type: PipelineOutputPortType;
  readonly target: string;
  readonly overwriteConfirmed: boolean;
}

/**
 * What validation produces and the enqueue path consumes.
 *
 * `pipeline` reuses `WorkflowRunPipeline` rather than introducing a parallel
 * snapshot type: it is already the expanded contract-plus-`PhaseDef[]` shape
 * that `snapshotPipelineContract()` produces and that a Run executes. A second
 * type for the same thing would be a second source of truth.
 */
export interface FrozenRunPlan {
  readonly pipeline: WorkflowRunPipeline;
  readonly inputs: readonly FrozenInputBinding[];
  readonly supplemental: readonly FrozenSupplementalInput[];
  readonly outputs: readonly FrozenOutputRequest[];
  readonly instructions?: string;
  readonly frozenAt: number;
}

export type ValidationOutcome =
  | { readonly ok: true; readonly plan: FrozenRunPlan }
  | { readonly ok: false; readonly errors: readonly RunRequestFieldError[] };
