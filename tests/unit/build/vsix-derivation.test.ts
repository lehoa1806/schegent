/**
 * Feature 106 (T597, T597a, T597b) — the derivation's own assertions, observed.
 *
 * Twenty-five pinned entries became two shape predicates and one correspondence.
 * A shape that admits more than the pin did would have traded away the property
 * the pin was really carrying — the *absence* of source maps, dotfiles, fixtures
 * and dependency trees — so each rejection is asserted here by name rather than
 * left to the archive check to discover on some future build.
 *
 * Every vacuity control is exercised too. A filter over an empty subject passes,
 * and this feature removed a list; the gate has to fail when it cannot
 * substantiate its verdict, and "has to" is not an observation.
 */

import { describe, expect, it } from 'vitest';

import { WEBVIEW_ENTRY_PREFIX, plausiblePackagedNames } from './authored-boundaries';

const CHUNKS = `${WEBVIEW_ENTRY_PREFIX}chunks/`;

async function policy() {
  return import('../../../scripts/check-vsix-smoke.mjs');
}

/** A boundary set with no route, for cases where routes are not the subject. */
const ONE_BOUNDARY = {
  boundaries: [{ component: 'RunsSurface', path: '/src/components/RunsSurface.svelte', route: 'runs' }],
  routes: [{ route: 'runs', specifier: '../components/RunsSurface.svelte' }]
};

const MINIMAL = async () => {
  const { ALLOWED_VSIX_ENTRIES } = await policy();
  return [...ALLOWED_VSIX_ENTRIES, `${CHUNKS}RunsSurface.js`];
};

describe('the chunk shape admits build-assigned names and nothing else', () => {
  it('admits a single-segment .js file and reports its basename', async () => {
    const { chunkBasename } = await policy();
    expect(chunkBasename(`${CHUNKS}empty-catalog-guidance.js`)).toBe('empty-catalog-guidance');
    expect(chunkBasename(`${CHUNKS}RunsSurface.js`)).toBe('RunsSurface');
  });

  it.each([
    ['a source map', `${CHUNKS}RunsSurface.js.map`],
    ['a dotfile', `${CHUNKS}.DS_Store`],
    ['a dotted .js file', `${CHUNKS}.hidden.js`],
    ['a nested directory', `${CHUNKS}vendor/lodash.js`],
    ['a stylesheet under chunks/', `${CHUNKS}RunsSurface.css`],
    ['a declaration file', `${CHUNKS}RunsSurface.d.ts`],
    ['an ESM extension', `${CHUNKS}RunsSurface.mjs`],
    ['the directory itself', CHUNKS],
    ['a chunk one level up', `${WEBVIEW_ENTRY_PREFIX}RunsSurface.js`]
  ])('rejects %s', async (_label, name) => {
    const { chunkBasename } = await policy();
    expect(chunkBasename(name)).toBeNull();
  });

  it('names a rejected source map as an unexpected packaged file', async () => {
    const { assertAllowedEntryNames } = await policy();
    const names = [...(await plausiblePackagedNames()), `${CHUNKS}RunsSurface.js.map`];
    expect(() => assertAllowedEntryNames(names)).toThrow(
      /unexpected packaged file extension\/dist\/webview\/chunks\/RunsSurface\.js\.map/
    );
  });
});

