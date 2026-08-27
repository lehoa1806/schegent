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
// tmp roots are realpath'd before use (macOS `/var` → `/private/var`), matching
// `tests/integration/filesystem-safety/refusal-audit-boundary.test.ts`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
