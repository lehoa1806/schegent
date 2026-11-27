/**
 * The webview's statements capitalise Phase and Workflow, and the names of its
 * controls and fields keep their words. This package's README records the rule
 * under "Where the port departs from the mockups".
 *
 * A statement is a hint, a note, an empty state and its heading, a confirmation
 * body, an error, a tooltip that explains, or the new Phase's starter text. A
 * name is a control's caption, accessible name, placeholder or menu item, a
 * tooltip that only repeats it, a field, column or crumb caption, a dialog
 * title, or a status or stand-in value. A sentence that quotes a name keeps the
 * name's words. Run, Task and Queue are outside this guard.
 *
 * The scan reads every source under `webview-ui/src` except the tests: the text
 * and attribute values of each component's markup, and every string and
 * template part in its scripts and in the `.ts` modules. It skips comments,
 * styles, `data-*` attributes and the attributes in SKIP_ATTRIBUTES, which hold
 * markup rather than words.
 *
 * Its limit: it sees only strings of two or more words. A single word reads as
 * an identifier or a key, so a one-word caption is the reviewer's to check.
 *
 * NAMES lists the copy that writes a noun in lower case because it is a name.
 * A new name joins the list; a new statement capitalises the noun.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'svelte/compiler';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_DIR = join(__dirname, '..', '..');
const SOURCE_EXTENSIONS = ['.svelte', '.ts'];
/** A product noun in lower case, as a whole word. */
const LOWER_CASE_NOUN = /\b(phases?|workflows?)\b/;
/** Attributes that hold markup, references or values, never copy. */
const SKIP_ATTRIBUTES = new Set([
  'class', 'id', 'type', 'role', 'href', 'for', 'name', 'slot', 'style', 'aria-labelledby',
  'aria-describedby', 'aria-controls', 'aria-live', 'aria-atomic', 'autocomplete', 'inputmode',
  'viewBox', 'd', 'fill', 'stroke', 'xmlns', 'value', 'key', 'this', 'scope', 'tabindex'
]);
/** Syntax-tree keys that lead to styles and comments. */
const SKIP_KEYS = new Set(['css', 'leadingComments', 'trailingComments', 'comments']);

/** The copy that keeps a lower-case noun because it is a name, as the scan reads it. */
const NAMES = new Set([
  // Control captions and accessible names, and the tooltips that repeat them.
  'Resume active phase',
  'Pause active phase',
  'Restart active phase',
  'Skip active phase',
  'Enable selected phase',
  'Disable selected phase',
  'Pause workflow when this phase is reached',
  'Cancel scheduled pause for this phase',
  'Delete selected phase from workflow',
  'Retry the active phase now instead of waiting out the backoff',
  'Restart failed phase',
  'More phase actions',
  'More workflow actions',
  'New phase',
  'New workflow',
  ', switch workflow',
  'phase detail for',
  // Placeholders and field, crumb and setting captions.
  'Search phases',
  'Search workflows',
  'All workflows',
  'Selected phase',
  'Default workflow',
  'Custom phase prompts',
  // Dialog and banner titles, and a confirming button.
  'Retry phase now?',
  'Skip active phase?',
  'Delete active phase',
  'Delete future phase',
  'Delete phase',
  'Custom phase prompts are disabled',
  // Status and stand-in values.
  'no active phase',
  'Unknown workflow',
  'stderr lines this phase'
]);

interface Found {
  offset: number;
  text: string;
}

interface Hit {
  where: string;
  text: string;
}

function webviewSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...webviewSources(path));
      continue;
    }
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue;
    if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) files.push(path);
  }
  return files;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The words a Svelte node holds itself, or null when they sit in its children. */
function svelteNodeText(node: Record<string, unknown>): string | null {
  if (node.type === 'Text' && typeof node.data === 'string') return node.data;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (
    node.type === 'TemplateElement' &&
    isRecord(node.value) &&
    typeof node.value.cooked === 'string'
  ) {
    return node.value.cooked;
  }
  return null;
}

