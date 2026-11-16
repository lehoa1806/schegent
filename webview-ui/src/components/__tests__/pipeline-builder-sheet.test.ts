// The Builder's shared sheet (`PipelineBuilderEditors/pipeline-builder.css`) styles only what the
// Builder renders. Its rules are global to `.pb`, so nothing ties one to its markup: a component
// that stops drawing a class leaves the rule behind, and a comment naming the component can
// outlive it too. Finding 10 of the webview port review found both. This reads every class the
// sheet names and looks for it in the modules `PipelineBuilder.svelte` imports, near or far.
//
// A use is the name in a module's markup or code, never in a comment or a `<style>` block: a rule
// in a component's own sheet, or a comment, is how a dead class looks alive. A class built in a
// `class` attribute from a prefix and a value (`status-{p.row.sourceStatus}`) counts as used.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const COMPONENTS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHEET = join(COMPONENTS, 'PipelineBuilderEditors', 'pipeline-builder.css');
const ROOT = join(COMPONENTS, 'PipelineBuilder.svelte');

/** A relative module specifier in an import or export statement. */
const RELATIVE_IMPORT = /(?:from|import)\s+['"](\.{1,2}\/[^'"]+)['"]/g;
/** The source extensions an extensionless or `.js` specifier may resolve to, in order. */
const SOURCE_SUFFIXES = ['', '.ts', '.svelte.ts', '/index.ts'];

function resolveModule(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier.replace(/\.js$/, ''));
  if (/\.(css|json)$/.test(base)) return null;
  for (const suffix of SOURCE_SUFFIXES) {
    const candidate = base + suffix;
    if (/\.(svelte|ts)$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/** What a module renders or computes classes from: its text less comments and style blocks. */
function codeOf(text: string): string {
  return text
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** Every source module the root imports, directly or through another, with its text. */
function importedSources(root: string): Map<string, string> {
  const seen = new Map<string, string>();
  const pending = [root];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next)) continue;
    const text = readFileSync(next, 'utf8');
    seen.set(next, text);
    for (const match of text.matchAll(RELATIVE_IMPORT)) {
      const target = resolveModule(next, match[1]);
      if (target !== null && !seen.has(target)) pending.push(target);
    }
  }
  return seen;
}

/** The class names the sheet's selectors name, comments left out. */
function sheetClasses(sheet: string): string[] {
  const rules = sheet.replace(/\/\*[\s\S]*?\*\//g, '');
  const names = new Set<string>();
  for (const block of rules.matchAll(/([^{}]+)\{[^}]*\}/g)) {
    for (const match of block[1].matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) names.add(match[1]);
  }
  return [...names].sort();
}

function isUsed(name: string, sources: readonly string[]): boolean {
  const literal = new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`);
  const cut = name.lastIndexOf('-');
  const interpolated =
    cut > 0 ? new RegExp(`class=["'][^"']*?(?<![\\w-])${name.slice(0, cut + 1)}\\{`) : null;
  return sources.some((text) => literal.test(text) || (interpolated?.test(text) ?? false));
}

describe('pipeline-builder.css', () => {
  it('styles no class the Builder does not render', () => {
    const sources = [...importedSources(ROOT).values()].map(codeOf);
    const unused = sheetClasses(readFileSync(SHEET, 'utf8')).filter(
      (name) => !isUsed(name, sources)
    );
    expect(unused).toEqual([]);
  });
});
