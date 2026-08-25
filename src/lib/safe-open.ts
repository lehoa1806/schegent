import * as fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';

/**
 * FR-R3-053 (H-02) — open a file under a trusted root without ever letting a
 * symlink decide where the bytes go, and RETAIN the descriptor so the pathname
 * is never resolved twice.
 *
 * The defect this replaces: `path.join(root, '.schegent', 'audit.log')` followed
 * by `mkdir -p` and `appendFile`. Both follow symlinks, so a `.schegent` symlink
 * that ALREADY EXISTS inside the workspace redirects the next append out of it.
 * No race is needed, and the append-only evidence record is what gets written
 * somewhere else. Reproduced in `tests/unit/audit/audit-path-containment.test.ts`
 * before this module existed.
 *
 * WHY A DESCRIPTOR AND NOT A VERDICT
 *
 * `src/lib/path-containment.ts` answers "is this path contained?", which is the
 * right question for a one-shot destructive operation. It is the wrong shape for
 * a sink that appends for the lifetime of a run: every append re-resolves a
 * mutable pathname, so a verdict is only true until the next syscall. Holding
 * the verified descriptor removes re-resolution instead of racing it.
 *
 * WHAT THIS CANNOT DO, STATED PLAINLY
 *
 * The deliverable asks for a walk over trusted directory HANDLES -- `openat(2)`
 * relative to a verified parent fd. **Node does not expose `openat`**, and there
 * is no portable substitute (`/proc/self/fd` is Linux-only). So the walk here
 * checks each component with `lstat` and opens the leaf `O_NOFOLLOW`, then
 * `fstat`s the handle it actually got. That closes the no-race hole completely
 * -- a symlink at any component is refused -- and narrows the racing window to
 * "a component is swapped between its `lstat` and the next syscall", which
 * remains open. Closing it needs `openat(2)` — a handle-relative walk — and therefore a native
 * addon. FR-R3-083 asked that question once for all four residuals that share it and answered it:
 * see `docs/architecture/native-binding-decision.md`. The answer is **no**, so this window is a
 * PERMANENT stated limit rather than an open follow-up, and `tests/lint/safe-open-migration.test.ts`
 * carries it under that disposition.
 */

/** Why a safe open was refused. Bounded, and safe to log. */
export type SafeOpenRefusal =
  /** A path component is a symbolic link. */
  | 'symlink-component'
  /** The leaf itself is a symbolic link (`O_NOFOLLOW` refused the open). */
  | 'symlink-leaf'
  /**
   * The leaf carries a reparse point, on a platform with no `O_NOFOLLOW`.
   *
   * Kept DISTINCT from `symlink-leaf` because the two are different checks with
   * different strength, and an operator reading a refusal should be able to tell
   * which one answered. `symlink-leaf` is the kernel refusing the open atomically.
   * This one is a check-then-open, so it is a narrowing and not a guarantee.
   */
  | 'reparse-point-leaf'
  /** A component that must be a directory is not one. */
  | 'not-a-directory'
  /** The opened descriptor is not a regular file. */
  | 'not-a-regular-file'
  /** The relative path escapes the root, or is not relative at all. */
  | 'escapes-root'
  /** A syscall failed, so nothing could be proven. */
  | 'io-failed';

export type SafeOpenResult =
  | { readonly outcome: 'opened'; readonly handle: fsp.FileHandle }
  | {
      readonly outcome: 'refused';
      readonly reason: SafeOpenRefusal;
      readonly errno: string;
    };

function errnoOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
}

function refuse(reason: SafeOpenRefusal, errno = 'none'): SafeOpenResult {
  return { outcome: 'refused', reason, errno };
}

/**
 * `O_NOFOLLOW` is POSIX. On Windows the flag does not exist and Node ignores
 * it, so the leaf check there rests on the `lstat` below plus the reparse-point
 * check FR-R3-083 added at the leaf.
 *
 * That check reaches the reparse ATTRIBUTE, not the reparse TAG. Distinguishing tags — a mount point
 * from a dedup reparse from an OneDrive placeholder — needs `FSCTL_GET_REPARSE_POINT`, which is a
 * native call. `docs/architecture/native-binding-decision.md` answered that question **no**, so the
 * tag-level distinction is a PERMANENT stated limit.
 */
// Typed as `Partial` because the ambient types claim `number` unconditionally
// while Windows Node does not define this constant at all. Asserting the type
// lie is what makes the `??` necessary rather than dead defensive code.
const NOFOLLOW: number = (fsConstants as Partial<typeof fsConstants>).O_NOFOLLOW ?? 0;

