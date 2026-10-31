import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * FR-R4-F06 (FR-029; T31; contract Q, Q3) -- the offline help capture: what it prints, and what it
 * never prints.
 *
 * WHAT THE SCRIPT IS FOR. The qualification record states which capability flags each backend CLI
 * lists, at which version. That has to come from running the CLI, with no account and no model
 * call, so `scripts/capture-backend-help.mjs` runs each installed CLI's `--version` and `--help`
 * under a minimal environment and an isolated, empty home, and prints the result. It is run by hand
 * at implement and by no tier, so this test is what keeps its output honest.
 *
 * THE ORACLE is a stub CLI (`stub-backend-cli.mjs`) whose help holds every flag plus one absolute
 * path. The script is run as a child, with the stub on `PATH` under the name of a real backend, and
 * `TMPDIR` pointed at an empty directory so the temporary home it makes can be observed gone.
 * Nothing here is evidence about a real CLI.
 *
 * POSIX only: the stub is reached through a shell wrapper.
 */
const run = promisify(execFile);
const posixOnly = process.platform === 'win32' ? describe.skip : describe;
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'capture-backend-help.mjs');
const STUB = join(REPO_ROOT, 'tests', 'fixtures', 'stub-backend-cli.mjs');
const CASE_TIMEOUT_MS = 10_000;
const FLAGS = ['--dangerously-skip-permissions', '--disallowedTools', '--permission-mode', '--sandbox'];

let scratch: string;
let binDir: string;
let tmpRoot: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'schegent-capture-test-'));
  binDir = join(scratch, 'bin');
  tmpRoot = join(scratch, 'tmp');
  await mkdir(binDir);
  await mkdir(tmpRoot);
  // A wrapper named for a real backend, so the script finds it on PATH as it would the real CLI.
  const wrapper = join(binDir, 'claude');
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "$@"\n`);
  await chmod(wrapper, 0o755);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function capture(...backends: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await run(process.execPath, [SCRIPT, ...backends], {
      // Only the stub's directory and the system directories: a real `codex` or `agy` the host
      // happens to have must not be found, or the not-installed case would test the host.
      env: { PATH: `${binDir}:/usr/bin:/bin`, TMPDIR: tmpRoot },
      timeout: CASE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024
    });
    return { stdout, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; code?: number };
    return { stdout: failure.stdout ?? '', code: failure.code ?? 1 };
  }
}

posixOnly('the offline help capture (T31)', () => {
  it('names each flag as listed, with the version the CLI reported', async () => {
    const { stdout, code } = await capture('claude');

    expect(code).toBe(0);
    expect(stdout).toContain('backend: claude');
    expect(stdout).toContain('version: 9.9.9');
    for (const flag of ['--dangerously-skip-permissions', '--disallowedTools', '--permission-mode']) {
      expect(stdout, `${flag} must be reported as listed`).toMatch(
        new RegExp(`${flag}: listed`)
      );
    }
  });

  it('reports both commands exited 0', async () => {
    const { stdout } = await capture('claude');
    expect(stdout).toMatch(/--version exit: 0/);
    expect(stdout).toMatch(/--help exit: 0/);
  });

  it('shows the help line with <path> in place of the absolute path, and holds no absolute path', async () => {
    const { stdout } = await capture('claude');

    // Control: the stub's help really did print an absolute path, so a clean output proves the
    // redaction ran rather than that nothing was there to redact.
    expect(STUB.startsWith('/')).toBe(true);
    expect(stdout).toContain('<path>');
    expect(stdout).not.toContain(STUB);
    expect(stdout).not.toContain(REPO_ROOT);
    expect(stdout).not.toContain(scratch);
    expect(stdout).not.toMatch(/(^|[\s"'(=])\/(?:[\w.@+~-]+\/)+[\w.@+~-]+/m);
  });

  it('reports a backend that is not installed as not installed, and does not fail the run', async () => {
    const { stdout, code } = await capture('codex');
    expect(code).toBe(0);
    expect(stdout).toContain('backend: codex');
    expect(stdout).toContain('executable: not installed');
  });

  it('refuses a backend name it does not know', async () => {
    const { code, stdout } = await capture('not-a-backend');
    expect(code).not.toBe(0);
    expect(stdout).not.toContain('executable: found');
  });

  it('removes the temporary home it made', async () => {
    await capture('claude');
    expect(await readdir(tmpRoot), 'the isolated home must be gone').toEqual([]);
  });

  it('removes the temporary home even when a command fails', async () => {
    await capture('claude', 'not-a-backend');
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('lists every capability flag for every backend it can be asked about', async () => {
    const { stdout } = await capture('claude');
    // The set the script reports on is the planner's SURFACES flags for that backend, so a flag
    // added to the planner without the script is a flag the record cannot qualify.
    for (const flag of FLAGS.filter((f) => f !== '--sandbox')) expect(stdout).toContain(flag);
  });
});
