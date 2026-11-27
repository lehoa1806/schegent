/**
 * Post-merge review Finding 3 — durable decoding, preservation, and bounded
 * diagnostics for the terminal-transition settlement journal
 * (`KEYS.terminalTransitionIntent`).
 *
 * Mirrors the `connected-run-migrator.ts` contract:
 *   - Decodes persisted journal records into readable v1 intents PLUS preserved
 *     opaque sibling entries (such as future-schema or partially unreadable
 *     entries), so healthy sibling saves, clears, and verdict migrations NEVER
 *     drop unreadable recovery records.
 *   - Distinguishes an absent journal (`undefined`) from an unreadable whole
 *     envelope (`null`, array, primitive, corrupt SQLite JSON, or unsupported
 *     top-level single-intent `schemaVersion`), refusing whole-document writes
 *     so original persisted bytes stay intact for operator recovery.
 *   - Bounds preserved opaque payloads (256 entries / 16 MiB) and compact
 *     identity tombstones (512 IDs / 64 KiB), failing closed if even identity
 *     markers cannot fit.
 *
 * Zero `vscode` imports (keeps module headless-testable).
 */
import {
  MAX_OPERATIONAL_JSON_DEPTH,
  deepFreezeValue,
  isPlainRecord,
  setOwnProp
} from '../lib/operational-value-helpers';
import type { TerminalTransitionIntent, WorkflowRun } from './workflow-run';
import { QueueMutationRejected } from './workspace-state-types';

export const TERMINAL_JOURNAL_PRESERVED_MAX_COUNT = 256;
export const TERMINAL_JOURNAL_PRESERVED_MAX_BYTES = 16 * 1024 * 1024;
export const TERMINAL_JOURNAL_TOMBSTONE_MAX_COUNT = 512;
export const TERMINAL_JOURNAL_TOMBSTONE_MAX_BYTES = 64 * 1024;

const DIAGNOSTIC_CAP = 20;
const DIAGNOSTIC_ID_MAX = 128;

export type TerminalJournalEntryRefusalReason =
  | 'unsupported-schema-version'
  | 'invalid-entry';

export type TerminalJournalEnvelopeRefusalReason =
  | 'corrupt-envelope'
  | 'unsupported-envelope-version';

export interface TerminalJournalDiagnostic {
  readonly runId: string;
  readonly reason: TerminalJournalEntryRefusalReason;
}

export type DecodedTerminalTransitionJournal =
  | {
      readonly status: 'absent';
      readonly readable: Readonly<Record<string, TerminalTransitionIntent>>;
      readonly preservedOpaque: Readonly<Record<string, unknown>>;
      readonly diagnostics: readonly TerminalJournalDiagnostic[];
    }
  | {
      readonly status: 'unreadable-envelope';
      readonly reason: TerminalJournalEnvelopeRefusalReason;
      readonly readable: Readonly<Record<string, TerminalTransitionIntent>>;
      readonly preservedOpaque: Readonly<Record<string, unknown>>;
      readonly diagnostics: readonly TerminalJournalDiagnostic[];
    }
  | {
      readonly status: 'ok';
      readonly readable: Readonly<Record<string, TerminalTransitionIntent>>;
      readonly preservedOpaque: Readonly<Record<string, unknown>>;
      readonly diagnostics: readonly TerminalJournalDiagnostic[];
    };

export interface TerminalTransitionJournalInspection {
  readonly status: 'ok' | 'degraded' | 'unreadable-envelope';
  readonly envelopeReason?: TerminalJournalEnvelopeRefusalReason;
  readonly readableCount: number;
  readonly preservedCount: number;
  readonly preservedRunIds: readonly string[];
  readonly diagnostics: readonly TerminalJournalDiagnostic[];
}

const EMPTY_RECORD = Object.freeze({}) as Readonly<Record<string, never>>;
const EMPTY_DIAGNOSTICS: readonly TerminalJournalDiagnostic[] = Object.freeze([]);

function sanitizeDiagnosticId(key: string): string {
  let cleaned = '';
  const limit = Math.min(key.length, DIAGNOSTIC_ID_MAX);
  for (let i = 0; i < limit; i += 1) {
    const code = key.charCodeAt(i);
    cleaned += code <= 0x1f || code === 0x7f ? '?' : key.charAt(i);
  }
  return key.length > DIAGNOSTIC_ID_MAX ? `${cleaned}...` : cleaned;
}

/** Validates one v1 `TerminalTransitionIntent` record; returns `null` for any other version or shape. */
export function asTerminalTransitionIntent(raw: unknown): TerminalTransitionIntent | null {
  if (!isPlainRecord(raw)) return null;
  const intent = raw as Partial<TerminalTransitionIntent> & { description?: unknown };
  if (
    intent.schemaVersion !== 1 ||
    !isPlainRecord(intent.run) ||
    typeof (intent.run as Partial<WorkflowRun>).id !== 'string' ||
    ((intent.run as Partial<WorkflowRun>).id as string).length === 0 ||
    typeof intent.createdAt !== 'number'
  ) {
    return null;
  }
  if (intent.description !== undefined && typeof intent.description !== 'string') {
    const { description: _dropped, ...rest } = intent;
    return rest as TerminalTransitionIntent;
  }
  return intent as TerminalTransitionIntent;
}

