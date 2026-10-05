// Feature 217 (FR-003) — a narrowing that walks a chain of directories stops at
// the first one it finds to be a symbolic link.
//
// `narrowMode` refuses a path whose LAST component is a link, but every path
// below a refused directory resolves through it. A walk that carried on after
// the refusal would aim each later `chmod` at whatever the link points to, which
// is the act FR-003 forbids, reached one component further down.
//
// The swap has to land between the walk that proved each component and the
// narrowing that follows it, a window no real-filesystem fixture can hit on
// demand. So the one seam is a hook run just before `narrowMode` acts on a chosen
// directory: it moves that directory aside and leaves a link to a decoy in its
// place. The narrowing itself is the real routine, and every mode is read back
// from disk.
//
// tmp roots are realpath'd before use (macOS `/var` → `/private/var`), matching
// `tests/integration/store-anchor-containment.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { CATALOG_DIRECTORY_SEGMENTS, createCatalogFsAdapter } from '../../src/host-services/catalog-fs-adapter';
import { openWithinRoot } from '../../src/lib/safe-open';

const seam = vi.hoisted(() => ({
  /** Run before `narrowMode` acts on a path; `null` leaves the routine untouched. */
  beforeNarrow: null as null | ((pathname: string) => Promise<void>)
}));

vi.mock('../../src/lib/narrow-mode', async () => {
  const real = await vi.importActual<typeof import('../../src/lib/narrow-mode')>(
    '../../src/lib/narrow-mode'
  );
  return {
    ...real,
    narrowMode: async (pathname: string, desired: number) => {
      if (seam.beforeNarrow !== null) await seam.beforeNarrow(pathname);
      return real.narrowMode(pathname, desired);
    }
  };
});

const posixOnly = process.platform === 'win32' ? it.skip : it;

const PERMISSION_BITS = 0o777;
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;
const WIDENED_FILE = 0o644;
const WIDENED_DIR = 0o755;

let base: string;
let workspaceRoot: string;
let outside: string;
let swapped: boolean;

const modeOf = async (target: string): Promise<number> =>
  (await fs.lstat(target)).mode & PERMISSION_BITS;

/** Each directory created and widened explicitly, so the fixture does not depend on the umask. */
const widenedDirectories = async (...directories: readonly string[]): Promise<void> => {
  for (const directory of directories) {
    await fs.mkdir(directory, { recursive: true });
    await fs.chmod(directory, WIDENED_DIR);
  }
};

const widenedFile = async (file: string): Promise<void> => {
  await fs.writeFile(file, '');
  await fs.chmod(file, WIDENED_FILE);
};

/** The first time `narrowMode` is aimed at `directory`, put a link to `decoy` there instead. */
const swapForLinkBeforeNarrowing = (directory: string, decoy: string): void => {
  seam.beforeNarrow = async (pathname) => {
    if (swapped || pathname !== directory) return;
    swapped = true;
    await fs.rename(directory, `${directory}.moved`);
    await fs.symlink(decoy, directory);
  };
};

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-217-link-stop-')));
  workspaceRoot = path.join(base, 'ws');
  outside = path.join(base, 'outside');
  await fs.mkdir(workspaceRoot);
  await fs.mkdir(outside);
  swapped = false;
});

afterEach(async () => {
  seam.beforeNarrow = null;
  await fs.rm(base, { recursive: true, force: true });
});

describe('Feature 217 (FR-003) — narrowing stops at the first directory found to be a link', () => {
  posixOnly('openWithinRoot: nothing below the link is narrowed, the leaf included', async () => {
    const schegent = path.join(workspaceRoot, '.schegent');
    const sessions = path.join(schegent, 'sessions');
    await widenedDirectories(schegent, sessions);
    await widenedFile(path.join(sessions, 'audit.log'));
    // The decoy mirrors the layout, so every path below the link resolves to a
    // real entry in it rather than failing on a missing one.
    const decoy = path.join(outside, 'decoy');
    await widenedDirectories(decoy, path.join(decoy, 'sessions'));
    await widenedFile(path.join(decoy, 'sessions', 'audit.log'));
    swapForLinkBeforeNarrowing(schegent, decoy);

    const result = await openWithinRoot(workspaceRoot, ['.schegent', 'sessions', 'audit.log'], {
      flags: 'a',
      createDirs: true,
      dirMode: OWNER_ONLY_DIR,
      fileMode: OWNER_ONLY_FILE
    });
    expect(result.outcome).toBe('opened');
    if (result.outcome !== 'opened') return;
    await result.handle.close();

    expect(swapped, 'the link was swapped in before the narrowing').toBe(true);
    expect(result.narrowing).toEqual([{ scope: 'directory', outcome: 'refused-symlink' }]);
    expect(await modeOf(decoy)).toBe(WIDENED_DIR);
    expect(await modeOf(path.join(decoy, 'sessions'))).toBe(WIDENED_DIR);
    expect(await modeOf(path.join(decoy, 'sessions', 'audit.log'))).toBe(WIDENED_FILE);
  });

  posixOnly('catalog store: nothing below the link is narrowed and nothing is written through it', async () => {
    const store = path.join(workspaceRoot, ...CATALOG_DIRECTORY_SEGMENTS);
    const kindDir = path.join(store, 'phases');
    await widenedDirectories(store, kindDir, path.join(kindDir, 'p'));
    const decoy = path.join(outside, 'decoy');
    await widenedDirectories(decoy, path.join(decoy, 'p'));
    swapForLinkBeforeNarrowing(kindDir, decoy);
    const adapter = createCatalogFsAdapter({ workspaceRoot, storeRoot: store });

    expect(await adapter.writeFileIfAbsent(['phases', 'p', 'v1.json'], '{}')).toEqual({
      outcome: 'failed',
      errno: 'ESCHEGENTCONTAINMENT'
    });

    expect(swapped, 'the link was swapped in before the narrowing').toBe(true);
    expect(await modeOf(decoy)).toBe(WIDENED_DIR);
    expect(await modeOf(path.join(decoy, 'p'))).toBe(WIDENED_DIR);
    expect(await fs.readdir(path.join(decoy, 'p'))).toEqual([]);
  });
});
