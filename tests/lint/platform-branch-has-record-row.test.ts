import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * FR-R3-115 / FR-007 — every `process.platform` comparison under `src/` must name a
 * platform the observation record classifies.
 *
 * WHY. This product ships four `win32` branches, two of them safety paths, for an
 * operating system on which its code has never executed, and branches on `linux` for
 * path case-sensitivity it has never observed. `FR-R3-115` decided (2026-08-27) to
 * DECLINE measuring them rather than pretend, keep the branches because deleting
 * untested safety code makes Windows strictly worse, and narrow the declared support
 * surface to say so.
 *
 * That decision is only durable if the next platform branch cannot arrive without
 * one. A `process.platform === 'freebsd'` added in six months would otherwise be a
 * fifth unverified platform with no row, no tier, and nobody having decided
 * anything — which is the state this whole item exists to leave behind.
 *
 * THE TWO WAYS TO GET THIS WRONG, and both were live risks:
 *
 *   * **Flag a comment.** `src/lib/runtime-log/runtime-log-path.ts:36` says "We
 *     don't gate by `process.platform`" in prose. That is not a branch, and a gate
 *     that reports it teaches people to ignore it.
 *   * **Strip too much.** `FR-R3-114` measured a gate rendered VACUOUS on the day it
 *     was written because it filtered through `codeOnly()`, which blanks string
 *     bodies — and the shape it forbade lived inside a string. So comments are
 *     stripped and **string bodies are kept**, and both directions carry a fixture
 *     below.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC_ROOT = resolve(REPO_ROOT, 'src');
const RECORD = resolve(REPO_ROOT, 'docs/operations/platform-observation-record.md');

/** Comments out, strings in. See the docblock: this is the FR-R3-114 lesson, applied. */
export function stripCommentsKeepStrings(source: string): string {
  let out = '';
  let index = 0;
  const n = source.length;
  while (index < n) {
    const ch = source[index]!;
    const next = source[index + 1];
    if (ch === '/' && next === '/') {
      while (index < n && source[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      index += 2;
      while (index < n && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      index += 1;
      while (index < n) {
        const inner = source[index]!;
        out += inner;
        index += 1;
        if (inner === '\\') {
          if (index < n) {
            out += source[index];
            index += 1;
          }
          continue;
        }
        if (inner === quote) break;
      }
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

/** Platforms the observation record's support table classifies. */
function classifiedPlatforms(): ReadonlySet<string> {
  const body = readFileSync(RECORD, 'utf8');
  const named = new Set<string>();
  // The support table names each platform, and the parenthesised token is the
  // `process.platform` value. `darwin` and `win32` appear that way; `Linux` maps to
  // the lowercase platform string.
  for (const match of body.matchAll(/^\|\s*\*\*([A-Za-z]+)\*\*(?:\s*\(([a-z0-9, ]+)\))?\s*\|\s*\*\*(?:Verified|Unverified)\*\*/gm)) {
    named.add(match[1]!.toLowerCase());
    // The parenthesised group is OPTIONAL in the pattern, so it is absent at
    // runtime for a row like `| **Linux** | **Unverified** |`. The declaration says
    // so; without it `noUncheckedIndexedAccess` being off types it `string` and the
    // guard below reads as dead code.
    const platformToken: string | undefined = match[2];
    for (const token of (platformToken ?? '').split(',')) {
      const trimmed = token.trim();
      if (trimmed.length > 0) named.add(trimmed);
    }
  }
  return named;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface Comparison {
  readonly file: string;
  readonly platform: string;
}

const COMPARISON = /process\.platform\s*(?:===|!==|==|!=)\s*['"`]([a-z0-9]+)['"`]/g;

function comparisons(): readonly Comparison[] {
  const found: Comparison[] = [];
  for (const absolute of sourceFiles(SRC_ROOT)) {
    const code = stripCommentsKeepStrings(readFileSync(absolute, 'utf8'));
    COMPARISON.lastIndex = 0;
    for (const match of code.matchAll(COMPARISON)) {
      found.push({
        file: relative(REPO_ROOT, absolute).split(/[/\\]/).join('/'),
        platform: match[1]!
      });
    }
  }
  return found;
}

describe('every platform branch has a row in the observation record (FR-R3-115)', () => {
  it('the observation record classifies a non-empty set of platforms', () => {
    // Vacuity control on the RECORD side: if the support table is renamed or
    // reformatted, `classified` empties and every branch below becomes a violation
    // — loud, which is the right failure. The opposite arrangement, where an empty
    // set silently excuses everything, is the one to avoid.
    const classified = classifiedPlatforms();
    expect(
      [...classified].sort(),
      'the support table in platform-observation-record.md did not parse — this gate ' +
        'reads its **Platform** / **Tier** rows, and cannot answer without them'
    ).toContain('darwin');
    expect(classified.size).toBeGreaterThan(2);
  });

  it('finds the platform comparisons it governs', () => {
    // Vacuity control on the CODE side.
    expect(
      comparisons().length,
      'no process.platform comparison was found under src/ — the detector no longer ' +
        'matches how this tree branches on platform, so this gate is measuring nothing'
    ).toBeGreaterThan(4);
  });

  it('names no platform the observation record does not classify', () => {
    const classified = classifiedPlatforms();
    const orphans = comparisons()
      .filter((comparison) => !classified.has(comparison.platform))
      .map(
        (comparison) =>
          `${comparison.file} branches on '${comparison.platform}', which no row of ` +
          `docs/operations/platform-observation-record.md classifies. Add a row giving its ` +
          `tier and the evidence behind it — shipping a branch for a platform the ` +
          `documents do not claim is what FR-R3-115 closed.`
      );
    expect([...new Set(orphans)]).toEqual([]);
  });

  it('does not read a comment as a branch', () => {
    // runtime-log-path.ts:36 says "We don't gate by `process.platform`" in prose.
    const stripped = stripCommentsKeepStrings(
      "// gate by process.platform === 'freebsd' one day\nconst x = 1;\n"
    );
    expect(stripped).not.toContain('freebsd');
  });

  it('does not blank string bodies (the FR-R3-114 vacuity trap)', () => {
    // The gate that inspired this assertion used codeOnly(), which blanked strings,
    // and the shape it forbade lived inside one. It read as coverage for months.
    const stripped = stripCommentsKeepStrings(
      "const cmd = \"process.platform === 'freebsd'\"; // a comment\n"
    );
    expect(stripped).toContain('freebsd');
    expect(stripped).not.toContain('a comment');
  });
});
