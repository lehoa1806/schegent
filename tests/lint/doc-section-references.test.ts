import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
 * paragraph, over 10,000 characters or holding more than 256 of `[`, `<`, a backtick and `§` is not parsed; it is
 * counted and reported instead. A fence marker over a cap keeps its role. A target's heading over either cap, or
 * whose text runs into a line that was not read, is not indexed.
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
/** U+2028, U+2029 and a lone carriage return: line terminators a line split on `\n` can still hold. */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const CARRIAGE_RETURN = String.fromCharCode(13);
/** U+00A0, whitespace to `\s` though no space. */
const NO_BREAK_SPACE = String.fromCharCode(0xa0);

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
        '',
        'Intro text',
        '[the third',
        'name](target.md#also-gone)',
        ''
      ].join('\n')
    });
    const { checked, failures } = check(root);
    expect(checked).toBe(5);
    // A wrapped link that opens a line is reported on that line, not on the line before it.
    expect(failures.map((f) => [f.line, f.form, f.named, f.reason])).toEqual([
      [1, 'S', '2', 'no-such-identifier'],
      [3, 'F', 'gone', 'no-such-anchor'],
      [8, 'F', 'also-gone', 'no-such-anchor']
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
        '- see [the long',
        '- name](target.md#gone)',
        '',
        'Intro [the',
        '## name](target.md#gone)',
        '',
        '| [the |',
        '| name](target.md#gone) |',
        '',
        'An empty fence ends [the',
        '```',
        '```',
        'name](target.md#gone)',
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
        '',
        '## Foo',
        '',
        '## Foo 1',
        '',
        '## Foo',
        '',
        '## Bar',
        '',
        '## Bar',
        '',
        '## Bar 1',
        '',
        '## Closed ##',
        '',
        '## Real',
        '---',
        '',
        '```',
        'code',
        '```',
        '---',
        '',
        '#hashtag is not a heading',
        '',
        '    # indented code',
        '',
        '####### seven hashes',
        '',
        '  Two  ',
        '  Lines',
        '=====',
        '',
        `## Bad${LINE_SEPARATOR}heading`,
        '',
        `\`\`\`${LINE_SEPARATOR}x`,
        '',
        '## After the false fence',
        '',
        '## §3 Scope',
        '',
        '## ⚠',
        '',
        '## ⚠',
        '',
        `## Bad${PARAGRAPH_SEPARATOR}para`,
        '',
        `## Bad${CARRIAGE_RETURN}cr`,
        '',
        '> > ## Nested quote',
        ''
      ].join('\n'),
      'repo/docs/crlf.md': '# T\r\n\r\n## Crlf heading\r\n',
      'repo/docs/citing.md': [
        '#quoted-heading',
        '#-careful',
        '#run-213401',
        '#the-snake_case-name-and-emphasis',
        '#title',
        '#subtitle',
        '#foo-2',
        '#bar-1-1',
        '#closed',
        '#real',
        '#-real',
        '#code',
        '#hashtag-is-not-a-heading',
        '#indented-code',
        '#seven-hashes',
        '#two-lines',
        '#badheading',
        '#after-the-false-fence',
        '#-1',
        '#badpara',
        '#badcr',
        '#nested-quote'
      ]
        .map((fragment) => `[x](target.md${fragment})\n`)
        .join('\n')
        .concat('\n`target.md` §3 and [x](crlf.md#crlf-heading)\n')
    });
    const { checked, failures } = check(root);
    expect(checked).toBe(24);
    // A line terminator inside a line, U+2028, U+2029 or a lone carriage return, makes it neither a
    // heading nor a fence marker. A heading quoted twice is still a heading.
    expect(failures.map((f) => f.named)).toEqual(['-real', 'code', 'hashtag-is-not-a-heading', 'indented-code', 'seven-hashes', 'badheading', 'badpara', 'badcr']);
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
      'repo/docs/accents.md': '## Zebra\n\n## Éa\n\n## Éb\n\n## Éc\n',
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
        '',
        '[a](rules.md#Kept-Here)',
        '',
        '[a](rules.md) §"Notes…"',
        '',
        '[a](accents.md) §"zeb…"',
        '',
        '[a](rules.md) §"Zzz"',
        ''
      ].join('\n')
    });
    const { checked, failures } = check(root);
    expect(checked).toBe(13);
    // An ellipsis name that is a whole heading resolves: it is its own prefix. A prefix is found in
    // code-unit order, where `zebra` sorts before `éa`, as no locale order has it, and a name past
    // every heading fails rather than throwing.
    expect(failures.map((f) => [f.line, f.named, f.reason])).toEqual([
      [3, 'notes-2', 'no-such-anchor'],
      [11, 'inside-a-fence', 'no-such-anchor'],
      [13, 'Notes', 'case-only'],
      [17, 'Recording cadence', 'prefix-only'],
      [19, 'Kept-Here', 'case-only'],
      [25, 'Zzz', 'no-such-heading']
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
      'docs/ARCHITECTURE.md': '[x](../repo/docs/target.md#gone)\n',
      'notes/docs/features/a-page.md': '[x](../../../repo/docs/target.md#gone)\n'
    });
    const { checked, failures } = check(root);
    expect(checked).toBe(4);
    expect(failures.map((f) => [f.file, f.line]).sort()).toEqual([
      ['docs/ARCHITECTURE.md', 1],
      ['docs/features-extra/a-page.md', 1],
      ['notes/docs/features/a-page.md', 1],
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
      'ws/repo/docs/citing.md': '[linked](linked.md#nope), [up](../../../outside/secret.md#nope) and [in](target.md#present-heading)\n'
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

  it('does not read a passage too dense to parse, in a citing page or a target, and counts it', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': [
        '# T',
        '',
        `## 9. ${'[e] '.repeat(257)}`,
        '',
        `§8 ${'[f] '.repeat(200)}`,
        '[f] '.repeat(100),
        '===',
        '',
        `§7 ${'y'.repeat(6000)}`,
        'y'.repeat(6000),
        '===',
        '',
        '## 6. Present',
        ''
      ].join('\n'),
      'repo/docs/citing.md': [
        '`target.md` §9, `target.md` §8, `target.md` §7 and `target.md` §6.',
        '',
        `[x](target.md#gone-dense) ${'[b] '.repeat(256)}`,
        '',
        `${'[c] '.repeat(200)}[the`,
        `name](target.md#gone-wrapped) ${'[d] '.repeat(100)}`,
        '',
        `[y](target.md#gone-at-the-cap) ${'[b] '.repeat(255)}`,
        '',
        `[x](target.md#gone-angles) ${'<'.repeat(256)}`,
        '',
        `[x](target.md#gone-ticks) ${'`'.repeat(256)}`,
        '',
        `[x](target.md#gone-marks) ${'§'.repeat(256)}`,
        ''
      ].join('\n')
    });
    const { checked, failures, unread } = check(root);
    // Not indexed: an ATX heading over 256 openers, and setext headings over 256 openers or 10,000
    // characters, each joined from lines within both. Not read: a citing line over 256 openers, of
    // each of the four kinds, and a wrapped paragraph over 256. Read: a line holding exactly 256.
    expect(failures.map((f) => [f.file, f.line, f.named, f.reason])).toEqual([
      ['repo/docs/citing.md', 1, '9', 'no-such-identifier'],
      ['repo/docs/citing.md', 1, '8', 'no-such-identifier'],
      ['repo/docs/citing.md', 1, '7', 'no-such-identifier'],
      ['repo/docs/citing.md', 8, 'gone-at-the-cap', 'no-such-anchor']
    ]);
    expect(checked).toBe(5);
    // Three passages in the target, which is a live page too, and five in the citing page.
    expect(unread).toBe(8);
  });

  it('keeps the structure a dense line marks: a fence opens and closes where it did, and a setext heading that runs into an unread line is not indexed', () => {
    const dense = '['.repeat(300);
    const root = tree({
      ...ENVELOPE,
      'repo/docs/fenced-target.md': [
        '# T',
        '',
        `\`\`\`js ${dense}`,
        '## Inside',
        '```',
        '',
        '```',
        `\`\`\` ${dense}`,
        '## Still inside',
        '```',
        ''
      ].join('\n'),
      'repo/docs/setext-target.md': ['# S', '', `x${dense}`, 'Real title', '==========', '', '## Present', ''].join('\n'),
      'repo/docs/citing.md': [
        '[a](fenced-target.md#inside), [b](fenced-target.md#still-inside), [c](setext-target.md#real-title) and [d](setext-target.md#present)',
        '',
        `\`\`\`${dense}`,
        'quoted [x](fenced-target.md#gone-inside-a-fence)',
        '```',
        '',
        '[y](fenced-target.md#gone-after-the-fence)',
        '',
        `> \`\`\`${dense}`,
        '[q](fenced-target.md#gone-after-a-quoted-marker)',
        ''
      ].join('\n'),
      'repo/docs/citing-long-fence.md': ['```', 'code', '`'.repeat(300), '', '[z](fenced-target.md#gone-after-the-long-fence)', ''].join('\n')
    });
    const { checked, failures, unread } = check(root);
    // A dense opener still opens, with or without an info string, and a dense line with an info
    // string still does not close. A dense closer still closes. A quoted marker opens nothing in a
    // citing page, dense or not. Real title's heading text runs into an unread line, so it fails.
    expect(failures.map((f) => [f.file, f.line, f.named]).sort()).toEqual([
      ['repo/docs/citing-long-fence.md', 5, 'gone-after-the-long-fence'],
      ['repo/docs/citing.md', 1, 'inside'],
      ['repo/docs/citing.md', 1, 'real-title'],
      ['repo/docs/citing.md', 1, 'still-inside'],
      ['repo/docs/citing.md', 10, 'gone-after-a-quoted-marker'],
      ['repo/docs/citing.md', 7, 'gone-after-the-fence']
    ]);
    expect(checked).toBe(7);
    // Fence markers are not counted: the passes never read them. The quoted marker and `x` + 300 are.
    expect(unread).toBe(2);
  });

  it('keeps a dense fence marker exact as a target reads it: a bare closer closes, a quote or tildes open, a line terminator unmakes it', () => {
    const dense = '['.repeat(300);
    const root = tree({
      ...ENVELOPE,
      'repo/docs/fences.md': [
        '# F',
        '',
        '```',
        '## In A',
        '`'.repeat(300),
        '',
        '## After A',
        '',
        '```',
        '## In B',
        `\`\`\`${' '.repeat(10001)}`,
        '',
        '## After B',
        '',
        `> > \`\`\`${dense}`,
        '> > ## In C',
        '> > ```',
        '',
        '## After C',
        '',
        `~~~${dense}`,
        '## In D',
        '~~~',
        '',
        '## After D',
        '',
        '```',
        '## In E',
        `\`\`\`${LINE_SEPARATOR}${' '.repeat(10001)}`,
        '## Still in E',
        '```',
        '',
        `\`\`\`${dense}${PARAGRAPH_SEPARATOR}`,
        '## Outside F',
        '',
        '    ```',
        '## After indented',
        '',
        '```',
        '## In G',
        '  ```',
        '## After G',
        '',
        '```',
        '## In H',
        '~~~',
        '## Still in H',
        '```',
        '',
        '`````',
        '## In I',
        '`'.repeat(300),
        '## After I',
        '',
        `    \`\`\`${dense}`,
        '## After dense indent',
        '',
        `>     \`\`\`${dense}`,
        '## After quoted indent',
        '',
        '```',
        'code',
        '`'.repeat(10001),
        '',
        '```',
        '## Hidden in a fence',
        '```',
        '',
        '## Visible after a long closer',
        '',
        '```',
        'code',
        '`'.repeat(10001),
        '',
        '~~~',
        '## Hidden in the tilde fence',
        '```',
        '## Looks like a heading',
        '~~~',
        '',
        '```',
        '## In L',
        `\`\`\`${'\t'.repeat(10001)}`,
        '## After L',
        '',
        `   \`\`\`${dense}`,
        '## In M',
        '```',
        '',
        `>\t    \`\`\`${dense}`,
        '## After a quoted tab',
        '',
        `>    \`\`\`${dense}`,
        '## In N',
        '```',
        '',
        `>${NO_BREAK_SPACE}\`\`\`${dense}`,
        '## In O',
        '```',
        '',
        `>\t> \`\`\`${dense}`,
        '## In P',
        '```',
        '',
        '`'.repeat(10000),
        '## Between ten thousands',
        '`'.repeat(10000),
        '',
        '## After ten thousands',
        '',
        '~~~',
        '## In a tilde fence',
        '~'.repeat(10001),
        '',
        '## After a long tilde closer',
        '',
        '```',
        '## In a backtick fence',
        '~'.repeat(10001),
        '## Still in backtick fence',
        '```',
        '',
        `${'`'.repeat(10001)}${CARRIAGE_RETURN}tail`,
        '## After a long run and CR',
        '',
        '```',
        '## Inside Q',
        `${'`'.repeat(10001)} x`,
        '## Still inside Q',
        '```',
        '',
        '```',
        '## In T',
        '``` ',
        '## After T',
        '',
        ` \`\`${dense}`,
        '===',
        '',
        '## End',
        '',
        '`'.repeat(20000),
        '## Behind a long run',
        '`'.repeat(30000),
        '## After a long run',
        ''
      ].join('\n'),
      'repo/docs/long-tilde.md': ['# L', '', '~'.repeat(20000), '## Behind a long tilde run', '~'.repeat(30000), '## After a long tilde run', ''].join('\n'),
      'repo/docs/long-info.md': ['# L', '', `${'`'.repeat(20000)}js`, '## Behind a long run with info', '`'.repeat(10001), '## After a long run with info', ''].join('\n'),
      'repo/docs/citing-fences.md': [
        'after-a',
        'after-b',
        'in-c',
        'after-c',
        'in-d',
        'after-d',
        'still-in-e',
        'outside-f',
        'after-indented',
        'after-g',
        'still-in-h',
        'after-i',
        'after-dense-indent',
        'after-quoted-indent',
        'hidden-in-a-fence',
        'visible-after-a-long-closer',
        'hidden-in-the-tilde-fence',
        'looks-like-a-heading',
        'after-l',
        'in-m',
        'after-a-quoted-tab',
        'in-n',
        'in-o',
        'in-p',
        'between-ten-thousands',
        'after-ten-thousands',
        'after-a-long-tilde-closer',
        'still-in-backtick-fence',
        'after-a-long-run-and-cr',
        'still-inside-q',
        'after-t',
        '-x',
        'end',
        'behind-a-long-run',
        'after-a-long-run'
      ]
        .map((fragment) => `[x](fences.md#${fragment})`)
        .concat(
          '[x](long-tilde.md#behind-a-long-tilde-run)',
          '[x](long-tilde.md#after-a-long-tilde-run)',
          '[x](long-info.md#behind-a-long-run-with-info)',
          '[x](long-info.md#after-a-long-run-with-info)'
        )
        .join('\n\n'),
      'repo/docs/citing-indented.md': `    \`\`\`${dense}\n[w](fences.md#gone-behind-an-indented-marker)\n`,
      'repo/docs/citing-tab.md': `\t\`\`\`${dense}\n\n[w](fences.md#gone-behind-a-tab-marker)\n`,
      'repo/docs/citing-two.md': `\`\`${dense}\n[t](fences.md#gone-after-two-backticks)\n`,
      'repo/docs/citing-wrapped.md': ['[x', 'more](fences.md#gone-wrapped-beside-a-quote)', `> ${'`'.repeat(300)}`, ''].join('\n')
    });
    const { checked, failures } = check(root);
    // Up to the last long run, each answer is the one the target gives with no caps at all. A dense
    // bare closer, or one padded past the length cap with spaces or tabs, closes, and a dense closer
    // longer than its opener closes it, a run past the cap included; a dense opener behind two
    // quotes, of tildes, or behind three spaces opens; a line terminator after a run makes the line
    // no marker, dense or not; four spaces make no fence, dense or not, nor do a quote and five
    // spaces, or a quote, a tab and four; a quote with four spaces, with a no-break space, or two
    // quotes split by a tab, open one; two spaces make a closer; tildes do not close backticks. A
    // fence a run past the length cap opens is never closed, though a longer closer would close it on
    // GitHub: past the cap the check fails closed. In a citing page, a dense marker behind four spaces
    // or a tab still toggles the plain fence, so the link after it is not read; two backticks do not;
    // and a dense quoted line beside a wrapped link leaves the link to be read. Runs of exactly
    // 10,000 open and close as any run does; a run past the cap closes a shorter fence of its own
    // character only; a line terminator after it makes it no marker; with an info string it closes
    // nothing; a closer may end in a space; two backticks open nothing, so a dense line of them
    // above `===` makes no heading; and a fence a run past the cap opens, of either character, with
    // an info string or not, is never closed.
    expect(failures.map((f) => f.named).sort()).toEqual([
      '-x',
      'after-a-long-run',
      'after-a-long-run-with-info',
      'after-a-long-tilde-run',
      'behind-a-long-run',
      'behind-a-long-run-with-info',
      'behind-a-long-tilde-run',
      'between-ten-thousands',
      'gone-after-two-backticks',
      'gone-wrapped-beside-a-quote',
      'hidden-in-a-fence',
      'hidden-in-the-tilde-fence',
      'in-c',
      'in-d',
      'in-m',
      'in-n',
      'in-o',
      'in-p',
      'looks-like-a-heading',
      'still-in-backtick-fence',
      'still-in-e',
      'still-in-h',
      'still-inside-q'
    ]);
    expect(checked).toBe(41);
  });

  it('reads a dense line beside a setext heading as it reads the page with no caps', () => {
    const dense = '['.repeat(300);
    const root = tree({
      ...ENVELOPE,
      'repo/docs/setext.md': ['# S', '', `<!-- ${dense} -->`, 'Title one', '=========', '', 'Title two', '=========', `x${dense}`, ''].join('\n'),
      'repo/docs/citing.md': '[x](setext.md#title-one)\n\n[y](setext.md#title-two)\n'
    });
    // A dense line that is no paragraph line above the heading, or any dense line below its
    // underline, leaves the heading's text whole, so it is indexed.
    expect(check(root)).toMatchObject({ checked: 2, failures: [] });
  });

  it('reads a line of any length without overflowing: millions of `>`, and a fence marker behind them', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': `${TARGET}\n${'>'.repeat(3_400_000)}\n\n${'>'.repeat(2_500_000)}\`\`\`\n`,
      'repo/docs/citing.md': '[x](target.md#present-heading)\n'
    });
    expect(check(root)).toMatchObject({ checked: 1, failures: [], unread: 2 });
  });

  it('resolves each target path once, however often it is cited', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': TARGET,
      'repo/docs/citing.md': '[x](target.md#present-heading)\n'.repeat(200)
    });
    const resolveReal = vi.spyOn(realpathSync, 'native');
    try {
      expect(check(root)).toMatchObject({ checked: 200, failures: [] });
      // The two roots, then the one target: resolving costs more the deeper the path.
      expect(resolveReal).toHaveBeenCalledTimes(3);
    } finally {
      resolveReal.mockRestore();
    }
  });

  it('judges a hard-linked target by the name it is cited by, whichever name is cited first', () => {
    for (const order of [['soft', 'hard'], ['hard', 'soft']]) {
      const root = tree({
        'ws/ARCHITECTURE.md': '# Envelope\n',
        'ws/CLAUDE.md': '# Pointer\n',
        'ws/docs/README.md': '# Docs\n',
        'outside/secret.md': '# Secret\n\n## Hidden heading\n'
      });
      const docs = join(root, 'ws', 'repo', 'docs');
      mkdirSync(docs, { recursive: true });
      linkSync(join(root, 'outside', 'secret.md'), join(docs, 'hard.md'));
      symlinkSync(join(root, 'outside', 'secret.md'), join(docs, 'soft.md'));
      const links: Record<string, string> = { soft: '[s](soft.md#hidden-heading)', hard: '[h](hard.md#absent)' };
      writeFileSync(join(docs, 'citing.md'), `${order.map((name) => links[name]).join('\n\n')}\n`);
      // The symlink leads outside both trees, so it is unverifiable; the hard link's own name lies
      // inside, so the file is read through it and its missing heading fails.
      const result = check(join(root, 'ws'));
      expect(result).toMatchObject({ checked: 1, unverifiable: 1 });
      expect(result.failures.map((f) => [f.file, f.named])).toEqual([['repo/docs/citing.md', 'absent']]);
    }
  });

  it('skips a directory named like a page, and a missing target, which are the path check\'s to report', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/adir.md/inner.txt': 'not a page\n',
      'repo/docs/citing.md': '[a](adir.md#x) and [m](missing.md#x)\n\n`adir.md` §1\n'
    });
    expect(check(root)).toMatchObject({ checked: 0, unverifiable: 0, failures: [] });
  });

  it('resolves each target file once, however many spellings cite it', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/sub/target.md': TARGET,
      'repo/docs/citing.md': ['[x](sub/target.md#present-heading)', '', '[y](a/target.md#present-heading)', '', '[z](b/target.md#present-heading)', ''].join('\n')
    });
    symlinkSync(join(root, 'repo', 'docs', 'sub'), join(root, 'repo', 'docs', 'a'), 'dir');
    symlinkSync(join(root, 'repo', 'docs', 'sub'), join(root, 'repo', 'docs', 'b'), 'dir');
    const resolveReal = vi.spyOn(realpathSync, 'native');
    try {
      expect(check(root)).toMatchObject({ checked: 3, failures: [] });
      // The two roots, then the one file, however it is spelled.
      expect(resolveReal).toHaveBeenCalledTimes(3);
    } finally {
      resolveReal.mockRestore();
    }
  });

  it('counts a target whose real path cannot be resolved as unverifiable, and does not throw', () => {
    const root = tree({ ...ENVELOPE, 'repo/docs/target.md': TARGET, 'repo/docs/citing.md': '[x](target.md#present-heading)\n' });
    const native = realpathSync.native;
    const resolveReal = vi.spyOn(realpathSync, 'native').mockImplementation(((path: string) => {
      if (String(path).endsWith('target.md')) throw new Error('EACCES');
      return native(path);
    }) as typeof realpathSync.native);
    try {
      expect(check(root)).toMatchObject({ checked: 0, unverifiable: 1, failures: [] });
    } finally {
      resolveReal.mockRestore();
    }
  });

  it('reads a passage exactly at either cap, and not one past it', () => {
    const atLength = (prefix: string, length: number) => `${prefix}${'y'.repeat(length - prefix.length)}`;
    // Three lines joined by two spaces to `total` characters, a link wrapping from the first into the second.
    const wrapped = (fragment: string, total: number) => {
      const first = `${'y'.repeat(100)} [the`;
      const second = `name](target.md#${fragment})`;
      return [first, second, 'y'.repeat(total - first.length - second.length - 2)];
    };
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': ['# T', '', '## Present heading', '', `§5 ${'[f] '.repeat(127)}`, '[f] '.repeat(128).trimEnd(), '===', ''].join('\n'),
      'repo/docs/citing.md': [
        atLength('[a](target.md#gone-line-at-the-cap) ', 10000),
        '',
        ...wrapped('gone-paragraph-at-the-cap', 10000),
        '',
        ...wrapped('gone-paragraph-past-the-cap', 10001),
        '',
        '`target.md` §5',
        '',
        `[b](target.md#gone-ampersands) ${'&'.repeat(300)}`,
        '',
        `\`${'['.repeat(150)}\` [the`,
        `name](target.md#gone-dense-in-code) \`${'['.repeat(150)}\``,
        '',
        `\`${'y'.repeat(6000)}\` [the`,
        `name](target.md#gone-long-in-code) \`${'y'.repeat(6000)}\``,
        ''
      ].join('\n')
    });
    const { checked, failures, unread } = check(root);
    // Read: a line of 10,000 characters, a paragraph of 10,000 counting its two joining spaces, a
    // setext heading of exactly 256 openers, and 300 `&`, which open nothing. Not read: the
    // paragraph of 10,001, whose text without those spaces is 9,999, and two paragraphs over a cap
    // only inside their code spans, which are counted before the spans are taken out.
    expect(failures.map((f) => [f.line, f.named])).toEqual([
      [1, 'gone-line-at-the-cap'],
      [3, 'gone-paragraph-at-the-cap'],
      [13, 'gone-ampersands']
    ]);
    expect(checked).toBe(4);
    expect(unread).toBe(3);
  });

  it('counts as unread only what a pass would have read: not a record, a fence marker or a fenced line', () => {
    const long = 'x'.repeat(10001);
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': TARGET,
      'docs/audits/a-review.md': `# A review\n\n${long}\n`,
      'repo/docs/fenced.md': ['# Fenced', '', `\`\`\`${'['.repeat(300)}`, long, '```', '', '[in](target.md#present-heading)', ''].join('\n'),
      'repo/docs/plain.md': `# Plain\n\n${long}\n`
    });
    expect(check(root)).toMatchObject({ checked: 1, failures: [], unread: 1 });
  });

  it('orders failures by line, and reads a backticked path against its own page first and a directory named like `..`', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/target.md': '# Root target\n\n## Elsewhere\n',
      'repo/docs/sub/target.md': '# Sub target\n\n## Only in sub\n',
      '..notes/target.md': '# Notes\n\n## Present heading\n',
      'repo/docs/sub/citing.md': [
        'A wrapped [link that',
        'fails](target.md#gone-first) on line 1.',
        '',
        '[x](target.md#gone-second)',
        '',
        '`target.md` §"Only in sub"',
        '',
        '[y](../../../..notes/target.md#gone-in-dots)',
        ''
      ].join('\n')
    });
    const { checked, failures } = check(root);
    expect(checked).toBe(4);
    expect(failures.map((f) => [f.line, f.named, f.reason])).toEqual([
      [1, 'gone-first', 'no-such-anchor'],
      [4, 'gone-second', 'no-such-anchor'],
      [8, 'gone-in-dots', 'no-such-anchor']
    ]);
  });

  it('counts a target it cannot read as unverifiable, and does not throw', () => {
    // Root reads a file of mode 0o000, so the case has nothing to show there.
    if (process.getuid?.() === 0) return;
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': TARGET,
      'specs/locked.md': TARGET,
      'repo/docs/citing.md': '[x](../../specs/locked.md#present-heading) and [y](target.md#present-heading)\n'
    });
    chmodSync(join(root, 'specs', 'locked.md'), 0o000);
    expect(check(root)).toMatchObject({ checked: 1, unverifiable: 1, failures: [] });
  });

  it('runs as a command by any path, a symlinked one included: exit 1, the failure printed, control characters neutralised', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': TARGET,
      'repo/docs/citing.md': 'See [absent](target.md#useful\u001b[2J-targets\u202e).\n\n`target.md` §"No\u2028such\u2029name".\n'
    });
    const script = installScript(root);
    const linked = join(root, 'linked-scripts');
    symlinkSync(dirname(script), linked, 'dir');
    const run = spawnSync('node', [join(linked, 'check-doc-links.mjs')], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Unresolved section references (2):');
    expect(run.stderr).toContain('repo/docs/citing.md:1 -> repo/docs/target.md#useful?[2J-targets? (no-such-anchor)');
    expect(run.stderr).toContain('repo/docs/citing.md:3 -> repo/docs/target.md §No?such?name (no-such-heading)');
    expect(run.stderr).not.toContain('Broken documentation links');
    for (const hidden of ['\u001b', '\u202e', '\u2028', '\u2029']) expect(run.stderr).not.toContain(hidden);
  });

  it('exits 1 on a broken path alone, and prints its line with control characters neutralised', () => {
    const root = tree({
      ...ENVELOPE,
      'repo/docs/target.md': TARGET,
      'repo/docs/citing.md': '[broken](missing\u001b[31m.md) and [fine](target.md#present-heading)\n'
    });
    const run = spawnSync('node', [installScript(root)], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Broken documentation links (1):');
    expect(run.stderr).toContain('repo/docs/citing.md:1 -> missing?[31m.md');
    expect(run.stderr).not.toContain('Unresolved section references');
    expect(run.stderr).not.toContain('\u001b');
  });

  it('says how many links and references it could not verify when the envelope is absent, beside what it could not read', () => {
    const long = 'x'.repeat(10001);
    const root = tree({
      'repo/docs/target.md': TARGET,
      'repo/docs/citing.md': `[up](../../elsewhere.md#somewhere) and [in](target.md#present-heading)\n\n${long}\n\n${long}\n`
    });
    const script = installScript(root);
    const run = spawnSync('node', [script], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Documentation links checked: 1 across 2 files (repository only, 1 outside this tree skipped).');
    expect(run.stdout).toContain(
      'Section references checked: 1 in live documents, 1 skipped as outside this tree or unreadable, 2 passages too long or too dense to read.'
    );
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
    expect(run.stdout).toContain('Section references checked: 1 in live documents, 1 passage too long or too dense to read.');
  });

  it('finds section references in the real tree, and none of them is unresolved', () => {
    // The vacuity control: an extractor that matched nothing would pass every other case here.
    const { checked, failures } = checkSectionReferences({ repoRoot: REPO, wsRoot: resolve(REPO, '..') });
    expect(checked).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});
