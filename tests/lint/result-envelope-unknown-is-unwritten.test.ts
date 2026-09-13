// Feature 212 (FR-005, FR-014) — UNKNOWN is a field that was never written, and
// there is no type that says so.
//
// `resultEnvelope` is a THREE-state fact on a `phase-end` payload: `'received'`,
// `'absent'`, or the key not present at all. The third state is not a shrug. Two
// of the three docblocks that define it say the same thing in the same words —
// `'absent'` is the positive claim that the invocation RAN and no envelope
// arrived — so an omission read as `'absent'` puts every phase refused before a
// process existed into the population FR-007 counts as ran-without-a-verdict,
// which is the opposite diagnosis.
//
// WHY A GATE AND NOT A TYPE. `Record<string, unknown>` is what an audit payload
// is by the time it reaches the writer, and on an object `{ k: undefined }` and
// `{}` are different values: `'k' in obj` is `true` for the first. The
// projection and the export both read presence, so a key written as `undefined`
// is a key somebody answered.
//
// The flag that would type this is `exactOptionalPropertyTypes`, and it is OFF
// in this tree on purpose: `compiler-strictness-ratchet.test.ts` carries it at
// 142 errors and asserts it is not silently enabled, so the ratchet is the
// standing decision not to adopt it yet. That entry's own note describes this
// exact defect — `run-driver.ts`'s nine residual errors are each "a `WorkflowRun`
// spread where an optional field carries an explicit `undefined`". Even with the
// flag on it would not reach here, because these payloads are not declared
// optional properties; they are index-signature objects assembled at four sites
// in three modules. The one construct that keeps the distinction is a
// conditional spread, and nothing but this gate requires it.
//
// WHAT IT CHECKS: every site in `src/` that puts `resultEnvelope` into an object
// literal — `resultEnvelope: <value>` or the `{ resultEnvelope }` shorthand — is
// guarded by an explicit `!== undefined` test on the same line or the code line
// just above it. A required (non-`?`) declaration of the field also fails,
// because a field that cannot be omitted cannot carry UNKNOWN at all.
//
// WHAT IT DOES NOT CHECK: that the guarded value is correct. Whether a given arm
// should record `'received'`, `'absent'`, or nothing is a judgement about that
// arm, asserted in `phase-runner-backend-posture.test.ts`. This gate only keeps
// the third state expressible.
//
// Each matcher is proved against known-bad and known-good text below, per the
// precedent in `no-content-driven-process-control.test.ts`: a pattern that
// silently stops matching must fail here rather than ship as a comment.

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC_ROOT = resolve(REPO_ROOT, 'src');

/**
 * The property going INTO an object literal, in either spelling.
 *
 * `resultEnvelope?:` is excluded by construction — `\s*` does not match `?` — so
 * an optional declaration is not a write. A declaration without the `?` is one
 * this gate wants to see, and reports through the same channel.
 */
const WRITE = /\bresultEnvelope\s*:|\{\s*resultEnvelope\s*[},]/;

/** The optional declaration, which is the only declaration FR-014 permits. */
const OPTIONAL_DECLARATION = /\bresultEnvelope\s*\?\s*:/;

/** An explicit three-state test. `?.`, `??` and truthiness are all not this. */
const GUARD = /\bresultEnvelope\s*!==\s*undefined/;

/**
 * The property being ASSIGNED rather than built into a literal, which the
 * matchers above cannot see and this gate does not try to teach them.
 *
 * `(?!=)` is what keeps `!==`, `===` and `==` out: those are the reads this file
 * is built around, and a matcher that swallowed them would report the guard as
 * the violation. The member access is what keeps `const resultEnvelope = ...`
 * out — `audit-payload.ts` binds one while projecting a row, and a local binding
 * puts nothing on an object. Both spellings of the access are matched, because
 * `obj['resultEnvelope'] = x` reaches the same property as `obj.resultEnvelope`.
 *
 * The reason it is a separate rule is that `WRITE`'s guard discipline does not
 * transfer. A literal write and its guard both name `resultEnvelope`, so "the
 * same line or the one above" is a test a regex can make. An assignment's safety
 * is a property of the right-hand EXPRESSION — that it cannot evaluate to
 * `undefined` — and the guard next to the one such site this tree ever had named
 * a different variable entirely (`raw.sawTerminalResult !== undefined`). Reading
 * that as coverage means trusting a regex to decide when two different names are
 * the same fact, which is how a gate starts passing sites it never checked.
 *
 * So assignment is ruled OUT of the tree instead of reasoned about. `AttemptRef`
 * carries the backend's raw `boolean | undefined` and `PhaseRunner.envelopeField`
 * derives the three-state from it, inside a literal this file already governs.
 * The rule below keeps that true: it is the whole reason the object-literal scope
 * above is a complete description of how this tree writes the field, rather than
 * a description of the sites somebody happened to think of.
 */
