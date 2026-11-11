/**
 * FR-R6-F14 (FR-002, FR-016; research R6) — reading the destination credential through the
 * secret port. The value is read on demand and never stored outside the exporter's memory; a
 * port that is absent, unavailable, empty-handed or throwing gives `credential-unavailable`,
 * and a value a request header cannot carry gives `credential-invalid`.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { DeliveryErrorClass, DropReason, TelemetrySecretPort } from '../../contracts/telemetry-export';

export type CredentialFailure = Extract<DropReason & DeliveryErrorClass, 'credential-unavailable' | 'credential-invalid'>;

export type CredentialState =
  | { readonly kind: 'unread' }
  | { readonly kind: 'value'; readonly value: string }
  | { readonly kind: 'failed'; readonly reason: CredentialFailure };

/** A credential value longer than this is refused; a request header should not carry it. */
export const CREDENTIAL_CHARS_MAX = 8_192;
const FIRST_PRINTABLE_CODE = 0x20;
const LAST_PRINTABLE_CODE = 0x7e;

export const CREDENTIAL_UNREAD: CredentialState = Object.freeze({ kind: 'unread' });
const UNAVAILABLE: CredentialState = Object.freeze({ kind: 'failed', reason: 'credential-unavailable' });
const INVALID: CredentialState = Object.freeze({ kind: 'failed', reason: 'credential-invalid' });

/** Printable ASCII only: no line break, no control character, nothing a header cannot carry. */
export function isHeaderValue(value: string): boolean {
  if (value.length === 0 || value.length > CREDENTIAL_CHARS_MAX) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < FIRST_PRINTABLE_CODE || code > LAST_PRINTABLE_CODE) return false;
  }
  return true;
}

/** Never rejects: every failure of the port is a `failed` state. */
export async function readCredential(secrets: TelemetrySecretPort | null, reference: string): Promise<CredentialState> {
  if (secrets === null) return UNAVAILABLE;
  let value: unknown;
  try {
    if (secrets.availability() !== 'available') return UNAVAILABLE;
    value = await secrets.read(reference);
  } catch {
    // The reason a port failed is not kept: it could name the store or the reference.
    return UNAVAILABLE;
  }
  if (typeof value !== 'string') return UNAVAILABLE;
  return isHeaderValue(value) ? { kind: 'value', value } : INVALID;
}
