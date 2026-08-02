import type { PhaseDefinition, WorkflowSnapshot } from '../../lib/snapshot-types';
import type { SavePhaseRow, SavePhasesMutation } from '../../lib/save-phases';
import type { MutablePhase } from './types';

type PhaseCatalogRecord = NonNullable<WorkflowSnapshot['phaseCatalog']>['records'][number];

export function effectivePhasesToMutable(
  phases: readonly PhaseDefinition[]
): MutablePhase[] {
  return phases.map((phase) => ({
    ...phase,
    version: phase.version ?? 1,
    sourceKey: `effective::${phase.id}`,
    scope: 'built-in',
    sourceStatus: 'effective',
    sourceErrors: [],
    persisted: true
  }));
}

export function sourceRecordToMutable(record: PhaseCatalogRecord): MutablePhase {
  const definition = record.definition;
  const display = record.display;
  const displayedFields = Object.fromEntries(
    Object.entries(display).filter(([key]) => key !== 'id' && key !== 'phaseId')
  );
  return {
    ...displayedFields,
    id: definition?.phaseId ?? record.phaseId,
    name: definition?.name ?? (typeof display.name === 'string' ? display.name : 'Invalid Phase'),
    version: definition?.version ?? (typeof display.version === 'number' ? display.version : 1),
    ...(definition?.description !== undefined ? { description: definition.description } : {}),
    ...(definition?.instruction !== undefined
      ? { instruction: definition.instruction }
      : typeof display.instruction === 'string' ? { instruction: display.instruction } : {}),
    ...(definition?.skill !== undefined
      ? { skill: definition.skill }
      : typeof display.skill === 'string' ? { skill: display.skill } : {}),
    ...(definition?.model !== undefined ? { model: definition.model } : {}),
    ...(definition?.effort !== undefined ? { effort: definition.effort } : {}),
    ...(definition?.timeoutSeconds !== undefined ? { timeoutSeconds: definition.timeoutSeconds } : {}),
    ...(definition?.loopable !== undefined ? { loopable: definition.loopable } : {}),
    ...(definition?.retryCondition !== undefined ? { retryCondition: definition.retryCondition } : {}),
    ...(definition?.isRequired !== undefined ? { isRequired: definition.isRequired } : {}),
    ...(definition?.runner !== undefined ? { runner: definition.runner } : {}),
    sourceKey: record.key,
    scope: record.scope,
    sourceStatus: record.status,
    sourceErrors: record.errors,
    ...(record.modelAvailable !== undefined ? { modelAvailable: record.modelAvailable } : {}),
    persisted: true
  } as MutablePhase;
}

function targetIndex(
  rows: readonly MutablePhase[], sourceKey: string | null,
  scope: 'user' | 'workspace', phaseId: string
): number {
  const exact = rows.findIndex((row) => row.sourceKey === sourceKey);
  if (exact >= 0) return exact;
  const candidates = rows.flatMap((row, index) =>
    row.scope === scope && row.id === phaseId ? [index] : []);
  return candidates.length === 1 ? candidates[0] : -1;
}

/** Reapply only the declared local mutation over a freshly projected catalog. */
export function rebasePhaseMutation(
  records: readonly PhaseCatalogRecord[],
  draftRows: readonly MutablePhase[],
  mutation: SavePhasesMutation,
  scope: 'user' | 'workspace',
  sourceKey: string | null
): MutablePhase[] {
  const fresh = records.map(sourceRecordToMutable);
  if (mutation.kind === 'reset') return fresh.filter((row) => row.scope !== scope);
  if (mutation.kind === 'remove') {
    const removal = targetIndex(fresh, sourceKey, scope, mutation.phaseId);
    return removal < 0 ? fresh : fresh.filter((_, index) => index !== removal);
  }
  const draftTarget = targetIndex(draftRows, sourceKey, scope, mutation.phaseId);
  if (draftTarget < 0) return fresh;
  const draft = draftRows[draftTarget];
  if (mutation.kind === 'create' || mutation.kind === 'duplicate') return [...fresh, draft];
  const freshTarget = targetIndex(fresh, sourceKey, scope, mutation.phaseId);
  if (freshTarget < 0) return fresh;
  fresh[freshTarget] = draft;
  return fresh;
}

