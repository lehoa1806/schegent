import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * FR-R4-F21 (feature 249; FR-001, FR-004, FR-023, FR-025, A2 to A5) — the advisory command, run
 * as a real process against a temporary git repository and a stub `npm`.
 *
 * Capture audits the commit, never the working tree. It writes a capture whatever the audit did.
 * Compare reads the captures and the two commits, prints a report and exits 0 whatever it found.
 * Neither writes anywhere the operator did not name, and an output the operator named is created
 * exclusively, owner-only, and never under a `.schegent/` directory. This pins contract T8 for
 * those behaviours.
 *
 * It also pins the read-only half of FR-002, FR-027 and FR-029: capture and compare change no
 * tracked file, lockfile, manifest or `node_modules`, compare starts no `npm` at all, and the
 * absolute audit gives the same answer before and after.
 *
 * No test here contacts the network or needs a credential: the stub `npm` answers `--version`,
 * `config get registry` and `audit`, and records every call. The stub, the advisory ids and the
 * package names are synthetic (`tests/fixtures/advisory-diff/cli/npm`).
 */
const REPO_ROOT = resolve(__dirname, '..', '..');
const CLI = join(REPO_ROOT, 'scripts', 'advisory-diff.mjs');
const STUB = join(REPO_ROOT, 'tests', 'fixtures', 'advisory-diff', 'cli', 'npm');

const ROOT_MANIFEST = `${JSON.stringify({ name: 'fixture-root', version: '1.0.0', private: true }, null, 2)}\n`;
const WEBVIEW_MANIFEST = `${JSON.stringify({ name: 'fixture-webview', version: '1.0.0', private: true }, null, 2)}\n`;

/** A version 3 lockfile for `versions`, a location to version map. */
function lockfileText(name: string, versions: Readonly<Record<string, string>>): string {
  const packages: Record<string, unknown> = { '': { name, version: '1.0.0' } };
  for (const [location, version] of Object.entries(versions)) packages[location] = { version };
  return `${JSON.stringify({ name, version: '1.0.0', lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;
}

const BASE_ROOT_LOCK = lockfileText('fixture-root', { 'node_modules/lib-old': '1.0.0' });
const CANDIDATE_ROOT_LOCK = lockfileText('fixture-root', {
  'node_modules/lib-old': '1.0.0',
  'node_modules/lib-new': '1.0.0'
});
const EDITED_ROOT_LOCK = lockfileText('fixture-root', {
  'node_modules/lib-old': '1.0.0',
  'node_modules/lib-new': '1.0.0',
  'node_modules/lib-extra': '1.0.0'
});
const WEBVIEW_LOCK = lockfileText('fixture-webview', { 'node_modules/lib-clean': '1.0.0' });

const GIT_IDENTITY = [
  '-c', 'user.name=Fixture',
  '-c', 'user.email=fixture@example.test',
  '-c', 'commit.gpgsign=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'maintenance.auto=false',
  '-c', 'gc.auto=0'
] as const;

/** The temp git repository, its stub `npm` and the commits it holds. */
const world = {
  dir: '',
  repo: '',
  out: '',
  bin: '',
  stubLog: '',
  baseCommit: '',
  candidateCommit: '',
  /** `--base-capture` and `--candidate-capture` arguments naming four captures made in `beforeAll`. */
  captureArgs: [] as string[]
};

function git(args: readonly string[], cwd: string = world.repo): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function write(rel: string, text: string): void {
  const file = join(world.repo, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
}

function commitAll(message: string): string {
  git(['add', '-A']);
  git(['commit', '-q', '-m', message]);
  return git(['rev-parse', 'HEAD']).trim();
}

beforeAll(() => {
  world.dir = realpathSync(mkdtempSync(join(tmpdir(), 'advisory-diff-cli-')));
  world.repo = join(world.dir, 'repo');
  world.out = join(world.dir, 'out');
  world.bin = join(world.dir, 'bin');
  world.stubLog = join(world.dir, 'stub-npm.log');
  mkdirSync(world.repo);
  mkdirSync(world.out);
  mkdirSync(world.bin);
  copyFileSync(STUB, join(world.bin, 'npm'));
  chmodSync(join(world.bin, 'npm'), 0o755);

  git(['init', '-q', '-b', 'develop']);
  write('package.json', ROOT_MANIFEST);
  write('package-lock.json', BASE_ROOT_LOCK);
  write('webview-ui/package.json', WEBVIEW_MANIFEST);
  write('webview-ui/package-lock.json', WEBVIEW_LOCK);
  world.baseCommit = commitAll('base');
  git(['switch', '-q', '-c', 'candidate']);
  write('package-lock.json', CANDIDATE_ROOT_LOCK);
  world.candidateCommit = commitAll('candidate adds lib-new');

  for (const [side, commit] of [
    ['base', world.baseCommit],
    ['candidate', world.candidateCommit]
  ] as const) {
    for (const tree of ['root', 'webview-ui']) {
      const out = join(world.out, `shared-${side}-${tree}.json`);
      const result = run(['capture', '--tree', tree, '--commit', commit, '--out', out]);
      if (result.status !== 0) throw new Error(`setup capture failed: ${result.stderr}`);
      world.captureArgs.push(`--${side}-capture`, `${tree}=${out}`);
    }
  }
});

afterAll(() => {
  rmSync(world.dir, { recursive: true, force: true });
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the CLI as a child process with the stub `npm` first on `PATH`. */
function run(args: readonly string[], extraEnv: Record<string, string> = {}): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: world.repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${world.bin}${delimiter}${process.env['PATH'] ?? ''}`,
      ADVISORY_STUB_NPM_LOG: world.stubLog,
      ...extraEnv
    }
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

