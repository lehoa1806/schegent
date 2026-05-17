// Feature 020 T041 — PhaseLogTailSession: file-append → push pipeline.
// Verifies the offset/partial-buffer machinery, sanitization at the
// push boundary, monotonic seq, and the synthetic `tail-ended` entry
// emitted on dispose. The watcher mechanism is irrelevant here — we
// drive ticks manually so the test stays deterministic.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { PhaseLogTailSession } from '../../../../src/services/phase-log/phase-log-tail-session';
import type {
  PhaseLogDisplayEntry,
  PhaseLogSelection
} from '../../../../src/services/phase-log/types';

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

async function writeFile(content: string): Promise<void> {
  const p = streamPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

async function appendFile(content: string): Promise<void> {
  await fs.appendFile(streamPath(), content);
}

interface CapturedPush {
  readonly tailSessionId: string;
  readonly entrySeq: number;
  readonly entry: PhaseLogDisplayEntry;
}

function makePushSpy(): {
  push: (msg: CapturedPush) => void;
  calls: CapturedPush[];
} {
  const calls: CapturedPush[] = [];
  return {
    push: (msg) => {
      calls.push(msg);
    },
    calls
  };
}

describe('Feature 020 T041 — PhaseLogTailSession', () => {
  it('reads initial bytes on start and emits one push per parsed entry', async () => {
    await writeFile(
      [
        '{"type":"system","subtype":"init"}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}'
      ]
        .map((l) => `${l}\n`)
        .join('')
    );
    const spy = makePushSpy();
    const session = new PhaseLogTailSession({
      sessionId: 'sess-1',
      filePath: streamPath(),
      selection: SELECTION,
      pushToWebview: spy.push,
      sanitize,
      caps: { perFieldBytes: 4096 }
    });
    await session.tick();
    expect(spy.calls.length).toBe(2);
    expect(spy.calls[0].entry.kind).toBe('system');
    expect(spy.calls[1].entry.kind).toBe('assistant-text');
    expect(spy.calls[0].entrySeq).toBe(1);
    expect(spy.calls[1].entrySeq).toBe(2);
    expect(spy.calls.every((c) => c.tailSessionId === 'sess-1')).toBe(true);
    await session.dispose('webview-stop');
  });

  it('joins a partial line across two ticks', async () => {
    await writeFile('{"type":"system","subtype":"init"}\n{"type":"assist');
    const spy = makePushSpy();
    const session = new PhaseLogTailSession({
      sessionId: 'sess-1',
      filePath: streamPath(),
      selection: SELECTION,
      pushToWebview: spy.push,
      sanitize,
      caps: { perFieldBytes: 4096 }
    });
    await session.tick();
    expect(spy.calls.length).toBe(1); // only the system line; partial held
    await appendFile('ant","message":{"content":[{"type":"text","text":"world"}]}}\n');
    await session.tick();
    expect(spy.calls.length).toBe(2);
    expect(spy.calls[1].entry.kind).toBe('assistant-text');
    expect(spy.calls[1].entry.body.text).toBe('world');
    await session.dispose('webview-stop');
  });

  it('sanitizes secret patterns in body strings before pushing', async () => {
    // Split the OpenAI-key-shaped literal across concatenation so the
    // pre-commit secret scanner does not flag the test fixture itself.
    const fakeSecret = 'sk' + '-1234567890abcdef1234567890abcdef';
    const secretLine = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: `token ${fakeSecret}` }]
      }
    });
    await writeFile(`${secretLine}\n`);
    const spy = makePushSpy();
    const session = new PhaseLogTailSession({
      sessionId: 'sess-1',
      filePath: streamPath(),
      selection: SELECTION,
      pushToWebview: spy.push,
      sanitize,
      caps: { perFieldBytes: 4096 }
    });
    await session.tick();
    expect(spy.calls.length).toBe(1);
    const text = spy.calls[0].entry.body.text ?? '';
    expect(text).not.toContain(fakeSecret);
    expect(text).toMatch(/REDACTED/i);
    await session.dispose('webview-stop');
  });

  it('counts malformed lines as skipped and does not push them', async () => {
    await writeFile(
      [
        '{"type":"system","subtype":"init"}',
        'this is not valid json',
        '{"type":"system","subtype":"end"}'
      ]
        .map((l) => `${l}\n`)
        .join('')
    );
    const spy = makePushSpy();
    const session = new PhaseLogTailSession({
      sessionId: 'sess-1',
      filePath: streamPath(),
      selection: SELECTION,
      pushToWebview: spy.push,
      sanitize,
      caps: { perFieldBytes: 4096 }
    });
    await session.tick();
    expect(spy.calls.length).toBe(2);
    expect(session.skippedLines).toBe(1);
    await session.dispose('webview-stop');
  });

  it('emits a synthetic `tail-ended` entry on dispose with the supplied reason', async () => {
    await writeFile('{"type":"system","subtype":"init"}\n');
    const spy = makePushSpy();
    const session = new PhaseLogTailSession({
      sessionId: 'sess-1',
      filePath: streamPath(),
      selection: SELECTION,
      pushToWebview: spy.push,
      sanitize,
      caps: { perFieldBytes: 4096 }
    });
    await session.tick();
    expect(spy.calls.length).toBe(1);
    await session.dispose('phase-complete');
    const final = spy.calls[spy.calls.length - 1];
    expect(final.entry.kind).toBe('tail-ended');
    expect(final.entry.body.reason).toBe('phase-complete');
  });

  it('is idempotent on a second dispose call (no double tail-ended)', async () => {
    await writeFile('{"type":"system","subtype":"init"}\n');
    const spy = makePushSpy();
    const session = new PhaseLogTailSession({
      sessionId: 'sess-1',
      filePath: streamPath(),
      selection: SELECTION,
      pushToWebview: spy.push,
      sanitize,
      caps: { perFieldBytes: 4096 }
    });
    await session.tick();
    await session.dispose('webview-stop');
    const beforeSecond = spy.calls.length;
    await session.dispose('webview-stop');
    expect(spy.calls.length).toBe(beforeSecond);
  });

  it('does NOT re-push entries that were already pushed (offset advances)', async () => {
    await writeFile('{"type":"system","subtype":"init"}\n');
    const spy = makePushSpy();
    const session = new PhaseLogTailSession({
      sessionId: 'sess-1',
      filePath: streamPath(),
      selection: SELECTION,
      pushToWebview: spy.push,
      sanitize,
      caps: { perFieldBytes: 4096 }
    });
    await session.tick();
    await session.tick(); // no new bytes — no new pushes
    expect(spy.calls.length).toBe(1);
    await appendFile('{"type":"system","subtype":"end"}\n');
    await session.tick();
    expect(spy.calls.length).toBe(2);
    await session.dispose('webview-stop');
  });

  it('truncates body fields that exceed the per-field byte cap', async () => {
    const big = 'a'.repeat(5000);
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: big }] }
    });
    await writeFile(`${line}\n`);
    const spy = makePushSpy();
    const session = new PhaseLogTailSession({
      sessionId: 'sess-1',
      filePath: streamPath(),
      selection: SELECTION,
      pushToWebview: spy.push,
      sanitize,
      caps: { perFieldBytes: 4096 }
    });
    await session.tick();
    const entry = spy.calls[0].entry;
    expect(entry.bodyTruncated?.text?.originalLength).toBe(5000);
    expect((entry.body.text ?? '').length).toBeLessThanOrEqual(4096);
    await session.dispose('webview-stop');
  });

  it('ignores ticks after dispose (push spy unchanged)', async () => {
    await writeFile('{"type":"system","subtype":"init"}\n');
    const spy = makePushSpy();
    const session = new PhaseLogTailSession({
      sessionId: 'sess-1',
      filePath: streamPath(),
      selection: SELECTION,
      pushToWebview: spy.push,
      sanitize,
      caps: { perFieldBytes: 4096 }
    });
    await session.dispose('webview-stop');
    const before = spy.calls.length;
    await appendFile('{"type":"system","subtype":"end"}\n');
    await session.tick();
    expect(spy.calls.length).toBe(before);
  });

  it('surfaces sessionId in every pushed envelope', async () => {
    await writeFile('{"type":"system","subtype":"init"}\n');
    const spy = makePushSpy();
    const session = new PhaseLogTailSession({
      sessionId: 'sess-XYZ',
      filePath: streamPath(),
      selection: SELECTION,
      pushToWebview: spy.push,
      sanitize,
      caps: { perFieldBytes: 4096 }
    });
    await session.tick();
    await session.dispose('webview-stop');
    expect(spy.calls.every((c) => c.tailSessionId === 'sess-XYZ')).toBe(true);
  });
});

describe('Feature 020 T041 — PhaseLogTailSession push contract', () => {
  it('treats fs.appendFile concurrency atomically — one tick after multiple appends covers all', async () => {
    await writeFile('{"type":"system","subtype":"init"}\n');
    const spy = makePushSpy();
    const session = new PhaseLogTailSession({
      sessionId: 'sess-1',
      filePath: streamPath(),
      selection: SELECTION,
      pushToWebview: spy.push,
      sanitize,
      caps: { perFieldBytes: 4096 }
    });
    await session.tick();
    await appendFile('{"type":"system","subtype":"a"}\n');
    await appendFile('{"type":"system","subtype":"b"}\n');
    await appendFile('{"type":"system","subtype":"c"}\n');
    await session.tick();
    expect(spy.calls.length).toBe(4);
    await session.dispose('webview-stop');
  });

  it('never invokes pushToWebview synchronously inside the constructor', () => {
    const pushSpy = vi.fn();
    new PhaseLogTailSession({
      sessionId: 'sess-1',
      filePath: streamPath(),
      selection: SELECTION,
      pushToWebview: pushSpy,
      sanitize,
      caps: { perFieldBytes: 4096 }
    });
    expect(pushSpy).not.toHaveBeenCalled();
  });
});
