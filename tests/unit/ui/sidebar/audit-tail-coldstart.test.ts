// Feature 068 (US3) — pins the cold-start replay contract for
// `readAuditTailColdStart(workspaceRoot)`. Tests cover INV-10..INV-16 from
// specs/068-enhance-system-log/contracts/audit-tail-projector.md §2:
//
//   INV-10  Missing file returns []
//   INV-11  Empty file returns []
//   INV-12  Valid file with N ≤ 50 entries returns all N projected entries
//   INV-13  Valid file with N > 50 entries returns the last 50
//   INV-14  Mixed valid + malformed lines returns only the valid projected
//   INV-15  Returned array is frozen
//   INV-16  Function does not modify the file (size & mtime unchanged)
//
// Plus T027 — empty workspaceRoot guard.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEntry } from '../../../../src/audit/audit-entry';
import { readAuditTailColdStart } from '../../../../src/ui/sidebar/audit-tail-coldstart';
import { AUDIT_TAIL_MAX } from '../../../../src/ui/sidebar/snapshot';

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 'entry-1',
    timestamp: '2026-05-23T12:00:00.000Z',
    runId: 'run-abc',
    phase: 'speckit-plan',
    iteration: 1,
    eventType: 'phase-start',
    payload: { summary: 'starting plan' },
    outcome: 'info',
    ...overrides
  };
}

function entryLine(overrides: Partial<AuditEntry> = {}): string {
  return JSON.stringify(entry(overrides));
}

