import * as fsp from 'node:fs/promises';

/**
 * Feature 217 (FR-002, FR-003, FR-007) — the product's one narrowing mechanism.
 *
 * A `mode` passed to `open` or `mkdir` applies only when the path is CREATED, so
 * every evidence file and directory an earlier release made under the process
 * umask keeps the group and other bits it was born with. This routine takes those
 * bits away from a path that already exists, in place: no recreate, no truncate,
 * so a hash-chained log stays the same file.
 *
 * It was `tightenIfPermissive` in `src/audit/verbose-diagnostic-writer.ts`, the
 * only correct copy in the tree, and it moved here rather than being written a
 * second time. Its callers are `openWithinRoot` in `safe-open.ts`, which
 * narrows the leaf each writing open reaches and, when the open declares a
 * `dirMode`, the directories it walks through; `evidence-narrowing.ts`, which
 * narrows the rotated files no open reaches; and the directories that the
 * diagnostic writer, `ownership-fs.ts` and `catalog-fs-adapter.ts` prepare
 * themselves. `tests/lint/evidence-sink-mode-census.test.ts` fails on a `chmod`,
 * `lchmod` or `fchmod` anywhere else, in any member syntax the source spells on
 * any receiver (after a dot; in brackets as a literal, bare or under parentheses,
 * `as`, `satisfies`, `!` or `<T>`; or as a destructured key), and on a name it
 * reads but cannot follow to `node:fs`, unless the place carries a stated reason.
 * It reads syntax, not types, so review is the control for a `chmod` whose name
 * the source does not spell (a key any other expression computes, or reflection
 * over its receiver), a cast past a port, a module loaded any other way
 * (`module.require`, a function `createRequire` returns,
 * `process.getBuiltinModule`, code evaluated from a string), and a mode a spawned
 * process changes. The census header is the full statement.
 */

/**
 * Bits that must never be set on a diagnostic path: group and other, all classes.
 *
 * Moved verbatim with the routine below (feature 217). It now names the bits no
 * evidence path may carry, of any class.
 */
export const NON_OWNER_BITS = 0o077;

/** What one narrowing did. Never thrown: a platform limit is an answer, not an error. */
export type NarrowOutcome =
  | { readonly outcome: 'narrowed'; readonly previousMode: number }
  | { readonly outcome: 'already-private' }
  | { readonly outcome: 'refused-symlink'; readonly reason: string }
  | {
      readonly outcome: 'unsupported';
      /** The platform's own message. It can name the path, so it is never logged. */
      readonly reason: string;
      /** A bounded errno-shaped code, or `not-applied`. Safe to log. */
      readonly code: string;
    };

const ERRNO_CODE = /^[A-Z][A-Z0-9_]{0,31}$/;
const UNKNOWN_CODE = 'unknown';
const NOT_APPLIED = 'not-applied';
const PERMISSION_BITS = 0o777;

/**
 * Narrow a path's mode to `desired` if it currently grants anything outside the
 * owner. Never widens the mode it read. Records what it did, because silently
 * changing a permission is the same class of surprise as silently leaving one
 * open.
 *
 * A platform that cannot report or enforce modes lands in the catch, which
 * records the limitation rather than letting the caller believe the path is
 * private.
 *
 * Feature 217 — recording is now the caller's: the outcome says what happened and
 * `noticeFor` turns it into a path-free record. The mode is read back after the
 * `chmod` because a platform can accept the call without applying it (Windows
 * synthesises modes and only toggles the read-only attribute; some network mounts
 * ignore it), and claiming `narrowed` there would be the false private this
 * routine exists to prevent. The result is `current & desired` with every
 * non-owner bit cleared as well: `desired` is owner-only at every call site, but
 * its type does not say so, and a caller handing in `0o644` must not be told
 * `narrowed` while group and other can still read.
 */
export async function narrowMode(pathname: string, desired: number): Promise<NarrowOutcome> {
  try {
    // `lstat`, not `stat`, and refuse a symlink outright. `stat` reports the
    // TARGET's mode and `chmod` changes the TARGET (POSIX has no `lchmod` on
    // Linux, and Node follows the link), so on a path an attacker can plant a
    // symlink into this would become a chmod-an-arbitrary-file primitive.
    // Bounded -- the mask only ever clears bits, so the worst case is stripping
    // access from a file someone else owns the name of, not granting any -- but
    // the diagnostics directory is inside the workspace, and refusing costs
    // nothing: a real diagnostic path is never a symlink.
    const stat = await fsp.lstat(pathname);
    if (stat.isSymbolicLink()) {
      return { outcome: 'refused-symlink', reason: 'the path is a symbolic link' };
    }
    const current = stat.mode & PERMISSION_BITS;
    if ((current & NON_OWNER_BITS) === 0) return { outcome: 'already-private' };
    const target = current & desired & ~NON_OWNER_BITS;
    await fsp.chmod(pathname, target);
    const applied = (await fsp.lstat(pathname)).mode & PERMISSION_BITS;
    if (applied !== target) {
      return {
        outcome: 'unsupported',
        reason: 'the platform accepted the mode change but did not apply it',
        code: NOT_APPLIED
      };
    }
    return { outcome: 'narrowed', previousMode: current };
  } catch (error) {
    return { outcome: 'unsupported', reason: messageOf(error), code: codeOf(error) };
  }
}

/** Which kind of path a notice is about. Never which path. */
export type NarrowingScope = 'file' | 'directory';

/**
 * The path-free record of a narrowing worth telling an operator about.
 *
 * It carries no pathname and no platform message, by construction: a WARN line
 * is not a place to publish where an operator's evidence lives.
 */
export type NarrowingNotice =
  | { readonly scope: NarrowingScope; readonly outcome: 'narrowed'; readonly previousMode: number }
  | { readonly scope: NarrowingScope; readonly outcome: 'refused-symlink' }
  | { readonly scope: NarrowingScope; readonly outcome: 'unsupported'; readonly code: string };

/** The notice for one outcome, or `null` when there is nothing to say. */
export function noticeFor(scope: NarrowingScope, outcome: NarrowOutcome): NarrowingNotice | null {
  switch (outcome.outcome) {
    case 'already-private':
      return null;
    case 'narrowed':
      return { scope, outcome: 'narrowed', previousMode: outcome.previousMode };
    case 'refused-symlink':
      return { scope, outcome: 'refused-symlink' };
    case 'unsupported':
      return { scope, outcome: 'unsupported', code: outcome.code };
  }
}

function codeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && ERRNO_CODE.test(code)) return code;
  }
  return UNKNOWN_CODE;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
