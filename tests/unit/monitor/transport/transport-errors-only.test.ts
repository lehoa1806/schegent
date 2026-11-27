// Feature 251 (FR-R4-F04, contract T3, SC-002, FR-004) — `errors-only` keeps only what a failed or
// canceled Run produced, through the real sink and the router's Run-end hook.
//
// What it pins: two concurrent Runs, one `failed` and one `completed`, retain only the failed Run's
// records (in its Run file) and the clean Run's marker is in no retained file; `paused` is not an end
// (the stage stays, no Run file appears); a Run resumed after failing that ends `completed` has its
// Run file removed; a switch to `off` before a failed end promotes nothing; a stage a crash left
// behind is promoted by `runPass` when its Run is known `failed` and only aged when its Run is
// unknown or still active; and a stage root cleared before the end promotes nothing and throws
// nothing.
//
// Why: the filing's finding (S-19) is that the clean Run's marker was retained under a mode the
// operator chose to keep errors only. Each "retained" or "removed" claim is paired with a control
// that must hit.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';

import { RunTransportStore } from '../../../../src/monitor/transport/run-transport-store';
import { createTransportHarness, filesContaining, listFilesUnder, type TransportHarness } from './transport-harness';

const FAILED_MARKER = 'SYNTHETIC-MARKER-251-3';
const CLEAN_MARKER = 'SYNTHETIC-MARKER-251-4';
const NO_ACTIVE: ReadonlySet<string> = new Set();

let harness: TransportHarness;

beforeEach(async () => {
  harness = await createTransportHarness({ setting: 'errors-only' });
});

afterEach(async () => {
  await harness.dispose();
});

async function retainedFiles(): Promise<string[]> {
  return listFilesUnder(harness.workspaceRoot, harness.tempRoot);
}

describe('errors-only keeps only the failed Run (SC-002)', () => {
  it('retains the failed Run in its Run file and drops the clean Run', async () => {
    harness.record('run-failed', `${FAILED_MARKER} one`);
    harness.record('run-clean', `${CLEAN_MARKER} one`);
    harness.record('run-failed', `${FAILED_MARKER} two`);
    harness.record('run-clean', `${CLEAN_MARKER} two`);
    await harness.flush();

    // Before the end both Runs are staged, so the control exists: the markers are somewhere.
    expect(await filesContaining(FAILED_MARKER, harness.tempRoot)).toHaveLength(1);
    expect(await filesContaining(CLEAN_MARKER, harness.tempRoot)).toHaveLength(1);
    expect(await listFilesUnder(harness.workspaceRoot)).toEqual([]);

    await harness.router.finalizeRun('run-failed', 'failed', NO_ACTIVE);
    await harness.router.finalizeRun('run-clean', 'completed', NO_ACTIVE);

    expect(await filesContaining(FAILED_MARKER, harness.workspaceRoot, harness.tempRoot)).toEqual([
      harness.runFile('run-failed')
    ]);
    expect(await filesContaining(CLEAN_MARKER, harness.workspaceRoot, harness.tempRoot)).toEqual([]);
    expect(await retainedFiles()).toEqual([harness.runFile('run-failed')]);

    const promoted = (await fs.readFile(harness.runFile('run-failed'), 'utf8')).trimEnd().split('\n');
    expect(promoted.map((line) => line.split('\t')[4])).toEqual([`${FAILED_MARKER} one`, `${FAILED_MARKER} two`]);
  });

  it('promotes a canceled Run the same way', async () => {
    harness.record('run-canceled', `${FAILED_MARKER} before cancel`);
    await harness.flush();
    await harness.router.finalizeRun('run-canceled', 'canceled', NO_ACTIVE);

    expect(await retainedFiles()).toEqual([harness.runFile('run-canceled')]);
  });
});

describe('paused is not an end', () => {
  it('keeps the stage file and creates no Run file', async () => {
    harness.record('run-paused', `${FAILED_MARKER} while paused`);
    await harness.flush();
    await harness.router.finalizeRun('run-paused', 'paused', new Set(['run-paused']));

    expect(await harness.stageFile('run-paused')).not.toBeNull();
    expect(await listFilesUnder(harness.workspaceRoot)).toEqual([]);
  });
});

describe('a resumed Run (FR-004)', () => {
  it('has its Run file removed when it ends completed under errors-only', async () => {
    harness.record('run-resumed', `${FAILED_MARKER} first leg`);
    await harness.flush();
    await harness.router.finalizeRun('run-resumed', 'failed', NO_ACTIVE);
    // The control: the failed leg's records are retained, so the removal below is a removal.
    expect(await retainedFiles()).toEqual([harness.runFile('run-resumed')]);

    harness.record('run-resumed', `${CLEAN_MARKER} second leg`);
    await harness.flush();
    await harness.router.finalizeRun('run-resumed', 'completed', NO_ACTIVE);

    expect(await retainedFiles()).toEqual([]);
    expect(await filesContaining(FAILED_MARKER, harness.workspaceRoot, harness.tempRoot)).toEqual([]);
  });
});

