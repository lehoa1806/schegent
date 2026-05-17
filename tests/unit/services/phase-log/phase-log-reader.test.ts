// Feature 020 T018 — `readIterationManifest`: end-to-end fixture →
// manifest with sanitized + truncated entries; SECRET_PATTERNS
// redaction verified at the IPC body. See
// specs/020-phase-level-logs/contracts/phase-log-service.md §6.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { readIterationManifest } from '../../../../src/services/phase-log/phase-log-reader';

let tmpDir: string;
const logger = new SanitizedLogger();

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase-log-reader-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const BASE_SELECTION = {
  queueId: 'q1',
  taskId: 'run-1',
  pipelineId: 'pipe-1',
  phaseId: 'phase-1',
  iterationN: null as number | null
};

function streamPath(iteration: number): string {
  return path.join(
    tmpDir,
    '.schegent',
    'sessions',
    'run-1',
    'diagnostics',
    'pipe-1',
    'phase-1',
    `iter-${iteration}`,
    'stream.jsonl'
  );
}

async function writeStream(iteration: number, lines: string[]): Promise<void> {
  const p = streamPath(iteration);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, lines.map((l) => `${l}\n`).join(''));
}

const sanitize = (s: string): string => logger.sanitize(s);

describe('Feature 020 T018 — readIterationManifest end-to-end', () => {
  it('returns an empty manifest when the phase dir does not exist', async () => {
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: BASE_SELECTION,
      isInFlight: false,
      caps: { perFieldBytes: 4096, maxEntries: 500 },
      sanitize
    });
    expect(manifest.iterations).toEqual([]);
    expect(manifest.selectedIteration).toBeNull();
    expect(manifest.entries).toEqual([]);
    expect(manifest.skippedLines).toBe(0);
    expect(manifest.truncatedCount).toBe(0);
    expect(manifest.isInFlight).toBe(false);
  });

  it('discovers iterations descending and defaults selectedIteration to the latest', async () => {
    await writeStream(1, ['{"type":"system","subtype":"init"}']);
    await writeStream(2, ['{"type":"system","subtype":"init"}']);
    await writeStream(5, ['{"type":"system","subtype":"init"}']);
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: BASE_SELECTION,
      isInFlight: false,
      caps: { perFieldBytes: 4096, maxEntries: 500 },
      sanitize
    });
    expect(manifest.iterations).toEqual([5, 2, 1]);
    expect(manifest.selectedIteration).toBe(5);
    expect(manifest.entries.length).toBeGreaterThan(0);
  });

  it('honors a requested iterationN when in iterations[]', async () => {
    await writeStream(1, ['{"type":"system","subtype":"init"}']);
    await writeStream(2, ['{"type":"system","subtype":"init"}']);
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: { ...BASE_SELECTION, iterationN: 1 },
      isInFlight: false,
      caps: { perFieldBytes: 4096, maxEntries: 500 },
      sanitize
    });
    expect(manifest.selectedIteration).toBe(1);
  });

  it('counts malformed lines into skippedLines', async () => {
    await writeStream(1, [
      '{"type":"system","subtype":"init"}',
      'this is not json',
      '{"type":"result","duration_ms":1}'
    ]);
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: BASE_SELECTION,
      isInFlight: false,
      caps: { perFieldBytes: 4096, maxEntries: 500 },
      sanitize
    });
    expect(manifest.skippedLines).toBe(1);
    expect(manifest.entries.length).toBe(2);
  });

  it('redacts SECRET_PATTERNS-matching strings in entry bodies', async () => {
    // Anthropic-style API key — matches SECRET_PATTERNS.
    const secret = 'sk-ant-1234567890abcdef1234567890ABCDEF';
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: `leaked: ${secret} :end` }]
      }
    });
    await writeStream(1, [line]);
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: BASE_SELECTION,
      isInFlight: false,
      caps: { perFieldBytes: 4096, maxEntries: 500 },
      sanitize
    });
    const entry = manifest.entries.find((e) => e.kind === 'assistant-text');
    expect(entry).toBeDefined();
    expect(entry?.body.text).not.toContain(secret);
    expect(entry?.body.text).toContain('[REDACTED]');
  });

  it('truncates large bodies and counts them into truncatedCount', async () => {
    const big = 'x'.repeat(5000);
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: big }] }
    });
    await writeStream(1, [line]);
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: BASE_SELECTION,
      isInFlight: false,
      caps: { perFieldBytes: 4096, maxEntries: 500 },
      sanitize
    });
    expect(manifest.truncatedCount).toBe(1);
    const entry = manifest.entries[0];
    expect(entry.bodyTruncated?.text?.originalLength).toBe(5000);
  });

  it('caps entries at maxEntries and prepends a truncated-head synthetic entry', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      lines.push(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: `line-${i}` }] }
        })
      );
    }
    await writeStream(1, lines);
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: BASE_SELECTION,
      isInFlight: false,
      caps: { perFieldBytes: 4096, maxEntries: 10 },
      sanitize
    });
    expect(manifest.entries.length).toBe(10);
    expect(manifest.entries[0].kind).toBe('truncated-head');
    expect(manifest.entries[0].body.droppedEntryCount).toBe(2);
  });

  it('throws TypeError when the selection is not fully populated', async () => {
    await expect(
      readIterationManifest({
        workspaceRoot: tmpDir,
        // @ts-expect-error — testing invariant
        selection: { ...BASE_SELECTION, taskId: null },
        isInFlight: false,
        caps: { perFieldBytes: 4096, maxEntries: 500 },
        sanitize
      })
    ).rejects.toThrow(TypeError);
  });
});

