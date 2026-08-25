// FR-R3-061 — the declaration side of `backend-canary.mjs`, so `typecheck:tests`
// can see the pure decisions. Same arrangement as `require-full-gate.d.mts`.

export declare const PROBE_STATES: readonly string[];

export interface ProbeResult {
  readonly ok?: boolean;
  readonly version?: string;
  readonly detail?: string;
}

export interface BackendState {
  readonly state: string;
  readonly detail: string;
}

export declare function decideBackendState(input: {
  readonly versionProbe?: ProbeResult | null;
  readonly liveProbe?: ProbeResult | null;
  readonly credentialPresent?: boolean;
  readonly expectedVersionPrefix?: string;
}): BackendState;

export declare function runnerBackendResult(input: {
  readonly backend: string;
  readonly versionProbe?: ProbeResult | null;
  readonly credentialValue?: string;
}): BackendState & { readonly backend: string };

export declare function canaryExitCode(results: unknown): number;

export declare function formatReport(
  results: ReadonlyArray<{ backend: string; state: string; detail: string }>
): string;
