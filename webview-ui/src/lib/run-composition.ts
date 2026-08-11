// Feature 088 (T045) — what a composed run IS, in one place.
//
// Extracted from `RunLauncher.svelte` when the connected-run continuation grew a
// second composer. The two surfaces differ in exactly two ways — which command
// they post, and which Pipeline they render — and in no other, so the assembly of
// a `RunRequest` out of four sections belongs here rather than in each of them.
// A second copy would be a second place that decides what a composition is: one
// that could omit a field, order the supplemental entries differently, or map an
// indexed refusal back to the wrong control.
//
// Nothing here validates. `validateRunRequest()` host-side owns every field rule
// and reports every failing field at once; a webview pre-check would be a second
// oracle that disagrees with the authoritative one the moment either moves. What
// this module does is decide what to *send*, which is a different question — an
// empty control contributes no entry, because a blank field is nothing typed
// rather than an empty value the host should refuse.

import type {
  PipelineInputPort,
  PipelineOutputPort
} from './snapshot-types';
import type {
  RunInputValue,
  RunOutputTargetRequest,
  RunRequest,
  RunRequestFieldError,
  SupplementalInput
} from '../../../src/contracts/run-request';

/** Declared by a port that an earlier Phase feeds, never the operator (FR-001a). */
export const PHASE_FED_PORT_TYPE = 'pipeline-output';

/** The operator-facing subset of a Pipeline's declared inputs. */
export function operatorPorts(
  ports: readonly PipelineInputPort[] | undefined
): readonly PipelineInputPort[] {
  return (ports ?? []).filter((port) => port.type !== PHASE_FED_PORT_TYPE);
}

/** Whitespace-only is nothing typed; the raw value is what gets sent. */
export function filled(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

export interface CompositionState {
  readonly pipelineId: string;
  readonly inputPorts: readonly PipelineInputPort[];
  readonly outputPorts: readonly PipelineOutputPort[];
  readonly inputValues: Record<string, string>;
  readonly supplementalValues: Record<string, string>;
  readonly outputTargets: Record<string, string>;
  readonly sideEffectConfirmed: Record<string, boolean>;
  readonly overwriteConfirmed: Record<string, boolean>;
}

export interface Composition {
  readonly request: RunRequest;
  /** Which control produced each supplemental entry, in emission order. */
  readonly supplementalKeys: readonly string[];
}

/**
 * Assemble the one `RunRequest` that goes on the wire.
 *
 * The supplemental entries are emitted in the section's declaration order, and
 * `supplementalKeys` records that order, because the host addresses a supplemental
 * refusal by position — there is no port to name it by — and the view has to map it
 * back to the control the operator used.
 */
export function composeRunRequest(state: CompositionState): Composition {
  const inputs: RunInputValue[] = state.inputPorts
    .filter((port) => filled(state.inputValues[port.portId]))
    .map((port) => ({
      portId: port.portId,
      type: port.type,
      value: state.inputValues[port.portId]!
    }));

  const supplemental: SupplementalInput[] = [];
  const supplementalKeys: string[] = [];
  const add = (key: string, item: SupplementalInput): void => {
    supplemental.push(item);
    supplementalKeys.push(key);
  };

  const localFile = state.supplementalValues['local-file'];
  if (filled(localFile)) add('local-file', { kind: 'local-file', path: localFile });
  const localFolder = state.supplementalValues['local-folder'];
  if (filled(localFolder)) add('local-folder', { kind: 'local-folder', path: localFolder });
  const url = state.supplementalValues['url'];
  if (filled(url)) add('url', { kind: 'url', url });
  const text = state.supplementalValues['text'];
  if (filled(text)) add('text', { kind: 'text', text });
  const sourceRunId = state.supplementalValues['prior-run'];
  const outputName = state.supplementalValues['prior-output'];
  // Half a reference addresses nothing, so it is not sent: the operator is
  // mid-typing, not making a request the host should refuse.
  if (filled(sourceRunId) && filled(outputName)) {
    add('prior-output', { kind: 'prior-output', reference: { sourceRunId, outputName } });
  }

  const outputs: RunOutputTargetRequest[] = state.outputPorts
    .filter((port) => filled(state.outputTargets[port.portId]))
    .map((port) => ({
      portId: port.portId,
      target: state.outputTargets[port.portId]!,
      ...(state.overwriteConfirmed[port.portId] ? { overwriteConfirmed: true } : {}),
      ...(state.sideEffectConfirmed[port.portId] ? { externalSideEffectConfirmed: true } : {})
    }));

  const instructions = state.supplementalValues['instruction'];

  return {
    request: {
      pipelineId: state.pipelineId,
      inputs,
      supplemental,
      outputs,
      ...(filled(instructions) ? { instructions } : {})
    },
    supplementalKeys
  };
}

/** Port- and field-addressed refusals, rendered against their own control. */
export function errorsByField(
  errors: readonly RunRequestFieldError[]
): ReadonlyMap<string, string> {
  return new Map(errors.map((error) => [error.field, error.message] as const));
}

/**
 * Supplemental refusals arrive addressed by position, so they are mapped back to
 * the control that produced each one. The instruction limit rides along here: it
 * is reported against the request's own `instructions` field, and the control the
 * operator used for it lives in that section.
 */
export function supplementalErrors(
  errors: readonly RunRequestFieldError[],
  submittedKeys: readonly string[]
): ReadonlyMap<string, string> {
  const mapped = new Map<string, string>();
  for (const error of errors) {
    if (error.field === 'instructions') {
      mapped.set('instruction', error.message);
      continue;
    }
    const match = /^supplemental\[(\d+)\]$/.exec(error.field);
    if (!match) continue;
    const key = submittedKeys[Number(match[1])];
    if (key !== undefined) mapped.set(key, error.message);
  }
  return mapped;
}

/** Ports the host refused for want of an overwrite confirmation (FR-023). */
export function overwriteRequestedPorts(
  errors: readonly RunRequestFieldError[]
): ReadonlySet<string> {
  return new Set(
    errors
      .filter((error) => error.code === 'output-overwrite-unconfirmed')
      .map((error) => error.field.slice('outputs.'.length))
  );
}
