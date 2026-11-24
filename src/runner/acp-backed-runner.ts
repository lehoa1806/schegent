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
import { getBackendDescriptor } from '../contracts/backend-descriptors';
import type {
  BackendRunner,
  MonitorSidecarHook,
  TreeTeardownOutcome
} from '../contracts/backend-runner';
import { classifyFatal } from '../lib/fatal-signature-registry';
import {
  canonicalizePathWithTailSync,
  isTargetProtectedPathSync,
  isWorkspaceProtectedPattern,
  normalizeProtectedComparePath
} from '../lib/protected-path-match';
import { openAcpConnection } from '../services/acp-runtime/acp-client';
import { isAgentIdentifier } from '../services/acp-runtime/agent-identifier';
import { createRunnerObservationBridge } from '../services/acp-runtime/client-guards';
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
import { resolveExecutableCommand } from '../lib/spawn-command';
import { buildLaneGitEnv } from '../services/execution-lanes/git-runner';
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

function encodeUsageResultLine(
  kind: BackendRunnerKind,
  sessionId: string | undefined,
  durationMs: number,
  usage: AcpUsageUpdate | null
): string {
  // F06-FR-23: ACP `used`/`size` are context occupancy, never billable tokens; authoritative ACP
  // accounting ingests `AcpUsageUpdate` directly via `onAcpObservation`.
  if (kind === 'codex') {
    return `${JSON.stringify({
      type: 'turn.completed',
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      usage: { input_tokens: 0, output_tokens: 0 }
    })}\n`;
  }
  if (kind === 'agy') {
    return `${JSON.stringify({
      event: 'result',
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
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
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
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
  private readonly sessionRoots = new Map<string, string>();
  private readonly fallbackSessionBindingStore = createInMemoryAcpSessionBindingStore();
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
    let teeChain: Promise<void> = Promise.resolve();

    let transport: AcpStdioTransport | null = null as AcpStdioTransport | null;
    let connection: AcpConnection | null = null;
    let activeSessionId: string | null = null;
    let latestUsage: AcpUsageUpdate | null = null;
    let sawTerminalResult = false;
    let acpTurnSettled = false;
    let backgroundWorkOpenAtResult = false;
    let killed: boolean = false as boolean;
    let timedOut: boolean = false as boolean;
    let deadlineExceeded: boolean = false as boolean;
    let teardownOutcome: TreeTeardownOutcome | null = null;
    let liveStreamText = '';

    const emitChunk = (stream: 'stdout' | 'stderr', chunk: string): void => {
      if (chunk.length === 0) return;
      if (stream === 'stdout') {
        stdoutBuffer.append(chunk);
        liveStreamText += chunk;
        if (tee !== null) {
          const append = (): Promise<void> => tee.writer.teeStream(tee.target, chunk);
          teeChain = teeChain.then(append, append);
        }
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

    const hasSafeCanonicalFileUriShape = (uri: string): boolean => {
      // Require empty authority (`file:///...`) so remote hosts (`file://host/share` -> SMB UNC)
      // and non-canonical `file://localhost/...` URIs never reach `fileURLToPath` or `lstatSync`.
      if (!uri.startsWith('file:///')) return false;
      // Reject ASCII C0 controls (including \t, \r, \n stripped by WHATWG URL), raw space, DEL,
      // query (`?`), fragment (`#`), and backslashes (`\`).
      for (let i = 0; i < uri.length; i += 1) {
        const code = uri.charCodeAt(i);
        if (code <= 0x20 || code === 0x7f) return false;
      }
      if (uri.includes('?') || uri.includes('#') || uri.includes('\\')) return false;
      if (/%00|%2f|%5c/i.test(uri)) return false;
      const rawPathPart = uri.slice('file:///'.length);
      const rawSegments = rawPathPart.split('/');
      for (let i = 0; i < rawSegments.length; i += 1) {
        const seg = rawSegments[i]!;
        if (seg === '.' || seg === '..') return false;
        let decoded: string;
        try {
          decoded = decodeURIComponent(seg);
        } catch {
          return false;
        }
        if (
          decoded === '.' ||
          decoded === '..' ||
          decoded.includes('/') ||
          decoded.includes('\\') ||
          decoded.includes('\0')
        ) {
          return false;
        }
        if (process.platform === 'win32') {
          if (decoded.includes(':') && (i !== 0 || !/^[A-Za-z]:$/.test(decoded))) {
            return false;
          }
          if (/[. ]$/.test(decoded)) {
            return false;
          }
        }
      }
      return true;
    };

    const gate = this.options.authorityGate;
    const verifyResourceLink = (uri: string): boolean | Promise<boolean> => {
      if (!hasSafeCanonicalFileUriShape(uri)) return false;
      let filePath: string;
      try {
        filePath = fileURLToPath(uri);
      } catch {
        return false;
      }
      const liveProtectedPaths = resolveProtectedDatabasePaths(this.options.protectedDatabasePaths);
      if (gate && activeSessionId !== null) {
        // Authorize via gate FIRST using the raw `filePath` so workspace trust, awaited live
        // primacy (14-07), generation, raw + canonical protected-path rules, and execution-root
        // containment are all enforced before any extra filesystem checks.
        return gate
          .authorizeAsync({
            requestKind: 'filesystem',
            acpSessionId: activeSessionId,
            connectionGeneration: generation,
            attemptId,
            mutating: false,
            targetPath: filePath
          })
          .then(
            (decision) => {
              if (!decision.allowed) return false;
              if (liveProtectedPaths.length > 0 && isTargetProtectedPathSync(filePath, liveProtectedPaths)) {
                return false;
              }
              return true;
            },
            () => false
          );
      }
      const canon = canonicalizePathWithTailSync(filePath);
      if (!canon.ok) return false;
      if (
        isWorkspaceProtectedPattern(filePath) ||
        isWorkspaceProtectedPattern(canon.canonical)
      ) {
        return false;
      }
      if (
        liveProtectedPaths.length > 0 &&
        (isTargetProtectedPathSync(filePath, liveProtectedPaths) ||
          isTargetProtectedPathSync(canon.canonical, liveProtectedPaths))
      ) {
        return false;
      }
      const cwdCanon = canonicalizePathWithTailSync(request.cwd);
      if (!cwdCanon.ok) return false;
      const isUnder = (root: string, target: string): boolean => {
        const rel = path.relative(
          normalizeProtectedComparePath(root),
          normalizeProtectedComparePath(target)
        );
        return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
      };
      const lexicalPath = path.resolve(filePath);
      const lexicalWithinCwd =
        isUnder(request.cwd, lexicalPath) || isUnder(cwdCanon.canonical, lexicalPath);
      return lexicalWithinCwd && isUnder(cwdCanon.canonical, canon.canonical);
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
          effectiveFatalSignatures: request.effectiveFatalSignatures,
          liveStreamText
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
        } else if (ownershipShifted) {
          warnings.push('acp-ownership-unverified');
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
            deadlineExceeded = true;
            timedOut = false;
            cancelExecution();
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
        const isSignalAborted = (): boolean => request.cancellationSignal?.aborted === true;
        if (request.onBeforeSpawn !== undefined) await request.onBeforeSpawn({ helperInvocation: request.helperInvocation === true });
        if (this.isClosed()) throw new SpawnRefusedAfterCloseError(label);
        if (killed || isSignalAborted()) { killed = true; exitCode = 130; } else {
        let spawnedPid: number | undefined;
        const opened = await openAcpConnection({
          profile,
          generation,
          launch: (validatedProfile) => {
            const created = this.options.launchTransport
              ? this.options.launchTransport(validatedProfile, request, generation)
              : spawnStdioTransport(launchSpec);
            transport = created;
            spawnedPid = created.pid;
            created.onStderr((chunk) => { resetIdleTimer(); emitChunk('stderr', Buffer.from(chunk).toString('utf8')); });
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
            } else if (observation.kind === 'usage') latestUsage = observation.usage;
          }
        });
        if (!opened.ok) { warnings.push(`acp-open-refused:${opened.refusal}${opened.detail ? `:${opened.detail}` : ''}`); exitCode = 1; } else {
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
            sessionRes = isBridgeProfile
              ? allowLoad && matchedBridgeBinding !== null
                ? await connection.loadSession(matchedBridgeBinding.persistedSessionId, request.cwd, { mayLoad: true, providerSessionId: matchedBridgeBinding.providerSessionId })
                : await connection.newSession(request.cwd)
              : allowLoad && isValidAcpSessionToken(resumeId)
                ? await connection.loadSession(resumeId, request.cwd, { mayLoad: true })
                : await connection.newSession(request.cwd);
          }

          if (sessionRes !== null && !sessionRes.ok) {
            if (sessionRes.reason === 'transport-closed') {
              obsBridge.emitLifecycle({ kind: 'transport-disconnected', reason: 'transport-closed' });
            }
            warnings.push(`acp-session-failed:${sessionRes.reason}`);
            exitCode = 1;
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
              const isKilled = (): boolean => killed;
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

              const outcome = await connection.prompt({
                sessionId: activeSessionId,
                attemptId,
                rootId,
                blocks
              });

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
              if (outcome.kind === 'completed') {
                emitChunk(
                  'stdout',
                  encodeUsageResultLine(this.options.kind, persistedCliSessionId, elapsedMs, latestUsage)
                );
                sawTerminalResult = true;
                acpTurnSettled = request.review === undefined
                  ? outcome.stopReason !== 'refusal'
                  : outcome.stopReason === 'end_turn';
                backgroundWorkOpenAtResult = acpTurnSettled && openWorkTracker.hasOpenWork;
                exitCode = request.review === undefined || acpTurnSettled ? 0 : 1;
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
          }
        }
        }
        }
        }
      }
    } finally {
      if (idleTimer !== null) clearTimeout(idleTimer);
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      request.cancellationSignal?.removeEventListener?.('abort', onAbort);
      for (const encodedLine of streamEncoder.flush()) {
        emitChunk('stdout', encodedLine);
      }
      if (activeSessionId !== null) {
        gate?.revokeSession(activeSessionId, generation);
      }
      await settleTeardown();
      if (tee !== null) {
        await Promise.allSettled([teeChain]);
      }
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

    const teeResult = tee?.writer.result();
    const mergedWarnings = [...(teeResult ? teeResult.warnings : []), ...warnings];

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
      cliSessionId: isBridgeProfile ? persistedCliSessionId : (activeSessionId ?? undefined),
      effectiveFatalSignatures: request.effectiveFatalSignatures,
      liveStreamText
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
      ...(params.acpTurnSettled ? { acpTurnSettled: true } : {}),
      ...(params.backgroundWorkOpenAtResult ? { backgroundWorkOpenAtResult: true } : {}),
      durationMs: Math.max(0, Date.now() - params.startedAtMs),
      ...(params.warnings.length > 0 ? { diagnosticWarnings: params.warnings } : {}),
      ...(params.diagnosticsCaptured ? { diagnosticsCaptured: true } : {}),
      command: params.commandDisplay,
      ...(params.cliSessionId ? { cliSessionId: params.cliSessionId } : {}),
      ...(streamFatalMatch ? { streamFatalMatch } : {})
    };
  }
}
