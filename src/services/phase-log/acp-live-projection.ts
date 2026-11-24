// FR-R6-F07 T038 (FR-017) & FR-R7-16 (`16-09`, FR-009) — projects F13's
// normalized ACP events to display entries.
//
// F13's ACP runtime (`src/services/acp-runtime/`, `src/runner/acp-stream-encoder.ts`,
// `src/runner/acp-open-work-tracker.ts`, `src/contracts/acp-runtime.ts`) imports
// `AcpNormalizedEvent` as a type-only contract; runtime `projectAcpEvents` currently
// has no production caller and is qualified at its display boundary against fixtures
// and adversarial bounds tests.
//
// SEGMENTS. Entries from one connection, one origin (live or history) and one
// certain correlation share a segment. A new segment opens:
//   - on a new connection generation: behind one `transport-gap` row, because
//     what happened between the two connections is unknown;
//   - on a switch between live and history: behind a labelled marker row, so
//     replayed history is never read as new activity;
//   - on a history event without a source id after one with an id: behind a
//     `transport-gap` row, because its place in the history is uncertain.
//
// SEQUENCE. The stream sequence is assigned here, from 0, and only rises. It
// orders entries locally; no event field can move it.
//
// CONTENT. Identifier metadata (`connectionGeneration`, `attemptId`, `sourceEventId`)
// is grammar-checked before projection. Payload fields (`toolName`, `text`,
// `toolArgs`) are pre-bounded host-side (Hard Rule 25) before any large buffer
// allocation, deep clone, or `JSON.stringify`, then passed through the shared
// truncation, sanitization, and whole-entry byte budget. An event that is not
// the normalized shape is shown as a `parse-omission` gap holding none of its
// content.
//
// Zero `vscode` imports (docs/hard-rules.md rule 13).

import { LIVE_LOG_ENTRY_MAX_BYTES, type LiveLogCoverageReason } from '../../contracts/phase-log-bounds';
import {
  AGENT_DISPLAY_TITLE_PRE_CAP_CHARS,
  sanitizeAgentDisplayTitle
} from '../acp-runtime/agent-identifier';
import { cutToBytes, fitEntryToBudget } from './live-log-entry-budget';
import { coverageGapEntry } from './live-log-snapshot';
import { sanitizeDisplayEntryBody } from './phase-log-sanitizer';
import {
  TRUNCATE_SANITIZE_LOOKAHEAD_BYTES,
  truncateDisplayEntryBody,
  type TruncateCaps
} from './phase-log-truncator';
import type { PhaseLogDisplayEntry, ToolArgumentValue } from './types';

/** Longest connection generation, attempt id or source event id accepted. */
export const ACP_IDENTIFIER_MAX_LENGTH = 256;

/** Longest `toolName` kept at the ACP display boundary (UTF-16 code units). */
export const ACP_TOOL_NAME_MAX_LENGTH = 128;

/** Maximum nesting depth walked for untrusted ACP `toolArgs` before elision. */
export const ACP_TOOL_ARGS_MAX_DEPTH = 8;

/** Maximum nodes/properties walked for untrusted ACP `toolArgs` before truncation. */
export const ACP_TOOL_ARGS_MAX_NODES = 256;

export const ACP_EVENT_ORIGINS = Object.freeze(['live', 'history'] as const);
export type AcpEventOrigin = (typeof ACP_EVENT_ORIGINS)[number];

export const ACP_EVENT_KINDS = Object.freeze(['message', 'tool-call', 'tool-result', 'plan', 'status'] as const);
export type AcpEventKind = (typeof ACP_EVENT_KINDS)[number];

/** One normalized ACP event, as F13 delivers it. */
export interface AcpNormalizedEvent {
  readonly connectionGeneration: string;
  readonly attemptId: string | null;
  readonly sourceEventId: string | null;
  readonly origin: AcpEventOrigin;
  readonly kind: AcpEventKind;
  readonly text?: string;
  readonly toolName?: string;
  readonly toolArgs?: unknown;
}

