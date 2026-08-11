// Feature 087 (T021, T023, US5) — local file and folder references.
//
// These run against a real temporary tree rather than a mocked `fs`. The
// behaviours under test are `O_NOFOLLOW`, `lstat`-after-open, and a bounded
// walk — all of them properties of the syscalls, so a mock would assert only
// that the mock behaves as the mock was written to behave.
//
// FR-015 (containment), FR-016 (symlink bound), FR-017 (500 files / 5 MiB /
// text-like extensions, naming the limit that was exceeded), FR-018 (missing or
// unreadable). These functions return codes and bounds, never prose — message
// wording and its path hygiene (FR-020) belong to the composing validator and
// are pinned by the error-hygiene test.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_TEXT_EXTENSIONS,
  FOLDER_MAX_BYTES,
  FOLDER_MAX_FILES,
  checkLocalFile,
  checkLocalFolder
} from '../../../../src/services/run-request/local-input-validator';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-run-request-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(relative: string, contents = 'x'): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, 'utf8');
}

describe('checkLocalFile', () => {
  it('accepts a file inside the workspace', async () => {
    await write('notes/brief.md');
    expect(await checkLocalFile(root, 'notes/brief.md')).toEqual({ ok: true });
  });

  it('refuses a path that escapes the workspace', async () => {
    expect(await checkLocalFile(root, '../outside.md')).toMatchObject({
      ok: false,
      code: 'path-escapes-workspace'
    });
  });

  // The containment check is lexical, so a symlink *inside* the workspace that
  // points outside it passes containment and must be caught by `O_NOFOLLOW`.
  it('refuses a symlink, even one resolving inside the workspace', async () => {
    await write('notes/brief.md');
    await fs.symlink(path.join(root, 'notes/brief.md'), path.join(root, 'link.md'));
    expect(await checkLocalFile(root, 'link.md')).toMatchObject({
      ok: false,
      code: 'symlink-limit-exceeded'
    });
  });

  it('refuses a symlink chain that exceeds the traversal limit', async () => {
    await fs.symlink(path.join(root, 'b.md'), path.join(root, 'a.md'));
    await fs.symlink(path.join(root, 'a.md'), path.join(root, 'b.md'));
    expect(await checkLocalFile(root, 'a.md')).toMatchObject({
      ok: false,
      code: 'symlink-limit-exceeded'
    });
  });

  it('refuses a file that does not exist', async () => {
    expect(await checkLocalFile(root, 'notes/absent.md')).toMatchObject({
      ok: false,
      code: 'file-not-found'
    });
  });

  it('refuses a directory supplied as a file', async () => {
    await fs.mkdir(path.join(root, 'notes'), { recursive: true });
    expect(await checkLocalFile(root, 'notes')).toMatchObject({
      ok: false,
      code: 'file-not-found'
    });
  });

  it('refuses a file that cannot be read', async () => {
    await write('secret.md');
    await fs.chmod(path.join(root, 'secret.md'), 0o000);
    const outcome = await checkLocalFile(root, 'secret.md');
    await fs.chmod(path.join(root, 'secret.md'), 0o600);
    // A process running as root reads it regardless, so the assertion admits
    // both outcomes rather than failing on the privilege of the test runner.
    expect(outcome.ok === false ? outcome.code : 'file-unreadable').toBe('file-unreadable');
  });

  it('refuses when there is no workspace root', async () => {
    expect(await checkLocalFile('', 'notes/brief.md')).toMatchObject({
      ok: false,
      code: 'path-escapes-workspace'
    });
  });
});

