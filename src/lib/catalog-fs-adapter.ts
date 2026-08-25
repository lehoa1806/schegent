// Feature 099 (FR-R3-015) T479a — the catalog store's filesystem, and the only
// module in the feature that knows where the store actually is.
//
// The store's core is segment-addressed and holds no absolute path (see
// `src/catalog/ports.ts`). This is where segments become a path, which makes it the
// single place a workspace root exists in this feature, the single place a
// `rename` or an `unlink` happens, and therefore the single place the containment
// oracle has to be consulted (FR-061, and the containment lint of FR-R3-005).
//
// Three properties the port's shape requires of this file:
//
//   - **Every failure is a returned value.** No caller in `src/catalog/` has a
//     `try`/`catch`, so an exception escaping this module would be an unhandled
//     rejection rather than a refusal. Everything is caught here and mapped.
//   - **No `errno` is a path.** Errors are reduced to their `code`, so nothing a
//     refusal carries can leak a workspace root into a log line (SC-012).
//   - **Directories are created lazily.** A workspace that never saves must end up
//     with no `.schegent/catalog/` directory at all (FR-001a, SC-018), so nothing on
//     the read path or in construction calls `mkdir`.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  CatalogFsPort,
  FsReadOutcome,
  FsRemoveOutcome,
  FsWriteIfAbsentOutcome,
  FsWriteOutcome,
  StoreSegments,
  StoreWritability
} from '../catalog/ports';
import { tempNameFor } from '../catalog/atomic-write';
import { resolveContainedLink, resolveContainedTarget } from './path-containment';
import {
  ensureAnchorWithinRoot,
  openWithinRootByPath,
  segmentsUnderRoot,
  type SafeOpenResult
} from './safe-open';

/** The store's directory, under the workspace's `.schegent/`. */
export const CATALOG_DIRECTORY_SEGMENTS = ['.schegent', 'catalog'] as const;

/** Matching `ownership-fs.ts` and the checkpoint writer: nothing outside this account reads these. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const CONTAINMENT_ERRNO = 'ESCHEGENTCONTAINMENT';

function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  // The message is deliberately not consulted: Node puts the path in it.
  return typeof code === 'string' && code.length > 0 ? code : 'EUNKNOWN';
}

function isMissing(error: unknown): boolean {
  const code = errnoOf(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** A read's containment verdict, reduced to the three answers this adapter acts on. */
type ReadPermission =
  /** Proven inside the store. `at` is the resolved path to read. */
  | { readonly outcome: 'read'; readonly at: string }
  /** Not there. The empty catalog (FR-001a), not an escape. */
  | { readonly outcome: 'absent' }
  /** Outside the store, or containment could not be proven either way. */
  | { readonly outcome: 'refused' };

let tempCounter = 0;

/** A unique temp token. Impure by nature, which is why it lives on this side of the port. */
function nextTempToken(): string {
  tempCounter += 1;
  return `${process.pid}.${tempCounter}`;
}

/**
 * The production filesystem for the catalog store.
 *
 * `anchor` is `null` when no workspace folder is open. That is not an error
 * state to guard against at every call: reads report `absent`, which is already
 * the empty catalog (FR-001a), and writes never get here because `save` asks
 * `checkWritability` first and refuses `no-workspace` by name (FR-033a).
 *
 * FR-R3-069 (feature 152) — two required roles where one path used to play
 * both: `workspaceRoot` is the TRUSTED anchor every containment judgment
 * resolves against, and `storeRoot` is the UNTRUSTED store directory paths are
 * composed from. Anchoring the judge at the store itself was the F-01 defect —
 * the judge realpaths the root it is handed, so a checkout arriving with
 * `.schegent` or `.schegent/catalog` as a symlink made its own target the
 * boundary and everything beneath it judged `contained`. Judged from the
 * workspace root, an escaping store link refuses; one that stays inside the
 * workspace is still admitted.
 */
