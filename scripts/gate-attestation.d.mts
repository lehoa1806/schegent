// FR-R3-095 — the declaration side of `gate-attestation.mjs`, so
// `typecheck:tests` can see the pure decision without the script becoming
// TypeScript. Same arrangement as `require-full-gate.d.mts`, whose binding this
// is the locally-reachable counterpart to.

/** Absolute path of the implementation repository root. */
export declare const REPO_ROOT: string;

/** Where the untracked attestation lives. */
export declare const ATTESTATION_PATH: string;

/**
 * FR-R3-135 — the gate's spawn identity, and the single construction site for what the gate is.
 *
 * `args` is the vector the recorder passes to `npm`; `GATE_COMMAND` is its rendering. Typed
 * `readonly` throughout to match the runtime `Object.freeze`, so a caller that tries to edit the
 * authority fails at the typecheck rather than silently at runtime.
 */
export interface GateCommandSpec {
  readonly script: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** `npm.cmd` on win32, `npm` elsewhere. A function so a POSIX test can ask for either. */
  readonly executableFor: (platform: string) => string;
}

export declare const GATE_COMMAND_SPEC: GateCommandSpec;

/**
 * Render an argument vector as the command an operator would type.
 *
 * Platform-neutral: always `npm`, never `npm.cmd`, so two machines' records stay comparable.
 */
export declare function renderGateCommandLabel(args: readonly string[]): string;

/** The command whose observed exit code is the evidence. Derived from the spec's argv. */
export declare const GATE_COMMAND: string;

export declare const ATTESTATION_VERSION: number;

/**
 * Why a release was refused, or `verified`.
 *
 * Eight distinct refusals because they have distinct remedies: a gate that says only "refused"
 * sends someone to read the gate instead of fixing the cause. FR-R3-135 added two — `stale-version`
 * split from `unreadable` (a superseded record needs a gate run; a file whose `version` is not a
 * number needs looking at), and `command-identity-mismatch` for a label its own recorded argv does
 * not witness.
 */
export type ReleaseVerdictReason =
  | 'verified'
  | 'dirty-tree'
  | 'no-attestation'
  | 'stale-version'
  | 'unreadable'
  | 'wrong-command'
  | 'command-identity-mismatch'
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
