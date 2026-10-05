import type { SanitizedLogger } from '../lib/logger';
import type { NarrowingNotice } from '../lib/narrow-mode';
import { openWithinRoot } from '../lib/safe-open';

const GITIGNORE_BODY = [
  '# Schegent runtime artifacts are local-only.',
  '# This directory can contain unredacted transcripts and diagnostics.',
  '*',
  ''
].join('\n');

const SCHEGENT_DIR_NAME = '.schegent';
const GITIGNORE_NAME = '.gitignore';

/**
 * Best-effort self-ignore for the workspace-local runtime directory.
 *
 * Repository-level `.gitignore` coverage only protects checkouts that already
 * include Schegent's ignore rule. Installed extension users may run against an
 * arbitrary workspace, so every writer that creates `.schegent/` also drops a
 * local `.schegent/.gitignore` that ignores the directory's contents.
 *
 * Existing files are never overwritten: an operator-managed ignore file wins.
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
  const opened = await openWithinRoot(workspaceRoot, [SCHEGENT_DIR_NAME, GITIGNORE_NAME], {
    flags: 'wx',
    createDirs: true,
    dirMode: 0o700,
    fileMode: 0o600
  });
  if (opened.outcome === 'refused') {
    // EEXIST is the normal case on every run after the first: the file is
    // already there and an operator-managed one wins. Not a warning.
    if (opened.errno === 'EEXIST') return [];
    logger.warn('schegent gitignore ensure refused', {
      reason: opened.reason,
      errno: opened.errno
    });
    return [];
  }
  try {
    await opened.handle.write(GITIGNORE_BODY, null, 'utf8');
  } catch (err) {
    logger.warn(`schegent gitignore ensure failed: ${(err as Error).message}`);
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
  return opened.narrowing;
}
