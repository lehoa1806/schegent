// Feature 099 (FR-R3-015) T477a — the content hash (FR-012).
//
// The hash is what makes "opening an editor and closing it" a no-op rather than a
// version (FR-014). It is taken over the *canonical* form, never over the body as
// received, because the body arrives from the webview boundary or from a YAML
// import and its key order carries no meaning.
//
// The digest itself is a port. `node:crypto` would be the obvious import, and it
// is exactly the import FR-057 forbids in this directory — so the algorithm's
// name lives here and its implementation lives in the adapter.

import type { Digest } from './ports';
import { canonicalJson, type CanonicalJsonResult } from './canonical-json';

/**
 * Canonicalisation's refusal reasons, carried through rather than restated. Spelt
 * out here once, the two unions drift the first time one gains an arm — and the
 * arm they would disagree about is a body this store then hashes as if it were
 * fine.
 */
type CanonicalRefusalReason = Extract<CanonicalJsonResult, { outcome: 'refused' }>['reason'];

export type ContentHashResult =
  | { readonly outcome: 'hashed'; readonly contentHash: string; readonly canonical: string }
  | {
      readonly outcome: 'refused';
      readonly reason: CanonicalRefusalReason;
      readonly at: string;
    };

/**
 * `sha256:<lowercase hex>` over the canonical form of `body`.
 *
 * Returns the canonical text alongside the hash because the caller needs both and
 * canonicalising twice would be a second chance to disagree with itself.
 */
export function contentHashOf(body: unknown, digest: Digest): ContentHashResult {
  const canonical = canonicalJson(body);
  if (canonical.outcome === 'refused') {
    return { outcome: 'refused', reason: canonical.reason, at: canonical.at };
  }
  return {
    outcome: 'hashed',
    contentHash: digest.sha256(canonical.text),
    canonical: canonical.text
  };
}
