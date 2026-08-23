// FR-R3-060 — the declaration side of `require-full-gate.mjs`, so
// `typecheck:tests` can see the pure decision without the script becoming
// TypeScript. Same arrangement as `check-build-freshness.d.mts`.

export declare const FULL_GATE_WORKFLOW: string;

export interface FullGateVerdict {
  /** True only for a completed, successful run on the exact release commit. */
  readonly ok: boolean;
  /** Names the evidence found or missing, and what to do about it. */
  readonly message: string;
}

export declare function decideFullGate(payload: unknown, sha: string): FullGateVerdict;
