// FR-R3-069 (feature 152) — the disk ownership adapter, on a real filesystem.
//
// This file did not exist before feature 152: the adapter's six operations were
// exercised only through in-memory doubles, and four of the six called `fs`
// with no containment proof at all. Now that every operation routes through the
// workspace-anchored judgment and the safe-open walk, each is pinned here with
// real directories and real symlinks — including the fresh-workspace first
// write, which is the exact case whose `io-failed ENOENT` reverted the first
// migration attempt (FR-R3-053 §4c.1).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  createDiskOwnershipFs,
  isAlreadyExists,
  type OwnershipFs
} from '../../../src/state/ownership-fs';

const posixOnly = process.platform === 'win32' ? it.skip : it;

let base: string;
let workspaceRoot: string;
let outside: string;
let ownershipDir: string;
let adapter: OwnershipFs;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-152-ownfs-'));
  workspaceRoot = path.join(base, 'ws');
  outside = path.join(base, 'outside');
  await fs.mkdir(workspaceRoot);
  await fs.mkdir(outside);
  ownershipDir = path.join(workspaceRoot, '.schegent', 'ownership');
  adapter = createDiskOwnershipFs({ workspaceRoot, ownershipDir });
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe('FR-R3-069 — the six operations on a fresh workspace', () => {
  it('ensureDir creates the store chain in a workspace where nothing exists yet', async () => {
    // The FR-R3-053 §4c.1 revert case: the walk now has the workspace root as
    // its existing trusted ancestor, so the first election has a directory.
    await adapter.ensureDir(ownershipDir);
    expect(await fs.readdir(ownershipDir)).toEqual([]);
  });

  it('list of a missing store dir is empty, read of a missing record is null', async () => {
    expect(await adapter.list(ownershipDir)).toEqual([]);
    await adapter.ensureDir(ownershipDir);
    expect(await adapter.read(`${ownershipDir}/primacy.g000000001.json`)).toBeNull();
  });

  it('createExclusive keeps its atomicity contract: one winner, EEXIST losers', async () => {
    await adapter.ensureDir(ownershipDir);
    const file = `${ownershipDir}/primacy.g000000001.json`;
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => adapter.createExclusive(file, `claim-${i}`))
    );
    const winners = outcomes.filter((o) => o.status === 'fulfilled');
    const losers = outcomes.filter(
      (o) => o.status === 'rejected' && isAlreadyExists((o as PromiseRejectedResult).reason)
    );
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(5);
  });

  it('replace round-trips through read, and remove is idempotent', async () => {
    await adapter.ensureDir(ownershipDir);
    const file = `${ownershipDir}/primacy.g000000001.json`;
    await adapter.createExclusive(file, 'first');
    await adapter.replace(file, 'second');
    expect(await adapter.read(file)).toBe('second');
    await adapter.remove(file);
    await adapter.remove(file);
    expect(await adapter.read(file)).toBeNull();
  });
});

describe('FR-R3-069 — a symlinked store refuses instead of authorizing its target', () => {
  posixOnly('.schegent/ownership linked out of the workspace: election refuses, nothing written', async () => {
    await fs.mkdir(path.join(workspaceRoot, '.schegent'), { recursive: true });
    await fs.symlink(outside, ownershipDir);
    await expect(adapter.ensureDir(ownershipDir)).rejects.toMatchObject({
      code: 'ESCHEGENTCONTAINMENT'
    });
    await expect(
      adapter.createExclusive(`${ownershipDir}/primacy.g000000001.json`, 'claim')
    ).rejects.toMatchObject({ code: 'ESCHEGENTCONTAINMENT' });
    // The refusal is a containment refusal, never an I/O error, and the link
    // target stays untouched — no record was arbitrated through it.
    expect(await fs.readdir(outside)).toEqual([]);
  });

  posixOnly('.schegent itself linked out: the same refusal, one level up', async () => {
    await fs.symlink(outside, path.join(workspaceRoot, '.schegent'));
    await expect(adapter.ensureDir(ownershipDir)).rejects.toMatchObject({
      code: 'ESCHEGENTCONTAINMENT'
    });
    await expect(adapter.list(ownershipDir)).rejects.toMatchObject({
      code: 'ESCHEGENTCONTAINMENT'
    });
    await expect(
      adapter.read(`${ownershipDir}/primacy.g000000001.json`)
    ).rejects.toMatchObject({ code: 'ESCHEGENTCONTAINMENT' });
    expect(await fs.readdir(outside)).toEqual([]);
  });

  posixOnly('a store link that stays inside the workspace is admitted, not refused', async () => {
    // The refusal is for escapes, not for links per se: containment is judged
    // against the workspace root, and this target is inside it.
    const realStore = path.join(workspaceRoot, 'real-store');
    await fs.mkdir(realStore);
    await fs.mkdir(path.join(workspaceRoot, '.schegent'));
    await fs.symlink(realStore, ownershipDir);
    await adapter.ensureDir(ownershipDir);
    const file = `${ownershipDir}/primacy.g000000001.json`;
    await adapter.createExclusive(file, 'claim');
    expect(await adapter.read(file)).toBe('claim');
    expect(await adapter.list(ownershipDir)).toEqual(['primacy.g000000001.json']);
  });

  it('the dir-shaped operations refuse any path that is not the adapter\'s own store', async () => {
    await expect(adapter.ensureDir(path.join(workspaceRoot, 'elsewhere'))).rejects.toMatchObject({
      code: 'ESCHEGENTCONTAINMENT'
    });
    await expect(adapter.list(path.join(workspaceRoot, 'elsewhere'))).rejects.toMatchObject({
      code: 'ESCHEGENTCONTAINMENT'
    });
  });
});
