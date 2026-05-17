// Mirror of src/lib/fatal-signature-registry.ts FATAL_SIGNATURES — parity
// verified by tests/parity/fatal-signatures-parity.test.ts. Do not modify
// without updating both files in lockstep.

export type FatalSignature = string;

export const FATAL_SIGNATURES: ReadonlyArray<FatalSignature> = Object.freeze([
  "error: unknown option",
  "Autocompact is thrashing"
]);
