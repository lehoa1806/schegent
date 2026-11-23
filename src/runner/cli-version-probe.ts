// FR-R3-104 (FR-054, FR-055) & FR-R7-16 (16-15, FR-015) — what version of the CLI is this run
// actually driving?
//
// THE GAP. The qualification record names the CLI versions a canary observed. Nothing on the
// host observed the version it drives, so an operator upgrading `claude` mid-feature
// crossed the protocol boundary the record vouches for and no evidence said so. When a parse then
// failed, the record showed a qualified version and the machine had another one installed — a
// diagnosis nobody could reach from the evidence.
//
// A STRICT VERSION TOKEN, NEVER A PATH OR RAW STDOUT. `cliPath` is deliberately absent from every
// audit payload, and unparseable `--version` output returns `null` rather than echoing raw bytes
// into logs, warnings, audit payloads, or acceptance bindings (16-15).
//
// HARD COMPLETION DEADLINE. Spawns through a `run(` helper with its own process group
// (`processTreeSpawnOptions()`), streaming 64 KiB stdout cap, process-tree `SIGTERM`/`SIGKILL`
// teardown, and immediate local pipe destruction at the deadline so a pipe-holding grandchild
// cannot delay settlement past the configured timeout.
//
// CACHED WITH A TTL, not once per activation and not once per phase. A short TTL catches
// mid-session upgrades without paying a probe per phase.
import { spawn as spawnChildProcess, type ChildProcess } from 'node:child_process';
import {
  SHIPPED_DEFAULT_POLICY,
  policyFingerprint,
  type ProcessEnvironmentPolicy
} from '../contracts/process-environment-policy';
import {
  QUALIFIED_AT,
  QUALIFIED_BACKEND_VERSIONS
} from '../contracts/qualified-backend-versions';
import {
  childIsReaped,
  processTreeIsGone,
  processTreeSpawnOptions,
  signalProcessTree,
  trackGroupAtExit
} from './process-tree';
import { buildSpawnEnv, policyRequestFields } from './spawn-env';
import { spawnCommandFor } from '../lib/spawn-command';

/** How long an observed version stands before it is probed again. */
export const CLI_VERSION_TTL_MS = 10 * 60 * 1000;

/** How long the probe may take. A CLI that cannot answer this in five seconds is answering `null`. */
export const CLI_VERSION_TIMEOUT_MS = 5_000;

/** Bound on what is recorded, so a chatty `--version` cannot inflate an audit payload. */
export const CLI_VERSION_MAX_LEN = 64;

/**
 * FR-R7-16 (16-15) — strictly bounded dotted-numeric CLI version grammar.
 * Any value outside this grammar is rejected rather than emitted to logs, warnings, or audit rows.
 */
export const CLI_VERSION_PATTERN = /^\d{1,6}\.\d{1,6}(?:\.\d{1,6})?$/;

/**
 * FR-R6-F09 (NFR-002) -- the most `--version` output the probe reads. Past it the child is
 * stopped and the answer is `null`, which admission reads as unverified: the version decides
 * whether a spawn is admitted, so an unbounded answer must not be buffered to decide it.
 */
export const CLI_VERSION_MAX_OUTPUT_BYTES = 64 * 1024;

/** Short bounded grace after process exit to drain buffered stdout before closing pipes. */
const POST_EXIT_DRAIN_GRACE_MS = 200;

/** Escalation delay from SIGTERM to SIGKILL when tearing down a timed-out or oversized probe tree. */
const SIGKILL_ESCALATION_MS = 500;

export interface CliVersionProbe {
  /** The observed version, or `null` when it could not be observed. Never throws. */
  observe: (cliPath: string) => Promise<string | null>;
}

export interface CliVersionProbeDeps {
  /** Injected so tests never spawn. Resolves the first line of `<cliPath> --version`. */
  readonly probe?: (cliPath: string) => Promise<string>;
  readonly monotonicNow?: () => number;
  /**
   * FR-R4-F06 (FR-004) -- the environment policy a `--version` child is started
   * under, read at each lookup so the answer is never older than the lookup.
   * Absent means the shipped allowlist default, the safe direction.
   */
  readonly environmentPolicy?: () => ProcessEnvironmentPolicy;
  /** Hard completion deadline override for tests (defaults to {@link CLI_VERSION_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  /**
   * FR-R7-16 (16-14) -- live workspace trust predicate. When false, `observe` returns `null`
   * immediately with zero executable invocations and without poisoning the TTL cache.
   */
  readonly isTrusted?: () => boolean;
}

function errnoOf(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
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
    return errnoOf(error) !== 'ESRCH';
  }
}

/**
 * Signal `child`'s process tree safely: if the leader is still alive, signal group + child; if the
 * leader has already been reaped on POSIX, signal `-pid` ONLY when `pid` is absent (`ESRCH`) and
 * `-pid` still answers, preventing any signal to a recycled PID.
 */
