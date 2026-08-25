// Feature FR-R3-003 (T295) — the storage seam the fenced ownership registry
// writes through.
//
// Deliberately six operations and no more. The registry's correctness argument
// rests on exactly one of them being atomic — `createExclusive`, which either
// creates a file or reports that someone else already did — so the port exists
// to make that requirement explicit and to make it substitutable in a test
// without a real filesystem. Everything else here is ordinary reading and
// replacing.
//
// `replace` is separate from `createExclusive` on purpose: a heartbeat rewrites
// a record a caller already owns and must never be observable half-written, so
// the disk adapter writes a temporary file and renames it over the target. A
// reader therefore sees the previous contents or the next ones, never a torn
// mix. `createExclusive` cannot use that trick, because a rename would clobber
// the very file whose absence it is asserting.

import * as fs from 'fs/promises';
import * as path from 'path';

import { resolveContainedLink, resolveContainedTarget } from '../lib/path-containment';
import type { FileHandle } from 'fs/promises';
import {
  ensureAnchorWithinRoot,
  openWithinRootByPath,
  segmentsUnderRoot,
  type SafeOpenRefusal
} from '../lib/safe-open';

export interface OwnershipFs {
  /** Create `dir` and any missing parents. Idempotent. */
  ensureDir(dir: string): Promise<void>;
  /** File names directly inside `dir`. An absent directory lists as empty. */
  list(dir: string): Promise<readonly string[]>;
  /** `file`'s contents, or `null` when it is absent. */
  read(file: string): Promise<string | null>;
  /**
   * Create `file` holding `data`, failing with an `EEXIST`-coded error when it
   * is already there.
   *
   * This is the registry's single atomic primitive. Two callers racing on the
   * same name must produce exactly one success and one `EEXIST`; an
   * implementation that reads-then-writes instead of creating exclusively
   * silently removes the guarantee the whole mechanism is built on.
   */
  createExclusive(file: string, data: string): Promise<void>;
  /** Replace `file`'s contents without ever exposing a partial read. */
  replace(file: string, data: string): Promise<void>;
  /** Remove `file`. An absent file is success. */
  remove(file: string): Promise<void>;
}