/** One projected row, with the identity it was projected under. */
export interface AcpProjectedItem {
  readonly streamSeq: number;
  readonly segment: number;
  readonly origin: AcpEventOrigin;
  readonly connectionGeneration: string | null;
  readonly attemptId: string | null;
  readonly sourceEventId: string | null;
  readonly entry: PhaseLogDisplayEntry;
}

export interface AcpProjectionState {
  readonly nextStreamSeq: number;
  readonly segment: number;
  /** The generation, origin and id presence of the last projected event; null before the first. */
  readonly last: {
    readonly connectionGeneration: string;
    readonly origin: AcpEventOrigin;
    readonly hadSourceEventId: boolean;
  } | null;
}

export interface AcpProjectionOptions {
  readonly sanitize: (text: string) => string;
  readonly caps: TruncateCaps;
}

export interface AcpProjectionResult {
  readonly state: AcpProjectionState;
  readonly items: readonly AcpProjectedItem[];
  /** How many gap rows of each reason this call produced, for the counters. */
  readonly gaps: Readonly<Partial<Record<LiveLogCoverageReason, number>>>;
}

const MARKER_SUMMARY: Readonly<Record<AcpEventOrigin, string>> = Object.freeze({
  history: 'Replayed history from the agent',
  live: 'Live activity'
});

const ORIGINS: ReadonlySet<string> = new Set(ACP_EVENT_ORIGINS);
const KINDS: ReadonlySet<string> = new Set(ACP_EVENT_KINDS);

/**
 * Rejects Unicode control (Cc), format/bidi (Cf), lone surrogate (Cs),
 * line separator (Zl), and paragraph separator (Zp) characters in ACP identifiers.
 */
const DISALLOWED_IDENTIFIER_CHAR_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;

/** Serialized UTF-8 byte length of `{"__elided":true}`. */
const ELIDED_SENTINEL_BYTES = 17;

/**
 * Lookahead retained by `preBoundText` past `perFieldBytes` so `truncateDisplayEntryBody`
 * sees the full `TRUNCATE_SANITIZE_LOOKAHEAD_BYTES` window plus the exact next character
 * for mid-token cut detection before sanitizing and snapping to `perFieldBytes` (SR-A2 #2).
 */
const PRE_BOUND_LOOKAHEAD_BYTES = TRUNCATE_SANITIZE_LOOKAHEAD_BYTES + 64;

type BodyTruncatedMap = NonNullable<PhaseLogDisplayEntry['bodyTruncated']>;

interface BuiltBody {
  readonly kind: PhaseLogDisplayEntry['kind'];
  readonly body: PhaseLogDisplayEntry['body'];
  readonly preTruncated: BodyTruncatedMap | null;
}

interface ToolArgsWalkState {
  nodes: number;
  bytes: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
  readonly ancestors: WeakSet<object>;
}

type WalkOutcome =
  | { readonly ok: true; readonly value: ToolArgumentValue }
  | { readonly ok: false };

const WALK_OVERFLOW: WalkOutcome = Object.freeze({ ok: false });

function walkOk(value: ToolArgumentValue): WalkOutcome {
  return { ok: true, value };
}

export function initialAcpProjectionState(): AcpProjectionState {
  return Object.freeze({ nextStreamSeq: 0, segment: 0, last: null });
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= ACP_IDENTIFIER_MAX_LENGTH &&
    !DISALLOWED_IDENTIFIER_CHAR_RE.test(value)
  );
}

