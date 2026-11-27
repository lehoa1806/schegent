import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * FR-R3-118 — is the planning envelope above `repo/`?
 *
 * Ten gates in this tree read the envelope. Nine handled its absence; one did
 * not, and raised ENOENT in a standalone execution-repository clone — which took
 * down `vitest run`, therefore `test:host`, therefore `verify:all`, therefore
 * `gate`. A clone that cannot reach a green gate cannot cut a release, and the
 * envelope README and `repo/AGENTS.md` both promise that it can.
 *
 * The predicate is `scripts/check-doc-links.mjs`'s `envelopePresent()`,
 * deliberately reproduced rather than re-invented: a fourth shape for the same
 * question is how the ten drift apart. It lives here, outside any `.test.ts`, so
 * importing it does not re-register another file's suite.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');
export const ENVELOPE_ROOT = resolve(REPO_ROOT, '..');

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when `..` holds the planning envelope rather than an unrelated parent. */
export function envelopePresent(root: string = ENVELOPE_ROOT): boolean {
  return (
    existsSync(resolve(root, 'ARCHITECTURE.md')) &&
    existsSync(resolve(root, 'CLAUDE.md')) &&
    isDir(resolve(root, 'docs'))
  );
}

/**
 * The decision a governance gate makes before it reads anything, extracted so
 * the absence path can be exercised against a synthetic root instead of being
 * asserted about. A gate that crashes rather than reports is the same defect as
 * one that passes vacuously (FR-R3-063); until FR-R3-118 only the second half of
 * that lesson had been applied here.
 */
export type GovernanceScope =
  | { readonly kind: 'envelope'; readonly specsRoot: string }
  | { readonly kind: 'skipped'; readonly reason: string };

export function resolveGovernanceScope(root: string = ENVELOPE_ROOT): GovernanceScope {
  if (!envelopePresent(root)) {
    return {
      kind: 'skipped',
      reason:
        `no planning envelope at ${root} — this is a standalone execution-repository ` +
        `clone, and spec traceability is governed by the envelope that is not here`
    };
  }
  return { kind: 'envelope', specsRoot: resolve(root, 'specs') };
}
