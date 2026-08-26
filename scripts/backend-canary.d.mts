// FR-R3-061 — the declaration side of `backend-canary.mjs`, so `typecheck:tests`
// can see the pure decisions. Same arrangement as `require-full-gate.d.mts`.

export declare const PROBE_STATES: readonly string[];

export interface ProbeResult {
  readonly ok?: boolean;
  readonly version?: string;
  readonly detail?: string;
  /**
   * Set by the live probe when the CLI's own output said it is not signed in.
   * Distinguishes "this machine is not authenticated" from "this backend
   * drifted" — the two failures a live turn can report, which must not be
   * conflated in either direction.
   */
  readonly notAuthenticated?: boolean;
}

export interface BackendState {
  readonly state: string;
  readonly detail: string;
}

export declare function decideBackendState(input: {
  readonly versionProbe?: ProbeResult | null;
  readonly liveProbe?: ProbeResult | null;
  readonly expectedVersionPrefix?: string;
}): BackendState;

export declare function runnerBackendResult(input: {
  readonly backend: string;
  readonly versionProbe?: ProbeResult | null;
  readonly liveProbe?: ProbeResult | null;
  readonly expectedVersionPrefix?: string;
}): BackendState & { readonly backend: string };

/**
 * Whether a failed live turn's OUTPUT says the CLI is not signed in.
 *
 * Output, never exit status: `agy models` printed its sign-in refusal beside
 * exit 0. Narrow on purpose — an unrecognised failure is drift, which somebody
 * reads, not a skip, which nobody does.
 */
export declare function saysNotAuthenticated(stdout?: string, stderr?: string): boolean;

export declare function canaryExitCode(results: unknown): number;

export declare function formatReport(
  results: ReadonlyArray<{ backend: string; state: string; detail: string }>
): string;
