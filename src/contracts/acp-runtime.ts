/**
 * FR-R6-F13 (F13-A; FR-001 to FR-022) — the host-owned ACP agent runtime: profiles, negotiated
 * capabilities, the per-operation capability matrix, refusal and failure reasons, prompt
 * outcomes, observations and the connection projection.
 *
 * The runtime speaks ACP protocol version 1 over newline-delimited JSON-RPC on stdio. It is
 * built and tested against deterministic fixtures only: no activation path constructs it, and
 * no profile is qualified in this delivery (F13-B qualifies one, F13-C moves dispatch).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { AcpNormalizedEvent } from '../services/phase-log/acp-live-projection';
import type { AcpAttemptBinding, AcpUsageUpdate } from '../services/usage-accounting/acp-usage-mapping';

/** The only ACP protocol version this host speaks (research R1). */
export const ACP_PROTOCOL_VERSION = 1;

const KIB = 1024;
const MIB = 1024 * KIB;

/** Every bound the runtime enforces (spec NFR-001, NFR-002 and Clarifications). */
export const ACP_RUNTIME_LIMITS = Object.freeze({
  /** Absolute deadline for `initialize`, `session/new` and `session/load`. */
  handshakeDeadlineMs: 5_000,
  /** How long a cancelled prompt may stay unanswered before teardown. */
  cancelBoundMs: 5_000,
  /** Outstanding requests in both directions together. */
  maxOutstandingRequests: 64,
  /** Largest decoded message, and largest encoded prompt content. */
  maxMessageBytes: 2 * MIB,
  /** Largest undecoded remainder plus incoming chunk held at once. */
  maxPendingBytes: 8 * MIB,
  /** Diagnostic stderr kept per connection. */
  stderrTailBytes: 64 * KIB,
  /**
   * Longest ACP session id, tool call id or permission option id accepted (equal to F07's cap).
   * Such an id also carries no control, format, surrogate or line-separator character.
   */
  identifierMaxLength: 256,
  /** Most options one permission request may offer. */
  maxPermissionOptions: 32
});

export const ACP_PROFILE_KINDS = Object.freeze(['native', 'bridge'] as const);
export type AcpProfileKind = (typeof ACP_PROFILE_KINDS)[number];

export const ACP_QUALIFICATIONS = Object.freeze(['unqualified', 'fixture', 'qualified'] as const);
export type AcpQualification = (typeof ACP_QUALIFICATIONS)[number];

export const ACP_REQUIRED_CAPABILITIES = Object.freeze(['load-session', 'embedded-context', 'image', 'audio'] as const);
export type AcpRequiredCapability = (typeof ACP_REQUIRED_CAPABILITIES)[number];

/** A configured agent profile. The executable reference is resolved by the host, never run as text. */
export interface AgentProfile {
  readonly profileId: string;
  readonly revision: number;
  readonly kind: AcpProfileKind;
  readonly executableRef: string;
  /** Declared, not observed: what the profile says it fronts. */
  readonly attribution: {
    readonly provider: string;
    readonly backend: string;
    readonly model: string;
  };
  readonly requiredCapabilities: readonly AcpRequiredCapability[];
  readonly qualification: AcpQualification;
}

const PROFILE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ATTRIBUTION_MAX_LENGTH = 128;

function isBoundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= ATTRIBUTION_MAX_LENGTH;
}

function isMember<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

