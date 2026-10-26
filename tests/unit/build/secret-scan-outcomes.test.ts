import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The secret scan reads every file it is given, prints no value it finds, and refuses a run
 * that has nothing to read.
 *
 * Three findings of the feature-229 security review (S4, S5 and R3-02; the envelope's
 * `docs/features/round_3/INDEX.md` section 24 records where each went), each a way
 * `scripts/scan-secrets.mjs` reported less than it was given:
 *
 * - S4. `git ls-files` without `-z` quotes a name that holds a byte outside printable ASCII, a
 *   double quote or a backslash. The quoted form names no file on disk, so the scan counted the
 *   file absent, never read it, and passed.
 * - S5. secretlint's type declarations say masking is the default, and its core reads
 *   `maskSecrets ?? false`, so a report line carried the matched value to the terminal and to
 *   any log that keeps it.
 * - R3-02. With no file to scan it printed `secretlint over 0 tracked file(s)` and exited 0.
 *   Outside a repository of its own, such as an archive unpacked inside a repository that does
 *   not track it, `git ls-files` exits 0 and prints nothing.
 *
 * The scan finds its root from its own location, so each case copies it, the module it imports
 * and this repository's configuration into a fresh repository, and links this tree's
 * `node_modules` for the engine. Every file is written under the run's temp root. The planted
 * token is assembled at run time, so this file holds no value for the repository's own scan to
 * report.
 */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPTS = ['scan-secrets.mjs', 'invoked-as-script.mjs'];
// Engine start-up dominates a run; a hung child fails the case instead of the suite.
const CHILD_TIMEOUT_MS = 30_000;

// The part of the token a partial mask would still show.
const TOKEN_TAIL = 'Zq3K8vR2mN7pL4wT9yB6cD1f';
const PLANTED_TOKEN = ['xo', 'xb-', '1234567890-', '1234567890-', TOKEN_TAIL].join('');
// Outside printable ASCII, so `git ls-files` quotes it when `core.quotePath` is on, its default.
const QUOTED_NAME = 'café-notes.txt';

const roots: string[] = [];

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' });
}

/** A repository holding a copy of the scan, tracking `files` and nothing else. */
function sandbox(files: Record<string, string>): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'secret-scan-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'));
  for (const script of SCRIPTS) {
    copyFileSync(join(REPO_ROOT, 'scripts', script), join(root, 'scripts', script));
  }
  copyFileSync(join(REPO_ROOT, '.secretlintrc.json'), join(root, '.secretlintrc.json'));
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  git(root, 'init', '--quiet');
  // Set here rather than inherited, so the case does not turn on the developer's own config.
  git(root, 'config', 'core.quotePath', 'true');
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents);
  const names = Object.keys(files);
  if (names.length > 0) git(root, 'add', '--', ...names);
  return root;
}

function scan(root: string) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'scan-secrets.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe('the secret scan reports what it was given', () => {
  it('passes a clean tree and prints the scope it read', () => {
    // The control: the copied scan runs, and a pass names its file count.
    const { status, out } = scan(sandbox({ 'clean.txt': 'nothing to see\n' }));
    expect(status, out).toBe(0);
    expect(out).toContain('Secret scan: secretlint over 1 tracked file(s)');
  });

  it('reads a file whose name git quotes (S4)', () => {
    const root = sandbox({
      'clean.txt': 'nothing to see\n',
      [QUOTED_NAME]: `token = "${PLANTED_TOKEN}"\n`
    });
    const { status, out } = scan(root);
    expect(status, `a token in ${QUOTED_NAME} must fail the scan. Got: ${out}`).toBe(1);
    expect(out).toContain(QUOTED_NAME);
    expect(out).toContain('secretlint over 2 tracked file(s)');
    expect(out).not.toContain('absent from disk');
  });

  it('names the rule and the place of a finding, never its value (S5)', () => {
    const { status, out } = scan(sandbox({ 'leak.txt': `token = "${PLANTED_TOKEN}"\n` }));
    expect(status, out).toBe(1);
    expect(out).toContain('leak.txt');
    expect(out).toContain('SLACK_TOKEN');
    expect(out).not.toContain(TOKEN_TAIL);
  });

  it('refuses a tree with no tracked file instead of passing over nothing (R3-02)', () => {
    const { status, out } = scan(sandbox({}));
    expect(status, out).toBe(1);
    expect(out).toContain('Secret scan cannot run: no tracked file to scan');
    expect(out).not.toContain('secretlint over 0 tracked file(s)');
  });
});
