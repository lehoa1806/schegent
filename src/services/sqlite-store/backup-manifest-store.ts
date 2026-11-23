/**
 * FR-R7-03 (FR-002, FR-005, FR-010) — Companion backup manifest parsing, validation,
 * and read-only contained backup listing under `<storageRoot>/sqlite/<scopeId>/backups/`.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * Zero raw `node:fs` write primitives (docs/hard-rules.md rule 69).
 */

import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, readdirSync, readSync } from 'node:fs';
import * as path from 'node:path';
import {
  STORAGE_AUTHORITIES,
  type BackupDependencyManifest,
  type BackupExternalDependency,
  type BackupRestoreRejectionCode,
  type StorageAuthority
} from '../../contracts/sqlite-store/schema-types';
import { NON_OWNER_BITS } from '../../lib/narrow-mode';
import { openReadOnlyNoFollowSync, walkDirectoriesWithinRoot } from '../../lib/safe-open';

export const SAFE_BACKUP_FILENAME_PATTERN = /^[A-Za-z0-9._-]+\.(?:db|sqlite|sqlite3)$/;
export const SAFE_BACKUP_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
/**
 * Calibrated supported backup/restore database image ceiling (512 MiB).
 * Verified on macOS arm64 / local APFS (see `docs/operations/sqlite-large-restore-measurement.md`)
 * via SQLite-native `ATTACH` + `INSERT INTO ... SELECT` and async chunked SHA-256 so restore
 * stays well inside the 5 s `WorkspaceLockManager` heartbeat and 15 s staleness envelope.
 */
export const MAX_BACKUP_DATABASE_BYTES = 512 * 1024 * 1024;
export const MAX_RESTORE_IMAGE_BYTES = MAX_BACKUP_DATABASE_BYTES;
export const MAX_BACKUP_MANIFEST_BYTES = 16 * 1024 * 1024;
export const MANIFEST_SUFFIX = '.manifest.json';
export const SQLITE_SIDECAR_SUFFIXES = Object.freeze(['-wal', '-shm', '-journal'] as const);

export interface FileStatFingerprint {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

const STORAGE_AUTHORITY_SET = new Set<string>(STORAGE_AUTHORITIES);
const FILE_FORBIDDEN_MODE_BITS = NON_OWNER_BITS | 0o100; // 0o177: group/other + owner execute
const STREAM_READ_CHUNK_BYTES = 64 * 1024;

function isOwnerOnlyDirMode(mode: number): boolean {
  if (process.platform === 'win32') return true;
  return (mode & NON_OWNER_BITS) === 0;
}

export function isOwnerOnlyFileMode(mode: number): boolean {
  if (process.platform === 'win32') return true;
  return (mode & FILE_FORBIDDEN_MODE_BITS) === 0;
}

export function statFileFingerprintSync(resolvedPath: string): FileStatFingerprint | null {
  try {
    const st = lstatSync(resolvedPath, { bigint: true });
    if (st.isSymbolicLink() || !st.isFile() || !isOwnerOnlyFileMode(Number(st.mode))) {
      return null;
    }
    return {
      dev: st.dev,
      ino: st.ino,
      size: st.size,
      mtimeNs: st.mtimeNs,
      ctimeNs: st.ctimeNs
    };
  } catch {
    return null;
  }
}

export function fingerprintsMatch(a: FileStatFingerprint, b: FileStatFingerprint): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

function readBoundedUtf8FileSync(
  resolvedPath: string,
  maxBytes: number
): { readonly ok: true; readonly content: string } | { readonly ok: false } {
  let fd: number | null = null;
  try {
    fd = openReadOnlyNoFollowSync(resolvedPath);
    const preStat = fstatSync(fd);
    if (!preStat.isFile() || !isOwnerOnlyFileMode(preStat.mode) || preStat.size > maxBytes) {
      return { ok: false };
    }
    const chunks: Buffer[] = [];
    let totalRead = 0;
    if (maxBytes > 0) {
      const buf = Buffer.allocUnsafe(Math.min(STREAM_READ_CHUNK_BYTES, maxBytes));
      while (totalRead < maxBytes) {
        const toRead = Math.min(buf.byteLength, maxBytes - totalRead);
        const bytesRead = readSync(fd, buf, 0, toRead, null);
        if (bytesRead === 0) break;
        chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
        totalRead += bytesRead;
      }
    }
    const postStat = fstatSync(fd);
    if (
      !postStat.isFile() ||
      !isOwnerOnlyFileMode(postStat.mode) ||
      postStat.size > maxBytes ||
      totalRead !== postStat.size
    ) {
      return { ok: false };
    }
    return { ok: true, content: Buffer.concat(chunks, totalRead).toString('utf8') };
  } catch {
    return { ok: false };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failure.
      }
    }
  }
}

