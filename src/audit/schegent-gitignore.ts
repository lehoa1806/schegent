import type { SanitizedLogger } from '../lib/logger';
import type { NarrowingNotice } from '../lib/narrow-mode';
import { openWithinRoot } from '../lib/safe-open';

/** The body every writer drops, and the one a non-conforming existing file is replaced with. */
export const SCHEGENT_GITIGNORE_BODY = [
  '# Schegent runtime artifacts are local-only.',
  '# This directory can contain unredacted transcripts and diagnostics.',
  '*',
  ''
].join('\n');

const SCHEGENT_DIR_NAME = '.schegent';
const GITIGNORE_NAME = '.gitignore';
const GITIGNORE_SEGMENTS = [SCHEGENT_DIR_NAME, GITIGNORE_NAME] as const;
/** Larger than any hand-written ignore file; a larger one is not judged, it is replaced. */
const MAX_JUDGED_BYTES = 64 * 1024;
/** Patterns that, on their own line, ignore every path below the file's directory. */
const IGNORE_ALL_PATTERNS: ReadonlySet<string> = new Set(['*', '/*', '**', '/**']);
const REPAIR_WARNING = 'schegent gitignore repaired: the existing file did not ignore every path';

/**
 * Best-effort self-ignore for the workspace-local runtime directory.
 *
 * Repository-level `.gitignore` coverage only protects checkouts that already
 * include Schegent's ignore rule. Installed extension users may run against an
 * arbitrary workspace, so every writer that creates `.schegent/` also drops a
 * local `.schegent/.gitignore` that ignores the directory's contents.
 *
 * An existing file wins only while it still ignores every path: a line that is
 * one of {@link IGNORE_ALL_PATTERNS} and no `!` negation. Review gap GC-12
 * (2026-11-12): a repository can commit this file, every later run finds it,
 * and one that ignored nothing let transcripts and the audit log be committed.
 * Anything else, or a file too large to judge, is replaced with
 * {@link SCHEGENT_GITIGNORE_BODY} and the repair is warned once per writer.
 *
 * Feature 217 (FR-003) — returns what the walk narrowed, for the caller to
 * report through its own reporter. The drop runs before a writer's first open,
 * so on a fresh but widened `.schegent/` it is this open that narrows it, and
 * the operator should read that from the writer they know rather than from a
 * helper with no sink of its own. `[]` when the file is already there or the
 * open was refused: neither reaches a mode.
 */
export async function ensureSchegentGitignore(
  workspaceRoot: string,
  logger: SanitizedLogger
): Promise<readonly NarrowingNotice[]> {
  // FR-R3-053 (H-02) — through the safe walk, not `mkdir -p` + `writeFile`.
  // This function runs BEFORE the first audit append, so when `.schegent` was a
  // symlink it was this call that created the escape: the append was then merely
  // the second file written outside the workspace. Fixing only the append left
  // `.gitignore` landing there, which the containment test caught.
  const opened = await openWithinRoot(workspaceRoot, GITIGNORE_SEGMENTS, {
    flags: 'wx',
    createDirs: true,
    dirMode: 0o700,
    fileMode: 0o600
  });
  if (opened.outcome === 'refused') {
    // EEXIST is the normal case on every run after the first: the file is
    // already there, and a conforming one wins. Not a warning.
    if (opened.errno === 'EEXIST') return repairIfNonConforming(workspaceRoot, logger);
    logger.warn('schegent gitignore ensure refused', {
      reason: opened.reason,
      errno: opened.errno
    });
    return [];
  }
  try {
    await opened.handle.write(SCHEGENT_GITIGNORE_BODY, null, 'utf8');
  } catch (err) {
    logger.warn(`schegent gitignore ensure failed: ${(err as Error).message}`);
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
  return opened.narrowing;
}

/** Whether `text` ignores every path: an ignore-all line and no negation. */
export function ignoresEveryPath(text: string): boolean {
  let ignoresAll = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith('!')) return false;
    if (IGNORE_ALL_PATTERNS.has(line)) ignoresAll = true;
  }
  return ignoresAll;
}

/** The existing file's text, `null` when it is too large to judge, or the refusal. */
async function readExisting(
  workspaceRoot: string
): Promise<{ readonly text: string | null } | { readonly refused: string; readonly errno: string }> {
  const opened = await openWithinRoot(workspaceRoot, GITIGNORE_SEGMENTS, { flags: 'r' });
  if (opened.outcome === 'refused') return { refused: opened.reason, errno: opened.errno };
  try {
    const buffer = Buffer.alloc(MAX_JUDGED_BYTES + 1);
    const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, 0);
    return { text: bytesRead > MAX_JUDGED_BYTES ? null : buffer.toString('utf8', 0, bytesRead) };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

async function repairIfNonConforming(
  workspaceRoot: string,
  logger: SanitizedLogger
): Promise<readonly NarrowingNotice[]> {
  const existing = await readExisting(workspaceRoot);
  if ('refused' in existing) {
    logger.warn('schegent gitignore ensure refused', { reason: existing.refused, errno: existing.errno });
    return [];
  }
  if (existing.text !== null && ignoresEveryPath(existing.text)) return [];

  const opened = await openWithinRoot(workspaceRoot, GITIGNORE_SEGMENTS, {
    flags: 'w',
    createDirs: true,
    dirMode: 0o700,
    fileMode: 0o600
  });
  if (opened.outcome === 'refused') {
    logger.warn('schegent gitignore ensure refused', { reason: opened.reason, errno: opened.errno });
    return [];
  }
  try {
    await opened.handle.write(SCHEGENT_GITIGNORE_BODY, null, 'utf8');
    logger.warn(REPAIR_WARNING);
  } catch (err) {
    logger.warn('schegent gitignore repair failed', { error: err instanceof Error ? err.name : typeof err });
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
  return opened.narrowing;
}