function isOptionalIdentifier(value: unknown): value is string | null {
  return value === null || isIdentifier(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/** The event when it is the normalized shape, else null. */
export function asAcpNormalizedEvent(value: unknown): AcpNormalizedEvent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (!isIdentifier(event['connectionGeneration'])) return null;
  if (!isOptionalIdentifier(event['attemptId']) || !isOptionalIdentifier(event['sourceEventId'])) return null;
  if (typeof event['origin'] !== 'string' || !ORIGINS.has(event['origin'])) return null;
  if (typeof event['kind'] !== 'string' || !KINDS.has(event['kind'])) return null;
  if (!isOptionalString(event['text']) || !isOptionalString(event['toolName'])) return null;
  if (event['kind'] === 'tool-call' ? typeof event['toolName'] !== 'string' : typeof event['text'] !== 'string') {
    return null;
  }
  return event as unknown as AcpNormalizedEvent;
}

function effectivePerFieldBytes(caps: TruncateCaps): number {
  const raw = Number.isFinite(caps.perFieldBytes) ? Math.floor(caps.perFieldBytes) : 0;
  return Math.min(Math.max(0, raw), LIVE_LOG_ENTRY_MAX_BYTES);
}

/**
 * Pre-bounds untrusted text without allocating a multi-MiB Buffer via `Buffer.from`, preserving
 * exact `originalLength` in UTF-8 bytes when `text` exceeds `maxBytes` while retaining a bounded
 * lookahead window so `truncateDisplayEntryBody` can run `options.sanitize` BEFORE snapping to
 * `maxBytes` (SR-A2 #2 / CR-A2 #3).
 */
function preBoundText(text: string, maxBytes: number): {
  readonly value: string;
  readonly originalLength: number | null;
} {
  if (text.length * 3 <= maxBytes) {
    return { value: text, originalLength: null };
  }
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength <= maxBytes) {
    return { value: text, originalLength: null };
  }
  const lookaheadCap = maxBytes + PRE_BOUND_LOOKAHEAD_BYTES;
  if (byteLength <= lookaheadCap) {
    return { value: text, originalLength: byteLength };
  }
  return {
    value: cutToBytes(text, lookaheadCap),
    originalLength: byteLength
  };
}

/**
 * Measures the UTF-8 byte length of `JSON.stringify(value)` with early exit
 * as soon as the cumulative total exceeds `limit`, avoiding any string allocation.
 */
function measureJsonStringBytes(value: string, limit: number): number {
  let bytes = 2;
  if (bytes > limit) return bytes;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x22 || code === 0x5c || (code >= 0x08 && code <= 0x0d && code !== 0x0b)) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += 6;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= HIGH_SURROGATE_FIRST && code <= HIGH_SURROGATE_LAST) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= LOW_SURROGATE_FIRST && next <= LOW_SURROGATE_LAST) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= LOW_SURROGATE_FIRST && code <= LOW_SURROGATE_LAST) {
      bytes += 6;
    } else {
      bytes += 3;
    }
    if (bytes > limit) return bytes;
  }
  return bytes;
}

