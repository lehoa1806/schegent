// FR-R3-037 — a name this project deliberately retired may not reappear as
// instruction.
//
// `docs:check` resolves every relative link in this repository and reports zero
// broken, because it verifies that a target EXISTS. It has never verified that a
// sentence is still TRUE, and that is the one drift class nothing here covers.
// Three sentences were false about the tree when this gate was written:
// `backends.md` routed per-phase runner selection through a
// `pipeline-config.json` that feature 098 retired, `ARCHITECTURE.md` labelled the
// host "Node 20" against an `engines.node` of `^22 || ^24`, and a 2026-05-10
// decision record still status-"Decided" asserted that this project runs no
// remote CI, seven workflow files later. Writing this gate found a fourth:
// `CONTRIBUTING.md` asked bug reporters for a `schegent.phases` entry.
//
// The ADR is why this is a gate rather than four edits. It prescribed a required
// check on `main`, on a repository whose integration branch is `develop` and
// which has never had a `main`. Workflow triggers were written against it and
// filtered a branch that does not exist, so they never ran and never errored. A
// stale decision record did not just misinform a reader — it propagated into
// configuration.
//
// WHAT THIS GATE DOES NOT DO, stated because the gap is the larger half:
// it reads names in sentences, not the truth of sentences. It catches a retired
// identifier used as instruction. It cannot catch a sentence that is false
// without naming anything retired, which is most of them. No gate in this
// repository reads a claim and decides whether it still holds, and this one does
// not change that.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (path: string): string => readFileSync(resolve(REPO_ROOT, path), 'utf8');

interface Retired {
  readonly name: string;
  readonly retiredBy: string;
  readonly writeInstead: string;
}

/**
 * Names this project removed on purpose, each with the event that removed it and
 * what to write in its place. The replacement is not decoration: a failure that
 * says only "forbidden" gets an exemption added, and a failure that says what to
 * write gets a fix.
 *
 * `src/engine` is deliberately absent. It is a path fragment that appears in
 * ordinary prose, and a rule matching it loosely would fire on unrelated text —
 * which is how an allowlist starts growing until it means nothing.
 */
const RETIRED: ReadonlyArray<Retired> = Object.freeze([
  {
    name: 'pipeline-config.json',
    retiredBy: 'feature 098 / FR-R3-014 — the extension ships no phases and reads no such file',
    writeInstead:
      'the versioned catalog under `.schegent/catalog/`, authored in the Pipeline Builder or imported from YAML'
  },
  {
    name: 'schegent.phases',
    retiredBy: 'feature 098 — the setting was deleted with no replacement',
    writeInstead: 'a Phase definition in the versioned catalog'
  },
  {
    name: 'schegent.pipelines',
    retiredBy: 'feature 098 — the setting was deleted with no replacement',
    writeInstead: 'a Pipeline definition in the versioned catalog'
  }
]);

/**
 * Documents whose retired names are a record of what was true on their date.
 *
 * Enumerated with a reason each. A directory exclusion would be easier and would
 * let the next drift land in a file nobody re-reads.
 */
const HISTORICAL: ReadonlyArray<{ path: string; why: string }> = Object.freeze([
  {
    path: 'docs/operations/principal-architecture-review-2026-05-18.md',
    why: 'a dated review; its accuracy is a property of its date'
  },
  {
    path: 'docs/operations/superseded-architecture-review.md',
    why: 'a dated review; its accuracy is a property of its date'
  },
  {
    path: 'tests/lint/retired-identifiers.test.ts',
    why: 'this file names every retired identifier by definition'
  }
]);

/**
 * The lowest Node major `engines.node` admits.
 *
 * Derived rather than written down. A literal would be correct today and wrong at
 * the next bump — the same hardcoded-fact defect this gate exists to catch, one
 * level down.
 */
