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

/**
 * FR-R4-F11 (FR-022, SC-006) — the pages a newcomer meets first, repo-relative. Each must link only
 * to files inside this repository.
 *
 * WHY. `CONTRIBUTING.md` linked `../AGENTS.md`, a file one directory above the checkout. In the
 * planning envelope it resolves; in a standalone clone it is a dead link on the second page a
 * contributor reads, and `scripts/check-doc-links.mjs` reports it as unverifiable rather than
 * broken (it cannot tell a missing envelope from a missing file). A file that lives only in the
 * envelope is named in text on these pages, with an instruction to obtain it, never linked.
 *
 * The two security policies are here because they are the entry points of the security reader, not
 * because the filing named them.
 */
const ENTRY_PAGES: readonly string[] = [
  'README.md',
  'CONTRIBUTING.md',
  'AGENTS.md',
  'docs/README.md',
  'SECURITY.md',
  '.github/SECURITY.md'
];

/**
 * Pure: the link targets of one entry page that resolve outside the repository root. A scheme
 * (`https:`, `mailto:`) is not a file, and a pure `#anchor` has no path, so neither can escape; the
 * shared `LINK` pattern captures the path part only, so it never sees the latter. One body for the
 * live pages and for the synthetic corpus of the NON-VACUITY case.
 */
function escapingLinks(file: string, body: string): string[] {
  const fromDir = dirname(join(ROOT, file));
  const escaping: string[] = [];
  for (const match of body.matchAll(LINK)) {
    const raw = match.at(1);
    if (raw === undefined || /^[a-z]+:/.test(raw)) continue;
    if (relative(ROOT, resolve(fromDir, raw)).startsWith('..')) escaping.push(raw);
  }
  return escaping;
}

/**
 * FR-R4-F11 (FR-031, SC-008) — pages the "Complete index" section of `docs/README.md` may leave
 * out, each with the reason. Empty, deliberately, and for the same reason `ALLOWED_ORPHANS` is.
 *
 * WHY THIS IS NOT THE ORPHAN CHECK. A page can have an inbound link and still be missing from the
 * index: 37 pages were linked from somewhere and listed nowhere in the section whose heading and
 * coverage paragraph said it lists every page. The orphan check passes on any inbound link, so it
 * could not see that. This one reads the section itself.
 *
 * An entry needs a reason a reader can act on, and leaves the moment the page is listed: an
 * exclusion for a page that is listed describes nothing.
 */
const INDEX_EXCLUSIONS: ReadonlyMap<string, string> = new Map();

/** The text from the `## Complete index` heading to the next `## ` heading. Throws without the heading. */
function completeIndexSection(readme: string): string {
  const lines = readme.split('\n');
  const start = lines.findIndex((line) => line.startsWith('## Complete index'));
  if (start < 0) throw new Error('docs/README.md has no "## Complete index" section');
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start, next < 0 ? lines.length : next).join('\n');
}

/**
 * Pure: the pages, `README.md` excepted, that the section does not link and the exclusions do not
 * name. Link targets are resolved relative to `docs/` with the shared `LINK` pattern. One body for
 * the live README and for the synthetic corpus of the NON-VACUITY case.
 */
function unindexed(
  allPages: readonly string[],
  section: string,
  exclusions: ReadonlyMap<string, string>
): string[] {
  const listed = new Set<string>();
  for (const match of section.matchAll(LINK)) {
    const raw = match.at(1);
    if (raw === undefined || /^[a-z]+:/.test(raw)) continue;
    const target = relative(DOCS, resolve(DOCS, raw)).split(/[/\\]/).join('/');
    if (!target.startsWith('..')) listed.add(posix.normalize(target));
  }
  return allPages.filter(
    (page) => page !== 'README.md' && !listed.has(page) && !exclusions.has(page)
  );
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

  it('no entry page links to a file outside this repository (FR-R4-F11)', () => {
    const escaping = ENTRY_PAGES.flatMap((file) =>
      escapingLinks(file, readFileSync(join(ROOT, file), 'utf8')).map((target) => `${file} -> ${target}`)
    );
    expect(
      escaping,
      'an entry page links outside the repository, so it is a dead link in a standalone clone: ' +
        'name the envelope file in text and say to obtain it instead — ' +
        escaping.join('; ')
    ).toEqual([]);
  });

  it('the Complete index section lists every page under docs/ or records an exclusion (FR-R4-F11)', () => {
    const section = completeIndexSection(readFileSync(join(DOCS, 'README.md'), 'utf8'));
    const missing = unindexed(all, section, INDEX_EXCLUSIONS);
    expect(
      missing,
      'docs/README.md "## Complete index" does not list these pages. Add each to the section, ' +
        `or exclude it in INDEX_EXCLUSIONS with a reason — ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('keeps the index exclusions live: an excluded page that the section lists must leave', () => {
    const section = completeIndexSection(readFileSync(join(DOCS, 'README.md'), 'utf8'));
    const nowListed = [...INDEX_EXCLUSIONS.keys()].filter(
      (page) => unindexed([page], section, new Map()).length === 0
    );
    expect(nowListed).toEqual([]);
  });

  it('requires a reason for every index exclusion', () => {
    for (const [page, why] of INDEX_EXCLUSIONS) {
      expect(why.length, `${page} needs a reason`).toBeGreaterThan(20);
    }
  });

  it('the Complete index section names the gate that enforces it', () => {
    // The coverage text in the section must point at what holds it to account, so a reader who
    // wonders why a page is listed there is told, and a rewrite that drops the pointer is caught.
    const section = completeIndexSection(readFileSync(join(DOCS, 'README.md'), 'utf8'));
    expect(section).toContain('tests/lint/doc-orphan-pages.test.ts');
  });

  it('NON-VACUITY: unindexed reads the section only, and honours an exclusion', () => {
    // The same function the live case calls, over a synthetic README. `d.md` is linked before
    // and after the section but not inside it, which proves the section boundary in both
    // directions; `b/c.md` is linked nowhere.
    const readme = [
      '# Docs',
      '[early](d.md)',
      '## Complete index',
      '- [A](a.md)',
      '## Other',
      '[late](d.md)'
    ].join('\n');
    const section = completeIndexSection(readme);
    const synthetic = ['a.md', 'b/c.md', 'd.md'];
    expect(unindexed(synthetic, section, new Map())).toEqual(['b/c.md', 'd.md']);
    expect(unindexed(synthetic, section, new Map([['b/c.md', 'a synthetic reason long enough']]))).toEqual(['d.md']);
    // `README.md` is never required to list itself, and a missing heading is an error, not a pass.
    expect(unindexed(['README.md'], section, new Map())).toEqual([]);
    expect(() => completeIndexSection('# Docs\n- [A](a.md)')).toThrow('Complete index');
  });

  it('NON-VACUITY: escapingLinks reports a link that leaves the repository and no other', () => {
    // The same function the live case calls, over a synthetic corpus.
    expect(escapingLinks('CONTRIBUTING.md', 'See [x](../AGENTS.md) for the rules.')).toEqual(['../AGENTS.md']);
    expect(escapingLinks('CONTRIBUTING.md', 'See [y](docs/README.md) for the index.')).toEqual([]);
    // The path is resolved from the page's own directory: `..` from `docs/` stays inside.
    expect(escapingLinks('docs/README.md', '[a](../AGENTS.md) [b](../../AGENTS.md)')).toEqual(['../../AGENTS.md']);
    // A scheme and a pure anchor cannot leave.
    expect(escapingLinks('README.md', '[c](https://example.com/x) [d](#section) [e](mailto:a@b.c)')).toEqual([]);
  });
});
