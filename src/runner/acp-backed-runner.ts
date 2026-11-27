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
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  type AcpBillableTokens,
  type AcpConnection,
  type AcpConnectionProjection,
  type AcpObservation,
  type AcpPromptBlock,
  type AgentProfile
} from '../contracts/acp-runtime';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import { getBackendDescriptor } from '../contracts/backend-descriptors';
import type {
  BackendRunner,
  MonitorSidecarHook,
  TreeTeardownOutcome
} from '../contracts/backend-runner';
import { combineStreamScans, IncrementalFatalScanner } from '../lib/incremental-fatal-scanner';
import { openAcpConnection } from '../services/acp-runtime/acp-client';
import { isAgentIdentifier } from '../services/acp-runtime/agent-identifier';
import { createRunnerObservationBridge } from '../services/acp-runtime/client-guards';
import type { AcpTerminalReconciliation } from '../services/acp-runtime/terminal-reconciliation';
import {
  createInMemoryAcpSessionBindingStore,
  isEphemeralBridgeSessionId,
  isValidProviderSessionId,
  normalizeAcpWorkspaceRoot,
  type AcpPersistedSessionBinding,
  type AcpSessionBindingStore
} from '../services/acp-runtime/acp-durable-runtime-store';
import {
  ACP_PROFILE_IDS,
  getBuiltinAcpProfile,
  resolveAcpProfileLaunch,
  type AcpHostLocality,
  type AcpProfilePlatform
} from '../services/acp-runtime/profiles';
import {
  spawnStdioTransport,
  type AcpStdioTransport
} from '../services/acp-runtime/stdio-transport';
import {
  AcpAuthorityGate,
  verifyAcpTransportTeardown
} from '../services/containment-qualification/acp-authority-gate';
import { VerboseDiagnosticWriter } from '../audit/verbose-diagnostic-writer';
import { SanitizedLogger } from '../lib/logger';
import type { EvidenceHealthReporter } from '../services/evidence-health/evidence-health-monitor';
import type { DeliveryRepresentation } from '../contracts/phase-context/context-delivery';
import {
  normalizeHandoffIdentifier,
  verifyNegotiatedHandoffCapabilities
} from '../services/phase-context/handoff-delivery-coordinator';
import { AcpOpenWorkTracker } from './acp-open-work-tracker';
import { SpawnRefusedAfterCloseError } from './spawn-refused-after-close';
import { AcpStreamEncoder } from './acp-stream-encoder';
import { nextInvocationId } from './invocation-identity';
import {
  armedMaxDurationMs,
  type InvocationOutputSink,
  type InvocationRequest,
  type RawInvocationOutput
} from './invocation-result';
import { buildSpawnEnv } from './spawn-env';
import { assertExecutableUnchanged, resolveExecutableCommand } from '../lib/spawn-command';
import { buildLaneGitEnv } from '../services/execution-lanes/git-runner';
import {
  ACP_MIN_SINK_STALL_WATCHDOG_MS,
  ACP_VERBOSE_TEE_CANCEL_DRAIN_MS,
  AcpStreamBackpressureController,
  SCANNER_SHA256_HEX_RE,
  encodeUsageResultLine,
  mergeLiveUsageObservation,
  reconcileAcpPromptOutcome,
  verifyAcpResourceLink
} from './acp-runner-stream-helpers';
import { SessionCostLedger } from './session-cost-ledger';
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
  readonly logger?: SanitizedLogger;
  readonly evidenceHealth?: EvidenceHealthReporter;
  readonly readConfiguredProfile?: () => string;
  readonly allowLegacyDrain?: boolean;
  readonly bridgeScriptPath?: string;
  readonly authorityGate?: AcpAuthorityGate;
  readonly primaryWorkspaceRoot?: string;
  readonly protectedDatabasePaths?: readonly string[] | (() => readonly string[]);
  readonly currentOwnershipGeneration?: () => number;
  /**
   * Review gap GC-08 follow-up — awaited before a session registers its scope, so the gate holds an
   * authoritative primacy verdict before the session's first callback. `false` ends the attempt
   * with `acp-ownership-unverified` before its prompt is sent.
   */
  readonly primeAuthority?: () => Promise<boolean>;
  readonly onAcpObservation?: (event: AcpRunnerObservationEvent) => void;
  /** FR-R7-14 (14-04): durable backend + workspace-root session binding store for bridged profiles. */
  readonly sessionBindingStore?: AcpSessionBindingStore;
  /** FR-R7-14 (14-06): persistent monotonic connection-generation allocator across host restarts. */
  readonly allocateConnectionGeneration?: () => number;
  /** FR-R7-14 (14-11): host locality classification (`'local'` vs `'remote'`) evaluated before spawn. */
  readonly hostLocality?: AcpHostLocality;
  /**
   * The platform the profile's qualification is judged against; omitted, this host's. Tests pin it
   * so a qualified turn, or an unqualified refusal, is exercised whatever the host is.
   */
  readonly platform?: AcpProfilePlatform;
  /** FR-035: optional persisted phase-handoff DeliveryRepresentation lookup verified against negotiated capabilities. */
  readonly resolveHandoffRepresentation?: (attemptId: string) => DeliveryRepresentation | null;
  /** FR-035: optional current handoff contentDigest lookup verified against the persisted representation. */
  readonly resolveHandoffContentDigest?: (handoffId: string) => string | null;
  readonly launchTransport?: (
    profile: AgentProfile,
    request: InvocationRequest,
    generation: number
  ) => AcpStdioTransport;
}

