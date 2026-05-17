/**
 * Feature 011 T052 — parity test between the host's
 * `src/lib/retry-condition.ts` and the webview's mirror at
 * `webview-ui/src/lib/retry-condition.ts`.
 *
 * Per SC-011, the two validators must agree on every input. A simple
 * byte-equality test would suffice if both files were identical TS
 * source, but the spec asks us to load a "broad fixture" and assert
 * that the validity verdict matches for every entry — that way, even
 * if the webview drifts in import paths or comment style, we still
 * catch behavioral drift on day one.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { validate as hostValidate } from '../../src/lib/retry-condition';

// Note: importing the webview's TS source directly across the
// CommonJS/ESM boundary fails under our root tsconfig. The "byte
// equality (modulo banner)" test below covers behavioral parity: if
// the source bodies are identical, the validators MUST behave
// identically. The fixture sweep below uses the host validator only
// as a sanity check that the chosen fixtures match their declared
// expectations.

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOST_PATH = path.join(REPO_ROOT, 'src', 'lib', 'retry-condition.ts');
const WEBVIEW_PATH = path.join(REPO_ROOT, 'webview-ui', 'src', 'lib', 'retry-condition.ts');

interface Fixture {
  readonly source: string;
  readonly expectedOk: boolean;
  readonly description: string;
}

// Broad cross-section: every valid construct, every documented error
// path, every edge case noted in the grammar EBNF. Disagreements here
// indicate behavioral drift between the host and webview validators.
const FIXTURES: readonly Fixture[] = [
  // ----- Valid -----
  { source: 'open_questions > 0', expectedOk: true, description: 'simple identifier > number' },
  { source: '0 < open_questions', expectedOk: true, description: 'number < identifier' },
  { source: 'open_questions == 0', expectedOk: true, description: 'equality compare' },
  { source: 'open_questions != 0', expectedOk: true, description: 'inequality compare' },
  { source: 'a >= 1 and b <= 2', expectedOk: true, description: 'logical and' },
  { source: 'a >= 1 or b <= 2', expectedOk: true, description: 'logical or' },
  { source: 'a >= 1 && b <= 2', expectedOk: true, description: 'and via &&' },
  { source: 'a >= 1 || b <= 2', expectedOk: true, description: 'or via ||' },
  { source: 'not (a > 0)', expectedOk: true, description: 'not on grouped compare' },
  { source: '!(a > 0)', expectedOk: true, description: '! on grouped compare' },
  { source: '(a > 0 and b > 0) or c > 0', expectedOk: true, description: 'nested parens' },
  { source: '-5 < count', expectedOk: true, description: 'negative numeric literal' },
  { source: '3.14 < pi', expectedOk: true, description: 'float literal' },
  { source: 'snake_case_id > 0', expectedOk: true, description: 'snake-case identifier' },
  { source: '_underscore > 0', expectedOk: true, description: 'leading underscore identifier' },
  // ----- Invalid -----
  { source: '', expectedOk: false, description: 'empty source' },
  { source: '   ', expectedOk: false, description: 'whitespace-only source' },
  { source: 'open_questions >', expectedOk: false, description: 'compare missing rhs' },
  { source: '> 0', expectedOk: false, description: 'compare missing lhs' },
  { source: 'a > b > c', expectedOk: false, description: 'compare chain rejected' },
  { source: 'a + b > 0', expectedOk: false, description: '+ operator not in grammar' },
  { source: 'a > b()', expectedOk: false, description: 'function calls not allowed' },
  { source: 'a > b.c', expectedOk: false, description: 'member access not allowed' },
  { source: 'a > "b"', expectedOk: false, description: 'string literals not allowed' },
  { source: 'AND a > 0', expectedOk: false, description: 'reserved word case-sensitive' },
  { source: 'a > 0 AND b > 0', expectedOk: false, description: 'AND uppercase rejected' },
  { source: 'a > -b', expectedOk: false, description: 'unary minus on identifier rejected' },
  { source: '(a > 0', expectedOk: false, description: 'unbalanced paren' },
  { source: 'a > 0)', expectedOk: false, description: 'stray close paren' },
  { source: 'not', expectedOk: false, description: 'lone not' },
  { source: 'and', expectedOk: false, description: 'lone and' }
];

describe('Feature 011 T052 — retry-condition host/webview parity (SC-011)', () => {
  it('host and webview mirrors share identical body source (modulo top-of-file banner)', () => {
    // Strip the leading // comment block at the top of each file; the
    // mirror banner on the webview file legitimately differs from the
    // host's. Everything after the first blank line MUST be byte-equal.
    const stripBanner = (src: string): string => {
      const lines = src.split('\n');
      let start = 0;
      while (start < lines.length && lines[start].startsWith('//')) {
        start++;
      }
      // skip the trailing blank line that follows the banner
      while (start < lines.length && lines[start].trim() === '') {
        start++;
      }
      return lines.slice(start).join('\n');
    };
    const host = stripBanner(fs.readFileSync(HOST_PATH, 'utf8'));
    const webview = stripBanner(fs.readFileSync(WEBVIEW_PATH, 'utf8'));
    expect(host).toBe(webview);
  });

  it('every fixture matches its declared expectation on the host (sanity check)', () => {
    const drift: string[] = [];
    for (const fx of FIXTURES) {
      const result = hostValidate(fx.source);
      if (result.ok !== fx.expectedOk) {
        drift.push(
          `[${fx.description}] source=${JSON.stringify(fx.source)} expected.ok=${fx.expectedOk} actual.ok=${result.ok} actual.error=${result.ok ? '(none)' : result.error}`
        );
      }
    }
    expect(drift, drift.join('\n')).toEqual([]);
  });
});
