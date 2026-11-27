/**
 * FR-R7-11 (T003, FR-016) — Host OS filesystem type detector for SQLite WAL eligibility.
 *
 * Probes the nearest existing ancestor of a target path (without creating directories)
 * and classifies the underlying mount as `'local'`, `'network'`, or `'unknown'`:
 * - `darwin`: parses `/sbin/mount` via `execFile` (2,000 ms timeout) with longest-prefix matching.
 * - `linux`: parses `/proc/<pid>/mountinfo` (fallback `/proc/<pid>/mounts`) via `openWithinRoot`.
 * - `win32`: classifies UNC paths (`\\server\share`, `\\?\UNC\...`) as `'network'` (`'smb'`)
 *   and local drive paths (`C:\...`, `\\?\C:\...`) as `'local'`.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * Zero raw `node:fs` write primitives (docs/hard-rules.md rule 69).
 */

import { execFile } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { NETWORK_FILESYSTEM_TYPES } from '../../contracts/sqlite-store/schema-types';
import { openWithinRoot } from '../../lib/safe-open';

const MOUNT_EXEC_TIMEOUT_MS = 2_000;
const MOUNT_EXEC_MAX_BUFFER = 1_048_576;

export type FilesystemClassification = 'local' | 'network' | 'unknown';

export interface FilesystemTypeVerdict {
  readonly classification: FilesystemClassification;
  readonly filesystemType: string;
  readonly probedAncestorPath?: string | undefined;
}

export interface DetectFilesystemTypeDeps {
  readonly platform?: NodeJS.Platform | undefined;
  readonly lstat?: ((targetPath: string) => Promise<unknown>) | undefined;
  readonly realpath?: ((targetPath: string) => Promise<string>) | undefined;
  readonly execDarwinMount?: (() => Promise<string>) | undefined;
  readonly readLinuxMountInfo?: (() => Promise<string | null>) | undefined;
  readonly readLinuxProcMounts?: (() => Promise<string | null>) | undefined;
}

const NETWORK_FILESYSTEM_SET: ReadonlySet<string> = new Set<string>([
  ...NETWORK_FILESYSTEM_TYPES,
  'nfs3',
  'nfs4',
  'smb2',
  'smb3',
  'smb3.1.1',
  'afpfs',
  'webdavfs',
  'sshfs',
  'davfs',
  'fuse.davfs',
  'fuse.rclone',
  'fuse.s3fs',
  'fuse.gcsfuse',
  'fuse.vmhgfs-fuse',
  'vmhgfs',
  'vboxsf',
  'prl_fs',
  '9p',
  'ceph',
  'glusterfs',
  'lustre',
  'ocfs2',
  'gfs2',
  'afs',
  'coda',
  'unc',
  'mup'
]);

const LOCAL_FILESYSTEM_SET: ReadonlySet<string> = new Set<string>([
  'apfs',
  'hfs',
  'hfs+',
  'ext2',
  'ext3',
  'ext4',
  'xfs',
  'btrfs',
  'zfs',
  'tmpfs',
  'ramfs',
  'devtmpfs',
  'overlay',
  'overlayfs',
  'squashfs',
  'f2fs',
  'jfs',
  'reiserfs',
  'ufs',
  'ffs',
  'ntfs',
  'refs',
  'fat',
  'fat32',
  'vfat',
  'exfat',
  'msdos',
  'msdosfs',
  'udf',
  'bcachefs',
  'nilfs2',
  'local'
]);

function errnoOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
}

function normalizePosixPath(rawPath: string): string {
  const collapsed = rawPath.replace(/\/+/g, '/');
  if (collapsed.length > 1 && collapsed.endsWith('/')) {
    return collapsed.slice(0, -1);
  }
  return collapsed;
}

function posixMountMatches(normalizedTarget: string, normalizedMount: string): boolean {
  if (normalizedMount === '/') return normalizedTarget.startsWith('/');
  return (
    normalizedTarget === normalizedMount ||
    normalizedTarget.startsWith(`${normalizedMount}/`)
  );
}

function unescapeProcMountPath(raw: string): string {
  return raw.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(parseInt(octal, 8))
  );
}

/**
 * Classifies a normalized OS filesystem type string into `'local'`, `'network'`, or `'unknown'`.
 */
export function classifyFilesystemTypeName(
  rawFsType: string | undefined
): FilesystemTypeVerdict {
  if (typeof rawFsType !== 'string') {
    return { classification: 'unknown', filesystemType: 'unknown' };
  }
  const normalized = rawFsType.trim().toLowerCase();
  if (normalized.length === 0 || normalized === 'unknown') {
    return { classification: 'unknown', filesystemType: 'unknown' };
  }
  if (
    NETWORK_FILESYSTEM_SET.has(normalized) ||
    normalized.startsWith('nfs') ||
    normalized.startsWith('smb') ||
    normalized.startsWith('cifs') ||
    normalized.startsWith('afp') ||
    normalized.startsWith('webdav') ||
    normalized.startsWith('fuse.sshfs')
  ) {
    return { classification: 'network', filesystemType: normalized };
  }
  if (LOCAL_FILESYSTEM_SET.has(normalized)) {
    return { classification: 'local', filesystemType: normalized };
  }
  return { classification: 'unknown', filesystemType: normalized };
}

