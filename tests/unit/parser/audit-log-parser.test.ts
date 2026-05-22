import { describe, it, expect } from 'vitest';
import { parseAuditLogBlock } from '../../../src/parser/audit-log-parser';

const validBlock = [
  '=== SCHEGENT AUDIT LOG ===',
  'phase: speckit-specify',
  'files_created: ["specs/001-mock/spec.md"]',
  'files_modified: []',
  'files_deleted: []',
  'commands_executed: ["echo hi"]',
  'network_calls: ["none"]',
  'ruleset_switches: ["none"]',
  'notes: created spec scaffold',
  '=== END AUDIT LOG ==='
].join('\n');

describe('parseAuditLogBlock', () => {
  it('parses a valid audit block', () => {
    const result = parseAuditLogBlock(validBlock);
    expect(result.warnings).toEqual([]);
    expect(result.entry).not.toBeNull();
    expect(result.entry).toMatchObject({
      phase: 'speckit-specify',
      filesCreated: ['specs/001-mock/spec.md'],
      filesModified: [],
      filesDeleted: [],
      commandsExecuted: ['echo hi'],
      networkCalls: ['none'],
      rulesetSwitches: ['none'],
      notes: 'created spec scaffold'
    });
  });

  it('warns and returns null when audit log is missing', () => {
    const result = parseAuditLogBlock('no audit block here');
    expect(result.entry).toBeNull();
    expect(result.warnings.some((w) => /missing audit log/i.test(w))).toBe(true);
  });

  it('warns when the close marker is missing', () => {
    const stdout = ['=== SCHEGENT AUDIT LOG ===', 'phase: speckit-plan'].join('\n');
    const result = parseAuditLogBlock(stdout);
    expect(result.entry).toBeNull();
    expect(result.warnings.some((w) => /unterminated/i.test(w))).toBe(true);
  });

  it('warns when required fields are missing', () => {
    const stdout = [
      '=== SCHEGENT AUDIT LOG ===',
      'phase: speckit-specify',
      'files_created: []',
      '=== END AUDIT LOG ==='
    ].join('\n');
    const result = parseAuditLogBlock(stdout);
    expect(result.entry).toBeNull();
    expect(result.warnings.some((w) => /missing fields/i.test(w))).toBe(true);
  });

  it('parses multi-element list values with quoted entries', () => {
    const stdout = [
      '=== SCHEGENT AUDIT LOG ===',
      'phase: speckit-implement',
      'files_created: ["src/a.ts", "src/b.ts"]',
      'files_modified: ["src/c.ts"]',
      'files_deleted: []',
      'commands_executed: ["npm install", "npm run build"]',
      'network_calls: ["none"]',
      'ruleset_switches: ["none"]',
      'notes: completed implementation',
      '=== END AUDIT LOG ==='
    ].join('\n');
    const result = parseAuditLogBlock(stdout);
    expect(result.entry?.filesCreated).toEqual(['src/a.ts', 'src/b.ts']);
    expect(result.entry?.commandsExecuted).toEqual(['npm install', 'npm run build']);
  });

  it('truncates notes to 240 characters', () => {
    const longNote = 'x'.repeat(500);
    const stdout = [
      '=== SCHEGENT AUDIT LOG ===',
      'phase: speckit-specify',
      'files_created: []',
      'files_modified: []',
      'files_deleted: []',
      'commands_executed: []',
      'network_calls: []',
      'ruleset_switches: []',
      `notes: ${longNote}`,
      '=== END AUDIT LOG ==='
    ].join('\n');
    const result = parseAuditLogBlock(stdout);
    expect(result.entry?.notes.length).toBeLessThanOrEqual(240);
  });

  it('warns on malformed list field', () => {
    const stdout = [
      '=== SCHEGENT AUDIT LOG ===',
      'phase: speckit-specify',
      'files_created: not a list',
      'files_modified: []',
      'files_deleted: []',
      'commands_executed: []',
      'network_calls: []',
      'ruleset_switches: []',
      'notes: ok',
      '=== END AUDIT LOG ==='
    ].join('\n');
    const result = parseAuditLogBlock(stdout);
    expect(result.warnings.some((w) => /not a list/i.test(w))).toBe(true);
  });
});

