// Feature FR-R3-005 (T323) — the containment oracle every destructive
// filesystem operation in the host consults.
//
// The defect this closes is not "one path was unguarded". It is that
// containment was a function inside one service, so every other site that
// assembled a path lexically was an independent opportunity to forget — and
// several had. A lexically assembled path is not a contained path: `..` is a
// hop count `path.relative` can count, and a symlink is a hop it cannot see.
// So the check has to resolve, it has to live in one module, and it has to be
// consulted at the point of effect rather than once at a root.
//
// Three entry points, because the kernel treats the final path component
// differently depending on the operation and a single check cannot be right
// for all three:
//
//   - `resolveContainedTarget` — the operation follows the final component.
//     Recursive `rm`, `readdir`, and anything that opens an existing file land
//     here. The leaf itself is resolved, so a symlinked candidate inside an
//     otherwise contained root is caught.
//   - `resolveContainedLink`   — the operation acts on the directory entry and
//     never follows it. `unlink` and both ends of `rename` land here. The leaf
//     is deliberately NOT resolved; resolving it would refuse the legitimate
//     removal of a symlink whose target happens to sit elsewhere.
//   - `resolveContainedForWrite` — the operation follows an existing leaf and
//     creates an absent one. Appends, `writeFile`, and `open` with `O_CREAT`
//     land here.
//
// A resolution failure is a **refusal**, never a fall-through to lexical
// comparison. That is the whole point: if the host cannot prove where a path
// leads, it does not get to guess, because the guess is what a hostile
// workspace layout is built to win.
//
// TOCTOU is inherent to check-then-act on a filesystem and this module does
// not close it. Between the `realpath` here and the `rm` at the call site, a
// component can be replaced. This is risk reduction — the window shrinks from
// "the whole lifetime of the process" to "the gap between two adjacent
// syscalls" — and the docs say so in those words.

import * as nodeFs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * The one filesystem capability the oracle needs. Each consumer supplies it
 * from its own existing injectable seam, so a guard is testable without
 * creating a real symlink on the machine that runs the suite.
 */
export interface ContainmentFs {
  realpath(target: string): Promise<string>;
}

/** Why a path was refused. Bounded, and safe to put in an audit payload. */
export type ContainmentRefusal =
  /** The resolved path sits outside every allowed root. */
  | 'not-contained'
  /** A `realpath` failed, so containment could not be proven either way. */
  | 'resolve-failed';

/**
 * The errno recorded on a `not-contained` refusal. There was no I/O failure —
 * the resolution succeeded and the answer was no — but callers log a single
 * bounded field for both refusal reasons, so the arm carries a placeholder
 * rather than making every call site branch before it can log.
 */
export const NO_ERRNO = 'none';

export type ContainmentVerdict =
  /** Proven inside one of the roots. `resolved` is the path to act on. */
  | { readonly outcome: 'contained'; readonly resolved: string }
  /** The path does not exist. Not a failure — a destructive op has no work. */
  | { readonly outcome: 'absent' }
  /** Do not proceed. */
  | {
      readonly outcome: 'refused';
      readonly reason: ContainmentRefusal;
      readonly errno: string;
    };

function errnoCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
}