function walkToolArgument(value: unknown, depth: number, state: ToolArgsWalkState): WalkOutcome {
  state.nodes += 1;
  if (state.nodes > state.maxNodes) {
    return WALK_OVERFLOW;
  }
  if (depth >= ACP_TOOL_ARGS_MAX_DEPTH) {
    state.bytes += ELIDED_SENTINEL_BYTES;
    return state.bytes > state.maxBytes ? WALK_OVERFLOW : walkOk({ __elided: true });
  }
  if (value === null) {
    state.bytes += 4;
    return state.bytes > state.maxBytes ? WALK_OVERFLOW : walkOk(null);
  }
  const kind = typeof value;
  if (kind === 'boolean') {
    state.bytes += value ? 4 : 5;
    return state.bytes > state.maxBytes ? WALK_OVERFLOW : walkOk(value as boolean);
  }
  if (kind === 'number') {
    const num = value as number;
    if (!Number.isFinite(num)) {
      state.bytes += 4;
      return state.bytes > state.maxBytes ? WALK_OVERFLOW : walkOk(null);
    }
    state.bytes += String(num).length;
    return state.bytes > state.maxBytes ? WALK_OVERFLOW : walkOk(num);
  }
  if (kind === 'string') {
    const str = value as string;
    const remaining = state.maxBytes - state.bytes;
    if (str.length + 2 > remaining) {
      state.bytes += Math.max(str.length + 2, remaining + 1);
      return WALK_OVERFLOW;
    }
    const jsonBytes = measureJsonStringBytes(str, remaining);
    state.bytes += jsonBytes;
    return state.bytes > state.maxBytes ? WALK_OVERFLOW : walkOk(str);
  }
  if (kind !== 'object') {
    // undefined, function, symbol, bigint — coerce to null for safety.
    state.bytes += 4;
    return state.bytes > state.maxBytes ? WALK_OVERFLOW : walkOk(null);
  }

  const obj = value as object;
  if (state.ancestors.has(obj)) {
    state.bytes += ELIDED_SENTINEL_BYTES;
    return state.bytes > state.maxBytes ? WALK_OVERFLOW : walkOk({ __elided: true });
  }

  state.ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      state.bytes += 2;
      if (state.bytes > state.maxBytes) return WALK_OVERFLOW;
      const out: ToolArgumentValue[] = [];
      for (let i = 0; i < obj.length; i += 1) {
        if (i > 0) {
          state.bytes += 1;
          if (state.bytes > state.maxBytes) return WALK_OVERFLOW;
        }
        let item: unknown;
        try {
          item = obj[i];
        } catch {
          return WALK_OVERFLOW;
        }
        const child = walkToolArgument(item, depth + 1, state);
        if (!child.ok) return WALK_OVERFLOW;
        out.push(child.value);
      }
      return walkOk(out);
    }

    state.bytes += 2;
    if (state.bytes > state.maxBytes) return WALK_OVERFLOW;
    const out: { [k: string]: ToolArgumentValue } = {};
    const record = obj as Record<string, unknown>;
    let first = true;
    try {
      for (const key in record) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
        if (!first) {
          state.bytes += 1;
        }
        first = false;
        const keyRemaining = state.maxBytes - state.bytes - 1;
        if (key.length + 2 > keyRemaining) {
          state.bytes += Math.max(key.length + 3, keyRemaining + 2);
          return WALK_OVERFLOW;
        }
        const keyBytes = measureJsonStringBytes(key, keyRemaining) + 1;
        state.bytes += keyBytes;
        if (state.bytes > state.maxBytes) return WALK_OVERFLOW;
        let propVal: unknown;
        try {
          propVal = record[key];
        } catch {
          return WALK_OVERFLOW;
        }
        const child = walkToolArgument(propVal, depth + 1, state);
        if (!child.ok) return WALK_OVERFLOW;
        Object.defineProperty(out, key, {
          value: child.value,
          enumerable: true,
          writable: true,
          configurable: true
        });
      }
    } catch {
      return WALK_OVERFLOW;
    }
    return walkOk(out);
  } finally {
    state.ancestors.delete(obj);
  }
}

function truncatedToolUseBody(toolName: string, originalBytes: number): BuiltBody {
  const safeBytes = Math.max(originalBytes, 1);
  const sentinel: ToolArgumentValue = { __truncated: true, originalBytes: safeBytes };
  return {
    kind: 'tool-use',
    body: {
      toolName,
      toolInput: JSON.stringify(sentinel),
      toolArguments: sentinel
    },
    preTruncated: {
      toolInput: { originalLength: safeBytes },
      toolArguments: { originalLength: safeBytes }
    }
  };
}

