// Feature 020 T026 — project a single parsed stream.jsonl line into a
// display entry. Pure projection — no sanitization, no truncation.
// See specs/020-phase-level-logs/contracts/phase-log-service.md §4
// and research.md §4.
//
// Feature 020 BUG-002 (T083, FR-012a) — that projection reads Claude's lines,
// which carry a string `type`. agy keys its lines `event` and spreads one step
// over several of them, so `StreamLineProjector` below chooses the projection
// by each line's shape and holds an agy step until a line closes it. The agy
// mapping is recorded in specs/020-phase-level-logs/data-model.md §6.

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
      return {
        seq: 0,
        kind: 'tool-use',
        ts: null,
        body: toolUseBody(asString(blockRec['name']) ?? '', blockRec['input']),
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

// Feature 020 BUG-002 (T083) — shared by both projections, so an agy `init` or
// `result` line reads as a Claude `system` line does.
function scalarSummaryParts(rec: AnyRecord, skippedKeys: ReadonlySet<string>): string[] {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(rec)) {
    if (skippedKeys.has(k)) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}=${String(v)}`);
    }
  }
  return parts;
}

// Feature 020 BUG-002 (T083) — the `tool-use` body of a Claude `tool_use` block
// and of an agy `tool` step alike.
function toolUseBody(toolName: string, inputValue: unknown): PhaseLogDisplayEntry['body'] {
  const toolInput = inputValue === undefined
    ? ''
    : typeof inputValue === 'string'
      ? inputValue
      : safeStringify(inputValue);
  const toolArguments = buildToolArguments(inputValue);
  return toolArguments !== undefined
    ? { toolName, toolInput, toolArguments }
    : { toolName, toolInput };
}

const CLAUDE_SYSTEM_SKIPPED_KEYS: ReadonlySet<string> = new Set(['type', 'subtype']);

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
      return {
        seq: 0,
        kind: 'system',
        ts: null,
        body: {
          systemSubtype: subtype,
          systemSummary: scalarSummaryParts(rec, CLAUDE_SYSTEM_SKIPPED_KEYS).join(' ')
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

// ---------------------------------------------------------------------------
// Feature 020 BUG-002 (T083, FR-012a) — agy's JSON lines.
//
// agy writes an `event: init` line, then `event: step_update` lines, then an
// `event: result` line. One step spans the `step_update` lines that share its
// `step_index`: each may carry a `text_delta` fragment, and `state` moves from
// `ACTIVE` to `DONE`, or to `ERROR`. That grouping is inferred from the field
// names and counts BUG-002 recorded, not from agy documentation; the SC-011
// live check is what confirms it.

/**
 * The most agy steps held open at once. A step that never closes would
 * otherwise hold its text for the life of a tail; when one more step opens,
 * the oldest open one is emitted as it stands.
 */
export const MAX_OPEN_AGY_STEPS = 16;

/**
 * The most UTF-16 code units of text kept for one agy step. Fragments past it
 * are dropped, so a step that never closes cannot grow without bound; the
 * display truncator then caps the field as it caps any other.
 */
export const MAX_AGY_STEP_TEXT_LENGTH = 256 * 1024;

const AGY_INIT_SKIPPED_KEYS: ReadonlySet<string> = new Set(['event']);
// `usage` is appended as JSON after the scalars, as a Claude `result` line's is.
const AGY_RESULT_SKIPPED_KEYS: ReadonlySet<string> = new Set(['event', 'usage']);
const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;

interface OpenAgyStep {
  stepType: string | undefined;
  toolName: string | undefined;
  toolInfo: unknown;
  text: string;
  /** Set once `text` reached its cap; later fragments are dropped. */
  textFull: boolean;
}

function agyEntry(
  kind: PhaseLogDisplayEntry['kind'],
  body: PhaseLogDisplayEntry['body']
): PhaseLogDisplayEntry {
  return { seq: 0, kind, ts: null, body, bodyTruncated: null };
}

function agyStepKey(value: unknown): string | undefined {
  return typeof value === 'number' ? String(value) : asString(value);
}

function agyResultSummary(rec: AnyRecord): string {
  const parts = scalarSummaryParts(rec, AGY_RESULT_SKIPPED_KEYS);
  const usage = rec['usage'];
  if (usage !== undefined) parts.push(`usage=${safeStringify(usage)}`);
  return parts.length === 0 ? 'result' : parts.join(' ');
}

// A capped text never ends on half a surrogate pair.
function dropTrailingHighSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= HIGH_SURROGATE_FIRST && last <= HIGH_SURROGATE_LAST ? text.slice(0, -1) : text;
}

function appendStepText(step: OpenAgyStep, fragment: string): void {
  if (step.textFull) return;
  const room = MAX_AGY_STEP_TEXT_LENGTH - step.text.length;
  if (fragment.length <= room) {
    step.text += fragment;
    return;
  }
  step.textFull = true;
  step.text = dropTrailingHighSurrogate(step.text + fragment.slice(0, room));
}

// A field a line omits keeps the value an earlier line of the step gave it.
function mergeStepUpdate(step: OpenAgyStep, rec: AnyRecord): void {
  step.stepType = asString(rec['step_type']) ?? step.stepType;
  step.toolName = asString(rec['tool_name']) ?? step.toolName;
  if (rec['tool_info'] !== undefined) step.toolInfo = rec['tool_info'];
  const fragment = asString(rec['text_delta']);
  if (fragment !== undefined) appendStepText(step, fragment);
}

function projectAgyStep(step: OpenAgyStep): PhaseLogDisplayEntry[] {
  switch (step.stepType) {
    case 'agent_response':
      return [agyEntry('assistant-text', { text: step.text })];
    case 'tool':
      // A tool step's name and input are shown; its own text is not.
      return [agyEntry('tool-use', toolUseBody(step.toolName ?? '', step.toolInfo))];
    case 'user_input':
    case 'system_message':
    case 'checkpoint':
    case 'error_message':
      return [agyEntry('system', { systemSubtype: step.stepType, systemSummary: step.text })];
    default:
      // A step type BUG-002 did not record has no projection yet.
      return [];
  }
}

/**
 * Feature 020 BUG-002 (T083, FR-012a) — projects parsed `stream.jsonl` lines
 * in order, choosing each line's projection by its shape: a string `type` is a
 * Claude line, a string `event` an agy one, and any other line is noise,
 * skipped without being counted as malformed.
 *
 * Stateful, because one agy step spans several lines and is emitted once, when
 * a line closes it. Use one instance per one-shot read, and one per tail for as
 * long as its offset holds, so a read and a tail of the same lines yield the
 * same entries.
 */
export class StreamLineProjector {
  private readonly openSteps = new Map<string, OpenAgyStep>();

  project(line: unknown): readonly PhaseLogDisplayEntry[] {
    const rec = asRecord(line);
    if (!rec) return [];
    if (typeof rec['type'] === 'string') {
      const entry = projectStreamJsonlLine(rec);
      return entry ? [entry] : [];
    }
    switch (asString(rec['event'])) {
      case 'init':
        return [agyEntry('system', {
          systemSubtype: 'init',
          systemSummary: scalarSummaryParts(rec, AGY_INIT_SKIPPED_KEYS).join(' ')
        })];
      case 'result':
        return [agyEntry('result', { resultSummary: agyResultSummary(rec) })];
      case 'step_update':
        return this.updateStep(rec);
      default:
        return [];
    }
  }

  private updateStep(rec: AnyRecord): PhaseLogDisplayEntry[] {
    const key = agyStepKey(rec['step_index']);
    if (key === undefined) return [];
    const emitted: PhaseLogDisplayEntry[] = [];
    let step = this.openSteps.get(key);
    if (step === undefined) {
      if (this.openSteps.size >= MAX_OPEN_AGY_STEPS) emitted.push(...this.closeOldestStep());
      step = { stepType: undefined, toolName: undefined, toolInfo: undefined, text: '', textFull: false };
      this.openSteps.set(key, step);
    }
    mergeStepUpdate(step, rec);
    const state = asString(rec['state']);
    if (state === 'DONE' || state === 'ERROR') {
      this.openSteps.delete(key);
      emitted.push(...projectAgyStep(step));
    }
    return emitted;
  }

  private closeOldestStep(): PhaseLogDisplayEntry[] {
    const oldest = this.openSteps.entries().next();
    if (oldest.done === true) return [];
    const [key, step] = oldest.value;
    this.openSteps.delete(key);
    return projectAgyStep(step);
  }
}
