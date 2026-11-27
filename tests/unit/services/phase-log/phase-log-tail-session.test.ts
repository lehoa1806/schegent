// Feature 020 T041, FR-R6-F07 (T015) — PhaseLogTailSession: file-append to
// acknowledged batches.
//
// The session reads a stream file from a byte position, frames whole records,
// projects, truncates and sanitizes them, and posts bounded batches. Nothing is
// posted before the consumer's ack 0. A batch's `toCursor` names the last
// projector-idle record boundary it passed. Ticks are driven by hand so the
// tests stay deterministic; the watcher belongs to the registry.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SanitizedLogger } from '../../../../src/lib/logger';
import {
  PhaseLogTailSession,
  type PhaseLogBatchPush
} from '../../../../src/services/phase-log/phase-log-tail-session';
import {
  FINGERPRINT_WINDOW_BYTES,
  fingerprintOf,
  generationOf,
  issueCursor,
  streamDigest
} from '../../../../src/services/phase-log/live-log-cursor';
import {
  LIVE_LOG_BATCH_MAX_BYTES,
  LIVE_LOG_ENTRY_MAX_BYTES,
  LIVE_LOG_PENDING_MAX_BYTES,
  LIVE_LOG_REPLAY_PASS_MAX_BYTES,
  LIVE_LOG_RESIDUAL_MAX_BYTES
} from '../../../../src/contracts/phase-log-bounds';
import type { PhaseLogSelection } from '../../../../src/services/phase-log/types';

let tmpDir: string;
const logger = new SanitizedLogger();
const sanitize = (s: string): string => logger.sanitize(s);

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase-log-tail-'));
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
const OPEN_STEP = JSON.stringify({
  event: 'step_update',
  step_type: 'agent_response',
  state: 'ACTIVE',
  step_index: 0,
  text_delta: 'thinking'
});

function assistantLine(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}

function toolUseLine(input: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input }] }
  });
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

async function appendFile(content: string | Buffer): Promise<void> {
  await fs.appendFile(streamPath(), content);
}

function lines(...records: string[]): string {
  return records.map((record) => `${record}\n`).join('');
}

/** The cursor the session is expected to issue for `offset` of the current file. */
async function cursorAt(offset: number): Promise<string> {
  const file = await fs.readFile(streamPath());
  const stat = await fs.stat(streamPath());
  const window = file.subarray(Math.max(0, offset - FINGERPRINT_WINDOW_BYTES), offset);
  return issueCursor({
    digest: streamDigest(tmpDir, SELECTION),
    generation: generationOf(stat, process.platform),
    offset,
    fingerprint: fingerprintOf(window)
  });
}

interface Harness {
  readonly session: PhaseLogTailSession;
  readonly batches: PhaseLogBatchPush[];
  setAccepting(accepting: boolean): void;
}

function makeHarness(sessionId = 'sess-1', perFieldBytes = 4096): Harness {
  const batches: PhaseLogBatchPush[] = [];
  let accepting = true;
  const session = new PhaseLogTailSession({
    sessionId,
    workspaceRoot: tmpDir,
    filePath: streamPath(),
    selection: SELECTION,
    sanitize,
    caps: { perFieldBytes },
    postBatch: (batch) => {
      if (!accepting) return false;
      batches.push(batch);
      return true;
    }
  });
  return {
    session,
    batches,
    setAccepting: (next) => {
      accepting = next;
    }
  };
}

async function startReady(harness: Harness, fromCursor?: string) {
  const started = await harness.session.start(fromCursor);
  harness.session.ack({ batchSeq: 0 });
  await harness.session.tick();
  return started;
}

function itemsOf(batches: readonly PhaseLogBatchPush[]) {
  return batches.flatMap((batch) => batch.entries);
}

function kindsOf(batches: readonly PhaseLogBatchPush[]): string[] {
  return itemsOf(batches).map((item) => item.entry.kind);
}