describe('readAuditTailColdStart (Feature 068 US3)', () => {
  let workspaceRoot: string;
  let auditDir: string;
  let auditLog: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'schegent-coldstart-'));
    auditDir = join(workspaceRoot, '.schegent');
    auditLog = join(auditDir, 'audit.log');
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('INV-10: returns [] when .schegent/ directory is missing', async () => {
    const tail = await readAuditTailColdStart(workspaceRoot);
    expect(tail).toEqual([]);
  });

  it('INV-10: returns [] when audit.log file is missing but directory exists', async () => {
    await mkdir(auditDir, { recursive: true });
    const tail = await readAuditTailColdStart(workspaceRoot);
    expect(tail).toEqual([]);
  });

  it('INV-11: returns [] for empty audit.log', async () => {
    await mkdir(auditDir, { recursive: true });
    await writeFile(auditLog, '', 'utf8');
    const tail = await readAuditTailColdStart(workspaceRoot);
    expect(tail).toEqual([]);
  });

  it('INV-11: returns [] for whitespace-only audit.log', async () => {
    await mkdir(auditDir, { recursive: true });
    await writeFile(auditLog, '\n\n   \n\n', 'utf8');
    const tail = await readAuditTailColdStart(workspaceRoot);
    expect(tail).toEqual([]);
  });

  it('INV-12: returns all N projected entries when N ≤ AUDIT_TAIL_MAX', async () => {
    await mkdir(auditDir, { recursive: true });
    const lines = [
      entryLine({ id: 'e-1', iteration: 1 }),
      entryLine({ id: 'e-2', iteration: 2, eventType: 'phase-end', outcome: 'success' }),
      entryLine({ id: 'e-3', iteration: 3, eventType: 'cli-invocation', outcome: 'info', payload: { command: 'claude --print' } })
    ];
    await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

    const tail = await readAuditTailColdStart(workspaceRoot);

    expect(tail.length).toBe(3);
    expect(tail[0]!.id).toBe('e-1');
    expect(tail[1]!.id).toBe('e-2');
    expect(tail[2]!.id).toBe('e-3');
    expect(tail[2]!.command).toBe('claude --print');
  });

  it('INV-13: returns the last AUDIT_TAIL_MAX entries when file exceeds the cap', async () => {
    await mkdir(auditDir, { recursive: true });
    const totalEntries = AUDIT_TAIL_MAX + 25;
    const lines: string[] = [];
    for (let i = 0; i < totalEntries; i++) {
      lines.push(entryLine({ id: `e-${i}`, iteration: i }));
    }
    await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

    const tail = await readAuditTailColdStart(workspaceRoot);

    expect(tail.length).toBe(AUDIT_TAIL_MAX);
    // The first entry in the tail should be `e-25` (i.e., the (N - 50)th).
    expect(tail[0]!.id).toBe(`e-${totalEntries - AUDIT_TAIL_MAX}`);
    expect(tail[AUDIT_TAIL_MAX - 1]!.id).toBe(`e-${totalEntries - 1}`);
  });

  it('INV-14: returns only the valid projected entries when file mixes valid + malformed lines', async () => {
    await mkdir(auditDir, { recursive: true });
    const lines = [
      entryLine({ id: 'e-1', iteration: 1 }),
      '{not valid JSON',
      entryLine({ id: 'e-2', iteration: 2 }),
      '   ',
      'random text that is not JSON',
      entryLine({ id: 'e-3', iteration: 3 })
    ];
    await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

    const tail = await readAuditTailColdStart(workspaceRoot);

    expect(tail.length).toBe(3);
    expect(tail.map((t) => t.id)).toEqual(['e-1', 'e-2', 'e-3']);
  });

  it('INV-15: returned array is frozen (read-only)', async () => {
    await mkdir(auditDir, { recursive: true });
    await writeFile(auditLog, entryLine({ id: 'e-only' }) + '\n', 'utf8');

    const tail = await readAuditTailColdStart(workspaceRoot);

    expect(Object.isFrozen(tail)).toBe(true);
    // Each projected entry is itself frozen (already covered by projector
    // tests; reaffirm here so a regression at the boundary is caught).
    expect(Object.isFrozen(tail[0])).toBe(true);
  });

  it('INV-16: does not modify the file on disk (bytes & mtime unchanged)', async () => {
    await mkdir(auditDir, { recursive: true });
    const lines = [
      entryLine({ id: 'e-1' }),
      entryLine({ id: 'e-2' })
    ];
    const bytes = lines.join('\n') + '\n';
    await writeFile(auditLog, bytes, 'utf8');
    const before = await stat(auditLog);
    const beforeBytes = await readFile(auditLog, 'utf8');

    await readAuditTailColdStart(workspaceRoot);

    const after = await stat(auditLog);
    const afterBytes = await readFile(auditLog, 'utf8');
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(afterBytes).toBe(beforeBytes);
  });

  it('T027: returns [] for empty workspaceRoot string without I/O', async () => {
    const tail = await readAuditTailColdStart('');
    expect(tail).toEqual([]);
  });

  it('T027: returns [] for whitespace-only workspaceRoot string without I/O', async () => {
    const tail = await readAuditTailColdStart('   ');
    expect(tail).toEqual([]);
  });

  it('preserves unknown eventType entries (CLAUDE.md hard rule)', async () => {
    await mkdir(auditDir, { recursive: true });
    const lines = [
      entryLine({ id: 'e-1', eventType: 'phase-start' }),
      // Unknown event type — must be preserved (not dropped) per the parser
      // contract; categorize() will fall through to 'system'.
      JSON.stringify({
        ...entry({ id: 'e-2' }),
        eventType: 'totally-new-event-type'
      })
    ];
    await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

    const tail = await readAuditTailColdStart(workspaceRoot);

    expect(tail.length).toBe(2);
    expect(tail[1]!.category).toBe('system');
  });

  it('logs a single warning when malformed lines appear (logger optional)', async () => {
    await mkdir(auditDir, { recursive: true });
    await writeFile(auditLog, '{bad\n{also bad\n', 'utf8');

    const warnMessages: string[] = [];
    const logger = {
      warn(message: string): void {
        warnMessages.push(message);
      }
    } as unknown as import('../../../../src/lib/logger').SanitizedLogger;

    const tail = await readAuditTailColdStart(workspaceRoot, logger);
    expect(tail).toEqual([]);
    // Exactly one warn — the implementation de-duplicates per call.
    expect(warnMessages.length).toBe(1);
    // No workspaceRoot path leakage in the warning (CLAUDE.md hard rule).
    expect(warnMessages[0]).not.toContain(workspaceRoot);
  });
});