const ASSIGNMENT = /(?:\.resultEnvelope|\[\s*(['"])resultEnvelope\1\s*\])\s*=(?!=)/;

/**
 * Code lines, paired with their real line numbers.
 *
 * Comments are dropped rather than skipped over, so "the code line just above"
 * means what it says: `close()` puts a four-line note between its guard and the
 * spread it guards, and a window measured in raw lines would miss the guard and
 * fail a site that is correct.
 */
interface CodeLine {
  readonly line: number;
  readonly text: string;
}

function codeLines(source: string): CodeLine[] {
  return source
    .split('\n')
    .map((text, index) => ({ line: index + 1, text: text.trim() }))
    .filter(({ text }) => text !== '')
    .filter(
      ({ text }) =>
        !text.startsWith('//') && !text.startsWith('*') && !text.startsWith('/*')
    );
}

interface Site {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function unguardedWrites(): Site[] {
  const out: Site[] = [];
  for (const file of filesUnder(SRC_ROOT, { extensions: ['.ts'] })) {
    const lines = codeLines(readFileSync(file, 'utf8'));
    lines.forEach(({ line, text }, index) => {
      if (OPTIONAL_DECLARATION.test(text)) return;
      if (!WRITE.test(text)) return;
      const window = [text, lines[index - 1]?.text ?? ''];
      if (window.some((candidate) => GUARD.test(candidate))) return;
      out.push({ file: relative(REPO_ROOT, file), line, text });
    });
  }
  return out;
}

describe('an unknown result envelope is never written as a key (feature 212)', () => {
  const writes = (() => {
    let count = 0;
    for (const file of filesUnder(SRC_ROOT, { extensions: ['.ts'] })) {
      for (const { text } of codeLines(readFileSync(file, 'utf8'))) {
        if (!OPTIONAL_DECLARATION.test(text) && WRITE.test(text)) count += 1;
      }
    }
    return count;
  })();

  it('finds the write sites it governs', () => {
    // Vacuity control. The assertion below expects an empty list, which an empty
    // scan satisfies for free — and an empty scan is exactly what a renamed
    // field, a moved `src/`, or a broken matcher produces. Four sites carry the
    // field today (`phase-runner`, `phase-attempt-recorder`, `phase-sequencer`,
    // `audit-payload`); the floor is set below that so adding one is not a
    // failure and removing all of them is.
    expect(
      writes,
      'no object-literal write of `resultEnvelope` was found under src/ — the ' +
        'matcher no longer describes how this tree writes the field, so the ' +
        'assertion below is comparing nothing to nothing'
    ).toBeGreaterThanOrEqual(3);
  });

  it('guards every one of them with an explicit !== undefined', () => {
    expect(
      unguardedWrites(),
      'each of these puts `resultEnvelope` into an object without first ruling ' +
        'out `undefined`. On an audit payload `{ resultEnvelope: undefined }` ' +
        'is a key that IS present, and both `projectPhaseEnd` and the ' +
        'metadata-only export read presence — so the omission that means ' +
        'UNKNOWN (FR-014) becomes an answer. Spread it conditionally, as ' +
        '`PhaseRunner.envelopeField` and `PhaseAttempt.close` do.'
    ).toEqual([]);
  });

  it('is never assigned, only built into a guarded literal', () => {
    const assignments: Site[] = [];
    for (const file of filesUnder(SRC_ROOT, { extensions: ['.ts'] })) {
      for (const { line, text } of codeLines(readFileSync(file, 'utf8'))) {
        if (ASSIGNMENT.test(text)) {
          assignments.push({ file: relative(REPO_ROOT, file), line, text });
        }
      }
    }
    expect(
      assignments,
      'each of these assigns `resultEnvelope` rather than spreading it into an ' +
        'object, which puts it outside every check above: the matcher that finds ' +
        'write sites is anchored on object-literal syntax, and the guard rule it ' +
        'applies is about a neighbouring line naming the same field. Assign the ' +
        "backend's raw `boolean | undefined` instead and derive the three-state " +
        'where it is spread, as `PhaseRunner.envelopeField` does.'
    ).toEqual([]);
  });

  it('matches the shapes it claims to match', () => {
    // The write spellings this tree actually uses, and the near-miss that must
    // NOT be read as a write.
    expect(WRITE.test('? { resultEnvelope: attemptRef.resultEnvelope }')).toBe(true);
    expect(WRITE.test('...(resultEnvelope !== undefined ? { resultEnvelope } : {}),')).toBe(true);
    expect(WRITE.test('resultEnvelope: raw.sawTerminalResult ? \'received\' : \'absent\',')).toBe(true);
    expect(WRITE.test('attemptRef.resultEnvelope = raw.sawTerminalResult ? \'received\' : undefined;')).toBe(
      false
    );

    // An optional declaration is a declaration, not a write.
    expect(OPTIONAL_DECLARATION.test("  resultEnvelope?: 'received' | 'absent';")).toBe(true);
    expect(OPTIONAL_DECLARATION.test("  readonly resultEnvelope?: 'received' | 'absent';")).toBe(true);
    // A REQUIRED one is reported, because it cannot express UNKNOWN.
    expect(OPTIONAL_DECLARATION.test("  resultEnvelope: 'received' | 'absent';")).toBe(false);
    expect(WRITE.test("  resultEnvelope: 'received' | 'absent';")).toBe(true);

    // The guard, and the three things that look like one and are not.
    expect(GUARD.test('return attemptRef.resultEnvelope !== undefined')).toBe(true);
    expect(GUARD.test('...(inputs.resultEnvelope !== undefined')).toBe(true);
    expect(GUARD.test('if (attemptRef.resultEnvelope) {')).toBe(false);
    expect(GUARD.test('resultEnvelope: attemptRef.resultEnvelope ?? undefined')).toBe(false);
    expect(GUARD.test('attemptRef?.resultEnvelope')).toBe(false);

    // The assignment form this tree no longer contains — proved here so the rule
    // above cannot pass by quietly matching nothing — and the reads and the local
    // binding that share its spelling and must not be mistaken for it.
    expect(ASSIGNMENT.test("attemptRef.resultEnvelope = raw.sawTerminalResult ? 'received' : 'absent';")).toBe(
      true
    );
    expect(ASSIGNMENT.test("payload['resultEnvelope'] = 'absent';")).toBe(true);
    expect(ASSIGNMENT.test('const resultEnvelope = saw ? \'received\' : \'absent\';')).toBe(false);
    expect(ASSIGNMENT.test('return attemptRef.resultEnvelope !== undefined')).toBe(false);
    expect(ASSIGNMENT.test('if (entry.resultEnvelope === undefined) return {};')).toBe(false);
  });

  it('reads the guard through comments rather than stopping at them', () => {
    // `PhaseAttempt.close` separates its guard from its spread by a comment.
    // Measured in raw lines the guard is out of the window and a correct site
    // fails; this is the reason `codeLines` drops comments instead of the
    // window being widened, which would let a genuinely distant guard pass.
    const recorder = resolve(SRC_ROOT, 'controller', 'phase-attempt-recorder.ts');
    const lines = codeLines(readFileSync(recorder, 'utf8'));
    const writeIndex = lines.findIndex(
      ({ text }) => WRITE.test(text) && !OPTIONAL_DECLARATION.test(text)
    );
    expect(writeIndex).toBeGreaterThan(0);
    const guardLine = lines[writeIndex - 1]?.line ?? 0;
    const writeLine = lines[writeIndex]?.line ?? 0;
    expect(GUARD.test(lines[writeIndex - 1]?.text ?? '')).toBe(true);
    expect(writeLine - guardLine).toBeGreaterThan(0);
  });
});