describe('a mode change before the end', () => {
  it('promotes nothing when the mode is off at a failed end, and removes the stage', async () => {
    harness.record('run-switched', `${FAILED_MARKER} staged`);
    await harness.flush();
    expect(await harness.stageFile('run-switched')).not.toBeNull();

    harness.setting = 'off';
    await harness.router.finalizeRun('run-switched', 'failed', NO_ACTIVE);

    expect(await retainedFiles()).toEqual([]);
  });
});

describe('a completed Run never promotes its stage', () => {
  it('removes the staged records even when the mode is on at the end, and writes no Run file', async () => {
    harness.record('run-completed', `${CLEAN_MARKER} staged under errors-only`);
    await harness.flush();
    expect(await harness.stageFile('run-completed')).not.toBeNull();

    // The mode changes to `on` before the end. Under `on` a clean Run's Run file is kept, but what was
    // staged while the mode was `errors-only` belongs to a Run that did not fail, and is not promoted.
    harness.setting = 'on';
    await harness.router.finalizeRun('run-completed', 'completed', NO_ACTIVE);

    expect(await retainedFiles()).toEqual([]);
    expect(await filesContaining(CLEAN_MARKER, harness.workspaceRoot, harness.tempRoot)).toEqual([]);
  });
});

describe('a stage a crash left behind (X6)', () => {
  it('is promoted by runPass when its Run is known failed', async () => {
    harness.record('run-crashed', `${FAILED_MARKER} before the crash`);
    await harness.flush();
    expect(await harness.stageFile('run-crashed')).not.toBeNull();

    harness.statuses.set('run-crashed', 'failed');
    await harness.restart();
    await harness.router.runPass(NO_ACTIVE);

    expect(await retainedFiles()).toEqual([harness.runFile('run-crashed')]);
    expect(await filesContaining(FAILED_MARKER, harness.workspaceRoot)).toEqual([harness.runFile('run-crashed')]);
  });

  it.each([
    ['an unknown Run', undefined],
    ['a Run still running', 'running' as const]
  ])('is only aged by runPass when its Run is %s', async (_label, status) => {
    harness.record('run-unknown', `${FAILED_MARKER} staged`);
    await harness.flush();
    if (status !== undefined) harness.statuses.set('run-unknown', status);

    await harness.router.runPass(new Set(status === 'running' ? ['run-unknown'] : []));

    expect(await harness.stageFile('run-unknown')).not.toBeNull();
    expect(await listFilesUnder(harness.workspaceRoot)).toEqual([]);
  });
});

describe('a cleared stage root', () => {
  it('promotes nothing and throws nothing', async () => {
    harness.record('run-cleared', `${FAILED_MARKER} staged`);
    await harness.flush();
    const directory = await harness.stageDirectory();
    expect(directory, 'the stage must exist before it is cleared').not.toBeNull();
    await fs.rm(directory!, { recursive: true, force: true });

    await expect(harness.router.finalizeRun('run-cleared', 'failed', NO_ACTIVE)).resolves.toBeUndefined();

    expect(await retainedFiles()).toEqual([]);
  });
});

describe('a stage directory another user owns', () => {
  // The stage's name is derived from the workspace path, so on a shared temp root (`/tmp` on a multi-user
  // host) another account can make it first. Adopting it would put the staged transport in a directory they
  // can rename and replace files in, so the next open lands in a file they made and can read.
  it('is refused, and nothing is written into it', async () => {
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const foreign = new RunTransportStore({ tempRoot: harness.tempRoot, warn: () => undefined, ownerUid: () => uid + 1 });
    const target = { kind: 'stage', workspaceRoot: harness.workspaceRoot, runId: 'run-foreign' } as const;

    await expect(foreign.append(target, `${FAILED_MARKER} staged\n`)).rejects.toMatchObject({ code: 'stage-not-owned' });
    expect(await filesContaining(FAILED_MARKER, harness.tempRoot)).toEqual([]);

    // The control: the same store, owned by this account, writes.
    const own = new RunTransportStore({ tempRoot: harness.tempRoot, warn: () => undefined });
    await own.append(target, `${FAILED_MARKER} staged\n`);
    await own.dispose();
    expect(await filesContaining(FAILED_MARKER, harness.tempRoot)).toHaveLength(1);
  });
});
