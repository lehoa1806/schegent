// FR-R3-104 — the declaration side of `backend-qualification.mjs`, so `typecheck:tests` can see
// the pure decision without the script becoming TypeScript. Same arrangement as
// `gate-attestation.d.mts`, whose binding this one sits beside on the release path.

/** Where the untracked qualification record lives. */
export declare const QUALIFICATION_PATH: string;

/** How long a qualification stands. The operator disclosure derives from this. */
export declare const QUALIFICATION_MAX_AGE_MS: number;

/** Path prefixes whose change invalidates an older qualification. */
export declare const QUALIFICATION_PATHS: readonly string[];

/** The environment variable that turns a refusal into a recorded unqualified release. */
export declare const DRIFT_OVERRIDE_ENV: string;

export interface QualificationRecord {
  version?: number;
  qualifiedAt?: string;
  commit?: string | null;
  platform?: string;
  versions?: Record<string, string | null>;
  states?: Record<string, string>;
  malformed?: boolean;
}

export interface QualificationVerdict {
  ok: boolean;
  reason: string;
  message: string;
}

export declare function readQualification(path?: string): QualificationRecord | null;

/** `null` means the question could not be answered, which the decision treats as a refusal. */
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
}): QualificationVerdict;

export declare function buildQualificationRecord(inputs: {
  versions: Record<string, string | null>;
  states: Record<string, string>;
  commit: string | null;
  platform: string;
  now: string;
}): {
  version: number;
  qualifiedAt: string;
  commit: string | null;
  platform: string;
  versions: Record<string, string | null>;
  states: Record<string, string>;
};

export declare function readHeadCommit(): string | null;

export declare function recordFromCanaryResults(
  results: ReadonlyArray<{
    backend: string;
    state: string;
    observedVersion?: string | null;
  }>,
  context: { commit: string | null; platform: string; now: string }
): {
  version: number;
  qualifiedAt: string;
  commit: string | null;
  platform: string;
  versions: Record<string, string | null>;
  states: Record<string, string>;
};
