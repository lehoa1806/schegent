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
  AcpPermissionDecision,
  AcpPermissionPolicy,
  AcpPermissionRequest
} from '../../contracts/acp-runtime';
import { grants, type DeclaredCapabilitySet } from '../../contracts/phase-capabilities';
import type {
  AcpAuthorizationReason,
  TeardownQualification
} from '../../contracts/containment-qualification';
import {
  canonicalizePathWithTailSync,
  isTargetProtectedPathSync,
  isWorkspaceProtectedPattern,
  normalizeProtectedComparePath,
  verifySymlinkFreeUnderAnchorSync
} from '../../lib/protected-path-match';
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
  readonly protectedDatabasePaths?: readonly string[] | (() => readonly string[]) | undefined;
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
  verifyPrimacy?(): Promise<boolean>;
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
  /** Optional caller-claimed attempt id; when supplied (including `null` for unattributed callbacks), must match the registered session scope. */
  readonly attemptId?: string | null | undefined;
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

function normalizeCandidatePath(baseRoot: string, rawPath: string): string | null {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0 || rawPath.includes('\0')) {
    return null;
  }
  if (process.platform === 'win32') {
    if (/^[/\\](?![/\\])/.test(rawPath) || /^[A-Za-z]:(?![/\\])/.test(rawPath)) {
      return null;
    }
    if (
      rawPath
        .split(/[/\\]+/)
        .some((seg) => seg !== '' && seg !== '.' && seg !== '..' && /[. ]$/.test(seg))
    ) {
      return null;
    }
  }
  // Preserve `..` segments uncollapsed so `canonicalizePathWithTailSync` walks
  // symlinks left-to-right before applying `..` (matching POSIX kernel order).
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  const trimmedBase = baseRoot.endsWith(path.sep) ? baseRoot.slice(0, -1) : baseRoot;
  return `${trimmedBase}${path.sep}${rawPath}`;
}

function resolveScopeProtectedDatabasePaths(
  source: AcpAttemptAuthorityScope['protectedDatabasePaths']
): readonly string[] {
  if (source === undefined) return [];
  return typeof source === 'function' ? source() : source;
}

