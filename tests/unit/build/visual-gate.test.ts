import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { themeCss } from '../../visual/theme-palette';

const ROOT = resolve(__dirname, '../../..');

/** The CSS generic font families, each of which a browser maps to a face of its own choosing. */
const GENERIC_FONT_FAMILIES: ReadonlySet<string> = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong'
]);

/** A font-family declaration in the visual fixture, from its variable's name to its semicolon. */
const FIXTURE_FONT_FAMILY = /--vscode-[a-z-]*font-family:[^;]+;/g;

/** A font a theme fixture declares: the variable that holds it and its families, in order. */
interface FixtureFont {
  readonly name: string;
  readonly families: readonly string[];
}

/** Reads the font-family declarations out of a theme fixture's CSS. */
function fixtureFonts(css: string): FixtureFont[] {
  return [...css.matchAll(FIXTURE_FONT_FAMILY)].map((match) => {
    const declaration = match[0];
    const colon = declaration.indexOf(':');
    return {
      name: declaration.slice(0, colon),
      families: declaration
        .slice(colon + 1, -1)
        .split(',')
        .map((family) => family.trim())
    };
  });
}

/** Whether a family, when there is one, is generic, which the browser maps to a face itself. */
function isGenericFamily(family: string | undefined): boolean {
  return family !== undefined && GENERIC_FONT_FAMILIES.has(family);
}

describe('browser visual regression gate', () => {
  it('pins a first-class visual script into both local CI entry points', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      readonly scripts: Readonly<Record<string, string>>;
      readonly devDependencies: Readonly<Record<string, string>>;
    };
    expect(pkg.devDependencies['@playwright/test']).toBe('^1.62.1');
    expect(pkg.scripts['test:visual']).toContain('playwright.config.ts');
    expect(pkg.scripts['ci:fast']).toContain('npm run test:visual');
    expect(pkg.scripts['ci']).toContain('npm run test:visual');
  });

  // FR-R3-099 — three workflow files carried this until the Actions retirement
  // deleted all eight. The renderer invariant survives with a local subject: the
  // visual suite must be reached by the attested chain, and it must be the canonical
  // Chromium that runs it. The browser install that CI did per job is now the
  // developer's own `check-playwright-browser.mjs` preflight, which `test:visual`
  // runs first and which refuses rather than silently rendering in something else.
  // See docs/release/withdrawn-ci-controls.md.
  it('the attested chain reaches the visual suite, behind the canonical-renderer preflight', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['gate'], 'the attested chain must exist').toBeTruthy();
    expect(pkg.scripts['gate']).toContain('npm run ci');
    expect(pkg.scripts['ci']).toContain('npm run test:visual');
    expect(pkg.scripts['test:visual']).toContain('check-playwright-browser.mjs');
    expect(pkg.scripts['test:visual']).toContain('playwright.config.ts');
  });

  it('keeps the visual browser fixture on a fail-closed loopback network boundary', () => {
    const source = readFileSync(
      resolve(ROOT, 'tests/visual/webview.visual.spec.ts'),
      'utf8'
    );
    expect(source).toContain("requestUrl.origin === 'http://127.0.0.1:4173'");
    expect(source).toContain('await route.abort()');
  });

  // The fixture once gave the editor font as the bare generic `monospace`. Chromium on macOS
  // draws that family in Courier, the face the baselines hold, but in an occasional load it
  // drew Menlo instead, and the screenshot of a page that had not changed failed on its
  // monospace text. A named face first keeps the generic lookup out of the path; the generic
  // family stays last, as the fallback on a machine without that face.
  it('names a face before any generic family in each font of every fixture theme', () => {
    for (const theme of ['light', 'dark', 'high-contrast'] as const) {
      const fonts = fixtureFonts(themeCss(theme));
      expect(fonts, `the ${theme} fixture declares its fonts`).toHaveLength(2);
      for (const { name, families } of fonts) {
        expect(
          isGenericFamily(families.at(0)),
          `the ${theme} fixture's ${name} starts with a generic family, which the browser maps`
        ).toBe(false);
        expect(
          isGenericFamily(families.at(-1)),
          `the ${theme} fixture's ${name} ends without a generic family to fall back on`
        ).toBe(true);
      }
    }
  });
});
