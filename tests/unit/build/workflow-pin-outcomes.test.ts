import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * FR-R3-100 (FR-019) — the pin gate's three outcomes, all three observed.
 *
 * `check-workflow-pins.mjs` stayed in the attested chain after FR-R3-099 deleted
 * every workflow, and that only makes sense if it can say which of three things
 * happened. Before this test it could not: an absent directory threw ENOENT and
 * failed the whole chain, and an empty one printed "check passed" -- the same
 * words as a real pass over real files.
 *
 * Both of those are the vacuity defect FR-R3-088 measured, so they are pinned
 * here rather than left to whoever next reads the script. The absent-directory
 * case is the one this repository is actually in, which is exactly why it is the
 * one most likely to go unexercised.
 *
 * The script reads a relative path, so each case runs it in its own temporary
 * cwd. Nothing is written inside the repository.
 */
const SCRIPT = resolve(__dirname, '../../../scripts/check-workflow-pins.mjs');
const PINNED_SHA = 'a'.repeat(40);

const dirs: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pin-outcomes-'));
  dirs.push(dir);
  return dir;
}

function run(cwd: string) {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('the workflow pin gate says which of three things happened', () => {
  it('treats an absent workflow directory as nothing to pin, not as a pass and not as a crash', () => {
    const { status, out } = run(sandbox());
    expect(status, `an absent .github/workflows must not fail the gate chain. Got: ${out}`).toBe(0);
    expect(out).toContain('no workflows present, nothing to pin');
    // The distinction is the whole point: it must NOT claim to have passed a check.
    expect(out).not.toContain('pin check passed');
  });

  it('treats an empty workflow directory as nothing to pin, distinctly from a pass', () => {
    const dir = sandbox();
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    const { status, out } = run(dir);
    expect(status).toBe(0);
    expect(out).toContain('no workflows present, nothing to pin');
    expect(out).not.toContain('pin check passed');
  });

  it('passes over pinned references and prints the count, so the scope is declared', () => {
    const dir = sandbox();
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    writeFileSync(
      join(dir, '.github/workflows/ci.yml'),
      `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${PINNED_SHA}\n`
    );
    const { status, out } = run(dir);
    expect(status).toBe(0);
    expect(out).toContain('1 workflow(s), all pinned');
  });

  it('refuses a tag-pinned reference, naming file, line and reference', () => {
    const dir = sandbox();
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    writeFileSync(
      join(dir, '.github/workflows/ci.yml'),
      'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n'
    );
    const { status, out } = run(dir);
    expect(status).toBe(1);
    expect(out).toContain('.github/workflows/ci.yml:4');
    expect(out).toContain('actions/checkout@v4');
  });

  it('ignores local composite actions, which carry no SHA to pin', () => {
    const dir = sandbox();
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    writeFileSync(
      join(dir, '.github/workflows/ci.yml'),
      'jobs:\n  a:\n    steps:\n      - uses: ./.github/actions/setup@main\n'
    );
    expect(run(dir).status).toBe(0);
  });

  it('refuses when the directory cannot be read for any reason other than absence', () => {
    const dir = sandbox();
    // A file where the directory should be: readdir fails with ENOTDIR, which is
    // unanswerable rather than empty. An unanswerable check is a refusal.
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(join(dir, '.github/workflows'), 'not a directory');
    const { status, out } = run(dir);
    expect(status).toBe(1);
    expect(out).toContain('could not read');
  });
});
