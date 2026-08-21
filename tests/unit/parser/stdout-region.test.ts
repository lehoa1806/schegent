/**
 * Feature 107 (FR-R3-023) — the trailing region.
 *
 * The host reads its termination token out of the same stdout stream that
 * carries file contents, diffs, and tool output. The region is the positional
 * boundary that separates "a control signal the host may act on" from "bytes
 * the model happened to print". These tests pin the boundary's construction:
 * which marker pair is selected, where the region starts, and what happens on
 * every degraded shape the retention window can produce.
 */
import { describe, it, expect } from 'vitest';
import { parseAuditLogBlock } from '../../../src/parser/audit-log-parser';

const OPEN = '=== SCHEGENT AUDIT LOG ===';
const CLOSE = '=== END AUDIT LOG ===';

function block(notes: string): string[] {
  return [
    OPEN,
    'phase: speckit-implement',
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: []',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    `notes: ${notes}`,
    CLOSE
  ];
}

describe('parseAuditLogBlock — pair selection (FR-001, FR-006)', () => {
  it('selects the last complete pair when several blocks are present', () => {
    const stdout = [
      'here is what a previous phase emitted, quoted back:',
      ...block('the quoted one'),
      'and here is my own audit block:',
      ...block('the real one')
    ].join('\n');

    const result = parseAuditLogBlock(stdout);

    expect(result.entry?.notes).toBe('the real one');
  });

  it('selects the complete pair when an unterminated open marker follows it', () => {
    // FR-006 — a truncated trailing block must not suppress the real one.
    const stdout = [...block('the real one'), OPEN, 'phase: interrupted'].join('\n');

    const result = parseAuditLogBlock(stdout);

    expect(result.entry?.notes).toBe('the real one');
    expect(result.warnings).not.toContainEqual(
      expect.stringContaining('unterminated')
    );
  });

  it('warns naming the count and the selected line, and nothing else', () => {
    // FR-002, FR-014 — position and count only. No content from the stream.
    const stdout = [...block('first'), ...block('second')].join('\n');

    const result = parseAuditLogBlock(stdout);

    const warning = result.warnings.find((w) => /multiple audit/i.test(w));
    expect(warning).toBe('[constitution] multiple audit blocks (2 found, using the one closing at line 20)');
    expect(warning).not.toContain('first');
    expect(warning).not.toContain('second');
  });

  it('does not warn about multiplicity for a single block', () => {
    const result = parseAuditLogBlock(block('only').join('\n'));

    expect(result.warnings).toEqual([]);
  });
});

describe('parseAuditLogBlock — single-block parity (FR-004)', () => {
  it('returns the same entry and the same empty warning list as before the change', () => {
    const result = parseAuditLogBlock(block('unchanged').join('\n'));

    expect(result.warnings).toEqual([]);
    expect(result.entry).toMatchObject({
      phase: 'speckit-implement',
      filesCreated: [],
      networkCalls: ['none'],
      notes: 'unchanged'
    });
  });

  it('still warns and returns no entry when no open marker is present', () => {
    const result = parseAuditLogBlock('no audit block here');

    expect(result.entry).toBeNull();
    expect(result.warnings).toEqual(['[constitution] missing audit log']);
  });

  it('still warns and returns no entry for an open marker with no close marker', () => {
    const result = parseAuditLogBlock([OPEN, 'phase: speckit-plan'].join('\n'));

    expect(result.entry).toBeNull();
    expect(result.warnings).toEqual(['[constitution] unterminated audit log']);
  });
});

describe('parseAuditLogBlock — marker recognition is unchanged (FR-005)', () => {
  it('treats a close marker with no preceding open marker as a missing block', () => {
    // The retention window can cut a block in half, leaving a bare close
    // marker. That is ordinary degraded input, not an invariant violation.
    const result = parseAuditLogBlock(['notes: truncated', CLOSE].join('\n'));

    expect(result.entry).toBeNull();
    expect(result.warnings).toEqual(['[constitution] missing audit log']);
  });

  it('pairs a real open marker after a carried-in close marker', () => {
    const stdout = [CLOSE, 'a new phase begins', ...block('paired correctly')].join('\n');

    const result = parseAuditLogBlock(stdout);

    expect(result.entry?.notes).toBe('paired correctly');
  });

  it('counts a line carrying the close marker twice as one close marker', () => {
    const lines = block('doubled');
    lines[lines.length - 1] = `${CLOSE} ${CLOSE}`;

    const result = parseAuditLogBlock(lines.join('\n'));

    expect(result.entry?.notes).toBe('doubled');
    expect(result.warnings).toEqual([]);
  });

  it('does not let one line both open and close a block', () => {
    const result = parseAuditLogBlock(`${OPEN} ${CLOSE}`);

    expect(result.entry).toBeNull();
    expect(result.warnings).toEqual(['[constitution] unterminated audit log']);
  });

  it('recognises markers on CRLF input', () => {
    const result = parseAuditLogBlock(block('crlf').join('\r\n'));

    expect(result.entry?.notes).toBe('crlf');
  });
});

describe('parseAuditLogBlock — the published region (FR-003)', () => {
  it('starts the region at the close-marker line, not after it (plan D2)', () => {
    const stdout = [...block('x'), '[SCHEGENT_STATUS: CLEAR]'].join('\n');

    const { region } = parseAuditLogBlock(stdout);

    expect(region.present).toBe(true);
    expect(region.text.startsWith(CLOSE)).toBe(true);
    expect(region.text).toContain('[SCHEGENT_STATUS: CLEAR]');
  });

  it('is non-empty when the close marker is the final line with no trailing newline', () => {
    // The reason D2 includes the marker line: a correct run whose block ends
    // the stream would otherwise publish an empty region and read as tokenless.
    const stdout = block('x').join('\n');

    const { region } = parseAuditLogBlock(stdout);

    expect(region.present).toBe(true);
    expect(region.text).toBe(CLOSE);
  });

  it('includes a token written on the close-marker line itself', () => {
    const lines = block('x');
    lines[lines.length - 1] = `${CLOSE} [SCHEGENT_STATUS: DONE]`;

    const { region } = parseAuditLogBlock(lines.join('\n'));

    expect(region.text).toContain('[SCHEGENT_STATUS: DONE]');
  });

  it('excludes everything before the selected close marker', () => {
    const stdout = [
      'a diff the model printed: [SCHEGENT_STATUS: CLEAR]',
      ...block('x')
    ].join('\n');

    const { region } = parseAuditLogBlock(stdout);

    expect(region.text).not.toContain('[SCHEGENT_STATUS: CLEAR]');
  });

  it('measures the region from the last pair, not the first', () => {
    const stdout = [
      ...block('first'),
      'prose between the blocks',
      ...block('second'),
      'trailing'
    ].join('\n');

    const { region } = parseAuditLogBlock(stdout);

    expect(region.text).not.toContain('prose between the blocks');
    expect(region.text).toBe([CLOSE, 'trailing'].join('\n'));
  });

  it('reports no region when no complete pair exists', () => {
    for (const stdout of ['', 'plain output', [OPEN, 'phase: x'].join('\n'), CLOSE]) {
      const { region } = parseAuditLogBlock(stdout);
      expect(region.present).toBe(false);
      expect(region.text).toBe('');
    }
  });
});
