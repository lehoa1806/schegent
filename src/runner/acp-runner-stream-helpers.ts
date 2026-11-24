/**
 * FR-R8-02 (02-01, 02-03) — cohesive stream-encoding, URI validation, and backpressure/bounded-tee
 * helpers extracted from `acp-backed-runner.ts` so the runner stays concise and each bound is
 * independently testable. Zero `vscode` or `child_process` imports.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACP_MAX_VERBOSE_TEE_PENDING_BYTES,
  type AcpBillableTokens,
  type AcpPromptOutcome
} from '../contracts/acp-runtime';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import { MONITOR_STALL_THRESHOLD_MS } from '../contracts/monitor-events';
import {
  canonicalizePathWithTailSync,
  isTargetProtectedPathSync,
  isWorkspaceProtectedPattern,
  normalizeProtectedComparePath
} from '../lib/protected-path-match';
import type { AcpAuthorityGate } from '../services/containment-qualification/acp-authority-gate';
import {
  classifyBridgeErrorStatus,
  warningCodeForReconciliation,
  type AcpTerminalReconciliation
} from '../services/acp-runtime/terminal-reconciliation';
import type { AcpStdioTransport } from '../services/acp-runtime/stdio-transport';
import type { VerboseDiagnosticWriter } from '../audit/verbose-diagnostic-writer';
import type { InvocationOutputSink, VerboseDiagnosticTarget } from './invocation-result';

export function hasSafeCanonicalFileUriShape(uri: string): boolean {
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
}

export function verifyAcpResourceLink(params: {
  readonly uri: string;
  readonly cwd: string;
  readonly gate: AcpAuthorityGate | undefined;
  readonly activeSessionId: string | null;
  readonly generation: number;
  readonly attemptId: string;
  readonly liveProtectedPaths: readonly string[];
}): boolean | Promise<boolean> {
  const { uri, cwd, gate, activeSessionId, generation, attemptId, liveProtectedPaths } = params;
  if (!hasSafeCanonicalFileUriShape(uri)) return false;
  let filePath: string;
  try {
    filePath = fileURLToPath(uri);
  } catch {
    return false;
  }
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
  if (isWorkspaceProtectedPattern(filePath) || isWorkspaceProtectedPattern(canon.canonical)) {
    return false;
  }
  if (
    liveProtectedPaths.length > 0 &&
    (isTargetProtectedPathSync(filePath, liveProtectedPaths) ||
      isTargetProtectedPathSync(canon.canonical, liveProtectedPaths))
  ) {
    return false;
  }
  const cwdCanon = canonicalizePathWithTailSync(cwd);
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
    isUnder(cwd, lexicalPath) || isUnder(cwdCanon.canonical, lexicalPath);
  return lexicalWithinCwd && isUnder(cwdCanon.canonical, canon.canonical);
}

export function buildEncodedUsageObject(
  kind: BackendRunnerKind,
  billableTokens: AcpBillableTokens | null
): Record<string, number> | undefined {
  if (billableTokens === null) return undefined;
  const out: Record<string, number> = {};
  if (billableTokens.inputTokens !== undefined) out['input_tokens'] = billableTokens.inputTokens;
  if (billableTokens.outputTokens !== undefined) out['output_tokens'] = billableTokens.outputTokens;
  if (kind === 'claude') {
    if (billableTokens.cacheCreationInputTokens !== undefined) {
      out['cache_creation_input_tokens'] = billableTokens.cacheCreationInputTokens;
    }
    if (billableTokens.cacheReadInputTokens !== undefined) {
      out['cache_read_input_tokens'] = billableTokens.cacheReadInputTokens;
    }
  } else if (kind === 'codex') {
    if (billableTokens.cacheCreationInputTokens !== undefined) {
      out['cache_write_input_tokens'] = billableTokens.cacheCreationInputTokens;
    }
    if (billableTokens.cacheReadInputTokens !== undefined) {
      out['cached_input_tokens'] = billableTokens.cacheReadInputTokens;
    }
  } else if (billableTokens.cacheReadInputTokens !== undefined) {
    out['cache_read_tokens'] = billableTokens.cacheReadInputTokens;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function encodeUsageResultLine(
  kind: BackendRunnerKind,
  sessionId: string | undefined,
  durationMs: number,
  billableTokens: AcpBillableTokens | null,
  claudeCostUsd: number | undefined
): string {
  // FR-R8-02 (02-01) & F06-FR-23: ACP `used`/`size` are context occupancy, never billable tokens.
  // Only genuinely measured billable counters and validated USD cost are emitted; absent or
  // context-only usage omits the keys so spend bounds and accounting stay unmeasurable rather
  // than fabricating synthetic zeroes.
  const usageObj = buildEncodedUsageObject(kind, billableTokens);
  if (kind === 'codex') {
    return `${JSON.stringify({
      type: 'turn.completed',
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      ...(usageObj !== undefined ? { usage: usageObj } : {})
    })}\n`;
  }
  if (kind === 'agy') {
    return `${JSON.stringify({
      event: 'result',
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      result: {
        duration_seconds: Math.max(0, durationMs / 1_000),
        num_turns: 1,
        ...(usageObj !== undefined ? { usage: usageObj } : {})
      }
    })}\n`;
  }
  const row: Record<string, unknown> = {
    type: 'result',
    subtype: 'success',
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    duration_ms: Math.max(0, Math.round(durationMs)),
    num_turns: 1,
    ...(usageObj !== undefined ? { usage: usageObj } : {})
  };
  if (claudeCostUsd !== undefined && Number.isFinite(claudeCostUsd) && claudeCostUsd >= 0) {
    row.total_cost_usd = claudeCostUsd;
  }
  return `${JSON.stringify(row)}\n`;
}

export const ACP_VERBOSE_TEE_CANCEL_DRAIN_MS = 2_000;
/** Hard Rule 20: derived from `MONITOR_STALL_THRESHOLD_MS` so stall reporting always fires before watchdog kill. */
export const ACP_MIN_SINK_STALL_WATCHDOG_MS = MONITOR_STALL_THRESHOLD_MS * 2;
export const SCANNER_SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const MAX_BILLABLE_COST_USD = 1e12;

