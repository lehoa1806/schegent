import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative, resolve, dirname } from 'node:path';

/**
 * FR-R3-063 — a documentation page nobody links to.
 *
 * The review's own auditor was caught by this: 21 of 53 pages had no inbound
 * link, in a tree the review had inventoried. A page with no inbound link is not
 * reachable by reading; it is reachable only by knowing it exists, which is the
 * opposite of what documentation is for. It also drifts unnoticed, because the
 * readers who would catch an error never arrive.
 *
 * The allowlist is reviewed content, not a dumping ground: every entry carries a
 * reason, and a page that gains an inbound link must leave it, or the list stops
 * describing anything.
 */
const ROOT = resolve(__dirname, '..', '..');
const DOCS = resolve(ROOT, 'docs');

/** Markdown links and bare relative references. */
const LINK = /\[[^\]]*\]\(([^)#\s]+)(?:#[^)\s]*)?\)/g;

/**
 * Entry points a reader arrives at without a link: the tree's own indexes and
 * the repository-root documents a reader meets first.
 */
const ENTRY_POINTS: ReadonlySet<string> = new Set(['README.md']);

/**
 * Empty, deliberately. The fix for an orphan is a link, not an entry here: the
 * acceptance for this gate says the allowlist is reviewed content and not a
 * dumping ground, and 20-odd entries would have been the dumping ground. Every
 * page the gate found is now indexed in `docs/README.md`.
 *
 * The mechanism stays for a page that genuinely has another entry point, and the
 * assertions below keep it honest: an entry must carry a reason, and must leave
 * once the page gains an inbound link.
 */
const ALLOWED_ORPHANS: ReadonlyMap<string, string> = new Map();

function markdownUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      markdownUnder(full, out);
      continue;
    }
    if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Every doc page, keyed as a docs-relative posix path. */
function pages(): readonly string[] {
  return markdownUnder(DOCS)
    .map((file) => relative(DOCS, file).split(/[/\\]/).join('/'))
    .sort();
}

/** Docs-relative targets linked from anywhere in the repository's Markdown. */
function linked(): ReadonlySet<string> {
  const citing = [...markdownUnder(DOCS), ...topLevelMarkdown()];
  const targets = new Set<string>();
  for (const file of citing) {
    const fromDir = dirname(file);
    for (const match of readFileSync(file, 'utf8').matchAll(LINK)) {
      const raw = match[1]!;
      if (/^[a-z]+:/.test(raw)) continue;
      const absolute = resolve(fromDir, raw);
      const rel = relative(DOCS, absolute).split(/[/\\]/).join('/');
      if (rel.startsWith('..')) continue;
      targets.add(posix.normalize(rel));
    }
  }
  return targets;
}

function topLevelMarkdown(): readonly string[] {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(ROOT, entry.name));
}

describe('every documentation page is reachable by reading (FR-R3-063)', () => {
  const all = pages();
  const inbound = linked();

  it('finds pages and links at all', () => {
    expect(all.length).toBeGreaterThan(30);
    expect(inbound.size).toBeGreaterThan(30);
  });

  it('has no orphan outside the reviewed allowlist', () => {
    const orphans = all
      .filter((page) => !ENTRY_POINTS.has(page))
      .filter((page) => !inbound.has(page))
      .filter((page) => !ALLOWED_ORPHANS.has(page));
    expect(orphans).toEqual([]);
  });

  it('keeps the allowlist live: an allowed orphan that gained a link must leave it', () => {
    const nowLinked = [...ALLOWED_ORPHANS.keys()].filter((page) => inbound.has(page));
    expect(nowLinked).toEqual([]);
  });

  it('requires a reason for every allowed orphan', () => {
    for (const [page, why] of ALLOWED_ORPHANS) {
      expect(why.length, `${page} needs a reason`).toBeGreaterThan(20);
    }
  });
});
