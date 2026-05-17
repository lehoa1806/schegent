// Feature 020 T024 — list iterations under a phase dir, numeric
// descending. See specs/020-phase-level-logs/contracts/phase-log-service.md §2.

import * as fs from 'node:fs/promises';

const ITER_NAME = /^iter-(\d+)$/;

export async function discoverIterations(phaseDir: string): Promise<number[]> {
  let entries;
  try {
    entries = await fs.readdir(phaseDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
      return [];
    }
    throw err;
  }
  const iterations: number[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = ITER_NAME.exec(entry.name);
    if (!match) continue;
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n) && n >= 1) iterations.push(n);
  }
  iterations.sort((a, b) => b - a);
  return iterations;
}
