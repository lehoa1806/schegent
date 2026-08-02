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
