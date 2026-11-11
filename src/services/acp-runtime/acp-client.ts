/**
 * FR-R6-F13 (F13-A; FR-001 to FR-020) — one host-owned ACP connection to one agent process.
 *
 * Open order: profile and generation validation, qualification (an unqualified profile is never
 * launched), launch, `initialize` within the handshake deadline, version and capability checks.
 * A refusal after launch closes the transport before it is returned. There is no fallback.
 *
 * - Every agent stdout byte goes through the frame decoder and the JSON-RPC layer; stderr goes
 *   only to the sanitized tail. Any transport failure fails the connection once, settles every
 *   written request `lost`, and tears the transport down once.
 * - One pipe read can hold several messages. The answer to `session/new`, `session/load` and
 *   `session/prompt` is applied in the settle hook, while it is being routed, so the next message
 *   of the same read sees the session, the end of the load, or the end of the turn.
 * - A written prompt that loses its transport is `uncertain` and is never re-sent (FR-020).
 * - `completed` and `cancelled` outcomes still need host validation (FR-012, FR-022).
 * - Permission requests are answered synchronously by the policy or the fail-closed fallback;
 *   every other agent request is refused `Method not found` (FR-009, FR-010).
 *
 * Zero `vscode` imports. No activation path constructs this in F13-A.
 */
import {
  ACP_RUNTIME_LIMITS,
  isValidProfile,
  type AcpClock,
  type AcpConnection,
  type AcpConnectionProjection,
  type AcpConnectionState,
  type AcpFailureReason,
  type AcpOpenOptions,
  type AcpOpenResult,
  type AcpPromptOutcome,
  type AcpPromptRequest,
  type AcpRefusalReason,
  type AcpSessionResult,
  type AcpTransport,
  type AgentProfile,
  type NegotiatedCapabilities
} from '../../contracts/acp-runtime';
import { initializeParams, missingRequirement, negotiate, operationAllowed } from './capability-negotiation';
import {
  buildUsageUpdate,
  failureOf,
  isHostIdentifier,
  isNonEmpty,
  isRecord,
  isSessionId,
  qualifies,
  stopReasonOf,
  withDetail
} from './client-guards';
import { buildProjection, emptyClientCounters } from './connection-projection';
import { deferred } from './deferred';
import { FrameDecoder } from './frame-decoder';
import { JSON_RPC_INVALID_PARAMS, JSON_RPC_METHOD_NOT_FOUND, type RpcId } from './json-rpc-message';
import { ObservationEmitter } from './observation-emitter';
import { decidePermission, parsePermissionParams } from './permission-policy';
import { buildPromptContent } from './prompt-content';
import { RpcConnection, type RpcSettlement } from './rpc-connection';
import { mapSessionUpdate, toNormalizedEvent } from './session-update-mapper';
import { SessionTable, type TurnState } from './session-state';
import { StderrTail } from './stderr-tail';
import { SYSTEM_CLOCK } from './system-clock';

type Refusal = { readonly reason: AcpRefusalReason; readonly detail?: string };

const LOAD_SESSION_REQUIREMENT = 'load-session';

