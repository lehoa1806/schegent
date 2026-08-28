// FR-R3-135 — the declaration side of `gate-recorder.mjs`, so `typecheck:tests` can see the
// recorder's injected seams without the script becoming TypeScript. Same arrangement as
// `gate-attestation.d.mts`, and it exists for the same reason the recorder exists at all: the
// argv the recorder spawns is now an assertion in a unit test, and an assertion the typechecker
// cannot see is one that can drift from the thing it asserts about.
//
// `TreeState` is imported rather than restated. The runtime module imports from
// `gate-attestation.mjs` too, and the defect this item closed was a second copy of a fact that
// had one authority — restating the shape here would be the same mistake in a smaller place.
import type { TreeState } from './gate-attestation.mjs';

/**
 * `spawnSync`'s result, narrowed to the three fields the recorder reads.
 *
 * `status: null` is signal termination, and is NOT interchangeable with `0` — the recorder turns
 * it into a `signal:` string rather than a pass. `error` is set when the child could never be
 * started, which the recorder treats as "no gate ran", not "the gate failed".
 */
export type GateSpawnResult = {
  readonly status: number | null;
  readonly signal: string | null;
  readonly error?: Error;
};

/**
 * The options the recorder passes to its spawn.
 *
 * A type alias rather than an interface, deliberately: an alias gets an implicit index signature,
 * so a test may supply a spawn typed over a plain `Record<string, unknown>` bag and still be
 * checked against these exact keys.
 *
 * `stdio: 'inherit'` is what makes the operator watch the real gate; `shell: false` is what keeps
 * the argument vector a vector rather than a string a shell re-splits.
 */
export type GateSpawnOptions = {
  readonly cwd: string;
  readonly stdio: 'inherit';
  readonly shell: false;
  readonly encoding: 'utf8';
};

/**
 * The record the recorder writes.
 *
 * `command` is the derived label and `commandArgv` is its witness: `decideRelease` refuses a
 * record whose label its own argv does not account for. `exitCode` carries a `signal:` string for
 * a child killed by a signal, because a signalled gate is not a gate that returned zero.
 */
export type GateAttestationRecord = {
  readonly version: number;
  readonly command: string;
  readonly commandExecutable: string;
  readonly commandArgv: readonly string[];
  readonly head: string;
  /** Always `true`: a record is only written for a tree that was clean before and after. */
  readonly treeClean: true;
  readonly exitCode: number | `signal:${string}`;
  readonly platform: string;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly startedAt: string;
  readonly recordedAt: string;
};

/**
 * Every dependency whose behaviour a test needs to vary. Nothing else is injected — see the
 * runtime module's header for why `process.arch` and `process.version` are read directly.
 */
export interface RecordGateRunDeps {
  /** Synchronous child-process spawn. `spawnSync`'s shape, narrowed to what is read. */
  readonly spawn: (
    executable: string,
    args: readonly string[],
    options: GateSpawnOptions
  ) => GateSpawnResult;
  /** `process.platform`, injected so the win32 executable resolution is assertable from POSIX. */
  readonly platform: string;
  readonly readTreeState: () => TreeState;
  /** Durable write. The `fsync` barrier lives in the caller's implementation, not here. */
  readonly writeAttestation: (attestation: GateAttestationRecord) => void;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
  /** ISO-8601 timestamp source. */
  readonly now: () => string;
}

/**
 * Why the recorder returned what it did.
 *
 * Recorder-internal, and read by tests rather than by production: the CLI exits on `exitCode` and
 * the operator-facing text has already gone through `error`. It exists so a test can separate
 * `spawn-failed` from `tree-moved` — both exit 2 — without matching on message prose, and it
 * shares no namespace with `decideRelease`'s release-side `ReleaseVerdictReason`.
 */
export type RecordGateRunReason =
  | 'passed'
  | 'gate-failed'
  | 'dirty-tree-before'
  | 'spawn-failed'
  | 'tree-moved';

export interface RecordGateRunResult {
  /** 0 pass, 1 recorded failure, 2 refused without recording. */
  readonly exitCode: 0 | 1 | 2;
  /** The record written, or `null` on a refusal — which is what "wrote nothing" means. */
  readonly attestation: GateAttestationRecord | null;
  readonly reason: RecordGateRunReason;
}

/**
 * Observe the gate and produce the record. Never calls `process.exit`; the caller owns the process.
 */
export declare function recordGateRun(deps: RecordGateRunDeps): RecordGateRunResult;
