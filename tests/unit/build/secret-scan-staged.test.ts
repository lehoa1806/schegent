import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PLANTED } from '../../fixtures/secret-scan-corpus';
import { commit, git, removeSandboxes, replaceEngineWithUnloadable, sandbox, scan } from './secret-scan-harness';

/**
 * FR-R4-F10 (contract test T3; SS2 to SS6; FR-008 to FR-013; SC-002, SC-003) -- the staged scan
 * judges the bytes a commit carries, and answers with one of four named outcomes.
 *
 * WHAT IT PINS. The reproduced hole: `scan-secrets.mjs` reads the working tree, so a secret staged
 * and then edited out of the working copy is committed and the scan stays green. Each case here
 * builds a temporary repository with the harness, stages a change, and runs the copied scan with
 * `--staged`. The value is the corpus's synthetic Slack token, assembled at call time, so this file
 * holds no token for the repository's own scan to report.
 *
 * Two invariants hold for EVERY case, not only the ones named after them. `stagedScan` checks that
 * the index, `git ls-files -s`, `git status` and the stash are unchanged by the scan (SS6), that no
 * `schegent-staged-scan-*` directory is left in the case's private `TMPDIR` (SS4, tasks TA9), and
 * that no output line holds that directory's path.
 */
const SLACK = PLANTED.find((planted) => planted.family === 'slack');
if (SLACK === undefined) throw new Error('the corpus has no slack case');
const SLACK_VALUE = SLACK.build();
const SLACK_RULE = 'secretlint-rule-slack';
const STAGED_DIRECTORY_PREFIX = 'schegent-staged-scan-';
const LEAK_FILE = 'leak.txt';

const tempDirs: string[] = [];

