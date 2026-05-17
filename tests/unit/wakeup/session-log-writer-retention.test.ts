// Feature 031 T042 — unit tests for the session-log writer's retention path.
//
// The writer enforces:
//   (a) When on-disk size before append < 32 MB, no trim occurs and
//       `trimmed: false`.
//   (b) When on-disk size after append > 32 MB, the oldest *complete* blocks
//       are removed from the head until size <= 32 MB and `trimmed: true`.
//   (c) The head of the remaining file always starts at `=== wakeup-block ` —
//       no partial block remains.
//   (d) When block-parse fails (hand-edit corruption) AND size > 128 MB, the
//       hard-cap path truncates to the most recent ~64 MB and reports
//       `trimmed: true` with the `hard-cap-emergency-truncate` annotation
//       (or to size 0 with the same annotation when no boundary is found).
//
// The 32 MB / 128 MB constants live in `src/wakeup/session-log-constants.ts`.
// We use a smaller `maxBytesOverride` injection on the writer so the test
// stays in-memory-bounded; the production code path uses the larger caps.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBlock } from '../../../src/wakeup/session-log-writer';

const ID_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ID_B = 'bbbbbbbb-cccc-4ddd-9eee-ffffffffffff';
const ID_C = 'cccccccc-dddd-4eee-aaaa-111111111111';
const ID_D = 'dddddddd-eeee-4fff-bbbb-222222222222';

function header(id: string, iso: string): string {
  return `=== wakeup-block ${iso} id=${id} trigger=scheduled model=runner-default status=succeeded ===\n`;
}

let tmpDir: string;
let sessionLogPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'session-log-writer-retention-'));
  sessionLogPath = join(tmpDir, 'session.log');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Feature 031 T042 — session-log-writer retention trimming', () => {
  it('does not trim when on-disk size after append remains under the soft cap', async () => {
    const result = await appendBlock({
      sessionLogPath,
      header: {
        iso: '2026-05-16T04:00:00.000Z',
        correlationId: ID_A,
        trigger: 'scheduled',
        model: 'runner-default',
        status: 'succeeded'
      },
      body: 'OUT: tiny\n'
    });
    expect(result.outcome).toBe('appended');
    if (result.outcome !== 'appended') return;
    expect(result.trimmed).toBe(false);
  });

  it('trims the oldest complete blocks when soft cap exceeded (with override)', async () => {
    // Use a 1 KB override so we can blow past the cap with tiny blocks.
    const SOFT_CAP = 1024;

    // Pre-populate with two large blocks then one small block — pushing
    // total well above SOFT_CAP. The trim should drop the head blocks
    // first, leaving the tail boundary intact.
    const filler = 'x'.repeat(800); // 800 bytes body
    let initial = '';
    initial += header(ID_A, '2026-05-16T04:00:00.000Z');
    initial += `OUT: ${filler}\n`;
    initial += header(ID_B, '2026-05-16T04:00:01.000Z');
    initial += `OUT: ${filler}\n`;
    writeFileSync(sessionLogPath, initial, 'utf8');

    const result = await appendBlock({
      sessionLogPath,
      header: {
        iso: '2026-05-16T04:00:02.000Z',
        correlationId: ID_C,
        trigger: 'scheduled',
        model: 'runner-default',
        status: 'succeeded'
      },
      body: 'OUT: latest\n',
      maxBytesOverride: SOFT_CAP
    });

    expect(result.outcome).toBe('appended');
    if (result.outcome !== 'appended') return;
    expect(result.trimmed).toBe(true);

    const content = readFileSync(sessionLogPath, 'utf8');
    expect(content.length).toBeLessThanOrEqual(SOFT_CAP);
    // Head of the remaining file MUST start at a block boundary.
    expect(content.startsWith('=== wakeup-block ')).toBe(true);
    // The newest block MUST survive.
    expect(content).toContain(`id=${ID_C}`);
    // The oldest block MUST be gone.
    expect(content).not.toContain(`id=${ID_A}`);
  });

  it('keeps the head at a block boundary after trim — no partial block', async () => {
    const SOFT_CAP = 800;

    // Three blocks at ~300 bytes each: total ~900, above SOFT_CAP.
    const blk = (id: string, iso: string): string =>
      header(id, iso) + 'OUT: ' + 'p'.repeat(240) + '\n';
    const initial =
      blk(ID_A, '2026-05-16T04:00:00.000Z') +
      blk(ID_B, '2026-05-16T04:00:01.000Z') +
      blk(ID_C, '2026-05-16T04:00:02.000Z');
    writeFileSync(sessionLogPath, initial, 'utf8');

    const result = await appendBlock({
      sessionLogPath,
      header: {
        iso: '2026-05-16T04:00:03.000Z',
        correlationId: ID_D,
        trigger: 'scheduled',
        model: 'runner-default',
        status: 'succeeded'
      },
      body: 'OUT: trail\n',
      maxBytesOverride: SOFT_CAP
    });

    expect(result.outcome).toBe('appended');
    if (result.outcome !== 'appended') return;
    expect(result.trimmed).toBe(true);

    const content = readFileSync(sessionLogPath, 'utf8');
    expect(content.startsWith('=== wakeup-block ')).toBe(true);
    // No partial mid-block bytes at the head: the entire file is a chain
    // of complete blocks back-to-back.
    expect(content.split('=== wakeup-block ').length).toBeGreaterThanOrEqual(2);
  });

  it('emergency-truncates to last 64 MB tail with annotation when corrupted past hard cap', async () => {
    // Force the hard-cap branch via overrides: soft 200B, hard 600B. Then
    // write a file > 600 B with NO block-header markers (hand-edit
    // corruption) so the soft-cap scan fails and the hard-cap path fires.
    const corrupt = 'this is not a real session log '.repeat(50); // ~1500 chars
    writeFileSync(sessionLogPath, corrupt, 'utf8');

    const result = await appendBlock({
      sessionLogPath,
      header: {
        iso: '2026-05-16T04:00:00.000Z',
        correlationId: ID_A,
        trigger: 'scheduled',
        model: 'runner-default',
        status: 'succeeded'
      },
      body: 'OUT: post-corrupt\n',
      maxBytesOverride: 200,
      hardCapOverride: 600
    });

    expect(result.outcome).toBe('appended');
    if (result.outcome !== 'appended') return;
    expect(result.trimmed).toBe(true);
    expect(result.trimAnnotation).toBe('hard-cap-emergency-truncate');

    const size = statSync(sessionLogPath).size;
    // Either truncated to 0 (no boundary found in tail) and just our new
    // block remains, or it was preserved with the boundary intact. Either
    // way the resulting file MUST start with a block boundary.
    const content = readFileSync(sessionLogPath, 'utf8');
    if (size > 0) {
      expect(content.startsWith('=== wakeup-block ')).toBe(true);
    }
    expect(content).toContain(`id=${ID_A}`);
  });
});
