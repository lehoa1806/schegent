/**
 * The absent-field census, as a callable method rather than a dated document.
 *
 * FR-R3-167. A one-time sweep classified every `not.toHaveProperty` / `toBeUndefined` /
 * `toBeNull` assertion in the suite against the payload contracts, wrote the answer into a
 * document, and the document began decaying the moment the next test landed. This module is
 * that sweep's method, executable. `absent-field-census.test.ts` is the gate that runs it.
 *
 * It is deliberately NOT a `.test.ts`: `suite-invoked-once.test.ts` and the three meta-gates
 * that enumerate `tests/lint/**` as governance gates would both count it and re-register its
 * suite. Helpers live outside the glob.
 *
 * Nothing here is enumerated. The test corpus is walked, the contract corpus is discovered by
 * basename, and the field declarations are located inside whatever the discovery found. The
 * only hard-coded things are the *rule* — five assertion patterns and four basename globs —
 * which is the method the retired document published and which FR-022 requires the gate to
 * carry verbatim.
 *
 * Nothing here spawns a binary. `lint-gates-are-hermetic.test.ts` forbids it, and the five
 * `grep` commands the gate's header carries are documentation for a human to run by hand.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';

import { ENVELOPE_ROOT, envelopePresent } from './envelope-presence';
import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Separator normalisation, applied only where `\` really is the separator.
 *
 * On POSIX a backslash is an ordinary character in a filename, so rewriting it would turn filename
 * bytes into path separators: `tests/unit/..\..\x.test.ts` would become a relative path with `..`
 * segments in it, able to escape the root it was made relative to and to impersonate a path on the
 * exclusion list. Every read in this module goes through the absolute path `filesUnder` returned
 * and never through a rewritten one, so this is the second of two locks on the same door.
 */
const toPosix = (value: string): string => (sep === '\\' ? value.split('\\').join('/') : value);

/** A field name reaches `new RegExp` from the scanned corpus. Escaped at the sink, not at the source. */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- scope

/** What the gate could reach. Resolved once, before anything is read, reported on every run. */
export interface CorpusScope {
  /** Always present: the execution repository's own documentation. */
  readonly repoDocsRoot: string;
  /** The planning envelope's specification tree, when the envelope is above `repo/`. */
  readonly envelopeSpecsRoot: string | null;
  /** Why the envelope is absent, when it is. Reported, never swallowed. */
  readonly envelopeAbsentReason: string | null;
  /** Always present. */
  readonly testsRoot: string;
  /**
   * The webview package's own suite, when the repository carries one. It is a second population
   * root rather than an omission: the discovered corpus includes `sidebar-ipc*.md`, which governs
   * exactly the host/webview boundary that suite tests, so a census that read `tests/` alone would
   * make a claim about a contract while unable to see half the code the contract binds.
   */
  readonly webviewTestsRoot: string | null;
  /** The execution repository's root, for making discovered paths relative. */
  readonly repoRoot: string;
}

/** Every root the population is drawn from, in report order. */
export function populationRoots(scope: CorpusScope): readonly string[] {
  return scope.webviewTestsRoot === null ? [scope.testsRoot] : [scope.testsRoot, scope.webviewTestsRoot];
}

/**
 * Reuses `envelopePresent()` rather than re-deriving the predicate. A fourth shape for the same
 * question is how the existing envelope readers drift apart, which is FR-R3-118's finding.
 */
export function resolveScope(repoRoot: string = REPO_ROOT, envelopeRoot: string = ENVELOPE_ROOT): CorpusScope {
  const present = envelopePresent(envelopeRoot);
  const webviewTestsRoot = resolve(repoRoot, 'webview-ui', 'src');
  return {
    repoDocsRoot: resolve(repoRoot, 'docs'),
    envelopeSpecsRoot: present ? resolve(envelopeRoot, 'specs') : null,
    envelopeAbsentReason: present
      ? null
      : 'no planning envelope above the execution repository (no ARCHITECTURE.md, CLAUDE.md and docs/ ' +
        'at the parent) — a standalone clone reaches the published reference only',
    testsRoot: resolve(repoRoot, 'tests'),
    webviewTestsRoot: existsSync(webviewTestsRoot) ? webviewTestsRoot : null,
    repoRoot,
  };
}

// ---------------------------------------------------------------- comments

/**
 * A `/` after one of these opens a regex literal even though the character before it is a word
 * character. `return /don't/.test(s)` is the shape that matters: without this the `/` reads as
 * division, the apostrophe inside opens a phantom string, and every subsequent `//` in the file is
 * read inside-out — which quietly deletes assertions from the population rather than reporting
 * them. Every entry is a keyword that cannot end an expression.
 */
const KEYWORD_BEFORE_REGEX: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'case',
  'instanceof',
  'delete',
  'void',
  'yield',
  'await',
  'throw',
  'do',
  'else',
]);

/** Every string scanner here returns the index just past the close, or -1 when it never closes. */
const UNTERMINATED = -1;

/**
 * Characters the re-enterable sub-scanners may examine, per character of source, across one file.
 *
 * The main blanking loop advances monotonically and needs no budget: each of its own steps consumes
 * the character it looked at. The three sub-scanners are different. When one of them fails to find
 * its close it reports so and the main loop steps over the single opening character and carries on,
 * which is the right recovery — but it throws away the scan. A file of `` `${ ``, or of `='`, or of
 * `=[/`, is then Θ(n) failing openers each costing a Θ(n) scan, and the whole blank is quadratic:
 * measured at 24 KiB / 347 ms, 94 KiB / 8.7 s, 375 KiB / 136 s. The largest file already in the
 * corpus is 124 KB.
 *
 * This is the same class of hazard as the recursion the frame stack below replaced, and it is worse
 * for the same reason: `runCensus()` runs at module scope, where vitest's `testTimeout` cannot reach
 * it, so the gate reports nothing at all rather than reporting the file that caused it. A budget
 * converts the hang into a verdict. The file that exhausts it is reported as unscannable, by name,
 * and the gate fails on the count — legible, and nothing is silently dropped.
 *
 * Eight is measured, not chosen for its looks. Set to **one** — a single character of allowance per
 * character of source — all 1134 files of the corpus still scan in full, with every reported count
 * unchanged, because a sub-scan that succeeds consumes exactly the characters it crossed and the
 * main loop then resumes past them. So eight is eight times the worst the tree actually asks for,
 * and it still caps the pathological case at tens of milliseconds: the 375 KiB payload that took
 * 136 seconds takes 35. The floor keeps the accounting's own off-by-ones away from very short inputs.
 *
 * A high-water-mark skip would be cheaper and is wrong: `` `${ `` followed by `` `a` `` gives
 * `templateEnd(0) === UNTERMINATED` while `templateEnd(3)` legitimately closes, so a later start
 * cannot inherit an earlier start's failure.
 */
const SCAN_BUDGET_PER_CHARACTER = 8;
const SCAN_BUDGET_FLOOR = 1024;

/** Mutable, one per blanking pass: every sub-scan of that one file draws on the same allowance. */
interface ScanBudget {
  remaining: number;
}

const outOfBudget = (budget: ScanBudget): boolean => budget.remaining <= 0;

/**
 * A `'`- or `"`-quoted string ends at its matching quote, and cannot cross a line.
 *
 * Bounding it at the newline is what keeps one stray apostrophe in prose from inverting the
 * scanner's notion of "inside a string" for the rest of the file.
 */
function quotedEnd(source: string, start: number, n: number, budget: ScanBudget): number {
  const quote = source[start] ?? '';
  let k = start + 1;
  while (k < n && source[k] !== quote) {
    budget.remaining -= 1;
    if (outOfBudget(budget)) return UNTERMINATED;
    if (source[k] === '\\') {
      k += 2;
      continue;
    }
    if (source[k] === '\n') return UNTERMINATED;
    k += 1;
  }
  return k < n ? k + 1 : UNTERMINATED;
}

