// Feature 020 T024 — list iterations under a phase dir, numeric
// descending. See specs/020-phase-level-logs/contracts/phase-log-service.md §2.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { STREAM_FILE } from './phase-log-path';

const ITER_NAME = /^iter-(\d+)$/;

/**
 * Feature 020 BUG-002 (T085, FR-026a) — whether an `iter-<N>` directory holds
 * an entry named `stream.jsonl`, of any type. A directory holding none (only
 * the agent-written `phase-message.env`, say) is not a recorded iteration.
 *
 * `lstat` looks the entry up without following it, so a symlink counts, a
 * dangling one included, and the reader's `record-path-refused` keeps its
 * cases. Only an answer that no such entry exists (ENOENT, ENOTDIR) leaves the
 * iteration uncounted. Every other error is a refusal, and a refused iteration
 * is counted, so the refusal reaches the operator as `permission-denied` when
 * the reader opens the same path instead of being read as an absence.
 *
 * A lookup, not a listing: it needs the search permission the reader's open
 * needs, and not read permission, which the open does not need either.
 */
async function holdsStreamEntry(iterationDir: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(iterationDir, STREAM_FILE));
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

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
  const candidates: { readonly n: number; readonly dir: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = ITER_NAME.exec(entry.name);
    if (!match) continue;
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n) && n >= 1) {
      candidates.push({ n, dir: path.join(phaseDir, entry.name) });
    }
  }
  // Feature 020 BUG-002 (T085) — the phase directory is still read once, by
  // the `readdir` above (contract C4, 203's SC-008). Each check below looks
  // inside one `iter-<N>` only. A recursive `readdir` would not do: one refused
  // `iter-<N>` rejects the whole listing.
  const checked = await Promise.all(
    candidates.map(async (candidate) => ({
      n: candidate.n,
      counted: await holdsStreamEntry(candidate.dir)
    }))
  );
  const iterations = checked.filter((c) => c.counted).map((c) => c.n);
  iterations.sort((a, b) => b - a);
  return { outcome: 'listed', iterations };
}
