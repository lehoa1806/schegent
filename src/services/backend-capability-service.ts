import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { SanitizedLogger } from '../lib/logger';
import {
  SUPPORTED_BACKENDS,
  type BackendRunnerKind
} from '../contracts/backend-kinds';

export const DEFAULT_BACKEND_PROBE_TIMEOUT_SECONDS = 5;
export const MIN_BACKEND_PROBE_TIMEOUT_SECONDS = 1;
export const MAX_BACKEND_PROBE_TIMEOUT_SECONDS = 30;
export const BACKEND_PROBE_OUTPUT_CAP_BYTES = 64 * 1024;

const TERMINATION_GRACE_MS = 2_000;
const AGY_MODEL_LIMIT = 200;
const AGY_MODEL_ID_MAX_LENGTH = 128;

const NO_MODELS: readonly string[] = Object.freeze([]);

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

interface CommandResult {
  readonly ok: boolean;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly errorCode?: string;
}

interface BackendInspection {
  readonly kind: BackendRunnerKind;
  readonly available: boolean;
  readonly models: readonly string[];
}

export interface BackendCapabilitySnapshot {
  readonly generation: number;
  readonly availableBackends: readonly BackendRunnerKind[];
  readonly availableModels: Record<BackendRunnerKind, readonly string[]>;
}

export interface BackendAvailabilityProbe {
  probeAvailability(kind: BackendRunnerKind): Promise<boolean>;
}

export type BackendProbeFailureCause =
  | 'not-found'
  | 'not-executable'
  | 'non-zero-exit'
  | 'timed-out'
  | 'unknown';

export type BackendProbeResult =
  | {
      readonly runner: BackendRunnerKind;
      readonly available: true;
      readonly exitCode: 0;
    }
  | {
      readonly runner: BackendRunnerKind;
      readonly available: false;
      readonly cause: BackendProbeFailureCause;
      readonly exitCode?: number;
    };

export interface BackendCapabilityServiceDeps {
  readonly cwd: string;
  readonly resolveCliPath: (kind: BackendRunnerKind) => string;
  readonly readTimeoutSeconds: () => unknown;
  readonly buildEnv: () => NodeJS.ProcessEnv;
  readonly logger: Pick<SanitizedLogger, 'debug' | 'warn'>;
  readonly onDidChange?: () => void;
  readonly spawnFn?: SpawnFn;
  /** Test seam; production always uses the complete closed registry. */
  readonly backendKinds?: readonly BackendRunnerKind[];
}

const EMPTY_MODELS: Record<BackendRunnerKind, readonly string[]> = Object.freeze({
  claude: Object.freeze([]),
  codex: Object.freeze([]),
  agy: Object.freeze([])
});

export function normalizeBackendProbeTimeoutSeconds(value: unknown): number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_BACKEND_PROBE_TIMEOUT_SECONDS
    && value <= MAX_BACKEND_PROBE_TIMEOUT_SECONDS
    ? value
    : DEFAULT_BACKEND_PROBE_TIMEOUT_SECONDS;
}

/**
 * Host-only owner for backend executable and model discovery.
 *
 * Invocation runners deliberately do not expose probing methods: constructing
 * them remains lazy and tied to actual phase execution. This service owns its
 * own short-lived, bounded subprocesses and exposes only structural capability
 * data to the sidebar projection.
 */
export class BackendCapabilityService implements BackendAvailabilityProbe {
  private readonly spawnFn: SpawnFn;
  private readonly backendKinds: readonly BackendRunnerKind[];
  private readonly activeChildren = new Set<ChildProcess>();
  private readonly killTimers = new Map<ChildProcess, ReturnType<typeof setTimeout>>();
  private requestedGeneration = 0;
  private disposed = false;
  private snapshot: BackendCapabilitySnapshot = Object.freeze({
    generation: 0,
    availableBackends: Object.freeze([]),
    availableModels: EMPTY_MODELS
  });

  constructor(private readonly deps: BackendCapabilityServiceDeps) {
    this.spawnFn = deps.spawnFn ?? (spawn as unknown as SpawnFn);
    this.backendKinds = deps.backendKinds ?? SUPPORTED_BACKENDS;
  }

  public getSnapshot(): BackendCapabilitySnapshot {
    return this.snapshot;
  }

  public getAvailableBackends(): readonly BackendRunnerKind[] {
    return this.snapshot.availableBackends;
  }

  public getAvailableModels(): Record<BackendRunnerKind, readonly string[]> {
    return this.snapshot.availableModels;
  }

  public async probeAvailability(kind: BackendRunnerKind): Promise<boolean> {
    return (await this.probe(kind)).available;
  }

