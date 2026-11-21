/**
 * FR-R7-11 (T002, FR-018) — Strict-contained, zero-mutation read-only SQLite
 * inspection helpers shared across `src/lib/`, `src/state/`, and `src/services/`.
 *
 * Security & preservation invariants:
 * - Zero acting-layer imports (`tests/lint/architecture-layers.ts`).
 * - Rejects any symlink in every directory segment beneath `rootDir` (including
 *   in-root symlinks), any symlink or non-regular `.db` leaf, and any symlink or
 *   non-regular `-wal` / `-shm` sidecar before opening SQLite.
 * - When `-wal` is absent, opens SQLite with `file://...?immutable=1` (`readOnly: true`)
 *   so SQLite creates zero `-wal`/`-shm` sidecars and mutates zero bytes.
 * - When `-wal` is present, stages `.db` and `-wal` into a private `0o700` temp
 *   directory using `ensureAnchorWithinRoot` + `openWithinRoot(..., { flags: 'wx', fileMode: 0o600 })`
 *   (Hard Rule 69), reads committed WAL frames from the staged copy without ever
 *   opening or mutating the source directory, and removes the temp directory via
 *   `resolveContainedTarget` + `fsp.rm`.
 */

import { randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { resolveContainedTarget } from './path-containment';
import {
  ensureAnchorWithinRoot,
  openWithinRoot,
  platformLacksNoFollow,
  walkDirectoriesWithinRoot,
  type SafeOpenRefusal
} from './safe-open';

const COPY_CHUNK_BYTES = 65_536;
const DEFAULT_BUSY_TIMEOUT_MS = 250;

export interface VerifiedSqliteCandidate {
  readonly verifiedDbPath: string;
  readonly walPresent: boolean;
  readonly shmPresent: boolean;
  readonly dbSizeBytes: number;
  readonly dbMtimeMs: number;
  readonly walSizeBytes: number;
  readonly walMtimeMs: number;
}

export type VerifySqliteCandidateResult =
  | { readonly outcome: 'ok'; readonly verified: VerifiedSqliteCandidate }
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'refused'; readonly reason: SafeOpenRefusal; readonly errno: string }
  | { readonly outcome: 'unreadable'; readonly reason: SafeOpenRefusal; readonly errno: string };

export type ZeroMutationInspectResult<T> =
  | { readonly outcome: 'ok'; readonly value: T; readonly verified: VerifiedSqliteCandidate }
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'refused'; readonly reason: SafeOpenRefusal; readonly errno: string }
  | { readonly outcome: 'unreadable'; readonly reason: SafeOpenRefusal; readonly errno: string }
  | { readonly outcome: 'sqlite-error'; readonly error: unknown; readonly verified: VerifiedSqliteCandidate };

export interface ZeroMutationReadOnlyOptions {
  /** Default `true`. Set `false` only for read-only `VACUUM INTO` staging of a selected winner. */
  readonly queryOnly?: boolean | undefined;
  readonly busyTimeoutMs?: number | undefined;
}

export type SyncZeroMutationOpenResult =
  | { readonly kind: 'opened'; readonly db: DatabaseSync; readonly verifiedDbPath: string }
  | { readonly kind: 'wal-present'; readonly verifiedDbPath: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'refused'; readonly reason: SafeOpenRefusal; readonly errno: string }
  | { readonly kind: 'unreadable'; readonly reason: SafeOpenRefusal; readonly errno: string };

function errnoOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
}

function isInvalidSingleSegment(segment: string): boolean {
  return (
    segment.length === 0 ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0') ||
    path.isAbsolute(segment)
  );
}

// Pure-Node symlink / reparse-point containment refusal helper; residual
// native-binding trade-offs (no openat/FSCTL_GET_REPARSE_POINT) are decided in
// `docs/architecture/native-binding-decision.md`.
function isContainmentRefusalReason(reason: SafeOpenRefusal): boolean {
  return (
    reason === 'symlink-component' ||
    reason === 'symlink-leaf' ||
    reason === 'reparse-point-leaf' ||
    reason === 'not-a-directory' ||
    reason === 'not-a-regular-file' ||
    reason === 'escapes-root'
  );
}

