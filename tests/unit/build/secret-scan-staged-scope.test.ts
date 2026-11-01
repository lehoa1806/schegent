import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * FR-R4-F10 (contract test T5; SS2, SS3, SS4) -- the pure parts of staged mode, over byte fixtures
 * built in this file, with no git child.
 *
 * WHAT IT PINS. `git diff-index --cached --raw -z --no-renames` and `git cat-file --batch` are the
 * two byte formats staged mode trusts for its scope and for the content it scans. A parser that
 * misread a name with a space, a newline or a non-ASCII byte would scan a different file than the
 * commit carries, and one that accepted a short or mismatched blob would scan less than it was
 * given and still pass. So each format is built here from its documented framing and the parse is
 * asserted entry by entry, and every malformed reply must be a typed refusal, never a result.
 *
 * `classifyStaged` is the scope decision (SS2): which staged entries are read, and which are
 * skipped with a counted cause. The ignore matcher is a parameter (tasks TA3), so the test passes
 * the scan's own `isIgnored`. A mode-only change is `unchanged` (tasks AN1).
 */
// The two scripts are ES modules and this file is typed as CommonJS, so they are loaded with a
// dynamic import, as the other tests of `.mjs` scripts do.
const loadStaged = () => import('../../../scripts/secret-scan-staged.mjs');
type StagedModule = Awaited<ReturnType<typeof loadStaged>>;
type StagedEntry = ReturnType<StagedModule['parseRawDiffIndex']>[number];
type Refusal = InstanceType<StagedModule['StagedRefusal']>;

let staged: StagedModule;
let isIgnored: (file: string, patterns: ReadonlyArray<string>) => boolean;

beforeAll(async () => {
  staged = await loadStaged();
  ({ isIgnored } = await import('../../../scripts/scan-secrets.mjs'));
});

const ZERO = '0'.repeat(40);
const BLOB_A = 'a'.repeat(40);
const BLOB_B = 'b'.repeat(40);

interface RawFields {
  readonly status: string;
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldBlob: string;
  readonly blob: string;
  readonly path: string;
}

/** The framing `git diff-index --raw -z` writes: `:<om> <nm> <ob> <nb> <S>\0<path>\0`. */
function rawBuffer(entries: ReadonlyArray<RawFields>): Buffer {
  const parts = entries.map(
    (entry) => `:${entry.oldMode} ${entry.newMode} ${entry.oldBlob} ${entry.blob} ${entry.status}\0${entry.path}\0`
  );
  return Buffer.from(parts.join(''), 'utf8');
}

function entry(status: string, oldMode: string, newMode: string, oldBlob: string, blob: string, path: string): StagedEntry {
  return { status, oldMode, newMode, oldBlob, blob, path };
}

/** The framing `git cat-file --batch` writes for a blob: `<id> blob <size>\n<bytes>\n`. */
function batchBlob(id: string, content: string): Buffer {
  const body = Buffer.from(content, 'utf8');
  return Buffer.concat([Buffer.from(`${id} blob ${body.length}\n`, 'utf8'), body, Buffer.from('\n', 'utf8')]);
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function refusalCause(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(staged.StagedRefusal);
    return (error as Refusal).cause;
  }
  throw new Error('expected a StagedRefusal, but nothing was thrown');
}

describe('parseRawDiffIndex reads the NUL-separated raw format (SS2)', () => {
  it('keeps names holding a space, a newline, a double quote and a non-ASCII character intact', () => {
    const names = ['dir with space/a file.txt', 'line\nbreak.txt', 'quo"te.txt', 'café-notes.txt'];
    const parsed = staged.parseRawDiffIndex(
      rawBuffer(names.map((path) => entry('A', '000000', '100644', ZERO, BLOB_A, path)))
    );
    expect(parsed.map((item) => item.path)).toEqual(names);
    expect(parsed.every((item) => item.status === 'A' && item.blob === BLOB_A)).toBe(true);
  });

  it('reads every status letter, with its modes and both blob ids', () => {
    const fields: RawFields[] = [
      entry('A', '000000', '100644', ZERO, BLOB_A, 'added.txt'),
      entry('M', '100644', '100644', BLOB_A, BLOB_B, 'modified.txt'),
      entry('T', '100644', '120000', BLOB_A, BLOB_B, 'typechanged'),
      entry('D', '100644', '000000', BLOB_A, ZERO, 'deleted.txt'),
      entry('U', '000000', '000000', ZERO, ZERO, 'unmerged.txt')
    ];
    const parsed = staged.parseRawDiffIndex(rawBuffer(fields));
    expect(parsed).toEqual(fields);
  });

  it('reads the four modes staged mode distinguishes', () => {
    const modes = ['100644', '100755', '120000', '160000'];
    const parsed = staged.parseRawDiffIndex(
      rawBuffer(modes.map((mode, index) => entry('A', '000000', mode, ZERO, BLOB_A, `file-${index}`)))
    );
    expect(parsed.map((item) => item.newMode)).toEqual(modes);
  });

  it('returns nothing for empty output', () => {
    expect(staged.parseRawDiffIndex(Buffer.alloc(0))).toEqual([]);
  });

  it('refuses output that is not the raw format, rather than reading less of it', () => {
    expect(refusalCause(() => staged.parseRawDiffIndex(Buffer.from('not raw output\0', 'utf8')))).toBe('git-failed');
    const truncated = rawBuffer([entry('A', '000000', '100644', ZERO, BLOB_A, 'a.txt')]).subarray(0, 40);
    expect(refusalCause(() => staged.parseRawDiffIndex(truncated))).toBe('git-failed');
  });
});

