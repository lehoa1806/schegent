// FR-R3-004 (T320) — checkpoint artifacts stay owner-only.
//
// A `.patch` is unredacted source: it is a diff of the working tree, so it holds
// whatever the tree holds, including anything the logger's redaction set would
// have caught on its way to a log. Nothing reads these files but the operator who
// goes looking for one, and they live under the extension's global storage rather
// than in the workspace, so `0700` on the directory and `0600` on every file is
// the whole access-control story.
//
// Asserted here rather than beside the writer because the modes are only true if
// they survive the *sequence* the writer performs — `mkdir` honours the process
// umask, so `ensureRunRoot` follows it with an explicit `chmod`, and a directory
// created by an earlier checkpoint has to keep its mode when a later one reuses
// it. A unit test that called the writer once would pass without that.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  makeDriveHarness,
  GIT_PHASE_ID,
  QUEUE_A,
  QUEUE_B,
  type CheckpointDriveHarness
} from './driver-harness';

let h: CheckpointDriveHarness;

beforeEach(async () => {
  h = await makeDriveHarness();
});

afterEach(async () => {
  await h.dispose();
});

async function modeOf(target: string): Promise<number> {
  return (await fs.stat(target)).mode & 0o777;
}

/** Every artifact a Run wrote, with its mode. */
async function modes(runId: string): Promise<ReadonlyArray<{ name: string; mode: number }>> {
  const names = await h.artifacts(runId);
  return Promise.all(
    names.map(async (name) => ({ name, mode: await modeOf(path.join(h.runRoot(runId), name)) }))
  );
}

describe('checkpoint artifacts are owner-only (T320, FR-R3-004)', () => {
  it('writes the patch and its metadata 0600 under a 0700 directory', async () => {
    h.start(QUEUE_A, 'run-a');
    await h.atGate('run-a', 'write-work');
    h.step('run-a');
    await h.atGate('run-a', 'settle');
    h.step('run-a');
    await h.atGate('run-a', GIT_PHASE_ID);

    expect(await modeOf(h.runRoot('run-a'))).toBe(0o700);
    const written = await modes('run-a');
    expect(written.map((entry) => entry.name.replace(/^\d+-/, ''))).toEqual([
      `${GIT_PHASE_ID}.json`,
      `${GIT_PHASE_ID}.patch`
    ]);
    for (const entry of written) {
      expect(entry.mode, `${entry.name} is not owner-only`).toBe(0o600);
    }
  });

  it('writes a decline marker 0600 under a 0700 directory', async () => {
    // A marker names the paths that made the partition undecidable, so it is not
    // a file to leave world-readable either — and it is written down a separate
    // code path, with its own `ensureRunRoot` call.
    h.start(QUEUE_A, 'run-a');
    h.start(QUEUE_B, 'run-b');
    await h.atGate('run-a', 'write-work');
    await h.atGate('run-b', 'write-work');
    h.step('run-a');
    await h.atGate('run-a', 'settle');
    h.step('run-b');
    await h.atGate('run-b', 'settle');
    // Nobody declared this, so run-a's checkpoint cannot account for the tree.
    await h.write('stray.txt', 'nobody declared this\n');
    h.step('run-a');
    await h.atGate('run-a', GIT_PHASE_ID);

    expect(await h.decline('run-a')).toMatchObject({
      reason: 'unattributed-worktree-change',
      restorable: false
    });
    expect(await modeOf(h.runRoot('run-a'))).toBe(0o700);
    const written = await modes('run-a');
    expect(written).toHaveLength(1);
    expect(written[0]!.name).toMatch(/\.declined\.json$/);
    expect(written[0]!.mode).toBe(0o600);
  });
});