describe('FR-R6-F07 — PhaseLogTailSession start and readiness', () => {
  it('posts nothing before ack 0, then the snapshot as a reset batch', async () => {
    await writeFile(lines(INIT, RESULT));
    const harness = makeHarness();
    await harness.session.start();
    await harness.session.tick();
    expect(harness.batches).toHaveLength(0);
    harness.session.ack({ batchSeq: 0 });
    await harness.session.tick();
    expect(harness.batches).toHaveLength(1);
    const batch = harness.batches.at(0);
    expect(batch?.protocol).toBe(1);
    expect(batch?.tailSessionId).toBe('sess-1');
    expect(batch?.batchSeq).toBe(1);
    expect(batch?.mode).toBe('reset');
    expect(kindsOf(harness.batches)).toEqual(['system', 'result']);
    await harness.session.dispose('webview-stop');
  });

  it('returns the snapshot cutoff and status none without a cursor', async () => {
    await writeFile(lines(INIT));
    const harness = makeHarness();
    const started = await harness.session.start();
    expect(started).not.toBeNull();
    expect(started?.cursorStatus).toBe('none');
    expect(started?.snapshotCutoff).toBe(await cursorAt(0));
    expect(started?.nextCursor).toBe(started?.snapshotCutoff);
    expect(harness.session.skippedLeadingByteCount).toBe(0);
  });

  it('returns null when the stream file cannot be opened', async () => {
    const harness = makeHarness();
    expect(await harness.session.start()).toBeNull();
  });

  it('resumes from an accepted cursor with exactly the later records', async () => {
    await writeFile(lines(INIT, RESULT));
    const boundary = Buffer.byteLength(`${INIT}\n`);
    const cursor = await cursorAt(boundary);
    const harness = makeHarness();
    const started = await startReady(harness, cursor);
    expect(started?.cursorStatus).toBe('accepted');
    expect(started?.nextCursor).toBe(cursor);
    expect(harness.batches.at(0)?.mode).toBe('resume');
    expect(kindsOf(harness.batches)).toEqual(['result']);
    const { size } = await fs.stat(streamPath());
    expect(itemsOf(harness.batches).at(0)?.at).toBe(size);
    await harness.session.dispose('webview-stop');
  });

  it('resets on an unusable cursor and delivers the whole snapshot', async () => {
    await writeFile(lines(INIT, RESULT));
    const harness = makeHarness();
    const started = await startReady(harness, 'plc1.not-a-cursor');
    expect(started?.cursorStatus).toBe('reset');
    expect(harness.batches.at(0)?.mode).toBe('reset');
    expect(kindsOf(harness.batches)).toEqual(['system', 'result']);
    await harness.session.dispose('webview-stop');
  });

  it('reports an unknown cursor version and resets', async () => {
    await writeFile(lines(INIT));
    const harness = makeHarness();
    const started = await startReady(harness, 'plc9.anything');
    expect(started?.cursorStatus).toBe('unknown-version');
    expect(harness.batches.at(0)?.mode).toBe('reset');
    await harness.session.dispose('webview-stop');
  });

  it('opens a replaced source with a source-replaced gap', async () => {
    await writeFile(lines(INIT, RESULT));
    const stale = (await cursorAt(Buffer.byteLength(`${INIT}\n`))).replace(
      /^(plc1\.[0-9a-f]{16}\.)[^.]+/,
      '$1zz-zz'
    );
    const harness = makeHarness();
    const started = await startReady(harness, stale);
    expect(started?.cursorStatus).toBe('reset');
    const first = itemsOf(harness.batches).at(0);
    expect(first?.entry.kind).toBe('coverage-gap');
    expect(first?.entry.body.reason).toBe('source-replaced');
    expect(kindsOf(harness.batches).slice(1)).toEqual(['system', 'result']);
    expect(harness.session.counters().sourceResets).toBe(1);
    await harness.session.dispose('webview-stop');
  });

  it('starts a long stream at a record boundary near its end, with a range-skipped gap', async () => {
    const filler = `${assistantLine('f'.repeat(1000))}\n`;
    const count = Math.ceil(LIVE_LOG_REPLAY_PASS_MAX_BYTES / Buffer.byteLength(filler)) + 10;
    await writeFile(Buffer.from(filler.repeat(count)));
    await appendFile(lines(RESULT));
    const harness = makeHarness();
    const started = await startReady(harness);
    const skipped = harness.session.skippedLeadingByteCount;
    expect(skipped).toBeGreaterThan(0);
    expect(skipped % Buffer.byteLength(filler)).toBe(0);
    expect(started?.snapshotCutoff).toBe(await cursorAt(skipped));
    const first = itemsOf(harness.batches).at(0);
    expect(first?.entry.kind).toBe('coverage-gap');
    expect(first?.entry.body.reason).toBe('range-skipped');
    expect(first?.entry.body.bytes).toBe(skipped);
    harness.session.ack({ batchSeq: harness.batches.length });
    for (let round = 0; round < 64; round += 1) {
      await harness.session.tick();
      const last = harness.batches.at(-1);
      if (last === undefined || kindsOf([last]).includes('result')) break;
      harness.session.ack({ batchSeq: last.batchSeq });
    }
    expect(kindsOf(harness.batches).at(-1)).toBe('result');
    await harness.session.dispose('webview-stop');
  });

  it('never posts from the constructor', () => {
    const postBatch = vi.fn(() => true);
    new PhaseLogTailSession({
      sessionId: 'sess-1',
      workspaceRoot: tmpDir,
      filePath: streamPath(),
      selection: SELECTION,
      sanitize,
      caps: { perFieldBytes: 4096 },
      postBatch
    });
    expect(postBatch).not.toHaveBeenCalled();
  });
});