  public async probe(kind: BackendRunnerKind): Promise<BackendProbeResult> {
    if (this.disposed) {
      return { runner: kind, available: false, cause: 'unknown' };
    }
    const result = await this.runBoundedCommand(kind, ['--help']);
    if (result.ok) return { runner: kind, available: true, exitCode: 0 };
    if (result.timedOut) {
      return { runner: kind, available: false, cause: 'timed-out' };
    }
    if (result.errorCode === 'ENOENT') {
      return { runner: kind, available: false, cause: 'not-found' };
    }
    if (result.errorCode === 'EACCES' || result.errorCode === 'EPERM') {
      return { runner: kind, available: false, cause: 'not-executable' };
    }
    if (result.exitCode !== null) {
      return {
        runner: kind,
        available: false,
        cause: 'non-zero-exit',
        exitCode: result.exitCode
      };
    }
    return { runner: kind, available: false, cause: 'unknown' };
  }

  /**
   * Refresh all supported backends concurrently. Only the newest requested
   * generation may publish; a slow older scan is discarded after completion.
   */
  public async scan(): Promise<BackendCapabilitySnapshot> {
    if (this.disposed) return this.snapshot;
    const generation = ++this.requestedGeneration;
    const inspections = await Promise.all(
      this.backendKinds.map((kind) => this.inspectBackend(kind))
    );
    if (this.disposed || generation !== this.requestedGeneration) {
      return this.snapshot;
    }

    const models: Record<BackendRunnerKind, readonly string[]> = {
      claude: Object.freeze([]),
      codex: Object.freeze([]),
      agy: Object.freeze([])
    };
    const available: BackendRunnerKind[] = [];
    for (const inspection of inspections) {
      if (!inspection.available) continue;
      available.push(inspection.kind);
      models[inspection.kind] = Object.freeze([...inspection.models]);
    }

    const next: BackendCapabilitySnapshot = Object.freeze({
      generation,
      availableBackends: Object.freeze(available),
      availableModels: Object.freeze(models)
    });
    const changed = !sameCapabilities(this.snapshot, next);
    this.snapshot = next;
    if (changed) {
      try {
        this.deps.onDidChange?.();
      } catch {
        this.deps.logger.warn('backend-capabilities: update callback failed');
      }
    }
    return next;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requestedGeneration += 1;
    for (const child of this.activeChildren) this.terminate(child);
  }

  private async inspectBackend(kind: BackendRunnerKind): Promise<BackendInspection> {
    const available = await this.probeAvailability(kind);
    if (!available) {
      this.deps.logger.debug(`backend-capabilities: ${kind} unavailable`);
      return { kind, available: false, models: Object.freeze([]) };
    }

    // Neither CLI can enumerate its models: each accepts a `--model` that
    // TAKES a value and exposes no listing subcommand. This service reports
    // discovered facts, so for these two the honest answer is none. The lists
    // that used to sit here were code-resident constants that read as
    // discoveries; because the snapshot's `availableModels` seeded the Models
    // editor and drove the `modelAvailable` advisory, they silently displaced
    // the operator's own `schegent.models` catalog. The catalog is
    // configuration and now reaches the webview as such, on its own field.
    if (kind === 'claude' || kind === 'codex') {
      return { kind, available: true, models: NO_MODELS };
    }

    const detected = await this.runBoundedCommand(kind, ['models']);
    const models = detected.ok
      ? parseAgyModels(detected.stdout)
      : Object.freeze([] as string[]);
    return {
      kind,
      available: true,
      models
    };
  }

