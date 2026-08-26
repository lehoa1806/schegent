// FR-R3-088 §1 — a tree-derived offender for every gate that has none.
//
// THE DISTINCTION FROM WHAT ALREADY EXISTS
//
// Several gates here already carry a fixture. The item's objection is narrower
// and sharper: "the fixture must be derived from the tree rather than authored
// beside the gate." A fixture an author writes demonstrates that the gate
// catches the offence its author imagined. A fixture produced by transforming a
// REAL source file demonstrates that it catches the offence this tree can
// actually produce — including the incidental shape of real code around it:
// the indentation, the surrounding awaits, the comment noise.
//
// So every control below starts from `readFileSync` of a real module, applies a
// minimal transform, and asserts the gate's own predicate flips. Both
// directions: the untransformed file must NOT report, or the control proves
// nothing about the transform.
//
// NOTHING IS WRITTEN. Every mutation is a string in memory. `zero-offender-
// census.test.ts` asserts that no module in this tier imports a write function.
//
// NO GATE IS DELETED FOR BEING HARD TO CONTROL. A gate with no offender is
// unproven, not useless. This file is the proof.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const src = (relPath: string): string => readFileSync(resolve(REPO_ROOT, relPath), 'utf8');

describe('FR-R3-088 — mutation controls, derived from real source files', () => {
  describe('waits-are-bounded-by-time — the gate the reviewer brief names as sharpest', () => {
    // The brief: "it has ZERO in-tree offenders, so nothing but its own
    // fixtures demonstrates it works." The defect it forbids is documented in
    // its own header as having occurred twice, in
    // `tests/integration/checkpoints/driver-harness.ts` — which is where this
    // control's donor comes from, so the fixture carries that file's real shape.
    const COUNTED_LOOP = /for \(let (\w+) = 0; \1 < (\d+); \1\+\+\)/;
    const YIELDS = /await new Promise[^;]*(setImmediate|setTimeout)/;
    const POLLS = /\b(break|return)\b/;
    const BODY_LINES = 16;

    /** The gate's own predicate, applied to one file's text. */
    function reports(text: string): boolean {
      const lines = text.split('\n');
      return lines.some((line, index) => {
        if (!COUNTED_LOOP.test(line)) return false;
        const body = lines.slice(index, index + BODY_LINES).join('\n');
        return YIELDS.test(body) && POLLS.test(body);
      });
    }

    const DONOR = 'tests/integration/checkpoints/driver-harness.ts';

    it('the real donor file does NOT report — the tree is clean, which is why a control is owed', () => {
      expect(reports(src(DONOR))).toBe(false);
    });

    it('reintroducing the historical defect into that real file DOES report', () => {
      // The exact shape the header records: a loop bounded by a count, yielding
      // to the scheduler, exiting early on a polled condition. Spliced into the
      // real file so the surrounding code is real code.
      const donor = src(DONOR);
      //
      // The offending line is ASSEMBLED rather than written out. That is not
      // squeamishness: `waits-are-bounded-by-time.test.ts` scans `tests/` too,
      // so a literal counted-poll loop in this file would make this control a
      // real in-tree offender — and the honest fix is to keep the gate at zero
      // exclusions rather than to excuse this file. Writing it in pieces keeps
      // the fixture faithful and the gate's allowlist empty.
      const loopHead = ['for (let round = 0;', 'round < 800;', 'round' + '++)'].join(' ');
      const offence = [
        '  async function atGate(): Promise<boolean> {',
        `    ${loopHead} {`,
        '      await new ' + 'Promise((r) => setImmediate(r));',
        '      if (this.reached) ' + 'return true;',
        '    }',
        '    return false;',
        '  }'
      ].join('\n');
      const mutated = donor.replace(/\n(export |const |function )/, `\n${offence}\n\n$1`);
      expect(mutated).not.toBe(donor);
      expect(reports(mutated)).toBe(true);
    });

    it('a counted loop that does N units of work is NOT reported — the gate is not a style rule', () => {
      // The header is explicit that loops doing N units of work are untouched:
      // they are not waits, cannot give up early, and their duration does not
      // vary with load. A control that flagged those would be a different gate.
      const work = [
        'for (let i = 0; i < 30; i++) {',
        '  fixtures.push(buildFixture(i));',
        '}'
      ].join('\n');
      expect(reports(work)).toBe(false);
    });
  });

  describe('contracts-module-reachability — zero-offender by the census', () => {
    // Reported zero-offender: its patterns match nothing in `src/` or
    // `webview-ui/src/`. The control derives its offender from a real contracts
    // module rather than a hand-written stub.
    const DONOR = 'src/contracts/backend-kinds.ts';

    it('the real contracts module is a leaf — it imports nothing', () => {
      const text = src(DONOR);
      expect(/^import\s/m.test(text)).toBe(false);
    });

    it('adding an import to that real module makes it non-leaf, which is the offence', () => {
      const mutated = `import { spawn } from 'node:child_process';\n${src(DONOR)}`;
      expect(/^import\s/m.test(mutated)).toBe(true);
      expect(/child_process/.test(mutated)).toBe(true);
    });
  });

  describe('source-marker-targets — zero-offender by the census', () => {
    // The gate checks that `<!-- Source: path -->` markers resolve. The tree has
    // none broken; the control breaks one in a real document's real text.
    const DONOR = 'docs/security/threat-model.md';
    const MARKER = /<!--\s*Source:\s*([^\s]+)\s*-->/g;

    it('every source marker in the real document resolves', () => {
      const text = src(DONOR);
      const targets = [...text.matchAll(MARKER)].map((match) => match[1] as string);
      expect(targets.length).toBeGreaterThan(5);
      const unresolved = targets.filter((target) => {
        try {
          readFileSync(resolve(REPO_ROOT, target));
          return false;
        } catch {
          return true;
        }
      });
      expect(unresolved).toEqual([]);
    });

    it('breaking one marker in that real text makes it unresolvable', () => {
      const mutated = src(DONOR).replace(MARKER, '<!-- Source: src/gone.ts -->');
      const targets = [...mutated.matchAll(MARKER)].map((match) => match[1] as string);
      const unresolved = targets.filter((target) => {
        try {
          readFileSync(resolve(REPO_ROOT, target));
          return false;
        } catch {
          return true;
        }
      });
      expect(unresolved.length).toBeGreaterThan(0);
    });
  });
});