function buildBoundedToolUseBody(
  rawToolName: string,
  rawToolArgs: unknown,
  maxBytes: number,
  sanitize: (text: string) => string
): BuiltBody {
  // SR-A3 #3: apply caller `sanitize` inside `sanitizeAgentDisplayTitle` BEFORE the 4096 pre-cap
  // slice while keeping up to the pre-cap title budget so `truncateDisplayEntryBody` and
  // `sanitizeDisplayEntryBody` apply the 128-byte/char cap without secret-pull leakage.
  const toolName =
    sanitizeAgentDisplayTitle(rawToolName, AGENT_DISPLAY_TITLE_PRE_CAP_CHARS, sanitize) ?? 'tool';
  if (rawToolArgs === undefined) {
    return { kind: 'tool-use', body: { toolName, toolInput: '' }, preTruncated: null };
  }
  if (typeof rawToolArgs === 'string') {
    const boundedInput = preBoundText(rawToolArgs, maxBytes);
    if (boundedInput.originalLength !== null) {
      const originalArgsBytes = boundedInput.originalLength + 12;
      return {
        kind: 'tool-use',
        body: {
          toolName,
          toolInput: boundedInput.value,
          toolArguments: { __truncated: true, originalBytes: originalArgsBytes }
        },
        preTruncated: {
          toolInput: { originalLength: boundedInput.originalLength },
          toolArguments: { originalLength: originalArgsBytes }
        }
      };
    }
    const wrappedBytes = 10 + measureJsonStringBytes(rawToolArgs, maxBytes);
    if (wrappedBytes > maxBytes) {
      return {
        kind: 'tool-use',
        body: {
          toolName,
          toolInput: rawToolArgs,
          toolArguments: { __truncated: true, originalBytes: wrappedBytes }
        },
        preTruncated: {
          toolArguments: { originalLength: wrappedBytes }
        }
      };
    }
    return {
      kind: 'tool-use',
      body: { toolName, toolInput: rawToolArgs, toolArguments: { value: rawToolArgs } },
      preTruncated: null
    };
  }
  if (rawToolArgs === null) {
    return { kind: 'tool-use', body: { toolName, toolInput: 'null', toolArguments: null }, preTruncated: null };
  }
  if (typeof rawToolArgs === 'boolean') {
    return {
      kind: 'tool-use',
      body: { toolName, toolInput: rawToolArgs ? 'true' : 'false', toolArguments: rawToolArgs },
      preTruncated: null
    };
  }
  if (typeof rawToolArgs === 'number') {
    const normalized = Number.isFinite(rawToolArgs) ? rawToolArgs : null;
    return {
      kind: 'tool-use',
      body: {
        toolName,
        toolInput: normalized === null ? 'null' : String(normalized),
        toolArguments: normalized
      },
      preTruncated: null
    };
  }
  if (typeof rawToolArgs !== 'object') {
    return { kind: 'tool-use', body: { toolName, toolInput: '', toolArguments: null }, preTruncated: null };
  }

  const state: ToolArgsWalkState = {
    nodes: 0,
    bytes: 0,
    maxNodes: ACP_TOOL_ARGS_MAX_NODES,
    maxBytes,
    ancestors: new WeakSet<object>()
  };
  const walked = walkToolArgument(rawToolArgs, 0, state);
  if (!walked.ok) {
    return truncatedToolUseBody(toolName, state.bytes);
  }
  const toolInput = JSON.stringify(walked.value);
  const actualBytes = Buffer.byteLength(toolInput, 'utf8');
  if (actualBytes > maxBytes) {
    return truncatedToolUseBody(toolName, actualBytes);
  }
  return {
    kind: 'tool-use',
    body: { toolName, toolInput, toolArguments: walked.value },
    preTruncated: null
  };
}

