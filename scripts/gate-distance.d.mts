// Feature 217 (FR-R3-180) — the declaration side of `gate-distance.mjs`, so `typecheck:tests` can
// see the reader's injected seams without the script becoming TypeScript. Same arrangement as
// `gate-recorder.d.mts`.
//
// `TreeState` is imported rather than restated, for the reason the recorder's declaration gives:
// the runtime module takes the tree state from `gate-attestation.mjs`, and a second copy of its
// shape here would be the split that module exists to prevent.
import type { TreeState } from './gate-attestation.mjs';

/** The three seams the reader is pure over. The CLI binds them to the record, git and the tree. */
export interface GateDistanceDeps {
  /**
   * The record's text, or `null` when no record exists. Any other read failure is thrown, and the
   * reader reports it as `unreadable` rather than letting it end the process.
   */
  readonly readRecordText: () => string | null;
  readonly readTreeState: () => TreeState;
  /**
   * `git rev-list --count <range>`, or `null` when git cannot resolve the range — a recorded commit
   * that a rebase or prune has removed from this repository.
   */
  readonly countCommits: (range: string) => number | null;
}

export interface GateDistanceReport {
  /** Always 0. The command reports and never enforces; see the module header. */
  readonly exitCode: 0;
  /** The aligned lines to print, in order. */
  readonly lines: readonly string[];
}

/** Report the attestation's distance from HEAD. Never throws for any state the record can be in. */
export declare function reportGateDistance(deps: GateDistanceDeps): GateDistanceReport;
