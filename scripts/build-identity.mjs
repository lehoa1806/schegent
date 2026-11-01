// FR-R4-F09 (FR-032; contract BI1; research R3) — which commit, and which mode, built this bundle.
//
// A release candidate, an installed extension and a diagnostics bundle all need to answer one
// question without a checkout: "what built this?". The answer is read once, here, at build time,
// stamped into the host bundle by esbuild's `define`, written into both module graphs, and copied
// into the release record. This module is the only reader, so the halves of one build cannot
// disagree about their own identity unless they were built from different trees, which is the
// case the SBOM and the release driver refuse.
//
// WHY `unknown` AND NEVER A GUESS. A git failure, a directory that is not a checkout, and a HEAD
// that is not a full 40-character lowercase hex id all give `commit: 'unknown'`, and the dirty flag
// is `unknown` exactly when the commit is. An abbreviated id in a record reads as an identity and
// is not one, so an id is never truncated, lowercased or repaired. The release path refuses a
// build whose identity is unknown; a development build simply says so.
//
// The tree state comes from `readTreeState` in `gate-attestation.mjs`, so the gate record and the
// build identity read git through one function. Both seams are injected for the same reason the
// gate recorder injects its own: a test must vary them, and nothing else about this is varied.
import { readTreeState as readGitTreeState } from './gate-attestation.mjs';

const FULL_COMMIT = /^[0-9a-f]{40}$/;

/**
 * The identity of the build being made: `{ commit, dirty, mode }`.
 *
 * `mode` describes the host half (`production` minifies and drops the source map) and is
 * `production` exactly when `NODE_ENV` is the string `production`.
 *
 * @param {{ readTreeState?: () => { head: string, treeClean: boolean },
 *   env?: Readonly<Record<string, string | undefined>> }} [deps]
 * @returns {{ commit: string, dirty: boolean | 'unknown', mode: 'production' | 'development' }}
 */
export function readBuildIdentity({ readTreeState = readGitTreeState, env = process.env } = {}) {
  const mode = env.NODE_ENV === 'production' ? 'production' : 'development';

  let state;
  try {
    state = readTreeState();
  } catch {
    return { commit: 'unknown', dirty: 'unknown', mode };
  }

  const head = typeof state?.head === 'string' ? state.head : '';
  if (!FULL_COMMIT.test(head)) return { commit: 'unknown', dirty: 'unknown', mode };
  return { commit: head, dirty: state.treeClean !== true, mode };
}
