import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * FR-R7-11 (Task 20) — Canonical, symlink-aware, case-folding protected-path
 * matcher shared by ACP resource-link / authority guards, lifecycle unlinks,
 * and retention/cleanup services.
 *
 * Fails closed whenever canonicalization encounters an unresolvable filesystem
 * error (`EACCES`, `EIO`, `ELOOP`, `ENOTDIR`, Win32 device namespace or ADS,
 * `..` after a missing component, or exceeded hop/step bounds).
 */

const CASE_INSENSITIVE_PLATFORM =
  process.platform === 'darwin' || process.platform === 'win32';
const IS_WIN32 = process.platform === 'win32';

const MAX_SYMLINK_HOPS = 40;
const MAX_WALK_STEPS = 1_024;

export const WORKSPACE_PROTECTED_BASENAME_PATTERNS: readonly RegExp[] = [
  /\.sqlite3?(?:-(?:wal|shm|journal))?$/i,
  /^\.env(?:\..+)?$/i,
  /^\.git-credentials$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^id_(?:rsa|ed25519|ecdsa)$/i
];

const NON_SCHEGENT_PROTECTED_SEGMENTS: ReadonlySet<string> = new Set([
  '.ssh',
  '.gnupg',
  'secrets'
]);

function isValidWin32UncHostAndShare(server: string, share: string): boolean {
  if (
    server.length === 0 ||
    share.length === 0 ||
    server === '.' ||
    server === '..' ||
    server === '?' ||
    share === '.' ||
    share === '..' ||
    share === '?' ||
    server.includes(':') ||
    share.includes(':') ||
    isUnsafeWin32TrailingDotOrSpaceSegment(server, true) ||
    isUnsafeWin32TrailingDotOrSpaceSegment(share, true)
  ) {
    return false;
  }
  return true;
}

function hasForbiddenVerbatimWin32Rest(rest: string): boolean {
  if (rest.includes('/')) {
    return true;
  }
  return rest.split('\\').some((seg) => seg === '.' || seg === '..');
}

function normalizeWin32Namespace(
  rawPath: string,
  win32Mode: boolean = IS_WIN32
): { readonly ok: true; readonly normalized: string } | { readonly ok: false } {
  if (!win32Mode) {
    return { ok: true, normalized: rawPath };
  }
  // Only accept exact backslash-only Win32 verbatim extended-length prefixes
  // (`\\?\UNC\...` and `\\?\<drive>:\...`, as emitted by `fs.realpathSync.native`)
  // with zero forward slashes and zero `.` / `..` segments. All `\\.\`, `//./`,
  // `//?/`, and `\\?/` local-device namespaces fail closed so `..` can never
  // traverse into `\??\` / `GLOBALROOT` / raw disk devices.
  const uncExt = /^\\\\\?\\UNC\\([^/\\]+)\\([^/\\]+)(?:\\(.*))?$/i.exec(rawPath);
  if (uncExt !== null) {
    const server = uncExt.at(1);
    const share = uncExt.at(2);
    const rest = uncExt.at(3) ?? '';
    if (
      server === undefined ||
      share === undefined ||
      !isValidWin32UncHostAndShare(server, share) ||
      hasForbiddenVerbatimWin32Rest(rest)
    ) {
      return { ok: false };
    }
    return {
      ok: true,
      normalized: rest.length > 0 ? `\\\\${server}\\${share}\\${rest}` : `\\\\${server}\\${share}\\`
    };
  }
  const driveExt = /^\\\\\?\\([A-Za-z]:)\\(.*)$/.exec(rawPath);
  if (driveExt !== null) {
    const drive = driveExt.at(1);
    const rest = driveExt.at(2) ?? '';
    if (drive === undefined || hasForbiddenVerbatimWin32Rest(rest)) {
      return { ok: false };
    }
    return {
      ok: true,
      normalized: rest.length > 0 ? `${drive}\\${rest}` : `${drive}\\`
    };
  }
  if (/^[/\\]{2}[?.](?:[/\\]|$)/.test(rawPath)) {
    return { ok: false };
  }
  if (/^[/\\]{2}/.test(rawPath)) {
    const plainUnc = /^[/\\]{2}([^/\\]+)[/\\]([^/\\]+)(?:[/\\](.*))?$/.exec(rawPath);
    const server = plainUnc?.at(1);
    const share = plainUnc?.at(2);
    if (
      plainUnc === null ||
      server === undefined ||
      share === undefined ||
      !isValidWin32UncHostAndShare(server, share)
    ) {
      return { ok: false };
    }
  }
  return { ok: true, normalized: rawPath };
}