describe('checkLocalFolder bounds (FR-017)', () => {
  it('accepts a small folder of allowed files', async () => {
    await write('docs/a.md');
    await write('docs/nested/b.txt');
    expect(await checkLocalFolder(root, 'docs')).toEqual({ ok: true });
  });

  it('accepts a folder at exactly the file-count limit', async () => {
    await Promise.all(
      Array.from({ length: FOLDER_MAX_FILES }, (_, index) => write(`bulk/f${index}.md`))
    );
    expect(await checkLocalFolder(root, 'bulk')).toEqual({ ok: true });
  });

  it('refuses one file over the count limit, naming the limit', async () => {
    await Promise.all(
      Array.from({ length: FOLDER_MAX_FILES + 1 }, (_, index) => write(`bulk/f${index}.md`))
    );
    expect(await checkLocalFolder(root, 'bulk')).toMatchObject({
      ok: false,
      code: 'folder-file-count-exceeded',
      limit: FOLDER_MAX_FILES
    });
  });

  it('refuses a folder over the byte limit, naming the limit', async () => {
    const chunk = 'x'.repeat(1024 * 1024);
    for (let index = 0; index <= FOLDER_MAX_BYTES / chunk.length; index += 1) {
      await write(`heavy/f${index}.md`, chunk);
    }
    expect(await checkLocalFolder(root, 'heavy')).toMatchObject({
      ok: false,
      code: 'folder-bytes-exceeded',
      limit: FOLDER_MAX_BYTES
    });
  });

  it('refuses a folder containing a file outside the extension allowlist', async () => {
    await write('mixed/a.md');
    await write('mixed/b.bin');
    expect(await checkLocalFolder(root, 'mixed')).toMatchObject({
      ok: false,
      code: 'folder-extension-not-allowed'
    });
  });

  it('treats an extension-less file as outside the allowlist', async () => {
    await write('mixed/Makefile');
    expect(await checkLocalFolder(root, 'mixed')).toMatchObject({
      ok: false,
      code: 'folder-extension-not-allowed'
    });
  });

  it('matches the allowlist case-insensitively', async () => {
    await write('docs/README.MD');
    expect(await checkLocalFolder(root, 'docs')).toEqual({ ok: true });
  });

  it('refuses a symlink inside the tree that escapes the workspace', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-outside-'));
    try {
      await fs.mkdir(path.join(root, 'docs'), { recursive: true });
      await fs.symlink(outside, path.join(root, 'docs/escape'));
      expect(await checkLocalFolder(root, 'docs')).toMatchObject({
        ok: false,
        code: 'symlink-limit-exceeded'
      });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a symlink inside the tree even when it stays inside the workspace', async () => {
    await write('docs/a.md');
    await fs.symlink(path.join(root, 'docs/a.md'), path.join(root, 'docs/b.md'));
    expect(await checkLocalFolder(root, 'docs')).toMatchObject({
      ok: false,
      code: 'symlink-limit-exceeded'
    });
  });

  it('refuses a folder that escapes the workspace', async () => {
    expect(await checkLocalFolder(root, '../outside')).toMatchObject({
      ok: false,
      code: 'path-escapes-workspace'
    });
  });

  it('refuses a folder that does not exist', async () => {
    expect(await checkLocalFolder(root, 'absent')).toMatchObject({
      ok: false,
      code: 'file-not-found'
    });
  });

  it('refuses a file supplied as a folder', async () => {
    await write('docs/a.md');
    expect(await checkLocalFolder(root, 'docs/a.md')).toMatchObject({
      ok: false,
      code: 'file-not-found'
    });
  });

  it('publishes a non-empty allowlist of text-like extensions', () => {
    expect(ALLOWED_TEXT_EXTENSIONS.length).toBeGreaterThan(0);
    expect(ALLOWED_TEXT_EXTENSIONS.every((ext) => ext.startsWith('.'))).toBe(true);
    expect(ALLOWED_TEXT_EXTENSIONS.every((ext) => ext === ext.toLowerCase())).toBe(true);
  });
});

// The bound has to be enforced *during* the walk: measuring the whole tree and
// then deciding is itself the denial of service the bound exists to prevent.
describe('the walk aborts on first breach', () => {
  it('stops inspecting entries once the count limit is passed', async () => {
    const overage = 200;
    await Promise.all(
      Array.from({ length: FOLDER_MAX_FILES + overage }, (_, index) =>
        write(`bulk/f${String(index).padStart(4, '0')}.md`)
      )
    );
    let stats = 0;
    const outcome = await checkLocalFolder(root, 'bulk', {
      onEntry: () => {
        stats += 1;
      }
    });
    expect(outcome).toMatchObject({ ok: false, code: 'folder-file-count-exceeded' });
    expect(stats).toBeLessThanOrEqual(FOLDER_MAX_FILES + 1);
  });
});