function signalProbeTreeSafely(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!childIsReaped(child)) {
    void signalProcessTree(child, signal);
    return;
  }
  if (isReusedPid(child)) return;
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, 0);
  } catch {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    /* group already exited */
  }
}

interface RunProbeOptions {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Execute `<cliPath> --version` with a hard completion deadline, process-group teardown, pipe
 * destruction, and streaming byte cap. Named `run` to keep the child_process env-policy census
 * contract (`tests/lint/invocations-forward-env-policy.test.ts`).
 */
function run(
  cliPath: string,
  args: readonly string[],
  options: RunProbeOptions
): Promise<{ readonly stdout: string }> {
  return new Promise<{ readonly stdout: string }>((resolve, reject) => {
    let command: string;
    try {
      // FR-R7-16 (16-16): resolve against the child's exact environment, never host process.env.
      command = spawnCommandFor(cliPath, options.env);
    } catch (error) {
      reject(error);
      return;
    }

    let child: ChildProcess;
    try {
      // `shell: false` is explicit: `cliPath` is operator configuration, never a shell command line.
      child = spawnChildProcess(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        env: options.env,
        ...processTreeSpawnOptions()
      });
    } catch (error) {
      reject(error);
      return;
    }
    trackGroupAtExit(child);

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutEnded = false;
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let teardownStarted = false;
    let teardownAnchored = false;
    let groupAliveAtExit = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

    const canSignalTree = (): boolean => {
      if (processTreeIsGone(child)) return false;
      if (!childIsReaped(child)) return true;
      if (process.platform === 'win32') return false;
      if (!teardownAnchored && !groupAliveAtExit) return false;
      return !isReusedPid(child);
    };

    const clearSettleTimers = (): void => {
      if (deadlineTimer !== null) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
      if (drainTimer !== null) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }
    };

    const destroyPipes = (): void => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    const startTreeTeardown = (): void => {
      if (teardownStarted) {
        destroyPipes();
        return;
      }
      teardownAnchored = !childIsReaped(child) || groupAliveAtExit;
      teardownStarted = true;
      destroyPipes();
      if (!canSignalTree()) return;
      signalProbeTreeSafely(child, 'SIGTERM');
      const escalationDelay = Math.min(SIGKILL_ESCALATION_MS, Math.max(50, options.timeoutMs));
      sigkillTimer = setTimeout(() => {
        sigkillTimer = null;
        if (canSignalTree()) {
          signalProbeTreeSafely(child, 'SIGKILL');
        }
      }, escalationDelay);
      sigkillTimer.unref();
    };

    const finishOk = (): void => {
      if (settled) return;
      settled = true;
      clearSettleTimers();
      destroyPipes();
      if (!teardownStarted && sigkillTimer !== null) {
        clearTimeout(sigkillTimer);
        sigkillTimer = null;
      }
      resolve({ stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8') });
    };

    const finishError = (error: Error, teardown: boolean): void => {
      if (settled) return;
      settled = true;
      clearSettleTimers();
      if (teardown) {
        startTreeTeardown();
      } else {
        destroyPipes();
      }
      reject(error);
    };

    const settleAfterExit = (): void => {
      if (settled) return;
      if (!teardownStarted && groupAliveAtExit && canSignalTree()) {
        startTreeTeardown();
      }
      if (exitCode === 0 && exitSignal === null) {
        finishOk();
      } else {
        finishError(new Error('cli version probe exited non-zero'), false);
      }
    };

    child.stdout?.on('error', () => undefined);
    child.stderr?.on('error', () => undefined);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stdoutBytes + bytes.length > options.maxBytes) {
        finishError(new Error('cli version probe output cap exceeded'), true);
        return;
      }
      stdoutChunks.push(bytes);
      stdoutBytes += bytes.length;
    });
    child.stdout?.once('end', () => {
      stdoutEnded = true;
      if (exited && !settled) {
        settleAfterExit();
      }
    });
    // Always drain stderr without retaining it so a verbose stderr cannot block the child.
    child.stderr?.on('data', () => undefined);

    child.once('error', (error) => {
      finishError(error instanceof Error ? error : new Error('cli version probe spawn failed'), false);
    });

