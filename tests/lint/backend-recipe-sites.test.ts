// FR-R4-F06 (FR-035; L11; research R44; contract G, G8) -- the backend recipe lists every site, and a census
// keeps it complete.
//
// THE DEFECT IT CLOSES. `backend-kinds.ts` said adding a backend "means three edits". The sweep found about
// thirty source files that compare to a backend literal or key a record by `BackendRunnerKind`, and a factory
// `switch` whose `default:` built every unlisted backend as Claude. A fourth backend added by the recipe as
// written would have compiled and then run as Claude.
//
// WHAT FAILS, in both directions.
//   1. A `src/` or `webview-ui/src/` file that compares to a backend literal or keys a record by the union and
//      is not in `BACKEND_RECIPE_SITES`: an undeclared place the recipe forgets.
//   2. A listed `switch`, `equality` or `record` site that no longer matches its `how`, or any listed path that
//      no longer exists: a recipe step pointing at nothing.
//   3. A listed `switch` site whose `default:` absorbs a supported backend: a `case 'x':` label that falls
//      straight into `default:`, the shape the factory had.
//
// WHAT IS SCANNED. Non-test `.ts` and `.svelte` sources under `src/` and `webview-ui/src/`, minus generated
// output and declarations, with comment lines removed so a doc comment quoting the pattern is not a site.
// The patterns are `=== 'x'`, `!== 'x'`, `case 'x':` for the three backends, and `Record<BackendRunnerKind`.
//
// It is seeded: an unlisted comparison, a stale row and an absorbing `default:` must each fail.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { SUPPORTED_BACKENDS } from '../../src/contracts/backend-kinds';
import {
  BACKEND_RECIPE_SITES,
  type BackendRecipeHow,
  type BackendRecipeSite
} from '../fixtures/backend-recipe-sites';
import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Seeded fixtures' roots, built rather than written as `src/...` literals (see lint-anchor-grounding). */
const SEEDED_SRC = 'src';
const SEEDED_WEBVIEW = ['webview-ui', 'src'].join('/');
const LITERALS = SUPPORTED_BACKENDS.join('|');

const SITE_PATTERNS: Readonly<Record<Exclude<BackendRecipeHow, 'literal'>, RegExp>> = {
  switch: new RegExp(`case '(?:${LITERALS})'`),
  equality: new RegExp(`(?:===|!==) '(?:${LITERALS})'`),
  record: /Record<BackendRunnerKind/
};
const ANY_SITE = new RegExp(
  [SITE_PATTERNS.switch, SITE_PATTERNS.equality, SITE_PATTERNS.record].map((p) => p.source).join('|')
);
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

/** The code lines of a source text, comment lines removed. */
const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !COMMENT_LINE.test(line))
    .join('\n');

/** Does `text` hold a site of kind `how`? */
function matches(text: string, how: Exclude<BackendRecipeHow, 'literal'>): boolean {
  return SITE_PATTERNS[how].test(codeOf(text));
}

