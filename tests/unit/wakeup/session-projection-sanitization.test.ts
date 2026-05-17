// Feature 031 T033 — single-point sanitization invariant for the
// wake-up session-log IPC projection.
//
// The IPC projection composer is required by the contract to use the
// EXISTING `SanitizedLogger.sanitize` callback as the SINGLE source of
// truth for redaction (see
// specs/031-advanced-wakeup-logs-models/contracts/wakeup-session-log-ipc.md
// §Sanitization boundary, and CLAUDE.md hard rule about
// `SECRET_PATTERNS` being the single redaction source).
//
// This test exercises the integration point with the REAL
// `SanitizedLogger.sanitize` against a fixture session.log block
// containing a well-formed secret pattern. The redacted token MUST
// appear in the projection body. The test also pins:
//
//   (a) Even when the on-disk block carries the secret verbatim (the
//       writer's sanitization is a defense in depth; for this projection
//       test we inject the real callback so the reader's sanitize step
//       lands the redaction), the IPC projection body NEVER carries the
//       raw secret. Repo-wide invariant: the only way bytes reach the
//       webview is through this reader.
//
//   (b) The callback is invoked AT MOST ONCE per read. Double
//       sanitization is forbidden by CLAUDE.md; we wrap the real
//       sanitize and assert the call count is 1.
//
//   (c) Multiple distinct SECRET_PATTERNS members redact independently
//       (sk-ant-* Anthropic-style + Bearer header + AWS access key id),
//       so future additions to `SECRET_PATTERNS` automatically benefit.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionBlock } from '../../../src/wakeup/session-log-reader';
import { SanitizedLogger } from '../../../src/lib/logger';

const ID_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function header(id: string, opts: { trigger?: string; model?: string; status?: string; iso?: string } = {}): string {
  const trigger = opts.trigger ?? 'scheduled';
  const model = opts.model ?? 'runner-default';
  const status = opts.status ?? 'succeeded';
  const iso = opts.iso ?? '2026-05-16T04:00:00.000Z';
  return `=== wakeup-block ${iso} id=${id} trigger=${trigger} model=${model} status=${status} ===\n`;
}

let tmpDir: string;
let sessionLogPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'session-projection-sanitize-test-'));
  sessionLogPath = join(tmpDir, 'session.log');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Feature 031 T033 — IPC projection sanitization invariant', () => {
  it('redacts an Anthropic-style sk-ant-* token via the real SanitizedLogger.sanitize callback', async () => {
    const secret = 'sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAA'; // matches SECRET_PATTERNS[0]
    writeFileSync(
      sessionLogPath,
      header(ID_A) +
        `OUT: leak=${secret}\n` +
        'OUT: tail line\n',
      'utf8'
    );

    const logger = new SanitizedLogger([]);
    const result = await readSessionBlock(
      ID_A,
      sessionLogPath,
      logger.sanitize.bind(logger)
    );

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    expect(result.body).toContain('[REDACTED]');
    expect(result.body).not.toContain(secret);
  });

  it('invokes the injected sanitize callback exactly once per read', async () => {
    const secret = 'sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAA';
    writeFileSync(
      sessionLogPath,
      header(ID_A) + `OUT: ${secret}\n`,
      'utf8'
    );

    const logger = new SanitizedLogger([]);
    let calls = 0;
    const sanitize = (input: string): string => {
      calls++;
      return logger.sanitize(input);
    };
    await readSessionBlock(ID_A, sessionLogPath, sanitize);

    // Single-sanitization invariant — CLAUDE.md hard rule.
    expect(calls).toBe(1);
  });

  it('redacts every distinct SECRET_PATTERNS family present in a single block', async () => {
    const anthropic = 'sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const bearer = 'Bearer abcdefghijklmnopqrstuvwxyz0123';
    const aws = 'AKIA' + 'IOSFODNN7EXAMPLE';
    writeFileSync(
      sessionLogPath,
      header(ID_A) +
        `OUT: anthropic=${anthropic}\n` +
        `ERR: auth=${bearer}\n` +
        `OUT: aws=${aws}\n`,
      'utf8'
    );

    const logger = new SanitizedLogger([]);
    const result = await readSessionBlock(
      ID_A,
      sessionLogPath,
      logger.sanitize.bind(logger)
    );

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;

    // None of the raw secrets survive in the projection.
    expect(result.body).not.toContain(anthropic);
    expect(result.body).not.toContain(bearer);
    expect(result.body).not.toContain(aws);
    // The redaction marker lands in the body.
    expect(result.body).toContain('[REDACTED]');
  });

  it('preserves non-secret content verbatim while redacting the secret', async () => {
    const secret = 'sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAA';
    writeFileSync(
      sessionLogPath,
      header(ID_A) +
        'OUT: prelude that should survive\n' +
        `ERR: oh no, leak=${secret}, recovering...\n` +
        'OUT: epilogue line\n',
      'utf8'
    );

    const logger = new SanitizedLogger([]);
    const result = await readSessionBlock(
      ID_A,
      sessionLogPath,
      logger.sanitize.bind(logger)
    );

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    // Surrounding context is preserved verbatim.
    expect(result.body).toContain('OUT: prelude that should survive');
    expect(result.body).toContain('OUT: epilogue line');
    // The secret is gone; the marker is in.
    expect(result.body).not.toContain(secret);
    expect(result.body).toContain('[REDACTED]');
  });
});