function collectSvelte(node: unknown, found: Found[]): void {
  if (Array.isArray(node)) {
    for (const child of node as unknown[]) collectSvelte(child, found);
    return;
  }
  if (!isRecord(node) || node.type === 'Comment') return;
  if (node.type === 'Attribute') {
    const name = typeof node.name === 'string' ? node.name : '';
    if (!SKIP_ATTRIBUTES.has(name) && !name.startsWith('data-')) collectSvelte(node.value, found);
    return;
  }
  const text = svelteNodeText(node);
  if (text !== null) {
    found.push({ offset: Number(node.start), text });
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (!SKIP_KEYS.has(key)) collectSvelte(value, found);
  }
}

function svelteStrings(file: string, source: string): Found[] {
  const ast = parse(source, { modern: true, filename: file });
  const found: Found[] = [];
  for (const part of [ast.fragment, ast.instance, ast.module]) collectSvelte(part, found);
  return found;
}

function scriptStrings(file: string, source: string): Found[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: Found[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      found.push({ offset: node.getStart(sourceFile), text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** Copy of two or more words that writes a product noun in lower case, flattened; else null. */
function lowerCaseCopy(text: string): string | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.includes(' ') && LOWER_CASE_NOUN.test(flat) ? flat : null;
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

function hitsIn(file: string): Hit[] {
  const source = readFileSync(file, 'utf8');
  const found = file.endsWith('.svelte')
    ? svelteStrings(file, source)
    : scriptStrings(file, source);
  return found.flatMap(({ offset, text }) => {
    const copy = lowerCaseCopy(text);
    if (copy === null) return [];
    return [{ where: `${relative(SOURCE_DIR, file)} line ${lineAt(source, offset)}`, text: copy }];
  });
}

/** Every hit across the sources, with each file that failed to parse and why. */
function scan(): { hits: Hit[]; failures: string[] } {
  const hits: Hit[] = [];
  const failures: string[] = [];
  for (const file of webviewSources(SOURCE_DIR)) {
    try {
      hits.push(...hitsIn(file));
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'the parser threw a non-error';
      failures.push(`${relative(SOURCE_DIR, file)}: ${reason}`);
    }
  }
  return { hits, failures };
}

describe('the case of Phase and Workflow in webview copy', () => {
  const { hits, failures } = scan();

  it('reads the webview sources outside the tests, and parses each', () => {
    const sources = webviewSources(SOURCE_DIR);
    expect(sources.length).toBeGreaterThan(250);
    expect(sources).toContain(join(SOURCE_DIR, 'main.ts'));
    expect(sources).toContain(join(SOURCE_DIR, 'components', 'PhaseControlMenu.svelte'));
    expect(sources.some((file) => file.endsWith('.test.ts'))).toBe(false);
    expect(failures).toEqual([]);
  });

  it('reads a lower-case noun in copy of two or more words, and nothing else', () => {
    expect(lowerCaseCopy('No phase\n      selected')).toBe('No phase selected');
    expect(lowerCaseCopy("the phase's output")).toBe("the phase's output");
    expect(lowerCaseCopy('All workflows')).toBe('All workflows');
    expect(lowerCaseCopy('No Phase selected')).toBeNull();
    expect(lowerCaseCopy('phase')).toBeNull();
    expect(lowerCaseCopy('the phaseName field')).toBeNull();
  });

  it('capitalises Phase and Workflow in every statement', () => {
    const offenders = hits
      .filter((hit) => !NAMES.has(hit.text))
      .map((hit) => `${hit.where}: ${hit.text}`);
    expect(offenders).toEqual([]);
  });

  it('still finds every name it lets keep its words', () => {
    const seen = new Set(hits.map((hit) => hit.text));
    expect([...NAMES].filter((name) => !seen.has(name))).toEqual([]);
  });
});
