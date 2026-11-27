import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * FR-R4-F09 (DP3; contract test T13) -- the temporary-repository harness of the secret-scan tests,
 * shared by two files. FR-R4-F10 (contract T2; TA2) extends it for staged mode and the hook.
 *
 * It lived inside `secret-scan-outcomes.test.ts`, which uses it to prove the scan reports what it
 * was given. `secret-scan-corpus.test.ts` needs the same harness to plant a value in a repository
 * and run the configured scan over it, and two copies would let the tests drift in how they build a
 * repository and invoke the scan: a corpus that passed under one harness and not the other would
 * prove nothing about the scan. So the harness moved here unchanged, exported, and both files
 * import it.
 *
 * The scan finds its root from its own location, so each sandbox copies it, the modules it imports
 * and this repository's configuration into a fresh repository, and links this tree's
 * `node_modules` for the engine. Every file is written under the run's temp root.
 *
 * FR-R4-F10 options. A caller that passes none gets the sandbox it always got: the configuration is
 * copied but not tracked, and no ignore list or hook is present. `stageConfig` also copies
 * `.secretlintignore` and tracks both files, because staged mode reads them from the index.
 * `hooks` copies the pre-commit hook with mode 0755, tracks it, and points `core.hooksPath` at it.
 */
export const REPO_ROOT = resolve(__dirname, '..', '..', '..');
export const SCRIPTS = [
  'scan-secrets.mjs',
  'invoked-as-script.mjs',
  'secret-scan-staged.mjs',
  'secretlint-rule-schegent.mjs'
];
// Engine start-up dominates a run; a hung child fails the case instead of the suite.
export const CHILD_TIMEOUT_MS = 30_000;

const HOOK_PATH = join('scripts', 'hooks', 'pre-commit');
const roots: string[] = [];

/** Options of `sandbox`. Every one is off by default, which reproduces the original sandbox. */
export interface SandboxOptions {
  /** Copy `.secretlintignore` beside `.secretlintrc.json` and track both. */
  readonly stageConfig?: boolean;
  /** Copy, track and activate `scripts/hooks/pre-commit` (mode 0755). */
  readonly hooks?: boolean;
}

export function git(root: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' });
}

/** The standard output of a git command in `root`, as bytes. Throws on a non-zero exit. */
export function gitOut(root: string, ...args: string[]): Buffer {
  return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A repository holding a copy of the scan, tracking `files` and nothing else (unless opted in). */
export function sandbox(files: Record<string, string>, options: SandboxOptions = {}): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'secret-scan-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'));
  for (const script of SCRIPTS) {
    copyFileSync(join(REPO_ROOT, 'scripts', script), join(root, 'scripts', script));
  }
  copyFileSync(join(REPO_ROOT, '.secretlintrc.json'), join(root, '.secretlintrc.json'));
  if (options.stageConfig === true) {
    copyFileSync(join(REPO_ROOT, '.secretlintignore'), join(root, '.secretlintignore'));
  }
  if (options.hooks === true) {
    mkdirSync(join(root, 'scripts', 'hooks'), { recursive: true });
    copyFileSync(join(REPO_ROOT, HOOK_PATH), join(root, HOOK_PATH));
    chmodSync(join(root, HOOK_PATH), 0o755);
  }
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  git(root, 'init', '--quiet');
  // Set here rather than inherited, so the case does not turn on the developer's own config.
  git(root, 'config', 'core.quotePath', 'true');
  git(root, 'config', 'user.name', 'Secret Scan Harness');
  git(root, 'config', 'user.email', 'harness@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), contents);
  }
  const names = Object.keys(files);
  if (names.length > 0) git(root, 'add', '--', ...names);
  if (options.stageConfig === true) git(root, 'add', '--', '.secretlintrc.json', '.secretlintignore');
  if (options.hooks === true) {
    git(root, 'add', '--', HOOK_PATH);
    git(root, 'config', 'core.hooksPath', join('scripts', 'hooks'));
  }
  return root;
}

/**
 * FR-R4-F10 (SS5) -- an engine package that will not load, in one sandbox only. The link to this
 * tree's `node_modules` is replaced by a directory holding a stub of `@secretlint/node`; resolution
 * reaches the nearest `node_modules` first, so the scan imports the stub. `entry` is the text of the
 * stub's entry file, and `null` leaves that file out, so the package names an entry that is not
 * there. Both are an engine that will not load, as a damaged install is; a package that is absent
 * altogether cannot be built here, because a sandbox under this repository's temporary root would
 * find this tree's copy by walking up.
 */
export function replaceEngineWithUnloadable(root: string, entry: string | null): void {
  unlinkSync(join(root, 'node_modules'));
  const packageDirectory = join(root, 'node_modules', '@secretlint', 'node');
  mkdirSync(packageDirectory, { recursive: true });
  const manifest = { name: '@secretlint/node', version: '0.0.0', type: 'module', exports: './index.js' };
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify(manifest));
  if (entry !== null) writeFileSync(join(packageDirectory, 'index.js'), entry);
}

/** Run the scan copied into `root`. `args` is `['--staged']` for staged mode; `env` is merged over the process's. */
export function scan(root: string, args: ReadonlyArray<string> = [], env?: Record<string, string>) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'scan-secrets.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    ...(env === undefined ? {} : { env: { ...process.env, ...env } })
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** Run `git commit <args>` in `root`, so a hook configured there runs. */
export function commit(root: string, args: ReadonlyArray<string>, env?: Record<string, string>) {
  const result = spawnSync('git', ['commit', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    ...(env === undefined ? {} : { env: { ...process.env, ...env } })
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** Remove every sandbox made since the last call. A test file calls it from `afterEach`. */
export function removeSandboxes(): void {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
}
