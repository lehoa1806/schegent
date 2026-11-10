// FR-R6-F07 T034 (FR-012, FR-016, SC-005) — every coverage reason a tail session
// meets has its own fixture, its own gap and its own counter.
//
// WHAT THIS PINS. For each reason the session produces:
//   - the posted batches carry exactly one `coverage-gap` entry with that reason,
//     however often the same state is seen again;
//   - the counter that reason feeds rises once;
//   - every counter is an integer, and a gap body holds the reason and integers
//     only, so no log text reaches the counters or the gap.
//
// Reason to counter:
//   not-yet-produced, artifact-expired, permission-refused, range-skipped → deliveryGaps
//   parse-omission, oversized-record, display-truncation                  → omittedRecords
//   source-replaced                                                        → sourceResets
// Bytes a gap stands for are added to `omittedBytes` where the session knows them.
//
// The two other reasons have other producers. `transport-gap` comes from the ACP
// projection (T038) and `capture-disabled` from the live-log index's restart
// replay (T039): a phase run with capture off writes no file, so a tail session
// never starts on one. Their fixtures are in the tests of those modules.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SanitizedLogger } from '../../../../src/lib/logger';
import {
  PhaseLogTailSession,
  type LiveLogBatchItem,
  type PhaseLogBatchPush
} from '../../../../src/services/phase-log/phase-log-tail-session';
import {
  LIVE_LOG_ENTRY_MAX_BYTES,
  LIVE_LOG_REPLAY_PASS_MAX_BYTES
} from '../../../../src/contracts/phase-log-bounds';
import type { PhaseLogSelection } from '../../../../src/services/phase-log/types';

let tmpDir: string;
const logger = new SanitizedLogger();
const sanitize = (s: string): string => logger.sanitize(s);

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-log-coverage-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const SELECTION: PhaseLogSelection = {
  queueId: 'q1',
  taskId: 'run-1',
  pipelineId: 'pipe-1',
  phaseId: 'phase-1',
  iterationN: 1
};

const INIT = '{"type":"system","subtype":"init"}';
const RESULT = '{"type":"result","duration_ms":1}';
/** A per-field cap that never binds, so only the entry bound shapes an entry. */
const UNBOUNDED_FIELD_BYTES = 1_048_576;
/** Ticks that see the same state again; the gap and its counter must not repeat. */
const RESIGHT_TICKS = 3;
const GAP_BODY_KEYS = new Set(['reason', 'count', 'bytes']);

function assistantLine(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}

function lines(...records: string[]): string {
  return records.map((record) => `${record}\n`).join('');
}

function streamPath(): string {
  return path.join(
    tmpDir,
    '.schegent',
    'sessions',
    'run-1',
    'diagnostics',
    'pipe-1',
    'phase-1',
    'iter-1',
    'stream.jsonl'
  );
}

