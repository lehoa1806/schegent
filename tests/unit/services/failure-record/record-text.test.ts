/**
 * FR-R4-F15 (feature 243) — contract C1: the summary pipeline.
 *
 * `specs/243-retained-failure-diagnostics/contracts/capture-and-write.md` C7.1. One table drives
 * `boundSummary` with the real `SanitizedLogger.sanitize`, never a stub: a stub would prove the
 * pipeline calls a function, not that the shared redaction set sits inside it (hard rules 1, 23).
 *
 * Secrets are built at run time from pieces, as the existing redaction tests build theirs, so
 * `npm run security:secrets` does not flag this file.
 */
import { describe, it, expect } from 'vitest';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { boundSummary } from '../../../../src/services/failure-record/record-text';

const logger = new SanitizedLogger([]);
const sanitize = (value: string): string => logger.sanitize(value);

const POSIX_ROOT = '/ws/proj';
const WINDOWS_ROOT = 'C:\\Users\\dev\\proj';
const posix = { sanitize, workspaceRoot: POSIX_ROOT, platform: 'linux' as NodeJS.Platform };
const windows = { sanitize, workspaceRoot: WINDOWS_ROOT, platform: 'win32' as NodeJS.Platform };

const ANTHROPIC_SECRET = ['sk', 'ant', 'a'.repeat(24)].join('-');
const GITHUB_SECRET = ['ghp', 'b'.repeat(32)].join('_');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const GRINNING = '\u{1F600}';

type Row = readonly [label: string, raw: string, ctx: typeof posix, expected: string | null];

