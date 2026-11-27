// FR-R3-137 (T1531a, FR-013, FR-014) — the leak detector.
//
// Node closes a `FileHandle` that becomes unreachable and says so:
//
//   Closing file descriptor 24 on garbage collection
//   [DEP0137] DeprecationWarning: Closing a FileHandle object on garbage
//   collection is deprecated.
//
// That is a *warning*, on stderr, in a green run — which is how a suite emitted
// fifteen lines of it for as long as anyone had been reading the output. This
// module turns it into something a test can fail on.
//
// OPT-IN, per file, and that is the design rather than a concession. A listener
// that failed the whole run on any descriptor warning would fail on a leak some
// unrelated suite has been emitting all along, and this feature would arrive as
// somebody else's red tree. A file that has been made to dispose what it creates
// calls `expectNoDescriptorWarnings()` in its own `afterAll`; a file that has
// not is unaffected and unmeasured, which is honest.
//
// SCOPE. Registered through `setupFiles` in `vitest.config.ts`, so it covers the
// default include. `tests/perf/**` runs under `vitest.perf.config.ts` (FR-R3-042)
// which declares no `setupFiles` and is deliberately left alone: the perf suite's
// descriptor claim is `openDescriptorCount` returning to baseline, which is a
// stronger statement than the absence of a GC warning.

/**
 * Node's own text, in both the plain warning and the deprecation that follows
 * it. Matched on the message rather than the warning `name`, because the pair
 * arrives as one `DeprecationWarning` and one un-named write on some versions.
 */
const DESCRIPTOR_WARNING = /Closing (?:a )?[Ff]ile(?:Handle| descriptor)/;

/**
 * Whether a piece of text is Node reporting a descriptor it had to close itself.
 *
 * Exported so the real-leak control (T1531e) can point this predicate at the
 * stderr of a process that actually leaked, rather than at two string literals
 * somebody transcribed from the docs. A regex that has drifted from Node's text
 * passes every test written against the regex.
 */
export function matchesDescriptorWarning(text: string): boolean {
  return DESCRIPTOR_WARNING.test(text);
}

const observed: string[] = [];

process.on('warning', (warning: Error & { code?: string }) => {
  const text = `${warning.name}: ${warning.message}`;
  if (warning.code === 'DEP0137' || matchesDescriptorWarning(text)) {
    observed.push(text);
  }
});

/** What the listener has seen so far, in arrival order. */
export function descriptorWarnings(): readonly string[] {
  return [...observed];
}

/** Forget everything seen so far. For the controls, which emit on purpose. */
export function resetDescriptorWarnings(): void {
  observed.length = 0;
}

/**
 * Fail the calling file if Node has closed a descriptor for it.
 *
 * Throws rather than using `expect`, so the module carries no dependency on the
 * test framework and can be called from a plain `afterAll` in any file.
 */
export function expectNoDescriptorWarnings(): void {
  if (observed.length === 0) return;
  const count = observed.length;
  const seen = observed.join('\n  ');
  // Cleared before throwing, so one leaking file does not also fail the next
  // file to call this in the same worker.
  observed.length = 0;
  throw new Error(
    `Node closed ${count} file descriptor(s) on garbage collection during this file. ` +
      `Something this file constructed was never disposed — GC is not a lifecycle. ` +
      `Dispose it where it was created.\n  ${seen}`
  );
}