export function validateBackupPathBeforeOpen(
  backupDatabasePath: string,
  trustedRootDir?: string,
  maxDatabaseBytes: number = MAX_BACKUP_DATABASE_BYTES,
  maxManifestBytes: number = MAX_BACKUP_MANIFEST_BYTES
):
  | {
      readonly ok: true;
      readonly resolvedPath: string;
      readonly fileBytes: number;
      readonly companionManifestBytes?: number | undefined;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly reasonCode?: BackupRestoreRejectionCode | undefined;
    } {
  if (backupDatabasePath.length === 0 || backupDatabasePath.includes('\0')) {
    return { ok: false, error: 'Backup database path is empty or contains a NUL byte' };
  }
  const rawSegments = backupDatabasePath.split(/[\\/]/);
  if (rawSegments.some((seg) => seg === '.' || seg === '..')) {
    return { ok: false, error: 'Backup database path must not contain relative "." or ".." segments' };
  }
  const resolvedTarget = path.resolve(backupDatabasePath);
  const leafName = path.basename(resolvedTarget);
  if (!SAFE_BACKUP_FILENAME_PATTERN.test(leafName) || leafName.includes('..')) {
    return { ok: false, error: 'Backup database filename must be a plain *.db or *.sqlite leaf name' };
  }
  if (trustedRootDir !== undefined) {
    if (!path.isAbsolute(trustedRootDir) || trustedRootDir.includes('\0')) {
      return { ok: false, error: 'Trusted backup root directory must be an absolute path' };
    }
    if (!path.isAbsolute(backupDatabasePath)) {
      return { ok: false, error: 'Backup database path must be an absolute path under trusted root' };
    }
    const resolvedRoot = path.resolve(trustedRootDir);
    const rel = path.relative(resolvedRoot, resolvedTarget);
    if (rel.length === 0 || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return { ok: false, error: 'Backup database path escapes trusted root directory' };
    }
    const parts = rel.split(path.sep);
    let current = resolvedRoot;
    for (let i = 0; i < parts.length - 1; i += 1) {
      current = path.join(current, parts[i]!);
      try {
        const dirStat = lstatSync(current);
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
          return { ok: false, error: 'Backup path traverses a symlink or non-directory component' };
        }
      } catch {
        return { ok: false, error: 'Backup parent directory is unreadable' };
      }
    }
  }
  const parentDir = path.dirname(resolvedTarget);
  let parentStat: ReturnType<typeof lstatSync>;
  try {
    parentStat = lstatSync(parentDir);
  } catch {
    return { ok: false, error: 'Backup parent directory is unreadable' };
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    return { ok: false, error: 'Backup parent directory must not be a symlink or non-directory' };
  }
  if (!isOwnerOnlyDirMode(parentStat.mode)) {
    return { ok: false, error: 'Backup parent directory permissions must be owner-only (0700)' };
  }

  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(resolvedTarget);
  } catch {
    return { ok: false, error: 'Backup database file does not exist or is unreadable' };
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, error: 'Backup database path must not be a symbolic link' };
  }
  if (!stat.isFile()) {
    return { ok: false, error: 'Backup database path must be a regular file' };
  }
  if (!isOwnerOnlyFileMode(stat.mode)) {
    return { ok: false, error: 'Backup database file permissions must be owner-only (0600)' };
  }
  const companionManifestPath = path.join(parentDir, manifestFileNameFor(leafName));
  let companionManifestBytes: number | undefined;
  try {
    const manifestStat = lstatSync(companionManifestPath);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
      return { ok: false, error: 'Backup companion manifest must be a regular non-symlink file' };
    }
    if (!isOwnerOnlyFileMode(manifestStat.mode)) {
      return {
        ok: false,
        error: 'Backup companion manifest permissions must be owner-only (0600)'
      };
    }
    if (manifestStat.size > maxManifestBytes) {
      return {
        ok: false,
        reasonCode: 'BACKUP_MANIFEST_BOUND_EXCEEDED',
        error: `Backup companion manifest size (${manifestStat.size} bytes) exceeds maximum limit (${maxManifestBytes} bytes)`
      };
    }
    companionManifestBytes = manifestStat.size;
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code !== 'ENOENT') {
      return { ok: false, error: 'Backup companion manifest could not be verified' };
    }
  }
  // VACUUM INTO produces a single self-contained database image. Any pre-existing
  // -wal/-shm/-journal sidecar (regular or symlink) must be refused so SQLite cannot
  // replay unverified pages alongside a digest-verified main file.
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    let sidecarExists = false;
    try {
      lstatSync(`${resolvedTarget}${suffix}`);
      sidecarExists = true;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code !== 'ENOENT') {
        return { ok: false, error: `Backup SQLite sidecar (${suffix}) could not be verified` };
      }
    }
    if (sidecarExists) {
      return {
        ok: false,
        error: `Backup SQLite sidecar (${suffix}) is present; backups must be self-contained single files`
      };
    }
  }
  if (stat.size > maxDatabaseBytes) {
    return {
      ok: false,
      reasonCode: 'RESTORE_IMAGE_BOUND_EXCEEDED',
      error: `Backup database size (${stat.size} bytes) exceeds maximum limit (${maxDatabaseBytes} bytes)`
    };
  }
  return { ok: true, resolvedPath: resolvedTarget, fileBytes: stat.size, companionManifestBytes };
}

