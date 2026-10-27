// FR-R4-F01 (spec 239, US5, T051, FR-025, contract C6 G17, research R7 "Temp cleanup") — a
// crash between `replace`'s temp write and its rename leaves `.<generation-file>.<pid>.<n>.tmp`
// behind, and `pruneBelow` removed generation files only.
//
// A temp file is a proven orphan only when the generation it was aiming at is BELOW the
// resource's highest: that target is already superseded (and `pruneBelow` removes it), so no live
// write can still be aiming at it. A temp file for the live generation is never removed, and no
// pid or age heuristic decides anything, because a pid says nothing across hosts on a shared mount
// and a slow mount makes an old temp file live.

import { beforeEach, describe, expect, it } from 'vitest';
import { STALENESS_THRESHOLD_MS } from '../../../src/state/lock';
import { OwnershipRegistry } from '../../../src/state/ownership-registry';
import { OWNERSHIP_DIR, SharedOwnershipFs } from '../../fixtures/state/ownership-harness';

const RESOURCE = 'queue:q';
const OTHER_RESOURCE = 'queue:other';
const NOW = 1_000_000;

let fs: SharedOwnershipFs;
let registry: OwnershipRegistry;

beforeEach(() => {
  fs = new SharedOwnershipFs();
  registry = new OwnershipRegistry(fs, OWNERSHIP_DIR);
});

/** The readable half of a resource's file prefix, as `prefixFor` builds it. */
const slugOf = (resource: string): string => resource.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 32);

/** The generation file name `resource` has at `generation`, derived from one it already has. */
function generationFile(resource: string, generation: number): string {
  const existing = fs
    .names()
    .find((name) => !name.startsWith('.') && name.startsWith(`${slugOf(resource)}.`));
  if (existing === undefined) throw new Error(`no generation file yet for ${resource}`);
  return existing.replace(/\.g\d{9}\.json$/, `.g${String(generation).padStart(9, '0')}.json`);
}

const tempFor = (file: string, n: number): string => `${OWNERSHIP_DIR}/.${file}.4242.${n}.tmp`;
const create = (path: string): Promise<void> => fs.createExclusive(path, '{}');

describe('pruneBelow removes the temp files of superseded generations (G17)', () => {
  it('removes a temp file whose target generation is below the highest, and keeps the rest', async () => {
    await registry.acquire(RESOURCE, 'window-a', NOW, STALENESS_THRESHOLD_MS);
    await registry.acquire(OTHER_RESOURCE, 'window-a', NOW, STALENESS_THRESHOLD_MS);
    const gen1 = generationFile(RESOURCE, 1);
    const gen2 = generationFile(RESOURCE, 2);
    const gen3 = generationFile(RESOURCE, 3);
    const otherGen1 = generationFile(OTHER_RESOURCE, 1);
    const staleTemp = tempFor(gen1, 1);
    const liveTemp = tempFor(gen2, 2);
    const futureTemp = tempFor(gen3, 3);
    const foreignTemp = tempFor(otherGen1, 4);
    for (const name of [staleTemp, liveTemp, futureTemp, foreignTemp]) await create(name);
    await create(`${OWNERSHIP_DIR}/.keep`);

    // A rival reclaims after staleness: generation 2 is created, and `pruneBelow(2)` runs.
    const taken = await registry.acquire(
      RESOURCE,
      'window-b',
      NOW + STALENESS_THRESHOLD_MS + 1,
      STALENESS_THRESHOLD_MS
    );
    expect(taken).toMatchObject({ outcome: 'acquired', fence: 2 });

    const names = new Set(fs.names());
    const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
    expect(names.has(base(staleTemp)), 'a temp file aimed at superseded generation 1').toBe(false);
    expect(names.has(gen1), 'the superseded generation file, as before').toBe(false);
    expect(names.has(gen2), 'the live generation file').toBe(true);
    expect(names.has(base(liveTemp)), 'a temp file for the live generation').toBe(true);
    expect(names.has(base(futureTemp)), 'a temp file aimed above the highest').toBe(true);
    expect(names.has(base(foreignTemp)), "another resource's temp file").toBe(true);
    expect(names.has('.keep'), 'an unrelated dotfile').toBe(true);
  });

  it('never removes a generation file at or above the highest', async () => {
    await registry.acquire(RESOURCE, 'window-a', NOW, STALENESS_THRESHOLD_MS);
    const taken = await registry.acquire(
      RESOURCE,
      'window-b',
      NOW + STALENESS_THRESHOLD_MS + 1,
      STALENESS_THRESHOLD_MS
    );
    expect(taken).toMatchObject({ outcome: 'acquired', fence: 2 });

    expect(fs.names().filter((name) => name.endsWith('.g000000002.json'))).toHaveLength(1);
    expect((await registry.read(RESOURCE))?.holder?.ownerId).toBe('window-b');
  });
});