async function writeFile(content: string | Buffer): Promise<void> {
  const p = streamPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

interface Harness {
  readonly session: PhaseLogTailSession;
  readonly batches: PhaseLogBatchPush[];
}

function makeHarness(caps: { perFieldBytes: number; residualMaxBytes?: number } = { perFieldBytes: 4096 }): Harness {
  const batches: PhaseLogBatchPush[] = [];
  const session = new PhaseLogTailSession({
    sessionId: 'sess-coverage',
    workspaceRoot: tmpDir,
    filePath: streamPath(),
    selection: SELECTION,
    sanitize,
    caps,
    postBatch: (batch) => {
      batches.push(batch);
      return true;
    }
  });
  return { session, batches };
}

async function startReady(harness: Harness): Promise<void> {
  await harness.session.start();
  harness.session.ack({ batchSeq: 0 });
  await harness.session.tick();
}

/** Acknowledges everything posted, then ticks `times` more on an unchanged source. */
async function resight(harness: Harness, times = RESIGHT_TICKS): Promise<void> {
  for (let round = 0; round < times; round += 1) {
    harness.session.ack({ batchSeq: harness.batches.length });
    await harness.session.tick();
  }
}

function itemsOf(batches: readonly PhaseLogBatchPush[]): LiveLogBatchItem[] {
  return batches.flatMap((batch) => batch.entries);
}

function gapsOf(batches: readonly PhaseLogBatchPush[]): LiveLogBatchItem[] {
  return itemsOf(batches).filter((item) => item.entry.kind === 'coverage-gap');
}

function reasonsOf(batches: readonly PhaseLogBatchPush[]): unknown[] {
  return gapsOf(batches).map((item) => item.entry.body.reason);
}

function isAfter(later: LiveLogBatchItem, earlier: LiveLogBatchItem): boolean {
  return later.at > earlier.at || (later.at === earlier.at && later.n > earlier.n);
}

/** Every counter an integer; every gap body the reason and integers only. */
function expectNoText(harness: Harness): void {
  for (const value of Object.values(harness.session.counters())) {
    expect(Number.isInteger(value)).toBe(true);
  }
  for (const gap of gapsOf(harness.batches)) {
    for (const [key, value] of Object.entries(gap.entry.body)) {
      expect(GAP_BODY_KEYS.has(key), `gap body key ${key}`).toBe(true);
      if (key !== 'reason') expect(Number.isInteger(value), `gap body ${key}`).toBe(true);
    }
  }
}

describe('FR-R6-F07 T034 — one fixture, gap and counter per coverage reason', () => {
  it('not-yet-produced: an empty source leads with one gap, and later records follow it', async () => {
    await writeFile('');
    const harness = makeHarness();
    await startReady(harness);
    await resight(harness);
    expect(reasonsOf(harness.batches)).toEqual(['not-yet-produced']);
    expect(harness.session.counters()).toMatchObject({ deliveryGaps: 1, omittedRecords: 0 });

    await fs.appendFile(streamPath(), lines(assistantLine('first words')));
    await resight(harness, 1);
    const items = itemsOf(harness.batches);
    expect(items.map((item) => item.entry.kind)).toEqual(['coverage-gap', 'assistant-text']);
    const [gap, record] = [items.at(0), items.at(1)];
    expect(gap !== undefined && record !== undefined && isAfter(record, gap)).toBe(true);
    expectNoText(harness);
    await harness.session.dispose('webview-stop');
  });

  it('parse-omission: a line that does not parse is one gap holding no text', async () => {
    const secret = 'sk' + '-live0coverage0secret0value0123456789';
    const malformed = `{"type":"assistant","token":"${secret}"`;
    await writeFile(`${INIT}\n${malformed}\n${RESULT}\n`);
    const harness = makeHarness();
    await startReady(harness);
    await resight(harness);
    expect(reasonsOf(harness.batches)).toEqual(['parse-omission']);
    expect(harness.session.counters()).toMatchObject({
      omittedRecords: 1,
      omittedBytes: malformed.length,
      deliveryGaps: 0
    });
    expect(JSON.stringify(harness.batches)).not.toContain(secret);
    expectNoText(harness);
    await harness.session.dispose('webview-stop');
  });

  it('oversized-record: a record above the residual bound is one gap', async () => {
    const residualMaxBytes = 1024;
    const huge = assistantLine('h'.repeat(residualMaxBytes * 4));
    await writeFile(lines(INIT, huge, RESULT));
    const harness = makeHarness({ perFieldBytes: 4096, residualMaxBytes });
    await startReady(harness);
    await resight(harness);
    expect(reasonsOf(harness.batches)).toEqual(['oversized-record']);
    expect(harness.session.counters()).toMatchObject({ omittedRecords: 1, deliveryGaps: 0 });
    expectNoText(harness);
    await harness.session.dispose('webview-stop');
  });

  it('display-truncation: an entry no shrink can fit is one gap', async () => {
    // A tool name is not a shrinkable field, so this entry cannot be cut to fit.
    const name = 'n'.repeat(LIVE_LOG_ENTRY_MAX_BYTES);
    const toolUse = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu-1', name, input: {} }] }
    });
    await writeFile(lines(INIT, toolUse, RESULT));
    const harness = makeHarness({ perFieldBytes: UNBOUNDED_FIELD_BYTES });
    await startReady(harness);
    await resight(harness);
    expect(reasonsOf(harness.batches)).toEqual(['display-truncation']);
    expect(harness.session.counters()).toMatchObject({ omittedRecords: 1, deliveryGaps: 0 });
    expect(JSON.stringify(harness.batches)).not.toContain(name);
    expectNoText(harness);
    await harness.session.dispose('webview-stop');
  });

  it('artifact-expired: a source that vanishes after start is one gap after what was shown', async () => {
    await writeFile(lines(INIT, assistantLine('before it went')));
    const harness = makeHarness();
    await startReady(harness);
    harness.session.ack({ batchSeq: 1 });
    await fs.rm(streamPath());
    await resight(harness);
    expect(reasonsOf(harness.batches)).toEqual(['artifact-expired']);
    expect(harness.session.counters()).toMatchObject({ deliveryGaps: 1, sourceResets: 0 });
    const items = itemsOf(harness.batches);
    const [shown, gap] = [items.at(-2), items.at(-1)];
    expect(shown?.entry.kind).toBe('assistant-text');
    expect(shown !== undefined && gap !== undefined && isAfter(gap, shown)).toBe(true);
    expectNoText(harness);
    await harness.session.dispose('webview-stop');
  });

  it('permission-refused: a source the containment open refuses is one gap, and nothing it names is read', async () => {
    await writeFile(lines(INIT));
    const harness = makeHarness();
    await startReady(harness);
    harness.session.ack({ batchSeq: 1 });
    const elsewhere = path.join(tmpDir, 'elsewhere.jsonl');
    await fs.writeFile(elsewhere, lines(assistantLine('not this file')));
    await fs.rm(streamPath());
    await fs.symlink(elsewhere, streamPath());
    await resight(harness);
    expect(reasonsOf(harness.batches)).toEqual(['permission-refused']);
    expect(harness.session.counters()).toMatchObject({ deliveryGaps: 1, sourceResets: 0 });
    expect(JSON.stringify(harness.batches)).not.toContain('not this file');
    expectNoText(harness);
    await harness.session.dispose('webview-stop');
  });

  it('source-replaced: a replaced source resets behind one gap', async () => {
    await writeFile(lines(INIT));
    const harness = makeHarness();
    await startReady(harness);
    harness.session.ack({ batchSeq: 1 });
    const replacement = `${streamPath()}.next`;
    await fs.writeFile(replacement, lines(RESULT));
    await fs.rename(replacement, streamPath());
    await resight(harness);
    expect(reasonsOf(harness.batches)).toEqual(['source-replaced']);
    expect(harness.session.counters()).toMatchObject({ sourceResets: 1, deliveryGaps: 0 });
    expectNoText(harness);
    await harness.session.dispose('webview-stop');
  });

  it('range-skipped: a source longer than one pass starts behind one gap counting the skipped bytes', async () => {
    const filler = `${assistantLine('f'.repeat(1000))}\n`;
    const count = Math.ceil(LIVE_LOG_REPLAY_PASS_MAX_BYTES / Buffer.byteLength(filler)) + 10;
    await writeFile(Buffer.from(filler.repeat(count)));
    const harness = makeHarness();
    await startReady(harness);
    const skipped = harness.session.skippedLeadingByteCount;
    expect(skipped).toBeGreaterThan(0);
    await resight(harness);
    expect(reasonsOf(harness.batches)).toEqual(['range-skipped']);
    expect(gapsOf(harness.batches).at(0)?.entry.body.bytes).toBe(skipped);
    expect(harness.session.counters()).toMatchObject({ deliveryGaps: 1, omittedBytes: skipped });
    expectNoText(harness);
    await harness.session.dispose('webview-stop');
  });
});