/**
 * Reject anything that is not a plain forward step. `path.join` would happily
 * absorb `..` and an absolute segment would replace the root outright, which is
 * how a lexical composition becomes an escape.
 */
/**
 * FR-R3-083 (T1132-T1135) — should this leaf be refused as a reparse point?
 *
 * WHAT THIS CLOSES, AND WHY IT WAS OPEN
 *
 * The walk `lstat`s every DIRECTORY component and opens the leaf `O_NOFOLLOW`.
 * `NOFOLLOW` is `0` on Windows, so on that platform the leaf open followed
 * whatever the entry pointed at, and nothing looked. A symlink or a junction AT
 * THE LEAF -- the last component, the one being written to -- redirected the bytes,
 * and the module's own comment said the check "rests on the `lstat` below", which
 * was a description of a check the leaf never received.
 *
 * `lstat` reports both `IO_REPARSE_TAG_SYMLINK` and `IO_REPARSE_TAG_MOUNT_POINT`
 * (a junction) as symbolic links, so those two -- the reparse kinds that redirect a
 * path -- are reachable and are refused.
 *
 * WHAT IT DOES NOT CLOSE, STATED RATHER THAN IMPLIED
 *
 * Other reparse tags (cloud placeholders, dedup, app-exec links) are reported by
 * `lstat` as ordinary files, so this cannot see them. Telling tags apart needs
 * `FSCTL_GET_REPARSE_POINT`, which is a native call.
 * `docs/architecture/native-binding-decision.md` answered that question **no**, so
 * the tag-level distinction is a PERMANENT stated limit.
 *
 * And this is a check-then-open, not an atomic refusal: an entry swapped between
 * the `lstat` and the `open` is the same component-swap window the walk's other
 * components have, recorded in that same decision.
 *
 * PURE, so the classification is reachable from a test on ANY platform -- including
 * the ones where the arrangement cannot be created at all.
 */
export function refusesLeafAsReparsePoint(
  leafStat: { isSymbolicLink(): boolean },
  platformHasNoFollow: boolean
): boolean {
  // On a platform with `O_NOFOLLOW` the kernel already refused atomically, and a
  // second, weaker check would only add a syscall and a race to a settled answer.
  if (platformHasNoFollow) return false;
  return leafStat.isSymbolicLink();
}

function invalidSegment(segment: string): boolean {
  return (
    segment.length === 0 ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\') ||
    path.isAbsolute(segment)
  );
}

/**
 * Walk `segments` under `root`, refusing a symlink at every component, creating
 * intermediate directories when asked, and return an open handle to the leaf.
 *
 * `root` itself is trusted by the caller and is NOT re-verified here: it is the
 * caller's own workspace root, and a caller that cannot trust it has a different
 * problem than this function can solve.
 */
type SafeOpenRefusalResult = Extract<SafeOpenResult, { outcome: 'refused' }>;

/**
 * FR-R3-053 — the component walk, shared by the file open and the
 * directory-only entry point.
 *
 * `lstat`, never `stat`, so a symlink is reported AS a symlink rather than as
 * whatever it points at. That is the check the old `path.join` + `mkdir -p` had
 * none of.
 */
async function walkDirectories(
  root: string,
  segments: readonly string[],
  options: { readonly createDirs?: boolean; readonly dirMode?: number }
): Promise<{ readonly outcome: 'ready'; readonly directory: string } | SafeOpenRefusalResult> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat: Awaited<ReturnType<typeof fsp.lstat>> | null = null;
    try {
      stat = await fsp.lstat(current);
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT') return refuse('io-failed', errnoOf(error)) as SafeOpenRefusalResult;
      if (options.createDirs !== true) return refuse('io-failed', 'ENOENT') as SafeOpenRefusalResult;
      try {
        // `mkdir` without `recursive` fails if the name already exists, which is
        // the behaviour wanted here: a component that appeared between the
        // `lstat` and now is not silently adopted.
        await fsp.mkdir(current, { mode: options.dirMode });
      } catch (mkdirError) {
        if (errnoOf(mkdirError) !== 'EEXIST') {
          return refuse('io-failed', errnoOf(mkdirError)) as SafeOpenRefusalResult;
        }
      }
      try {
        stat = await fsp.lstat(current);
      } catch (error) {
        return refuse('io-failed', errnoOf(error)) as SafeOpenRefusalResult;
      }
    }
    if (stat.isSymbolicLink()) return refuse('symlink-component') as SafeOpenRefusalResult;
    if (!stat.isDirectory()) return refuse('not-a-directory') as SafeOpenRefusalResult;
  }
  return { outcome: 'ready', directory: current };
}

