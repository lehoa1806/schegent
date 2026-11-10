// Feature 020 T046 — PhaseLogTailRegistry.
//
// Owns the tail sessions of one host. Decides the watcher mechanism
// (`fs.watch` vs `polling`) at start time, subscribes to the host's
// `task-leaves-in-flight` signal, and exposes `start` / `ack` / `stop` /
// `disposeAll`.
//
// FR-R6-F07 (NFR-003) — there are two consumer slots, `dashboard` and
// `sidebar`. Each slot has its own sink, visibility and at most one session;
// a start supersedes only the session of its own slot. Any other consumer
// name is answered with `busy`, and a slot whose sink is unbound with
// `consumer-unavailable`.
//
// The registry wraps each session batch in the IPC envelope
// (`{ type: MSG_PHASE_LOG_BATCH, payload }`) before handing it to the slot's
// sink. A sink returns false when the batch was not delivered; the session
// then suspends and replays from its last acknowledged position. Nothing is
// posted for a session until its consumer sends the ready ack (batch 0), and
// the start does not read before its response.
//
// Sanitization rule: body strings are sanitized inside
// `PhaseLogTailSession` using the injected `sanitize` callback; the
// registry only forwards already-sanitized payloads.

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  MSG_PHASE_LOG_BATCH,
  type AckPhaseLogTailResponse,
  type PhaseLogBatchPushMessage,
  type PhaseLogTailCounters
} from '../../contracts/sidebar-ipc';
import { resolveStreamJsonlPath } from './phase-log-path';
import {
  PhaseLogTailSession,
  type PhaseLogBatchPush,
  type PhaseLogTailCaps,
  type TailEndedReason,
  type TailSessionAck
} from './phase-log-tail-session';
import type {
  PhaseLogSelection,
  PhaseLogTailStartResult,
  PhaseLogTailStopResult
} from './types';

const POLLING_INTERVAL_MS = 500;

/** FR-R6-F07 (NFR-003) — the consumer slots, in a fixed order. */
export const PHASE_LOG_TAIL_CONSUMERS = Object.freeze(['dashboard', 'sidebar'] as const);
export type PhaseLogTailConsumer = (typeof PHASE_LOG_TAIL_CONSUMERS)[number];
const DEFAULT_CONSUMER: PhaseLogTailConsumer = 'dashboard';

/** Posts one batch envelope; false when it was not delivered. */
export type PhaseLogTailSink = (msg: PhaseLogBatchPushMessage) => boolean;

export interface PhaseLogTailRegistryAuditEvent {
  readonly type: 'phase-log-tail-started' | 'phase-log-tail-stopped';
  readonly payload: {
    readonly sessionId: string;
    readonly queueId: string;
    readonly taskId: string;
    readonly pipelineId: string;
    readonly phaseId: string;
    readonly iterationN: number | null;
    readonly mechanism?: 'fs.watch' | 'polling';
    readonly reason?: TailEndedReason | 'unknown-session';
    readonly outcome: 'success' | 'failure';
    /** FR-R6-F07 (FR-014) — on a stop row only; counts, never content. */
    readonly counters?: PhaseLogTailCounters;
  };
}

export interface PhaseLogTailSubscriptionToken {
  dispose(): void;
}

export interface PhaseLogTailRegistryDeps {
  readonly sanitize: (s: string) => string;
  readonly appendAudit: (event: PhaseLogTailRegistryAuditEvent) => Promise<void> | void;
  readonly onTaskNoLongerInFlight: (
    cb: (runId: string) => void
  ) => PhaseLogTailSubscriptionToken;
  readonly caps: PhaseLogTailCaps;
}

export interface PhaseLogTailStartRequest {
  readonly workspaceRoot: string;
  readonly selection: PhaseLogSelection;
  readonly consumer?: string;
  readonly fromCursor?: string;
}

interface AuditMeta {
  readonly queueId: string;
  readonly taskId: string;
  readonly pipelineId: string;
  readonly phaseId: string;
  readonly iterationN: number;
}

interface SessionEntry {
  readonly session: PhaseLogTailSession;
  readonly stop: () => void;
  readonly runId: string;
  readonly auditMeta: AuditMeta;
  disposing: boolean;
}

interface InFlightStartToken {
  cancelled: boolean;
}

interface ConsumerSlot {
  sink: PhaseLogTailSink | null;
  visible: boolean;
  current: SessionEntry | null;
  activeStart: InFlightStartToken | null;
}

function isConsumer(name: string): name is PhaseLogTailConsumer {
  return (PHASE_LOG_TAIL_CONSUMERS as readonly string[]).includes(name);
}

export class PhaseLogTailRegistry {
  private readonly deps: PhaseLogTailRegistryDeps;
  private readonly subscription: PhaseLogTailSubscriptionToken;
  private readonly slots = new Map<PhaseLogTailConsumer, ConsumerSlot>(
    PHASE_LOG_TAIL_CONSUMERS.map((name) => [
      name,
      { sink: null, visible: true, current: null, activeStart: null }
    ])
  );
  private disposed = false;