describe('classifyStaged decides what is read and counts what is not (SS2; AN1)', () => {
  const classify = (entries: ReadonlyArray<StagedEntry>, patterns: ReadonlyArray<string> = []) =>
    staged.classifyStaged(entries, patterns, isIgnored);

  it('scans added, modified and type-changed regular files and symlinks', () => {
    const scope = classify([
      entry('A', '000000', '100644', ZERO, BLOB_A, 'added.txt'),
      entry('M', '100644', '100644', BLOB_A, BLOB_B, 'modified.txt'),
      entry('A', '000000', '100755', ZERO, BLOB_A, 'tool.sh'),
      entry('T', '100644', '120000', BLOB_A, BLOB_B, 'link')
    ]);
    expect(scope.scan.map((item) => item.path)).toEqual(['added.txt', 'modified.txt', 'tool.sh', 'link']);
    expect(scope.skipped).toEqual({ ignored: 0, deleted: 0, gitlink: 0, unchanged: 0 });
  });

  it('skips a deletion, a gitlink and an ignored path, each with its own count', () => {
    const scope = classify(
      [
        entry('D', '100644', '000000', BLOB_A, ZERO, 'gone.txt'),
        entry('A', '000000', '160000', ZERO, BLOB_A, 'vendor/sub'),
        entry('A', '000000', '100644', ZERO, BLOB_A, 'dist/bundle.js'),
        entry('A', '000000', '100644', ZERO, BLOB_B, 'kept.txt')
      ],
      ['dist/**']
    );
    expect(scope.scan.map((item) => item.path)).toEqual(['kept.txt']);
    expect(scope.skipped).toEqual({ ignored: 1, deleted: 1, gitlink: 1, unchanged: 0 });
  });

  it('skips a mode-only change as unchanged, and scans a modification with a new blob (AN1)', () => {
    const scope = classify([
      entry('M', '100644', '100755', BLOB_A, BLOB_A, 'chmod-only.sh'),
      entry('M', '100644', '100755', BLOB_A, BLOB_B, 'chmod-and-edit.sh')
    ]);
    expect(scope.scan.map((item) => item.path)).toEqual(['chmod-and-edit.sh']);
    expect(scope.skipped.unchanged).toBe(1);
  });

  it('judges a renamed or copied path at its new path, so the ignore list sees the new name', () => {
    const scope = classify(
      [entry('A', '000000', '100644', ZERO, BLOB_A, 'config/.env.local')],
      ['config/ignored/**']
    );
    expect(scope.scan.map((item) => item.path)).toEqual(['config/.env.local']);
    const moved = classify(
      [entry('A', '000000', '100644', ZERO, BLOB_A, 'config/ignored/.env.local')],
      ['config/ignored/**']
    );
    expect(moved.scan).toEqual([]);
    expect(moved.skipped.ignored).toBe(1);
  });

  it('refuses an unmerged path with unmerged-path, never scanning past it', () => {
    const cause = refusalCause(() =>
      classify([
        entry('A', '000000', '100644', ZERO, BLOB_A, 'fine.txt'),
        entry('U', '000000', '000000', ZERO, ZERO, 'conflict.txt')
      ])
    );
    expect(cause).toBe('unmerged-path');
  });
});

