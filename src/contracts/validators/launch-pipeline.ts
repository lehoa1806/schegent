// Feature 087 (T011) — CMD_LAUNCH_PIPELINE ingress validator.
//
// This gate answers exactly one question: is the thing on the wire shaped like
// a `RunRequest`? It is deliberately blind to whether any value in it is
// *correct*. An unknown port, a missing required input, an over-long
// instruction, a target that escapes the workspace — every one of those must
// reach `validateRunRequest()` at gate 6, because FR-013 requires all failing
// fields in one response and FR-012 requires the limit and the actual length.
// A payload dropped here produces no field errors at all, so anything the
// operator can plausibly fix belongs downstream, not in this file.
//
// The one thing it does own is the transport contract, and the reason it exists
// is bulk-0 ledger B0-P01: feature 085 shipped a correct handler and a correct
// emitter, and the envelope never arrived because this layer had no arm for it.

import { CMD_LAUNCH_PIPELINE, type SidebarCommand } from '../sidebar-ipc';
import { PIPELINE_INPUT_PORT_TYPES } from '../pipeline-definitions';
import { fail, hasUnexpectedKeys, ok, type IpcValidationResult } from './shared';

const PORT_ID_MAX = 64;
const PIPELINE_ID_MAX = 64;

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function boundedId(value: unknown, max: number): value is string {
  return nonEmptyString(value) && value.length <= max;
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function validInput(value: unknown): boolean {
  const input = record(value);
  return input !== null
    && !hasUnexpectedKeys(input, ['portId', 'type', 'value'])
    && boundedId(input.portId, PORT_ID_MAX)
    && typeof input.type === 'string'
    && (PIPELINE_INPUT_PORT_TYPES as readonly string[]).includes(input.type)
    && typeof input.value === 'string';
}

function validSupplemental(value: unknown): boolean {
  const item = record(value);
  if (item === null) return false;
  switch (item.kind) {
    case 'local-file':
    case 'local-folder':
      return !hasUnexpectedKeys(item, ['kind', 'path']) && nonEmptyString(item.path);
    case 'url':
      return !hasUnexpectedKeys(item, ['kind', 'url']) && nonEmptyString(item.url);
    // Pasted text and free-form instructions may legitimately be empty while
    // the operator is composing; only their type is a transport concern.
    case 'text':
    case 'instruction':
      return !hasUnexpectedKeys(item, ['kind', 'text']) && typeof item.text === 'string';
    // FR-028a — structured data compared field-wise. There is no string form to
    // accept here, and accepting one would be the first half of a parser.
    case 'prior-output': {
      if (hasUnexpectedKeys(item, ['kind', 'reference'])) return false;
      const reference = record(item.reference);
      return reference !== null
        && !hasUnexpectedKeys(reference, ['sourceRunId', 'outputName'])
        && nonEmptyString(reference.sourceRunId)
        && nonEmptyString(reference.outputName);
    }
    default:
      return false;
  }
}

function validOutput(value: unknown): boolean {
  const output = record(value);
  return output !== null
    && !hasUnexpectedKeys(output, [
      'portId',
      'target',
      'overwriteConfirmed',
      'externalSideEffectConfirmed'
    ])
    && boundedId(output.portId, PORT_ID_MAX)
    // An empty target is FR-021's `output-target-missing`, reported as a field
    // error — so it is a string here, not a non-empty one.
    && typeof output.target === 'string'
    && optionalBoolean(output.overwriteConfirmed)
    && optionalBoolean(output.externalSideEffectConfirmed);
}

/**
 * The transport shape of a `RunRequest`, exported so the connected-run
 * validators reuse it rather than forking it (feature 088). A second copy of
 * this rule would drift, and the two commands carry the identical nested
 * object — a `RunRequest` composed against a Pipeline's contract.
 */
export function validRunRequest(value: unknown): boolean {
  const request = record(value);
  return request !== null
    && !hasUnexpectedKeys(request, [
      'pipelineId',
      'inputs',
      'supplemental',
      'outputs',
      'instructions'
    ])
    && boundedId(request.pipelineId, PIPELINE_ID_MAX)
    && Array.isArray(request.inputs)
    && request.inputs.every(validInput)
    && Array.isArray(request.supplemental)
    && request.supplemental.every(validSupplemental)
    && Array.isArray(request.outputs)
    && request.outputs.every(validOutput)
    && (request.instructions === undefined || typeof request.instructions === 'string');
}

export function validateLaunchPipeline(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = record(obj.payload);
  if (payload === null) {
    return fail('missing-payload', { type: CMD_LAUNCH_PIPELINE, correlationId });
  }
  if (hasUnexpectedKeys(payload, ['request']) || !validRunRequest(payload.request)) {
    return fail('invalid-payload', { type: CMD_LAUNCH_PIPELINE, correlationId });
  }
  return ok({
    type: CMD_LAUNCH_PIPELINE,
    correlationId,
    payload: { request: payload.request }
  } as SidebarCommand);
}
