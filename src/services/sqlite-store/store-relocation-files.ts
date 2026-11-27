import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { resolveContainedLink } from '../../lib/path-containment';
import { judgeLeafRedirect, openWithinRoot, platformLacksNoFollow } from '../../lib/safe-open';
import { verifySqliteCandidateWithinRoot, type VerifiedSqliteCandidate } from '../../lib/sqlite-readonly-inspect';
import type { CandidateFileFingerprint, RelocateLegacySqliteStoreRequest, RelocationJournal } from './store-relocation';

const FILE_MODE = 0o600;
export const CANONICAL_DB_FILENAME = 'schegent-state.db';
export const STAGING_DB_FILENAME = '.schegent-state.relocate.staging.db';

const errnoOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;

const isMissing = (error: unknown): boolean => {
  const code = errnoOf(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
};

export async function writeFully(handle: fsp.FileHandle, bytes: Buffer): Promise<void> {
  for (let offset = 0; offset < bytes.length; ) {
    offset += (await handle.write(bytes, offset, bytes.length - offset)).bytesWritten;
  }
}

export async function unlinkContainedEntry(
  root: string,
  targetPath: string,
  unlinkFn?: (resolvedPath: string) => Promise<void>
): Promise<boolean> {
  const verdict = await resolveContainedLink(targetPath, [root]);
  if (verdict.outcome === 'absent') return true;
  if (verdict.outcome !== 'contained') return false;
  const leaf = await judgeLeafRedirect(verdict.resolved, ['ENOENT'], platformLacksNoFollow());
  if (leaf.outcome !== 'ok') return false;
  try {
    if (unlinkFn !== undefined) await unlinkFn(verdict.resolved);
    else await fsp.unlink(verdict.resolved);
    return true;
  } catch (error) {
    return isMissing(error);
  }
}

export async function renameContainedEntry(anchorDir: string, fromName: string, toName: string): Promise<boolean> {
  const realAnchor = await fsp.realpath(anchorDir).catch(() => null);
  if (realAnchor === null) return false;
  const fromVerdict = await resolveContainedLink(path.join(anchorDir, fromName), [anchorDir]);
  const toVerdict = await resolveContainedLink(path.join(anchorDir, toName), [anchorDir]);
  if (fromVerdict.outcome !== 'contained') return false;
  if (toVerdict.outcome !== 'contained' && toVerdict.outcome !== 'absent') return false;
  const resolvedTo = toVerdict.outcome === 'contained' ? toVerdict.resolved : path.join(realAnchor, toName);
  if (path.dirname(fromVerdict.resolved) !== realAnchor || path.dirname(resolvedTo) !== realAnchor) return false;
  const sourceLeaf = await judgeLeafRedirect(fromVerdict.resolved, [], platformLacksNoFollow());
  const destinationLeaf = await judgeLeafRedirect(resolvedTo, ['ENOENT'], platformLacksNoFollow());
  if (sourceLeaf.outcome !== 'ok' || destinationLeaf.outcome !== 'ok') return false;
  await fsp.rename(fromVerdict.resolved, resolvedTo);
  return true;
}

export async function syncRelocationDirectory(directory: string): Promise<void> {
  // Node cannot open a directory for syncing on Windows.
  if (process.platform === 'win32') return;
  const handle = await fsp.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export const fingerprintFromVerified = (v: VerifiedSqliteCandidate): CandidateFileFingerprint => ({
  sizeBytes: v.dbSizeBytes, mtimeMs: v.dbMtimeMs, walSizeBytes: v.walSizeBytes, walMtimeMs: v.walMtimeMs
});

export const fingerprintsMatch = (a: CandidateFileFingerprint, b: CandidateFileFingerprint): boolean =>
  a.sizeBytes === b.sizeBytes && Math.trunc(a.mtimeMs) === Math.trunc(b.mtimeMs) &&
  a.walSizeBytes === b.walSizeBytes && Math.trunc(a.walMtimeMs) === Math.trunc(b.walMtimeMs);

export async function matchesPreviousCanonical(
  canonicalRoot: string,
  relativeDirSegments: readonly string[],
  expected: RelocationJournal['previousCanonicalFingerprint']
): Promise<boolean> {
  if (expected === undefined) return false;
  const current = await verifySqliteCandidateWithinRoot(canonicalRoot, relativeDirSegments, CANONICAL_DB_FILENAME);
  if (expected === null) return current.outcome === 'absent';
  if (current.outcome !== 'ok') return false;
  const fingerprint = fingerprintFromVerified(current.verified);
  // The previous attempt may already have removed the old canonical sidecars.
  const pending = fingerprint.walSizeBytes === 0 && fingerprint.walMtimeMs === 0
    ? { ...expected, walSizeBytes: 0, walMtimeMs: 0 }
    : expected;
  return fingerprintsMatch(fingerprint, pending);
}

export async function publishStagedRelocation(
  canonicalRoot: string,
  canonicalAnchorDir: string,
  onStage: RelocateLegacySqliteStoreRequest['onStage']
): Promise<void> {
  const canonicalDbPath = path.join(canonicalAnchorDir, CANONICAL_DB_FILENAME);
  if (
    !(await unlinkContainedEntry(canonicalRoot, `${canonicalDbPath}-shm`)) ||
    !(await unlinkContainedEntry(canonicalRoot, `${canonicalDbPath}-wal`))
  ) {
    throw new Error('RELOCATION_CANONICAL_SIDECAR_REFUSED');
  }
  await onStage?.('after_remove_canonical_sidecars');
  if (!(await renameContainedEntry(canonicalAnchorDir, STAGING_DB_FILENAME, CANONICAL_DB_FILENAME))) {
    throw new Error('RELOCATION_ATOMIC_PUBLISH_REFUSED');
  }
  await onStage?.('after_atomic_publish');
}

export async function readRegularFileWithinRoot(root: string, segments: readonly string[]): Promise<Buffer | null> {
  const opened = await openWithinRoot(root, segments, { flags: 'r' });
  if (opened.outcome !== 'opened') return null;
  try {
    return await opened.handle.readFile();
  } catch {
    return null;
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

export async function readJsonStatusWithinRoot(root: string, segments: readonly string[]): Promise<{ readonly kind: 'absent' } | { readonly kind: 'malformed' } | { readonly kind: 'parsed'; readonly value: unknown }> {
  const opened = await openWithinRoot(root, segments, { flags: 'r' });
  if (opened.outcome !== 'opened') {
    return opened.reason === 'io-failed' && (opened.errno === 'ENOENT' || opened.errno === 'ENOTDIR') ? { kind: 'absent' } : { kind: 'malformed' };
  }
  try {
    return { kind: 'parsed', value: JSON.parse((await opened.handle.readFile()).toString('utf8')) as unknown };
  } catch {
    return { kind: 'malformed' };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

export async function computeFileSha256WithinRoot(root: string, segments: readonly string[]): Promise<string | null> {
  const bytes = await readRegularFileWithinRoot(root, segments);
  return bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
}

export async function writeAtomicJsonWithinAnchor(anchorDir: string, tempName: string, finalName: string, payload: unknown): Promise<void> {
  await unlinkContainedEntry(anchorDir, path.join(anchorDir, tempName));
  const opened = await openWithinRoot(anchorDir, [tempName], { flags: 'wx', fileMode: FILE_MODE });
  if (opened.outcome !== 'opened') throw new Error(`RELOCATION_WRITE_REFUSED:${opened.reason}:${opened.errno}`);
  try {
    await writeFully(opened.handle, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8'));
    await opened.handle.sync();
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
  if (!(await renameContainedEntry(anchorDir, tempName, finalName))) {
    await unlinkContainedEntry(anchorDir, path.join(anchorDir, tempName));
    throw new Error('RELOCATION_ATOMIC_RENAME_REFUSED');
  }
  await syncRelocationDirectory(anchorDir);
}
