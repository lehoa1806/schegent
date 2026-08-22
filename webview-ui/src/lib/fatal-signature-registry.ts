// GENERATED FILE — do not edit.
//
// Emitted from src/lib/fatal-signature-registry.ts by scripts/generate-contract-schemas.mjs.
// Edit the source and run: npm run contracts:generate
//
// `npm run contracts:check` (the first target of verify:all) fails when this
// file and its source disagree, so a fix applied here alone cannot ship.
// This is a PROJECTION, not a whole-file mirror: the host module also owns
// the matching and classification surface (FatalSource, EffectiveSignature,
// FatalMatch, and the classifier), which the webview does not need and must
// not carry. Only the declarations named in FATAL_SIGNATURE_PROJECTION appear
// here, selected from the AST by name — not sliced out of a text range.

export type FatalSignature = string;

export type FatalStream = 'stdout' | 'stderr';

/**
 * Streams a built-in signature can legitimately originate on.
 *
 * A signature is a diagnostic the CLI *emits about itself*. Scanning for
 * one on a stream it never originates on cannot detect anything — it can
 * only produce false positives, because both streams also carry text the
 * CLI is merely transporting (tool results, file contents, model output).
 * `error: unknown option` is an argument-parse diagnostic and is stderr-only
 * by origin; a stdout occurrence is necessarily something the CLI was
 * carrying, not something it reported. See the 2026-08-16 incident recorded
 * on `SIGNATURE_STREAMS` below.
 *
 * Operator additions carry no scope and are scanned on both streams: the
 * `schegent.fatalSignatures` setting is a bare string list and widening it
 * would be an operator-facing schema change. The line-scoping in
 * `incremental-fatal-scanner.ts` is what keeps a transported payload from
 * arming those.
 */
const BOTH_STREAMS = ['stdout', 'stderr'] as const;

const STDERR_ONLY = ['stderr'] as const;

export interface FatalSignatureSpec {
  readonly pattern: FatalSignature;
  readonly streams: ReadonlyArray<FatalStream>;
}

export const SIGNATURE_STREAMS: ReadonlyArray<FatalSignatureSpec> = Object.freeze([
  { pattern: "error: unknown option", streams: STDERR_ONLY },
  { pattern: "Autocompact is thrashing", streams: BOTH_STREAMS }
]);

/**
 * The code-resident floor, patterns only. Kept as a string list so the
 * "adding a signature is a one-line edit" guarantee and every existing
 * membership assertion hold unchanged; `SIGNATURE_STREAMS` above carries
 * the scope for each entry and is the array to edit when adding one.
 */
export const FATAL_SIGNATURES: ReadonlyArray<FatalSignature> = Object.freeze(
  SIGNATURE_STREAMS.map((entry) => entry.pattern)
);