/**
 * FR-R3-079 (T1056) — judge a directory chain WITHOUT creating any of it.
 *
 * `ensureDirWithinRoot` walks and creates; the dispatch-time output check needs
 * the walk and must create nothing, because a declared output that does not
 * exist yet must not be brought into existence by its own containment check. A
 * missing component answers `io-failed`/`ENOENT`, which the caller reads as
 * "there is nothing here to be redirected through" rather than as a refusal to
 * dispatch — see `services/dispatch-output-guard.ts` for that reading.
 */
export async function walkDirectoriesWithinRoot(
  root: string,
  segments: readonly string[]
): Promise<{ readonly outcome: 'ready'; readonly directory: string } | SafeOpenRefusalResult> {
  return walkDirectories(root, segments, { createDirs: false });
}

/**
 * FR-R3-053 — create a DIRECTORY chain under a trusted root, safely, with no
 * leaf file.
 *
 * The first version of this migration spelled "make this directory" as "open a
 * marker file inside it", and the marker was wrong twice: it appeared in
 * directory listings that assert their exact contents, and an operator browsing
 * checkpoints or diagnostics would have found a stray dotfile with no
 * explanation. A directory is a legitimate thing to want and should not have to
 * be spelled as a file.
 */
export async function ensureDirWithinRoot(
  root: string,
  segments: readonly string[],
  dirMode?: number
): Promise<{ readonly outcome: 'ready' } | SafeOpenRefusalResult> {
  // One walk, two shapes: this is the anchor primitive minus the returned
  // path, delegated so the next containment fix lands in exactly one place.
  const made = await ensureAnchorWithinRoot(root, segments, dirMode);
  return made.outcome === 'refused' ? made : { outcome: 'ready' };
}

/**
 * FR-R3-069 (feature 152) — create a store ANCHOR's own chain beneath a higher
 * trusted root, and hand back the composed anchor path.
 *
 * `openWithinRoot` trusts and never creates its own root — the right contract,
 * and exactly what a store adapter cannot satisfy when the directory it must
 * create IS the root it was anchored at (the FR-R3-053 §4c.1 reverted attempt:
 * every election refused `io-failed ENOENT` because the walk had no existing
 * ancestor). This is the missing primitive that item named: the workspace root
 * is the trusted anchor, the store directory is segments beneath it, and the
 * same `lstat` walk that refuses a symlinked component refuses a symlinked
 * `.schegent` or store directory BY NAME instead of adopting its target.
 *
 * The returned `anchor` is for path composition only. Trust stays with `root`:
 * a caller that anchored later judgments at the returned path would trust a
 * directory a checkout can swap for a link after this call — the exact defect
 * FR-R3-069 removes. Concurrent first-creation is safe: each component's
 * `mkdir` tolerates `EEXIST` and the component is re-`lstat`ed afterwards.
 */
export async function ensureAnchorWithinRoot(
  root: string,
  segments: readonly string[],
  dirMode?: number
): Promise<{ readonly outcome: 'ready'; readonly anchor: string } | SafeOpenRefusalResult> {
  if (segments.length === 0 || segments.some(invalidSegment)) {
    return refuse('escapes-root') as SafeOpenRefusalResult;
  }
  const walked = await walkDirectories(root, segments, { createDirs: true, dirMode });
  return walked.outcome === 'refused'
    ? walked
    : { outcome: 'ready', anchor: walked.directory };
}

