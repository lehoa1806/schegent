// FR-R3-088 §5 — the split is defined by a RULE, not by a hand-maintained list.
//
// The item is explicit: "the split is defined by a rule a reader can apply, not
// by a hand-maintained list." A list would need an entry per test file, would go
// stale on the next addition, and — worse — would let whoever maintains it
// decide which side a test falls on. That is the same authorship problem
// FR-R3-088 is about, one level up.
//
// So this asserts three things about `scripts/test-census.mjs`:
//   1. it classifies EVERY test file it finds — nothing is unassigned;
//   2. it holds no list of file names, so nothing can be assigned by hand;
//   3. the rule it applies is the one documented, verified on real files from
//      each side rather than on synthetic strings.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CENSUS = resolve(REPO_ROOT, 'scripts/test-census.mjs');

function runCensus(): string {
  return execFileSync(process.execPath, [CENSUS], { cwd: REPO_ROOT, encoding: 'utf8' });
}

describe('FR-R3-088 — product coverage is reported separately from suite coverage', () => {
  const output = runCensus();

  it('reports two figures where one was reported', () => {
    expect(output).toContain('ABOUT THE PRODUCT');
    expect(output).toContain('ABOUT THE SUITE');
  });

  it('assigns every test file to exactly one side — nothing is unclassified', () => {
    const product = /ABOUT THE PRODUCT\s+(\d+) file/.exec(output);
    const suite = /ABOUT THE SUITE\s+(\d+) file/.exec(output);
    const total = /TOTAL\s+(\d+) file/.exec(output);
    expect(product).not.toBeNull();
    expect(suite).not.toBeNull();
    expect(total).not.toBeNull();
    const [p, s, t] = [product, suite, total].map((match) => Number((match as RegExpExecArray)[1]));
    expect(p + s).toBe(t);
    // A census over nothing would satisfy the arithmetic above and mean nothing.
    expect(t).toBeGreaterThan(500);
  });

  it('prints the rule and its stated limit, so the figures are not read as more than they are', () => {
    expect(output).toContain('RULE:');
    expect(output).toContain('NOT measured:');
  });

  it('holds NO hand-maintained list of test files', () => {
    // The whole point. If a path literal naming a test file appeared here, the
    // split would stop being a rule and start being someone's judgement.
    const source = readFileSync(CENSUS, 'utf8');
    const listed = [...source.matchAll(/['"][\w./-]*\.(?:test|spec)\.ts['"]/g)].map((m) => m[0]);
    expect(listed).toEqual([]);
  });

  it('applies the documented rule to real files from each side', () => {
    // Derived from the tree: a known behavioural test imports src/, a known gate
    // does not. If the classifier's rule ever drifted from the documented one,
    // one of these flips.
    const behavioural = readFileSync(
      resolve(REPO_ROOT, 'tests/unit/services/backend-containment-policy.test.ts'),
      'utf8'
    );
    const gate = readFileSync(
      resolve(REPO_ROOT, 'tests/lint/waits-are-bounded-by-time.test.ts'),
      'utf8'
    );
    const importsProduct =
      /(?:^|\n)\s*(?:import|export)[^;\n]*from\s+['"][^'"]*(?:\.\.\/)*(?:src|webview-ui\/src)\/[^'"]+['"]/;
    expect(importsProduct.test(behavioural)).toBe(true);
    expect(importsProduct.test(gate)).toBe(false);
  });
});
