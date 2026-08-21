/**
 * Feature 107 (T621, T622) — the region's edges, and its cost.
 *
 * The adversary cases live in `stdout-injection.test.ts`. These are the shapes
 * that are not attacks at all: a stream cut off by retention, a marker the
 * model echoed, a fence nobody closed, a file with no trailing newline. Each
 * one is a place where "the last complete audit block" has to mean something
 * specific, and where getting it wrong fails a legitimate run rather than
 * admitting a forged one — the more likely defect, and the less visible.
 *
 * FR-013 also bounds the *cost* of the boundary: fence tracking runs inside the
 * region only, and the out-of-region scan is the same per-line test the parser
 * already ran over the whole stream, so total work must not exceed today's.
 * That is unobservable from behaviour, so it is measured (T622, SC-004).
 */
import { describe, it, expect } from 'vitest';
import { parseAuditLogBlock } from '../../../src/parser/audit-log-parser';
import { parseInvocation, type InvocationResult, type ParseInputs } from '../../../src/parser/stdout-parser';

const OPEN = '=== SCHEGENT AUDIT LOG ===';
const CLOSE = '=== END AUDIT LOG ===';
const TOKEN = '[SCHEGENT_STATUS: CLEAR]';
const FENCE = '```';

function block(notes = 'work done'): string[] {
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

function parse(stdout: string, overrides: Partial<ParseInputs> = {}): InvocationResult {
  const audit = parseAuditLogBlock(stdout);
  return parseInvocation({
    stdout,
    stderr: '',
    exitCode: 0,
    rateLimit: { matched: false, cause: '' },
    auditEntry: audit.entry,
    auditWarnings: audit.warnings,
    region: audit.region,
    ...overrides
  });
}

function warningsOf(result: InvocationResult): string[] {
  return 'warnings' in result && result.warnings ? result.warnings : [];
}

describe('region edges (T621)', () => {
  it('accepts a stream with no trailing newline', () => {
    // The common case, not an edge case: a process that exits without a final
    // newline. `split` yields the token as the last element with no empty tail.
    const stdout = [...block(), TOKEN].join('\n');
    expect(stdout.endsWith('\n')).toBe(false);
    expect(parse(stdout).kind).toBe('clean');
  });

  it('accepts a token on the close-marker line itself', () => {
    // The region starts *at* the close marker rather than after it, so a model
    // that puts both on one line is inside the region, not before it. Pinning
    // this because "after the close marker" is the intuitive reading and it
    // would silently reject a well-behaved run.
    const lines = block();
    lines[lines.length - 1] = `${CLOSE} ${TOKEN}`;
    expect(parse(lines.join('\n')).kind).toBe('clean');
  });

  it('ignores a close marker echoed before any open marker', () => {
    // A model quoting the tail of a previous phase. There is no open marker to
    // pair it with, so it is not a block boundary and the real block that
    // follows is the last complete pair.
    const stdout = [`the last phase ended with ${CLOSE}`, ...block(), TOKEN].join('\n');
    const result = parse(stdout);
    expect(result.kind).toBe('clean');
    // No multiplicity warning: one complete pair was found, not two.
    expect(warningsOf(result)).toEqual([]);
  });

  it('treats a retention-truncated half block as no block at all', () => {
    // An open marker with its close cut off — the shape a log rotation or a
    // killed process leaves. There is no region, so detection degrades to the
    // whole-stream scan and says so.
    const stdout = [OPEN, 'phase: speckit-implement', 'notes: cut off here'].join('\n');
    const audit = parseAuditLogBlock(stdout);
    expect(audit.region).toEqual({ text: '', present: false });
    expect(audit.warnings).toContainEqual('[constitution] unterminated audit log');
  });

  it('does not let a truncated block shadow a complete earlier one', () => {
    // The retry case: one phase completed, a second was cut off mid-block. The
    // completed pair is still the last *complete* pair, so its region is used.
    const stdout = [...block('first attempt'), TOKEN, OPEN, 'notes: cut off'].join('\n');
    const audit = parseAuditLogBlock(stdout);
    expect(audit.region.present).toBe(true);
    expect(audit.region.text).toContain(TOKEN);
    expect(parse(stdout).kind).toBe('clean');
  });

  it('warns but still resolves when the region has an unclosed fence', () => {
    // A warning is an operator-facing signal, not a gate (T25 residual risk).
    // An unclosed fence makes everything after it look fenced, so the token is
    // reported as fenced — and still acted on, because refusing here would fail
    // a run over markdown the model did not close.
    const result = parse([...block(), FENCE, 'some output', TOKEN].join('\n'));
    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toContainEqual(
      expect.stringContaining('termination token inside a code fence')
    );
  });

  it('does not carry fence depth from the head into the region', () => {
    // The head may contain any number of unbalanced fences — it is a diff of
    // markdown files as often as not. Fence depth starts at zero at the region
    // boundary, so an odd count in the head cannot make a clean region look
    // fenced.
    const result = parse([FENCE, 'an unclosed fence in the head', ...block(), TOKEN].join('\n'));
    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toEqual([]);
  });

  it('does not resolve a region that contains only its close marker', () => {
    // The block closed and the run stopped. There is a region, it is one line
    // long, and it holds no verdict — so the phase did not report one.
    const audit = parseAuditLogBlock(block().join('\n'));
    expect(audit.region.present).toBe(true);
    expect(audit.region.text).toBe(CLOSE);
    expect(parse(block().join('\n')).kind).not.toBe('clean');
  });

  it('does not pair a doubled close marker on one line with itself', () => {
    // Two close markers on one line are one line: the pair-collector advances
    // per line, so the line closes the open block once and cannot also open
    // and close a second.
    const lines = block();
    lines[lines.length - 1] = `${CLOSE} ${CLOSE}`;
    const audit = parseAuditLogBlock([...lines, TOKEN].join('\n'));
    expect(audit.warnings.filter((w) => w.includes('multiple audit blocks'))).toEqual([]);
    expect(audit.region.text).toContain(TOKEN);
  });

  it('handles an empty stream without inventing a region', () => {
    const audit = parseAuditLogBlock('');
    expect(audit.region).toEqual({ text: '', present: false });
    expect(parse('').kind).not.toBe('clean');
  });
});

describe('region scanning cost is bounded (T622, SC-004, FR-013)', () => {
  /**
   * 1 MiB of head, 64 fence delimiters, and a token in every region — the
   * fixture FR-013's bound is stated against.
   *
   * The head is where the saving has to show up: it gets one non-backtracking
   * per-line regex test (what the parser already did over the whole stream) and
   * no fence tracking at all. If fence state were tracked over the head, this
   * fixture's 64 delimiters would put the token's apparent fence depth at the
   * mercy of a megabyte of unrelated output.
   */
  function buildFixture(): string {
    const lines: string[] = [];
    // ~1 MiB of head: 64 chunks, each ending in a fence delimiter, each
    // containing a token the parser must refuse to act on.
    const filler = 'x'.repeat(200);
    for (let chunk = 0; chunk < 64; chunk++) {
      for (let i = 0; i < 82; i++) {
        lines.push(`${filler} ${i}`);
      }
      lines.push(`echoed from a file: ${TOKEN}`);
      lines.push(FENCE);
    }
    lines.push(...block());
    lines.push(TOKEN);
    return lines.join('\n');
  }

  const fixture = buildFixture();

  it('the fixture is at least 1 MiB with 64 fence delimiters', () => {
    // A perf assertion against a fixture that quietly shrank measures nothing.
    expect(Buffer.byteLength(fixture, 'utf8')).toBeGreaterThan(1024 * 1024);
    expect(fixture.split('\n').filter((l) => l.trim().startsWith(FENCE))).toHaveLength(64);
  });

  it('parses 1 MiB in under 50 ms', () => {
    parse(fixture); // warm-up: first-call JIT is not the property under test.

    // Best of three. A single sample on a saturated machine measures the
    // scheduler, not the parser; three samples keep the bound meaningful while
    // surviving one descheduling hiccup.
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      parse(fixture);
      best = Math.min(best, performance.now() - started);
    }
    expect(best).toBeLessThan(50);
  });

  it('still reaches the right verdict on the large fixture', () => {
    // The bound is worthless if the fast path is fast because it stopped
    // working: 64 out-of-region tokens must be reported, and the in-region one
    // acted on.
    const result = parse(fixture);
    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toContainEqual(
      expect.stringContaining('termination token outside audit region (64 occurrences')
    );
  });
});
