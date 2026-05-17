// Feature 020 T013 — `discoverIterations` numeric-descending sort,
// `iter-*` filtering, missing-dir → []. See
// specs/020-phase-level-logs/contracts/phase-log-service.md §2.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverIterations } from '../../../../src/services/phase-log/phase-log-iteration-discovery';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase-log-it-disc-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('Feature 020 T013 — discoverIterations', () => {
  it('sorts iterations numerically descending (iter-10 before iter-2)', async () => {
    await fs.mkdir(path.join(tmpDir, 'iter-1'));
    await fs.mkdir(path.join(tmpDir, 'iter-2'));
    await fs.mkdir(path.join(tmpDir, 'iter-10'));
    const result = await discoverIterations(tmpDir);
    expect(result).toEqual([10, 2, 1]);
  });

  it('filters out non-iter-* directories and stray files', async () => {
    await fs.mkdir(path.join(tmpDir, 'iter-1'));
    await fs.mkdir(path.join(tmpDir, 'iter-5'));
    await fs.mkdir(path.join(tmpDir, 'other'));
    await fs.mkdir(path.join(tmpDir, 'iter-abc'));
    await fs.writeFile(path.join(tmpDir, '.DS_Store'), 'noise');
    const result = await discoverIterations(tmpDir);
    expect(result).toEqual([5, 1]);
  });

  it('returns [] when the directory does not exist', async () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    const result = await discoverIterations(missing);
    expect(result).toEqual([]);
  });

  it('returns [] when the directory is empty', async () => {
    const result = await discoverIterations(tmpDir);
    expect(result).toEqual([]);
  });
});