/**
 * A template literal ends at its matching backtick — but only counting backticks that belong to it.
 *
 * `${...}` holds arbitrary expression text, and a template nested inside one opens and closes with
 * backticks of its own. Scanning for the next unescaped backtick therefore stops at the *inner*
 * template's opening backtick, and everything from there to the real end is read as code: a `//`
 * inside it blanks a line of live source, and an assertion on that line leaves the population with
 * nothing reported. `save-general-settings-doc-parity.test.ts` carries exactly this shape. Tracking
 * the interpolation is what keeps the scanner and the source in step.
 *
 * The frame stack is an array on purpose, and this is the second time this one construct has been
 * got wrong in the same direction. The first cut of it was a `templateEnd`/`interpolationEnd` pair
 * that called each other, which reads more clearly and put the nesting depth on the *call* stack —
 * a fixed ceiling this code does not choose and cannot see. One corpus file nesting templates
 * deeply enough then threw `RangeError: Maximum call stack size exceeded`, and because `runCensus`
 * runs at module scope (see the note on the census test's own top-level call) vitest's `testTimeout`
 * does not bound it: the whole gate reports nothing, rather than reporting a finding about the file
 * that did it. A scanner must not be takeable down by the corpus it scans — that is the same
 * property the `EXPECT_MESSAGE` bound, the `stripTrailingBlockClose` rewrite and the scan budget
 * above exist for. On the heap the depth is bounded by memory instead: O(input), though with a
 * constant worth naming rather than waving at — a frame per two source characters at worst, which
 * measured at about 110 bytes per character of source, so a 2 MB file peaks near 110 MiB. That is
 * fifty-odd times the cost of holding the source, not equal to it. It is still a number this
 * process has, where the call stack's ceiling was one it did not choose and could not see.
 *
 * Equivalent to the recursive pair rather than merely similar, and the one asymmetry is worth
 * stating because it is what makes the flattening safe. A nested `templateEnd` returned
 * `UNTERMINATED` only on reaching the end of input, and an enclosing template propagated that
 * outward — so once any frame ran out of input, the outermost answer was `UNTERMINATED` however
 * the intermediate frames unwound. Returning it directly from the scan loop is the same answer for
 * less work. (An enclosing *interpolation* instead stepped over the quote and carried on, which
 * looks like a divergence and is not: a nested template only reports `UNTERMINATED` after scanning
 * to the end without finding a backtick, so no backtick remains for the outer template to close on
 * either.) The `quotedEnd` case is the one real non-EOF `UNTERMINATED`, and it never recursed.
 *
 * The one construct an interpolation frame must read and a template body must not is a comment.
 * `${...}` holds expression text, and expression text may be commented; a template body may not, and
 * a `//` there is two ordinary characters. Skipping comments only inside the number frames is
 * therefore not a convenience, it is the language. Without it, a block comment inside `${...}`
 * containing a `}` closes the interpolation on that brace, and a backtick later in the same comment
 * closes the template — and the blanker walks out of step. On the fixture that shape produces, a
 * live `expect(...).not.toHaveProperty('…')` on the same line was blanked away entirely, its
 * assertion gone from the population with nothing said. The reconciliation gate cannot catch it: the
 * erased line still counts once against `linesByFamily` and once against `commentLines`, so
 * `lines === code + comment` holds while the population is short by one.
 *
 * A regex literal in an interpolation can desynchronise the same way (`` `${s.replace(/}/g, '')}` ``)
 * and is deliberately not handled. Telling a regex from a division needs the `regexCanFollow` state
 * the blanking loop keeps, and guessing wrong turns `` `${a / b}` `` into a scan to end of line —
 * trading a shape the corpus does not contain for one it does. The differential against the
 * TypeScript compiler's own comment ranges is what would catch either of them arriving.
 *
 * The comment spans found on the way out are collected rather than blanked, because this scan may
 * still fail: on `UNTERMINATED` the caller steps over the backtick and reads the same text as
 * ordinary code, and a blank left behind by the abandoned scan would erase code that is live under
 * the reading the caller actually kept. They are the caller's to apply, and only if it succeeds.
 * Reported at all because the compiler reports them: a commented-out assertion inside `${...}` is
 * commented out, and leaving it unblanked would put a phantom into the population.
 */
function templateEnd(
  source: string,
  start: number,
  n: number,
  budget: ScanBudget,
  comments: { from: number; to: number }[]
): number {
  // Innermost frame last. `null` is a template literal; a number is a `${...}` interpolation
  // carrying its count of braces still open, which is what the recursive form held in `depth`.
  const frames: (number | null)[] = [null];
  let k = start + 1;
  while (k < n) {
    budget.remaining -= 1;
    if (outOfBudget(budget)) return UNTERMINATED;
    const ch = source[k] ?? '';
    if (ch === '\\') {
      k += 2;
      continue;
    }
    const frame = frames[frames.length - 1];
    if (frame === null) {
      if (ch === '`') {
        frames.pop();
        if (frames.length === 0) return k + 1;
        k += 1;
        continue;
      }
      if (ch === '$' && source[k + 1] === '{') {
        frames.push(1);
        k += 2;
        continue;
      }
      k += 1;
      continue;
    }
    if (ch === '`') {
      frames.push(null);
      k += 1;
      continue;
    }
    // Comment spans are charged whole rather than per character: each is found by a single forward
    // scan paid for immediately afterwards, so the total stays inside the budget to within one span
    // and the hot loop keeps one branch per character rather than two.
    if (ch === '/' && source[k + 1] === '/') {
      let end = k + 2;
      while (end < n && source[end] !== '\n') end += 1;
      budget.remaining -= end - k;
      if (outOfBudget(budget)) return UNTERMINATED;
      comments.push({ from: k, to: end });
      k = end;
      continue;
    }
    if (ch === '/' && source[k + 1] === '*') {
      let end = k + 2;
      while (end < n && !(source[end] === '*' && source[end + 1] === '/')) end += 1;
      budget.remaining -= end - k;
      if (outOfBudget(budget)) return UNTERMINATED;
      // An unclosed block comment runs to the end of input, and so then does the template holding it.
      const close = Math.min(end + 2, n);
      comments.push({ from: k, to: close });
      k = close;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const after = quotedEnd(source, k, n, budget);
      if (outOfBudget(budget)) return UNTERMINATED;
      // An unterminated string inside the interpolation is not a string; step over the quote alone
      // rather than letting it swallow the enclosing template.
      k = after === UNTERMINATED ? k + 1 : after;
      continue;
    }
    if (ch === '{') frames[frames.length - 1] = frame + 1;
    else if (ch === '}') {
      if (frame === 1) frames.pop();
      else frames[frames.length - 1] = frame - 1;
    }
    k += 1;
  }
  return UNTERMINATED;
}

/** A blanking pass that either finished or ran out of budget, and says which. */
export interface BlankedSource {
  /** Comment spans replaced by spaces. Trustworthy only when `unscannable` is null. */
  readonly text: string;
  /** null when the whole file was scanned; otherwise why the pass was abandoned. Carries no
   *  corpus text — only counts — because it is echoed into a failure message that reaches CI. */
  readonly unscannable: string | null;
}

/**
 * Replaces every comment span with spaces, preserving length and line geometry so a match's line
 * number in the blanked text is its line number in the source.
 *
 * Structural rather than a line-prefix heuristic (research.md D4): the occurrence that made the
 * source filing's own count wrong by one sits on a `*` continuation line inside a doc block, which
 * no prefix test catches without also eating multiplication.
 *
 * Returns the verdict rather than the text, because a partial blank is worse than none: the caller
 * must decide what to do about a file it could not read, and cannot decide that from a string. The
 * two callers in this module both stop and report the file. `blankComments` is the convenience over
 * it for inputs known to be small, and throws rather than hand back a half-scanned string.
 */
