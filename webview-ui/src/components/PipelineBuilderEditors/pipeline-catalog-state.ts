// Feature 082 (US1, T029) — Pipeline Builder draft state.
//
// Plain TypeScript so it is unit-testable without a DOM: the Svelte editor owns
// rendering and event wiring, this module owns the draft shape, dirty tracking,
// client-side pre-flight validation, and the mutation rebase.
//
// The host remains authoritative. Everything here is advisory — a draft that
// passes `validatePipelineDraft` can still be rejected by the host validator,
// and the editor must always surface the host's field errors as well.
//
// Authored rows persist under the legacy `id` / `phases` keys, so
// `MutablePipeline` and `toSavePipelineRow` both speak that key form even
// though the projection speaks `pipelineId` / `phaseIds`.

import type {
  PhaseBinding,
  PipelineCatalogMutation,
  PipelineCatalogSourceRecord
} from '../../lib/snapshot-types';
import type { SavePipelineRow } from '../../lib/save-pipelines';
import type { MutablePipeline } from './types';

export const PIPELINE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const PIPELINE_NAME_MAX_LEN = 80;
export const PIPELINE_DESCRIPTION_MAX_LEN = 1024;
export const PIPELINE_PORT_LABEL_MAX_LEN = 80;

export interface PipelineDraftError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function cloneBinding(binding: PhaseBinding): PhaseBinding {
  return binding.kind === 'output'
    ? { ...binding }
    : { ...binding, source: { ...binding.source } };
}

/**
 * Projects one catalog record into an editable row. An invalid record has no
 * `definition`, so the operator's own authored scalars in `display` are the only
 * thing left to show them — falling back to an empty row would silently discard
 * what they typed.
 */