describe('the stylesheet shape is numbered, contiguous, and starts at 2', () => {
  it('admits index2 and above', async () => {
    const { stylesheetNumber } = await policy();
    expect(stylesheetNumber(`${WEBVIEW_ENTRY_PREFIX}index2.css`)).toBe(2);
    expect(stylesheetNumber(`${WEBVIEW_ENTRY_PREFIX}index14.css`)).toBe(14);
  });

  it.each([
    ['the unnumbered first stylesheet', `${WEBVIEW_ENTRY_PREFIX}index.css`],
    ['index1, which the bundler never emits', `${WEBVIEW_ENTRY_PREFIX}index1.css`],
    ['a zero-padded number', `${WEBVIEW_ENTRY_PREFIX}index02.css`],
    ['a suffixed name', `${WEBVIEW_ENTRY_PREFIX}index2.min.css`],
    ['a stylesheet one level down', `${CHUNKS}index2.css`]
  ])('rejects %s', async (_label, name) => {
    const { stylesheetNumber } = await policy();
    expect(stylesheetNumber(name)).toBeNull();
  });

  it('fails on a gap, naming the absent number rather than only a count', async () => {
    const { assertAllowedEntryNames } = await policy();
    const names = [
      ...(await MINIMAL()),
      `${WEBVIEW_ENTRY_PREFIX}index2.css`,
      `${WEBVIEW_ENTRY_PREFIX}index4.css`
    ];
    expect(() => assertAllowedEntryNames(names, 'VSIX', ONE_BOUNDARY)).toThrow(
      /stylesheet numbering has a gap: 2 emitted.*absent index3\.css/
    );
  });

  it('accepts a contiguous run of any length', async () => {
    const { assertAllowedEntryNames } = await policy();
    const run = [2, 3, 4, 5, 6].map((n) => `${WEBVIEW_ENTRY_PREFIX}index${n}.css`);
    const names = [...(await MINIMAL()), ...run];
    expect(() => assertAllowedEntryNames(names, 'VSIX', ONE_BOUNDARY)).not.toThrow();
  });
});

describe('the correspondence holds authored boundaries to emitted chunks', () => {
  it('names the route when a route surface has no chunk', async () => {
    const { assertAllowedEntryNames, ALLOWED_VSIX_ENTRIES } = await policy();
    expect(() =>
      assertAllowedEntryNames([...ALLOWED_VSIX_ENTRIES, `${CHUNKS}Other.js`], 'VSIX', ONE_BOUNDARY)
    ).toThrow(/no emitted chunk for route runs \(RunsSurface\)/);
  });

  it('distinguishes a non-route boundary from a route surface', async () => {
    const { assertAllowedEntryNames, ALLOWED_VSIX_ENTRIES } = await policy();
    const authored = {
      boundaries: [
        ...ONE_BOUNDARY.boundaries,
        { component: 'QueueDetailTier', path: '/src/components/drilldown/QueueDetailTier.svelte', route: null }
      ],
      routes: ONE_BOUNDARY.routes
    };
    expect(() =>
      assertAllowedEntryNames(
        [...ALLOWED_VSIX_ENTRIES, `${CHUNKS}RunsSurface.js`],
        'VSIX',
        authored
      )
    ).toThrow(/no emitted chunk for authored boundary QueueDetailTier/);
  });

  it('is one-directional: an emitted chunk needs no authored boundary', async () => {
    // The reverse direction is the pinned list this feature removed. A shared
    // chunk Vite extracts on its own — `empty-catalog-guidance.js` — corresponds
    // to no source module at all, and demanding one is what made the old pin
    // unrepairable.
    const { assertAllowedEntryNames } = await policy();
    const names = [...(await MINIMAL()), `${CHUNKS}empty-catalog-guidance.js`];
    expect(() => assertAllowedEntryNames(names, 'VSIX', ONE_BOUNDARY)).not.toThrow();
  });

  it('fails as ambiguous when two source files claim one chunk name', async () => {
    const { assertAllowedEntryNames } = await policy();
    const authored = {
      boundaries: [
        { component: 'Panel', path: '/src/components/a/Panel.svelte', route: null },
        { component: 'Panel', path: '/src/components/b/Panel.svelte', route: null },
        ...ONE_BOUNDARY.boundaries
      ],
      routes: ONE_BOUNDARY.routes
    };
    const names = [...(await MINIMAL()), `${CHUNKS}Panel.js`];
    expect(() => assertAllowedEntryNames(names, 'VSIX', authored)).toThrow(
      /ambiguous boundary Panel: 2 source files claim that chunk name/
    );
  });
});

