// FR-R6-F10 T007 (research R5) — the lane Git runner.
//
// WHAT THIS PINS:
//   - the default runner calls `execFile` with no shell, the caller's timeout and a bounded
//     `maxBuffer`;
//   - the child environment drops every variable that would redirect Git to another repository
//     and turns off the credential prompt;
//   - a failure carries an exit code and a bounded reason code, never stderr text.

import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  GIT_DEFAULT_MAX_BUFFER_BYTES,
  LANE_GIT_STRIPPED_ENV,
  buildLaneGitEnv,
  createExecFileGitRunner,
  type ExecFileLike,
  type ExecFileLikeError,
  type ExecFileLikeOptions
} from '../../../src/services/execution-lanes/git-runner';

interface RecordedCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: ExecFileLikeOptions;
}

function fakeExecFile(
  calls: RecordedCall[],
  outcome: { error: ExecFileLikeError | null; stdout: string; stderr: string }
): ExecFileLike {
  return (file, args, options, callback) => {
    calls.push({ file, args: [...args], options });
    callback(outcome.error, outcome.stdout, outcome.stderr);
  };
}

function onlyCall(calls: readonly RecordedCall[]): RecordedCall {
  expect(calls).toHaveLength(1);
  const call = calls.at(0);
  if (call === undefined) throw new Error('no call recorded');
  return call;
}

const REDIRECTING_ENV: Record<string, string> = {
  PATH: '/usr/bin',
  HOME: '/home/someone',
  GIT_DIR: '/elsewhere/.git',
  GIT_WORK_TREE: '/elsewhere',
  GIT_INDEX_FILE: '/elsewhere/.git/index',
  GIT_OBJECT_DIRECTORY: '/elsewhere/.git/objects',
  GIT_ALTERNATE_OBJECT_DIRECTORIES: '/elsewhere/alt',
  GIT_COMMON_DIR: '/elsewhere/.git',
  GIT_NAMESPACE: 'other',
  GIT_SHALLOW_FILE: '/elsewhere/shallow',
  GIT_REPLACE_REF_BASE: 'refs/other/',
  GIT_ATTR_SOURCE: 'HEAD~1',
  GIT_CONFIG_PARAMETERS: "'core.bare'='true'",
  GIT_CONFIG_COUNT: '1',
  GIT_LITERAL_PATHSPECS: '1',
  GIT_GLOB_PATHSPECS: '1',
  GIT_NOGLOB_PATHSPECS: '1',
  GIT_ICASE_PATHSPECS: '1',
  GIT_PREFIX: 'sub/',
  GIT_TERMINAL_PROMPT: '1'
};

describe('FR-R6-F10 lane Git environment (research R5)', () => {
  it('names the redirecting variables and those that change how Git reads config, attributes and pathspecs', () => {
    expect([...LANE_GIT_STRIPPED_ENV]).toEqual([
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_COMMON_DIR',
      'GIT_NAMESPACE',
      'GIT_SHALLOW_FILE',
      'GIT_REPLACE_REF_BASE',
      'GIT_ATTR_SOURCE',
      'GIT_CONFIG_PARAMETERS',
      'GIT_CONFIG_COUNT',
      'GIT_LITERAL_PATHSPECS',
      'GIT_GLOB_PATHSPECS',
      'GIT_NOGLOB_PATHSPECS',
      'GIT_ICASE_PATHSPECS',
      'GIT_PREFIX'
    ]);
    expect(Object.isFrozen(LANE_GIT_STRIPPED_ENV)).toBe(true);
  });

  it('drops every redirecting variable, keeps the rest and disables the prompt', () => {
    const env = buildLaneGitEnv(REDIRECTING_ENV);
    for (const name of LANE_GIT_STRIPPED_ENV) {
      expect(Object.hasOwn(env, name), name).toBe(false);
    }
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/someone');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('does not change the environment it copies', () => {
    const base = { ...REDIRECTING_ENV };
    buildLaneGitEnv(base);
    expect(base).toEqual(REDIRECTING_ENV);
  });
});

