#!/usr/bin/env node
// FR-R3-065 — `test:visual` needs a browser no document declared.
//
// THE INCIDENT
//
// On a checkout whose Playwright browser cache is absent or a revision behind,
// every case in the visual suite failed with the same
// `browserType.launch: Executable doesn't exist` error, and the remedy appeared
// only inside a stack trace. `ci:fast` therefore went red on an undeclared
// dependency — which is precisely the failure VER-2 / FR-R3-033 exists to
// remove, reached again through a different binary.
//
// The measured trigger was NOT a first clone. It was a version bump: the
// installed build was one revision behind what the toolchain resolved, so a
// cache that had worked for months stopped working. Any Playwright bump
// re-breaks it, which is why the prerequisite is now declared in CONTRIBUTING
// and developer-workflows, and why a parity gate keeps that declaration true.
//
// WHAT THIS DOES
//
// One filesystem check, before the runner starts. Present: silence, exit 0.
// Absent: one message naming the missing revision, the path it looked for, and
// the command that fixes it — then a non-zero exit.
//
// WHY A WRAPPER AND NOT A globalSetup HOOK
//
// Playwright launches the browser per worker, so a config-level or
// `globalSetup` failure is still reported through the runner's own machinery,
// interleaved with the runner's output. The npm script is the only place that
// is unambiguously *before* the runner, and reporting before the runner is the
// entire point: eighteen red cases read as eighteen broken tests.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
//   - It does not install. Tempting and wrong, for the reason FR-R3-045
//     declined to put the Electron download in `ci:fast`: a gate that downloads
//     ~95 MiB on first use makes the preflight's cost unpredictable and hides
//     the dependency instead of declaring it. CI installs it as an explicit
//     step; a contributor runs it once.
//   - It does not skip the suite, and it never exits 0 on a missing browser. A
//     visual gate that quietly does not run is worse than one that fails loudly
//     — the FR-R3-045 vacuity rule, unchanged.
//   - It checks EXISTENCE, not integrity. A truncated or corrupt executable
//     passes here and fails at launch. Detecting that needs a launch, which is
//     the cost this whole design avoids. Stated rather than implied.
//   - It checks CHROMIUM only, because that is the only browser
//     `playwright.config.ts` uses. `playwright-install-doc-parity` asserts that
//     correspondence against the script's CODE, so adding a second browser to
//     the config cannot leave it unchecked here — a comment claiming coverage
//     does not satisfy it. Chromium means both of Chromium's builds: the headed
//     one and the headless shell a headless launch actually starts. One install
//     command provisions both, so the remedy stays one line.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, basename, join } from 'node:path';
// `@playwright/test` is the dependency package.json declares. `playwright-core`
// is only reachable through it, so importing it directly would make this script
// depend on a hoisted transitive package — an undeclared dependency, which is
// the class of defect this preflight exists to remove.
import { chromium } from '@playwright/test';

/**
 * Stable marker on every failure line.
 *
 * A setup failure and a visual diff have to be distinguishable from the FIRST
 * line of output (FR-008) — the original defect was output that misdirected, and
 * a gate whose red output misleads is one people learn to skip. The marker also
 * gives the behaviour gate something to assert other than prose, so rewording
 * these sentences cannot break a test.
 */
const MARKER = 'visual-preflight:';

/** The command a contributor runs. Kept version-agnostic on purpose: pinning a
 * version here would need editing on every bump, which is the drift the parity
 * gate exists to catch. */
const INSTALL_COMMAND = 'npx playwright install chromium';

function fail(lines) {
  for (const line of lines) process.stderr.write(`${MARKER} ${line}\n`);
  process.exit(1);
}

/**
 * Where the suite will actually look.
 *
 * Asked of the toolchain, never reconstructed. A hardcoded cache layout would
 * be a second undeclared assumption — and worse, it would pass while the suite
 * still failed whenever `PLAYWRIGHT_BROWSERS_PATH` redirects the cache.
 */
function resolveExpectedExecutable() {
  let resolved;
  try {
    // Throws, not returns empty, when the toolchain has no build for this
    // platform ("Browser is not supported on current platform"). An uncaught
    // throw here would put the remedy back inside a stack trace, which is the
    // defect this script exists to remove — so it lands on the indeterminate
    // branch instead.
    resolved = chromium.executablePath();
  } catch {
    return null;
  }
  if (typeof resolved !== 'string' || resolved.length === 0) {
    return null;
  }
  return resolved;
}

