import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureSchegentGitignore } from '../../../src/audit/schegent-gitignore';
import { SanitizedLogger } from '../../../src/lib/logger';

/**
 * Feature 217 (FR-003) — the ignore-file drop hands back what its walk narrowed.
 *
 * It runs before the first write of three writers and before the mount probe's
 * exclusive create, so on a fresh but widened `.schegent/` it is the open that
 * narrows the directory. It names no sink of its own: each caller reports the
 * notices through its own subject, so the operator reads the writer they know
 * rather than a helper. Returning nothing meant the narrowing happened and
 * nobody was told.
 */

/** POSIX-only: `mode` is not an enforceable concept on Windows. */
const posixOnly = process.platform === 'win32' ? it.skip : it;
/** What umask 022 leaves a directory at. */
const WIDENED_DIR = 0o755;

let base: string;
let workspaceRoot: string;

const modeOf = async (p: string): Promise<number> => (await fs.lstat(p)).mode & 0o777;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-gitignore-'));
  workspaceRoot = path.join(base, 'workspace');
  await fs.mkdir(workspaceRoot);
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe('ensureSchegentGitignore — what the drop narrowed (feature 217)', () => {
  posixOnly('returns the narrowing of the widened directory it drops the ignore file in', async () => {
    const schegent = path.join(workspaceRoot, '.schegent');
    await fs.mkdir(schegent);
    await fs.chmod(schegent, WIDENED_DIR);

    const notices = await ensureSchegentGitignore(workspaceRoot, new SanitizedLogger());

    expect(notices).toEqual([{ scope: 'directory', outcome: 'narrowed', previousMode: WIDENED_DIR }]);
    expect(await modeOf(schegent)).toBe(0o700);
    expect(await modeOf(path.join(schegent, '.gitignore'))).toBe(0o600);
  });

  posixOnly('returns nothing and narrows nothing when an ignore file is already there', async () => {
    // EEXIST is the ordinary case on every run after the first, and an
    // operator-managed file wins. A refused `wx` open reaches no mode at all.
    const schegent = path.join(workspaceRoot, '.schegent');
    const operatorFile = path.join(schegent, '.gitignore');
    await fs.mkdir(schegent);
    await fs.writeFile(operatorFile, '# operator\n');
    await fs.chmod(schegent, WIDENED_DIR);

    const notices = await ensureSchegentGitignore(workspaceRoot, new SanitizedLogger());

    expect(notices).toEqual([]);
    expect(await modeOf(schegent)).toBe(WIDENED_DIR);
    expect(await fs.readFile(operatorFile, 'utf8')).toBe('# operator\n');
  });

  posixOnly('returns nothing when the walk is refused', async () => {
    const outside = path.join(base, 'outside');
    await fs.mkdir(outside);
    await fs.chmod(outside, WIDENED_DIR);
    await fs.symlink(outside, path.join(workspaceRoot, '.schegent'), 'dir');

    const notices = await ensureSchegentGitignore(workspaceRoot, new SanitizedLogger());

    expect(notices).toEqual([]);
    expect(await modeOf(outside), 'the link target is untouched').toBe(WIDENED_DIR);
    expect(await fs.readdir(outside)).toEqual([]);
  });
});