  constructor(deps: PhaseLogTailRegistryDeps) {
    this.deps = deps;
    this.subscription = deps.onTaskNoLongerInFlight((runId) => {
      this.handleTaskLeftInFlight(runId).catch(() => {
        // Audit failures are non-fatal: `disposeSlot` clears the slot
        // before the audit append runs.
      });
    });
  }

  get activeSessionCount(): number {
    let count = 0;
    for (const slot of this.slots.values()) if (slot.current !== null) count += 1;
    return count;
  }

  /** Binds the sink a slot posts through; null unbinds it. */
  bindSink(consumer: PhaseLogTailConsumer, sink: PhaseLogTailSink | null): void {
    this.slotOf(consumer).sink = sink;
  }

  /** Hidden: the slot's session posts nothing. Revealed: it resumes. */
  setConsumerVisible(consumer: PhaseLogTailConsumer, visible: boolean): void {
    const slot = this.slotOf(consumer);
    slot.visible = visible;
    const session = slot.current?.session;
    if (session === undefined) return;
    session.setVisible(visible);
    if (visible) tickQuietly(session);
  }

  async start(req: PhaseLogTailStartRequest): Promise<PhaseLogTailStartResult> {
    if (this.disposed) return { outcome: 'failure', reason: 'internal-error' };
    const consumer = req.consumer ?? DEFAULT_CONSUMER;
    if (!isConsumer(consumer)) return { outcome: 'failure', reason: 'busy' };
    const slot = this.slotOf(consumer);
    if (slot.sink === null) return { outcome: 'failure', reason: 'consumer-unavailable' };
    const sel = req.selection;
    const filePath = resolvedPath(req.workspaceRoot, sel);
    if (filePath === null || sel.iterationN === null) {
      return { outcome: 'failure', reason: 'unknown-tuple' };
    }

    if (slot.activeStart !== null) slot.activeStart.cancelled = true;
    const token: InFlightStartToken = { cancelled: false };
    slot.activeStart = token;
    const cancelled = (): boolean => this.disposed || token.cancelled || slot.activeStart !== token;
    const settle = (result: PhaseLogTailStartResult): PhaseLogTailStartResult => {
      if (slot.activeStart === token) slot.activeStart = null;
      return result;
    };

    try {
      await fsPromises.access(filePath, fsPromises.constants.R_OK);
    } catch {
      return settle({ outcome: 'failure', reason: 'unknown-tuple' });
    }
    if (cancelled()) return { outcome: 'failure', reason: 'internal-error' };

    // One session per slot: the previous one ends with 'webview-stop'.
    await this.disposeSlot(slot, 'webview-stop');
    if (cancelled()) return { outcome: 'failure', reason: 'internal-error' };

    const sessionId = randomUUID();
    const session = new PhaseLogTailSession({
      sessionId,
      workspaceRoot: req.workspaceRoot,
      filePath,
      selection: sel,
      postBatch: (batch) => this.post(slot, token, batch),
      sanitize: this.deps.sanitize,
      caps: this.deps.caps
    });
    if (!slot.visible) session.setVisible(false);

    let cursors: Awaited<ReturnType<PhaseLogTailSession['start']>>;
    try {
      cursors = await session.start(req.fromCursor);
    } catch {
      await disposeQuietly(session, 'webview-dispose');
      return settle({ outcome: 'failure', reason: 'internal-error' });
    }
    if (cursors === null) {
      await disposeQuietly(session, 'webview-dispose');
      return settle({ outcome: 'failure', reason: 'unknown-tuple' });
    }
    if (cancelled()) {
      await disposeQuietly(session, 'webview-dispose');
      return { outcome: 'failure', reason: 'internal-error' };
    }

    const watcher = this.watch(filePath, session);
    const auditMeta: AuditMeta = {
      queueId: sel.queueId,
      taskId: sel.taskId,
      pipelineId: sel.pipelineId,
      phaseId: sel.phaseId,
      iterationN: sel.iterationN
    };
    slot.current = { session, stop: watcher.stop, runId: sel.taskId, auditMeta, disposing: false };
    // A visibility change during the start found no current session; apply the slot's state now.
    session.setVisible(slot.visible);
    const result = settle({ outcome: 'success', sessionId, mechanism: watcher.mechanism, ...cursors });

    await this.safeAudit({
      type: 'phase-log-tail-started',
      payload: { sessionId, ...auditMeta, mechanism: watcher.mechanism, outcome: 'success' }
    });
    return result;
  }

  /** FR-R6-F07 (FR-009) — credit, readiness, gap and duplicate reports. */
  ack(sessionId: string, ack: TailSessionAck): AckPhaseLogTailResponse {
    const slot = this.slotOfSession(sessionId);
    const session = slot?.current?.session;
    if (session === undefined) {
      return { outcome: 'failure', sessionId, reason: 'unknown-session' };
    }
    session.ack(ack);
    tickQuietly(session);
    return { outcome: 'success', sessionId };
  }