const ROWS: readonly Row[] = [
  ['an Anthropic-shaped secret', `failed with ${ANTHROPIC_SECRET} today`, posix, 'failed with [REDACTED] today'],
  ['a GitHub-shaped secret', `token ${GITHUB_SECRET} leaked`, posix, 'token [REDACTED] leaked'],
  [
    'a control character planted inside a secret',
    `key ${ANTHROPIC_SECRET.slice(0, 16)}\u0007${ANTHROPIC_SECRET.slice(16)} end`,
    posix,
    'key [REDACTED] end'
  ],
  ['a format character planted inside a secret', `key ${GITHUB_SECRET.slice(0, 12)}\u200b${GITHUB_SECRET.slice(12)}`, posix, 'key [REDACTED]'],
  ['the workspace root as a prefix', `error in ${POSIX_ROOT}/src/a.ts line 3`, posix, 'error in src/a.ts line 3'],
  ['the workspace root at the start of the text', `${POSIX_ROOT}/src/a.ts: error`, posix, 'src/a.ts: error'],
  ['a Windows workspace root', `error in ${WINDOWS_ROOT}\\src\\a.ts line 3`, windows, 'error in src\\a.ts line 3'],
  ['a Windows workspace root in another case', 'error in c:\\users\\DEV\\proj\\src\\a.ts', windows, 'error in src\\a.ts'],
  ['a Windows workspace root with forward slashes', 'error in C:/Users/dev/proj/src/a.ts', windows, 'error in src/a.ts'],
  ['a bare workspace root', `cwd is ${POSIX_ROOT} now`, posix, 'cwd is . now'],
  ['a bare workspace root in brackets', `(${POSIX_ROOT})`, posix, null],
  ['a bare workspace root before a sentence period', `ran in ${POSIX_ROOT}.`, posix, 'ran in ..'],
  ['a path that only starts like the root', `see ${POSIX_ROOT}ect2/x.ts`, posix, 'see [path]'],
  ['a root in another case on a case-sensitive platform', 'see /WS/PROJ/x.ts', posix, 'see [path]'],
  ['/etc/passwd', 'reads /etc/passwd now', posix, 'reads [path] now'],
  ['a Windows drive path with backslashes', 'open C:\\Users\\x\\y now', posix, 'open [path] now'],
  ['a Windows drive path with a forward slash', 'open C:/x now', posix, 'open [path] now'],
  ['a UNC path', 'open \\\\host\\share\\x now', posix, 'open [path] now'],
  ['a file URI', 'open file:///home/x now', posix, 'open [path] now'],
  // A path directly after `:`, `;`, `|` or `{` is still a path: JVM and Gradle write `file:/home/x` and
  // `jar:file:/home/x/a.jar!/B.class`, a Windows `PATH` joins drive paths with `;`.
  ['a file URI with one slash', 'open file:/home/x/y.txt now', posix, 'open file:[path] now'],
  ['a jar URI', 'see jar:file:/home/x/a.jar!/B.class now', posix, 'see jar:file:[path] now'],
  ['a path after a label colon', 'cwd:/home/x/y', posix, 'cwd:[path]'],
  ['a drive path after a label colon', 'prefix:C:\\Users\\x\\y now', posix, 'prefix:[path] now'],
  ['a path after a semicolon', 'PATH is C:\\Tools;C:\\Users\\x\\bin now', posix, 'PATH is [path];[path] now'],
  ['a path after a pipe', 'a|/home/x/y now', posix, 'a|[path] now'],
  ['a path after an opening brace', 'data{/home/x/y now', posix, 'data{[path] now'],
  ['the workspace root after a label colon', `file:${POSIX_ROOT}/src/a.ts`, posix, 'file:src/a.ts'],
  ['and/or', 'fix this and/or that', posix, 'fix this and/or that'],
  ['N/A', 'result: N/A for now', posix, 'result: N/A for now'],
  ['a URL', 'see https://example.com/a for details', posix, 'see https://example.com/a for details'],
  [
    'a URL path that names a home directory',
    'see https://example.com/home/x for details',
    posix,
    'see https://example.com/home/x for details'
  ],
  ['a port before a path', 'listening on localhost:3000/api now', posix, 'listening on localhost:3000/api now'],
  ['an import alias', "import '@/lib/file' fails", posix, "import '@/lib/file' fails"],
  ['a relative path', 'see src/lib/file.ts for details', posix, 'see src/lib/file.ts for details'],
  ['a path after an equals sign', 'x=/etc/passwd', posix, 'x=[path]'],
  ['a path in parentheses', 'bad (/etc/passwd) here', posix, 'bad ([path]) here'],
  ['a path in quotes', 'bad "/etc/passwd" here', posix, 'bad "[path]" here'],
  ['a path before a comma', 'see /etc/passwd, then', posix, 'see [path], then'],
  ['a lone slash between words', 'a / b', posix, 'a / b'],
  ['markup', '<img src=x onerror=alert(1)>', posix, '<img src=x onerror=alert(1)>'],
  ['markdown', '**bold** and [link](https://x.example)', posix, '**bold** and [link](https://x.example)'],
  ['a template expression', '{@html x} is text', posix, '{@html x} is text'],
  ['only a path', '/etc/passwd', posix, null],
  ['only a workspace-rooted directory', `${POSIX_ROOT}/`, posix, null],
  ['only a secret', ANTHROPIC_SECRET, posix, null],
  ['only whitespace and controls', ' \u0007 \t ', posix, null],
  ['an empty string', '', posix, null],
  ['surrounding whitespace', '  one case fails  ', posix, 'one case fails']
];

