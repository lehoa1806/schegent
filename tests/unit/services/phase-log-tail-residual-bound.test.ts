import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PhaseLogTailSession,
  type PhaseLogEntryPushPayload
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

  it('bounds an unterminated record growing across ticks, emits one display-omission notice per overflowed record, recovers after newline, and leaves disk bytes untouched', async () => {
    const logPath = path.join(tmpDir, 'stream.jsonl');
    await fs.writeFile(logPath, '', 'utf8');

    const pushed: PhaseLogEntryPushPayload[] = [];
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
      pushToWebview: (msg) => pushed.push(msg),
      sanitize: (s) => s,
      caps: {
        perFieldBytes: 65_536,
        maxResidualUnits: 200
      }
    });

    // Tick 1: 120 units without newline -> retained in partial (120 <= 200)
    await fs.appendFile(logPath, 'a'.repeat(120), 'utf8');
    await session.tick();
    expect(session.retainedResidualUnits).toBe(120);
    expect(session.droppedResidualUnits).toBe(0);
    expect(pushed).toHaveLength(0);

    // Tick 2: another 120 units without newline -> crosses 200-unit bound!
    // Residual is cleared, droppedResidualUnits becomes 240, and 1 omission notice is pushed.
    await fs.appendFile(logPath, 'b'.repeat(120), 'utf8');
    await session.tick();
    expect(session.retainedResidualUnits).toBe(0);
    expect(session.droppedResidualUnits).toBe(240);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.entry.kind).toBe('system');
    expect(pushed[0]!.entry.body.systemSubtype).toBe('display-omission');
    expect(String(pushed[0]!.entry.body.systemSummary)).toContain('200 UTF-16 units');

    // Tick 3: another 100 units still without newline -> discarded silently without duplicate notice
    await fs.appendFile(logPath, 'c'.repeat(100), 'utf8');
    await session.tick();
    expect(session.retainedResidualUnits).toBe(0);
    expect(session.droppedResidualUnits).toBe(340);
    expect(pushed).toHaveLength(1);

    // Tick 4: terminating newline for the oversize record + a valid JSONL assistant line
    const validLine = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Recovered after newline' }] }
    });
    await fs.appendFile(logPath, `d\n${validLine}\n`, 'utf8');
    await session.tick();

    expect(session.retainedResidualUnits).toBe(0);
    expect(session.droppedResidualUnits).toBe(341);
    expect(session.skippedLines).toBe(1);
    expect(pushed).toHaveLength(2);
    expect(pushed[1]!.entry.kind).toBe('assistant-text');
    expect(pushed[1]!.entry.body.text).toBe('Recovered after newline');

    // Verify authoritative on-disk file is completely unchanged by display overflow
    const expectedDiskContent = `${'a'.repeat(120)}${'b'.repeat(120)}${'c'.repeat(100)}d\n${validLine}\n`;
    const actualDiskContent = await fs.readFile(logPath, 'utf8');
    expect(
      crypto.createHash('sha256').update(actualDiskContent).digest('hex')
    ).toBe(crypto.createHash('sha256').update(expectedDiskContent).digest('hex'));
  });
});

