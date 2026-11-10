// FR-R6-F09 (FR-001, FR-002, FR-004, FR-005, FR-009, FR-012, FR-017) -- the closed vocabulary of
// backend containment qualification and spawn admission.
//
// WHAT THIS IS. A leaf: value lists and the record shapes every surface reads. The pure judgement
// lives in `src/services/containment-qualification/`, the spawn decorator in `src/runner/`. Nothing
// here holds a directory path, an environment value or a credential (FR-008, NFR-005): every string
// field is an identifier from a closed list, a version `major.minor`, a platform name or a digest.
//
// WHY EVERY LIST IS CLOSED. A refusal reason, an outcome or a residual that a caller can extend is
// one a reader cannot rely on. Each list is frozen, and its type is derived from it, so the list and
// the type cannot drift.

import type { BackendRunnerKind } from './backend-kinds';

/** The six effects a record qualifies separately (FR-005). Also the record's order. */
export const CONTAINMENT_EFFECTS = Object.freeze([
  'fs-read',
  'fs-write',
  'process-creation',
  'network',
  'credential-exposure',
  'descendant-lifetime'
] as const);
export type ContainmentEffect = (typeof CONTAINMENT_EFFECTS)[number];

/** What is known about one effect. Help text alone never yields `observed-enforced` (FR-002). */
export const EFFECT_OUTCOMES = Object.freeze([
  'observed-enforced',
  'tool-restricted',
  'unsupported',
  'unverified',
  'stale'
] as const);
export type EffectOutcome = (typeof EFFECT_OUTCOMES)[number];

export const EVIDENCE_BASES = Object.freeze(['observed-behavior', 'help-syntax', 'none'] as const);
export type EvidenceBasis = (typeof EVIDENCE_BASES)[number];

/** The component an observation exercised (FR-012). An unexercised one is a residual. */
export const OBSERVED_COMPONENTS = Object.freeze([
  'file-tool',
  'shell-child',
  'hook',
  'external-tool',
  'host-ladder'
] as const);
export type ObservedComponent = (typeof OBSERVED_COMPONENTS)[number];

/** What one cell's evidence leaves unproven. Closed, so a record names no free text. */
export const EFFECT_RESIDUALS = Object.freeze([
  'file-tool-unobserved',
  'hook-unobserved',
  'external-tool-unobserved',
  'non-loopback-destinations-unobserved',
  'dns-unobserved',
  'redirect-unobserved',
  'proxy-unobserved',
  'no-filtering-claimed',
  'descendants-outside-group-undetectable'
] as const);
export type EffectResidual = (typeof EFFECT_RESIDUALS)[number];

/** Why a spawn was refused (FR-003, FR-013). */
export const CONTAINMENT_REFUSAL_REASONS = Object.freeze([
  'containment-unqualified-for-tuple',
  'acceptance-fingerprint-changed',
  'backend-executable-unresolved',
  'workspace-untrusted-at-spawn',
  'ownership-lost-at-spawn',
  'configuration-changed-at-spawn'
] as const);
export type ContainmentRefusalReason = (typeof CONTAINMENT_REFUSAL_REASONS)[number];

/** The only reasons an operator may accept. The other four are reported and never offered. */
export const CONSENTABLE_REFUSAL_REASONS: readonly ContainmentRefusalReason[] = Object.freeze([
  'containment-unqualified-for-tuple',
  'acceptance-fingerprint-changed'
]);

export const EXECUTABLE_UNRESOLVED_CAUSES = Object.freeze(['not-found', 'not-executable'] as const);
export type ExecutableUnresolvedCause = (typeof EXECUTABLE_UNRESOLVED_CAUSES)[number];

/** The enforcement fingerprint's components. Also the comparison order. No path is one. */
export const FINGERPRINT_COMPONENTS = Object.freeze([
  'backend',
  'version',
  'os',
  'arch',
  'mechanism',
  'environment-policy',
  'flag-surface'
] as const);
export type FingerprintComponent = (typeof FINGERPRINT_COMPONENTS)[number];

export const ACCEPTANCE_ORIGINS = Object.freeze(['consent', 'legacy-first-use'] as const);
export type AcceptanceOrigin = (typeof ACCEPTANCE_ORIGINS)[number];

export const IDENTITY_STATES = Object.freeze(['observed', 'unverified', 'not-observed'] as const);
export type IdentityState = (typeof IDENTITY_STATES)[number];

export const TEARDOWN_OUTCOMES = Object.freeze([
  'group-exit-confirmed',
  'residual',
  'unanswerable'
] as const);
export type TeardownOutcome = (typeof TEARDOWN_OUTCOMES)[number];

export const TEARDOWN_RESIDUALS = Object.freeze([
  'descendants-outside-group-undetectable',
  'group-survived',
  'bound-elapsed'
] as const);
export type TeardownResidual = (typeof TEARDOWN_RESIDUALS)[number];