describe('boundSummary - the table (C7.1)', () => {
  it.each(ROWS)('%s', (_label, raw, ctx, expected) => {
    expect(boundSummary(raw, ctx)).toBe(expected);
    // Pure: the same input gives the same answer, so no regex keeps state between calls.
    expect(boundSummary(raw, ctx)).toBe(expected);
  });

  it('keeps no planted secret, workspace root or absolute path in any row that has content', () => {
    for (const [, raw, ctx] of ROWS) {
      const out = boundSummary(raw, ctx);
      if (out === null) continue;
      expect(out).not.toContain(ANTHROPIC_SECRET);
      expect(out).not.toContain(GITHUB_SECRET);
      expect(out).not.toContain(ctx.workspaceRoot);
      expect(out).not.toMatch(/(^|[\s"'`([<=,;|{]|:(?!\/\/))\/(etc|home|ws)\b/);
      expect(out).not.toMatch(/(^|[\s"'`([<=,;|{]|:(?!\/\/))[A-Za-z]:[\\/]/);
    }
  });
});

describe('boundSummary - the bound (C1 step 4, D3)', () => {
  it('leaves a summary of exactly 240 code points whole', () => {
    const raw = 'a'.repeat(240);
    expect(boundSummary(raw, posix)).toBe(raw);
  });

  it('cuts 241 code points to 239 and an ellipsis', () => {
    expect(boundSummary('a'.repeat(241), posix)).toBe(`${'a'.repeat(239)}\u2026`);
  });

  it('cuts 300 code points with an astral character at position 240 without splitting it', () => {
    const raw = `${'a'.repeat(239)}${GRINNING}${'b'.repeat(60)}`;
    expect(Array.from(raw)).toHaveLength(300);
    const out = boundSummary(raw, posix) as string;
    expect(out).toBe(`${'a'.repeat(239)}\u2026`);
    expect(Array.from(out)).toHaveLength(240);
    expect(out).not.toMatch(LONE_SURROGATE);
  });

  it('keeps an astral character that ends at position 239 whole', () => {
    const raw = `${'a'.repeat(238)}${GRINNING}${'b'.repeat(61)}`;
    const out = boundSummary(raw, posix) as string;
    expect(out).toBe(`${'a'.repeat(238)}${GRINNING}\u2026`);
    expect(Array.from(out)).toHaveLength(240);
    expect(out).not.toMatch(LONE_SURROGATE);
  });

  it('counts code points, not UTF-16 units: 240 astral characters fit', () => {
    const raw = GRINNING.repeat(240);
    expect(boundSummary(raw, posix)).toBe(raw);
    expect(boundSummary(GRINNING.repeat(241), posix)).toBe(`${GRINNING.repeat(239)}\u2026`);
  });

  it('measures after redaction and path removal, not before', () => {
    const raw = `${POSIX_ROOT}/${'a'.repeat(240)}`;
    expect(boundSummary(raw, posix)).toBe('a'.repeat(240));
  });

  it('never exceeds 240 code points for any row of the table', () => {
    for (const [, raw, ctx] of ROWS) {
      const out = boundSummary(raw, ctx);
      if (out !== null) expect(Array.from(out).length).toBeLessThanOrEqual(240);
    }
  });
});

describe('boundSummary - order (FR-005)', () => {
  it('strips control characters before redacting, so a planted one cannot break the match', () => {
    const planted = `${ANTHROPIC_SECRET.slice(0, 10)}\u0000${ANTHROPIC_SECRET.slice(10)}`;
    expect(boundSummary(planted, posix)).toBeNull();
    expect(boundSummary(`x ${planted}`, posix)).toBe('x [REDACTED]');
  });

  it('redacts before removing the root, so a secret inside a path is gone', () => {
    const raw = `${POSIX_ROOT}/${ANTHROPIC_SECRET}/a.ts`;
    const out = boundSummary(raw, posix);
    expect(out === null || !out.includes(ANTHROPIC_SECRET)).toBe(true);
  });

  it('calls the supplied sanitizer exactly once and holds no secret pattern of its own', () => {
    const calls: string[] = [];
    const marker = 'zz-not-a-known-secret-shape';
    const out = boundSummary(`${marker} and ${ANTHROPIC_SECRET}`, {
      ...posix,
      sanitize: (value) => {
        calls.push(value);
        return value;
      }
    });
    expect(calls).toHaveLength(1);
    // With a pass-through sanitizer nothing is redacted: the module has no redaction of its own.
    expect(out).toContain(ANTHROPIC_SECRET);
  });
});
