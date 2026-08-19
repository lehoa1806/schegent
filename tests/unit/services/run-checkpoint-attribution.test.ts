// FR-R3-004 (T315) — a checkpoint taken with three Runs in flight contains that
// Run's changes and no sibling's.
//
// This is the scenario feature 093 could only decline. What makes it decidable
// now is that each phase declares what it wrote: `harness.phase(run, …)` is the
// driver's bracket by hand, and the report it closes with is the audit record's
// `files_created`/`files_modified`/`files_deleted`. The whole-tree diff read at
// each window edge is the *check* on that declaration, not the source of it —
// a section nobody claimed makes the checkpoint decline.
//
// Driven against a real temporary git repository. The property under test is
// which bytes land in a `.patch`, and a stubbed `execFile` would only assert
// that the stub returned what the stub was told to return.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  git,
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

describe('RunCheckpointService — attribution under concurrency (T315, FR-R3-004)', () => {
  it('writes a patch holding this Run s changes and no sibling s', async () => {
    const a = h.run('run-a');
    const b = h.run('run-b');
    const c = h.run('run-c');
    expect(h.live.size).toBe(3);

    await h.phase(a, () => h.write('a.txt', 'written by run-a\n'));
    await h.phase(b, () => h.write('b.txt', 'written by run-b\n'));
    await h.phase(c, () => h.write('c.txt', 'written by run-c\n'));

    await h.service().checkpoint(a, 'speckit-implement');

    const patch = await onlyPatch(h, 'run-a');
    expect(patch).not.toBeNull();
    expect(patch).toContain('written by run-a');
    expect(patch).not.toContain('written by run-b');
    expect(patch).not.toContain('written by run-c');
    // And the sibling's *file* is absent too, not merely its content: a header
    // with an empty body would still be a claim on someone else's path.
    expect(patch).not.toContain('b/b.txt');
    expect(patch).not.toContain('b/c.txt');
    expect(h.warnings).toEqual([]);
  });

  it('records the base commit and the attribution mode beside the patch', async () => {
    const a = h.run('run-a');
    await h.idlePhase(h.run('run-b'));
    await h.phase(a, () => h.write('a.txt', 'written by run-a\n'));

    const base = await h.head();
    await h.service().checkpoint(a, 'speckit-implement');

    const metadata = await onlyMetadata(h, 'run-a');
    expect(metadata).toMatchObject({
      runId: 'run-a',
      phaseId: 'speckit-implement',
      // T314 — a scoped patch is a subset of a tree that keeps moving, so
      // "apply it to whatever is checked out" was never a safe instruction.
      baseCommit: base
    });
    expect(metadata!.attribution).toMatchObject({
      mode: 'no-sibling-work-present',
      inFlightRuns: 2
    });
  });

  it('applies cleanly to the recorded base commit', async () => {
    // The acceptance scenario an operator actually performs: check out the base
    // the metadata names, apply the patch by hand, and get that Run's work back
    // without a sibling's.
    const a = h.run('run-a');
    const b = h.run('run-b');
    await h.phase(a, () => h.write('shared/a.txt', 'written by run-a\n'));
    await h.phase(b, () => h.write('shared/b.txt', 'written by run-b\n'));

    await h.service().checkpoint(a, 'speckit-implement');
    const metadata = await onlyMetadata(h, 'run-a');
    const patch = (await onlyPatch(h, 'run-a'))!;
    expect(metadata!.attribution).toMatchObject({ mode: 'scoped' });

    const clone = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-attr-apply-'));
    const patchFile = path.join(clone, 'restore.patch');
    await git('git', ['clone', '-q', h.workspaceRoot, path.join(clone, 'repo')]);
    const applyRoot = path.join(clone, 'repo');
    await git('git', ['checkout', '-q', metadata!.baseCommit as string], { cwd: applyRoot });
    await fs.writeFile(patchFile, patch, 'utf8');

    await expect(git('git', ['apply', patchFile], { cwd: applyRoot })).resolves.toBeDefined();
    expect(await fs.readFile(path.join(applyRoot, 'shared', 'a.txt'), 'utf8')).toBe(
      'written by run-a\n'
    );
    await expect(fs.readFile(path.join(applyRoot, 'shared', 'b.txt'), 'utf8')).rejects.toThrow();
    await fs.rm(clone, { recursive: true, force: true });
  });

  it('attributes a second write to a file that was already dirty', async () => {
    // A path the operator had already dirtied, written into again by a Run. It is
    // in the baseline *and* in this Run's declaration, and it stays in the patch:
    // `git diff HEAD` renders both edits as one set of hunks that cannot be
    // split, so dropping it because it was pre-dirty would drop this Run's own
    // work. It is nobody else's work either way.
    await h.write('shared.txt', 'first line\n');
    await h.commitAll('seed');
    await h.write('shared.txt', 'first line\nfrom the operator\n');

    const a = h.run('run-a');
    await h.idlePhase(h.run('run-b'));
    await h.phase(a, () => h.write('shared.txt', 'first line\nfrom the operator\nfrom run-a\n'));

    await h.service().checkpoint(a, 'speckit-implement');
    const patch = await onlyPatch(h, 'run-a');
    expect(patch).toContain('from run-a');
  });

  it('writes the whole tree when no sibling has touched it', async () => {
    // Several Runs in flight but only one holding work: the whole-tree diff *is*
    // that Run's diff, so it is written whole rather than reconstructed.
    const a = h.run('run-a');
    await h.idlePhase(h.run('run-b'));
    await h.idlePhase(h.run('run-c'));
    await h.phase(a, () => h.write('a.txt', 'written by run-a\n'));

    await h.service().checkpoint(a, 'speckit-implement');

    const metadata = await onlyMetadata(h, 'run-a');
    expect(metadata!.attribution).toMatchObject({ mode: 'no-sibling-work-present' });
    const patch = (await onlyPatch(h, 'run-a'))!;
    const whole = (
      await git('git', ['diff', '--binary', '--no-ext-diff', 'HEAD'], { cwd: h.workspaceRoot })
    ).stdout;
    expect(patch).toBe(whole);
  });

  it('ignores a declared path that names somewhere outside the workspace', async () => {
    // Declared paths come from CLI stdout, which is operator-influenced, so a
    // record can name anywhere at all. Canonicalisation is lexical and drops
    // anything that does not resolve inside the workspace — nothing here opens a
    // declared path, and an escaping one simply matches no section git printed.
    const a = h.run('run-a');
    const b = h.run('run-b');
    await h.phase(a, () => h.write('a.txt', 'written by run-a\n'), [
      'a.txt',
      '../../etc/hosts',
      '/etc/hosts'
    ]);
    await h.phase(b, () => h.write('b.txt', 'written by run-b\n'));

    await h.service().checkpoint(a, 'speckit-implement');

    const metadata = await onlyMetadata(h, 'run-a');
    expect(metadata!.attribution).toMatchObject({ mode: 'scoped', paths: ['a.txt'] });
    const patch = (await onlyPatch(h, 'run-a'))!;
    expect(patch).toContain('written by run-a');
    expect(patch).not.toContain('hosts');
  });

  it('leaves a terminated Run s uncommitted work out of a sibling s patch', async () => {
    // A failed or cancelled Run's edits do not leave the tree with it. They stop
    // being any live Run's, but they never become this Run's — so they are
    // excluded from the scoped patch *and* they block the whole-tree shortcut.
    //
    // Two Runs stay live on purpose. Drop to one and the `inFlight <= 1`
    // bypass takes over and writes the whole tree, leftovers included — which is
    // exactly what the sole-run path does today and what the requirement pins as
    // unchanged.
    const a = h.run('run-a');
    const dead = h.run('run-dead');
    await h.idlePhase(h.run('run-b'));
    await h.phase(dead, () => h.write('dead.txt', 'written by run-dead\n'));
    await h.phase(a, () => h.write('a.txt', 'written by run-a\n'));
    h.live.delete(dead.id);
    expect(h.live.size).toBe(2);

    await h.service().checkpoint(a, 'speckit-implement');

    const patch = await onlyPatch(h, 'run-a');
    expect(patch).toContain('written by run-a');
    expect(patch).not.toContain('written by run-dead');
    expect((await onlyMetadata(h, 'run-a'))!.attribution).toMatchObject({ mode: 'scoped' });
  });
});
