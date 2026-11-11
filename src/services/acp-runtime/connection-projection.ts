/**
 * FR-R6-F13 (FR-014) — what a host surface may show about one connection.
 *
 * The projection is built field by field from the profile, never by spreading it, so the
 * executable reference and anything the launch resolver used can never reach a surface. Agent
 * stderr is not part of it either; it is read separately and only through the sanitized tail.
 *
 * Zero `vscode` imports.
 */
import type {
  AcpConnectionProjection,
  AcpConnectionState,
  AcpFailureReason,
  AcpRefusalReason,
  AgentProfile,
  NegotiatedCapabilities
} from '../../contracts/acp-runtime';
import type { RpcCounters } from './rpc-connection';

/** Counters the client keeps beside the JSON-RPC layer's. */
export interface ClientCounters {
  staleUpdates: number;
  ignoredUpdates: number;
  unknownNotifications: number;
  refusedAgentRequests: number;
  permissionRequests: number;
}

export interface ProjectionInput {
  readonly profile: AgentProfile;
  readonly generation: number;
  readonly state: AcpConnectionState;
  readonly capabilities: NegotiatedCapabilities | null;
  readonly lastRefusal: AcpRefusalReason | null;
  readonly lastFailure: AcpFailureReason | null;
  readonly sessionCount: number;
  readonly rpcCounters: RpcCounters;
  readonly counters: Readonly<ClientCounters>;
}

export function emptyClientCounters(): ClientCounters {
  return { staleUpdates: 0, ignoredUpdates: 0, unknownNotifications: 0, refusedAgentRequests: 0, permissionRequests: 0 };
}

export function buildProjection(input: ProjectionInput): AcpConnectionProjection {
  const { profile, counters, rpcCounters } = input;
  return {
    profileId: profile.profileId,
    profileRevision: profile.revision,
    profileKind: profile.kind,
    qualification: profile.qualification,
    attribution: {
      provider: profile.attribution.provider,
      backend: profile.attribution.backend,
      model: profile.attribution.model
    },
    generation: input.generation,
    state: input.state,
    capabilities: input.capabilities === null ? null : { ...input.capabilities },
    lastRefusal: input.lastRefusal,
    lastFailure: input.lastFailure,
    sessionCount: input.sessionCount,
    counters: {
      unknownResponses: rpcCounters.unknownResponses,
      duplicateResponses: rpcCounters.duplicateResponses,
      staleUpdates: counters.staleUpdates,
      ignoredUpdates: counters.ignoredUpdates,
      unknownNotifications: counters.unknownNotifications,
      refusedAgentRequests: counters.refusedAgentRequests,
      permissionRequests: counters.permissionRequests
    }
  };
}
