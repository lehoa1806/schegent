// Feature 251 (FR-R4-F04, contract T25, FR-037, TL1) — how long the raw transcript lives, pinned against
// the real writer.
//
// The raw transcript is the one artifact the workspace holds unredacted, so its lifetime is the sentence
// an operator most needs to be true. TL1 changes nothing in the writer; this file pins what the
// retention disclosure says about it: under `errors-only` a failed leg's transcript is kept, a resumed
// Run that completes removes it, `off` writes none, and `always` keeps it whatever the end.
//
// Each "removed" claim is paired with a control that must hit: the transcript is read back before the
// completion, so a writer that left it behind would fail the assertion that follows and not pass on a
// file that never existed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { RawTranscriptWriter } from '../../../src/audit/raw-transcript-writer';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { RawTranscriptMode } from '../../../src/state/workflow-run';
import { createTransportHarness } from '../monitor/transport/transport-harness';

const RUN_ID = 'run-lifetime-251';
const FAILED_LEG_MARKER = 'SYNTHETIC-MARKER-251-FAILED-LEG';
const RESUMED_LEG_MARKER = 'SYNTHETIC-MARKER-251-RESUMED-LEG';

let workspaceRoot: string;
let writer: RawTranscriptWriter;

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-lifetime-251-'));
  // The spool stays under this test's own root, as `raw-transcript-writer.test.ts` does.
  writer = new RawTranscriptWriter(workspaceRoot, new SanitizedLogger([]), path.join(workspaceRoot, 'raw-spool'));
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

const retainedPath = (runId: string): string => path.join(workspaceRoot, '.schegent', 'sessions', `raw-${runId}.log`);
const pendingPath = (runId: string): string =>
  path.join(workspaceRoot, '.schegent', 'sessions', '.pending', `raw-${runId}.log`);

async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(
    () => true,
    () => false
  );
}

async function writeLeg(runId: string, mode: RawTranscriptMode, marker: string, exitCode: number): Promise<void> {
  await writer.appendStart({ runId, phase: 'speckit-plan', iteration: 1, prompt: marker, mode });
  await writer.appendEnd({
    runId,
    stdout: marker,
    stderr: exitCode === 0 ? '' : 'failed',
    exitCode,
    killed: false,
    timedOut: false,
    mode
  });
}

