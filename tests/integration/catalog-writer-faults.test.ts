// Feature 254 (FR-R4-F07, W-T4, W-T5; contract W7, W8; research R22, R23; data-model §9; FR-039, FR-040,
// SC-010) — what the catalog writer reports, and what it leaves on disk, when a step fails.
//
// A save touches two files, a version record and then the manifest (`src/catalog/atomic-write.ts`), and
// the adapter writes each through a sequence of steps. Until this feature neither file was synced before
// its rename or its close ended, and no directory was synced after: a power cut could leave a manifest
// rename on disk with its contents not, which the store reads as malformed, so every definition in the
// catalog becomes unreadable. The barrier closes that on local POSIX filesystems, and this file is its
// proof: it fails ONE step at a time on a real directory, through the real adapter, and asserts three
// things for each (data-model §9):
//
//   * the outcome the store reported;
//   * the files on disk;
//   * how the next cold read classifies them.
//
// And it holds the ORDER (W-T5): the file `sync` comes before the `close` that precedes a rename or ends an
// exclusive create, and the directory `sync` comes after the rename and after the exclusive create, on
// darwin and linux only. On win32 no directory is opened at all: Node cannot open one there, which is a
// stated platform limit and not a fault.
//
// How faults are injected, and why no production seam was added (R23). `MemoryCatalogFs` fails a whole
// port call, so it cannot fail BETWEEN a write, a flush and a rename. The filing rules out generic
// dependency injection, so the spy sits at the test boundary: `open` and `rename` on `node:fs/promises`,
// and `writeFile` and `sync` on the `FileHandle` prototype taken from a handle opened here, and `close`, which is
// an own property of each handle, on the handle `open` returns. A handle is mapped to the kind of file it was opened for, so a fault names "the record's sync" and not "the
// third sync".
//
// What no case does: remove a landed file (FR-040). A step that fails leaves what had landed before it, and
// the store labels (`wrote`) only what is on disk.
//
// This is a real-filesystem file in the integration tier, run alone: a spy on `node:fs/promises` is
// process-wide, and the file restores it after every case.

import { promises as fsp, statSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeDigest, systemClock } from '../../src/activation/catalog-store-wiring';
import { createCatalogStore, createQueueRunProvenance, type CatalogStore } from '../../src/catalog';
import type { LifecycleWriteOutcome } from '../../src/contracts/catalog-store';
import { createCatalogFsAdapter } from '../../src/host-services/catalog-fs-adapter';
import {
  createWorkspace,
  openStore,
  removeWorkspace,
  storeRootOf,
  treeOf
} from '../fixtures/catalog-real-fs';

// ---------------------------------------------------------------------------
// The spy
// ---------------------------------------------------------------------------

type Op = 'open' | 'write' | 'sync' | 'close' | 'rename';

interface PlannedFault {
  readonly op: Op;
  /** `record`, `temp`, `dir:phases/implement`, `dir:.` (the store root), or a prefix ending in `*`. */
  readonly kind: string;
  readonly errno: string;
  remaining: number;
}

/** The ids the faulted save writes. A different definition is seeded first, so a manifest already exists. */
const SEED_ID = 'seed';
const TARGET_ID = 'implement';
/** What a cold read lists once the target landed: sorted, as `observe` sorts. */
const BOTH_DEFINITIONS = [SEED_ID, TARGET_ID].sort();
const TARGET_RECORD_DIR = `dir:phases/${TARGET_ID}`;
const STORE_ROOT_DIR = 'dir:.';

/** The events whose order W-T5 holds. Opens are left out: an open is not a barrier. */
const BARRIER_EVENTS = new Set([
  'sync:record',
  'close:record',
  `sync:${TARGET_RECORD_DIR}`,
  `close:${TARGET_RECORD_DIR}`,
  'sync:temp',
  'close:temp',
  'rename:manifest',
  `sync:${STORE_ROOT_DIR}`,
  `close:${STORE_ROOT_DIR}`
]);

const EXPECTED_BARRIER_ORDER = [
  'sync:record',
  'close:record',
  `sync:${TARGET_RECORD_DIR}`,
  `close:${TARGET_RECORD_DIR}`,
  'sync:temp',
  'close:temp',
  'rename:manifest',
  `sync:${STORE_ROOT_DIR}`,
  `close:${STORE_ROOT_DIR}`
];

let storeRoot = '';
const events: string[] = [];
const kindOfHandle = new WeakMap<object, string>();
let plans: PlannedFault[] = [];
let spies: { mockRestore(): void }[] = [];
let originalPlatform: PropertyDescriptor | undefined;

