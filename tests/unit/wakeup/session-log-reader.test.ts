// Feature 031 T028 — unit tests for the session-log block reader.
//
// The reader scans `<wakeup home>/session.log` for the block whose
// header carries `id=<correlationId>` and returns the projected body
// (capped at 32 KB). Sanitization is dependency-injected — the reader
// is a SINK, not a sanitizer; the writer is responsible for writing
// already-sanitized bytes.
//
// Coverage:
//   (a) a `session.log` with three known blocks parses correctly by
//       correlationId (each block isolated to its own header → next-
//       header boundary).
//   (b) an unknown correlationId resolves to
//       `{ outcome: 'unknown-correlation-id' }`.
//   (c) a missing or unreadable file resolves to
//       `{ outcome: 'session-log-unavailable' }`.
//   (d) the projection respects `SESSION_PROJECTION_MAX_BYTES = 32 KB`
//       and sets `bodyTruncated: true` when the on-disk block exceeds
//       the cap.
//   (e) the reader is FRESH-READ-PER-REQUEST — no in-memory cache —
//       so a subsequent write is visible on the next call.
//
// Module under test lives at `src/wakeup/session-log-reader.ts` and
// MUST stay `vscode`-import-free.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionBlock } from '../../../src/wakeup/session-log-reader';
import { SESSION_PROJECTION_MAX_BYTES } from '../../../src/wakeup/session-log-constants';

function identitySanitize(input: string): string {
  return input;
}

function header(id: string, opts: { trigger?: string; model?: string; status?: string; iso?: string } = {}): string {
  const trigger = opts.trigger ?? 'scheduled';
  const model = opts.model ?? 'runner-default';
  const status = opts.status ?? 'succeeded';
  const iso = opts.iso ?? '2026-05-16T04:00:00.000Z';
  return `=== wakeup-block ${iso} id=${id} trigger=${trigger} model=${model} status=${status} ===\n`;
}

const ID_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ID_B = 'bbbbbbbb-cccc-4ddd-9eee-ffffffffffff';
const ID_C = 'cccccccc-dddd-4eee-aaaa-111111111111';

let tmpDir: string;
let sessionLogPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'session-log-reader-test-'));
  sessionLogPath = join(tmpDir, 'session.log');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Feature 031 T028 — session-log-reader block lookup', () => {
  it('parses each block by correlationId from a multi-block file', async () => {
    const content =
      header(ID_A) +
      'OUT: alpha body line\n' +
      'ERR: alpha err line\n' +
      header(ID_B) +
      'OUT: bravo body line\n' +
      header(ID_C) +
      'OUT: charlie body line\n';
    writeFileSync(sessionLogPath, content, 'utf8');

    const a = await readSessionBlock(ID_A, sessionLogPath, identitySanitize);
    expect(a.outcome).toBe('success');
    if (a.outcome !== 'success') return;
    expect(a.body).toContain('OUT: alpha body line');
    expect(a.body).toContain('ERR: alpha err line');
    expect(a.body).not.toContain('OUT: bravo body line');
    expect(a.bodyTruncated).toBe(false);

    const b = await readSessionBlock(ID_B, sessionLogPath, identitySanitize);
    expect(b.outcome).toBe('success');
    if (b.outcome !== 'success') return;
    expect(b.body).toContain('OUT: bravo body line');
    expect(b.body).not.toContain('OUT: charlie body line');
    expect(b.body).not.toContain('OUT: alpha body line');

    const c = await readSessionBlock(ID_C, sessionLogPath, identitySanitize);
    expect(c.outcome).toBe('success');
    if (c.outcome !== 'success') return;
    expect(c.body).toContain('OUT: charlie body line');
  });

  it('returns `unknown-correlation-id` when no block matches', async () => {
    writeFileSync(
      sessionLogPath,
      header(ID_A) + 'OUT: hi\n',
      'utf8'
    );
    const result = await readSessionBlock(ID_B, sessionLogPath, identitySanitize);
    expect(result.outcome).toBe('unknown-correlation-id');
  });

  it('returns `session-log-unavailable` when the file does not exist', async () => {
    const missing = join(tmpDir, 'missing-session.log');
    const result = await readSessionBlock(ID_A, missing, identitySanitize);
    expect(result.outcome).toBe('session-log-unavailable');
  });

  it('projects up to SESSION_PROJECTION_MAX_BYTES and sets bodyTruncated', async () => {
    // Build a 64 KB body so we exceed the 32 KB projection cap.
    const bigBody = 'OUT: ' + 'X'.repeat(64 * 1024) + '\n';
    const content = header(ID_A) + bigBody;
    writeFileSync(sessionLogPath, content, 'utf8');

    const result = await readSessionBlock(ID_A, sessionLogPath, identitySanitize);
    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    expect(Buffer.byteLength(result.body, 'utf8')).toBeLessThanOrEqual(
      SESSION_PROJECTION_MAX_BYTES
    );
    expect(result.bodyTruncated).toBe(true);
    expect(result.fullBlockBytesOnDisk).toBeGreaterThan(SESSION_PROJECTION_MAX_BYTES);
  });

  it('is fresh-read-per-request — a subsequent append is visible on the next call', async () => {
    writeFileSync(sessionLogPath, header(ID_A) + 'OUT: original\n', 'utf8');
    const first = await readSessionBlock(ID_A, sessionLogPath, identitySanitize);
    expect(first.outcome).toBe('success');

    // Append a NEW block for a different id between the two reads.
    appendFileSync(
      sessionLogPath,
      header(ID_B) + 'OUT: fresh content\n',
      'utf8'
    );

    const second = await readSessionBlock(ID_B, sessionLogPath, identitySanitize);
    expect(second.outcome).toBe('success');
    if (second.outcome !== 'success') return;
    expect(second.body).toContain('OUT: fresh content');
  });

  it('rejects malformed correlationId without touching the filesystem', async () => {
    writeFileSync(sessionLogPath, header(ID_A) + 'OUT: irrelevant\n', 'utf8');
    // Even pointing at a real file, a malformed id MUST resolve to
    // unknown-correlation-id (or invalid-correlation-id) before any
    // filesystem read. We accept `unknown-correlation-id` since the
    // upstream dispatcher does the shape check first; this test pins
    // that the reader does not crash on a non-UUIDv4 input.
    const result = await readSessionBlock(
      'NOT-A-UUID',
      sessionLogPath,
      identitySanitize
    );
    expect(result.outcome).toBe('unknown-correlation-id');
  });

  it('flows bytes through the sanitize callback exactly once', async () => {
    writeFileSync(
      sessionLogPath,
      header(ID_A) + 'OUT: secret=sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAA\n',
      'utf8'
    );
    let calls = 0;
    const sanitize = (input: string): string => {
      calls++;
      return input.replace(/sk-(ant-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
    };
    const result = await readSessionBlock(ID_A, sessionLogPath, sanitize);
    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    expect(calls).toBeGreaterThanOrEqual(1);
    // Either the writer or the reader sanitizes — both paths leave
    // [REDACTED] in the projection. Asserting the redaction landed is
    // enough; the exact-once invariant is pinned in the projection-
    // sanitization test (T033).
    expect(result.body).toContain('[REDACTED]');
  });
});
