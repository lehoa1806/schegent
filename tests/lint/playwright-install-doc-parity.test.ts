// FR-R3-065 — the documented install command must satisfy the Playwright the
// config actually resolves.
//
// WHY THIS EXISTS AT ALL
//
// The finding this closes was not a first clone. It was a **version bump**: the
// installed browser build was one revision behind what the toolchain resolved,
// and a cache that had worked for months stopped working. Declaring the
// prerequisite fixes today; this is what decides whether the declaration is
// still true after the next bump — which is how the prerequisite came to be
// undeclared in the first place.
//
// WHAT THIS GATE GUARANTEES
//
//   - both documentation surfaces carry an install command inside a CODE SPAN;
//   - that command would satisfy the installed `@playwright/test` — it is either
//     version-agnostic, or pins that exact version;
//   - the preflight checks the browser the config actually names, so adding a
//     second browser to the config cannot leave it unchecked.
//
// WHAT IT DOES NOT GUARANTEE
//
//   - It reads CODE SPANS, never prose. A document could describe the wrong
//     thing in a sentence and pass. That is deliberate: a gate that reads prose
//     pressures authors to write worse prose, which this round has recorded eight
//     times. The command is the checkable part; the sentence around it is review's.
//   - A command pinning a RANGE (`playwright@^1.62`) is rejected rather than
//     resolved. A range in a setup instruction is not a reproducible instruction,
//     and resolving semver here would mean this gate deciding what npm would have
//     installed — a different and much weaker claim.
//   - It compares the documented command against the DECLARED dependency version,
//     not against what is installed in `node_modules` on this machine. The
//     manifest is the contract; a local tree out of step with it is a different
//     problem, and `npm ci` is its remedy.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const PREFLIGHT = 'scripts/check-playwright-browser.mjs';
const CONFIG = 'playwright.config.ts';

/** Every shipped surface that tells a contributor how to provision the browser. */
const DOCUMENTED_SURFACES = [
  'CONTRIBUTING.md',
  'docs/how-to/developer-workflows.md',
  // Added after review asked why it was absent: CONTRIBUTING points a newcomer
  // here for "the complete build", so a setup tutorial that omits the browser is
  // the undeclared-prerequisite defect in the one document most likely to be a
  // contributor's first.
  'docs/tutorials/developer-setup.md'
] as const;

const read = (relPath: string): string => readFileSync(resolve(REPO_ROOT, relPath), 'utf8');

/**
 * Source with `//` and block comments removed.
 *
 * Crude on purpose — a comment marker inside a string literal is stripped too,
 * which can only ever make an assertion over the result stricter, never laxer.
 */
const stripComments = (body: string): string =>
  body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The version the manifest declares — the contract, not this machine's tree. */
