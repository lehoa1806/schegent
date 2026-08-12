// Feature 089 T008 — boundary argument validation for the process entrypoints.
// Contract: specs/089-headless-parity-qualification/contracts/headless-api.md §5
//
// The rule this module exists to keep is negative: it declares **no bound of its
// own** for a value class `src/contracts/runtime-validators.ts` already bounds
// (FR-015, FR-037). Where an argument is the payload of an existing IPC command,
// the check IS that command's existing validator, called with the same payload —
// so a bound widened in one place cannot leave a headless caller held to the old
// one, and a bound tightened cannot leave a headless caller held to nothing.
//
// What is left is what the wire boundary does not check because the wire cannot
// express it: an argument that arrives as a live object rather than as JSON.
// `bytes` is the whole of that set — a `Uint8Array` never crosses `postMessage`,
// so no existing validator has ever had to recognize one.
//
// This module imports no editor host API (FR-007). It performs no I/O, reads no
// configuration, and retains nothing.

import { validRunRequest } from '../contracts/validators/launch-pipeline';
import { validateExportProcessYaml } from '../contracts/validators/process-yaml';
import { QUEUE_ID_MAX } from '../contracts/validators/shared';
import { validateContinueWorkflow } from '../contracts/validators/workflow-run';

/**
 * Why an argument was refused.
 *
 * Deliberately a closed set of *shape* words. A code here says what was wrong
 * with the argument, never what the argument was: `'wrong-type'` and not
 * `'expected Uint8Array, received "/Users/…"'`, because the second sentence is a
 * location leak waiting for an operator to paste a path into the wrong field.
 */
export type BoundaryErrorCode = 'missing' | 'wrong-type' | 'unsupported-value' | 'malformed';

/**
 * The boundary's own refusal — §5's "a field id and a limit, never a value and
 * never a location", enforced by there being nowhere to put either.
 *
 * This is not an operation result and does not compete with one (R4). Every
 * entrypoint returns its service's existing wire result *or* this, and the two
 * are distinguishable by `outcome` because no wire result declares
 * `'rejected-argument'`. It is declared here, once, rather than per entrypoint:
 * six copies of a four-member refusal is the duplication this feature exists to
 * prevent, at the smallest scale it can occur.
 */
export interface BoundaryRefusal {
  readonly outcome: 'rejected-argument';
  readonly field: string;
  readonly code: BoundaryErrorCode;
  readonly limit?: number;
}

function refuse(field: string, code: BoundaryErrorCode): BoundaryRefusal {
  return { outcome: 'rejected-argument', field, code };
}

/** The only correlation id a headless call has: it is not on a message channel. */
const NO_CORRELATION = '';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * §1 — `kind` is one of the closed set and `definition` is an object.
 *
 * The catalog is not checked here. It is the caller's effective catalog, and an
 * empty or partial one is a legitimate input whose consequences the validators
 * below report as defects — refusing it at the boundary would turn "this
 * Pipeline references a Phase you do not have" into an argument error.
 */
export function checkDefinitionArgs(input: {
  readonly kind: unknown;
  readonly definition: unknown;
}): BoundaryRefusal | null {
  if (input.kind !== 'phase' && input.kind !== 'pipeline' && input.kind !== 'workflow') {
    return refuse('kind', 'unsupported-value');
  }
  if (!isRecord(input.definition)) return refuse('definition', 'wrong-type');
  return null;
}

/**
 * §2 — `bytes` is a `Uint8Array`.
 *
 * No length is checked. The 1 MiB bound belongs to the scanner and is applied
 * there, before the scanner is entered; a second copy here would be the new
 * bound FR-015 forbids, and would drift the moment the scanner's changed.
 */
export function checkDocumentBytes(bytes: unknown): BoundaryRefusal | null {
  if (bytes === undefined || bytes === null) return refuse('bytes', 'missing');
  if (!(bytes instanceof Uint8Array)) return refuse('bytes', 'wrong-type');
  return null;
}

/**
 * §2 — the export selection, checked by the export command's own validator.
 *
 * Composed rather than restated: `validateExportProcessYaml` owns the per-kind id
 * bound, the closed `resourceKind` set, and the kind/inclusion discrimination
 * that makes `inclusion` required for a Pipeline and refused for a Phase.
 */
export function checkExportSelection(selection: unknown): BoundaryRefusal | null {
  const result = validateExportProcessYaml({ payload: selection }, NO_CORRELATION);
  return result.ok ? null : refuse('selection', 'malformed');
}

/** §3 — the run request, by the launch command's own transport predicate. */
export function checkRunRequest(request: unknown): BoundaryRefusal | null {
  return validRunRequest(request) ? null : refuse('request', 'malformed');
}

/**
 * §4 — the continuation arguments, by the continue command's own validator.
 *
 * This is the whole of gate 0 for a continuation: the run id bound, the
 * non-negative integer revision, the node id bound, and the nested run request
 * are all the wire validator's, unchanged. `workspaceRoot` and `startedAt` are
 * not part of it, because they are values the caller resolves rather than
 * values the caller composes.
 */
export function checkContinuationArgs(payload: unknown): BoundaryRefusal | null {
  const result = validateContinueWorkflow({ payload }, NO_CORRELATION);
  return result.ok ? null : refuse('payload', 'malformed');
}

/** Shared by the two entrypoints that take a caller-resolved root. */
export function checkWorkspaceRoot(workspaceRoot: unknown): BoundaryRefusal | null {
  if (workspaceRoot === null || typeof workspaceRoot === 'string') return null;
  return refuse('workspaceRoot', 'wrong-type');
}

/**
 * Feature 092 (T062, FR-034) — §3's queue id, held to the wire's own bound.
 *
 * `QUEUE_ID_MAX` is imported rather than restated, per this module's rule: the
 * bound belongs to the validators that already own it, and a headless caller
 * must not be held to a different one than a webview caller sending the same
 * id. Absence is valid and means the default queue — the entrance takes a
 * parameter and asks nothing.
 */
export function checkQueueId(queueId: unknown): BoundaryRefusal | null {
  if (queueId === undefined) return null;
  if (typeof queueId !== 'string') return refuse('queueId', 'wrong-type');
  if (queueId.length === 0 || queueId.length > QUEUE_ID_MAX) {
    return { outcome: 'rejected-argument', field: 'queueId', code: 'unsupported-value', limit: QUEUE_ID_MAX };
  }
  return null;
}
