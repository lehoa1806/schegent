/**
 * FR-R6-F13 (FR-001, FR-012, FR-015, research R5) — the pure checks and builders the ACP client
 * uses: input shapes, profile qualification, stop-reason validation and the usage update.
 *
 * Zero `vscode` imports.
 */
import {
  ACP_STOP_REASONS,
  type AcpFailureReason,
  type AcpObservation,
  type AcpPermissionDecision,
  type AcpPermissionPolicy,
  type AcpPromptOutcome,
  type AcpStopReason,
  type AgentProfile
} from '../../contracts/acp-runtime';
import type { AcpUsageUpdate } from '../usage-accounting/acp-usage-mapping';
import { isAgentIdentifier, sanitizeAgentDisplayTitle } from './agent-identifier';
import { sanitizePermissionRequest } from './permission-policy';
import type { RpcSettlement } from './rpc-connection';
import type { UsageReading } from './session-update-mapper';
import type { Attribution } from './session-state';

/** Host identities (attempt, root) use the bounded identifier F06 attributes by. */
const HOST_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STOP_REASONS: ReadonlySet<string> = new Set(ACP_STOP_REASONS);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isSessionId(value: unknown): value is string {
  return isAgentIdentifier(value);
}

export function isHostIdentifier(value: unknown): value is string {
  return typeof value === 'string' && HOST_IDENTIFIER.test(value);
}

/** A fixture profile is launched only when the caller opted in (tests and the smoke harness). */
export function qualifies(profile: AgentProfile, allowFixtureProfiles: boolean): boolean {
  if (profile.qualification === 'qualified') return true;
  return profile.qualification === 'fixture' && allowFixtureProfiles;
}

/** The prompt result's stop reason, or null when it is missing or not an ACP v1 value. */
export function stopReasonOf(value: unknown): AcpStopReason | null {
  if (!isRecord(value)) return null;
  const stopReason = value['stopReason'];
  return typeof stopReason === 'string' && STOP_REASONS.has(stopReason) ? (stopReason as AcpStopReason) : null;
}

/** Why a request produced no answer; an error answer here is a protocol violation. */
export function failureOf(settlement: RpcSettlement): AcpFailureReason {
  return settlement.kind === 'lost' || settlement.kind === 'not-dispatched' ? settlement.reason : 'protocol-violation';
}

/** Adds `detail` only when there is one, so no `detail: undefined` key appears. */
export function withDetail<T extends object>(base: T, detail: string | undefined): T & { detail?: string } {
  return detail === undefined ? base : { ...base, detail };
}

export interface UsageContext {
  readonly profileId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly attribution: Attribution;
  readonly hostReceiveSeq: number;
  readonly eventUtc: string;
  readonly providerSessionId?: string | null;
}

/** The F06 usage update for one `usage_update`; a loaded-history reading is `replayed`. */
export function buildUsageUpdate(context: UsageContext, reading: UsageReading): AcpUsageUpdate {
  const providerSessionId =
    typeof context.providerSessionId === 'string' && context.providerSessionId.length > 0
      ? context.providerSessionId
      : undefined;
  return {
    profileId: context.profileId,
    acpSessionId: context.sessionId,
    connectionGeneration: context.generation,
    turnId: context.attribution.turnId,
    hostReceiveSeq: context.hostReceiveSeq,
    eventUtc: context.eventUtc,
    replayed: context.attribution.origin === 'history',
    used: reading.used,
    size: reading.size,
    hasQualifiedSessionBaseline: false,
    ...(reading.cost !== undefined ? { cost: reading.cost } : {}),
    ...(reading.producerEventId !== undefined ? { producerEventId: reading.producerEventId } : {}),
    ...(reading.billableTokens !== undefined ? { billableTokens: reading.billableTokens } : {}),
    ...(providerSessionId !== undefined ? { providerSessionId } : {})
  };
}

export type AcpLifecycleObservationBody =
  | { readonly kind: 'permission-requested'; readonly permissionRequestId: string }
  | { readonly kind: 'permission-resolved'; readonly permissionRequestId: string; readonly granted: boolean }
  | { readonly kind: 'turn-canceled'; readonly reason?: AcpFailureReason | 'cancelled' }
  | { readonly kind: 'turn-uncertain'; readonly reason: AcpFailureReason }
  | { readonly kind: 'transport-disconnected'; readonly reason: AcpFailureReason };

