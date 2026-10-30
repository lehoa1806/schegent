import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  CheckpointNotWritableError,
  checkpointKey,
  type AuditHeadCheckpointV1
} from '../../../src/audit/audit-checkpoint';
import { createAuditCheckpointStore } from '../../../src/audit/audit-checkpoint-store';
import { ensureCheckpointRoot } from '../../../src/audit/audit-checkpoint-root';

/**
 * FR-R4-F03 (FR-015, FR-018, FR-019; contract T10, C1 to C3, C7; R13) — the checkpoint store: where
 * the file lives, what mode it has, and what a crash or a refusal leaves behind.
 *
 * REAL FILES. The store, the root and the key are real, in a real temporary directory. The one seam
 * is a hoisted `fs/promises` hook on `rename`, which flips the destination directory read-only just
 * before the publish, so the "crash between the temp write and the rename" is a real refusal at the
 * real step, with the old file as the thing to compare. The case asserts the hook fired.
 */

const seam = vi.hoisted(() => ({ beforeRename: null as null | (() => Promise<void>), renames: 0 }));

vi.mock('fs/promises', async () => {
  const real = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...real,
    rename: async (...args: Parameters<typeof real.rename>) => {
      if (seam.beforeRename && String(args[1]).includes('audit-checkpoints')) {
        seam.renames += 1;
        await seam.beforeRename();
      }
      return real.rename(...args);
    }
  };
});

const WORKSPACE_PATH = '/Users/alexander-hamilton/projects/aardvark-product';
const hex = (digit: string): string => digit.repeat(64);

describe('the checkpoint store (T10)', () => {
  let root: string;
  let key: string;
  const dir = (): string => path.join(root, 'audit-checkpoints');
  const file = (): string => path.join(dir(), `${key}.json`);
  const record = (over: Partial<AuditHeadCheckpointV1> = {}): AuditHeadCheckpointV1 => ({
    version: 1,
    workspaceKey: key,
    state: 'active',
    origin: 'new',
    headDigest: hex('b'),
    position: 3,
    establishedAtMs: 1_000,
    updatedAtMs: 1_000,
    ...over
  });
  const modeOf = async (target: string): Promise<number> => (await fs.stat(target)).mode & 0o777;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-checkpoint-store-'));
    key = checkpointKey(WORKSPACE_PATH);
    await ensureCheckpointRoot(root);
  });

  afterEach(async () => {
    seam.beforeRename = null;
    seam.renames = 0;
    await fs.chmod(dir(), 0o700).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reads absent before anything is written, and round-trips a record', async () => {
    const store = createAuditCheckpointStore({ root, key });
    expect(await store.read()).toEqual({ status: 'absent' });

    await store.write(record());

    expect(await store.read()).toEqual({ status: 'active', checkpoint: record() });
  });

  it('writes the file 0600 in a 0700 directory, under the 64-character key', async () => {
    const store = createAuditCheckpointStore({ root, key });
    await store.write(record());

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await modeOf(dir())).toBe(0o700);
    expect(await modeOf(file())).toBe(0o600);
    expect(await fs.readdir(dir())).toEqual([`${key}.json`]);
  });

  it('puts no segment of the workspace path in the key or in the file', async () => {
    const store = createAuditCheckpointStore({ root, key });
    await store.write(record());

    const text = await fs.readFile(file(), 'utf8');
    const segments = WORKSPACE_PATH.split('/').filter((segment) => segment.length > 3);
    expect(segments.length, 'the control has segments to look for').toBeGreaterThan(0);
    for (const segment of segments) {
      expect(key, segment).not.toContain(segment);
      expect(text, segment).not.toContain(segment);
    }
    expect(text).not.toContain(WORKSPACE_PATH);
  });

  it('leaves the old file byte-identical when the rename step is refused after the temp write', async () => {
    const store = createAuditCheckpointStore({ root, key });
    await store.write(record({ position: 3 }));
    const before = await fs.readFile(file());

    seam.beforeRename = async () => {
      await fs.chmod(dir(), 0o500);
    };
    await expect(store.write(record({ position: 4 }))).rejects.toThrow();

    expect(seam.renames, 'the seam must have fired').toBeGreaterThanOrEqual(1);
    await fs.chmod(dir(), 0o700);
    expect((await fs.readFile(file())).equals(before), 'the old checkpoint survives a failed publish').toBe(true);

    seam.beforeRename = null;
    await store.write(record({ position: 4 }));
    expect(await store.read()).toMatchObject({ status: 'active', checkpoint: { position: 4 } });
  });

  it('refuses to write after a read that was unreadable, and leaves the file as found', async () => {
    await fs.mkdir(dir(), { recursive: true, mode: 0o700 });
    await fs.writeFile(file(), '{"version": 2, "from": "a newer release"}', { mode: 0o600 });
    const before = await fs.readFile(file());
    const store = createAuditCheckpointStore({ root, key });

    expect(await store.read()).toEqual({ status: 'unreadable', reason: 'version-unknown' });
    await expect(store.write(record())).rejects.toBeInstanceOf(CheckpointNotWritableError);

    expect((await fs.readFile(file())).equals(before), 'a newer release\'s file is never overwritten').toBe(true);
  });

  it('refuses a symlinked audit-checkpoints directory on write and reads it as unreachable', async () => {
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-checkpoint-elsewhere-'));
    try {
      await fs.symlink(elsewhere, dir());
      const store = createAuditCheckpointStore({ root, key });

      expect(await store.read()).toEqual({ status: 'unreadable', reason: 'unreachable' });
      await expect(store.write(record())).rejects.toThrow();

      expect(await fs.readdir(elsewhere), 'nothing was written through the link').toEqual([]);
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('reads an I/O error as unreachable, never as absent', async () => {
    await fs.mkdir(file(), { recursive: true });
    const store = createAuditCheckpointStore({ root, key });

    expect(await store.read()).toEqual({ status: 'unreadable', reason: 'unreachable' });
  });

  it('creates the storage root owner-only, and nothing beside it', async () => {
    const fresh = path.join(root, 'global-storage', 'nested');
    await ensureCheckpointRoot(fresh);

    expect(await modeOf(fresh)).toBe(0o700);
    expect(await fs.readdir(fresh)).toEqual([]);
  });
});
