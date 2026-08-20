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
//
// FR-R3-001 named that second tier `ExecutionEnvelope` and made it the thing the
// execution path reads, rather than a record the factory harvested one field
// from. `FrozenRunPlan` is retained as an alias of it, not as a sibling type.

import type { CatalogVersionRef } from './catalog-version';
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
 * What validation produces, the enqueue path consumes, and the execution path
 * executes — one value for all three (FR-R3-001, T256).
 *
 * Feature 087 froze `pipeline`, `inputs`, `supplemental`, `outputs` and
 * `instructions` together and then only ever read the first of them on the way
 * to the backend. The other four were frozen, persisted, and dropped at the
 * factory seam. The fix is not four more optional scalars on `PromptInputs` —
 * that closes today's gap and reopens it on the next field. It is this: one
 * envelope, constructed at one site, **consumed by reference**. A component
 * that needs part of the request takes the whole envelope; it does not copy
 * fields out of it, so adding a field here does not mean editing every
 * consumer. FR-R3-002's mandatory `queueId` is the next such field, and it
 * belongs here for exactly that reason.
 *
 * `pipeline` reuses `WorkflowRunPipeline` rather than introducing a parallel
 * snapshot type: it is already the expanded contract-plus-`PhaseDef[]` shape
 * that `snapshotPipelineContract()` produces and that a Run executes. A second
 * type for the same thing would be a second source of truth.
 *
 * Immutability is structural — every member is `readonly`, `validateRunRequest()`
 * is the only constructor, and no consumer holds a mutable alias — so an
 * in-flight envelope behaves exactly as the in-flight `pipeline` snapshot
 * already does under a catalog or task-row edit.
 */
export interface ExecutionEnvelope {
  readonly pipeline: WorkflowRunPipeline;
  readonly inputs: readonly FrozenInputBinding[];
  readonly supplemental: readonly FrozenSupplementalInput[];
  readonly outputs: readonly FrozenOutputRequest[];
  readonly instructions?: string;
  readonly frozenAt: number;
  /**
   * Feature 102 (T035, FR-021, FR-022) — which published version this plan froze.
   *
   * Resolved host-side at the freeze site and stamped here; `RunRequest` gains
   * nothing, which is FR-024 and a requirement rather than an omission. Optional
   * and additive, so a plan serialized before this feature deserializes unchanged
   * and no `STATE_SCHEMA_VERSION` moves.
   *
   * **Absent means "not recorded"** (FR-027), never an error and never `''`. Two
   * plans reach that state legitimately: one frozen before this feature, and one
   * frozen from a caller-supplied snapshot rather than from the effective catalog
   * — a version invented for either would be a version the system never resolved.
   */
  readonly catalogVersion?: CatalogVersionRef;
}

/**
 * The enqueue-path spelling of the same value (feature 087's name for it).
 *
 * Deliberately an alias rather than a second interface. The queue persists what
 * validation froze and the execution path executes what the queue persisted, so
 * there is one type, not three that happen to agree today. Two structurally
 * identical interfaces would let a field be added to one half and silently not
 * reach the other — which is the defect FR-R3-001 exists to close, rewritten.
 */
export type FrozenRunPlan = ExecutionEnvelope;

export type ValidationOutcome =
  | { readonly ok: true; readonly plan: ExecutionEnvelope }
  | { readonly ok: false; readonly errors: readonly RunRequestFieldError[] };
