// FR-R4-F09 (contract BI1) — the declaration side of `build-identity.mjs`, so `typecheck:tests` and
// the bundler configuration can see the build-time read. `TreeState` is imported rather than
// restated, as `gate-recorder.d.mts` does: the runtime module reads git through
// `gate-attestation.mjs`, and a second copy of that shape is the mistake this file avoids.
import type { TreeState } from './gate-attestation.mjs';

/** `production` exactly when `NODE_ENV` is the string `production`; otherwise `development`. */
export type BuildMode = 'production' | 'development';

/**
 * The identity stamped into a build. `commit` is 40 lowercase hex or `unknown`, and `dirty` is
 * `unknown` exactly when `commit` is.
 */
export type BuildIdentity = {
  readonly commit: string;
  readonly dirty: boolean | 'unknown';
  readonly mode: BuildMode;
};

/** The two seams a test varies. Both default to the real ones. */
export interface BuildIdentityDeps {
  readonly readTreeState?: () => TreeState;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** The identity of the build being made. Never throws: a git failure gives `unknown`. */
export declare function readBuildIdentity(deps?: BuildIdentityDeps): BuildIdentity;