export function computeFileDigestSync(
  resolvedPath: string,
  expectedMaxBytes: number
):
  | { readonly ok: true; readonly byteLength: number; readonly sha256: string }
  | {
      readonly ok: false;
      readonly error: string;
      readonly reasonCode?: BackupRestoreRejectionCode | undefined;
    } {
  let fd: number | null = null;
  try {
    fd = openReadOnlyNoFollowSync(resolvedPath);
    const preStat = fstatSync(fd);
    if (!preStat.isFile()) {
      return { ok: false, error: 'Backup database path must be a regular file' };
    }
    if (!isOwnerOnlyFileMode(preStat.mode)) {
      return { ok: false, error: 'Backup database file permissions must be owner-only (0600)' };
    }
    if (preStat.size > expectedMaxBytes) {
      return {
        ok: false,
        reasonCode: 'RESTORE_IMAGE_BOUND_EXCEEDED',
        error: `Backup database size (${preStat.size} bytes) exceeds maximum limit (${expectedMaxBytes} bytes)`
      };
    }
    const hash = createHash('sha256');
    let totalRead = 0;
    if (expectedMaxBytes > 0) {
      const chunk = Buffer.allocUnsafe(Math.min(STREAM_READ_CHUNK_BYTES, expectedMaxBytes));
      while (totalRead < expectedMaxBytes) {
        const toRead = Math.min(chunk.byteLength, expectedMaxBytes - totalRead);
        const bytesRead = readSync(fd, chunk, 0, toRead, null);
        if (bytesRead === 0) break;
        hash.update(chunk.subarray(0, bytesRead));
        totalRead += bytesRead;
      }
    }
    const postStat = fstatSync(fd);
    if (!postStat.isFile() || !isOwnerOnlyFileMode(postStat.mode)) {
      return { ok: false, error: 'Backup database file changed during digest verification' };
    }
    if (postStat.size > expectedMaxBytes) {
      return {
        ok: false,
        reasonCode: 'RESTORE_IMAGE_BOUND_EXCEEDED',
        error: `Backup database size (${postStat.size} bytes) exceeds maximum limit (${expectedMaxBytes} bytes)`
      };
    }
    if (totalRead !== postStat.size) {
      return { ok: false, error: 'Backup database file changed during digest verification' };
    }
    return { ok: true, byteLength: totalRead, sha256: hash.digest('hex') };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'ELOOP') {
      return { ok: false, error: 'Backup database path must not be a symbolic link' };
    }
    return { ok: false, error: 'Backup database file could not be read for digest verification' };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failure.
      }
    }
  }
}

