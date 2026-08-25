// FR-R3-088 §5 / T1210 — re-verify the 407-of-461 classification, or mark it
// unverified wherever it is cited.
//
// THE CLAIM UNDER TEST. `webview-ui/vitest.config.ts` records that nine webview
// files measure 0%, 461 statements between them, and that SIX Svelte components
// account for 407 of those statements as "already recorded as knowingly
// unreachable … None has an importer outside tests."
//
// The reviewer brief's objection is exactly the right one: "If that
// classification is wrong, the real figure is worse." A classification that is
// only ever re-read is not re-verified — the reading reproduces whatever the
// first author concluded, including their mistake.
//
// SO THIS RE-DERIVES IT rather than restating it: for each of the six named
// components, the tree is searched for an importer outside `__tests__`. Dead
// means unimported; the statement count is not what makes it dead.
//
// If one of these gains a real importer, this test goes red — and that is the
// good outcome. It means 407 is now wrong and the coverage figure should be
// re-read as a testing gap rather than a dead-code inventory.
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesUnder } from '../source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const WEBVIEW_SRC = resolve(REPO_ROOT, 'webview-ui/src');
const CONFIG = resolve(REPO_ROOT, 'webview-ui/vitest.config.ts');

/** The six components and the statement counts the config attributes to them. */
const CLASSIFIED_DEAD: ReadonlyArray<readonly [string, number]> = [
  ['HoverText.svelte', 179],
  ['ControlPanel.svelte', 104],
  ['QueueList.svelte', 41],
  ['PhaseTracker.svelte', 36],
  ['LiveActivityHeader.svelte', 33],
  ['StatusHeader.svelte', 14]
];

const rel = (abs: string): string => relative(REPO_ROOT, abs).replaceAll('\\', '/');

const WEBVIEW_SOURCES = filesUnder(WEBVIEW_SRC, { extensions: ['.ts', '.svelte'] })
  .map((file) => [rel(file), readFileSync(file, 'utf8')] as const)
  .filter(([path]) => !path.includes('__tests__'));

describe('FR-R3-088 — the webview dead-code classification, re-derived', () => {
  it('scanned a non-empty webview tree', () => {
    // Without this the "no importer" result below would be produced by an empty
    // scan, which is the failure this whole tier is about.
    expect(WEBVIEW_SOURCES.length).toBeGreaterThan(100);
  });

  it('the six classified-dead components still have no importer outside tests', () => {
    const stillImported: string[] = [];
    for (const [component] of CLASSIFIED_DEAD) {
      const base = component.replace('.svelte', '');
      const importers = WEBVIEW_SOURCES.filter(([path, source]) => {
        if (path.endsWith(`/${component}`)) return false;
        return new RegExp(`from\\s+['"][^'"]*${base}(?:\\.svelte)?['"]`).test(source);
      }).map(([path]) => path);
      if (importers.length > 0) stillImported.push(`${component} <- ${importers.join(', ')}`);
    }
    expect(
      stillImported,
      'A component classified as dead has gained an importer. The 407-of-461 figure is now ' +
        'wrong, and the webview coverage number should be re-read as a testing gap rather ' +
        'than a dead-code inventory.'
    ).toEqual([]);
  });

  it('the statement counts attributed to those components still sum to 407', () => {
    // The arithmetic half. If the config's per-component numbers are edited
    // without the total, the two disagree and the citation is unsound.
    const total = CLASSIFIED_DEAD.reduce((sum, [, count]) => sum + count, 0);
    expect(total).toBe(407);
  });

  it('the config still states the figures this test re-derives, so neither drifts alone', () => {
    const config = readFileSync(CONFIG, 'utf8');
    expect(config).toContain('407 of the 461 statements');
    for (const [component, count] of CLASSIFIED_DEAD) {
      const base = component.replace('.svelte', '');
      expect(config, `${component} must still be named in the config's inventory`).toContain(base);
      expect(config, `${component}'s statement count must still be recorded`).toMatch(
        new RegExp(`${base}[^)]*\\(${count}`)
      );
    }
  });
});