export function sourceRecordToMutablePipeline(
  record: PipelineCatalogSourceRecord
): MutablePipeline {
  const definition = record.definition;
  const display = record.display;
  const displayPhases = Array.isArray(display.phases)
    ? (display.phases as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : [];
  const description =
    definition?.description ??
    (typeof display.description === 'string' ? display.description : undefined);
  return {
    id: definition?.pipelineId ?? record.pipelineId,
    name: definition?.name ?? text(display.name, 'Invalid Pipeline'),
    ...(description !== undefined ? { description } : {}),
    version: definition?.version ?? (typeof display.version === 'number' ? display.version : 1),
    phases: definition ? [...definition.phaseIds] : displayPhases,
    inputs: definition ? definition.inputs.map((port) => ({ ...port })) : [],
    outputs: definition ? definition.outputs.map((port) => ({ ...port })) : [],
    bindings: definition ? definition.bindings.map(cloneBinding) : [],
    ...(definition?.executionDefaults !== undefined
      ? { executionDefaults: { ...definition.executionDefaults } }
      : {}),
    recommendedNext: definition ? [...definition.recommendedNext] : [],
    sourceKey: record.key,
    sourceStatus: record.status,
    sourceErrors: record.errors,
    persisted: true
  };
}

/** Legacy authored key form; see the module header. */
export function toSavePipelineRow(pipeline: MutablePipeline): SavePipelineRow {
  return {
    id: pipeline.id,
    name: pipeline.name,
    version: pipeline.version,
    phases: [...pipeline.phases],
    ...(typeof pipeline.description === 'string' && pipeline.description.length > 0
      ? { description: pipeline.description }
      : {}),
    ...(pipeline.inputs.length > 0
      ? { inputs: pipeline.inputs.map((port) => ({ ...port })) }
      : {}),
    ...(pipeline.outputs.length > 0
      ? { outputs: pipeline.outputs.map((port) => ({ ...port })) }
      : {}),
    ...(pipeline.bindings.length > 0 ? { bindings: pipeline.bindings.map(cloneBinding) } : {}),
    ...(pipeline.executionDefaults !== undefined
      ? { executionDefaults: { ...pipeline.executionDefaults } }
      : {}),
    ...(pipeline.recommendedNext.length > 0
      ? { recommendedNext: [...pipeline.recommendedNext] }
      : {})
  };
}

function uniqueId(base: string, taken: readonly MutablePipeline[]): string {
  let candidate = base;
  let suffix = 1;
  while (taken.some((row) => row.id === candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

export function makeNewPipelineDraft(
  pipelines: readonly MutablePipeline[]
): MutablePipeline {
  const id = uniqueId('new-pipeline', pipelines);
  return {
    id,
    name: 'New Pipeline',
    version: 1,
    phases: [],
    inputs: [],
    outputs: [],
    bindings: [],
    recommendedNext: [],
    sourceKey: `draft::${id}`,
    // Feature 099 (T494a, FR-043) — see `makeNewPhaseDraft`: a draft is
    // `effective`, and `persisted: false` is what marks it unsaved.
    sourceStatus: 'effective',
    sourceErrors: [],
    persisted: false
  };
}

/**
 * Svelte state rows are reactive proxies and cannot be passed to
 * structuredClone, so every nested collection is copied explicitly. This also
 * lets duplication work from live UI state, not just from a projection record.
 */
export function makeDuplicatePipelineDraft(
  original: MutablePipeline,
  pipelines: readonly MutablePipeline[]
): MutablePipeline {
  const id = uniqueId(`${original.id}-copy`, pipelines);
  return {
    ...original,
    id,
    name: `${original.name || 'Untitled Pipeline'} (Copy)`,
    version: 1,
    phases: [...original.phases],
    inputs: original.inputs.map((port) => ({ ...port })),
    outputs: original.outputs.map((port) => ({ ...port })),
    bindings: original.bindings.map(cloneBinding),
    ...(original.executionDefaults !== undefined
      ? { executionDefaults: { ...original.executionDefaults } }
      : {}),
    recommendedNext: [...original.recommendedNext],
    sourceKey: `draft::${id}`,
    sourceStatus: 'effective',
    sourceErrors: [],
    persisted: false
  };
}

/**
 * Feature 082 (US2, T034) — move one Phase reference to a new position.
 *
 * Bindings address a Phase *position* rather than a bare `phaseId` (research
 * R3), so both endpoints — the owning `phaseIndex` and a `phase-output`
 * source's `phaseIndex` — are remapped through the same old→new index map the
 * move produces. Skipping the remap would spuriously invalidate every binding
 * that survived the reorder, which is exactly what US2 must not do.
 *
 * Out-of-range or identical positions return an equivalent row rather than
 * throwing: the editor's move controls are already bounded, and a defensive
 * no-op keeps a stray keyboard repeat from corrupting the draft.
 */
export function reorderPipelinePhases(
  pipeline: MutablePipeline,
  from: number,
  to: number
): MutablePipeline {
  const length = pipeline.phases.length;
  const inRange = (index: number): boolean => Number.isInteger(index) && index >= 0 && index < length;
  if (!inRange(from) || !inRange(to) || from === to) {
    return { ...pipeline, phases: [...pipeline.phases], bindings: pipeline.bindings.map(cloneBinding) };
  }
  const phases = [...pipeline.phases];
  const [moved] = phases.splice(from, 1);
  phases.splice(to, 0, moved);
  // Old position → new position. Built by replaying the same splice on the
  // identity permutation so the map can never drift from the move above.
  const permutation = Array.from({ length }, (_value, index) => index);
  const [movedIndex] = permutation.splice(from, 1);
  permutation.splice(to, 0, movedIndex);
  const remapped = new Map(permutation.map((oldIndex, newIndex) => [oldIndex, newIndex]));
  const remap = (index: number): number => remapped.get(index) ?? index;
  const bindings = pipeline.bindings.map((binding) =>
    binding.kind === 'output'
      ? { ...binding, phaseIndex: remap(binding.phaseIndex) }
      : {
          ...binding,
          phaseIndex: remap(binding.phaseIndex),
          source:
            binding.source.from === 'phase-output'
              ? { ...binding.source, phaseIndex: remap(binding.source.phaseIndex) }
              : { ...binding.source }
        }
  );
  return { ...pipeline, phases, bindings };
}

function targetIndex(
  rows: readonly MutablePipeline[],
  sourceKey: string | null,
  pipelineId: string
): number {
  const exact = rows.findIndex((row) => row.sourceKey === sourceKey);
  if (exact >= 0) return exact;
  const candidates = rows.flatMap((row, index) => (row.id === pipelineId ? [index] : []));
  return candidates.length === 1 ? candidates[0] : -1;
}

/**
 * Reapply only the declared local mutation over a freshly projected catalog.
 * Used after a `stale-catalog` rejection so a concurrent edit elsewhere in the
 * catalog survives instead of being clobbered by the operator's whole draft.
 */
export function rebasePipelineMutation(
  records: readonly PipelineCatalogSourceRecord[],
  draftRows: readonly MutablePipeline[],
  mutation: PipelineCatalogMutation,
  sourceKey: string | null
): MutablePipeline[] {
  const fresh = records.map(sourceRecordToMutablePipeline);
  // Feature 099 (T494a, FR-043) — a reset empties the catalog; see
  // `rebasePhaseMutation`.
  if (mutation.kind === 'reset') return [];
  // Feature 085 — a package import owns no draft row in this editor: the import
  // surface holds the plan, and a rejected package is recovered by inspecting the
  // same document again (FR-042b), not by rebasing a draft that does not exist.
  // The fresh projection IS the answer.
  if (mutation.kind === 'import-package') return fresh;
  if (mutation.kind === 'remove') {
    const removal = targetIndex(fresh, sourceKey, mutation.pipelineId);
    return removal < 0 ? fresh : fresh.filter((_unused, index) => index !== removal);
  }
  const draftTarget = targetIndex(draftRows, sourceKey, mutation.pipelineId);
  if (draftTarget < 0) return fresh;
  const draft = draftRows[draftTarget];
  if (mutation.kind === 'create' || mutation.kind === 'duplicate') return [...fresh, draft];
  const freshTarget = targetIndex(fresh, sourceKey, mutation.pipelineId);
  if (freshTarget < 0) return fresh;
  fresh[freshTarget] = draft;
  return fresh;
}

/**
 * Advisory pre-flight validation. Mirrors the local field rules of
 * `src/config/pipeline-definition-validator.ts` so the operator gets immediate
 * feedback; cross-reference rules (binding endpoints, Phase existence) stay with
 * the host, which owns the effective Phase catalog.
 */
export function validatePipelineDraft(
  pipeline: MutablePipeline,
  siblings: readonly MutablePipeline[] = []
): PipelineDraftError[] {
  const errors: PipelineDraftError[] = [];
  const add = (field: string, code: string, message: string): void => {
    errors.push({ field, code, message });
  };

  if (!PIPELINE_ID_PATTERN.test(pipeline.id)) {
    add(
      'pipelineId',
      'invalid-pattern',
      'Id must be lowercase letters, digits, or hyphens (max 64) and start with a letter'
    );
  } else if (
    siblings.some(
      (other) => other.sourceKey !== pipeline.sourceKey && other.id === pipeline.id
    )
  ) {
    // The code keeps the host validator's spelling so the advisory pre-flight
    // and the authoritative rejection stay comparable; only the message loses
    // the scope it used to name.
    add('pipelineId', 'duplicate-in-scope', `Id '${pipeline.id}' is already used`);
  }
  if (pipeline.name.trim().length === 0 || pipeline.name.length > PIPELINE_NAME_MAX_LEN) {
    add('name', 'invalid-length', `Name must contain 1 to ${PIPELINE_NAME_MAX_LEN} characters`);
  }
  if (
    pipeline.description !== undefined &&
    pipeline.description.length > PIPELINE_DESCRIPTION_MAX_LEN
  ) {
    add(
      'description',
      'invalid-length',
      `Description must be at most ${PIPELINE_DESCRIPTION_MAX_LEN} characters`
    );
  }
  if (!Number.isInteger(pipeline.version) || pipeline.version < 1) {
    add('version', 'invalid-version', 'Version must be a positive integer');
  }
  if (pipeline.phases.length === 0) {
    add('phaseIds', 'non-empty-required', 'A Pipeline must reference at least one Phase');
  }
  validatePorts(pipeline.inputs, 'inputs', add);
  validatePorts(pipeline.outputs, 'outputs', add);
  validateBindingOrder(pipeline, add);
  return errors;
}

/**
 * FR-015 — a Phase may only consume the output of an *earlier* Phase. Indices
 * are remapped by `reorderPipelinePhases` before this runs, so an error here
 * means the requested order genuinely broke a dependency rather than that the
 * remap was skipped.
 */
function validateBindingOrder(
  pipeline: MutablePipeline,
  add: (field: string, code: string, message: string) => void
): void {
  const last = pipeline.phases.length - 1;
  pipeline.bindings.forEach((binding, index) => {
    const label = `Binding ${index + 1}`;
    if (binding.phaseIndex < 0 || binding.phaseIndex > last) {
      add(
        `bindings[${index}].phaseIndex`,
        'unknown-phase-index',
        `${label} refers to a Phase position that no longer exists`
      );
      return;
    }
    if (binding.kind !== 'input' || binding.source.from !== 'phase-output') return;
    const sourceIndex = binding.source.phaseIndex;
    if (sourceIndex < 0 || sourceIndex > last) {
      add(
        `bindings[${index}].source.phaseIndex`,
        'unknown-phase-index',
        `${label} reads from a Phase position that no longer exists`
      );
    } else if (sourceIndex >= binding.phaseIndex) {
      add(
        `bindings[${index}].source.phaseIndex`,
        'forward-reference',
        `${label} reads from Phase ${sourceIndex + 1}, which does not run before Phase ${binding.phaseIndex + 1}`
      );
    }
  });
}

function validatePorts(
  ports: readonly { portId: string; label: string }[],
  namespace: 'inputs' | 'outputs',
  add: (field: string, code: string, message: string) => void
): void {
  const seen = new Set<string>();
  ports.forEach((port, index) => {
    if (!PIPELINE_ID_PATTERN.test(port.portId)) {
      add(
        `${namespace}[${index}].portId`,
        'invalid-pattern',
        'Port id must be lowercase letters, digits, or hyphens (max 64) and start with a letter'
      );
    } else if (seen.has(port.portId)) {
      add(
        `${namespace}[${index}].portId`,
        'duplicate-port-id',
        `Port id '${port.portId}' is declared more than once`
      );
    }
    seen.add(port.portId);
    if (port.label.trim().length === 0 || port.label.length > PIPELINE_PORT_LABEL_MAX_LEN) {
      add(
        `${namespace}[${index}].label`,
        'invalid-length',
        `Port label must contain 1 to ${PIPELINE_PORT_LABEL_MAX_LEN} characters`
      );
    }
  });
}

/**
 * Feature 082 (US3, T039) — presentation bounds for one error region.
 *
 * A single Pipeline can fail many rules at once; showing every message beside
 * the control that named it would push the form off screen (FR-032). Each
 * region renders at most `MAX_VISIBLE_FIELD_ERRORS` messages and reports the
 * count it withheld, so nothing is silently dropped.
 */
export const MAX_VISIBLE_FIELD_ERRORS = 5;
export const FIELD_ERROR_MESSAGE_MAX_LEN = 160;

export interface BoundedFieldErrors {
  readonly visible: readonly PipelineDraftError[];
  readonly withheld: number;
}

/**
 * Messages reach this point already redacted — the host sanitizes its own
 * strings exactly once through `logger.sanitize`, and the draft messages built
 * above only interpolate values that already matched `PIPELINE_ID_PATTERN`.
 * This collapses control characters and caps length purely so one pathological
 * message cannot break out of its row or take over the region; redaction stays
 * with the host and is never re-run here.
 */
function boundMessage(message: string): string {
  const collapsed = message
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim();
  return collapsed.length > FIELD_ERROR_MESSAGE_MAX_LEN
    ? `${collapsed.slice(0, FIELD_ERROR_MESSAGE_MAX_LEN - 1)}…`
    : collapsed;
}

export function boundFieldErrors(
  errors: readonly PipelineDraftError[]
): BoundedFieldErrors {
  return {
    visible: errors
      .slice(0, MAX_VISIBLE_FIELD_ERRORS)
      .map((error) => ({ ...error, message: boundMessage(error.message) })),
    withheld: Math.max(0, errors.length - MAX_VISIBLE_FIELD_ERRORS)
  };
}

/**
 * Which rendered control an error belongs beside (FR-038). `aria-describedby`
 * must name a region holding only that control's messages, so the anchor has to
 * be decided per error rather than by dropping everything into one card-wide
 * block.
 *
 * `pipeline` names no rendered control — bindings are not authorable in the
 * Builder, so a binding *port* failure has nowhere of its own to land. Those
 * stay visible at the Pipeline level instead of being dropped.
 */
export type PipelineErrorAnchor =
  | { readonly kind: 'field'; readonly field: string }
  | { readonly kind: 'phase'; readonly position: number }
  | { readonly kind: 'sequence' }
  | { readonly kind: 'port' }
  | { readonly kind: 'pipeline' };

const SCALAR_FIELDS: ReadonlySet<string> = new Set([
  'pipelineId',
  'name',
  'description',
  'version'
]);
const PHASE_POSITION_FIELD = /^phaseIds\[(\d+)\]$/;
const BINDING_OWNER_FIELD = /^bindings\[(\d+)\]\.phaseIndex$/;
// The host writes `src`, the draft validator writes `source`; both name the
// producing Phase of the same binding endpoint.
const BINDING_SOURCE_FIELD = /^bindings\[(\d+)\]\.(?:src|source)\.phaseIndex$/;
const PORT_FIELD = /^(?:inputs|outputs)(?:\[\d+\])?\./;

/** The Phase position a binding endpoint names, or null when it is unusable. */
function bindingPhasePosition(
  pipeline: MutablePipeline,
  bindingIndex: number,
  endpoint: 'owner' | 'source'
): number | null {
  const binding = pipeline.bindings[bindingIndex];
  if (binding === undefined) return null;
  if (endpoint === 'owner') return binding.phaseIndex;
  if (binding.kind !== 'input' || binding.source.from !== 'phase-output') return null;
  return binding.source.phaseIndex;
}

export function pipelineErrorAnchor(
  error: PipelineDraftError,
  pipeline: MutablePipeline
): PipelineErrorAnchor {
  if (SCALAR_FIELDS.has(error.field)) return { kind: 'field', field: error.field };
  if (error.field === 'phaseIds') return { kind: 'sequence' };
  if (error.field === 'inputs' || error.field === 'outputs' || PORT_FIELD.test(error.field)) {
    return { kind: 'port' };
  }
  const inSequence = (position: number | null): PipelineErrorAnchor =>
    position !== null && position >= 0 && position < pipeline.phases.length
      ? { kind: 'phase', position }
      : { kind: 'pipeline' };
  const atPosition = PHASE_POSITION_FIELD.exec(error.field);
  if (atPosition) return inSequence(Number(atPosition[1]));
  const owner = BINDING_OWNER_FIELD.exec(error.field);
  if (owner) return inSequence(bindingPhasePosition(pipeline, Number(owner[1]), 'owner'));
  const source = BINDING_SOURCE_FIELD.exec(error.field);
  if (source) return inSequence(bindingPhasePosition(pipeline, Number(source[1]), 'source'));
  return { kind: 'pipeline' };
}

/** Structural comparison; the row is dirty when it differs from its baseline. */
export function isPipelineDirty(
  pipeline: MutablePipeline,
  baseline: MutablePipeline | null
): boolean {
  if (baseline === null) return true;
  return (
    JSON.stringify(toSavePipelineRow(pipeline)) !== JSON.stringify(toSavePipelineRow(baseline))
  );
}

export function pipelineTooltip(pipeline: MutablePipeline): string {
  const summary = pipeline.description ?? 'No description';
  const truncated = `${summary.slice(0, 100)}${summary.length > 100 ? '...' : ''}`;
  return `ID: ${pipeline.id}\nName: ${pipeline.name}\nPhases: ${pipeline.phases.length}\n${truncated}`;
}

/** Turns a host rejection into one line the operator can act on. */
export function formatPipelineSaveRejection(reason: string, result: unknown): string {
  const details = result as
    | {
        dependentWorkflowIds?: readonly string[];
        dependentWorkflowDefinitionIds?: readonly string[];
        errors?: readonly {
          pipelineId?: string;
          field?: string;
          code?: string;
          message?: string;
        }[];
        total?: number;
      }
    | undefined;
  // Feature 083 (FR-041) — a removal can be blocked by a queued run, by a
  // stored Workflow definition, or by both. Both lists are named, because
  // showing only one would leave the operator editing the wrong thing.
  const dependents = [
    ...(details?.dependentWorkflowIds ?? []),
    ...(details?.dependentWorkflowDefinitionIds ?? [])
  ];
  if (dependents.length) {
    return `${reason} — used by workflows: ${dependents.join(', ')}`;
  }
  if (reason === 'pipeline-validation' && details?.errors?.length) {
    const visible = details.errors.slice(0, 3).map((error) => {
      const location = [error.pipelineId, error.field].filter(Boolean).join('.');
      const explanation = error.message ?? error.code ?? 'invalid value';
      return `${location || 'Pipeline'}: ${explanation}`;
    });
    const remaining = Math.max(0, (details.total ?? details.errors.length) - visible.length);
    return `${reason} — ${visible.join('; ')}${remaining > 0 ? `; +${remaining} more` : ''}`;
  }
  if (reason === 'stale-catalog') return `${reason} — refresh the catalog, then reapply the draft`;
  return reason;
}
