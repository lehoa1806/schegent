// The arithmetic behind the lint ratchet's per-file record, separated from the
// runner so it can be tested without linting the repository.
//
// `scripts/lint.mjs` is a script: it runs ESLint over a whole tree at import time
// and sets `process.exitCode`. A test that imported it to check a comparison would
// pay for a full lint pass and then get an answer about THIS repository's current
// findings rather than about the comparison. So the part with a right answer lives
// here, where it can be handed two breakdowns and asked what changed, and the
// runner keeps the I/O, the record and the remediation wording.
//
// Unit tests: tests/unit/scripts/lint-baseline-diff.test.ts

/** How many files a message names before it summarises the rest. */
export const FILES_SHOWN = 10;

/**
 * FR-R3-088 — whether a recorded per-file breakdown still describes the run in
 * front of it, and if not, what moved.
 *
 * WHY THIS EXISTS. The ratchet gates a rule's TOTAL against
 * `tests/lint/eslint-baseline.json`, in both directions. Beside that total the
 * record carries a per-file breakdown, which is the thing that lets a regression
 * NAME the files that grew instead of telling a contributor to run the tool twice
 * and diff by hand. Nothing compared the breakdown, so a change that MOVED a
 * finding from one file to another left the total equal, the gate green, and the
 * record pointing at a file that no longer had the finding. The next regression
 * message then names the wrong file — which is worse than naming none, as the
 * runner's own `byFile` comment records from experience.
 *
 * It happened twice before this was written, both times recorded in the
 * repository rather than remembered: a `no-unnecessary-condition` attributed to
 * `src/extension.ts` after the finding had moved to
 * `src/monitor/cli-transport-sink.ts`, and a `no-explicit-any` blamed on a visual
 * spec that the run in question had not touched. The remedy written down at the
 * time was an instruction to contributors — re-run with `--write-baseline` when
 * you move code, not only when a count changes — which is exactly the kind of
 * remedy a gate exists to replace.
 *
 * WHAT IT REPORTS. Only files whose count changed. A file that carries the same
 * number of findings before and after is not evidence of anything and would bury
 * the two lines that are. Both directions appear, because a move is a loss and a
 * gain and naming only one half asks the reader to work out the other.
 *
 * WHY IT TRUNCATES. A directory rename relocates every finding at once. The
 * record is regenerated with one command whether it names ten files or four
 * hundred, so an exhaustive list buys nothing and costs a scrollback. The
 * truncation is announced rather than silent, so a short list is never mistaken
 * for a complete one.
 *
 * @param {Record<string, number>} recorded per-file counts as the baseline holds them
 * @param {Record<string, number>} actual per-file counts from the run just performed
 * @returns {string | null} newline-terminated indented lines, or null when they agree
 */
export function breakdownDrift(recorded, actual) {
  const moved = [];
  for (const file of new Set([...Object.keys(recorded), ...Object.keys(actual)])) {
    const was = recorded[file] ?? 0;
    const now = actual[file] ?? 0;
    if (was !== now) moved.push({ file, was, now });
  }
  if (moved.length === 0) return null;

  // Largest movement first, so the file most likely to be the cause is the first
  // line read; ties by path, so two runs over the same drift print the same text.
  moved.sort(
    (a, b) => Math.abs(b.now - b.was) - Math.abs(a.now - a.was) || a.file.localeCompare(b.file)
  );

  const shown = moved
    .slice(0, FILES_SHOWN)
    .map(({ file, was, now }) => {
      const sign = now > was ? '+' : '-';
      const delta = String(Math.abs(now - was)).padStart(4);
      const where = was === 0 ? `(had none recorded, now ${now})`
        : now === 0 ? `(was ${was}, now none)`
        : `(was ${was}, now ${now})`;
      return `        ${sign}${delta}  ${file}  ${where}\n`;
    })
    .join('');

  const rest = moved.length - FILES_SHOWN;
  return rest > 0 ? `${shown}        and ${rest} more file(s) moved\n` : shown;
}
