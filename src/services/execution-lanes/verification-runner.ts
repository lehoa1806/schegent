/**
 * FR-R6-F10 (research R9): executing a request's frozen verification profile in its lane.
 *
 * Each check is spawned with no shell, in the lane root, with the R5 environment built from the
 * operator's process-environment policy (review gap GC-15). Its stdout and
 * stderr are streamed into one SHA-256 and a byte count, then discarded; no output text is kept
 * (SC-006). Checks run in order and the first failure stops the run. A check settles when its
 * output closes, or a short grace after it exits, whichever comes first.
 *
 * Before the first check and after the last, the lane must still hold the candidate, with no
 * tracked change: a check that rewrites a tracked file has verified some other tree. Before the
 * first check no untracked file may exist either (review S3); ignored files are not seen.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { VerificationCheck, VerificationProfile } from '../../contracts/execution-lanes';
import { SHIPPED_DEFAULT_POLICY, type ProcessEnvironmentPolicy } from '../../contracts/process-environment-policy';
import { spawnCommandFor } from '../../lib/spawn-command';
import { buildSpawnEnv } from '../../runner/spawn-env';
import { allDirtyCount, trackedDirtyCount } from './git-observe';
import { buildLaneGitEnv, LaneGitError, type LaneGitRunner } from './git-runner';
import type { IntegrationStore, RequestRecord, VerificationResultRecord } from './integration-store';

/** What one check did. `exitCode` is `null` when it was killed or never started. */
export interface CheckRun {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly outputBytes: number;
  readonly outputSha256: string;
}

export interface SpawnCheckOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
}

/** The verification process port (contract §5, `spawnCheck`). */
export type SpawnCheck = (argv: readonly string[], options: SpawnCheckOptions) => Promise<CheckRun>;

type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface SpawnCheckDeps {
  readonly spawn?: SpawnLike;
  /** The environment the policy selects from; default `process.env`. */
  readonly baseEnv?: NodeJS.ProcessEnv;
  /**
   * The operator's process-environment policy, read at each check so a changed setting reaches
   * the next one; default the shipped policy, an empty allowlist (review gap GC-15).
   */
  readonly environmentPolicy?: () => ProcessEnvironmentPolicy;
  readonly now?: () => number;
}

const KILL_SIGNAL: NodeJS.Signals = 'SIGKILL';
/**
 * After the check exits, how long its output may keep draining. A descendant that left the
 * process group can hold the pipes open forever; past this, they are closed (review S1).
 */
const OUTPUT_DRAIN_GRACE_MS = 2_000;
const LANE_CHECK_GIT_TIMEOUT_MS = 60_000;
const ID_BYTES = 16;

export function checkPassed(run: CheckRun): boolean {
  return run.exitCode === 0 && run.signal === null && !run.timedOut;
}

/**
 * Review gap GC-15 — a check runs code the candidate holds, which an agent wrote, so it gets what
 * the agent's own process gets, not the host's whole environment. `minimal` keeps the bootstrap
 * names here: a check is a build tool started by name, and none can be found without `PATH`.
 */
function checkEnv(policy: ProcessEnvironmentPolicy, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selected =
    policy.mode === 'inherit'
      ? buildSpawnEnv({}, base)
      : buildSpawnEnv({ processEnvAllowlist: policy.processEnvAllowlist ?? [] }, base);
  return buildLaneGitEnv(selected);
}

/** Kills the check's whole process group, so a grandchild cannot outlive the timeout. */
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, KILL_SIGNAL);
  } catch {
    child.kill(KILL_SIGNAL);
  }
}