    child.once('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      groupAliveAtExit =
        process.platform !== 'win32' && !isReusedPid(child) && !processTreeIsGone(child);
      if (settled) return;
      if (stdoutEnded) {
        settleAfterExit();
        return;
      }
      // Bounded drain grace so a grandchild holding stdout open after the leader exits cannot hang.
      const graceMs = Math.min(POST_EXIT_DRAIN_GRACE_MS, options.timeoutMs);
      drainTimer = setTimeout(() => {
        drainTimer = null;
        if (settled) return;
        if (canSignalTree()) {
          startTreeTeardown();
        } else {
          destroyPipes();
        }
        settleAfterExit();
      }, graceMs);
      drainTimer.unref();
    });

    child.once('close', (code, signal) => {
      if (!exited) {
        exited = true;
        exitCode = code;
        exitSignal = signal;
        groupAliveAtExit =
          process.platform !== 'win32' && !isReusedPid(child) && !processTreeIsGone(child);
      }
      if (!settled) {
        settleAfterExit();
      }
    });

    deadlineTimer = setTimeout(() => {
      deadlineTimer = null;
      finishError(new Error('cli version probe timed out'), true);
    }, options.timeoutMs);
    deadlineTimer.unref();
  });
}

/**
 * FR-R4-F06 (FR-005) -- the key a version is cached and de-duplicated under: the path
 * and the policy fingerprint, joined by a NUL that neither can contain. NAMES only;
 * the key never holds an environment value, so it can be logged or compared freely.
 */
export function cliVersionCacheKey(cliPath: string, policy: ProcessEnvironmentPolicy): string {
  return `${cliPath}\u0000${policyFingerprint(policy)}`;
}

/** True iff `value` strictly matches {@link CLI_VERSION_PATTERN} within {@link CLI_VERSION_MAX_LEN}. */
export function isValidCliVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= CLI_VERSION_MAX_LEN &&
    CLI_VERSION_PATTERN.test(value)
  );
}

/**
 * Reduce a `--version` line to a strictly bounded dotted-numeric token (`/^\d{1,6}\.\d{1,6}(?:\.\d{1,6})?$/`).
 *
 * The three CLIs answer differently (`2.1.246 (Claude Code)`, `codex-cli 0.149.0`, `1.1.20`), and
 * the comparison that matters is on the dotted-numeric token — the same reduction
 * `scripts/backend-qualification.mjs` applies.
 *
 * FR-R7-16 (16-15): unparseable stdout returns `null` rather than echoing raw bytes, so arbitrary
 * banners, paths, or secret-bearing lines can never reach logs, warnings, audit rows, or bindings.
 */
export function normalizeCliVersion(line: string): string | null {
  const first = line.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (first.length === 0) return null;
  // Negative lookbehind prevents O(N^2) backtracking across long digit runs without `.d` (SR-308-1).
  const match = /(?<!\d)(\d+\.\d+(?:\.\d+)?)/.exec(first);
  const token = match?.[1];
  if (token === undefined || !isValidCliVersion(token)) return null;
  return token;
}

export function createCliVersionProbe(deps: CliVersionProbeDeps = {}): CliVersionProbe {
  const now = deps.monotonicNow ?? (() => Date.now());
  const currentPolicy = deps.environmentPolicy ?? (() => SHIPPED_DEFAULT_POLICY);
  const timeoutMs =
    typeof deps.timeoutMs === 'number' && Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0
      ? deps.timeoutMs
      : CLI_VERSION_TIMEOUT_MS;
  // The policy is captured once per lookup and handed to the probe, so the key a result is
  // cached under and the environment the child was started with come from the same reading.
  const injectedProbe = deps.probe;
  const probe: (cliPath: string, policy: ProcessEnvironmentPolicy) => Promise<string> =
    injectedProbe !== undefined
      ? (cliPath) => injectedProbe(cliPath)
      : async (cliPath, policy) => {
          // FR-R4-F06 (FR-004) & FR-R7-16 (16-15, 16-16): `run(` builds the child env once from
          // the policy, resolves `cliPath` against that exact child env, and enforces the hard
          // deadline, process-group teardown, pipe destruction, and 64 KiB output cap.
          const { stdout } = await run(cliPath, ['--version'], {
            timeoutMs,
            maxBytes: CLI_VERSION_MAX_OUTPUT_BYTES,
            env: buildSpawnEnv(policyRequestFields(policy))
          });
          return stdout;
        };

  const cache = new Map<string, { version: string | null; observedAtMs: number }>();
  const inFlight = new Map<string, Promise<string | null>>();

  const observe = async (cliPath: string): Promise<string | null> => {
    if (deps.isTrusted?.() === false) return null;
    const policy = currentPolicy();
    const key = cliVersionCacheKey(cliPath, policy);
    const cached = cache.get(key);
    if (cached !== undefined && now() - cached.observedAtMs < CLI_VERSION_TTL_MS) {
      return cached.version;
    }
    // One probe per path and policy at a time. Twenty phases starting together must not spawn
    // twenty processes for one answer.
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;

    // `Promise.resolve().then(...)` rather than `probe(cliPath).then(...)`: a probe that throws
    // SYNCHRONOUSLY never returns a promise for `.catch` to attach to, so the exception escapes
    // into whatever awaited `observe` — a phase, in production.
    const pending = Promise.resolve()
      .then(() => probe(cliPath, policy))
      .then((stdout) => normalizeCliVersion(stdout))
      .catch(() => null)
      .then((version) => {
        // A failed probe is cached too, for the same window. Otherwise a CLI that is missing or
        // slow would be probed again at every phase, turning one unanswerable question into a
        // per-phase cost. It is cached for its own key only: a failure under one policy says
        // nothing about another.
        cache.set(key, { version, observedAtMs: now() });
        inFlight.delete(key);
        return version;
      });
    inFlight.set(key, pending);
    return pending;
  };

  return { observe };
}

