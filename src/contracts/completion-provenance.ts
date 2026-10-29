// ---------------------------------------------------------------------------
// FR-R4-F16 (feature 244, contract P1) — the closed vocabulary of how a completed row got there.
//
// `CompletionProvenance` is the type of the queue row's `completionProvenance` field. This module
// is the one place that decides, at runtime, whether a value read from the audit log or from a
// queue row is a member of it. The audit projection admits the field into `task-removed` through
// `isCompletionProvenance`, and the failed-row census reads "attested" through the same function,
// so the two cannot disagree about what the word means (research R3).
//
// IDENTITY ONLY. A member is the whole record: no trimming, no case folding, no prefix match. A near
// miss, a non-string and `null` are all refused, so a reader that meets a value it does not know
// treats the provenance as absent. A later member is appended to the union in `queue/feature-request`
// and to the list below; the compile-time check fails until both hold it.
//
// WHY THIS SITS IN `contracts/`. Neither `src/audit/` nor `src/contracts/` imports from `src/queue/`,
// and a leaf layer may not value-import an acting layer. The union is type-imported only, which the
// layer rules allow; the list and the guard are values and live here, on the `isFailureCause`
// precedent (`failure-cause.ts`).
// ---------------------------------------------------------------------------

import type { CompletionProvenance } from '../queue/feature-request';

export const COMPLETION_PROVENANCES = ['operator-attested'] as const satisfies readonly CompletionProvenance[];

// Compile-time only (contract P1.2). A union member missing from the list leaves a non-`never`
// remainder, and `true` is then not assignable to the declared type.
type ProvenanceListCoversUnion = [
  Exclude<CompletionProvenance, (typeof COMPLETION_PROVENANCES)[number]>
] extends [never]
  ? true
  : never;
const _provenanceListCoversUnion: ProvenanceListCoversUnion = true;
void _provenanceListCoversUnion;

/**
 * Membership by identity: true only for a string equal to a member. `'Operator-Attested'`,
 * `' operator-attested'`, `true`, `{}` and `null` are all refused.
 */
export function isCompletionProvenance(value: unknown): value is CompletionProvenance {
  return typeof value === 'string' && (COMPLETION_PROVENANCES as readonly string[]).includes(value);
}
