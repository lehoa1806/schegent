/**
 * FR-R3-109 — the secret scan is the scanner a reader thinks it is.
 *
 * WHAT THIS REPLACED. Four regular expressions (a PEM header, `AKIA…`, `gh[pousr]_…`,
 * `sk-ant-…`) over tracked files, with `tests/` and `package-lock.json` filtered out.
 * Meanwhile `@secretlint/node` sat in devDependencies **wired to nothing**, so a reader
 * inventorying the toolchain saw a real scanner and reasonably believed it scanned.
 * That is the class this round exists to close: a control whose presence implies an
 * enforcement that does not exist.
 *
 * THE EXCLUSION WAS THE WORST PART. `tests/` was skipped wholesale, so a real
 * credential pasted into a test file was invisible **by construction** — not missed,
 * excluded. Fixture secrets in tests are common and are legitimately allowlistable
 * **by entry**, which is a different thing from never looking. This scan reads the test
 * tree, and `.secretlintignore` carries per-entry reasons for the generated and binary
 * artifacts it skips.
 *
 * WHY IT MATTERS MORE NOW. `FR-R3-099` retired GitHub Actions, which took CodeQL with
 * it. Local static controls are the only static controls this project has.
 *
 * SCOPE. `git ls-files`, the same tracked-file set the previous scan used, so an
 * untracked scratch file is not scanned and a `node_modules` tree is never walked. The
 * measurement that justified this scoping is recorded in `SECURITY.md`.
 */
import { execFileSync } from 'node:child_process';
import { createEngine } from '@secretlint/node';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = resolve(ROOT, '.secretlintrc.json');
const IGNORE = resolve(ROOT, '.secretlintignore');

/** Tracked files only — the same scope the four-regex scan used. */
function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/**
 * The ignore list, as a set of prefix/suffix matchers.
 *
 * Deliberately a small matcher rather than a glob library: adding a dependency to a
 * security control that FR-R3-109 forbids adding dependencies to would be the wrong
 * kind of thorough. Every pattern in `.secretlintignore` is either `dir/**`, `*.ext`,
 * or a literal path, and those three are what this reads.
 */
function ignoreMatchers() {
  if (!existsSync(IGNORE)) return [];
  return readFileSync(IGNORE, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function isIgnored(file, patterns) {
  for (const pattern of patterns) {
    if (pattern.endsWith('/**')) {
      if (file.startsWith(pattern.slice(0, -2))) return true;
      continue;
    }
    if (pattern.startsWith('*.')) {
      if (file.endsWith(pattern.slice(1))) return true;
      continue;
    }
    if (file === pattern) return true;
  }
  return false;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!existsSync(CONFIG)) {
    console.error(`Secret scan cannot run: ${CONFIG} is missing. An unanswerable check is a refusal.`);
    process.exit(1);
  }

  const patterns = ignoreMatchers();
  const tracked = trackedFiles();
  const notIgnored = tracked.filter((file) => !isIgnored(file, patterns));
  // A file can be tracked in the index and absent from disk mid-change (a staged
  // deletion, a half-applied patch). A security gate that throws on that is a gate
  // that gets bypassed, so those are skipped -- and COUNTED, because a silent skip is
  // how a scan's scope quietly shrinks.
  const files = notIgnored.filter((file) => existsSync(resolve(ROOT, file)));
  const skipped = tracked.length - notIgnored.length;
  const absent = notIgnored.length - files.length;

  const engine = await createEngine({
    configFileJSON: JSON.parse(readFileSync(CONFIG, 'utf8')),
    formatter: 'stylish',
    color: false,
    cwd: ROOT
  });

  const result = await engine.executeOnFiles({
    filePathList: files.map((file) => resolve(ROOT, file))
  });

  // The scope is PRINTED on every run, pass or fail. A scan that says only "passed"
  // cannot be told apart from a scan that looked at nothing -- the vacuity defect this
  // repository measures rather than assumes.
  const summary =
    `Secret scan: secretlint over ${files.length} tracked file(s)` +
    (skipped > 0 ? `, ${skipped} skipped by .secretlintignore` : '') +
    (absent > 0 ? `, ${absent} tracked but absent from disk` : '') +
    ` (rules: preset-recommend, no-dotenv; tests/ INCLUDED).`;

  if (result.ok === false) {
    console.error(result.output);
    console.error(summary);
    console.error(
      'A finding that is a fixture rather than a leak is allowlisted BY ENTRY in ' +
        '.secretlintignore with a stated reason — never by excluding a directory.'
    );
    process.exit(1);
  }

  console.log(summary);
}