export function createCatalogFsAdapter(
  anchor: { readonly workspaceRoot: string; readonly storeRoot: string } | null
): CatalogFsPort {
  const workspaceRoot = anchor === null ? null : anchor.workspaceRoot;
  const storeRoot = anchor === null ? null : anchor.storeRoot;
  const roots = workspaceRoot === null ? [] : [workspaceRoot];

  const pathFor = (at: StoreSegments): string | null =>
    storeRoot === null ? null : path.join(storeRoot, ...at);

  /** A safe-open refusal reduced to this adapter's errno vocabulary. */
  const refusalErrno = (result: Extract<SafeOpenResult, { outcome: 'refused' }>): string =>
    result.reason === 'io-failed' ? result.errno : CONTAINMENT_ERRNO;

  /**
   * The trusted root in the form a RESOLVED path derives from. The judge
   * realpaths the roots it compares against, so a resolved path may sit under
   * the workspace root's real form rather than its lexical one (`/tmp` vs
   * `/private/tmp` on macOS). Lexical first, real form as the fallback — the
   * same two forms `judge` already treats as one root.
   */
  const walkRootFor = async (
    resolvedPath: string
  ): Promise<{ root: string; segments: readonly string[] } | null> => {
    if (workspaceRoot === null) return null;
    const direct = segmentsUnderRoot(workspaceRoot, resolvedPath);
    if (direct !== null) return { root: workspaceRoot, segments: direct };
    try {
      const real = await fs.realpath(workspaceRoot);
      const viaReal = segmentsUnderRoot(real, resolvedPath);
      return viaReal === null ? null : { root: real, segments: viaReal };
    } catch {
      return null;
    }
  };

  /**
   * Open an already-proven path through the safe walk from the workspace root
   * — defence in depth beneath the judgment above it, on the same terms as
   * `ownership-fs.ts`.
   */
  const openContained = async (
    provenPath: string,
    flags: 'r' | 'w' | 'wx'
  ): Promise<SafeOpenResult> => {
    const walk = await walkRootFor(provenPath);
    if (walk === null) {
      return { outcome: 'refused', reason: 'escapes-root', errno: CONTAINMENT_ERRNO };
    }
    return openWithinRootByPath(walk.root, provenPath, { flags, fileMode: FILE_MODE });
  };

  /**
   * FR-R3-069 — the two-level judgment. Level one resolves the STORE ROOT
   * itself against the trusted workspace root, target form, so a
   * `.schegent`/`catalog` symlink is followed and judged: escaping the
   * workspace refuses everything, staying inside it is admitted and yields the
   * real directory. Level two (the per-op proofs below) then judges each entry
   * against that RESOLVED store root, which preserves the shipped store-scoping
   * — an intra-store link that points elsewhere in the workspace still refuses,
   * exactly as before this feature. Resolved per call, never cached: a store
   * root swapped for a link between operations is re-judged, which is the
   * anchor property F-01 was about.
   *
   * `null` means level one refused (or no workspace is open); an absent store
   * root falls back to the link form so the first write into a fresh workspace
   * is judged against where its chain will actually land.
   */
  const storeRoots = async (): Promise<readonly string[] | null> => {
    if (workspaceRoot === null || storeRoot === null) return null;
    const target = await resolveContainedTarget(storeRoot, roots);
    if (target.outcome === 'contained') return [target.resolved];
    if (target.outcome !== 'absent') return null;
    const link = await resolveContainedLink(storeRoot, roots);
    return link.outcome === 'contained' ? [link.resolved] : null;
  };

  /**
   * Prove containment for a path this adapter is about to write, rename, or
   * unlink, and return the resolved path to act on.
   *
   * The **link** form, not the target form: these are `rename` and `unlink` on the
   * directory entry itself, and following the leaf would refuse the legitimate
   * removal of a record whose path happens to be a symlink. Refuses rather than
   * falling back to a lexical comparison — a lexically joined path is not a
   * contained path, because `..` is a hop count and a symlink is a hop no join can
   * see.
   */
  const proveContainedEntry = async (target: string): Promise<string | null> => {
    const scoped = await storeRoots();
    if (scoped === null) return null;
    const verdict = await resolveContainedLink(target, scoped);
    return verdict.outcome === 'contained' ? verdict.resolved : null;
  };

  /**
   * Prove containment for a path this adapter is about to *read*, and return the
   * resolved path to read.
   *
   * The **target** form, because a read follows the leaf: a record replaced with a
   * link to a file outside the workspace would otherwise be read through, and its
   * contents would arrive in the Builder as a definition. The core cannot build a
   * segment that escapes — but the core is not what plants the link. A cloned
   * repository carries its own `.schegent/catalog/`, links and all.
   *
   * `absent` is passed through rather than refused: a path that is not there is the
   * empty catalog (FR-001a), not an escape.
   */
  const proveContainedRead = async (target: string): Promise<ReadPermission> => {
    const scoped = await storeRoots();
    if (scoped === null) return { outcome: 'refused' };
    const verdict = await resolveContainedTarget(target, scoped);
    if (verdict.outcome === 'contained') return { outcome: 'read', at: verdict.resolved };
    if (verdict.outcome === 'absent') return { outcome: 'absent' };
    return { outcome: 'refused' };
  };

  /**
   * Create the directory a write is about to land in, and prove containment
   * **first** — `mkdir` is a syscall with an effect, so it is subject to the same
   * rule as the write it precedes.
   *
   * The oracle is consulted here rather than only at the write because `mkdir`
   * with `recursive` follows symlinks and creates what is missing behind them.
   * A `.schegent/catalog/phases` planted as a link by a cloned repository would
   * otherwise have the first save of a new definition create `<link target>/<id>`
   * at a path the attacker chose, and *then* have the write refused — a refusal
   * the operator is told about, and a directory they would never think to look
   * for. Containment refuses the whole operation instead of the last step of it.
   *
   * The link form, as at `proveContainedEntry`: `mkdir` creates a directory
   * entry and never follows the one it creates. What has to be contained is the
   * ancestry it would create that entry inside, and `resolveContainedLink`
   * resolves that chain in full.
   *
   * FR-R3-069 — the store anchor is still created first, because an entry
   * cannot be judged against a root that does not exist yet (the truth inside
   * the old "cannot be proven against itself" note). What changed is HOW: the
   * anchor is judged against the workspace root (inside `storeRoots`) and
   * created by the checked walk, never by a raw `mkdir -p` that follows
   * whatever `.schegent` points at.
   */
  const ensureParent = async (target: string): Promise<boolean> => {
    if (workspaceRoot === null) return false;
    const scoped = await storeRoots();
    if (scoped === null) return false;
    const anchorWalk = await walkRootFor(scoped[0]);
    if (anchorWalk === null) return false;
    const anchorMade = await ensureAnchorWithinRoot(anchorWalk.root, anchorWalk.segments, DIR_MODE);
    if (anchorMade.outcome === 'refused') return false;
    const verdict = await resolveContainedLink(path.dirname(target), scoped);
    if (verdict.outcome !== 'contained') return false;
    const walk = await walkRootFor(verdict.resolved);
    if (walk === null) return false;
    const made = await ensureAnchorWithinRoot(walk.root, walk.segments, DIR_MODE);
    return made.outcome === 'ready';
  };

  return {
    async readFile(at: StoreSegments): Promise<FsReadOutcome> {
      const target = pathFor(at);
      if (target === null) return { outcome: 'absent' };
      const proven = await proveContainedRead(target);
      if (proven.outcome === 'absent') return { outcome: 'absent' };
      if (proven.outcome === 'refused') return { outcome: 'failed', errno: CONTAINMENT_ERRNO };
      const opened = await openContained(proven.at, 'r');
      if (opened.outcome === 'refused') {
        if (opened.errno === 'ENOENT' || opened.errno === 'ENOTDIR') return { outcome: 'absent' };
        return { outcome: 'failed', errno: refusalErrno(opened) };
      }
      try {
        return {
          outcome: 'read',
          contents: await opened.handle.readFile({ encoding: 'utf8' })
        };
      } catch (error) {
        if (isMissing(error)) return { outcome: 'absent' };
        return { outcome: 'failed', errno: errnoOf(error) };
      } finally {
        await opened.handle.close().catch(() => undefined);
      }
    },

    async writeFileAtomic(at: StoreSegments, contents: string): Promise<FsWriteOutcome> {
      const target = pathFor(at);
      if (target === null) return { outcome: 'failed', errno: 'ENOWORKSPACE' };
      // The name comes from the pure module that also recognises it, so the
      // integrity scan's `isTempName` is the inverse of what is written here rather
      // than a second guess at the same shape.
      const temp = path.join(
        path.dirname(target),
        tempNameFor(path.basename(target), nextTempToken())
      );
      try {
        if (!(await ensureParent(target))) {
          return { outcome: 'failed', errno: CONTAINMENT_ERRNO };
        }
        // Both ends proven before the write, so a refusal leaves no temp file
        // behind and reads as a refusal rather than as ordinary I/O trouble.
        const provenTemp = await proveContainedEntry(temp);
        const provenTarget = await proveContainedEntry(target);
        if (provenTemp === null || provenTarget === null) {
          return { outcome: 'failed', errno: CONTAINMENT_ERRNO };
        }
        const opened = await openContained(provenTemp, 'w');
        if (opened.outcome === 'refused') {
          return { outcome: 'failed', errno: refusalErrno(opened) };
        }
        try {
          await opened.handle.writeFile(contents, { encoding: 'utf8' });
        } finally {
          await opened.handle.close().catch(() => undefined);
        }
        try {
          await fs.rename(provenTemp, provenTarget);
        } catch (error) {
          // The temp file is this adapter's own, never store content: removing it
          // is not a compensating delete of a landed write (FR-029).
          await fs.rm(provenTemp, { force: true }).catch(() => undefined);
          return { outcome: 'failed', errno: errnoOf(error) };
        }
        return { outcome: 'written' };
      } catch (error) {
        return { outcome: 'failed', errno: errnoOf(error) };
      }
    },

    async writeFileIfAbsent(
      at: StoreSegments,
      contents: string
    ): Promise<FsWriteIfAbsentOutcome> {
      const target = pathFor(at);
      if (target === null) return { outcome: 'failed', errno: 'ENOWORKSPACE' };
      try {
        if (!(await ensureParent(target))) {
          return { outcome: 'failed', errno: CONTAINMENT_ERRNO };
        }
        const proven = await proveContainedEntry(target);
        if (proven === null) return { outcome: 'failed', errno: CONTAINMENT_ERRNO };
        // `wx` is the write-once primitive itself (FR-030): the kernel decides who
        // wins, so two windows racing on one version id produce exactly one write
        // and one `EEXIST`. A stat-then-write here would be the race, not the guard.
        const opened = await openContained(proven, 'wx');
        if (opened.outcome === 'refused') {
          if (opened.errno === 'EEXIST') return { outcome: 'exists' };
          return { outcome: 'failed', errno: refusalErrno(opened) };
        }
        try {
          await opened.handle.writeFile(contents, { encoding: 'utf8' });
        } finally {
          await opened.handle.close().catch(() => undefined);
        }
        return { outcome: 'written' };
      } catch (error) {
        if (errnoOf(error) === 'EEXIST') return { outcome: 'exists' };
        return { outcome: 'failed', errno: errnoOf(error) };
      }
    },

    async listDirectory(at: StoreSegments): Promise<readonly string[]> {
      const target = pathFor(at);
      if (target === null) return [];
      const proven = await proveContainedRead(target);
      // A directory that is absent, unreadable, or *not contained* all list as
      // empty: the port has no failure arm here because every caller's answer would
      // be the same, and a listing failure surfaces on the next read of a named
      // record. Empty is also the safe answer for the refused case — the only
      // consumer is the integrity scan, and a name it never sees is a record it
      // never reports as collectable.
      if (proven.outcome !== 'read') return [];
      try {
        return await fs.readdir(proven.at);
      } catch {
        return [];
      }
    },

    async removeFile(at: StoreSegments): Promise<FsRemoveOutcome> {
      const target = pathFor(at);
      if (target === null) return { outcome: 'absent' };
      // Retention's prune is the only caller (FR-034). Containment is proven on the
      // entry, immediately before the unlink.
      const proven = await proveContainedEntry(target);
      if (proven === null) return { outcome: 'failed', errno: CONTAINMENT_ERRNO };
      try {
        await fs.unlink(proven);
        return { outcome: 'removed' };
      } catch (error) {
        if (isMissing(error)) return { outcome: 'absent' };
        return { outcome: 'failed', errno: errnoOf(error) };
      }
    },

    async checkWritability(): Promise<StoreWritability> {
      if (workspaceRoot === null || storeRoot === null) return 'no-workspace';
      try {
        // The save path is the only caller, and it is about to write — so creating
        // the store directory here does not violate the never-saved case (FR-001a).
        // FR-R3-069 — judged against the workspace root first (admitting a store
        // link that stays inside the workspace, refusing one that escapes), then
        // created beneath the trusted anchor — never by a raw mkdir that follows
        // a planted `.schegent` link. A refused chain reads as not-writable,
        // which the refused save reports.
        const scoped = await storeRoots();
        if (scoped === null) return 'not-writable';
        const walk = await walkRootFor(scoped[0]);
        if (walk === null) return 'not-writable';
        const made = await ensureAnchorWithinRoot(walk.root, walk.segments, DIR_MODE);
        if (made.outcome === 'refused') return 'not-writable';
        // The anchor walk succeeding is most of the answer; `access` covers the
        // directory that exists and is not writable, which is the case an operator
        // hits after cloning a repository with a read-only `.schegent/` (FR-033b).
        await fs.access(made.anchor, fs.constants.W_OK);
        return 'writable';
      } catch {
        return 'not-writable';
      }
    }
  };
}