export function blankCommentsBounded(source: string): BlankedSource {
  // A char array, not a rope or a slice-and-splice: the blanker must replace comment bodies in place
  // while leaving every other byte at the offset it already had, because `scanSource` maps a match
  // offset in this output straight back to a line number in the original. The array is per-file and
  // transient — the largest file in the corpus is a couple of hundred kilobytes — so the allocation is
  // bounded by one file, never by the tree.
  const out = source.split('');
  const n = source.length;
  const limit = Math.max(SCAN_BUDGET_FLOOR, SCAN_BUDGET_PER_CHARACTER * n);
  const budget: ScanBudget = { remaining: limit };
  const abandoned = (): BlankedSource => ({
    text: out.join(''),
    unscannable: `scan budget exhausted: ${limit} sub-scan character examinations over ${n} characters of source`,
  });
  let i = 0;
  let lastSignificant = '';
  // The word ending at the cursor, surviving intervening whitespace so `return /…/` is recognised.
  let lastWord = '';
  // Whitespace has been seen since that word, so the next word character starts a new one rather
  // than extending it. Surviving whitespace without ending the word would splice `b` and `return`.
  let wordBroken = false;
  // `obj.return` is a property name, not the keyword, so a word reached through a dot never counts.
  let wordAfterDot = false;

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  // Reused across template scans rather than allocated per backtick: on a file of templates that is
  // one allocation instead of thousands, and the buffer is dead the moment its scan returns.
  const insideTemplate: { from: number; to: number }[] = [];

  // A `/` opens a regex literal, rather than dividing, when the last significant character cannot
  // end an expression. Without this, `/\/\//` reads as a comment and blanks the code after it.
  const regexCanFollow = (): boolean =>
    lastSignificant === '' ||
    '(,=:[!&|?{};+-*%~^<>'.includes(lastSignificant) ||
    (!wordAfterDot && KEYWORD_BEFORE_REGEX.has(lastWord));

  // This loop needs no budget of its own: every branch below either advances `i` past the characters
  // it looked at or defers to a sub-scan that carries one, so its own work is one pass over `source`.
  while (i < n) {
    const ch = source[i] ?? '';
    const next = source[i + 1] ?? '';

    if (ch === '/' && next === '/') {
      let end = i;
      while (end < n && source[end] !== '\n') end += 1;
      blank(i, end);
      i = end;
      continue;
    }

    if (ch === '/' && next === '*') {
      let end = i + 2;
      while (end < n && !(source[end] === '*' && source[end + 1] === '/')) end += 1;
      end = Math.min(end + 2, n);
      blank(i, end);
      i = end;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      // Unterminated is not a string at all: step over the quote and carry on rather than swallowing
      // the rest of the file.
      let after: number;
      if (ch === '`') {
        insideTemplate.length = 0;
        after = templateEnd(source, i, n, budget, insideTemplate);
        // Only on success. A failed scan's spans belong to a template that turned out not to be one,
        // and the caller is about to read that same text as ordinary code.
        if (after !== UNTERMINATED) {
          for (const span of insideTemplate) blank(span.from, span.to);
        }
      } else {
        after = quotedEnd(source, i, n, budget);
      }
      if (outOfBudget(budget)) return abandoned();
      i = after === UNTERMINATED ? i + 1 : after;
      lastSignificant = ch;
      lastWord = '';
      wordBroken = false;
      wordAfterDot = false;
      continue;
    }

    if (ch === '/' && regexCanFollow()) {
      let end = i + 1;
      let closed = false;
      // A `/` inside a character class is an ordinary character, not the terminator. Without the
      // flag, `/['"`](?:src|tests)\/[\w.-]+['"`]/` closes at the escaped-looking `/` in the class,
      // the backtick after it opens a phantom template, and every comment to the end of the file
      // goes unblanked — or, where the phantom closes, real code is blanked and the assertions in it
      // leave the population unreported. `lint-anchor-grounding.test.ts` carries this exact shape.
      let inClass = false;
      while (end < n && source[end] !== '\n') {
        budget.remaining -= 1;
        if (outOfBudget(budget)) return abandoned();
        if (source[end] === '\\') {
          end += 2;
          continue;
        }
        if (source[end] === '[') inClass = true;
        else if (source[end] === ']') inClass = false;
        else if (!inClass && source[end] === '/') {
          closed = true;
          break;
        }
        end += 1;
      }
      if (closed) {
        i = end + 1;
        lastSignificant = '/';
        lastWord = '';
        wordBroken = false;
        wordAfterDot = false;
        continue;
      }
    }

    if (/[\w$]/.test(ch)) {
      // Whitespace does not clear `lastWord` — `return\n  /re/` must still see `return` — but it does
      // end the word. Without the break flag the two sides of `const a = b` + newline + `return /re/`
      // concatenate into `breturn`, which is in no keyword set, so the regex-literal guard never
      // fires and the rest of that line is blanked as a comment: an assertion on it disappears from
      // the population entirely rather than being reported unresolvable.
      if (wordBroken) {
        lastWord = '';
        wordBroken = false;
      }
      if (lastWord === '') wordAfterDot = lastSignificant === '.';
      lastWord += ch;
    } else if (/\s/.test(ch)) {
      if (lastWord !== '') wordBroken = true;
    } else {
      lastWord = '';
      wordBroken = false;
      wordAfterDot = false;
    }
    if (!/\s/.test(ch)) lastSignificant = ch;
    i += 1;
  }

  return { text: out.join(''), unscannable: null };
}

/**
 * The blanked text, for inputs whose size is known — unit fixtures, and nothing the corpus supplies.
 * Throws on budget exhaustion rather than returning a half-scanned string, because there is no
 * correct thing to do with one and a silent partial blank is the failure this whole module is
 * written against.
 */
export function blankComments(source: string): string {
  const { text, unscannable } = blankCommentsBounded(source);
  if (unscannable !== null) throw new Error(`blankComments: ${unscannable}`);
  return text;
}

/** Each line split into the part that is code and the part that is comment. */
interface LineSplit {
  readonly code: string;
  readonly comment: string;
}

/**
 * Keyed on the array `runCensus` caches per file, so the F blanking passes a file with F findings
 * used to cost become one. `findDecisionNote` is called once per finding and blanks the whole file
 * each time; on a 52 KiB file with 100 findings that multiplied a bounded cost by a hundred. The
 * function is pure and the arrays are never mutated, so the memo changes nothing but the count.
 */
const splitsByLines = new WeakMap<readonly string[], readonly LineSplit[]>();

function splitCommentsByLine(lines: readonly string[]): readonly LineSplit[] {
  const memo = splitsByLines.get(lines);
  if (memo !== undefined) return memo;

  // A file the budget could not finish is read as all code and no comment — not the reverse. Calling
  // it all comment would let any dated line in it stand in for a decision note; calling it all code
  // finds no note anywhere, so a finding on such a file is reported un-noted and someone looks.
  const { text, unscannable } = blankCommentsBounded(lines.join('\n'));
  const blanked = unscannable === null ? text.split('\n') : lines;
  const splits = lines.map((line, index) => {
    const code = blanked[index] ?? '';
    let comment = '';
    for (let k = 0; k < line.length; k += 1) {
      if ((code[k] ?? ' ') === ' ' && line[k] !== ' ') comment += line[k];
      else if (comment !== '') comment += ' ';
    }
    return { code, comment: comment.trim() };
  });
  splitsByLines.set(lines, splits);
  return splits;
}

// ---------------------------------------------------------------- assertions

export type PatternFamily = 'A' | 'B1' | 'B2' | 'B3' | 'B4';

export const PATTERN_FAMILIES: readonly PatternFamily[] = ['A', 'B1', 'B2', 'B3', 'B4'];