class AcpClientConnection implements AcpConnection {
  private readonly profile: AgentProfile;
  private readonly generation: number;
  private readonly clock: AcpClock;
  private readonly rpc: RpcConnection;
  private readonly decoder = new FrameDecoder();
  private readonly tail = new StderrTail();
  private readonly sessions: SessionTable;
  private readonly observer: ObservationEmitter;
  private readonly counters = emptyClientCounters();
  private state: AcpConnectionState = 'initializing';
  private capabilities: NegotiatedCapabilities | null = null;
  private lastRefusal: AcpRefusalReason | null = null;
  private lastFailure: AcpFailureReason | null = null;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly options: AcpOpenOptions,
    private readonly transport: AcpTransport
  ) {
    this.profile = options.profile;
    this.generation = options.generation;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.sessions = new SessionTable(this.profile.profileId, this.generation);
    this.observer = new ObservationEmitter(this.generation, this.clock, options.onObservation);
    this.rpc = new RpcConnection((line) => transport.write(line), this.clock, {
      onRequest: (id, method, params) => this.onAgentRequest(id, method, params),
      onNotification: (method, params) => this.onNotification(method, params),
      onFailure: (reason) => this.onFailure(reason)
    });
    transport.onStdout((chunk) => this.onStdout(chunk));
    transport.onStderr((chunk) => this.tail.push(chunk));
    transport.onClose(() => this.rpc.fail('transport-closed'));
  }

  /** `initialize` and the capability checks; null when the connection is ready. */
  async handshake(): Promise<Extract<AcpOpenResult, { ok: false }> | null> {
    const settlement = await this.rpc.request('initialize', initializeParams(), ACP_RUNTIME_LIMITS.handshakeDeadlineMs).settled;
    if (settlement.kind !== 'result') return { ok: false, refusal: failureOf(settlement) };
    const negotiated = negotiate(settlement.value);
    if (!negotiated.ok) return { ok: false, refusal: negotiated.reason };
    const missing = missingRequirement(this.profile, negotiated.capabilities);
    if (missing !== null) return { ok: false, refusal: 'capability-missing', detail: missing };
    this.capabilities = negotiated.capabilities;
    this.state = 'ready';
    return null;
  }

  async newSession(cwd: string): Promise<AcpSessionResult> {
    if (this.state !== 'ready') return this.refuseSession({ reason: 'connection-not-ready' });
    if (!isNonEmpty(cwd)) return this.refuseSession({ reason: 'invalid-input' });
    const params = { cwd, mcpServers: [] };
    return this.exchange('session/new', params, (settlement) => this.adoptSession(settlement));
  }

  async loadSession(sessionId: string, cwd: string, options: { readonly mayLoad: boolean }): Promise<AcpSessionResult> {
    const refusal = this.loadRefusal(sessionId, cwd, options);
    if (refusal !== null) return this.refuseSession(refusal);
    this.sessions.add(sessionId, true);
    const params = { sessionId, cwd, mcpServers: [] };
    return this.exchange('session/load', params, (settlement) => this.finishLoad(sessionId, settlement));
  }

  async prompt(request: AcpPromptRequest): Promise<AcpPromptOutcome> {
    const checked = this.checkPrompt(request);
    if (!checked.ok) {
      this.lastRefusal = checked.refusal.reason;
      return withDetail({ kind: 'refused', reason: checked.refusal.reason }, checked.refusal.detail);
    }
    const { sessionId, attemptId, rootId } = request;
    const open: { turn: TurnState | null } = { turn: null };
    const begin = (id: number): TurnState => (open.turn ??= this.startTurn(sessionId, id, attemptId, rootId));
    const done = deferred<AcpPromptOutcome>();
    const call = this.rpc.request('session/prompt', { sessionId, prompt: checked.blocks }, undefined, (settlement, id) => {
      done.resolve(this.finishTurn(sessionId, begin(id), settlement));
      this.sessions.endTurn(sessionId);
    });
    if (call.id === null) return { kind: 'not-dispatched', reason: failureOf(await call.settled) };
    begin(call.id);
    return done.promise;
  }

  cancel(sessionId: string): void {
    if (this.state !== 'ready') return;
    const turn = this.sessions.turnOf(sessionId);
    if (turn === null || turn.cancelling) return;
    turn.cancelling = true;
    this.rpc.notify('session/cancel', { sessionId });
    turn.cancelTimer = this.clock.setTimer(() => this.rpc.fail('cancel-bound-elapsed'), ACP_RUNTIME_LIMITS.cancelBoundMs);
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    if (this.state !== 'failed') this.state = 'draining';
    await this.teardown();
    this.rpc.fail('transport-closed');
    this.state = 'closed';
  }

  describe(): AcpConnectionProjection {
    return buildProjection({
      profile: this.profile,
      generation: this.generation,
      state: this.state,
      capabilities: this.capabilities,
      lastRefusal: this.lastRefusal,
      lastFailure: this.lastFailure,
      sessionCount: this.sessions.size,
      rpcCounters: this.rpc.counters,
      counters: this.counters
    });
  }

  stderrTail(): string {
    return this.tail.text();
  }

  /**
   * Closes the transport once; every later call returns the same promise. A transport may report
   * its close synchronously from inside `close()`, so the guard is set before the call.
   */
  teardown(): Promise<void> {
    if (this.closing !== null) return this.closing;
    let settle: () => void = () => undefined;
    this.closing = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let closed: Promise<void>;
    try {
      closed = this.transport.close();
    } catch {
      closed = Promise.resolve();
    }
    closed.then(settle, settle);
    return this.closing;
  }

  /** A refused open: the connection never becomes usable. */
  async discard(): Promise<void> {
    if (this.state !== 'failed') this.state = 'closed';
    await this.teardown();
  }

  private refuseSession(refusal: Refusal): AcpSessionResult {
    this.lastRefusal = refusal.reason;
    return withDetail({ ok: false, reason: refusal.reason }, refusal.detail);
  }

  private loadRefusal(sessionId: string, cwd: string, options: { readonly mayLoad: boolean }): Refusal | null {
    if (this.state !== 'ready' || this.capabilities === null) return { reason: 'connection-not-ready' };
    if (!isRecord(options) || options.mayLoad !== true) return { reason: 'fresh-session-required' };
    if (!operationAllowed('session-load', this.capabilities)) {
      return { reason: 'capability-missing', detail: LOAD_SESSION_REQUIREMENT };
    }
    if (!isSessionId(sessionId) || !isNonEmpty(cwd) || this.sessions.has(sessionId)) return { reason: 'invalid-input' };
    return null;
  }

  private checkPrompt(
    request: AcpPromptRequest
  ): { ok: true; blocks: readonly Record<string, unknown>[] } | { ok: false; refusal: Refusal } {
    if (this.state !== 'ready' || this.capabilities === null) return { ok: false, refusal: { reason: 'connection-not-ready' } };
    if (!isRecord(request) || !isSessionId(request.sessionId)) return { ok: false, refusal: { reason: 'invalid-input' } };
    if (!isHostIdentifier(request.attemptId) || !isHostIdentifier(request.rootId)) {
      return { ok: false, refusal: { reason: 'invalid-input' } };
    }
    if (!this.sessions.has(request.sessionId)) return { ok: false, refusal: { reason: 'session-unknown' } };
    if (this.sessions.isLoading(request.sessionId) || this.sessions.turnOf(request.sessionId) !== null) {
      return { ok: false, refusal: { reason: 'prompt-in-flight' } };
    }
    const content = buildPromptContent(request.blocks, this.capabilities, this.options.verifyResourceLink);
    if (!content.ok) return { ok: false, refusal: withDetail({ reason: content.reason }, content.detail) };
    return { ok: true, blocks: content.blocks };
  }

  /** One handshake-bounded session request. `apply` runs while its answer is being routed. */
  private exchange(
    method: string,
    params: unknown,
    apply: (settlement: RpcSettlement) => AcpSessionResult
  ): Promise<AcpSessionResult> {
    const done = deferred<AcpSessionResult>();
    const hook = (settlement: RpcSettlement): void => done.resolve(apply(settlement));
    const call = this.rpc.request(method, params, ACP_RUNTIME_LIMITS.handshakeDeadlineMs, hook);
    return call.id === null ? call.settled.then(apply) : done.promise;
  }

  private adoptSession(settlement: RpcSettlement): AcpSessionResult {
    if (settlement.kind === 'error') return { ok: false, reason: 'rejected', code: settlement.code };
    if (settlement.kind !== 'result') return { ok: false, reason: failureOf(settlement) };
    const sessionId = isRecord(settlement.value) ? settlement.value['sessionId'] : undefined;
    if (!isSessionId(sessionId) || this.sessions.has(sessionId)) {
      this.rpc.fail('protocol-violation');
      return { ok: false, reason: 'protocol-violation' };
    }
    this.sessions.add(sessionId, false);
    return { ok: true, sessionId };
  }

  private finishLoad(sessionId: string, settlement: RpcSettlement): AcpSessionResult {
    if (settlement.kind === 'result') {
      this.sessions.endLoad(sessionId);
      return { ok: true, sessionId };
    }
    this.sessions.delete(sessionId);
    if (settlement.kind === 'error') return { ok: false, reason: 'rejected', code: settlement.code };
    return { ok: false, reason: failureOf(settlement) };
  }

  private startTurn(sessionId: string, requestId: number, attemptId: string, rootId: string): TurnState {
    const turn = this.sessions.beginTurn(sessionId, requestId, attemptId, rootId);
    this.observer.emit(sessionId, this.sessions.attributionFor(sessionId), () => ({ kind: 'turn-started', requestId }));
    return turn;
  }

  private finishTurn(sessionId: string, turn: TurnState, settlement: RpcSettlement): AcpPromptOutcome {
    if (settlement.kind === 'error') return { kind: 'rejected', turnId: turn.turnId, code: settlement.code };
    if (settlement.kind !== 'result') return { kind: 'uncertain', turnId: turn.turnId, reason: settlement.reason };
    const stopReason = stopReasonOf(settlement.value);
    if (stopReason === null) {
      this.rpc.fail('protocol-violation');
      return { kind: 'uncertain', turnId: turn.turnId, reason: 'protocol-violation' };
    }
    this.observer.emit(sessionId, this.sessions.attributionFor(sessionId), () => ({
      kind: 'turn-completed',
      requestId: turn.requestId,
      stopReason
    }));
    if (stopReason === 'cancelled') return { kind: 'cancelled', turnId: turn.turnId, hostValidationRequired: true };
    return { kind: 'completed', turnId: turn.turnId, stopReason, hostValidationRequired: true };
  }

  private onStdout(chunk: Uint8Array): void {
    const decoded = this.decoder.push(chunk);
    if (!decoded.ok) {
      this.rpc.fail(decoded.reason);
      return;
    }
    for (const message of decoded.messages) {
      if (this.rpc.failure !== null) return;
      this.rpc.receive(message);
    }
  }

  private onFailure(reason: AcpFailureReason): void {
    if (this.state !== 'draining' && this.state !== 'closed') {
      this.state = 'failed';
      this.lastFailure = reason;
    }
    for (const turn of this.sessions.openTurns()) turn.cancelTimer?.cancel();
    void this.teardown();
  }

  private onAgentRequest(id: RpcId, method: string, params: unknown): void {
    if (method !== 'session/request_permission') {
      this.counters.refusedAgentRequests += 1;
      this.rpc.respondError(id, JSON_RPC_METHOD_NOT_FOUND, 'Method not found');
      return;
    }
    this.counters.permissionRequests += 1;
    const parsed = parsePermissionParams(params);
    if (!parsed.ok || !this.sessions.has(parsed.sessionId)) {
      this.rpc.respondError(id, JSON_RPC_INVALID_PARAMS, 'Invalid params');
      return;
    }
    const turn = this.sessions.turnOf(parsed.sessionId);
    const permission = {
      sessionId: parsed.sessionId,
      attemptId: turn === null ? null : turn.attemptId,
      toolCallId: parsed.toolCallId,
      toolTitle: parsed.toolTitle,
      options: parsed.options
    };
    const cancelling = turn !== null && turn.cancelling;
    this.rpc.respond(id, { outcome: decidePermission(permission, this.options.permissionPolicy, cancelling) });
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'session/update') {
      this.counters.unknownNotifications += 1;
      return;
    }
    if (!isRecord(params) || !isSessionId(params['sessionId'])) {
      this.counters.ignoredUpdates += 1;
      return;
    }
    const sessionId = params['sessionId'];
    if (!this.sessions.has(sessionId)) {
      this.counters.staleUpdates += 1;
      return;
    }
    const mapped = mapSessionUpdate(params['update']);
    if (mapped.kind === 'ignored') {
      this.counters.ignoredUpdates += 1;
      return;
    }
    const attribution = this.sessions.attributionFor(sessionId);
    if (mapped.kind === 'display') {
      const context = { generation: this.generation, attemptId: attribution.attemptId, origin: attribution.origin };
      const event = toNormalizedEvent(mapped.part, context);
      this.observer.emit(sessionId, attribution, () => ({ kind: 'display', event }));
      return;
    }
    const { profileId } = this.profile;
    const { generation } = this;
    this.observer.emit(sessionId, attribution, (hostReceiveSeq, eventUtc) => ({
      kind: 'usage',
      usage: buildUsageUpdate({ profileId, generation, sessionId, attribution, hostReceiveSeq, eventUtc }, mapped.usage)
    }));
  }
}

/** Opens one connection, or says why it was refused. */
export async function openAcpConnection(options: AcpOpenOptions): Promise<AcpOpenResult> {
  if (!isRecord(options) || !isValidProfile(options.profile)) return { ok: false, refusal: 'invalid-input' };
  if (!Number.isSafeInteger(options.generation) || options.generation < 1) return { ok: false, refusal: 'invalid-input' };
  if (!qualifies(options.profile, options.allowFixtureProfiles === true)) return { ok: false, refusal: 'profile-unqualified' };
  let transport: AcpTransport;
  try {
    transport = options.launch(options.profile);
  } catch {
    return { ok: false, refusal: 'transport-closed' };
  }
  const connection = new AcpClientConnection(options, transport);
  const refusal = await connection.handshake();
  if (refusal === null) return { ok: true, connection };
  await connection.discard();
  return refusal;
}
