// Feature 087 (T022, T024, US5) — local file and folder references.
//
// Two established idioms, applied unchanged:
//
//   * **TOCTOU-closed reads** (plan D5, after `phase-sidecar-reader.ts`):
//     `fs.open(path, O_RDONLY | O_NOFOLLOW)` makes the kernel reject a
//     final-component symlink atomically, `handle.stat()` binds to the FD
//     rather than the path, and an `lstat` after the open covers Windows, where
//     `O_NOFOLLOW` does not exist. There is no check-then-act window to race.
//
//   * **Bounds enforced during the walk** (research §5, the ingestion-bomb
//     pattern): count, bytes, and extension are checked as each entry is
//     reached and the walk aborts on the first breach. Measuring the whole tree
//     and then deciding is itself the denial of service the bound exists to
//     prevent.
//
// These functions answer a closed question — is this reference usable? — and
// return a code plus, where FR-017 requires it, the limit and the actual. They
// produce no prose: a message that named the resolved absolute path would leak
// it to the webview (FR-020), so message wording lives with the caller.
//
// The 500 / 5 MiB / extension values are guard rails against accidental bulk
// ingestion, established by this feature. They are not the security boundary —
// the workspace root and the symlink rules are.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RunRequestErrorCode } from '../../contracts/run-request';
import { resolveWithinWorkspace } from './workspace-containment';

export const FOLDER_MAX_FILES = 500;
export const FOLDER_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Text-like extensions an operator may hand to a Phase as context.
 *
 * Lower-case; comparison lower-cases the candidate. The list is deliberately
 * short of two things: binary/archive formats, which are not context a Phase can
 * read, and `.env`, which is text but is the file most likely to carry secrets
 * into a prompt. An extension-less file (`Makefile`, `LICENSE`) is outside the
 * list by construction — the allowlist is positive, so anything unnamed is out.
 */
export const ALLOWED_TEXT_EXTENSIONS = [
  '.md',
  '.markdown',
  '.txt',
  '.rst',
  '.adoc',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.properties',
  '.csv',
  '.tsv',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.svelte',
  '.vue',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.cs',
  '.swift',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.sql',
  '.graphql',
  '.proto',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.less',
  '.xml'
] as const;

export type LocalCheckResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: RunRequestErrorCode;
      readonly limit?: number;
      readonly actual?: number;
    };

export interface FolderWalkOptions {
  /**
   * Called once per directory entry the walk inspects. Exists so a test can
   * assert the walk aborts on first breach rather than costing a full traversal
   * — the property research §5 requires and that a result value cannot show.
   */
  readonly onEntry?: () => void;
}

const OK: LocalCheckResult = { ok: true };

function refuse(code: RunRequestErrorCode, bounds?: { limit: number; actual: number }): LocalCheckResult {
  return bounds === undefined ? { ok: false, code } : { ok: false, code, ...bounds };
}

/**
 * `O_NOFOLLOW` is POSIX. On Windows it is absent, so OR with `0` (identity) and
 * rely on the `lstat` after the open plus Windows' own symlink-creation ACL.
 */
const NOFOLLOW: number = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

function codeOf(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

/** ELOOP and EMLINK are what the kernel reports for both refusals FR-016 covers. */
function isSymlinkRefusal(err: unknown): boolean {
  const code = codeOf(err);
  return code === 'ELOOP' || code === 'EMLINK';
}

function isAbsent(err: unknown): boolean {
  const code = codeOf(err);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function hasAllowedExtension(name: string): boolean {
  const extension = path.extname(name).toLowerCase();
  return (ALLOWED_TEXT_EXTENSIONS as readonly string[]).includes(extension);
}

/**
 * Check that `candidate` names a readable regular file inside `workspaceRoot`.
 *
 * The file is opened but not read: a successful `O_RDONLY` open is what proves
 * readability, and reading a file the composer only needs to reference would be
 * work done for nothing.
 */
export async function checkLocalFile(
  workspaceRoot: string,
  candidate: string
): Promise<LocalCheckResult> {
  const contained = resolveWithinWorkspace(workspaceRoot, candidate);
  if (!contained.ok) return refuse('path-escapes-workspace');

  const absolutePath = contained.absolutePath;
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(absolutePath, fs.constants.O_RDONLY | NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) return refuse('file-not-found');
    const afterOpen = await fs.lstat(absolutePath);
    if (afterOpen.isSymbolicLink()) return refuse('symlink-limit-exceeded');
    return OK;
  } catch (err) {
    if (isSymlinkRefusal(err)) return refuse('symlink-limit-exceeded');
    if (isAbsent(err)) return refuse('file-not-found');
    return refuse('file-unreadable');
  } finally {
    await handle?.close();
  }
}

/**
 * Check that `candidate` names a folder inside `workspaceRoot` whose contents
 * stay within every FR-017 bound.
 *
 * The traversal is iterative rather than recursive: a deep tree would otherwise
 * bound the check by the call stack instead of by the limits.
 */
export async function checkLocalFolder(
  workspaceRoot: string,
  candidate: string,
  options: FolderWalkOptions = {}
): Promise<LocalCheckResult> {
  const contained = resolveWithinWorkspace(workspaceRoot, candidate);
  if (!contained.ok) return refuse('path-escapes-workspace');

  const rootStat = await lstatOrNull(contained.absolutePath);
  if (rootStat === null) return refuse('file-not-found');
  if (rootStat.isSymbolicLink()) return refuse('symlink-limit-exceeded');
  if (!rootStat.isDirectory()) return refuse('file-not-found');

  const pending: string[] = [contained.absolutePath];
  let files = 0;
  let bytes = 0;

  while (pending.length > 0) {
    const directory = pending.pop() as string;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (err) {
      if (isSymlinkRefusal(err)) return refuse('symlink-limit-exceeded');
      return refuse(isAbsent(err) ? 'file-not-found' : 'file-unreadable');
    }

    for (const entry of entries) {
      options.onEntry?.();

      // `readdir` reports link-ness with `lstat` semantics, so this catches a
      // symlink before anything follows it — including one whose target sits
      // outside the workspace, which the lexical containment check on the
      // folder itself cannot see.
      if (entry.isSymbolicLink()) return refuse('symlink-limit-exceeded');

      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) return refuse('file-unreadable');

      files += 1;
      if (files > FOLDER_MAX_FILES) {
        return refuse('folder-file-count-exceeded', { limit: FOLDER_MAX_FILES, actual: files });
      }
      if (!hasAllowedExtension(entry.name)) return refuse('folder-extension-not-allowed');

      const stat = await lstatOrNull(entryPath);
      if (stat === null) return refuse('file-not-found');
      bytes += stat.size;
      if (bytes > FOLDER_MAX_BYTES) {
        return refuse('folder-bytes-exceeded', { limit: FOLDER_MAX_BYTES, actual: bytes });
      }
    }
  }

  return OK;
}

async function lstatOrNull(target: string) {
  try {
    return await fs.lstat(target);
  } catch {
    return null;
  }
}
