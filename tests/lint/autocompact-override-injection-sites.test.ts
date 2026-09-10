// Feature 012 (T071 — FR-009, SC-011) — the sites that inject
// CLAUDE_AUTOCOMPACT_PCT_OVERRIDE are a closed set of two, and each one says in
// source which requirement governs it.
//
// WHY THIS EXISTS. BUG-001 found the override transported and never effective:
// a session already too large for the CLI to admit is refused upstream of the
// auto-compaction threshold, so the variable is exported and the threshold never
// fires. Patching that report turned up a second thing nobody had written down.
// FR-006 says the operator setting decides whether the key appears, and it was
// drafted when exactly one place built an invocation. A second place had since
// appeared — the host's own session-compaction invocation, which hardcodes `1`
// and never reads the setting. That behaviour is deliberate, reasoned in the
// `sessionReuse` contract, and documented for operators in two reference pages.
// The requirement and the enforcement were the only two places it did not
// appear. FR-009 is the requirement; this file is the enforcement.
//
// ------------------------------------------------------------------ the method
//
// Search `src/` for the environment variable's NAME, never for its value —
// `docs/hard-rules.md` rule 67. That rule is not abstract here. A JSDoc block in
// `src/controller/phase-runner.ts` contains the literal text
// CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1, explaining why the compaction invocation
// forces the value. A search for the VALUE — for `=1`, or for `'1'` — scores
// that sentence as an assignment and reports three injection sites where there
// are two. The partition below is what stops a prose mention from counting, and
// the assertion that it stays a comment is a live control rather than a caveat:
// the trap is in the tree, not in a fixture.
//
// Every hit is classified into exactly one of three kinds:
//
//   assignment — the name appears in code, immediately followed by `:` or `=`.
//                Both shapes occur: a property assignment onto an env record,
//                and a key in an object literal passed as `env`.
//   comment    — the occurrence is inside a `//` tail, or on a line whose first
//                non-space characters open or continue a block comment.
//   other      — in code, but not being assigned. A read, a deletion, a key
//                lookup. None exist today; the kind exists so that one arriving
//                is reported rather than silently folded into a partition it
//                does not belong to.
//
// -------------------------------------------------- what this gate cannot say
//
//   - It cannot prove a comment GOVERNS the assignment it sits near. The marker
//     rule is a bounded look-back over comment lines, because the phase site's
//     FR-006 block sits a dozen lines above its assignment with the accessor
//     read and the env-map literal in between. What is checked is that a reader
//     scanning up from the assignment meets the requirement id before leaving
//     its neighbourhood. Whether the sentence is a good one is a human read.
//   - It pins no TOTAL and does not count how many comments mention the
//     variable. That number has no producer and would go red on the next comment
//     that mentions it — per FR-R3-067, `asserted-counts.test.ts`. Only the
//     assignment partition is pinned, because only that partition is what FR-009
//     calls a closed set.
//   - It asserts FILES, not line numbers. Line numbers are carried in the
//     failure message, where they help, and asserted nowhere. T073 adds a
//     comment above one of these two sites and shifts it by a line; a gate that
//     went red for that would be measuring formatting rather than the
//     requirement.
//   - It reads `src/` only. Tests and the webview mention the name too, and
//     neither builds a CLI invocation, so including them would widen the
//     population without widening the question.
//   - This file is not in its own population, by construction rather than by an
//     exclusion list: it lives under `tests/`, and the scan root is `src/`.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { linesMatching } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'src');

/**
 * The name, assembled rather than written whole.
 *
 * Not superstition: `spawn-env-parity.test.ts` and the phase-runner suite both
 * search source for this identifier, and a gate that spelled it out would put a
 * sixth occurrence into a tree whose whole subject is how many there are. The
 * scan root excludes `tests/` so nothing here can reach the census either way —
 * this keeps that true for any future gate whose root is wider.
 */
const ENV_NAME = ['CLAUDE', 'AUTOCOMPACT', 'PCT', 'OVERRIDE'].join('_');

type Kind = 'assignment' | 'comment' | 'other';

interface Occurrence {
  /** Repository-relative, so a failure message is copy-pasteable. */
  readonly file: string;
  /** 1-indexed. Reported, never asserted — see the header. */
  readonly line: number;
  readonly text: string;
  readonly kind: Kind;
}

