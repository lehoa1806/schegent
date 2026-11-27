// FR-R6-F05 (FR-023, AC-10, SC-008) — the public shapes of qualified artifact access.
//
// An agent reaches artifact bytes only through a handle the lifecycle service issued after it
// verified the policy, the immutable version, the digest and the attempt's protective reference.
// A request names an artifact by opaque id and expected digest; it never carries a path or URI.
//
// The handle itself (`ArtifactAccessHandle`) lives in `lifecycle-types.ts` and is re-exported here.

import type { ArtifactDigest } from './lifecycle-types';

export type { ArtifactAccessHandle, ArtifactDigest } from './lifecycle-types';

export const ARTIFACT_ACCESS_MODES = ['embed', 'read'] as const;
export type ArtifactAccessMode = (typeof ARTIFACT_ACCESS_MODES)[number];

/** The only keys a qualification request may carry; anything else (a path, a URI) is refused. */
export const QUALIFY_ACCESS_REQUEST_KEYS = ['artifactId', 'expectedDigest', 'attemptId', 'sessionId', 'mode'] as const;

/** One qualification request (contract lifecycle-service.md, `qualifyAccess`). */
export interface QualifyAccessRequest {
  readonly artifactId: string;
  readonly expectedDigest: ArtifactDigest;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly mode: ArtifactAccessMode;
}

/** A materialized copy's lifetime when the caller names none: one hour. */
export const MATERIALIZED_COPY_DEFAULT_TTL_MS = 60 * 60 * 1000;

/** The longest lifetime a materialized copy may ask for: one day. A copy never pins forever. */
export const MATERIALIZED_COPY_MAX_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A copy of a qualified artifact's bytes written under a caller-named root. It shares the source
 * identity (`artifactId`, `digest`), has its own pin owner (`copyId`) and always expires.
 */
export interface MaterializedCopy {
  readonly copyId: string;
  readonly artifactId: string;
  readonly digest: ArtifactDigest;
  /** The copy's file name inside the destination root; the root itself is never echoed back. */
  readonly fileName: string;
  readonly expiresAtMs: number;
}