function bodyOf(
  event: AcpNormalizedEvent,
  maxBytes: number,
  sanitize: (text: string) => string
): BuiltBody {
  if (event.kind === 'tool-call') {
    const rawToolName = event.toolName ?? '';
    const built = buildBoundedToolUseBody(rawToolName, event.toolArgs, maxBytes, sanitize);
    const toolNameCapBytes = Math.min(maxBytes, ACP_TOOL_NAME_MAX_LENGTH);
    const rawToolNameBytes =
      rawToolName.length * 3 > toolNameCapBytes ? Buffer.byteLength(rawToolName, 'utf8') : 0;
    if (rawToolNameBytes > toolNameCapBytes) {
      return {
        ...built,
        preTruncated: mergeBodyTruncated(
          { toolName: { originalLength: rawToolNameBytes } },
          built.preTruncated
        )
      };
    }
    return built;
  }
  const bounded = preBoundText(event.text ?? '', maxBytes);
  switch (event.kind) {
    case 'message':
      return {
        kind: 'assistant-text',
        body: { text: bounded.value },
        preTruncated: bounded.originalLength === null ? null : { text: { originalLength: bounded.originalLength } }
      };
    case 'tool-result':
      return {
        kind: 'tool-result',
        body: { toolResult: bounded.value },
        preTruncated:
          bounded.originalLength === null ? null : { toolResult: { originalLength: bounded.originalLength } }
      };
    case 'plan':
      return {
        kind: 'system',
        body: { systemSubtype: 'acp-plan', systemSummary: bounded.value },
        preTruncated:
          bounded.originalLength === null ? null : { systemSummary: { originalLength: bounded.originalLength } }
      };
    case 'status':
      return {
        kind: 'system',
        body: { systemSubtype: 'acp-status', systemSummary: bounded.value },
        preTruncated:
          bounded.originalLength === null ? null : { systemSummary: { originalLength: bounded.originalLength } }
      };
  }
}

function mergeBodyTruncated(
  preTruncated: BodyTruncatedMap | null,
  postTruncated: PhaseLogDisplayEntry['bodyTruncated']
): PhaseLogDisplayEntry['bodyTruncated'] {
  if (preTruncated === null) return postTruncated;
  if (postTruncated === null) return preTruncated;
  const merged: { -readonly [K in keyof BodyTruncatedMap]: BodyTruncatedMap[K] } = { ...preTruncated };
  for (const key of Object.keys(postTruncated) as Array<keyof BodyTruncatedMap>) {
    const post = postTruncated[key];
    if (post === undefined) continue;
    const pre = merged[key];
    merged[key] =
      pre === undefined
        ? post
        : { originalLength: Math.max(pre.originalLength, post.originalLength) };
  }
  return merged;
}

/** Accumulates one call's rows; the state it ends with is returned frozen. */
class Projection {
  readonly items: AcpProjectedItem[] = [];
  readonly gaps: Partial<Record<LiveLogCoverageReason, number>> = {};
  private nextStreamSeq: number;
  private segment: number;
  private last: AcpProjectionState['last'];
  private omitted = 0;
  private readonly perFieldBytes: number;

  constructor(state: AcpProjectionState, private readonly options: AcpProjectionOptions) {
    this.nextStreamSeq = state.nextStreamSeq;
    this.segment = state.segment;
    this.last = state.last;
    this.perFieldBytes = effectivePerFieldBytes(options.caps);
  }

  accept(value: unknown): void {
    const event = asAcpNormalizedEvent(value);
    if (event === null) {
      this.omitted += 1;
      return;
    }
    this.flushOmitted();
    this.openSegmentIfNeeded(event);
    const { kind, body, preTruncated } = bodyOf(event, this.perFieldBytes, this.options.sanitize);
    this.push(event, this.bounded({ seq: 0, kind, ts: null, body, bodyTruncated: null }, preTruncated));
    this.last = {
      connectionGeneration: event.connectionGeneration,
      origin: event.origin,
      hadSourceEventId: event.sourceEventId !== null
    };
  }

  finish(): AcpProjectionResult {
    this.flushOmitted();
    const state: AcpProjectionState = Object.freeze({
      nextStreamSeq: this.nextStreamSeq,
      segment: this.segment,
      last: this.last === null ? null : Object.freeze({ ...this.last })
    });
    return { state, items: this.items, gaps: this.gaps };
  }

