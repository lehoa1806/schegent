import { describe, expect, it } from 'vitest';
import type { PhaseLogDisplayEntry } from '../../../../../src/services/phase-log/types';
import { phaseLogEntriesToText } from '../phase-log-text-export';

function entry(
  kind: PhaseLogDisplayEntry['kind'],
  body: PhaseLogDisplayEntry['body'],
  ts: string | null = null
): PhaseLogDisplayEntry {
  return { seq: 0, kind, ts, body, bodyTruncated: null };
}

describe('phaseLogEntriesToText', () => {
  it('preserves host-sanitized display text and timestamps', () => {
    const text = phaseLogEntriesToText([
      entry('assistant-text', { text: 'already [REDACTED]' }, '12:00:00'),
      entry('tool-result', { toolResult: 'done', isError: true })
    ]);

    expect(text).toBe('[12:00:00] already [REDACTED]\n[ERROR] done');
  });

  it('formats structured and multiline tool arguments without re-stringifying the entry', () => {
    const text = phaseLogEntriesToText([
      entry('tool-use', {
        toolName: 'Write',
        toolArguments: {
          file_path: '/tmp/example',
          content: 'first\nsecond',
          options: { overwrite: true }
        }
      })
    ]);

    expect(text).toContain('▶ Write');
    expect(text).toContain('  file_path: /tmp/example');
    expect(text).toContain('  content:\n    first\n    second');
    expect(text).toContain('  options:\n    overwrite: true');
  });

  // FR-R6-F07 review S7 — the export names a gap reason only from the closed list,
  // as the rendered row does; any other string becomes `unknown`, never copied text.
  it('copies a known coverage-gap reason and never one outside the closed list', () => {
    const forged = { reason: 'copied log text' } as unknown as PhaseLogDisplayEntry['body'];
    const text = phaseLogEntriesToText([
      entry('coverage-gap', { reason: 'range-skipped' }),
      entry('coverage-gap', forged)
    ]);

    expect(text).toBe('Coverage gap (range-skipped)\nCoverage gap (unknown)');
  });
});
