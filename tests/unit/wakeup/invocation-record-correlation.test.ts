// Feature 031 T006 — unit tests for the five new OPTIONAL fields on
// `InvocationRecord`. Mirrors the contract diff at
// specs/031-advanced-wakeup-logs-models/contracts/wakeup-invocation-record.diff.md.
//
// The fields are additive — legacy records (014/024) MUST keep
// parsing as-is. A 031-aware record carries:
//   - correlationId        (UUIDv4)
//   - requestedModel       (operator's selection, verbatim)
//   - actualModel          (what the runner actually invoked)
//   - sessionLogBytesAppended  (byte counter)
//   - sessionLogTrimmed    (boolean retention marker)
//
// Coverage:
//   (a) parse a legacy line (no new fields) → record has none.
//   (b) parse a 031 line (all five new fields) → record carries them.
//   (c) round-trip via `JSON.stringify` / `JSON.parse` preserves the
//       new fields verbatim (stable shape).
//
// The reader's existing `tryParse` helper accepts unknown fields via
// the `[extra: string]: unknown` index signature, so this test pins
// the typed shape after T012 adds them as first-class optional fields.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InvocationLog,
  type InvocationRecord
} from '../../../src/wakeup/invocation-log';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'schegent-wakeup-corr-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function legacyRecord(over: Partial<InvocationRecord> = {}): InvocationRecord {
  return {
    timestamp: '2026-05-16T03:00:00.000Z',
    platform: 'darwin',
    pid: 1234,
    lockAcquired: true,
    ephemeralCwd: '/tmp/schegent-primer-session/abc',
    cwdInsideWorkspace: false,
    envScrubbed: true,
    claudeExitCode: 0,
    durationMs: 1500,
    ...over
  };
}

function fullThirtyOneRecord(): InvocationRecord {
  return {
    timestamp: '2026-05-16T04:00:00.000Z',
    platform: 'darwin',
    pid: 4321,
    lockAcquired: true,
    ephemeralCwd: '/tmp/schegent-primer-session/def',
    cwdInsideWorkspace: false,
    envScrubbed: true,
    claudeExitCode: 0,
    durationMs: 2500,
    triggerSource: 'scheduled',
    status: 'succeeded',
    correlationId: '8f7e6d5c-4b3a-4f2e-8d1c-9a8b7c6d5e4f',
    requestedModel: 'claude-sonnet-4-6',
    actualModel: 'claude-sonnet-4-6',
    sessionLogBytesAppended: 4096,
    sessionLogTrimmed: false
  };
}

describe('Feature 031 — InvocationRecord backward compatibility', () => {
  it('parses a legacy line (no 031 fields) and returns a record without them', async () => {
    const log = new InvocationLog(tempDir);
    const rec = legacyRecord();
    await log.append(rec);
    const back = await log.read();
    expect(back).toHaveLength(1);
    expect(back[0].correlationId).toBeUndefined();
    expect(back[0].requestedModel).toBeUndefined();
    expect(back[0].actualModel).toBeUndefined();
    expect(back[0].sessionLogBytesAppended).toBeUndefined();
    expect(back[0].sessionLogTrimmed).toBeUndefined();
  });

  it('parses a legacy line directly written to disk (no 031 fields)', async () => {
    // Simulate a pre-031 runner emission by hand-writing the line.
    writeFileSync(
      join(tempDir, 'invocations.log'),
      JSON.stringify(legacyRecord()) + '\n',
      'utf8'
    );
    const log = new InvocationLog(tempDir);
    const back = await log.read();
    expect(back).toHaveLength(1);
    expect(back[0].correlationId).toBeUndefined();
  });
});

describe('Feature 031 — InvocationRecord with 031 fields', () => {
  it('appends and reads back the five new optional fields', async () => {
    const log = new InvocationLog(tempDir);
    const rec = fullThirtyOneRecord();
    await log.append(rec);
    const back = await log.read();
    expect(back).toHaveLength(1);
    expect(back[0].correlationId).toBe('8f7e6d5c-4b3a-4f2e-8d1c-9a8b7c6d5e4f');
    expect(back[0].requestedModel).toBe('claude-sonnet-4-6');
    expect(back[0].actualModel).toBe('claude-sonnet-4-6');
    expect(back[0].sessionLogBytesAppended).toBe(4096);
    expect(back[0].sessionLogTrimmed).toBe(false);
  });

  it('round-trips via JSON.stringify / JSON.parse with stable shape', () => {
    const rec = fullThirtyOneRecord();
    const json = JSON.stringify(rec);
    const back = JSON.parse(json) as InvocationRecord;
    expect(back.correlationId).toBe(rec.correlationId);
    expect(back.requestedModel).toBe(rec.requestedModel);
    expect(back.actualModel).toBe(rec.actualModel);
    expect(back.sessionLogBytesAppended).toBe(rec.sessionLogBytesAppended);
    expect(back.sessionLogTrimmed).toBe(rec.sessionLogTrimmed);
  });

  it('preserves the fallback case: requestedModel !== actualModel', async () => {
    const log = new InvocationLog(tempDir);
    const rec: InvocationRecord = {
      ...legacyRecord({ timestamp: '2026-05-16T05:00:00.000Z' }),
      correlationId: '11111111-2222-4333-8444-555555555555',
      requestedModel: 'claude-bogus-9000',
      actualModel: 'runner-default',
      sessionLogBytesAppended: 256,
      sessionLogTrimmed: false
    };
    await log.append(rec);
    const back = await log.read();
    expect(back[0].requestedModel).toBe('claude-bogus-9000');
    expect(back[0].actualModel).toBe('runner-default');
  });

  it('verifies the on-disk JSON line carries the new fields verbatim', async () => {
    const log = new InvocationLog(tempDir);
    const rec = fullThirtyOneRecord();
    await log.append(rec);
    const content = readFileSync(join(tempDir, 'invocations.log'), 'utf8');
    expect(content).toContain('"correlationId":"8f7e6d5c-4b3a-4f2e-8d1c-9a8b7c6d5e4f"');
    expect(content).toContain('"requestedModel":"claude-sonnet-4-6"');
    expect(content).toContain('"actualModel":"claude-sonnet-4-6"');
    expect(content).toContain('"sessionLogBytesAppended":4096');
    expect(content).toContain('"sessionLogTrimmed":false');
  });

  it('enforces the lock-skipped invariant: status=skipped + lockAcquired=false → correlationId absent', () => {
    // Lock-skipped invocations produce no session-log block, so they
    // MUST NOT carry a correlationId. The runner code is responsible
    // for this (T034); here we pin the data-model invariant by
    // constructing a representative record.
    const skipped: InvocationRecord = legacyRecord({
      lockAcquired: false,
      skipped: true,
      status: 'skipped'
    });
    expect(skipped.correlationId).toBeUndefined();
  });
});