export function toSavePhaseRow(phase: MutablePhase): SavePhaseRow {
  const row: SavePhaseRow = {
    id: phase.id,
    name: phase.name,
    version: phase.version,
    ...(typeof phase.description === 'string' ? { description: phase.description } : {}),
    ...(typeof phase.instruction === 'string' ? { instruction: phase.instruction } : {}),
    ...(typeof phase.skill === 'string' ? { skill: phase.skill } : {}),
    ...(typeof phase.model === 'string' && phase.model.length > 0 ? { model: phase.model } : {}),
    ...(typeof phase.effort === 'string' && phase.effort.length > 0
      ? { effort: phase.effort as PhaseDefinition['effort'] }
      : {}),
    ...(typeof phase.timeoutSeconds === 'number' ? { timeoutSeconds: phase.timeoutSeconds } : {}),
    ...(typeof phase.loopable === 'boolean' ? { loopable: phase.loopable } : {}),
    ...(typeof phase.retryCondition === 'string' ? { retryCondition: phase.retryCondition } : {}),
    ...(typeof phase.isRequired === 'boolean' ? { isRequired: phase.isRequired } : {}),
    ...(phase.runner ? { runner: phase.runner } : {})
  };
  return row;
}

export function makeNewPhaseDraft(phases: readonly MutablePhase[]): MutablePhase {
  let id = 'new-phase';
  let suffix = 1;
  while (phases.some((phase) => phase.id === id && phase.scope === 'workspace')) {
    id = `new-phase-${suffix++}`;
  }
  return {
    id,
    name: 'New Phase',
    version: 1,
    instruction: 'Describe the phase objective here.',
    scope: 'workspace',
    sourceKey: `draft::workspace::${id}`,
    sourceStatus: 'shadowed',
    sourceErrors: [],
    persisted: false
  };
}

export function makeDuplicatePhaseDraft(
  original: MutablePhase,
  phases: readonly MutablePhase[]
): MutablePhase {
  // Svelte state rows are reactive proxies and cannot be passed to
  // structuredClone. Copy the portable scalar fields and the sole nested
  // collection explicitly so duplication also works from live UI state.
  const duplicate: MutablePhase = {
    ...original,
    sourceErrors: original.sourceErrors.map((error) => ({ ...error }))
  };
  let id = `${original.id}-copy`;
  let suffix = 1;
  while (phases.some((phase) => phase.id === id)) id = `${original.id}-copy-${suffix++}`;
  duplicate.id = id;
  duplicate.name = `${original.name || 'Untitled Phase'} (Copy)`;
  duplicate.version = 1;
  duplicate.scope = original.scope === 'built-in' ? 'workspace' : original.scope;
  duplicate.sourceKey = `draft::${duplicate.scope}::${id}`;
  duplicate.sourceStatus = 'shadowed';
  duplicate.sourceErrors = [];
  duplicate.persisted = false;
  return duplicate;
}

export function phaseTooltip(phases: readonly MutablePhase[], phaseId: string): string {
  const phase = phases.find((candidate) => candidate.id === phaseId);
  if (!phase) return `Unknown phase: ${phaseId}`;
  const directive = phase.instruction ?? (phase.skill ? `Skill: ${phase.skill}` : 'No directive');
  const summary = `${directive.slice(0, 100)}${directive.length > 100 ? '...' : ''}`;
  return `ID: ${phase.id}\nName: ${phase.name}\nModel: ${phase.model || 'Default Backend Model'}\nDirective: ${summary}`;
}

export function formatPhaseSaveRejection(reason: string, result: unknown): string {
  const details = result as {
    dependentPipelineIds?: readonly string[];
    errors?: readonly { phaseId?: string; field?: string; code?: string; message?: string }[];
    total?: number;
  } | undefined;
  if (details?.dependentPipelineIds?.length) {
    return `${reason} — used by pipelines: ${details.dependentPipelineIds.join(', ')}`;
  }
  if (reason === 'phase-validation' && details?.errors?.length) {
    const visible = details.errors.slice(0, 3).map((error) => {
      const location = [error.phaseId, error.field].filter(Boolean).join('.');
      const explanation = error.message ?? error.code ?? 'invalid value';
      return `${location || 'Phase'}: ${explanation}`;
    });
    const remaining = Math.max(0, (details.total ?? details.errors.length) - visible.length);
    return `${reason} — ${visible.join('; ')}${remaining > 0 ? `; +${remaining} more` : ''}`;
  }
  if (reason === 'stale-catalog') return `${reason} — refresh the catalog, then reapply the draft`;
  return reason;
}
