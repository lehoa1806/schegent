/**
 * FR-R6-F15 (F15-A; FR-013, FR-025, FR-026, FR-035) — how an accepted revision is planned for
 * delivery: the profile's capacity, the route of each artifact, the session request and the
 * recorded representation a dispatch is checked against.
 *
 * The plan produces prompt blocks; sending them is F15-B.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { AcpPromptBlock, NegotiatedCapabilities } from '../acp-runtime';
import type { ProducerRef } from './context-policy';

/** The backend profile and the context size it is qualified for, in bytes (NFR-002). */
export interface ProfileCapacity {
  readonly profileId: string;
  readonly profileRevision: number;
  /** `null` when the profile has no qualification; such a profile is refused. */
  readonly qualifiedContextBytes: number | null;
}

/** The host's answer about one artifact: how the next agent could reach it. */
export interface ArtifactAccess {
  /** The artifact's text, when the host can supply it for embedding. */
  readonly embeddedText: string | null;
  /** An immutable reference the agent can read. */
  readonly linkUri: string | null;
  readonly materializePermitted: boolean;
  /** The protected copy, once F15-B has made it. */
  readonly materializedUri: string | null;
}

export const ARTIFACT_ROUTES = Object.freeze(['embedded', 'resource-link', 'materialized-copy', 'omitted'] as const);
export type ArtifactRouteKind = (typeof ARTIFACT_ROUTES)[number];

export interface ArtifactRoute {
  readonly artifactId: string;
  readonly immutableVersion: string;
  readonly route: ArtifactRouteKind;
}

/** FR-013: a fresh session always works; reuse names both lineages so they can be compared. */
export type SessionRequest =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'reuse'; readonly sessionLineage: ProducerRef; readonly targetLineage: ProducerRef };

export type DeliverySession = 'fresh' | 'reuse';

/** FR-035: what a dispatch must still match. */
export interface DeliveryRepresentation {
  readonly handoffId: string;
  readonly revision: number;
  readonly targetAttemptId: string;
  /** The digest of the manifest text. */
  readonly contentDigest: string;
  readonly rendererVersion: number;
  readonly renderedDigest: string;
  readonly capabilities: NegotiatedCapabilities;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly session: DeliverySession;
  readonly routes: readonly ArtifactRoute[];
  readonly representationDigest: string;
}

export interface DeliveryPlan {
  /** Empty while a materialized copy is awaited. */
  readonly blocks: readonly AcpPromptBlock[];
  /** Artifacts whose protected copy does not exist yet. */
  readonly awaitingCopy: readonly string[];
  readonly routes: readonly ArtifactRoute[];
  readonly representation: DeliveryRepresentation;
}

/** What is true at dispatch, compared with the recorded representation. */
export interface DispatchContext {
  readonly capabilities: NegotiatedCapabilities;
  readonly profile: ProfileCapacity;
  readonly contentDigest: string;
}
