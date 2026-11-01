// FR-R4-F09 (FR-032, US7-4; contract BI3, research R3) -- which build this is, read where it can
// be read.
//
// An installed extension has no checkout, so it cannot ask git which commit built it. The build
// asks once, at build time, and esbuild stamps the answer into the bundle as the constant
// `__SCHEGENT_BUILD_IDENTITY__` (`esbuild.config.mjs`, through `scripts/build-identity.mjs`). This
// module reads that constant, and it is the only place the host does.
//
// WHY EVERY FIELD IS CHECKED BY PATTERN. The identity is shown in a diagnostics bundle that a person
// attaches to a report. It is therefore shaped like data and never believed like code: a commit
// is 40 lowercase hex or `unknown`, `dirty` is a boolean or `unknown`, and `mode` is `production`
// or `development`. Anything else, including a value that is almost right, becomes the unknown
// identity as a whole. A value is never repaired, truncated or partly kept, because a half-trusted
// identity reads as an identity.
//
// UNDER A RUNNER THAT STAMPED NOTHING (vitest, the tsc-compiled integration suite) the constant
// does not exist, and the honest answer is `unknown`. The read guards for that with `typeof`, which
// is also what esbuild's `define` folds away in a real build.
//
// No `vscode` import: this is pure, so it stays on the safe side of the headless boundary (hard
// rule 13) and is testable without a host. The identity names no path and carries no secret, so the
// redaction set (hard rules 1 and 23) has nothing here to redact.

/** Stamped into the bundle by esbuild `define`. Absent in a build that did not stamp it. */
declare const __SCHEGENT_BUILD_IDENTITY__: unknown;

export interface BuildIdentity {
  /** 40 lowercase hex, or `unknown`. Never abbreviated. */
  readonly commit: string;
  readonly dirty: boolean | 'unknown';
  /** `unknown` exists only in the unknown identity: it means "not built by this build". */
  readonly mode: 'production' | 'development' | 'unknown';
}

/** What an unstamped or malformed build reads as. */
export const UNKNOWN_BUILD_IDENTITY: BuildIdentity = Object.freeze({
  commit: 'unknown',
  dirty: 'unknown',
  mode: 'unknown'
});

const FULL_COMMIT = /^[0-9a-f]{40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The identity `raw` describes, or the unknown identity when it does not describe one.
 *
 * `raw` defaults to the constant esbuild stamped, behind a `typeof` guard so a build that stamped
 * nothing reads as unknown instead of throwing.
 */
export function readBuildIdentity(
  raw: unknown = typeof __SCHEGENT_BUILD_IDENTITY__ === 'undefined' ? undefined : __SCHEGENT_BUILD_IDENTITY__
): BuildIdentity {
  if (!isRecord(raw)) return UNKNOWN_BUILD_IDENTITY;
  const { commit, dirty, mode } = raw;
  if (typeof commit !== 'string' || (commit !== 'unknown' && !FULL_COMMIT.test(commit))) {
    return UNKNOWN_BUILD_IDENTITY;
  }
  if (typeof dirty !== 'boolean' && dirty !== 'unknown') return UNKNOWN_BUILD_IDENTITY;
  if (mode !== 'production' && mode !== 'development') return UNKNOWN_BUILD_IDENTITY;
  return { commit, dirty, mode };
}