let nextAcpGeneration = 0;

function sanitizeHostToken(raw: string | undefined, fallback: string): string {
  if (!raw || raw.trim().length === 0) return fallback;
  const cleaned = raw.trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '');
  if (cleaned.length === 0) return fallback;
  return cleaned.slice(0, 128);
}

function isValidAcpSessionToken(raw: string | undefined): raw is string {
  return isAgentIdentifier(raw);
}

function resolveProtectedDatabasePaths(
  source: AcpBackedRunnerOptions['protectedDatabasePaths']
): readonly string[] {
  if (source === undefined) return [];
  return typeof source === 'function' ? source() : source;
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
  private readonly sessionRoots = new Map<string, string>();
  private readonly fallbackSessionBindingStore = createInMemoryAcpSessionBindingStore();
  private readonly sessionCosts = new SessionCostLedger();
  private closed = false;

  public constructor(private readonly options: AcpBackedRunnerOptions) {
    this.inner = options.inner;
  }

  private get sessionBindingStore(): AcpSessionBindingStore {
    return this.options.sessionBindingStore ?? this.fallbackSessionBindingStore;
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
    if (request.review === undefined && request.legacyDrain === true && this.options.allowLegacyDrain !== false) {
      if (this.closed) {
        throw new SpawnRefusedAfterCloseError(getBackendDescriptor(this.options.kind).runnerLabel);
      }
      if (request.cancellationSignal?.aborted === true) {
        const stdoutBuffer = new ZippedStreamBuffer();
        const stderrBuffer = new ZippedStreamBuffer();
        stdoutBuffer.finalize();
        stderrBuffer.finalize();
        return {
          stdoutBuffer,
          stderrBuffer,
          exitCode: null,
          killed: true,
          timedOut: false,
          durationMs: 0,
          command: request.cliPath
        };
      }
      return this.inner.invoke(request, outputSink);
    }
    const label = getBackendDescriptor(this.options.kind).runnerLabel;
    if (this.closed) {
      throw new SpawnRefusedAfterCloseError(label);
    }

    const expectedProfileId = ACP_PROFILE_IDS[this.options.kind];
    const configuredRaw = (this.options.readConfiguredProfile ? this.options.readConfiguredProfile().trim() : '') || 'auto';
    if (configuredRaw !== 'auto' && configuredRaw !== expectedProfileId) {
      throw new AcpProfileMismatchError(this.options.kind, configuredRaw, expectedProfileId);
    }

    const basePlatform = this.options.platform ?? { os: process.platform, arch: process.arch };
    const effectivePlatform: AcpProfilePlatform =
      basePlatform.locality !== undefined
        ? basePlatform
        : this.options.hostLocality !== undefined
          ? { ...basePlatform, locality: this.options.hostLocality }
          : basePlatform;
    const profile = getBuiltinAcpProfile(this.options.kind, {
      ...(request.model !== undefined ? { model: request.model } : {}),
      platform: effectivePlatform
    });
    let generation = 0;
    const invocationId = nextInvocationId(label);
    const runId = request.runId ?? null;
    const attemptId = sanitizeHostToken(request.attemptId, sanitizeHostToken(invocationId, 'attempt-1'));
    const rootId = sanitizeHostToken(runId ?? undefined, 'adhoc-root');
    const maxDurationMs = armedMaxDurationMs(request);

    const stdoutBuffer = new ZippedStreamBuffer();
    const stderrBuffer = new ZippedStreamBuffer();
    const startedAtMs = Date.now();
    const warnings: string[] = [];
    const streamEncoder = new AcpStreamEncoder();
    const openWorkTracker = new AcpOpenWorkTracker();
    const tee = request.verboseDiagnostics
      ? {
          target: request.verboseDiagnostics,
          writer: new VerboseDiagnosticWriter(
            this.options.logger ?? new SanitizedLogger(),
            this.options.evidenceHealth
          )
        }
      : null;

    let transport: AcpStdioTransport | null = null as AcpStdioTransport | null;
    let connection: AcpConnection | null = null;
    let activeSessionId: string | null = null;
    let latestBillableTokens: AcpBillableTokens | null = null;
    let latestClaudeCostUsd: number | undefined;
    let sessionLoaded = false;
    let sawTerminalResult = false;
    let acpTurnSettled = false;
    let backgroundWorkOpenAtResult = false;
    let killed: boolean = false as boolean;
    let timedOut: boolean = false as boolean;
    let deadlineExceeded: boolean = false as boolean;
    let settled = false;
    let promptDispatched = false;
    let emittedUsageLine = false;
    let teardownOutcome: TreeTeardownOutcome | null = null;
    let terminalReconciliation: AcpTerminalReconciliation | undefined;
    const stderrDecoder = new TextDecoder('utf-8', { fatal: false });
    const stdoutFatalScanner = request.effectiveFatalSignatures
      ? new IncrementalFatalScanner('stdout', request.effectiveFatalSignatures)
      : null;
    const stderrFatalScanner = request.effectiveFatalSignatures
      ? new IncrementalFatalScanner('stderr', request.effectiveFatalSignatures)
      : null;

    let idleTimer: ReturnType<typeof setTimeout> | null = null as ReturnType<typeof setTimeout> | null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

    const suspendIdleTimer = (): void => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const clearDeadlineTimer = (): void => {
      if (deadlineTimer !== null) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
    };

    const backpressure = new AcpStreamBackpressureController(
      outputSink,
      tee,
      () => transport,
      (warning) => warnings.push(warning),
      suspendIdleTimer,
      () => resetIdleTimer(),
      () => settled || killed || deadlineExceeded || timedOut,
      maxDurationMs === null
        ? {
            timeoutMs: Math.max(request.timeoutMs, ACP_MIN_SINK_STALL_WATCHDOG_MS),
            onStall: () => {
              if (!settled && !deadlineExceeded && !killed) {
                timedOut = true;
                cancelExecution();
              }
            }
          }
        : undefined
    );

    const resetIdleTimer = (): void => {
      suspendIdleTimer();
      if (settled || killed || deadlineExceeded || timedOut || backpressure.isBackpressured) return;
      if (request.timeoutMs > 0) {
        idleTimer = setTimeout(() => {
          if (!settled && !deadlineExceeded && !killed) {
            timedOut = true;
            cancelExecution();
          }
        }, request.timeoutMs);
        idleTimer.unref();
      }
    };

    const emitChunk = (stream: 'stdout' | 'stderr', chunk: string): void => {
      if (chunk.length === 0) return;
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      if (stream === 'stdout') {
        stdoutBuffer.append(chunk);
        stdoutFatalScanner?.append(chunk);
        backpressure.enqueueVerboseTee(chunk, chunkBytes);
        this.options.monitorHook?.({ kind: 'stdout-chunk', runId, invocationId, chunk });
      } else {
        stderrBuffer.append(chunk);
        stderrFatalScanner?.append(chunk);
        this.options.monitorHook?.({ kind: 'stderr-chunk', runId, invocationId, chunk });
      }
      backpressure.writeToSink(stream, chunk, chunkBytes);
    };

    const cancelExecution = (): void => {
      backpressure.releaseAll();
      if (promptDispatched && connection !== null && activeSessionId !== null) {
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
    const verifyResourceLink = (uri: string): boolean | Promise<boolean> =>
      verifyAcpResourceLink({
        uri,
        cwd: request.cwd,
        gate,
        activeSessionId,
        generation,
        attemptId,
        liveProtectedPaths: resolveProtectedDatabasePaths(this.options.protectedDatabasePaths)
      });

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

    const isBridgeProfile = profile.kind === 'bridge';
    const normalizedWorkspaceRoot = normalizeAcpWorkspaceRoot(request.cwd);
    let persistedCliSessionId: string | undefined;
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
          acpTurnSettled: false,
          backgroundWorkOpenAtResult: false,
          startedAtMs,
          warnings,
          diagnosticsCaptured: false,
          commandDisplay: `acp:${profile.profileId}`,
          cliSessionId: undefined,
          stdoutFatalScanner,
          stderrFatalScanner,
          terminalReconciliation: { status: 'cancelled', stopReason: 'cancelled' },
          streamPendingHighWaterBytes: backpressure.streamPendingHighWaterBytes
        });
      }

      // FR-R7-14 (14-04): resolve and verify durable bridged provider session bindings BEFORE
      // launching any bridge or child CLI process so missing/mismatched bindings refuse cleanly.
      const isResumeRequested = request.isContinue === true || request.sessionReuse === true;
      let matchedBridgeBinding: AcpPersistedSessionBinding | null = null;
      let bridgeResumeRefusal: string | null = null;
      if (isBridgeProfile && isResumeRequested && request.resumeSessionOrigin !== 'legacy-cli') {
        const resumeId = request.resumeSessionId;
        if (!isValidAcpSessionToken(resumeId)) {
          if (request.isContinue === true) {
            bridgeResumeRefusal = 'missing-session-id';
          }
        } else if (isEphemeralBridgeSessionId(resumeId)) {
          bridgeResumeRefusal = 'ephemeral-session-id';
        } else {
          const binding = this.sessionBindingStore.getBinding(resumeId);
          if (binding === null) {
            bridgeResumeRefusal = 'binding-missing';
          } else if (binding.backend !== this.options.kind) {
            bridgeResumeRefusal = 'backend-mismatch';
          } else if (binding.workspaceRoot !== normalizedWorkspaceRoot) {
            bridgeResumeRefusal = 'workspace-root-mismatch';
          } else if (!isValidProviderSessionId(binding.providerSessionId)) {
            bridgeResumeRefusal = 'invalid-provider-session';
          } else {
            matchedBridgeBinding = binding;
          }
        }
      }

      if (bridgeResumeRefusal !== null) {
        warnings.push(`acp-session-resume-unrecoverable:${bridgeResumeRefusal}`);
        exitCode = 1;
      } else if (profile.qualification !== 'qualified') {
        warnings.push('acp-open-refused:profile-unqualified');
        exitCode = 1;
      } else if (this.options.primeAuthority !== undefined && !(await this.options.primeAuthority())) {
        if (this.isClosed()) {
          throw new SpawnRefusedAfterCloseError(label);
        }
        warnings.push('acp-ownership-unverified');
        exitCode = 1;
      } else {
        if (this.isClosed()) {
          throw new SpawnRefusedAfterCloseError(label);
        }
        const turnOwnershipGeneration = this.options.currentOwnershipGeneration?.();
        if (!killed && request.cancellationSignal?.aborted !== true && tee !== null) {
          await tee.writer.prepare(tee.target);
        }
        if (this.isClosed()) {
          throw new SpawnRefusedAfterCloseError(label);
        }

        request.cancellationSignal?.addEventListener('abort', onAbort);
        const abortedDuringSetup = killed || request.cancellationSignal?.aborted === true;
        const ownershipShifted =
          turnOwnershipGeneration !== undefined &&
          this.options.currentOwnershipGeneration?.() !== turnOwnershipGeneration;
        if (abortedDuringSetup) {
          killed = true;
          exitCode = 130;
          terminalReconciliation = { status: 'cancelled', stopReason: 'cancelled' };
        } else if (ownershipShifted) {
          warnings.push('acp-ownership-unverified');
          exitCode = 1;
        } else if (
          this.options.kind === 'codex' &&
          request.review?.kind === 'security' &&
          (typeof request.review.resolvedScannerPath !== 'string' ||
            request.review.resolvedScannerPath.trim().length === 0 ||
            !path.isAbsolute(request.review.resolvedScannerPath) ||
            typeof request.review.resolvedScannerSha256 !== 'string' ||
            !SCANNER_SHA256_HEX_RE.test(request.review.resolvedScannerSha256))
        ) {
          warnings.push('acp-open-refused:scanner-unresolved');
          exitCode = 1;
        } else {
        const allocatedGeneration = this.options.allocateConnectionGeneration?.();
        generation =
          typeof allocatedGeneration === 'number' &&
          Number.isSafeInteger(allocatedGeneration) &&
          allocatedGeneration >= 1
            ? allocatedGeneration
            : nextAcpGeneration + 1;
        nextAcpGeneration = Math.max(nextAcpGeneration, generation);
        resetIdleTimer();
        if (maxDurationMs !== null) {
          deadlineTimer = setTimeout(() => {
            if (!settled && !killed) {
              deadlineExceeded = true;
              timedOut = false;
              cancelExecution();
            }
          }, maxDurationMs);
          deadlineTimer.unref();
        }

        const env = buildSpawnEnv(request);
        const spawnEnv = request.review === undefined ? env : { ...buildLaneGitEnv(env), GIT_OPTIONAL_LOCKS: '0' };
        let effectiveCliPath = request.cliPath;
        let executableUnresolved = false;
        if (this.options.launchTransport === undefined) {
          const resolvedExec = resolveExecutableCommand(request.cliPath, spawnEnv);
          if (!resolvedExec.ok) {
            executableUnresolved = true;
          } else {
            effectiveCliPath = resolvedExec.resolvedPath;
          }
        }
        if (executableUnresolved) {
          warnings.push('acp-open-refused:executable-unresolved');
          exitCode = 1;
        } else {
        const launchSpec = resolveAcpProfileLaunch({
          kind: this.options.kind,
          resolvedCliPath: effectiveCliPath,
          ...(request.executableFileStamp && { executableFileStamp: request.executableFileStamp }),
          cwd: request.cwd,
          env: spawnEnv,
          ...(request.capabilities !== undefined ? { capabilities: request.capabilities } : {}),
          ...(request.review !== undefined ? { nativeReview: request.review } : {}),
          ...(request.model !== undefined ? { model: request.model } : {}),
          ...(request.effort !== undefined ? { effort: request.effort } : {}),
          ...(this.options.bridgeScriptPath !== undefined
            ? { bridgeScriptPath: this.options.bridgeScriptPath }
            : {})
        });

        const obsBridge = createRunnerObservationBridge({
          profileId: profile.profileId, generation, rootId, attemptId, getSessionId: () => activeSessionId,
          deliver: (observation) => {
            if (connection !== null) this.options.onAcpObservation?.({ backendKind: this.options.kind, runId, invocationId, attemptId, observation, projection: connection.describe() });
          }
        });
        const isKilled = (): boolean => killed;
        const isTimedOutOrDeadline = (): boolean => timedOut || deadlineExceeded;
        const isSignalAborted = (): boolean => request.cancellationSignal?.aborted === true;
        if (request.onBeforeSpawn !== undefined) await request.onBeforeSpawn({ helperInvocation: request.helperInvocation === true });
        if (this.isClosed()) throw new SpawnRefusedAfterCloseError(label);
        if (isKilled() || isSignalAborted()) {
          killed = true; exitCode = 130; terminalReconciliation = { status: 'cancelled', stopReason: 'cancelled' };
        } else if (isTimedOutOrDeadline()) {
          exitCode = 130; terminalReconciliation = { status: 'missing-terminal-record', warningCode: 'acp-missing-terminal-record' };
        } else {
        let spawnedPid: number | undefined;
        const opened = await openAcpConnection({
          profile,
          generation,
          launch: (validatedProfile) => {
            assertExecutableUnchanged(effectiveCliPath, request.executableFileStamp);
            const created = this.options.launchTransport
              ? this.options.launchTransport(validatedProfile, request, generation)
              : spawnStdioTransport(launchSpec);
            transport = created;
            spawnedPid = created.pid;
            created.onStderr((chunk) => { resetIdleTimer(); emitChunk('stderr', stderrDecoder.decode(chunk, { stream: true })); });
            this.options.monitorHook?.({ kind: 'started', runId, invocationId, helperInvocation: request.helperInvocation === true, maxDurationMs, pid: created.pid ?? null });
            return created;
          },
          permissionPolicy: obsBridge.wrapPermissionPolicy(gate?.createPermissionPolicy(generation), this.options.logger),
          verifyResourceLink,
          onObservation: (observation) => {
            resetIdleTimer();
            obsBridge.forward(observation);
            // F13-FR-07: history replay is historical observation only; never emit as live output or new usage.
            if (observation.origin !== 'live') return;
            if (observation.kind === 'display') {
              openWorkTracker.observe(observation.event);
              for (const encodedLine of streamEncoder.push(observation.event)) emitChunk('stdout', encodedLine);
            } else if (observation.kind === 'usage') {
              const merged = mergeLiveUsageObservation({
                kind: this.options.kind,
                currentTokens: latestBillableTokens,
                currentClaudeCostUsd: latestClaudeCostUsd,
                observedTokens: observation.usage.billableTokens,
                observedCost: observation.usage.cost
              });
              latestBillableTokens = merged.billableTokens;
              latestClaudeCostUsd = merged.claudeCostUsd;
            }
          }
        });
        if (!opened.ok) {
          if (isKilled() || isSignalAborted()) {
            killed = true; exitCode = 130; terminalReconciliation = { status: 'cancelled', stopReason: 'cancelled' };
          } else {
            warnings.push(`acp-open-refused:${opened.refusal}${opened.detail ? `:${opened.detail}` : ''}`);
            exitCode = 1;
          }
        } else {
          connection = opened.connection;
          if (request.helperInvocation !== true && request.onAfterSpawn !== undefined) await request.onAfterSpawn(spawnedPid);
          const normalizedCwd = normalizeAcpWorkspaceRoot(request.cwd);
          const resumeId = request.resumeSessionId;
          const priorSessionRoot = !isBridgeProfile && isValidAcpSessionToken(resumeId) ? this.sessionRoots.get(resumeId) : undefined;
          const rootMismatchOnResume = priorSessionRoot !== undefined && priorSessionRoot !== normalizedCwd;
          if (rootMismatchOnResume) warnings.push('acp-session-rebind-fresh-root');
          const canLoadNative = !isBridgeProfile && !rootMismatchOnResume && isResumeRequested && isValidAcpSessionToken(resumeId) && (request.resumeSessionOrigin === 'acp' || (request.resumeSessionOrigin === undefined && priorSessionRoot !== undefined));
          const wantsLoadSession = isBridgeProfile ? matchedBridgeBinding !== null : canLoadNative;
          const handoffRep = this.options.resolveHandoffRepresentation?.(normalizeHandoffIdentifier(request.attemptId ?? attemptId, attemptId)) ?? null;
          const capCheck = verifyNegotiatedHandoffCapabilities({
            negotiated: connection.describe().capabilities,
            representation: handoffRep,
            activeProfile: { profileId: profile.profileId, profileRevision: profile.revision },
            ...(handoffRep !== null && this.options.resolveHandoffContentDigest !== undefined ? { expectedContentDigest: this.options.resolveHandoffContentDigest(handoffRep.handoffId) ?? '' } : {}),
            ...(request.phaseHandoffId !== undefined ? { expectedHandoffId: request.phaseHandoffId } : {}),
            ...(request.phaseHandoffRepresentationDigest !== undefined ? { expectedRepresentationDigest: request.phaseHandoffRepresentationDigest } : {}),
            acpPromptBlocks: request.acpPromptBlocks,
            wantsLoadSession,
            isContinue: request.isContinue === true
          });
          let sessionRes: Awaited<ReturnType<AcpConnection['newSession']>> | null = null;
          if (!capCheck.ok) {
            warnings.push(capCheck.warning);
            exitCode = 1;
          } else {
            if (capCheck.warning !== undefined) warnings.push(capCheck.warning);
            const allowLoad = wantsLoadSession && !capCheck.forceFreshSession;
            sessionLoaded = allowLoad && (isBridgeProfile ? matchedBridgeBinding !== null : isValidAcpSessionToken(resumeId));
            sessionRes = isBridgeProfile
              ? allowLoad && matchedBridgeBinding !== null
                ? await connection.loadSession(matchedBridgeBinding.persistedSessionId, request.cwd, { mayLoad: true, providerSessionId: matchedBridgeBinding.providerSessionId })
                : await connection.newSession(request.cwd)
              : allowLoad && isValidAcpSessionToken(resumeId)
                ? await connection.loadSession(resumeId, request.cwd, { mayLoad: true })
                : await connection.newSession(request.cwd);
          }

          if (sessionRes !== null && !sessionRes.ok) {
            if (isKilled() || isSignalAborted()) {
              killed = true; exitCode = 130; terminalReconciliation = { status: 'cancelled', stopReason: 'cancelled' };
            } else {
              if (sessionRes.reason === 'transport-closed') {
                obsBridge.emitLifecycle({ kind: 'transport-disconnected', reason: 'transport-closed' });
              }
              warnings.push(`acp-session-failed:${sessionRes.reason}`);
              exitCode = 1;
            }
          } else if (sessionRes !== null) {
            activeSessionId = sessionRes.sessionId;
            if (!isBridgeProfile) {
              const normalizedCwd = normalizeAcpWorkspaceRoot(request.cwd);
              if (!this.sessionRoots.has(activeSessionId) && this.sessionRoots.size >= 512) {
                const oldestKey = this.sessionRoots.keys().next().value;
                if (oldestKey !== undefined) this.sessionRoots.delete(oldestKey);
              }
              this.sessionRoots.set(activeSessionId, normalizedCwd);
            }

            // F10-FR-19: verify access to accepted F15 upstream artifact versions before prompt dispatch.
            let missingUpstream = false;
            if (request.authorizedUpstreamInputPaths !== undefined) {
              for (const upstreamPath of request.authorizedUpstreamInputPaths) {
                try {
                  await fs.access(upstreamPath);
                } catch {
                  missingUpstream = true;
                  break;
                }
              }
            }
            if (missingUpstream) {
              warnings.push('acp-upstream-artifact-inaccessible');
              exitCode = 1;
            } else {
              // FR-R7-16 (16-17): re-verify trust, primacy, and ownership generation before prompt dispatch.
              const prePromptGenOk =
                turnOwnershipGeneration === undefined ||
                this.options.currentOwnershipGeneration?.() === turnOwnershipGeneration;
              const prePromptAuthorityOk =
                !this.isClosed() &&
                !isKilled() &&
                !isSignalAborted() &&
                prePromptGenOk &&
                (this.options.primeAuthority === undefined || (await this.options.primeAuthority())) &&
                (turnOwnershipGeneration === undefined ||
                  this.options.currentOwnershipGeneration?.() === turnOwnershipGeneration);
              if (this.isClosed()) {
                throw new SpawnRefusedAfterCloseError(label);
              } else if (isKilled() || isSignalAborted()) {
                killed = true;
                exitCode = 130;
                terminalReconciliation = { status: 'cancelled', stopReason: 'cancelled' };
              } else if (isTimedOutOrDeadline()) {
                exitCode = 130;
                terminalReconciliation = { status: 'missing-terminal-record', warningCode: 'acp-missing-terminal-record' };
              } else if (!prePromptAuthorityOk) {
                warnings.push('acp-ownership-unverified');
                exitCode = 1;
              } else {
              gate?.registerScope({
                attemptId,
                profileId: profile.profileId,
                acpSessionId: activeSessionId,
                connectionGeneration: generation,
                ownershipGeneration: turnOwnershipGeneration ?? 1,
                executionRoot: request.cwd,
                primaryWorkspaceRoot: this.options.primaryWorkspaceRoot ?? request.cwd,
                ...(this.options.protectedDatabasePaths !== undefined
                  ? { protectedDatabasePaths: () => resolveProtectedDatabasePaths(this.options.protectedDatabasePaths) }
                  : {}),
                ...(request.authorizedUpstreamInputPaths !== undefined
                  ? { authorizedUpstreamInputPaths: request.authorizedUpstreamInputPaths }
                  : {}),
                ...(request.authorizedOutputPaths !== undefined
                  ? { authorizedOutputPaths: request.authorizedOutputPaths }
                  : {}),
                ...(request.capabilities !== undefined ? { capabilities: request.capabilities } : {})
              });

              const blocks: readonly AcpPromptBlock[] =
                request.acpPromptBlocks && request.acpPromptBlocks.length > 0
                  ? request.acpPromptBlocks
                  : [{ type: 'text', text: request.prompt }];

              promptDispatched = true;
              const outcome = await connection.prompt({
                sessionId: activeSessionId,
                attemptId,
                rootId,
                blocks
              });
              promptDispatched = false;
              settled = true;
              suspendIdleTimer();
              clearDeadlineTimer();
              backpressure.releaseAll();

              const elapsedMs = Date.now() - startedAtMs;
              for (const encodedLine of streamEncoder.flush()) {
                emitChunk('stdout', encodedLine);
              }

              if (isBridgeProfile) {
                const dispatchedOutcome =
                  outcome.kind === 'completed' ||
                  outcome.kind === 'cancelled' ||
                  outcome.kind === 'uncertain' ||
                  outcome.kind === 'rejected';
                if (dispatchedOutcome) {
                  const observedProviderId = connection.providerSessionIdOf(activeSessionId);
                  const hasValidObservedId =
                    observedProviderId !== null && isValidProviderSessionId(observedProviderId);
                  if (matchedBridgeBinding !== null || hasValidObservedId) {
                    const sameEpochBefore =
                      turnOwnershipGeneration === undefined ||
                      this.options.currentOwnershipGeneration?.() === turnOwnershipGeneration;
                    const canPersistBinding =
                      sameEpochBefore &&
                      (this.options.primeAuthority === undefined ||
                        (await this.options.primeAuthority())) &&
                      (turnOwnershipGeneration === undefined ||
                        this.options.currentOwnershipGeneration?.() === turnOwnershipGeneration);
                    if (canPersistBinding) {
                      if (matchedBridgeBinding !== null) {
                        persistedCliSessionId = matchedBridgeBinding.persistedSessionId;
                        const effectiveProviderId = hasValidObservedId
                          ? observedProviderId
                          : matchedBridgeBinding.providerSessionId;
                        this.sessionBindingStore.putBinding({
                          persistedSessionId: matchedBridgeBinding.persistedSessionId,
                          backend: this.options.kind,
                          workspaceRoot: normalizedWorkspaceRoot,
                          providerSessionId: effectiveProviderId,
                          updatedAtMs: Date.now()
                        });
                      } else if (hasValidObservedId) {
                        const mintedSessionId = `acp-sess-${this.options.kind}-${randomUUID()}`;
                        this.sessionBindingStore.putBinding({
                          persistedSessionId: mintedSessionId,
                          backend: this.options.kind,
                          workspaceRoot: normalizedWorkspaceRoot,
                          providerSessionId: observedProviderId,
                          updatedAtMs: Date.now()
                        });
                        persistedCliSessionId = mintedSessionId;
                      }
                    } else if (matchedBridgeBinding !== null) {
                      persistedCliSessionId = matchedBridgeBinding.persistedSessionId;
                    }
                  }
                }
              } else {
                persistedCliSessionId = activeSessionId;
              }

              obsBridge.recordPromptOutcome(activeSessionId, outcome);
              const rec = reconcileAcpPromptOutcome({
                outcome, isNativeReview: request.review !== undefined, isBridgeProfile,
                hasOpenWork: openWorkTracker.hasOpenWork, killed, timedOut, deadlineExceeded,
                nativeAbnormalExit: !isBridgeProfile ? (transport?.getExitInfo?.() ?? null) : null
              });
              if (rec.emitUsageLine) {
                emittedUsageLine = true;
                emitChunk(
                  'stdout',
                  encodeUsageResultLine(
                    this.options.kind,
                    persistedCliSessionId,
                    elapsedMs,
                    latestBillableTokens,
                    latestClaudeCostUsd
                  )
                );
              }
              sawTerminalResult = rec.sawTerminalResult;
              acpTurnSettled = rec.acpTurnSettled;
              backgroundWorkOpenAtResult = rec.backgroundWorkOpenAtResult;
              if (rec.markKilled) killed = true;
              exitCode = rec.exitCode;
              if (rec.warnings.length > 0) warnings.push(...rec.warnings);
              terminalReconciliation = rec.terminalReconciliation;
              }
            }
          }
        }
        }
        }
        }
      }
    } finally {
      settled = true;
      suspendIdleTimer();
      clearDeadlineTimer();
      request.cancellationSignal?.removeEventListener?.('abort', onAbort);
      const stderrTail = stderrDecoder.decode();
      if (stderrTail.length > 0) emitChunk('stderr', stderrTail);
      for (const encodedLine of streamEncoder.flush()) {
        emitChunk('stdout', encodedLine);
      }
      backpressure.releaseAll();
      if (activeSessionId !== null) {
        gate?.revokeSession(activeSessionId, generation);
      }
      await settleTeardown();
      await backpressure.drainVerboseTee(
        killed || timedOut || deadlineExceeded ? ACP_VERBOSE_TEE_CANCEL_DRAIN_MS : undefined
      );
      if (transport !== null) {
        this.options.monitorHook?.({
          kind: 'exited', runId, invocationId, exitCode, signal: killed ? 'SIGTERM' : null, killed, timedOut: timedOut || deadlineExceeded,
          ...(request.attemptId !== undefined ? { attemptId: request.attemptId } : {}),
          streamHighWaterBytes: stdoutBuffer.highWaterRetainedBytes + stderrBuffer.highWaterRetainedBytes,
          streamObservedBytes: stdoutBuffer.totalBytes + stderrBuffer.totalBytes,
          streamPendingHighWaterBytes: backpressure.streamPendingHighWaterBytes,
          streamTruncated: stdoutBuffer.truncated || stderrBuffer.truncated
        });
      }
      this.activeExecutions.delete(invocationId);
    }

    const teeResult = tee?.writer.result();
    const mergedWarnings = [...(teeResult ? teeResult.warnings : []), ...warnings];
    const effectiveSessionId = isBridgeProfile ? persistedCliSessionId : (activeSessionId ?? undefined);
    let sessionCostBaselineUsd: number | undefined;
    let cliSessionCostUsd: number | undefined;
    if (this.options.kind === 'claude') {
      if (
        effectiveSessionId !== undefined &&
        effectiveSessionId === request.resumeSessionId &&
        request.resumeSessionCostUsd !== undefined &&
        Number.isFinite(request.resumeSessionCostUsd) &&
        request.resumeSessionCostUsd >= 0
      ) {
        this.sessionCosts.recordIfAbsent(effectiveSessionId, request.resumeSessionCostUsd);
      }
      sessionCostBaselineUsd =
        (effectiveSessionId === undefined ? undefined : this.sessionCosts.get(effectiveSessionId)) ??
        (!sessionLoaded ? 0 : undefined);
      if (
        emittedUsageLine &&
        effectiveSessionId !== undefined &&
        latestClaudeCostUsd !== undefined &&
        request.helperInvocation !== true
      ) {
        this.sessionCosts.record(effectiveSessionId, latestClaudeCostUsd);
      }
      cliSessionCostUsd =
        effectiveSessionId === undefined ? undefined : this.sessionCosts.get(effectiveSessionId);
    }

    return this.finalizeOutput({
      stdoutBuffer,
      stderrBuffer,
      exitCode,
      killed,
      timedOut,
      deadlineExceeded,
      sawTerminalResult,
      acpTurnSettled,
      backgroundWorkOpenAtResult,
      startedAtMs,
      warnings: mergedWarnings,
      diagnosticsCaptured: teeResult?.streamCaptured === true,
      commandDisplay: `acp:${profile.profileId}`,
      cliSessionId: effectiveSessionId,
      ...(sessionCostBaselineUsd !== undefined ? { sessionCostBaselineUsd } : {}),
      ...(cliSessionCostUsd !== undefined ? { cliSessionCostUsd } : {}),
      stdoutFatalScanner,
      stderrFatalScanner,
      ...(terminalReconciliation !== undefined ? { terminalReconciliation } : {}),
      streamPendingHighWaterBytes: backpressure.streamPendingHighWaterBytes
    });
  }

  private isClosed(): boolean {
    return this.closed;
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
    readonly acpTurnSettled: boolean;
    readonly backgroundWorkOpenAtResult: boolean;
    readonly startedAtMs: number;
    readonly warnings: readonly string[];
    readonly diagnosticsCaptured: boolean;
    readonly commandDisplay: string;
    readonly cliSessionId: string | undefined;
    readonly sessionCostBaselineUsd?: number;
    readonly cliSessionCostUsd?: number;
    readonly stdoutFatalScanner: IncrementalFatalScanner | null;
    readonly stderrFatalScanner: IncrementalFatalScanner | null;
    readonly terminalReconciliation?: AcpTerminalReconciliation;
    readonly streamPendingHighWaterBytes: number;
  }): RawInvocationOutput {
    params.stdoutBuffer.finalize();
    params.stderrBuffer.finalize();
    params.stdoutFatalScanner?.finalize();
    params.stderrFatalScanner?.finalize();
    const streamFatalMatch =
      params.stdoutFatalScanner !== null && params.stderrFatalScanner !== null
        ? combineStreamScans(params.stdoutFatalScanner, params.stderrFatalScanner)
        : undefined;

    return {
      stdoutBuffer: params.stdoutBuffer,
      stderrBuffer: params.stderrBuffer,
      exitCode: params.exitCode,
      killed: params.killed,
      timedOut: params.timedOut,
      ...(params.deadlineExceeded ? { deadlineExceeded: true } : {}),
      sawTerminalResult: params.sawTerminalResult,
      ...(params.acpTurnSettled ? { acpTurnSettled: true } : {}),
      ...(params.backgroundWorkOpenAtResult ? { backgroundWorkOpenAtResult: true } : {}),
      durationMs: Math.max(0, Date.now() - params.startedAtMs),
      ...(params.warnings.length > 0 ? { diagnosticWarnings: params.warnings } : {}),
      ...(params.diagnosticsCaptured ? { diagnosticsCaptured: true } : {}),
      command: params.commandDisplay,
      ...(params.cliSessionId ? { cliSessionId: params.cliSessionId } : {}),
      ...(params.sessionCostBaselineUsd !== undefined
        ? { sessionCostBaselineUsd: params.sessionCostBaselineUsd }
        : {}),
      ...(params.cliSessionCostUsd !== undefined
        ? { cliSessionCostUsd: params.cliSessionCostUsd }
        : {}),
      ...(streamFatalMatch ? { streamFatalMatch } : {}),
      ...(params.terminalReconciliation !== undefined
        ? { terminalReconciliation: params.terminalReconciliation }
        : {}),
      ...(params.streamPendingHighWaterBytes > 0
        ? { streamPendingHighWaterBytes: params.streamPendingHighWaterBytes }
        : {})
    };
  }
}
