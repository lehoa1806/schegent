// FR-R3-095 — the declaration side of `gate-attestation.mjs`, so
// `typecheck:tests` can see the pure decision without the script becoming
// TypeScript. Same arrangement as `require-full-gate.d.mts`, whose binding this
// is the locally-reachable counterpart to.

/** Absolute path of the implementation repository root. */
export declare const REPO_ROOT: string;

/** Where the untracked attestation lives. */
export declare const ATTESTATION_PATH: string;

/** The command whose observed exit code is the evidence. Stated once. */
export declare const GATE_COMMAND: string;

export declare const ATTESTATION_VERSION: number;

/**
 * Why a release was refused, or `verified`.
 *
 * Six distinct refusals because they have six distinct remedies: a gate that
 * says only "refused" sends someone to read the gate instead of fixing the cause.
 */
export type ReleaseVerdictReason =
  | 'verified'
  | 'dirty-tree'
  | 'no-attestation'
  | 'unreadable'
  | 'wrong-command'
  | 'wrong-commit'
  | 'recorded-dirty'
  | 'gate-failed';

export interface ReleaseVerdict {
  readonly ok: boolean;
  readonly reason: ReleaseVerdictReason;
  /** Names the cause and its remedy, never just the refusal. */
  readonly message: string;
}

export interface TreeState {
  /** `HEAD` of the implementation repository, which is what a release is OF. */
  readonly head: string;
  /** False when `git status --porcelain` reports anything, untracked included. */
  readonly treeClean: boolean;
}

export declare function readTreeState(): TreeState;

/** Pure over its inputs, so every refusal is testable without cutting a release. */
export declare function decideRelease(input: {
  attestation: unknown;
  head: string;
  treeClean: boolean;
  now?: string;
}): ReleaseVerdict;
