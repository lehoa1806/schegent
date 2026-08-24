import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * FR-R3-063 — `<!-- Source: ... -->` provenance markers name a real file.
 *
 * Every operator-facing page carries these to say where its claims came from,
 * and there are thousands of them. Nothing checked that the named file exists.
 * A marker pointing at a deleted module is worse than no marker: it presents the
 * claim above it as grounded, and a reader who wants to verify follows it to
 * nothing.
 *
 * Paths only. A marker may also carry a bare identifier or a prose note, and
 * demanding that everything after the colon be a file would fail on markers that
 * are doing something legitimate.
 */
const ROOT = resolve(__dirname, '..', '..');
const ENVELOPE = resolve(ROOT, '..');
const MARKER = /<!--\s*Source:\s*([^>]+?)\s*-->/g;

/** Looks like a path this repository could contain. */
function pathLike(value: string): boolean {
  if (!value.includes('/')) return false;
  if (/\s/.test(value)) return false;
  if (value.startsWith('http://') || value.startsWith('https://')) return false;
  // A glob names a set, not a file; resolving one is a different check.
  if (value.includes('*')) return false;
  return true;
}

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      markdownFiles(full, out);
      continue;
    }
    if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

interface Marker {
  readonly from: string;
  readonly line: number;
  readonly target: string;
}

function markers(): readonly Marker[] {
  const roots = [resolve(ROOT, 'docs'), ROOT];
  const seen = new Set<string>();
  const files: string[] = [];
  for (const root of roots) {
    for (const file of root === ROOT ? topLevelMarkdown() : markdownFiles(root)) {
      if (seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
  }
  const found: Marker[] = [];
  for (const file of files) {
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((text, index) => {
        for (const match of text.matchAll(MARKER)) {
          const target = match[1]!.trim();
          if (!pathLike(target)) continue;
          found.push({
            from: relative(ROOT, file).split(/[/\\]/).join('/'),
            line: index + 1,
            target
          });
        }
      });
  }
  return found;
}

function topLevelMarkdown(): readonly string[] {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(ROOT, entry.name));
}

/**
 * A marker is written relative to the CITING DOCUMENT first -- `docs/README.md`
 * cites `../package.json` -- and the tree also contains repo-root-relative and
 * envelope-relative (`repo/src/...`) forms. All three are accepted, because all
 * three are in use and this gate is about whether the reader can follow the
 * marker, not about normalising how it is written.
 */
function resolves(fromFile: string, target: string): boolean {
  const citingDir = dirname(resolve(ROOT, fromFile));
  return (
    existsSync(resolve(citingDir, target)) ||
    existsSync(resolve(ROOT, target)) ||
    existsSync(resolve(ENVELOPE, target)) ||
    existsSync(resolve(ROOT, target.replace(/^repo\//, '')))
  );
}

describe('provenance markers name a real file (FR-R3-063)', () => {
  const all = markers();

  it('finds a substantial number of markers', () => {
    // Guards the whole file. A regex that stopped matching would make the
    // assertion below pass by measuring nothing.
    expect(all.length).toBeGreaterThan(500);
  });

  it('resolves every path-shaped marker target', () => {
    const broken = all
      .filter((m) => !resolves(m.from, m.target))
      .map((m) => `${m.from}:${m.line} -> ${m.target}`);
    expect(broken).toEqual([]);
  });
});
