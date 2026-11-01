/**
 * FR-R4-F10 (BD2, BD6; FR-029, FR-030) -- a 10-line seeded PRNG for fixed-seed generators.
 *
 * WHY IT EXISTS. The bounded-work check (`tests/perf/sanitize-bounded-work.test.ts`), the local
 * scanner rule's linear-cost check (`tests/perf/secretlint-rule-linear.test.ts`) and the runtime
 * corpus's variants all build hostile or varied input from a seed, so that a failing run prints the
 * seed and reproduces from it alone. This is not a generative-test framework (FR-030): it is
 * mulberry32 and one picker.
 *
 * `tests/unit/lib/logger-secret-patterns.property.test.ts` keeps its own copy of the same
 * algorithm, on purpose, so that this feature edits no unrelated test.
 */

/** A deterministic generator of values in `[0, 1)` for `seed`. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** One element of `items`, chosen by `rng`. `items` must not be empty. */
export function pick<T>(rng: () => number, items: ReadonlyArray<T>): T {
  if (items.length === 0) throw new Error('pick: items must not be empty');
  return items.at(Math.floor(rng() * items.length)) as T;
}