function isWin32DrivelessRootRelative(
  rawPath: string,
  win32Mode: boolean = IS_WIN32
): boolean {
  return win32Mode && /^[/\\](?![/\\])/.test(rawPath);
}

function stripWin32TrailingDotsAndSpaces(segment: string): string {
  if (segment === '.' || segment === '..') return segment;
  return segment.replace(/[. ]+$/, '');
}

function isUnsafeWin32TrailingDotOrSpaceSegment(
  segment: string,
  win32Mode: boolean = IS_WIN32
): boolean {
  return win32Mode && segment !== '.' && segment !== '..' && /[. ]$/.test(segment);
}

function hasUnsafeWin32TrailingSegment(
  rawPath: string,
  win32Mode: boolean = IS_WIN32
): boolean {
  if (!win32Mode) return false;
  return rawPath
    .split(/[/\\]+/)
    .some((s) => s.length > 0 && isUnsafeWin32TrailingDotOrSpaceSegment(s, true));
}

function hasWin32AdsColonInSegments(
  rawPath: string,
  win32Mode: boolean = IS_WIN32
): boolean {
  if (!win32Mode) return false;
  const ns = normalizeWin32Namespace(rawPath, true);
  if (!ns.ok) return true;
  const p = ns.normalized;
  let rest = p;
  const uncMatch = /^[/\\]{2}[^/\\:]+[/\\][^/\\:]+(?:[/\\]|$)/.exec(p);
  if (uncMatch !== null) {
    rest = p.slice(uncMatch[0].length);
  } else {
    const driveMatch = /^[A-Za-z]:[/\\]/.exec(p);
    if (driveMatch !== null) {
      rest = p.slice(driveMatch[0].length);
    }
  }
  return rest.includes(':');
}

export function normalizeProtectedComparePath(targetPath: string): string {
  const ns = normalizeWin32Namespace(targetPath);
  const candidate = ns.ok ? ns.normalized : targetPath;
  const resolved = path.resolve(candidate);
  if (!CASE_INSENSITIVE_PLATFORM) {
    return resolved;
  }
  if (IS_WIN32) {
    const parsed = path.win32.parse(resolved);
    const rest = resolved.slice(parsed.root.length);
    const normRest = rest
      .split(/[/\\]+/)
      .map((s) => stripWin32TrailingDotsAndSpaces(s))
      .filter((s) => s.length > 0)
      .join('\\');
    return `${parsed.root}${normRest}`.toLowerCase();
  }
  return resolved.toLowerCase();
}

function matchesProtectedSegments(
  segments: readonly string[],
  allowSchegent: boolean
): boolean {
  const base = segments.at(-1) ?? '';
  if (WORKSPACE_PROTECTED_BASENAME_PATTERNS.some((pattern) => pattern.test(base))) {
    return true;
  }
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (NON_SCHEGENT_PROTECTED_SEGMENTS.has(lower)) {
      return true;
    }
    if (lower === '.schegent' && !allowSchegent) {
      return true;
    }
  }
  return false;
}

export function isWorkspaceProtectedPattern(
  targetPath: string,
  options?: { readonly allowSchegent?: boolean }
): boolean {
  if (hasWin32AdsColonInSegments(targetPath) || hasUnsafeWin32TrailingSegment(targetPath)) {
    return true;
  }
  const ns = normalizeWin32Namespace(targetPath);
  if (!ns.ok || isWin32DrivelessRootRelative(ns.normalized)) {
    return true;
  }
  const p = ns.normalized;
  const allowSchegent = options?.allowSchegent === true;
  const toSegments = (raw: string): string[] =>
    (IS_WIN32 ? raw.split(/[/\\]+/) : raw.split('/'))
      .map((s) => (IS_WIN32 ? stripWin32TrailingDotsAndSpaces(s) : s))
      .filter((s) => s.length > 0 && s !== '.');

  const normalizedSegments = toSegments(p);
  if (matchesProtectedSegments(normalizedSegments, allowSchegent)) {
    return true;
  }
  if (normalizedSegments.includes('..')) {
    const resolvedSegments = toSegments(path.resolve(p));
    if (matchesProtectedSegments(resolvedSegments, allowSchegent)) {
      return true;
    }
  }
  return false;
}

