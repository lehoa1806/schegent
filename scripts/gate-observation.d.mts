// FR-R4-F09 (contract GR2; TA5) -- the declaration side of `gate-observation.mjs`, so the recorder's
// declaration and `typecheck:tests` can see the observation and its seams. The observation is the
// four fields a version-3 gate record carries after `nodeVersion`. Type aliases rather than
// interfaces, deliberately: an alias gets an implicit index signature, so a test may hold a record
// typed over `Record<string, unknown>` and still be checked against these exact keys, as
// `gate-recorder.d.mts` does for the record itself.

export type GateTreeName = 'root' | 'webview-ui';

/** `matches`, `differs` (with a count), `absent` (no hidden lockfile) or `unreadable`. */
export type InstallState = 'matches' | 'differs' | 'absent' | 'unreadable';

export type TreeObservation = {
  readonly tree: GateTreeName;
  /** Repository-relative. */
  readonly lockfile: string;
  /** The SHA-256 of the lockfile's bytes, or `null` when it could not be read. */
  readonly lockfileSha256: string | null;
  readonly install: InstallState;
  /** Present exactly when `install` is `differs`. */
  readonly installDifferences?: number;
};

export type GateObservation = {
  /** `.nvmrc` trimmed, or `null` when absent, empty or over 64 bytes. */
  readonly nodeDeclared: string | null;
  readonly nodeMatchesDeclared: boolean;
  readonly envelope: { readonly present: boolean };
  /** Exactly `root` then `webview-ui`. */
  readonly trees: readonly [TreeObservation, TreeObservation];
};

export interface ObserveGateEnvironmentInput {
  /** Absolute repository root. Joined to each path read; never returned. */
  readonly root: string;
  /** The bytes of a file. Throws with `code: 'ENOENT'` when it does not exist. */
  readonly readFile: (path: string) => Buffer;
  /** `envelopePresent` from `check-doc-links.mjs`, called once. */
  readonly envelopePresent: () => boolean;
  /** `process.version`, for example `v24.19.0`. */
  readonly nodeVersion: string;
}

/** Observe the environment the gate is about to run in. Describes; never refuses. */
export declare function observeGateEnvironment(input: ObserveGateEnvironmentInput): GateObservation;
