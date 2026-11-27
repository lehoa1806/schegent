// Bug "there is no way to start a pending task" (2026-09-02), third finding —
// the lint gate that ratchets a total and lets its own breakdown rot.
//
// `scripts/lint.mjs` compares a rule's finding COUNT against
// `tests/lint/eslint-baseline.json` and fails in both directions. Beside each
// count it writes a per-file breakdown, which is what lets a regression name the
// files that grew instead of telling a contributor to run the tool twice and diff
// by hand (FR-R3-088). Nothing compared that breakdown. So a change that MOVED a
// finding from one file to another left the total equal, the gate green, and the
// record pointing at a file that no longer had the finding — after which the next
// regression message names the wrong file, which the record's own `byFile`
// comment already establishes is worse than naming none.
//
// It had happened twice by the time this was written, and both are recorded in
// the repository rather than remembered: `lint.mjs` carried the case of a
// `no-unnecessary-condition` attributed to `src/extension.ts` after the finding
// moved to `src/monitor/cli-transport-sink.ts`, and the baseline's own
// `reductionNote` says *"the record kept carrying them because this gate ratchets
// a TOTAL and the per-file breakdown is rewritten only when the total moves."*
// The remedy written down at the time was an instruction to contributors — "re-run
// this with `--write-baseline` when you move code, not only when a count changes"
// — which is precisely the kind of remedy a gate exists to replace.
//
// WHY THE DIFF IS ITS OWN MODULE. `lint.mjs` runs ESLint over the whole tree at
// import time, so a test cannot import it without paying for a full lint pass and
// getting an answer about this repository rather than about the comparison. The
// arithmetic is separated out so it can be given two breakdowns and asked what
// changed; the runner keeps the I/O, the record and the remediation wording.
//
// Imported through a computed specifier for the reason `eslint-baseline.test.ts`
// records at its own dynamic import: the module is `.mjs` with no declaration
// file and this tree does not set `allowJs`, so a literal specifier fails
// `typecheck:tests` on the import itself.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

type Counts = Record<string, number>;
type BreakdownDrift = (recorded: Counts, actual: Counts) => string | null;

let breakdownDrift: BreakdownDrift;

beforeAll(async () => {
  const specifier = pathToFileURL(
    resolve(__dirname, '..', '..', '..', 'scripts', 'lint-baseline-diff.mjs')
  ).href;
  const mod = (await import(specifier)) as { breakdownDrift: BreakdownDrift };
  breakdownDrift = mod.breakdownDrift;
});

describe('breakdownDrift — the per-file record, held to the run that produced it', () => {
  it('is silent when the breakdown still describes the run', () => {
    const same: Counts = { 'src/a.ts': 3, 'src/b.ts': 1 };
    expect(breakdownDrift(same, { ...same })).toBeNull();
  });

  it('is silent over two empty breakdowns', () => {
    // A rule at zero in this tree. Nothing to say, and saying something would
    // fail every clean run of a rule nobody has findings for.
    expect(breakdownDrift({}, {})).toBeNull();
  });

  it('catches a finding that moved between files while the total stayed put', () => {
    // THE CASE THE GATE COULD NOT SEE. Both sides total 4.
    const drift = breakdownDrift(
      { 'src/extension.ts': 1, 'src/queue/queue-manager.ts': 3 },
      { 'src/monitor/cli-transport-sink.ts': 1, 'src/queue/queue-manager.ts': 3 }
    );

    expect(drift).not.toBeNull();
    expect(drift).toContain('src/extension.ts');
    expect(drift).toContain('src/monitor/cli-transport-sink.ts');
    // The file that did not move is not noise in the message.
    expect(drift).not.toContain('src/queue/queue-manager.ts');
  });

  it('distinguishes a file that gained from one that lost, and names the amounts', () => {
    const drift = breakdownDrift(
      { 'src/kept.ts': 5, 'src/shrank.ts': 4 },
      { 'src/kept.ts': 5, 'src/shrank.ts': 1, 'src/grew.ts': 3 }
    );

    expect(drift).not.toBeNull();
    const text = drift as string;
    // Each changed file appears once, with both its recorded and its current count,
    // so the reader can see which direction it moved without a second run.
    expect(text).toMatch(/src\/shrank\.ts.*\b4\b.*\b1\b|src\/shrank\.ts.*\b1\b.*\b4\b/);
    expect(text).toMatch(/src\/grew\.ts/);
    expect(text.split('\n').filter((line) => line.includes('src/kept.ts'))).toEqual([]);
  });

  it('names a file that appeared and one that vanished as such', () => {
    const drift = breakdownDrift({ 'src/gone.ts': 2 }, { 'src/arrived.ts': 2 });

    expect(drift).not.toBeNull();
    const text = drift as string;
    expect(text).toContain('src/gone.ts');
    expect(text).toContain('src/arrived.ts');
  });

  it('ends every line it emits, so the runner can concatenate it', () => {
    // The runner splices this into a multi-part failure string beside other
    // sections. A section that does not end its last line runs into the next one.
    const text = breakdownDrift({ 'src/a.ts': 1 }, { 'src/b.ts': 1 }) as string;
    expect(text.endsWith('\n')).toBe(true);
  });

  it('bounds a wholesale relocation rather than printing hundreds of lines', () => {
    // A directory rename moves every finding at once. The message has to stay
    // readable — the record is regenerated with one command either way, so an
    // exhaustive list buys nothing and costs a scrollback.
    const recorded: Counts = {};
    const actual: Counts = {};
    for (let index = 0; index < 200; index += 1) {
      recorded[`src/old/file-${index}.ts`] = 1;
      actual[`src/new/file-${index}.ts`] = 1;
    }

    const text = breakdownDrift(recorded, actual) as string;
    expect(text).not.toBeNull();
    expect(text.split('\n').length).toBeLessThan(40);
    // And it must say that it truncated, rather than quietly appearing complete.
    expect(text).toMatch(/more file/);
  });
});