describe('parseAuditLogBlock — metrics extraction (010, T021, US2)', () => {
  function blockWith(extraLines: string[]): string {
    return [
      '=== SCHEGENT AUDIT LOG ===',
      'phase: speckit-clarify',
      'files_created: []',
      'files_modified: []',
      'files_deleted: []',
      'commands_executed: []',
      'network_calls: []',
      'ruleset_switches: []',
      'notes: ok',
      ...extraLines,
      '=== END AUDIT LOG ==='
    ].join('\n');
  }

  it('captures top-level integer and float metric lines (FR-007)', () => {
    const stdout = blockWith(['open_questions: 3', 'confidence: 0.85']);
    const result = parseAuditLogBlock(stdout);
    expect(result.entry?.metrics).toEqual({ open_questions: 3, confidence: 0.85 });
  });

  it('accepts negative numeric values', () => {
    const stdout = blockWith(['delta: -2']);
    const result = parseAuditLogBlock(stdout);
    expect(result.entry?.metrics).toEqual({ delta: -2 });
  });

  it('drops reserved keys and emits one warning per invocation', () => {
    const stdout = blockWith(['status: 42', 'effort: 7', 'open_questions: 1']);
    const result = parseAuditLogBlock(stdout);
    expect(result.entry?.metrics).toEqual({ open_questions: 1 });
    expect(result.entry?.warnings ?? []).toContain(
      '[constitution] dropped reserved metric key(s): status, effort'
    );
  });

  it('drops non-finite values (NaN, Infinity, -Infinity) with a warning', () => {
    const stdout = blockWith(['nan_metric: NaN', 'inf_metric: Infinity', 'real: 4']);
    const result = parseAuditLogBlock(stdout);
    expect(result.entry?.metrics).toEqual({ real: 4 });
    expect(result.entry?.warnings.some((w) => /non-finite/i.test(w))).toBe(true);
  });

  it('drops non-numeric values with a warning', () => {
    const stdout = blockWith(['real: 5', 'word: many']);
    const result = parseAuditLogBlock(stdout);
    expect(result.entry?.metrics).toEqual({ real: 5 });
    expect(result.entry?.warnings.some((w) => /non-numeric/i.test(w))).toBe(true);
  });

  it('tolerates whitespace variants in `key:value`, `key : value`, tab-separated', () => {
    const stdout = blockWith([
      'a:1',
      'b : 2',
      'c\t:\t3'
    ]);
    const result = parseAuditLogBlock(stdout);
    expect(result.entry?.metrics).toMatchObject({ a: 1, b: 2, c: 3 });
  });

  it('last-occurrence-wins when a key repeats', () => {
    const stdout = blockWith(['a: 1', 'a: 2']);
    const result = parseAuditLogBlock(stdout);
    expect(result.entry?.metrics).toEqual({ a: 2 });
  });

  it('excludes identifiers that fail the [a-zA-Z_][a-zA-Z0-9_]* pattern', () => {
    const stdout = blockWith(['9bad: 1', 'good_one: 2', 'has-dash: 3', 'real: 4']);
    const result = parseAuditLogBlock(stdout);
    // good_one and real are valid; 9bad and has-dash are not (and treated as
    // unknown audit fields per existing parser behavior — warnings track them
    // but they are not included in metrics).
    expect(result.entry?.metrics).toMatchObject({ good_one: 2, real: 4 });
    expect(result.entry?.metrics).not.toHaveProperty('9bad');
    expect(result.entry?.metrics).not.toHaveProperty('has-dash');
  });

  it('does NOT capture lines under named sub-blocks (Open Questions / Remaining Issues)', () => {
    const stdout = blockWith([
      'open_questions: 2',
      'Open Questions:',
      '- not_a_metric: 99',
      'Remaining Issues:',
      '- also_not: 7'
    ]);
    const result = parseAuditLogBlock(stdout);
    expect(result.entry?.metrics).toMatchObject({ open_questions: 2 });
    expect(result.entry?.metrics).not.toHaveProperty('not_a_metric');
    expect(result.entry?.metrics).not.toHaveProperty('also_not');
  });

  it('returns empty metrics when no metric lines are present', () => {
    const result = parseAuditLogBlock(validBlock);
    expect(result.entry?.metrics).toEqual({});
  });

  it('yields integer open_questions/resolved_questions metrics from a clarify-shaped block (010, T032, SC-007)', () => {
    const stdout = blockWith(['open_questions: 1', 'resolved_questions: 4']);
    const result = parseAuditLogBlock(stdout);
    expect(result.entry?.metrics).toMatchObject({
      open_questions: 1,
      resolved_questions: 4
    });
    expect(Number.isInteger(result.entry?.metrics.open_questions)).toBe(true);
    expect(Number.isInteger(result.entry?.metrics.resolved_questions)).toBe(true);
  });
});