export type CanonicalPathResult =
  | { readonly ok: true; readonly canonical: string }
  | { readonly ok: false };

function splitRelativeRawSegments(rawRelative: string): string[] {
  const parts = path.sep === '\\' ? rawRelative.split(/[/\\]+/) : rawRelative.split('/');
  return parts.filter((segment) => segment.length > 0);
}

function driveRootOf(p: string): string | null {
  const m = /^([A-Za-z]:)[/\\]?/.exec(p);
  const drive = m?.at(1);
  return drive !== undefined ? `${drive}\\` : null;
}

function extractRootAndRawSegments(
  rawPath: string,
  inheritRoot?: string
): { readonly root: string; readonly segments: readonly string[] } | null {
  const ns = normalizeWin32Namespace(rawPath);
  if (!ns.ok) return null;
  const target = ns.normalized;

  if (!path.isAbsolute(target)) {
    const cwdParts = extractRootAndRawSegments(process.cwd());
    if (cwdParts === null) return null;
    return {
      root: cwdParts.root,
      segments: [...cwdParts.segments, ...splitRelativeRawSegments(target)]
    };
  }
  if (path.sep === '/') {
    return { root: '/', segments: splitRelativeRawSegments(target.slice(1)) };
  }
  const uncMatch = /^([/\\]{2}[^/\\:]+[/\\][^/\\:]+)(?:[/\\]|$)/.exec(target);
  const uncPrefix = uncMatch?.at(1);
  if (uncMatch !== null && uncPrefix !== undefined) {
    const root = `${uncPrefix.replaceAll('/', '\\')}\\`;
    return { root, segments: splitRelativeRawSegments(target.slice(uncMatch[0].length)) };
  }
  if (/^[/\\]{2}/.test(target)) {
    return null;
  }
  const driveMatch = /^([A-Za-z]:[/\\]?)/.exec(target);
  const drivePrefix = driveMatch?.at(1);
  if (driveMatch !== null && drivePrefix !== undefined) {
    const rawRoot = drivePrefix.replaceAll('/', '\\');
    const root = rawRoot.endsWith('\\') ? rawRoot : `${rawRoot}\\`;
    return { root, segments: splitRelativeRawSegments(target.slice(driveMatch[0].length)) };
  }
  // Win32 driveless root-relative path (`\foo\bar`): fail closed on initial input
  // (drive-ambiguous across child process drives); only symlink targets inherit
  // their symlink's drive root.
  if (inheritRoot === undefined) {
    return null;
  }
  const inheritedDrive = driveRootOf(inheritRoot);
  if (inheritedDrive === null) {
    return null;
  }
  return { root: inheritedDrive, segments: splitRelativeRawSegments(target.slice(1)) };
}

function buildRawPath(root: string, segments: readonly string[]): string {
  if (segments.length === 0) return root;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return `${prefix}${segments.join(path.sep)}`;
}

/**
 * Canonicalizes `targetPath` via a strict left-to-right component walk
 * (never calling `path.resolve` before symlink expansion, so `<symlink>/..`
 * and relative dangling symlink targets resolve against the symlink's real
 * physical parent directory, matching OS kernel semantics).
 *
 * When a component does not exist (`ENOENT`), subsequent segments are attached
 * as a missing tail (for absent `-wal`/`-shm` sidecars or new files); `..`
 * after a missing component, Win32 ADS `:`, Win32 raw device namespaces, or any
 * non-`ENOENT` error (`EACCES`, `EIO`, `ELOOP`, `ENOTDIR`, exceeded hop/step
 * limit) fails closed with `{ ok: false }`.
 */