describe('errors-only keeps a failed leg and drops it when the resumed Run completes (TL1)', () => {
  it('retains the failed leg under its Run name', async () => {
    await writeLeg(RUN_ID, 'errors-only', FAILED_LEG_MARKER, 1);
    expect(await exists(pendingPath(RUN_ID)), 'the leg is staged before its end').toBe(true);

    await writer.finalizeRun(RUN_ID, 'failed', 'errors-only');

    expect(await exists(pendingPath(RUN_ID))).toBe(false);
    expect(await fs.readFile(retainedPath(RUN_ID), 'utf8')).toContain(FAILED_LEG_MARKER);
  });

  it('removes the retained transcript and the resumed leg\'s stage when the Run completes', async () => {
    await writeLeg(RUN_ID, 'errors-only', FAILED_LEG_MARKER, 1);
    await writer.finalizeRun(RUN_ID, 'failed', 'errors-only');
    // The control: the failed leg's transcript is on disk, so what follows is a removal.
    expect(await exists(retainedPath(RUN_ID))).toBe(true);

    // The resumed leg reuses the Run id and stages its own transcript.
    await writeLeg(RUN_ID, 'errors-only', RESUMED_LEG_MARKER, 0);
    expect(await exists(pendingPath(RUN_ID)), 'the resumed leg is staged').toBe(true);

    await writer.finalizeRun(RUN_ID, 'completed', 'errors-only');

    expect(await exists(retainedPath(RUN_ID))).toBe(false);
    expect(await exists(pendingPath(RUN_ID))).toBe(false);
  });

  it('keeps a resumed leg that fails again, replacing nothing it should not', async () => {
    await writeLeg(RUN_ID, 'errors-only', FAILED_LEG_MARKER, 1);
    await writer.finalizeRun(RUN_ID, 'failed', 'errors-only');
    await writeLeg(RUN_ID, 'errors-only', RESUMED_LEG_MARKER, 1);
    await writer.finalizeRun(RUN_ID, 'failed', 'errors-only');

    const kept = await fs.readFile(retainedPath(RUN_ID), 'utf8');
    expect(kept).toContain(RESUMED_LEG_MARKER);
    expect(await exists(pendingPath(RUN_ID))).toBe(false);
  });

  it('distinguishes paused vs failed staging for transport and removes both raw transcript and transport when the resumed Run completes (FR-R5-F17)', async () => {
    const transport = await createTransportHarness({
      setting: 'errors-only',
      rawMode: 'errors-only'
    });
    const runFile = path.join(
      transport.workspaceRoot,
      '.schegent',
      'sessions',
      RUN_ID,
      'transport.log'
    );
    try {
      // Leg 1 pauses: raw transcript promotes on `paused`, while transport stays staged in <temp>.
      await writeLeg(RUN_ID, 'errors-only', FAILED_LEG_MARKER, 1);
      transport.record(RUN_ID, FAILED_LEG_MARKER);
      await transport.flush();
      await writer.finalizeRun(RUN_ID, 'paused', 'errors-only');
      await transport.router.finalizeRun(RUN_ID, 'paused', new Set([RUN_ID]));

      expect(await exists(retainedPath(RUN_ID))).toBe(true);
      expect(await exists(runFile)).toBe(false);

      // Leg 2 fails: raw transcript appends to retained, and transport promotes to the Run file.
      await writeLeg(RUN_ID, 'errors-only', RESUMED_LEG_MARKER, 1);
      transport.record(RUN_ID, RESUMED_LEG_MARKER);
      await transport.flush();
      await writer.finalizeRun(RUN_ID, 'failed', 'errors-only');
      await transport.router.finalizeRun(RUN_ID, 'failed', new Set());

      expect(await exists(retainedPath(RUN_ID))).toBe(true);
      expect(await exists(runFile)).toBe(true);

      // Leg 3 resumes and completes: Run-level `errors-only` removes both the promoted raw transcript and the promoted transport file.
      await writeLeg(RUN_ID, 'errors-only', 'FINAL-COMPLETED-LEG', 0);
      transport.record(RUN_ID, 'FINAL-COMPLETED-LEG');
      await transport.flush();
      await writer.finalizeRun(RUN_ID, 'completed', 'errors-only');
      await transport.router.finalizeRun(RUN_ID, 'completed', new Set());

      expect(await exists(retainedPath(RUN_ID))).toBe(false);
      expect(await exists(pendingPath(RUN_ID))).toBe(false);
      expect(await exists(runFile)).toBe(false);
    } finally {
      await transport.dispose();
    }
  });
});

describe('off writes none', () => {
  it('creates no transcript, no stage and no spool capture', async () => {
    await writer.appendStart({ runId: RUN_ID, phase: 'speckit-plan', iteration: 1, prompt: 'p', mode: 'off' });
    expect(await writer.createInvocationCapture(RUN_ID, 'off')).toBeNull();
    await writer.appendEnd({
      runId: RUN_ID,
      stdout: FAILED_LEG_MARKER,
      stderr: '',
      exitCode: 0,
      killed: false,
      timedOut: false,
      mode: 'off'
    });
    await writer.finalizeRun(RUN_ID, 'failed', 'off');

    expect(await exists(retainedPath(RUN_ID))).toBe(false);
    expect(await exists(pendingPath(RUN_ID))).toBe(false);
  });
});

describe('always keeps it', () => {
  it.each(['completed', 'failed'] as const)('keeps the transcript when the Run ends %s', async (status) => {
    await writeLeg(RUN_ID, 'always', FAILED_LEG_MARKER, status === 'completed' ? 0 : 1);
    await writer.finalizeRun(RUN_ID, status, 'always');

    expect(await fs.readFile(retainedPath(RUN_ID), 'utf8')).toContain(FAILED_LEG_MARKER);
  });
});