export async function openWithinRoot(
  root: string,
  segments: readonly string[],
  options: {
    /** Node open flags for the leaf, e.g. `'a'` for append. */
    readonly flags: string;
    /** Create missing intermediate directories. Each is created with this mode. */
    readonly createDirs?: boolean;
    readonly dirMode?: number;
    readonly fileMode?: number;
  }
): Promise<SafeOpenResult> {
  if (segments.length === 0 || segments.some(invalidSegment)) {
    return refuse('escapes-root');
  }

  const walked = await walkDirectories(root, segments.slice(0, -1), options);
  if (walked.outcome === 'refused') return walked;
  const current = walked.directory;

  const leaf = path.join(current, segments[segments.length - 1]);
  // Translated OUTSIDE the try. Inside it, an unsupported `flags` value would be
  // caught and reported as `io-failed` -- a programming error disguised as a
  // filesystem one, which is the opposite of what this function promises.
  const flagBits = NOFOLLOW | toFlagBits(options.flags);

  // FR-R3-083 — the leaf check this platform's `O_NOFOLLOW` will not perform.
  // Skipped entirely where `NOFOLLOW` is real, so the POSIX path keeps its exact
  // syscall sequence and its exact refusals.
  if (NOFOLLOW === 0) {
    try {
      const leafStat = await fsp.lstat(leaf);
      if (refusesLeafAsReparsePoint(leafStat, false)) return refuse('reparse-point-leaf');
    } catch (error) {
      // ENOENT is the ordinary case for a creating open: there is no entry to be a
      // reparse point. Anything else could not be proven, and a leaf that cannot be
      // proven is not opened.
      const errno = errnoOf(error);
      if (errno !== 'ENOENT') return refuse('io-failed', errno);
    }
  }

  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(leaf, flagBits, options.fileMode);
  } catch (error) {
    // ELOOP is what `O_NOFOLLOW` reports for a symlinked leaf. Named separately
    // because "the file you asked for is a link" is a refusal an operator can
    // act on, where a bare errno is not.
    const errno = errnoOf(error);
    if (errno === 'ELOOP') return refuse('symlink-leaf', errno);
    return refuse('io-failed', errno);
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      return refuse('not-a-regular-file');
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    return refuse('io-failed', errnoOf(error));
  }

  return { outcome: 'opened', handle };
}

/**
 * Node's string flags are a convenience over the numeric ones, and they cannot
 * be combined with `O_NOFOLLOW`. Only the modes this codebase's sinks use are
 * translated; anything else is a programming error and says so, rather than
 * silently opening with the wrong intent.
 */
function toFlagBits(flags: string): number {
  switch (flags) {
    case 'a':
      return fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY;
    case 'r':
      return fsConstants.O_RDONLY;
    case 'w':
      return fsConstants.O_TRUNC | fsConstants.O_CREAT | fsConstants.O_WRONLY;
    case 'wx':
      // Create-exclusive. EEXIST from this is a normal outcome for a caller that
      // must never overwrite an existing file, not a failure.
      return fsConstants.O_EXCL | fsConstants.O_CREAT | fsConstants.O_WRONLY;
    default:
      throw new Error(`openWithinRoot: unsupported flags ${JSON.stringify(flags)}`);
  }
}

/**
 * FR-R3-053 — the same walk, for a caller that already holds an absolute path.
 *
 * Several sinks are PORTS: they receive a pathname from whoever calls them and
 * have no segment list to offer. Requiring segments there would mean an interface
 * change at every call site, and the ones that matter most are exactly the ones
 * with the most callers.
 *
 * So the segments are derived, and the derivation is the check: `path.relative`
 * from the root, refused if it escapes or is absolute, then split. Every segment
 * still goes through `invalidSegment`, so `..` cannot arrive by a different door
 * than it would through `openWithinRoot` directly. This is a convenience over the
 * same primitive, not a second one with different rules.
 */
export async function openWithinRootByPath(
  root: string,
  absolutePath: string,
  options: Parameters<typeof openWithinRoot>[2]
): Promise<SafeOpenResult> {
  const segments = segmentsUnderRoot(root, absolutePath);
  if (segments === null) return refuse('escapes-root');
  return openWithinRoot(root, segments, options);
}

/**
 * The path's segments relative to `root`, or `null` when it is not under it.
 *
 * Exported because a caller that needs to create a DIRECTORY (not a file) has to
 * express that as a leaf inside it, and doing that arithmetic at each call site
 * would put the escape check back in several places.
 */
export function segmentsUnderRoot(root: string, absolutePath: string): readonly string[] | null {
  const relative = path.relative(root, absolutePath);
  if (relative.length === 0) return null;
  // `'..' + sep`, not a bare `'..'` prefix. A directory legitimately named
  // `..scratch` inside the root relativizes to `..scratch/x`, which starts with
  // `..` and is INSIDE — rejecting it refused a contained path. The escape
  // shapes are exactly `..` itself and anything below it, which is what
  // `resolveWithinWorkspace` has always tested and what this now matches; the
  // two rules disagreeing is how an operator-named target could pass request-time
  // validation and then be refused at dispatch as `escapes-root`.
  if (relative === '..' || relative.startsWith('..' + path.sep)) return null;
  if (path.isAbsolute(relative)) return null;
  return relative.split(path.sep);
}