export function canonicalizePathWithTailSync(targetPath: string): CanonicalPathResult {
  if (targetPath.length === 0 || targetPath.includes('\0')) {
    return { ok: false };
  }

  const initial = extractRootAndRawSegments(targetPath);
  if (initial === null) {
    return { ok: false };
  }
  let root = initial.root;
  const resolvedStack: string[] = [];
  const pendingReversed: string[] = [...initial.segments].reverse();
  let existingDepth = 0;
  let inMissingTail = false;
  let symlinkHops = 0;
  let steps = 0;

  while (pendingReversed.length > 0) {
    steps += 1;
    if (steps > MAX_WALK_STEPS) {
      return { ok: false };
    }
    const segment = pendingReversed.pop()!;
    if (segment === '' || segment === '.') {
      continue;
    }
    if (IS_WIN32 && (segment.includes(':') || isUnsafeWin32TrailingDotOrSpaceSegment(segment))) {
      return { ok: false };
    }
    if (segment === '..') {
      if (inMissingTail) {
        return { ok: false };
      }
      resolvedStack.pop();
      existingDepth = resolvedStack.length;
      continue;
    }
    if (inMissingTail) {
      resolvedStack.push(segment);
      continue;
    }

    const candidate = buildRawPath(root, [...resolvedStack, segment]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        inMissingTail = true;
        resolvedStack.push(segment);
        continue;
      }
      return { ok: false };
    }

    if (stat.isSymbolicLink()) {
      symlinkHops += 1;
      if (symlinkHops > MAX_SYMLINK_HOPS) {
        return { ok: false };
      }
      let linkTarget: string;
      try {
        linkTarget = fs.readlinkSync(candidate);
      } catch {
        return { ok: false };
      }
      if (linkTarget.length === 0 || linkTarget.includes('\0')) {
        return { ok: false };
      }
      const linkNs = normalizeWin32Namespace(linkTarget);
      if (!linkNs.ok) {
        return { ok: false };
      }
      const cleanLinkTarget = linkNs.normalized;
      if (path.isAbsolute(cleanLinkTarget)) {
        const parsedLink = extractRootAndRawSegments(cleanLinkTarget, root);
        if (parsedLink === null) {
          return { ok: false };
        }
        root = parsedLink.root;
        resolvedStack.length = 0;
        existingDepth = 0;
        for (let i = parsedLink.segments.length - 1; i >= 0; i -= 1) {
          pendingReversed.push(parsedLink.segments[i]!);
        }
      } else {
        const relSegments = splitRelativeRawSegments(cleanLinkTarget);
        for (let i = relSegments.length - 1; i >= 0; i -= 1) {
          pendingReversed.push(relSegments[i]!);
        }
      }
      continue;
    }

    resolvedStack.push(segment);
    existingDepth = resolvedStack.length;
  }

  if (IS_WIN32 && existingDepth > 0) {
    // Expand existing NTFS 8.3 short names (e.g. `ENV~1`, `SCHEGE~1`) to their
    // canonical long filenames via Win32 `GetFinalPathNameByHandleW` before
    // protected-path and containment matching.
    const existingPrefix = buildRawPath(root, resolvedStack.slice(0, existingDepth));
    let nativeReal: string;
    try {
      nativeReal = fs.realpathSync.native(existingPrefix);
    } catch {
      return { ok: false };
    }
    const realNs = normalizeWin32Namespace(nativeReal, true);
    if (!realNs.ok) {
      return { ok: false };
    }
    const missingTail = resolvedStack.slice(existingDepth);
    const canonical =
      missingTail.length > 0
        ? path.win32.join(realNs.normalized, ...missingTail)
        : realNs.normalized;
    return { ok: true, canonical };
  }

  return { ok: true, canonical: buildRawPath(root, resolvedStack) };
}

/**
 * Verifies that `rawPath` lies inside `anchorRaw` / `anchorCanonical` with
 * ZERO `..` traversal, ZERO Win32 ADS `:`, ZERO unsafe Win32 trailing
 * dot/space segments, and ZERO symbolic links at or below `anchorCanonical`.
 * Expands existing Windows NTFS 8.3 short names to long names via
 * `fs.realpathSync.native`. Returns the canonical path under `anchorCanonical`
 * when verified symlink-free, or `null` on any symlink, escape, or error.
 */
