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
 *
 * STAGED MODE (FR-R4-F10). `--staged` scans what a commit would carry, read from the Git index
 * and not from the working tree: a secret staged and then edited out of the working copy passes
 * the tree scan and is committed. The scope, the blob reads and the temporary directory live in
 * `secret-scan-staged.mjs`; this file keeps the dispatch, the engine and the four outcome lines
 * (passed, finding, nothing staged needed scanning, cannot run). Any other argument is refused.
 * An error anywhere in staged mode is a refusal, never a pass.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokedAsScript } from './invoked-as-script.mjs';
import { StagedRefusal, collectStagedSubject, withStagedFiles } from './secret-scan-staged.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = resolve(ROOT, '.secretlintrc.json');
const IGNORE = resolve(ROOT, '.secretlintignore');

/**
 * Tracked files only — the same scope the four-regex scan used. NUL-separated, because without
 * `-z` git quotes a name holding a byte outside printable ASCII, a double quote or a backslash,
 * and the quoted form names no file: the scan counted such a file absent and never read it.
 */
function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
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

/** The rules the summary lines name, so tree and staged mode cannot disagree about them. */
const RULES_SUMMARY = 'preset-recommend (aws id scan on), no-dotenv, schegent local rule';
const ALLOWLIST_REMINDER =
  'A finding that is a fixture rather than a leak is allowlisted BY ENTRY in ' +
  '.secretlintignore with a stated reason — never by excluding a directory.';
const STAGED_DIRECTORY = /\S*schegent-staged-scan-[A-Za-z0-9]+\/?/g;
const DETAIL_LIMIT = 200;
const LOAD_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The configuration with every rule id that begins `./` resolved against `root`, because the
 * engine's loader resolves a package name or an absolute path and nothing relative. Other ids pass
 * through unchanged. An id that resolves outside `root` is a refusal (`config-unparseable`): a
 * configuration must not make the scan load code from elsewhere. Rules nested in a preset are
 * resolved too. The input is not modified.
 */
function resolveLocalRuleIds(configJson, root) {
  const resolveEntry = (entry) => {
    if (entry === null || typeof entry !== 'object') return entry;
    const resolved = { ...entry };
    if (typeof entry.id === 'string' && entry.id.startsWith('./')) {
      const absolute = resolve(root, entry.id);
      const inside = relative(root, absolute);
      if (inside.startsWith('..') || isAbsolute(inside)) {
        throw new StagedRefusal('config-unparseable', 'a rule id in the configuration resolves outside the repository');
      }
      resolved.id = absolute;
    }
    if (Array.isArray(entry.rules)) resolved.rules = entry.rules.map(resolveEntry);
    return resolved;
  };
  return resolveEntry(configJson);
}

/**
 * The engine's `createEngine`, loaded when a scan needs it and not when this module links. A static
 * import made an engine package that would not load (a clone before `npm ci`, a damaged install)
 * stop the module before any of it ran: Node's own error, trace and exit code, and none of the
 * refusal lines that contract SS5 and `SECURITY.md` describe. A failure here is the `engine-failed`
 * refusal in both modes. The line carries Node's error code and never its message, which names a path.
 */
async function loadCreateEngine() {
  try {
    const { createEngine } = await import('@secretlint/node');
    return createEngine;
  } catch (error) {
    const code = typeof error?.code === 'string' && LOAD_ERROR_CODE.test(error.code) ? error.code : 'unknown';
    throw new StagedRefusal('engine-failed', `the secretlint engine package could not be loaded (${code})`);
  }
}

/** A diagnostic fragment with control characters, the staged directory's path and excess length removed. */
function sanitizedDetail(text) {
  return String(text)
    .replace(STAGED_DIRECTORY, '')
    .replace(/[^\x20-\x7e]/g, ' ')
    .trim()
    .slice(0, DETAIL_LIMIT);
}

/** The engine's report with the temporary directory replaced by the repository-relative form. */
function repositoryRelative(text, dir) {
  return text.split(`${dir}/`).join('').split(dir).join('.').replace(STAGED_DIRECTORY, '<staged>');
}

/** The scope a staged outcome line prints: what was read against which base, and each counted skip. */
function stagedScope(subject) {
  const parts = [`${subject.scan.length} path(s) scanned against ${subject.base === 'HEAD' ? 'HEAD' : 'empty tree'}`];
  for (const cause of ['ignored', 'deleted', 'gitlink', 'unchanged']) {
    if (subject.skipped[cause] > 0) parts.push(`${subject.skipped[cause]} ${cause}`);
  }
  return parts.join(', ');
}