function isWithinDirectory(rootDir: string, targetPath: string): boolean {
  const resolvedRoot = normalizeProtectedComparePath(rootDir);
  const resolvedTarget = normalizeProtectedComparePath(targetPath);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function isProtectedPath(
  resolvedTarget: string,
  scope: AcpAttemptAuthorityScope
): boolean {
  if (isWorkspaceProtectedPattern(resolvedTarget)) {
    return true;
  }
  const dbPaths = resolveScopeProtectedDatabasePaths(scope.protectedDatabasePaths);
  if (dbPaths.length > 0 && isTargetProtectedPathSync(resolvedTarget, dbPaths)) {
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
  private readonly scopesBySession = new Map<string, Map<number, AcpAttemptAuthorityScope>>();
  private readonly seenEffectKeys = new Set<string>();
  private readonly receipts: AcpAuthorizationReceipt[] = [];
  private nextReceiptSeq = 1;

  constructor(
    private readonly liveProbe: AcpAuthorityLiveProbe,
    private readonly sqliteConnection?: AcpReceiptSqlSink
  ) {}

  registerScope(scope: AcpAttemptAuthorityScope): void {
    let byGeneration = this.scopesBySession.get(scope.acpSessionId);
    if (byGeneration === undefined) {
      byGeneration = new Map<number, AcpAttemptAuthorityScope>();
      this.scopesBySession.set(scope.acpSessionId, byGeneration);
    }
    byGeneration.set(scope.connectionGeneration, scope);
  }

  revokeSession(acpSessionId: string, connectionGeneration?: number): void {
    if (connectionGeneration === undefined) {
      this.scopesBySession.delete(acpSessionId);
      return;
    }
    const byGeneration = this.scopesBySession.get(acpSessionId);
    if (byGeneration === undefined) return;
    byGeneration.delete(connectionGeneration);
    if (byGeneration.size === 0) {
      this.scopesBySession.delete(acpSessionId);
    }
  }

  listReceipts(): readonly AcpAuthorizationReceipt[] {
    return [...this.receipts];
  }

  private resolveScope(
    acpSessionId: string,
    connectionGeneration: number
  ):
    | { readonly kind: 'matched'; readonly scope: AcpAttemptAuthorityScope }
    | { readonly kind: 'stale-generation'; readonly sibling: AcpAttemptAuthorityScope }
    | { readonly kind: 'missing' } {
    const byGeneration = this.scopesBySession.get(acpSessionId);
    if (byGeneration === undefined || byGeneration.size === 0) {
      return { kind: 'missing' };
    }
    const exact = byGeneration.get(connectionGeneration);
    if (exact !== undefined) {
      return { kind: 'matched', scope: exact };
    }
    let latestSibling: AcpAttemptAuthorityScope | undefined;
    for (const candidate of byGeneration.values()) {
      latestSibling = candidate;
    }
    return latestSibling !== undefined
      ? { kind: 'stale-generation', sibling: latestSibling }
      : { kind: 'missing' };
  }

  private makeRecorder(
    request: AcpCallbackAuthorizationRequest,
    profileId: string,
    nowMs: number,
    currentGen: number,
    canPersistReceipt: boolean
  ): (
    attemptId: string,
    decision: 'allowed' | 'denied' | 'cancelled',
    reason: AcpAuthorizationReason
  ) => AcpAuthorizationDecision {
    return (attemptId, decision, reason) => {
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
      if (canPersistReceipt) {
        this.persistReceiptIfConfigured(receipt, profileId);
      }
      return {
        allowed: decision === 'allowed',
        decision,
        reason,
        receipt
      };
    };
  }

  authorize(request: AcpCallbackAuthorizationRequest): AcpAuthorizationDecision {
    return this.authorizeInternal(request, true);
  }

  private authorizeInternal(
    request: AcpCallbackAuthorizationRequest,
    allowPersistReceipt: boolean
  ): AcpAuthorizationDecision {
    const nowMs = this.liveProbe.nowMs ? this.liveProbe.nowMs() : Date.now();
    const currentGen = this.liveProbe.currentOwnershipGeneration();
    const trusted = this.liveProbe.isWorkspaceTrusted();
    const holdsPrimacy = this.liveProbe.holdsPrimacy();
    const resolved = this.resolveScope(request.acpSessionId, request.connectionGeneration);
    const scope = resolved.kind === 'matched' ? resolved.scope : undefined;
    const sibling = resolved.kind === 'stale-generation' ? resolved.sibling : undefined;
    const record = this.makeRecorder(
      request,
      scope?.profileId ?? sibling?.profileId ?? 'unattributed',
      nowMs,
      currentGen,
      allowPersistReceipt && trusted && holdsPrimacy
    );

    if (resolved.kind === 'missing') {
      return record('unattributed', 'denied', 'session-attempt-mismatch');
    }
    if (resolved.kind === 'stale-generation') {
      return record(resolved.sibling.attemptId, 'denied', 'stale-connection-generation');
    }
    const matched = resolved.scope;
    if (request.attemptId !== undefined && request.attemptId !== matched.attemptId) {
      return record(matched.attemptId, 'denied', 'session-attempt-mismatch');
    }
    if (this.liveProbe.isTurnCancelling?.(request.acpSessionId) === true) {
      return record(matched.attemptId, 'cancelled', 'turn-cancelling');
    }
    if (!trusted) {
      return record(matched.attemptId, 'denied', 'workspace-untrusted');
    }
    if (!holdsPrimacy || currentGen !== matched.ownershipGeneration) {
      return record(matched.attemptId, 'denied', 'ownership-lost');
    }
    return this.evaluatePostPrimacyChecks(matched, request, record);
  }

  /**
   * FR-R7-14 (14-07) — awaits an authoritative live primacy probe (`verifyPrimacy()`) before
   * authorizing sensitive callbacks, then re-validates scope registration, attempt binding,
   * cancellation, workspace trust, primacy, ownership generation, capabilities, path containment,
   * and duplicate effect replay against the post-await state.
   */
  async authorizeAsync(request: AcpCallbackAuthorizationRequest): Promise<AcpAuthorizationDecision> {
    if (this.liveProbe.verifyPrimacy === undefined) {
      return this.authorize(request);
    }

    const preNowMs = this.liveProbe.nowMs ? this.liveProbe.nowMs() : Date.now();
    const preGen = this.liveProbe.currentOwnershipGeneration();
    const preTrusted = this.liveProbe.isWorkspaceTrusted();
    const preResolved = this.resolveScope(request.acpSessionId, request.connectionGeneration);
    const preProfile =
      preResolved.kind === 'matched'
        ? (preResolved.scope.profileId ?? 'unattributed')
        : preResolved.kind === 'stale-generation'
          ? (preResolved.sibling.profileId ?? 'unattributed')
          : 'unattributed';
    // Never persist SQLite receipts on pre-await fast-fail branches before `verifyPrimacy()` settles.
    const preRecord = this.makeRecorder(request, preProfile, preNowMs, preGen, false);

    if (preResolved.kind === 'missing') {
      return preRecord('unattributed', 'denied', 'session-attempt-mismatch');
    }
    if (preResolved.kind === 'stale-generation') {
      return preRecord(preResolved.sibling.attemptId, 'denied', 'stale-connection-generation');
    }
    const preScope = preResolved.scope;
    if (request.attemptId !== undefined && request.attemptId !== preScope.attemptId) {
      return preRecord(preScope.attemptId, 'denied', 'session-attempt-mismatch');
    }
    if (this.liveProbe.isTurnCancelling?.(request.acpSessionId) === true) {
      return preRecord(preScope.attemptId, 'cancelled', 'turn-cancelling');
    }
    if (!preTrusted) {
      return preRecord(preScope.attemptId, 'denied', 'workspace-untrusted');
    }
    if (preGen !== preScope.ownershipGeneration) {
      return preRecord(preScope.attemptId, 'denied', 'ownership-lost');
    }

    let primacyHeld: boolean;
    try {
      primacyHeld = (await this.liveProbe.verifyPrimacy()) === true;
    } catch {
      primacyHeld = false;
    }

    const postNowMs = this.liveProbe.nowMs ? this.liveProbe.nowMs() : Date.now();
    const postGen = this.liveProbe.currentOwnershipGeneration();
    const postTrusted = this.liveProbe.isWorkspaceTrusted();
    const postResolved = this.resolveScope(request.acpSessionId, request.connectionGeneration);
    const postProfile =
      postResolved.kind === 'matched'
        ? (postResolved.scope.profileId ?? 'unattributed')
        : postResolved.kind === 'stale-generation'
          ? (postResolved.sibling.profileId ?? 'unattributed')
          : 'unattributed';
    const postCanPersist =
      postTrusted &&
      primacyHeld &&
      postGen === preGen &&
      (postResolved.kind !== 'matched' || postGen === postResolved.scope.ownershipGeneration);
    const postRecord = this.makeRecorder(
      request,
      postProfile,
      postNowMs,
      postGen,
      postCanPersist
    );

    if (postResolved.kind === 'missing') {
      return postRecord('unattributed', 'denied', 'session-attempt-mismatch');
    }
    if (postResolved.kind === 'stale-generation') {
      return postRecord(postResolved.sibling.attemptId, 'denied', 'stale-connection-generation');
    }
    const postScope = postResolved.scope;
    if (request.attemptId !== undefined && request.attemptId !== postScope.attemptId) {
      return postRecord(postScope.attemptId, 'denied', 'session-attempt-mismatch');
    }
    if (this.liveProbe.isTurnCancelling?.(request.acpSessionId) === true) {
      return postRecord(postScope.attemptId, 'cancelled', 'turn-cancelling');
    }
    if (!postTrusted) {
      return postRecord(postScope.attemptId, 'denied', 'workspace-untrusted');
    }
    if (!primacyHeld || postGen !== postScope.ownershipGeneration) {
      return postRecord(postScope.attemptId, 'denied', 'ownership-lost');
    }
    return this.evaluatePostPrimacyChecks(postScope, request, postRecord);
  }

  private evaluatePostPrimacyChecks(
    scope: AcpAttemptAuthorityScope,
    request: AcpCallbackAuthorizationRequest,
    record: (
      attemptId: string,
      decision: 'allowed' | 'denied' | 'cancelled',
      reason: AcpAuthorizationReason
    ) => AcpAuthorizationDecision
  ): AcpAuthorizationDecision {
    if (!effectAllowedByCapabilities(scope.capabilities, request.requestKind, request.mutating)) {
      return record(scope.attemptId, 'denied', 'effect-not-declared');
    }

    if (request.targetPath !== undefined) {
      const resolvedTarget = normalizeCandidatePath(scope.executionRoot, request.targetPath);
      if (resolvedTarget === null) {
        return record(scope.attemptId, 'denied', 'outside-execution-root');
      }
      const dbPaths = resolveScopeProtectedDatabasePaths(scope.protectedDatabasePaths);
      if (dbPaths.length > 0 && isTargetProtectedPathSync(resolvedTarget, dbPaths)) {
        return record(scope.attemptId, 'denied', 'protected-target-refused');
      }
      const targetCanon = canonicalizePathWithTailSync(resolvedTarget);
      if (!targetCanon.ok) {
        return record(scope.attemptId, 'denied', 'outside-execution-root');
      }
      const canonicalTarget = targetCanon.canonical;
      // Win32 verbatim extended-length paths (`\\?\...`) are already validated by
      // `canonicalizePathWithTailSync` to contain zero `/`, `.`, or `..` segments,
      // and passing `\\?\C:\` to `path.win32.resolve` would corrupt it to `\\?\C:`.
      const isWin32Verbatim = process.platform === 'win32' && resolvedTarget.startsWith('\\\\?\\');
      const lexicalResolved = isWin32Verbatim ? resolvedTarget : path.resolve(resolvedTarget);
      const lexicalCanon = isWin32Verbatim
        ? targetCanon
        : canonicalizePathWithTailSync(lexicalResolved);
      if (!lexicalCanon.ok) {
        return record(scope.attemptId, 'denied', 'outside-execution-root');
      }
      const canonicalLexicalTarget = lexicalCanon.canonical;
      if (
        dbPaths.length > 0 &&
        (isTargetProtectedPathSync(canonicalTarget, dbPaths) ||
          isTargetProtectedPathSync(lexicalResolved, dbPaths) ||
          isTargetProtectedPathSync(canonicalLexicalTarget, dbPaths))
      ) {
        return record(scope.attemptId, 'denied', 'protected-target-refused');
      }

      const rootCanon = canonicalizePathWithTailSync(scope.executionRoot);
      const primaryCanon =
        scope.primaryWorkspaceRoot !== undefined
          ? canonicalizePathWithTailSync(scope.primaryWorkspaceRoot)
          : null;
      const anchorPairs: Array<{ readonly raw: string; readonly canonical: string }> = [];
      if (rootCanon.ok) {
        anchorPairs.push({ raw: scope.executionRoot, canonical: rootCanon.canonical });
      }
      if (scope.primaryWorkspaceRoot !== undefined && primaryCanon !== null && primaryCanon.ok) {
        anchorPairs.push({ raw: scope.primaryWorkspaceRoot, canonical: primaryCanon.canonical });
      }

      const verifyAuthorizedRefPath = (candidatePath: string): string | null => {
        for (const anchor of anchorPairs) {
          const verified = verifySymlinkFreeUnderAnchorSync(
            anchor.raw,
            anchor.canonical,
            candidatePath
          );
          if (verified !== null) {
            if (isWorkspaceProtectedPattern(verified, { allowSchegent: true })) {
              return null;
            }
            if (dbPaths.length > 0 && isTargetProtectedPathSync(verified, dbPaths)) {
              return null;
            }
            return normalizeProtectedComparePath(verified);
          }
        }
        return null;
      };

      const toAuthorizedCanonicalSet = (paths: readonly string[] | undefined): ReadonlySet<string> => {
        const set = new Set<string>();
        for (const p of paths ?? []) {
          const verified = verifyAuthorizedRefPath(p);
          if (verified !== null) set.add(verified);
        }
        return set;
      };
      const allowedReadRefs = toAuthorizedCanonicalSet(scope.authorizedUpstreamInputPaths);
      const allowedWriteRefs = toAuthorizedCanonicalSet(scope.authorizedOutputPaths);
      // Require the requested target itself to be symlink-free beneath an authorized
      // anchor so a planted symlink cannot escalate into an authorized ref entry.
      const verifiedRequestRef = verifyAuthorizedRefPath(resolvedTarget);
      const normCanonicalTarget = normalizeProtectedComparePath(canonicalTarget);
      const matchesAuthorizedRefSet = (refs: ReadonlySet<string>): boolean =>
        verifiedRequestRef !== null &&
        verifiedRequestRef === normCanonicalTarget &&
        refs.has(normCanonicalTarget);
      const explicitlyAuthorizedRef = request.mutating
        ? matchesAuthorizedRefSet(allowedWriteRefs)
        : matchesAuthorizedRefSet(allowedReadRefs) || matchesAuthorizedRefSet(allowedWriteRefs);

      if (
        !explicitlyAuthorizedRef &&
        (isProtectedPath(resolvedTarget, scope) ||
          isProtectedPath(canonicalTarget, scope) ||
          isProtectedPath(lexicalResolved, scope) ||
          isProtectedPath(canonicalLexicalTarget, scope))
      ) {
        return record(scope.attemptId, 'denied', 'protected-target-refused');
      }
      // Enforce BOTH canonical (POSIX symlink-before-`..`) and lexical-then-canonical
      // (Win32 `..`-before-symlink) execution-root containment so neither kernel
      // resolution order can escape via symlinks or NTFS junctions.
      const lexicallyWithinRoot =
        isWithinDirectory(scope.executionRoot, lexicalResolved) ||
        (rootCanon.ok && isWithinDirectory(rootCanon.canonical, lexicalResolved));
      if (
        !explicitlyAuthorizedRef &&
        (!rootCanon.ok ||
          !lexicallyWithinRoot ||
          !isWithinDirectory(rootCanon.canonical, canonicalTarget) ||
          !isWithinDirectory(rootCanon.canonical, canonicalLexicalTarget))
      ) {
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
    const pickOption = (
      request: AcpPermissionRequest,
      allowed: boolean
    ): AcpPermissionDecision => {
      if (!allowed || options.allowAuthorizedOnce === false) {
        return 'undecided';
      }
      const allowOnce = request.options.find((opt) => opt.kind === 'allow_once');
      return allowOnce !== undefined ? { optionId: allowOnce.optionId } : 'undecided';
    };

    return (request: AcpPermissionRequest) => {
      const resolved = this.resolveScope(request.sessionId, connectionGeneration);
      if (resolved.kind !== 'matched' || request.attemptId !== resolved.scope.attemptId) {
        this.authorizeInternal(
          {
            requestKind: 'permission',
            acpSessionId: request.sessionId,
            connectionGeneration,
            attemptId: request.attemptId,
            mutating: true
          },
          this.liveProbe.verifyPrimacy === undefined
        );
        return 'undecided';
      }

      const authRequest: AcpCallbackAuthorizationRequest = {
        requestKind: 'permission',
        acpSessionId: request.sessionId,
        connectionGeneration,
        attemptId: request.attemptId,
        ...(request.toolCallId !== null ? { effectRequestKey: request.toolCallId } : {}),
        mutating: true
      };

      if (this.liveProbe.verifyPrimacy !== undefined) {
        return this.authorizeAsync(authRequest).then(
          (decision) => pickOption(request, decision.allowed),
          () => 'undecided'
        );
      }

      const decision = this.authorize(authRequest);
      return pickOption(request, decision.allowed);
    };
  }

  private persistReceiptIfConfigured(receipt: AcpAuthorizationReceipt, profileId: string): void {
    if (this.sqliteConnection === undefined) return;
    // Never write to the shared SQLite store from a window that has lost ownership or workspace trust.
    if (
      receipt.reasonCode === 'ownership-lost' ||
      receipt.reasonCode === 'workspace-untrusted'
    ) {
      return;
    }
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
