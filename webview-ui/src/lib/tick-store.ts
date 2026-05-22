// Feature 065 (T026) — Shared webview tick stores for the scheduled-start
// countdown surface. Per research.md §R9 / FR-017 / Q13:
//   - `nowFine`   — 1-second tick, used while the queue panel is expanded.
//   - `nowCoarse` — 1-minute tick, used while the panel is collapsed (e.g.
//                   sidebar header / status area). Derived from `nowFine`
//                   (NOT a second `setInterval`) so the entire webview pays
//                   for a single wake-up per second.
//
// Both stores expose Svelte-store-compatible `subscribe()` semantics
// (writable `now: number` epoch ms). The fine timer starts lazily on the
// first subscription and stops when the last subscriber unsubscribes —
// idle webviews never tick.
//
// `nowCoarse` is computed by snapping `nowFine` down to the nearest
// 60-second boundary (`Math.floor(fine / 60_000) * 60_000`) and only
// publishing when that snapped value changes. This keeps "max-60-second
// lag" intact (SC-007) without a second interval.
//
// Tests should override `setNow` / `clearNow` via the exported
// `__setTickerForTests` hook OR use vitest's fake timers.

import type { Readable } from 'svelte/store';
import { readable, derived } from 'svelte/store';

export const MS_PER_SECOND = 1_000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;

type Stop = () => void;
type IntervalHandle = ReturnType<typeof setInterval>;

interface TickerDeps {
  setInterval: (fn: () => void, ms: number) => IntervalHandle;
  clearInterval: (h: IntervalHandle) => void;
  now: () => number;
}

let deps: TickerDeps = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
  now: () => Date.now()
};

/**
 * Test-only hook for vitest specs that need to drive the ticker without
 * fake timers. The host webview never calls this. The test harness
 * restores `deps` to its production default in an afterEach.
 */
export function __setTickerForTests(next: Partial<TickerDeps>): void {
  deps = { ...deps, ...next };
}

export function __resetTickerForTests(): void {
  deps = {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
    now: () => Date.now()
  };
}

function createFineTicker(): Readable<number> {
  return readable<number>(deps.now(), (set): Stop => {
    set(deps.now());
    const handle = deps.setInterval(() => set(deps.now()), MS_PER_SECOND);
    return () => deps.clearInterval(handle);
  });
}

/**
 * 1-second tick. Subscribe from the expanded queue panel and any
 * countdown that should refresh every second.
 */
export const nowFine: Readable<number> = createFineTicker();

/**
 * 1-minute tick. Subscribe from collapsed surfaces (sidebar header,
 * status-area summaries). Derived from `nowFine` so there is no second
 * `setInterval`; only re-publishes when the snapped minute boundary
 * changes.
 */
export const nowCoarse: Readable<number> = derived(
  nowFine,
  ($fine, set) => {
    const snapped = Math.floor($fine / MS_PER_MINUTE) * MS_PER_MINUTE;
    set(snapped);
  },
  Math.floor(deps.now() / MS_PER_MINUTE) * MS_PER_MINUTE
);