/**
 * Parses macOS `/sbin/mount` stdout and matches the longest mount-point prefix for `targetPath`.
 */
export function parseDarwinMountOutput(
  mountStdout: string,
  targetPath: string
): FilesystemTypeVerdict {
  if (!targetPath || !targetPath.startsWith('/')) {
    return { classification: 'unknown', filesystemType: 'unknown' };
  }
  const normalizedTarget = normalizePosixPath(targetPath);
  let bestMountLen = -1;
  let bestFsType: string | undefined;

  for (const rawLine of mountStdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const parenOpen = line.lastIndexOf(' (');
    if (parenOpen === -1 || !line.endsWith(')')) continue;
    const flagsBody = line.slice(parenOpen + 2, -1);
    if (flagsBody.includes('(') || flagsBody.includes(')')) continue;
    const prefix = line.slice(0, parenOpen);
    const markerIdx = prefix.lastIndexOf(' on /');
    if (markerIdx <= 0) continue;
    const mountPoint = normalizePosixPath(prefix.slice(markerIdx + 4));
    if (!mountPoint.startsWith('/')) continue;
    if (!posixMountMatches(normalizedTarget, mountPoint)) continue;
    const flags = flagsBody
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0);
    const fsType = flags[0];
    if (!fsType) continue;
    if (mountPoint.length >= bestMountLen) {
      bestMountLen = mountPoint.length;
      bestFsType = fsType;
    }
  }

  return classifyFilesystemTypeName(bestFsType);
}

/**
 * Parses Linux `/proc/self/mountinfo` (or `/proc/<pid>/mountinfo`) and matches
 * the longest unescaped mount-point prefix for `targetPath`.
 */
export function parseLinuxMountInfo(
  mountInfoText: string,
  targetPath: string
): FilesystemTypeVerdict {
  if (!targetPath || !targetPath.startsWith('/')) {
    return { classification: 'unknown', filesystemType: 'unknown' };
  }
  const normalizedTarget = normalizePosixPath(targetPath);
  let bestMountLen = -1;
  let bestFsType: string | undefined;

  for (const rawLine of mountInfoText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const tokens = line.split(' ');
    const sepIdx = tokens.indexOf('-');
    if (sepIdx < 6 || sepIdx + 1 >= tokens.length) continue;
    const rawMountPoint = tokens[4];
    const fsType = tokens[sepIdx + 1];
    if (!rawMountPoint || !fsType) continue;
    const mountPoint = normalizePosixPath(unescapeProcMountPath(rawMountPoint));
    if (!mountPoint.startsWith('/')) continue;
    if (!posixMountMatches(normalizedTarget, mountPoint)) continue;
    if (mountPoint.length >= bestMountLen) {
      bestMountLen = mountPoint.length;
      bestFsType = fsType;
    }
  }

  return classifyFilesystemTypeName(bestFsType);
}

/**
 * Parses Linux `/proc/mounts` (fallback format) and matches the longest mount-point prefix.
 */
export function parseLinuxProcMounts(
  procMountsText: string,
  targetPath: string
): FilesystemTypeVerdict {
  if (!targetPath || !targetPath.startsWith('/')) {
    return { classification: 'unknown', filesystemType: 'unknown' };
  }
  const normalizedTarget = normalizePosixPath(targetPath);
  let bestMountLen = -1;
  let bestFsType: string | undefined;

  for (const rawLine of procMountsText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 3) continue;
    const rawMountPoint = tokens[1];
    const fsType = tokens[2];
    if (!rawMountPoint || !fsType) continue;
    const mountPoint = normalizePosixPath(unescapeProcMountPath(rawMountPoint));
    if (!mountPoint.startsWith('/')) continue;
    if (!posixMountMatches(normalizedTarget, mountPoint)) continue;
    if (mountPoint.length >= bestMountLen) {
      bestMountLen = mountPoint.length;
      bestFsType = fsType;
    }
  }

  return classifyFilesystemTypeName(bestFsType);
}

/**
 * Classifies Windows paths: UNC network shares (`\\server\share`, `\\?\UNC\...`)
 * report `'network'` (`'smb'`); local drive paths (`C:\...`, `\\?\C:\...`) report `'local'`.
 */
