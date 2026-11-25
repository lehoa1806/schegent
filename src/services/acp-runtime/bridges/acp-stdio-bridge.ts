/**
 * FR-R6-F13 (F13-B; FR-001, FR-002, FR-003, FR-005, FR-008, FR-011, FR-017, FR-019) — maintained
 * ACP v1 stdio bridge fronting `claude` (`-p --output-format stream-json --verbose`) and `codex`
 * (`exec --json ... -` / `exec resume --json <id> ... -`).
 *
 * Design invariants:
 * - Speaks standard ACP protocol version 1 UTF-8 JSON-RPC 2.0 over newline-delimited stdio.
 * - Reserves stdout exclusively for framed JSON-RPC messages; child diagnostics go to bridge stderr.
 * - Keeps ACP `sessionId` distinct from underlying CLI `providerSessionId` (F13-FR-03).
 * - Advertises only verified capabilities (`loadSession: true`, `embeddedContext: true`,
 *   `image: false`, `audio: false`).
 * - Zero `vscode` imports and zero direct `child_process` imports (spawns via `stdio-transport`).
 */
import * as path from 'node:path';

import {
  ACP_MAX_BRIDGE_PENDING_STDOUT_BYTES,
  ACP_MAX_CLI_LINE_BYTES,
  ACP_PROTOCOL_VERSION,
  ACP_RUNTIME_LIMITS
} from '../../../contracts/acp-runtime';
import { getBackendDescriptor } from '../../../contracts/backend-descriptors';
import { isNativeReviewKind, type NativeReviewKind } from '../../../contracts/process-definitions';
import {
  codexSecurityLaunch, isReviewCommit, isReviewExclusion, summarizeSecurityScan, type NativeReviewInvocation
} from '../../../runner/native-review-launch';
import { isAgentIdentifier, isSafeProviderSessionId } from '../agent-identifier';
import { BridgeByteFramer } from '../bridge-byte-framer';
import {
  MAX_TRACKED_TERMINAL_EVENTS,
  SHA256_HEX_RE,
  boundRawInputForFrame,
  canonicalizeBridgeCwd,
  chunkTextForFrame,
  formatBridgeCostAmount,
  isNonEmptyString,
  isRecord,
  isValidBridgeProviderSessionId,
  parseStrictBillableTokens,
  renderPromptBlocks,
  safeUsedTokens,
  truncateErrorMessage,
  truncateTextForJsonFrame
} from './acp-stdio-bridge-helpers';
import {
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  classifyMessage,
  errorLine,
  notificationLine,
  resultLine,
  type RpcId
} from '../json-rpc-message';
import {
  spawnManagedCliChild,
  type ManagedCliChild,
  type StdioLaunch
} from '../stdio-transport';
import {
  formatBridgeErrorMessage,
  reconcileBridgeTurnOutcome,
  rpcCodeForBridgeErrorStatus,
  type BridgeStopReason,
  type BridgeTerminalEvent
} from '../terminal-reconciliation';

export type BridgedBackendKind = 'claude' | 'codex';

export const ACP_STDIO_BRIDGE_VERSION = '1.0.0';

export interface AcpBridgeLaunchConfig {
  readonly backend: BridgedBackendKind;
  readonly cliPath: string;
  readonly permissionFlags: readonly string[];
  readonly model?: string;
  readonly effort?: string;
  readonly nativeReview?: NativeReviewInvocation;
  readonly env: NodeJS.ProcessEnv;
  readonly spawnChild?: (input: StdioLaunch) => ManagedCliChild;
}

export interface BridgeIoStreams {
  onStdin(listener: (chunk: Uint8Array) => void): void;
  onStdinClose(listener: () => void): void;
  writeStdout(line: string): boolean | void;
  onStdoutDrain?(listener: () => void): void;
  stdoutWritableLength?(): number;
  writeStderr(text: string): boolean | void;
  onStderrDrain?(listener: () => void): void;
  stderrWritableLength?(): number;
}

export interface BridgeServerHandle {
  close(): Promise<void>;
}

interface BridgeSession {
  readonly acpSessionId: string;
  cwd: string;
  providerSessionId: string | null;
  activeTurn: ActiveBridgeTurn | null;
}

interface ActiveBridgeTurn {
  readonly rpcId: RpcId;
  readonly child: ManagedCliChild;
  cancelled: boolean;
}

const RPC_INTERNAL_ERROR = -32000;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const MAX_CLI_LINE_BYTES = ACP_MAX_CLI_LINE_BYTES;

