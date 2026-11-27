// GENERATED FILE — do not edit.
//
// Emitted from src/contracts/queue-failure-policy.ts by scripts/generate-contract-schemas.mjs.
// Edit the source and run: npm run contracts:generate
//
// `npm run contracts:check` (the first target of verify:all) fails when this
// file and its source disagree, so a fix applied here alone cannot ship.

// Feature 195 (T004, FR-001) — the queue failure-policy vocabulary.
//
// Two values only. `halt-on-failure` is the product default (research.md D9):
// a queue whose current rows include a task that ended `failed` starts no
// further task until an operator retries or removes it. `continue` is the
// pre-feature behaviour, named rather than left as an absence so a stored
// choice and "no opinion yet" are two different things (`effectiveQueueFailurePolicy`
// below).
//
// **Import-free, deliberately.** This file is whole-file mirrored to the
// webview by `scripts/generate-contract-schemas.mjs` (`mirrorWholeFile`,
// alongside `src/contracts/action-keys.ts`) — a real full-file mirror requires
// the source to import nothing, or the mirror would drag host-only modules
// into the webview bundle. The predicate that reads `FeatureRequest` rows
// lives beside the queue instead: `src/queue/queue-halt-policy.ts`.
//
// Contract: specs/195-queue-halt-on-failure/contracts/queue-failure-policy.md

export const QUEUE_FAILURE_POLICIES = ['halt-on-failure', 'continue'] as const;

export type QueueFailurePolicy = (typeof QUEUE_FAILURE_POLICIES)[number];

/**
 * The policy a queue actually runs under, right now.
 *
 * `stored` is `QueueState.failurePolicy` — absent on every queue an operator
 * has not touched, and on every record written before this feature (FR-017).
 * An unrecognised stored value (a downgrade reading a value written by a
 * later app version, or corrupt Memento state) is read as absent rather than
 * thrown on: the workspace default is always a safe answer, and the drain
 * gate must never refuse to evaluate.
 */
export function effectiveQueueFailurePolicy(
  stored: string | null | undefined,
  workspaceDefault: QueueFailurePolicy
): QueueFailurePolicy {
  if (isQueueFailurePolicy(stored)) return stored;
  return workspaceDefault;
}

function isQueueFailurePolicy(value: unknown): value is QueueFailurePolicy {
  return (
    typeof value === 'string' &&
    (QUEUE_FAILURE_POLICIES as readonly string[]).includes(value)
  );
}
