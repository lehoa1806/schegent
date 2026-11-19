/**
 * FR-R7-03 (FR-002, FR-005, FR-010) — Companion backup manifest parsing, validation,
 * and read-only contained backup listing under `<storageRoot>/sqlite/<scopeId>/backups/`.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * Zero raw `node:fs` write primitives (docs/hard-rules.md rule 69).
 */

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  STORAGE_AUTHORITIES,
  type BackupDependencyManifest,
  type BackupExternalDependency,
  type StorageAuthority
} from '../../contracts/sqlite-store/schema-types';
import { walkDirectoriesWithinRoot } from '../../lib/safe-open';

export const SAFE_BACKUP_FILENAME_PATTERN = /^[A-Za-z0-9._-]+\.(?:db|sqlite|sqlite3)$/;
export const SAFE_BACKUP_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
export const MAX_BACKUP_DATABASE_BYTES = 512 * 1024 * 1024;
export const MAX_BACKUP_MANIFEST_BYTES = 16 * 1024 * 1024;
export const MANIFEST_SUFFIX = '.manifest.json';
export const SQLITE_SIDECAR_SUFFIXES = Object.freeze(['-wal', '-shm', '-journal'] as const);

const STORAGE_AUTHORITY_SET = new Set<string>(STORAGE_AUTHORITIES);

export function validateBackupPathBeforeOpen(
  backupDatabasePath: string,
  trustedRootDir?: string
):
  | { readonly ok: true; readonly resolvedPath: string; readonly fileBytes: number }
  | { readonly ok: false; readonly error: string } {
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
  if (stat.size > MAX_BACKUP_DATABASE_BYTES) {
    return {
      ok: false,
      error: `Backup database size (${stat.size} bytes) exceeds maximum limit (${MAX_BACKUP_DATABASE_BYTES} bytes)`
    };
  }
  return { ok: true, resolvedPath: resolvedTarget, fileBytes: stat.size };
}

export function computeFileDigestSync(
  resolvedPath: string,
  expectedMaxBytes: number
):
  | { readonly ok: true; readonly byteLength: number; readonly sha256: string }
  | { readonly ok: false; readonly error: string } {
  try {
    const buf = readFileSync(resolvedPath);
    if (buf.byteLength > expectedMaxBytes) {
      return {
        ok: false,
        error: `Backup database size (${buf.byteLength} bytes) exceeds maximum limit (${expectedMaxBytes} bytes)`
      };
    }
    const sha256 = createHash('sha256').update(buf).digest('hex');
    return { ok: true, byteLength: buf.byteLength, sha256 };
  } catch {
    return { ok: false, error: 'Backup database file could not be read for digest verification' };
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
    obj.createdAtMs < 0
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
    let manifest: BackupDependencyManifest | undefined;
    try {
      const mStat = lstatSync(manifestPath);
      if (mStat.isSymbolicLink() || !mStat.isFile() || mStat.size > MAX_BACKUP_MANIFEST_BYTES) {
        manifestStatus = 'invalid';
      } else {
        const raw = readFileSync(manifestPath, 'utf8');
        const parsed = parseAndValidateBackupManifest(raw);
        if (parsed === null || parsed.backupId !== fallbackId) {
          manifestStatus = 'invalid';
        } else {
          manifest = parsed;
          manifestStatus = 'valid';
        }
      }
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      manifestStatus = code === 'ENOENT' ? 'missing' : 'invalid';
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
