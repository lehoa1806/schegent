import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PhaseLogTailSession,
  type LiveLogBatchItem
} from '../../../src/services/phase-log/phase-log-tail-session';

describe('PhaseLogTailSession cross-tick residual bound (T016, T017, US4)', () => {
  let tmpDir = '';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-tail-bound-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('bounds an unterminated record growing across ticks, reports one oversized-record gap, recovers after the newline, and leaves disk bytes untouched (FR-R6-F07)', async () => {
    const logPath = path.join(tmpDir, 'stream.jsonl');
    await fs.writeFile(logPath, '', 'utf8');

    const pushed: LiveLogBatchItem[] = [];
    const session = new PhaseLogTailSession({
      sessionId: 'sess-bound-1',
      workspaceRoot: tmpDir,
      filePath: logPath,
      selection: {
        queueId: 'q1',
        taskId: 't1',
        pipelineId: 'p1',
        phaseId: 'ph1',
        iterationN: 1
      },
      postBatch: (batch) => {
        pushed.push(...batch.entries);
        return true;
      },
      sanitize: (s) => s,
      caps: {
        perFieldBytes: 65_536,
        residualMaxBytes: 200
      }
    });
    await session.start();
    session.ack({ batchSeq: 0 });

    // Tick 1: 120 bytes without a newline are held (120 <= 200).
    await fs.appendFile(logPath, 'a'.repeat(120), 'utf8');
    await session.tick();
    expect(session.retainedResidualBytes).toBe(120);
    // FR-R6-F07 (FR-012) — the file started empty, so the first batch is one
    // `not-yet-produced` gap; the residual assertions below start after it.
    expect(pushed.map((item) => item.entry.body.reason)).toEqual(['not-yet-produced']);
    pushed.splice(0);

    // Tick 2: 120 more cross the 200-byte bound: the held bytes are dropped and one gap is posted.
    await fs.appendFile(logPath, 'b'.repeat(120), 'utf8');
    await session.tick();
    expect(session.retainedResidualBytes).toBe(0);
    expect(pushed.map((item) => item.entry.kind)).toEqual(['coverage-gap']);
    expect(pushed.at(0)?.entry.body).toEqual({ reason: 'oversized-record', count: 1 });
    expect(pushed.at(0)?.at).toBe(200);
    expect(session.counters().omittedRecords).toBe(1);

    // Tick 3: 100 more bytes of the same record are discarded with no second gap.
    await fs.appendFile(logPath, 'c'.repeat(100), 'utf8');
    await session.tick();
    expect(session.retainedResidualBytes).toBe(0);
    expect(pushed).toHaveLength(1);

    // Tick 4: the record's newline and a valid assistant line.
    const validLine = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Recovered after newline' }] }
    });
    await fs.appendFile(logPath, `d\n${validLine}\n`, 'utf8');
    await session.tick();

    expect(session.retainedResidualBytes).toBe(0);
    expect(session.counters().omittedRecords).toBe(1);
    expect(session.counters().omittedBytes).toBe(341);
    expect(session.skippedLines).toBe(0);
    expect(pushed.map((item) => item.entry.kind)).toEqual(['coverage-gap', 'assistant-text']);
    expect(pushed.at(1)?.entry.body.text).toBe('Recovered after newline');

    // Verify authoritative on-disk file is completely unchanged by display overflow
    const expectedDiskContent = `${'a'.repeat(120)}${'b'.repeat(120)}${'c'.repeat(100)}d\n${validLine}\n`;
    const actualDiskContent = await fs.readFile(logPath, 'utf8');
    expect(
      crypto.createHash('sha256').update(actualDiskContent).digest('hex')
    ).toBe(crypto.createHash('sha256').update(expectedDiskContent).digest('hex'));
  });
});