/** ENOENT and ENOTDIR both mean "no such path", from different components. */
function isMissing(error: unknown): boolean {
  const code = errnoCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

const ABSENT: ContainmentVerdict = Object.freeze({ outcome: 'absent' });

function refuseResolve(error: unknown): ContainmentVerdict {
  return { outcome: 'refused', reason: 'resolve-failed', errno: errnoCode(error) };
}

/**
 * Lexical containment of two **already resolved** paths. Private on purpose:
 * exporting it would put the exact primitive this feature exists to stop
 * people reaching for back within reach.
 */
function isContainedIn(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Compare one resolved path against the roots.
 *
 * A root that will not resolve is not treated as "does not contain": it might
 * have been the one that did, so an unresolvable root downgrades the verdict
 * to `resolve-failed` rather than letting the answer read as a clean refusal.
 * An empty root list refuses everything, which is the correct fail-closed
 * reading of "nothing is allowed".
 */
async function judge(
  resolved: string,
  roots: readonly string[],
  filesystem: ContainmentFs
): Promise<ContainmentVerdict> {
  let rootError: unknown = null;
  let anyContained = false;
  for (const root of roots) {
    if (typeof root !== 'string' || root.length === 0) continue;
    let resolvedRoot: string;
    try {
      resolvedRoot = await filesystem.realpath(root);
    } catch (error) {
      if (rootError === null) rootError = error;
      continue;
    }
    if (isContainedIn(resolved, resolvedRoot)) {
      anyContained = true;
      break;
    }
  }
  if (anyContained) return { outcome: 'contained', resolved };
  if (rootError !== null) return refuseResolve(rootError);
  return { outcome: 'refused', reason: 'not-contained', errno: NO_ERRNO };
}

/**
 * Resolve the deepest ancestor of `absolute` that exists, then re-append the
 * components that did not. Those components cannot be symlinks — they are not
 * anything yet — so appending them lexically is sound, while the part that
 * does exist is fully resolved.
 *
 * Terminates because `path.dirname` strictly shortens until it reaches the
 * filesystem root, where it becomes a fixed point.
 */
async function resolveNearestExisting(
  absolute: string,
  filesystem: ContainmentFs
): Promise<{ readonly resolved: string } | { readonly error: unknown }> {
  const unresolvedTail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const resolved = await filesystem.realpath(current);
      return {
        resolved: unresolvedTail.length === 0
          ? resolved
          : path.join(resolved, ...unresolvedTail)
      };
    } catch (error) {
      if (!isMissing(error)) return { error };
      const parent = path.dirname(current);
      if (parent === current) return { error };
      unresolvedTail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * For operations that follow the final path component — recursive `rm`,
 * `readdir`, opening an existing file.
 *
 * A missing target is `absent`, not a refusal: a destructive operation on a
 * path that is not there has no work to do, and the pre-first-run state of
 * every evidence directory is exactly that.
 */
export async function resolveContainedTarget(
  target: string,
  roots: readonly string[],
  filesystem: ContainmentFs = nodeFs
): Promise<ContainmentVerdict> {
  let resolved: string;
  try {
    resolved = await filesystem.realpath(target);
  } catch (error) {
    if (isMissing(error)) return ABSENT;
    return refuseResolve(error);
  }
  return judge(resolved, roots, filesystem);
}

/**
 * For operations that act on the directory entry and never follow it —
 * `unlink`, and both ends of `rename`.
 *
 * The leaf stays unresolved by design. `unlink` on a symlink removes the link,
 * so resolving the leaf would refuse a removal that never touches the target,
 * and the host would be unable to clean up its own directory because someone
 * put a link in it. What must be contained is the directory the entry lives
 * in, and that is resolved in full.
 */
export async function resolveContainedLink(
  target: string,
  roots: readonly string[],
  filesystem: ContainmentFs = nodeFs
): Promise<ContainmentVerdict> {
  const absolute = path.resolve(target);
  const parent = path.dirname(absolute);
  if (parent === absolute) {
    // The filesystem root itself. Nothing above it can contain it.
    return { outcome: 'refused', reason: 'not-contained', errno: NO_ERRNO };
  }
  const nearest = await resolveNearestExisting(parent, filesystem);
  if ('error' in nearest) return refuseResolve(nearest.error);
  return judge(path.join(nearest.resolved, path.basename(absolute)), roots, filesystem);
}

/**
 * For operations that follow an existing leaf and create an absent one —
 * appends, `writeFile`, `open` with `O_CREAT`.
 *
 * Resolves the leaf when it is there, so an existing file that is a symlink
 * out of the workspace is refused rather than written through; falls back to
 * the link form when it is not, so the first write to a fresh path is still
 * checked against whatever of its ancestry does exist.
 *
 * Never returns `absent`: a path that is about to be created is not a no-op
 * the way a path that is about to be deleted is.
 */
export async function resolveContainedForWrite(
  target: string,
  roots: readonly string[],
  filesystem: ContainmentFs = nodeFs
): Promise<ContainmentVerdict> {
  const verdict = await resolveContainedTarget(target, roots, filesystem);
  if (verdict.outcome !== 'absent') return verdict;
  return resolveContainedLink(target, roots, filesystem);
}