describe('the gate refuses an empty subject rather than passing over one', () => {
  it('fails when the boundary scan found no dynamic import', async () => {
    const { assertAllowedEntryNames } = await policy();
    const names = await MINIMAL();
    expect(() =>
      assertAllowedEntryNames(names, 'VSIX', { boundaries: [], routes: ONE_BOUNDARY.routes })
    ).toThrow(/could not establish the correspondence: the boundary scan found no dynamic component import/);
  });

  it('fails when the route map yielded no route', async () => {
    const { assertAllowedEntryNames } = await policy();
    const names = await MINIMAL();
    expect(() =>
      assertAllowedEntryNames(names, 'VSIX', { boundaries: ONE_BOUNDARY.boundaries, routes: [] })
    ).toThrow(/could not establish the correspondence: the route map yielded no route/);
  });

  it('fails when the package holds no webview chunk at all', async () => {
    const { assertAllowedEntryNames, ALLOWED_VSIX_ENTRIES } = await policy();
    expect(() => assertAllowedEntryNames(ALLOWED_VSIX_ENTRIES, 'VSIX', ONE_BOUNDARY)).toThrow(
      /could not establish the correspondence: the package holds no webview chunk/
    );
  });

  it('finds both source-text patterns it depends on', async () => {
    // The two parsers are regexes over source. Either could stop matching after a
    // formatting change and take the correspondence with it.
    const { parseDynamicSvelteImports, parseRouteLoaderEntries, readAuthoredBoundaries } =
      await policy();
    expect(parseDynamicSvelteImports("x = import('./A.svelte')")).toEqual(['./A.svelte']);
    expect(parseDynamicSvelteImports("type X = typeof import('./A.svelte').default")).toEqual([]);
    expect(parseRouteLoaderEntries("  runs: () => import('../components/RunsSurface.svelte'),")).toEqual([
      { route: 'runs', specifier: '../components/RunsSurface.svelte' }
    ]);
    expect(readAuthoredBoundaries().boundaries.length).toBeGreaterThan(0);
    expect(readAuthoredBoundaries().routes.length).toBeGreaterThan(0);
  });
});

describe('one run reports every difference', () => {
  it('collects the classes into a single error, in a stable order', async () => {
    const { assertAllowedEntryNames } = await policy();
    const names = [
      ...(await plausiblePackagedNames()).filter((name) => name !== 'extension/readme.md'),
      'extension/test_output.txt',
      `${WEBVIEW_ENTRY_PREFIX}index6.css`
    ];
    let message = '';
    try {
      assertAllowedEntryNames(names);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/\[policy\] 3 differences between the package and the allowlist/);
    expect(message).toMatch(/\(1 unexpected, 1 missing, 1 numbering\)/);
    expect(message).toContain('unexpected packaged file extension/test_output.txt');
    expect(message).toContain('missing required packaged file extension/readme.md');
    expect(message).toContain('absent index5.css');
    expect(message.indexOf('unexpected packaged')).toBeLessThan(message.indexOf('missing required'));
  });

  it('throws an unsafe archive path on its own, before anything is collected', async () => {
    const { assertAllowedEntryNames } = await policy();
    let message = '';
    try {
      assertAllowedEntryNames([
        ...(await plausiblePackagedNames()),
        '../outside',
        'extension/test_output.txt'
      ]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/\[policy\] 1 unsafe archive path/);
    expect(message).toContain('unsafe ZIP entry path ../outside');
    // The junk file is a real difference and is deliberately absent: a traversal
    // entry is a security finding, and burying it in a skimmable list is how it
    // gets skimmed past.
    expect(message).not.toContain('test_output.txt');
  });

  it('states what the count assertion can still catch: a duplicate entry', async () => {
    const { assertAllowedEntryNames } = await policy();
    const names = await plausiblePackagedNames();
    let message = '';
    try {
      assertAllowedEntryNames([...names, 'extension/readme.md']);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('a duplicate archive entry');
    expect(message).toMatch(/\(1 count\)/);
  });

  it('tags every policy failure with its stage', async () => {
    const { assertAllowedEntryNames, STAGE_POLICY } = await policy();
    expect(STAGE_POLICY).toBe('[policy]');
    let message = '';
    try {
      assertAllowedEntryNames([...(await plausiblePackagedNames()), 'extension/test_output.txt']);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(STAGE_POLICY);
  });
});