/** Cache directory prefix of the headless shell download. See `resolveShell`. */
const SHELL_PREFIX = 'chromium_headless_shell-';

/**
 * The headless shell's own revision, from the toolchain's manifest.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A RECONSTRUCTION
 *
 * `resolveShell` used to build the shell's directory name by pasting the HEADED
 * revision after `SHELL_PREFIX`. That worked only while the two revisions agree,
 * and `browsers.json` declares them as SEPARATE entries with INDEPENDENT
 * `revision` fields — measured: `chromium` and `chromium-headless-shell` both at
 * 1234 today, and the tip-of-tree pair both at 1433, so they track within a
 * channel but nothing structurally ties them. A release that rolled them apart
 * would have made this preflight fail on a CORRECTLY provisioned checkout, with
 * a remedy that could not fix it — the worst failure a gate can have.
 *
 * So the revision is read rather than guessed. `browsers.json` is not an exported
 * path, but `playwright-core/package.json` is, so it is reached through that
 * anchor — and resolved from `@playwright/test`, the package this project
 * actually declares, so this does not quietly depend on a hoisted transitive
 * package (the defect review caught in the first draft of this file).
 *
 * Returns null when the manifest cannot be read or does not name the shell. The
 * caller degrades rather than failing: see `resolveShell`.
 */
function readShellRevision() {
  try {
    const fromHere = createRequire(import.meta.url);
    const testPkg = fromHere.resolve('@playwright/test/package.json');
    const fromTest = createRequire(testPkg);
    const corePkg = fromTest.resolve('playwright-core/package.json');
    const manifest = JSON.parse(readFileSync(join(dirname(corePkg), 'browsers.json'), 'utf8'));
    const entry = (manifest.browsers ?? []).find(
      (browser) => browser.name === 'chromium-headless-shell'
    );
    const revision = entry?.revision;
    return typeof revision === 'string' || typeof revision === 'number' ? String(revision) : null;
  } catch {
    return null;
  }
}

/** …/<root>/chromium-<rev>/<platform>/… — walk up to the revision segment. */
function findRevisionDir(executablePath) {
  let current = executablePath;
  while (current !== dirname(current)) {
    if (basename(current).startsWith('chromium-')) {
      return current;
    }
    current = dirname(current);
  }
  return null;
}

/**
 * Has this machine ever installed a Chromium build?
 *
 * The revision is a path segment (`chromium-1234`), so a cache that holds any
 * other revision means the contributor HAS run the install and needs to run it
 * AGAIN. "Install it" and "install it again" are different instructions to
 * someone who believes they already did, and the version-bump trigger makes the
 * second case the common one.
 *
 * The same argument reaches one state further: the directory for the resolved
 * revision can itself be present with no executable inside it, which an
 * interrupted install or a cache provisioned for another platform leaves. That
 * is reported separately for the same reason the shell-only case is.
 */
function describeCacheState(executablePath) {
  const revisionDir = findRevisionDir(executablePath);
  if (revisionDir === null) {
    return { revision: null, revisionDirPresent: false, siblings: [], shells: [] };
  }
  const revision = basename(revisionDir);
  let entries = [];
  try {
    entries = readdirSync(dirname(revisionDir));
  } catch {
    // The cache root does not exist at all, which is the never-installed case.
    // An unreadable directory lands here too and is treated the same way: the
    // remedy is identical, and guessing between them would add a sentence
    // nobody can act on differently.
    entries = [];
  }
  return {
    revision,
    // The directory for the very revision we resolved, sitting there without the
    // executable inside it. That is an interrupted install or one made for
    // another platform — not an empty cache — and it is the state a reader is
    // most likely to be looking at while being told they have never installed.
    revisionDirPresent: entries.includes(revision),
    siblings: entries.filter((entry) => entry.startsWith('chromium-') && entry !== revision),
    // A shell build with no headed build beside it is NOT a never-provisioned
    // cache: it is what `--only-shell` and an interrupted install leave behind.
    // Telling someone staring at a populated cache that they have never
    // installed is the same misdirection this preflight exists to remove.
    shells: entries.filter((entry) => entry.startsWith(SHELL_PREFIX))
  };
}

