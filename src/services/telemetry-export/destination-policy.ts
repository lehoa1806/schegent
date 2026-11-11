/**
 * FR-R6-F14 (FR-001, FR-002, FR-013, FR-014; research R6) — which destination, if any, is in
 * force. Export is off unless exactly one valid user-scope profile is enabled in a trusted
 * workspace; every other outcome is `disabled` or one reason from a closed list.
 *
 * Pure: it opens nothing and reads no secret. A refusal carries the reason and nothing from the
 * profile, so an endpoint or a header name can never reach a surface through it.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  TELEMETRY_CONTENT_POLICIES,
  TELEMETRY_EXPORT_BOUNDS,
  TELEMETRY_PROFILE_SCOPES,
  TELEMETRY_PROTOCOLS,
  TELEMETRY_SIGNALS,
  TELEMETRY_SUPPORTED_PROTOCOL,
  type ProfileEvaluation,
  type ProfileEvaluationContext,
  type ProfileRefusalReason,
  type TelemetryCredentialRef,
  type TelemetryProfile
} from '../../contracts/telemetry-export';

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** RFC 9110 `token`. */
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_NAME_CHARS_MAX = 128;
const CREDENTIAL_REFERENCE_CHARS_MAX = 256;
const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const LOOPBACK_IPV6_HOST = '[::1]';
const LOOPBACK_NAME = 'localhost';
/** `scheme://` followed by the first host character: the parser would otherwise repair `https:///x`. */
const AUTHORITY_START = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]/;
const FIRST_PRINTABLE_CODE = 0x21;
const DELETE_CODE = 0x7f;

/** Headers the transport owns; a credential may not be sent under one of them. */
export const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'user-agent',
  'accept-encoding'
]);

const PROFILE_KEYS: ReadonlySet<string> = new Set([
  'id',
  'revision',
  'enabled',
  'scope',
  'protocol',
  'signals',
  'contentPolicy',
  'endpoint',
  'allowPlaintextLoopback',
  'credential'
]);
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set(['reference', 'headerName']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

function readCredential(value: unknown): TelemetryCredentialRef | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasOnlyKeys(value, CREDENTIAL_KEYS)) return undefined;
  const { reference, headerName } = value;
  if (typeof reference !== 'string' || typeof headerName !== 'string') return undefined;
  if (reference.length === 0 || reference.length > CREDENTIAL_REFERENCE_CHARS_MAX) return undefined;
  return Object.freeze({ reference, headerName });
}

/** The profile when `value` has the declared shape; `undefined` otherwise. */
function readProfile(value: Record<string, unknown>): TelemetryProfile | undefined {
  if (!hasOnlyKeys(value, PROFILE_KEYS)) return undefined;
  const { id, revision, scope, protocol, signals, contentPolicy, endpoint, allowPlaintextLoopback } = value;
  if (typeof id !== 'string' || !PROFILE_ID.test(id)) return undefined;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return undefined;
  if (!oneOf(TELEMETRY_PROFILE_SCOPES, scope) || !oneOf(TELEMETRY_PROTOCOLS, protocol)) return undefined;
  if (!Array.isArray(signals) || signals.length === 0 || signals.length > TELEMETRY_SIGNALS.length) return undefined;
  if (!signals.every((signal) => oneOf(TELEMETRY_SIGNALS, signal))) return undefined;
  if (!oneOf(TELEMETRY_CONTENT_POLICIES, contentPolicy)) return undefined;
  if (typeof endpoint !== 'string' || typeof allowPlaintextLoopback !== 'boolean') return undefined;
  const credential = readCredential(value.credential);
  if (credential === undefined) return undefined;
  return { id, revision, enabled: true, scope, protocol, signals, contentPolicy, endpoint, allowPlaintextLoopback, credential };
}

function hasOnlyPrintableAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < FIRST_PRINTABLE_CODE || code >= DELETE_CODE) return false;
  }
  return true;
}

/** The parsed endpoint, or `undefined` when it breaks an endpoint rule. */
function parseEndpoint(endpoint: string): URL | undefined {
  if (endpoint.length === 0 || endpoint.length > TELEMETRY_EXPORT_BOUNDS.endpointCharsMax) return undefined;
  if (!hasOnlyPrintableAscii(endpoint)) return undefined;
  // The parser reports an empty query or fragment as absent, so the raw text is checked too.
  if (endpoint.includes('?') || endpoint.includes('#')) return undefined;
  // The parser also reads a backslash as a slash and skips extra slashes before the host.
  if (endpoint.includes('\\') || !AUTHORITY_START.test(endpoint)) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username !== '' || url.password !== '' || url.hostname === '') return undefined;
  if (url.search !== '' || url.hash !== '') return undefined;
  return url;
}

/** True for `localhost`, an address in `127.0.0.0/8` and `::1`, as the URL parser spells them. */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === LOOPBACK_NAME || hostname === LOOPBACK_IPV6_HOST || LOOPBACK_IPV4.test(hostname);
}

function isAcceptableHeaderName(headerName: string): boolean {
  if (headerName.length > HEADER_NAME_CHARS_MAX || !HEADER_TOKEN.test(headerName)) return false;
  return !RESERVED_HEADERS.has(headerName.toLowerCase());
}

function refused(reason: ProfileRefusalReason): ProfileEvaluation {
  return Object.freeze({ kind: 'refused', reason });
}

const DISABLED: ProfileEvaluation = Object.freeze({ kind: 'disabled' });

function evaluateOne(candidate: Record<string, unknown>, context: ProfileEvaluationContext): ProfileEvaluation {
  const profile = readProfile(candidate);
  if (profile === undefined) return refused('profile-invalid');
  if (profile.scope !== 'user') return refused('scope-not-authorized');
  if (!context.workspaceTrusted) return refused('workspace-untrusted');
  if (profile.protocol !== TELEMETRY_SUPPORTED_PROTOCOL) return refused('protocol-unsupported');
  if (profile.signals.length !== 1 || profile.signals.at(0) !== 'metrics') return refused('signal-unsupported');
  if (profile.contentPolicy !== 'metadata-only') return refused('content-export-unsupported');
  const url = parseEndpoint(profile.endpoint);
  if (url === undefined) return refused('endpoint-invalid');
  const plaintext = url.protocol === 'http:';
  if (plaintext && !(profile.allowPlaintextLoopback && isLoopbackHostname(url.hostname))) {
    return refused('plaintext-not-loopback');
  }
  if (profile.credential !== null) {
    if (!isAcceptableHeaderName(profile.credential.headerName)) return refused('credential-header-invalid');
    if (context.secretStore !== 'available') return refused('secret-store-unavailable');
  }
  return Object.freeze({
    kind: 'authorized',
    destination: Object.freeze({
      profileId: profile.id,
      profileRevision: profile.revision,
      endpoint: url.href,
      plaintextLoopback: plaintext,
      credential: profile.credential
    })
  });
}

/**
 * Evaluates the configured profiles. An entry counts as enabled only when it is an object whose
 * `enabled` is exactly `true`, so a malformed entry can never turn export on.
 */
export function evaluateProfiles(profiles: readonly unknown[], context: ProfileEvaluationContext): ProfileEvaluation {
  const enabled = profiles.filter(isRecord).filter((candidate) => candidate.enabled === true);
  if (enabled.length === 0) return DISABLED;
  if (enabled.length > TELEMETRY_EXPORT_BOUNDS.activeProfilesMax) return refused('multiple-active-profiles');
  const only = enabled.at(0);
  return only === undefined ? DISABLED : evaluateOne(only, context);
}
