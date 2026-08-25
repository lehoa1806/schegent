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
