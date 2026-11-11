/**
 * FR-R6-F13 (F13-C; FR-001, FR-005..FR-012, FR-017..FR-022) & FR-R6-F09 (FR-017) — host ACP
 * `BackendRunner` implementation for post-cutover execution, with bounded legacy drain delegation.
 *
 * - All new-architecture attempts execute over ACP (`openAcpConnection` + `resolveAcpProfileLaunch`
 *   + `spawnStdioTransport`); ACP refusal, disconnect, or error NEVER falls back to direct CLI.
 * - Pre-cutover in-flight legacy attempts (`request.legacyDrain === true` while
 *   `allowLegacyDrain === true`) delegate strictly to `this.inner` until drained.
 * - Enforces `AcpAuthorityGate` (`F09-FR-17`) on every permission/resource callback and verifies
 *   OS process-group teardown (`verifyAcpTransportTeardown`) on completion and cancellation.
 * - History replay (`origin === 'history'`) is forwarded as historical observation only and never
 *   treated as live turn output or new billable usage (`F13-FR-07`).
 *
 * Zero `vscode`, `child_process`, or audit-writer imports.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  AcpConnection,
  AcpConnectionProjection,
  AcpObservation,
  AcpPromptBlock,
  AgentProfile
} from '../contracts/acp-runtime';
import type { AcpUsageUpdate } from '../services/usage-accounting/acp-usage-mapping';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import type {
  BackendRunner,
  MonitorSidecarHook,
  RunnerLabel,
  TreeTeardownOutcome
} from '../contracts/backend-runner';
import { classifyFatal } from '../lib/fatal-signature-registry';
import { openAcpConnection } from '../services/acp-runtime/acp-client';
import {
  ACP_PROFILE_IDS,
  getBuiltinAcpProfile,
  resolveAcpProfileLaunch
} from '../services/acp-runtime/profiles';
import {
  spawnStdioTransport,
  type AcpStdioTransport
} from '../services/acp-runtime/stdio-transport';
import {
  AcpAuthorityGate,
  verifyAcpTransportTeardown
} from '../services/containment-qualification/acp-authority-gate';
import { nextInvocationId } from './invocation-identity';
import {
  armedMaxDurationMs,
  type InvocationOutputSink,
  type InvocationRequest,
  type RawInvocationOutput
} from './invocation-result';
import { buildSpawnEnv } from './spawn-env';
import { ZippedStreamBuffer } from './zipped-stream-buffer';

export class AcpProfileMismatchError extends Error {
  public readonly code = 'acp-profile-mismatch' as const;

  public constructor(
    public readonly backendKind: BackendRunnerKind,
    public readonly configuredProfileId: string,
    public readonly expectedProfileId: string
  ) {
    super(
      `ACP profile '${configuredProfileId}' does not match backend '${backendKind}' (expected '${expectedProfileId}').`
    );
    this.name = 'AcpProfileMismatchError';
  }
}

export interface AcpRunnerObservationEvent {
  readonly backendKind: BackendRunnerKind;
  readonly runId: string | null;
  readonly invocationId: string;
  readonly attemptId: string;
  readonly observation: AcpObservation;
  readonly projection: AcpConnectionProjection;
}

export interface AcpBackedRunnerOptions {
  readonly kind: BackendRunnerKind;
  readonly inner: BackendRunner;
  readonly monitorHook?: MonitorSidecarHook | null;
  readonly readConfiguredProfile?: () => string;
  readonly allowLegacyDrain?: boolean;
  readonly bridgeScriptPath?: string;
  readonly authorityGate?: AcpAuthorityGate;
  readonly primaryWorkspaceRoot?: string;
  readonly protectedDatabasePaths?: readonly string[];
  readonly currentOwnershipGeneration?: () => number;
  readonly onAcpObservation?: (event: AcpRunnerObservationEvent) => void;
  readonly launchTransport?: (
    profile: AgentProfile,
    request: InvocationRequest,
    generation: number
  ) => AcpStdioTransport;
}

const RUNNER_LABEL_BY_KIND: Readonly<Record<BackendRunnerKind, RunnerLabel>> = Object.freeze({
  claude: 'claude-cli',
  codex: 'codex-cli',
  agy: 'agy-cli'
});

let nextAcpGeneration = 0;

function sanitizeHostToken(raw: string | undefined, fallback: string): string {
  if (!raw || raw.trim().length === 0) return fallback;
  const cleaned = raw.trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '');
  if (cleaned.length === 0) return fallback;
  return cleaned.slice(0, 128);
}

function isValidAcpSessionToken(raw: string | undefined): raw is string {
  return typeof raw === 'string' && raw.length >= 1 && raw.length <= 256 && !/[\r\n\0]/.test(raw);
}

function encodeAssistantLine(text: string): string {
  return `${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] }
  })}\n`;
}

function encodeUsageResultLine(
  kind: BackendRunnerKind,
  sessionId: string,
  durationMs: number,
  usage: AcpUsageUpdate | null
): string {
  // F06-FR-23: ACP `used`/`size` are context occupancy, never billable tokens; authoritative ACP
  // accounting ingests `AcpUsageUpdate` directly via `onAcpObservation`.
  if (kind === 'codex') {
    return `${JSON.stringify({
      type: 'turn.completed',
      session_id: sessionId,
      usage: { input_tokens: 0, output_tokens: 0 }
    })}\n`;
  }
  if (kind === 'agy') {
    return `${JSON.stringify({
      event: 'result',
      session_id: sessionId,
      result: {
        duration_seconds: Math.max(0, durationMs / 1_000),
        num_turns: 1,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    })}\n`;
  }
  const row: Record<string, unknown> = {
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    duration_ms: Math.max(0, Math.round(durationMs)),
    num_turns: 1,
    usage: { input_tokens: 0, output_tokens: 0 }
  };
  if (usage?.hasQualifiedSessionBaseline && usage.cost?.currency === 'USD') {
    const parsedCost = Number(usage.cost.amount);
    if (Number.isFinite(parsedCost) && parsedCost >= 0) {
      row.total_cost_usd = parsedCost;
    }
  }
  return `${JSON.stringify(row)}\n`;
}

interface ActiveAcpExecution {
  readonly invocationId: string;
  readonly getConnection: () => AcpConnection | null;
  readonly getSessionId: () => string | null;
  readonly cancel: () => void;
  readonly teardownPromise: () => Promise<TreeTeardownOutcome | null>;
}

export class AcpBackedRunner implements BackendRunner {
  private readonly inner: BackendRunner;
  private readonly activeExecutions = new Map<string, ActiveAcpExecution>();
  private closed = false;

  public constructor(private readonly options: AcpBackedRunnerOptions) {
    this.inner = options.inner;
  }

  public get hasActiveProcess(): boolean {
    return this.activeExecutions.size > 0 || this.inner.hasActiveProcess;
  }

  public get availabilityAdapter(): BackendRunner['availabilityAdapter'] {
    return this.inner.availabilityAdapter;
  }

  public async invoke(
    request: InvocationRequest,
    outputSink?: InvocationOutputSink
  ): Promise<RawInvocationOutput> {
    if (request.legacyDrain === true && this.options.allowLegacyDrain !== false) {
      return this.inner.invoke(request, outputSink);
    }
    if (this.closed) {
      throw new Error(`acp-backed-runner (${this.options.kind}): runner is closed`);
    }

    const expectedProfileId = ACP_PROFILE_IDS[this.options.kind];
    const configuredRaw = (this.options.readConfiguredProfile ? this.options.readConfiguredProfile().trim() : '') || 'auto';
    if (configuredRaw !== 'auto' && configuredRaw !== expectedProfileId) {
      throw new AcpProfileMismatchError(this.options.kind, configuredRaw, expectedProfileId);
    }

    const profile = getBuiltinAcpProfile(this.options.kind, { model: request.model });
    const generation = ++nextAcpGeneration;
    const label = RUNNER_LABEL_BY_KIND[this.options.kind];
    const invocationId = nextInvocationId(label);
    const runId = request.runId ?? null;
    const attemptId = sanitizeHostToken(request.attemptId, sanitizeHostToken(invocationId, `attempt-${generation}`));
    const rootId = sanitizeHostToken(runId ?? undefined, 'adhoc-root');
    const maxDurationMs = armedMaxDurationMs(request);

    const stdoutBuffer = new ZippedStreamBuffer();
    const stderrBuffer = new ZippedStreamBuffer();
    const startedAtMs = Date.now();
    const warnings: string[] = [];

    let transport: AcpStdioTransport | null = null as AcpStdioTransport | null;
    let connection: AcpConnection | null = null;
    let activeSessionId: string | null = null;
    let latestUsage: AcpUsageUpdate | null = null;
    let sawTerminalResult = false;
    let killed = false;
    let timedOut: boolean = false as boolean;
    let deadlineExceeded: boolean = false as boolean;
    let teardownOutcome: TreeTeardownOutcome | null = null;
    let liveStreamText = '';

    const emitChunk = (stream: 'stdout' | 'stderr', chunk: string): void => {
      if (chunk.length === 0) return;
      if (stream === 'stdout') {
        stdoutBuffer.append(chunk);
        liveStreamText += chunk;
        this.options.monitorHook?.({
          kind: 'stdout-chunk',
          runId,
          invocationId,
          chunk
        });
      } else {
        stderrBuffer.append(chunk);
        this.options.monitorHook?.({
          kind: 'stderr-chunk',
          runId,
          invocationId,
          chunk
        });
      }
      try {
        outputSink?.write(stream, chunk);
      } catch {
        // OutputSink contract forbids throws; ignore defensive failures.
      }
    };

    let idleTimer: ReturnType<typeof setTimeout> | null = null as ReturnType<typeof setTimeout> | null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

    const resetIdleTimer = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      if (request.timeoutMs > 0) {
        idleTimer = setTimeout(() => {
          if (!deadlineExceeded && !killed) {
            timedOut = true;
            cancelExecution();
          }
        }, request.timeoutMs);
        idleTimer.unref();
      }
    };

    const cancelExecution = (): void => {
      if (connection !== null && activeSessionId !== null) {
        connection.cancel(activeSessionId);
      } else if (transport !== null) {
        void transport.close();
      }
    };

    const onAbort = (): void => {
      killed = true;
      cancelExecution();
    };

    const gate = this.options.authorityGate;
    const verifyResourceLink = (uri: string): boolean => {
      if (!uri.startsWith('file://')) return false;
      let filePath: string;
      try {
        filePath = fileURLToPath(uri);
      } catch {
        return false;
      }
      if (gate && activeSessionId !== null) {
        return gate.authorize({
          requestKind: 'filesystem',
          acpSessionId: activeSessionId,
          connectionGeneration: generation,
          mutating: false,
          targetPath: filePath
        }).allowed;
      }
      const rel = path.relative(path.resolve(request.cwd), path.resolve(filePath));
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    };

    const settleTeardown = async (): Promise<TreeTeardownOutcome | null> => {
      if (teardownOutcome !== null) return teardownOutcome;
      if (connection !== null) {
        await connection.close();
      }
      if (transport !== null) {
        const qual = await verifyAcpTransportTeardown(transport);
        const result =
          qual.outcome === 'residual'
            ? 'tree-unconfirmed'
            : process.platform === 'win32'
              ? 'platform-unanswerable'
              : 'group-gone';
        teardownOutcome = {
          attribution: {
            runId,
            phase: request.phase,
            iteration: request.iteration
          },
          runner: label,
          pid: transport.pid ?? null,
          result
        };
        if (qual.outcome === 'residual') {
          warnings.push('acp-transport-residual-group');
        }
      }
      return teardownOutcome;
    };

    this.activeExecutions.set(invocationId, {
      invocationId,
      getConnection: () => connection,
      getSessionId: () => activeSessionId,
      cancel: () => {
        killed = true;
        cancelExecution();
      },
      teardownPromise: settleTeardown
    });

    let exitCode: number | null = 1;
    try {
      if (request.cancellationSignal?.aborted) {
        killed = true;
        exitCode = 130;
        return this.finalizeOutput({
          stdoutBuffer,
          stderrBuffer,
          exitCode,
          killed,
          timedOut,
          deadlineExceeded,
          sawTerminalResult: false,
          startedAtMs,
          warnings,
          commandDisplay: `acp:${profile.profileId}`,
          cliSessionId: undefined,
          effectiveFatalSignatures: request.effectiveFatalSignatures,
          liveStreamText
        });
      }

      request.cancellationSignal?.addEventListener('abort', onAbort);
      resetIdleTimer();
      if (maxDurationMs !== null) {
        deadlineTimer = setTimeout(() => {
          deadlineExceeded = true;
          timedOut = false;
          cancelExecution();
        }, maxDurationMs);
        deadlineTimer.unref();
      }

      const spawnEnv = buildSpawnEnv(request);
      const launchSpec = resolveAcpProfileLaunch({
        kind: this.options.kind,
        resolvedCliPath: request.cliPath,
        cwd: request.cwd,
        env: spawnEnv,
        capabilities: request.capabilities,
        model: request.model,
        effort: request.effort,
        bridgeScriptPath: this.options.bridgeScriptPath
      });

      const opened = await openAcpConnection({
        profile,
        generation,
        launch: (validatedProfile) => {
          const created = this.options.launchTransport
            ? this.options.launchTransport(validatedProfile, request, generation)
            : spawnStdioTransport(launchSpec);
          transport = created;
          created.onStderr((chunk) => {
            resetIdleTimer();
            emitChunk('stderr', Buffer.from(chunk).toString('utf8'));
          });
          this.options.monitorHook?.({
            kind: 'started',
            runId,
            invocationId,
            helperInvocation: request.helperInvocation === true,
            maxDurationMs,
            pid: created.pid ?? null
          });
          return created;
        },
        permissionPolicy: gate
          ? gate.createPermissionPolicy(generation)
          : undefined,
        verifyResourceLink,
        onObservation: (observation) => {
          resetIdleTimer();
          if (connection !== null) {
            this.options.onAcpObservation?.({
              backendKind: this.options.kind,
              runId,
              invocationId,
              attemptId,
              observation,
              projection: connection.describe()
            });
          }
          // F13-FR-07: history replay is historical observation only; never emit as live output or new usage.
          if (observation.origin !== 'live') {
            return;
          }
          if (
            observation.kind === 'display' &&
            observation.event.kind === 'message' &&
            typeof observation.event.text === 'string'
          ) {
            emitChunk('stdout', encodeAssistantLine(observation.event.text));
          } else if (observation.kind === 'usage') {
            latestUsage = observation.usage;
          }
        }
      });

      if (!opened.ok) {
        warnings.push(`acp-open-refused:${opened.refusal}${opened.detail ? `:${opened.detail}` : ''}`);
        exitCode = 1;
      } else {
        connection = opened.connection;
        const mayLoad =
          (request.isContinue === true || request.sessionReuse === true) &&
          request.resumeSessionOrigin === 'acp' &&
          isValidAcpSessionToken(request.resumeSessionId);
        const sessionRes = mayLoad
          ? await connection.loadSession(request.resumeSessionId!, request.cwd, { mayLoad: true })
          : await connection.newSession(request.cwd);

        if (!sessionRes.ok) {
          warnings.push(`acp-session-failed:${sessionRes.reason}`);
          exitCode = 1;
        } else {
          activeSessionId = sessionRes.sessionId;
          gate?.registerScope({
            attemptId,
            profileId: profile.profileId,
            acpSessionId: activeSessionId,
            connectionGeneration: generation,
            ownershipGeneration: this.options.currentOwnershipGeneration?.() ?? 1,
            executionRoot: request.cwd,
            primaryWorkspaceRoot: this.options.primaryWorkspaceRoot ?? request.cwd,
            protectedDatabasePaths: this.options.protectedDatabasePaths,
            authorizedUpstreamInputPaths: request.authorizedUpstreamInputPaths,
            authorizedOutputPaths: request.authorizedOutputPaths,
            capabilities: request.capabilities
          });

          const blocks: readonly AcpPromptBlock[] =
            request.acpPromptBlocks && request.acpPromptBlocks.length > 0
              ? request.acpPromptBlocks
              : [{ type: 'text', text: request.prompt }];

          const outcome = await connection.prompt({
            sessionId: activeSessionId,
            attemptId,
            rootId,
            blocks
          });

          const elapsedMs = Date.now() - startedAtMs;
          if (outcome.kind === 'completed') {
            emitChunk('stdout', encodeUsageResultLine(this.options.kind, activeSessionId, elapsedMs, latestUsage));
            sawTerminalResult = true;
            exitCode = 0;
          } else if (outcome.kind === 'cancelled') {
            exitCode = 130;
          } else if (outcome.kind === 'uncertain') {
            warnings.push(`acp-turn-uncertain:${outcome.reason}`);
            exitCode = 1;
          } else if (outcome.kind === 'refused') {
            warnings.push(`acp-prompt-refused:${outcome.reason}${outcome.detail ? `:${outcome.detail}` : ''}`);
            exitCode = 1;
          } else if (outcome.kind === 'rejected') {
            warnings.push(`acp-prompt-rejected:${outcome.code}`);
            exitCode = 1;
          } else {
            warnings.push(`acp-prompt-not-dispatched:${outcome.reason}`);
            exitCode = 1;
          }
        }
      }
    } finally {
      if (idleTimer !== null) clearTimeout(idleTimer);
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      request.cancellationSignal?.removeEventListener?.('abort', onAbort);
      if (activeSessionId !== null) {
        gate?.revokeSession(activeSessionId);
      }
      await settleTeardown();
      if (transport !== null) {
        this.options.monitorHook?.({
          kind: 'exited',
          runId,
          invocationId,
          exitCode,
          signal: killed ? 'SIGTERM' : null,
          killed,
          timedOut: timedOut || deadlineExceeded
        });
      }
      this.activeExecutions.delete(invocationId);
    }

    return this.finalizeOutput({
      stdoutBuffer,
      stderrBuffer,
      exitCode,
      killed,
      timedOut,
      deadlineExceeded,
      sawTerminalResult,
      startedAtMs,
      warnings,
      commandDisplay: `acp:${profile.profileId}`,
      cliSessionId: activeSessionId ?? undefined,
      effectiveFatalSignatures: request.effectiveFatalSignatures,
      liveStreamText
    });
  }

  public cancelActive(): boolean {
    let cancelled = false;
    for (const active of this.activeExecutions.values()) {
      active.cancel();
      cancelled = true;
    }
    if (this.inner.cancelActive()) {
      cancelled = true;
    }
    return cancelled;
  }

  public async settleTeardowns(deadline?: Promise<void>): Promise<readonly TreeTeardownOutcome[]> {
    const acpPromises = [...this.activeExecutions.values()].map(async (entry) => {
      entry.cancel();
      return entry.teardownPromise();
    });
    const waitAll = Promise.all([
      Promise.all(acpPromises),
      this.inner.settleTeardowns(deadline)
    ]);
    const [acpResults, innerResults] = deadline
      ? await Promise.race([waitAll, deadline.then(() => [[], []] as const)])
      : await waitAll;
    const merged: TreeTeardownOutcome[] = [...innerResults];
    for (const item of acpResults) {
      if (item !== null) merged.push(item);
    }
    return merged;
  }

  public close(): void {
    this.closed = true;
    this.cancelActive();
    this.inner.close();
  }

  private finalizeOutput(params: {
    readonly stdoutBuffer: ZippedStreamBuffer;
    readonly stderrBuffer: ZippedStreamBuffer;
    readonly exitCode: number | null;
    readonly killed: boolean;
    readonly timedOut: boolean;
    readonly deadlineExceeded: boolean;
    readonly sawTerminalResult: boolean;
    readonly startedAtMs: number;
    readonly warnings: readonly string[];
    readonly commandDisplay: string;
    readonly cliSessionId: string | undefined;
    readonly effectiveFatalSignatures: InvocationRequest['effectiveFatalSignatures'];
    readonly liveStreamText: string;
  }): RawInvocationOutput {
    params.stdoutBuffer.finalize();
    params.stderrBuffer.finalize();
    const streamFatalMatch = params.effectiveFatalSignatures
      ? classifyFatal(params.liveStreamText, params.stderrBuffer.getTrailingLines(200), params.effectiveFatalSignatures)
      : undefined;

    return {
      stdoutBuffer: params.stdoutBuffer,
      stderrBuffer: params.stderrBuffer,
      exitCode: params.exitCode,
      killed: params.killed,
      timedOut: params.timedOut,
      ...(params.deadlineExceeded ? { deadlineExceeded: true } : {}),
      sawTerminalResult: params.sawTerminalResult,
      durationMs: Math.max(0, Date.now() - params.startedAtMs),
      ...(params.warnings.length > 0 ? { diagnosticWarnings: params.warnings } : {}),
      command: params.commandDisplay,
      ...(params.cliSessionId ? { cliSessionId: params.cliSessionId } : {}),
      ...(streamFatalMatch ? { streamFatalMatch } : {})
    };
  }
}