/**
 * The optional second argument of `expect(value, message)`. Bounded, and closed over a class that
 * excludes both parens, so the enclosing `)` of the `expect(` call is always the fence: the group
 * can never reach across a call boundary and pair a property access with a distant matcher. Without
 * it, `expect(row.phaseId, 'row 3').toBeNull()` matches nothing at all and leaves the population
 * silently — not as an unclassifiable row, but with no trace.
 *
 * The residue is a message containing a parenthesis. That assertion is still invisible, and the
 * gate says so in its limitations rather than implying a reach it does not have.
 */
const EXPECT_MESSAGE = '(?:,[^()]{0,200})?';

/**
 * The five patterns, as the retired census defined them. `A` is the primary pattern the source
 * filing counts; the other four are the value-shaped forms. These are the machine-readable twins
 * of the five `grep` commands the gate's header carries for a human (FR-022) — twins, not clones,
 * and the two documented ways they differ are both widenings:
 *
 *   - whitespace, including a newline, is tolerated at every join, because prettier wraps a long
 *     assertion across lines the moment it crosses the print width and a line-oriented `grep` then
 *     stops seeing it. A census whose answer changes when a file is reformatted is the decay this
 *     feature exists to end;
 *   - the two-argument `expect(value, message)` form is read.
 *
 * The coverage block reports both counts, so what `grep -n` can see stays visible next to what the
 * gate saw beyond it.
 */
const FAMILY_PATTERNS: Readonly<Record<PatternFamily, RegExp>> = {
  A: /not\s*\.\s*toHaveProperty\(\s*([^)]*)/g,
  B1: new RegExp(`\\.([A-Za-z_$][\\w$]*)\\s*${EXPECT_MESSAGE}\\)\\s*\\.\\s*toBeUndefined\\(\\s*\\)`, 'g'),
  B2: new RegExp(`\\.([A-Za-z_$][\\w$]*)\\s*${EXPECT_MESSAGE}\\)\\s*\\.\\s*toBe\\(\\s*undefined\\s*\\)`, 'g'),
  B3: new RegExp(`\\.([A-Za-z_$][\\w$]*)\\s*${EXPECT_MESSAGE}\\)\\s*\\.\\s*toBeNull\\(\\s*\\)`, 'g'),
  B4: new RegExp(`\\.([A-Za-z_$][\\w$]*)\\s*${EXPECT_MESSAGE}\\)\\s*\\.\\s*toBe\\(\\s*null\\s*\\)`, 'g'),
};

/**
 * The first argument, when it is one complete quoted string. The capture stops at the closing
 * paren, so that string is either the whole argument or the first of two.
 */
