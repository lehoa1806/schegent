import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- .mjs script, typed by use rather than by declaration
import { checkSectionReferences } from '../../scripts/check-doc-links.mjs';

/**
 * FR-R3-184 (feature 219, T1821a) — `docs:check` resolves the section a live document names in
 * another file, not only the file's path.
 *
 * WHY THIS EXISTS. The path check passed a README that sent new contributors to build commands
 * under a label `repo/README.md` no longer had, because the link to the file resolved. Feature 219
 * counted the class at a fixed pair of commits, by a rule fixed before the count: ten or more
 * mechanical references in live documents that do not resolve means build a check. The corrected
 * count was ten. The decision, its measurement and what would retire it are recorded in
 * `docs/development/section-reference-check.md`.
 *
 * WHAT IS CHECKED, and only this. A link fragment naming a heading in another Markdown file (F),
 * and a `§` marker directly after a link or backticked path naming another file (S), with only
 * whitespace between, a line break included. F resolves against the target's GitHub heading
 * anchors and explicit HTML ids. S resolves by heading text, by a quoted name ending in an ellipsis
 * as a prefix, or by a numbered identifier at the start of a heading.
 *
 * WHAT IS NOT. Dated records (the `specs/`, `docs/features/`, `docs/audits/`, `docs/plans/`
 * prefixes of each tree) and three pages whose banners declare them records: dated records say
 * what was true on their date. Line anchors (`#L42`), fragments on files that are not Markdown,
 * same-file anchors, and sections named in free prose are not checked either. Prose would need a
 * heuristic, and feature 219 declined one. With the envelope absent, a target outside `repo/` is
 * unverifiable, not broken.
 */
const REPO = resolve(__dirname, '..', '..');

const roots: string[] = [];

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'doc-section-references-'));
  roots.push(root);
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

/** The planning envelope's three markers, so the check reads the fixture as an envelope. */
const ENVELOPE = { 'ARCHITECTURE.md': '# Envelope\n', 'CLAUDE.md': '# Pointer\n', 'docs/README.md': '# Docs\n' };
const TARGET = '# Target\n\n## Present heading\n\n## 2. Scope\n\nA paragraph.\n';

interface Failure {
  readonly file: string;
  readonly line: number;
  readonly form: string;
  readonly named: string;
  readonly reason: string;
}

function check(root: string, repo = join(root, 'repo')): { checked: number; failures: Failure[]; unverifiable: number } {
  return checkSectionReferences({ repoRoot: repo, wsRoot: root });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('FR-R3-184 — a section a live document names in another file exists', () => {
  it('fails a link fragment naming a heading its target does not have, and passes one it has', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': TARGET,
      'repo/docs/citing.md': 'See [present](target.md#present-heading).\n\nSee [absent](target.md#useful-targets).\n'
    });
    const { checked, failures } = check(root);
    expect(checked).toBe(2);
    expect(failures.map((f) => [f.file, f.line, f.form, f.named, f.reason])).toEqual([
      ['repo/docs/citing.md', 3, 'F', 'useful-targets', 'no-such-anchor']
    ]);
  });

  it('resolves a § marker by identifier and by quoted name, a wrapped one included', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': TARGET,
      'repo/docs/citing.md': [
        'Present: `target.md` §2 and [target](target.md) §"Present heading".',
        '',
        'Absent: `target.md` §7.',
        '',
        'Wrapped: what [target](target.md)',
        '§9 asks for.',
        ''
      ].join('\n')
    });
    const { checked, failures } = check(root);
    expect(checked).toBe(4);
    expect(failures.map((f) => [f.line, f.form, f.named, f.reason])).toEqual([
      [3, 'S', '7', 'no-such-identifier'],
      [5, 'S', '9', 'no-such-identifier']
    ]);
  });

  it('reads no dated record, no banner-declared record, no line anchor and no same-file anchor', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': TARGET,
      'repo/docs/features/a-user-page.md': '[x](../target.md#gone)\n',
      'repo/docs/operations/merge-gate-observation.md': '[x](../target.md#gone)\n',
      'docs/audits/a-review.md': '[x](../../repo/docs/target.md#gone)\n',
      'ARCHITECTURE.md': '# Envelope\n\n[x](repo/docs/target.md#gone)\n',
      'repo/docs/citing.md': '[line](target.md#L3) and [own](#nowhere)\n'
    });
    expect(check(root)).toMatchObject({ checked: 0, failures: [] });
  });

  it('treats a target outside repo/ as unverifiable when the envelope is absent', () => {
    const root = tree({
      'repo/docs/target.md': TARGET,
      'repo/docs/citing.md': '[up](../../elsewhere.md#somewhere) and [in](target.md#present-heading)\n'
    });
    const result = check(root);
    expect(result.failures).toEqual([]);
    expect(result.unverifiable).toBe(1);
    expect(result.checked).toBe(1);
  });

  it('finds section references in the real tree, and none of them is unresolved', () => {
    // The vacuity control: an extractor that matched nothing would pass every other case here.
    const { checked, failures } = checkSectionReferences({ repoRoot: REPO, wsRoot: resolve(REPO, '..') });
    expect(checked).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});