afterEach(() => {
  removeSandboxes();
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

/** Words long enough to be a value, split at the characters a line puts around one. */
function valueWords(text: string): string[] {
  return text.split(/[\s"'=,]+/).filter((word) => word.length >= 12);
}

function privateTmp(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'staged-tmp-'));
  tempDirs.push(dir);
  return dir;
}

function readOnlyGit(root: string, ...args: string[]): Buffer {
  return execFileSync('git', args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  });
}

interface Snapshot {
  readonly index: Buffer;
  readonly staged: string;
  readonly status: string;
  readonly stash: string;
}

/** Everything SS6 says a staged scan must leave alone, read without taking a lock. */
function snapshot(root: string): Snapshot {
  const indexPath = join(root, '.git', 'index');
  return {
    index: existsSync(indexPath) ? readFileSync(indexPath) : Buffer.alloc(0),
    staged: readOnlyGit(root, 'ls-files', '-s').toString('utf8'),
    status: readOnlyGit(root, 'status', '--porcelain=v2', '-z').toString('latin1'),
    stash: readOnlyGit(root, 'stash', 'list').toString('utf8')
  };
}

function stagedDirectoriesIn(tmp: string): string[] {
  return readdirSync(tmp).filter((name) => name.startsWith(STAGED_DIRECTORY_PREFIX));
}

/** Run `scan --staged` in a repository, asserting SS6 and SS4 around it. */
function stagedScan(root: string, env: Record<string, string> = {}) {
  const tmp = privateTmp();
  const before = snapshot(root);
  const result = scan(root, ['--staged'], { TMPDIR: tmp, ...env });
  const after = snapshot(root);
  expect(after.index.equals(before.index), 'the scan changed .git/index').toBe(true);
  expect(after.staged, 'the scan changed git ls-files -s').toBe(before.staged);
  expect(after.status, 'the scan changed git status').toBe(before.status);
  expect(after.stash, 'the scan changed the stash').toBe('');
  expect(stagedDirectoriesIn(tmp), 'a temporary scan directory was left behind').toEqual([]);
  expect(result.out, 'an output line holds the temporary directory path').not.toContain(tmp);
  expect(result.out).not.toContain(STAGED_DIRECTORY_PREFIX);
  return result;
}

/** A repository with a base commit holding `files` and the staged configuration. */
function baseRepository(files: Record<string, string>): string {
  const root = sandbox(files, { stageConfig: true });
  const made = commit(root, ['-m', 'base']);
  expect(made.status, made.out).toBe(0);
  return root;
}

function stage(root: string, name: string, text: string): void {
  mkdirSync(join(root, name, '..'), { recursive: true });
  writeFileSync(join(root, name), text);
  git(root, 'add', '--', name);
}

function expectFinding(result: { status: number | null; out: string }, file: string, rule = SLACK_RULE): void {
  expect(result.status, result.out).toBe(1);
  expect(result.out).toContain('Secret scan (staged): FINDING');
  expect(result.out).toContain(rule);
  expect(result.out).toContain(file);
  expect(result.out).not.toContain('passed');
  const words = valueWords(SLACK_VALUE);
  expect(words.length, 'the masking check needs something to look for').toBeGreaterThan(0);
  for (const word of words) expect(result.out, 'a part of the value reached the report').not.toContain(word);
}

function expectRefusal(result: { status: number | null; out: string }, cause: string): void {
  expect(result.status, result.out).toBe(1);
  expect(result.out).toContain(`cannot run: ${cause}`);
  expect(result.out).not.toContain('passed');
}

describe('AC1 and AC2: the committed bytes are the staged bytes', () => {
  it('fails on a secret that is staged but restored clean in the working copy (AC1)', () => {
    const root = baseRepository({ 'clean.txt': 'nothing here\n' });
    stage(root, LEAK_FILE, SLACK_VALUE);
    writeFileSync(join(root, LEAK_FILE), 'clean now\n');
    expectFinding(stagedScan(root), LEAK_FILE);
  });

  it('fails on a newly added file that holds the secret (AC2)', () => {
    const root = baseRepository({ 'clean.txt': 'nothing here\n' });
    stage(root, 'added/new-file.txt', SLACK_VALUE);
    expectFinding(stagedScan(root), 'added/new-file.txt');
  });

  it('passes a clean change and prints the scope it read', () => {
    const root = baseRepository({ 'clean.txt': 'nothing here\n' });
    stage(root, 'clean.txt', 'still nothing here\n');
    const result = stagedScan(root);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('Secret scan (staged): passed; 1 path(s) scanned against HEAD');
  });
});

describe('AC3: renamed and moved content is judged at its new path', () => {
  it('fails a clean file renamed to .env at full similarity', () => {
    const root = baseRepository({ 'notes.txt': 'harmless notes\n' });
    git(root, 'mv', 'notes.txt', '.env');
    const result = stagedScan(root);
    expect(result.status, result.out).toBe(1);
    // The staged outcome line: tree mode also reports a tracked `.env`, so the rule name alone
    // would pass before staged mode exists.
    expect(result.out).toContain('Secret scan (staged): FINDING');
    expect(result.out).toContain('secretlint-rule-no-dotenv');
    expect(result.out).toContain('.env');
  });

  it('fails a file moved from an ignored path to a scanned one', () => {
    const root = baseRepository({ 'dist/bundle.js': SLACK_VALUE });
    mkdirSync(join(root, 'app'));
    git(root, 'mv', 'dist/bundle.js', 'app/bundle.js');
    expectFinding(stagedScan(root), 'app/bundle.js');
  });
});

describe('FR-010: dotenv variants and templates, judged by the local rule at the staged path (tasks TA1)', () => {
  const LOCAL_RULE = 'secretlint-rule-schegent';

  it('fails a clean file renamed to .env.local', () => {
    const root = baseRepository({ 'notes.txt': 'harmless notes\n' });
    git(root, 'mv', 'notes.txt', '.env.local');
    expectFinding(stagedScan(root), '.env.local', LOCAL_RULE);
  });

  it('fails a clean file renamed to config/.env.production', () => {
    const root = baseRepository({ 'notes.txt': 'harmless notes\n' });
    mkdirSync(join(root, 'config'));
    git(root, 'mv', 'notes.txt', 'config/.env.production');
    expectFinding(stagedScan(root), 'config/.env.production', LOCAL_RULE);
  });

  it('fails an .env.example whose staged content holds an Anthropic value', () => {
    const template = PLANTED.find((planted) => planted.family === 'anthropic-in-template');
    expect(template).toBeDefined();
    const text = template?.build() ?? '';
    const root = baseRepository({ 'clean.txt': 'nothing here\n' });
    stage(root, '.env.example', text);
    const result = stagedScan(root);
    expectFinding(result, '.env.example', LOCAL_RULE);
    for (const word of valueWords(text)) expect(result.out, 'a part of the value reached the report').not.toContain(word);
  });

  it('passes a credential-free .env.example', () => {
    const root = baseRepository({ 'clean.txt': 'nothing here\n' });
    stage(root, '.env.example', 'SOME_SETTING=placeholder\n');
    const result = stagedScan(root);
    expect(result.status, result.out).toBe(0);
  });
});

describe('AC4: partial staging', () => {
  it('fails on a secret in the staged hunk, and passes one only in the unstaged hunk', () => {
    const root = baseRepository({ 'app.txt': 'line one\nline two\nline three\n' });
    stage(root, 'app.txt', `line one\n${SLACK_VALUE}line three\n`);
    writeFileSync(join(root, 'app.txt'), 'line one\nline two\nline three\n');
    expectFinding(stagedScan(root), 'app.txt');

    const clean = baseRepository({ 'app.txt': 'line one\nline two\nline three\n' });
    stage(clean, 'app.txt', 'line one\nline two edited\nline three\n');
    writeFileSync(join(clean, 'app.txt'), `line one\n${SLACK_VALUE}line three\n`);
    const staged = stagedScan(clean);
    expect(staged.status, staged.out).toBe(0);
    const tree = scan(clean);
    expect(tree.status, 'tree mode must still report the working-tree secret').toBe(1);
    expect(tree.out).toContain(SLACK_RULE);
  });
});

describe('AC6: every unanswerable check is a named refusal', () => {
  it('refuses a missing configuration with config-missing', () => {
    const root = sandbox({ 'a.txt': 'x\n' });
    expectRefusal(stagedScan(root), 'config-missing');
  });

  it('refuses an unparseable staged configuration with config-unparseable', () => {
    const root = baseRepository({ 'a.txt': 'x\n' });
    stage(root, '.secretlintrc.json', '{ this is not json');
    expectRefusal(stagedScan(root), 'config-unparseable');
  });

  it('refuses a missing staged ignore list with ignore-missing', () => {
    const root = baseRepository({ 'a.txt': 'x\n' });
    git(root, 'rm', '--cached', '--quiet', '--', '.secretlintignore');
    stage(root, 'a.txt', 'changed\n');
    expectRefusal(stagedScan(root), 'ignore-missing');
  });

  it('refuses a rule the staged configuration names but the engine cannot load, with engine-failed', () => {
    const root = baseRepository({ 'a.txt': 'x\n' });
    stage(root, '.secretlintrc.json', JSON.stringify({ rules: [{ id: '@secretlint/secretlint-rule-absent-rule' }] }));
    stage(root, 'a.txt', 'changed\n');
    expectRefusal(stagedScan(root), 'engine-failed');
  });

  // FR-R4-F10 (SS5): "an engine that will not load" is a named refusal in both modes. The engine was
  // imported statically, so a package that failed to load stopped the module while it linked: Node's
  // own error, its own trace and no refusal line. The load now happens inside the refusal path.
  const LOAD_FAILURE = "throw new Error('synthetic load failure');\n";

  it('refuses an engine package that throws while it loads, with engine-failed and no loader trace', () => {
    const root = baseRepository({ 'a.txt': 'x\n' });
    replaceEngineWithUnloadable(root, LOAD_FAILURE);
    stage(root, 'a.txt', 'changed\n');
    const result = stagedScan(root);
    expectRefusal(result, 'engine-failed');
    expect(result.out, 'a raw module-loader trace reached the operator').not.toContain('node:internal');
    expect(result.out, 'the sandbox path reached the operator').not.toContain(root);
  });

  it('refuses an engine package whose entry file is missing, naming the loader code and no path', () => {
    const root = baseRepository({ 'a.txt': 'x\n' });
    replaceEngineWithUnloadable(root, null);
    stage(root, 'a.txt', 'changed\n');
    const result = stagedScan(root);
    expectRefusal(result, 'engine-failed');
    expect(result.out).toContain('ERR_MODULE_NOT_FOUND');
    expect(result.out, 'a raw module-loader trace reached the operator').not.toContain('node:internal');
    expect(result.out, 'the sandbox path reached the operator').not.toContain(root);
  });

  it('refuses the same way in tree mode', () => {
    const root = sandbox({ 'a.txt': 'x\n' });
    replaceEngineWithUnloadable(root, LOAD_FAILURE);
    const result = scan(root);
    expectRefusal(result, 'engine-failed');
    expect(result.out, 'a raw module-loader trace reached the operator').not.toContain('node:internal');
  });

  it('refuses a commit with nothing to scan too, as it did when the engine was imported at load', () => {
    const root = baseRepository({ 'a.txt': 'x\n', 'b.txt': 'y\n' });
    replaceEngineWithUnloadable(root, LOAD_FAILURE);
    git(root, 'rm', '--quiet', '--', 'a.txt');
    expectRefusal(stagedScan(root), 'engine-failed');
  });

  it('refuses when git returns a corrupted blob stream, with blob-unreadable', () => {
    const root = baseRepository({ 'a.txt': 'x\n' });
    stage(root, 'a.txt', 'changed content that is longer than the cut\n');
    const wrapperDir = privateTmp();
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const wrapper = join(wrapperDir, 'git');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nif [ "$1" = "cat-file" ] && [ "$2" = "--batch" ]; then\n  "${realGit}" "$@" | head -c 12\nelse\n  exec "${realGit}" "$@"\nfi\n`
    );
    chmodSync(wrapper, 0o755);
    const result = stagedScan(root, { PATH: `${wrapperDir}:${process.env.PATH ?? ''}` });
    expectRefusal(result, 'blob-unreadable');
  });

  it('refuses outside a repository with git-failed', () => {
    const root = sandbox({});
    rmSync(join(root, '.git'), { recursive: true, force: true });
    // The sandbox sits under this repository's own temporary root, so a bare lookup would walk up
    // into the enclosing repository. The ceiling stops the walk at the sandbox's parent.
    const result = scan(root, ['--staged'], { TMPDIR: privateTmp(), GIT_CEILING_DIRECTORIES: dirname(root) });
    expectRefusal(result, 'git-failed');
  });

  it('refuses an unknown argument with unknown-argument, before any git call', () => {
    const root = baseRepository({ 'a.txt': 'x\n' });
    const result = scan(root, ['--stagd']);
    expectRefusal(result, 'unknown-argument');
  });

  it('refuses a real merge conflict with unmerged-path', () => {
    const root = baseRepository({ 'conflict.txt': 'a\nb\nc\n' });
    git(root, 'switch', '--quiet', '-c', 'other');
    stage(root, 'conflict.txt', 'a\nOTHER\nc\n');
    expect(commit(root, ['-m', 'other side']).status).toBe(0);
    git(root, 'switch', '--quiet', '-');
    stage(root, 'conflict.txt', 'a\nMAIN\nc\n');
    expect(commit(root, ['-m', 'main side']).status).toBe(0);
    const merged = spawnSync('git', ['merge', '--no-edit', 'other'], { cwd: root, encoding: 'utf8' });
    expect(merged.status, 'the merge must stop on a conflict').toBe(1);
    expectRefusal(stagedScan(root), 'unmerged-path');
  });
});

describe('AC7: nothing staged needed scanning', () => {
  it('lets a deletion-only commit through with the no-subject line', () => {
    const root = baseRepository({ 'a.txt': 'x\n', 'b.txt': 'y\n' });
    git(root, 'rm', '--quiet', '--', 'a.txt');
    const result = stagedScan(root);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('nothing staged needed scanning');
    expect(result.out).toContain('1 deleted');
  });

  it('lets a mode-only change through, counted as unchanged (AN1)', () => {
    const root = baseRepository({ 'tool.sh': 'echo hi\n' });
    git(root, 'update-index', '--chmod=+x', '--', 'tool.sh');
    const result = stagedScan(root);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('nothing staged needed scanning');
    expect(result.out).toContain('1 unchanged');
  });
});

describe('edge cases', () => {
  it('scans against the empty tree before the first commit', () => {
    const clean = sandbox({ 'clean.txt': 'fine\n' }, { stageConfig: true });
    const passed = stagedScan(clean);
    expect(passed.status, passed.out).toBe(0);
    expect(passed.out).toContain('against empty tree');

    const leaking = sandbox({ [LEAK_FILE]: SLACK_VALUE }, { stageConfig: true });
    expectFinding(stagedScan(leaking), LEAK_FILE);
  });

  it('skips a gitlink and counts it', () => {
    const root = baseRepository({ 'a.txt': 'x\n' });
    git(root, 'update-index', '--add', '--cacheinfo', `160000,${'c'.repeat(40)},vendor/sub`);
    const result = stagedScan(root);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('nothing staged needed scanning');
    expect(result.out).toContain('1 gitlink');
  });

  it('scans the target text of a symlink, so a secret in it fails', () => {
    const root = baseRepository({ 'a.txt': 'x\n' });
    const token = SLACK_VALUE.split('"').at(1) ?? '';
    expect(token.length).toBeGreaterThan(20);
    symlinkSync(`targets/${token}`, join(root, 'link'));
    git(root, 'add', '--', 'link');
    expectFinding(stagedScan(root), 'link');
  });

  it('treats a binary blob as tree mode treats it', () => {
    const binary = `${'\u0000\u0001\u0002'.repeat(60)}${SLACK_VALUE}`;
    const root = sandbox({ 'blob.bin': binary }, { stageConfig: true });
    const staged = stagedScan(root);
    const tree = scan(root);
    expect(staged.out).toContain('Secret scan (staged):');
    expect(tree.out).not.toContain('Secret scan (staged)');
    expect(staged.status, `staged: ${staged.out}\ntree: ${tree.out}`).toBe(tree.status);
  });
});

describe('SS6: a held index lock does not stop the scan, and is left alone', () => {
  it('scans while .git/index.lock exists and leaves it untouched', () => {
    const root = baseRepository({ 'clean.txt': 'nothing here\n' });
    stage(root, LEAK_FILE, SLACK_VALUE);
    const lock = join(root, '.git', 'index.lock');
    writeFileSync(lock, 'held by another process\n');
    const result = scan(root, ['--staged'], { TMPDIR: privateTmp() });
    expectFinding(result, LEAK_FILE);
    expect(readFileSync(lock, 'utf8')).toBe('held by another process\n');
  });
});

describe('SS4: the temporary directory is gone on every exit', () => {
  it('leaves none after a pass, a finding and a refusal (checked by every stagedScan call)', () => {
    const root = baseRepository({ 'clean.txt': 'nothing here\n' });
    stage(root, 'clean.txt', 'edited\n');
    const passed = stagedScan(root);
    expect(passed.status, passed.out).toBe(0);
    expect(passed.out).toContain('Secret scan (staged): passed');
    stage(root, LEAK_FILE, SLACK_VALUE);
    const found = stagedScan(root);
    expect(found.status, found.out).toBe(1);
    expect(found.out).toContain('Secret scan (staged): FINDING');
  });

  it('removes the directory when the scan receives SIGTERM while the engine runs', async () => {
    const root = baseRepository({ 'clean.txt': 'nothing here\n' });
    stage(root, 'clean.txt', 'edited\n');
    const tmp = privateTmp();
    const child = spawn(process.execPath, [join(root, 'scripts', 'scan-secrets.mjs'), '--staged'], {
      cwd: root,
      env: { ...process.env, TMPDIR: tmp },
      stdio: 'ignore'
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
      child.on('close', (code, signal) => done({ code, signal }));
    });
    const deadline = Date.now() + 20_000;
    while (stagedDirectoriesIn(tmp).length === 0 && Date.now() < deadline) {
      await new Promise((wait) => setTimeout(wait, 2));
    }
    expect(stagedDirectoriesIn(tmp).length, 'the scan never created its directory').toBeGreaterThan(0);
    child.kill('SIGTERM');
    const { code, signal } = await exited;
    expect(signal, 'the scan was killed by the signal instead of handling it').toBeNull();
    expect(code).toBe(1);
    expect(stagedDirectoriesIn(tmp)).toEqual([]);
  }, 60_000);
});

describe('SC-006: staged mode reads only the paths that changed', () => {
  it('prints 1 path(s) scanned for 1 staged change among 60 tracked files', () => {
    const files = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`tracked/file-${String(index).padStart(2, '0')}.txt`, `content ${index}\n`])
    );
    const root = baseRepository(files);
    stage(root, 'tracked/file-07.txt', 'content 7 changed\n');
    const result = stagedScan(root);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('1 path(s) scanned');
  });
});
