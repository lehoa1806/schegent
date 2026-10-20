import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
 * count was ten. The decision, its measurement and what would reopen it are recorded in
 * `docs/development/section-reference-check.md`.
 *
 * WHAT IS CHECKED, and only this, in every live document `docs:check` walks. A link fragment
 * naming a heading in another Markdown file (F), and a `§` marker directly after a link or
 * backticked path naming another file (S), with only whitespace between, a line break included. F
 * resolves against the target's GitHub heading anchors and explicit HTML ids. S resolves by heading
 * text, by a quoted name ending in an ellipsis as a prefix, or by a numbered identifier at the start
 * of a heading.
 *
 * WHAT IS NOT. Records: the envelope's `docs/features/`, `docs/audits/` and `docs/plans/`, the
 * envelope's `ARCHITECTURE.md`, whose banner declares it one, and any page carrying the record
 * marker on its own line near its top, the rule `current-control-claims.test.ts` reads. A record
 * says what was true on its date. Line anchors (`#L42`), fragments on files that are not Markdown,
 * same-file anchors, a link naming its own file, and sections named in free prose are not checked
 * either. Prose would need a heuristic, and feature 219 declined one. A target outside both trees
 * being checked, symlinks resolved, or one that cannot be read, is unverifiable and is not read. A line, or a wrapped
 * paragraph, over 10,000 characters is not parsed; it is counted and reported instead.
 */
const REPO = resolve(__dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'check-doc-links.mjs');

const roots: string[] = [];

