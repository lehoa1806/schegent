import type {
  PhaseBinding,
  PipelineDefinition,
  PipelineFieldError,
  PipelineInputPort,
  PipelineOutputPort
} from '../contracts/pipeline-definitions';
import type { PhaseDefinition } from '../contracts/process-definitions';

const ERROR_MESSAGE_MAX = 512;
const ERROR_FIELD_MAX = 32;
const ERROR_CODE_MAX = 64;
const PIPELINE_ID_MAX_LEN = 64;

/** The single declared bridge from a Phase output into a later Phase input (research R4). */
const BRIDGE_INPUT_PORT_TYPE = 'pipeline-output';

function bounded(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function fieldError(
  pipelineId: string,
  field: string,
  code: string,
  message: string
): PipelineFieldError {
  return Object.freeze({
    pipelineId: bounded(pipelineId || '?', PIPELINE_ID_MAX_LEN),
    field: bounded(field, ERROR_FIELD_MAX),
    code: bounded(code, ERROR_CODE_MAX),
    message: bounded(message, ERROR_MESSAGE_MAX)
  });
}

interface BindingContext {
  readonly pipelineId: string;
  readonly phaseIds: readonly string[];
  readonly knownPhaseIds: ReadonlySet<string>;
  readonly inputsById: ReadonlyMap<string, PipelineInputPort>;
  readonly outputsById: ReadonlyMap<string, PipelineOutputPort>;
}

/**
 * Validates one Phase position reference: it must address a slot that exists in
 * the sequence, and that slot's Phase must resolve in the effective Phase catalog.
 */
function checkPhaseReference(
  context: BindingContext,
  phaseIndex: number,
  field: string,
  errors: PipelineFieldError[]
): boolean {
  if (phaseIndex < 0 || phaseIndex >= context.phaseIds.length) {
    errors.push(
      fieldError(
        context.pipelineId,
        field,
        'binding-phase-out-of-range',
        `Binding references position ${phaseIndex}, outside the ${context.phaseIds.length}-Phase sequence`
      )
    );
    return false;
  }
  const phaseId = context.phaseIds[phaseIndex] as string;
  if (!context.knownPhaseIds.has(phaseId)) {
    errors.push(
      fieldError(
        context.pipelineId,
        field,
        'binding-unknown-phase',
        `Phase '${bounded(phaseId, PIPELINE_ID_MAX_LEN)}' at position ${phaseIndex} has no effective definition`
      )
    );
    return false;
  }
  return true;
}

function checkOutputBinding(
  context: BindingContext,
  binding: Extract<PhaseBinding, { kind: 'output' }>,
  index: number,
  errors: PipelineFieldError[]
): void {
  checkPhaseReference(context, binding.phaseIndex, `bindings[${index}].phaseIndex`, errors);
  if (!context.outputsById.has(binding.portId)) {
    errors.push(
      fieldError(
        context.pipelineId,
        `bindings[${index}].portId`,
        'binding-unknown-output-port',
        `Binding writes to undeclared output port '${bounded(binding.portId, PIPELINE_ID_MAX_LEN)}'`
      )
    );
  }
}

function checkSessionInputSource(
  context: BindingContext,
  portId: string,
  index: number,
  errors: PipelineFieldError[]
): void {
  const field = `bindings[${index}].src.portId`;
  const port = context.inputsById.get(portId);
  if (!port) {
    errors.push(
      fieldError(
        context.pipelineId,
        field,
        'binding-unknown-input-port',
        `Binding reads from undeclared input port '${bounded(portId, PIPELINE_ID_MAX_LEN)}'`
      )
    );
    return;
  }
  if (port.type === BRIDGE_INPUT_PORT_TYPE) {
    errors.push(
      fieldError(
        context.pipelineId,
        field,
        'binding-type-mismatch',
        `Input port '${bounded(portId, PIPELINE_ID_MAX_LEN)}' is typed ${BRIDGE_INPUT_PORT_TYPE}, so it is fed by an earlier Phase and cannot be supplied at session start`
      )
    );
  }
}

function checkPhaseOutputSource(
  context: BindingContext,
  binding: Extract<PhaseBinding, { kind: 'input' }>,
  source: { readonly phaseIndex: number; readonly portId: string },
  index: number,
  errors: PipelineFieldError[]
): void {
  const indexField = `bindings[${index}].src.phaseIndex`;
  const inRange = checkPhaseReference(context, source.phaseIndex, indexField, errors);
  if (inRange && source.phaseIndex >= binding.phaseIndex) {
    errors.push(
      fieldError(
        context.pipelineId,
        indexField,
        'binding-forward-reference',
        `Position ${binding.phaseIndex} reads from position ${source.phaseIndex}, which is not strictly earlier in the sequence`
      )
    );
  }

  const portField = `bindings[${index}].src.portId`;
  const producing = context.outputsById.get(source.portId);
  if (!producing) {
    errors.push(
      fieldError(
        context.pipelineId,
        portField,
        'binding-unknown-output-port',
        `Binding reads from undeclared output port '${bounded(source.portId, PIPELINE_ID_MAX_LEN)}'`
      )
    );
  }

  const consuming = context.inputsById.get(source.portId);
  if (!consuming) {
    errors.push(
      fieldError(
        context.pipelineId,
        portField,
        'binding-unknown-input-port',
        `A Phase output consumed by a later Phase needs an input port '${bounded(source.portId, PIPELINE_ID_MAX_LEN)}' declared with type ${BRIDGE_INPUT_PORT_TYPE}`
      )
    );
    return;
  }
  if (consuming.type !== BRIDGE_INPUT_PORT_TYPE) {
    errors.push(
      fieldError(
        context.pipelineId,
        portField,
        'binding-type-mismatch',
        `Input port '${bounded(source.portId, PIPELINE_ID_MAX_LEN)}' is typed ${consuming.type}, but a Phase output is consumed only through an input port typed ${BRIDGE_INPUT_PORT_TYPE}`
      )
    );
  }
}

/**
 * Cross-reference validation for one Pipeline's bindings against the effective
 * Phase catalog (FR-011, FR-015, FR-016).
 *
 * Type compatibility is exact string equality on the two closed port-type unions
 * (research R4) — there is no widening or coercion matrix. `pipeline-output` is
 * the only declared Phase-output to Phase-input bridge.
 *
 * Pure: takes the resolved effective Phase catalog as an argument and never reads
 * configuration or imports `vscode`.
 */
export function validatePipelineBindings(
  definition: PipelineDefinition,
  effectivePhases: readonly PhaseDefinition[]
): readonly PipelineFieldError[] {
  const context: BindingContext = {
    pipelineId: definition.pipelineId,
    phaseIds: definition.phaseIds,
    knownPhaseIds: new Set(effectivePhases.map((phase) => phase.phaseId)),
    inputsById: new Map(definition.inputs.map((port) => [port.portId, port])),
    outputsById: new Map(definition.outputs.map((port) => [port.portId, port]))
  };

  const errors: PipelineFieldError[] = [];
  definition.bindings.forEach((binding, index) => {
    if (binding.kind === 'output') {
      checkOutputBinding(context, binding, index, errors);
      return;
    }
    checkPhaseReference(context, binding.phaseIndex, `bindings[${index}].phaseIndex`, errors);
    if (binding.source.from === 'pipeline-input') {
      checkSessionInputSource(context, binding.source.portId, index, errors);
      return;
    }
    checkPhaseOutputSource(context, binding, binding.source, index, errors);
  });
  return Object.freeze(errors);
}