// BUG-001 (Bugfix 2026-05-22) — sub-block continuation rule. The parser
// must re-detect top-level field shape and reset `inSubBlock` so metric
// lines emitted immediately after a sub-block heading (without a blank
// line separator) reach the metrics map. See spec FR-007 + SC-010 + T075.
describe('parseAuditLogBlock — sub-block continuation (010, T075, BUG-001)', () => {
  function blockWith(extraLines: string[]): string {
    return [
      '=== SCHEGENT AUDIT LOG ===',
      'phase: speckit-clarify',
      'files_created: []',
      'files_modified: []',
      'files_deleted: []',
      'commands_executed: []',
      'network_calls: []',
      'ruleset_switches: []',
      ...extraLines,
      '=== END AUDIT LOG ==='
    ].join('\n');
  }

  it('captures top-level metric lines after a `Notes:` sub-block heading with no blank line (SC-010 reproduction)', () => {
    const stdout = blockWith([
      'notes:',
      '- Added Clarifications/Session 2026-05-22 with 5 Q&A',
      'open_questions: 0',
      'resolved_questions: 5'
    ]);
    const result = parseAuditLogBlock(stdout);
    expect(result.entry?.metrics).toMatchObject({
      open_questions: 0,
      resolved_questions: 5
    });
  });

  it('captures top-level metric lines after a `Findings:` sub-block heading with no blank line', () => {
    const stdout = blockWith([
      'notes: ok',
      'Findings:',
      '- some narrative finding',
      'open_questions: 3',
      'resolved_questions: 2'
    ]);
    const result = parseAuditLogBlock(stdout);
    expect(result.entry?.metrics).toMatchObject({
      open_questions: 3,
      resolved_questions: 2
    });
  });

  it('captures top-level metric lines after an `Open Questions:` sub-block heading with no blank line', () => {
    const stdout = blockWith([
      'notes: ok',
      'Open Questions:',
      '- a leftover question',
      'metric_a: 1'
    ]);
    const result = parseAuditLogBlock(stdout);
    expect(result.entry?.metrics).toMatchObject({ metric_a: 1 });
  });

  it('captures top-level metric lines after a `Remaining Issues:` sub-block heading with no blank line', () => {
    const stdout = blockWith([
      'notes: ok',
      'Remaining Issues:',
      '- one leftover issue',
      'metric_b: 9'
    ]);
    const result = parseAuditLogBlock(stdout);
    expect(result.entry?.metrics).toMatchObject({ metric_b: 9 });
  });

  it('does NOT capture list bullets shaped like `- foo` inside the sub-block', () => {
    const stdout = blockWith([
      'notes: ok',
      'Findings:',
      '- foo',
      '- bar',
      'metric_c: 2'
    ]);
    const result = parseAuditLogBlock(stdout);
    expect(result.entry?.metrics).toMatchObject({ metric_c: 2 });
    expect(result.entry?.metrics).not.toHaveProperty('foo');
    expect(result.entry?.metrics).not.toHaveProperty('bar');
  });

  it('matches all four SUBBLOCK_HEADING labels case-insensitively', () => {
    const stdout = blockWith([
      'notes: ok',
      'NOTES:',
      '- noise',
      'after_notes: 1',
      'findings:',
      '- noise',
      'after_findings: 2',
      'OPEN QUESTIONS:',
      '- noise',
      'after_open_questions: 3',
      'remaining issues:',
      '- noise',
      'after_remaining_issues: 4'
    ]);
    const result = parseAuditLogBlock(stdout);
    expect(result.entry?.metrics).toMatchObject({
      after_notes: 1,
      after_findings: 2,
      after_open_questions: 3,
      after_remaining_issues: 4
    });
  });
});
