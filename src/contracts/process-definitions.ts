import type { BackendRunnerKind } from '../runner/backend-runner-factory';

/**
 * How long a Phase id may be (feature 089, FR-037).
 *
 * Declared here rather than in `config/process-definition-validator.ts` so the
 * exchange wire contract can read it without importing a validator: that module
 * pulls `runner/backend-runner-factory`, and the sidebar contract barrel is
 * bundled into the webview, where a Node-only import fails the build. The
 * validator re-exports this name, so it remains the one bound every caller sees.
 */
export const PHASE_ID_MAX_LEN = 64;

export const PHASE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type PhaseDefinitionEffort = (typeof PHASE_EFFORT_LEVELS)[number];

/**
 * The containment class a Phase declares for itself (feature 098, FR-001).
 *
 * Declared here, beside `PHASE_EFFORT_LEVELS`, because a containment class is an
 * authored document field like any other — not a property the host infers from
 * which layer a definition came out of. `config/pipeline-config.ts` re-exports
 * both of these rather than restating them, so the authored contract and the
 * runtime shape cannot drift apart without `npm run typecheck` saying so.
 */
export const PHASE_SIDE_EFFECTS = ['none', 'workspace', 'git', 'unrestricted'] as const;
export type PhaseSideEffects = (typeof PHASE_SIDE_EFFECTS)[number];

export const PHASE_EVIDENCE_POLICIES = ['required', 'best-effort', 'none'] as const;
export type PhaseEvidencePolicy = (typeof PHASE_EVIDENCE_POLICIES)[number];

interface PhaseDefinitionBase {
  readonly phaseId: string;
  readonly name: string;
  readonly description?: string;
  readonly version: number;
  readonly model?: string;
  readonly effort?: PhaseDefinitionEffort;
  /**
   * What this Phase is permitted to touch, and whether its evidence is required.
   * Optional on the wire so an older document still parses; the resolver supplies
   * the FR-005 defaults (`workspace` / `required`) when a document omits them, so
   * an absent field is never read as `unrestricted`.
   */
  readonly sideEffects?: PhaseSideEffects;
  readonly evidencePolicy?: PhaseEvidencePolicy;
  readonly timeoutSeconds?: number;
  readonly loopable?: boolean;
  readonly retryCondition?: string;
  readonly isRequired?: boolean;
  /** Advance rather than fail when `retryCondition` is truthy at the cap. */
  readonly forceContinueOnRetryCap?: boolean;
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

/**
 * Feature 099 (FR-040) — two arms, because there is one layer.
 *
 * `shadowed` is deleted rather than retained as an unreachable arm: it described a
 * definition a higher-precedence layer hid, and with a single layer nothing can hide
 * anything. An arm no producer can emit is one every consumer still has to handle.
 */
export type PhaseSourceStatus = 'effective' | 'invalid';

export interface PhaseSourceRecord {
  readonly key: string;
  readonly phaseId: string;
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
  /** One revision for the one layer (FR-044). Derived from the store's manifest (FR-044a). */
  readonly revision: string;
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
      readonly sourcePhaseId: string;
      readonly phaseId: string;
    }
  | { readonly kind: 'remove'; readonly phaseId: string }
  | { readonly kind: 'reset' };

/**
 * One save against the one layer.
 *
 * Feature 099 (FR-043) — formerly `ScopedPhaseSavePayload`. Renamed rather than
 * kept with its `scope` field removed: a type named for a scope that no longer
 * exists is a comment that lies, and the rename makes `typecheck` name every
 * caller instead of leaving the collapse half-applied.
 */
export interface PhaseSavePayload {
  readonly expectedRevision: string;
  readonly mutation: PhaseCatalogMutation;
  readonly phases: readonly unknown[];
}
