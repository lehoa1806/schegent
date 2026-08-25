import type { PhaseCapability } from './phase-capabilities';
import type { BackendRunnerKind } from './backend-kinds';

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

/**
 * How long a Phase `retryCondition` expression may be (feature 111, FR-001).
 *
 * 512 characters. The derivation, not a round number picked for looking like one:
 * the longest expression the product ships is 77 characters
 * (`examples/speckit-new-feature.pipeline.yaml`), and the longest identifier the
 * grammar admits is 24. An eight-clause condition — already past what an operator
 * writes by hand — is eight identifiers, seven operators, and the parentheses to
 * group them: 8 x 24 + 7 x 4 + 16 = 236, and doubling that for the operator who
 * writes a longer one lands above 256 (472). So 256 is too tight to be obviously
 * safe and 1024 buys nothing a bounded evaluator needs. 512 also sits between the
 * skill bound (256) and the description bound (1024) in both modules that declare
 * this family — `config/process-definition-validator.ts` and
 * `ui/sidebar/phase-catalog-projection.ts` — and equals the latter's `MESSAGE_MAX`.
 *
 * What it replaces on the projection path is the number worth noticing:
 * `retryCondition` was truncated there at `INSTRUCTION_MAX`, 8192. This is a 16x
 * tightening of the one sink that already bounded the field, and the first bound of
 * any kind on the three that did not.
 *
 * The bound is a **character count on the source string** — every check reads
 * `source.length` — not a byte count. A multi-byte identifier costs the same as an
 * ASCII one, which is the correct posture for a grammar whose cost is per token.
 *
 * Declared here rather than beside its four siblings in
 * `config/process-definition-validator.ts` for two independent reasons. The webview
 * reads bounds from `contracts/`, as `PHASE_ID_MAX_LEN` above records. And the
 * module that consumes this one — `lib/retry-condition.ts` — imports nothing at
 * all: it is byte-mirrored into `webview-ui/src/lib/`, and
 * `tests/lint/retry-condition-stays-inert.test.ts` pins its importer list at
 * exactly three. So the evaluator takes the bound as an argument and the contract
 * owns the number, which is what the FR-037 law asks for anyway: declare a bound
 * once, in the contract that declares the field. T23 in
 * `docs/security/threat-model.md` prescribes the same placement in as many words.
 */
export const PHASE_RETRY_CONDITION_MAX_LEN = 512;

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

/**
 * FR-R3-058 (M-07 / R-10) — what evidence may advance this Phase.
 *
 * A separate axis from `evidencePolicy`, which asks whether an audit block must
 * be present. This asks who is believed when the host's own signals and the
 * model's disagree.
 *
 * `'model-token'` is the default and the historical behaviour, unchanged: a clean
 * termination token advances the Phase even when the process timed out or exited
 * non-zero. That is a recorded decision (FR-R3-023 verified evidence *shape*,
 * FR-R3-038 *disclosed* the self-certification) and it is right for a Phase whose
 * product is prose.
 *
 * `'exit-code'` marks the Phase SENSITIVE: the process's own exit status decides,
 * and a clean token cannot override a non-zero exit or a timeout. For a Phase
 * that runs tests, produces artifacts, or claims a side effect, the agent whose
 * work is being judged should not also be the author of the evidence that
 * advances it.
 *
 * Omission means `'model-token'`, so every existing definition behaves exactly as
 * before. The step FR-R3-023 and FR-R3-038 both deferred is taken only where a
 * definition asks for it.
 */
export const PHASE_HOST_VERIFICATIONS = ['model-token', 'exit-code'] as const;
export type PhaseHostVerification = (typeof PHASE_HOST_VERIFICATIONS)[number];

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
  /** FR-R3-058 — omission means `model-token`, the historical behaviour. */
  readonly hostVerification?: PhaseHostVerification;
  /**
   * FR-R3-086 — what this phase's agent may do.
   *
   * **Omission means every capability**, which is the historical behaviour and
   * the overwhelmingly common case: the phase spawns with the argv it spawns
   * with today, byte for byte. Narrowing is opt-in, per phase.
   *
   * The set is frozen into the Run's pipeline snapshot with the rest of the
   * plan, so what an agent may do is part of the plan the operator approved
   * rather than a property of the machine it happens to run on — and, like every
   * other snapshot field, it is never retargeted in flight.
   */
  readonly capabilities?: readonly PhaseCapability[];
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