function engineFloor(): number {
  const manifest = JSON.parse(read('package.json')) as { engines?: { node?: string } };
  const declared = manifest.engines?.node ?? '';
  const supported = [...declared.matchAll(/(\d+)/g)].map((match) => Number(match[1]));
  expect(
    supported.length,
    'package.json declares no parseable `engines.node`. This gate derives the floor from it ' +
      'rather than hardcoding a version; if the field moved, teach this function.'
  ).toBeGreaterThan(0);
  return Math.min(...supported);
}

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(resolve(REPO_ROOT, dir))) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const rel = `${dir}/${entry}`;
    if (statSync(resolve(REPO_ROOT, rel)).isDirectory()) markdownFiles(rel, out);
    else if (entry.endsWith('.md')) out.push(rel);
  }
  return out;
}

/** Every document this gate reads, with the historical records removed. */
function scanned(): string[] {
  const exempt = new Set(HISTORICAL.map((entry) => entry.path));
  return ['README.md', 'SECURITY.md', 'ARCHITECTURE.md', 'CONTRIBUTING.md', ...markdownFiles('docs')]
    .filter((path) => !exempt.has(path));
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ');

/**
 * Claim-sized units: a table row, a list item, or a sentence within a paragraph.
 *
 * Block structure has to come first. Splitting only on sentence punctuation makes
 * a markdown table one unit — `ARCHITECTURE.md` produces a single 3,113-character
 * "sentence" spanning an entire ownership table — and a retired name in one cell
 * is then excused by unrelated wording three rows away. Fenced code is skipped
 * entirely: it is an example, not a claim.
 */
function textUnits(text: string): string[] {
  const units: string[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) {
      units.push(...collapse(paragraph.join(' ')).split(/(?<=[.!?;])\s+/));
    }
    paragraph = [];
  };
  let fenced = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (trimmed.length === 0) {
      flush();
      continue;
    }
    if (trimmed.startsWith('|') || /^[-*+]\s|^\d+\.\s/.test(trimmed)) {
      flush();
      units.push(collapse(trimmed));
      continue;
    }
    paragraph.push(trimmed);
  }
  flush();
  return units.filter((unit) => unit.trim().length > 0);
}

/**
 * Language that marks a name as gone. A claim carrying one of these near the name
 * is describing a retirement, not prescribing the retired thing.
 */
const RETIREMENT_LANGUAGE =
  /\b(deleted|removed|retired|no longer|once lived|used to|formerly|are not settings|there are no|with no replacement|superseded|absent)\b/i;

/** A dated measurement is a fact about a run, not a claim about the current floor. */
const DATED_MEASUREMENT = /\bat the time\b|\bmeasured on\b|\bpin at the time\b/i;

/**
 * Language that puts a name in the imperative — telling a reader to use it.
 *
 * This is decisive, and it has to be, because retirement language alone is
 * evadable: `Set schegent.phases to configure the retry count, a workaround that
 * predates the feature we removed for the deprecated batch mode` contains
 * "removed", about something else entirely, and a rule that only looks for
 * retirement language excuses the instruction on that basis. A name being told
 * to a reader is drift no matter what else the sentence says about history.
 */
const INSTRUCTION_LANGUAGE =
  /\b(set|configure|add|edit|use|using|specify|declare|put|place|enable|populate|check that|depends on|include)\b/i;

/**
 * Is retirement language close enough to THIS occurrence to be describing it?
 *
 * Generous on purpose — 120 characters. A retirement predicate follows its
 * subject, and the subject is often a list: in `ARCHITECTURE.md` the phrase
 * `are **deleted, not drained**` sits 79 characters past the first of three
 * names, so a tighter window reported a correct sentence. Width is safe here
 * because it is not the only test: an occurrence preceded by instruction
 * language is an offender regardless of what follows it, which is what stops a
 * wide window from excusing `Set schegent.phases … a feature we removed`.
 */
function explainedAt(unit: string, index: number, length: number, extra?: RegExp): boolean {
  const window = unit.slice(Math.max(0, index - 120), index + length + 120);
  return RETIREMENT_LANGUAGE.test(window) || (extra?.test(window) ?? false);
}

/**
 * Is the name being told to the reader as something to do?
 *
 * Only language BEFORE the name counts. An imperative puts its verb first —
 * "Set X", "using X", "check that X", "depends on X" — whereas a sentence
 * recording a retirement puts its predicate after the list: "X, Y and Z are
 * deleted". Looking on both sides flagged two correct sentences in
 * `ARCHITECTURE.md` and `settings.md` on the day it was written, because a
 * later clause happened to contain an instruction-ish word.
 */
