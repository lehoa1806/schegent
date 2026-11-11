/**
 * FR-R6-F09 (FR-009, FR-017, F09-AC-08) — ACP callback authority boundary, bounded decision
 * provenance receipts (`acp_authorization_receipts`), and post-cancel surviving-helper check.
 *
 * Enforces:
 * - Exact `acpSessionId` -> `attemptId` + `connectionGeneration` binding; forged or stale sessions
 *   refuse immediately.
 * - Live re-evaluation of workspace trust and window primacy / ownership generation before every
 *   permission, filesystem, or terminal decision.
 * - Path containment against the attempt's permitted execution root and explicit F15 upstream
 *   input / declared output reference sets, blocking access to SQLite databases, WAL/SHM files,
 *   credentials, or `.schegent/` evidence outside authorized references.
 * - Duplicate effectful request deduplication so replayed requests never repeat mutations.
 * - Bounded decision provenance (never raw tool arguments, paths, or secret values).
 * - Post-cancellation / post-turn process-group verification so an ACP `cancelled` / `end_turn`
 *   response cannot conceal surviving helper processes.
 *
 * Zero `vscode` imports.
 */
import * as path from 'node:path';

import type {
  AcpPermissionPolicy,
  AcpPermissionRequest
} from '../../contracts/acp-runtime';
import { grants, type DeclaredCapabilitySet } from '../../contracts/phase-capabilities';
import type {
  AcpAuthorizationReason,
  TeardownQualification
} from '../../contracts/containment-qualification';
import type { AcpStdioTransport } from '../acp-runtime/stdio-transport';

export interface AcpReceiptSqlSink {
  run(sql: string, ...params: (string | number | null)[]): unknown;
}

export type AcpCallbackKind = 'permission' | 'filesystem' | 'terminal';

export interface AcpAttemptAuthorityScope {
  readonly attemptId: string;
  readonly profileId?: string;
  readonly acpSessionId: string;
  readonly connectionGeneration: number;
  readonly ownershipGeneration: number;
  readonly executionRoot: string;
  /** Primary workspace root where `.schegent/` and protected state reside. */
  readonly primaryWorkspaceRoot?: string;
  /** Protected SQLite store directory or file paths that no callback may ever read or write. */
  readonly protectedDatabasePaths?: readonly string[];
  /** Explicit F15 accepted upstream artifact paths permitted for read-only access. */
  readonly authorizedUpstreamInputPaths?: readonly string[];
  /** Explicit declared output paths permitted for write access when outside `executionRoot`. */
  readonly authorizedOutputPaths?: readonly string[];
  /** Declared Phase capability restrictions, when authored. */
  readonly capabilities?: DeclaredCapabilitySet;
}

export interface AcpAuthorityLiveProbe {
  isWorkspaceTrusted(): boolean;
  holdsPrimacy(): boolean;
  currentOwnershipGeneration(): number;
  isTurnCancelling?(acpSessionId: string): boolean;
  nowMs?(): number;
}

export interface AcpAuthorizationReceipt {
  readonly receiptId: string;
  readonly attemptId: string;
  readonly acpSessionId: string;
  readonly connectionGeneration: number;
  readonly requestKind: AcpCallbackKind;
  readonly decision: 'allowed' | 'denied' | 'cancelled';
  readonly reasonCode: AcpAuthorizationReason;
  readonly ownershipGeneration: number;
  readonly decidedAtMs: number;
}

export interface AcpCallbackAuthorizationRequest {
  readonly requestKind: AcpCallbackKind;
  readonly acpSessionId: string;
  readonly connectionGeneration: number;
  /** Unique per-request or per-tool-call token used to prevent duplicate effect replay. */
  readonly effectRequestKey?: string;
  readonly mutating: boolean;
  /** Target path supplied by a filesystem or resource callback, if any. */
  readonly targetPath?: string;
}

export interface AcpAuthorizationDecision {
  readonly allowed: boolean;
  readonly decision: 'allowed' | 'denied' | 'cancelled';
  readonly reason: AcpAuthorizationReason;
  readonly receipt: AcpAuthorizationReceipt;
}

const MAX_IN_MEMORY_RECEIPTS = 512;
const MAX_TRACKED_EFFECT_KEYS = 2_048;

const PROTECTED_BASENAME_PATTERNS: readonly RegExp[] = [
  /\.sqlite3?(?:-(?:wal|shm|journal))?$/i,
  /^\.env(?:\..+)?$/i,
  /^\.git-credentials$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^id_(?:rsa|ed25519|ecdsa)$/i
];

const PROTECTED_SEGMENT_NAMES: ReadonlySet<string> = new Set([
  '.schegent',
  '.ssh',
  '.gnupg',
  'secrets'
]);

function normalizeCandidatePath(baseRoot: string, rawPath: string): string | null {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0 || rawPath.includes('\0')) {
    return null;
  }
  return path.resolve(baseRoot, rawPath);
}

