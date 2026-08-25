import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RawTranscriptWriter } from '../../../src/audit/raw-transcript-writer';
import { SanitizedLogger } from '../../../src/lib/logger';

/**
 * FR-R3-081 (T1081, T1082) — `M-10`'s unaudited half.
 *
 * The review named the monitor map AND the transcript map. `FR-R3-052` bounded
 * the monitor half and recorded the other as outstanding, and outstanding is
 * what it stayed: measured on 2026-08-25 at `repo/` `3999f4da`, entries were
 * added to `chains` at three sites and deleted at none, so the map held one
 * settled promise per run id for the life of the extension host.
 *
 * That is not a dramatic leak — a promise and a string per run — and it is a
 * leak whose rate is "however many runs the operator starts", which is the
 * property that makes it worth bounding rather than the size. A long-lived host
 * on a busy workspace is exactly the case this feature's measurement half is
 * about.
 *
 * The property asserted is the one that matters and the one a size assertion
 * cannot give: after N runs finish, the map is EMPTY. A test that asserted "the
 * map is small" would pass on a leak that is merely slow.
 */
let workspaceRoot: string;
let writer: RawTranscriptWriter;

/** The private field, read for the assertion. Nothing production reads it. */
function chainSize(instance: RawTranscriptWriter): number {
  return (instance as unknown as { chains: Map<string, unknown> }).chains.size;
}

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-tx-lifetime-'));
  writer = new RawTranscriptWriter(
    workspaceRoot,
    new SanitizedLogger(),
    path.join(workspaceRoot, 'raw-spool')
  );
});

async function driveRun(runId: string, mode: 'always' | 'errors-only'): Promise<void> {
  await writer.appendStart({ runId, phase: 'speckit-plan', iteration: 1, prompt: 'p', mode });
  await writer.appendEnd({
    runId,
    stdout: 'out',
    stderr: '',
    exitCode: 0,
    killed: false,
    timedOut: false,
    mode
  });
  await writer.finalizeRun(runId, 'completed', mode);
}

describe('FR-R3-081 — the transcript chain map has a stated lifetime', () => {
  it('returns to empty after every run finishes', async () => {
    for (let i = 0; i < 25; i += 1) await driveRun(`run-${i}`, 'always');
    expect(chainSize(writer)).toBe(0);
  });

  it('returns to empty for the errors-only retention mode too', async () => {
    // A different path through `finalizeRun` — promotion rather than discard —
    // and the entry has to go on both.
    for (let i = 0; i < 10; i += 1) await driveRun(`err-${i}`, 'errors-only');
    expect(chainSize(writer)).toBe(0);
  });

  it('keeps the entry while a run still has writes pending', async () => {
    // The bound must not become a bug: an entry dropped while work is still
    // queued behind it would let two writes for one run interleave.
    const pending = writer.appendStart({
      runId: 'run-live',
      phase: 'speckit-plan',
      iteration: 1,
      prompt: 'p'
    });
    expect(chainSize(writer)).toBe(1);
    await pending;
    await writer.finalizeRun('run-live', 'completed', 'always');
    expect(chainSize(writer)).toBe(0);
  });

  it('keeps the newer chain when an append arrives while an earlier one settles', async () => {
    // The identity check. Both appends are issued before either is awaited, so
    // the first link settles with a newer one already in the map — deleting on
    // settle without checking identity would drop the live chain.
    const first = writer.appendStart({
      runId: 'run-race',
      phase: 'speckit-plan',
      iteration: 1,
      prompt: 'one'
    });
    const second = writer.appendStart({
      runId: 'run-race',
      phase: 'speckit-plan',
      iteration: 2,
      prompt: 'two'
    });
    await Promise.all([first, second]);
    // Both landed, in order, and the map is back to empty afterwards.
    const written = await fs.readFile(
      path.join(workspaceRoot, '.schegent', 'sessions', 'raw-run-race.log'),
      'utf8'
    );
    expect(written.indexOf('one')).toBeLessThan(written.indexOf('two'));
    expect(chainSize(writer)).toBe(0);
  });
});