const FIRST_ARGUMENT = /^(['"`])((?:[^\\]|\\.)*?)\1\s*(?:,|$)/;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Why an assertion has no literal field name. Two different unresolvables were reported as one, and
 * the published description of the merged bucket then misdescribed part of its own membership.
 */
export type NameShape = 'literal' | 'non-identifier-literal' | 'dynamic-key';

/** One discovered member of the population. The unit of the census and of every count. */
export interface AbsentFieldAssertion {
  /** Repo-relative, POSIX separators. */
  readonly file: string;
  /** 1-indexed, matching `grep -n`. */
  readonly line: number;
  readonly family: PatternFamily;
  /** The literal property name, or null when the name is not a literal identifier. */
  readonly fieldName: string | null;
  /** Why `fieldName` is null, when it is. */
  readonly nameShape: NameShape;
  /**
   * True when the assertion crosses a newline. Not the same as invisible to a line-oriented search,
   * and the two were conflated: family A's pattern stops at the opening paren, so a wrapped
   * `not.toHaveProperty(` still matches its own first line and `grep` still prints it. Only the B
   * families start at the property access, which a wrap moves onto a line of its own.
   */
  readonly spansLines: boolean;
  /** The assertion's source text, for the failure message. */
  readonly text: string;
}

/**
 * One file's contribution to the population, with the line counters FR-015 needs to explain why
 * discovered lines and discovered assertions are not the same number.
 */
export interface FileScan {
  readonly file: string;
  readonly assertions: readonly AbsentFieldAssertion[];
  /** Lines with at least one single-line occurrence, counting comments — what `grep -n` reports. */
  readonly linesByFamily: Readonly<Record<PatternFamily, number>>;
  /** Lines with at least one single-line occurrence outside a comment. */
  readonly codeLinesByFamily: Readonly<Record<PatternFamily, number>>;
  /** Lines whose every single-line occurrence was inside a comment. */
  readonly commentLinesByFamily: Readonly<Record<PatternFamily, number>>;
  /** Assertions that cross a newline. A wrap, not a claim about what a search can see. */
  readonly spanningByFamily: Readonly<Record<PatternFamily, number>>;
  /**
   * Assertions whose family pattern matches nothing on the raw line they start on: the ones a
   * line-oriented search genuinely cannot print. Measured per assertion rather than inferred from
   * `spanningByFamily`, which over-states it, or from `assertions - codeLines`, which folds in
   * every line that carries two assertions of one family.
   */
  readonly invisibleByFamily: Readonly<Record<PatternFamily, number>>;
  /**
   * null when the file was read in full. Otherwise the file defeated the scan budget and every
   * counter above is zero: it contributes nothing to the population and is reported by name, rather
   * than contributing numbers derived from a blank the scanner knows it did not finish.
   */
  readonly unscannable: string | null;
}

const zeroed = (): Record<PatternFamily, number> => ({ A: 0, B1: 0, B2: 0, B3: 0, B4: 0 });

function matchesIn(text: string, family: PatternFamily): RegExpExecArray[] {
  const pattern = new RegExp(FAMILY_PATTERNS[family].source, 'g');
  const found: RegExpExecArray[] = [];
  let match = pattern.exec(text);
  while (match !== null) {
    found.push(match);
    match = pattern.exec(text);
  }
  return found;
}

function fieldNameOf(family: PatternFamily, match: RegExpExecArray): { fieldName: string | null; shape: NameShape } {
  // `.at(n) ?? fallback` throughout this module, never `match[n] ?? fallback`. The lint program
  // types a capture group as `string` and calls the guard unnecessary; the tests program indexes
  // defensively. `.at()` returns `T | undefined` by signature, so the guard is necessary by type
  // rather than defensive against it, and both readings are satisfied honestly. The reasoning is
  // the same one recorded in `tests/lint/blueprint-configuration-parity.test.ts`.
  const captured = (match.at(1) ?? '').trim();
  if (family !== 'A') return { fieldName: captured, shape: 'literal' };

  const literal = FIRST_ARGUMENT.exec(captured);
  const quote = literal?.at(1);
  const body = literal?.at(2);
  // An interpolated template is a computed name that merely looks quoted, so it is read as dynamic.
  if (literal === null || quote === undefined || body === undefined || (quote === '`' && body.includes('${'))) {
    return { fieldName: null, shape: 'dynamic-key' };
  }
  if (IDENTIFIER.test(body)) return { fieldName: body, shape: 'literal' };
  // Written out in full but not a JS identifier — `'9bad'`, `'has-dash'`. Nothing dynamic about it;
  // it simply cannot be looked up as a declared field name.
  return { fieldName: null, shape: 'non-identifier-literal' };
}

/** Byte offset -> 1-indexed line, by scan over the line-start table. */
function lineIndexer(source: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let k = 0; k < source.length; k += 1) {
    if (source[k] === '\n') starts.push(k + 1);
  }
  return (offset: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((starts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

/** Whitespace collapsed onto one line, so a wrapped assertion reads as one thing in the report. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function scanSource(file: string, source: string): FileScan {
  const rawLines = source.split('\n');
  const blank = blankCommentsBounded(source);
  if (blank.unscannable !== null) {
    return {
      file,
      assertions: [],
      linesByFamily: zeroed(),
      codeLinesByFamily: zeroed(),
      commentLinesByFamily: zeroed(),
      spanningByFamily: zeroed(),
      invisibleByFamily: zeroed(),
      unscannable: blank.unscannable,
    };
  }
  const codeLines = blank.text.split('\n');
  const blanked = blank.text;

  const assertions: AbsentFieldAssertion[] = [];
  const linesByFamily = zeroed();
  const codeLinesByFamily = zeroed();
  const commentLinesByFamily = zeroed();
  const spanningByFamily = zeroed();
  const invisibleByFamily = zeroed();

  // Pass one: the grep-comparable counters. One line at a time, which is exactly and only what the
  // five published `grep` commands can see. These are reported, never used to build the population.
  rawLines.forEach((raw, index) => {
    const code = codeLines[index] ?? '';
    for (const family of PATTERN_FAMILIES) {
      if (matchesIn(raw, family).length === 0) continue;
      linesByFamily[family] += 1;
      if (matchesIn(code, family).length === 0) commentLinesByFamily[family] += 1;
      else codeLinesByFamily[family] += 1;
    }
  });

  // Pass two: the population, over the whole comment-blanked source. This is where an assertion
  // prettier wrapped across a newline is read, which is the whole reason the two numbers are
  // reported separately instead of one standing in for the other.
  //
  // Whether pass one could also see it is asked here rather than assumed from the wrap. A family A
  // match begins at `not.toHaveProperty(` and its capture may close empty, so the opening line
  // matches on its own and `grep` prints it; a B-family match begins at the property access, which
  // a wrap puts on a line that matches nothing. Reading `spansLines` as "invisible" over-stated the
  // gate's reach by three of thirteen on the tree this was written against.
  const lineAt = lineIndexer(source);
  for (const family of PATTERN_FAMILIES) {
    for (const hit of matchesIn(blanked, family)) {
      const matched = hit[0];
      const spansLines = matched.includes('\n');
      if (spansLines) spanningByFamily[family] += 1;
      const line = lineAt(hit.index);
      if (matchesIn(rawLines[line - 1] ?? '', family).length === 0) invisibleByFamily[family] += 1;
      const { fieldName, shape } = fieldNameOf(family, hit);
      assertions.push({
        file,
        line,
        family,
        fieldName,
        nameShape: shape,
        spansLines,
        text: spansLines ? oneLine(source.slice(hit.index, hit.index + matched.length)) : (rawLines[line - 1] ?? '').trim(),
      });
    }
  }

  assertions.sort((a, b) => (a.line === b.line ? a.family.localeCompare(b.family) : a.line - b.line));
  return {
    file,
    assertions,
    linesByFamily,
    codeLinesByFamily,
    commentLinesByFamily,
    spanningByFamily,
    invisibleByFamily,
    unscannable: null,
  };
}

/**
 * The gate's own two modules are excluded from the population by path, and the exclusion is
 * asserted rather than assumed (FR-016): the gate's text carries all five patterns verbatim, and
 * the negative control plants findings on purpose.
 */
export const EXCLUDED_FROM_POPULATION: readonly string[] = [
  'tests/lint/absent-field-census.ts',
  'tests/lint/absent-field-census.test.ts',
];

/** One traversal's result: the scans, plus where each display path was actually read from. */
export interface CorpusScan {
  readonly scans: readonly FileScan[];
  /** Display path -> the absolute path `filesUnder` returned. Never re-derive one from the other. */
  readonly absolutePaths: ReadonlyMap<string, string>;
}

export function scanTestCorpus(roots: readonly string[], repoRoot: string = REPO_ROOT): CorpusScan {
  const excluded = new Set(EXCLUDED_FROM_POPULATION);
  // Keyed by display path so a file reachable from two roots is scanned once, and read through the
  // absolute path `filesUnder` returned — never through the display path resolved back again, which
  // is what would let a `..` in a filename address a file outside the root that produced it.
  const absolutePaths = new Map<string, string>();
  for (const root of roots) {
    for (const absolute of filesUnder(root, { extensions: ['.ts'] })) {
      if (!absolute.endsWith('.test.ts')) continue;
      const display = toPosix(relative(repoRoot, absolute));
      if (excluded.has(display)) continue;
      if (!absolutePaths.has(display)) absolutePaths.set(display, absolute);
    }
  }
  const scans = [...absolutePaths.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([display, absolute]) => scanSource(display, readFileSync(absolute, 'utf8')));
  return { scans, absolutePaths };
}

// ---------------------------------------------------------------- contracts

/** A discovered payload-defining contract. */
export interface ContractDocument {
  /** Relative to the corpus root that found it, POSIX separators. */
  readonly path: string;
  readonly root: 'repo-docs' | 'envelope-specs';
  /** Every backtick-quoted identifier in the document. The census's step-2 corpus. */
  readonly quotedNames: ReadonlySet<string>;
  readonly lines: readonly string[];
}

/**
 * The census's four basename patterns, unwidened. FR-027 forbids growing this set here: a corpus
 * that grew would answer a different question every release, and no two runs of this gate would be
 * comparable with each other.
 */
const CONTRACT_BASENAMES: readonly RegExp[] = [
  /^audit-events.*\.md$/,
  /^sidebar-ipc.*\.md$/,
  /^state-schema.*\.md$/,
  /^audit-payload-delta.*\.md$/,
];

export function isContractBasename(name: string): boolean {
  return CONTRACT_BASENAMES.some((pattern) => pattern.test(name));
}

const QUOTED_IDENTIFIER = /`([A-Za-z_$][\w$]*)`/g;

export function readContract(path: string, root: ContractDocument['root'], source: string): ContractDocument {
  const quotedNames = new Set<string>();
  let match = QUOTED_IDENTIFIER.exec(source);
  while (match !== null) {
    const quoted = match.at(1);
    if (quoted !== undefined) quotedNames.add(quoted);
    match = QUOTED_IDENTIFIER.exec(source);
  }
  QUOTED_IDENTIFIER.lastIndex = 0;
  return { path: toPosix(path), root, quotedNames, lines: source.split('\n') };
}

export function discoverContracts(scope: CorpusScope): readonly ContractDocument[] {
  const found: ContractDocument[] = [];

  const collect = (searchRoot: string, relativeTo: string, root: ContractDocument['root']): void => {
    for (const absolute of filesUnder(searchRoot, { extensions: ['.md'] })) {
      if (!isContractBasename(basename(absolute))) continue;
      found.push(readContract(toPosix(relative(relativeTo, absolute)), root, readFileSync(absolute, 'utf8')));
    }
  };

  collect(scope.repoDocsRoot, scope.repoRoot, 'repo-docs');
  if (scope.envelopeSpecsRoot !== null) {
    collect(scope.envelopeSpecsRoot, resolve(scope.envelopeSpecsRoot, '..'), 'envelope-specs');
  }

  return found.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------- declarations

export type ConditionalityShape =
  | 'nullable-union' // `x: number | null`
  | 'optional-marker' // `x?: T`, or `optional` in a markdown Type cell
  | 'conditional-annotation'; // `// present iff …`

export type FieldDeclaration =
  | {
      readonly kind: 'found';
      readonly document: string;
      readonly line: number;
      readonly text: string;
      /** Empty when the contract declares the field unconditionally present. */
      readonly conditionality: readonly ConditionalityShape[];
    }
  | {
      readonly kind: 'not-located';
      readonly document: string;
      /** Why: the name appears only in prose, only in a heading, only in a link. */
      readonly reason: string;
    };

/**
 * How the discovered contracts actually write "this field is not always here".
 *
 * Derived from the corpus, not invented: the first entry is the form `data-model.md` illustrates,
 * and every other one is a phrasing a discovered document uses for a field some test asserts absent
 * — `stalled` ("Present if and only if:"), `evaluationError` ("Always `true` when present"),
 * `expression` ("Not persisted"), `missingKeys` ("Absent when no key was missing").
 *
 * A field declared conditional in English is declared conditional (FR-011). Reading only the one
 * literal form would have reported thirteen contradictions the contracts do not assert, and the
 * resolution for each would have been a note recording the scanner's blind spot — which is the
 * failure mode the filing names: never resolve a contradiction by editing the test when the test is
 * the accurate account.
 *
 * This is a phrase list, so it is a heuristic, and the gate says so in its limitations. It is kept
 * narrow deliberately: each entry is pinned by a unit test, and widening it is how this gate would
 * go quiet.
 */
const CONDITIONAL_ANNOTATIONS: readonly RegExp[] = [
  /present\s+iff\b/i,
  /present\s+if\s+and\s+only\s+if/i,
  /\b(when|if)\s+present\b/i,
  /\bpresent\s+(only\s+)?when\b/i,
  /\babsent\s+(when|if|means|unless)\b/i,
  /\b(not|never)\s+persisted\b/i,
  /\bomitted\b/i,
];

const isConditionallyAnnotated = (text: string): boolean =>
  CONDITIONAL_ANNOTATIONS.some((pattern) => pattern.test(text));

function splitTableRow(row: string): readonly string[] {
  return row
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, '|').trim())
    .slice(1, -1);
}

function conditionalityOfType(expression: string): ConditionalityShape[] {
  const shapes: ConditionalityShape[] = [];
  if (/\|\s*(null|undefined)\b/.test(expression) || /\b(null|undefined)\s*\|/.test(expression)) {
    shapes.push('nullable-union');
  }
  if (/\boptional\b/i.test(expression)) shapes.push('optional-marker');
  return shapes;
}

type LocatedDeclaration = Extract<FieldDeclaration, { kind: 'found' }>;

/**
 * Of the declarations one document makes for one name, the one the gate must answer for.
 *
 * First-match-wins was wrong in one direction, and silently. A document can declare a name twice —
 * a conditional table row and an unconditional fenced field, the same field in two payload sections
 * — and returning whichever came first meant a conditional declaration standing ahead of an
 * unconditional one moved the assertion out of `findings` and into `ordinary`: a bare count, no row
 * in the register, no note demanded, nothing for a reader to notice it had happened. Preferring the
 * unconditional declaration makes that case loud instead, which is the direction a gate is allowed
 * to be wrong in.
 *
 * Bucket-equivalent to carrying every declaration through to `classify`, because `classify` asks
 * only whether any located declaration is unconditional; measured against the tree at the time, both
 * produce the same 27 findings. What changes is which line the register quotes back.
 */
const preferUnconditional = (found: readonly LocatedDeclaration[]): LocatedDeclaration | null =>
  found.find((declaration) => declaration.conditionality.length === 0) ?? found.at(0) ?? null;

function locateInTable(document: ContractDocument, fieldName: string): LocatedDeclaration | null {
  const found: LocatedDeclaration[] = [];
  for (const [index, line] of document.lines.entries()) {
    // A removed diff line declares what the contract no longer says; an added one declares what it
    // now says, and is read with the `+` stripped. See `locateInFence` for why this matters.
    if (line.startsWith('-')) continue;
    const row = line.replace(/^\+/, '');
    if (!row.trimStart().startsWith('|')) continue;
    const cells = splitTableRow(row);
    if ((cells[0] ?? '') !== `\`${fieldName}\``) continue;

    const shapes = new Set(conditionalityOfType(cells[1] ?? ''));
    if (isConditionallyAnnotated(line)) shapes.add('conditional-annotation');
    found.push({
      kind: 'found',
      document: document.path,
      line: index + 1,
      text: line.trim(),
      conditionality: [...shapes],
    });
  }
  return preferUnconditional(found);
}

function locateInFence(document: ContractDocument, fieldName: string): LocatedDeclaration | null {
  // `escapeRegExp` because the field name is corpus data reaching a regex constructor, and `$` is a
  // legal first character of a JavaScript identifier: `$schema` would otherwise compile to an
  // end-anchor and locate nothing, silently downgrading a finding to unclassifiable.
  //
  // The optional leading `+` reads a unified-diff contract. Five of the thirteen discovered
  // documents are `*.diff.md`, where every added declaration carries a `+` in column one; without
  // this they are quoted-but-never-located, and four live field names sat in that hole. A `-` line
  // is the removed side and is deliberately not read: it declares what the contract no longer says.
  const declaration = new RegExp(`^[+]?\\s*(?:readonly\\s+)?${escapeRegExp(fieldName)}(\\??)\\s*:(.*)$`);
  const found: LocatedDeclaration[] = [];
  let inFence = false;

  for (const [index, line] of document.lines.entries()) {
    if (line.replace(/^[+-]/, '').trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    if (line.startsWith('-')) continue;

    const match = declaration.exec(line);
    if (match === null) continue;

    const shapes = new Set(conditionalityOfType(match.at(2) ?? ''));
    if (match.at(1) === '?') shapes.add('optional-marker');
    if (isConditionallyAnnotated(line) || isConditionallyAnnotated(document.lines[index - 1] ?? '')) {
      shapes.add('conditional-annotation');
    }
    found.push({
      kind: 'found',
      document: document.path,
      line: index + 1,
      text: line.trim(),
      conditionality: [...shapes],
    });
  }
  return preferUnconditional(found);
}

/**
 * A markdown table row — the published reference's form — or a fenced `name:` declaration. If
 * neither locates it, the candidate becomes unclassifiable (FR-013): never a finding, never a silent
 * pass.
 *
 * Both are read before either is chosen, and `preferUnconditional` decides between them, so a
 * conditional table row cannot suppress an unconditional fenced declaration of the same name in the
 * same document. Table order is kept only as the tie-break between two declarations that agree.
 */
export function locateDeclaration(document: ContractDocument, fieldName: string): FieldDeclaration {
  const inTable = locateInTable(document, fieldName);
  const inFence = locateInFence(document, fieldName);
  const located = preferUnconditional([inTable, inFence].filter((row): row is LocatedDeclaration => row !== null));
  if (located !== null) return located;

  return {
    kind: 'not-located',
    document: document.path,
    reason: document.quotedNames.has(fieldName)
      ? 'the name is quoted in prose, a heading or a link, but no table row or fenced declaration declares it'
      : 'the document does not mention the name',
  };
}

// ---------------------------------------------------------------- decision notes

export interface DecisionNote {
  /** ISO-8601 `YYYY-MM-DD`, as written. Not calendar-validated, never compared to today. */
  readonly date: string;
  readonly text: string;
  readonly line: number;
  readonly siting: 'same-line' | 'block-above';
}

/**
 * A date, not a date-shaped fragment of something else. `\b` alone accepts the date inside
 * `docs/audits/2026-05-19-speckit-checklists.md`, so a comment that merely cites a dated filename
 * would satisfy the note requirement without anyone having decided anything. Excluding `/` and `-`
 * on both sides keeps a path segment and a longer hyphenated token out, and still admits every real
 * form the corpus uses: `// 2026-09-06 …`, `(2026-09-06)`, `2026-09-06:` and `2026-09-06T…`.
 */
const ISO_DATE = /(?<![\w/-])\d{4}-\d{2}-\d{2}(?![\d/-])/;

/**
 * The trailing `*` run and the block-comment close that may follow it, removed with string ops not
 * `/\*+\/$/`. That pattern is unanchored at its left end and its tail can fail, so on a comment that
 * is a long run of asterisks the engine retries the greedy `\*+` from every start offset: measured
 * quadratic, 5.8 s on 64k characters and 25 minutes on a megabyte. A comment line is corpus data,
 * nothing in this repository bounds its length, and `runCensus` is called at module scope where a
 * hang is not caught by vitest's per-test timeout. `/\*+$/` has the same shape and is avoided for
 * the same reason. The three surviving regexes below are all `^`-anchored, so they cannot rescan.
 */
function stripTrailingBlockClose(text: string): string {
  let end = text.length;
  if (!text.endsWith('*/')) return text;
  end -= 2;
  while (end > 0 && text[end - 1] === '*') end -= 1;
  return text.slice(0, end);
}

const stripMarkers = (comment: string): string =>
  stripTrailingBlockClose(comment.replace(/^\/\*+/, ''))
    .replace(/^\/\//, '')
    .replace(/^\*+/, '')
    .trim();

/**
 * A comment containing an ISO-8601 date, on the assertion's own line or anywhere inside the
 * unbroken comment block immediately above it. That is the whole grammar; everything here is its
 * edges. A blank line or any statement detaches the block, and a comment below is a note about the
 * next statement.
 */
export function findDecisionNote(lines: readonly string[], assertionLine: number): DecisionNote | null {
  const split = splitCommentsByLine(lines);
  const index = assertionLine - 1;
  if (index < 0 || index >= split.length) return null;

  const sameLine = split[index]?.comment ?? '';
  const trailing = ISO_DATE.exec(sameLine);
  if (trailing !== null) {
    return { date: trailing[0], text: stripMarkers(sameLine), line: assertionLine, siting: 'same-line' };
  }

  // Where the assertion's *statement* starts, which is not always where it was matched. A B-family
  // pattern begins at the property access, so a wrapped `expect(\n  record.field\n).toBeNull()` is
  // matched on line two — and the line above it is then `expect(`, a statement, which detaches the
  // comment block a reader can plainly see sitting above the assertion. Walking back over the
  // continuation lines puts the block scan where the author wrote the note. A trailing note on one
  // of those lines counts too: it is on the assertion's own statement.
  let statementStart = index;
  while (statementStart > 0 && (split[statementStart - 1]?.code ?? '').trimEnd().endsWith('(')) {
    statementStart -= 1;
    const continued = split[statementStart]?.comment ?? '';
    const dated = ISO_DATE.exec(continued);
    if (dated !== null) {
      return { date: dated[0], text: stripMarkers(continued), line: statementStart + 1, siting: 'same-line' };
    }
  }

  const block: { readonly line: number; readonly comment: string }[] = [];
  for (let above = statementStart - 1; above >= 0; above -= 1) {
    const entry = split.at(above);
    if (entry === undefined) break;
    if (entry.code.trim() !== '') break;
    if (entry.comment === '') break;
    block.unshift({ line: above + 1, comment: entry.comment });
  }

  for (const entry of block) {
    const dated = ISO_DATE.exec(entry.comment);
    if (dated !== null) {
      return {
        date: dated[0],
        text: block.map((row) => stripMarkers(row.comment)).join(' ').trim(),
        line: entry.line,
        siting: 'block-above',
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------- classification

/**
 * A corpus line is echoed into the failure message, and a failure message reaches CI logs. The
 * corpus is test source and is swept clean today, but "today" is not a control: clipping bounds what
 * one over-long fixture line — a token-shaped literal, a pasted payload — can carry out of the tree.
 *
 * Every echo of corpus text goes through this, the field name included. A name is a capture from an
 * `expect(...)` argument, not a checked identifier: a fixture string that opens a paren and never
 * closes it hands family A a capture as long as the rest of the line. Two sites echoed one
 * unclipped, and measurement put both over five thousand characters on a synthetic corpus.
 */
const MAX_ECHOED = 240;
export const clip = (text: string): string =>
  text.length <= MAX_ECHOED ? text : `${text.slice(0, MAX_ECHOED)}… (${text.length - MAX_ECHOED} more characters)`;

export interface Candidate {
  /** `fieldName` is non-null by construction. */
  readonly assertion: AbsentFieldAssertion;
  /** Every contract that mentions the name. */
  readonly declarations: readonly FieldDeclaration[];
}

export interface Finding {
  readonly assertion: AbsentFieldAssertion;
  /** The unconditional declaration that made this a finding. Names the document and line. */
  readonly decidedBy: Extract<FieldDeclaration, { kind: 'found' }>;
  /** null is the failure. */
  readonly note: DecisionNote | null;
}

export interface Unclassifiable {
  readonly assertion: AbsentFieldAssertion;
  readonly reason: string;
}

export interface Classification {
  readonly ordinary: readonly AbsentFieldAssertion[];
  readonly candidates: readonly Candidate[];
  readonly findings: readonly Finding[];
  readonly unclassifiable: readonly Unclassifiable[];
}

const byFileThenLine = (a: { file: string; line: number }, b: { file: string; line: number }): number =>
  a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file);

/**
 * The two-stage narrowing. Stage one matches the asserted field's **name** against the names the
 * contracts quote — never its value, which is `docs/hard-rules.md` rule 67 and the reason a census
 * that searched for values would prove nothing. Stage two asks whether any located declaration is
 * unconditional; a contract that already says the field may be absent is not contradicted by a test
 * asserting it absent.
 */
export function classify(
  scans: readonly FileScan[],
  contracts: readonly ContractDocument[],
  sourceOf: (file: string) => readonly string[]
): Classification {
  const ordinary: AbsentFieldAssertion[] = [];
  const candidates: Candidate[] = [];
  const findings: Finding[] = [];
  const unclassifiable: Unclassifiable[] = [];

  for (const scan of scans) {
    for (const assertion of scan.assertions) {
      const { fieldName } = assertion;
      if (fieldName === null) {
        // Two different unresolvables, named apart. A wrapped or computed argument is genuinely
        // dynamic; `'9bad'` and `'has-dash'` are written out in full and simply are not identifiers.
        // Reported as one bucket, the published description misdescribed part of its own membership.
        unclassifiable.push({
          assertion,
          reason:
            assertion.nameShape === 'non-identifier-literal'
              ? 'non-identifier literal: the asserted name is written out but is not a JavaScript identifier'
              : 'dynamic key: the asserted name is not a literal at the assertion site',
        });
        continue;
      }

      const quoting = contracts.filter((contract) => contract.quotedNames.has(fieldName));
      if (quoting.length === 0) {
        ordinary.push(assertion);
        continue;
      }

      const declarations = quoting.map((contract) => locateDeclaration(contract, fieldName));
      candidates.push({ assertion, declarations });

      const located = declarations.filter(
        (declaration): declaration is Extract<FieldDeclaration, { kind: 'found' }> => declaration.kind === 'found'
      );
      if (located.length === 0) {
        unclassifiable.push({
          assertion,
          reason: `declaration not located: ${quoting.length} contract(s) quote \`${clip(fieldName)}\` but none declares it`,
        });
        continue;
      }

      const unconditional = located
        .filter((declaration) => declaration.conditionality.length === 0)
        .sort((a, b) => (a.document === b.document ? a.line - b.line : a.document.localeCompare(b.document)));

      if (unconditional.length === 0) {
        ordinary.push(assertion);
        continue;
      }

      const decidedBy = unconditional.at(0);
      // Unreachable: the branch above returned when the array was empty. It throws rather than
      // `continue`s because a `continue` here would drop the assertion out of all four buckets, and
      // the reconciliation FR-014 asserts — ordinary + findings + unclassifiable == population —
      // would then fail with no indication of which assertion went missing or why.
      if (decidedBy === undefined) {
        // Clipped like every other echo of a corpus-derived name, though the guard above makes this
        // branch dead today. The point of routing all of them through one helper is that the next
        // edit to that guard cannot quietly reopen an unclipped path.
        throw new Error(
          `unreachable: no unconditional declaration for \`${clip(fieldName)}\` after a non-empty filter`
        );
      }
      findings.push({ assertion, decidedBy, note: findDecisionNote(sourceOf(assertion.file), assertion.line) });
    }
  }

  ordinary.sort(byFileThenLine);
  candidates.sort((a, b) => byFileThenLine(a.assertion, b.assertion));
  findings.sort((a, b) => byFileThenLine(a.assertion, b.assertion));
  unclassifiable.sort((a, b) => byFileThenLine(a.assertion, b.assertion));

  return { ordinary, candidates, findings, unclassifiable };
}

// ---------------------------------------------------------------- report

/** What the gate says about itself, on a passing run as well as a failing one (FR-017). */
export interface CoverageReport {
  readonly scope: CorpusScope;
  readonly contractDocuments: number;
  readonly testFilesScanned: number;
  /**
   * Files the scan budget could not finish, counted in `testFilesScanned` but contributing nothing
   * else. Empty on this tree, and the gate asserts that: a file that starts defeating the scanner
   * must fail by name here rather than quietly leave the population one assertion shorter.
   */
  readonly unscannableFiles: readonly { readonly file: string; readonly reason: string }[];
  readonly linesByFamily: Readonly<Record<PatternFamily, number>>;
  readonly codeLinesByFamily: Readonly<Record<PatternFamily, number>>;
  readonly commentLinesByFamily: Readonly<Record<PatternFamily, number>>;
  readonly assertionsByFamily: Readonly<Record<PatternFamily, number>>;
  /** Of those assertions, the ones a wrap put across a newline. */
  readonly spanningByFamily: Readonly<Record<PatternFamily, number>>;
  /** Of those assertions, the ones no line-oriented search can see. Reported so the gap is legible. */
  readonly invisibleByFamily: Readonly<Record<PatternFamily, number>>;
  readonly totalAssertions: number;
  readonly candidates: number;
  readonly findings: number;
  readonly findingsWithNote: number;
  readonly unclassifiable: readonly Unclassifiable[];
  readonly ordinary: number;
}

export function buildCoverageReport(
  scope: CorpusScope,
  scans: readonly FileScan[],
  contracts: readonly ContractDocument[],
  classification: Classification
): CoverageReport {
  const linesByFamily = zeroed();
  const codeLinesByFamily = zeroed();
  const commentLinesByFamily = zeroed();
  const assertionsByFamily = zeroed();
  const spanningByFamily = zeroed();
  const invisibleByFamily = zeroed();

  for (const scan of scans) {
    for (const family of PATTERN_FAMILIES) {
      linesByFamily[family] += scan.linesByFamily[family];
      codeLinesByFamily[family] += scan.codeLinesByFamily[family];
      commentLinesByFamily[family] += scan.commentLinesByFamily[family];
      spanningByFamily[family] += scan.spanningByFamily[family];
      invisibleByFamily[family] += scan.invisibleByFamily[family];
    }
    for (const assertion of scan.assertions) assertionsByFamily[assertion.family] += 1;
  }

  return {
    scope,
    contractDocuments: contracts.length,
    testFilesScanned: scans.length,
    unscannableFiles: scans
      .filter((scan) => scan.unscannable !== null)
      .map((scan) => ({ file: scan.file, reason: scan.unscannable ?? '' })),
    linesByFamily,
    codeLinesByFamily,
    commentLinesByFamily,
    assertionsByFamily,
    spanningByFamily,
    invisibleByFamily,
    totalAssertions: scans.reduce((sum, scan) => sum + scan.assertions.length, 0),
    candidates: classification.candidates.length,
    findings: classification.findings.length,
    findingsWithNote: classification.findings.filter((finding) => finding.note !== null).length,
    unclassifiable: classification.unclassifiable,
    ordinary: classification.ordinary.length,
  };
}

const perFamily = (counts: Readonly<Record<PatternFamily, number>>, other: Readonly<Record<PatternFamily, number>>) =>
  PATTERN_FAMILIES.map((family) => `${family} ${counts[family]}/${other[family]}`).join('  ');

/** One deterministic block. No banners, colour or emoji: two runs over one tree print one thing. */
export function formatCoverage(report: CoverageReport): string {
  const { scope } = report;
  const population =
    scope.webviewTestsRoot === null ? 'repo/tests' : 'repo/tests, repo/webview-ui/src (its own suite)';
  const roots =
    scope.envelopeSpecsRoot === null
      ? `repo/docs only — no planning envelope: ${scope.envelopeAbsentReason ?? 'reason not recorded'}`
      : 'repo/docs, <envelope>/specs';
  const count = (prefix: string): number =>
    report.unclassifiable.filter((row) => row.reason.startsWith(prefix)).length;
  const dynamic = count('dynamic key');
  const nonIdentifier = count('non-identifier literal');
  const notLocated = report.unclassifiable.length - dynamic - nonIdentifier;
  const invisible = PATTERN_FAMILIES.reduce((sum, family) => sum + report.invisibleByFamily[family], 0);

  return [
    'absent-field census — coverage',
    `  contracts read  : ${roots}`,
    `  population read : ${population}`,
    `  contracts       : ${report.contractDocuments} documents`,
    `  test files      : ${report.testFilesScanned}   (unscannable: ${report.unscannableFiles.length})`,
    `  lines / assertions by family:  ${perFamily(report.linesByFamily, report.assertionsByFamily)}`,
    `  lines in comments by family :  ${PATTERN_FAMILIES.map((f) => `${f} ${report.commentLinesByFamily[f]}`).join('  ')}`,
    `  wrapped across a newline    :  ${PATTERN_FAMILIES.map((f) => `${f} ${report.spanningByFamily[f]}`).join('  ')}`,
    `  invisible to a line search  :  ${PATTERN_FAMILIES.map((f) => `${f} ${report.invisibleByFamily[f]}`).join('  ')}` +
      `   (${invisible} total: seen by this gate, matched by no published grep)`,
    `  total assertions: ${report.totalAssertions}  =  ordinary ${report.ordinary} + findings ${report.findings}` +
      ` + unclassifiable ${report.unclassifiable.length}`,
    `  candidates      : ${report.candidates}   findings with a note: ${report.findingsWithNote}`,
    `  unclassifiable  : ${report.unclassifiable.length}   (${dynamic} dynamic key, ${nonIdentifier} non-identifier` +
      ` literal, ${notLocated} declaration not located)`,
  ].join('\n');
}

/** One entry per un-noted finding, carrying everything needed to act without re-deriving it. */
export function formatFindings(findings: readonly Finding[]): readonly string[] {
  return findings.map((finding) => {
    const { assertion, decidedBy } = finding;
    return [
      `${assertion.file}:${assertion.line}  field \`${clip(assertion.fieldName ?? '<dynamic>')}\``,
      `  asserted absent: ${clip(assertion.text)}${assertion.spansLines ? '   [wrapped across lines]' : ''}`,
      `  declared by:     ${decidedBy.document}:${decidedBy.line} — ${clip(decidedBy.text)}`,
      '  no adjacent dated decision note',
      '',
      '  If the receiver here is a different record type, say so in a note on the line:',
      '      // 2026-09-06 coincidental: this is a queue item, not an audit payload',
      '  If the divergence is deliberate, say that instead, with the date it was decided.',
    ].join('\n');
  });
}

/** Everything one run produced. The gate asserts against this and prints its coverage block. */
export interface CensusResult {
  readonly report: CoverageReport;
  readonly classification: Classification;
  readonly contracts: readonly ContractDocument[];
  readonly scans: readonly FileScan[];
}

export function runCensus(scope: CorpusScope = resolveScope()): CensusResult {
  const contracts = discoverContracts(scope);
  const { scans, absolutePaths } = scanTestCorpus(populationRoots(scope), scope.repoRoot);

  // Read through the absolute path the traversal produced, and at most once per file. The previous
  // shape re-read the file for every finding in it and resolved the display path back into a real
  // one to do it — a second chance to address a file the traversal never offered.
  const cache = new Map<string, readonly string[]>();
  const linesOf = (file: string): readonly string[] => {
    const cached = cache.get(file);
    if (cached !== undefined) return cached;
    const absolute = absolutePaths.get(file);
    const lines = absolute === undefined ? [] : readFileSync(absolute, 'utf8').split('\n');
    cache.set(file, lines);
    return lines;
  };

  const classification = classify(scans, contracts, linesOf);
  return { report: buildCoverageReport(scope, scans, contracts, classification), classification, contracts, scans };
}
