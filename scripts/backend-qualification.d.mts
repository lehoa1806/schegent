// FR-R3-104 & FR-R7-14 (14-10) — declaration side of `backend-qualification.mjs`.

export declare const QUALIFICATION_PATH: string;
export declare const QUALIFICATION_MAX_AGE_MS: number;
export declare const ADVERTISED_BACKENDS: readonly ['claude', 'codex', 'agy'];
export declare const EXPECTED_BACKEND_TRANSPORTS: Readonly<Record<string, string>>;
export declare const EXPECTED_BACKEND_PROFILES: Readonly<Record<string, string>>;
export declare const QUALIFICATION_PATHS: readonly string[];
export declare const QUALIFICATION_BUILD_OUTPUTS: readonly string[];
export declare const DRIFT_OVERRIDE_ENV: string;

export type QualificationMode = 'live' | 'fixture';

export interface QualificationRecord {
  version?: number;
  mode?: QualificationMode | string;
  qualifiedAt?: string;
  commit?: string | null;
  platform?: string;
  sourceFingerprint?: string | null;
  versions?: Record<string, string | null>;
  states?: Record<string, string>;
  transports?: Record<string, string>;
  profiles?: Record<string, string>;
  executables?: Record<string, string | null>;
  malformed?: boolean;
}

export interface QualificationVerdict {
  ok: boolean;
  reason: string;
  message: string;
}

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
}): {
  version: number;
  mode: QualificationMode;
  qualifiedAt: string;
  commit: string | null;
  platform: string;
  sourceFingerprint: string | null;
  versions: Record<string, string | null>;
  states: Record<string, string>;
  transports: Record<string, string>;
  profiles: Record<string, string>;
  executables?: Record<string, string | null>;
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
  }
): {
  version: number;
  mode: QualificationMode;
  qualifiedAt: string;
  commit: string | null;
  platform: string;
  sourceFingerprint: string | null;
  versions: Record<string, string | null>;
  states: Record<string, string>;
  transports: Record<string, string>;
  profiles: Record<string, string>;
  executables: Record<string, string | null>;
};
