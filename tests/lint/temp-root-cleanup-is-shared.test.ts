// One race, one answer.
//
// Removing a test scratch directory while a Run is still writing to it fails
// with ENOTEMPTY (or EBUSY/EACCES, platform depending). It is a teardown race:
// the assertions have already passed. Several suites assert that something
// *starts* and deliberately do not wait for it to finish, so a run still writing
// at teardown is the behaviour under test.
//
// On 2026-08-23 that one race had been solved independently six ways across nine
// files — `maxRetries: 10`; `maxRetries: 10, retryDelay: 50`; a hand-rolled
// three-attempt loop copy-pasted byte-identically into three files, giving 75ms
// of tolerance where 500ms was needed; a bare `rm` with no retry; and
// `.catch(() => undefined)`, which does not tolerate the race so much as hide
// it. That last one is the reason this gate exists rather than a code comment:
// a swallowed cleanup failure leaks a temp root silently, and a leftover `.tmp/`
// from a crashed run was packaged into the VSIX the same day.
//
// `removeTempRoot()` in `tests/temp-root-cleanup.ts` is now the single answer,
// and this gate keeps it single.
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const TESTS_ROOT = resolve(REPO_ROOT, 'tests');
const HELPER = 'tests/temp-root-cleanup.ts';

const rel = (abs: string): string => relative(REPO_ROOT, abs).replaceAll('\\', '/');

/**
 * Files permitted to spell the removal themselves.
 *
 * The helper obviously may. `global-temp-root.ts` is the vitest `globalSetup`
 * that owns the run root itself: it runs after every worker has exited, so there
 * is nothing left writing and nothing to race.
 */
const SELF = 'tests/lint/temp-root-cleanup-is-shared.test.ts';

const ALLOWED: ReadonlySet<string> = new Set([
  HELPER,
  // The vitest `globalSetup` that owns the run root. It runs after every worker
  // has exited, so there is nothing left writing and nothing to race.
  'tests/global-temp-root.ts',
  // This file quotes every forbidden variant as a fixture, to prove the patterns
  // still match. Excluded by name rather than by a pattern carve-out, which
  // would weaken the rule for everyone.
  SELF
]);

function testSources(): readonly string[] {
  return filesUnder(TESTS_ROOT, { extensions: ['.ts'] }).map(rel).sort();
}

/** A recursive `rm` that also passes retry options — i.e. a hand-spelled fix. */
const HAND_ROLLED_RETRY = /rm\([^)]*recursive:\s*true[^)]*maxRetries/;

/** A recursive `rm` whose failure is discarded. */
const SWALLOWED = /rm\([^)]*recursive:\s*true[^)]*\)\s*\.catch\(/;

/** A retry loop keyed on the error codes this race produces. */
const RETRY_LOOP = /code\s*!==\s*'ENOTEMPTY'|catch[\s\S]{0,200}ENOTEMPTY[\s\S]{0,200}setTimeout/;

describe('temp-root cleanup has one implementation', () => {
  it('scans the test tree, so a broken scan cannot read as compliance', () => {
    const sources = testSources();
    expect(
      sources.length,
      `No .ts files found under ${TESTS_ROOT}. Every assertion below is passing ` +
        `over an empty file list.`
    ).toBeGreaterThan(400);
    // The helper must exist and must be reachable by the scan — if it is
    // renamed, the assertions below start allowing what they exist to forbid.
    expect(
      sources,
      `${HELPER} was not found. The shared cleanup helper has moved, and every ` +
        `assertion below is now enforcing a rule against a file that is gone.`
    ).toContain(HELPER);
  });

  it('nobody hand-rolls the retry that removeTempRoot() already does', () => {
    const offenders = testSources().filter((file) => {
      if (ALLOWED.has(file)) return false;
      const src = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      return HAND_ROLLED_RETRY.test(src) || SWALLOWED.test(src) || RETRY_LOOP.test(src);
    });
    expect(
      offenders,
      `These spell the temp-root teardown race themselves:\n  ${offenders.join('\n  ')}\n\n` +
        `Use \`removeTempRoot()\` from ${HELPER}. It is not about tidiness: the ` +
        `hand-rolled variants that existed gave 75ms of tolerance where 500ms was ` +
        `needed, and one discarded the failure entirely, which turns a loud test ` +
        `failure into a silent disk leak.`
    ).toEqual([]);
  });

  it('the patterns recognise each variant that actually existed here', () => {
    // Every string below was in this repo on 2026-08-23. Without this, a pattern
    // edit that stops matching is indistinguishable from a tree that complies —
    // the failure mode the rest of tests/lint/ now guards against by default.
    expect(HAND_ROLLED_RETRY.test('await fs.rm(d, { recursive: true, force: true, maxRetries: 10 });')).toBe(true);
    expect(SWALLOWED.test('await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);')).toBe(true);
    expect(RETRY_LOOP.test("if (code !== 'ENOTEMPTY' && code !== 'EBUSY') throw err;")).toBe(true);
    // And the sanctioned call is not mistaken for any of them.
    const sanctioned = 'await removeTempRoot(tmpRoot);';
    expect(HAND_ROLLED_RETRY.test(sanctioned)).toBe(false);
    expect(SWALLOWED.test(sanctioned)).toBe(false);
    expect(RETRY_LOOP.test(sanctioned)).toBe(false);
    // A plain recursive rm is NOT forbidden: most are not teardown of a live
    // run, and a rule that flagged all 134 would be noise rather than a gate.
    expect(HAND_ROLLED_RETRY.test('await fs.rm(d, { recursive: true, force: true });')).toBe(false);
  });
});