describe('FR-R6-F07 — batch positions and cursors', () => {
  it('positions each entry by its record end and ordinal', async () => {
    // Sixteen open agy steps fill the projector, so the record that closes a
    // seventeenth also closes the oldest: one record, two entries.
    const step = (index: number, state: string) =>
      JSON.stringify({
        event: 'step_update',
        step_type: 'agent_response',
        state,
        step_index: index,
        text_delta: `step ${index}`
      });
    const open = Array.from({ length: 16 }, (_, index) => step(index, 'ACTIVE'));
    await writeFile(lines(INIT, ...open, step(16, 'DONE')));
    const harness = makeHarness();
    await startReady(harness);
    const { size } = await fs.stat(streamPath());
    const initEnd = Buffer.byteLength(`${INIT}\n`);
    const positions = itemsOf(harness.batches).map((item) => [item.at, item.n]);
    expect(positions).toEqual([
      [initEnd, 0],
      [size, 0],
      [size, 1]
    ]);
    await harness.session.dispose('webview-stop');
  });

  it('sets toCursor only at a projector-idle record boundary', async () => {
    await writeFile(lines(INIT, OPEN_STEP, RESULT));
    const harness = makeHarness();
    await startReady(harness);
    expect(kindsOf(harness.batches)).toEqual(['system', 'result']);
    expect(harness.batches.at(0)?.toCursor).toBe(await cursorAt(Buffer.byteLength(`${INIT}\n`)));
    await harness.session.dispose('webview-stop');
  });

  it('sets a null toCursor when the batch passed no idle boundary', async () => {
    await writeFile(lines(OPEN_STEP, RESULT));
    const harness = makeHarness();
    await startReady(harness);
    expect(kindsOf(harness.batches)).toEqual(['result']);
    expect(harness.batches.at(0)?.toCursor).toBeNull();
    await harness.session.dispose('webview-stop');
  });

  it('stamps a monotonic seq across batches and carries the session id', async () => {
    await writeFile(lines(INIT));
    const harness = makeHarness('sess-XYZ');
    await startReady(harness);
    harness.session.ack({ batchSeq: 1 });
    await appendFile(lines(RESULT));
    await harness.session.tick();
    expect(harness.batches.map((batch) => batch.batchSeq)).toEqual([1, 2]);
    expect(harness.batches.at(1)?.mode).toBe('continue');
    const seqs = itemsOf(harness.batches).map((item) => item.entry.seq);
    expect(seqs).toEqual([1, 2]);
    expect(harness.batches.every((batch) => batch.tailSessionId === 'sess-XYZ')).toBe(true);
    await harness.session.dispose('webview-stop');
  });
});