  private openSegmentIfNeeded(event: AcpNormalizedEvent): void {
    const last = this.last;
    if (last === null) {
      if (event.origin === 'history') this.pushMarker(event);
      return;
    }
    if (event.connectionGeneration !== last.connectionGeneration) {
      this.segment += 1;
      this.pushGap(event, 'transport-gap');
      if (event.origin !== last.origin) this.pushMarker(event);
      return;
    }
    if (event.origin !== last.origin) {
      this.segment += 1;
      this.pushMarker(event);
      return;
    }
    if (event.origin === 'history' && last.hadSourceEventId && event.sourceEventId === null) {
      this.segment += 1;
      this.pushGap(event, 'transport-gap');
    }
  }

  private flushOmitted(): void {
    if (this.omitted === 0) return;
    const origin = this.last?.origin ?? 'live';
    this.pushRow(origin, this.last?.connectionGeneration ?? null, null, null, coverageGapEntry('parse-omission', this.omitted));
    this.countGap('parse-omission');
    this.omitted = 0;
  }

  private pushGap(event: AcpNormalizedEvent, reason: LiveLogCoverageReason): void {
    this.pushRow(event.origin, event.connectionGeneration, event.attemptId, null, coverageGapEntry(reason, 1));
    this.countGap(reason);
  }

  private pushMarker(event: AcpNormalizedEvent): void {
    const body = { systemSubtype: `acp-${event.origin}`, systemSummary: MARKER_SUMMARY[event.origin] };
    const entry: PhaseLogDisplayEntry = { seq: 0, kind: 'system', ts: null, body, bodyTruncated: null };
    this.pushRow(event.origin, event.connectionGeneration, event.attemptId, null, entry);
  }

  private push(event: AcpNormalizedEvent, entry: PhaseLogDisplayEntry): void {
    this.pushRow(event.origin, event.connectionGeneration, event.attemptId, event.sourceEventId, entry);
  }

  private pushRow(
    origin: AcpEventOrigin,
    connectionGeneration: string | null,
    attemptId: string | null,
    sourceEventId: string | null,
    entry: PhaseLogDisplayEntry
  ): void {
    const streamSeq = this.nextStreamSeq;
    this.nextStreamSeq += 1;
    this.items.push({
      streamSeq,
      segment: this.segment,
      origin,
      connectionGeneration,
      attemptId,
      sourceEventId,
      entry: { ...entry, seq: streamSeq }
    });
  }

  private countGap(reason: LiveLogCoverageReason): void {
    this.gaps[reason] = (this.gaps[reason] ?? 0) + 1;
  }

  private bounded(
    entry: PhaseLogDisplayEntry,
    preTruncated: BodyTruncatedMap | null
  ): PhaseLogDisplayEntry {
    const truncated = truncateDisplayEntryBody(entry, {
      perFieldBytes: this.perFieldBytes,
      sanitize: this.options.sanitize
    });
    const merged = mergeBodyTruncated(preTruncated, truncated.bodyTruncated);
    const withTruncated: PhaseLogDisplayEntry =
      merged === truncated.bodyTruncated ? truncated : { ...truncated, bodyTruncated: merged };
    const sanitized = sanitizeDisplayEntryBody(withTruncated, this.options.sanitize);
    return fitEntryToBudget(sanitized, LIVE_LOG_ENTRY_MAX_BYTES);
  }
}

/**
 * Projects `events` after `state`. Pure: the given state is not changed, and
 * the returned state carries the segment, sequence and last identity forward.
 */
export function projectAcpEvents(
  state: AcpProjectionState,
  events: readonly unknown[],
  options: AcpProjectionOptions
): AcpProjectionResult {
  const projection = new Projection(state, options);
  for (const value of events) projection.accept(value);
  return projection.finish();
}
