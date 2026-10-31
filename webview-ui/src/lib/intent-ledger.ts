// FR-R4-F05 (FR-019 to FR-027; contract I, I1 to I3, I5, I6, I8, I9; data-model §4) — the
// panel's ledger of unresolved intents.
//
// WHY A LEDGER. Every waiting webview helper minted a fresh `correlationId` per send. The host
// already answers a repeat of an identity with the first outcome and runs the operation once
// (`MutationCommandExecutor`), but a retry under a NEW identity is a new action. So an operator
// whose queue move outlived the webview's 5 s wait, and who clicked again, moved the task twice.
// This module is what makes a retry the same action: while an intent is unresolved, an identical
// send reuses its identity and its stored payload, and the host's replay does the rest.
//
// THE STATES. An entry is `pending` until a waiter's timer fires, then `timed-out`; the host's
// ack settles it (the entry is removed), the reuse window expires it, a signal's abort removes
// only that waiter, and `disposeIntentLedger()` discards everything. A timeout says the outcome is
// NOT YET KNOWN, never that the action failed: the host may still run it, and the waiter that
// timed out is told the outcome once, through `onLateOutcome`, if it arrives.
//
// WHAT IT IS NOT. Risk reduction, not exactly-once delivery. The ledger is per webview realm, so a
// reload, a different panel and a host restart each start a new action, and so does the reuse
// window (the host forgets an identity at the same bound, `src/contracts/ack-retention.ts`).
//
// It never calls `postCommand`: the adopting module passes a `post` callback, so every
// `postCommand(CMD_…)` stays in the module that holds it today (hard rules 11 and 30), and a
// destructive post stays inside its `useConfirm` block.

import { ACK_RETENTION_MS } from '../../../src/contracts/ack-retention';
import type { CommandType } from './messages';
import { snapshotStore } from './snapshot-store.svelte';
import type { AckResult } from './snapshot-store.svelte';

/** How long an identity is reused, from the entry's first send: the host's retention (FR-025). */
export const INTENT_REUSE_WINDOW_MS = ACK_RETENTION_MS;

/** Between the type and the canonical payload in an entry's key. */
const KEY_SEPARATOR = '\x00';

export type IntentResult =
  | { readonly kind: 'ack'; readonly ack: AckResult; readonly correlationId: string }
  | { readonly kind: 'unknown'; readonly correlationId: string }
  | { readonly kind: 'cancelled'; readonly correlationId: string };

/**
 * What a waiting helper's callers may pass: a signal aborted in their cleanup (I8), and a
 * callback for the helper's own mapped result, called once if the wait timed out and the host's
 * outcome arrives later (I6).
 */
export interface IntentWaitOptions<R> {
  readonly signal?: AbortSignal;
  readonly onLateOutcome?: (result: R) => void;
}

export interface SendIntentRequest<P> {
  readonly type: CommandType;
  readonly payload: P;
  /** Posts the command under `correlationId`. The module keeps its own `postCommand` site. */
  readonly post: (correlationId: string, payload: P) => void;
  readonly timeoutMs: number;
  /** Aborted in the caller's cleanup: removes this waiter's timer and late callback (I8). */
  readonly signal?: AbortSignal;
  /** Called once with the ack if this waiter resolved `unknown` and the ack arrives later (I6). */
  readonly onLateOutcome?: (ack: AckResult) => void;
}

interface Waiter {
  timer: ReturnType<typeof setTimeout> | null;
  /** True once the waiter has resolved, whichever way. */
  settled: boolean;
  onLateOutcome: ((ack: AckResult) => void) | undefined;
  resolve: (result: IntentResult) => void;
  detach: () => void;
}

interface IntentEntry {
  readonly key: string;
  readonly correlationId: string;
  /** As first sent; a retry re-posts this (FR-022). */
  readonly payload: unknown;
  readonly firstSentAt: number;
  readonly waiters: Set<Waiter>;
  unsubscribe: () => void;
}

const entries = new Map<string, IntentEntry>();