/** What kind of file a path is, for naming a fault and an event. */
function kindOfPath(target: string): string {
  const name = basename(target);
  if (/^v\d+\.json$/.test(name)) return 'record';
  if (name.startsWith('.manifest.json.') && name.endsWith('.tmp')) return 'temp';
  if (name === 'manifest.json') return 'manifest';
  try {
    if (statSync(target).isDirectory()) return `dir:${relative(storeRoot, target) || '.'}`;
  } catch {
    // Not there yet: not a directory this file cares about.
  }
  return 'other';
}

function note(op: Op, kind: string): void {
  const event = `${op}:${kind}`;
  if (kind === 'other') return;
  events.push(event);
}

function failIfPlanned(op: Op, kind: string): void {
  const plan = plans.find(
    (candidate) =>
      candidate.op === op &&
      candidate.remaining > 0 &&
      (candidate.kind.endsWith('*') ? kind.startsWith(candidate.kind.slice(0, -1)) : candidate.kind === kind)
  );
  if (plan === undefined) return;
  plan.remaining -= 1;
  throw Object.assign(new Error(`injected ${op} fault on ${kind}`), { code: plan.errno });
}

function plan(op: Op, kind: string, errno = 'EIO', times = 1): void {
  plans.push({ op, kind, errno, remaining: times });
}

/** The `FileHandle` prototype, taken from a handle opened here and closed straight away. */
async function fileHandlePrototype(): Promise<Record<string, unknown>> {
  const handle = await fsp.open(storeRoot.length > 0 ? storeRoot : '.', 'r');
  const prototype = Object.getPrototypeOf(handle) as Record<string, unknown>;
  await handle.close();
  return prototype;
}

async function installSpies(): Promise<void> {
  const prototype = (await fileHandlePrototype()) as unknown as {
    writeFile: (this: FileHandle, ...args: never[]) => Promise<void>;
    sync: (this: FileHandle) => Promise<void>;
  };
  const realOpen = fsp.open.bind(fsp);
  const realRename = fsp.rename.bind(fsp);
  const realWrite = prototype.writeFile;
  const realSync = prototype.sync;

  spies = [
    vi.spyOn(fsp, 'open').mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      const kind = kindOfPath(String(args[0]));
      failIfPlanned('open', kind);
      const handle = await realOpen(...args);
      kindOfHandle.set(handle, kind);
      note('open', kind);
      // `close` is an own property of each handle in Node 24 (an arrow function field), not a method on the
      // prototype, so it is wrapped here, per handle. A planned close fault still closes the handle first:
      // a leaked descriptor is not what is under test.
      const realClose = handle.close.bind(handle);
      handle.close = async () => {
        await realClose();
        note('close', kind);
        failIfPlanned('close', kind);
      };
      return handle;
    }) as typeof fsp.open),
    vi.spyOn(fsp, 'rename').mockImplementation((async (from: string, to: string) => {
      const kind = kindOfPath(String(to));
      note('rename', kind);
      failIfPlanned('rename', kind);
      return realRename(from, to);
    }) as typeof fsp.rename),
    vi.spyOn(prototype, 'writeFile').mockImplementation(async function (this: FileHandle, ...args: never[]) {
      const kind = kindOfHandle.get(this) ?? 'other';
      note('write', kind);
      failIfPlanned('write', kind);
      return realWrite.apply(this, args);
    }),
    vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
      const kind = kindOfHandle.get(this) ?? 'other';
      note('sync', kind);
      failIfPlanned('sync', kind);
      return realSync.call(this);
    })
  ];
  syncBuiltinESMExports();
}

function removeSpies(): void {
  for (const spy of spies) spy.mockRestore();
  spies = [];
  syncBuiltinESMExports();
}