describe('Feature 029 — sanitizeToolArguments recursive string-leaf redaction', () => {
  it('redacts SECRET_PATTERNS tokens inside scalar string leaves of toolArguments', async () => {
    const secret = 'sk-ant-1234567890abcdef1234567890ABCDEF';
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Write',
            input: { file_path: '/x', token: `leaked: ${secret} :end` }
          }
        ]
      }
    });
    await writeStream(1, [line]);
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: BASE_SELECTION,
      isInFlight: false,
      caps: { perFieldBytes: 4096, maxEntries: 500 },
      sanitize
    });
    const entry = manifest.entries.find((e) => e.kind === 'tool-use');
    expect(entry).toBeDefined();
    const args = entry?.body.toolArguments as Record<string, unknown> | undefined;
    expect(args).toBeDefined();
    // Keys must be untouched.
    expect(Object.keys(args ?? {})).toEqual(['file_path', 'token']);
    // String leaf containing the secret must be redacted.
    expect(args?.['token']).not.toContain(secret);
    expect(String(args?.['token'])).toContain('[REDACTED]');
    // Other string leaves pass through unchanged.
    expect(args?.['file_path']).toBe('/x');
  });

  it('does not sanitize object keys even if the key text matches a SECRET pattern', async () => {
    // Construct a key that happens to look like a token; sanitizeToolArguments
    // walks values only, never keys.
    const tokenLikeKey = 'sk-ant-1234567890abcdef1234567890ABCDEF';
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Custom',
            input: { [tokenLikeKey]: 'normal-value' }
          }
        ]
      }
    });
    await writeStream(1, [line]);
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: BASE_SELECTION,
      isInFlight: false,
      caps: { perFieldBytes: 4096, maxEntries: 500 },
      sanitize
    });
    const entry = manifest.entries.find((e) => e.kind === 'tool-use');
    const args = entry?.body.toolArguments as Record<string, unknown> | undefined;
    expect(args).toBeDefined();
    // Key preserved as-is (no redaction).
    expect(Object.keys(args ?? {})).toContain(tokenLikeKey);
    expect(args?.[tokenLikeKey]).toBe('normal-value');
  });

  it('redacts secrets inside nested objects and arrays under toolArguments', async () => {
    const secret = 'sk-ant-1234567890abcdef1234567890ABCDEF';
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Nested',
            input: {
              nested: {
                items: [`prefix ${secret} suffix`, 'clean']
              }
            }
          }
        ]
      }
    });
    await writeStream(1, [line]);
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: BASE_SELECTION,
      isInFlight: false,
      caps: { perFieldBytes: 4096, maxEntries: 500 },
      sanitize
    });
    const entry = manifest.entries.find((e) => e.kind === 'tool-use');
    const args = entry?.body.toolArguments as
      | { nested: { items: unknown[] } }
      | undefined;
    expect(args).toBeDefined();
    const items = args?.nested.items as string[];
    expect(items[0]).not.toContain(secret);
    expect(items[0]).toContain('[REDACTED]');
    expect(items[1]).toBe('clean');
  });

  it('passes non-string scalars through toolArguments unchanged', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Custom',
            input: {
              count: 42,
              ratio: 0.5,
              enabled: true,
              disabled: false,
              empty: null
            }
          }
        ]
      }
    });
    await writeStream(1, [line]);
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: BASE_SELECTION,
      isInFlight: false,
      caps: { perFieldBytes: 4096, maxEntries: 500 },
      sanitize
    });
    const entry = manifest.entries.find((e) => e.kind === 'tool-use');
    const args = entry?.body.toolArguments as Record<string, unknown> | undefined;
    expect(args).toEqual({
      count: 42,
      ratio: 0.5,
      enabled: true,
      disabled: false,
      empty: null
    });
  });
});
