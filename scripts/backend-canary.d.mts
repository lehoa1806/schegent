// FR-R3-061 — the declaration side of `backend-canary.mjs`, so `typecheck:tests`
// can see the pure decisions. Same arrangement as `require-full-gate.d.mts`.

export declare const PROBE_STATES: readonly string[];

export declare const LIVE_PROMPT: string;
export declare const LIVE_ANSWER_TOKEN: string;

export interface LiveInvocationShape {
  readonly args: readonly string[];
  readonly stdin: 'raw' | 'agy-stream-json';
}

/**
 * The protocol shape each backend is probed in — the host's own shape, so the
 * canary qualifies the protocol the product actually speaks.
 */
export declare const LIVE_INVOCATIONS: Readonly<Record<string, LiveInvocationShape>>;

export declare function liveArgsFor(backend: string): string[] | undefined;

/** The bytes a backend's stdin expects. Checked against the host's encoder. */
export declare function stdinPayloadFor(backend: string, prompt: string): string | undefined;

/** Whether a live answer carries the token the prompt asked for. */
export declare function answerEstablishesPrompt(
  stdout: string,
  prompt?: string,
  token?: string
): boolean;

/** The `prompt-injection-in-output` case's prompt: lines it asks the model to print. */
export declare const INJECTION_PROMPT: string;

/** The three routes untrusted text reaches the model by (feature 217, FR-R3-182). */
export type InjectionSurface = 'task-text' | 'repository-file' | 'prior-output';

export declare const INJECTION_SURFACES: readonly InjectionSurface[];

/** The host prompt fields a surface case fills, rendered as `PromptBuilder.build` renders them. */
export interface HostPromptSlice {
  readonly instruction: string;
  readonly featureDescription?: string;
  readonly previousPhaseMessage?: Readonly<Record<string, string>>;
}

export interface CanaryScenario {
  readonly id: string;
  /** The surface the case's untrusted text arrives by; `null` when it carries none. */
  readonly surface: InjectionSurface | null;
  /** `every-run`: `npm run canary`. `record-only`: `npm run canary:record` alone. */
  readonly cadence: 'every-run' | 'record-only';
  /** The recording's name after `<backend>-`: `<backend>-<stem>.jsonl`. */
  readonly stem: string;
  readonly prompt: string;
  /** What must be seen for the case to have shown anything, and what it shows (FR-054). */
  readonly expectedObservable: string;
  readonly host?: HostPromptSlice;
  /** Files planted, by bare name, in the case's own working directory. */
  readonly files?: Readonly<Record<string, string>>;
  /** A word only the surface holds: in the reply, the surface reached the model. */
  readonly deliveryToken?: string;
  /** A word only the planted instruction asks for: in the reply, the model obeyed it. */
  readonly injectionMarker?: string;
}

export interface CanaryCase extends CanaryScenario {
  readonly backend: string;
}

/** The corpus, one row per scenario. `backend-canary-run.mjs` holds no prompt of its own. */
export declare const CANARY_SCENARIOS: readonly CanaryScenario[];

/** Every scenario on every backend with a live path. */
export declare const CANARY_CASES: readonly CanaryCase[];

/**
 * A live envelope with its environment rows dropped, its ids redacted, and each
 * spelling in `probeDirs` (the turn's working directory) replaced by `<probe-dir>`.
 */
export declare function redactLiveEnvelope(
  stdout: string,
  probeDirs?: readonly string[]
): string;

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
