import type { RunnerLabel } from '../contracts/backend-runner';

/**
 * Feature 093 BUG-001 (T100) — the one place an invocation's identity is minted.
 *
 * WHY THIS IS NOT A COUNTER ON THE RUNNER. Both adapters already carried a
 * `nextInvocationToken`, monotonic per runner INSTANCE, and it did the job it was
 * introduced for (T046a): keying a runner's own live-child map so an invocation
 * deletes its own entry and no other. It cannot do this one. The monitor consumes
 * a merged sidecar stream from every backend in the window, so two runners each
 * emit an invocation numbered 1 — and an identity that collides is worse than no
 * identity, because the reader believes it. That is T046a's lesson re-learned at
 * a new key, which is precisely what T100 was written to prevent.
 *
 * The counter is module-scope, so it is per host process rather than per
 * instance, and uniqueness no longer depends on how many runners exist or when
 * they were constructed. The label is carried in the string as well — not for
 * uniqueness, which the counter already settles, but because these ids appear in
 * monitor reasoning and an id that says which adapter produced it is readable in
 * a log without a second lookup.
 *
 * Each runner keys its live-child map by this same value rather than minting a
 * second token beside it: one invocation, one identity, or the two drift and the
 * map's key stops naming the thing the events name.
 */
let nextInvocation = 0;

export function nextInvocationId(label: RunnerLabel): string {
  nextInvocation += 1;
  return `${label}#${nextInvocation}`;
}
