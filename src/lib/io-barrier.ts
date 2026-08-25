// FR-R3-050 (M-02) → FR-R3-082 (T1089) — the two guarantees a single timeout
// used to serve, and why they cannot be one.
//
// The defect, in both writers that had it: `Promise.race([write, setTimeout])`.
// `race` reports whichever side settles first and cancels nothing. The timer
// fires, the caller is told the append failed, the chain link resolves — and the
// write is still in flight, free to land AFTER the next append has been written.
// An append-only evidence file whose appends can reorder is not append-only in
// the way anything reading it assumes.
//
// The correction separates what one timer was doing:
//
//   - `holdOrdering` is the CHAIN's view. The next append waits for this one to
//     really settle, so nothing interleaves with a write a caller gave up on.
//     Bounded, and the expiry is REPORTED: past that point ordering genuinely is
//     not guaranteed, and a log that stays silent about it reads as an ordered
//     log. Never rejects — it is the chain, and a rejected chain link would
//     surface as an unhandled rejection with no caller to receive it.
//
//   - `boundForCaller` is the CALLER's view. A wedged filesystem must not stall
//     the phase that is waiting, so the caller gets a bounded answer. Rejecting
//     here says "you were not told this landed"; it does not say the write was
//     abandoned, because it was not.
//
// This module exists so there is ONE implementation. `FR-R3-082` requires the
// metrics writer to use the shape `FR-R3-050` established rather than invent a
// second, and two copies of a shape are two shapes as soon as one is edited.

/** A write that stayed in flight past this is no longer ordered against the next. */
export const ORDERING_BARRIER_TIMEOUT_MS = 60_000;

/**
 * Hold the chain until `settled` really settles.
 *
 * `onExpiry` is called when the barrier gives up rather than when the write
 * does — the caller decides how to report it, because "ordering is no longer
 * guaranteed" is worded differently for an audit log than for a metrics rollup,
 * and neither should be a bare log line from a shared helper.
 */
export function holdOrdering(
  settled: Promise<unknown>,
  onExpiry: (barrierMs: number) => void,
  barrierMs: number = ORDERING_BARRIER_TIMEOUT_MS
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), barrierMs);
    timer.unref();
  });
  return Promise.race([
    settled.then(
      () => 'settled' as const,
      () => 'settled' as const
    ),
    expired
  ])
    .then((outcome) => {
      if (outcome !== 'expired') return;
      onExpiry(barrierMs);
    })
    .finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
}

/**
 * Give the caller a bounded answer without abandoning the write.
 *
 * `makeTimeoutError` is the caller's, so the rejection carries the code its own
 * accounting already recognises — `ETIMEDOUT` for the metrics rollup, a plain
 * `Error` for the audit log — rather than a code invented here that every
 * downstream normalizer would have to learn.
 */
export async function boundForCaller<T>(
  settled: Promise<T>,
  timeoutMs: number,
  makeTimeoutError: () => Error,
  /**
   * `unref()` the bound's timer. Off by default, so every existing caller is
   * byte-for-byte unchanged.
   *
   * FR-R3-083 needs it: the mount probe's deferred sweep waits several bounds on a
   * create that may never settle, and a ref'd timer there holds the Node event loop
   * open for that whole window after the probe has already answered — measured at
   * ~1.5 s past the verdict with a 300 ms bound, and ~10 s at the shipped one. A
   * probe outliving activation is the opposite of bounded.
   *
   * `holdOrdering` above already unrefs for the same reason; this makes the choice
   * available on this half rather than sending the next caller off to hand-roll a
   * third race.
   */
  unrefTimer = false
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      settled,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(makeTimeoutError()), timeoutMs);
        if (unrefTimer) timer.unref();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
