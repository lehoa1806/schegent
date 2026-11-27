// FR-R4-F01 (spec 239, US6, T068, FR-029, SC-006, contract K4, hard rule 59) — the manual restore
// runbook is a procedure a test has executed, not prose.
//
// There is no in-product restore path: an operator applies a checkpoint's patch by hand. The page
// that tells them how (`docs/operations/recovery-checkpoints.md`, "Restoring a checkpoint by hand")
// carried the sentence "None of the procedures here has an automated end-to-end test behind it".
// This file is the exception to it, and it holds the page honest in both directions:
//
//   - the commands in the page's fenced block are compared with the commands this test runs, and
//     a difference fails (a doc-sync assertion, so the page cannot drift from what is exercised);
//   - the sequence is then RUN in throwaway repositories for each SC-006 case, and the restored
//     bytes are compared with the ones the checkpoint was taken from.
//
// The target is a disposable clone made with `git clone --no-hardlinks`, never `git worktree`
// (hard rule 59), and the untracked file the manifest lists is asserted NOT to be restored.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunCheckpointService } from '../../../src/services/run-checkpoint-service';
import { RunMutationLedger } from '../../../src/services/run-mutation-ledger';
import type { SanitizedLogger } from '../../../src/lib/logger';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import {
  makeCheckpointHarness,
  onlyMetadata,
  onlyPatch,
  type CheckpointHarness
} from '../../fixtures/services/checkpoint-harness';

const exec = promisify(execFile);
const RUNBOOK = path.resolve(__dirname, '..', '..', '..', 'docs', 'operations', 'recovery-checkpoints.md');
const SECTION = 'Restoring a checkpoint by hand';

/**
 * The runbook's commands, with `<workspace>`, `<tmp>`, `<baseCommit>` and `<patch>` as the
 * placeholders the page uses. The page's fenced block must hold exactly these command lines, in
 * this order (comments aside).
 */
const COMMANDS = {
  clone: 'git clone --no-hardlinks <workspace> <tmp>',
  checkout: 'git -C <tmp> checkout --detach <baseCommit>',
  init: 'git init <tmp>',
  check: 'git -C <tmp> apply --check --binary <patch>',
  apply: 'git -C <tmp> apply --binary <patch>',
  threeWay: 'git -C <tmp> apply --3way --binary <patch>',
  reject: 'git -C <tmp> apply --reject --binary <patch>'
} as const;

const ORDER = [
  COMMANDS.clone,
  COMMANDS.checkout,
  COMMANDS.init,
  COMMANDS.check,
  COMMANDS.apply,
  COMMANDS.threeWay,
  COMMANDS.reject
];

interface Placeholders {
  readonly workspace: string;
  readonly tmp: string;
  readonly baseCommit: string;
  readonly patch: string;
}