let counter = 0;
/** A path under the output directory that does not exist yet. */
function outPath(label: string): string {
  counter += 1;
  return join(world.out, `${label}-${String(counter)}.json`);
}

interface CaptureFile {
  readonly commit: string;
  readonly lockfile: { readonly path: string; readonly blob: string };
  readonly outcome: { readonly status: string; readonly reason?: string };
  readonly findings: readonly { readonly package: string }[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('capture audits the commit, never the working tree (FR-001)', () => {
  it('records the commit blob and the commit findings when the working tree lockfile is edited', () => {
    const out = outPath('uncommitted');
    write('package-lock.json', EDITED_ROOT_LOCK);
    try {
      const result = run(['capture', '--tree', 'root', '--commit', 'HEAD', '--out', out]);
      expect(result.status, result.stderr).toBe(0);
      const capture = readJson<CaptureFile>(out);
      expect(capture.commit).toBe(world.candidateCommit);
      expect(capture.lockfile.blob).toBe(git(['rev-parse', 'HEAD:package-lock.json']).trim());
      expect(capture.findings.map((f) => f.package)).toEqual(['lib-new', 'lib-old']);
      expect(JSON.stringify(capture)).not.toContain('lib-extra');
      expect(result.stdout).toMatch(/^root [0-9a-f]{7} succeeded 2 findings\n$/);
    } finally {
      write('package-lock.json', CANDIDATE_ROOT_LOCK);
    }
  });

  it('captures the webview tree from its own files', () => {
    const out = outPath('webview');
    const result = run(['capture', '--tree', 'webview-ui', '--commit', world.baseCommit, '--out', out]);
    expect(result.status, result.stderr).toBe(0);
    const capture = readJson<CaptureFile>(out);
    expect(capture.lockfile.path).toBe('webview-ui/package-lock.json');
    expect(capture.findings).toEqual([]);
  });
});

describe('capture writes a capture whatever the audit did, and exits 0 (FR-004)', () => {
  it('records a failed capture when the stub prints nothing', () => {
    const out = outPath('silent');
    const result = run(['capture', '--tree', 'root', '--commit', 'HEAD', '--out', out], {
      ADVISORY_STUB_NPM_MODE: 'silent'
    });
    expect(result.status, result.stderr).toBe(0);
    const capture = readJson<CaptureFile>(out);
    expect(capture.outcome).toEqual({ status: 'failed', reason: 'no-report' });
    expect(result.stdout).toMatch(/failed no-report/);
  });
});

describe('an output the operator names is created exclusively and never under .schegent (FR-025)', () => {
  const subcommands: readonly (readonly [string, (out: string) => string[]])[] = [
    ['capture', (out) => ['capture', '--tree', 'root', '--commit', 'HEAD', '--out', out]],
    ['compare', (out) => ['compare', ...world.captureArgs, '--out', out]]
  ];

  for (const [name, args] of subcommands) {
    it(`${name}: refuses an existing file, leaving it and printing nothing`, () => {
      const out = outPath(`${name}-exists`);
      writeFileSync(out, 'keep me');
      const result = run(args(out));
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('--out');
      expect(readFileSync(out, 'utf8')).toBe('keep me');
    });

    it(`${name}: refuses a symbolic link and leaves its target unchanged`, () => {
      const target = outPath(`${name}-link-target`);
      const link = outPath(`${name}-link`);
      writeFileSync(target, 'target content');
      symlinkSync(target, link);
      const result = run(args(link));
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('--out');
      expect(readFileSync(target, 'utf8')).toBe('target content');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    });

    it(`${name}: refuses a path under a .schegent directory and creates no file`, () => {
      const dir = join(world.dir, `${name}-sandbox`, '.schegent');
      mkdirSync(dir, { recursive: true });
      const out = join(dir, 'x.json');
      const result = run(args(out));
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('--out');
      expect(existsSync(out)).toBe(false);
    });

    it(`${name}: refuses a path whose parent does not exist and creates nothing`, () => {
      const out = join(world.out, `${name}-no-such-dir`, 'x.json');
      const result = run(args(out));
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('--out');
      expect(existsSync(join(world.out, `${name}-no-such-dir`))).toBe(false);
    });

    it(`${name}: creates the output with mode 0600`, () => {
      const out = outPath(`${name}-mode`);
      const result = run(args(out));
      expect(result.status, result.stderr).toBe(0);
      expect(modeOf(out)).toBe(0o600);
    });
  }
});

describe('a bad invocation exits 2 and prints nothing (A2)', () => {
  const cases: readonly (readonly [string, string[]])[] = [
    ['an unknown flag', ['compare', '--bogus']],
    ['an unknown subcommand', ['frobnicate']],
    ['no subcommand', []],
    ['a repeated single-valued flag', ['capture', '--tree', 'root', '--commit', 'HEAD', '--out', 'a', '--out', 'b']],
    [
      'a repeated tree on one side',
      ['compare', '--base-capture', 'root=a.json', '--base-capture', 'root=b.json']
    ],
    ['a missing --tree', ['capture', '--commit', 'HEAD', '--out', 'x.json']],
    ['a missing --commit', ['capture', '--tree', 'root', '--out', 'x.json']],
    ['a missing --out', ['capture', '--tree', 'root', '--commit', 'HEAD']],
    ['a tree outside the scope', ['capture', '--tree', 'src', '--commit', 'HEAD', '--out', 'x.json']],
    ['a capture with no tree= prefix', ['compare', '--base-capture', 'a.json']],
    ['--tree on compare, which has no flag that narrows the scope', ['compare', '--tree', 'root']],
    ['--target together with --base', ['compare', '--target', 'develop', '--base', 'HEAD']],
    ['a candidate beginning with a dash', ['base', '--candidate', '--output=x']],
    ['a --at that is not an ISO-8601 UTC instant', ['compare', '--at', 'yesterday']],
    ['a --at that is not a real instant', ['compare', '--at', '2026-13-45T00:00:00Z']],
    ['a --at without a Z', ['compare', '--at', '2026-10-30T09:00:00']]
  ];

  for (const [label, args] of cases) {
    it(`${label}`, () => {
      const result = run(args);
      expect(result.status, result.stderr).toBe(2);
      expect(result.stdout).toBe('');
    });
  }

  it('creates no output file when the invocation is bad', () => {
    const out = outPath('bad-invocation');
    const result = run(['compare', '--at', 'yesterday', '--out', out]);
    expect(result.status).toBe(2);
    expect(existsSync(out)).toBe(false);
  });
});

describe('base prints the selected base commit (K1)', () => {
  it('prints the merge-base of the candidate and develop', () => {
    const result = run(['base']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${world.baseCommit}\n`);
  });

  it('exits 1 with the reason on stderr when --target names no branch', () => {
    const result = run(['base', '--target', 'no-such-branch']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('target-missing');
  });
});

describe('compare reads the captures and prints the report (K7, FR-023)', () => {
  it('prints the four lines and writes a version 1 record for four matching captures', () => {
    const record = outPath('record');
    const result = run(['compare', ...world.captureArgs, '--out', record]);
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.split('\n');
    expect(lines[0]).toBe('Advisory comparison: COMPLETE');
    expect(lines[1]).toBe('Introduced: 1   Worsened: 0');
    expect(lines[2]).toMatch(/^Report-only\. The absolute audit \(npm run security:audit\) is unaffected/);
    expect(lines[3]).toMatch(/^Candidate [0-9a-f]{7} vs base [0-9a-f]{7} \(merge-base with develop\), evaluated /);
    const written = readJson<{ recordVersion: number; mode: string; complete: boolean }>(record);
    expect(written.recordVersion).toBe(1);
    expect(written.mode).toBe('report-only');
    expect(written.complete).toBe(true);
  });
});

/** A snapshot of everything the command must leave alone, read by content and never by mtime. */
function snapshot(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const rel of [
    'package.json',
    'package-lock.json',
    'webview-ui/package.json',
    'webview-ui/package-lock.json',
    'node_modules/planted/index.js'
  ]) {
    files[rel] = readFileSync(join(world.repo, rel), 'utf8');
  }
  files['git status --porcelain'] = git(['status', '--porcelain', '--untracked-files=all']);
  return files;
}

/** Every path in the working tree outside `.git`, so a file the command created would show. */
function treeListing(dir: string = world.repo, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) out.push(rel, ...treeListing(join(dir, entry.name), `${rel}/`));
    else out.push(rel);
  }
  return out.sort();
}

/** The stub's absolute audit over the working tree, as the repository runs it. */
function absoluteAudit(): Run {
  const result = spawnSync('npm', ['audit', '--audit-level=low'], {
    cwd: world.repo,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${world.bin}${delimiter}${process.env['PATH'] ?? ''}` }
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The `--base-capture` and `--candidate-capture` arguments for captures all taken at `commit`. */
function capturesAt(commit: string, label: string): string[] {
  const args: string[] = [];
  for (const tree of ['root', 'webview-ui']) {
    const out = outPath(`${label}-${tree}`);
    const result = run(['capture', '--tree', tree, '--commit', commit, '--out', out]);
    expect(result.status, result.stderr).toBe(0);
    args.push('--base-capture', `${tree}=${out}`, '--candidate-capture', `${tree}=${out}`);
  }
  return args;
}

describe('capture and compare change nothing they report on (FR-002, FR-029, SC-005)', () => {
  it('leaves every tracked file, lockfile, manifest and node_modules file byte-identical', () => {
    write('node_modules/planted/index.js', 'module.exports = "planted";\n');
    const before = snapshot();
    const listingBefore = treeListing();

    const captures: string[] = [];
    for (const [side, commit] of [
      ['base', world.baseCommit],
      ['candidate', world.candidateCommit]
    ] as const) {
      for (const tree of ['root', 'webview-ui']) {
        const out = outPath(`readonly-${side}-${tree}`);
        const result = run(['capture', '--tree', tree, '--commit', commit, '--out', out]);
        expect(result.status, result.stderr).toBe(0);
        captures.push(`--${side}-capture`, `${tree}=${out}`);
      }
    }
    const compared = run(['compare', ...captures, '--out', outPath('readonly-record')]);
    expect(compared.status, compared.stderr).toBe(0);

    expect(snapshot()).toEqual(before);
    expect(treeListing()).toEqual(listingBefore);
  });

  it('leaves the absolute audit with the same non-zero exit and the same output, and says it is unaffected', () => {
    const before = absoluteAudit();
    expect(before.status).not.toBe(0);
    expect(before.stdout).toContain('lib-old');

    // A candidate equal to its base: the comparison finds nothing introduced and one pre-existing,
    // while the absolute audit over the working tree still fails.
    const compared = run(['compare', '--candidate', world.baseCommit, ...capturesAt(world.baseCommit, 'control')]);
    expect(compared.status, compared.stderr).toBe(0);
    expect(compared.stdout.split('\n')[1]).toBe('Introduced: 0   Worsened: 0');
    expect(compared.stdout).toMatch(/^Pre-existing \(1\)$/m);
    expect(compared.stdout).toContain('npm run security:audit');
    expect(compared.stdout.split('\n')[2]).toContain('is unaffected');

    const after = absoluteAudit();
    expect(after.status).toBe(before.status);
    expect(after.stdout).toBe(before.stdout);
  });

  it('exits 0 and writes a report-only record when the comparison finds an introduced finding (US5-3)', () => {
    const record = outPath('introduced-record');
    const result = run(['compare', ...world.captureArgs, '--out', record]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^Introduced \(1\)$/m);
    expect(readJson<{ mode: string }>(record).mode).toBe('report-only');
  });
});

describe('compare is offline (FR-027)', () => {
  it('succeeds when every call to npm fails, and starts no npm at all', () => {
    const log = join(world.dir, 'stub-npm-offline.log');
    const result = run(['compare', ...world.captureArgs], {
      ADVISORY_STUB_NPM_MODE: 'fail',
      ADVISORY_STUB_NPM_LOG: log
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split('\n')[0]).toBe('Advisory comparison: COMPLETE');
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe('');
  });

  it('control: capture does start npm, so the empty log above is a measurement', () => {
    const log = join(world.dir, 'stub-npm-capture.log');
    const out = outPath('offline-control');
    const result = run(['capture', '--tree', 'root', '--commit', 'HEAD', '--out', out], {
      ADVISORY_STUB_NPM_LOG: log
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.map((line) => (JSON.parse(line) as { argv: string[] }).argv[0])).toEqual(
      expect.arrayContaining(['--version', 'config', 'audit'])
    );
  });
});

describe('compare reads a disposition list and never writes one (FR-020 to FR-022)', () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    advisory: 'GHSA-oo11-ld22-aa33',
    ecosystem: 'npm',
    package: 'lib-old',
    tree: 'root',
    range: '<2.0.0',
    status: 'accepted',
    owner: 'owner-a',
    decidedOn: '2026-10-01',
    expiresOn: '2099-01-01',
    ...overrides
  });

  it('shows the verdict of each finding and states the list was read', () => {
    const list = outPath('dispositions-list');
    writeFileSync(list, JSON.stringify({ dispositionListVersion: 1, dispositions: [entry()] }));
    const before = readFileSync(list, 'utf8');
    const record = outPath('dispositions-record');
    const result = run(['compare', ...world.captureArgs, '--dispositions', list, '--out', record]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^Disposition list: read$/m);
    expect(result.stdout).toContain('disposition: covers');
    expect(result.stdout).toContain('entry: accepted, owner owner-a, decided 2026-10-01, expires 2099-01-01 - covers');
    const written = readJson<{ dispositions: { state: string }; complete: boolean }>(record);
    expect(written.dispositions).toEqual({ state: 'read' });
    expect(readFileSync(list, 'utf8')).toBe(before);
  });

  it('treats a path that does not exist as an unusable list: exit 0, every verdict unknown', () => {
    const missing = join(world.out, 'no-such-dispositions.json');
    const record = outPath('dispositions-missing-record');
    const result = run(['compare', ...world.captureArgs, '--dispositions', missing, '--out', record]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^Disposition list: unusable \(unreadable\)$/m);
    expect(result.stdout).toContain('disposition: unknown');
    expect(result.stdout.split('\n')[0]).toBe('Advisory comparison: COMPLETE');
    expect(readJson<{ dispositions: unknown }>(record).dispositions).toEqual({ state: 'unusable', defect: 'unreadable' });
    expect(existsSync(missing)).toBe(false);
  });
});