/** The default port: `child_process.spawn`, no shell, its own process group, output digested. */
export function createSpawnCheck(deps: SpawnCheckDeps = {}): SpawnCheck {
  const spawnFn: SpawnLike = deps.spawn ?? nodeSpawn;
  const base = deps.baseEnv ?? process.env;
  const environmentPolicy = deps.environmentPolicy ?? (() => SHIPPED_DEFAULT_POLICY);
  const now = deps.now ?? Date.now;
  return (argv, options) =>
    new Promise<CheckRun>((resolve) => {
      const started = now();
      const hash = createHash('sha256');
      let outputBytes = 0;
      let timedOut = false;
      let settled = false;
      const finish = (exitCode: number | null, signal: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode, signal, timedOut, durationMs: now() - started, outputBytes, outputSha256: hash.digest('hex') });
      };
      const env = checkEnv(environmentPolicy(), base);
      // Review gap GC-24 -- on win32 a bare check program (`npm`, `node`) resolves along the
      // check's PATH only, never from the lane root, where the lane's own work could plant one.
      // A miss is reported the way a spawn error is: no exit code, no signal.
      let command: string;
      try {
        command = spawnCommandFor(argv.at(0) ?? '', env);
      } catch {
        settled = true;
        resolve({ exitCode: null, signal: null, timedOut, durationMs: now() - started, outputBytes, outputSha256: hash.digest('hex') });
        return;
      }
      const child = spawnFn(command, argv.slice(1), {
        cwd: options.cwd,
        env,
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child);
      }, options.timeoutMs);
      const consume = (chunk: Buffer): void => {
        outputBytes += chunk.length;
        hash.update(chunk);
      };
      child.stdout?.on('data', consume);
      child.stderr?.on('data', consume);
      child.once('error', () => finish(null, null));
      child.once('close', (code, signal) => finish(code, signal));
      child.once('exit', (code, signal) => {
        const drained = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(code, signal);
        }, OUTPUT_DRAIN_GRACE_MS);
        drained.unref();
      });
    });
}

export interface VerificationContext {
  readonly integrations: IntegrationStore;
  readonly git: LaneGitRunner;
  readonly spawnCheck: SpawnCheck;
  readonly clock: () => number;
  readonly random: (size: number) => Buffer;
}

export type VerificationOutcome =
  | { readonly state: 'awaiting-review'; readonly reason: null }
  | { readonly state: 'blocked'; readonly reason: 'verification-failed' | 'verification-workspace-changed' };

/**
 * Whether the lane's `HEAD` is the candidate with no tracked change. Before the first check an
 * untracked file counts too: it appeared after the freeze, so the checks would see a tree the
 * candidate does not hold (review S3). After the last check only tracked changes count, since
 * checks may write build output.
 */
async function laneHoldsCandidate(
  ctx: VerificationContext,
  root: string,
  candidateCommit: string,
  moment: 'before' | 'after'
): Promise<boolean> {
  const head = await ctx.git.run(['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: root,
    timeoutMs: LANE_CHECK_GIT_TIMEOUT_MS
  });
  if (!head.ok) throw new LaneGitError('rev-parse', head);
  if (head.stdout.trim() !== candidateCommit) return false;
  const count = moment === 'before' ? allDirtyCount : trackedDirtyCount;
  const dirty = await count({ git: ctx.git, cwd: root, timeoutMs: LANE_CHECK_GIT_TIMEOUT_MS });
  if (dirty === null) throw new LaneGitError('status', { code: 'exit', exitCode: null });
  return dirty === 0;
}

function resultOf(
  ctx: VerificationContext,
  request: RequestRecord,
  index: number,
  check: VerificationCheck,
  run: CheckRun
): VerificationResultRecord {
  return {
    resultId: ctx.random(ID_BYTES).toString('hex'),
    requestId: request.requestId,
    attempt: request.verificationAttempt,
    checkIndex: index,
    checkName: check.name,
    candidateCommit: request.candidateCommit,
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    outputBytes: run.outputBytes,
    outputSha256: run.outputSha256,
    recordedAt: new Date(ctx.clock()).toISOString()
  };
}

/**
 * Runs `profile` for a request already in `verifying`, recording each check under the request's
 * current attempt. Throws `LaneGitError` when Git cannot say what the lane holds.
 */
export async function runVerification(
  ctx: VerificationContext,
  request: RequestRecord,
  profile: VerificationProfile,
  root: string
): Promise<VerificationOutcome> {
  if (!(await laneHoldsCandidate(ctx, root, request.candidateCommit, 'before'))) {
    return { state: 'blocked', reason: 'verification-workspace-changed' };
  }
  for (const [index, check] of profile.checks.entries()) {
    const run = await ctx.spawnCheck(check.argv, { cwd: root, timeoutMs: check.timeoutMs });
    ctx.integrations.insertVerificationResult(resultOf(ctx, request, index, check, run));
    if (!checkPassed(run)) return { state: 'blocked', reason: 'verification-failed' };
  }
  if (!(await laneHoldsCandidate(ctx, root, request.candidateCommit, 'after'))) {
    return { state: 'blocked', reason: 'verification-workspace-changed' };
  }
  return { state: 'awaiting-review', reason: null };
}
