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
import { ACP_PROTOCOL_VERSION, ACP_RUNTIME_LIMITS } from '../../../contracts/acp-runtime';
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

export type BridgedBackendKind = 'claude' | 'codex';

export const ACP_STDIO_BRIDGE_VERSION = '1.0.0';

export interface AcpBridgeLaunchConfig {
  readonly backend: BridgedBackendKind;
  readonly cliPath: string;
  readonly permissionFlags: readonly string[];
  readonly model?: string;
  readonly effort?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly spawnChild?: (input: StdioLaunch) => ManagedCliChild;
}

export interface BridgeIoStreams {
  onStdin(listener: (chunk: Uint8Array) => void): void;
  onStdinClose(listener: () => void): void;
  writeStdout(line: string): void;
  writeStderr(text: string): void;
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
const MAX_CLI_LINE_BYTES = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function renderPromptBlocks(blocks: unknown): string | null {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  const parts: string[] = [];
  for (const raw of blocks as readonly unknown[]) {
    if (!isRecord(raw) || typeof raw['type'] !== 'string') return null;
    if (raw['type'] === 'text') {
      if (typeof raw['text'] !== 'string') return null;
      parts.push(raw['text']);
    } else if (raw['type'] === 'resource_link') {
      if (!isNonEmptyString(raw['uri']) || !isNonEmptyString(raw['name'])) return null;
      parts.push(`[Resource Link: ${raw['name']} (${raw['uri']})]`);
    } else if (raw['type'] === 'resource') {
      const resource = raw['resource'];
      if (!isRecord(resource) || !isNonEmptyString(resource['uri']) || typeof resource['text'] !== 'string') {
        return null;
      }
      const mime = typeof resource['mimeType'] === 'string' ? ` (${resource['mimeType']})` : '';
      parts.push(`<embedded-resource uri="${resource['uri']}"${mime}>\n${resource['text']}\n</embedded-resource>`);
    } else {
      return null;
    }
  }
  const combined = parts.join('\n\n');
  if (Buffer.byteLength(combined, 'utf8') > ACP_RUNTIME_LIMITS.maxMessageBytes) return null;
  return combined;
}

function buildCliArgs(config: AcpBridgeLaunchConfig, providerSessionId: string | null): string[] {
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
      : ['exec', '--json', ...config.permissionFlags];
  if (isNonEmptyString(config.model)) args.push('--model', config.model);
  if (isNonEmptyString(config.effort)) args.push('--config', `model_reasoning_effort=${config.effort}`);
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
  const permissionFlags: string[] = [];

  for (let idx = 0; idx < argv.length; idx += 1) {
    const flag = argv[idx];
    const next = argv[idx + 1];
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
    } else {
      return null;
    }
  }
  if (backend === null || cliPath === null) return null;
  return {
    backend,
    cliPath,
    permissionFlags,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
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

  const sendFramedLine = (line: string): void => {
    if (closing) return;
    io.writeStdout(line);
  };

  const emitSessionUpdate = (sessionId: string, update: Record<string, unknown>): void => {
    sendFramedLine(notificationLine('session/update', { sessionId, update }));
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
    record: Record<string, unknown>
  ): { completedStopReason?: 'end_turn' | 'max_tokens' | 'refusal'; errorText?: string } => {
    if (typeof record['session_id'] === 'string' && record['session_id'].length > 0) {
      session.providerSessionId = record['session_id'];
    }
    const rowType = record['type'];
    if (rowType === 'assistant' && isRecord(record['message']) && Array.isArray(record['message']['content'])) {
      for (const block of record['message']['content'] as readonly unknown[]) {
        if (!isRecord(block)) continue;
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          emitSessionUpdate(session.acpSessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: block['text'] }
          });
        } else if (block['type'] === 'thinking' && typeof block['thinking'] === 'string') {
          emitSessionUpdate(session.acpSessionId, {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: block['thinking'] }
          });
        } else if (block['type'] === 'tool_use') {
          emitSessionUpdate(session.acpSessionId, {
            sessionUpdate: 'tool_call',
            toolCallId: safeToolId(block['id']),
            title: typeof block['name'] === 'string' && block['name'].length > 0 ? block['name'] : 'tool',
            ...(block['input'] !== undefined ? { rawInput: block['input'] } : {})
          });
        }
      }
      return {};
    }
    if (rowType === 'user' && isRecord(record['message']) && Array.isArray(record['message']['content'])) {
      for (const block of record['message']['content'] as readonly unknown[]) {
        if (!isRecord(block) || block['type'] !== 'tool_result') continue;
        const isErr = block['is_error'] === true;
        const rawContent = block['content'];
        const text = typeof rawContent === 'string' ? rawContent : isErr ? 'failed' : 'completed';
        emitSessionUpdate(session.acpSessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: safeToolId(block['tool_use_id']),
          status: isErr ? 'failed' : 'completed',
          content: [{ type: 'content', content: { type: 'text', text } }]
        });
      }
      return {};
    }
    if (rowType === 'result') {
      const usage = isRecord(record['usage']) ? record['usage'] : null;
      if (usage !== null) {
        const inputTokens = typeof usage['input_tokens'] === 'number' ? Math.max(0, Math.trunc(usage['input_tokens'])) : 0;
        const outputTokens = typeof usage['output_tokens'] === 'number' ? Math.max(0, Math.trunc(usage['output_tokens'])) : 0;
        const costUsd = record['total_cost_usd'];
        const cost =
          typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0
            ? { amount: costUsd.toFixed(6), currency: 'USD' }
            : undefined;
        emitSessionUpdate(session.acpSessionId, {
          sessionUpdate: 'usage_update',
          used: inputTokens + outputTokens,
          size: DEFAULT_CONTEXT_WINDOW_TOKENS,
          ...(cost !== undefined ? { cost } : {})
        });
      }
      if (record['is_error'] === true) {
        return { errorText: typeof record['result'] === 'string' ? record['result'] : 'claude result reported error' };
      }
      if (typeof record['result'] === 'string' && record['result'].length > 0) {
        // Ensure single-line result streams with no prior assistant block still surface text.
        emitSessionUpdate(session.acpSessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: record['result'] }
        });
      }
      const stopReason = record['stop_reason'] === 'max_tokens' ? 'max_tokens' : 'end_turn';
      return { completedStopReason: stopReason };
    }
    return {};
  };

  const handleCodexJsonLine = (
    session: BridgeSession,
    record: Record<string, unknown>
  ): { completedStopReason?: 'end_turn'; errorText?: string } => {
    const rowType = record['type'];
    if (rowType === 'thread.started' && typeof record['thread_id'] === 'string' && record['thread_id'].length > 0) {
      session.providerSessionId = record['thread_id'];
      return {};
    }
    if ((rowType === 'item.started' || rowType === 'item.completed') && isRecord(record['item'])) {
      const item = record['item'];
      const itemType = item['type'];
      if (rowType === 'item.completed' && itemType === 'agent_message' && typeof item['text'] === 'string') {
        emitSessionUpdate(session.acpSessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: item['text'] }
        });
      } else if (rowType === 'item.completed' && itemType === 'reasoning' && typeof item['text'] === 'string') {
        emitSessionUpdate(session.acpSessionId, {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: item['text'] }
        });
      } else if (itemType === 'command_execution' || itemType === 'file_change') {
        const toolCallId = safeToolId(item['id']);
        if (rowType === 'item.started') {
          emitSessionUpdate(session.acpSessionId, {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: String(itemType),
            ...(typeof item['command'] === 'string' ? { rawInput: { command: item['command'] } } : {})
          });
        } else {
          const failed = typeof item['exit_code'] === 'number' && item['exit_code'] !== 0;
          const outputText =
            typeof item['aggregated_output'] === 'string' && item['aggregated_output'].length > 0
              ? item['aggregated_output']
              : failed
                ? 'failed'
                : 'completed';
          emitSessionUpdate(session.acpSessionId, {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: failed ? 'failed' : 'completed',
            content: [{ type: 'content', content: { type: 'text', text: outputText } }]
          });
        }
      }
      return {};
    }
    if (rowType === 'turn.completed') {
      const usage = isRecord(record['usage']) ? record['usage'] : null;
      if (usage !== null) {
        const inputTokens = typeof usage['input_tokens'] === 'number' ? Math.max(0, Math.trunc(usage['input_tokens'])) : 0;
        const outputTokens = typeof usage['output_tokens'] === 'number' ? Math.max(0, Math.trunc(usage['output_tokens'])) : 0;
        emitSessionUpdate(session.acpSessionId, {
          sessionUpdate: 'usage_update',
          used: inputTokens + outputTokens,
          size: DEFAULT_CONTEXT_WINDOW_TOKENS
        });
      }
      return { completedStopReason: 'end_turn' };
    }
    if (rowType === 'turn.failed' || rowType === 'error') {
      const msg =
        isRecord(record['error']) && typeof record['error']['message'] === 'string'
          ? record['error']['message']
          : typeof record['message'] === 'string'
            ? record['message']
            : 'codex turn failed';
      return { errorText: msg };
    }
    return {};
  };

  const executePromptTurn = (
    rpcId: RpcId,
    session: BridgeSession,
    promptText: string
  ): void => {
    const args = buildCliArgs(config, session.providerSessionId);
    const child = spawnChild({
      command: config.cliPath,
      args,
      cwd: session.cwd,
      env: config.env
    });
    const turn: ActiveBridgeTurn = { rpcId, child, cancelled: false };
    session.activeTurn = turn;

    const childDecoder = new TextDecoder('utf-8', { fatal: false });
    let lineRemainder = '';
    let completedStopReason: 'end_turn' | 'max_tokens' | 'refusal' | null = null;
    let streamErrorText: string | null = null;

    const processStdoutLine = (rawLine: string): void => {
      const trimmed = rawLine.trim();
      if (trimmed.length === 0 || Buffer.byteLength(trimmed, 'utf8') > MAX_CLI_LINE_BYTES) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Non-JSON stdout text from a bridged CLI is surfaced as a message chunk rather than raw stdout.
        emitSessionUpdate(session.acpSessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: trimmed }
        });
        return;
      }
      if (!isRecord(parsed)) return;
      const outcome =
        config.backend === 'claude'
          ? handleClaudeJsonLine(session, parsed)
          : handleCodexJsonLine(session, parsed);
      if (outcome.completedStopReason !== undefined) completedStopReason = outcome.completedStopReason;
      if (outcome.errorText !== undefined) streamErrorText = outcome.errorText;
    };

    child.onStdout((chunk) => {
      lineRemainder += childDecoder.decode(chunk, { stream: true });
      let newlineIdx = lineRemainder.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = lineRemainder.slice(0, newlineIdx);
        lineRemainder = lineRemainder.slice(newlineIdx + 1);
        processStdoutLine(line);
        newlineIdx = lineRemainder.indexOf('\n');
      }
    });

    child.onStderr((chunk) => {
      io.writeStderr(Buffer.from(chunk).toString('utf8'));
    });

    const wrote = child.writeStdin(promptText.endsWith('\n') ? promptText : `${promptText}\n`);
    child.endStdin();
    if (!wrote) {
      void child.terminate();
    }

    void child.exited.then((exit) => {
      const tail = lineRemainder + childDecoder.decode();
      if (tail.trim().length > 0) processStdoutLine(tail);
      if (session.activeTurn === turn) session.activeTurn = null;

      if (turn.cancelled) {
        if (!child.isProcessTreeGone()) {
          io.writeStderr('[acp-bridge] warning: child process group survived after cancellation\n');
        }
        sendFramedLine(resultLine(rpcId, { stopReason: 'cancelled' }));
        return;
      }
      if (exit.launchFailed) {
        sendFramedLine(errorLine(rpcId, RPC_INTERNAL_ERROR, 'Backend executable failed to launch'));
        return;
      }
      if (streamErrorText !== null || (exit.code !== 0 && completedStopReason === null)) {
        sendFramedLine(
          errorLine(
            rpcId,
            RPC_INTERNAL_ERROR,
            streamErrorText ?? `Backend exited with code ${String(exit.code ?? 'signal')}`
          )
        );
        return;
      }
      sendFramedLine(resultLine(rpcId, { stopReason: completedStopReason ?? 'end_turn' }));
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
            name: config.backend === 'claude' ? 'Schegent Claude ACP Bridge' : 'Schegent Codex ACP Bridge',
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
      const acpSessionId = `acp-${config.backend}-session-${nextSessionSeq}`;
      nextSessionSeq += 1;
      sessions.set(acpSessionId, {
        acpSessionId,
        cwd: params['cwd'],
        providerSessionId: null,
        activeTurn: null
      });
      sendFramedLine(resultLine(id, { sessionId: acpSessionId }));
      return;
    }

    if (method === 'session/load') {
      if (!isRecord(params) || !isNonEmptyString(params['sessionId']) || !isNonEmptyString(params['cwd'])) {
        sendFramedLine(errorLine(id, JSON_RPC_INVALID_PARAMS, 'Invalid params'));
        return;
      }
      const sessionId = params['sessionId'];
      const existing = sessions.get(sessionId);
      if (existing !== undefined) {
        existing.cwd = params['cwd'];
      } else {
        sessions.set(sessionId, {
          acpSessionId: sessionId,
          cwd: params['cwd'],
          providerSessionId: sessionId.startsWith(`acp-${config.backend}-session-`) ? null : sessionId,
          activeTurn: null
        });
      }
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

  io.onStdin((chunk) => {
    pendingStdin += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(pendingStdin, 'utf8') > ACP_RUNTIME_LIMITS.maxPendingBytes) {
      io.writeStderr('[acp-bridge] stdin pending bytes exceeded limit\n');
      void closeAll();
      return;
    }
    let idx = pendingStdin.indexOf('\n');
    while (idx !== -1) {
      const line = pendingStdin.slice(0, idx);
      pendingStdin = pendingStdin.slice(idx + 1);
      handleRawLine(line);
      idx = pendingStdin.indexOf('\n');
    }
  });

  io.onStdinClose(() => {
    void closeAll();
  });

  return { close: closeAll };
}