function buildCliArgs(config: AcpBridgeLaunchConfig, providerSessionId: string | null): string[] {
  if (providerSessionId !== null && !isSafeProviderSessionId(providerSessionId)) {
    throw new Error('ACP_BRIDGE_INVALID_PROVIDER_SESSION_ID');
  }
  if (config.backend === 'claude') {
    const args: string[] = [...config.permissionFlags];
    if (providerSessionId !== null) args.push('--resume', providerSessionId);
    args.push('-p');
    if (isNonEmptyString(config.model)) args.push('--model', config.model);
    if (isNonEmptyString(config.effort)) args.push('--effort', config.effort);
    args.push('--output-format', 'stream-json', '--verbose');
    return args;
  }
  const args: string[] =
    providerSessionId !== null
      ? ['exec', 'resume', '--json', ...config.permissionFlags, providerSessionId]
      : [
          'exec', '--json',
          ...(config.nativeReview?.kind === 'code' ? ['--sandbox', 'read-only'] : config.permissionFlags)
        ];
  if (isNonEmptyString(config.model)) args.push('--model', config.model);
  if (isNonEmptyString(config.effort)) args.push('--config', `model_reasoning_effort=${config.effort}`);
  if (config.nativeReview?.kind === 'code') args.push('review');
  args.push('-');
  return args;
}

export function parseBridgeCliArgv(
  argv: readonly string[],
  env: NodeJS.ProcessEnv
): AcpBridgeLaunchConfig | null {
  let backend: BridgedBackendKind | null = null;
  let cliPath: string | null = null;
  let model: string | undefined;
  let effort: string | undefined;
  let nativeReview: NativeReviewKind | undefined;
  let mergeBase: string | undefined;
  let scannerCliPath: string | undefined;
  let scannerSha256: string | undefined;
  const excludedPaths: string[] = [];
  const permissionFlags: string[] = [];

  for (let idx = 0; idx < argv.length; idx += 1) {
    const flag = argv[idx];
    const next = argv.at(idx + 1);
    if (flag === '--backend' && (next === 'claude' || next === 'codex')) {
      backend = next;
      idx += 1;
    } else if (flag === '--cli' && isNonEmptyString(next)) {
      cliPath = next;
      idx += 1;
    } else if (flag === '--permission-flag' && typeof next === 'string' && next.length > 0) {
      permissionFlags.push(next);
      idx += 1;
    } else if (flag === '--model' && isNonEmptyString(next)) {
      model = next;
      idx += 1;
    } else if (flag === '--effort' && isNonEmptyString(next)) {
      effort = next;
      idx += 1;
    } else if (flag === '--native-review' && nativeReview === undefined && isNativeReviewKind(next)) {
      nativeReview = next;
      idx += 1;
    } else if (flag === '--review-base' && mergeBase === undefined && isReviewCommit(next)) {
      mergeBase = next;
      idx += 1;
    } else if (
      flag === '--scanner-cli' &&
      scannerCliPath === undefined &&
      isNonEmptyString(next) &&
      path.isAbsolute(next) &&
      !next.includes('\0')
    ) {
      scannerCliPath = next;
      idx += 1;
    } else if (
      flag === '--scanner-sha256' &&
      scannerSha256 === undefined &&
      typeof next === 'string' &&
      SHA256_HEX_RE.test(next)
    ) {
      scannerSha256 = next;
      idx += 1;
    } else if (flag === '--review-exclude' && next !== undefined && isReviewExclusion(next)) {
      excludedPaths.push(next);
      idx += 1;
    } else {
      return null;
    }
  }
  if (backend === null || cliPath === null) return null;
  if ((nativeReview === undefined) !== (mergeBase === undefined)) return null;
  if (excludedPaths.length > 0 && (backend !== 'codex' || nativeReview !== 'security')) return null;
  if (
    (scannerCliPath !== undefined || scannerSha256 !== undefined) &&
    (backend !== 'codex' || nativeReview !== 'security')
  ) {
    return null;
  }
  if (
    backend === 'codex' &&
    nativeReview === 'security' &&
    (scannerCliPath === undefined || scannerSha256 === undefined)
  ) {
    return null;
  }
  return {
    backend,
    cliPath,
    permissionFlags,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(nativeReview !== undefined && mergeBase !== undefined
      ? {
          nativeReview: {
            kind: nativeReview,
            mergeBase,
            ...(scannerCliPath !== undefined ? { resolvedScannerPath: scannerCliPath } : {}),
            ...(scannerSha256 !== undefined ? { resolvedScannerSha256: scannerSha256 } : {}),
            ...(excludedPaths.length > 0 ? { excludedPaths } : {})
          }
        }
      : {}),
    env
  };
}