export function assertPathAndSidecarsAbsent(
  backupDatabasePath: string,
  includeLeaf: boolean,
  manifestPath?: string
): void {
  const targets = includeLeaf
    ? [
        backupDatabasePath,
        ...(manifestPath ? [manifestPath] : []),
        ...SQLITE_SIDECAR_SUFFIXES.map((s) => `${backupDatabasePath}${s}`)
      ]
    : SQLITE_SIDECAR_SUFFIXES.map((s) => `${backupDatabasePath}${s}`);
  for (const target of targets) {
    let exists = false;
    try {
      lstatSync(target);
      exists = true;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code !== 'ENOENT') {
        throw new Error('BACKUP_PATH_REFUSED: unable to verify backup output path absence');
      }
    }
    if (exists) {
      throw new Error('BACKUP_PATH_REFUSED: backup output file, manifest, or SQLite sidecar already exists');
    }
  }
}

export function manifestFileNameFor(backupFileName: string): string {
  return `${backupFileName}${MANIFEST_SUFFIX}`;
}

export function parseAndValidateBackupManifest(rawJson: string): BackupDependencyManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.backupId !== 'string' ||
    !SAFE_BACKUP_ID_PATTERN.test(obj.backupId) ||
    obj.backupId.includes('..')
  ) {
    return null;
  }
  if (
    typeof obj.createdAtMs !== 'number' ||
    !Number.isSafeInteger(obj.createdAtMs) ||
    obj.createdAtMs < 0 ||
    Number.isNaN(new Date(obj.createdAtMs).getTime())
  ) {
    return null;
  }
  if (
    typeof obj.schemaVersion !== 'number' ||
    !Number.isSafeInteger(obj.schemaVersion) ||
    obj.schemaVersion < 1
  ) {
    return null;
  }
  if (
    typeof obj.sqliteVersion !== 'string' ||
    obj.sqliteVersion.length === 0 ||
    obj.sqliteVersion.length > 64
  ) {
    return null;
  }
  if (typeof obj.databaseSha256 !== 'string' || !SHA256_HEX_PATTERN.test(obj.databaseSha256)) {
    return null;
  }
  if (
    typeof obj.databaseBytes !== 'number' ||
    !Number.isSafeInteger(obj.databaseBytes) ||
    obj.databaseBytes <= 0 ||
    obj.databaseBytes > MAX_BACKUP_DATABASE_BYTES
  ) {
    return null;
  }
  if (typeof obj.cutoverAuthority !== 'string' || !STORAGE_AUTHORITY_SET.has(obj.cutoverAuthority)) {
    return null;
  }
  if (!Array.isArray(obj.externalDependencies)) {
    return null;
  }
  const deps: BackupExternalDependency[] = [];
  for (const item of obj.externalDependencies) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return null;
    }
    const dep = item as Record<string, unknown>;
    if (
      dep.dependencyKind !== 'artifact_blob' &&
      dep.dependencyKind !== 'log_segment' &&
      dep.dependencyKind !== 'audit_log'
    ) {
      return null;
    }
    if (
      typeof dep.referenceId !== 'string' ||
      dep.referenceId.length === 0 ||
      typeof dep.relativePath !== 'string' ||
      dep.relativePath.length === 0 ||
      typeof dep.byteLength !== 'number' ||
      !Number.isSafeInteger(dep.byteLength) ||
      dep.byteLength < 0 ||
      typeof dep.sha256Digest !== 'string' ||
      dep.sha256Digest.length === 0
    ) {
      return null;
    }
    deps.push({
      dependencyKind: dep.dependencyKind,
      referenceId: dep.referenceId,
      relativePath: dep.relativePath,
      byteLength: dep.byteLength,
      sha256Digest: dep.sha256Digest
    });
  }
  return {
    backupId: obj.backupId,
    createdAtMs: obj.createdAtMs,
    schemaVersion: obj.schemaVersion,
    sqliteVersion: obj.sqliteVersion,
    databaseSha256: obj.databaseSha256,
    databaseBytes: obj.databaseBytes,
    cutoverAuthority: obj.cutoverAuthority as StorageAuthority,
    externalDependencies: deps
  };
}

