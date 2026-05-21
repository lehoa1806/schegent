import type { PhaseDef } from './pipeline-config';

export type PhaseFieldKey =
  | 'model'
  | 'effort'
  | 'timeoutSeconds'
  | 'retryCondition';

export type PhasePrecedenceLayer = 'built-in' | 'user' | 'workspace' | 'unset';

export type PhasePrecedenceProjection = Readonly<Record<string, PhasePrecedenceLayer>>;

const PHASE_FIELD_KEYS: readonly PhaseFieldKey[] = [
  'model',
  'effort',
  'timeoutSeconds',
  'retryCondition'
];

function compositeKey(phaseId: string, fieldKey: PhaseFieldKey): string {
  return `${phaseId}::${fieldKey}`;
}

function readField(
  phase: PhaseDef | undefined,
  fieldKey: PhaseFieldKey
): unknown {
  if (!phase) return undefined;
  return (phase as unknown as Record<string, unknown>)[fieldKey];
}

function indexById(phases: readonly PhaseDef[]): Map<string, PhaseDef> {
  const m = new Map<string, PhaseDef>();
  for (const p of phases) m.set(p.id, p);
  return m;
}

export function projectPhasePrecedence(
  builtIn: readonly PhaseDef[],
  user: readonly PhaseDef[],
  workspace: readonly PhaseDef[]
): PhasePrecedenceProjection {
  const builtInById = indexById(builtIn);
  const userById = indexById(user);
  const workspaceById = indexById(workspace);

  const phaseIds = new Set<string>();
  for (const p of builtIn) phaseIds.add(p.id);
  for (const p of user) phaseIds.add(p.id);
  for (const p of workspace) phaseIds.add(p.id);

  const out: Record<string, PhasePrecedenceLayer> = {};
  for (const id of phaseIds) {
    const b = builtInById.get(id);
    const u = userById.get(id);
    const w = workspaceById.get(id);
    for (const k of PHASE_FIELD_KEYS) {
      let layer: PhasePrecedenceLayer = 'unset';
      if (readField(u, k) !== undefined) layer = 'user';
      else if (readField(w, k) !== undefined) layer = 'workspace';
      else if (readField(b, k) !== undefined) layer = 'built-in';
      out[compositeKey(id, k)] = layer;
    }
  }
  return Object.freeze(out);
}
