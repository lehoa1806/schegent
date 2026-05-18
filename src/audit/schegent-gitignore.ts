import * as fs from 'fs/promises';
import * as path from 'path';
import type { SanitizedLogger } from '../lib/logger';

const GITIGNORE_BODY = [
  '# Schegent runtime artifacts are local-only.',
  '# This directory can contain unredacted transcripts and diagnostics.',
  '*',
  ''
].join('\n');

/**
 * Best-effort self-ignore for the workspace-local runtime directory.
 *
 * Repository-level `.gitignore` coverage only protects checkouts that already
 * include Schegent's ignore rule. Installed extension users may run against an
 * arbitrary workspace, so every writer that creates `.schegent/` also drops a
 * local `.schegent/.gitignore` that ignores the directory's contents.
 *
 * Existing files are never overwritten: an operator-managed ignore file wins.
 */
export async function ensureSchegentGitignore(
  workspaceRoot: string,
  logger: SanitizedLogger
): Promise<void> {
  const dir = path.join(workspaceRoot, '.schegent');
  const target = path.join(dir, '.gitignore');
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(target, GITIGNORE_BODY, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return;
    logger.warn(`schegent gitignore ensure failed: ${(err as Error).message}`);
  }
}