  async stop(sessionId: string, reason: TailEndedReason): Promise<PhaseLogTailStopResult> {
    const slot = this.slotOfSession(sessionId);
    if (slot === null) return { outcome: 'failure', sessionId, reason: 'unknown-session' };
    const counters = await this.endSlot(slot, reason);
    return counters === null
      ? { outcome: 'failure', sessionId, reason: 'unknown-session' }
      : { outcome: 'success', sessionId, counters };
  }

  async releaseConsumer(
    consumer: string = DEFAULT_CONSUMER,
    reason: TailEndedReason = 'webview-dispose'
  ): Promise<boolean> {
    if (!isConsumer(consumer)) return false;
    const slot = this.slotOf(consumer);
    let released = false;
    if (slot.activeStart !== null) {
      slot.activeStart.cancelled = true;
      slot.activeStart = null;
      released = true;
    }
    const counters = await this.endSlot(slot, reason);
    return released || counters !== null;
  }

  async disposeAll(reason: TailEndedReason): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Unsubscribe before the first await, so teardown never waits on a session.
    try {
      this.subscription.dispose();
    } catch {
      // best-effort
    }
    for (const slot of this.slots.values()) {
      if (slot.activeStart !== null) slot.activeStart.cancelled = true;
      slot.activeStart = null;
      await this.disposeSlot(slot, reason);
    }
  }

  private slotOf(consumer: PhaseLogTailConsumer): ConsumerSlot {
    const slot = this.slots.get(consumer);
    if (slot === undefined) throw new Error(`unknown phase-log consumer slot: ${consumer}`);
    return slot;
  }

  private slotOfSession(sessionId: string): ConsumerSlot | null {
    for (const slot of this.slots.values()) {
      if (slot.current?.session.sessionId === sessionId) return slot;
    }
    return null;
  }

  private post(slot: ConsumerSlot, token: InFlightStartToken, batch: PhaseLogBatchPush): boolean {
    if (this.disposed || token.cancelled || slot.sink === null) return false;
    try {
      return slot.sink({ type: MSG_PHASE_LOG_BATCH, payload: batch });
    } catch {
      return false;
    }
  }

  private watch(
    filePath: string,
    session: PhaseLogTailSession
  ): { readonly mechanism: 'fs.watch' | 'polling'; readonly stop: () => void } {
    const onChange = (): void => {
      if (!this.disposed) tickQuietly(session);
    };
    try {
      const watcher = fs.watch(filePath, { persistent: false }, onChange);
      return {
        mechanism: 'fs.watch',
        stop: () => {
          try {
            watcher.close();
          } catch {
            // best-effort
          }
        }
      };
    } catch {
      const interval = setInterval(onChange, POLLING_INTERVAL_MS);
      // Allow the host process to exit even if the interval is still
      // active; disposeAll clears it anyway.
      if (typeof interval.unref === 'function') interval.unref();
      return { mechanism: 'polling', stop: () => clearInterval(interval) };
    }
  }

  /** Ends the slot's session and writes its stop row; null when there was none. */
  private async endSlot(
    slot: ConsumerSlot,
    reason: TailEndedReason
  ): Promise<PhaseLogTailCounters | null> {
    const entry = slot.current;
    if (entry === null) return null;
    const sessionId = entry.session.sessionId;
    await this.disposeSlot(slot, reason);
    const counters = entry.session.counters();
    await this.safeAudit({
      type: 'phase-log-tail-stopped',
      payload: { sessionId, ...entry.auditMeta, reason, outcome: 'success', counters }
    });
    return counters;
  }

  private async disposeSlot(slot: ConsumerSlot, reason: TailEndedReason): Promise<void> {
    const entry = slot.current;
    if (entry === null || entry.disposing) return;
    entry.disposing = true;
    slot.current = null;
    try {
      entry.stop();
    } catch {
      /* best-effort */
    }
    await disposeQuietly(entry.session, reason);
  }

  private async handleTaskLeftInFlight(runId: string): Promise<void> {
    for (const slot of this.slots.values()) {
      if (slot.current?.runId === runId) await this.endSlot(slot, 'phase-complete');
    }
  }

  private async safeAudit(event: PhaseLogTailRegistryAuditEvent): Promise<void> {
    try {
      await this.deps.appendAudit(event);
    } catch {
      // Audit failures are non-fatal.
    }
  }
}

function resolvedPath(workspaceRoot: string, sel: PhaseLogSelection): string | null {
  if (sel.iterationN === null || sel.iterationN < 1) return null;
  try {
    return resolveStreamJsonlPath({
      workspaceRoot,
      runId: sel.taskId,
      pipelineId: sel.pipelineId,
      phaseId: sel.phaseId,
      iterationN: sel.iterationN
    });
  } catch {
    return null;
  }
}

function tickQuietly(session: PhaseLogTailSession): void {
  session.tick().catch(() => {
    // tick errors are isolated per call; keep watching.
  });
}

async function disposeQuietly(session: PhaseLogTailSession, reason: TailEndedReason): Promise<void> {
  try {
    await session.dispose(reason);
  } catch {
    /* dispose failures should not block teardown */
  }
}
