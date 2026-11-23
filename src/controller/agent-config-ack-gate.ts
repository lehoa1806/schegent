// Feature 318 (FR-R7-04, FR-003, FR-004, FR-005, FR-007, FR-009) — per-run
// repository agent configuration preflight gate.
//
// Modelled on `src/controller/backend-posture-recorder.ts`:
//   - Runs ONLY for uncontained backends (`containmentOf(backend) === 'none'`).
//   - Runs ONCE per `(runId, backend)` per activation via a bounded LRU
//     in-memory ledger (same `POSTURE_LEDGER_MAX_PAIRS` bound and NUL separator),
//     coalescing overlapping concurrent calls for the same pair and releasing
//     terminal Runs via `forgetRun(runId)`.
//   - Checks workspace-scoped persistent grants (only when `scan.persistable`).
//   - Emits closed metadata-only `agent-config-acknowledged` audit events
//     (`backend`, `fileCount`, `decision`) — zero paths, hook names, or values.
//   - Throws `AgentConfigAcknowledgementRefusedError` on denial so no child
//     process is spawned and `start-failure-classification.ts` reports a clean
//     refusal.
import type { AuditEntry } from '../audit/audit-entry';
import type {
  AgentConfigAckDecision,
  AgentConfigAcknowledgedPayload
} from '../contracts/agent-config-acknowledgement';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import { errorMessage } from '../lib/errors';
import type { SanitizedLogger } from '../lib/logger';
import { AgentConfigAcknowledgementRefusedError } from '../services/agent-config-ack-refusal';
import { containmentOf } from '../services/backend-containment-policy';
import {
  computeAgentConfigFingerprint,
  type RepoAgentConfigScanResult
} from '../services/repo-agent-config-scanner';
import type { AgentConfigGrant } from '../state/agent-config-grants';
import {
  LEDGER_KEY_SEPARATOR,
  POSTURE_LEDGER_MAX_PAIRS
} from './backend-posture-recorder';

export type AgentConfigAckChoice = 'this-run' | 'persist' | 'denied';

export interface AgentConfigAckContext {
  readonly runId: string;
  readonly phase: string;
  readonly iteration: number;
  readonly cwd: string;
}

export interface AgentConfigAckGateDeps {
  readonly scan: (cwd: string, backend: BackendRunnerKind) => Promise<RepoAgentConfigScanResult>;
  readonly hasGrant: (fingerprint: string, backend: BackendRunnerKind) => boolean;
  readonly latestGrantForBackend: (backend: BackendRunnerKind) => AgentConfigGrant | null;
  readonly persistGrant: (grant: AgentConfigGrant) => Promise<void>;
  readonly request: (
    scan: RepoAgentConfigScanResult,
    previousGrant: AgentConfigGrant | null
  ) => Promise<AgentConfigAckChoice>;
  readonly appendAudit: (entry: Omit<AuditEntry, 'id' | 'timestamp'>) => Promise<unknown>;
  readonly logger: Pick<SanitizedLogger, 'warn'>;
  readonly now?: () => number;
}

export class AgentConfigAckGate {
  private readonly cleared = new Set<string>();
  private readonly inFlight = new Map<string, Promise<void>>();

  public constructor(private readonly deps: AgentConfigAckGateDeps) {}

  /** Remove every cleared `(runId, backend)` pair for a terminal Run. */
  public forgetRun(runId: string): void {
    const prefix = `${runId}${LEDGER_KEY_SEPARATOR}`;
    for (const key of this.cleared) {
      if (key.startsWith(prefix)) {
        this.cleared.delete(key);
      }
    }
  }

  public async ensureAcknowledged(
    context: AgentConfigAckContext,
    backend: BackendRunnerKind
  ): Promise<void> {
    // FR-009: contained (OS-enforced) backends do not trigger this uncontained preflight.
    if (containmentOf(backend) !== 'none') return;

    const ledgerKey = `${context.runId}${LEDGER_KEY_SEPARATOR}${backend}`;
    if (this.cleared.has(ledgerKey)) {
      // Refresh LRU order so long-lived active Runs stay newest under eviction.
      this.cleared.delete(ledgerKey);
      this.cleared.add(ledgerKey);
      return;
    }

    const pending = this.inFlight.get(ledgerKey);
    if (pending !== undefined) {
      return pending;
    }

    const task = this.evaluateAndAcknowledge(context, backend, ledgerKey).finally(() => {
      if (this.inFlight.get(ledgerKey) === task) {
        this.inFlight.delete(ledgerKey);
      }
    });
    this.inFlight.set(ledgerKey, task);
    return task;
  }

