// FR-R3-069 (feature 152) — the composition check: a workspace arriving with
// its stores symlinked out is refused by the SHIPPED wiring shapes, end to end.
//
// F-01/F-02's finding was not a broken primitive — the judge is correct — but a
// primitive anchored at a root the checkout chooses. These fixtures are the
// acceptance the source plan wrote: `.schegent` symlinked out, then
// `.schegent/catalog` alone, then `.schegent/ownership` — each refuses with no
// directory created, nothing written, nothing read through the link, and an
// election that refuses rather than arbitrates. The in-workspace-link case is
// asserted too, because the refusal is for escapes, not for links per se.
//
// Feature 217 (FR-006) adds the last block: each store narrows its own widened
// directories and nothing above them, whether the store sits where it is named
// or an in-workspace link relocated it, and says what it narrowed (FR-003).
//
// tmp roots are realpath'd before use (macOS `/var` → `/private/var`), matching
// `tests/integration/filesystem-safety/refusal-audit-boundary.test.ts`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createCatalogFsAdapter, CATALOG_DIRECTORY_SEGMENTS } from '../../src/host-services/catalog-fs-adapter';
import { createDiskOwnershipFs } from '../../src/state/ownership-fs';
import { OwnershipRegistry, PRIMACY_RESOURCE } from '../../src/state/ownership-registry';
import { STALENESS_THRESHOLD_MS } from '../../src/state/lock';

const posixOnly = process.platform === 'win32' ? it.skip : it;
const CONTAINMENT_ERRNO = 'ESCHEGENTCONTAINMENT';

let base: string;
let workspaceRoot: string;
let outside: string;

const storeRoot = (): string => path.join(workspaceRoot, ...CATALOG_DIRECTORY_SEGMENTS);
const ownershipDir = (): string => path.join(workspaceRoot, '.schegent', 'ownership');

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-152-anchor-')));
  workspaceRoot = path.join(base, 'ws');
  outside = path.join(base, 'outside');
  await fs.mkdir(workspaceRoot);
  await fs.mkdir(outside);
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe('FR-R3-069 — a symlinked .schegent refuses everything beneath it', () => {
  posixOnly('catalog: no write lands, no read passes, no directory appears behind the link', async () => {
    await fs.symlink(outside, path.join(workspaceRoot, '.schegent'));
    const adapter = createCatalogFsAdapter({ workspaceRoot, storeRoot: storeRoot() });

    expect(await adapter.checkWritability()).toBe('not-writable');
    expect(await adapter.writeFileAtomic(['phases', 'p', 'v1.json'], '{}')).toEqual({
      outcome: 'failed',
      errno: CONTAINMENT_ERRNO
    });
    expect(await adapter.writeFileIfAbsent(['phases', 'p', 'v1.json'], '{}')).toEqual({
      outcome: 'failed',
      errno: CONTAINMENT_ERRNO
    });
    // A definition planted behind the link must not be readable as catalog
    // content: the read refuses rather than returning attacker-chosen bytes.
    await fs.mkdir(path.join(outside, 'catalog', 'phases'), { recursive: true });
    await fs.writeFile(path.join(outside, 'catalog', 'phases', 'planted.json'), '{"evil":true}');
    expect(await adapter.readFile(['phases', 'planted.json'])).toEqual({
      outcome: 'failed',
      errno: CONTAINMENT_ERRNO
    });
    expect(await adapter.listDirectory(['phases'])).toEqual([]);
    // Nothing this test did not plant itself appeared behind the link.
    expect((await fs.readdir(outside)).sort()).toEqual(['catalog']);
  });

  posixOnly('ownership: election refuses rather than arbitrating through the link', async () => {
    await fs.symlink(outside, path.join(workspaceRoot, '.schegent'));
    const registry = new OwnershipRegistry(
      createDiskOwnershipFs({ workspaceRoot, ownershipDir: ownershipDir() }),
      ownershipDir()
    );
    const outcome = await registry.acquire(
      PRIMACY_RESOURCE,
      'window-a',
      Date.now(),
      STALENESS_THRESHOLD_MS
    );
    expect(outcome.outcome).toBe('unavailable');
    expect(await fs.readdir(outside)).toEqual([]);
  });
});

