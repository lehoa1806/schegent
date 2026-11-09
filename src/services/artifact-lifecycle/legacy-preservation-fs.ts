/**
 * FR-R6-F05 US3 (FR-014, FR-015) — the byte-level filesystem port legacy
 * preservation copies, verifies and removes through, and its Node adapter.
 *
 * Every path is workspace-relative segments. Reads and writes go through
 * `openWithinRoot`, so a symlinked component or an escape is refused rather
 * than followed. A write is exclusive (`wx`): it never replaces an existing
 * file, which is what keeps an interrupted quarantine from overwriting either
 * side. Removal proves containment through the shared oracle first and removes
 * only a regular file.
 *
 * Outcomes are bounded values; no host path or raw error leaves this module.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { resolveContainedLink } from '../../lib/path-containment';
import { openWithinRoot, type SafeOpenResult } from '../../lib/safe-open';

export type LegacyReadOutcome =
  | { readonly outcome: 'read'; readonly bytes: Buffer }
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'failed' };

/** `exists`: the destination was already there and was left untouched. */
export type LegacyWriteOutcome = 'written' | 'exists' | 'refused' | 'failed';

export type LegacyUnlinkOutcome = 'removed' | 'absent' | 'refused' | 'failed';

export interface LegacyPreservationFs {
  readBytes(segments: readonly string[]): Promise<LegacyReadOutcome>;
  writeExclusive(segments: readonly string[], bytes: Buffer): Promise<LegacyWriteOutcome>;
  unlinkContained(segments: readonly string[]): Promise<LegacyUnlinkOutcome>;
}

const QUARANTINE_DIR_MODE = 0o700;
const QUARANTINE_FILE_MODE = 0o600;
const MISSING_ERRNOS: readonly string[] = ['ENOENT', 'ENOTDIR'];

type Refused = Extract<SafeOpenResult, { outcome: 'refused' }>;

function errnoOf(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
}

function isMissing(refused: Refused): boolean {
  if (refused.reason === 'not-a-directory') return true;
  return refused.reason === 'io-failed' && MISSING_ERRNOS.includes(refused.errno);
}

async function readAll(root: string, segments: readonly string[]): Promise<LegacyReadOutcome> {
  const opened = await openWithinRoot(root, segments, { flags: 'r' });
  if (opened.outcome === 'refused') return isMissing(opened) ? { outcome: 'absent' } : { outcome: 'failed' };
  try {
    return { outcome: 'read', bytes: await opened.handle.readFile() };
  } catch {
    return { outcome: 'failed' };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

async function writeNew(root: string, segments: readonly string[], bytes: Buffer): Promise<LegacyWriteOutcome> {
  const opened = await openWithinRoot(root, segments, {
    flags: 'wx',
    createDirs: true,
    dirMode: QUARANTINE_DIR_MODE,
    fileMode: QUARANTINE_FILE_MODE
  });
  if (opened.outcome === 'refused') {
    if (opened.reason === 'io-failed' && opened.errno === 'EEXIST') return 'exists';
    return opened.reason === 'io-failed' ? 'failed' : 'refused';
  }
  try {
    await opened.handle.writeFile(bytes);
    await opened.handle.sync();
    return 'written';
  } catch {
    // The file was created and may hold part of the bytes; the caller verifies by digest.
    return 'failed';
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

async function removeContained(root: string, segments: readonly string[]): Promise<LegacyUnlinkOutcome> {
  const verdict = await resolveContainedLink(path.join(root, ...segments), [root]);
  if (verdict.outcome === 'absent') return 'absent';
  if (verdict.outcome === 'refused') return 'refused';
  let isFile: boolean;
  try {
    isFile = (await fsp.lstat(verdict.resolved)).isFile();
  } catch (error) {
    return MISSING_ERRNOS.includes(errnoOf(error)) ? 'absent' : 'failed';
  }
  if (!isFile) return 'refused';
  try {
    // Only the entry proven contained under the workspace root above is removed.
    await fsp.unlink(verdict.resolved);
    return 'removed';
  } catch (error) {
    return MISSING_ERRNOS.includes(errnoOf(error)) ? 'absent' : 'failed';
  }
}

/** The Node adapter, rooted at the workspace folder. */
export function createNodeLegacyPreservationFs(workspaceRoot: string): LegacyPreservationFs {
  return {
    readBytes: (segments) => readAll(workspaceRoot, segments),
    writeExclusive: (segments, bytes) => writeNew(workspaceRoot, segments, bytes),
    unlinkContained: (segments) => removeContained(workspaceRoot, segments)
  };
}
