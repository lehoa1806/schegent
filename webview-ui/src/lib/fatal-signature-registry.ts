// Mirror of src/lib/fatal-signature-registry.ts FATAL_SIGNATURES — parity
// verified by tests/parity/fatal-signatures-parity.test.ts. Do not modify
// without updating both files in lockstep.
//
// `streams` records which stream each built-in can legitimately originate
// on. The webview only lists the patterns, but the literal is mirrored
// whole so the parity check compares one shape rather than a projection.

export type FatalSignature = string;

export type FatalStream = 'stdout' | 'stderr';

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

export const FATAL_SIGNATURES: ReadonlyArray<FatalSignature> = Object.freeze(
  SIGNATURE_STREAMS.map((entry) => entry.pattern)
);
