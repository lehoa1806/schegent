// FR-R4-F01 (spec 239, US6, T065, FR-027, FR-032, contract K1, data-model §5, decision D3) — a
// checkpoint says exactly what it can restore.
//
// A checkpoint patch is `git diff --binary <base>`, which holds tracked bytes only: staged and
// unstaged changes to tracked files, including newly added ones. An untracked, non-ignored file is
// not in it, and at `ebf589fa` nothing said so: an empty repository with one untracked file gave a
// 0-byte patch and a manifest with no completeness field, which reads as "a checkpoint of nothing"
// rather than "a checkpoint that could not hold what was there".
//
// Throwaway Git repositories and real `git`: the property under test is what lands on disk.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SanitizedLogger } from '../../../src/lib/logger';
import {
  RunCheckpointService,
  describeCheckpointCompleteness,
  readCheckpointCompleteness
} from '../../../src/services/run-checkpoint-service';
import { RunMutationLedger } from '../../../src/services/run-mutation-ledger';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import {
  makeCheckpointHarness,
  onlyMetadata,
  onlyPatch,
  type CheckpointHarness
} from '../../fixtures/services/checkpoint-harness';

let h: CheckpointHarness;

beforeEach(async () => {
  h = await makeCheckpointHarness();
});

afterEach(async () => {
  await h.dispose();
});

const untracked = (relative: string, body = 'not in the index\n'): Promise<void> =>
  fs
    .mkdir(path.dirname(path.join(h.workspaceRoot, relative)), { recursive: true })
    .then(() => fs.writeFile(path.join(h.workspaceRoot, relative), body, 'utf8'));