/**
 * FR-R3-104 (FR-054) & FR-R7-16 (16-14, 16-15) — the version for one invocation, resolved safely.
 *
 * HERE RATHER THAN IN THE PHASE RUNNER, and the reason is that file's own budget discipline: the
 * shell forwards decisions, it does not make them. Skips probing when the cancellation signal is
 * already aborted, swallows failures, and admits only strictly bounded version tokens.
 */
export async function observedVersionOf(
  registry: { observedCliVersion: (cliPath: string) => Promise<string | null> } | null,
  cliPath: string,
  cancellationSignal?: { readonly aborted?: boolean }
): Promise<string | null> {
  if (registry === null || cancellationSignal?.aborted === true) return null;
  try {
    const observed = await registry.observedCliVersion(cliPath);
    return isValidCliVersion(observed) ? observed : null;
  } catch {
    return null;
  }
}

type DriftDirection = 'newer than' | 'older than' | 'not comparable to';

/**
 * FR-R3-147 — what each direction means for the operator, which is not the same thing.
 */
const DRIFT_ADVICE: Readonly<Record<DriftDirection, string>> = Object.freeze({
  'newer than':
    'A newer CLI usually speaks the same protocol; treat this as context if a phase fails in a way you cannot explain.',
  'older than':
    'An older CLI may not have protocol features this build relies on; upgrading the backend CLI is the fix.',
  'not comparable to':
    'The installed version did not parse as a version, so which way it drifted is unknown.'
});

/**
 * FR-R3-147 — drift compared on `major.minor`, and which side of it we are on.
 */
function driftDirection(qualified: string, observed: string): DriftDirection | null {
  const q = /^(\d+)\.(\d+)/.exec(qualified);
  const o = /^(\d+)\.(\d+)/.exec(observed);
  if (!q || !o) return 'not comparable to';
  const qMajor = Number(q[1]);
  const oMajor = Number(o[1]);
  if (qMajor !== oMajor) return oMajor > qMajor ? 'newer than' : 'older than';
  const qMinor = Number(q[2]);
  const oMinor = Number(o[2]);
  if (qMinor !== oMinor) return oMinor > qMinor ? 'newer than' : 'older than';
  return null;
}

/**
 * FR-R3-104 (FR-054, FR-055) & FR-R7-16 (16-15) — the version fields for one phase's records,
 * and the drift warning.
 *
 * Accepts strictly bounded dotted-numeric versions only. If a caller passes a non-matching string,
 * `cliVersion` is omitted and any drift warning uses fixed `'unverified'` wording — zero raw
 * stdout text ever enters returned fields or logger warnings.
 */
export function cliVersionFields(
  observed: string | null,
  backend: string,
  logger?: { warn: (message: string) => void }
): Record<string, unknown> {
  if (observed === null) return {};
  const qualified: string | undefined = Object.prototype.hasOwnProperty.call(
    QUALIFIED_BACKEND_VERSIONS,
    backend
  )
    ? QUALIFIED_BACKEND_VERSIONS[backend]
    : undefined;
  if (!isValidCliVersion(observed)) {
    if (qualified === undefined) return {};
    logger?.warn(
      `${backend} CLI version is unverified (not comparable to ${qualified}, ${QUALIFIED_AT}). ` +
        'Protocol handling for this backend has not been checked against this binary. ' +
        `${DRIFT_ADVICE['not comparable to']} ` +
        'From a checkout, `npm run canary` re-qualifies.'
    );
    return { cliVersionDrift: true, qualifiedCliVersion: qualified };
  }
  if (qualified === undefined || qualified === observed) return { cliVersion: observed };
  const direction = driftDirection(qualified, observed);
  if (direction === null) return { cliVersion: observed };
  logger?.warn(
    `${backend} CLI ${observed} is ${direction} the version this build was qualified against ` +
      `(${qualified}, ${QUALIFIED_AT}). Protocol handling for this backend has not been checked ` +
      `against this binary. ${DRIFT_ADVICE[direction]} ` +
      'From a checkout, `npm run canary` re-qualifies.'
  );
  return { cliVersion: observed, cliVersionDrift: true, qualifiedCliVersion: qualified };
}