describe('parseCatFileBatch reads the framed blob stream (SS3)', () => {
  it('returns each blob by id, byte for byte, including a body with its own newlines', () => {
    const buffer = Buffer.concat([batchBlob(BLOB_A, 'one\ntwo\n'), batchBlob(BLOB_B, '')]);
    const blobs = staged.parseCatFileBatch(buffer, [BLOB_A, BLOB_B]);
    expect(blobs.get(BLOB_A)?.toString('utf8')).toBe('one\ntwo\n');
    expect(blobs.get(BLOB_B)?.length).toBe(0);
    expect(blobs.size).toBe(2);
  });

  it('refuses a missing reply with blob-unreadable', () => {
    const buffer = Buffer.from(`${BLOB_A} missing\n`, 'utf8');
    expect(refusalCause(() => staged.parseCatFileBatch(buffer, [BLOB_A]))).toBe('blob-unreadable');
  });

  it('refuses a size that does not match the body with blob-unreadable', () => {
    const body = 'short';
    const buffer = Buffer.from(`${BLOB_A} blob ${body.length + 3}\n${body}\nextra-bytes\n`, 'utf8');
    expect(refusalCause(() => staged.parseCatFileBatch(buffer, [BLOB_A]))).toBe('blob-unreadable');
  });

  it('refuses a truncated body, and a stream shorter than the ids asked for, with blob-unreadable', () => {
    const whole = batchBlob(BLOB_A, 'a body long enough to cut');
    expect(refusalCause(() => staged.parseCatFileBatch(whole.subarray(0, whole.length - 8), [BLOB_A]))).toBe(
      'blob-unreadable'
    );
    expect(refusalCause(() => staged.parseCatFileBatch(whole, [BLOB_A, BLOB_B]))).toBe('blob-unreadable');
  });

  it('refuses a reply that names a different object than the one asked for', () => {
    expect(refusalCause(() => staged.parseCatFileBatch(batchBlob(BLOB_B, 'x'), [BLOB_A]))).toBe('blob-unreadable');
  });
});

describe('materialize writes the staged blobs into a private directory (SS4)', () => {
  function privateDirectory(): string {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'scope-materialize-'));
    tempDirs.push(dir);
    return dir;
  }

  it('writes each file 0600 under its relative path, inside a 0700 directory', () => {
    const dir = privateDirectory();
    const written = staged.materialize(dir, [
      { path: 'top.txt', content: Buffer.from('top', 'utf8') },
      { path: 'nested/deeper/inner.txt', content: Buffer.from('inner', 'utf8') }
    ]);
    expect(written).toEqual([join(dir, 'top.txt'), join(dir, 'nested', 'deeper', 'inner.txt')]);
    expect(readFileSync(join(dir, 'nested', 'deeper', 'inner.txt'), 'utf8')).toBe('inner');
    for (const file of written) expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('refuses a path that escapes the directory with path-escape', () => {
    const dir = privateDirectory();
    expect(refusalCause(() => staged.materialize(dir, [{ path: '../x', content: Buffer.from('x') }]))).toBe('path-escape');
    expect(refusalCause(() => staged.materialize(dir, [{ path: '/etc/x', content: Buffer.from('x') }]))).toBe(
      'path-escape'
    );
    expect(refusalCause(() => staged.materialize(dir, [{ path: 'a/../../x', content: Buffer.from('x') }]))).toBe(
      'path-escape'
    );
  });

  // A second write to a file already written would replace the first blob, so the engine would scan
  // one file twice and never read the other: a staged secret would pass. The index cannot hold one
  // path twice, but a case-insensitive scan directory (macOS, Windows) folds `Foo.txt` and `foo.txt`
  // into one file.
  it('refuses two files that land on one file, instead of scanning only the last', () => {
    const dir = privateDirectory();
    const twice = [
      { path: 'same.txt', content: Buffer.from('first', 'utf8') },
      { path: 'same.txt', content: Buffer.from('second', 'utf8') }
    ];
    expect(refusalCause(() => staged.materialize(dir, twice))).toBe('path-escape');
  });

  it('writes two paths that differ only by case apart, or refuses them', () => {
    const dir = privateDirectory();
    const pair = [
      { path: 'Foo.txt', content: Buffer.from('upper', 'utf8') },
      { path: 'foo.txt', content: Buffer.from('lower', 'utf8') }
    ];
    let written: string[] | undefined;
    try {
      written = staged.materialize(dir, pair);
    } catch (error) {
      expect(error).toBeInstanceOf(staged.StagedRefusal);
      expect((error as Refusal).cause).toBe('path-escape');
      return;
    }
    expect(written.map((file) => readFileSync(file, 'utf8'))).toEqual(['upper', 'lower']);
  });
});