describe('completeness in a sole-Run checkpoint (K1 G3, FR-027)', () => {
  it('is complete, with nothing excluded, when only tracked files changed', async () => {
    const a = h.run('run-a');
    await h.write('a.txt', 'tracked change\n');

    await h.service().checkpoint(a, 'speckit-implement');

    expect(await onlyMetadata(h, 'run-a')).toMatchObject({
      completeness: 'complete',
      excludedUntracked: [],
      excludedUntrackedCount: 0
    });
  });

  it('is incomplete, and names the file, when an untracked file exists beside tracked changes', async () => {
    const a = h.run('run-a');
    await h.write('a.txt', 'tracked change\n');
    await untracked('notes.txt');

    await h.service().checkpoint(a, 'speckit-implement');

    expect(await onlyPatch(h, 'run-a')).toContain('tracked change');
    expect(await onlyMetadata(h, 'run-a')).toMatchObject({
      completeness: 'incomplete',
      excludedUntracked: ['notes.txt'],
      excludedUntrackedCount: 1
    });
  });

  it('is never complete beside an empty patch: untracked files only (D3)', async () => {
    const a = h.run('run-a');
    await untracked('only-untracked.txt');

    await h.service().checkpoint(a, 'speckit-implement');

    expect(await onlyPatch(h, 'run-a')).toBe('');
    expect(await onlyMetadata(h, 'run-a')).toMatchObject({
      completeness: 'incomplete',
      excludedUntracked: ['only-untracked.txt'],
      excludedUntrackedCount: 1
    });
  });

  it('is never complete beside an empty patch in an unborn repository', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-completeness-unborn-'));
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-completeness-store-'));
    try {
      await promisify(execFile)('git', ['init', '-q'], { cwd: root });
      await fs.writeFile(path.join(root, 'first.txt'), 'the first file\n', 'utf8');
      const service = new RunCheckpointService(
        storage,
        root,
        { warn: () => undefined } as unknown as SanitizedLogger,
        () => 1,
        new RunMutationLedger({
          readDiff: async () => '',
          listInFlightRunIds: () => [],
          workspaceRoot: root
        })
      );
      const run = { id: 'run-unborn', status: 'running' } as unknown as WorkflowRun;

      await service.checkpoint(run, 'speckit-implement');

      const dir = path.join(storage, 'checkpoints', 'run-unborn');
      const manifest = (await fs.readdir(dir)).find((name) => name.endsWith('.json'))!;
      expect(JSON.parse(await fs.readFile(path.join(dir, manifest), 'utf8'))).toMatchObject({
        completeness: 'incomplete',
        excludedUntracked: ['first.txt']
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(storage, { recursive: true, force: true });
    }
  });

  it('lists an untracked directory once, with its trailing slash', async () => {
    const a = h.run('run-a');
    await untracked('docs/one.md');
    await untracked('docs/two.md');

    await h.service().checkpoint(a, 'speckit-implement');

    expect(await onlyMetadata(h, 'run-a')).toMatchObject({
      excludedUntracked: ['docs/'],
      excludedUntrackedCount: 1
    });
  });

  it('lists at most 50 entries and counts all of them', async () => {
    const a = h.run('run-a');
    for (let index = 0; index < 60; index += 1) {
      await untracked(`bulk-${String(index).padStart(2, '0')}.txt`);
    }

    await h.service().checkpoint(a, 'speckit-implement');

    const manifest = (await onlyMetadata(h, 'run-a'))!;
    expect(manifest.excludedUntracked).toHaveLength(50);
    expect(manifest.excludedUntrackedCount).toBe(60);
    expect(manifest.completeness).toBe('incomplete');
  });

  it('neither lists nor counts an ignored file (FR-027)', async () => {
    await h.write('.gitignore', '*.log\n');
    await h.commitAll('ignore logs');
    const a = h.run('run-a');
    await untracked('debug.log');

    await h.service().checkpoint(a, 'speckit-implement');

    expect(await onlyMetadata(h, 'run-a')).toMatchObject({
      completeness: 'complete',
      excludedUntracked: [],
      excludedUntrackedCount: 0
    });
  });
});

describe('scoped modes never name an entry they cannot attribute (K1 G4, FR-032, hard rule 59)', () => {
  // The mutation ledger forgets a declared path the tracked diff does not show (`forgetAbsent`), so
  // a Run's own untracked file is not in the evidence the checkpoint is handed. In the scoped modes
  // every untracked entry is therefore counted and none is named: the record is `incomplete`, and
  // it says how many entries it could not attribute.
  it('no-sibling-work-present: counts every untracked entry and names none', async () => {
    const a = h.run('run-a');
    await h.idlePhase(h.run('run-b'));
    await h.phase(a, () => untracked('mine/created.txt'), ['mine/created.txt']);
    await untracked('stray/operator.txt');

    await h.service().checkpoint(a, 'speckit-implement');

    const manifest = (await onlyMetadata(h, 'run-a'))!;
    expect(manifest.attribution).toMatchObject({ mode: 'no-sibling-work-present' });
    expect(manifest).toMatchObject({
      completeness: 'incomplete',
      excludedUntracked: [],
      excludedUntrackedCount: 0,
      unattributedUntrackedCount: 2
    });
  });

  it('scoped: lists no sibling\'s untracked path, and counts it', async () => {
    const a = h.run('run-a');
    const b = h.run('run-b');
    await h.phase(a, () => h.write('a.txt', 'tracked by a\n'), ['a.txt']);
    await h.phase(b, () => h.write('b.txt', 'tracked by b\n'), ['b.txt']);
    // After both phases: `h.write` stages everything (`git add -A`), which would turn these
    // into tracked files nobody declared and make the checkpoint decline instead.
    await untracked('mine/created.txt');
    await untracked('theirs/created.txt');

    await h.service().checkpoint(a, 'speckit-implement');

    const manifest = (await onlyMetadata(h, 'run-a'))!;
    expect(manifest.attribution).toMatchObject({ mode: 'scoped' });
    expect(manifest).toMatchObject({
      completeness: 'incomplete',
      excludedUntracked: [],
      excludedUntrackedCount: 0,
      unattributedUntrackedCount: 2
    });
    expect(await onlyPatch(h, 'run-a')).not.toContain('tracked by b');
  });
});

describe('describeCheckpointCompleteness: the lexical match to declared paths (hard rule 53)', () => {
  const declared = new Set(['mine/created.txt', 'src/lib']);

  it('names a collapsed directory that holds a declared path, a file that is one, and a file under one', () => {
    const fields = describeCheckpointCompleteness(
      ['mine/', 'src/lib/extra.ts', 'mine/created.txt', 'theirs/', 'stray.txt'],
      declared
    );

    expect(fields).toEqual({
      completeness: 'incomplete',
      excludedUntracked: ['mine/', 'src/lib/extra.ts', 'mine/created.txt'],
      excludedUntrackedCount: 3,
      unattributedUntrackedCount: 2
    });
  });

  it('does not match a name that merely shares a prefix', () => {
    const fields = describeCheckpointCompleteness(['mine/created.txt.bak', 'src/library/'], declared);

    expect(fields.excludedUntracked).toEqual([]);
    expect(fields.unattributedUntrackedCount).toBe(2);
  });

  it('is complete, with no unattributed field, for a sole Run with nothing untracked', () => {
    expect(describeCheckpointCompleteness([], null)).toEqual({
      completeness: 'complete',
      excludedUntracked: [],
      excludedUntrackedCount: 0
    });
  });

  it('is incomplete in a scoped mode when the only untracked entry is not this Run\'s', () => {
    expect(describeCheckpointCompleteness(['theirs/'], declared)).toMatchObject({
      completeness: 'incomplete',
      unattributedUntrackedCount: 1
    });
  });
});

describe('a path git quotes (porcelain v1)', () => {
  it('is listed unquoted: spaces, a double quote, a backslash and UTF-8 bytes', async () => {
    const a = h.run('run-a');
    await untracked('with space.txt');
    await untracked('quote"d.txt');
    await untracked('caf\u00e9.txt');

    await h.service().checkpoint(a, 'speckit-implement');

    const manifest = (await onlyMetadata(h, 'run-a'))!;
    expect([...(manifest.excludedUntracked as string[])].sort()).toEqual(
      ['caf\u00e9.txt', 'quote"d.txt', 'with space.txt'].sort()
    );
  });
});

describe('a record written before this feature (K1 G2, FR-032)', () => {
  it('reads as unknown through the reader, and is never reported as complete', () => {
    expect(readCheckpointCompleteness({ runId: 'r', baseCommit: 'abc', status: '' })).toBe('unknown');
    expect(readCheckpointCompleteness({ completeness: 'bogus' })).toBe('unknown');
    expect(readCheckpointCompleteness(null)).toBe('unknown');
    expect(readCheckpointCompleteness('not an object')).toBe('unknown');
  });

  it('reads the two values this feature writes', () => {
    expect(readCheckpointCompleteness({ completeness: 'complete' })).toBe('complete');
    expect(readCheckpointCompleteness({ completeness: 'incomplete' })).toBe('incomplete');
  });
});