/** The one sentence that says which of the four cache states this is. */
function describeInstalledState(state) {
  if (state.revisionDirPresent) {
    // Most specific, so it wins over the sibling and shell branches: whatever
    // else the cache holds, the directory for the needed revision is right
    // there and the executable is not. Measured 2026-08-24 on darwin/arm64
    // against a cache holding an empty `chromium-1234`: the fallback sentence
    // below reported "never been provisioned" to a reader who could see it.
    return (
      `The directory for that build (${state.revision}) is present but the executable inside it is ` +
      'not, so this cache came from an interrupted install or one provisioned for a different ' +
      'platform rather than from no install at all. Running the install again replaces it.'
    );
  }
  if (state.siblings.length > 0) {
    return (
      `A different build is present (${state.siblings.sort().join(', ')}), so this is a STALE cache — ` +
      'you have installed before and a Playwright version bump has moved the target. Run the ' +
      'install again.'
    );
  }
  if (state.shells.length > 0) {
    return (
      `A headless-shell build is present (${state.shells.sort().join(', ')}) but the headed build ` +
      'beside it is absent, so this cache came from a shell-only or interrupted install rather than ' +
      'from no install at all. The command below provisions both.'
    );
  }
  return 'No Chromium build is present, so this cache has never been provisioned.';
}

/**
 * The build a HEADLESS launch actually starts.
 *
 * `playwright.config.ts` sets no `channel` and does not turn headless off, and
 * for that combination Playwright resolves `chromium-headless-shell` — a
 * SEPARATE download from the headed build above, cached as
 * `chromium_headless_shell-<rev>` beside it. `executablePath()` on the browser
 * type returns the HEADED path, so checking only that answers a question the
 * suite never asks: measured 2026-08-24 on darwin/arm64, a cache holding
 * `chromium-1234` and no shell passed the check and then failed at launch with
 * the exact `browserType.launch: Executable doesn't exist` error this preflight
 * exists to pre-empt.
 *
 * The one documented install command provisions both, so the remedy is
 * unchanged; what changes is that a half-finished or `--no-shell` install is
 * caught here instead of eighteen cases later.
 *
 * Directory-level existence, deliberately: the shell executable's leaf name
 * differs per platform (`chrome-headless-shell`, `headless_shell`, `.exe`), and
 * reproducing that table here would be the hardcoded cache layout
 * `resolveExpectedExecutable` refuses to carry. Consistent with checking
 * EXISTENCE and not integrity.
 *
 * THREE RESIDUALS, EACH DELIBERATE, EACH REVIEWED
 *
 * 1. A HEADED BUILD IS STILL REQUIRED, even though a headless run starts only the
 *    shell. So `npx playwright install --only-shell chromium` produces a cache the
 *    suite would run on and this preflight rejects. Kept because the design
 *    commits to ONE documented remedy that provisions both builds: a contributor
 *    who followed the documentation is never in that state, and a preflight that
 *    over-reports with an actionable remedy is a smaller harm than one that
 *    under-reports and lets the suite fail at launch. If `--only-shell` ever
 *    becomes the documented command, this condition is what has to change.
 *
 * 2. AN INDETERMINATE SHELL RESOLUTION EXITS 0, unlike the headed path, which
 *    fails. The asymmetry is deliberate and worth stating because it is the one
 *    place this script relaxes its own rule. `resolveShell` returns null only
 *    when the headed executable EXISTS but its path carries no `chromium-<rev>`
 *    segment — a cache layout this file does not recognise. Failing there would
 *    turn a correctly provisioned checkout red with a remedy that cannot fix it,
 *    for a layout change that has not happened; exiting 0 lets the suite reach
 *    its own launch error, which is worse output but a true report.
 *
 * 3. AN UNREADABLE MANIFEST DEGRADES THE SHELL CHECK rather than failing it. When
 *    `readShellRevision` returns null there is no authoritative revision to
 *    demand, so any populated shell build satisfies the check and a shell at the
 *    wrong revision would pass. Same reasoning as 2: a script that cannot find a
 *    file must not fail a checkout whose only fault is that. The headed check
 *    still catches a stale pair, and the message says the revision is unknown
 *    rather than naming one it guessed.
 *
 *    This replaces the residual that used to sit here. The shell's directory name
 *    was RECONSTRUCTED from the headed revision, which would have failed a
 *    correctly provisioned checkout the first time upstream rolled the two
 *    revisions apart — `browsers.json` declares them as separate entries with
 *    independent `revision` fields. It is now read from that manifest. Recorded
 *    because "watch this, it has not happened yet" is a weaker thing to leave
 *    behind than a fix, and the fix was available.
 */
