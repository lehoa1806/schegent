// Feature 087 (T014, FR-015) — the canonical-workspace boundary for every
// operator-supplied path in a Run Request.
//
// Plan D5: this is the `path.relative` idiom that `runtime-log-path.ts`'s
// private `isUnderAllowedRoot` already uses, applied to the workspace root
// instead of the log roots. That helper is not exported and its roots are not
// this root, so widening it would change a contract two subsystems depend on;
// the idiom is reused, the function is not.
//
// The order matters and is OWASP's: resolve to canonical form FIRST, then test
// containment relationally. A prefix compare accepts `/workspace-evil` for root
// `/workspace`; `path.relative` produces a hop count, which does not.
//
// Purely lexical — it touches no filesystem and imports no `vscode`. Symlinks
// are a separate concern with a separate mitigation, in `local-input-validator.ts`.

import * as path from 'node:path';

export type ContainmentResult =
  | { readonly ok: true; readonly absolutePath: string }
  | { readonly ok: false };

const REFUSED: ContainmentResult = { ok: false };

/** Written as an escape so this source file never contains a raw NUL byte. */
const NUL = '\u0000';

/**
 * Resolve `candidate` against `workspaceRoot` and return the absolute path only
 * if it lands inside the root.
 *
 * `candidate` is normally workspace-relative — the IPC contract admits nothing
 * else — but an absolute one is handled rather than trusted: `path.resolve`
 * keeps it absolute and the containment test then decides, so a pasted absolute
 * path inside the workspace works and one outside it is refused by the same rule.
 *
 * The returned `absolutePath` is host-internal. It must never reach the webview,
 * in a success response or an error (FR-020).
 */
export function resolveWithinWorkspace(
  workspaceRoot: string,
  candidate: string
): ContainmentResult {
  if (workspaceRoot.trim().length === 0 || candidate.trim().length === 0) return REFUSED;
  // A NUL truncates the path at the syscall, so what the check reads and what
  // the kernel opens can differ. Refuse here rather than let Node throw later.
  if (workspaceRoot.includes(NUL) || candidate.includes(NUL)) return REFUSED;

  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  const contained = relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  return contained ? { ok: true, absolutePath: resolved } : REFUSED;
}
