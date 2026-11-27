/**
 * FR-R6-F04 (F04-A, FR-004) — Trusted host storage location resolver.
 *
 * Enforces:
 * - Only host-trusted storage roots (`host_storage_uri` or
 *   `host_global_storage_uri`) are accepted; webview, workspace-setting, and
 *   untrusted env overrides are rejected before touching the filesystem.
 * - Directory creation uses `ensureAnchorWithinRoot` from `src/lib/safe-open.ts`
 *   with literal `0o700` mode (Hard Rule 69).
 * - Network/distributed filesystems (`nfs`, `smb`, `cifs`, `afp`, `webdav`,
 *   `fuse.sshfs`, `smbfs`, `ncpfs`) are refused when `WAL` mode is requested.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * Zero raw `node:fs` write primitives (docs/hard-rules.md rule 69).
 */

import * as path from 'node:path';
import {
  NETWORK_FILESYSTEM_TYPES,
  type StorageLocationRequest,
  type StorageLocationResolution
} from '../../contracts/sqlite-store/schema-types';
import { ensureAnchorWithinRoot, openWithinRoot } from '../../lib/safe-open';
import {
  classifyFilesystemTypeName,
  detectFilesystemType,
  type FilesystemClassification,
  type FilesystemTypeVerdict
} from './filesystem-type-detector';

const SAFE_DB_FILENAME_PATTERN = /^[A-Za-z0-9._-]+\.(?:db|sqlite|sqlite3)$/;

export interface TrustedSqliteLocationRequest extends StorageLocationRequest {
  readonly filesystemClassification?: FilesystemClassification | undefined;
  readonly detectFilesystemType?: ((targetPath: string) => Promise<FilesystemTypeVerdict>) | undefined;
}

export function isNetworkFilesystem(filesystemType: string | undefined): boolean {
  if (!filesystemType) return false;
  const normalized = filesystemType.trim().toLowerCase();
  if ((NETWORK_FILESYSTEM_TYPES as readonly string[]).includes(normalized)) return true;
  return classifyFilesystemTypeName(normalized).classification === 'network';
}

export async function resolveTrustedSqliteLocation(
  request: TrustedSqliteLocationRequest
): Promise<StorageLocationResolution> {
  if (
    request.sourceKind !== 'host_storage_uri' &&
    request.sourceKind !== 'host_global_storage_uri'
  ) {
    return {
      status: 'refused',
      reason: 'untrusted_source',
      operatorDiagnostic:
        `Refused SQLite storage location from untrusted source '${request.sourceKind}'. ` +
        'Database paths must originate from host storageUri or globalStorageUri.'
    };
  }

  if (!path.isAbsolute(request.trustedRootDir)) {
    return {
      status: 'refused',
      reason: 'escapes_trusted_root',
      operatorDiagnostic: 'Trusted storage root must be an absolute host directory path.'
    };
  }

  const dbFileName = request.databaseFileName ?? 'schegent-state.db';
  if (
    !SAFE_DB_FILENAME_PATTERN.test(dbFileName) ||
    dbFileName.includes('/') ||
    dbFileName.includes('\\') ||
    dbFileName.includes('..')
  ) {
    return {
      status: 'refused',
      reason: 'invalid_database_filename',
      operatorDiagnostic: `Refused database filename '${dbFileName}': must be a plain '*.db' or '*.sqlite' leaf name.`
    };
  }

  if (request.relativeSegments.length === 0) {
    return {
      status: 'refused',
      reason: 'escapes_trusted_root',
      operatorDiagnostic: 'Storage location requires at least one relative directory segment beneath the trusted root.'
    };
  }

  for (const segment of request.relativeSegments) {
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('/') ||
      segment.includes('\\')
    ) {
      return {
        status: 'refused',
        reason: 'escapes_trusted_root',
        operatorDiagnostic: `Refused storage path containing invalid or traversal segment '${segment}'.`
      };
    }
  }

  const journalMode = request.requestedJournalMode ?? 'wal';
  let fsType: string;
  let fsClassification: FilesystemClassification;
  if (request.filesystemType !== undefined) {
    const classified = classifyFilesystemTypeName(request.filesystemType);
    fsType = classified.filesystemType;
    fsClassification =
      isNetworkFilesystem(fsType)
        ? 'network'
        : (request.filesystemClassification ?? classified.classification);
  } else if (request.filesystemClassification !== undefined) {
    fsClassification = request.filesystemClassification;
    fsType = fsClassification === 'network' ? 'network' : fsClassification;
  } else {
    const probed = await (request.detectFilesystemType ?? detectFilesystemType)(
      path.join(request.trustedRootDir, ...request.relativeSegments)
    );
    fsClassification = probed.classification;
    fsType = probed.filesystemType;
  }
  if (journalMode === 'wal' && (fsClassification === 'network' || isNetworkFilesystem(fsType))) {
    return {
      status: 'refused',
      reason: 'network_share_wal_unsupported',
      operatorDiagnostic:
        `Refused SQLite WAL mode on network filesystem '${fsType}'. ` +
        'Shared-memory WAL (.shm) locking is unsafe across network shares; store the database on a local filesystem.'
    };
  }

  const anchorResult = await ensureAnchorWithinRoot(
    request.trustedRootDir,
    request.relativeSegments,
    0o700
  );

  if (anchorResult.outcome === 'refused') {
    return {
      status: 'refused',
      reason: 'symlink_or_containment_refused',
      operatorDiagnostic: `Refused storage directory under trusted root: ${anchorResult.reason}.`
    };
  }

  for (const suffix of ['-wal', '-shm']) {
    const sidecar = await openWithinRoot(request.trustedRootDir, [...request.relativeSegments, `${dbFileName}${suffix}`], { flags: 'r' });
    if (sidecar.outcome === 'opened') {
      await sidecar.handle.close();
    } else if (sidecar.reason !== 'io-failed' || sidecar.errno !== 'ENOENT') {
      return {
        status: 'refused',
        reason: 'symlink_or_containment_refused',
        operatorDiagnostic: `Refused database sidecar under trusted root: ${sidecar.reason}.`
      };
    }
  }

  // Pre-create and narrow the database file with 0o600 permissions and O_NOFOLLOW
  // via openWithinRoot so SQLite opens an already-narrowed regular file.
  const fileSegments = [...request.relativeSegments, dbFileName];
  const openResult = await openWithinRoot(request.trustedRootDir, fileSegments, {
    flags: 'a',
    createDirs: true,
    dirMode: 0o700,
    fileMode: 0o600
  });

  if (openResult.outcome === 'refused') {
    return {
      status: 'refused',
      reason: 'symlink_or_containment_refused',
      operatorDiagnostic: `Refused database file under trusted root: ${openResult.reason}.`
    };
  }
  await openResult.handle.close();

  const databasePath = path.join(anchorResult.anchor, dbFileName);
  return {
    status: 'resolved',
    anchorDirectory: anchorResult.anchor,
    databasePath,
    walPath: `${databasePath}-wal`,
    shmPath: `${databasePath}-shm`,
    journalMode,
    expectedDirMode: 0o700,
    expectedFileMode: 0o600,
    filesystemType: fsType
  };
}