export function classifyWin32Path(targetPath: string): FilesystemTypeVerdict {
  const trimmed = targetPath.trim();
  if (trimmed.length === 0 || trimmed.includes('\0')) {
    return { classification: 'unknown', filesystemType: 'unknown' };
  }
  if (/^(?:\\\\\?\\UNC\\|\/\/\?\/UNC\/)/i.test(trimmed)) {
    return { classification: 'network', filesystemType: 'smb' };
  }
  if (/^(?:\\\\[^\\?][^\\]*\\[^\\]+|\/\/[^/?][^/]*\/[^/]+)/.test(trimmed)) {
    return { classification: 'network', filesystemType: 'smb' };
  }
  if (/^(?:\\\\\?\\|\/\/\?\/)?[A-Za-z]:(?:[\\/]|$)/.test(trimmed)) {
    return { classification: 'local', filesystemType: 'local' };
  }
  return { classification: 'unknown', filesystemType: 'unknown' };
}

function defaultExecDarwinMount(): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      '/sbin/mount',
      [],
      {
        encoding: 'utf8',
        timeout: MOUNT_EXEC_TIMEOUT_MS,
        maxBuffer: MOUNT_EXEC_MAX_BUFFER,
        env: { LC_ALL: 'C' }
      },
      (error, stdout) => {
        if (error !== null) {
          rejectPromise(error);
          return;
        }
        resolvePromise(stdout);
      }
    );
  });
}

async function readProcFile(fileName: 'mountinfo' | 'mounts'): Promise<string | null> {
  const opened = await openWithinRoot('/proc', [String(process.pid), fileName], { flags: 'r' });
  if (opened.outcome !== 'opened') return null;
  try {
    return await opened.handle.readFile('utf8');
  } catch {
    return null;
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

async function resolveNearestExistingAncestor(
  targetPath: string,
  lstatFn: (target: string) => Promise<unknown>,
  realpathFn: (target: string) => Promise<string>
): Promise<string | null> {
  let current = path.resolve(targetPath);
  for (;;) {
    try {
      await lstatFn(current);
      try {
        return await realpathFn(current);
      } catch {
        return current;
      }
    } catch (error) {
      const code = errnoOf(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return null;
      }
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/**
 * Probes the host OS mount table for `targetPath` by walking up to its nearest existing
 * ancestor without creating directories, returning `{ classification, filesystemType }`.
 */
export async function detectFilesystemType(
  targetPath: string,
  deps?: DetectFilesystemTypeDeps
): Promise<FilesystemTypeVerdict> {
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0 || targetPath.includes('\0')) {
    return { classification: 'unknown', filesystemType: 'unknown' };
  }

  const platform = deps?.platform ?? process.platform;
  const lstatFn = deps?.lstat ?? ((p: string) => fsp.lstat(p));
  const realpathFn = deps?.realpath ?? ((p: string) => fsp.realpath(p));

  if (platform === 'win32') {
    const direct = classifyWin32Path(targetPath);
    if (direct.classification === 'network') {
      return direct;
    }
    const ancestor = await resolveNearestExistingAncestor(targetPath, lstatFn, realpathFn);
    if (ancestor !== null) {
      const resolvedVerdict = classifyWin32Path(ancestor);
      return { ...resolvedVerdict, probedAncestorPath: ancestor };
    }
    return direct;
  }

  const ancestor = await resolveNearestExistingAncestor(targetPath, lstatFn, realpathFn);
  if (ancestor === null) {
    return { classification: 'unknown', filesystemType: 'unknown' };
  }

  if (platform === 'darwin') {
    try {
      const mountStdout = await (deps?.execDarwinMount ?? defaultExecDarwinMount)();
      const verdict = parseDarwinMountOutput(mountStdout, ancestor);
      return { ...verdict, probedAncestorPath: ancestor };
    } catch {
      return { classification: 'unknown', filesystemType: 'unknown', probedAncestorPath: ancestor };
    }
  }

  if (platform === 'linux') {
    try {
      const mountInfo = await (deps?.readLinuxMountInfo ?? (() => readProcFile('mountinfo')))();
      if (mountInfo !== null && mountInfo.length > 0) {
        const verdict = parseLinuxMountInfo(mountInfo, ancestor);
        if (verdict.filesystemType !== 'unknown') {
          return { ...verdict, probedAncestorPath: ancestor };
        }
      }
      const procMounts = await (deps?.readLinuxProcMounts ?? (() => readProcFile('mounts')))();
      if (procMounts !== null && procMounts.length > 0) {
        const verdict = parseLinuxProcMounts(procMounts, ancestor);
        return { ...verdict, probedAncestorPath: ancestor };
      }
    } catch {
      // Fall through to unknown verdict.
    }
    return { classification: 'unknown', filesystemType: 'unknown', probedAncestorPath: ancestor };
  }

  return { classification: 'unknown', filesystemType: 'unknown', probedAncestorPath: ancestor };
}
