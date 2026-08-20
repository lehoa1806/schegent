// The transport shape of a `RunRequest`, in one place.
//
// Feature 087 (T011) wrote this rule inside `launch-pipeline.ts`, feature 088
// imported it from there rather than restating it, and feature 102 (T039) needs
// it in a third place: the `is*Payload` guards the wire contract registers in
// `COMMAND_GUARDS`. Those guards live under `contracts/sidebar-ipc/` and cannot
// import the validator module — `launch-pipeline.ts` needs `CMD_LAUNCH_PIPELINE`
// from the barrel, and the barrel imports the guards, so the edge would close a
// runtime cycle. So the rule moves down here, where it depends on neither.
//
// One rule, five consumers, and that is the point. FR-023 says a submitted
// `catalogVersion` is refused rather than dropped, and a refusal only holds if
// every boundary that answers for the same payload answers the same way. Two
// copies of "which keys may a request carry" is two answers waiting to diverge,
// and the divergence is invisible: whichever boundary is looser is the one an
// attacker reaches.
//
// What this file does NOT do: judge whether any value is *correct*. An unknown
// port, a missing required input, a target that escapes the workspace — all of
// those belong to `validateRunRequest()`, which reports every failing field at
// once (FR-013) where a boolean predicate can only say no.

import { PIPELINE_INPUT_PORT_TYPES } from '../pipeline-definitions';
import { hasUnexpectedKeys } from './shared';

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
 * The transport shape of a `RunRequest`, allowlisted at every depth.
 *
 * Every nested object states the keys it admits, not merely the keys it needs:
 * a request, each input, each supplemental item, a prior-output reference, and
 * each output. Feature 102 (FR-023, FR-024) rests on that being exhaustive — a
 * `catalogVersion` is resolved host-side and has no submitted form, so one on
 * the wire is refused wherever it appears rather than quietly stripped at the
 * one depth someone remembered to check.
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