/** Run one runbook line, substituting the placeholders. Resolves to the exit code and output. */
async function runLine(
  template: string,
  values: Placeholders
): Promise<{ code: number; stdout: string; stderr: string }> {
  const line = template
    .replaceAll('<workspace>', values.workspace)
    .replaceAll('<tmp>', values.tmp)
    .replaceAll('<baseCommit>', values.baseCommit)
    .replaceAll('<patch>', values.patch);
  const [program, ...args] = line.split(' ');
  try {
    const { stdout, stderr } = await exec(program!, args, { maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

/** The fenced block under the runbook heading, as its command lines (comments and blanks dropped). */
async function documentedCommands(): Promise<readonly string[]> {
  const page = await fs.readFile(RUNBOOK, 'utf8');
  const heading = page.search(new RegExp(`^#{2,4} ${SECTION}\\s*$`, 'm'));
  expect(heading, `the page has no "${SECTION}" section`).toBeGreaterThanOrEqual(0);
  const rest = page.slice(heading);
  const fenced = /```(?:bash|sh|shell)?\n([\s\S]*?)```/.exec(rest);
  expect(fenced, 'the section has no fenced command block').not.toBeNull();
  return fenced![1]!
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

let scratch: string;
let h: CheckpointHarness;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-runbook-'));
  h = await makeCheckpointHarness();
});

afterEach(async () => {
  await h.dispose();
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('the page and the test agree on the commands (doc-sync)', () => {
  it('holds exactly the commands this test runs, in order', async () => {
    expect(await documentedCommands()).toEqual(ORDER);
  });

  it('says it is the exception to "no automated end-to-end test"', async () => {
    const page = await fs.readFile(RUNBOOK, 'utf8');
    expect(page).toContain(SECTION);
    expect(page).toContain('manual-restore-runbook.test.ts');
  });

  it('never tells the operator to use git worktree for the target', async () => {
    const commands = await documentedCommands();
    expect(commands.some((command) => command.includes('worktree'))).toBe(false);
  });
});

/** Follow the runbook for a normal repository: clone, check out the base, check, apply. */
async function followRunbook(
  workspace: string,
  baseCommit: string,
  patchText: string
): Promise<{ tmp: string; checked: number; applied: number }> {
  const tmp = path.join(scratch, `restore-${Math.random().toString(16).slice(2)}`);
  const patch = path.join(scratch, `restore-${Math.random().toString(16).slice(2)}.patch`);
  await fs.writeFile(patch, patchText, 'utf8');
  const values: Placeholders = { workspace, tmp, baseCommit, patch };
  expect((await runLine(COMMANDS.clone, values)).code).toBe(0);
  expect((await runLine(COMMANDS.checkout, values)).code).toBe(0);
  const checked = (await runLine(COMMANDS.check, values)).code;
  const applied = checked === 0 ? (await runLine(COMMANDS.apply, values)).code : -1;
  return { tmp, checked, applied };
}

const read = (root: string, relative: string): Promise<Buffer> => fs.readFile(path.join(root, relative));

describe('each SC-006 case: the record matches what the runbook restores', () => {
  it('tracked only, with a binary file: complete, and every byte comes back', async () => {
    const a = h.run('run-a');
    const binary = Buffer.from([0, 1, 2, 3, 255, 254, 0, 9, 8, 7]);
    await h.write('edited.txt', 'the tracked edit\n');
    await fs.writeFile(path.join(h.workspaceRoot, 'blob.bin'), binary);
    await exec('git', ['add', '-A'], { cwd: h.workspaceRoot });

    await h.service().checkpoint(a, 'speckit-implement');
    const manifest = (await onlyMetadata(h, 'run-a'))!;
    const restored = await followRunbook(h.workspaceRoot, manifest.baseCommit as string, (await onlyPatch(h, 'run-a'))!);

    expect(manifest.completeness).toBe('complete');
    expect([restored.checked, restored.applied]).toEqual([0, 0]);
    expect((await read(restored.tmp, 'edited.txt')).toString()).toBe('the tracked edit\n');
    expect((await read(restored.tmp, 'blob.bin')).equals(binary)).toBe(true);
  });

  it('tracked plus untracked: incomplete, the tracked bytes return and the untracked file does not', async () => {
    const a = h.run('run-a');
    await h.write('edited.txt', 'the tracked edit\n');
    await fs.writeFile(path.join(h.workspaceRoot, 'left-behind.txt'), 'never captured\n');

    await h.service().checkpoint(a, 'speckit-implement');
    const manifest = (await onlyMetadata(h, 'run-a'))!;
    const restored = await followRunbook(h.workspaceRoot, manifest.baseCommit as string, (await onlyPatch(h, 'run-a'))!);

    expect(manifest.completeness).toBe('incomplete');
    expect(manifest.excludedUntracked).toEqual(['left-behind.txt']);
    expect((await read(restored.tmp, 'edited.txt')).toString()).toBe('the tracked edit\n');
    await expect(read(restored.tmp, 'left-behind.txt')).rejects.toThrow();
  });

  it('untracked only: incomplete, an empty patch, and nothing to restore', async () => {
    const a = h.run('run-a');
    await fs.writeFile(path.join(h.workspaceRoot, 'only.txt'), 'never captured\n');

    await h.service().checkpoint(a, 'speckit-implement');
    const manifest = (await onlyMetadata(h, 'run-a'))!;

    expect(manifest.completeness).toBe('incomplete');
    expect(manifest.excludedUntracked).toEqual(['only.txt']);
    // The page tells the operator an empty patch applies nothing; the file is listed, not saved.
    expect(await onlyPatch(h, 'run-a')).toBe('');
  });

  it('staged then edited: the worktree bytes come back, not the staged ones', async () => {
    const a = h.run('run-a');
    await h.write('staged.txt', 'staged version\n');
    await fs.writeFile(path.join(h.workspaceRoot, 'staged.txt'), 'edited after staging\n');

    await h.service().checkpoint(a, 'speckit-implement');
    const manifest = (await onlyMetadata(h, 'run-a'))!;
    const restored = await followRunbook(h.workspaceRoot, manifest.baseCommit as string, (await onlyPatch(h, 'run-a'))!);

    expect(manifest.completeness).toBe('complete');
    expect((await read(restored.tmp, 'staged.txt')).toString()).toBe('edited after staging\n');
  });

  it('an unborn HEAD: the empty-repository branch of the runbook', async () => {
    const root = path.join(scratch, 'unborn-workspace');
    const storage = path.join(scratch, 'unborn-storage');
    await fs.mkdir(root, { recursive: true });
    await exec('git', ['init', '-q'], { cwd: root });
    await fs.writeFile(path.join(root, 'first.txt'), 'the first file\n');
    await exec('git', ['add', '-A'], { cwd: root });
    const service = new RunCheckpointService(
      storage,
      root,
      { warn: () => undefined } as unknown as SanitizedLogger,
      () => 1,
      new RunMutationLedger({ readDiff: async () => '', listInFlightRunIds: () => [], workspaceRoot: root })
    );

    await service.checkpoint({ id: 'run-unborn', status: 'running' } as unknown as WorkflowRun, 'speckit-implement');

    const dir = path.join(storage, 'checkpoints', 'run-unborn');
    const names = await fs.readdir(dir);
    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, names.find((name) => name.endsWith('.json'))!), 'utf8')
    ) as Record<string, unknown>;
    const patch = path.join(dir, names.find((name) => name.endsWith('.patch'))!);
    const tmp = path.join(scratch, 'restore-unborn');
    const values: Placeholders = { workspace: root, tmp, baseCommit: String(manifest.baseCommit), patch };

    expect((await runLine(COMMANDS.init, values)).code).toBe(0);
    expect((await runLine(COMMANDS.check, values)).code).toBe(0);
    expect((await runLine(COMMANDS.apply, values)).code).toBe(0);
    expect((await read(tmp, 'first.txt')).toString()).toBe('the first file\n');
  });

  it('two concurrent Runs: the scoped record restores this Run\'s paths and no sibling\'s', async () => {
    const a = h.run('run-a');
    const b = h.run('run-b');
    await h.phase(a, () => h.write('mine/a.txt', 'written by run-a\n'));
    await h.phase(b, () => h.write('theirs/b.txt', 'written by run-b\n'));

    await h.service().checkpoint(a, 'speckit-implement');
    const manifest = (await onlyMetadata(h, 'run-a'))!;
    const restored = await followRunbook(h.workspaceRoot, manifest.baseCommit as string, (await onlyPatch(h, 'run-a'))!);

    expect(manifest.attribution).toMatchObject({ mode: 'scoped' });
    expect((await read(restored.tmp, 'mine/a.txt')).toString()).toBe('written by run-a\n');
    await expect(read(restored.tmp, 'theirs/b.txt')).rejects.toThrow();
  });
});

describe('a conflicting target (K4 points 3 and 4, FR-029)', () => {
  it('fails the pre-apply check, applies nothing, and --reject leaves a .rej for the conflict', async () => {
    const a = h.run('run-a');
    await h.write('shared.txt', 'line one\n');
    await h.commitAll('seed shared');
    await h.write('shared.txt', 'line one\nline two from the checkpoint\n');
    await h.service().checkpoint(a, 'speckit-implement');
    const manifest = (await onlyMetadata(h, 'run-a'))!;
    const patchText = (await onlyPatch(h, 'run-a'))!;
    // The target holds a different edit to the same lines the patch changes.
    const tmp = path.join(scratch, 'restore-conflict');
    const patch = path.join(scratch, 'conflict.patch');
    await fs.writeFile(patch, patchText, 'utf8');
    const values: Placeholders = {
      workspace: h.workspaceRoot,
      tmp,
      baseCommit: manifest.baseCommit as string,
      patch
    };
    expect((await runLine(COMMANDS.clone, values)).code).toBe(0);
    expect((await runLine(COMMANDS.checkout, values)).code).toBe(0);
    await fs.writeFile(path.join(tmp, 'shared.txt'), 'line one\nA different second line\n');

    const checked = await runLine(COMMANDS.check, values);

    expect(checked.code).not.toBe(0);
    expect((await read(tmp, 'shared.txt')).toString()).toBe('line one\nA different second line\n');

    const rejected = await runLine(COMMANDS.reject, values);
    expect(rejected.code).not.toBe(0);
    await expect(read(tmp, 'shared.txt.rej')).resolves.toBeInstanceOf(Buffer);
  });
});

describe('--3way, the runbook\'s step for a target that has moved on (K4 point 4)', () => {
  const BASE = 'one\ntwo\nthree\nfour\nfive\n';

  /** A checkpoint that appends `six`, a clone at its base, and a commit in the clone on top. */
  async function movedOnTarget(edit: (text: string) => string): Promise<{ values: Placeholders; file: string }> {
    const a = h.run('run-a');
    await h.write('shared.txt', BASE);
    await h.commitAll('seed shared');
    await h.write('shared.txt', `${BASE}six\n`);
    await h.service().checkpoint(a, 'speckit-implement');
    const manifest = (await onlyMetadata(h, 'run-a'))!;
    const patch = path.join(scratch, 'moved-on.patch');
    await fs.writeFile(patch, (await onlyPatch(h, 'run-a'))!, 'utf8');
    const tmp = path.join(scratch, 'restore-moved-on');
    const values: Placeholders = {
      workspace: h.workspaceRoot,
      tmp,
      baseCommit: manifest.baseCommit as string,
      patch
    };
    expect((await runLine(COMMANDS.clone, values)).code).toBe(0);
    expect((await runLine(COMMANDS.checkout, values)).code).toBe(0);
    const file = path.join(tmp, 'shared.txt');
    await fs.writeFile(file, edit(BASE), 'utf8');
    // `--3way` implies `--index`, so the target's own change must be committed first.
    await exec('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-C', tmp, 'commit', '-qam', 'moved on']);
    return { values, file };
  }

  it('merges where the plain check fails on context, and keeps both edits', async () => {
    const { values, file } = await movedOnTarget((text) => text.replace('four', 'FOUR'));

    expect((await runLine(COMMANDS.check, values)).code).not.toBe(0);
    expect((await runLine(COMMANDS.threeWay, values)).code).toBe(0);

    expect((await fs.readFile(file, 'utf8'))).toBe('one\ntwo\nthree\nFOUR\nfive\nsix\n');
  });

  it('leaves conflict markers, and a non-zero exit, where the edits meet', async () => {
    const { values, file } = await movedOnTarget((text) => text.replace('five', 'FIVE'));

    const result = await runLine(COMMANDS.threeWay, values);

    expect(result.code).not.toBe(0);
    expect(await fs.readFile(file, 'utf8')).toContain('<<<<<<<');
  });
});
