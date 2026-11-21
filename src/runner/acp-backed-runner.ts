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
import {
  ACP_PROFILE_IDS,
  getBuiltinAcpProfile,
  resolveAcpProfileLaunch,
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
import { AcpOpenWorkTracker } from './acp-open-work-tracker';
import { AcpStreamEncoder } from './acp-stream-encoder';
import { nextInvocationId } from './invocation-identity';
import {
  armedMaxDurationMs,
  type InvocationOutputSink,
  type InvocationRequest,
  type RawInvocationOutput
} from './invocation-result';
import { buildSpawnEnv } from './spawn-env';
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
  /**
   * The platform the profile's qualification is judged against; omitted, this host's. Tests pin it
   * so a qualified turn, or an unqualified refusal, is exercised whatever the host is.
   */
  readonly platform?: AcpProfilePlatform;
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
  return typeof raw === 'string' && raw.length >= 1 && raw.length <= 256 && !/[\r\n\0]/.test(raw);
}

function resolveProtectedDatabasePaths(
  source: AcpBackedRunnerOptions['protectedDatabasePaths']
): readonly string[] {
  if (source === undefined) return [];
  return typeof source === 'function' ? source() : source;
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
  private readonly sessionRoots = new Map<string, string>();
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
    if (request.review === undefined && request.legacyDrain === true && this.options.allowLegacyDrain !== false) {
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

    const profile = getBuiltinAcpProfile(this.options.kind, {
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(this.options.platform !== undefined ? { platform: this.options.platform } : {})
    });
    const generation = ++nextAcpGeneration;
    const label = getBackendDescriptor(this.options.kind).runnerLabel;
    const invocationId = nextInvocationId(label);
    const runId = request.runId ?? null;
    const attemptId = sanitizeHostToken(request.attemptId, sanitizeHostToken(invocationId, `attempt-${generation}`));
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
    const verifyResourceLink = (uri: string): boolean => {
      if (!hasSafeCanonicalFileUriShape(uri)) return false;
      let filePath: string;
      try {
        filePath = fileURLToPath(uri);
      } catch {
        return false;
      }
      const liveProtectedPaths = resolveProtectedDatabasePaths(this.options.protectedDatabasePaths);
      if (gate && activeSessionId !== null) {
        // Authorize via gate FIRST using the raw `filePath` so workspace trust, primacy,
        // generation, raw + canonical protected-path rules, and execution-root containment
        // are all enforced before any extra filesystem checks.
        const decision = gate.authorize({
          requestKind: 'filesystem',
          acpSessionId: activeSessionId,
          connectionGeneration: generation,
          mutating: false,
          targetPath: filePath
        });
        if (!decision.allowed) return false;
        if (liveProtectedPaths.length > 0 && isTargetProtectedPathSync(filePath, liveProtectedPaths)) {
          return false;
        }
        return true;
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

      if (tee !== null) {
        await tee.writer.prepare(tee.target);
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

      const env = buildSpawnEnv(request);
      const spawnEnv = request.review === undefined ? env : { ...buildLaneGitEnv(env), GIT_OPTIONAL_LOCKS: '0' };
      const launchSpec = resolveAcpProfileLaunch({
        kind: this.options.kind,
        resolvedCliPath: request.cliPath,
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
        ...(gate !== undefined ? { permissionPolicy: gate.createPermissionPolicy(generation) } : {}),
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
          if (observation.kind === 'display') {
            openWorkTracker.observe(observation.event);
            for (const encodedLine of streamEncoder.push(observation.event)) {
              emitChunk('stdout', encodedLine);
            }
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
        const normalizedCwd = path.resolve(request.cwd);
        const resumeId = request.resumeSessionId;
        const priorSessionRoot = isValidAcpSessionToken(resumeId)
          ? this.sessionRoots.get(resumeId)
          : undefined;
        const rootMismatchOnResume =
          priorSessionRoot !== undefined && priorSessionRoot !== normalizedCwd;
        if (rootMismatchOnResume) {
          // F10-FR-19: session reuse/load cannot retain a prior lane's cwd or grants; open a fresh session.
          warnings.push('acp-session-rebind-fresh-root');
        }
        // BUG-001 (FR-008): load ACP-owned sessions tracked in `sessionRoots` even when
        // `resumeSessionOrigin` is omitted by standalone continuations, while still refusing
        // `'legacy-cli'` and unknown pre-cutover IDs (`F13-FR-21`) and cross-lane roots (`F10-FR-19`).
        const canLoadResumeSession =
          !rootMismatchOnResume &&
          (request.isContinue === true || request.sessionReuse === true) &&
          (request.resumeSessionOrigin === 'acp' ||
            (request.resumeSessionOrigin === undefined && priorSessionRoot !== undefined));
        const sessionRes =
          canLoadResumeSession && isValidAcpSessionToken(resumeId)
            ? await connection.loadSession(resumeId, request.cwd, { mayLoad: true })
            : await connection.newSession(request.cwd);

        if (!sessionRes.ok) {
          warnings.push(`acp-session-failed:${sessionRes.reason}`);
          exitCode = 1;
        } else {
          activeSessionId = sessionRes.sessionId;
          if (!this.sessionRoots.has(activeSessionId) && this.sessionRoots.size >= 512) {
            const oldestKey = this.sessionRoots.keys().next().value;
            if (oldestKey !== undefined) this.sessionRoots.delete(oldestKey);
          }
          this.sessionRoots.set(activeSessionId, normalizedCwd);

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
          } else if (this.options.primeAuthority !== undefined && !(await this.options.primeAuthority())) {
            warnings.push('acp-ownership-unverified');
            exitCode = 1;
          } else {
            gate?.registerScope({
              attemptId,
              profileId: profile.profileId,
              acpSessionId: activeSessionId,
              connectionGeneration: generation,
              ownershipGeneration: this.options.currentOwnershipGeneration?.() ?? 1,
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
            if (outcome.kind === 'completed') {
              emitChunk('stdout', encodeUsageResultLine(this.options.kind, activeSessionId, elapsedMs, latestUsage));
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
    } finally {
      if (idleTimer !== null) clearTimeout(idleTimer);
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      request.cancellationSignal?.removeEventListener?.('abort', onAbort);
      for (const encodedLine of streamEncoder.flush()) {
        emitChunk('stdout', encodedLine);
      }
      if (activeSessionId !== null) {
        gate?.revokeSession(activeSessionId);
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