function isWithinDirectory(rootDir: string, targetPath: string): boolean {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isProtectedPath(
  resolvedTarget: string,
  scope: AcpAttemptAuthorityScope
): boolean {
  const base = path.basename(resolvedTarget);
  if (PROTECTED_BASENAME_PATTERNS.some((pattern) => pattern.test(base))) {
    return true;
  }
  for (const dbPath of scope.protectedDatabasePaths ?? []) {
    const resolvedDb = path.resolve(dbPath);
    if (resolvedTarget === resolvedDb || isWithinDirectory(resolvedDb, resolvedTarget)) {
      return true;
    }
  }
  const segments = resolvedTarget.split(path.sep);
  if (segments.some((segment) => PROTECTED_SEGMENT_NAMES.has(segment))) {
    return true;
  }
  return false;
}

function effectAllowedByCapabilities(
  capabilities: DeclaredCapabilitySet | undefined,
  requestKind: AcpCallbackKind,
  mutating: boolean
): boolean {
  if (capabilities === undefined || capabilities.declaredAt === 'default') {
    return true;
  }
  if (requestKind === 'terminal') {
    return grants(capabilities, 'process-spawn');
  }
  if (requestKind === 'filesystem' && mutating) {
    return grants(capabilities, 'workspace-write');
  }
  if (requestKind === 'permission' && mutating) {
    return grants(capabilities, 'workspace-write') || grants(capabilities, 'process-spawn');
  }
  return true;
}

export class AcpAuthorityGate {
  private readonly scopesBySession = new Map<string, AcpAttemptAuthorityScope>();
  private readonly seenEffectKeys = new Set<string>();
  private readonly receipts: AcpAuthorizationReceipt[] = [];
  private nextReceiptSeq = 1;

  constructor(
    private readonly liveProbe: AcpAuthorityLiveProbe,
    private readonly sqliteConnection?: AcpReceiptSqlSink
  ) {}

  registerScope(scope: AcpAttemptAuthorityScope): void {
    this.scopesBySession.set(scope.acpSessionId, scope);
  }

  revokeSession(acpSessionId: string): void {
    this.scopesBySession.delete(acpSessionId);
  }

  listReceipts(): readonly AcpAuthorizationReceipt[] {
    return [...this.receipts];
  }

  authorize(request: AcpCallbackAuthorizationRequest): AcpAuthorizationDecision {
    const nowMs = this.liveProbe.nowMs ? this.liveProbe.nowMs() : Date.now();
    const currentGen = this.liveProbe.currentOwnershipGeneration();
    const scope = this.scopesBySession.get(request.acpSessionId);

    const record = (
      attemptId: string,
      decision: 'allowed' | 'denied' | 'cancelled',
      reason: AcpAuthorizationReason
    ): AcpAuthorizationDecision => {
      const receipt: AcpAuthorizationReceipt = Object.freeze({
        receiptId: `acp-auth-${nowMs}-${this.nextReceiptSeq++}`,
        attemptId,
        acpSessionId: request.acpSessionId,
        connectionGeneration: request.connectionGeneration,
        requestKind: request.requestKind,
        decision,
        reasonCode: reason,
        ownershipGeneration: currentGen,
        decidedAtMs: nowMs
      });
      if (this.receipts.length >= MAX_IN_MEMORY_RECEIPTS) {
        this.receipts.shift();
      }
      this.receipts.push(receipt);
      this.persistReceiptIfConfigured(receipt, scope?.profileId ?? 'unattributed');
      return {
        allowed: decision === 'allowed',
        decision,
        reason,
        receipt
      };
    };

    if (scope === undefined) {
      return record('unattributed', 'denied', 'session-attempt-mismatch');
    }
    if (request.connectionGeneration !== scope.connectionGeneration) {
      return record(scope.attemptId, 'denied', 'stale-connection-generation');
    }
    if (this.liveProbe.isTurnCancelling?.(request.acpSessionId) === true) {
      return record(scope.attemptId, 'cancelled', 'turn-cancelling');
    }
    if (!this.liveProbe.isWorkspaceTrusted()) {
      return record(scope.attemptId, 'denied', 'workspace-untrusted');
    }
    if (!this.liveProbe.holdsPrimacy() || currentGen !== scope.ownershipGeneration) {
      return record(scope.attemptId, 'denied', 'ownership-lost');
    }
    if (!effectAllowedByCapabilities(scope.capabilities, request.requestKind, request.mutating)) {
      return record(scope.attemptId, 'denied', 'effect-not-declared');
    }

    if (request.targetPath !== undefined) {
      const resolvedTarget = normalizeCandidatePath(scope.executionRoot, request.targetPath);
      if (resolvedTarget === null) {
        return record(scope.attemptId, 'denied', 'outside-execution-root');
      }
      const allowedReadRefs = new Set((scope.authorizedUpstreamInputPaths ?? []).map((p) => path.resolve(p)));
      const allowedWriteRefs = new Set((scope.authorizedOutputPaths ?? []).map((p) => path.resolve(p)));
      const explicitlyAuthorizedRef = request.mutating
        ? allowedWriteRefs.has(resolvedTarget)
        : allowedReadRefs.has(resolvedTarget) || allowedWriteRefs.has(resolvedTarget);

      if (!explicitlyAuthorizedRef && isProtectedPath(resolvedTarget, scope)) {
        return record(scope.attemptId, 'denied', 'protected-target-refused');
      }
      if (!explicitlyAuthorizedRef && !isWithinDirectory(scope.executionRoot, resolvedTarget)) {
        return record(scope.attemptId, 'denied', 'outside-execution-root');
      }
    }

    if (request.mutating && request.effectRequestKey !== undefined) {
      const dedupeKey = `${scope.connectionGeneration}:${scope.acpSessionId}:${request.effectRequestKey}`;
      if (this.seenEffectKeys.has(dedupeKey)) {
        return record(scope.attemptId, 'denied', 'duplicate-effect-request');
      }
      if (this.seenEffectKeys.size >= MAX_TRACKED_EFFECT_KEYS) {
        const oldest = this.seenEffectKeys.values().next().value;
        if (oldest !== undefined) this.seenEffectKeys.delete(oldest);
      }
      this.seenEffectKeys.add(dedupeKey);
    }

    return record(scope.attemptId, 'allowed', 'authorized');
  }

  /**
   * Builds an `AcpPermissionPolicy` that re-evaluates workspace trust, primacy generation,
   * session-to-attempt binding, declared capabilities, and duplicate `toolCallId` replay on
   * every `session/request_permission` callback.
   */
  createPermissionPolicy(
    connectionGeneration: number,
    options: { readonly allowAuthorizedOnce?: boolean } = {}
  ): AcpPermissionPolicy {
    return (request: AcpPermissionRequest) => {
      const scope = this.scopesBySession.get(request.sessionId);
      if (scope === undefined || (request.attemptId !== null && request.attemptId !== scope.attemptId)) {
        this.authorize({
          requestKind: 'permission',
          acpSessionId: request.sessionId,
          connectionGeneration,
          mutating: true
        });
        return 'undecided';
      }

      const decision = this.authorize({
        requestKind: 'permission',
        acpSessionId: request.sessionId,
        connectionGeneration,
        ...(request.toolCallId !== null ? { effectRequestKey: request.toolCallId } : {}),
        mutating: true
      });
      if (!decision.allowed || options.allowAuthorizedOnce === false) {
        return 'undecided';
      }

      const allowOnce = request.options.find((opt) => opt.kind === 'allow_once');
      if (allowOnce !== undefined) {
        return { optionId: allowOnce.optionId };
      }
      return 'undecided';
    };
  }

  private persistReceiptIfConfigured(receipt: AcpAuthorizationReceipt, profileId: string): void {
    if (this.sqliteConnection === undefined) return;
    const dbRequestKind = receipt.requestKind === 'filesystem' ? 'fs' : receipt.requestKind;
    const dbDecision = receipt.decision === 'allowed' ? 'approved' : receipt.decision;
    try {
      this.sqliteConnection.run(
        `INSERT OR IGNORE INTO acp_authorization_receipts (
          receipt_id, profile_id, connection_generation, session_id, attempt_id,
          request_kind, idempotency_key, decision, reason_code, fenced_epoch, recorded_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        receipt.receiptId,
        profileId,
        Math.max(1, receipt.connectionGeneration),
        receipt.acpSessionId,
        receipt.attemptId === 'unattributed' ? null : receipt.attemptId,
        dbRequestKind,
        receipt.receiptId,
        dbDecision,
        receipt.reasonCode,
        Math.max(0, receipt.ownershipGeneration),
        receipt.decidedAtMs
      );
    } catch {
      // If the attempt row is synthetic or foreign-key unbound in a unit test, keep in-memory receipt.
    }
  }
}

/**
 * F09-FR-09 / F09-FR-10 / F09-AC-08 — verifies actual OS process-group exit after ACP prompt
 * completion or protocol cancellation. A successful `session/cancel` response never conceals a
 * surviving helper process.
 */
export async function verifyAcpTransportTeardown(
  transport: AcpStdioTransport,
  platform: NodeJS.Platform = process.platform
): Promise<TeardownQualification> {
  await transport.close();
  if (platform === 'win32') {
    return Object.freeze({
      outcome: 'unanswerable',
      residuals: Object.freeze(['descendants-outside-group-undetectable'] as const)
    });
  }
  if (!transport.isProcessTreeGone()) {
    return Object.freeze({
      outcome: 'residual',
      residuals: Object.freeze(['group-survived'] as const)
    });
  }
  return Object.freeze({
    outcome: 'group-exit-confirmed',
    residuals: Object.freeze(['descendants-outside-group-undetectable'] as const)
  });
}