  private async runBoundedCommand(
    kind: BackendRunnerKind,
    args: readonly string[]
  ): Promise<CommandResult> {
    if (this.disposed) {
      return { ok: false, timedOut: false, exitCode: null, stdout: '' };
    }
    let cliPath: string;
    let env: NodeJS.ProcessEnv;
    let timeoutSeconds: number;
    try {
      cliPath = this.deps.resolveCliPath(kind);
      env = this.deps.buildEnv();
      timeoutSeconds = normalizeBackendProbeTimeoutSeconds(
        this.deps.readTimeoutSeconds()
      );
    } catch {
      return { ok: false, timedOut: false, exitCode: null, stdout: '' };
    }

    return new Promise<CommandResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawnFn(cliPath, args, {
          cwd: this.deps.cwd,
          env,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        const errorCode = errorCodeOf(error);
        resolve({
          ok: false,
          timedOut: false,
          exitCode: null,
          stdout: '',
          ...(errorCode ? { errorCode } : {})
        });
        return;
      }

      this.activeChildren.add(child);
      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let settled = false;
      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      const settle = (exitCode: number | null, errorCode?: string): void => {
        if (settled) return;
        settled = true;
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
        resolve({
          ok: !timedOut && exitCode === 0,
          timedOut,
          exitCode,
          stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
          ...(errorCode ? { errorCode } : {})
        });
      };
      const cleanup = (): void => {
        this.activeChildren.delete(child);
        const killTimer = this.killTimers.get(child);
        if (killTimer !== undefined) clearTimeout(killTimer);
        this.killTimers.delete(child);
      };
      const retainStdout = (chunk: Buffer | string): void => {
        if (stdoutBytes >= BACKEND_PROBE_OUTPUT_CAP_BYTES) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = BACKEND_PROBE_OUTPUT_CAP_BYTES - stdoutBytes;
        const retained = bytes.length <= remaining ? bytes : bytes.subarray(0, remaining);
        stdoutChunks.push(retained);
        stdoutBytes += retained.length;
      };

      child.stdout?.on('data', retainStdout);
      // Always drain stderr, but never retain or expose it.
      child.stderr?.on('data', () => { /* intentionally discarded */ });
      child.once('error', (error) => {
        cleanup();
        settle(null, errorCodeOf(error));
      });
      child.once('close', (code) => {
        cleanup();
        settle(typeof code === 'number' ? code : null);
      });

      timeoutHandle = setTimeout(() => {
        timedOut = true;
        this.terminate(child);
        // Publish the timeout at the configured boundary; cleanup continues
        // asynchronously through close/error and the SIGKILL escalation.
        settle(null);
      }, timeoutSeconds * 1_000);
      timeoutHandle.unref?.();
    });
  }

  private terminate(child: ChildProcess): void {
    // A child with no pid NEVER STARTED, and signalling it is not the no-op the
    // shape of the call suggests. `spawn` failing -- ENOENT for a backend that is
    // simply not installed, which is the ordinary misconfiguration and exactly
    // what a probe exists to discover -- still returns a ChildProcess, and that
    // object reports `pid === undefined` with `exitCode` and `signalCode` both
    // null. The two checks below therefore read it as live.
    //
    // libuv leaves the process handle's pid at 0 for a child that never started,
    // so `child.kill(sig)` reaches `kill(0, sig)`, which POSIX defines as "every
    // process in the CALLER's process group" -- the extension host and whatever
    // shares its group, terminated because a configured CLI was absent. Measured
    // on Node 24: the call returns `true`, so nothing upstream reads as failed,
    // and the host is gone.
    //
    // This guard belongs ahead of the liveness checks rather than inside them:
    // `pid` is assigned once at spawn and never changes, so a child that reaches
    // here without one can never become signallable, and the SIGKILL escalation
    // armed below would carry the identical hazard 2s later.
    if (child.pid === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // Continue to the hard-kill attempt below.
    }
    if (this.killTimers.has(child)) return;
    const timer = setTimeout(() => {
      this.killTimers.delete(child);
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // Best effort; the OS may already have reaped the child.
      }
    }, TERMINATION_GRACE_MS);
    timer.unref?.();
    this.killTimers.set(child, timer);
  }
}

function errorCodeOf(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The model ids in an `agy models` transcript.
 *
 * The command writes a `Fetching available models...` status line to stdout
 * and then one `<id>\t<Display Name>` row per model, so the id is the first
 * tab-delimited field and everything after the tab is prose for a human.
 * Keeping the whole line — which this did until the Models editor started
 * showing what it produced — yielded ids no operator, Phase, or Pipeline
 * could ever match, plus the status line as a model of its own.
 *
 * A row is recognized by the shape of its id rather than by the presence of a
 * tab: a model id carries no whitespace, while every status or prose line
 * does. That admits a bare-id transcript too, so a future `agy` that drops
 * the display column keeps working, and it is why the id is extracted BEFORE
 * the length and duplicate guards — those must judge the id, not the label
 * beside it, or two spellings of one model would both be admitted.
 */
export function parseAgyModels(stdout: string): readonly string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const model = line.split('\t', 1)[0]!.trim();
    if (
      model.length === 0
      || /\s/u.test(model)
      || model.length > AGY_MODEL_ID_MAX_LENGTH
      || seen.has(model)
    ) {
      continue;
    }
    seen.add(model);
    models.push(model);
    if (models.length >= AGY_MODEL_LIMIT) break;
  }
  return Object.freeze(models);
}

function sameCapabilities(
  left: BackendCapabilitySnapshot,
  right: BackendCapabilitySnapshot
): boolean {
  if (left.availableBackends.length !== right.availableBackends.length) return false;
  for (let i = 0; i < left.availableBackends.length; i += 1) {
    if (left.availableBackends[i] !== right.availableBackends[i]) return false;
  }
  for (const kind of SUPPORTED_BACKENDS) {
    const leftModels = left.availableModels[kind];
    const rightModels = right.availableModels[kind];
    if (leftModels.length !== rightModels.length) return false;
    for (let i = 0; i < leftModels.length; i += 1) {
      if (leftModels[i] !== rightModels[i]) return false;
    }
  }
  return true;
}
