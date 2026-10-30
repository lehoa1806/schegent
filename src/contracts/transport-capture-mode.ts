// FR-R4-F04 (FR-001, contract X1) — what the transport capture setting means.
//
// `schegent.logging.transportCaptureMode` has four values. Three are modes: `off` keeps nothing,
// `errors-only` keeps a Run's CLI output only when the Run fails or is canceled, `on` keeps all of it.
// The fourth, `inherit`, is the default and is not a mode of its own: it follows the raw transcript
// mode. That is how a workspace that never touched the new setting keeps the retention it already had,
// since the profile an operator chose is expressed in the raw transcript mode.
//
// WHY IT LIVES IN `contracts/`. The router reads the setting through an uncached accessor and resolves
// it here for every record (X1), and the privacy profiles resolve it the same way to detect a profile.
// The profiles are a contract, and `contracts/` is a leaf layer that may not value-import an acting one
// (`tests/lint/dependency-direction.test.ts`), so the one table both sides read has to sit where both
// may import it. Tasks T017 named `src/monitor/transport/`; the layer rule moved it, and nothing else.
//
// No VS Code import.

/** The raw transcript modes `inherit` follows; the same three `RawTranscriptMode` names. */
export type RawTranscriptModeName = 'off' | 'errors-only' | 'always';

/** The four values the setting accepts, in manifest order. */
export const TRANSPORT_CAPTURE_SETTINGS = ['inherit', 'off', 'errors-only', 'on'] as const;

export type TransportCaptureSetting = (typeof TRANSPORT_CAPTURE_SETTINGS)[number];

/** What a record is actually subject to: `inherit` never survives resolution. */
export type TransportCaptureMode = Exclude<TransportCaptureSetting, 'inherit'>;

/** The shipped default, which existing workspaces resolve through their raw transcript mode. */
export const DEFAULT_TRANSPORT_CAPTURE_SETTING: TransportCaptureSetting = 'inherit';

const INHERITED_MODE: Readonly<Record<RawTranscriptModeName, TransportCaptureMode>> = Object.freeze({
  off: 'off',
  'errors-only': 'errors-only',
  always: 'on'
});

/**
 * The effective mode (data-model §1). A value that is not one of the four, including a missing one, is
 * read as `inherit`: a setting nobody chose must not resolve to a mode nobody chose.
 */
export function resolveTransportCaptureMode(
  setting: unknown,
  rawTranscriptMode: RawTranscriptModeName
): TransportCaptureMode {
  if (setting === 'off' || setting === 'errors-only' || setting === 'on') return setting;
  return INHERITED_MODE[rawTranscriptMode];
}
