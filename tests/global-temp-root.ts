import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Vitest `globalSetup` that gives a test run its own temp root instead of the
 * shared system one.
 *
 * The suite creates scratch directories through `os.tmpdir()` from 124 distinct
 * `mkdtemp` prefixes across 102 files. On a developer machine those land beside
 * every other tool's leftovers in `$TMPDIR`, and a saturated `$TMPDIR` degrades
 * directory operations enough to blow the 5 s test timeout: measured on
 * 2026-08-18, `concurrency-cap.test.ts` took 16.5 s and failed 3 of 5 against a
 * directory holding ~964,000 entries, and 2.1 s with all 5 passing against a
 * clean one — same code, no edits. The failures look like flakes in whichever
 * suites happen to be filesystem-heavy, which is why they were misread as such
 * for a while.
 *
 * `os.tmpdir()` is the single funnel every one of those prefixes passes through,
 * so pointing it at a per-run directory fixes all of them without touching a
 * test. Mocking the filesystem was the alternative and is the wrong trade here:
 * a large share of these tests exist to assert real syscall semantics —
 * `flag: 'wx'` (O_EXCL) exclusivity and rename atomicity in
 * `src/state/ownership-fs.ts`, archive-by-rename in the audit writer, and real
 * `git diff --binary` bytes in the checkpoint attribution tests — and a
 * JavaScript model of the filesystem cannot exhibit the divergences those tests
 * are looking for.
 */

/** Directory holding every run's root; also the git discovery ceiling. */
const TEMP_ROOT_DIR = '.tmp';

/** Only the fields this module reads, so it does not pin a vitest type. */
interface GlobalSetupContextLike {
  readonly config: { readonly root: string };
}

let runRoot: string | null = null;

export async function setup(ctx: GlobalSetupContextLike): Promise<void> {
  const parent = path.resolve(ctx.config.root, TEMP_ROOT_DIR);

  // Keyed by pid so a concurrent `test:e2e` or `test:evals` run cannot remove
  // this run's root out from under it in its own teardown.
  runRoot = path.join(parent, `vitest-${process.pid}`);
  await fs.mkdir(runRoot, { recursive: true });

  // `os.tmpdir()` reads TMPDIR on POSIX and TEMP/TMP on Windows; set all three
  // so the root holds on either platform.
  process.env.TMPDIR = runRoot;
  process.env.TMP = runRoot;
  process.env.TEMP = runRoot;

  // The root sits inside the repository's working tree, so a `git` command run
  // with its cwd in a scratch directory would otherwise discover *this*
  // repository by walking up. That is not a cosmetic difference: the checkpoint
  // service shells out to `git diff --binary HEAD`, and
  // `run-checkpoint-service.test.ts` deliberately builds a directory that is
  // *not* a repository to assert the capture failure — without a ceiling that
  // test would instead diff the developer's own uncommitted work and capture it
  // into a test artifact. The ceiling stops the upward search at the parent, so
  // scratch directories read as "not a git repository" exactly as they do under
  // the system temp dir.
  process.env.GIT_CEILING_DIRECTORIES = parent;
}

export async function teardown(): Promise<void> {
  if (runRoot === null) return;
  // Best effort: a leaked scratch directory is why this file exists, but a
  // teardown that throws would fail an otherwise green run.
  await fs.rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
  runRoot = null;
}