function classifySafeOpenRefusal(
  reason: SafeOpenRefusal,
  errno: string
):
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'refused'; readonly reason: SafeOpenRefusal; readonly errno: string }
  | { readonly outcome: 'unreadable'; readonly reason: SafeOpenRefusal; readonly errno: string } {
  if (reason === 'io-failed' && (errno === 'ENOENT' || errno === 'ENOTDIR')) {
    return { outcome: 'absent' };
  }
  if (isContainmentRefusalReason(reason)) {
    return { outcome: 'refused', reason, errno };
  }
  return { outcome: 'unreadable', reason, errno };
}

export function toImmutableSqliteUri(verifiedDbPath: string): string {
  return `${pathToFileURL(verifiedDbPath).href}?immutable=1`;
}

function applyReadOnlyPragmas(db: DatabaseSync, options?: ZeroMutationReadOnlyOptions): void {
  const busyTimeoutMs = options?.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.exec('PRAGMA trusted_schema = OFF');
  db.exec('PRAGMA temp_store = MEMORY');
  if (options?.queryOnly !== false) {
    db.exec('PRAGMA query_only = ON');
  }
}

async function copyHandleToPrivateAnchor(
  srcHandle: fsp.FileHandle,
  destAnchorDir: string,
  destFileName: string
): Promise<void> {
  const destOpened = await openWithinRoot(destAnchorDir, [destFileName], {
    flags: 'wx',
    fileMode: 0o600
  });
  if (destOpened.outcome !== 'opened') {
    throw new Error(`SQLITE_INSPECT_STAGE_WRITE_REFUSED:${destOpened.reason}:${destOpened.errno}`);
  }
  try {
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let readOffset = 0;
    for (;;) {
      const { bytesRead } = await srcHandle.read(buffer, 0, buffer.length, readOffset);
      if (bytesRead === 0) break;
      readOffset += bytesRead;
      let written = 0;
      while (written < bytesRead) {
        const res = await destOpened.handle.write(buffer, written, bytesRead - written);
        written += res.bytesWritten;
      }
    }
  } finally {
    await destOpened.handle.close().catch(() => undefined);
  }
}

async function removePrivateStageDir(stageDir: string, tmpBase: string): Promise<void> {
  const verdict = await resolveContainedTarget(stageDir, [tmpBase]);
  if (verdict.outcome !== 'contained') return;
  await fsp.rm(verdict.resolved, { recursive: true, force: true }).catch(() => undefined);
}

interface OpenedVerifiedHandles {
  readonly verified: VerifiedSqliteCandidate;
  readonly dbHandle: fsp.FileHandle;
  readonly walHandle: fsp.FileHandle | null;
}

async function openAndVerifyCandidateHandles(
  rootDir: string,
  relativeDirSegments: readonly string[],
  dbFileName: string
): Promise<
  | { readonly outcome: 'ok'; readonly opened: OpenedVerifiedHandles }
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'refused'; readonly reason: SafeOpenRefusal; readonly errno: string }
  | { readonly outcome: 'unreadable'; readonly reason: SafeOpenRefusal; readonly errno: string }