function addCappedTokens(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, (a ?? 0) + (b ?? 0));
}

function keepMonotonicMax(prev: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined) return prev;
  return prev === undefined ? next : Math.max(prev, next);
}

/**
 * Merges a live `usage` observation into invocation-level billable counters.
 * - For `claude`, per-turn billable tokens are summed across multiple observations while
 *   cumulative session cost is strictly monotonic non-decreasing (`<= 1e12`).
 * - For `codex`/`agy`, trailing zero counters never overwrite previously observed positive counts.
 */
export function mergeLiveUsageObservation(params: {
  readonly kind: BackendRunnerKind;
  readonly currentTokens: AcpBillableTokens | null;
  readonly currentClaudeCostUsd: number | undefined;
  readonly observedTokens: AcpBillableTokens | undefined;
  readonly observedCost: { readonly amount: string; readonly currency?: string } | undefined;
}): {
  readonly billableTokens: AcpBillableTokens | null;
  readonly claudeCostUsd: number | undefined;
} {
  let billableTokens = params.currentTokens;
  const obs = params.observedTokens;
  if (obs !== undefined) {
    if (params.kind === 'claude') {
      const prev = billableTokens;
      const inputTokens = addCappedTokens(prev?.inputTokens, obs.inputTokens);
      const outputTokens = addCappedTokens(prev?.outputTokens, obs.outputTokens);
      const cacheCreationInputTokens = addCappedTokens(
        prev?.cacheCreationInputTokens,
        obs.cacheCreationInputTokens
      );
      const cacheReadInputTokens = addCappedTokens(
        prev?.cacheReadInputTokens,
        obs.cacheReadInputTokens
      );
      billableTokens = {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
        ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {})
      };
    } else if (billableTokens === null) {
      billableTokens = obs;
    } else {
      const inputTokens = keepMonotonicMax(billableTokens.inputTokens, obs.inputTokens);
      const outputTokens = keepMonotonicMax(billableTokens.outputTokens, obs.outputTokens);
      const cacheCreationInputTokens = keepMonotonicMax(
        billableTokens.cacheCreationInputTokens,
        obs.cacheCreationInputTokens
      );
      const cacheReadInputTokens = keepMonotonicMax(
        billableTokens.cacheReadInputTokens,
        obs.cacheReadInputTokens
      );
      billableTokens = {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
        ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {})
      };
    }
  }
  let claudeCostUsd = params.currentClaudeCostUsd;
  if (params.kind === 'claude' && params.observedCost?.currency === 'USD') {
    const parsedCost = Number(params.observedCost.amount);
    if (Number.isFinite(parsedCost) && parsedCost >= 0 && parsedCost <= MAX_BILLABLE_COST_USD) {
      claudeCostUsd = claudeCostUsd === undefined ? parsedCost : Math.max(claudeCostUsd, parsedCost);
    }
  }
  return { billableTokens, claudeCostUsd };
}