function uuidv4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** JSON with object keys sorted at every depth, arrays in order, `undefined` members omitted. */
function canonicalJson(value: unknown): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(',')}}`;
}

function keyOf(type: CommandType, payload: unknown): string {
  return `${type}${KEY_SEPARATOR}${canonicalJson(payload)}`;
}

function clearTimer(waiter: Waiter): void {
  if (waiter.timer !== null) {
    clearTimeout(waiter.timer);
    waiter.timer = null;
  }
}

/**
 * Resolves a waiter that has not resolved, once. Removes its timer and, unless it is still owed a
 * late outcome, its abort listener: a waiter that timed out keeps the listener, so the unmount that
 * follows can still drop its late callback (I8).
 */
function settle(waiter: Waiter, result: IntentResult): void {
  if (waiter.settled) return;
  waiter.settled = true;
  clearTimer(waiter);
  if (result.kind !== 'unknown' || waiter.onLateOutcome === undefined) waiter.detach();
  waiter.resolve(result);
}

/** Removes an entry and everything it holds. Its waiters resolve `cancelled` if still waiting. */
function discard(entry: IntentEntry): void {
  entries.delete(entry.key);
  try {
    entry.unsubscribe();
  } catch {
    // a one-shot listener's removal must not leak
  }
  for (const waiter of entry.waiters) {
    clearTimer(waiter);
    waiter.onLateOutcome = undefined;
    settle(waiter, { kind: 'cancelled', correlationId: entry.correlationId });
    waiter.detach();
  }
  entry.waiters.clear();
}

/** The host's ack: still-waiting waiters get it, timed-out ones get it once as the late outcome. */
function deliver(entry: IntentEntry, ack: AckResult): void {
  if (entries.get(entry.key) !== entry) return;
  entries.delete(entry.key);
  const waiters = [...entry.waiters];
  entry.waiters.clear();
  for (const waiter of waiters) {
    if (!waiter.settled) {
      settle(waiter, { kind: 'ack', ack, correlationId: entry.correlationId });
      continue;
    }
    const late = waiter.onLateOutcome;
    waiter.onLateOutcome = undefined;
    waiter.detach();
    if (late !== undefined) late(ack);
  }
}

function expireStale(now: number): void {
  for (const entry of [...entries.values()]) {
    if (now - entry.firstSentAt >= INTENT_REUSE_WINDOW_MS) discard(entry);
  }
}

/**
 * Sends one intent, or re-sends an unresolved one under its original identity. Resolves with the
 * host's ack, with `unknown` at `timeoutMs`, or with `cancelled` when the waiter's signal aborts or
 * the ledger is discarded. It never rejects.
 */
export function sendIntent<P>(request: SendIntentRequest<P>): Promise<IntentResult> {
  const now = Date.now();
  expireStale(now);
  const key = keyOf(request.type, request.payload);
  let entry = entries.get(key);
  const isNew = entry === undefined;
  if (entry === undefined) {
    const correlationId = uuidv4();
    const created: IntentEntry = {
      key,
      correlationId,
      payload: request.payload,
      firstSentAt: now,
      waiters: new Set(),
      unsubscribe: () => undefined
    };
    snapshotStore.markPending(correlationId);
    created.unsubscribe = snapshotStore.onceAck(correlationId, (ack) => deliver(created, ack));
    entries.set(key, created);
    entry = created;
  }
  const live = entry;

  return new Promise<IntentResult>((resolve) => {
    const signal = request.signal;
    const onAbort = (): void => {
      waiter.onLateOutcome = undefined;
      live.waiters.delete(waiter);
      settle(waiter, { kind: 'cancelled', correlationId: live.correlationId });
    };
    const waiter: Waiter = {
      timer: null,
      settled: false,
      onLateOutcome: request.onLateOutcome,
      resolve,
      detach: () => signal?.removeEventListener('abort', onAbort)
    };
    if (signal?.aborted === true) {
      waiter.onLateOutcome = undefined;
      settle(waiter, { kind: 'cancelled', correlationId: live.correlationId });
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    live.waiters.add(waiter);
    // The post is the module's own `postCommand` site. A retry re-posts the STORED payload, so
    // the host sees the same command it already has under this identity (FR-022).
    request.post(live.correlationId, (isNew ? request.payload : live.payload) as P);
    waiter.timer = setTimeout(() => {
      waiter.timer = null;
      // The outcome is not yet known. The waiter stays in the entry for its late callback.
      settle(waiter, { kind: 'unknown', correlationId: live.correlationId });
    }, request.timeoutMs);
  });
}

/**
 * Removes every ledger timer and listener and discards every entry (I9). Waiters resolve
 * `cancelled`, which no caller renders, and a later ack finds no listener, so no outcome is shown
 * after a webview realm goes.
 */
export function disposeIntentLedger(): void {
  for (const entry of [...entries.values()]) discard(entry);
}