function instructedAt(unit: string, index: number): boolean {
  return INSTRUCTION_LANGUAGE.test(unit.slice(Math.max(0, index - 60), index));
}

/**
 * Every occurrence of `name` that reads as instruction rather than as history.
 *
 * Two ways to be an offender: told to the reader as something to use, or named
 * with nothing nearby saying it is gone.
 */
function unexplainedOccurrences(unit: string, name: string): boolean {
  let from = 0;
  for (;;) {
    const at = unit.indexOf(name, from);
    if (at < 0) return false;
    if (instructedAt(unit, at)) return true;
    if (!explainedAt(unit, at, name.length)) return true;
    from = at + name.length;
  }
}

describe('retired identifiers do not reappear as instruction', () => {
  for (const entry of RETIRED) {
    it(`does not name \`${entry.name}\` as a live instruction`, () => {
      const offenders: string[] = [];
      for (const path of scanned()) {
        for (const unit of textUnits(read(path))) {
          if (!unit.includes(entry.name)) continue;
          if (!unexplainedOccurrences(unit, entry.name)) continue;
          offenders.push(`${path}: "${unit.slice(0, 120)}"`);
        }
      }
      expect(
        offenders,
        `\`${entry.name}\` was retired by ${entry.retiredBy}, and it is named without saying so in:\n  ` +
          `${offenders.join('\n  ')}\n` +
          `Write ${entry.writeInstead} instead. Naming it to record that it is gone is correct and ` +
          `passes; naming it as something to configure is the drift. If the document is a dated ` +
          `historical record, add it to HISTORICAL with that reason — but read the sentence first, ` +
          `because an exemption added to silence a gate is how the gate stops meaning anything.`
      ).toEqual([]);
    });
  }

  it('does not claim a runtime below the declared engine floor', () => {
    // Every major below the floor, not a fixed window. An earlier version
    // forbade only floor-1 and floor-2, leaving `Node 18` and `Node 16` — both
    // former LTS releases, and therefore more plausible mistaken claims than the
    // 21 it did cover — silently permitted, and under-covering further with
    // every bump.
    const floor = engineFloor();
    const offenders: string[] = [];
    for (const path of scanned()) {
      for (const unit of textUnits(read(path))) {
        for (const match of unit.matchAll(/\bNode (\d+)\b/g)) {
          if (Number(match[1]) >= floor) continue;
          const at = match.index;
          // `docs/development/coverage-measurements.md` and
          // `docs/development/lint-and-type-aware-rules.md` both record
          // "Node 20.18.0 (the `.nvmrc` pin at the time)". That is true, and it
          // must stay sayable.
          if (explainedAt(unit, at, match[0].length, DATED_MEASUREMENT)) continue;
          offenders.push(`${path}: "${unit.slice(0, 120)}"`);
        }
      }
    }
    expect(
      offenders,
      `A document claims a Node version below the ${floor} floor \`engines.node\` declares:\n  ` +
        `${offenders.join('\n  ')}\n` +
        `The manifest is where the supported range is declared; a document restating an older one ` +
        `is a second copy that went stale. The floor is read from the manifest, so bumping the ` +
        `engine changes what is forbidden without editing this gate.`
    ).toEqual([]);
  });

  // A cross-repo assertion stood here and was removed, because it could not have
  // held where it mattered. It read `../docs/plans/remote-ci-decision.md` — a
  // path in the sibling WORKSPACE repository, which this one is cloned without.
  // `schegent-dev/.gitignore` ignores `/repo/` precisely because the two are
  // independent repositories with separate remotes, so a standalone clone of
  // this one has no such sibling and the test threw ENOENT. It passed only in a
  // dual-checkout dev sandbox, which is the shape of a test that is green
  // everywhere except where it runs for real. The superseded-record assertions
  // belong to the workspace repository, where both documents actually are.

  it('states its own limit where a reader of a failure will see it', () => {
    const self = read('tests/lint/retired-identifiers.test.ts');
    expect(self).toContain('WHAT THIS GATE DOES NOT DO');
    expect(self).toContain('it reads names in sentences, not the truth of sentences');
  });
});