function resolveShell(executablePath) {
  const revisionDir = findRevisionDir(executablePath);
  if (revisionDir === null) {
    // The layout this walk assumes is gone. Nothing to claim either way, and
    // the headed check above has already spoken.
    return null;
  }
  const root = dirname(revisionDir);
  let entries = [];
  try {
    entries = readdirSync(root);
  } catch {
    entries = [];
  }
  const nonEmpty = (entry) => {
    try {
      // Non-empty, so an interrupted download that left the directory behind
      // does not read as a provisioned one.
      return readdirSync(join(root, entry)).length > 0;
    } catch {
      return false;
    }
  };

  const revision = readShellRevision();
  if (revision === null) {
    // The manifest could not be read, so there is no authoritative revision to
    // demand. DEGRADE rather than guess: any populated shell build satisfies the
    // check. That is weaker — a shell at the wrong revision would pass — and it
    // is the right trade, because the alternative is reconstructing a name that
    // may not exist and failing a checkout whose only fault is that this script
    // could not find a file. The headed check above still catches a stale pair.
    const anyShell = entries.filter((entry) => entry.startsWith(SHELL_PREFIX));
    const populated = anyShell.filter(nonEmpty);
    return {
      expectedDir: join(root, `${SHELL_PREFIX}<revision unknown>`),
      present: populated.length > 0,
      others: [],
      revisionKnown: false
    };
  }

  const name = `${SHELL_PREFIX}${revision}`;
  return {
    expectedDir: join(root, name),
    present: entries.includes(name) && nonEmpty(name),
    others: entries.filter((entry) => entry.startsWith(SHELL_PREFIX) && entry !== name),
    revisionKnown: true
  };
}

const expected = resolveExpectedExecutable();

if (expected === null) {
  // Indeterminate, so FAIL. An inconclusive preflight that reports success is
  // the vacuity this script exists to prevent: it would let the suite launch
  // and fail eighteen times, having promised it had checked.
  fail([
    'could not resolve the expected Chromium executable from the Playwright toolchain.',
    "This is a preflight failure, not a visual regression. The toolchain's browser",
    'resolution may have changed shape. Refusing to assume the browser is present.',
    `To provision the browser: ${INSTALL_COMMAND}`
  ]);
}

if (existsSync(expected)) {
  const shell = resolveShell(expected);
  if (shell !== null && !shell.present) {
    fail([
      `the Chromium headless-shell build this suite launches (${basename(shell.expectedDir)}) is missing.`,
      'This is a preflight failure, not a visual regression.',
      shell.others.length > 0
        ? `A different shell build is present (${shell.others.sort().join(', ')}), so this is a STALE ` +
          'cache — you have installed before and a Playwright version bump has moved the target. Run ' +
          'the install again.'
        : 'The headed Chromium build is present, but a headless run starts the separate ' +
          'headless-shell build, and that one is not. A half-finished install leaves exactly this ' +
          'state.',
      `Looked for: ${shell.expectedDir}`,
      `Fix it with: ${INSTALL_COMMAND}`,
      'This prerequisite is declared in CONTRIBUTING.md and docs/how-to/developer-workflows.md,',
      'and must be re-run after a Playwright version bump.'
    ]);
  }
  // Silence on success. A correctly provisioned run should not be told about a
  // check that found nothing wrong.
  process.exit(0);
}

const cacheState = describeCacheState(expected);

fail([
  `the Chromium build this suite needs (${cacheState.revision ?? 'unknown revision'}) is not installed.`,
  'This is a preflight failure, not a visual regression.',
  describeInstalledState(cacheState),
  `Looked for: ${expected}`,
  `Fix it with: ${INSTALL_COMMAND}`,
  'This prerequisite is declared in CONTRIBUTING.md and docs/how-to/developer-workflows.md,',
  'and must be re-run after a Playwright version bump.'
]);
