import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { HistoryDescriptionStore } from '../../../../src/services/history/history-description-store';
import type { SanitizedLogger } from '../../../../src/lib/logger';

/**
 * FR-R3-080 (T1063) — the description store's write path, and the window it had.
 *
 * `SEC-06`. The store took a containment verdict and then composed
 * `fs.mkdir` + `fs.writeFile` on the same pathname, so a component swapped
 * between the verdict and the write redirected operator-authored description
 * text out of the workspace. The write now goes through the checked walk, which
 * holds a descriptor rather than a name.
 *
 * NON-VACUITY, measured rather than asserted: with the verdict-then-`fs.writeFile`
 * pair restored, the first fixture below writes `run-swapped.txt` into the
 * outside directory with the description in it. Reverted, and the file re-run
 * green.
 */
async function harness(): Promise<{
  workspaceRoot: string;
  outside: string;
  store: HistoryDescriptionStore;
  warn: ReturnType<typeof vi.fn>;
}> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'hist-desc-contain-'));
  const workspaceRoot = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  await fs.mkdir(path.join(workspaceRoot, '.schegent'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  const warn = vi.fn();
  const store = new HistoryDescriptionStore({
    workspaceRoot,
    logger: { warn } as unknown as SanitizedLogger
  });
  return { workspaceRoot, outside, store, warn };
}

describe('FR-R3-080 — the description write refuses a swapped component', () => {
  it('refuses, and nothing lands outside the workspace', async () => {
    const { workspaceRoot, outside, store, warn } = await harness();
    // `.schegent/history` is a link out of the tree at the moment of the write.
    await fs.symlink(outside, path.join(workspaceRoot, '.schegent', 'history'), 'dir');

    expect(await store.write('run-swapped', 'operator description')).toBeNull();
    expect(await fs.readdir(outside)).toEqual([]);
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain('refused');
  });

  it('still writes and reads back the ordinary case', async () => {
    const { workspaceRoot, store } = await harness();
    const ref = await store.write('run-ok', 'operator description');
    expect(ref).toBe('.schegent/history/run-ok.txt');
    expect(await store.read(ref!)).toEqual({ outcome: 'read', text: 'operator description' });
    // Mode is part of the contract: this text sits beside session evidence.
    const stat = await fs.stat(path.join(workspaceRoot, '.schegent', 'history', 'run-ok.txt'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('overwrites rather than appending on a second write', async () => {
    // `w`, not `a`: the store replaces a description, and an append would grow a
    // file that every reader takes whole.
    const { store } = await harness();
    await store.write('run-twice', 'first');
    const ref = await store.write('run-twice', 'second');
    expect(await store.read(ref!)).toEqual({ outcome: 'read', text: 'second' });
  });
});

describe('Feature 217 (FR-003) — the description store says what its write narrowed', () => {
  /** POSIX-only: `mode` is not an enforceable concept on Windows. */
  const posixOnly = process.platform === 'win32' ? it.skip : it;
  /** What umask 022 leaves a directory at. */
  const WIDENED_DIR = 0o755;

  posixOnly('narrows a widened `.schegent` and says so once, path-free', async () => {
    const { workspaceRoot, store, warn } = await harness();
    const schegent = path.join(workspaceRoot, '.schegent');
    await fs.chmod(schegent, WIDENED_DIR);
    await store.write('run-a', 'first');
    // Widened again between two writes: the second narrowing is real, and the
    // store has already said this once.
    await fs.chmod(schegent, WIDENED_DIR);
    await store.write('run-b', 'second');

    expect((await fs.lstat(schegent)).mode & 0o777).toBe(0o700);
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
      'history-description: an evidence directory granted access beyond its owner (mode 755); narrowed to owner-only'
    ]);
  });

  // The report sits between the open and the close of its handle, and this
  // store takes any `warn`, not only the logger that never throws.
  posixOnly('keeps the write when the logger throws on the line it reports', async () => {
    const { workspaceRoot } = await harness();
    const schegent = path.join(workspaceRoot, '.schegent');
    await fs.chmod(schegent, WIDENED_DIR);
    const store = new HistoryDescriptionStore({
      workspaceRoot,
      logger: {
        warn: () => {
          throw new Error('sink unavailable');
        }
      }
    });

    expect(await store.write('run-c', 'operator description')).toBe('.schegent/history/run-c.txt');
    expect(await fs.readFile(path.join(schegent, 'history', 'run-c.txt'), 'utf8')).toBe(
      'operator description'
    );
    expect((await fs.lstat(schegent)).mode & 0o777).toBe(0o700);
  });
});