export function verifySymlinkFreeUnderAnchorSync(
  anchorRaw: string,
  anchorCanonical: string,
  rawPath: string
): string | null {
  if (
    rawPath.length === 0 ||
    rawPath.includes('\0') ||
    hasWin32AdsColonInSegments(rawPath) ||
    hasUnsafeWin32TrailingSegment(rawPath)
  ) {
    return null;
  }
  const ns = normalizeWin32Namespace(rawPath);
  if (!ns.ok || isWin32DrivelessRootRelative(ns.normalized)) return null;
  const candidate = ns.normalized;

  const resolvedCand = path.resolve(candidate);
  const parsedCand = path.parse(resolvedCand);
  const candSegs = splitRelativeRawSegments(resolvedCand.slice(parsedCand.root.length));
  const normCandRoot = CASE_INSENSITIVE_PLATFORM
    ? parsedCand.root.toLowerCase()
    : parsedCand.root;

  let relSegments: string[] | null = null;
  for (const rawBase of [anchorCanonical, anchorRaw]) {
    const baseNs = normalizeWin32Namespace(rawBase);
    if (!baseNs.ok || isWin32DrivelessRootRelative(baseNs.normalized)) {
      continue;
    }
    const base = baseNs.normalized;
    const normBase = normalizeProtectedComparePath(base);
    const normCand = normalizeProtectedComparePath(candidate);
    if (normCand === normBase) {
      relSegments = [];
      break;
    }
    const r = path.relative(normBase, normCand);
    if (r !== '' && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r)) {
      // Both `base` and `candidate` are namespace-normalized (so `\\?\UNC\` and `\\?\C:\`
      // share identical parsed root geometry) and we verify matching roots and leading
      // segments before slicing original-case relative segments.
      const resolvedBase = path.resolve(base);
      const parsedBase = path.parse(resolvedBase);
      const normBaseRoot = CASE_INSENSITIVE_PLATFORM
        ? parsedBase.root.toLowerCase()
        : parsedBase.root;
      if (normBaseRoot !== normCandRoot) {
        continue;
      }
      const baseSegs = splitRelativeRawSegments(resolvedBase.slice(parsedBase.root.length));
      if (candSegs.length < baseSegs.length) {
        continue;
      }
      const prefixMatches = baseSegs.every((seg, idx) => {
        const candSeg = candSegs[idx]!;
        return CASE_INSENSITIVE_PLATFORM
          ? seg.toLowerCase() === candSeg.toLowerCase()
          : seg === candSeg;
      });
      if (prefixMatches) {
        relSegments = candSegs.slice(baseSegs.length);
        break;
      }
    }
  }
  if (relSegments === null) return null;

  // Reject any raw `..` segment or unsafe Win32 trailing dot/space segment in the input itself.
  const inputParts = splitRelativeRawSegments(candidate);
  if (inputParts.some((seg) => seg === '..' || isUnsafeWin32TrailingDotOrSpaceSegment(seg))) {
    return null;
  }

  let verifiedExistingCount = 0;
  let existingCursor = anchorCanonical;
  const finalizeCursor = (existing: string, tail: readonly string[]): string | null => {
    if (!IS_WIN32 || verifiedExistingCount === 0) {
      return tail.length > 0 ? path.join(existing, ...tail) : existing;
    }
    let nativeReal: string;
    try {
      nativeReal = fs.realpathSync.native(existing);
    } catch {
      return null;
    }
    const realNs = normalizeWin32Namespace(nativeReal, true);
    if (!realNs.ok || !isEqualOrInside(realNs.normalized, anchorCanonical)) {
      return null;
    }
    return tail.length > 0 ? path.win32.join(realNs.normalized, ...tail) : realNs.normalized;
  };

  let cursor = anchorCanonical;
  for (let i = 0; i < relSegments.length; i += 1) {
    const segment = relSegments[i]!;
    if (
      segment === '.' ||
      segment === '..' ||
      (IS_WIN32 && (segment.includes(':') || isUnsafeWin32TrailingDotOrSpaceSegment(segment)))
    ) {
      return null;
    }
    cursor = path.join(cursor, segment);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        return null;
      }
      existingCursor = cursor;
      verifiedExistingCount += 1;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        const tail = relSegments.slice(i);
        if (
          tail.some(
            (s) =>
              s === '.' ||
              s === '..' ||
              (IS_WIN32 && (s.includes(':') || isUnsafeWin32TrailingDotOrSpaceSegment(s)))
          )
        ) {
          return null;
        }
        return finalizeCursor(existingCursor, tail);
      }
      return null;
    }
  }
  return finalizeCursor(existingCursor, []);
}