function isRequirementList(value: unknown): value is readonly AcpRequiredCapability[] {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const item of value as readonly unknown[]) {
    if (!isMember(ACP_REQUIRED_CAPABILITIES, item) || seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

function isAttribution(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return isBoundedText(record['provider']) && isBoundedText(record['backend']) && isBoundedText(record['model']);
}

/** True when the value is a well-formed profile (data-model.md AgentProfile rules). */
export function isValidProfile(value: unknown): value is AgentProfile {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['profileId'] === 'string' &&
    PROFILE_IDENTIFIER.test(record['profileId']) &&
    Number.isSafeInteger(record['revision']) &&
    (record['revision'] as number) >= 0 &&
    isMember(ACP_PROFILE_KINDS, record['kind']) &&
    typeof record['executableRef'] === 'string' &&
    PROFILE_IDENTIFIER.test(record['executableRef']) &&
    isAttribution(record['attribution']) &&
    isRequirementList(record['requiredCapabilities']) &&
    isMember(ACP_QUALIFICATIONS, record['qualification'])
  );
}

/** What the agent granted on one connection. Absent fields are false. */
export interface NegotiatedCapabilities {
  readonly protocolVersion: typeof ACP_PROTOCOL_VERSION;
  readonly loadSession: boolean;
  readonly image: boolean;
  readonly audio: boolean;
  readonly embeddedContext: boolean;
  readonly authMethodCount: number;
}

export type AcpCapabilityFlag = 'loadSession' | 'image' | 'audio' | 'embeddedContext';

export const ACP_OPERATIONS = Object.freeze([
  'initialize',
  'session-new',
  'session-load',
  'prompt-text',
  'prompt-resource-link',
  'prompt-embedded-resource',
  'prompt-image',
  'cancel'
] as const);
export type AcpOperation = (typeof ACP_OPERATIONS)[number];

/** FR-019: the capability each operation needs, or null when it needs none. */
export const ACP_CAPABILITY_MATRIX: Readonly<Record<AcpOperation, AcpCapabilityFlag | null>> = Object.freeze({
  initialize: null,
  'session-new': null,
  'session-load': 'loadSession',
  'prompt-text': null,
  'prompt-resource-link': null,
  'prompt-embedded-resource': 'embeddedContext',
  'prompt-image': 'image',
  cancel: null
});

/** The negotiated flag each profile requirement needs. */
export const ACP_REQUIREMENT_FLAGS: Readonly<Record<AcpRequiredCapability, AcpCapabilityFlag>> = Object.freeze({
  'load-session': 'loadSession',
  'embedded-context': 'embeddedContext',
  image: 'image',
  audio: 'audio'
});

export const ACP_CONNECTION_STATES = Object.freeze(['initializing', 'ready', 'draining', 'closed', 'failed'] as const);
export type AcpConnectionState = (typeof ACP_CONNECTION_STATES)[number];

/** A request the host declined before it reached the agent. */
export const ACP_REFUSAL_REASONS = Object.freeze([
  'profile-unqualified',
  'protocol-version-unsupported',
  'capability-missing',
  'fresh-session-required',
  'resource-inaccessible',
  'prompt-in-flight',
  'connection-not-ready',
  'session-unknown',
  'protocol-violation',
  'invalid-input',
  'prompt-oversized'
] as const);
export type AcpRefusalReason = (typeof ACP_REFUSAL_REASONS)[number];

/** Why a connection failed. A failure settles every pending request. */
export const ACP_FAILURE_REASONS = Object.freeze([
  'malformed-frame',
  'frame-oversized',
  'pending-bytes-exceeded',
  'request-limit-exceeded',
  'handshake-deadline',
  'transport-closed',
  'cancel-bound-elapsed',
  'protocol-violation'
] as const);
export type AcpFailureReason = (typeof ACP_FAILURE_REASONS)[number];

export const ACP_STOP_REASONS = Object.freeze(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'] as const);
export type AcpStopReason = (typeof ACP_STOP_REASONS)[number];

/**
 * How one prompt ended. `completed` and `cancelled` say only that the agent ended the turn: the
 * phase result still needs host validation (FR-012, FR-022).
 */
export type AcpPromptOutcome =
  | {
      readonly kind: 'completed';
      readonly turnId: string;
      readonly stopReason: Exclude<AcpStopReason, 'cancelled'>;
      readonly hostValidationRequired: true;
    }
  | { readonly kind: 'cancelled'; readonly turnId: string; readonly hostValidationRequired: true }
  | { readonly kind: 'uncertain'; readonly turnId: string; readonly reason: AcpFailureReason }
  | { readonly kind: 'not-dispatched'; readonly reason: AcpFailureReason }
  | { readonly kind: 'refused'; readonly reason: AcpRefusalReason; readonly detail?: string }
  | { readonly kind: 'rejected'; readonly turnId: string; readonly code: number };

export type AcpObservationOrigin = 'live' | 'history';

interface AcpObservationBase {
  readonly generation: number;
  /** Increases by one for each observation on the connection. */
  readonly hostReceiveSeq: number;
  readonly observedAtUtc: string;
  readonly origin: AcpObservationOrigin;
  readonly acpSessionId: string;
  /** The prompt's turn, or `history-<generation>` / `idle-<generation>` outside a prompt. */
  readonly turnId: string;
  readonly attemptId: string | null;
  /** The prompt's binding for a live observation of a prompt; null otherwise. */
  readonly binding: AcpAttemptBinding | null;
}

export type AcpObservation =
  | (AcpObservationBase & { readonly kind: 'turn-started'; readonly requestId: number })
  | (AcpObservationBase & {
      readonly kind: 'turn-completed';
      readonly requestId: number;
      readonly stopReason: AcpStopReason;
    })
  | (AcpObservationBase & { readonly kind: 'display'; readonly event: AcpNormalizedEvent })
  | (AcpObservationBase & { readonly kind: 'usage'; readonly usage: AcpUsageUpdate });

export interface AcpConnectionCounters {
  readonly unknownResponses: number;
  readonly duplicateResponses: number;
  readonly staleUpdates: number;
  readonly ignoredUpdates: number;
  readonly unknownNotifications: number;
  readonly refusedAgentRequests: number;
  readonly permissionRequests: number;
}

/** FR-014: what a host surface may show. It never holds a command, argument or environment value. */
export interface AcpConnectionProjection {
  readonly profileId: string;
  readonly profileRevision: number;
  readonly profileKind: AcpProfileKind;
  readonly qualification: AcpQualification;
  readonly attribution: AgentProfile['attribution'];
  readonly generation: number;
  readonly state: AcpConnectionState;
  readonly capabilities: NegotiatedCapabilities | null;
  readonly lastRefusal: AcpRefusalReason | null;
  readonly lastFailure: AcpFailureReason | null;
  readonly sessionCount: number;
  readonly counters: AcpConnectionCounters;
}

/**
 * One live stdio channel to an agent. `write` takes one framed message, newline included, and
 * throws when the channel did not accept the line. A channel that loses the agent's input after
 * accepting a line reports it through `onClose`.
 */
export interface AcpTransport {
  write(line: string): void;
  onStdout(listener: (chunk: Uint8Array) => void): void;
  onStderr(listener: (chunk: Uint8Array) => void): void;
  onClose(listener: () => void): void;
  /** Idempotent teardown. */
  close(): Promise<void>;
}

export interface AcpTimer {
  cancel(): void;
}

/** Injected time, so deadlines and bounds are testable without real waits. */
export interface AcpClock {
  nowUtc(): string;
  setTimer(callback: () => void, delayMs: number): AcpTimer;
}

export type AcpPermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface AcpPermissionRequest {
  readonly sessionId: string;
  readonly attemptId: string | null;
  readonly toolCallId: string | null;
  /** Agent-written text, as received: not bounded below one message and not sanitized. Never log or render it raw. */
  readonly toolTitle: string | null;
  readonly options: readonly { readonly optionId: string; readonly kind: AcpPermissionOptionKind }[];
}

/** The host's answer to a permission request; `undecided` falls back to rejection (FR-009). */
export type AcpPermissionPolicy = (request: AcpPermissionRequest) => { readonly optionId: string } | 'undecided';

/** One block of host prompt input. Images and audio are not offered in this delivery. */
export type AcpPromptBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'resource-link'; readonly uri: string; readonly name: string }
  | { readonly type: 'embedded-resource'; readonly uri: string; readonly text: string; readonly mimeType?: string };

/** What `openAcpConnection` needs (contracts/acp-runtime.md). */
export interface AcpOpenOptions {
  readonly profile: AgentProfile;
  /** Host-assigned, positive, increasing per transport. */
  readonly generation: number;
  /** Tests only: lets a `fixture` profile open. */
  readonly allowFixtureProfiles?: boolean;
  /** Called only after qualification passes. */
  readonly launch: (profile: AgentProfile) => AcpTransport;
  readonly permissionPolicy?: AcpPermissionPolicy;
  readonly verifyResourceLink?: (uri: string) => boolean;
  readonly onObservation?: (observation: AcpObservation) => void;
  readonly clock?: AcpClock;
}

export type AcpOpenResult =
  | { readonly ok: true; readonly connection: AcpConnection }
  | { readonly ok: false; readonly refusal: AcpRefusalReason | AcpFailureReason; readonly detail?: string };

/** The result of `newSession` and `loadSession`. `rejected` carries the agent's error code. */
export type AcpSessionResult =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly reason: AcpRefusalReason | AcpFailureReason; readonly detail?: string }
  | { readonly ok: false; readonly reason: 'rejected'; readonly code: number };

/** One prompt. The attempt and root are host identities, never derived from protocol values. */
export interface AcpPromptRequest {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly rootId: string;
  readonly blocks: readonly AcpPromptBlock[];
}

/** One open connection to one agent process. */
export interface AcpConnection {
  newSession(cwd: string): Promise<AcpSessionResult>;
  /** Updates while the load is outstanding are history. */
  loadSession(sessionId: string, cwd: string, options: { readonly mayLoad: boolean }): Promise<AcpSessionResult>;
  prompt(request: AcpPromptRequest): Promise<AcpPromptOutcome>;
  /** Fence, cancel answers for later permission requests, `session/cancel`, then the bound. */
  cancel(sessionId: string): void;
  close(): Promise<void>;
  describe(): AcpConnectionProjection;
  /** Sanitized agent stderr, at most the tail bound. */
  stderrTail(): string;
}
