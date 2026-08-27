import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * FR-R3-118 / FR-049 — no file under `repo/tests/` may read above `REPO_ROOT`
 * without first asking whether the planning envelope is there.
 *
 * WHY THIS GATE EXISTS, and what measuring it actually found.
 *
 * `FR-R3-118` reported one defect: `spec-traceability-governance.test.ts` read the
 * envelope unguarded and raised ENOENT in a standalone clone, and nine siblings
 * did it correctly. Running the suite in a real envelope-free clone — rather than
 * grepping for the guard — found that the register undercounted twice over:
 *
 *   * **Eleven** gates reach above `REPO_ROOT`, not ten. Two of them
 *     (`source-marker-targets`, `actions-retirement-claims`) name their root
 *     `ENVELOPE` rather than `ENVELOPE_ROOT`, so a search for the latter missed
 *     them. That is precisely why this gate matches on the READ, not on the name
 *     of the constant.
 *   * **Four** misbehaved, not one — and two of them in a worse shape than the
 *     throw that was reported. `eslint-baseline` and `source-loc-budget` guarded
 *     their reads and then judged the missing envelope as a defect in the
 *     repository: `an owner that cannot be resolved is an unowned entry`, and
 *     `waiver needs ... a reference that resolves on disk`. Six and one confident,
 *     actionable, wrong accusations. A crash announces itself as a rig problem; a
 *     false accusation announces itself as a repo problem, and someone acts on it.
 *
 * So the rule this gate enforces is narrow and mechanical — a parent-reaching read
 * must be reachable only behind an envelope check — because the broader rule (do
 * not judge an absence you cannot see) is not mechanically checkable, and a gate
 * that claims to enforce it would be overstating itself.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');
const TESTS_ROOT = resolve(REPO_ROOT, 'tests');

/** Files allowed to reach the parent freely: the predicate itself. */
const ALLOWED = new Set(['tests/lint/envelope-presence.ts']);

/**
 * Tokens that show a file has asked the question. `envelopePresent` is the
 * canonical predicate; the rest are the shapes the siblings independently arrived
 * at before it existed, kept accepted so this gate reports genuinely unguarded
 * reads rather than churning correct code into one house style.
 */
const GUARD_TOKENS = ['envelopePresent', 'existsSync', 'statSync', 'try {', 'skipIf'] as const;

/**
 * Root constants, and where they actually point.
 *
 * An earlier version of this gate matched `resolve(X, '..')` textually and flagged
 * `LINT_DIR = resolve(__dirname, '..')` — which is `tests/lint`, nowhere near the
 * parent of the repository. Textual depth is not depth. So the constants are
 * RESOLVED against the file's real directory and compared to `REPO_ROOT`, and only
 * a constant that lands strictly above it counts.
 */
const ROOT_DECL =
  /^\s*(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:path\.)?resolve\(\s*([^)]*?)\s*\)/gm;

/** Resolve one `resolve(...)` argument list, given the file's directory and the roots so far. */
function resolveArgs(
  args: string,
  dir: string,
  known: ReadonlyMap<string, string>
): string | null {
  const parts = args.split(',').map((part) => part.trim());
  let base: string | null = null;
  const segments: string[] = [];
  for (const part of parts) {
    if (part === '__dirname') {
      if (base !== null) return null;
      base = dir;
      continue;
    }
    const literal = /^'([^']*)'$/.exec(part);
    if (literal) {
      segments.push(literal[1]!);
      continue;
    }
    const named = known.get(part);
    if (named !== undefined && base === null && segments.length === 0) {
      base = named;
      continue;
    }
    return null;
  }
  if (base === null) return null;
  return resolve(base, ...segments);
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

interface ParentReader {
  readonly file: string;
  readonly rootName: string;
  readonly guarded: boolean;
}

/** True when `candidate` is strictly above the execution repository. */
function isAboveRepoRoot(candidate: string): boolean {
  const rel = relative(candidate, REPO_ROOT);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function parentReaders(): readonly ParentReader[] {
  const found: ParentReader[] = [];
  for (const absolute of sourceFiles(TESTS_ROOT)) {
    const file = relative(REPO_ROOT, absolute).split(/[/\\]/).join('/');
    if (ALLOWED.has(file)) continue;
    const body = readFileSync(absolute, 'utf8');
    const dir = dirname(absolute);
    const known = new Map<string, string>();
    ROOT_DECL.lastIndex = 0;
    for (const match of body.matchAll(ROOT_DECL)) {
      const name = match[1]!;
      const resolved = resolveArgs(match[2]!, dir, known);
      if (resolved === null) continue;
      known.set(name, resolved);
      if (!isAboveRepoRoot(resolved)) continue;
      // A declared-but-unread root is not a parent read.
      const usedIndirectly = new RegExp(`(?:resolve|join)\\(\\s*${name}\\s*,`).test(body);
      if (!usedIndirectly) continue;
      found.push({
        file,
        rootName: name,
        guarded: GUARD_TOKENS.some((token) => body.includes(token))
      });
    }
  }
  return found;
}

describe('no test reads above REPO_ROOT without an envelope guard (FR-R3-118)', () => {
  const readers = parentReaders();

  it('finds the parent-reaching gates it governs', () => {
    // Vacuity control. Every assertion below filters `readers` and expects nothing
    // left, so an empty list would pass them all — and this gate exists precisely
    // because a search that quietly matched nothing is how the two `ENVELOPE`-named
    // gates went unnoticed in the first place.
    expect(
      readers.length,
      'no parent-reaching read was found under tests/ — the detection regex no longer ' +
        'matches how a root above REPO_ROOT is declared, so this gate is measuring nothing.'
    ).toBeGreaterThan(8);
  });

  it('leaves no parent-reaching read unguarded', () => {
    const unguarded = readers
      .filter((reader) => !reader.guarded)
      .map(
        (reader) =>
          `${reader.file}: reads through ${reader.rootName} (one level above REPO_ROOT) with no ` +
          `envelope check. A standalone execution-repository clone has no planning envelope, and ` +
          `an unguarded read there raises ENOENT — which takes down vitest, test:host, verify:all ` +
          `and gate, making a release uncuttable from a clone the README promises can build and ` +
          `test. Import envelopePresent from tests/lint/envelope-presence and branch on it.`
      );
    expect(unguarded).toEqual([]);
  });
});
