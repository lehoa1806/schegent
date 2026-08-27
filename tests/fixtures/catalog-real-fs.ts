// Feature 099 (FR-R3-015) — the catalog store over a real filesystem.
//
// The memory fixture next door (`catalog-memory-fs.ts`) is where the version
// algebra, the integrity findings, and the retention exemptions are asserted. It
// can inject an `EIO` and it can corrupt a file between two calls, which a real
// disk will not do on request. What it cannot say anything about is the handful
// of claims that are only true of a real filesystem:
//
//   - **Directories are created lazily**, so a workspace that never saves ends up
//     with nothing on disk at all — not an empty store, no store (FR-001a, SC-018).
//     A fake fs has no directories to not create.
//   - **`flag: 'wx'` is arbitrated by the kernel**, so two windows racing on one
//     version id produce exactly one write and one `EEXIST` (FR-030). A fake
//     enforces write-once by checking a Map, which is the race, not the guard.
//   - **Containment is resolved through `realpath`**, so a symlink pointing out of
//     the store is refused rather than followed (FR-061). Only a real filesystem
//     has symlinks.
//   - **Temp-plus-rename leaves no debris**, which is a claim about what is on
//     disk after the fact (FR-024).
//
// So these suites use the shipped adapter, the shipped digest, and the shipped
// clock, over a `mkdtemp` workspace — the same four ports `createHostCatalogStore`
// builds, with only the workspace root swapped for a temporary one.

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, sep } from 'node:path';

import { nodeDigest, systemClock } from '../../src/activation/catalog-store-wiring';
import { createCatalogStore, createQueueRunProvenance, type CatalogStore } from '../../src/catalog';
import type { RunProvenance } from '../../src/catalog';
import { draftTokenOf, type ExpectedDraftVersion } from '../../src/contracts/catalog-lifecycle';
import type { CatalogKind, LifecycleWriteOutcome } from '../../src/contracts/catalog-store';
import { CATALOG_DIRECTORY_SEGMENTS, createCatalogFsAdapter } from '../../src/host-services/catalog-fs-adapter';

/** Everything under the workspace root, relative and sorted. */
export interface Tree {
  readonly files: readonly string[];
  readonly directories: readonly string[];
}

/** Content and metadata of every file, for "nothing was written" assertions. */
export type Fingerprint = ReadonlyMap<string, string>;

/** A fresh empty workspace directory. Nothing inside it — not even `.schegent/`. */
export async function createWorkspace(label: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), `schegent-099-${label}-`));
}

export async function removeWorkspace(workspaceRoot: string): Promise<void> {
  await rm(workspaceRoot, { recursive: true, force: true });
}

/** Where the adapter puts the store, as the host computes it. */
export function storeRootOf(workspaceRoot: string): string {
  return join(workspaceRoot, ...CATALOG_DIRECTORY_SEGMENTS);
}

/**
 * The shipped provenance reader over a host with nothing running.
 *
 * Feature 102 (T050) — this replaces the `false`-for-everything module feature
 * 099 shipped, and it is the real reader rather than a second stub: a fixture
 * that doubles the port proves nothing about the code that answers in
 * production, and "no live run" is a state the real reader has to handle anyway.
 */
function noLiveRuns() {
  return createQueueRunProvenance(() => []);
}

/**
 * One window onto the store at `workspaceRoot`.
 *
 * Call it twice with the same root to get two independent windows — which is
 * what the concurrency suite is about, and what makes a "read it back" assertion
 * a claim about the disk rather than about a cache.
 */
export function openStore(
  workspaceRoot: string,
  options: { readonly provenance?: RunProvenance } = {}
): CatalogStore {
  return createCatalogStore({
    fs: createCatalogFsAdapter({ workspaceRoot, storeRoot: storeRootOf(workspaceRoot) }),
    clock: systemClock,
    digest: nodeDigest,
    provenance: options.provenance ?? noLiveRuns()
  });
}

/** The store the host builds when no workspace folder is open (FR-033a). */
export function openStoreWithoutWorkspace(): CatalogStore {
  return createCatalogStore({
    fs: createCatalogFsAdapter(null),
    clock: systemClock,
    digest: nodeDigest,
    provenance: noLiveRuns()
  });
}

