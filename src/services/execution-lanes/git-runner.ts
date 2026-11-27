/**
 * FR-R6-F10 research R5: the one way a lane operation calls Git.
 *
 * Every call goes through {@link LaneGitRunner}. The default implementation uses `spawn` with no
 * shell, detached process-group teardown (`SIGTERM` escalated to `SIGKILL` on timeout or buffer
 * overflow), streaming `maxBuffer` enforcement, and a bounded post-exit stdio-drain grace so a
 * hook or filter descendant holding pipes open cannot hang the lane past its timeout. Its
 * environment is the host's minus every variable that would point Git at another repository, with
 * the credential prompt turned off so a host operation never waits on a terminal. Every call also
 * carries the GC-11 overrides that stop the repository's fsmonitor and hooks from executing.
 *
 * A failure carries an exit code and a bounded reason code. Stderr is never returned,
 * stored or logged (hard rule 22): it can hold paths and remote URLs.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

import { withHostGitConfig } from '../../lib/host-git-config';
import { spawnCommandFor } from '../../lib/spawn-command';
import {
  childIsReaped,
  processTreeIsGone,
  processTreeSpawnOptions,
  signalProcessTree,
  trackGroupAtExit
} from '../../runner/process-tree';

/**
 * Variables that would redirect a Git call to another repository, index, object store, helper
 * binary, or config/template/SSH/pager/editor/askpass path, or change how it reads attributes and
 * pathspecs. Stripped case-insensitively (`key.toUpperCase()`) so Windows mixed/lowercase names
 * cannot bypass removal. Any `GIT_CONFIG_KEY_*` or `GIT_CONFIG_VALUE_*` key is also stripped
 * case-insensitively. Stripping `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` env overrides still
 * lets Git read the operator's real `~/.gitconfig` and `/etc/gitconfig` while preventing env-var
 * redirection. An inherited `GIT_LITERAL_PATHSPECS` would turn the LFS probe's glob into a literal
 * path that never matches (review S5).
 */
export const LANE_GIT_STRIPPED_ENV: readonly string[] = Object.freeze([
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

const LANE_GIT_STRIPPED_SET = new Set(LANE_GIT_STRIPPED_ENV);
const LANE_GIT_STRIPPED_PREFIXES: readonly string[] = Object.freeze([
  'GIT_CONFIG_KEY_',
  'GIT_CONFIG_VALUE_'
]);

/** Output bound for a call that does not set its own. */
export const GIT_DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
/** Bounded post-exit stdio drain grace so detached pipe-holding descendants cannot stall exit. */
export const GIT_OUTPUT_DRAIN_GRACE_MS = 2_000;
/** Grace between SIGTERM and SIGKILL when tearing down a timed-out or overflowing Git process tree. */
export const GIT_KILL_GRACE_MS = 250;

const GIT_EXECUTABLE = 'git';
const MAX_BUFFER_ERROR_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

export type GitFailureCode = 'exit' | 'timeout' | 'spawn' | 'buffer';

export type GitRunResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly exitCode: number | null; readonly code: GitFailureCode };

export interface GitRunOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxBuffer?: number;
}

/** The port every lane module takes; tests substitute their own. */
export interface LaneGitRunner {
  run(args: readonly string[], opts: GitRunOptions): Promise<GitRunResult>;
}

/** The subset of `execFile`'s options exposed to optional unit-test doubles. */
export interface ExecFileLikeOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly shell: false;
  readonly windowsHide: true;
  readonly encoding: 'utf8';
}

/** The fields of a child-process error the legacy test double adapter reads. */
export interface ExecFileLikeError {
  readonly code?: number | string | null;
  readonly killed?: boolean;
  readonly signal?: NodeJS.Signals | string | null;
}

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: ExecFileLikeOptions,
  callback: (error: ExecFileLikeError | null, stdout: string, stderr: string) => void
) => void;

export type GitSpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface ExecFileGitRunnerDeps {
  /** Optional legacy callback double for unit tests; production uses `spawn` with tree teardown. */
  readonly execFileImpl?: ExecFileLike;
  /** Optional spawn override for tests; defaults to `node:child_process` `spawn`. */
  readonly spawnImpl?: GitSpawnLike;
  /** The environment to copy; defaults to `process.env`. */
  readonly baseEnv?: NodeJS.ProcessEnv;
  /** Post-exit stdio drain grace in ms; defaults to {@link GIT_OUTPUT_DRAIN_GRACE_MS}. */
  readonly outputDrainGraceMs?: number;
  /** Grace between SIGTERM and SIGKILL in ms; defaults to {@link GIT_KILL_GRACE_MS}. */
  readonly killGraceMs?: number;
}

function isStrippedGitEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (LANE_GIT_STRIPPED_SET.has(upper)) return true;
  for (const prefix of LANE_GIT_STRIPPED_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Copy `base`, drop {@link LANE_GIT_STRIPPED_ENV} and `GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*`
 * case-insensitively, and set `GIT_TERMINAL_PROMPT=0`. Also the environment verification checks
 * run under (research R9).
 */
export function buildLaneGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (isStrippedGitEnvKey(key)) continue;
    if (key.toUpperCase() === 'GIT_TERMINAL_PROMPT') continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/** Whether a reaped child's PID appears held by another process (or is unsafe to signal on win32). */
function isReusedPid(child: ChildProcess): boolean {
  if (!childIsReaped(child)) return false;
  if (process.platform === 'win32') return true;
  const pid = child.pid;
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    return code !== 'ESRCH';
  }
}

function classifyFailure(error: ExecFileLikeError): GitRunResult {
  if (error.code === MAX_BUFFER_ERROR_CODE) return { ok: false, exitCode: null, code: 'buffer' };
  if (error.killed === true) return { ok: false, exitCode: null, code: 'timeout' };
  if (typeof error.code === 'number') return { ok: false, exitCode: error.code, code: 'exit' };
  return { ok: false, exitCode: null, code: 'spawn' };
}

