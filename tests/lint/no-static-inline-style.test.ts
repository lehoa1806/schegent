// No static inline style in the webview's Svelte components (FR-R4-F08, contract P: N4, P11; FR-028).
//
// WHAT THIS PINS. The webview ships under a policy whose `style-src` takes the local origin and a
// nonce and nothing else, so a `style="..."` attribute is a policy violation: Chromium reports it
// (`style-src-attr`) whether or not it still applies the declarations. Thirteen static attributes
// in the Builder's editors did exactly that, and `tests/visual/actual-policy.visual.spec.ts` is the
// browser check that found them. This is the cheap half that keeps them out: a static attribute is
// a `style="..."` whose value holds no `{`, and none may be added to a `.svelte` file under
// `webview-ui/src`.
//
// THE ONE ALLOWED ATTRIBUTE. A dynamic value (`style="--wf-arms: {n}"`) is applied by Svelte
// through the CSSOM, which the policy does not govern, so it is not a violation. There is exactly
// one today, and its count is pinned: a reviewer raises it only when a new dynamic attribute is
// justified, so a static one cannot be added by relabelling it dynamic.
//
// This gate cannot pass vacuously: it asserts it scanned a real tree, and its control feeds the
// scanner a synthetic static attribute that it must refuse and a dynamic one that it must not.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WEBVIEW_SRC = join(REPO_ROOT, 'webview-ui', 'src');
/** The dynamic `style` attributes in the tree today: `WorkflowFlowSubtree.svelte` sets `--wf-arms`. */
const EXPECTED_DYNAMIC_STYLE_ATTRIBUTES = 1;
/** Fewer than this means the scan is not looking at the webview. */
const MIN_SVELTE_FILES = 100;

interface StyleAttribute {
  readonly line: number;
  readonly value: string;
}

function svelteFilesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') found.push(...svelteFilesUnder(path));
    } else if (entry.name.endsWith('.svelte')) {
      found.push(path);
    }
  }
  return found;
}

/** Every `style="..."` attribute in a source text, with its 1-based line. */
function styleAttributes(source: string): StyleAttribute[] {
  const found: StyleAttribute[] = [];
  for (const match of source.matchAll(/\bstyle="([^"]*)"/g)) {
    const before = source.slice(0, match.index);
    found.push({ line: before.split('\n').length, value: match.at(1) ?? '' });
  }
  return found;
}

const isStatic = (attribute: StyleAttribute): boolean => !attribute.value.includes('{');

interface Scan {
  readonly files: number;
  readonly staticOffenders: readonly string[];
  readonly dynamicCount: number;
}

function scanTree(): Scan {
  const files = svelteFilesUnder(WEBVIEW_SRC);
  const staticOffenders: string[] = [];
  let dynamicCount = 0;
  for (const file of files) {
    for (const attribute of styleAttributes(readFileSync(file, 'utf8'))) {
      if (isStatic(attribute)) {
        staticOffenders.push(`${relative(REPO_ROOT, file)}:${attribute.line}`);
      } else {
        dynamicCount += 1;
      }
    }
  }
  return { files: files.length, staticOffenders, dynamicCount };
}

describe('no static inline style in webview Svelte files (FR-028)', () => {
  const scan = scanTree();

  it('scanned a real webview tree', () => {
    expect(scan.files).toBeGreaterThan(MIN_SVELTE_FILES);
  });

  it('holds no static style attribute, and names each offender as path:line', () => {
    expect(scan.staticOffenders).toEqual([]);
  });

  it('holds exactly the one dynamic style attribute it is known to hold', () => {
    // A reviewer raises this only when a new dynamic attribute is justified.
    expect(scan.dynamicCount).toBe(EXPECTED_DYNAMIC_STYLE_ATTRIBUTES);
  });

  it('control: a synthetic static attribute is refused and a dynamic one is not', () => {
    const synthetic = '<div class="a" style="margin-left:auto"></div>\n<p style="--x: {n}"></p>';
    const found = styleAttributes(synthetic);
    expect(found.length).toBe(2);
    expect(found.filter(isStatic).map((attribute) => attribute.line)).toEqual([1]);
    expect(found.filter((attribute) => !isStatic(attribute)).map((attribute) => attribute.line)).toEqual([2]);
  });
});
