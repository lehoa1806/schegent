// Feature 020 T046 — PhaseLogTailRegistry.
//
// Owns the cap-of-1 tail invariant per host. Decides the watcher
// mechanism (`fs.watch` vs `polling`) at start time, subscribes to
// the host's `task-leaves-in-flight` signal, and exposes
// `start` / `stop` / `disposeAll`.
//
// The registry adapts the session's raw push payload (a flat
// `{ tailSessionId, entrySeq, entry }`) into the IPC envelope
// (`{ type: MSG_PHASE_LOG_ENTRY, payload: ... }`) before forwarding
// to the host's webview-push function. The session itself is unaware
// of the IPC envelope shape; this is the only place those concerns
// meet.
//
// Sanitization rule: body strings are sanitized inside
// `PhaseLogTailSession` (T045) using the injected `sanitize` callback;
// the registry only forwards already-sanitized payloads.

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { MSG_PHASE_LOG_ENTRY } from '../../contracts/sidebar-ipc';
import { resolveStreamJsonlPath } from './phase-log-path';
import {
  PhaseLogTailSession,
  type PhaseLogEntryPushPayload,
  type TailEndedReason
} from './phase-log-tail-session';
import type {
  PhaseLogSelection,
  PhaseLogTailStartResult,
  PhaseLogTailStopResult
} from './types';

const POLLING_INTERVAL_MS = 500;

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
  };
}

export interface PhaseLogTailEnvelope {
  readonly type: typeof MSG_PHASE_LOG_ENTRY;
  readonly payload: PhaseLogEntryPushPayload;
}

export interface PhaseLogTailSubscriptionToken {
  dispose(): void;
}

export interface PhaseLogTailRegistryDeps {
  readonly pushToWebview: (msg: PhaseLogTailEnvelope) => void;
  readonly sanitize: (s: string) => string;
  readonly appendAudit: (event: PhaseLogTailRegistryAuditEvent) => Promise<void> | void;
  readonly onTaskNoLongerInFlight: (
    cb: (runId: string) => void
  ) => PhaseLogTailSubscriptionToken;
  readonly caps: { readonly perFieldBytes: number };
}

interface SessionEntry {
  readonly session: PhaseLogTailSession;
  readonly stop: () => void;
  readonly runId: string;
  readonly mechanism: 'fs.watch' | 'polling';
  readonly auditMeta: {
    readonly queueId: string;
    readonly taskId: string;
    readonly pipelineId: string;
    readonly phaseId: string;
    readonly iterationN: number;
  };
  disposing: boolean;
}

export class PhaseLogTailRegistry {
  private readonly deps: PhaseLogTailRegistryDeps;
  private readonly subscription: PhaseLogTailSubscriptionToken;
  private current: SessionEntry | null = null;
  private disposed = false;

  constructor(deps: PhaseLogTailRegistryDeps) {
    this.deps = deps;
    this.subscription = deps.onTaskNoLongerInFlight((runId) => {
      this.handleTaskLeftInFlight(runId).catch(() => {
        // Audit failures inside dispose are non-fatal; the session
        // map is still cleared.
      });
    });
  }

  get activeSessionCount(): number {
    return this.current !== null ? 1 : 0;
  }