/**
 * The part of a line that is code, with any comment removed.
 *
 * Returns the empty string for a wholly comment-sited line. The block-comment
 * test is a leading-character rule rather than a parser: every block comment in
 * this tree opens with `/*` and continues with `*`, and a scanner that tried to
 * track comment state across lines would have to lex template literals and
 * regular expressions to know whether it was inside one. A leading-character
 * rule is wrong only for a style nothing here uses, and it is wrong in the safe
 * direction — it declines to call something code.
 */
function codePortion(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
  const tail = text.indexOf('//');
  return tail === -1 ? text : text.slice(0, tail);
}

function classify(text: string): Kind {
  const code = codePortion(text);
  if (!code.includes(ENV_NAME)) return 'comment';
  // `\b` on both sides: a longer identifier that merely contains this name is a
  // different symbol, and calling it an injection site would be a false report.
  return new RegExp(`\\b${ENV_NAME}\\b\\s*[:=]`).test(code) ? 'assignment' : 'other';
}

const OCCURRENCES: readonly Occurrence[] = linesMatching(SCAN_ROOT, ENV_NAME, {
  fixed: true,
  extensions: ['.ts']
}).map((match) => ({
  file: match.file.slice(REPO_ROOT.length + 1),
  line: match.line,
  text: match.text,
  kind: classify(match.text)
}));

const ofKind = (kind: Kind): readonly Occurrence[] => OCCURRENCES.filter((o) => o.kind === kind);

/** `file:line — text`, the form a reader can act on without re-deriving anything. */
const describeOccurrence = (o: Occurrence): string => `${o.file}:${o.line} — ${o.text.trim()}`;

/**
 * The closed set FR-009 declares, and the requirement that governs each member.
 *
 * FR-006 binds the phase-invocation site: the operator setting decides whether
 * the key appears there at all. FR-009 exempts the host-internal maintenance
 * invocation, which sets the key without reading the setting because compacting
 * on demand is the entire point of that call — an operator threshold would
 * defeat it.
 */
const GOVERNED: readonly { readonly file: string; readonly requirement: string }[] = [
  { file: 'src/controller/phase-runner.ts', requirement: 'FR-006' },
  { file: 'src/controller/session-compactor.ts', requirement: 'FR-009' }
];

/**
 * Comment lines within a bounded look-back are searched for the requirement id.
 *
 * Twenty because the phase site's FR-006 block sits twelve lines above its
 * assignment, separated by the accessor read and the opening of the env map.
 * Wide enough to reach a marker that governs the statement, narrow enough that
 * it cannot reach the previous function.
 */
const MARKER_LOOKBACK = 20;

function markerNear(file: string, line: number, requirement: string): boolean {
  const lines = readFileSync(resolve(REPO_ROOT, file), 'utf8').split('\n');
  const from = Math.max(0, line - MARKER_LOOKBACK);
  return lines
    .slice(from, line)
    .some((text) => codePortion(text) === '' && text.includes(requirement));
}

