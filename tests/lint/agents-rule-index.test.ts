// Drift guard for the hard-rule index in the envelope's `docs/hard-rules.md`.
//
// THE RULES MOVED on 2026-09-05. They were 826 of AGENTS.md's 1,058 lines and
// are now a file of their own; AGENTS.md, CLAUDE.md and repo/AGENTS.md all
// point at it and carry no rule text. Nothing about the rules themselves
// changed — same 67, same order, same ordinals — so this gate is repointed,
// not rewritten. `SECTION_HEADING` is now `## The rules` because the file's
// own title is the old section heading, and the preamble above that heading is
// deliberately outside the numbered set: a "- **Never**" bullet written into
// it is a rule the index cannot cite, which the first test below still catches.
//
// The index at `### Index — read the rows your change touches` cites each hard
// rule twice over: by its opening words and by an ordinal. Both citations are
// derivable from the rules themselves, so neither has to be trusted — this
// test re-derives them and fails on disagreement.
//
// WHY IT EXISTS. `FR-R3-154` found the index describing a tree that no longer
// existed. A rule had been added at position 20 (the monitor-stall idle bound,
// from the compaction-window work in the same batch) and the index was not
// touched. Because the ordinals are positional, that single insertion made 45
// of the 64 citations name the rule *before* the one they quoted, and left the
// count one short. Every wrong row was individually plausible — the ordinals
// were still dense, still unique, still in range, and each phrase still
// matched a real rule — so nothing about reading the index revealed that most
// of it was wrong. Only re-deriving the numbers does.
//
// That is the shape this test is for: not a missing rule, which a reader might
// notice, but a correct-looking index that points one rule off. The existing
// `agents-claude-parity.test.ts` cannot catch it. Its `HARD_RULE_ANCHORS` check
// asks whether a phrase appears *somewhere* in the rule file, which stayed true
// throughout — an existence check is blind to an ordinal, by construction.
//
// WHAT IT DOES NOT DO. It does not check that a rule is indexed under the
// right subsystem heading. That is a judgement about which contributors need
// to read what, and mechanising it would mean encoding the taxonomy here as a
// second thing to maintain. It also does not renumber anything: on failure it
// reports the correct ordinal and stops, because a rule renumbered by a test
// run is a governance edit nobody reviewed.
//
// The cheap way to stay green is to append a new rule at the end of the list,
// where no existing ordinal moves. Inserting mid-list is allowed and sometimes
// right — it keeps a rule next to its neighbours — but it is a renumbering,
// and this test is what makes that a decision rather than an accident.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { envelopePresent } from './envelope-presence';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// The authoritative rule set is the envelope's docs/hard-rules.md. Neither
// AGENTS.md carries rule text; `agents-claude-parity.test.ts` enforces that.
const RULES_PATH = path.resolve(REPO_ROOT, '..', 'docs', 'hard-rules.md');
/** How the file is named in failure output, so a line number is clickable. */
const RULES_DISPLAY = 'docs/hard-rules.md';

const SECTION_HEADING = '## The rules';
const RULE_BULLET = /^- \*\*Never\*\* /;
// `- *opening words* (rule 12)` — the index citation form.
const INDEX_BULLET = /^- \*(.+)\* \(rule (\d+)\)$/;
// "all **65 rules** appear exactly once below"
const ASSERTED_COUNT = /all \*\*(\d+) rules\*\* appear exactly once below/;

interface Rule {
  readonly ordinal: number;
  readonly line: number;
  /** The bullet's first physical line, which is what the index quotes from. */
  readonly opening: string;
}