/** True when a top-level plain object looks like a single-intent envelope rather than a run-id map. */
function isTopLevelSingleIntentEnvelope(value: Record<string, unknown>): boolean {
  return Object.hasOwn(value, 'schemaVersion') && !isPlainRecord(value.schemaVersion);
}

/**
 * Decodes the persisted `KEYS.terminalTransitionIntent` value into readable v1
 * intents and preserved opaque sibling records, or flags an unreadable whole
 * envelope (`null`, non-object, corrupt SQLite sentinel, or future top-level
 * single-intent schema).
 */
export function decodeTerminalTransitionJournal(raw: unknown): DecodedTerminalTransitionJournal {
  if (raw === undefined) {
    return {
      status: 'absent',
      readable: EMPTY_RECORD,
      preservedOpaque: EMPTY_RECORD,
      diagnostics: EMPTY_DIAGNOSTICS
    };
  }
  if (!isPlainRecord(raw)) {
    return {
      status: 'unreadable-envelope',
      reason: 'corrupt-envelope',
      readable: EMPTY_RECORD,
      preservedOpaque: EMPTY_RECORD,
      diagnostics: EMPTY_DIAGNOSTICS
    };
  }
  const legacy = asTerminalTransitionIntent(raw);
  if (legacy !== null) {
    const readable: Record<string, TerminalTransitionIntent> = {};
    setOwnProp(readable, legacy.run.id, legacy);
    return {
      status: 'ok',
      readable,
      preservedOpaque: EMPTY_RECORD,
      diagnostics: EMPTY_DIAGNOSTICS
    };
  }
  if (isTopLevelSingleIntentEnvelope(raw)) {
    const sv = raw.schemaVersion;
    return {
      status: 'unreadable-envelope',
      reason:
        typeof sv === 'number' && sv !== 1 ? 'unsupported-envelope-version' : 'corrupt-envelope',
      readable: EMPTY_RECORD,
      preservedOpaque: EMPTY_RECORD,
      diagnostics: EMPTY_DIAGNOSTICS
    };
  }

  const readable: Record<string, TerminalTransitionIntent> = {};
  const preservedOpaque: Record<string, unknown> = {};
  const diagnostics: TerminalJournalDiagnostic[] = [];

  for (const [runId, entry] of Object.entries(raw)) {
    const intent = asTerminalTransitionIntent(entry);
    if (intent !== null) {
      setOwnProp(readable, runId, intent);
      continue;
    }
    const reason: TerminalJournalEntryRefusalReason =
      isPlainRecord(entry) && Object.hasOwn(entry, 'schemaVersion') && entry.schemaVersion !== 1
        ? 'unsupported-schema-version'
        : 'invalid-entry';
    setOwnProp(preservedOpaque, runId, entry);
    if (diagnostics.length < DIAGNOSTIC_CAP) {
      diagnostics.push({ runId: sanitizeDiagnosticId(runId), reason });
    }
  }

  return { status: 'ok', readable, preservedOpaque, diagnostics };
}

export function inspectDecodedTerminalJournal(
  decoded: DecodedTerminalTransitionJournal
): TerminalTransitionJournalInspection {
  if (decoded.status === 'unreadable-envelope') {
    return Object.freeze({
      status: 'unreadable-envelope',
      envelopeReason: decoded.reason,
      readableCount: 0,
      preservedCount: 0,
      preservedRunIds: Object.freeze([]),
      diagnostics: EMPTY_DIAGNOSTICS
    });
  }
  const readableCount = Object.keys(decoded.readable).length;
  const preservedKeys = Object.keys(decoded.preservedOpaque);
  return Object.freeze({
    status: preservedKeys.length > 0 ? 'degraded' : 'ok',
    readableCount,
    preservedCount: preservedKeys.length,
    preservedRunIds: Object.freeze(preservedKeys.slice(0, DIAGNOSTIC_CAP).map(sanitizeDiagnosticId)),
    diagnostics: Object.freeze([...decoded.diagnostics])
  });
}

export function terminalJournalWarning(inspection: TerminalTransitionJournalInspection): string {
  if (inspection.status === 'unreadable-envelope') {
    return (
      `terminal-transition: stored settlement journal envelope is unreadable ` +
      `(${inspection.envelopeReason ?? 'corrupt-envelope'}); original bytes preserved in place ` +
      'and journal writes/replay refused until inspected or restored from backup'
    );
  }
  const named = inspection.diagnostics
    .map((entry) => `${entry.runId} (${entry.reason})`)
    .join(', ');
  const unnamed = Math.max(0, inspection.preservedCount - inspection.diagnostics.length);
  const more = unnamed > 0 ? `, and ${unnamed} more` : '';
  return (
    `terminal-transition: preserved ${inspection.preservedCount} unreadable or unsupported ` +
    `settlement journal entr${inspection.preservedCount === 1 ? 'y' : 'ies'} in place: ${named}${more}`
  );
}

