// Principal Review F5/F6 (Hard Rule 22) — closed metadata-only projections for
// `scanner-consent-changed` and `telemetry-credential-changed`.
//
// Neither payload may carry filesystem paths, secret values, raw SecretStorage
// key names, CLI output, or arbitrary free-form text. Any unknown key or
// out-of-vocabulary value throws `AuditPayloadValidationError`.
import { REVIEW_SCANNERS, type ReviewScannerId } from '../contracts/containment-qualification';
import { AuditPayloadValidationError } from './audit-payload-error';

const SCANNER_REASON = 'malformed-scanner-consent-changed';
const TELEMETRY_REASON = 'malformed-telemetry-credential-changed';

const SCANNER_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'scanner',
  'action',
  'fingerprintDigestPrefix',
  'removedSetting',
  'clearedBinding'
]);
const SCANNER_ACTIONS: ReadonlySet<string> = new Set(['granted', 'denied', 'revoked']);

const TELEMETRY_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'action',
  'secretKeyDigestPrefix',
  'matchesConfiguredKey'
]);
const TELEMETRY_ACTIONS: ReadonlySet<string> = new Set(['stored', 'cleared']);

const DIGEST_PREFIX_RE = /^[0-9a-f]{16}$/;

export interface ScannerConsentChangedAuditPayload {
  readonly scanner: ReviewScannerId;
  readonly action: 'granted' | 'denied' | 'revoked';
  readonly fingerprintDigestPrefix?: string;
  readonly removedSetting?: boolean;
  readonly clearedBinding?: boolean;
}

export interface TelemetryCredentialChangedAuditPayload {
  readonly action: 'stored' | 'cleared';
  readonly secretKeyDigestPrefix: string;
  readonly matchesConfiguredKey?: boolean;
}

const rejectScanner = (): AuditPayloadValidationError =>
  new AuditPayloadValidationError(SCANNER_REASON);
const rejectTelemetry = (): AuditPayloadValidationError =>
  new AuditPayloadValidationError(TELEMETRY_REASON);

export function projectScannerConsentChangedPayload(
  payload: Record<string, unknown>
): ScannerConsentChangedAuditPayload {
  if (Object.keys(payload).some((key) => !SCANNER_ALLOWED_KEYS.has(key))) throw rejectScanner();
  const { scanner, action, fingerprintDigestPrefix, removedSetting, clearedBinding } = payload;
  if (typeof scanner !== 'string' || !(REVIEW_SCANNERS as readonly string[]).includes(scanner)) {
    throw rejectScanner();
  }
  if (typeof action !== 'string' || !SCANNER_ACTIONS.has(action)) {
    throw rejectScanner();
  }
  if (
    fingerprintDigestPrefix !== undefined &&
    (typeof fingerprintDigestPrefix !== 'string' || !DIGEST_PREFIX_RE.test(fingerprintDigestPrefix))
  ) {
    throw rejectScanner();
  }
  if (removedSetting !== undefined && typeof removedSetting !== 'boolean') {
    throw rejectScanner();
  }
  if (clearedBinding !== undefined && typeof clearedBinding !== 'boolean') {
    throw rejectScanner();
  }
  return Object.freeze({
    scanner: scanner as ReviewScannerId,
    action: action as ScannerConsentChangedAuditPayload['action'],
    ...(fingerprintDigestPrefix !== undefined ? { fingerprintDigestPrefix } : {}),
    ...(removedSetting !== undefined ? { removedSetting } : {}),
    ...(clearedBinding !== undefined ? { clearedBinding } : {})
  });
}

export function projectTelemetryCredentialChangedPayload(
  payload: Record<string, unknown>
): TelemetryCredentialChangedAuditPayload {
  if (Object.keys(payload).some((key) => !TELEMETRY_ALLOWED_KEYS.has(key))) throw rejectTelemetry();
  const { action, secretKeyDigestPrefix, matchesConfiguredKey } = payload;
  if (typeof action !== 'string' || !TELEMETRY_ACTIONS.has(action)) {
    throw rejectTelemetry();
  }
  if (typeof secretKeyDigestPrefix !== 'string' || !DIGEST_PREFIX_RE.test(secretKeyDigestPrefix)) {
    throw rejectTelemetry();
  }
  if (matchesConfiguredKey !== undefined && typeof matchesConfiguredKey !== 'boolean') {
    throw rejectTelemetry();
  }
  return Object.freeze({
    action: action as TelemetryCredentialChangedAuditPayload['action'],
    secretKeyDigestPrefix,
    ...(matchesConfiguredKey !== undefined ? { matchesConfiguredKey } : {})
  });
}