interface Citation {
  readonly line: number;
  readonly phrase: string;
  readonly ordinal: number;
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function loadRules(): {
  lines: readonly string[];
  sectionStart: number;
  sectionEnd: number;
} {
  const lines = fs.readFileSync(RULES_PATH, 'utf8').split(/\r?\n/);
  const sectionStart = lines.findIndex((l) => l.trim() === SECTION_HEADING);
  expect(
    sectionStart,
    `${RULES_DISPLAY} no longer contains the heading "${SECTION_HEADING}". This ` +
      'test locates the rules by that heading; if it was renamed, rename it here too.'
  ).toBeGreaterThanOrEqual(0);
  // The section runs to the next same-level heading, or to end of file.
  const rest = lines.findIndex(
    (l, i) => i > sectionStart && /^## /.test(l)
  );
  return { lines, sectionStart, sectionEnd: rest === -1 ? lines.length : rest };
}

function collectRules(
  lines: readonly string[],
  start: number,
  end: number
): Rule[] {
  const rules: Rule[] = [];
  for (let i = start; i < end; i++) {
    const line = lines[i] ?? '';
    if (!RULE_BULLET.test(line)) continue;
    rules.push({
      ordinal: rules.length + 1,
      line: i + 1,
      opening: squash(line)
    });
  }
  return rules;
}

function collectCitations(
  lines: readonly string[],
  start: number,
  end: number
): Citation[] {
  const citations: Citation[] = [];
  for (let i = start; i < end; i++) {
    const match = INDEX_BULLET.exec((lines[i] ?? '').trim());
    if (!match) continue;
    citations.push({
      line: i + 1,
      phrase: squash(match[1]),
      ordinal: Number(match[2])
    });
  }
  return citations;
}

/** Rules whose first line begins with the phrase the index quoted. */
function matchRules(rules: readonly Rule[], phrase: string): Rule[] {
  const prefix = squash(`- **Never** ${phrase}`);
  return rules.filter((rule) => rule.opening.startsWith(prefix));
}

// FR-R3-118 (FR-049) — the rule set this gate re-derives lives ABOVE `REPO_ROOT`,
// and `repo/` cloned on its own is a supported way to work here. `loadRules()`
// below is an unguarded `readFileSync`, so without this the whole file raises
// ENOENT in such a clone and takes `vitest run` — therefore `test:host`,
// `verify:all` and `gate` — down with it. Skipping is the same answer
// `agents-claude-parity.test.ts` gives to the same question; the shared
// predicate is `envelope-presence.ts` so an eleventh gate cannot invent a
// twelfth shape for it.
//
// `tests/lint/no-unguarded-parent-read.test.ts` did not catch the omission:
// `RULES_PATH` names a FILE, so its `isAboveRepoRoot` check computes
// `relative(RULES_PATH, REPO_ROOT) === '../../repo'` and reads false, and
// `readFileSync(NAME, …)` matches neither of its `resolve(NAME,`/`join(NAME,`
// indirect-use patterns. Two independent blind spots, either one sufficient.
describe.skipIf(!envelopePresent())('docs/hard-rules.md rule index', () => {
  it('numbers every rule in the section and nothing outside it', () => {
    const { lines, sectionStart, sectionEnd } = loadRules();
    const rules = collectRules(lines, sectionStart, sectionEnd);
    expect(rules.length).toBeGreaterThan(0);

    const strays = lines
      .map((line, i) => ({ line, number: i + 1 }))
      .filter(
        ({ line, number }) =>
          RULE_BULLET.test(line) &&
          (number <= sectionStart || number > sectionEnd)
      )
      .map(({ number }) => `${RULES_DISPLAY}:${number}`);
    expect(
      strays,
      'A "- **Never**" bullet outside the rules section is not part of the ' +
        'numbered set, so the index cannot cite it and this test cannot check ' +
        'it. Move it into the section, or stop phrasing it as a hard rule.'
    ).toEqual([]);
  });

  it('cites each rule by an ordinal that names that same rule', () => {
    const { lines, sectionStart, sectionEnd } = loadRules();
    const rules = collectRules(lines, sectionStart, sectionEnd);
    const citations = collectCitations(lines, sectionStart, sectionEnd);
    expect(citations.length).toBeGreaterThan(0);

    const wrong: string[] = [];
    for (const citation of citations) {
      const hits = matchRules(rules, citation.phrase);
      if (hits.length === 0) {
        wrong.push(
          `${RULES_DISPLAY}:${citation.line} cites "(rule ${citation.ordinal})" for ` +
            `"${citation.phrase}", but no rule opens with those words.`
        );
        continue;
      }
      if (hits.length > 1) {
        wrong.push(
          `${RULES_DISPLAY}:${citation.line} quotes "${citation.phrase}", which opens ` +
            `${hits.length} rules (${hits
              .map((h) => `rule ${h.ordinal}`)
              .join(', ')}). Quote more of the opening line so it names one.`
        );
        continue;
      }
      // Exactly one hit here: the zero and >1 cases both `continue` above.
      const actual = hits[0];
      if (actual.ordinal !== citation.ordinal) {
        wrong.push(
          `${RULES_DISPLAY}:${citation.line} cites "(rule ${citation.ordinal})" but ` +
            `"${citation.phrase}" is rule ${actual.ordinal} ` +
            `(${RULES_DISPLAY}:${actual.line}).`
        );
      }
    }
    expect(
      wrong,
      'The index and the rules disagree. Ordinals are positional, so a rule ' +
        'inserted mid-list renumbers every rule after it and each stale ' +
        'citation then names the rule before the one it quotes — which reads ' +
        'as correct. Fix the ordinals; do not reword a citation to match a ' +
        'number.\n' +
        wrong.join('\n')
    ).toEqual([]);
  });

  it('indexes every rule exactly once', () => {
    const { lines, sectionStart, sectionEnd } = loadRules();
    const rules = collectRules(lines, sectionStart, sectionEnd);
    const citations = collectCitations(lines, sectionStart, sectionEnd);

    const counts = new Map<number, number>();
    for (const citation of citations) {
      counts.set(citation.ordinal, (counts.get(citation.ordinal) ?? 0) + 1);
    }

    const missing = rules
      .filter((rule) => !counts.has(rule.ordinal))
      .map((rule) => `rule ${rule.ordinal} (${RULES_DISPLAY}:${rule.line})`);
    expect(
      missing,
      'A hard rule the index does not mention is a rule a contributor routed ' +
        'by subsystem will never be shown. Add it to the group whose readers ' +
        'need it.'
    ).toEqual([]);

    const repeated = [...counts.entries()]
      .filter(([, n]) => n > 1)
      .map(([ordinal, n]) => `rule ${ordinal} cited ${n} times`);
    expect(repeated, 'Each rule is indexed once.').toEqual([]);

    const outOfRange = [...counts.keys()]
      .filter((ordinal) => ordinal < 1 || ordinal > rules.length)
      .map((ordinal) => `rule ${ordinal}`);
    expect(
      outOfRange,
      `The section holds ${rules.length} rules, so these ordinals name nothing.`
    ).toEqual([]);
  });

  it('asserts its own rule count, and the count is right', () => {
    const { lines, sectionStart, sectionEnd } = loadRules();
    const rules = collectRules(lines, sectionStart, sectionEnd);
    const body = lines.slice(sectionStart, sectionEnd).join('\n');

    const claim = ASSERTED_COUNT.exec(body);
    expect(
      claim,
      'The index states how many rules it covers, in the form "all **N ' +
        'rules** appear exactly once below". That sentence is the claim this ' +
        'test checks; restoring it is cheaper than removing the check.'
    ).not.toBeNull();

    expect(
      Number(claim?.[1]),
      `The index claims ${claim?.[1]} rules; the section holds ${rules.length}. ` +
        'The last rule is at ' +
        `${RULES_DISPLAY}:${rules[rules.length - 1]?.line}. Note the dated FR-R3-121 ` +
        'measurement in the same section is deliberately NOT this number and ' +
        'must not be "corrected" to agree with today\'s tree.'
    ).toBe(rules.length);
  });
});
