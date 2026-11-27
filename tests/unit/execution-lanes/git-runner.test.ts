// FR-R6-F10 T007 (research R5) — the lane Git runner.
//
// WHAT THIS PINS:
//   - the default runner calls `execFile` with no shell, the caller's timeout and a bounded
//     `maxBuffer`;
//   - the child environment drops every variable that would redirect Git to another repository
//     and turns off the credential prompt;
//   - a failure carries an exit code and a bounded reason code, never stderr text.

import { spawn as nodeSpawn } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GIT_DEFAULT_MAX_BUFFER_BYTES,
  LANE_GIT_STRIPPED_ENV,
  LaneGitError,
  buildLaneGitEnv,
  createExecFileGitRunner,
  type ExecFileLike,
  type ExecFileLikeError,
  type ExecFileLikeOptions
} from '../../../src/services/execution-lanes/git-runner';
import { HOST_GIT_CONFIG_OVERRIDES } from '../../../src/lib/host-git-config';
import { waitForCondition } from '../../wait-for-condition';
import { createLaneHarness, disposeLaneHarnesses, HARNESS_WS } from './lane-harness';

const tempDirs: string[] = [];
const pidsToKill: number[] = [];

afterEach(() => {
  disposeLaneHarnesses();
  for (const pid of pidsToKill.splice(0, pidsToKill.length)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already exited.
    }
  }
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const ENV_WITH_PATH: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' };

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
  PATH: process.env.PATH ?? '/usr/bin',
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
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/tmp/evil-hooks',
  GIT_LITERAL_PATHSPECS: '1',
  GIT_GLOB_PATHSPECS: '1',
  GIT_NOGLOB_PATHSPECS: '1',
  GIT_ICASE_PATHSPECS: '1',
  GIT_PREFIX: 'sub/',
  GIT_EXEC_PATH: '/tmp/evil-git-exec',
  GIT_CONFIG_GLOBAL: '/tmp/evil-gitconfig',
  GIT_CONFIG_SYSTEM: '/tmp/evil-sysconfig',
  GIT_CONFIG: '/tmp/evil-config',
  GIT_EXTERNAL_DIFF: '/tmp/evil-diff',
  GIT_TEMPLATE_DIR: '/tmp/evil-template',
  GIT_SSH_COMMAND: 'sh -c evil',
  GIT_SSH: '/tmp/evil-ssh',
  GIT_ASKPASS: '/tmp/evil-askpass',
  SSH_ASKPASS: '/tmp/evil-ssh-askpass',
  GIT_PAGER: '/tmp/evil-pager',
  GIT_EDITOR: '/tmp/evil-editor',
  GIT_SEQUENCE_EDITOR: '/tmp/evil-seq-editor',
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
      'GIT_PREFIX',
      'GIT_EXEC_PATH',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_SYSTEM',
      'GIT_CONFIG',
      'GIT_EXTERNAL_DIFF',
      'GIT_TEMPLATE_DIR',
      'GIT_SSH_COMMAND',
      'GIT_SSH',
      'GIT_ASKPASS',
      'SSH_ASKPASS',
      'GIT_PAGER',
      'GIT_EDITOR',
      'GIT_SEQUENCE_EDITOR'
    ]);
    expect(Object.isFrozen(LANE_GIT_STRIPPED_ENV)).toBe(true);
  });

  it('drops every redirecting variable and GIT_CONFIG_KEY_/VALUE_ pair, keeps the rest and disables the prompt', () => {
    const env = buildLaneGitEnv(REDIRECTING_ENV);
    for (const name of LANE_GIT_STRIPPED_ENV) {
      expect(Object.hasOwn(env, name), name).toBe(false);
    }
    expect(Object.hasOwn(env, 'GIT_CONFIG_KEY_0')).toBe(false);
    expect(Object.hasOwn(env, 'GIT_CONFIG_VALUE_0')).toBe(false);
    expect(env.PATH).toBe(REDIRECTING_ENV.PATH);
    expect(env.HOME).toBe('/home/someone');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('strips Git redirecting and config variables case-insensitively (SR-B4 Windows mixed/lowercase guard)', () => {
    const mixedCase: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      git_dir: '/evil/.git',
      Git_Work_Tree: '/evil',
      git_config_parameters: "'core.hooksPath'='/evil'",
      Git_Config_Global: '/evil/global',
      git_config_system: '/evil/system',
      git_exec_path: '/evil/exec',
      git_ssh_command: 'evil-ssh',
      ssh_askpass: '/evil/askpass',
      git_config_key_0: 'core.fsmonitor',
      Git_Config_Value_0: '/evil/fsmonitor',
      git_terminal_prompt: '1',
      SAFE_KEEP_VAR: 'keep-me'
    };
    const env = buildLaneGitEnv(mixedCase);
    for (const key of Object.keys(mixedCase)) {
      if (key === 'PATH' || key === 'SAFE_KEEP_VAR') continue;
      expect(Object.hasOwn(env, key), key).toBe(false);
    }
    expect(env.PATH).toBe('/usr/bin');
    expect(env.SAFE_KEEP_VAR).toBe('keep-me');
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
    expect(path.basename(call.file)).toMatch(/^git(?:\.exe)?$/i);
    expect(call.args).toEqual([...HOST_GIT_CONFIG_OVERRIDES, 'rev-parse', 'HEAD']);
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
      baseEnv: ENV_WITH_PATH
    });
    await runner.run(['status'], { cwd: '/repo', timeoutMs: 1_000, maxBuffer: 2_048 });
    expect(onlyCall(calls).options.maxBuffer).toBe(2_048);
  });

  it('maps a non-zero exit to exit with its code and no stderr text', async () => {
    const error: ExecFileLikeError = { code: 128, killed: false, signal: null };
    const runner = createExecFileGitRunner({
      execFileImpl: fakeExecFile([], { error, stdout: '', stderr: 'fatal: secret path /home/x' }),
      baseEnv: ENV_WITH_PATH
    });
    const result = await runner.run(['update-ref', 'r', 'x', ''], { cwd: '/repo', timeoutMs: 1_000 });
    expect(result).toEqual({ ok: false, exitCode: 128, code: 'exit' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('maps a killed child to timeout', async () => {
    const error: ExecFileLikeError = { code: null, killed: true, signal: 'SIGTERM' };
    const runner = createExecFileGitRunner({
      execFileImpl: fakeExecFile([], { error, stdout: '', stderr: '' }),
      baseEnv: ENV_WITH_PATH
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
      baseEnv: ENV_WITH_PATH
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
      baseEnv: ENV_WITH_PATH
    });
    expect(await runner.run(['status'], { cwd: '/nowhere', timeoutMs: 1_000 })).toEqual({
      ok: false,
      exitCode: null,
      code: 'spawn'
    });
  });

  it('uses the real spawn runner by default', async () => {
    const runner = createExecFileGitRunner();
    const version = await runner.run(['--version'], { cwd: tmpdir(), timeoutMs: 10_000 });
    expect(version.ok).toBe(true);
    if (version.ok) expect(version.stdout.startsWith('git version ')).toBe(true);
    const unknown = await runner.run(['schegent-no-such-subcommand'], { cwd: tmpdir(), timeoutMs: 10_000 });
    expect(unknown).toEqual({ ok: false, exitCode: 1, code: 'exit' });
  });
});

describe('FR-R7-16 (16-18): bounded Git process-group teardown, drain grace, and >1 MiB status', () => {
  const IS_WINDOWS = process.platform === 'win32';

  it.skipIf(IS_WINDOWS)(
    'terminates a SIGTERM-ignoring child and its pipe-holding grandchild within bounded timeout teardown',
    async () => {
      const dir = fs.mkdtempSync(path.join(tmpdir(), 'git-runner-timeout-'));
      tempDirs.push(dir);
      const pidFile = path.join(dir, 'grandchild.pid');
      // Parent traps SIGTERM and forks a same-group grandchild holding stdout open.
      const script = [
        "process.on('SIGTERM', () => {});",
        "const cp = require('node:child_process');",
        "const child = cp.spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'inherit' });",
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        'setInterval(() => {}, 1000);'
      ].join(' ');

      const runner = createExecFileGitRunner({
        baseEnv: ENV_WITH_PATH,
        killGraceMs: 150,
        outputDrainGraceMs: 250,
        spawnImpl: (_cmd, _args, opts) => nodeSpawn(process.execPath, ['-e', script], opts)
      });

      const started = Date.now();
      const result = await runner.run(['status'], { cwd: dir, timeoutMs: 250 });
      const elapsed = Date.now() - started;

      expect(result).toEqual({ ok: false, exitCode: null, code: 'timeout' });
      expect(elapsed).toBeLessThan(3_000);
      if (fs.existsSync(pidFile)) {
        const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
        pidsToKill.push(grandchildPid);
        await waitForCondition(
          () => {
            try {
              process.kill(grandchildPid, 0);
              return false;
            } catch {
              return true;
            }
          },
          { timeoutMs: 2_000, label: 'grandchild reaped after SIGKILL' }
        );
      }
    },
    10_000
  );

  it.skipIf(IS_WINDOWS)(
    'settles within outputDrainGraceMs when a detached descendant holds stdio open after exit',
    async () => {
      const dir = fs.mkdtempSync(path.join(tmpdir(), 'git-runner-drain-'));
      tempDirs.push(dir);
      const pidFile = path.join(dir, 'detached.pid');
      const script = [
        "const cp = require('node:child_process');",
        "const c = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'inherit' });",
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
        'c.unref();',
        "process.stdout.write('ok-before-drain\\n');"
      ].join(' ');

      const runner = createExecFileGitRunner({
        baseEnv: ENV_WITH_PATH,
        outputDrainGraceMs: 250,
        spawnImpl: (_cmd, _args, opts) => nodeSpawn(process.execPath, ['-e', script], opts)
      });

      const started = Date.now();
      const result = await runner.run(['status'], { cwd: dir, timeoutMs: 10_000 });
      const elapsed = Date.now() - started;

      if (fs.existsSync(pidFile)) {
        pidsToKill.push(Number(fs.readFileSync(pidFile, 'utf8')));
      }
      expect(result).toEqual({ ok: true, stdout: 'ok-before-drain\n' });
      expect(elapsed).toBeLessThan(2_500);
    },
    10_000
  );

  it('enforces streaming maxBuffer on stdout and stderr, returning code: buffer with zero stderr leaked', async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'git-runner-buf-'));
    tempDirs.push(dir);

    const stdoutOverflow = createExecFileGitRunner({
      baseEnv: ENV_WITH_PATH,
      killGraceMs: 100,
      spawnImpl: (_cmd, _args, opts) =>
        nodeSpawn(process.execPath, ['-e', "process.stdout.write('x'.repeat(200_000))"], opts)
    });
    const outRes = await stdoutOverflow.run(['status'], { cwd: dir, timeoutMs: 5_000, maxBuffer: 16_384 });
    expect(outRes).toEqual({ ok: false, exitCode: null, code: 'buffer' });

    const stderrOverflow = createExecFileGitRunner({
      baseEnv: ENV_WITH_PATH,
      killGraceMs: 100,
      spawnImpl: (_cmd, _args, opts) =>
        nodeSpawn(process.execPath, ['-e', "process.stderr.write('SECRET_PATH_LEAK'.repeat(20_000))"], opts)
    });
    const errRes = await stderrOverflow.run(['status'], { cwd: dir, timeoutMs: 5_000, maxBuffer: 16_384 });
    expect(errRes).toEqual({ ok: false, exitCode: null, code: 'buffer' });
    expect(JSON.stringify(errRes)).not.toContain('SECRET_PATH_LEAK');
  });

  it.skipIf(IS_WINDOWS)(
    'escalates SIGKILL to a SIGTERM-ignoring same-group descendant after maxBuffer overflow even when parent exits immediately (CR-B3/SR-B5)',
    async () => {
      const dir = fs.mkdtempSync(path.join(tmpdir(), 'git-runner-buf-tree-'));
      tempDirs.push(dir);
      const pidFile = path.join(dir, 'descendant.pid');
      // Parent spawns a same-group SIGTERM-ignoring descendant, writes overflowing stdout, and exits on EPIPE/SIGTERM.
      const script = [
        "const cp = require('node:child_process');",
        "const fs = require('node:fs');",
        "const g = cp.spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000);\"], { stdio: 'ignore' });",
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
        "process.stdout.on('error', () => process.exit(1));",
        "process.stdout.write('x'.repeat(200_000));"
      ].join(' ');

      const runner = createExecFileGitRunner({
        baseEnv: ENV_WITH_PATH,
        killGraceMs: 120,
        outputDrainGraceMs: 250,
        spawnImpl: (_cmd, _args, opts) => nodeSpawn(process.execPath, ['-e', script], opts)
      });

      const res = await runner.run(['status'], { cwd: dir, timeoutMs: 5_000, maxBuffer: 16_384 });
      expect(res).toEqual({ ok: false, exitCode: null, code: 'buffer' });

      await waitForCondition(() => fs.existsSync(pidFile), { timeoutMs: 2_000, label: 'descendant pid file written' });
      const descendantPid = Number(fs.readFileSync(pidFile, 'utf8'));
      pidsToKill.push(descendantPid);
      await waitForCondition(
        () => {
          try {
            process.kill(descendantPid, 0);
            return false;
          } catch {
            return true;
          }
        },
        { timeoutMs: 3_000, label: 'SIGTERM-ignoring descendant killed after overflow SIGKILL escalation' }
      );
    },
    10_000
  );

  it.skipIf(IS_WINDOWS)(
    'tears down a lingering same-group pipe-holding descendant on drainTimer expiry before settling (CR-B3/SR-B5)',
    async () => {
      const dir = fs.mkdtempSync(path.join(tmpdir(), 'git-runner-drain-tree-'));
      tempDirs.push(dir);
      const pidFile = path.join(dir, 'lingering.pid');
      const script = [
        "const cp = require('node:child_process');",
        "const fs = require('node:fs');",
        "const g = cp.spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000);\"], { stdio: 'inherit' });",
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
        'g.unref();',
        "process.stdout.write('ok-drain-teardown\\n');"
      ].join(' ');

      const runner = createExecFileGitRunner({
        baseEnv: ENV_WITH_PATH,
        outputDrainGraceMs: 150,
        killGraceMs: 120,
        spawnImpl: (_cmd, _args, opts) => nodeSpawn(process.execPath, ['-e', script], opts)
      });

      const res = await runner.run(['status'], { cwd: dir, timeoutMs: 10_000 });
      expect(res).toEqual({ ok: true, stdout: 'ok-drain-teardown\n' });

      await waitForCondition(() => fs.existsSync(pidFile), { timeoutMs: 2_000, label: 'lingering pid file written' });
      const lingeringPid = Number(fs.readFileSync(pidFile, 'utf8'));
      pidsToKill.push(lingeringPid);
      await waitForCondition(
        () => {
          try {
            process.kill(lingeringPid, 0);
            return false;
          } catch {
            return true;
          }
        },
        { timeoutMs: 3_000, label: 'lingering same-group descendant killed on drainTimer expiry' }
      );
    },
    10_000
  );

  it.skipIf(IS_WINDOWS)(
    'tears down a surviving same-group descendant with closed stdio on close before settling (CR-309-1)',
    async () => {
      const dir = fs.mkdtempSync(path.join(tmpdir(), 'git-runner-close-tree-'));
      tempDirs.push(dir);
      const pidFile = path.join(dir, 'background.pid');
      const script = [
        "const cp = require('node:child_process');",
        "const fs = require('node:fs');",
        "const g = cp.spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000);\"], { stdio: 'ignore' });",
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
        'g.unref();',
        "process.stdout.write('ok-closed-stdio\\n');"
      ].join(' ');

      const runner = createExecFileGitRunner({
        baseEnv: ENV_WITH_PATH,
        outputDrainGraceMs: 5_000,
        killGraceMs: 120,
        spawnImpl: (_cmd, _args, opts) => nodeSpawn(process.execPath, ['-e', script], opts)
      });

      const started = Date.now();
      const res = await runner.run(['status'], { cwd: dir, timeoutMs: 10_000 });
      const elapsed = Date.now() - started;

      expect(res).toEqual({ ok: true, stdout: 'ok-closed-stdio\n' });
      expect(elapsed).toBeLessThan(3_000);

      await waitForCondition(() => fs.existsSync(pidFile), { timeoutMs: 2_000, label: 'background pid file written' });
      const bgPid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(Number.isInteger(bgPid) && bgPid > 0).toBe(true);
      pidsToKill.push(bgPid);
      await waitForCondition(
        () => {
          try {
            process.kill(bgPid, 0);
            return false;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ESRCH';
          }
        },
        { timeoutMs: 3_000, label: 'same-group background child with closed stdio torn down on close' }
      );
    },
    10_000
  );

  it('handles >1 MiB git status output across verification, cleanup, and landing without wedging', async () => {
    const h = createLaneHarness({ label: 'large-status' });
    const lane = await h.provision();
    const sibling = await h.provision();
    const laneRoot = await h.laneRoot(lane.laneId);
    fs.writeFileSync(path.join(laneRoot, 'src', 'a.txt'), 'changed-for-candidate\n');
    const frozen = await h.service.freezeCandidate({ laneId: lane.laneId });
    expect(frozen.ok).toBe(true);

    const queued = await h.service.requestIntegration({
      laneId: lane.laneId,
      targetBranch: 'main',
      profile: {
        profileId: 'unit',
        revision: 1,
        checks: [{ name: 'ok', argv: [process.execPath, '-e', 'process.exitCode = 0'], timeoutMs: 10_000 }]
      }
    });
    if (!queued.ok) throw new Error(`request failed: ${queued.refusal.reason}`);

    // Create >1 MiB of untracked status output inside the lane (6,000 files x ~190 byte relative path).
    const longDir = path.join(laneRoot, 'd'.repeat(160));
    fs.mkdirSync(longDir, { recursive: true });
    for (let i = 0; i < 6_000; i += 1) {
      fs.writeFileSync(path.join(longDir, `f_${String(i).padStart(5, '0')}_${'x'.repeat(20)}.txt`), '');
    }

    // 1. Verification fails with diagnosable `buffer` LaneGitError, releases busy lane & returns request to queued.
    let verifyErr: unknown;
    try {
      await h.service.verifyRequest({ requestId: queued.value.requestId });
    } catch (err) {
      verifyErr = err;
    }
    expect(verifyErr).toBeInstanceOf(LaneGitError);
    expect((verifyErr as LaneGitError).code).toBe('buffer');
    expect(h.integrations.getRequest(HARNESS_WS, queued.value.requestId)?.state).toBe('queued');
    // Lane is no longer busy and lane work is preserved.
    expect(h.service.cancelRequest({ requestId: queued.value.requestId }).ok).toBe(true);
    expect(fs.existsSync(path.join(laneRoot, 'src', 'a.txt'))).toBe(true);

    // 2. Cleanup keeps the >1 MiB lane with diagnosable `status-buffer-exceeded` AND still cleans sibling!
    expect(h.service.completeLane({ laneId: lane.laneId }).ok).toBe(true);
    expect(h.service.releaseLane({ laneId: lane.laneId, disposition: 'eligible' }).ok).toBe(true);
    expect(h.service.completeLane({ laneId: sibling.laneId }).ok).toBe(true);
    expect(h.service.releaseLane({ laneId: sibling.laneId, disposition: 'eligible' }).ok).toBe(true);

    const report = await h.service.cleanupLanes({});
    expect(report).toEqual({
      ok: true,
      value: {
        removed: [sibling.laneId],
        kept: [{ laneId: lane.laneId, observation: 'status-buffer-exceeded' }]
      }
    });
    expect(fs.existsSync(path.join(laneRoot, 'src', 'a.txt'))).toBe(true);

    // 3. Landing on a checked-out target whose status fails with `buffer` settles cleanly instead of wedging.
    const hLand = createLaneHarness({
      label: 'large-status-land',
      wrapGit: (real) => ({
        run: (args, opts) => {
          if (args.includes('status') && args.includes('--untracked-files=no')) {
            return Promise.resolve({ ok: false, exitCode: null, code: 'buffer' });
          }
          return real.run(args, opts);
        }
      })
    });
    const landLane = await hLand.provision();
    fs.writeFileSync(path.join(await hLand.laneRoot(landLane.laneId), 'src', 'a.txt'), 'land-edit\n');
    expect((await hLand.service.freezeCandidate({ laneId: landLane.laneId })).ok).toBe(true);
    const req = await hLand.service.requestIntegration({
      laneId: landLane.laneId,
      targetBranch: 'main',
      profile: {
        profileId: 'unit',
        revision: 1,
        checks: [{ name: 'ok', argv: [process.execPath, '-e', 'process.exitCode = 0'], timeoutMs: 10_000 }]
      }
    });
    if (!req.ok) throw new Error(`request failed: ${req.refusal.reason}`);
    // Verify using real status first, then move to awaiting-review + approve + land under buffer status.
    const moved = hLand.integrations.transitionRequest(HARNESS_WS, req.value.requestId, ['queued'], 'awaiting-review', {
      reason: null,
      now: new Date(Date.UTC(2026, 10, 10, 12, 0, 0)).toISOString(),
      generation: hLand.service.generation
    });
    expect(moved.ok).toBe(true);
    const approved = hLand.service.approveRequest({
      requestId: req.value.requestId,
      candidateCommit: req.value.candidateCommit,
      targetCommit: req.value.expectedTargetCommit,
      profileRevision: req.value.profile.revision,
      profileDigest: req.value.profile.digest
    });
    expect(approved.ok).toBe(true);

    const landed = await hLand.service.landRequest({ requestId: req.value.requestId });
    expect(landed.ok).toBe(false);
    if (!landed.ok) expect(landed.refusal.reason).toBe('target-worktree-dirty');
    // Request is settled as blocked (NOT wedged in `landing`!).
    expect(hLand.integrations.getRequest(HARNESS_WS, req.value.requestId)?.state).toBe('blocked');

    // Also verify reconcile on a `landing` request at candidate tip with >1 MiB target status settles `uncertain`.
    const movedLanding = hLand.integrations.transitionRequest(HARNESS_WS, req.value.requestId, ['blocked'], 'landing', {
      reason: null,
      now: new Date(Date.UTC(2026, 10, 10, 12, 0, 1)).toISOString(),
      generation: hLand.service.generation
    });
    expect(movedLanding.ok).toBe(true);
    hLand.fixture.git(['update-ref', 'refs/heads/main', req.value.candidateCommit]);
    const rec = await hLand.service.reconcile();
    expect(rec.ok).toBe(true);
    expect(hLand.integrations.getRequest(HARNESS_WS, req.value.requestId)?.state).toBe('uncertain');
  }, 30_000);
});
