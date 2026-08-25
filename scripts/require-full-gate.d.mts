// FR-R3-060 — the declaration side of `require-full-gate.mjs`, so
// `typecheck:tests` can see the pure decisions without the script becoming
// TypeScript. Same arrangement as `check-build-freshness.d.mts`.
//
// FR-R3-087 added the second, narrower stage: `decideJobCoverage`.

export declare const FULL_GATE_WORKFLOW: string;

/** The jobs whose success the release binding requires, by `name:`. */
export declare const REQUIRED_JOB_NAMES: readonly string[];

export interface FullGateVerdict {
  /** True only for a completed, successful run on the exact release commit. */
  readonly ok: boolean;
  /** The id of the run stage 2 must query. Present only when `ok`. */
  readonly runId?: number;
  /** Names the evidence found or missing, and what to do about it. */
  readonly message: string;
}

/**
 * FR-R3-087 — the per-job verdict.
 *
 * The three arrays are disjoint and each names a different finding: a check that
 * did not run, a check that ran red, and a check that was not in the run at all.
 */
export interface JobCoverageVerdict {
  readonly ok: boolean;
  /** Required names absent from the exhausted payload. */
  readonly missing?: readonly string[];
  /** Present, completed, and neither `success` nor `skipped`. */
  readonly failed?: readonly string[];
  /** Present but skipped, cancelled, or not completed. */
  readonly skipped?: readonly string[];
  readonly message: string;
}

export declare function decideFullGate(payload: unknown, sha: string): FullGateVerdict;
export declare function decideJobCoverage(payload: unknown): JobCoverageVerdict;