function isEqualOrInside(candidate: string, base: string): boolean {
  const normCandidate = normalizeProtectedComparePath(candidate);
  const normBase = normalizeProtectedComparePath(base);
  if (normCandidate === normBase) {
    return true;
  }
  const rel = path.relative(normBase, normCandidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function pathsOverlap(a: string, b: string): boolean {
  return isEqualOrInside(a, b) || isEqualOrInside(b, a);
}

function matchAgainstProtectedPathsSync(
  targetPath: string,
  protectedPaths: readonly string[],
  includeAncestorOverlap: boolean
): boolean {
  const nonEmptyProtected = protectedPaths.filter((p) => p.length > 0);
  if (nonEmptyProtected.length === 0) {
    return false;
  }
  if (
    isWin32DrivelessRootRelative(targetPath) ||
    hasWin32AdsColonInSegments(targetPath) ||
    hasUnsafeWin32TrailingSegment(targetPath)
  ) {
    return true;
  }
  const targetNs = normalizeWin32Namespace(targetPath);
  if (!targetNs.ok) {
    return true;
  }

  const matches = includeAncestorOverlap ? pathsOverlap : isEqualOrInside;

  for (const protectedPath of nonEmptyProtected) {
    if (matches(targetPath, protectedPath)) {
      return true;
    }
  }

  const targetCanon = canonicalizePathWithTailSync(targetPath);
  if (!targetCanon.ok) {
    return true;
  }

  // Also canonicalize the lexically collapsed path (Win32 `RtlGetFullPathName_U`
  // `..`-before-symlink order) whenever on Win32 or when `..` is present so a
  // `<junction>/../<protected-junction>` chain cannot evade protected matching.
  let lexicalCanonPath: string | null = null;
  if (IS_WIN32 || splitRelativeRawSegments(targetNs.normalized).includes('..')) {
    const lexicalTarget = path.resolve(targetNs.normalized);
    if (lexicalTarget !== targetCanon.canonical) {
      const lexicalCanon = canonicalizePathWithTailSync(lexicalTarget);
      if (!lexicalCanon.ok) {
        return true;
      }
      lexicalCanonPath = lexicalCanon.canonical;
    }
  }

  for (const protectedPath of nonEmptyProtected) {
    if (matches(targetCanon.canonical, protectedPath)) {
      return true;
    }
    if (lexicalCanonPath !== null && matches(lexicalCanonPath, protectedPath)) {
      return true;
    }
    const protectedCanon = canonicalizePathWithTailSync(protectedPath);
    if (!protectedCanon.ok) {
      return true;
    }
    if (matches(targetCanon.canonical, protectedCanon.canonical)) {
      return true;
    }
    if (lexicalCanonPath !== null && matches(lexicalCanonPath, protectedCanon.canonical)) {
      return true;
    }
    if (matches(targetPath, protectedCanon.canonical)) {
      return true;
    }
  }

  return false;
}

/**
 * Returns `true` if `targetPath` equals or lies inside any protected path
 * (after lexical + symlink-resolved + platform-case-folded comparison), or if
 * canonicalization fails closed while protected paths are non-empty.
 */
export function isTargetProtectedPathSync(
  targetPath: string,
  protectedPaths: readonly string[]
): boolean {
  return matchAgainstProtectedPathsSync(targetPath, protectedPaths, false);
}

/**
 * Returns `true` if `targetPath` equals, lies inside, OR is an ancestor
 * directory of any protected path (after lexical + symlink-resolved +
 * platform-case-folded comparison), or if canonicalization fails closed while
 * protected paths are non-empty.
 */
export function doesSubtreeOverlapProtectedPathsSync(
  targetPath: string,
  protectedPaths: readonly string[]
): boolean {
  return matchAgainstProtectedPathsSync(targetPath, protectedPaths, true);
}