export interface AcpRunnerObservationBridge {
  forward(observation: AcpObservation): void;
  emitLifecycle(
    body: AcpLifecycleObservationBody,
    override?: { readonly sessionId?: string | null; readonly turnId?: string }
  ): void;
  recordPromptOutcome(sessionId: string, outcome: AcpPromptOutcome): void;
  wrapPermissionPolicy(
    basePolicy: AcpPermissionPolicy | undefined,
    logger?: { info(message: string, meta?: Record<string, unknown>): void }
  ): AcpPermissionPolicy;
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * FR-R7-17 (`R7-17-05`) — keeps `hostReceiveSeq` strictly monotonic across protocol observations
 * and runner-emitted durable ACP lifecycle observations (`permission-requested`,
 * `permission-resolved`, `turn-canceled`, `turn-uncertain`, `transport-disconnected`).
 */
export function createRunnerObservationBridge(params: {
  readonly profileId: string;
  readonly generation: number;
  readonly rootId: string;
  readonly attemptId: string;
  readonly getSessionId: () => string | null;
  readonly deliver: (observation: AcpObservation) => void;
}): AcpRunnerObservationBridge {
  let maxSeq = 0;
  let activeTurnId = `idle-${params.generation}`;
  let permSeq = 0;

  const nextSeq = (incoming?: number): number => {
    const seq = incoming !== undefined && Number.isSafeInteger(incoming) && incoming > maxSeq ? incoming : maxSeq + 1;
    maxSeq = seq;
    return seq;
  };

  const safeDeliver = (observation: AcpObservation): void => {
    try {
      params.deliver(observation);
    } catch {
      // Observer faults must never disrupt an active ACP turn.
    }
  };

  const emitLifecycle: AcpRunnerObservationBridge['emitLifecycle'] = (body, override) => {
    const sessionId = override?.sessionId ?? params.getSessionId() ?? `${params.attemptId}-session`;
    const turnId = override?.turnId ?? activeTurnId;
    safeDeliver({
      generation: params.generation,
      hostReceiveSeq: nextSeq(),
      observedAtUtc: new Date().toISOString(),
      origin: 'live',
      acpSessionId: sessionId,
      turnId,
      attemptId: params.attemptId,
      binding: {
        profileId: params.profileId,
        acpSessionId: sessionId,
        connectionGeneration: params.generation,
        turnId,
        rootId: params.rootId,
        attemptId: params.attemptId
      },
      ...body
    });
  };

  return {
    forward(observation): void {
      if (observation.origin === 'live' && observation.kind === 'turn-started') {
        activeTurnId = observation.turnId;
      }
      const seq = nextSeq(observation.hostReceiveSeq);
      const normalized: AcpObservation =
        seq === observation.hostReceiveSeq
          ? observation
          : observation.kind === 'usage'
            ? { ...observation, hostReceiveSeq: seq, usage: { ...observation.usage, hostReceiveSeq: seq } }
            : { ...observation, hostReceiveSeq: seq };
      safeDeliver(normalized);
    },
    emitLifecycle,
    recordPromptOutcome(sessionId, outcome): void {
      if (outcome.kind === 'cancelled') {
        emitLifecycle({ kind: 'turn-canceled', reason: 'cancelled' }, { sessionId, turnId: outcome.turnId });
      } else if (outcome.kind === 'uncertain') {
        if (outcome.reason === 'transport-closed') {
          emitLifecycle({ kind: 'transport-disconnected', reason: outcome.reason }, { sessionId, turnId: outcome.turnId });
        }
        emitLifecycle({ kind: 'turn-uncertain', reason: outcome.reason }, { sessionId, turnId: outcome.turnId });
      } else if (outcome.kind === 'not-dispatched' && outcome.reason === 'transport-closed') {
        emitLifecycle({ kind: 'transport-disconnected', reason: outcome.reason }, { sessionId });
      }
    },
    wrapPermissionPolicy(basePolicy, logger): AcpPermissionPolicy {
      return (rawRequest) => {
        const safeRequest = sanitizePermissionRequest(rawRequest);
        permSeq += 1;
        const permissionRequestId = safeRequest.toolCallId ?? `perm-${params.generation}-${permSeq}`;
        emitLifecycle({ kind: 'permission-requested', permissionRequestId }, { sessionId: safeRequest.sessionId });
        const settle = (decision: AcpPermissionDecision): AcpPermissionDecision => {
          const granted =
            decision !== 'undecided' &&
            safeRequest.options.some(
              (option) =>
                option.optionId === decision.optionId &&
                (option.kind === 'allow_once' || option.kind === 'allow_always')
            );
          emitLifecycle(
            { kind: 'permission-resolved', permissionRequestId, granted },
            { sessionId: safeRequest.sessionId }
          );
          if (!granted && logger !== undefined) {
            logger.info('ACP permission request denied by host policy', {
              profileId: params.profileId,
              attemptId: params.attemptId,
              permissionRequestId,
              toolTitle: sanitizeAgentDisplayTitle(safeRequest.toolTitle) ?? 'untitled'
            });
          }
          return decision;
        };
        if (basePolicy === undefined) return settle('undecided');
        try {
          const raw = basePolicy(safeRequest);
          if (isPromiseLike<AcpPermissionDecision>(raw)) {
            return Promise.resolve(raw).then(settle, () => settle('undecided'));
          }
          return settle(raw);
        } catch {
          return settle('undecided');
        }
      };
    }
  };
}
