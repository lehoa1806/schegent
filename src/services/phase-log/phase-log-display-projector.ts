// Feature 020 T026 — project a single parsed stream.jsonl line into a
// display entry. Pure projection — no sanitization, no truncation.
// See specs/020-phase-level-logs/contracts/phase-log-service.md §4
// and research.md §4.

import type { PhaseLogDisplayEntry, ToolArgumentValue } from './types';

// Feature 029 — recursion depth cap for `toolArguments`. Values deeper
// than MAX_DEPTH are replaced with the elision sentinel.
const MAX_TOOL_ARGUMENT_DEPTH = 8;

function elideValueAtDepth(value: unknown, depth: number): ToolArgumentValue {
  if (depth >= MAX_TOOL_ARGUMENT_DEPTH) {
    return { __elided: true };
  }
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return value as string | number | boolean;
  }
  if (Array.isArray(value)) {
    return value.map((item) => elideValueAtDepth(item, depth + 1));
  }
  if (t === 'object') {
    const out: { [k: string]: ToolArgumentValue } = {};
    for (const [k, v] of Object.entries(value as object)) {
      out[k] = elideValueAtDepth(v, depth + 1);
    }
    return out;
  }
  // undefined, function, symbol, bigint — coerce to null for safety.
  return null;
}

function buildToolArguments(input: unknown): ToolArgumentValue | undefined {
  if (input === undefined) return undefined;
  if (typeof input === 'string') {
    // The raw input was a bare string (rare; e.g., some tools accept
    // free-form text). Preserve it as a one-key wrapper so the renderer
    // can still display it as a labeled value.
    return { value: input };
  }
  return elideValueAtDepth(input, 0);
}

interface AnyRecord {
  readonly [key: string]: unknown;
}

function asRecord(value: unknown): AnyRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as AnyRecord;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function extractAssistantBlock(rec: AnyRecord): PhaseLogDisplayEntry | null {
  const message = asRecord(rec['message']);
  if (!message) return null;
  const content = message['content'];
  if (!Array.isArray(content) || content.length === 0) return null;
  // Emit the first usable content block. Caller iterates content blocks
  // and re-invokes per block when multiple blocks appear in document
  // order. The projector itself returns one entry per call.
  for (const block of content) {
    const blockRec = asRecord(block);
    if (!blockRec) continue;
    const blockType = asString(blockRec['type']);
    if (blockType === 'text') {
      const text = asString(blockRec['text']);
      if (typeof text === 'string') {
        return {
          seq: 0,
          kind: 'assistant-text',
          ts: null,
          body: { text },
          bodyTruncated: null
        };
      }
    }
    if (blockType === 'tool_use') {
      const toolName = asString(blockRec['name']) ?? '';
      const inputValue = blockRec['input'];
      const toolInput = inputValue === undefined
        ? ''
        : typeof inputValue === 'string'
          ? inputValue
          : safeStringify(inputValue);
      const toolArguments = buildToolArguments(inputValue);
      const body: PhaseLogDisplayEntry['body'] =
        toolArguments !== undefined
          ? { toolName, toolInput, toolArguments }
          : { toolName, toolInput };
      return {
        seq: 0,
        kind: 'tool-use',
        ts: null,
        body,
        bodyTruncated: null
      };
    }
  }
  return null;
}

function extractUserBlock(rec: AnyRecord): PhaseLogDisplayEntry | null {
  const message = asRecord(rec['message']);
  if (!message) return null;
  const content = message['content'];
  if (!Array.isArray(content) || content.length === 0) return null;
  for (const block of content) {
    const blockRec = asRecord(block);
    if (!blockRec) continue;
    const blockType = asString(blockRec['type']);
    if (blockType === 'tool_result') {
      const raw = blockRec['content'];
      const toolResult = typeof raw === 'string' ? raw : safeStringify(raw);
      const isError = asBoolean(blockRec['is_error']) ?? false;
      return {
        seq: 0,
        kind: 'tool-result',
        ts: null,
        body: { toolResult, isError },
        bodyTruncated: null
      };
    }
  }
  return null;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

export function projectStreamJsonlLine(line: unknown): PhaseLogDisplayEntry | null {
  const rec = asRecord(line);
  if (!rec) return null;
  const t = asString(rec['type']);
  if (!t) return null;
  switch (t) {
    case 'assistant':
      return extractAssistantBlock(rec);
    case 'user':
      return extractUserBlock(rec);
    case 'system': {
      const subtype = asString(rec['subtype']) ?? '';
      const summaryParts: string[] = [];
      for (const [k, v] of Object.entries(rec)) {
        if (k === 'type' || k === 'subtype') continue;
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          summaryParts.push(`${k}=${String(v)}`);
        }
      }
      return {
        seq: 0,
        kind: 'system',
        ts: null,
        body: {
          systemSubtype: subtype,
          systemSummary: summaryParts.join(' ')
        },
        bodyTruncated: null
      };
    }
    case 'result': {
      const parts: string[] = [];
      const durationMs = rec['duration_ms'];
      const numTurns = rec['num_turns'];
      const totalCost = rec['total_cost_usd'];
      const usage = rec['usage'];
      const subtype = asString(rec['subtype']);
      if (typeof durationMs === 'number') parts.push(`duration_ms=${durationMs}`);
      if (typeof numTurns === 'number') parts.push(`num_turns=${numTurns}`);
      if (typeof totalCost === 'number') parts.push(`total_cost_usd=${totalCost}`);
      if (subtype) parts.push(`subtype=${subtype}`);
      if (usage !== undefined) parts.push(`usage=${safeStringify(usage)}`);
      const summary = parts.length === 0 ? 'result' : parts.join(' ');
      return {
        seq: 0,
        kind: 'result',
        ts: null,
        body: { resultSummary: summary },
        bodyTruncated: null
      };
    }
    default:
      // Framing kinds (message_start, message_stop, content_block_*,
      // message_delta) and unknown types are dropped silently.
      return null;
  }
}
