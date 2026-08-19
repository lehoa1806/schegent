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

import { resolveContainedLink } from '../lib/path-containment';

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
 * Feature FR-R3-005 — `containmentRoot` is required, not optional, and is
 * normally the same ownership directory handed to `useOwnershipStorage`. The
 * registry writes nowhere else, so that is the tightest honest root, and a
 * required parameter makes `npm run typecheck` the list of call sites that
 * have to name one. A default would be a guess about where a caller intends
 * to write, and the guess reads as a proven root everywhere downstream.
 */
export function createDiskOwnershipFs(containmentRoot: string): OwnershipFs {
  const roots = [containmentRoot];
  /**
   * Refuse rather than mutate. These are `rename` and `rm` on the entry, so
   * the link form is the right one: the registry's own temp files and records
   * are what it removes, and following a leaf would refuse a cleanup of a link
   * it created.
   */
  const proveContainedEntry = async (file: string): Promise<string> => {
    const verdict = await resolveContainedLink(file, roots);
    if (verdict.outcome !== 'contained') {
      throw Object.assign(
        new Error(`ownership storage refused: containment ${
          verdict.outcome === 'refused' ? verdict.reason : verdict.outcome
        }`),
        { code: 'ESCHEGENTCONTAINMENT' }
      );
    }
    return verdict.resolved;
  };
  return {
    async ensureDir(dir) {
      await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
    },
    async list(dir) {
      try {
        return await fs.readdir(dir);
      } catch (err) {
        if (isMissing(err)) return [];
        throw err;
      }
    },
    async read(file) {
      try {
        return await fs.readFile(file, 'utf8');
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
    },
    async createExclusive(file, data) {
      await fs.writeFile(file, data, { encoding: 'utf8', flag: 'wx', mode: FILE_MODE });
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
      await fs.writeFile(provenTemp, data, { encoding: 'utf8', mode: FILE_MODE });
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