export function startAcpStdioBridgeServer(
  config: AcpBridgeLaunchConfig,
  io: BridgeIoStreams
): BridgeServerHandle {
  const spawnChild = config.spawnChild ?? spawnManagedCliChild;
  const sessions = new Map<string, BridgeSession>();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let pendingStdin = '';
  let initialized = false;
  let closing = false;
  let nextSessionSeq = 1;
  let toolFallbackSeq = 1;

  let stdoutBackpressured = false;
  let drainRegistered = false;
  let estimatedPendingStdoutBytes = 0;
  const pausedChildren = new Set<ManagedCliChild>();

  let stderrDrainRegistered = false;
  let estimatedPendingStderrBytes = 0;
  const pausedStderrChildren = new Set<ManagedCliChild>();

  const resumePausedChildren = (): void => {
    stdoutBackpressured = false;
    drainRegistered = false;
    estimatedPendingStdoutBytes = 0;
    for (const child of pausedChildren) {
      child.resumeStdout?.();
    }
    pausedChildren.clear();
  };

  const resumePausedStderrChildren = (): void => {
    stderrDrainRegistered = false;
    estimatedPendingStderrBytes = 0;
    for (const child of pausedStderrChildren) {
      child.resumeStderr?.();
    }
    pausedStderrChildren.clear();
  };

  const writeBridgeStderr = (text: string, activeChild?: ManagedCliChild): void => {
    if (closing || text.length === 0) return;
    const textBytes = Buffer.byteLength(text, 'utf8');
    const currentPending = io.stderrWritableLength?.() ?? estimatedPendingStderrBytes;
    if (currentPending + textBytes > ACP_MAX_BRIDGE_PENDING_STDOUT_BYTES) {
      // Only pause & await `drain` when stderr actually has pending buffered bytes; dropping a
      // single oversized chunk at `currentPending === 0` must not deadlock waiting for a drain
      // event that will never fire.
      if (currentPending > 0) {
        if (activeChild !== undefined) {
          activeChild.pauseStderr?.();
          pausedStderrChildren.add(activeChild);
        }
        if (!stderrDrainRegistered && io.onStderrDrain !== undefined) {
          stderrDrainRegistered = true;
          io.onStderrDrain(() => resumePausedStderrChildren());
        }
      }
      return;
    }
    const accepted = io.writeStderr(text);
    if (accepted === false) {
      estimatedPendingStderrBytes += textBytes;
      if (activeChild !== undefined) {
        activeChild.pauseStderr?.();
        pausedStderrChildren.add(activeChild);
      }
      if (!stderrDrainRegistered && io.onStderrDrain !== undefined) {
        stderrDrainRegistered = true;
        io.onStderrDrain(() => resumePausedStderrChildren());
      }
    }
  };

  const sendFramedLine = (line: string, activeChild?: ManagedCliChild): boolean => {
    if (closing) return true;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const accepted = io.writeStdout(line);
    if (accepted === false) {
      stdoutBackpressured = true;
      estimatedPendingStdoutBytes += lineBytes;
      if (activeChild !== undefined) {
        activeChild.pauseStdout?.();
        pausedChildren.add(activeChild);
      }
      if (!drainRegistered && io.onStdoutDrain !== undefined) {
        drainRegistered = true;
        io.onStdoutDrain(() => resumePausedChildren());
      }
      const pending = io.stdoutWritableLength?.() ?? estimatedPendingStdoutBytes;
      if (pending > ACP_MAX_BRIDGE_PENDING_STDOUT_BYTES) {
        return false;
      }
    }
    return true;
  };

  const emitSessionUpdate = (
    sessionId: string,
    update: Record<string, unknown>,
    activeChild?: ManagedCliChild
  ): boolean => {
    const providerSessionId = sessions.get(sessionId)?.providerSessionId ?? null;
    return sendFramedLine(
      notificationLine('session/update', {
        sessionId,
        update,
        ...(providerSessionId !== null ? { _meta: { providerSessionId } } : {})
      }),
      activeChild
    );
  };

  const emitChunkedTextUpdate = (
    sessionId: string,
    sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk',
    text: string,
    activeChild: ManagedCliChild,
    overflowState: { overflowed: boolean }
  ): void => {
    for (const part of chunkTextForFrame(text)) {
      if (!emitSessionUpdate(sessionId, { sessionUpdate, content: { type: 'text', text: part } }, activeChild)) {
        overflowState.overflowed = true;
        return;
      }
    }
  };

  const safeToolId = (raw: unknown): string => {
    if (typeof raw === 'string' && raw.length > 0 && raw.length <= ACP_RUNTIME_LIMITS.identifierMaxLength) {
      return raw;
    }
    const generated = `bridge-tool-${toolFallbackSeq}`;
    toolFallbackSeq += 1;
    return generated;
  };

  const handleClaudeJsonLine = (
    session: BridgeSession,
    record: Record<string, unknown>,
    activeChild: ManagedCliChild
  ): { readonly terminalEvent?: BridgeTerminalEvent; readonly backpressureOverflow?: boolean } => {
    if (isValidBridgeProviderSessionId(config.backend, record['session_id'])) {
      session.providerSessionId = record['session_id'];
    }
    const overflowState = { overflowed: false };
    const emit = (update: Record<string, unknown>): void => {
      if (overflowState.overflowed) return;
      if (!emitSessionUpdate(session.acpSessionId, update, activeChild)) {
        overflowState.overflowed = true;
      }
    };
    const rowType = record['type'];
    if (rowType === 'assistant' && isRecord(record['message']) && Array.isArray(record['message']['content'])) {
      for (const block of record['message']['content'] as readonly unknown[]) {
        if (overflowState.overflowed) break;
        if (!isRecord(block)) continue;
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          emitChunkedTextUpdate(session.acpSessionId, 'agent_message_chunk', block['text'], activeChild, overflowState);
        } else if (block['type'] === 'thinking' && typeof block['thinking'] === 'string') {
          emitChunkedTextUpdate(session.acpSessionId, 'agent_thought_chunk', block['thinking'], activeChild, overflowState);
        } else if (block['type'] === 'tool_use') {
          const boundedInput = boundRawInputForFrame(block['input']);
          const title =
            typeof block['name'] === 'string' && block['name'].length > 0
              ? truncateTextForJsonFrame(block['name'], 1024)
              : 'tool';
          emit({
            sessionUpdate: 'tool_call',
            toolCallId: safeToolId(block['id']),
            title,
            ...(boundedInput !== undefined ? { rawInput: boundedInput } : {})
          });
        }
      }
      return overflowState.overflowed ? { backpressureOverflow: true } : {};
    }
    if (rowType === 'user' && isRecord(record['message']) && Array.isArray(record['message']['content'])) {
      for (const block of record['message']['content'] as readonly unknown[]) {
        if (overflowState.overflowed) break;
        if (!isRecord(block) || block['type'] !== 'tool_result') continue;
        const isErr = block['is_error'] === true;
        const rawContent = block['content'];
        const fullText = typeof rawContent === 'string' ? rawContent : isErr ? 'failed' : 'completed';
        const text = truncateTextForJsonFrame(fullText);
        emit({
          sessionUpdate: 'tool_call_update',
          toolCallId: safeToolId(block['tool_use_id']),
          status: isErr ? 'failed' : 'completed',
          content: [{ type: 'content', content: { type: 'text', text } }]
        });
      }
      return overflowState.overflowed ? { backpressureOverflow: true } : {};
    }
    if (rowType === 'result') {
      const usage = isRecord(record['usage']) ? record['usage'] : null;
      const billableTokens =
        usage !== null
          ? parseStrictBillableTokens({
              inputTokens: usage['input_tokens'],
              outputTokens: usage['output_tokens'],
              cacheCreationInputTokens: usage['cache_creation_input_tokens'],
              cacheReadInputTokens: usage['cache_read_input_tokens']
            })
          : undefined;
      const formattedCost = formatBridgeCostAmount(record['total_cost_usd']);
      const cost = formattedCost !== undefined ? { amount: formattedCost, currency: 'USD' } : undefined;
      if (billableTokens !== undefined || cost !== undefined) {
        emit({
          sessionUpdate: 'usage_update',
          used: safeUsedTokens(billableTokens),
          size: DEFAULT_CONTEXT_WINDOW_TOKENS,
          ...(cost !== undefined ? { cost } : {}),
          ...(billableTokens !== undefined ? { _meta: { billableTokens } } : {})
        });
      }
      const subtype = record['subtype'];
      const hasErrorSubtype = subtype !== undefined && subtype !== 'success';
      if (record['is_error'] === true || hasErrorSubtype) {
        const msg =
          typeof record['result'] === 'string' && record['result'].length > 0
            ? record['result']
            : typeof subtype === 'string' && subtype.length > 0
              ? `claude result reported ${subtype}`
              : 'claude result reported error';
        return {
          terminalEvent: { kind: 'error', message: truncateErrorMessage(msg) },
          ...(overflowState.overflowed ? { backpressureOverflow: true } : {})
        };
      }
      const rawStopReason = record['stop_reason'];
      let stopReason: BridgeStopReason;
      if (rawStopReason === undefined || rawStopReason === null || rawStopReason === 'end_turn') {
        stopReason = 'end_turn';
      } else if (rawStopReason === 'max_tokens') {
        stopReason = 'max_tokens';
      } else if (rawStopReason === 'refusal') {
        stopReason = 'refusal';
      } else {
        return {
          terminalEvent: {
            kind: 'error',
            message: truncateErrorMessage(`claude reported unsupported stop_reason: ${String(rawStopReason)}`)
          },
          ...(overflowState.overflowed ? { backpressureOverflow: true } : {})
        };
      }
      if (!overflowState.overflowed && typeof record['result'] === 'string' && record['result'].length > 0) {
        // Ensure single-line result streams with no prior assistant block still surface text.
        emitChunkedTextUpdate(session.acpSessionId, 'agent_message_chunk', record['result'], activeChild, overflowState);
      }
      return {
        terminalEvent: { kind: 'success', stopReason },
        ...(overflowState.overflowed ? { backpressureOverflow: true } : {})
      };
    }
    return {};
  };

  const handleCodexJsonLine = (
    session: BridgeSession,
    record: Record<string, unknown>,
    activeChild: ManagedCliChild
  ): { readonly terminalEvent?: BridgeTerminalEvent; readonly backpressureOverflow?: boolean } => {
    const overflowState = { overflowed: false };
    const emit = (update: Record<string, unknown>): void => {
      if (overflowState.overflowed) return;
      if (!emitSessionUpdate(session.acpSessionId, update, activeChild)) {
        overflowState.overflowed = true;
      }
    };
    const rowType = record['type'];
    if (rowType === 'thread.started' && isValidBridgeProviderSessionId(config.backend, record['thread_id'])) {
      session.providerSessionId = record['thread_id'];
      return {};
    }
    if ((rowType === 'item.started' || rowType === 'item.completed') && isRecord(record['item'])) {
      const item = record['item'];
      const itemType = item['type'];
      if (rowType === 'item.completed' && itemType === 'agent_message' && typeof item['text'] === 'string') {
        emitChunkedTextUpdate(session.acpSessionId, 'agent_message_chunk', item['text'], activeChild, overflowState);
      } else if (rowType === 'item.completed' && itemType === 'reasoning' && typeof item['text'] === 'string') {
        emitChunkedTextUpdate(session.acpSessionId, 'agent_thought_chunk', item['text'], activeChild, overflowState);
      } else if (itemType === 'command_execution' || itemType === 'file_change') {
        const toolCallId = safeToolId(item['id']);
        if (rowType === 'item.started') {
          const boundedInput =
            typeof item['command'] === 'string'
              ? boundRawInputForFrame({ command: item['command'] })
              : undefined;
          emit({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: String(itemType),
            ...(boundedInput !== undefined ? { rawInput: boundedInput } : {})
          });
        } else {
          const failed = typeof item['exit_code'] === 'number' && item['exit_code'] !== 0;
          const rawOutputText =
            typeof item['aggregated_output'] === 'string' && item['aggregated_output'].length > 0
              ? item['aggregated_output']
              : failed
                ? 'failed'
                : 'completed';
          const outputText = truncateTextForJsonFrame(rawOutputText);
          emit({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: failed ? 'failed' : 'completed',
            content: [{ type: 'content', content: { type: 'text', text: outputText } }]
          });
        }
      }
      return overflowState.overflowed ? { backpressureOverflow: true } : {};
    }
    if (rowType === 'turn.completed') {
      const usage = isRecord(record['usage']) ? record['usage'] : null;
      const billableTokens =
        usage !== null
          ? parseStrictBillableTokens({
              inputTokens: usage['input_tokens'],
              outputTokens: usage['output_tokens'],
              cacheCreationInputTokens: usage['cache_write_input_tokens'],
              cacheReadInputTokens: usage['cached_input_tokens']
            })
          : undefined;
      if (billableTokens !== undefined) {
        emit({
          sessionUpdate: 'usage_update',
          used: safeUsedTokens(billableTokens),
          size: DEFAULT_CONTEXT_WINDOW_TOKENS,
          _meta: { billableTokens }
        });
      }
      return {
        terminalEvent: { kind: 'success', stopReason: 'end_turn' },
        ...(overflowState.overflowed ? { backpressureOverflow: true } : {})
      };
    }
    if (rowType === 'turn.failed' || rowType === 'error') {
      const msg =
        isRecord(record['error']) && typeof record['error']['message'] === 'string'
          ? record['error']['message']
          : typeof record['message'] === 'string'
            ? record['message']
            : 'codex turn failed';
      return {
        terminalEvent: { kind: 'error', message: truncateErrorMessage(msg) }
      };
    }
    return {};
  };

  const executePromptTurn = (
    rpcId: RpcId,
    session: BridgeSession,
    promptText: string
  ): void => {
    const liveCwd = canonicalizeBridgeCwd(session.cwd);
    if (liveCwd === null || liveCwd !== session.cwd) {
      sendFramedLine(errorLine(rpcId, RPC_INTERNAL_ERROR, 'Session cwd retargeted or unreadable'));
      return;
    }
    const securityReview = config.backend === 'codex' && config.nativeReview?.kind === 'security'
      ? config.nativeReview
      : undefined;
    let security: ReturnType<typeof codexSecurityLaunch> | undefined;
    let child: ManagedCliChild;
    try {
      if (securityReview !== undefined) {
        security = codexSecurityLaunch(
          securityReview,
          config.env,
          config.model,
          config.effort,
          securityReview.resolvedScannerPath,
          securityReview.resolvedScannerSha256
        );
      }
      const cli: Omit<StdioLaunch, 'cwd'> = security ?? {
        command: config.cliPath,
        args: buildCliArgs(config, config.nativeReview === undefined ? session.providerSessionId : null),
        env: config.env
      };
      child = spawnChild({ ...cli, cwd: session.cwd });
    } catch {
      void security?.cleanup().catch(() => undefined);
      sendFramedLine(
        errorLine(
          rpcId,
          RPC_INTERNAL_ERROR,
          formatBridgeErrorMessage(
            'rejected',
            securityReview === undefined
              ? 'Backend executable failed to launch'
              : 'Codex Security executable failed to launch'
          )
        )
      );
      return;
    }
    const turn: ActiveBridgeTurn = { rpcId, child, cancelled: false };
    session.activeTurn = turn;
    const isTurnCancelled = (): boolean => turn.cancelled;

    const framer = new BridgeByteFramer(MAX_CLI_LINE_BYTES);
    const securityDecoder = new TextDecoder('utf-8', { fatal: false });
    const stderrDecoder = new TextDecoder('utf-8', { fatal: false });
    let securityBody = '';
    let securityBytes = 0;
    const terminalEvents: BridgeTerminalEvent[] = [];
    let streamErrorText: string | null = null;
    let lineOverflowed = false;
    let pendingBacklogOverflowed = false;
    const isStreamOverflowed = (): boolean => pendingBacklogOverflowed || lineOverflowed;

    const recordTerminalEvent = (event: BridgeTerminalEvent): void => {
      if (terminalEvents.length < MAX_TRACKED_TERMINAL_EVENTS) {
        terminalEvents.push(event);
        return;
      }
      // Bounded terminal-event tracking: an excessive flood of terminal/error events fails closed.
      if (streamErrorText === null) {
        streamErrorText = 'Backend emitted excessive terminal events';
      }
      void child.terminate();
    };

    const processStdoutLine = (rawLine: string): void => {
      const trimmed = rawLine.trim();
      if (trimmed.length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        if (config.nativeReview !== undefined) {
          streamErrorText = 'Native reviewer emitted malformed JSONL';
          return;
        }
        // Non-JSON stdout text from a bridged CLI is surfaced as a chunked message rather than raw stdout.
        const nonJsonOverflow = { overflowed: false };
        emitChunkedTextUpdate(session.acpSessionId, 'agent_message_chunk', trimmed, child, nonJsonOverflow);
        if (nonJsonOverflow.overflowed) {
          pendingBacklogOverflowed = true;
          void child.terminate();
        }
        return;
      }
      if (!isRecord(parsed)) return;
      const outcome =
        config.backend === 'claude'
          ? handleClaudeJsonLine(session, parsed, child)
          : handleCodexJsonLine(session, parsed, child);
      if (outcome.terminalEvent !== undefined) recordTerminalEvent(outcome.terminalEvent);
      if (outcome.backpressureOverflow === true) {
        pendingBacklogOverflowed = true;
        void child.terminate();
      }
    };

    child.onStdout((chunk) => {
      if (isTurnCancelled() || lineOverflowed || pendingBacklogOverflowed) return;
      if (securityReview !== undefined) {
        securityBytes += chunk.byteLength;
        if (securityBytes <= MAX_CLI_LINE_BYTES) {
          securityBody += securityDecoder.decode(chunk, { stream: true });
        } else {
          lineOverflowed = true;
          securityBody = '';
          streamErrorText = 'Native reviewer output exceeded the line limit';
          void child.terminate();
        }
        return;
      }
      for (const event of framer.push(chunk)) {
        if (event.kind === 'overflow') {
          lineOverflowed = true;
          writeBridgeStderr(`[acp-bridge] cli stdout line exceeded ${event.limitBytes} byte bound\n`, child);
          if (config.nativeReview !== undefined) {
            streamErrorText = 'Native reviewer output exceeded the line limit';
          }
          void child.terminate();
          return;
        }
        processStdoutLine(event.text);
        if (isStreamOverflowed() || isTurnCancelled()) return;
      }
      if (stdoutBackpressured) {
        child.pauseStdout?.();
        pausedChildren.add(child);
      }
    });

    child.onStderr((chunk) => {
      writeBridgeStderr(stderrDecoder.decode(chunk, { stream: true }), child);
    });

    let stdinDeliveryFailed = false;
    if (securityReview === undefined) {
      child.onStdinBroken?.(() => {
        if (turn.cancelled) return;
        stdinDeliveryFailed = true;
        void child.terminate();
      });
    }

    const wrote = securityReview !== undefined ||
      child.writeStdin(promptText.endsWith('\n') ? promptText : `${promptText}\n`);
    child.endStdin();
    if (!wrote) {
      stdinDeliveryFailed = true;
      void child.terminate();
    }

    void child.exited.then(async (exit) => {
      pausedChildren.delete(child);
      pausedStderrChildren.delete(child);
      const stderrTail = stderrDecoder.decode();
      if (stderrTail.length > 0) writeBridgeStderr(stderrTail);
      if (securityReview === undefined) {
        if (!turn.cancelled && !pendingBacklogOverflowed && !lineOverflowed) {
          for (const event of framer.flush()) {
            if (event.kind === 'line') processStdoutLine(event.text);
          }
        }
      } else {
        await security?.cleanup().catch(() => undefined);
        const tail = securityBody + securityDecoder.decode();
        const report = !lineOverflowed && securityBytes <= MAX_CLI_LINE_BYTES && exit.code === 0
          ? summarizeSecurityScan(tail, securityReview.mergeBase)
          : null;
        if (report === null) {
          streamErrorText = lineOverflowed
            ? 'Native reviewer output exceeded the line limit'
            : 'Codex Security did not return a complete scan report';
        } else {
          const reportOverflow = { overflowed: false };
          emitChunkedTextUpdate(session.acpSessionId, 'agent_message_chunk', report, child, reportOverflow);
          if (reportOverflow.overflowed) {
            pendingBacklogOverflowed = true;
          } else {
            recordTerminalEvent({ kind: 'success', stopReason: 'end_turn' });
          }
        }
      }
      if (session.activeTurn === turn) session.activeTurn = null;

      const resultMeta =
        session.providerSessionId !== null
          ? { _meta: { providerSessionId: session.providerSessionId } }
          : {};

      const decision = reconcileBridgeTurnOutcome({
        backend: config.backend,
        rejectDuplicateSuccessRecords: config.backend === 'codex',
        isNativeReview: config.nativeReview !== undefined,
        isSecurityReview: securityReview !== undefined,
        cancelled: turn.cancelled,
        exit,
        terminalEvents,
        streamErrorText,
        lineOverflowed,
        pendingBacklogOverflowed,
        stdinDeliveryFailed:
          securityReview === undefined && (stdinDeliveryFailed || child.isStdinBroken?.() === true)
      });

      if (decision.outcome === 'cancelled') {
        if (!child.isProcessTreeGone()) {
          writeBridgeStderr('[acp-bridge] warning: child process group survived after cancellation\n');
        }
        sendFramedLine(resultLine(rpcId, { stopReason: 'cancelled', ...resultMeta }));
        return;
      }
      if (decision.outcome === 'error') {
        sendFramedLine(errorLine(rpcId, rpcCodeForBridgeErrorStatus(decision.status), decision.message));
        return;
      }
      sendFramedLine(resultLine(rpcId, { stopReason: decision.stopReason, ...resultMeta }));
    });
  };

  const handleRequest = (id: RpcId, method: string, params: unknown): void => {
    if (method === 'initialize') {
      if (!isRecord(params) || typeof params['protocolVersion'] !== 'number') {
        sendFramedLine(errorLine(id, JSON_RPC_INVALID_PARAMS, 'Invalid params'));
        return;
      }
      initialized = true;
      sendFramedLine(
        resultLine(id, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: {
              image: false,
              audio: false,
              embeddedContext: true
            }
          },
          agentInfo: {
            name: `Schegent ${getBackendDescriptor(config.backend).displayLabel} ACP Bridge`,
            version: ACP_STDIO_BRIDGE_VERSION
          },
          authMethods: []
        })
      );
      return;
    }

    if (!initialized) {
      sendFramedLine(errorLine(id, RPC_INTERNAL_ERROR, 'Not initialized'));
      return;
    }

    if (method === 'session/new') {
      if (!isRecord(params) || !isNonEmptyString(params['cwd'])) {
        sendFramedLine(errorLine(id, JSON_RPC_INVALID_PARAMS, 'Invalid params'));
        return;
      }
      const canonicalCwd = canonicalizeBridgeCwd(params['cwd']);
      if (canonicalCwd === null) {
        sendFramedLine(errorLine(id, JSON_RPC_INVALID_PARAMS, 'Invalid cwd for session/new'));
        return;
      }
      const acpSessionId = `acp-${config.backend}-session-${nextSessionSeq}`;
      nextSessionSeq += 1;
      sessions.set(acpSessionId, {
        acpSessionId,
        cwd: canonicalCwd,
        providerSessionId: null,
        activeTurn: null
      });
      sendFramedLine(resultLine(id, { sessionId: acpSessionId }));
      return;
    }

    if (method === 'session/load') {
      if (
        !isRecord(params) ||
        !isNonEmptyString(params['sessionId']) ||
        !isAgentIdentifier(params['sessionId']) ||
        !isNonEmptyString(params['cwd'])
      ) {
        sendFramedLine(errorLine(id, JSON_RPC_INVALID_PARAMS, 'Invalid params'));
        return;
      }
      const sessionId = params['sessionId'];
      const requestedCanonicalCwd = canonicalizeBridgeCwd(params['cwd']);
      if (requestedCanonicalCwd === null) {
        sendFramedLine(errorLine(id, JSON_RPC_INVALID_PARAMS, 'Invalid cwd for session/load'));
        return;
      }
      const existing = sessions.get(sessionId);
      if (existing !== undefined) {
        if (
          existing.cwd !== requestedCanonicalCwd ||
          canonicalizeBridgeCwd(existing.cwd) !== existing.cwd
        ) {
          sendFramedLine(errorLine(id, JSON_RPC_INVALID_PARAMS, 'Session cwd mismatch for session/load'));
          return;
        }
        sendFramedLine(resultLine(id, {}));
        return;
      }
      const rawMeta = isRecord(params['_meta']) ? params['_meta'] : null;
      const rawProviderSessionId = rawMeta !== null ? rawMeta['providerSessionId'] : undefined;
      if (!isValidBridgeProviderSessionId(config.backend, rawProviderSessionId)) {
        sendFramedLine(errorLine(id, JSON_RPC_INVALID_PARAMS, 'Provider session binding missing for session/load'));
        return;
      }
      sessions.set(sessionId, {
        acpSessionId: sessionId,
        cwd: requestedCanonicalCwd,
        providerSessionId: rawProviderSessionId,
        activeTurn: null
      });
      sendFramedLine(resultLine(id, {}));
      return;
    }

    if (method === 'session/prompt') {
      if (!isRecord(params) || !isNonEmptyString(params['sessionId'])) {
        sendFramedLine(errorLine(id, JSON_RPC_INVALID_PARAMS, 'Invalid params'));
        return;
      }
      const session = sessions.get(params['sessionId']);
      if (session === undefined || session.activeTurn !== null) {
        sendFramedLine(errorLine(id, JSON_RPC_INVALID_PARAMS, 'Session unavailable'));
        return;
      }
      const promptText = renderPromptBlocks(params['prompt']);
      if (promptText === null) {
        sendFramedLine(errorLine(id, JSON_RPC_INVALID_PARAMS, 'Invalid prompt blocks'));
        return;
      }
      executePromptTurn(id, session, promptText);
      return;
    }

    sendFramedLine(errorLine(id, JSON_RPC_METHOD_NOT_FOUND, 'Method not found'));
  };

  const handleNotification = (method: string, params: unknown): void => {
    if (method !== 'session/cancel' || !isRecord(params) || !isNonEmptyString(params['sessionId'])) return;
    const session = sessions.get(params['sessionId']);
    if (session?.activeTurn === null || session === undefined) return;
    session.activeTurn.cancelled = true;
    pausedChildren.delete(session.activeTurn.child);
    pausedStderrChildren.delete(session.activeTurn.child);
    session.activeTurn.child.resumeStdout?.();
    session.activeTurn.child.resumeStderr?.();
    void session.activeTurn.child.terminate();
  };

  const handleRawLine = (rawLine: string): void => {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(trimmed);
    } catch {
      io.writeStderr('[acp-bridge] malformed JSON-RPC frame\n');
      return;
    }
    const parsed = classifyMessage(decoded);
    if (parsed.kind === 'request') {
      handleRequest(parsed.id, parsed.method, parsed.params);
    } else if (parsed.kind === 'notification') {
      handleNotification(parsed.method, parsed.params);
    }
  };

  const closeAll = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    const terminations: Promise<void>[] = [];
    for (const session of sessions.values()) {
      if (session.activeTurn !== null) {
        session.activeTurn.cancelled = true;
        terminations.push(session.activeTurn.child.terminate());
      }
    }
    await Promise.allSettled(terminations);
  };

  const isServerClosing = (): boolean => closing;
  io.onStdin((chunk) => {
    if (isServerClosing()) return;
    if (
      Buffer.byteLength(pendingStdin, 'utf8') + chunk.byteLength >
      ACP_RUNTIME_LIMITS.maxPendingBytes
    ) {
      pendingStdin = '';
      io.writeStderr('[acp-bridge] stdin pending bytes exceeded limit\n');
      void closeAll();
      return;
    }
    pendingStdin += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(pendingStdin, 'utf8') > ACP_RUNTIME_LIMITS.maxPendingBytes) {
      pendingStdin = '';
      io.writeStderr('[acp-bridge] stdin pending bytes exceeded limit\n');
      void closeAll();
      return;
    }
    let idx = pendingStdin.indexOf('\n');
    while (idx !== -1) {
      const line = pendingStdin.slice(0, idx);
      pendingStdin = pendingStdin.slice(idx + 1);
      handleRawLine(line);
      if (isServerClosing()) {
        pendingStdin = '';
        return;
      }
      idx = pendingStdin.indexOf('\n');
    }
  });

  io.onStdinClose(() => {
    void closeAll();
  });

  return { close: closeAll };
}
