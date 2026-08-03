import type { BackendRunnerKind } from '../runner/backend-runner-factory';

export const PHASE_DEFINITION_SCOPES = ['built-in', 'user', 'workspace'] as const;
export type PhaseDefinitionScope = (typeof PHASE_DEFINITION_SCOPES)[number];
export type WritablePhaseDefinitionScope = Exclude<PhaseDefinitionScope, 'built-in'>;

export const PHASE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type PhaseDefinitionEffort = (typeof PHASE_EFFORT_LEVELS)[number];

interface PhaseDefinitionBase {
  readonly phaseId: string;
  readonly name: string;
  readonly description?: string;
  readonly version: number;
  readonly model?: string;
  readonly effort?: PhaseDefinitionEffort;
  readonly timeoutSeconds?: number;
  readonly loopable?: boolean;
  readonly retryCondition?: string;
  readonly isRequired?: boolean;
  readonly runner?: BackendRunnerKind;
}

export interface InstructionPhaseDefinition extends PhaseDefinitionBase {
  readonly instruction: string;
  readonly skill?: never;
}

export interface SkillPhaseDefinition extends PhaseDefinitionBase {
  readonly instruction?: never;
  readonly skill: string;
}

export type PhaseDefinition = InstructionPhaseDefinition | SkillPhaseDefinition;

export interface PhaseFieldError {
  readonly phaseId: string;
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export type PhaseSourceStatus = 'effective' | 'shadowed' | 'invalid';

export interface PhaseSourceRecord {
  readonly key: string;
  readonly phaseId: string;
  readonly scope: PhaseDefinitionScope;
  readonly status: PhaseSourceStatus;
  readonly definition: PhaseDefinition | null;
  /** Recognized authored fields only. This host-internal value is sanitized before IPC. */
  readonly display: Readonly<Record<string, unknown>>;
  readonly errors: readonly PhaseFieldError[];
}

export interface PhaseCatalogWarning {
  readonly code: string;
  readonly message: string;
}

export interface PhaseCatalogResolution {
  readonly records: readonly PhaseSourceRecord[];
  readonly effective: readonly PhaseDefinition[];
  readonly revisions: Readonly<Record<WritablePhaseDefinitionScope, string>>;
  readonly warnings: readonly PhaseCatalogWarning[];
}

export type PhaseCatalogMutation =
  | { readonly kind: 'create'; readonly phaseId: string }
  /**
   * Feature 084 (FR-046a) — a `create` whose row came from a portable document
   * rather than from the editor, so its authored `version` is data and MUST be
   * stored as declared. The shared intent algebra sees it as a `create`: the
   * diff and shape checks are the same ones, and the target identity is by
   * construction absent from the layer, so there is no version *transition* for
   * a save to dictate. Every other row still echoes its current version.
   */
  | { readonly kind: 'import'; readonly phaseId: string }
  /**
   * Feature 085 (FR-036, FR-044) — the Phase half of one confirmed package
   * import. One write appends every eligible Phase at once, so the intent names
   * the whole set: a per-row `import` would make a multi-resource document N
   * writes with N revision gates, and a failure part-way through would leave the
   * layer in a state no single intent describes. Every named id keeps the
   * version its document declared, exactly as the single-Phase `import` does.
   */
  | { readonly kind: 'import-package'; readonly phaseIds: readonly string[] }
  | { readonly kind: 'edit'; readonly phaseId: string }
  | {
      readonly kind: 'duplicate';
      readonly sourceScope: PhaseDefinitionScope;
      readonly sourcePhaseId: string;
      readonly phaseId: string;
    }
  | { readonly kind: 'remove'; readonly phaseId: string }
  | { readonly kind: 'reset' };

export interface ScopedPhaseSavePayload {
  readonly scope: WritablePhaseDefinitionScope;
  readonly expectedRevision: string;
  readonly mutation: PhaseCatalogMutation;
  readonly phases: readonly unknown[];
}
