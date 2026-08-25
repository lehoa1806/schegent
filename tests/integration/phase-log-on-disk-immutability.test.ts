// Feature 029 T033 — on-disk immutability regression (SC-005).
//
// Hard rule: the phase-log view layer is strictly read-only. The bytes
// of `<workspaceRoot>/.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/stream.jsonl`
// MUST remain byte-for-byte identical after the manifest read, tail-
// session lifecycle, and any subsequent view-layer transformation.
//
// This test:
//   1. Materialises a realistic stream.jsonl (mixed kinds, secrets in
//      bodies so sanitization must fire).
//   2. Captures the SHA-256 of the raw file bytes.
//   3. Runs `readIterationManifest` (full manifest read path).
//   4. Spins up a `PhaseLogTailSession`, invokes `tick()` until quiet,
//      then disposes it.
//   5. Re-hashes the file and asserts the digest is unchanged.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SanitizedLogger } from '../../src/lib/logger';
import { readIterationManifest } from '../../src/services/phase-log/phase-log-reader';
import {
  PhaseLogTailSession,
  type PhaseLogEntryPushPayload
} from '../../src/services/phase-log/phase-log-tail-session';

const logger = new SanitizedLogger();
const sanitize = (s: string): string => logger.sanitize(s);

const SELECTION = {
  queueId: 'q1',
  taskId: 'run-immut-1',
  pipelineId: 'pipe-1',
  phaseId: 'phase-1',
  iterationN: 1
};

let tmpDir: string;
let streamPath: string;

async function writeStream(lines: string[]): Promise<void> {
  await fs.mkdir(path.dirname(streamPath), { recursive: true });
  await fs.writeFile(streamPath, lines.map((l) => `${l}\n`).join(''));
}

async function sha256(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase-log-immut-'));
  streamPath = path.join(
    tmpDir,
    '.schegent',
    'sessions',
    SELECTION.taskId,
    'diagnostics',
    SELECTION.pipelineId,
    SELECTION.phaseId,
    `iter-${SELECTION.iterationN}`,
    'stream.jsonl'
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('Feature 029 T033 — phase-log on-disk immutability (SC-005)', () => {
  it('preserves byte-identical stream.jsonl after a manifest read + tail-session lifecycle', async () => {
    // Build a manifest with mixed kinds AND secret-bearing strings so
    // sanitization is exercised on the in-memory body. The on-disk
    // bytes still must not change.
    const lines = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        cwd: '/Users/dev/repo',
        session_id: 'sess-1',
        model: 'claude-opus-4-7',
        tools: 'Read,Write,Edit,Bash'
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'token: sk-ant-api03-AAAAAAAAAAAAAAAAAAAA' }] }
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Write',
              input: {
                file_path: '/repo/note.md',
                content:
                  'Line 1\nLine 2 with sk-ant-api03-BBBBBBBBBBBBBBBBBBBB\nLine 3'
              }
            }
          ]
        }
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'id-1', content: 'ok\n', is_error: false }
          ]
        }
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text:
                '=== SCHEGENT AUDIT LOG ===\n[SCHEGENT_STATUS: CLEAR]\n=== END SCHEGENT AUDIT LOG ==='
            }
          ]
        }
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        duration_ms: 1234,
        num_turns: 3,
        total_cost_usd: 0.0042
      })
    ];
    await writeStream(lines);

    const beforeHash = await sha256(streamPath);
    const beforeStat = await fs.stat(streamPath);

    // 1. Manifest read.
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: SELECTION,
      isInFlight: true,
      caps: { perFieldBytes: 4096, maxEntries: 500 },
      sanitize
    });
    expect(manifest.entries.length).toBeGreaterThan(0);

    // 2. Tail-session lifecycle.
    const pushed: PhaseLogEntryPushPayload[] = [];
    const tail = new PhaseLogTailSession({
      sessionId: 'tail-1',
      workspaceRoot: tmpDir,
      filePath: streamPath,
      selection: { ...SELECTION, iterationN: SELECTION.iterationN },
      pushToWebview: (msg) => pushed.push(msg),
      sanitize,
      caps: { perFieldBytes: 4096 }
    });
    await tail.tick();
    await tail.tick();
    expect(pushed.length).toBeGreaterThan(0);

    // 3. Verify byte- and stat-level identity.
    const afterHash = await sha256(streamPath);
    const afterStat = await fs.stat(streamPath);
    expect(afterHash).toBe(beforeHash);
    expect(afterStat.size).toBe(beforeStat.size);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);

    // 4. Confirm the in-memory manifest WAS sanitized — proving the
    // sanitization fired on a path that COULD have written back, but
    // didn't.
    const flat = JSON.stringify(manifest);
    expect(flat).not.toContain('sk-ant-api03-AAAAAAAAAAAAAAAAAAAA');
    expect(flat).not.toContain('sk-ant-api03-BBBBBBBBBBBBBBBBBBBB');
  });
});