/** The workspace memento key the acceptance bindings live under. */
export const ACCEPTANCE_BINDINGS_KEY = 'schegent.backend.acceptanceBindings.v1';
/** The stored value's size bound, serialized. A larger value is treated as absent. */
export const ACCEPTANCE_BINDINGS_MAX_BYTES = 8 * 1024;
/** The only stored schema this host writes. A greater one is a future-version record. */
export const ACCEPTANCE_BINDINGS_SCHEMA_VERSION = 1;

/** The rule a `versionMinor` meets: `^\d{1,6}\.\d{1,6}$`. */
export const VERSION_MINOR_PATTERN = /^\d{1,6}\.\d{1,6}$/;
/** The rule a digest meets: 64 hex characters. */
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
/** Bound on `os` and `arch`. */
export const PLATFORM_FIELD_MAX = 16;
/** Bound on one fingerprint component value. */
export const FINGERPRINT_COMPONENT_MAX = 80;
/** Bound on one cell's residuals. */
export const EFFECT_RESIDUALS_MAX = 8;

/** The inputs the gate and the inspection read. No path is carried. */
export interface BackendIdentity {
  readonly kind: BackendRunnerKind;
  /** `'resolved'` or the closed cause; never the resolved location. */
  readonly executable: 'resolved' | ExecutableUnresolvedCause;
  /** `^\d{1,6}\.\d{1,6}$`; `null` means unverified. */
  readonly versionMinor: string | null;
  /** `process.platform` of the extension host, ≤ 16 characters. */
  readonly os: string;
  /** `process.arch` of the extension host, ≤ 16 characters. */
  readonly arch: string;
  /** 64 hex characters: mode plus sorted allowlist names, never values. */
  readonly environmentPolicyDigest: string;
}

/** The record key (FR-001). `acp` is reserved for F13 (FR-017). */
export interface QualificationKey {
  readonly kind: BackendRunnerKind;
  /** `major.minor`, or `'unverified'`. */
  readonly versionMinor: string;
  readonly os: string;
  readonly arch: string;
  readonly mechanism: string;
  /** The same as `versionMinor`: the mechanism ships inside the CLI. */
  readonly mechanismVersion: string;
  /** 64 hex characters. */
  readonly fingerprint: string;
  /** The sorted confirmed-flag names for the kind. */
  readonly capabilitySet: readonly string[];
  readonly acp: 'not-applicable';
}

export interface EffectQualification {
  readonly effect: ContainmentEffect;
  /** `observed-enforced` requires `basis === 'observed-behavior'` (FR-002). */
  readonly outcome: EffectOutcome;
  readonly basis: EvidenceBasis;
  /** What the evidence exercised (FR-012); empty unless `observed-behavior`. */
  readonly components: readonly ObservedComponent[];
  /** ≤ 8 entries. */
  readonly residuals: readonly EffectResidual[];
  /** ISO date of the observation, or `null`. */
  readonly observedAt: string | null;
}

export interface QualificationRecord {
  readonly key: QualificationKey;
  /** Exactly six, in `CONTAINMENT_EFFECTS` order. */
  readonly effects: readonly EffectQualification[];
  /**
   * True only when the backend claims a mechanism, the tuple matches an evidence row at the same
   * `versionMinor`, and every effect the mechanism claims is `observed-enforced`.
   */
  readonly qualified: boolean;
  readonly identityState: IdentityState;
}

export interface FingerprintRecord {
  /** 64 hex characters: SHA-256 of the ordered components. */
  readonly digest: string;
  /** Each value ≤ 80 characters, an identifier or digest only. */
  readonly components: Readonly<Record<FingerprintComponent, string>>;
}

export interface AcceptanceBinding {
  readonly fingerprint: FingerprintRecord;
  readonly origin: AcceptanceOrigin;
  /** ISO-8601. */
  readonly boundAt: string;
}

/** The binding a judgement reads: one, none, or a record a newer host wrote. */
export type BindingInput = AcceptanceBinding | null | 'future-schema';

export type AdmissionVerdict =
  | {
      readonly outcome: 'admitted';
      readonly containment: 'contained' | 'accepted-uncontained' | 'accepted-unqualified';
      readonly fingerprint: FingerprintRecord;
      /** The binding the gate writes before admitting, when one is due. */
      readonly bindingWrite?: AcceptanceOrigin;
    }
  | {
      readonly outcome: 'refused';
      readonly reason: ContainmentRefusalReason;
      readonly consentable: boolean;
      readonly fingerprint?: FingerprintRecord;
      readonly changedComponent?: FingerprintComponent;
      readonly cause?: ExecutableUnresolvedCause;
    };

export interface TeardownQualification {
  readonly outcome: TeardownOutcome;
  readonly residuals: readonly TeardownResidual[];
}

/** What the spawn gate is told about one spawn. `runId` is absent for a spawn outside a Run. */
export interface SpawnAdmissionRequest {
  readonly runId: string | undefined;
  readonly cliPath: string;
}

/**
 * The check every backend spawn awaits (FR-003, FR-008, FR-013). Resolves on admission; throws a
 * `ContainmentAdmissionRefusedError` on refusal, and rethrows any other failure unchanged.
 */
export interface SpawnGate {
  admit(kind: BackendRunnerKind, request: SpawnAdmissionRequest): Promise<void>;
}