> {
  if (!path.isAbsolute(rootDir) || rootDir.includes('\0') || isInvalidSingleSegment(dbFileName)) {
    return { outcome: 'refused', reason: 'escapes-root', errno: 'EINVAL' };
  }
  for (const segment of relativeDirSegments) {
    if (isInvalidSingleSegment(segment)) {
      return { outcome: 'refused', reason: 'escapes-root', errno: 'EINVAL' };
    }
  }

  const walked = await walkDirectoriesWithinRoot(rootDir, relativeDirSegments);
  if (walked.outcome === 'refused') {
    return classifySafeOpenRefusal(walked.reason, walked.errno);
  }

  const dbSegments = [...relativeDirSegments, dbFileName];
  const dbOpened = await openWithinRoot(rootDir, dbSegments, { flags: 'r' });
  if (dbOpened.outcome === 'refused') {
    return classifySafeOpenRefusal(dbOpened.reason, dbOpened.errno);
  }

  let walHandle: fsp.FileHandle | null = null;
  try {
    const dbStat = await dbOpened.handle.stat();

    const walOpened = await openWithinRoot(rootDir, [...relativeDirSegments, `${dbFileName}-wal`], {
      flags: 'r'
    });
    let walPresent = false;
    let walSizeBytes = 0;
    let walMtimeMs = 0;
    if (walOpened.outcome === 'opened') {
      walHandle = walOpened.handle;
      const walStat = await walHandle.stat();
      walPresent = true;
      walSizeBytes = walStat.size;
      walMtimeMs = walStat.size > 0 ? walStat.mtimeMs : 0;
    } else {
      const classified = classifySafeOpenRefusal(walOpened.reason, walOpened.errno);
      if (classified.outcome !== 'absent') {
        await dbOpened.handle.close().catch(() => undefined);
        return classified;
      }
    }

    const shmOpened = await openWithinRoot(rootDir, [...relativeDirSegments, `${dbFileName}-shm`], {
      flags: 'r'
    });
    let shmPresent = false;
    if (shmOpened.outcome === 'opened') {
      shmPresent = true;
      await shmOpened.handle.close().catch(() => undefined);
    } else {
      const classified = classifySafeOpenRefusal(shmOpened.reason, shmOpened.errno);
      if (classified.outcome !== 'absent') {
        await walHandle?.close().catch(() => undefined);
        await dbOpened.handle.close().catch(() => undefined);
        return classified;
      }
    }

    return {
      outcome: 'ok',
      opened: {
        verified: {
          verifiedDbPath: path.join(walked.directory, dbFileName),
          walPresent,
          shmPresent,
          dbSizeBytes: dbStat.size,
          dbMtimeMs: dbStat.mtimeMs,
          walSizeBytes,
          walMtimeMs
        },
        dbHandle: dbOpened.handle,
        walHandle
      }
    };
  } catch (error) {
    await walHandle?.close().catch(() => undefined);
    await dbOpened.handle.close().catch(() => undefined);
    return { outcome: 'unreadable', reason: 'io-failed', errno: errnoOf(error) };
  }
}

/**
 * Verifies strict segment-by-segment symlink-free containment of `rootDir/...relativeDirSegments/dbFileName`
 * and its `-wal` / `-shm` sidecars without creating or modifying any files.
 */
export async function verifySqliteCandidateWithinRoot(
  rootDir: string,
  relativeDirSegments: readonly string[],
  dbFileName: string
): Promise<VerifySqliteCandidateResult> {
  const checked = await openAndVerifyCandidateHandles(rootDir, relativeDirSegments, dbFileName);
  if (checked.outcome !== 'ok') return checked;
  await checked.opened.walHandle?.close().catch(() => undefined);
  await checked.opened.dbHandle.close().catch(() => undefined);
  return { outcome: 'ok', verified: checked.opened.verified };
}

/**
 * Opens a strictly-contained SQLite database for zero-mutation read-only inspection:
 * - Rejects any symlink in `relativeDirSegments`, the `.db` leaf, or `-wal`/`-shm` sidecars.
 * - When `-wal` is absent, opens `file://...?immutable=1` (`readOnly: true`) so SQLite
 *   creates zero `-wal`/`-shm` files and modifies zero bytes.
 * - When `-wal` is present, copies `.db` and `-wal` from the verified file handles into a
 *   private `0o700` temp directory (`0o600` files), inspects the staged copy read-only so
 *   all committed WAL frames are visible without touching the source directory, and cleans
 *   up the temp directory via `resolveContainedTarget` + `fsp.rm`.
 */