/** Whether `err` is the "somebody else created it first" outcome. */
export function isAlreadyExists(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'EEXIST';
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** The `EEXIST` failure, in the shape `isAlreadyExists` recognizes. */
export function alreadyExistsError(file: string): NodeJS.ErrnoException {
  const err = new Error(`EEXIST: file already exists, ${file}`) as NodeJS.ErrnoException;
  err.code = 'EEXIST';
  return err;
}

/**
 * Directory mode `0700` and file mode `0600`, matching the checkpoint and
 * transcript writers: an ownership record names window owner ids, and nothing
 * outside this account needs to read them.
 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

let tempCounter = 0;

/**
 * The production adapter. `.schegent/` is covered by the self-`.gitignore`
 * (`ensureSchegentGitignore` writes `*`), so nothing written under it is a
 * candidate for accidental commit.
 *
 * Feature FR-R3-005 made the containment root required so `npm run typecheck`
 * is the list of call sites that name one. FR-R3-069 (feature 152) splits the
 * one path it took into the two roles it was silently playing: `workspaceRoot`
 * is the TRUSTED anchor every judgment resolves against, and `ownershipDir` is
 * the UNTRUSTED store directory paths are composed from. Anchoring judgments at
 * the store itself was the F-02 defect — the containment judge realpaths the
 * root it is handed, so a checkout arriving with `.schegent/ownership` as a
 * symlink made its own target the boundary and every escape judged `contained`.
 * Judged from the workspace root, a symlinked store component refuses by name
 * (`symlink-component`), while a link that stays inside the workspace is still
 * admitted. Both parameters are required for the FR-R3-005 reason.
 */
export function createDiskOwnershipFs(anchor: {
  readonly workspaceRoot: string;
  readonly ownershipDir: string;
}): OwnershipFs {
  const { workspaceRoot } = anchor;
  const roots = [workspaceRoot];
  const containmentError = (reason: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`ownership storage refused: containment ${reason}`), {
      code: 'ESCHEGENTCONTAINMENT'
    });
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
    const direct = segmentsUnderRoot(workspaceRoot, resolvedPath);
    if (direct !== null) return { root: workspaceRoot, segments: direct };
    const real = await fs.realpath(workspaceRoot);
    const viaReal = segmentsUnderRoot(real, resolvedPath);
    return viaReal === null ? null : { root: real, segments: viaReal };
  };
  /** The two dir-shaped operations act only on the adapter's own store dir. */
  const requireStoreDir = (dir: string): void => {
    if (path.resolve(dir) !== path.resolve(anchor.ownershipDir)) {
      throw containmentError('not-contained');
    }
  };
  /** A safe-open refusal, translated to this port's error vocabulary. */
  const refusalError = (file: string, reason: SafeOpenRefusal, errno: string): NodeJS.ErrnoException => {
    if (reason === 'io-failed') {
      return Object.assign(new Error(`ownership storage I/O failed: ${errno}`), { code: errno });
    }
    if (errno === 'EEXIST') return alreadyExistsError(file);
    return containmentError(reason);
  };
  /**
   * FR-R3-069 — the two-level judgment, same scheme as `catalog-fs-adapter.ts`.
   * Level one resolves the STORE DIRECTORY itself against the trusted
   * workspace root, target form, so a symlinked `.schegent/ownership` (or a
   * symlinked `.schegent` above it) is followed and judged: escaping refuses
   * every operation, staying inside the workspace is admitted and yields the
   * real directory. Level two judges each entry against that RESOLVED store
   * directory, keeping the registry scoped to its own tree. Resolved per call,
   * never cached. An absent store directory falls back to the link form so the
   * very first election in a fresh workspace is judged against where its chain
   * will land — the FR-R3-053 §4c.1 ENOENT revert, closed.
   */
  const storeRoots = async (): Promise<readonly string[]> => {
    const target = await resolveContainedTarget(anchor.ownershipDir, roots);
    if (target.outcome === 'contained') return [target.resolved];
    if (target.outcome !== 'absent') {
      throw containmentError(target.reason);
    }
    const link = await resolveContainedLink(anchor.ownershipDir, roots);
    if (link.outcome !== 'contained') {
      throw containmentError(link.outcome === 'refused' ? link.reason : link.outcome);
    }
    return [link.resolved];
  };
  /**
   * Refuse rather than mutate. These are `rename` and `rm` on the entry, so
   * the link form is the right one: the registry's own temp files and records
   * are what it removes, and following a leaf would refuse a cleanup of a link
   * it created. Judged against the store directory as RESOLVED from the
   * workspace root, never against a root the checkout chose.
   */
  const proveContainedEntry = async (file: string): Promise<string> => {
    const verdict = await resolveContainedLink(file, await storeRoots());
    if (verdict.outcome !== 'contained') {
      throw containmentError(verdict.outcome === 'refused' ? verdict.reason : verdict.outcome);
    }
    return verdict.resolved;
  };
  /**
   * Prove `file` against the workspace root, then open the RESOLVED path
   * through the safe walk. Prove-first is what admits a store directory that is
   * an in-workspace symlink (the judge resolves it and finds it contained)
   * while refusing one that escapes; the walk over the resolved path is then
   * defence in depth — its `lstat` per component and `O_NOFOLLOW` leaf hold
   * even if a component is swapped for a link after the judgment.
   */
  const openProven = async (file: string, flags: 'r' | 'wx' | 'w'): Promise<FileHandle> => {
    const proven = await proveContainedEntry(file);
    const walk = await walkRootFor(proven);
    if (walk === null) throw containmentError('escapes-root');
    const result = await openWithinRootByPath(walk.root, proven, {
      flags,
      fileMode: FILE_MODE
    });
    if (result.outcome === 'refused') throw refusalError(file, result.reason, result.errno);
    return result.handle;
  };
  return {
    async ensureDir(dir) {
      // The one operation whose target IS the store anchor: level one judges
      // it against the workspace root, then the chain is created beneath the
      // trusted anchor by the primitive FR-R3-053 §4c.1 named missing — never
      // by a raw `mkdir -p` that follows whatever `.schegent` points at. The
      // registry only ever ensures its own directory; an argument naming any
      // other path is a wiring defect and refuses rather than being adopted.
      requireStoreDir(dir);
      const [resolved] = await storeRoots();
      const walk = await walkRootFor(resolved);
      if (walk === null) throw containmentError('escapes-root');
      const made = await ensureAnchorWithinRoot(walk.root, walk.segments, DIR_MODE);
      if (made.outcome === 'refused') throw refusalError(dir, made.reason, made.errno);
    },
    async list(dir) {
      // Same reasoning as ensureDir: the registry lists only its own
      // directory, and the resolved store dir is the judged form of it.
      requireStoreDir(dir);
      const [resolved] = await storeRoots();
      try {
        return await fs.readdir(resolved);
      } catch (err) {
        if (isMissing(err)) return [];
        throw err;
      }
    },
    async read(file) {
      let handle: FileHandle;
      try {
        handle = await openProven(file, 'r');
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
      try {
        return await handle.readFile({ encoding: 'utf8' });
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
    async createExclusive(file, data) {
      // 'wx' through the safe walk keeps the one atomic primitive atomic: the
      // exclusive create happens at the leaf open, and an EEXIST refusal is
      // rethrown in the shape `isAlreadyExists` recognizes.
      const handle = await openProven(file, 'wx');
      try {
        await handle.writeFile(data, { encoding: 'utf8' });
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
    async replace(file, data) {
      tempCounter += 1;
      const temp = path.join(
        path.dirname(file),
        `.${path.basename(file)}.${process.pid}.${tempCounter}.tmp`
      );
      // Both ends before the write, so a refusal leaves no temp file behind to
      // clean up — and so the refusal is reported instead of a rename failure
      // that reads like ordinary I/O trouble.
      const provenTemp = await proveContainedEntry(temp);
      const provenFile = await proveContainedEntry(file);
      const handle = await openProven(provenTemp, 'w');
      try {
        await handle.writeFile(data, { encoding: 'utf8' });
      } finally {
        await handle.close().catch(() => undefined);
      }
      try {
        await fs.rename(provenTemp, provenFile);
      } catch (err) {
        await fs.rm(provenTemp, { force: true }).catch(() => undefined);
        throw err;
      }
    },
    async remove(file) {
      await fs.rm(await proveContainedEntry(file), { force: true });
    }
  };
}

/**
 * The default adapter, for callers that supply no storage.
 *
 * It keeps the record set in one `Memento` entry so two `WorkspaceStateStore`
 * instances built over the same `Memento` — the shape every multi-window test
 * uses — share one ownership universe and genuinely contend. It is **not** a
 * production mechanism, and the reason is the finding this feature closes: a
 * `Memento` is a per-extension-host cache with no documented cross-process
 * visibility, so two real windows would each elect themselves. Production wires
 * `createDiskOwnershipFs()`; `tests/lint/ownership-registry-wiring.test.ts`
 * fails the build if that stops being true.
 *
 * The presence check and the construction of the next map are synchronous and
 * precede the single `update`, so `createExclusive` stays a decision made
 * against one observation rather than across an await.
 */
export function createMementoOwnershipFs(
  memento: { get<T>(key: string): T | undefined; update(key: string, value: unknown): unknown },
  key = 'schegent.ownership.records'
): OwnershipFs {
  const read = (): Record<string, string> => {
    const raw = memento.get<Record<string, string>>(key);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw;
  };
  const write = async (next: Record<string, string>): Promise<void> => {
    await Promise.resolve(memento.update(key, next));
  };
  return {
    async ensureDir() {
      // Names are flat keys in one map; there is no directory to create.
    },
    async list(dir) {
      const prefix = `${dir}/`;
      return Object.keys(read())
        .filter((name) => name.startsWith(prefix))
        .map((name) => name.slice(prefix.length))
        .filter((name) => !name.includes('/'));
    },
    async read(file) {
      return read()[file] ?? null;
    },
    async createExclusive(file, data) {
      const map = read();
      if (Object.prototype.hasOwnProperty.call(map, file)) throw alreadyExistsError(file);
      await write({ ...map, [file]: data });
    },
    async replace(file, data) {
      await write({ ...read(), [file]: data });
    },
    async remove(file) {
      const next = { ...read() };
      delete next[file];
      await write(next);
    }
  };
}