function stubPlatform(platform: NodeJS.Platform): void {
  originalPlatform ??= Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function restorePlatform(): void {
  if (originalPlatform !== undefined) Object.defineProperty(process, 'platform', originalPlatform);
  originalPlatform = undefined;
}

// ---------------------------------------------------------------------------
// The store, and what to read back
// ---------------------------------------------------------------------------

let workspaceRoot = '';
let warnings: string[] = [];

/** A store on the real adapter with a logger, so the adapter's own warnings can be counted. */
function openLoggedStore(): CatalogStore {
  return createCatalogStore({
    fs: createCatalogFsAdapter(
      { workspaceRoot, storeRoot: storeRootOf(workspaceRoot) },
      { warn: (message: string) => warnings.push(message) }
    ),
    clock: systemClock,
    digest: nodeDigest,
    provenance: createQueueRunProvenance(() => [])
  });
}

function saveDraft(store: CatalogStore, id: string): Promise<LifecycleWriteOutcome> {
  return store.applyLifecycleWrite({
    op: 'save-draft',
    kind: 'phase',
    id,
    body: { name: id },
    expectedDraftVersion: 'no-draft'
  });
}

interface Observation {
  readonly files: readonly string[];
  readonly definitions: readonly string[];
  readonly drafts: Readonly<Record<string, string | null>>;
  readonly collectable: readonly string[];
  readonly faults: number;
}

/** What a cold read makes of the directory: a fresh store, nothing cached. */
async function observe(): Promise<Observation> {
  const result = await openStore(workspaceRoot).read();
  if (result.outcome !== 'read') throw new Error(`store unreadable: ${result.fault.fault}`);
  const snapshot = result.snapshot;
  return {
    files: (await treeOf(storeRoot)).files,
    definitions: snapshot.definitions.map((definition) => definition.id).sort(),
    drafts: Object.fromEntries(
      snapshot.definitions.map((definition) => [definition.id, definition.draftVersionId])
    ),
    collectable: snapshot.collectable.map((record) => `${record.id}/${record.versionId}`).sort(),
    faults: snapshot.faults.length
  };
}

const isTempFile = (file: string): boolean => /^\.manifest\.json\..+\.tmp$/.test(basename(file));

async function readFileText(file: string): Promise<string> {
  return await fsp.readFile(join(storeRoot, file), 'utf8');
}

let store: CatalogStore;
let manifestBefore = '';

beforeEach(async () => {
  workspaceRoot = await createWorkspace('faults');
  storeRoot = storeRootOf(workspaceRoot);
  events.length = 0;
  plans = [];
  warnings = [];
  store = openLoggedStore();
  // A definition saved first, so the manifest exists and "unchanged" is a comparison of bytes.
  expect(await saveDraft(store, SEED_ID)).toMatchObject({ outcome: 'written' });
  manifestBefore = await readFileText('manifest.json');
  await installSpies();
  events.length = 0;
});

afterEach(async () => {
  removeSpies();
  restorePlatform();
  await removeWorkspace(workspaceRoot);
});

// ---------------------------------------------------------------------------
// W-T4: one step fails, and the outcome, the disk and the next read agree (data-model §9)
// ---------------------------------------------------------------------------

describe('FR-R4-F07 W-T4 — a fault at each step reports what is on disk (FR-040, SC-010)', () => {
  it('record open EEXIST: refused version-exists, and nothing changes', async () => {
    await fsp.mkdir(join(storeRoot, 'phases', TARGET_ID), { recursive: true });
    const plantedPath = join('phases', TARGET_ID, 'v1.json');
    await fsp.writeFile(join(storeRoot, plantedPath), '{"planted":true}', 'utf8');
    const before = await observe();

    const outcome = await saveDraft(store, TARGET_ID);

    expect(outcome).toEqual({ outcome: 'refused', reason: 'version-exists' });
    expect(await readFileText(plantedPath)).toBe('{"planted":true}');
    expect(await readFileText('manifest.json')).toBe(manifestBefore);
    expect(await observe()).toEqual(before);
  });

  it('record write: partial with nothing landed, the record left unnamed, the definition at its pointer', async () => {
    plan('write', 'record');

    const outcome = await saveDraft(store, TARGET_ID);

    expect(outcome).toEqual({ outcome: 'partial', wrote: [], errno: 'EIO' });
    expect(await readFileText('manifest.json')).toBe(manifestBefore);
    const after = await observe();
    expect(after.files).toContain(`phases/${TARGET_ID}/v1.json`);
    expect(after.definitions).toEqual([SEED_ID]);
    expect(after.collectable).toEqual([`${TARGET_ID}/v1`]);
    expect(after.faults).toBe(0);
  });

  it('record sync: partial with nothing landed, the unsynced record left unnamed', async () => {
    plan('sync', 'record');

    const outcome = await saveDraft(store, TARGET_ID);

    expect(outcome).toEqual({ outcome: 'partial', wrote: [], errno: 'EIO' });
    expect(await readFileText('manifest.json')).toBe(manifestBefore);
    const after = await observe();
    expect(after.definitions).toEqual([SEED_ID]);
    expect(after.collectable).toEqual([`${TARGET_ID}/v1`]);
    expect(after.faults).toBe(0);
  });

  it('record close after a good sync: written, the record landed', async () => {
    plan('close', 'record');

    const outcome = await saveDraft(store, TARGET_ID);

    expect(outcome).toMatchObject({ outcome: 'written', writtenVersionId: 'v1' });
    const after = await observe();
    expect(after.definitions).toEqual(BOTH_DEFINITIONS);
    expect(after.collectable).toEqual([]);
    expect(after.faults).toBe(0);
  });

  it('record dirsync: written, plus one errno-only warning', async () => {
    plan('sync', TARGET_RECORD_DIR, 'EINVAL');

    const outcome = await saveDraft(store, TARGET_ID);

    expect(outcome).toMatchObject({ outcome: 'written', writtenVersionId: 'v1' });
    const after = await observe();
    expect(after.definitions).toEqual(BOTH_DEFINITIONS);
    expect(after.collectable).toEqual([]);
    const barrierWarnings = warnings.filter((message) => /directory sync/i.test(message));
    expect(barrierWarnings).toHaveLength(1);
    expect(barrierWarnings[0]).toContain('EINVAL');
    expect(barrierWarnings[0]).not.toContain(workspaceRoot);
    expect(barrierWarnings[0]).not.toContain(TARGET_ID);
  });

  it.each([
    ['open', 'temp'],
    ['write', 'temp'],
    ['sync', 'temp']
  ] as const)(
    'temp %s: partial with the record landed, the definition unchanged, the record collectable',
    async (op, kind) => {
      plan(op, kind);

      const outcome = await saveDraft(store, TARGET_ID);

      expect(outcome).toEqual({ outcome: 'partial', wrote: ['v1'], errno: 'EIO' });
      // The manifest was never replaced. A `.manifest.json.<token>.tmp` may remain, and is skipped as a temp.
      expect(await readFileText('manifest.json')).toBe(manifestBefore);
      const after = await observe();
      expect(after.files.filter((file) => !isTempFile(file))).toEqual([
        'manifest.json',
        `phases/${TARGET_ID}/v1.json`,
        `phases/${SEED_ID}/v1.json`
      ].sort());
      expect(after.definitions).toEqual([SEED_ID]);
      expect(after.collectable).toEqual([`${TARGET_ID}/v1`]);
      expect(after.faults).toBe(0);
    }
  );

  it('rename: partial with the record landed, the temp removed, the manifest unchanged', async () => {
    plan('rename', 'manifest');

    const outcome = await saveDraft(store, TARGET_ID);

    expect(outcome).toEqual({ outcome: 'partial', wrote: ['v1'], errno: 'EIO' });
    expect(await readFileText('manifest.json')).toBe(manifestBefore);
    const after = await observe();
    expect(after.files.filter(isTempFile)).toEqual([]);
    expect(after.definitions).toEqual([SEED_ID]);
    expect(after.collectable).toEqual([`${TARGET_ID}/v1`]);
  });

  it('manifest dirsync: written, plus one errno-only warning, the new pointer in place', async () => {
    plan('sync', STORE_ROOT_DIR, 'EPERM');

    const outcome = await saveDraft(store, TARGET_ID);

    expect(outcome).toMatchObject({ outcome: 'written', writtenVersionId: 'v1' });
    const after = await observe();
    expect(after.drafts[TARGET_ID]).toBe('v1');
    expect(after.collectable).toEqual([]);
    const barrierWarnings = warnings.filter((message) => /directory sync/i.test(message));
    expect(barrierWarnings).toHaveLength(1);
    expect(barrierWarnings[0]).toContain('EPERM');
  });

  it('a directory that cannot be opened is the same: written, one warning, nothing refused', async () => {
    plan('open', TARGET_RECORD_DIR, 'EACCES');

    const outcome = await saveDraft(store, TARGET_ID);

    expect(outcome).toMatchObject({ outcome: 'written', writtenVersionId: 'v1' });
    expect((await observe()).drafts[TARGET_ID]).toBe('v1');
    expect(warnings.filter((message) => /directory sync/i.test(message))).toHaveLength(1);
  });

  it('warns once per adapter, however many directory syncs fail', async () => {
    plan('sync', 'dir:*', 'EINVAL', 100);

    expect(await saveDraft(store, TARGET_ID)).toMatchObject({ outcome: 'written' });
    expect(await saveDraft(store, 'again')).toMatchObject({ outcome: 'written' });

    // Four directory syncs failed across two saves; the adapter said so once.
    expect(warnings.filter((message) => /directory sync/i.test(message))).toHaveLength(1);
  });

  it('no case removes a landed file: every landed record is still there after every fault', async () => {
    for (const [op, kind] of [
      ['write', 'record'],
      ['sync', 'record'],
      ['sync', 'temp'],
      ['rename', 'manifest']
    ] as const) {
      plan(op, kind);
    }
    const landedBefore = (await treeOf(storeRoot)).files;

    await saveDraft(store, 'one');
    await saveDraft(store, 'two');
    await saveDraft(store, 'three');
    await saveDraft(store, 'four');

    const landedAfter = (await treeOf(storeRoot)).files.filter((file) => !isTempFile(file));
    for (const file of landedBefore) expect(landedAfter).toContain(file);
  });
});

// ---------------------------------------------------------------------------
// W-T5: the order of the barrier, and the platforms it applies to
// ---------------------------------------------------------------------------

describe('FR-R4-F07 W-T5 — the barrier order (contract W7; FR-039)', () => {
  it.each(['darwin', 'linux'] as const)(
    'on %s: file sync before each close, directory sync after the exclusive create and after the rename',
    async (platform) => {
      stubPlatform(platform);

      expect(await saveDraft(store, TARGET_ID)).toMatchObject({ outcome: 'written' });

      expect(events.filter((event) => BARRIER_EVENTS.has(event))).toEqual(EXPECTED_BARRIER_ORDER);
      // A directory sync creates no path: the tree is what the two saves wrote and nothing more.
      const tree = await treeOf(storeRoot);
      expect(tree.directories).toEqual(['phases', `phases/${TARGET_ID}`, `phases/${SEED_ID}`].sort());
      expect(tree.files.filter(isTempFile)).toEqual([]);
    }
  );

  it('on win32: the files are still synced before they are closed, and no directory is opened', async () => {
    stubPlatform('win32');

    expect(await saveDraft(store, TARGET_ID)).toMatchObject({ outcome: 'written' });

    expect(events.filter((event) => event.startsWith('open:dir'))).toEqual([]);
    expect(events.filter((event) => event.includes(':dir:'))).toEqual([]);
    const fileEvents = events.filter((event) => BARRIER_EVENTS.has(event));
    expect(fileEvents).toEqual(['sync:record', 'close:record', 'sync:temp', 'close:temp', 'rename:manifest']);
    expect(warnings.filter((message) => /directory sync/i.test(message))).toEqual([]);
  });

  it('control: the spy sees the writes (a run with no events would prove nothing)', async () => {
    expect(await saveDraft(store, TARGET_ID)).toMatchObject({ outcome: 'written' });

    expect(events).toContain('open:record');
    expect(events).toContain('write:record');
    expect(events).toContain('open:temp');
    expect(events).toContain('rename:manifest');
  });
});

// ---------------------------------------------------------------------------
// V-T3: the writability probe says why it refused (contract V4; data-model §11 row `:476`; FR-043)
// ---------------------------------------------------------------------------

describe('FR-R4-F07 V-T3 — a failing writability probe logs its errno once (V4)', () => {
  // `checkWritability` returned `not-writable` from a bare `catch`, so an operator told "the catalog is not
  // writable" could not tell a permissions problem from a containment refusal from a full disk. The outcome
  // is unchanged (it is still `not-writable`, and nothing is written); what is added is the errno, once per
  // adapter, with no path. This is one of exactly three catches whose diagnostic changes.
  it('refuses as not-writable, as before, and logs the errno once without a path', async () => {
    const access = vi
      .spyOn(fsp, 'access')
      .mockRejectedValue(Object.assign(new Error('injected access fault'), { code: 'EACCES' }));
    syncBuiltinESMExports();
    const filesBefore = (await treeOf(storeRoot)).files;

    const first = await saveDraft(store, TARGET_ID);
    const second = await saveDraft(store, 'again');

    access.mockRestore();
    syncBuiltinESMExports();
    expect(first).toEqual({ outcome: 'refused', reason: 'not-writable' });
    expect(second).toEqual({ outcome: 'refused', reason: 'not-writable' });
    // Nothing was written by either refused save.
    expect((await treeOf(storeRoot)).files).toEqual(filesBefore);
    const probeWarnings = warnings.filter((message) => /writab/i.test(message));
    expect(probeWarnings).toHaveLength(1);
    expect(probeWarnings[0]).toContain('EACCES');
    expect(probeWarnings[0]).not.toContain(workspaceRoot);
    expect(probeWarnings[0]).not.toContain(TARGET_ID);
  });

  it('control: a healthy probe logs nothing about writability', async () => {
    expect(await saveDraft(store, TARGET_ID)).toMatchObject({ outcome: 'written' });

    expect(warnings.filter((message) => /writab/i.test(message))).toEqual([]);
  });
});