export async function withZeroMutationReadOnlySqlite<T>(
  rootDir: string,
  relativeDirSegments: readonly string[],
  dbFileName: string,
  fn: (db: DatabaseSync, verified: VerifiedSqliteCandidate) => T | Promise<T>,
  options?: ZeroMutationReadOnlyOptions
): Promise<ZeroMutationInspectResult<T>> {
  const checked = await openAndVerifyCandidateHandles(rootDir, relativeDirSegments, dbFileName);
  if (checked.outcome !== 'ok') return checked;

  const { verified, dbHandle, walHandle } = checked.opened;

  if (!verified.walPresent) {
    await walHandle?.close().catch(() => undefined);
    await dbHandle.close().catch(() => undefined);

    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(toImmutableSqliteUri(verified.verifiedDbPath), {
        open: true,
        readOnly: true,
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false
      });
      applyReadOnlyPragmas(db, options);
    } catch (error) {
      try {
        db?.close();
      } catch {
        // Ignore close failure after open/pragma error.
      }
      return { outcome: 'sqlite-error', error, verified };
    }

    try {
      const value = await fn(db, verified);
      return { outcome: 'ok', value, verified };
    } finally {
      try {
        db.close();
      } catch {
        // Ignore close failure.
      }
    }
  }

  // `-wal` is present: stage `.db` and `-wal` into a private `0o700` temp directory.
  let tmpBase: string;
  let stageDir: string;
  try {
    tmpBase = await fsp.realpath(os.tmpdir());
    const stageName = `schegent-sqlite-ro-${process.pid}-${Date.now()}-${randomBytes(8).toString('hex')}`;
    const anchor = await ensureAnchorWithinRoot(tmpBase, [stageName], 0o700);
    if (anchor.outcome !== 'ready') {
      await walHandle?.close().catch(() => undefined);
      await dbHandle.close().catch(() => undefined);
      return { outcome: 'unreadable', reason: anchor.reason, errno: anchor.errno };
    }
    stageDir = anchor.anchor;
  } catch (error) {
    await walHandle?.close().catch(() => undefined);
    await dbHandle.close().catch(() => undefined);
    return { outcome: 'unreadable', reason: 'io-failed', errno: errnoOf(error) };
  }

  let db: DatabaseSync | null = null;
  try {
    try {
      await copyHandleToPrivateAnchor(dbHandle, stageDir, dbFileName);
      if (walHandle !== null) {
        await copyHandleToPrivateAnchor(walHandle, stageDir, `${dbFileName}-wal`);
      }
    } catch (error) {
      return { outcome: 'unreadable', reason: 'io-failed', errno: errnoOf(error) };
    } finally {
      await walHandle?.close().catch(() => undefined);
      await dbHandle.close().catch(() => undefined);
    }

    try {
      db = new DatabaseSync(path.join(stageDir, dbFileName), {
        open: true,
        readOnly: true,
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false
      });
      applyReadOnlyPragmas(db, options);
    } catch (error) {
      try {
        db?.close();
      } catch {
        // Ignore close failure.
      }
      db = null;
      return { outcome: 'sqlite-error', error, verified };
    }

    const value = await fn(db, verified);
    return { outcome: 'ok', value, verified };
  } finally {
    if (db !== null) {
      try {
        db.close();
      } catch {
        // Ignore close failure.
      }
    }
    await removePrivateStageDir(stageDir, tmpBase);
  }
}

/** Alias exported per T002 contract naming. */
export const inspectSqliteReadOnly = withZeroMutationReadOnlySqlite;

/**
 * Synchronous strict-contained check + zero-mutation `immutable=1` open for passive
 * sync inspection when `-wal` is absent. When `-wal` is present, returns
 * `{ kind: 'wal-present', verifiedDbPath }` so async callers can use `withZeroMutationReadOnlySqlite`.
 */
