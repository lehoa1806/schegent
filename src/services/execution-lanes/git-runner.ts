/**
 * FR-R6-F10 research R5: the one way a lane operation calls Git.
 *
 * Every call goes through {@link LaneGitRunner}. The default implementation uses
 * `execFile` with no shell, the caller's timeout and a bounded output buffer. Its
 * environment is the host's minus every variable that would point Git at another
 * repository, with the credential prompt turned off so a host operation never waits
 * on a terminal. Every call also carries the GC-11 overrides that stop the repository's
 * fsmonitor and hooks from executing.
 *
 * A failure carries an exit code and a bounded reason code. Stderr is never returned,
 * stored or logged (hard rule 22): it can hold paths and remote URLs.
 */

import { execFile } from 'node:child_process';

import { withHostGitConfig } from '../../lib/host-git-config';

/**
 * Variables that would redirect a Git call to another repository, index or object store, or
 * change how it reads config, attributes and pathspecs. An inherited `GIT_LITERAL_PATHSPECS`
 * would turn the LFS probe's glob into a literal path that never matches (review S5).
 * Unsetting `GIT_CONFIG_COUNT` disables every `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` pair.
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
  'GIT_PREFIX'
]);

/** Output bound for a call that does not set its own. */
export const GIT_DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;

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

/** The subset of `execFile`'s options the runner sets. */
export interface ExecFileLikeOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly shell: false;
  readonly windowsHide: true;
  readonly encoding: 'utf8';
}

/** The fields of a child-process error the runner reads. */
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

export interface ExecFileGitRunnerDeps {
  /** Defaults to `node:child_process` `execFile`. */
  readonly execFileImpl?: ExecFileLike;
  /** The environment to copy; defaults to `process.env`. */
  readonly baseEnv?: NodeJS.ProcessEnv;
}

/**
 * Copy `base`, drop {@link LANE_GIT_STRIPPED_ENV} and set `GIT_TERMINAL_PROMPT=0`.
 * Also the environment verification checks run under (research R9).
 */
export function buildLaneGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of LANE_GIT_STRIPPED_ENV) {
    delete env[name];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

const defaultExecFile: ExecFileLike = (file, args, options, callback) => {
  execFile(file, [...args], options, (error, stdout, stderr) => {
    callback(error, stdout, stderr);
  });
};

function classifyFailure(error: ExecFileLikeError): GitRunResult {
  if (error.code === MAX_BUFFER_ERROR_CODE) return { ok: false, exitCode: null, code: 'buffer' };
  if (error.killed === true) return { ok: false, exitCode: null, code: 'timeout' };
  if (typeof error.code === 'number') return { ok: false, exitCode: error.code, code: 'exit' };
  return { ok: false, exitCode: null, code: 'spawn' };
}

/** The production {@link LaneGitRunner}. */
export function createExecFileGitRunner(deps: ExecFileGitRunnerDeps = {}): LaneGitRunner {
  const execFileImpl = deps.execFileImpl ?? defaultExecFile;
  const env = buildLaneGitEnv(deps.baseEnv ?? process.env);
  return {
    run: (args, opts) =>
      new Promise<GitRunResult>((resolve) => {
        const options: ExecFileLikeOptions = {
          cwd: opts.cwd,
          env,
          timeout: opts.timeoutMs,
          maxBuffer: opts.maxBuffer ?? GIT_DEFAULT_MAX_BUFFER_BYTES,
          shell: false,
          windowsHide: true,
          encoding: 'utf8'
        };
        execFileImpl(GIT_EXECUTABLE, withHostGitConfig(args), options, (error, stdout) => {
          resolve(error === null ? { ok: true, stdout } : classifyFailure(error));
        });
      })
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