describe('FR-R6-F10 createExecFileGitRunner (research R5)', () => {
  it('calls git through execFile with no shell, the timeout and the default buffer bound', async () => {
    const calls: RecordedCall[] = [];
    const runner = createExecFileGitRunner({
      execFileImpl: fakeExecFile(calls, { error: null, stdout: 'abc\n', stderr: 'noise' }),
      baseEnv: REDIRECTING_ENV
    });
    const result = await runner.run(['rev-parse', 'HEAD'], { cwd: '/repo', timeoutMs: 5_000 });
    expect(result).toEqual({ ok: true, stdout: 'abc\n' });
    const call = onlyCall(calls);
    expect(call.file).toBe('git');
    expect(call.args).toEqual(['rev-parse', 'HEAD']);
    expect(call.options.shell).toBe(false);
    expect(call.options.cwd).toBe('/repo');
    expect(call.options.timeout).toBe(5_000);
    expect(call.options.maxBuffer).toBe(GIT_DEFAULT_MAX_BUFFER_BYTES);
    expect(call.options.encoding).toBe('utf8');
    for (const name of LANE_GIT_STRIPPED_ENV) {
      expect(Object.hasOwn(call.options.env, name), name).toBe(false);
    }
    expect(call.options.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('passes a caller maxBuffer through', async () => {
    const calls: RecordedCall[] = [];
    const runner = createExecFileGitRunner({
      execFileImpl: fakeExecFile(calls, { error: null, stdout: '', stderr: '' }),
      baseEnv: {}
    });
    await runner.run(['status'], { cwd: '/repo', timeoutMs: 1_000, maxBuffer: 2_048 });
    expect(onlyCall(calls).options.maxBuffer).toBe(2_048);
  });

  it('maps a non-zero exit to exit with its code and no stderr text', async () => {
    const error: ExecFileLikeError = { code: 128, killed: false, signal: null };
    const runner = createExecFileGitRunner({
      execFileImpl: fakeExecFile([], { error, stdout: '', stderr: 'fatal: secret path /home/x' }),
      baseEnv: {}
    });
    const result = await runner.run(['update-ref', 'r', 'x', ''], { cwd: '/repo', timeoutMs: 1_000 });
    expect(result).toEqual({ ok: false, exitCode: 128, code: 'exit' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('maps a killed child to timeout', async () => {
    const error: ExecFileLikeError = { code: null, killed: true, signal: 'SIGTERM' };
    const runner = createExecFileGitRunner({
      execFileImpl: fakeExecFile([], { error, stdout: '', stderr: '' }),
      baseEnv: {}
    });
    expect(await runner.run(['fetch'], { cwd: '/repo', timeoutMs: 1_000 })).toEqual({
      ok: false,
      exitCode: null,
      code: 'timeout'
    });
  });

  it('maps an output overflow to buffer, even though the child was killed', async () => {
    const error: ExecFileLikeError = { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM' };
    const runner = createExecFileGitRunner({
      execFileImpl: fakeExecFile([], { error, stdout: '', stderr: '' }),
      baseEnv: {}
    });
    expect(await runner.run(['log'], { cwd: '/repo', timeoutMs: 1_000 })).toEqual({
      ok: false,
      exitCode: null,
      code: 'buffer'
    });
  });

  it('maps a spawn failure to spawn', async () => {
    const error: ExecFileLikeError = { code: 'ENOENT', killed: false, signal: null };
    const runner = createExecFileGitRunner({
      execFileImpl: fakeExecFile([], { error, stdout: '', stderr: '' }),
      baseEnv: {}
    });
    expect(await runner.run(['status'], { cwd: '/nowhere', timeoutMs: 1_000 })).toEqual({
      ok: false,
      exitCode: null,
      code: 'spawn'
    });
  });

  it('uses the real execFile by default', async () => {
    const runner = createExecFileGitRunner();
    const version = await runner.run(['--version'], { cwd: tmpdir(), timeoutMs: 10_000 });
    expect(version.ok).toBe(true);
    if (version.ok) expect(version.stdout.startsWith('git version ')).toBe(true);
    const unknown = await runner.run(['schegent-no-such-subcommand'], { cwd: tmpdir(), timeoutMs: 10_000 });
    expect(unknown).toEqual({ ok: false, exitCode: 1, code: 'exit' });
  });
});
