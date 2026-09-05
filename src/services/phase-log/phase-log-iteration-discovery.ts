// Feature 020 T024 — list iterations under a phase dir, numeric
// descending. See specs/020-phase-level-logs/contracts/phase-log-service.md §2.

import * as fs from 'node:fs/promises';

const ITER_NAME = /^iter-(\d+)$/;

/**
 * Feature 203 (D3, D4, FR-006, FR-036) — one observation of the phase
 * directory, and an answer that says which situation it found.
 *
 * The previous return type was `number[]`, and `[]` carried three meanings at
 * once: the directory is absent, the directory is present and empty, and the
 * directory refused to be read. Each calls for a different response from the
 * operator, so collapsing them left the caller with no way to say which had
 * happened — it re-`stat`ed the same directory to recover the first
 * distinction, which is a second observation that can disagree with the first
 * and a race window between the two.
 *
 * `listed` with an empty array is a real answer rather than the absence of one.
 * Refusal is neither outcome: it leaves as a throw and becomes the existing
 * `permission-denied` failure at `readPhaseLog`, which returns before any
 * manifest is built, so no empty result can ever stand in for it.
 */
export type IterationDiscovery =
  | { readonly outcome: 'directory-absent' }
  | { readonly outcome: 'listed'; readonly iterations: readonly number[] };

export async function discoverIterations(phaseDir: string): Promise<IterationDiscovery> {
  let entries;
  try {
    entries = await fs.readdir(phaseDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { outcome: 'directory-absent' };
    }
    // EACCES and EPERM used to be swallowed here alongside the two above. They
    // are not an absence — the directory may be full of records this reader was
    // not allowed to see — and reporting them as one produced a blank pane that
    // said the phase had never run.
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
  return { outcome: 'listed', iterations };
}