export interface AcpVerboseTeeHandle {
  readonly target: VerboseDiagnosticTarget;
  readonly writer: VerboseDiagnosticWriter;
}

/**
 * Coordinates host-side output-sink backpressure (`pauseStdout`/`resumeStdout`, `pauseStderr`/
 * `resumeStderr`), optional sink-stall fallback timeout, and the bounded coalescing verbose
 * diagnostic tee queue (`ACP_MAX_VERBOSE_TEE_PENDING_BYTES`) without deadlocking on cancel/close.
 */
export class AcpStreamBackpressureController {
  private readonly backpressuredStreams = new Set<'stdout' | 'stderr'>();
  private readonly pendingSinkStreamBytes: Record<'stdout' | 'stderr', number> = {
    stdout: 0,
    stderr: 0
  };
  private pendingTeeBytes = 0;
  private verboseTeeOverflowWarned = false;
  private highWaterBytes = 0;
  private readonly teeQueue: { readonly text: string; readonly bytes: number }[] = [];
  private teeDrainPromise: Promise<void> | null = null;
  private sinkStallTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    private readonly outputSink: InvocationOutputSink | undefined,
    private readonly tee: AcpVerboseTeeHandle | null,
    private readonly getTransport: () => AcpStdioTransport | null,
    private readonly onWarning: (warning: string) => void,
    private readonly onSuspendIdleTimer: () => void,
    private readonly onResumeIdleTimer: () => void,
    private readonly isTerminating: () => boolean,
    private readonly sinkStallWatchdog?: {
      readonly timeoutMs: number;
      readonly onStall: () => void;
    }
  ) {}

  public get isBackpressured(): boolean {
    return this.backpressuredStreams.size > 0;
  }

  public get streamPendingHighWaterBytes(): number {
    return this.highWaterBytes;
  }

  private notePendingBytes(): void {
    const total =
      this.pendingSinkStreamBytes.stdout +
      this.pendingSinkStreamBytes.stderr +
      this.pendingTeeBytes;
    if (total > this.highWaterBytes) {
      this.highWaterBytes = total;
    }
  }

  private armSinkStallTimer(): void {
    if (this.sinkStallWatchdog === undefined || this.sinkStallTimer !== null) return;
    this.sinkStallTimer = setTimeout(() => {
      this.sinkStallTimer = null;
      if (this.backpressuredStreams.size > 0 && !this.isTerminating()) {
        this.sinkStallWatchdog?.onStall();
      }
    }, this.sinkStallWatchdog.timeoutMs);
    this.sinkStallTimer.unref();
  }

  private clearSinkStallTimer(): void {
    if (this.sinkStallTimer !== null) {
      clearTimeout(this.sinkStallTimer);
      this.sinkStallTimer = null;
    }
  }

  public enqueueVerboseTee(chunk: string, chunkBytes: number): void {
    if (this.tee === null) return;
    if (this.pendingTeeBytes + chunkBytes > ACP_MAX_VERBOSE_TEE_PENDING_BYTES) {
      if (!this.verboseTeeOverflowWarned) {
        this.verboseTeeOverflowWarned = true;
        this.onWarning('acp-verbose-tee-overflow');
      }
      return;
    }
    this.pendingTeeBytes += chunkBytes;
    this.notePendingBytes();
    this.teeQueue.push({ text: chunk, bytes: chunkBytes });
    if (this.teeDrainPromise === null) {
      this.teeDrainPromise = this.flushTeeQueue().finally(() => {
        this.teeDrainPromise = null;
      });
    }
  }

  private async flushTeeQueue(): Promise<void> {
    const tee = this.tee;
    if (tee === null) return;
    while (this.teeQueue.length > 0) {
      const batch = this.teeQueue.splice(0, this.teeQueue.length);
      let combined = '';
      let batchBytes = 0;
      for (const item of batch) {
        combined += item.text;
        batchBytes += item.bytes;
      }
      try {
        await tee.writer.teeStream(tee.target, combined);
      } catch {
        /* tee errors are reported through VerboseDiagnosticWriter warnings */
      } finally {
        this.pendingTeeBytes = Math.max(0, this.pendingTeeBytes - batchBytes);
      }
    }
  }

  public writeToSink(stream: 'stdout' | 'stderr', chunk: string, chunkBytes: number): void {
    if (this.outputSink === undefined) return;
    let ok = true;
    try {
      ok = this.outputSink.write(stream, chunk);
    } catch {
      ok = true;
    }
    if (ok || this.isTerminating()) return;
    this.pendingSinkStreamBytes[stream] += chunkBytes;
    this.notePendingBytes();
    if (this.backpressuredStreams.has(stream)) return;
    const wasUnblocked = this.backpressuredStreams.size === 0;
    this.backpressuredStreams.add(stream);
    const transport = this.getTransport();
    if (stream === 'stdout') transport?.pauseStdout?.();
    else transport?.pauseStderr?.();
    if (wasUnblocked) {
      this.onSuspendIdleTimer();
      this.armSinkStallTimer();
    }
    try {
      this.outputSink.onceDrain(stream, () => {
        if (!this.backpressuredStreams.delete(stream)) return;
        this.pendingSinkStreamBytes[stream] = 0;
        const activeTransport = this.getTransport();
        if (stream === 'stdout') activeTransport?.resumeStdout?.();
        else activeTransport?.resumeStderr?.();
        if (this.backpressuredStreams.size === 0) {
          this.clearSinkStallTimer();
          if (!this.isTerminating()) {
            this.onResumeIdleTimer();
          }
        }
      });
    } catch {
      this.backpressuredStreams.delete(stream);
      this.pendingSinkStreamBytes[stream] = 0;
      const activeTransport = this.getTransport();
      if (stream === 'stdout') activeTransport?.resumeStdout?.();
      else activeTransport?.resumeStderr?.();
      if (this.backpressuredStreams.size === 0) {
        this.clearSinkStallTimer();
        if (!this.isTerminating()) {
          this.onResumeIdleTimer();
        }
      }
    }
  }

  public releaseAll(): void {
    this.clearSinkStallTimer();
    const transport = this.getTransport();
    if (this.backpressuredStreams.has('stdout')) {
      this.backpressuredStreams.delete('stdout');
      this.pendingSinkStreamBytes.stdout = 0;
      transport?.resumeStdout?.();
    }
    if (this.backpressuredStreams.has('stderr')) {
      this.backpressuredStreams.delete('stderr');
      this.pendingSinkStreamBytes.stderr = 0;
      transport?.resumeStderr?.();
    }
  }

  public async drainVerboseTee(timeoutMs?: number): Promise<void> {
    const active = this.teeDrainPromise;
    if (this.tee === null || active === null) return;
    if (timeoutMs === undefined || timeoutMs <= 0) {
      await Promise.allSettled([active]);
      return;
    }
    let resolveTimeout: () => void = () => undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      resolveTimeout = resolve;
    });
    const timer = setTimeout(resolveTimeout, timeoutMs);
    timer.unref();
    try {
      await Promise.race([Promise.allSettled([active]), timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface ReconciledAcpPromptOutcome {
  readonly emitUsageLine: boolean;
  readonly sawTerminalResult: boolean;
  readonly acpTurnSettled: boolean;
  readonly backgroundWorkOpenAtResult: boolean;
  readonly markKilled: boolean;
  readonly exitCode: number;
  readonly warnings: readonly string[];
  readonly terminalReconciliation: AcpTerminalReconciliation;
}

/** Maps one `AcpPromptOutcome` into runner exit, settle flags, warnings, and reconciliation status. */
export function reconcileAcpPromptOutcome(params: {
  readonly outcome: AcpPromptOutcome;
  readonly isNativeReview: boolean;
  readonly isBridgeProfile: boolean;
  readonly hasOpenWork: boolean;
  readonly killed: boolean;
  readonly timedOut: boolean;
  readonly deadlineExceeded: boolean;
}): ReconciledAcpPromptOutcome {
  const { outcome, isNativeReview, isBridgeProfile, hasOpenWork, killed, timedOut, deadlineExceeded } = params;
  if (outcome.kind === 'completed') {
    if (outcome.stopReason === 'refusal') {
      return {
        emitUsageLine: true,
        sawTerminalResult: true,
        acpTurnSettled: false,
        backgroundWorkOpenAtResult: false,
        markKilled: false,
        exitCode: 1,
        warnings: ['acp-turn-refusal'],
        terminalReconciliation: {
          status: 'refusal',
          stopReason: 'refusal',
          warningCode: 'acp-turn-refusal'
        }
      };
    }
    const settled = !isNativeReview ? true : outcome.stopReason === 'end_turn';
    return {
      emitUsageLine: true,
      sawTerminalResult: true,
      acpTurnSettled: settled,
      backgroundWorkOpenAtResult: settled && hasOpenWork,
      markKilled: false,
      exitCode: !isNativeReview || settled ? 0 : 1,
      warnings: [],
      terminalReconciliation: settled
        ? { status: 'clean', stopReason: outcome.stopReason }
        : {
            status: 'backend-reported-error',
            stopReason: outcome.stopReason,
            warningCode: 'acp-terminal-reconciliation-failed'
          }
    };
  }
  if (outcome.kind === 'cancelled') {
    if (!killed && (timedOut || deadlineExceeded)) {
      return {
        emitUsageLine: false,
        sawTerminalResult: false,
        acpTurnSettled: false,
        backgroundWorkOpenAtResult: false,
        markKilled: false,
        exitCode: 130,
        warnings: [],
        terminalReconciliation: {
          status: 'missing-terminal-record',
          warningCode: 'acp-missing-terminal-record'
        }
      };
    }
    return {
      emitUsageLine: false,
      sawTerminalResult: false,
      acpTurnSettled: false,
      backgroundWorkOpenAtResult: false,
      markKilled: true,
      exitCode: 130,
      warnings: [],
      terminalReconciliation: { status: 'cancelled', stopReason: 'cancelled' }
    };
  }
  if (outcome.kind === 'uncertain') {
    return {
      emitUsageLine: false,
      sawTerminalResult: false,
      acpTurnSettled: false,
      backgroundWorkOpenAtResult: false,
      markKilled: false,
      exitCode: 1,
      warnings: ['acp-turn-uncertain', `acp-turn-uncertain:${outcome.reason}`],
      terminalReconciliation: { status: 'uncertain', warningCode: 'acp-turn-uncertain' }
    };
  }
  if (outcome.kind === 'refused') {
    if (
      killed &&
      !timedOut &&
      !deadlineExceeded &&
      outcome.reason === 'connection-not-ready' &&
      outcome.detail === 'cancelled'
    ) {
      return {
        emitUsageLine: false,
        sawTerminalResult: false,
        acpTurnSettled: false,
        backgroundWorkOpenAtResult: false,
        markKilled: true,
        exitCode: 130,
        warnings: [],
        terminalReconciliation: { status: 'cancelled', stopReason: 'cancelled' }
      };
    }
    return {
      emitUsageLine: false,
      sawTerminalResult: false,
      acpTurnSettled: false,
      backgroundWorkOpenAtResult: false,
      markKilled: false,
      exitCode: 1,
      warnings: [`acp-prompt-refused:${outcome.reason}${outcome.detail ? `:${outcome.detail}` : ''}`],
      terminalReconciliation: {
        status: 'refused',
        warningCode: 'acp-terminal-reconciliation-failed'
      }
    };
  }
  if (outcome.kind === 'rejected') {
    const recStatus = isBridgeProfile ? classifyBridgeErrorStatus(outcome.detail) : 'rejected';
    const recWarning = warningCodeForReconciliation(recStatus);
    return {
      emitUsageLine: false,
      sawTerminalResult: false,
      acpTurnSettled: false,
      backgroundWorkOpenAtResult: false,
      markKilled: false,
      exitCode: 1,
      warnings: [recWarning, `acp-prompt-rejected:${outcome.code}`],
      terminalReconciliation: { status: recStatus, warningCode: recWarning }
    };
  }
  if (killed && !timedOut && !deadlineExceeded) {
    return {
      emitUsageLine: false,
      sawTerminalResult: false,
      acpTurnSettled: false,
      backgroundWorkOpenAtResult: false,
      markKilled: true,
      exitCode: 130,
      warnings: [],
      terminalReconciliation: { status: 'cancelled', stopReason: 'cancelled' }
    };
  }
  return {
    emitUsageLine: false,
    sawTerminalResult: false,
    acpTurnSettled: false,
    backgroundWorkOpenAtResult: false,
    markKilled: false,
    exitCode: 1,
    warnings: [`acp-prompt-not-dispatched:${outcome.reason}`],
    terminalReconciliation: {
      status: 'not-dispatched',
      warningCode: 'acp-terminal-reconciliation-failed'
    }
  };
}
