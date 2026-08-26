// FR-R3-104 (FR-054, FR-055) — the CLI surface this build was qualified against.
//
// WHY IT IS COMMITTED AND THE RECORD IS NOT. `.backend-qualification.json` describes one
// machine's observation at one time and is untracked for the same reason the gate attestation is:
// the next clone must not inherit a qualification it never earned. But an INSTALLED extension has
// no such file and no repository — and the operator who installed it is exactly the person who needs to
// know that their `claude` has moved past the version this build's protocol handling was checked
// against. So the versions travel with the build, as a constant, dated.
//
// `tests/unit/build/qualified-versions-parity.test.ts` holds this table to the newest entry in
// `docs/release/backend-qualification-log.md`, so it cannot quietly rot into a claim about a
// canary run nobody made.
//
// WHAT DRIFT MEANS AND WHAT IT DOES NOT. A newer CLI is usually fine; vendors do not break
// protocols weekly. What drift means is that the one check on protocol compatibility — a live
// turn against the real CLI — has not been run against the binary now installed. So the host
// WARNS at phase start and refuses nothing: refusing to run because a CLI was upgraded would
// strand an operator mid-feature with no path forward. The release path is where the same drift
// refuses, because a release is a deliberate act with a person present. The reason for that split
// is recorded in `docs/release/backend-qualification-log.md`.

/** When the versions below were observed by a live canary turn. */
export const QUALIFIED_AT = '2026-08-26';

/**
 * Version tokens, in the reduced form `normalizeCliVersion` produces, so a comparison never
 * depends on a vendor's banner text.
 */
export const QUALIFIED_BACKEND_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  claude: '2.1.246',
  codex: '0.149.0',
  agy: '1.1.21'
});