describe('FR-R3-069 — the store directory alone symlinked out refuses the same way', () => {
  posixOnly('.schegent/catalog linked out', async () => {
    await fs.mkdir(path.join(workspaceRoot, '.schegent'));
    await fs.symlink(outside, storeRoot());
    const adapter = createCatalogFsAdapter({ workspaceRoot, storeRoot: storeRoot() });

    expect(await adapter.checkWritability()).toBe('not-writable');
    expect(await adapter.writeFileIfAbsent(['phases', 'p', 'v1.json'], '{}')).toEqual({
      outcome: 'failed',
      errno: CONTAINMENT_ERRNO
    });
    expect(await adapter.listDirectory([])).toEqual([]);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  posixOnly('.schegent/ownership linked out', async () => {
    await fs.mkdir(path.join(workspaceRoot, '.schegent'));
    await fs.symlink(outside, ownershipDir());
    const registry = new OwnershipRegistry(
      createDiskOwnershipFs({ workspaceRoot, ownershipDir: ownershipDir() }),
      ownershipDir()
    );
    const outcome = await registry.acquire(
      PRIMACY_RESOURCE,
      'window-a',
      Date.now(),
      STALENESS_THRESHOLD_MS
    );
    expect(outcome.outcome).toBe('unavailable');
    expect(await fs.readdir(outside)).toEqual([]);
  });
});

describe('FR-R3-069 — an in-workspace link is admitted: the refusal is for escapes', () => {
  posixOnly('catalog through an internal link still writes and reads', async () => {
    const realStore = path.join(workspaceRoot, 'real-catalog');
    await fs.mkdir(realStore);
    await fs.mkdir(path.join(workspaceRoot, '.schegent'));
    await fs.symlink(realStore, storeRoot());
    const adapter = createCatalogFsAdapter({ workspaceRoot, storeRoot: storeRoot() });

    expect(await adapter.checkWritability()).toBe('writable');
    expect(await adapter.writeFileIfAbsent(['phases', 'p', 'v1.json'], '{"ok":true}')).toEqual({
      outcome: 'written'
    });
    expect(await adapter.readFile(['phases', 'p', 'v1.json'])).toEqual({
      outcome: 'read',
      contents: '{"ok":true}'
    });
  });

  posixOnly('election through an internal link elects exactly one owner', async () => {
    const realStore = path.join(workspaceRoot, 'real-ownership');
    await fs.mkdir(realStore);
    await fs.mkdir(path.join(workspaceRoot, '.schegent'));
    await fs.symlink(realStore, ownershipDir());
    const registry = new OwnershipRegistry(
      createDiskOwnershipFs({ workspaceRoot, ownershipDir: ownershipDir() }),
      ownershipDir()
    );
    const outcome = await registry.acquire(
      PRIMACY_RESOURCE,
      'window-a',
      Date.now(),
      STALENESS_THRESHOLD_MS
    );
    expect(outcome.outcome).toBe('acquired');
  });
});

describe('Feature 217 (FR-006) — a store narrows its own widened directories, and nothing above them', () => {
  const PERMISSION_BITS = 0o777;
  const WIDENED = 0o755;
  const OWNER_ONLY = 0o700;

  const modeOf = async (target: string): Promise<number> =>
    (await fs.lstat(target)).mode & PERMISSION_BITS;

  /** Create each directory widened, the way an older release or a clone leaves it. */
  const widenedDirectories = async (...directories: readonly string[]): Promise<void> => {
    for (const directory of directories) {
      await fs.mkdir(directory, { recursive: true });
      await fs.chmod(directory, WIDENED);
    }
  };

  posixOnly('catalog: a write narrows the store directory and each directory down to its file', async () => {
    const schegent = path.join(workspaceRoot, '.schegent');
    const kindDir = path.join(storeRoot(), 'phases');
    const idDir = path.join(kindDir, 'p');
    await widenedDirectories(workspaceRoot, schegent, storeRoot(), kindDir, idDir);
    const adapter = createCatalogFsAdapter({ workspaceRoot, storeRoot: storeRoot() });

    expect(await adapter.writeFileIfAbsent(['phases', 'p', 'v1.json'], '{"ok":true}')).toEqual({
      outcome: 'written'
    });
    expect([await modeOf(storeRoot()), await modeOf(kindDir), await modeOf(idDir)]).toEqual([
      OWNER_ONLY,
      OWNER_ONLY,
      OWNER_ONLY
    ]);
    expect(await modeOf(schegent), 'the directory above the store').toBe(WIDENED);
    expect(await modeOf(workspaceRoot), 'the workspace root').toBe(WIDENED);
  });

  posixOnly('catalog relocated by an in-workspace link: the store is narrowed, the directory above it is not', async () => {
    const project = path.join(workspaceRoot, 'project');
    const realStore = path.join(project, 'real-catalog');
    const kindDir = path.join(realStore, 'phases');
    const idDir = path.join(kindDir, 'p');
    await widenedDirectories(project, realStore, kindDir, idDir);
    await fs.mkdir(path.join(workspaceRoot, '.schegent'));
    await fs.symlink(realStore, storeRoot());
    const adapter = createCatalogFsAdapter({ workspaceRoot, storeRoot: storeRoot() });

    expect(await adapter.writeFileIfAbsent(['phases', 'p', 'v1.json'], '{"ok":true}')).toEqual({
      outcome: 'written'
    });
    expect([await modeOf(realStore), await modeOf(kindDir), await modeOf(idDir)]).toEqual([
      OWNER_ONLY,
      OWNER_ONLY,
      OWNER_ONLY
    ]);
    expect(await modeOf(project)).toBe(WIDENED);
  });

  posixOnly('catalog under a .schegent an in-workspace link relocated: the store is narrowed, the link target is not', async () => {
    const elsewhere = path.join(workspaceRoot, 'elsewhere');
    const realStore = path.join(elsewhere, 'catalog');
    await widenedDirectories(elsewhere, realStore);
    await fs.symlink(elsewhere, path.join(workspaceRoot, '.schegent'));
    const adapter = createCatalogFsAdapter({ workspaceRoot, storeRoot: storeRoot() });

    expect(await adapter.writeFileIfAbsent(['phases', 'p', 'v1.json'], '{"ok":true}')).toEqual({
      outcome: 'written'
    });
    expect(await modeOf(realStore)).toBe(OWNER_ONLY);
    expect(await modeOf(elsewhere), 'the directory standing in for .schegent').toBe(WIDENED);
  });

  posixOnly('catalog: what the store narrowed is said once, path-free, to the logger it was handed (FR-003)', async () => {
    await widenedDirectories(storeRoot());
    const warnings: string[] = [];
    const adapter = createCatalogFsAdapter(
      { workspaceRoot, storeRoot: storeRoot() },
      { warn: (message) => warnings.push(message) }
    );

    for (const version of ['v1.json', 'v2.json']) {
      expect(await adapter.writeFileIfAbsent(['phases', 'p', version], '{}')).toEqual({
        outcome: 'written'
      });
    }
    expect(warnings).toEqual([
      'catalog store: an evidence directory granted access beyond its owner (mode 755); ' +
        'narrowed to owner-only'
    ]);
  });

  // A writing open reaches a file that is already there, and so can find it
  // widened, only when a stale temp file holds the name the write is about to
  // use. Both adapters number their temp files from a module-level counter, so a
  // fresh module's first write uses the token `<pid>.1`.
  const STALE_FILE = 0o644;
  const OWNER_ONLY_FILE = 0o600;
  const staleTempFile = async (directory: string, name: string): Promise<void> => {
    await fs.mkdir(directory, { recursive: true, mode: OWNER_ONLY });
    const stale = path.join(directory, `.${name}.${process.pid}.1.tmp`);
    await fs.writeFile(stale, 'left by a write that never finished');
    await fs.chmod(stale, STALE_FILE);
  };

  posixOnly('catalog: a widened stale temp file the write reuses is narrowed and said (FR-003)', async () => {
    vi.resetModules();
    const fresh = await import('../../src/host-services/catalog-fs-adapter.js');
    const idDir = path.join(storeRoot(), 'phases', 'p');
    await staleTempFile(idDir, 'v1.json');
    const warnings: string[] = [];
    const adapter = fresh.createCatalogFsAdapter(
      { workspaceRoot, storeRoot: storeRoot() },
      { warn: (message) => warnings.push(message) }
    );

    expect(await adapter.writeFileAtomic(['phases', 'p', 'v1.json'], '{}')).toEqual({
      outcome: 'written'
    });
    expect(await modeOf(path.join(idDir, 'v1.json'))).toBe(OWNER_ONLY_FILE);
    expect(warnings).toEqual([
      'catalog store: an evidence file granted access beyond its owner (mode 644); ' +
        'narrowed to owner-only'
    ]);
  });

  posixOnly('ownership: a widened stale temp file the write reuses is narrowed and said (FR-003)', async () => {
    vi.resetModules();
    const fresh = await import('../../src/state/ownership-fs.js');
    await staleTempFile(ownershipDir(), 'primacy.json');
    const warnings: string[] = [];
    const adapter = fresh.createDiskOwnershipFs(
      { workspaceRoot, ownershipDir: ownershipDir() },
      { warn: (message) => warnings.push(message) }
    );

    await adapter.replace(path.join(ownershipDir(), 'primacy.json'), '{}');
    expect(await modeOf(path.join(ownershipDir(), 'primacy.json'))).toBe(OWNER_ONLY_FILE);
    expect(warnings).toEqual([
      'ownership store: an evidence file granted access beyond its owner (mode 644); ' +
        'narrowed to owner-only'
    ]);
  });

  // The report sits between the open and the return of its handle, and both
  // adapters take any `warn`, not only the logger that never throws.
  const throwingWarn = (): never => {
    throw new Error('sink unavailable');
  };

  posixOnly('catalog: a logger that throws on the narrowing line does not cost the write', async () => {
    vi.resetModules();
    const fresh = await import('../../src/host-services/catalog-fs-adapter.js');
    const idDir = path.join(storeRoot(), 'phases', 'p');
    await staleTempFile(idDir, 'v1.json');
    const adapter = fresh.createCatalogFsAdapter(
      { workspaceRoot, storeRoot: storeRoot() },
      { warn: throwingWarn }
    );

    expect(await adapter.writeFileAtomic(['phases', 'p', 'v1.json'], '{}')).toEqual({
      outcome: 'written'
    });
    expect(await fs.readFile(path.join(idDir, 'v1.json'), 'utf8')).toBe('{}');
    expect(await modeOf(path.join(idDir, 'v1.json'))).toBe(OWNER_ONLY_FILE);
  });

  posixOnly('ownership: a logger that throws on the narrowing line does not cost the replace', async () => {
    vi.resetModules();
    const fresh = await import('../../src/state/ownership-fs.js');
    await staleTempFile(ownershipDir(), 'primacy.json');
    const adapter = fresh.createDiskOwnershipFs(
      { workspaceRoot, ownershipDir: ownershipDir() },
      { warn: throwingWarn }
    );

    await adapter.replace(path.join(ownershipDir(), 'primacy.json'), '{}');
    expect(await fs.readFile(path.join(ownershipDir(), 'primacy.json'), 'utf8')).toBe('{}');
    expect(await modeOf(path.join(ownershipDir(), 'primacy.json'))).toBe(OWNER_ONLY_FILE);
  });

  posixOnly('ownership: preparing the store narrows a widened store directory', async () => {
    const schegent = path.join(workspaceRoot, '.schegent');
    await widenedDirectories(workspaceRoot, schegent, ownershipDir());
    const adapter = createDiskOwnershipFs({ workspaceRoot, ownershipDir: ownershipDir() });

    await adapter.ensureDir(ownershipDir());
    expect(await modeOf(ownershipDir())).toBe(OWNER_ONLY);
    expect(await modeOf(schegent), 'the directory above the store').toBe(WIDENED);
    expect(await modeOf(workspaceRoot), 'the workspace root').toBe(WIDENED);
  });

  posixOnly('ownership: what the store narrowed is said once, path-free, to the logger it was handed (FR-003)', async () => {
    await widenedDirectories(ownershipDir());
    const warnings: string[] = [];
    const adapter = createDiskOwnershipFs(
      { workspaceRoot, ownershipDir: ownershipDir() },
      { warn: (message) => warnings.push(message) }
    );

    await adapter.ensureDir(ownershipDir());
    // Widened again: the same thing found twice is still said once.
    await fs.chmod(ownershipDir(), WIDENED);
    await adapter.ensureDir(ownershipDir());

    expect(await modeOf(ownershipDir())).toBe(OWNER_ONLY);
    expect(warnings).toEqual([
      'ownership store: an evidence directory granted access beyond its owner (mode 755); ' +
        'narrowed to owner-only'
    ]);
  });

  posixOnly('ownership relocated by an in-workspace link: the store is narrowed, the directory above it is not', async () => {
    const project = path.join(workspaceRoot, 'project');
    const realStore = path.join(project, 'real-ownership');
    await widenedDirectories(project, realStore);
    await fs.mkdir(path.join(workspaceRoot, '.schegent'));
    await fs.symlink(realStore, ownershipDir());
    const registry = new OwnershipRegistry(
      createDiskOwnershipFs({ workspaceRoot, ownershipDir: ownershipDir() }),
      ownershipDir()
    );

    const outcome = await registry.acquire(
      PRIMACY_RESOURCE,
      'window-a',
      Date.now(),
      STALENESS_THRESHOLD_MS
    );
    expect(outcome.outcome).toBe('acquired');
    expect(await modeOf(realStore)).toBe(OWNER_ONLY);
    expect(await modeOf(project)).toBe(WIDENED);
  });
});
