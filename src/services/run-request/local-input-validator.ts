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
//     **FR-R3-080 (2026-08-26) — that closed the LEAF and nothing above it.**
//     `resolveWithinWorkspace` is purely lexical, and `O_NOFOLLOW` guards only
//     the final component, so a symlinked ANCESTOR inside the workspace pointing
//     outside it satisfied the check and was never looked at: the verdict came
//     back usable for a path that is not in the workspace. The repro is filed
//     with the envelope's bug records in `docs/features/bugs/`, under
//     `local-input-validator-ancestor-symlink` — named rather than linked,
//     because that tree is outside this repository and a repo-relative path to
//     it is a dangling reference by construction (the practice
//     `services/guarded-run-service.ts` already follows).
//
//     Both entry points now go through `lib/safe-open.ts`'s component walk,
//     which `lstat`s every component and refuses a link at any depth — and which
//     carries FR-R3-083's Windows reparse check with it. The lexical check
//     stays and stays FIRST: `resolveRunOutputs` establishes that a path is
//     judged lexically before any syscall touches it, so an uncontained
//     candidate is refused without a filesystem read at an operator-supplied
//     location.
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
import {
  openWithinRootByPath,
  segmentsUnderRoot,
  walkDirectoriesWithinRoot,
  type SafeOpenRefusal
} from '../../lib/safe-open';

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

// The local `O_NOFOLLOW` constant went with the migration: `lib/safe-open.ts`
// owns that decision now, including the Windows branch FR-R3-083 added, and a
// second copy of a platform constant is a second place for it to drift.

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
  // Through the walk, which proves every component and opens the leaf. The
  // handle is closed immediately: this answers "is this reference usable?", and
  // reading a file the composer only needs to reference would be work done for
  // nothing.
  const opened = await openWithinRootByPath(workspaceRoot, absolutePath, { flags: 'r' });
  if (opened.outcome === 'refused') return refusalFor(opened.reason, opened.errno);
  try {
    const stat = await opened.handle.stat();
    // The walk guarantees a regular file at the leaf, so this is the narrower
    // question the caller asked: a directory supplied where a file was named.
    if (!stat.isFile()) return refuse('file-not-found');
    return OK;
  } catch {
    return refuse('file-unreadable');
  } finally {
    await opened.handle.close().catch(() => undefined);
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

  // FR-R3-080 — prove the chain from the workspace root DOWN to the walk root
  // before walking it. The `lstat` below refuses a symlinked walk root and the
  // loop refuses a symlinked entry, but neither could see a link one level up:
  // `lstat` follows it and reports a real directory.
  const segments = segmentsUnderRoot(workspaceRoot, contained.absolutePath);
  if (segments === null) return refuse('path-escapes-workspace');
  const walked = await walkDirectoriesWithinRoot(workspaceRoot, segments);
  if (walked.outcome === 'refused') return refusalFor(walked.reason, walked.errno);

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

/**
 * Translate a `SafeOpenRefusal` into this module's closed code set.
 *
 * One site, so the mapping is stated once. A link at ANY depth is
 * `symlink-limit-exceeded` — the code this module already used for the leaf, and
 * the one FR-016 names — because to a caller the finding is the same: the
 * reference reaches outside the workspace through a link. `reparse-point-leaf`
 * is the Windows form of exactly that (FR-R3-083) — reachable only where the
 * platform has no `O_NOFOLLOW`, and covering the reparse ATTRIBUTE rather than
 * the tag, which needs a native call declined on the record in
 * `docs/architecture/native-binding-decision.md`.
 *
 * `escapes-root` cannot be reached here — `resolveWithinWorkspace` refused first
 * — but it is mapped rather than defaulted, so a future caller that skips the
 * lexical check does not land on `file-unreadable` for a containment refusal.
 */
function refusalFor(reason: SafeOpenRefusal, errno?: string): LocalCheckResult {
  switch (reason) {
    case 'symlink-component':
    case 'symlink-leaf':
    case 'reparse-point-leaf':
      return refuse('symlink-limit-exceeded');
    case 'escapes-root':
      return refuse('path-escapes-workspace');
    case 'not-a-directory':
    case 'not-a-regular-file':
      return refuse('file-not-found');
    case 'io-failed':
      // The ERRNO decides, not the reason. The walk reports a missing component
      // and an unreadable one under the same `io-failed`, and collapsing them
      // told an operator their `chmod 000` file did not exist. Caught by the
      // suite's pre-existing "refuses a file that cannot be read" case, which is
      // what that case is for.
      return refuse(errno === 'ENOENT' || errno === 'ENOTDIR' ? 'file-not-found' : 'file-unreadable');
  }
}

async function lstatOrNull(target: string) {
  try {
    return await fs.lstat(target);
  } catch {
    return null;
  }
}
