// Feature 200 (FR-R3-161) T011 — the negative control for the Task status
// writer census. Spec FR-009a, contract C7.
//
// This file is a *planted* unenrolled writer. It satisfies all three stages of
// the derivation in `../task-status-writer-derivation.ts`:
//
//   stage 1 — its source names `FeatureRequest`;
//   stage 2 — it contains an object literal whose first top-level element is a
//             spread and which also assigns `status`;
//   stage 3 — its source names `requests`.
//
// and it does NOT call `decideTaskTransition`. So the derivation must report
// it. The control test asserts exactly that, and asserts the reported list is
// non-empty, so deleting this file turns the control red instead of letting it
// pass on an empty result — a control that passes when its subject is missing
// is not a control (contract C7 property 2).
//
// It can never fail the real gate: the real gate scans `repo/src/` only, and
// this file is under `repo/tests/lint/fixtures/` (contract C7 property 1,
// tasks.md constraint C6).
//
// It is inert. Nothing imports it, nothing calls it, and it performs no I/O.
// The status it writes is deliberately uncast — `as FeatureRequestStatus`
// appears nowhere in it — so the control also stands as a live example of the
// form contract C4.3 forbids the population term from being anchored on.

import type { FeatureRequest } from '../../../src/queue/feature-request';

/**
 * Cancel every request by rewriting its status directly, with no classifier in
 * the path. This is the drift shape the census exists to report.
 */
export function unenrolledTaskStatusWriter(
  requests: readonly FeatureRequest[]
): FeatureRequest[] {
  return requests.map((request): FeatureRequest => ({ ...request, status: 'canceled' }));
}