  private async evaluateAndAcknowledge(
    context: AgentConfigAckContext,
    backend: BackendRunnerKind,
    ledgerKey: string
  ): Promise<void> {
    const scan = await this.safeScan(context.cwd, backend);

    // FR-009: workspaces with no discovered repository agent config and no scan error proceed silently.
    if (!scan.scanError && scan.entries.length === 0) {
      this.rememberCleared(ledgerKey);
      return;
    }

    const fileCount = scan.entries.length;

    // FR-003: persistent match is valid ONLY when every discovered file was safely digested.
    if (scan.persistable && this.deps.hasGrant(scan.fingerprint, backend)) {
      await this.emitAudit(context, { backend, fileCount, decision: 'stored' });
      this.rememberCleared(ledgerKey);
      return;
    }

    const previousGrant = this.deps.latestGrantForBackend(backend);
    let choice: AgentConfigAckChoice;
    try {
      choice = await this.deps.request(scan, previousGrant);
    } catch (error) {
      this.deps.logger.warn(
        `agent-config.ack gate-request-failed backend=${backend} reason=${errorMessage(error)}`
      );
      await this.emitAuditBestEffort(context, { backend, fileCount, decision: 'denied' });
      throw new AgentConfigAcknowledgementRefusedError(backend, fileCount, 'unavailable');
    }

    if (choice !== 'this-run' && !(choice === 'persist' && scan.persistable)) {
      await this.emitAuditBestEffort(context, { backend, fileCount, decision: 'denied' });
      throw new AgentConfigAcknowledgementRefusedError(backend, fileCount, 'denied');
    }

    let auditDecision: AgentConfigAckDecision = 'approved-once';
    if (choice === 'persist' && scan.persistable) {
      const files = scan.entries
        .filter((e): e is Extract<typeof e, { status: 'present' }> => e.status === 'present')
        .map((e) => Object.freeze({ name: e.name, size: e.size, digest: e.digest }));
      try {
        await this.deps.persistGrant(
          Object.freeze({
            fingerprint: scan.fingerprint,
            backend,
            grantedAt: (this.deps.now ?? Date.now)(),
            files: Object.freeze(files)
          })
        );
        // FR-R7-11 — record `acknowledged` ONLY after the persistent grant write
        // actually succeeds; a failed write records `approved-once` because the
        // grant was not stored and the next Run will prompt again.
        auditDecision = 'acknowledged';
      } catch (error) {
        // Mirror `git-approval.ts:179-188`: a failed persistence write does not
        // revoke an operator's explicit approval for this run; next run asks again.
        this.deps.logger.warn(
          `agent-config.ack grant-not-recorded backend=${backend} reason=${errorMessage(error)}`
        );
      }
    }

    await this.emitAudit(context, { backend, fileCount, decision: auditDecision });
    this.rememberCleared(ledgerKey);
  }

  private async safeScan(cwd: string, backend: BackendRunnerKind): Promise<RepoAgentConfigScanResult> {
    try {
      return await this.deps.scan(cwd, backend);
    } catch (error) {
      // FR-007: a failed scan is treated as unreadable configuration and asks, never skips.
      this.deps.logger.warn(
        `agent-config.ack scan-failed backend=${backend} reason=${errorMessage(error)}`
      );
      const empty = Object.freeze([]);
      return {
        backend,
        entries: empty,
        fingerprint: computeAgentConfigFingerprint(backend, empty, true, 'scan-failed'),
        persistable: false,
        scanError: true,
        scanErrorReason: 'scan-failed'
      };
    }
  }

  private async emitAudit(
    context: AgentConfigAckContext,
    payload: AgentConfigAcknowledgedPayload
  ): Promise<void> {
    await this.deps.appendAudit({
      runId: context.runId,
      phase: context.phase,
      iteration: context.iteration,
      eventType: 'agent-config-acknowledged',
      payload: { ...payload },
      outcome: payload.decision === 'denied' ? 'failure' : 'info'
    });
  }

  private async emitAuditBestEffort(
    context: AgentConfigAckContext,
    payload: AgentConfigAcknowledgedPayload
  ): Promise<void> {
    try {
      await this.emitAudit(context, payload);
    } catch (error) {
      // Do not mask the refusal error if audit append fails on a denied run.
      this.deps.logger.warn(
        `agent-config.ack audit-failed backend=${payload.backend} reason=${errorMessage(error)}`
      );
    }
  }

  private rememberCleared(key: string): void {
    if (this.cleared.has(key)) {
      this.cleared.delete(key);
    } else if (this.cleared.size >= POSTURE_LEDGER_MAX_PAIRS) {
      const oldest = this.cleared.values().next();
      if (!oldest.done) this.cleared.delete(oldest.value);
    }
    this.cleared.add(key);
  }
}