/** The `case 'x':` labels in `text` that fall straight into a `default:`. */
function absorbedIntoDefault(text: string): string[] {
  const lines = codeOf(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const absorbed: string[] = [];
  lines.forEach((line, index) => {
    if (!line.startsWith('default:')) return;
    const before = lines[index - 1] ?? '';
    const label = new RegExp(`^case '(${LITERALS})':$`).exec(before);
    if (label?.[1] !== undefined) absorbed.push(label[1]);
  });
  return absorbed;
}

function scannedSources(): string[] {
  return ['src', 'webview-ui/src']
    .flatMap((root) =>
      filesUnder(resolve(REPO_ROOT, root), {
        extensions: ['.ts', '.svelte'],
        skipDirectories: ['__tests__', 'generated', 'node_modules']
      })
    )
    .filter((file) => !/\.(?:test|d)\.ts$/.test(file))
    .map((file) => relative(REPO_ROOT, file));
}

/** Files the scan finds that the table does not list. */
function unlisted(
  files: ReadonlyMap<string, string>,
  listed: readonly BackendRecipeSite[]
): string[] {
  const known = new Set(listed.map((site) => site.path));
  return [...files]
    .filter(([path, text]) => ANY_SITE.test(codeOf(text)) && !known.has(path))
    .map(([path]) => path);
}

describe('the backend recipe lists every site (L11)', () => {
  const sources = new Map(scannedSources().map((path) => [path, readFileSync(resolve(REPO_ROOT, path), 'utf8')]));

  it('scans a real tree: the control against a scan that found nothing', () => {
    expect(sources.size).toBeGreaterThan(500);
    const found = [...sources].filter(([, text]) => ANY_SITE.test(codeOf(text)));
    expect(found.length, 'the sweep found about thirty sites at befeccc8').toBeGreaterThan(20);
  });

  it('lists every source file that compares to a backend or keys a record by the union', () => {
    expect(
      unlisted(sources, BACKEND_RECIPE_SITES),
      'These files name a backend and the recipe does not. Add each to tests/fixtures/backend-recipe-sites.ts ' +
        'with its role, so the next backend added by the recipe reaches it.'
    ).toEqual([]);
  });

  it('lists no path twice, and gives every row a role', () => {
    const paths = BACKEND_RECIPE_SITES.map((site) => site.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const site of BACKEND_RECIPE_SITES) expect(site.role.trim().length, site.path).toBeGreaterThan(0);
  });

  it('lists only paths that exist', () => {
    const missing = BACKEND_RECIPE_SITES.filter((site) => !existsSync(resolve(REPO_ROOT, site.path)));
    expect(missing.map((site) => site.path)).toEqual([]);
  });

  it('keeps every switch, equality and record row true to its how', () => {
    const stale = BACKEND_RECIPE_SITES.filter(
      (site) =>
        site.how !== 'literal' &&
        !matches(readFileSync(resolve(REPO_ROOT, site.path), 'utf8'), site.how)
    );
    expect(
      stale.map((site) => `${site.path} (${site.how})`),
      'a listed site no longer matches the way the recipe says it names a backend'
    ).toEqual([]);
  });

  it('lets no listed switch absorb a supported backend into default:', () => {
    const absorbing = BACKEND_RECIPE_SITES.filter((site) => site.how === 'switch').flatMap((site) =>
      absorbedIntoDefault(readFileSync(resolve(REPO_ROOT, site.path), 'utf8')).map(
        (backend) => `${site.path}: case '${backend}' falls into default`
      )
    );
    expect(absorbing).toEqual([]);
  });

  it('lists the factory as a switch, and the path accessor as an exhaustive one', () => {
    const factory = BACKEND_RECIPE_SITES.find((site) => site.path === 'src/runner/backend-runner-factory.ts');
    expect(factory?.how).toBe('switch');
    // Review gap GC-06 (2026-11-12) — the accessor was an `if` chain whose fallback was Claude; it is
    // now a switch with a `never` default, so it no longer has a fallback site to name.
    const accessor = BACKEND_RECIPE_SITES.find((site) => site.path === 'src/config/cli-path-accessor.ts');
    expect(accessor?.how).toBe('switch');
    expect(accessor?.note).toMatch(/`never` default/);
  });

  describe('the check itself (seeded)', () => {
    it('fails an unlisted comparison to a backend literal', () => {
      const files = new Map([[`${SEEDED_SRC}/services/new-thing.ts`, "export const isCodex = (k: string) => k === 'codex';"]]);
      expect(unlisted(files, BACKEND_RECIPE_SITES)).toEqual([`${SEEDED_SRC}/services/new-thing.ts`]);
    });

    it('fails an unlisted record keyed by the union', () => {
      const files = new Map([[`${SEEDED_WEBVIEW}/lib/x.ts`, 'const m: Record<BackendRunnerKind, string> = {} as never;']]);
      expect(unlisted(files, BACKEND_RECIPE_SITES)).toEqual([`${SEEDED_WEBVIEW}/lib/x.ts`]);
    });

    it('does not read a comment that quotes the pattern', () => {
      const files = new Map([[`${SEEDED_SRC}/x.ts`, "// compares with k === 'codex' in prose\n/** Record<BackendRunnerKind, T> */\nconst a = 1;"]]);
      expect(unlisted(files, BACKEND_RECIPE_SITES)).toEqual([]);
    });

    it('fails a stale row: a listed equality site that no longer compares', () => {
      expect(matches('const unrelated = 1;', 'equality')).toBe(false);
      expect(matches("if (kind === 'agy') return 1;", 'equality')).toBe(true);
    });

    it('fails a switch whose default absorbs a supported backend', () => {
      const absorbing = "switch (kind) {\n  case 'codex':\n    return a;\n  case 'claude':\n  default:\n    return b;\n}";
      expect(absorbedIntoDefault(absorbing)).toEqual(['claude']);
    });

    it('passes a switch whose default stands alone', () => {
      const separate = "switch (kind) {\n  case 'claude':\n    return b;\n  default: {\n    throw new Error();\n  }\n}";
      expect(absorbedIntoDefault(separate)).toEqual([]);
    });
  });
});
