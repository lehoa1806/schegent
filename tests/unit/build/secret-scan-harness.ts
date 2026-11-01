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

/**
 * FR-R4-F09 (DP3; contract test T13) -- the temporary-repository harness of the secret-scan tests,
 * shared by two files.
 *
 * It lived inside `secret-scan-outcomes.test.ts`, which uses it to prove the scan reports what it
 * was given. `secret-scan-corpus.test.ts` needs the same harness to plant a value in a repository
 * and run the configured scan over it, and two copies would let the tests drift in how they build a
 * repository and invoke the scan: a corpus that passed under one harness and not the other would
 * prove nothing about the scan. So the harness moved here unchanged, exported, and both files
 * import it.
 *
 * The scan finds its root from its own location, so each sandbox copies it, the module it imports
 * and this repository's configuration into a fresh repository, and links this tree's
 * `node_modules` for the engine. Every file is written under the run's temp root.
 */
export const REPO_ROOT = resolve(__dirname, '..', '..', '..');
export const SCRIPTS = ['scan-secrets.mjs', 'invoked-as-script.mjs'];
// Engine start-up dominates a run; a hung child fails the case instead of the suite.
export const CHILD_TIMEOUT_MS = 30_000;

const roots: string[] = [];

export function git(root: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' });
}

/** A repository holding a copy of the scan, tracking `files` and nothing else. */
export function sandbox(files: Record<string, string>): string {
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

export function scan(root: string) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'scan-secrets.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** Remove every sandbox made since the last call. A test file calls it from `afterEach`. */
export function removeSandboxes(): void {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
}
