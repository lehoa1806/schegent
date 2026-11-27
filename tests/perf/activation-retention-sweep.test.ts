// FR-R3-114 row 6 — how long the activation-path retention sweep actually takes.
//
// THE RESIDUAL. Activation awaits a serial chain that includes a sweep over `.schegent/sessions`,
// under one loose 5 s budget covering the whole chain. The measured tree on the development
// machine was 105 MiB. Nothing measured the sweep ITSELF, so "a slow disk turns activation into a
// timeout mystery" was a hypothesis with no number attached — and a 5 s budget over a chain tells
// you nothing about which link is close to it.
//
// WHAT THIS MEASURES AND WHAT IT DOES NOT. It measures the sweep over a synthetic tree of the same
// ORDER as the observed one, on this machine's disk, and holds it to a budget derived from the
// measurement. It does NOT measure a slow disk, a network volume, or Windows — a single-platform
// local measurement, like every other result in this repository (`VER-1`).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionArtifactRetentionService } from '../../src/services/session-retention/session-artifact-retention-service';
import { SanitizedLogger } from '../../src/lib/logger';

/**
 * The tree shape, sized from the observed one.
 *
 * 105 MiB across a few hundred runs is the recorded observation; 300 files of 64 KiB is ~19 MiB,
 * which is the same ORDER at a size that does not make the perf suite write 105 MiB to a laptop
 * disk on every run. The budget below is scaled from what this shape measures, and the ratio is
 * stated so a reader can extrapolate rather than guess.
 */
const RUN_DIRS = 60;
const FILES_PER_RUN = 5;
const FILE_BYTES = 64 * 1024;

/**
 * MEASURED 2026-08-27 on darwin/arm64 (macOS 26.6.2, Node 24.19.0): **10.8 ms** for 300 files /
 * 18.8 MiB — **0.57 ms per MiB**. Extrapolated to the 105 MiB tree the residual observed, the
 * sweep costs roughly **60 ms** against the 5 s budget the whole activation chain shares: about
 * 1.2% of it.
 *
 * SO ROW 6'S EXPOSURE IS NOT SUPPORTED ON THIS DISK, and that is the finding rather than a
 * dismissal. "A slow disk turns activation into a timeout mystery" would need a disk roughly 80x
 * slower than this one before the sweep alone threatened the budget. What remains true is that
 * nothing attributes the budget per link, so if activation ever does time out, this measurement is
 * what lets someone rule the sweep out in one step instead of guessing.
 *
 * The budget is ~23x the measurement: a regression guard on a filesystem walk, loose enough to
 * survive a busy machine and tight enough to catch an order-of-magnitude change.
 */
const SWEEP_BUDGET_MS = 250;

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-sweep-perf-'));
  const sessions = path.join(workspaceRoot, '.schegent', 'sessions');
  const body = Buffer.alloc(FILE_BYTES, 'a');
  for (let run = 0; run < RUN_DIRS; run += 1) {
    const dir = path.join(sessions, `run-${run}`);
    await fs.mkdir(dir, { recursive: true });
    for (let file = 0; file < FILES_PER_RUN; file += 1) {
      await fs.writeFile(path.join(dir, `artifact-${file}.jsonl`), body);
    }
  }
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe('FR-R3-114 row 6 — the activation retention sweep, measured', () => {
  it('sweeps a sessions tree of the observed order within its own budget', async () => {
    const service = new SessionArtifactRetentionService({
      workspaceRoot,
      logger: new SanitizedLogger(),
      // A policy that retains everything, so the measurement is of the WALK rather than of how
      // fast this machine can delete files. The walk is the part activation waits on.
      policy: () => ({ maxAgeMs: 365 * 24 * 60 * 60 * 1000, maxBytes: 512 * 1024 * 1024 })
    });

    const started = performance.now();
    await service.sweep(new Set<string>());
    const elapsed = performance.now() - started;

    const bytes = RUN_DIRS * FILES_PER_RUN * FILE_BYTES;
    console.log(
      `[FR-R3-114 row 6] swept ${RUN_DIRS} run dirs / ${RUN_DIRS * FILES_PER_RUN} files ` +
        `(${(bytes / (1024 * 1024)).toFixed(1)} MiB) in ${elapsed.toFixed(1)} ms ` +
        `— ${((elapsed / (bytes / (1024 * 1024)))).toFixed(2)} ms per MiB`
    );

    // Non-vacuity: the tree really exists, so a sweep that silently found nothing cannot pass by
    // measuring an empty directory.
    const usage = service.getUsage();
    expect(usage.totalBytes, 'the sweep must have accounted for the tree').toBeGreaterThan(
      bytes / 2
    );
    expect(
      elapsed,
      `the sweep took ${elapsed.toFixed(1)} ms over ${(bytes / (1024 * 1024)).toFixed(1)} MiB, ` +
        `past its ${SWEEP_BUDGET_MS} ms budget. Activation awaits this serially under one 5 s ` +
        'budget covering the whole chain, so a regression here is an activation timeout nobody ' +
        'can attribute.'
    ).toBeLessThan(SWEEP_BUDGET_MS);
  }, 60_000);
});