/** Print the refusal line for any throw and return exit code 1. Nothing after a throw may print a pass. */
function refuseStaged(error) {
  const cause = error instanceof StagedRefusal ? error.cause : 'engine-failed';
  const detail = sanitizedDetail(error instanceof StagedRefusal ? error.detail : (error?.message ?? 'unknown error'));
  console.error(
    `Secret scan (staged) cannot run: ${cause}: ${detail}. An unanswerable check is a refusal.`
  );
  return 1;
}

/** Staged mode: scan what the index would commit. Returns the process exit code. */
async function runStaged() {
  try {
    // First, so that an engine which will not load refuses every commit, as it did when it was imported at link time.
    const createEngine = await loadCreateEngine();
    const subject = collectStagedSubject(ROOT, isIgnored);
    const scope = stagedScope(subject);
    if (subject.scan.length === 0) {
      console.log(`Secret scan (staged): nothing staged needed scanning; ${scope}.`);
      return 0;
    }
    const configFileJSON = resolveLocalRuleIds(subject.config, ROOT);
    const result = await withStagedFiles(subject, async (dir, paths) => {
      const engine = await createEngine({
        configFileJSON,
        formatter: 'stylish',
        color: false,
        maskSecrets: true,
        cwd: dir
      });
      const executed = await engine.executeOnFiles({ filePathList: paths });
      return { ok: executed.ok, output: repositoryRelative(executed.output, dir) };
    });
    const line = `${scope}; rules: ${RULES_SUMMARY}.`;
    if (result.ok === false) {
      console.error(result.output);
      console.error(`Secret scan (staged): FINDING; ${line}`);
      console.error(ALLOWLIST_REMINDER);
      return 1;
    }
    console.log(`Secret scan (staged): passed; ${line}`);
    return 0;
  } catch (error) {
    return refuseStaged(error);
  }
}

/**
 * The exit code of every invocation that is not tree mode: `--staged` runs, and any other argument
 * is refused before a git call is made. Tree mode is the invocation with no argument.
 */
async function runAnotherMode(args) {
  if (args.length === 1 && args.at(0) === '--staged') return runStaged();
  console.error(
    `Secret scan cannot run: unknown-argument: ${sanitizedDetail(args.join(' '))}. ` +
      'Accepted: no argument (tree mode) or --staged. An unanswerable check is a refusal.'
  );
  return 1;
}

if (invokedAsScript(import.meta.url)) {
  // FR-R4-F10: an argument selects another mode and ends here. No argument is tree mode, below.
  const args = process.argv.slice(2);
  if (args.length > 0) process.exit(await runAnotherMode(args));

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
  const unread =
    (skipped > 0 ? `, ${skipped} skipped by .secretlintignore` : '') +
    (absent > 0 ? `, ${absent} tracked but absent from disk` : '');

  // A scan over no file finds nothing and would print a summary that reads like a pass. Outside
  // a repository of its own, such as an archive unpacked inside a repository that does not track
  // it, `git ls-files` exits 0 and prints nothing, so this is refused like a missing config.
  if (files.length === 0) {
    console.error(
      `Secret scan cannot run: no tracked file to scan under ${ROOT}${unread}. ` +
        'An unanswerable check is a refusal.'
    );
    process.exit(1);
  }

  let treeConfigJson;
  try {
    treeConfigJson = resolveLocalRuleIds(JSON.parse(readFileSync(CONFIG, 'utf8')), ROOT);
  } catch (error) {
    if (!(error instanceof StagedRefusal)) throw error;
    console.error(`Secret scan cannot run: ${error.cause}: ${error.detail}. An unanswerable check is a refusal.`);
    process.exit(1);
  }

  let createEngine;
  try {
    createEngine = await loadCreateEngine();
  } catch (error) {
    if (!(error instanceof StagedRefusal)) throw error;
    console.error(`Secret scan cannot run: ${error.cause}: ${error.detail}. An unanswerable check is a refusal.`);
    process.exit(1);
  }

  const engine = await createEngine({
    configFileJSON: treeConfigJson,
    formatter: 'stylish',
    color: false,
    // The type declarations say masking is the default, but the core reads
    // `maskSecrets ?? false` (as installed, 10.2.2), so a report line carried the matched value into the
    // terminal and into any log that keeps it. The rule and the location are enough to act on.
    maskSecrets: true,
    cwd: ROOT
  });

  const result = await engine.executeOnFiles({
    filePathList: files.map((file) => resolve(ROOT, file))
  });

  // The scope is PRINTED on every run, pass or fail. A scan that says only "passed"
  // cannot be told apart from a scan that looked at nothing -- the vacuity defect this
  // repository measures rather than assumes.
  const summary =
    `Secret scan: secretlint over ${files.length} tracked file(s)${unread}` +
    ` (rules: ${RULES_SUMMARY}; tests/ INCLUDED).`;

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
