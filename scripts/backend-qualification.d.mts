// FR-R3-104 & FR-R7-14 (14-10) — declaration side of `backend-qualification.mjs`.

export declare const QUALIFICATION_PATH: string;
export declare const QUALIFICATION_MAX_AGE_MS: number;
export declare const ADVERTISED_BACKENDS: readonly ['claude', 'codex', 'agy'];
export declare const EXPECTED_BACKEND_TRANSPORTS: Readonly<Record<string, string>>;
export declare const EXPECTED_BACKEND_PROFILES: Readonly<Record<string, string>>;
export declare const EXPECTED_BACKEND_COST_DENOMINATIONS: Readonly<Record<string, 'usd' | 'tokens'>>;
export declare const QUALIFICATION_PATHS: readonly string[];
export declare const QUALIFICATION_LOCALITIES: readonly ['local', 'remote'];
export declare const QUALIFICATION_CHECK_KEYS: readonly [
  'resume',
  'policyDenial',
  'permissionTitleSanitized'
];
export declare const QUALIFICATION_BUILD_OUTPUTS: readonly string[];
export declare const BEHAVIOR_EVAL_MANIFEST_PATH: string;
export declare const BEHAVIOR_EVAL_MAX_AGE_DAYS: number;
export declare const DRIFT_OVERRIDE_ENV: string;

export type QualificationMode = 'live' | 'fixture';
export type QualificationLocality = 'local' | 'remote';

export interface BehaviorEvalPerBackendSummary {
  taskCount: number;
  passedCount: number;
  promptDigests: string[];
  costDenomination: 'usd' | 'tokens';
  totalCostUnits: number;
}

export interface BehaviorEvalsSummary {
  recordedAt: string;
  latestRecordedAt?: string;
  maxAgeDays: number;
  staleFixtureOwner: string;
  perBackend: Record<string, BehaviorEvalPerBackendSummary>;
}

export interface QualificationChecks {
  resume?: boolean;
  policyDenial?: boolean;
  permissionTitleSanitized?: boolean;
}

export interface QualificationRecord {
  version?: number;
  mode?: QualificationMode | string;
  qualifiedAt?: string;
  commit?: string | null;
  platform?: string;
  locality?: QualificationLocality | string;
  sourceFingerprint?: string | null;
  versions?: Record<string, string | null>;
  states?: Record<string, string>;
  transports?: Record<string, string>;
  profiles?: Record<string, string>;
  executables?: Record<string, string | null>;
  checks?: QualificationChecks;
  behaviorEvals?: BehaviorEvalsSummary | null;
  malformed?: boolean;
}

export interface QualificationVerdict {
  ok: boolean;
  reason: string;
  message: string;
}

export declare function summarizeBehaviorEvalManifest(
  manifestOrPath?: unknown,
  options?: { requiredBackends?: readonly string[] }
): BehaviorEvalsSummary | null;
export declare function validateBehaviorEvalsSummary(
  behaviorEvals: unknown,
  options: { now: string; requiredBackends?: readonly string[] }
): { ok: true } | { ok: false; reason: string; message: string };

export declare function computeQualificationSourceFingerprint(repoRoot?: string): string | null;
export declare function readQualification(path?: string): QualificationRecord | null;
export declare function changedQualificationPaths(
  qualifiedCommit: string | null | undefined,
  head?: string
): string[] | null;
export declare function probeInstalledVersions(
  commands?: Record<string, string>
): Record<string, string | null>;
export declare function versionToken(line: unknown): string | null;

export declare function decideQualification(inputs: {
  record: QualificationRecord | null | undefined;
  head: string | null;
  installedVersions: Record<string, string | null>;
  changedPaths: string[] | null;
  now: string;
  overrideRequested?: boolean;
  maxAgeMs?: number;
  expectedFingerprint?: string | null;
  requireLive?: boolean;
  requiredBackends?: readonly string[];
  expectedLocality?: QualificationLocality;
  requireChecks?: boolean;
}): QualificationVerdict;

export declare function buildQualificationRecord(inputs: {
  versions: Record<string, string | null>;
  states: Record<string, string>;
  commit: string | null;
  platform: string;
  now: string;
  mode?: QualificationMode;
  sourceFingerprint?: string | null;
  transports?: Record<string, string>;
  profiles?: Record<string, string>;
  executables?: Record<string, string | null>;
  locality?: QualificationLocality;
  checks?: QualificationChecks;
  behaviorEvals?: BehaviorEvalsSummary | null;
}): {
  version: number;
  mode: QualificationMode;
  qualifiedAt: string;
  commit: string | null;
  platform: string;
  locality?: QualificationLocality;
  sourceFingerprint: string | null;
  versions: Record<string, string | null>;
  states: Record<string, string>;
  transports: Record<string, string>;
  profiles: Record<string, string>;
  executables?: Record<string, string | null>;
  checks?: QualificationChecks;
  behaviorEvals?: BehaviorEvalsSummary | null;
};

export declare function readHeadCommit(): string | null;

export declare function recordFromCanaryResults(
  results: ReadonlyArray<{
    backend: string;
    state: string;
    observedVersion?: string | null;
    transport?: string;
    profileId?: string;
    executable?: string | null;
  }>,
  context: {
    commit: string | null;
    platform: string;
    now: string;
    mode?: QualificationMode;
    sourceFingerprint?: string | null;
    locality?: QualificationLocality;
    checks?: QualificationChecks;
    behaviorEvals?: BehaviorEvalsSummary | null;
  }
): {
  version: number;
  mode: QualificationMode;
  qualifiedAt: string;
  commit: string | null;
  platform: string;
  locality?: QualificationLocality;
  sourceFingerprint: string | null;
  versions: Record<string, string | null>;
  states: Record<string, string>;
  transports: Record<string, string>;
  profiles: Record<string, string>;
  executables: Record<string, string | null>;
  checks?: QualificationChecks;
  behaviorEvals?: BehaviorEvalsSummary | null;
};
