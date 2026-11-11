/**
 * FR-R6-F13 (FR-015, FR-022, research R6) — one ACP observation as F02's `AcpEventEnvelope`.
 *
 * - The JSON-RPC request id is connection-local; it is passed as its decimal string and only for
 *   a turn start or completion.
 * - Only a live observation of a prompt carries a `turnId`. A history or idle observation carries
 *   none, so F02 builds no turn row for it.
 * - ACP `cancelled` is F02 `canceled`; `max_turn_requests` and `refusal` have no F02 stop reason.
 * - A usage update carries no `usageDelta`: ACP `used` and `size` are context occupancy, not
 *   tokens, and accounting goes through F06 alone.
 * - ACP v1 reports no provider session and no durable event id, so neither is set.
 *
 * Zero `vscode` imports.
 */
import type { AcpObservation, AcpStopReason, AgentProfile } from '../../contracts/acp-runtime';
import type { AcpEventEnvelope } from '../../contracts/shared-memory-storage/artifacts-streams-and-acp';

type SharedStopReason = NonNullable<AcpEventEnvelope['stopReason']>;

const SHARED_STOP_REASONS: Readonly<Record<AcpStopReason, SharedStopReason | null>> = Object.freeze({
  end_turn: 'end_turn',
  max_tokens: 'max_tokens',
  cancelled: 'canceled',
  max_turn_requests: null,
  refusal: null
});

const MESSAGE_KINDS: Readonly<Record<AcpObservation['kind'], AcpEventEnvelope['messageKind']>> = Object.freeze({
  'turn-started': 'turn-started',
  'turn-completed': 'turn-completed',
  display: 'session-update',
  usage: 'usage-update'
});

function turnFields(observation: AcpObservation): Pick<AcpEventEnvelope, 'turnId' | 'jsonRpcRequestId'> {
  if (observation.origin !== 'live' || observation.binding === null) return {};
  if (observation.kind === 'turn-started' || observation.kind === 'turn-completed') {
    return { turnId: observation.turnId, jsonRpcRequestId: String(observation.requestId) };
  }
  return { turnId: observation.turnId };
}

function stopReasonField(observation: AcpObservation): Pick<AcpEventEnvelope, 'stopReason'> {
  if (observation.kind !== 'turn-completed') return {};
  const shared = SHARED_STOP_REASONS[observation.stopReason];
  return shared === null ? {} : { stopReason: shared };
}

/** The F02 envelope for one observation of a connection opened with `profile`. */
export function toSharedAcpEnvelope(observation: AcpObservation, profile: AgentProfile): AcpEventEnvelope {
  return {
    profileId: profile.profileId,
    profileRevision: profile.revision,
    connectionGeneration: observation.generation,
    acpSessionId: observation.acpSessionId,
    ...turnFields(observation),
    hostReceiveSeq: observation.hostReceiveSeq,
    observedAtUtc: observation.observedAtUtc,
    messageKind: MESSAGE_KINDS[observation.kind],
    ...stopReasonField(observation)
  };
}