function isJsonTreeSafe(value: unknown, depth: number, seen: WeakSet<object>): boolean {
  if (value === null || typeof value !== 'object') {
    return typeof value !== 'bigint' && typeof value !== 'symbol' && typeof value !== 'function';
  }
  if (depth > MAX_OPERATIONAL_JSON_DEPTH) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        if (!isJsonTreeSafe(value[i], depth + 1, seen)) return false;
      }
      return true;
    }
    if (!isPlainRecord(value)) return false;
    for (const key of Object.keys(value)) {
      if (!isJsonTreeSafe(value[key], depth + 1, seen)) return false;
    }
    return true;
  } finally {
    seen.delete(value);
  }
}

function measureSafeOpaqueEntry(
  value: unknown
): { readonly ok: true; readonly bytes: number } | { readonly ok: false } {
  try {
    if (!isJsonTreeSafe(value, 1, new WeakSet<object>())) return { ok: false };
    const serialized: unknown = JSON.stringify(value);
    if (typeof serialized !== 'string') return { ok: false };
    return { ok: true, bytes: Buffer.byteLength(serialized, 'utf8') };
  } catch {
    return { ok: false };
  }
}

/**
 * Merges `nextReadable` with all `preservedOpaque` sibling entries from `decoded`.
 * Enforces count and byte budgets on preserved payloads with compact `null`
 * tombstones as overflow markers, and refuses the entire write if even identity
 * markers exceed capacity so no unreadable settlement record is ever silently dropped.
 */
export function buildPreservedTerminalJournalDocument(
  decoded: Extract<DecodedTerminalTransitionJournal, { status: 'absent' | 'ok' }>,
  nextReadable: Readonly<Record<string, TerminalTransitionIntent>>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  let payloadCount = 0;
  let payloadBytes = 0;
  let tombstoneCount = 0;
  let tombstoneBytes = 0;

  for (const [id, rawEntry] of Object.entries(decoded.preservedOpaque)) {
    const measured = measureSafeOpaqueEntry(rawEntry);
    const keyBytes = Buffer.byteLength(JSON.stringify(id), 'utf8') + 2;
    if (
      rawEntry !== null &&
      measured.ok &&
      payloadCount < TERMINAL_JOURNAL_PRESERVED_MAX_COUNT &&
      payloadBytes + keyBytes + measured.bytes <= TERMINAL_JOURNAL_PRESERVED_MAX_BYTES
    ) {
      setOwnProp(merged, id, rawEntry);
      payloadCount += 1;
      payloadBytes += keyBytes + measured.bytes;
      continue;
    }
    tombstoneCount += 1;
    tombstoneBytes += keyBytes + 4;
    if (
      tombstoneCount > TERMINAL_JOURNAL_TOMBSTONE_MAX_COUNT ||
      tombstoneBytes > TERMINAL_JOURNAL_TOMBSTONE_MAX_BYTES
    ) {
      throw new QueueMutationRejected(
        'terminal-journal-corrupt',
        'Refused terminal transition journal write: preserved unreadable entries exceed quarantine capacity.'
      );
    }
    setOwnProp(merged, id, null);
  }

  for (const [id, intent] of Object.entries(nextReadable)) {
    setOwnProp(merged, id, intent);
  }
  return merged;
}

/**
 * Deep-freezes a persisted `KEYS.terminalTransitionIntent` document on SQLite
 * reload without losing healthy siblings to a single over-depth entry, while
 * converting non-object or unfreezable top-level envelopes into an explicit
 * `null` unreadable sentinel.
 */
export function deepFreezeTerminalJournalDocument(raw: unknown): {
  readonly value: unknown;
  readonly quarantinedCount: number;
  readonly quarantinedKeys: readonly string[];
} {
  if (!isPlainRecord(raw)) {
    return { value: null, quarantinedCount: 0, quarantinedKeys: [] };
  }
  if (asTerminalTransitionIntent(raw) !== null || isTopLevelSingleIntentEnvelope(raw)) {
    try {
      return { value: deepFreezeValue(raw), quarantinedCount: 0, quarantinedKeys: [] };
    } catch {
      return { value: null, quarantinedCount: 0, quarantinedKeys: [] };
    }
  }
  const frozenMap: Record<string, unknown> = {};
  const quarantinedKeys: string[] = [];
  let quarantinedCount = 0;
  for (const [key, entry] of Object.entries(raw)) {
    try {
      setOwnProp(frozenMap, key, deepFreezeValue(entry));
    } catch {
      // Preserve exact runId presence as a compact unreadable tombstone so sibling writes never erase it.
      setOwnProp(frozenMap, key, null);
      quarantinedCount += 1;
      if (quarantinedKeys.length < DIAGNOSTIC_CAP) {
        quarantinedKeys.push(sanitizeDiagnosticId(key));
      }
    }
  }
  return {
    value: Object.freeze(frozenMap),
    quarantinedCount,
    quarantinedKeys
  };
}