describe('the override injection sites are a closed set of two (012, FR-009, SC-011)', () => {
  it('scanned a tree rather than nothing', () => {
    // Without this the whole file passes vacuously the day the scan root moves:
    // zero assignments is not two, but zero comments and zero occurrences would
    // make every partition assertion below trivially satisfiable in the wrong
    // direction. Floors, not counts.
    expect(OCCURRENCES.length).toBeGreaterThan(2);
    expect(ofKind('comment').length).toBeGreaterThan(0);
  });

  it('finds exactly two assignment sites, one per governed file', () => {
    // SC-011. The size is the assertion; a third site, or the loss of one, is
    // what this exists to catch. Files rather than line numbers, per the header.
    const assignments = ofKind('assignment');
    expect(
      assignments.map(describeOccurrence).sort(),
      'FR-009 declares the injection sites a closed set. A new one must be added to GOVERNED here ' +
        'and to FR-009 in the spec, with the reason its value is fixed, or it must read the ' +
        'operator setting through the accessor like the phase site does.'
    ).toHaveLength(GOVERNED.length);
    expect(assignments.map((o) => o.file).sort()).toEqual(GOVERNED.map((g) => g.file).sort());
  });

  it('each assignment site names the requirement that governs it', () => {
    // FR-009's enumerability clause, second half: a member of the closed set
    // must be findable by searching the name AND must say why it is a member.
    const unmarked: string[] = [];
    for (const { file, requirement } of GOVERNED) {
      for (const site of ofKind('assignment').filter((o) => o.file === file)) {
        if (!markerNear(site.file, site.line, requirement)) {
          unmarked.push(`${describeOccurrence(site)}  (expected a comment naming ${requirement})`);
        }
      }
    }
    expect(
      unmarked,
      `An injection site with no requirement marker within ${MARKER_LOOKBACK} lines above it. Add a ` +
        'comment naming the requirement and the reason the value is what it is. Do not widen the ' +
        'window to make this pass.'
    ).toEqual([]);
  });

  it('excludes comment-only references from the assignment partition', () => {
    // The third kind of failure this gate is for: a total that counts prose.
    // These three files mention the variable and inject it nowhere.
    const commentSited = new Set(ofKind('comment').map((o) => o.file));
    const assigning = new Set(ofKind('assignment').map((o) => o.file));

    for (const file of [
      'src/contracts/audit-events.ts',
      'src/lib/auto-compact-override.ts'
    ]) {
      expect(commentSited.has(file), `${file} mentions the variable in prose`).toBe(true);
      expect(assigning.has(file), `${file} must not be counted as an injection site`).toBe(false);
    }
  });

  it('does not score the JSDoc that spells the variable with its value', () => {
    // The live control for rule 67, and the reason the search is on the name.
    // `phase-runner.ts` both assigns the variable and describes the assignment
    // in prose, so the file appears in two partitions and only one of its lines
    // is a site. A value search cannot tell those apart.
    const inRunner = OCCURRENCES.filter((o) => o.file === 'src/controller/phase-runner.ts');
    const prose = inRunner.filter((o) => o.kind === 'comment');

    expect(inRunner.filter((o) => o.kind === 'assignment')).toHaveLength(1);
    expect(prose.length).toBeGreaterThan(0);
    // The trap itself: a comment carrying the name followed directly by `=`.
    expect(prose.some((o) => new RegExp(`${ENV_NAME}=`).test(o.text))).toBe(true);
  });

  it('leaves no occurrence unaccounted for', () => {
    // Every hit lands in exactly one partition, so a shape nobody anticipated
    // shows up as `other` rather than disappearing.
    const partitioned = ofKind('assignment').length + ofKind('comment').length + ofKind('other').length;
    expect(partitioned).toBe(OCCURRENCES.length);
    expect(
      ofKind('other').map(describeOccurrence),
      'A code occurrence that is neither an assignment nor a comment — a read, a delete, a lookup. ' +
        'Decide which it is and say so here; it is not covered by FR-009 as written.'
    ).toEqual([]);
  });
});

describe('negative control — the classifier can tell the three kinds apart', () => {
  // Fixtures, so the controls cannot be deleted out from under the rule by an
  // ordinary edit to the tree. A gate whose liveness depends on the shape of
  // today's source stops being able to fail quietly.
  it('reads both assignment shapes as assignments', () => {
    expect(classify(`      env.${ENV_NAME} = String(autoCompactPct);`)).toBe('assignment');
    expect(classify(`      env: { ${ENV_NAME}: '1' },`)).toBe('assignment');
  });

  it('reads a comment carrying the name and a value as a comment', () => {
    expect(classify(`   * forces auto-compaction (${ENV_NAME}=1) on`)).toBe('comment');
    expect(classify(`// is set and \`${ENV_NAME}\` has been merged into the`)).toBe('comment');
    expect(classify(`      doThing(); // ${ENV_NAME} = '1'`)).toBe('comment');
  });

  it('reads a code occurrence that assigns nothing as neither', () => {
    expect(classify(`      delete env.${ENV_NAME};`)).toBe('other');
    expect(classify(`      if (${ENV_NAME} in env) {`)).toBe('other');
  });

  it('does not match a longer identifier that contains the name', () => {
    expect(classify(`      env.${ENV_NAME}_LEGACY = '1';`)).toBe('other');
  });

  it('finds no marker when the look-back holds none', () => {
    // The marker rule proven able to fail, against this file: nothing in the
    // twenty lines above line 1 names FR-006, because there are none.
    expect(markerNear('src/controller/phase-runner.ts', 1, 'FR-006')).toBe(false);
  });
});
