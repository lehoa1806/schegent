import { describe, expect, it } from 'vitest';
import { createCountsOnlyAuditExport } from '../../../src/commands/export-audit';

function row(schemaVersion: number, payload: Record<string, unknown>): string {
  return JSON.stringify({
    id: `event-${schemaVersion}`,
    timestamp: '2026-08-02T00:00:00.000Z',
    runId: 'run-private',
    correlationId: 'correlation-private',
    phase: 'speckit-implement',
    iteration: 1,
    eventType: 'phase-end',
    outcome: 'success',
    schemaVersion,
    payload
  });
}

describe('createCountsOnlyAuditExport', () => {
  it('exports v3 rows only and strips ids, names, commands, and paths from payloads', () => {
    const output = createCountsOnlyAuditExport([
      row(2, { command: 'legacy command' }),
      row(3, {
        command: 'forbidden command',
        files: ['src/private.ts'],
        metrics: { tests: 12 },
        fileChangeCounts: { created: 1, modified: 2, deleted: 0 },
        omittedFileEvidenceCount: 3,
        outcome: 'clean',
        terminationReason: 'token'
      })
    ].join('\n'));

    expect(output).not.toContain('legacy command');
    expect(output).not.toContain('forbidden command');
    expect(output).not.toContain('private.ts');
    expect(output).not.toContain('run-private');
    expect(output).toContain('"tests":12');
    expect(output.trim().split('\n')).toHaveLength(1);
  });
});
