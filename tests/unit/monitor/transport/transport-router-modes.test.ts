// Feature 251 (FR-R4-F04, contract T2, SC-001, FR-003, FR-007) — what each transport mode writes, and
// where, through the real sink.
//
// What it pins: under `off` a marker streamed by two concurrent Runs is in NO file under the
// workspace, the stage root or the OS temp root (a byte search of every file, not of the ones the
// design names); under `on` each Run's records are in its own Run file and nowhere else, and the
// shared `.schegent/cli-transport.log` is never written; a restarted sink appends to the same Run
// file; and an `off` stretch still advances the key-block redactor, so a later switch to `on` cannot
// leak the second half of a block.
//
// Why: the filing's finding (S-19) is that the marker reached `.schegent/cli-transport.log` whatever
// the operator chose. Every case pairs its "absent" claim with a control that must hit (the same
// harness under `on` finds the marker), so a harness that wrote nothing at all would fail here.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { PRIVATE_KEY_CASES } from '../../../fixtures/key-block-corpus';
import { createTransportHarness, filesContaining, listFilesUnder, type TransportHarness } from './transport-harness';

const MARKER = 'SYNTHETIC-MARKER-251-1';
const SECOND_MARKER = 'SYNTHETIC-MARKER-251-2';

let harness: TransportHarness;

afterEach(async () => {
  await harness.dispose();
});

describe('transport mode off (SC-001)', () => {
  beforeEach(async () => {
    harness = await createTransportHarness({ setting: 'off' });
  });

  it('leaves the marker in no file under the workspace, the stage root or the OS temp root', async () => {
    harness.record('run-a', `${MARKER} from run a`);
    harness.record('run-b', `${MARKER} from run b`);
    harness.record('run-a', `${MARKER} again`, { stream: 'stderr' });
    await harness.flush();

    const scratch = path.dirname(harness.workspaceRoot);
    expect(await filesContaining(MARKER, scratch)).toEqual([]);
    expect(await listFilesUnder(harness.workspaceRoot, harness.tempRoot)).toEqual([]);

    // The control: the same harness under `on` writes the marker, so "nowhere" above is a finding
    // about `off` and not about a harness that writes nothing.
    harness.setting = 'on';
    harness.record('run-a', `${MARKER} under on`);
    await harness.flush();
    expect(await filesContaining(MARKER, scratch)).toEqual([harness.runFile('run-a')]);
  });
});

describe('transport mode on (FR-003, FR-007)', () => {
  beforeEach(async () => {
    harness = await createTransportHarness({ setting: 'on' });
  });

  it('writes each Run to its own file and never to the shared log', async () => {
    harness.record('run-a', `${MARKER} a-1`);
    harness.record('run-b', `${SECOND_MARKER} b-1`);
    harness.record('run-a', `${MARKER} a-2`);
    harness.record('run-b', `${SECOND_MARKER} b-2`);
    await harness.flush();

    expect(await filesContaining(MARKER, harness.workspaceRoot, harness.tempRoot)).toEqual([harness.runFile('run-a')]);
    expect(await filesContaining(SECOND_MARKER, harness.workspaceRoot, harness.tempRoot)).toEqual([
      harness.runFile('run-b')
    ]);
    await expect(fs.stat(path.join(harness.workspaceRoot, '.schegent', 'cli-transport.log'))).rejects.toMatchObject({
      code: 'ENOENT'
    });

    const lines = (await fs.readFile(harness.runFile('run-a'), 'utf8')).trimEnd().split('\n');
    expect(lines.map((line) => line.split('\t')[4])).toEqual([`${MARKER} a-1`, `${MARKER} a-2`]);
    expect(lines.every((line) => line.split('\t')[1] === 'run-a')).toBe(true);
  });

  it('appends to the same Run file after a restart', async () => {
    harness.record('run-a', `${MARKER} before restart`);
    await harness.flush();
    await harness.restart();
    harness.record('run-a', `${MARKER} after restart`);
    await harness.flush();

    const lines = (await fs.readFile(harness.runFile('run-a'), 'utf8')).trimEnd().split('\n');
    expect(lines.map((line) => line.split('\t')[4])).toEqual([`${MARKER} before restart`, `${MARKER} after restart`]);
    expect(await listFilesUnder(path.join(harness.workspaceRoot, '.schegent'))).toEqual([harness.runFile('run-a')]);
  });
});

describe('the redactor advances under off (X2)', () => {
  beforeEach(async () => {
    harness = await createTransportHarness({ setting: 'off' });
  });

  it('leaves no unredacted half of a key block when the mode switches to on mid-block', async () => {
    const block = PRIVATE_KEY_CASES[0]!;
    const lines = block.text.split('\n');
    expect(lines.length, 'the fixture block must span at least four lines to be split').toBeGreaterThanOrEqual(4);

    // The BEGIN line and the first body line arrive while the mode is `off`: nothing is written, but
    // the redactor must still see them and open its suppression state.
    harness.record('run-a', lines[0]!);
    harness.record('run-a', lines[1]!);
    await harness.flush();
    expect(await listFilesUnder(harness.workspaceRoot, harness.tempRoot)).toEqual([]);

    harness.setting = 'on';
    for (const line of lines.slice(2)) harness.record('run-a', line);
    harness.record('run-a', 'ordinary output resumes');
    await harness.flush();

    const written = await fs.readFile(harness.runFile('run-a'), 'utf8');
    for (const forbidden of block.mustNotSurvive) {
      expect(written.includes(forbidden), `the Run file holds a fragment of the key block`).toBe(false);
    }
    // The control: the file is not empty, and ordinary output after the block is recorded.
    expect(written.includes('ordinary output resumes')).toBe(true);
  });
});