export interface ListedBackupEntry {
  readonly backupId: string;
  readonly fileName: string;
  readonly backupDatabasePath: string;
  readonly manifestPath: string;
  readonly createdAtMs: number | null;
  readonly schemaVersion: number | null;
  readonly databaseBytes: number;
  readonly manifestStatus: 'valid' | 'missing' | 'invalid';
  readonly manifestErrorCode?: BackupRestoreRejectionCode | undefined;
  readonly manifest?: BackupDependencyManifest | undefined;
}

/**
 * Lists backup images and companion manifests under a contained directory within
 * `trustedRootDir`. Never creates directories or files; returns `[]` when absent.
 */
export async function listBackupsInRoot(
  trustedRootDir: string,
  relativeBackupDirSegments: readonly string[]
): Promise<readonly ListedBackupEntry[]> {
  if (!path.isAbsolute(trustedRootDir) || trustedRootDir.includes('\0')) {
    return [];
  }
  const walked = await walkDirectoriesWithinRoot(trustedRootDir, relativeBackupDirSegments);
  if (walked.outcome !== 'ready') {
    return [];
  }
  const dirPath = walked.directory;
  let dirStat: ReturnType<typeof lstatSync>;
  try {
    dirStat = lstatSync(dirPath);
  } catch {
    return [];
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || !isOwnerOnlyDirMode(dirStat.mode)) {
    return [];
  }
  let names: string[];
  try {
    names = readdirSync(dirPath);
  } catch {
    return [];
  }

  const entries: ListedBackupEntry[] = [];
  for (const name of names) {
    if (!SAFE_BACKUP_FILENAME_PATTERN.test(name) || name.includes('..')) {
      continue;
    }
    const dbPath = path.join(dirPath, name);
    let dbStat: ReturnType<typeof lstatSync>;
    try {
      dbStat = lstatSync(dbPath);
    } catch {
      continue;
    }
    if (dbStat.isSymbolicLink() || !dbStat.isFile()) {
      continue;
    }

    const fallbackId = name.replace(/\.(?:db|sqlite|sqlite3)$/, '');
    const manifestPath = path.join(dirPath, manifestFileNameFor(name));
    let manifestStatus: 'valid' | 'missing' | 'invalid' = 'missing';
    let manifestErrorCode: BackupRestoreRejectionCode | undefined;
    let manifest: BackupDependencyManifest | undefined;
    if (!isOwnerOnlyFileMode(dbStat.mode)) {
      manifestStatus = 'invalid';
    } else if (dbStat.size > MAX_BACKUP_DATABASE_BYTES) {
      manifestStatus = 'invalid';
      manifestErrorCode = 'RESTORE_IMAGE_BOUND_EXCEEDED';
    } else {
      try {
        const mStat = lstatSync(manifestPath);
        if (mStat.isSymbolicLink() || !mStat.isFile() || !isOwnerOnlyFileMode(mStat.mode)) {
          manifestStatus = 'invalid';
        } else if (mStat.size > MAX_BACKUP_MANIFEST_BYTES) {
          manifestStatus = 'invalid';
          manifestErrorCode = 'BACKUP_MANIFEST_BOUND_EXCEEDED';
        } else {
          const bounded = readBoundedUtf8FileSync(manifestPath, MAX_BACKUP_MANIFEST_BYTES);
          if (!bounded.ok) {
            manifestStatus = 'invalid';
          } else {
            const parsed = parseAndValidateBackupManifest(bounded.content);
            if (parsed === null || parsed.backupId !== fallbackId) {
              manifestStatus = 'invalid';
            } else {
              manifest = parsed;
              manifestStatus = 'valid';
            }
          }
        }
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        manifestStatus = code === 'ENOENT' ? 'missing' : 'invalid';
      }
    }

    entries.push({
      backupId: manifest?.backupId ?? fallbackId,
      fileName: name,
      backupDatabasePath: dbPath,
      manifestPath,
      createdAtMs: manifest?.createdAtMs ?? null,
      schemaVersion: manifest?.schemaVersion ?? null,
      databaseBytes: dbStat.size,
      manifestStatus,
      ...(manifestErrorCode !== undefined ? { manifestErrorCode } : {}),
      manifest
    });
  }

  entries.sort((a, b) => {
    const timeDiff = (b.createdAtMs ?? -1) - (a.createdAtMs ?? -1);
    if (timeDiff !== 0) return timeDiff;
    return b.fileName.localeCompare(a.fileName);
  });
  return entries;
}