describe('FR-R6-F07 — credit, rewind and suspension', () => {
  it('keeps unacknowledged batches within the pending bound and resumes on ack', async () => {
    const record = assistantLine('x'.repeat(4000));
    const total = 300;
    await writeFile(lines(...Array.from({ length: total }, () => record)));
    const harness = makeHarness();
    await startReady(harness);
    const firstWave = harness.batches.length;
    expect(itemsOf(harness.batches).length).toBeLessThan(total);
    const sentBytes = harness.batches.reduce(
      (sum, batch) => sum + Buffer.byteLength(JSON.stringify({ type: 'phase-log-batch', payload: batch })),
      0
    );
    expect(sentBytes).toBeLessThanOrEqual(LIVE_LOG_PENDING_MAX_BYTES);
    for (let round = 0; round < 16 && itemsOf(harness.batches).length < total; round += 1) {
      harness.session.ack({ batchSeq: harness.batches.at(-1)?.batchSeq ?? 0 });
      await harness.session.tick();
    }
    expect(harness.batches.length).toBeGreaterThan(firstWave);
    expect(itemsOf(harness.batches)).toHaveLength(total);
    for (const batch of harness.batches) {
      const envelope = JSON.stringify({ type: 'phase-log-batch', payload: batch });
      expect(Buffer.byteLength(envelope)).toBeLessThanOrEqual(LIVE_LOG_BATCH_MAX_BYTES);
    }
    const ats = itemsOf(harness.batches).map((item) => item.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    expect(new Set(ats).size).toBe(total);
    await harness.session.dispose('webview-stop');
  });

  it('rewinds to the last acknowledged cursor on resync and replays the same positions', async () => {
    await writeFile(lines(INIT));
    const harness = makeHarness();
    await startReady(harness);
    harness.session.ack({ batchSeq: 1 });
    await appendFile(lines(RESULT));
    await harness.session.tick();
    const sent = itemsOf(harness.batches.slice(1)).map((item) => [item.at, item.n]);
    harness.session.ack({ batchSeq: 1, resync: true });
    await harness.session.tick();
    const replay = harness.batches.at(-1);
    expect(replay?.mode).toBe('resume');
    expect(replay?.batchSeq).toBe(3);
    expect(replay?.entries.map((item) => [item.at, item.n])).toEqual(sent);
    expect(harness.session.counters()).toMatchObject({ replayAttempts: 1, deliveryGaps: 1 });
    await harness.session.dispose('webview-stop');
  });

  it('counts a duplicate acknowledgement', async () => {
    await writeFile(lines(INIT));
    const harness = makeHarness();
    await startReady(harness);
    harness.session.ack({ batchSeq: 1, duplicate: true });
    expect(harness.session.counters().duplicateBatches).toBe(1);
    await harness.session.dispose('webview-stop');
  });

  it('suspends when a post is refused and replays the unacknowledged range when visible', async () => {
    await writeFile(lines(INIT));
    const harness = makeHarness();
    await harness.session.start();
    harness.session.ack({ batchSeq: 0 });
    harness.setAccepting(false);
    await harness.session.tick();
    expect(harness.batches).toHaveLength(0);
    harness.setAccepting(true);
    await harness.session.tick();
    expect(harness.batches).toHaveLength(0);
    harness.session.setVisible(true);
    await harness.session.tick();
    expect(harness.batches.at(0)?.mode).toBe('reset');
    expect(kindsOf(harness.batches)).toEqual(['system']);

    harness.session.ack({ batchSeq: 1 });
    await appendFile(lines(RESULT));
    harness.setAccepting(false);
    await harness.session.tick();
    harness.setAccepting(true);
    harness.session.setVisible(true);
    await harness.session.tick();
    expect(harness.batches.at(-1)?.mode).toBe('resume');
    expect(kindsOf(harness.batches)).toEqual(['system', 'result']);
    await harness.session.dispose('webview-stop');
  });

  it('posts nothing while hidden', async () => {
    await writeFile(lines(INIT));
    const harness = makeHarness();
    await startReady(harness);
    harness.session.ack({ batchSeq: 1 });
    harness.session.setVisible(false);
    await appendFile(lines(RESULT));
    await harness.session.tick();
    expect(harness.batches).toHaveLength(1);
    harness.session.setVisible(true);
    await harness.session.tick();
    expect(kindsOf(harness.batches)).toEqual(['system', 'result']);
    expect(harness.batches.at(-1)?.mode, 'a reveal replays from the acknowledged cursor').toBe('resume');
    await harness.session.dispose('webview-stop');
  });

  it('skips a hidden backlog above one replay pass with one range-skipped gap, then shows the newest records', async () => {
    await writeFile(lines(INIT));
    const harness = makeHarness();
    await startReady(harness);
    harness.session.ack({ batchSeq: 1 });
    harness.session.setVisible(false);
    const filler = `${assistantLine('b'.repeat(1000))}\n`;
    const count = Math.ceil(LIVE_LOG_REPLAY_PASS_MAX_BYTES / Buffer.byteLength(filler)) + 10;
    await appendFile(Buffer.from(filler.repeat(count)));
    await appendFile(lines(RESULT));
    harness.session.setVisible(true);
    await harness.session.tick();
    const reveal = harness.batches.at(1);
    expect(reveal?.mode).toBe('resume');
    const gaps = itemsOf(harness.batches.slice(1)).filter((item) => item.entry.kind === 'coverage-gap');
    expect(gaps).toHaveLength(1);
    const gap = gaps.at(0);
    expect(gap?.entry.body.reason).toBe('range-skipped');
    const skipped = gap?.entry.body.bytes;
    expect(typeof skipped).toBe('number');
    expect(skipped).toBeGreaterThan(0);
    expect(Number(skipped) % Buffer.byteLength(filler)).toBe(0);
    expect(harness.session.counters()).toMatchObject({ deliveryGaps: 1, omittedBytes: skipped });
    for (let round = 0; round < 64; round += 1) {
      const last = harness.batches.at(-1);
      if (last === undefined || kindsOf([last]).includes('result')) break;
      harness.session.ack({ batchSeq: last.batchSeq });
      await harness.session.tick();
    }
    expect(kindsOf(harness.batches).at(-1)).toBe('result');
    const shownFiller = kindsOf(harness.batches.slice(1)).filter((kind) => kind === 'assistant-text').length;
    expect(shownFiller + Number(skipped) / Buffer.byteLength(filler)).toBe(count);
    await harness.session.dispose('webview-stop');
  });

  // FR-R6-F07 review R1 — a replay that skips the same backlog again re-posts the
  // gap row but must not count the skipped bytes, or the skip, a second time.
  it('counts a skipped backlog once when a resync replays across the same skip', async () => {
    await writeFile(lines(INIT));
    const harness = makeHarness();
    await startReady(harness);
    harness.session.ack({ batchSeq: 1 });
    harness.session.setVisible(false);
    const filler = `${assistantLine('b'.repeat(1000))}\n`;
    const count = Math.ceil(LIVE_LOG_REPLAY_PASS_MAX_BYTES / Buffer.byteLength(filler)) + 10;
    await appendFile(Buffer.from(filler.repeat(count)));
    harness.session.setVisible(true);
    await harness.session.tick();
    const firstGap = itemsOf(harness.batches.slice(1)).find((item) => item.entry.kind === 'coverage-gap');
    const skipped = firstGap?.entry.body.bytes;
    expect(typeof skipped).toBe('number');
    const sentBefore = harness.batches.length;

    harness.session.ack({ batchSeq: 1, resync: true });
    await harness.session.tick();
    const replayGap = itemsOf(harness.batches.slice(sentBefore)).find((item) => item.entry.kind === 'coverage-gap');
    expect(replayGap?.entry.body).toEqual(firstGap?.entry.body);
    expect([replayGap?.at, replayGap?.n]).toEqual([firstGap?.at, firstGap?.n]);
    expect(harness.session.counters()).toMatchObject({
      replayAttempts: 1,
      deliveryGaps: 2,
      omittedBytes: skipped
    });
    await harness.session.dispose('webview-stop');
  });
});

describe('FR-R6-F07 — source changes', () => {
  it('resets with a source-replaced gap when the file is replaced', async () => {
    await writeFile(lines(INIT));
    const harness = makeHarness();
    await startReady(harness);
    harness.session.ack({ batchSeq: 1 });
    const replacement = `${streamPath()}.next`;
    await fs.writeFile(replacement, lines(RESULT));
    await fs.rename(replacement, streamPath());
    await harness.session.tick();
    const batch = harness.batches.at(-1);
    expect(batch?.mode).toBe('reset');
    expect(batch?.entries.at(0)?.entry.body.reason).toBe('source-replaced');
    expect(batch?.entries.map((item) => item.entry.kind)).toEqual(['coverage-gap', 'result']);
    expect(harness.session.counters().sourceResets).toBe(1);
    await harness.session.dispose('webview-stop');
  });

  it('resets when the file is truncated below the read position', async () => {
    await writeFile(lines(INIT, RESULT));
    const harness = makeHarness();
    await startReady(harness);
    harness.session.ack({ batchSeq: 1 });
    await fs.truncate(streamPath(), 0);
    await appendFile(lines(RESULT));
    await harness.session.tick();
    const batch = harness.batches.at(-1);
    expect(batch?.mode).toBe('reset');
    expect(batch?.entries.map((item) => item.entry.kind)).toEqual(['coverage-gap', 'result']);
    expect(harness.session.counters().sourceResets).toBe(1);
    await harness.session.dispose('webview-stop');
  });
});

describe('FR-R6-F07 — framing', () => {
  it('holds a partial line, including a split multibyte character, until it completes', async () => {
    const record = Buffer.from(`${assistantLine('café ok')}\n`);
    const split = record.indexOf(Buffer.from('é')) + 1;
    await writeFile(record.subarray(0, split));
    const harness = makeHarness();
    await startReady(harness);
    expect(harness.batches).toHaveLength(0);
    expect(harness.session.retainedResidualBytes).toBe(split);
    await appendFile(record.subarray(split));
    await harness.session.tick();
    expect(itemsOf(harness.batches).at(0)?.entry.body.text).toBe('café ok');
    await harness.session.dispose('webview-stop');
  });

  it('turns a malformed line into one parse-omission gap, counted once across replay', async () => {
    const malformed = 'this is not valid json';
    await writeFile(lines(INIT, malformed, RESULT));
    const harness = makeHarness();
    await startReady(harness);
    expect(kindsOf(harness.batches)).toEqual(['system', 'coverage-gap', 'result']);
    const gap = itemsOf(harness.batches).at(1)?.entry;
    expect(gap?.body).toEqual({ reason: 'parse-omission', count: 1, bytes: malformed.length });
    expect(harness.session.skippedLines).toBe(1);
    harness.session.ack({ batchSeq: 0, resync: true });
    await harness.session.tick();
    expect(kindsOf(harness.batches.slice(1))).toEqual(['system', 'coverage-gap', 'result']);
    expect(harness.session.skippedLines).toBe(1);
    expect(harness.session.counters()).toMatchObject({
      omittedRecords: 1,
      omittedBytes: malformed.length
    });
    await harness.session.dispose('webview-stop');
  });

  it('replaces a record above the residual bound with an oversized-record gap', async () => {
    const huge = assistantLine('h'.repeat(LIVE_LOG_RESIDUAL_MAX_BYTES + 10));
    await writeFile(lines(INIT, huge, RESULT));
    const harness = makeHarness();
    await startReady(harness);
    expect(kindsOf(harness.batches)).toEqual(['system', 'coverage-gap', 'result']);
    expect(itemsOf(harness.batches).at(1)?.entry.body.reason).toBe('oversized-record');
    expect(harness.session.counters()).toMatchObject({
      omittedRecords: 1,
      omittedBytes: Buffer.byteLength(huge)
    });
    await harness.session.dispose('webview-stop');
  });

  it('covers several appends in one tick', async () => {
    await writeFile(lines(INIT));
    const harness = makeHarness();
    await startReady(harness);
    harness.session.ack({ batchSeq: 1 });
    await appendFile(lines('{"type":"system","subtype":"a"}'));
    await appendFile(lines('{"type":"system","subtype":"b"}'));
    await appendFile(lines('{"type":"system","subtype":"c"}'));
    await harness.session.tick();
    expect(itemsOf(harness.batches)).toHaveLength(4);
    expect(harness.batches).toHaveLength(2);
    await harness.session.dispose('webview-stop');
  });
});

describe('FR-R6-F07 — entry content', () => {
  it('sanitizes secret patterns in body strings before posting', async () => {
    // Split the OpenAI-key-shaped literal across concatenation so the
    // pre-commit secret scanner does not flag the test fixture itself.
    const fakeSecret = 'sk' + '-1234567890abcdef1234567890abcdef';
    await writeFile(lines(assistantLine(`token ${fakeSecret}`)));
    const harness = makeHarness();
    await startReady(harness);
    const text = itemsOf(harness.batches).at(0)?.entry.body.text ?? '';
    expect(text).not.toContain(fakeSecret);
    expect(text).toMatch(/REDACTED/i);
    await harness.session.dispose('webview-stop');
  });

  it('masks a secret inside a tool argument in the posted batch', async () => {
    // Split so the pre-commit secret scanner does not flag the fixture itself.
    const fakeSecret = 'sk' + '-abcdef1234567890abcdef1234567890';
    await writeFile(lines(toolUseLine({ command: `curl -H "Authorization: Bearer ${fakeSecret}"` })));
    const harness = makeHarness();
    await startReady(harness);
    const posted = JSON.stringify(harness.batches);
    expect(kindsOf(harness.batches)).toEqual(['tool-use']);
    expect(posted).not.toContain(fakeSecret);
    expect(posted).toMatch(/REDACTED/i);
    await harness.session.dispose('webview-stop');
  });

  it('ends a giant field within the entry bound when the per-field cap does not reach it', async () => {
    const perFieldBytes = 1_048_576;
    const giant = 'g'.repeat(Math.floor(LIVE_LOG_ENTRY_MAX_BYTES * 0.75));
    await writeFile(lines(toolUseLine({ command: giant })));
    const harness = makeHarness('sess-giant', perFieldBytes);
    await startReady(harness);
    const items = itemsOf(harness.batches);
    expect(items).toHaveLength(1);
    const entry = items.at(0)?.entry;
    expect(entry?.kind).toBe('tool-use');
    expect(Buffer.byteLength(JSON.stringify(entry), 'utf8')).toBeLessThanOrEqual(LIVE_LOG_ENTRY_MAX_BYTES);
    expect(entry?.bodyTruncated, 'the entry budget, not the field cap, shortened it').not.toBeNull();
    await harness.session.dispose('webview-stop');
  });

  it('truncates body fields that exceed the per-field byte cap', async () => {
    await writeFile(lines(assistantLine('a'.repeat(5000))));
    const harness = makeHarness();
    await startReady(harness);
    const entry = itemsOf(harness.batches).at(0)?.entry;
    expect(entry?.bodyTruncated?.text?.originalLength).toBe(5000);
    expect((entry?.body.text ?? '').length).toBeLessThanOrEqual(4096);
    await harness.session.dispose('webview-stop');
  });
});

describe('FR-R6-F07 — dispose', () => {
  it('posts a terminal tail-ended batch with the reason', async () => {
    await writeFile(lines(INIT));
    const harness = makeHarness();
    await startReady(harness);
    await harness.session.dispose('phase-complete');
    const final = harness.batches.at(-1);
    expect(final?.toCursor).toBeNull();
    expect(final?.entries).toHaveLength(1);
    expect(final?.entries.at(0)?.at).toBe(Number.MAX_SAFE_INTEGER);
    expect(final?.entries.at(0)?.entry.kind).toBe('tail-ended');
    expect(final?.entries.at(0)?.entry.body.reason).toBe('phase-complete');
  });

  it('never posts the terminal batch as a reset, so ending clears no shown entry', async () => {
    await writeFile(lines(INIT));
    const harness = makeHarness();
    await harness.session.start();
    harness.session.ack({ batchSeq: 0 });
    await harness.session.dispose('phase-complete');
    const final = harness.batches.at(-1);
    expect(kindsOf(harness.batches)).toEqual(['tail-ended']);
    expect(final?.mode).not.toBe('reset');
  });

  it('is idempotent on a second dispose', async () => {
    await writeFile(lines(INIT));
    const harness = makeHarness();
    await startReady(harness);
    await harness.session.dispose('webview-stop');
    const before = harness.batches.length;
    await harness.session.dispose('webview-stop');
    expect(harness.batches).toHaveLength(before);
    expect(harness.session.isDisposed).toBe(true);
  });

  it('posts nothing on dispose before the consumer is ready', async () => {
    await writeFile(lines(INIT));
    const harness = makeHarness();
    await harness.session.start();
    await harness.session.dispose('webview-dispose');
    expect(harness.batches).toHaveLength(0);
  });

  it('ignores ticks after dispose', async () => {
    await writeFile(lines(INIT));
    const harness = makeHarness();
    await harness.session.start();
    harness.session.ack({ batchSeq: 0 });
    await harness.session.dispose('webview-stop');
    const before = harness.batches.length;
    await appendFile(lines(RESULT));
    await harness.session.tick();
    expect(harness.batches).toHaveLength(before);
  });
});
