/**
 * FR-R7-07 — Relocated to `src/contracts/queue-lifecycle-refresh.ts` so
 * `src/state/` can recompute unheld queue lifecycles without value-importing
 * `src/queue/`. Re-exported here verbatim for caller compatibility.
 */
export {
  refreshUnheldLifecycle,
  withRefreshedLifecycle
} from '../contracts/queue-lifecycle-refresh';
