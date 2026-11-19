// FR-R3-104 (FR-054, FR-055) / FR-R7-06 — the CLI surface this build was qualified against,
// projected from `BACKEND_DESCRIPTORS` (`qualifiedCliVersion`).
//
// `tests/unit/build/qualified-versions-parity.test.ts` holds this table to the newest entry in
// `docs/release/backend-qualification-log.md`. Update `qualifiedCliVersion` in
// `src/contracts/backend-descriptors.ts` and `QUALIFIED_AT` below together after a live canary.

import { mapBackends } from './backend-descriptors';

/** When the versions below were observed by a live canary turn. */
export const QUALIFIED_AT = '2026-10-19';

/**
 * Version tokens, in the reduced form `normalizeCliVersion` produces, so a comparison never
 * depends on a vendor's banner text.
 */
export const QUALIFIED_BACKEND_VERSIONS: Readonly<Record<string, string>> = mapBackends(
  (descriptor) => descriptor.qualifiedCliVersion
);