/** A fixture tree under the real temporary directory, so no symlink sits in its paths unasked. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'doc-section-references-'));
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
const RECORD_MARKER = '<!-- doc-class: record -->';

interface Failure {
  readonly file: string;
  readonly line: number;
  readonly form: string;
  readonly named: string;
  readonly reason: string;
}

interface Result {
  readonly checked: number;
  readonly failures: Failure[];
  readonly unverifiable: number;
  readonly unread: number;
}

function check(root: string, repo = join(root, 'repo')): Result {
  return checkSectionReferences({ repoRoot: repo, wsRoot: root });
}

/** The script copied into a fixture's `repo/scripts/`, so its roots are the fixture's. */
function installScript(root: string): string {
  const script = join(root, 'repo', 'scripts', 'check-doc-links.mjs');
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(SCRIPT, script);
  return script;
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

  it('resolves a § marker by identifier and by quoted name, wrapped ones included, and fails each when absent', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': TARGET,
      'repo/docs/citing.md': [
        'Present: `target.md` §2 and [target](target.md) §"Present heading".',
        '',
        'Absent: `target.md` §7 and [target](target.md) §"No such heading".',
        '',
        'Wrapped: what [target](target.md)',
        '§9 asks for, and what [target](target.md)',
        '§"Present heading" holds.',
        ''
      ].join('\n')
    });
    const { checked, failures } = check(root);
    expect(checked).toBe(6);
    expect(failures.map((f) => [f.line, f.form, f.named, f.reason])).toEqual([
      [3, 'S', '7', 'no-such-identifier'],
      [3, 'S', 'No such heading', 'no-such-heading'],
      [5, 'S', '9', 'no-such-identifier']
    ]);
  });

  it('reads an identifier only at a token boundary, and a link that wraps across a line', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': '# T\n\n## 21. Scope\n\n## Present heading\n',
      'repo/docs/citing.md': [
        '`target.md` §2 and `target.md` §21.',
        '',
        'See [the long',
        'name](target.md#gone) and [the other',
        'long name](target.md#present-heading).',
        ''
      ].join('\n')
    });
    const { checked, failures } = check(root);
    expect(checked).toBe(4);
    expect(failures.map((f) => [f.line, f.form, f.named, f.reason])).toEqual([
      [1, 'S', '2', 'no-such-identifier'],
      [3, 'F', 'gone', 'no-such-anchor']
    ]);
  });

  it('reads a reference definition, and a backticked path against the other tree', () => {
    const root = tree({
      ...ENVELOPE,
      'notes/only-here.md': '# Only here\n\n## Kept\n',
      'repo/docs/target.md': TARGET,
      'repo/docs/citing.md': '[ref]: target.md#gone\n\n`notes/only-here.md` §"Kept" and `notes/only-here.md` §"Gone".\n'
    });
    const { checked, failures } = check(root);
    expect(checked).toBe(3);
    expect(failures.map((f) => [f.line, f.form, f.named, f.reason])).toEqual([
      [1, 'F', 'gone', 'no-such-anchor'],
      [3, 'S', 'Gone', 'no-such-heading']
    ]);
  });

  it('skips what is not a section reference: a fragment on a file that is not Markdown, and link syntax quoted in code', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/script.ts': '// not Markdown\n',
      'repo/docs/target.md': TARGET,
      'repo/docs/citing.md': [
        '[code](script.ts#anything)',
        '',
        '`[quoted](target.md#gone)` is documentation of a link.',
        '',
        '`[quoted](target.md) §9` is documentation of a marker.',
        '',
        '```',
        '[fenced](target.md#gone)',
        '```',
        ''
      ].join('\n')
    });
    expect(check(root)).toMatchObject({ checked: 0, failures: [] });
  });

  it('renders headings as GitHub does: in a blockquote, after a shortcode or a time, snake_case, and stacked setext', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': [
        '# T',
        '',
        '> ## Quoted heading',
        '',
        '## :warning: Careful',
        '',
        '## run 21:34:01',
        '',
        '## the snake_case name and _emphasis_',
        '',
        'Title',
        '=====',
        'Subtitle',
        '--------',
        ''
      ].join('\n'),
      'repo/docs/citing.md': [
        '#quoted-heading',
        '#-careful',
        '#run-213401',
        '#the-snake_case-name-and-emphasis',
        '#title',
        '#subtitle'
      ]
        .map((fragment) => `[x](target.md${fragment})\n`)
        .join('\n')
    });
    expect(check(root)).toMatchObject({ checked: 6, failures: [] });
  });

  it('resolves as GitHub anchors do: duplicates, HTML ids, percent-encoding, setext, fences, case and the ellipsis rule', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/rules.md': [
        '# Rules',
        '',
        '## Recording cadence: at every merge',
        '',
        '## Notes',
        '',
        '## Notes',
        '',
        '<a id="kept-here"></a>',
        '',
        '## Café',
        '',
        'Setext title',
        '============',
        '',
        '```',
        '## Inside a fence',
        '```',
        ''
      ].join('\n'),
      'repo/docs/citing.md': [
        '[a](rules.md#notes-1)',
        '',
        '[a](rules.md#notes-2)',
        '',
        '[a](rules.md#kept-here)',
        '',
        '[a](rules.md#caf%C3%A9)',
        '',
        '[a](rules.md#setext-title)',
        '',
        '[a](rules.md#inside-a-fence)',
        '',
        '[a](rules.md#Notes)',
        '',
        '[a](rules.md) §"Recording cadence…"',
        '',
        '[a](rules.md) §"Recording cadence"',
        ''
      ].join('\n')
    });
    const { checked, failures } = check(root);
    expect(checked).toBe(9);
    expect(failures.map((f) => [f.line, f.named, f.reason])).toEqual([
      [3, 'notes-2', 'no-such-anchor'],
      [11, 'inside-a-fence', 'no-such-anchor'],
      [13, 'Notes', 'case-only'],
      [17, 'Recording cadence', 'prefix-only']
    ]);
  });

  it('reads no record, by directory, banner or marker, and no line anchor, same-file anchor or self-link', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': TARGET,
      'docs/audits/a-review.md': '[x](../../repo/docs/target.md#gone)\n',
      'docs/features/a-filing.md': '[x](../../repo/docs/target.md#gone)\n',
      'ARCHITECTURE.md': '# Envelope\n\n[x](repo/docs/target.md#gone)\n',
      'repo/docs/release/a-record.md': `# A record\n\n${RECORD_MARKER}\n\n[x](../target.md#gone)\n`,
      'repo/docs/citing.md': '[line](target.md#L3), [own](#nowhere) and [self](citing.md#nowhere)\n'
    });
    expect(check(root)).toMatchObject({ checked: 0, failures: [] });
  });

  it('judges records by the exact rule: the marker within ten lines, the envelope directories by prefix, the root ARCHITECTURE.md alone', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': TARGET,
      'repo/docs/late-marker.md': `${'line\n'.repeat(10)}${RECORD_MARKER}\n\n[x](target.md#gone)\n`,
      'repo/docs/padded-marker.md': `# Padded\n\n   ${RECORD_MARKER}   \n\n[x](target.md#gone)\n`,
      'docs/plans/a-plan.md': '[x](../../repo/docs/target.md#gone)\n',
      'docs/features-extra/a-page.md': '[x](../../repo/docs/target.md#gone)\n',
      'docs/ARCHITECTURE.md': '[x](../repo/docs/target.md#gone)\n'
    });
    const { checked, failures } = check(root);
    expect(checked).toBe(3);
    expect(failures.map((f) => [f.file, f.line]).sort()).toEqual([
      ['docs/ARCHITECTURE.md', 1],
      ['docs/features-extra/a-page.md', 1],
      ['repo/docs/late-marker.md', 13]
    ]);
  });

  it("reads a repo/ user guide under docs/features/, and a page that only mentions the record marker", () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': TARGET,
      'repo/docs/features/a-user-guide.md': '# Guide\n\n[x](../target.md#gone)\n',
      'repo/docs/mentions-the-marker.md': `A page marked \`${RECORD_MARKER}\` is skipped.\n\n[x](target.md#gone)\n`
    });
    const { checked, failures } = check(root);
    expect(checked).toBe(2);
    expect(failures.map((f) => [f.file, f.line, f.reason])).toEqual([
      ['repo/docs/features/a-user-guide.md', 3, 'no-such-anchor'],
      ['repo/docs/mentions-the-marker.md', 3, 'no-such-anchor']
    ]);
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

  it('does not read a target outside the tree being checked, by a relative path or through a symlink', () => {
    const root = tree({
      'ws/ARCHITECTURE.md': '# Envelope\n',
      'ws/CLAUDE.md': '# Pointer\n',
      'ws/docs/README.md': '# Docs\n',
      'ws/repo/docs/target.md': TARGET,
      'outside/secret.md': '# Secret\n\n## Hunter2\n',
      'ws/repo/docs/citing.md': '[up](../../../outside/secret.md#nope), [in](target.md#present-heading) and [linked](linked.md#nope)\n'
    });
    symlinkSync(join(root, 'outside', 'secret.md'), join(root, 'ws', 'repo', 'docs', 'linked.md'));
    const result = check(join(root, 'ws'));
    expect(result.failures).toEqual([]);
    expect(result.unverifiable).toBe(2);
    expect(result.checked).toBe(1);
  });

  it('reads a target inside either tree, when a root is spelled through a symlink', () => {
    const root = tree({
      'ws/ARCHITECTURE.md': '# Envelope\n',
      'ws/CLAUDE.md': '# Pointer\n',
      'ws/docs/README.md': '# Docs\n',
      'real-repo/docs/target.md': TARGET,
      'real-repo/docs/citing.md': '[x](target.md#gone) and [y](target.md#present-heading)\n'
    });
    symlinkSync(join(root, 'real-repo'), join(root, 'ws', 'repo'), 'dir');
    const result = check(join(root, 'ws'));
    expect(result.unverifiable).toBe(0);
    expect(result.checked).toBe(2);
    expect(result.failures.map((f) => [f.file, f.named])).toEqual([['repo/docs/citing.md', 'gone']]);
  });

  it('renders a numeric reference past U+10FFFF as U+FFFD, and does not throw on it', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': '# T\n\n## Bad &#x110000; reference\n\n## Long &#12345678901234567890; reference\n',
      'repo/docs/citing.md': '[a](target.md#bad--reference) and [b](target.md#long-12345678901234567890-reference)\n'
    });
    expect(check(root)).toMatchObject({ checked: 2, failures: [] });
  });

  it('leaves an entity inside a code span, or after a backslash, as written, as GitHub does', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': '# T\n\n## The `&amp;` entity\n\n## A \\&amp; B\n',
      'repo/docs/citing.md': '[a](target.md#the-amp-entity) and [b](target.md#a-amp-b)\n'
    });
    expect(check(root)).toMatchObject({ checked: 2, failures: [] });
  });

  it('counts a line, or a wrapped paragraph, too long to parse, rather than skipping it unseen', () => {
    const long = 'x'.repeat(10001);
    // The broken link wraps inside the paragraph, so only the joined read could see it, and the
    // count says that read did not happen.
    const wrapped = [`${'y'.repeat(4000)} [the`, `name](target.md#gone) ${'y'.repeat(4000)}`, 'y'.repeat(4000)].join('\n');
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': TARGET,
      'repo/docs/citing.md': `${long}\n\n${wrapped}\n\n[in](target.md#present-heading)\n`
    });
    expect(check(root)).toMatchObject({ checked: 1, failures: [], unread: 2 });
  });

  it('runs as a command by any path, a symlinked one included: exit 1, the failure printed, control characters neutralised', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': TARGET,
      'repo/docs/citing.md': 'See [absent](target.md#useful\u001b[2J-targets\u202e).\n[broken](missing\u001b[31m.md)\n'
    });
    const script = installScript(root);
    const linked = join(root, 'linked-scripts');
    symlinkSync(dirname(script), linked, 'dir');
    const run = spawnSync('node', [join(linked, 'check-doc-links.mjs')], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Unresolved section references (1):');
    expect(run.stderr).toContain('repo/docs/citing.md:1 -> repo/docs/target.md#useful?[2J-targets? (no-such-anchor)');
    expect(run.stderr).toContain('repo/docs/citing.md:2 -> missing?[31m.md');
    expect(run.stderr).not.toContain('\u001b');
    expect(run.stderr).not.toContain('\u202e');
  });

  it('says how many references it could not verify when the envelope is absent', () => {
    const root = tree({
      'repo/docs/target.md': TARGET,
      'repo/docs/citing.md': '[up](../../elsewhere.md#somewhere) and [in](target.md#present-heading)\n'
    });
    const script = installScript(root);
    const run = spawnSync('node', [script], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Section references checked: 1 in live documents, 1 outside this tree skipped.');
  });

  it('prints what it checked and what it could not read when it passes, and does nothing when imported', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': TARGET,
      'repo/docs/citing.md': `[in](target.md#present-heading)\n\n${'x'.repeat(10001)}\n`,
      'repo/docs/broken.md': '[out](target.md#gone)\n',
      'importer.mjs': "import './repo/scripts/check-doc-links.mjs';\n"
    });
    installScript(root);
    const imported = spawnSync('node', [join(root, 'importer.mjs')], { encoding: 'utf8' });
    expect([imported.status, imported.stdout, imported.stderr]).toEqual([0, '', '']);
    rmSync(join(root, 'repo', 'docs', 'broken.md'));
    const run = spawnSync('node', [join(root, 'repo', 'scripts', 'check-doc-links.mjs')], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Section references checked: 1 in live documents, 1 passage over 10000 characters not read.');
  });

  it('finds section references in the real tree, and none of them is unresolved', () => {
    // The vacuity control: an extractor that matched nothing would pass every other case here.
    const { checked, failures } = checkSectionReferences({ repoRoot: REPO, wsRoot: resolve(REPO, '..') });
    expect(checked).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});
