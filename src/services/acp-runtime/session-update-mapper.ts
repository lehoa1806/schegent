/**
 * FR-R6-F13 (FR-015, FR-016, research R5) — one ACP `session/update` payload to an F07 display
 * part, an F06 usage reading, or a counted ignore.
 *
 * The mapper reads the `update` object only. Session routing, origin and attribution are
 * decided by the caller, which then builds the F07 event with `toNormalizedEvent`. A field of the
 * wrong type makes the whole update `invalid-update`; nothing partial is shown.
 *
 * Zero `vscode` imports.
 */
import type { AcpEventKind, AcpEventOrigin, AcpNormalizedEvent } from '../phase-log/acp-live-projection';
import { isAgentIdentifier } from './agent-identifier';

export interface DisplayPart {
  readonly kind: AcpEventKind;
  readonly text?: string;
  readonly toolName?: string;
  readonly toolArgs?: unknown;
  readonly sourceEventId: string | null;
}

export interface UsageReading {
  readonly used: number;
  readonly size: number;
  readonly cost?: { readonly amount: string; readonly currency?: string };
}

export type IgnoreReason = 'unknown-kind' | 'non-terminal-tool-update' | 'invalid-update';

export type MappedUpdate =
  | { readonly kind: 'display'; readonly part: DisplayPart }
  | { readonly kind: 'usage'; readonly usage: UsageReading }
  | { readonly kind: 'ignored'; readonly reason: IgnoreReason };

const NON_TEXT_PLACEHOLDER = '[non-text content]';
const DEFAULT_TOOL_NAME = 'tool';
const TERMINAL_TOOL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed']);
const DECIMAL = /^\d+(\.\d+)?$/;
const INVALID: MappedUpdate = Object.freeze({ kind: 'ignored', reason: 'invalid-update' });

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sourceIdOf(value: unknown): string | null {
  return isAgentIdentifier(value) ? value : null;
}

function display(part: DisplayPart): MappedUpdate {
  return { kind: 'display', part };
}

/** The text of one content block, the placeholder for another block type, or null when malformed. */
function blockText(block: unknown): string | null {
  if (!isRecord(block) || typeof block['type'] !== 'string') return null;
  if (block['type'] !== 'text') return NON_TEXT_PLACEHOLDER;
  return typeof block['text'] === 'string' ? block['text'] : null;
}

function mapChunk(update: Fields, kind: 'message' | 'status'): MappedUpdate {
  const text = blockText(update['content']);
  return text === null ? INVALID : display({ kind, text, sourceEventId: null });
}

function mapToolCall(update: Fields): MappedUpdate {
  const title = update['title'];
  const toolKind = update['kind'];
  let toolName = DEFAULT_TOOL_NAME;
  if (typeof title === 'string' && title.length > 0) toolName = title;
  else if (typeof toolKind === 'string' && toolKind.length > 0) toolName = toolKind;
  const part: DisplayPart = { kind: 'tool-call', toolName, sourceEventId: sourceIdOf(update['toolCallId']) };
  return display('rawInput' in update ? { ...part, toolArgs: update['rawInput'] } : part);
}

function toolResultText(content: unknown, status: string): string | null {
  if (content === undefined || content === null) return status;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const item of content as readonly unknown[]) {
    if (!isRecord(item)) return null;
    if (item['type'] !== 'content') continue;
    const inner = item['content'];
    if (isRecord(inner) && inner['type'] === 'text' && typeof inner['text'] === 'string') texts.push(inner['text']);
  }
  return texts.length > 0 ? texts.join('\n') : status;
}

function mapToolUpdate(update: Fields): MappedUpdate {
  if (typeof update['toolCallId'] !== 'string') return INVALID;
  const status = update['status'];
  if (typeof status !== 'string' || !TERMINAL_TOOL_STATUSES.has(status)) {
    return status === undefined || typeof status === 'string' ? { kind: 'ignored', reason: 'non-terminal-tool-update' } : INVALID;
  }
  const text = toolResultText(update['content'], status);
  return text === null ? INVALID : display({ kind: 'tool-result', text, sourceEventId: sourceIdOf(update['toolCallId']) });
}

function mapPlan(update: Fields): MappedUpdate {
  const entries = update['entries'];
  if (!Array.isArray(entries)) return INVALID;
  const lines: string[] = [];
  for (const entry of entries as readonly unknown[]) {
    if (!isRecord(entry) || typeof entry['content'] !== 'string' || typeof entry['status'] !== 'string') return INVALID;
    lines.push(`[${entry['status']}] ${entry['content']}`);
  }
  return display({ kind: 'plan', text: lines.join('\n'), sourceEventId: null });
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** The cost as a non-negative decimal string, or undefined when it cannot be read exactly. */
function costOf(value: unknown): UsageReading['cost'] {
  if (!isRecord(value)) return undefined;
  const raw = value['amount'];
  const amount = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw;
  if (typeof amount !== 'string' || !DECIMAL.test(amount)) return undefined;
  const currency = value['currency'];
  return typeof currency === 'string' ? { amount, currency } : { amount };
}

function mapUsage(update: Fields): MappedUpdate {
  const used = update['used'];
  const size = update['size'];
  if (!isCount(used) || !isCount(size)) return INVALID;
  const cost = costOf(update['cost']);
  return { kind: 'usage', usage: cost === undefined ? { used, size } : { used, size, cost } };
}

/** Maps one `update` object from a `session/update` notification. */
export function mapSessionUpdate(update: unknown): MappedUpdate {
  if (!isRecord(update) || typeof update['sessionUpdate'] !== 'string') return INVALID;
  switch (update['sessionUpdate']) {
    case 'agent_message_chunk':
    case 'user_message_chunk':
      return mapChunk(update, 'message');
    case 'agent_thought_chunk':
      return mapChunk(update, 'status');
    case 'tool_call':
      return mapToolCall(update);
    case 'tool_call_update':
      return mapToolUpdate(update);
    case 'plan':
      return mapPlan(update);
    case 'usage_update':
      return mapUsage(update);
    default:
      return { kind: 'ignored', reason: 'unknown-kind' };
  }
}

export interface EventContext {
  readonly generation: number;
  readonly attemptId: string | null;
  readonly origin: AcpEventOrigin;
}

/** Builds the F07 event for one display part. */
export function toNormalizedEvent(part: DisplayPart, context: EventContext): AcpNormalizedEvent {
  const base = {
    connectionGeneration: String(context.generation),
    attemptId: context.attemptId,
    sourceEventId: part.sourceEventId,
    origin: context.origin,
    kind: part.kind
  };
  if (part.kind !== 'tool-call') return { ...base, text: part.text ?? '' };
  const toolName = part.toolName ?? DEFAULT_TOOL_NAME;
  return 'toolArgs' in part ? { ...base, toolName, toolArgs: part.toolArgs } : { ...base, toolName };
}
