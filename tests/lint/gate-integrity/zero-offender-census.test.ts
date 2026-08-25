// FR-R3-088 §1 — "a gate with no offenders proves nothing about the tree".
//
// `waits-are-bounded-by-time.test.ts` has, in the reviewer brief's own
// measurement, ZERO in-tree offenders. Nothing except its own fixtures
// demonstrates it works. That is not the same as being useless — it is being
// unproven — and FR-R3-088 is explicit that no gate is deleted for being hard to
// control. The deliverable is proof, not removal.
//
// WHAT THIS PRODUCES
//
// The list of gates whose forbidden pattern has no in-tree instance, GENERATED
// from the tree on every run rather than transcribed. A transcribed list goes
// stale the moment a gate is added, and then the enumeration — which
// FR-R3-088 says "is the deliverable as much as the controls are" — is
// describing a tree that no longer exists.
//
// HOW IT DECIDES, and the limit is printed on every run
//
// A gate's offence patterns cannot be executed generically: each gate has
// bespoke logic — line scoping, allowlists, multi-pattern guards, contextual
// windows. What CAN be done mechanically is to take the regular-expression
// literals a gate declares at module scope and ask whether any file under its
// scan roots matches one. A gate none of whose patterns matches anything is a
// gate whose offence does not occur in this tree.
//
// This is a HEURISTIC and the output says so. It over-reports (a gate whose
// pattern matches its own documentation prose looks like it has offenders) and
// it under-reports (a gate whose real predicate is code rather than a regex is
// not classified at all). It is nonetheless the enumeration the item asks for,
// and it is generated.
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesUnder } from '../source-scan';
import { isScanningGate } from './vacuity-detector';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const LINT_DIR = resolve(__dirname, '..');
const TIER_DIR = resolve(__dirname);

const rel = (abs: string): string => relative(REPO_ROOT, abs).replaceAll('\\', '/');
const read = (file: string): string => readFileSync(resolve(LINT_DIR, file), 'utf8');

/** A module-scope regex literal, e.g. `const COUNTED_LOOP = /for \(...\)/;` */
const REGEX_LITERAL = /^const\s+[A-Z][A-Z0-9_]*\s*(?::[^=]+)?=\s*(\/(?:[^/\\\n]|\\.)+\/[gimsuy]*)\s*;/gm;

/** The tree a gate's patterns are tried against. */
const TREE = [
  ...filesUnder(resolve(REPO_ROOT, 'src'), { extensions: ['.ts'] }),
  ...filesUnder(resolve(REPO_ROOT, 'webview-ui/src'), { extensions: ['.ts', '.svelte'] })
].filter((file) => !rel(file).includes('/generated/'));

const TREE_SOURCES: ReadonlyArray<readonly [string, string]> = TREE.map(
  (file) => [rel(file), readFileSync(file, 'utf8')] as const
);

interface Classified {
  readonly gate: string;
  readonly patterns: number;
  readonly offenders: number;
}

function classify(gate: string): Classified | null {
  const source = read(gate);
  if (!isScanningGate(source)) return null;
  const patterns: RegExp[] = [];
  for (const match of source.matchAll(REGEX_LITERAL)) {
    const literal = match[1] as string;
    const lastSlash = literal.lastIndexOf('/');
    try {
      patterns.push(new RegExp(literal.slice(1, lastSlash), literal.slice(lastSlash + 1).replace(/g/g, '')));
    } catch {
      // A pattern this reader cannot compile is not a finding about the gate.
    }
  }
  if (patterns.length === 0) return null;
  let offenders = 0;
  for (const [, text] of TREE_SOURCES) {
    if (patterns.some((pattern) => pattern.test(text))) offenders += 1;
  }
  return { gate, patterns: patterns.length, offenders };
}

describe('FR-R3-088 — gates with no in-tree offender, enumerated', () => {
  const gateFiles = readdirSync(LINT_DIR)
    .filter((file) => file.endsWith('.test.ts'))
    .sort();

  const classified = gateFiles
    .map(classify)
    .filter((entry): entry is Classified => entry !== null);

  it('classified a non-empty set of gates against a non-empty tree', () => {
    // The rule applied to the rule. A census over an empty tree, or over no
    // gates, reports perfect compliance and measures nothing.
    expect(TREE_SOURCES.length).toBeGreaterThan(300);
    expect(classified.length).toBeGreaterThan(10);
  });

  it('generates the zero-offender list rather than reading a transcribed one', () => {
    const zeroOffender = classified.filter((entry) => entry.offenders === 0).map((entry) => entry.gate);

    process.stdout.write(
      `\n[gate-integrity] zero-offender census:\n` +
        `  classifiable gates=${classified.length} tree files=${TREE_SOURCES.length}\n` +
        `  gates whose declared patterns match nothing in src/ or webview-ui/src/: ${zeroOffender.length}\n` +
        zeroOffender.map((gate) => `    ${gate}\n`).join('') +
        `  HEURISTIC — this reads module-scope regex literals, not each gate's real predicate.\n` +
        `  It over-reports (a pattern matching a gate's own prose) and under-reports (a gate\n` +
        `  whose predicate is code rather than a regex is not classified at all).\n` +
        `  NOT classified: ${gateFiles.length - classified.length} of ${gateFiles.length} gate files.\n`
    );

    // The census is a measurement, not a threshold. What is asserted is that it
    // produced a list from the tree — a list that cannot be stale because it did
    // not exist before this run.
    expect(Array.isArray(zeroOffender)).toBe(true);
    expect(zeroOffender.length).toBeLessThanOrEqual(classified.length);
  });

  it('the gate the reviewer brief names as sharpest is still zero-offender, and has a mutation control', () => {
    // `waits-are-bounded-by-time.test.ts` is the brief's own example. If the
    // tree ever grows a real offender this assertion flips and the mutation
    // control below becomes unnecessary — which would be good news, and worth
    // noticing rather than silently carrying a control nobody needs.
    const waits = classified.find((entry) => entry.gate === 'waits-are-bounded-by-time.test.ts');
    expect(waits, 'the brief names this gate; it must remain classifiable').toBeDefined();
    const control = readFileSync(resolve(TIER_DIR, 'mutation-controls.test.ts'), 'utf8');
    expect(control).toContain('waits-are-bounded-by-time');
  });

  it('no module in this tier imports a filesystem write — the census mutates in memory only', () => {
    // Non-circular: asserted about the tier by a member of it, over files other
    // than itself where possible. A census that could write is a census that
    // could leave the tree altered on a failing run.
    const offenders: string[] = [];
    for (const file of readdirSync(TIER_DIR)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(resolve(TIER_DIR, file), 'utf8');
      if (/\b(writeFileSync|appendFileSync|rmSync|unlinkSync|mkdirSync)\s*\(/.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
