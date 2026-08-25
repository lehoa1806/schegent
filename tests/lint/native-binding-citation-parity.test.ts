import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * FR-R3-083 (T1118) — every residual that says "this needs a native binding" must
 * point at the one record that decided whether the product will have one.
 *
 * WHY A GATE AND NOT A CONVENTION
 *
 * Before this feature the question was asked in three places and answered in none.
 * `safe-open.ts` called the `openat` walk "a stated follow-on". The migration
 * ledger called the same thing "a dependency decision and not this item's to
 * take". `process-tree.ts` said the Job Object "needs a native binding and is
 * stated as follow-on". Three descriptions of one question, drifting apart,
 * each true when written. `FR-R3-083` exists because filing them separately would
 * have asked that question a fourth time and answered it inconsistently again.
 *
 * WHAT THIS CHECKS, AND THE THREE WAYS IT HAS SEEN THINGS GO WRONG
 *
 *   1. A NEW residual site appears and nobody adds a citation. The discovery sweep
 *      below fails on an unclassified file, so a sixth site cannot appear silently.
 *      This is not hypothetical: the sweep found `metrics-rollup-writer.ts` and
 *      `raw-transcript-writer.ts` when it was first run, and both were sites the
 *      author of this feature had not listed.
 *   2. A citation is DELETED or edited away. Each discovered site is asserted to
 *      name the record.
 *   3. The record is RENAMED or MOVED. The cited path is resolved on disk, so a
 *      move fails here rather than leaving five links pointing nowhere.
 *
 * HERMETIC BY CONSTRUCTION (FR-R3-033, T1118a)
 *
 * The file set is resolved with `readdirSync`, never by spawning `rg` or `grep`.
 * Two gates in this directory once shelled out to `rg`, which appears in no
 * `devDependencies` and no workflow install step, and `npm run test:host` failed
 * on every machine without it — including the one a review ran on.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');

/** The one authority. Relative to the repository root so the resolve below is real. */
const RECORD_PATH = 'docs/architecture/native-binding-decision.md';

/**
 * The tokens that mean "a primitive this runtime does not reach".
 *
 * Deliberately CASE-SENSITIVE and domain-precise, because the obvious pattern is
 * wrong in both directions:
 *
 *   - `/openat/i` matches the identifier `openAt`, which appears in
 *     `parser/audit-log-parser.ts` and `tests/lint/visual-route-coverage.test.ts`
 *     as an ordinary index variable. A gate that flags those trains its readers to
 *     add exemptions.
 *   - A bare `reparse` matches the English verb — `webview-ui`'s phase-log export
 *     says "it does not reparse raw JSONL". The domain term is `reparse point` or
 *     `reparse tag`, and that is what is matched.
 *
 * The syscall names are lowercase because that is how a syscall is spelled; a
 * reader writing `OpenAt` is not naming `openat(2)`.
 */
const NATIVE_PRIMITIVE_TOKEN =
  /\bopenat\b|\brenameat\b|\bJob Object\b|\breparse[- ](?:point|tag)|FSCTL_GET_REPARSE_POINT|\bREPARSE\b/;

/** How a citation is recognised: the record's path, wherever it appears in the file. */
const CITATION = RECORD_PATH;

/** Where a residual may legitimately live. */
const SEARCH_ROOTS: readonly string[] = ['src', 'tests', 'webview-ui/src'];

const SKIP_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', 'dist', 'out', '.vite']);

function walk(dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // A search root that does not exist is not a failure of this gate; the
    // `finds any sites at all` assertion below is what catches a sweep that has
    // stopped seeing the tree.
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      walk(full, out);
      continue;
    }
    if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(full);
  }
}

/** Every file naming a primitive this runtime does not reach, repo-root-relative. */
function residualSites(): readonly string[] {
  const files: string[] = [];
  for (const root of SEARCH_ROOTS) walk(resolve(REPO_ROOT, root), files);
  return files
    .filter((file) => NATIVE_PRIMITIVE_TOKEN.test(readFileSync(file, 'utf8')))
    .map((file) => relative(REPO_ROOT, file).split(/[/\\]/).join('/'))
    .sort();
}

describe('native-binding citation parity (FR-R3-083)', () => {
  const sites = residualSites();

  it('finds residual sites at all', () => {
    // Without this the token pattern could stop matching -- after a rewording, say
    // -- and every assertion below would pass by finding nothing. The same
    // non-vacuity guard the migration ledger carries, for the same reason.
    expect(sites.length).toBeGreaterThan(2);
  });

  it('resolves the decision record on disk', () => {
    // Failure mode 3. Five citations pointing at a moved file is worse than none:
    // each one reads as a live reference.
    expect(existsSync(resolve(REPO_ROOT, ...RECORD_PATH.split('/')))).toBe(true);
  });

  it('has the record actually take the decision', () => {
    // A record that merely discusses the question cannot be what five sites rest
    // on. The permanence claims elsewhere in the tree are downstream of this word.
    const record = readFileSync(resolve(REPO_ROOT, ...RECORD_PATH.split('/')), 'utf8');
    expect(record).toContain('DECIDED');
    // Both branches must be present, or it is a preference with a date on it.
    expect(record).toContain('rejected');
  });

  it('has every residual site cite the record', () => {
    // Failure modes 1 and 2 together. An unclassified new site and a deleted
    // citation are the same observation from this gate's side: a file that names a
    // missing primitive and does not say where that question was settled.
    const uncited = sites.filter((site) => {
      const body = readFileSync(resolve(REPO_ROOT, ...site.split('/')), 'utf8');
      return !body.includes(CITATION);
    });
    // If this fails on a file you just wrote: cite
    // `docs/architecture/native-binding-decision.md` at the residual, or reword so
    // the file is not claiming a primitive this runtime does not reach.
    expect(uncited).toEqual([]);
  });
});
