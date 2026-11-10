// FR-R6-F07 T038 (FR-017) — projects F13's normalized ACP events to display
// entries.
//
// F13 does not exist yet. This module fixes the shape F13 maps its decoder to,
// and is qualified against fixtures only. No production code calls it.
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
// CONTENT. Every entry passes the same per-field truncation, sanitization and
// entry budget as a tail session's entries. An event that is not the normalized
// shape is shown as a `parse-omission` gap holding none of its content.

import { LIVE_LOG_ENTRY_MAX_BYTES, type LiveLogCoverageReason } from '../../contracts/phase-log-bounds';
import { fitEntryToBudget } from './live-log-entry-budget';
import { coverageGapEntry } from './live-log-snapshot';
import { toolUseBody } from './phase-log-display-projector';
import { sanitizeDisplayEntryBody } from './phase-log-sanitizer';
import { truncateDisplayEntryBody, type TruncateCaps } from './phase-log-truncator';
import type { PhaseLogDisplayEntry } from './types';

/** Longest connection generation, attempt id or source event id accepted. */
export const ACP_IDENTIFIER_MAX_LENGTH = 256;

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

export function initialAcpProjectionState(): AcpProjectionState {
  return Object.freeze({ nextStreamSeq: 0, segment: 0, last: null });
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= ACP_IDENTIFIER_MAX_LENGTH;
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

function bodyOf(event: AcpNormalizedEvent): Pick<PhaseLogDisplayEntry, 'kind' | 'body'> {
  const text = event.text ?? '';
  switch (event.kind) {
    case 'message':
      return { kind: 'assistant-text', body: { text } };
    case 'tool-call':
      return { kind: 'tool-use', body: toolUseBody(event.toolName ?? '', event.toolArgs) };
    case 'tool-result':
      return { kind: 'tool-result', body: { toolResult: text } };
    case 'plan':
      return { kind: 'system', body: { systemSubtype: 'acp-plan', systemSummary: text } };
    case 'status':
      return { kind: 'system', body: { systemSubtype: 'acp-status', systemSummary: text } };
  }
}

/** Accumulates one call's rows; the state it ends with is returned frozen. */
class Projection {
  readonly items: AcpProjectedItem[] = [];
  readonly gaps: Partial<Record<LiveLogCoverageReason, number>> = {};
  private nextStreamSeq: number;
  private segment: number;
  private last: AcpProjectionState['last'];
  private omitted = 0;

  constructor(state: AcpProjectionState, private readonly options: AcpProjectionOptions) {
    this.nextStreamSeq = state.nextStreamSeq;
    this.segment = state.segment;
    this.last = state.last;
  }

  accept(value: unknown): void {
    const event = asAcpNormalizedEvent(value);
    if (event === null) {
      this.omitted += 1;
      return;
    }
    this.flushOmitted();
    this.openSegmentIfNeeded(event);
    const { kind, body } = bodyOf(event);
    this.push(event, this.bounded({ seq: 0, kind, ts: null, body, bodyTruncated: null }));
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

  private bounded(entry: PhaseLogDisplayEntry): PhaseLogDisplayEntry {
    const truncated = truncateDisplayEntryBody(entry, this.options.caps);
    const sanitized = sanitizeDisplayEntryBody(truncated, this.options.sanitize);
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