function declaredPlaywrightVersion(): string {
  const manifest = JSON.parse(read('package.json')) as {
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  const spec =
    manifest.devDependencies?.['@playwright/test'] ?? manifest.dependencies?.['@playwright/test'];
  if (spec === undefined) throw new Error('@playwright/test is not a declared dependency');
  // Strip a leading range operator; the declared version is what we compare to.
  return spec.replace(/^[\^~>=<\s]+/, '');
}

/**
 * Install commands found in code spans — backticked inline spans and fenced
 * blocks both. Prose is not read.
 */
function documentedInstallCommands(body: string): string[] {
  const spans: string[] = [];
  for (const [, span] of body.matchAll(/`([^`\n]+)`/g)) spans.push(span);
  for (const [, block] of body.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    for (const line of block.split('\n')) spans.push(line.trim());
  }
  return spans.filter((span) => /playwright[^\s]*\s+install\b/.test(span));
}

/*
 * OBSERVED, 2026-08-24, darwin/arm64. Command in every case:
 * `npx vitest run tests/lint/playwright-install-doc-parity.test.ts`.
 *
 * RED on drift, three seeds, each reverted:
 *   1. `CONTRIBUTING.md` pinned `playwright@1.61.0` -> failed, naming the document,
 *      the documented command, and the declared 1.62.1.
 *   2. `developer-workflows.md` pinned the range `playwright@^1.62` -> failed,
 *      naming the range and why a range is not an instruction.
 *   3. `playwright.config.ts` switched to `firefox` -> failed, naming the browser
 *      the config launches and the preflight does not check.
 *
 * GREEN on a reworded sentence: "needs a Chromium build that" rewritten to
 * "depends upon a Chromium browser build which", command untouched -> 7 passed.
 * That direction matters as much as the red ones. A gate that fires when someone
 * improves a sentence is a gate that gets switched off, which is the eight-instance
 * lesson this round has recorded about text-matching checks.
 */
describe('playwright install command parity (FR-R3-065)', () => {
  const declared = declaredPlaywrightVersion();

  it.each(DOCUMENTED_SURFACES)('%s declares an install command in a code span', (surface) => {
    const commands = documentedInstallCommands(read(surface));
    expect(
      commands.length,
      `${surface} names no Playwright install command inside a code span. The visual suite cannot ` +
        'run without one, and a prerequisite a contributor has to search for is the undeclared ' +
        'dependency this gate exists to prevent.'
    ).toBeGreaterThan(0);
  });

  it.each(DOCUMENTED_SURFACES)('%s documents a command that satisfies the resolved toolchain', (surface) => {
    for (const command of documentedInstallCommands(read(surface))) {
      const pin = /playwright@([^\s]+)/.exec(command);
      if (pin === null) continue; // version-agnostic: satisfies whatever is declared
      const pinned = pin[1];
      expect(
        /^\d+\.\d+\.\d+$/.test(pinned),
        `${surface} documents '${command}', which pins a RANGE. A range in a setup instruction is ` +
          'not a reproducible instruction — use the exact version or leave it version-agnostic.'
      ).toBe(true);
      expect(
        pinned,
        `${surface} documents '${command}', but package.json declares @playwright/test ` +
          `${declared}. The documented command would install a browser the suite does not resolve, ` +
          'which is exactly the version-bump failure this gate exists to catch. Update the document ' +
          'or drop the pin.'
      ).toBe(declared);
    }
  });

  it('re-declares the prerequisite as re-runnable after a version bump', () => {
    // The measured trigger was a bump, so a document that names the command but
    // omits this leaves a contributor believing one install is forever.
    for (const surface of DOCUMENTED_SURFACES) {
      expect(
        /re-?run/i.test(read(surface)) && /version bump/i.test(read(surface)),
        `${surface} names the install command but does not say it must be re-run after a Playwright ` +
          'version bump. That omission is the whole reason this finding was a bump and not a clone.'
      ).toBe(true);
    }
  });

  it('the preflight covers the browser the config actually names', () => {
    // If the config gains a second browser, the preflight would silently check
    // only one and the other becomes the next undeclared dependency.
    const config = read(CONFIG);
    const named = [...config.matchAll(/browserName:\s*'([a-z]+)'/g)].map(([, name]) => name);
    expect(named.length, 'no browserName found in the Playwright config').toBeGreaterThan(0);
    // CODE, not comments. The preflight explains at length which browsers it
    // checks and why, so a bare substring search over the whole file is
    // satisfied by a comment saying a browser is deliberately NOT checked —
    // which is precisely the state this assertion must call a failure.
    const preflight = stripComments(read(PREFLIGHT));
    for (const browser of named) {
      expect(
        preflight.includes(browser),
        `playwright.config.ts uses '${browser}' but ${PREFLIGHT} does not check it. A browser the ` +
          'config launches and the preflight ignores is the next undeclared dependency.'
      ).toBe(true);
    }
  });

  it('the preflight offers the same command the documents do', () => {
    // Three places name this command: two documents and the failure message. If
    // they disagree, the contributor is told two different things depending on
    // where they look, which is the drift this whole item is about.
    //
    // The preflight is a script, so its command is a source constant rather than
    // a markdown code span — read it as one. (The first draft of this test reused
    // the markdown extractor here and found nothing, which is why the constant is
    // matched by name: a check looking in the wrong syntax reports absence, not
    // disagreement, and absence is the one answer that must not pass quietly.)
    const constant = /const INSTALL_COMMAND = '([^']+)'/.exec(read(PREFLIGHT));
    expect(
      constant,
      `${PREFLIGHT} no longer declares INSTALL_COMMAND as a single-quoted constant, so this gate ` +
        'cannot compare it against the documents. Restore the constant or update this matcher — do ' +
        'not delete the comparison.'
    ).not.toBeNull();
    const fromPreflight = [constant?.[1] ?? ''];
    for (const surface of DOCUMENTED_SURFACES) {
      const fromDoc = documentedInstallCommands(read(surface));
      expect(
        fromDoc.some((command) => fromPreflight.includes(command)),
        `${surface} and ${PREFLIGHT} name different install commands: ${fromDoc.join(' | ')} vs ` +
          `${fromPreflight.join(' | ')}.`
      ).toBe(true);
    }
  });
});