function runWithSpawn(
  spawnFn: GitSpawnLike,
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  opts: GitRunOptions,
  outputDrainGraceMs: number,
  killGraceMs: number
): Promise<GitRunResult> {
  return new Promise<GitRunResult>((resolve) => {
    const maxBuffer = opts.maxBuffer ?? GIT_DEFAULT_MAX_BUFFER_BYTES;
    const timeoutMs = Math.max(opts.timeoutMs, 1);
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let overflowed = false;
    let settled = false;
    let teardownTriggered = false;
    let teardownAnchored = false;
    let groupAliveAtExit = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

    let child: ChildProcess;
    try {
      child = spawnFn(file, withHostGitConfig(args), {
        cwd: opts.cwd,
        env,
        shell: false,
        ...processTreeSpawnOptions(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch {
      resolve({ ok: false, exitCode: null, code: 'spawn' });
      return;
    }
    trackGroupAtExit(child);

    const canSignalTree = (): boolean => {
      if (processTreeIsGone(child)) return false;
      if (!childIsReaped(child)) return true;
      if (process.platform === 'win32') return false;
      if (!teardownAnchored && !groupAliveAtExit) return false;
      return !isReusedPid(child);
    };

    const finish = (result: GitRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      if (killTimer !== undefined && (!teardownTriggered || processTreeIsGone(child))) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      stdoutChunks.length = 0;
      resolve(result);
    };

    const resultFromExit = (code: number | null, signal: NodeJS.Signals | null): GitRunResult => {
      if (overflowed) return { ok: false, exitCode: null, code: 'buffer' };
      if (timedOut) return { ok: false, exitCode: null, code: 'timeout' };
      if (code === 0 && signal === null) {
        return { ok: true, stdout: Buffer.concat(stdoutChunks).toString('utf8') };
      }
      return { ok: false, exitCode: typeof code === 'number' ? code : null, code: 'exit' };
    };

    const teardown = (result: GitRunResult): void => {
      if (!teardownTriggered) {
        teardownAnchored = !childIsReaped(child) || groupAliveAtExit;
        teardownTriggered = true;
      }
      if (canSignalTree()) {
        void signalProcessTree(child, 'SIGTERM');
      }
      if (killTimer !== undefined) return;
      killTimer = setTimeout(() => {
        killTimer = undefined;
        const settleAfterKill = (): void => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(result);
        };
        if (canSignalTree()) {
          void signalProcessTree(child, 'SIGKILL').then(settleAfterKill, settleAfterKill);
          return;
        }
        settleAfterKill();
      }, killGraceMs);
      killTimer.unref();
    };

    const triggerOverflow = (): void => {
      if (overflowed || settled) return;
      overflowed = true;
      stdoutChunks.length = 0;
      teardown({ ok: false, exitCode: null, code: 'buffer' });
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    const timeoutTimer = setTimeout(() => {
      if (settled || overflowed || teardownTriggered) return;
      timedOut = true;
      teardown({ ok: false, exitCode: null, code: 'timeout' });
    }, timeoutMs);

    child.stdout?.on('error', () => undefined);
    child.stderr?.on('error', () => undefined);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (settled || overflowed || timedOut) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      stdoutBytes += buf.length;
      if (stdoutBytes > maxBuffer) {
        triggerOverflow();
        return;
      }
      stdoutChunks.push(buf);
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (settled || overflowed || timedOut) return;
      // Discard stderr text immediately (hard rule 22); only count bytes against maxBuffer.
      stderrBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, 'utf8');
      if (stderrBytes > maxBuffer) triggerOverflow();
    });

    child.once('error', () => finish({ ok: false, exitCode: null, code: 'spawn' }));

    child.once('close', (code, signal) => {
      if (teardownTriggered && !processTreeIsGone(child)) return;
      if (!settled && !teardownTriggered && groupAliveAtExit && canSignalTree()) {
        if (drainTimer !== undefined) {
          clearTimeout(drainTimer);
          drainTimer = undefined;
        }
        teardown(resultFromExit(code, signal));
        return;
      }
      finish(resultFromExit(code, signal));
    });

    child.once('exit', (code, signal) => {
      groupAliveAtExit = process.platform !== 'win32' && !isReusedPid(child) && !processTreeIsGone(child);
      if (settled || timedOut || overflowed) return;
      drainTimer = setTimeout(() => {
        if (settled) return;
        const result = resultFromExit(code, signal);
        if (canSignalTree()) {
          teardown(result);
          child.stdout?.destroy();
          child.stderr?.destroy();
          return;
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(result);
      }, outputDrainGraceMs);
      drainTimer.unref();
    });
  });
}

/** The production {@link LaneGitRunner}. */
export function createExecFileGitRunner(deps: ExecFileGitRunnerDeps = {}): LaneGitRunner {
  const execFileImpl = deps.execFileImpl;
  const spawnImpl = deps.spawnImpl ?? nodeSpawn;
  const outputDrainGraceMs = deps.outputDrainGraceMs ?? GIT_OUTPUT_DRAIN_GRACE_MS;
  const killGraceMs = deps.killGraceMs ?? GIT_KILL_GRACE_MS;
  const env = buildLaneGitEnv(deps.baseEnv ?? process.env);
  return {
    run: (args, opts) => {
      // Review gap GC-24 -- on win32 `git` resolves along PATH only, never the lane's cwd.
      let file: string;
      try {
        file = spawnCommandFor(GIT_EXECUTABLE, env);
      } catch {
        return Promise.resolve({ ok: false, exitCode: null, code: 'spawn' });
      }
      if (execFileImpl !== undefined) {
        return new Promise<GitRunResult>((resolve) => {
          const options: ExecFileLikeOptions = {
            cwd: opts.cwd,
            env,
            timeout: opts.timeoutMs,
            maxBuffer: opts.maxBuffer ?? GIT_DEFAULT_MAX_BUFFER_BYTES,
            shell: false,
            windowsHide: true,
            encoding: 'utf8'
          };
          execFileImpl(file, withHostGitConfig(args), options, (error, stdout) => {
            resolve(error === null ? { ok: true, stdout } : classifyFailure(error));
          });
        });
      }
      return runWithSpawn(spawnImpl, file, args, env, opts, outputDrainGraceMs, killGraceMs);
    }
  };
}

/**
 * A Git call that a lane operation needed and that failed for a reason no refusal names. It
 * carries the bounded failure code and exit code only, never Git's output (hard rule 22).
 */
export class LaneGitError extends Error {
  public readonly code: GitFailureCode;
  public readonly exitCode: number | null;

  public constructor(
    public readonly operation: string,
    failure: { readonly code: GitFailureCode; readonly exitCode: number | null }
  ) {
    super(`lane git step failed: ${operation} (${failure.code})`);
    this.name = 'LaneGitError';
    this.code = failure.code;
    this.exitCode = failure.exitCode;
  }
}