export function openZeroMutationReadOnlySqliteSync(
  rootDir: string,
  relativeDirSegments: readonly string[],
  dbFileName: string
): SyncZeroMutationOpenResult {
  if (!path.isAbsolute(rootDir) || rootDir.includes('\0') || isInvalidSingleSegment(dbFileName)) {
    return { kind: 'refused', reason: 'escapes-root', errno: 'EINVAL' };
  }
  for (const segment of relativeDirSegments) {
    if (isInvalidSingleSegment(segment)) {
      return { kind: 'refused', reason: 'escapes-root', errno: 'EINVAL' };
    }
  }

  let current = rootDir;
  for (const segment of relativeDirSegments) {
    current = path.join(current, segment);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(current);
    } catch (error) {
      const code = errnoOf(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
      return { kind: 'unreadable', reason: 'io-failed', errno: code };
    }
    if (st.isSymbolicLink()) return { kind: 'refused', reason: 'symlink-component', errno: 'ELOOP' };
    if (!st.isDirectory()) return { kind: 'refused', reason: 'not-a-directory', errno: 'ENOTDIR' };
  }

  const verifiedDbPath = path.join(current, dbFileName);
  const linkReason: SafeOpenRefusal = platformLacksNoFollow() ? 'reparse-point-leaf' : 'symlink-leaf';

  try {
    const dbStat = lstatSync(verifiedDbPath);
    if (dbStat.isSymbolicLink()) return { kind: 'refused', reason: linkReason, errno: 'ELOOP' };
    if (!dbStat.isFile()) return { kind: 'refused', reason: 'not-a-regular-file', errno: 'EINVAL' };
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    return { kind: 'unreadable', reason: 'io-failed', errno: code };
  }

  for (const suffix of ['-shm', '-wal'] as const) {
    const sidecarPath = `${verifiedDbPath}${suffix}`;
    try {
      const st = lstatSync(sidecarPath);
      if (st.isSymbolicLink()) return { kind: 'refused', reason: linkReason, errno: 'ELOOP' };
      if (!st.isFile()) return { kind: 'refused', reason: 'not-a-regular-file', errno: 'EINVAL' };
      if (suffix === '-wal') {
        return { kind: 'wal-present', verifiedDbPath };
      }
    } catch (error) {
      const code = errnoOf(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return { kind: 'unreadable', reason: 'io-failed', errno: code };
      }
    }
  }

  try {
    const db = new DatabaseSync(toImmutableSqliteUri(verifiedDbPath), {
      open: true,
      readOnly: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false
    });
    return { kind: 'opened', db, verifiedDbPath };
  } catch (error) {
    return { kind: 'unreadable', reason: 'io-failed', errno: errnoOf(error) };
  }
}

/**
 * Verifies a single database leaf path and its `-wal`/`-shm` sidecars are non-symlink
 * regular files (or absent for sidecars), returning sidecar presence for legacy
 * single-path sync callers. Throws on symlink, non-regular file, or missing DB.
 */
export function verifyRegularDbAndSidecarsSync(
  databasePath: string
): { readonly walPresent: boolean; readonly shmPresent: boolean } {
  const linkReason: SafeOpenRefusal = platformLacksNoFollow() ? 'reparse-point-leaf' : 'symlink-leaf';
  const dbStat = lstatSync(databasePath);
  if (dbStat.isSymbolicLink()) {
    throw new Error(`SQLITE_READONLY_REFUSED:${linkReason}`);
  }
  if (!dbStat.isFile()) {
    throw new Error('SQLITE_READONLY_REFUSED:not-a-regular-file');
  }

  let walPresent = false;
  let shmPresent = false;
  for (const suffix of ['-wal', '-shm'] as const) {
    try {
      const st = lstatSync(`${databasePath}${suffix}`);
      if (st.isSymbolicLink()) {
        throw new Error(`SQLITE_READONLY_REFUSED:${linkReason}`);
      }
      if (!st.isFile()) {
        throw new Error('SQLITE_READONLY_REFUSED:not-a-regular-file');
      }
      if (suffix === '-wal') walPresent = true;
      else shmPresent = true;
    } catch (error) {
      const code = errnoOf(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw error;
    }
  }

  return { walPresent, shmPresent };
}