/**
 * The draft token this window would present on its next write (FR-012).
 *
 * Read out of the store every time rather than remembered from the caller's own
 * last write, because that is what a window actually does — the token is a fact
 * about the manifest on disk. A helper that cached it would stop noticing the other
 * window, which is the entire subject of the concurrency suite.
 */
export async function draftTokenFor(
  store: CatalogStore,
  kind: CatalogKind,
  id: string
): Promise<ExpectedDraftVersion> {
  const result = await store.read();
  if (result.outcome !== 'read') throw new Error(`store unreadable: ${result.fault.fault}`);
  const found = result.snapshot.definitions.find(
    (definition) => definition.kind === kind && definition.id === id
  );
  return draftTokenOf(found?.draftVersionId ?? null);
}

/**
 * A definition saved and then published — what "the catalog holds this" means.
 *
 * Two writes rather than one (FR-016): a draft save alone produces a version no
 * resolver sees, so a suite arranging a *live* definition with the draft write
 * alone would leave `activeVersionId` null and assert against the wrong state.
 * Returns the publication's outcome; the draft write's is asserted by the suites
 * that are about the draft write.
 */
export async function activate(
  store: CatalogStore,
  kind: CatalogKind,
  id: string,
  body: unknown
): Promise<LifecycleWriteOutcome> {
  await store.applyLifecycleWrite({
    op: 'save-draft',
    kind,
    id,
    body,
    expectedDraftVersion: await draftTokenFor(store, kind, id)
  });
  return await store.applyLifecycleWrite({
    op: 'publish',
    kind,
    id,
    expectedDraftVersion: await draftTokenFor(store, kind, id)
  });
}

/** Every file and directory under `root`, as `/`-separated relative paths. */
export async function treeOf(root: string): Promise<Tree> {
  const files: string[] = [];
  const directories: string[] = [];

  async function walk(absolute: string, relative: string): Promise<void> {
    // Spelled out rather than derived from `typeof readdir`: that name is
    // overloaded, and the overload TypeScript picks for it returns `Dirent[]`.
    let entries: string[];
    try {
      entries = await readdir(absolute);
    } catch {
      return;
    }
    for (const name of entries) {
      const childAbsolute = join(absolute, name);
      const childRelative = relative === '' ? name : `${relative}/${name}`;
      const info = await stat(childAbsolute);
      if (info.isDirectory()) {
        directories.push(childRelative);
        await walk(childAbsolute, childRelative);
      } else {
        files.push(childRelative);
      }
    }
  }

  await walk(root, '');
  return { files: files.sort(), directories: directories.sort() };
}

/**
 * Path to `sha256:<hash>:<size>:<mtimeMs>` for every file under `root`.
 *
 * Content alone would miss a file rewritten with identical bytes, which is
 * exactly what an over-eager "repair" on the read path would do — so the
 * modification time is part of the print (FR-016, SC-018).
 */
export async function fingerprintOf(root: string): Promise<Fingerprint> {
  const tree = await treeOf(root);
  const print = new Map<string, string>();
  for (const relative of tree.files) {
    const absolute = join(root, ...relative.split(posix.sep));
    const [contents, info] = await Promise.all([readFile(absolute), stat(absolute)]);
    const hash = createHash('sha256').update(contents).digest('hex');
    print.set(relative, `sha256:${hash}:${info.size}:${info.mtimeMs}`);
  }
  return print;
}

/** Read one store file as text, by the segments the core would have addressed it with. */
export async function readStoreFile(
  workspaceRoot: string,
  ...segments: readonly string[]
): Promise<string> {
  return await readFile(join(storeRootOf(workspaceRoot), ...segments), 'utf8');
}

/** Read one store file as JSON. */
export async function readStoreJson(
  workspaceRoot: string,
  ...segments: readonly string[]
): Promise<unknown> {
  return JSON.parse(await readStoreFile(workspaceRoot, ...segments)) as unknown;
}

/** Native separators, for asserting that a returned value does not carry a path. */
export function pathVariants(absolute: string): readonly string[] {
  const withPosix = absolute.split(sep).join('/');
  const withJsonEscapes = JSON.stringify(absolute).slice(1, -1);
  return [...new Set([absolute, withPosix, withJsonEscapes])];
}