  async start(req: {
    readonly workspaceRoot: string;
    readonly selection: PhaseLogSelection;
  }): Promise<PhaseLogTailStartResult> {
    if (this.disposed) {
      return { outcome: 'failure', reason: 'internal-error' };
    }
    const sel = req.selection;
    if (sel.iterationN === null || sel.iterationN < 1) {
      return { outcome: 'failure', reason: 'unknown-tuple' };
    }
    let filePath: string;
    try {
      filePath = resolveStreamJsonlPath({
        workspaceRoot: req.workspaceRoot,
        runId: sel.taskId,
        pipelineId: sel.pipelineId,
        phaseId: sel.phaseId,
        iterationN: sel.iterationN
      });
    } catch {
      return { outcome: 'failure', reason: 'unknown-tuple' };
    }

    try {
      await fsPromises.access(filePath, fsPromises.constants.R_OK);
    } catch {
      return { outcome: 'failure', reason: 'unknown-tuple' };
    }

    // Cap-of-1: dispose the previous session (if any) before creating
    // the new one. The previous session emits `tail-ended` with
    // reason 'webview-stop'.
    if (this.current !== null) {
      await this.disposeCurrent('webview-stop');
    }

    const sessionId = randomUUID();
    const session = new PhaseLogTailSession({
      sessionId,
      workspaceRoot: req.workspaceRoot,
      filePath,
      selection: sel,
      pushToWebview: (raw) => {
        if (this.disposed) return;
        this.deps.pushToWebview({
          type: MSG_PHASE_LOG_ENTRY,
          payload: raw
        });
      },
      sanitize: this.deps.sanitize,
      caps: this.deps.caps
    });

    // Initial read of any bytes already present.
    try {
      await session.tick();
    } catch {
      // Initial-read errors are non-fatal; subsequent ticks may
      // succeed. The session preserves its offset/skipped state.
    }

    let mechanism: 'fs.watch' | 'polling';
    let stopWatcher: () => void;
    try {
      const watcher = fs.watch(filePath, { persistent: false }, () => {
        if (this.disposed) return;
        session.tick().catch(() => {
          // tick errors are isolated per call; keep watching.
        });
      });
      mechanism = 'fs.watch';
      stopWatcher = () => {
        try {
          watcher.close();
        } catch {
          // best-effort
        }
      };
    } catch {
      mechanism = 'polling';
      const interval = setInterval(() => {
        if (this.disposed) return;
        session.tick().catch(() => {
          /* isolated */
        });
      }, POLLING_INTERVAL_MS);
      // Allow the host process to exit even if the interval is still
      // active; the registry's disposeAll clears it anyway.
      if (typeof interval.unref === 'function') interval.unref();
      stopWatcher = () => clearInterval(interval);
    }

    this.current = {
      session,
      stop: stopWatcher,
      runId: sel.taskId,
      mechanism,
      auditMeta: {
        queueId: sel.queueId,
        taskId: sel.taskId,
        pipelineId: sel.pipelineId,
        phaseId: sel.phaseId,
        iterationN: sel.iterationN
      },
      disposing: false
    };

    await this.safeAudit({
      type: 'phase-log-tail-started',
      payload: {
        sessionId,
        queueId: sel.queueId,
        taskId: sel.taskId,
        pipelineId: sel.pipelineId,
        phaseId: sel.phaseId,
        iterationN: sel.iterationN,
        mechanism,
        outcome: 'success'
      }
    });

    return { outcome: 'success', sessionId, mechanism };
  }

  async stop(
    sessionId: string,
    reason: TailEndedReason
  ): Promise<PhaseLogTailStopResult> {
    if (this.current === null || this.current.session.sessionId !== sessionId) {
      return {
        outcome: 'failure',
        sessionId,
        reason: 'unknown-session'
      };
    }
    const meta = this.current.auditMeta;
    await this.disposeCurrent(reason);
    await this.safeAudit({
      type: 'phase-log-tail-stopped',
      payload: {
        sessionId,
        queueId: meta.queueId,
        taskId: meta.taskId,
        pipelineId: meta.pipelineId,
        phaseId: meta.phaseId,
        iterationN: meta.iterationN,
        reason,
        outcome: 'success'
      }
    });
    return { outcome: 'success', sessionId };
  }

  async disposeAll(reason: TailEndedReason): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.current !== null) {
      await this.disposeCurrent(reason);
    }
    try {
      this.subscription.dispose();
    } catch {
      // best-effort
    }
  }

  private async disposeCurrent(reason: TailEndedReason): Promise<void> {
    const entry = this.current;
    if (entry === null) return;
    if (entry.disposing) return;
    entry.disposing = true;
    this.current = null;
    try {
      entry.stop();
    } catch {
      /* best-effort */
    }
    try {
      await entry.session.dispose(reason);
    } catch {
      /* dispose failures should not block teardown */
    }
  }

  private async handleTaskLeftInFlight(runId: string): Promise<void> {
    const entry = this.current;
    if (entry === null) return;
    if (entry.runId !== runId) return;
    const meta = entry.auditMeta;
    const sessionId = entry.session.sessionId;
    await this.disposeCurrent('phase-complete');
    await this.safeAudit({
      type: 'phase-log-tail-stopped',
      payload: {
        sessionId,
        queueId: meta.queueId,
        taskId: meta.taskId,
        pipelineId: meta.pipelineId,
        phaseId: meta.phaseId,
        iterationN: meta.iterationN,
        reason: 'phase-complete',
        outcome: 'success'
      }
    });
  }

  private async safeAudit(
    event: PhaseLogTailRegistryAuditEvent
  ): Promise<void> {
    try {
      await this.deps.appendAudit(event);
    } catch {
      // Audit failures are non-fatal.
    }
  }
}
