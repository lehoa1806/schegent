/**
 * FR-R4-F12 (FR-R4-004 / S-05; contract CI5; FR-023; tests-and-gates T8) -- a seeded, bounded
 * generator of hostile completion output, checked against an independent oracle.
 *
 * WHY IT EXISTS. The hand-written cases in `no-region-token.test.ts` pin the shapes someone
 * thought of. The completion decision reads attacker-influenced text, so this file feeds the same
 * parser 400 generated documents (CRLF and LF mixes, one long line, token runs, unterminated and
 * stray audit markers, markers inside JSON-looking lines, fences, lookalike brackets, zero-width
 * characters inside the token, a token split across lines) and asserts the parser says `clean`
 * exactly when a reference function says a token may count.
 *
 * THE ORACLE (`mayAdvance` below) is written without importing the parser's helpers:
 *
 *   region present && a token on a region line, outside a fence
 *   OR relaxed policy && no region && a token on the last non-empty line
 *
 * Under an authored `required` policy a region token with no parseable entry is withheld, so that
 * shape also asks the (separately tested) audit parser whether an entry exists.
 *
 * The seed is fixed and printed in every failure message. No wall-clock assertion: the bounded-time
 * check is `tests/perf/completion-detection-bounded-work.test.ts`.
 *
 * Every non-ASCII character is built with `String.fromCharCode` so no raw lookalike or zero-width
 * character sits in this file.
 */
import { describe, it, expect } from 'vitest';
import { mulberry32, pick } from '../../fixtures/seeded-rng';
import { parseAuditLogBlock } from '../../../src/parser/audit-log-parser';
import { parseInvocation, type ParseInputs } from '../../../src/parser/stdout-parser';

const SEED = 259_004;
const CASE_COUNT = 400;
const MAX_CASE_BYTES = 256 * 1024;

const OPEN = '=== SCHEGENT AUDIT LOG ===';
const CLOSE = '=== END AUDIT LOG ===';
const ZERO_WIDTH = String.fromCharCode(0x200b);
const FULLWIDTH_OPEN = String.fromCharCode(0xff3b);
const FULLWIDTH_CLOSE = String.fromCharCode(0xff3d);
const MATH_OPEN = String.fromCharCode(0x27e6);
const MATH_CLOSE = String.fromCharCode(0x27e7);

const TOKEN_SPELLINGS = [
  '[SCHEGENT_STATUS: CLEAR]',
  '[SCHEGENT_STATUS:CLEAR]',
  '[schegent_status: done]',
  '[SCHEGENT_STATUS:   RESOLVED]',
  '**[SCHEGENT_STATUS: CLEAR]**',
  'Result: [SCHEGENT_STATUS: CLEAR] (final)'
] as const;

const PROSE = [
  'I read the file and the tests.',
  'The change touches two modules.',
  'Next I will run the checks.',
  '- a bullet that is not under a heading',
  'Everything below is a quotation of earlier output:',
  '> quoted line from a log',
  ''
] as const;

interface PolicyShape {
  readonly name: string;
  readonly inputs: Pick<ParseInputs, 'evidencePolicy' | 'evidencePolicyDeclaredAt'>;
  readonly relaxed: boolean;
  readonly authoredRequired: boolean;
}

/** TA14: the six policy shapes. */
const SHAPES: readonly PolicyShape[] = [
  { name: 'evidencePolicy absent', inputs: {}, relaxed: false, authoredRequired: false },
  { name: 'required, origin absent', inputs: { evidencePolicy: 'required' }, relaxed: false, authoredRequired: false },
  {
    name: 'required, origin default',
    inputs: { evidencePolicy: 'required', evidencePolicyDeclaredAt: 'default' },
    relaxed: false,
    authoredRequired: false
  },
  {
    name: 'required, origin phase-definition',
    inputs: { evidencePolicy: 'required', evidencePolicyDeclaredAt: 'phase-definition' },
    relaxed: false,
    authoredRequired: true
  },
  { name: 'best-effort', inputs: { evidencePolicy: 'best-effort' }, relaxed: true, authoredRequired: false },
  { name: 'none', inputs: { evidencePolicy: 'none' }, relaxed: true, authoredRequired: false }
];

function validBlock(): string[] {
  return [
    OPEN,
    'phase: speckit-implement',
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: []',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    'notes: generated',
    CLOSE
  ];
}

type Gen = (rng: () => number) => string[];

const GENERATORS: readonly Gen[] = [
  (rng) => [pick(rng, PROSE)],
  (rng) => [pick(rng, TOKEN_SPELLINGS)],
  (rng) => [pick(rng, TOKEN_SPELLINGS)],
  () => validBlock(),
  () => [OPEN, 'phase: speckit-implement', CLOSE],
  () => [OPEN],
  () => [CLOSE],
  (rng) => [`{"type":"tool_result","content":"${pick(rng, [OPEN, CLOSE])}"}`],
  () => ['```'],
  () => [`${FULLWIDTH_OPEN}SCHEGENT_STATUS: CLEAR${FULLWIDTH_CLOSE}`, `${MATH_OPEN}SCHEGENT_STATUS: CLEAR${MATH_CLOSE}`],
  () => [`[SCHEGENT${ZERO_WIDTH}_STATUS: CLEAR]`],
  () => [`[SCHEGENT_STATUS:${ZERO_WIDTH}CLEAR]`],
  () => ['[SCHEGENT_STATUS:', 'CLEAR]'],
  () => ['[SCHEGENT_STATUS: CLEAR', ']'],
  (rng) => Array.from({ length: 2 + Math.floor(rng() * 6) }, () => pick(rng, TOKEN_SPELLINGS)),
  () => ['   ', '\t', ''],
  () => ['[SCHEGENT_STATUS:']
];

/** One generated document, as a list of lines and a line separator style. */
function generateDocument(index: number): { text: string; description: string } {
  const rng = mulberry32(SEED + index);
  const lines: string[] = [];
  const itemCount = 1 + Math.floor(rng() * 14);
  for (let i = 0; i < itemCount; i++) lines.push(...pick(rng, GENERATORS)(rng));

  // About one case in twenty carries a single very long line, at most the case size bound.
  if (index % 20 === 7) {
    const filler = 'x'.repeat(MAX_CASE_BYTES - 4096);
    lines.splice(Math.floor(rng() * (lines.length + 1)), 0, filler);
  }

  const separatorKind = Math.floor(rng() * 3);
  const text = lines
    .map((line, position) => {
      if (position === lines.length - 1) return line;
      if (separatorKind === 0) return `${line}\n`;
      if (separatorKind === 1) return `${line}\r\n`;
      return rng() < 0.5 ? `${line}\r\n` : `${line}\n`;
    })
    .join('');

  return { text, description: `case ${index} (seed ${SEED + index}, ${lines.length} lines)` };
}

// --- The oracle: independent of the parser's own helpers. -------------------------------------

const ORACLE_TOKEN = /\[SCHEGENT_STATUS:\s*(CLEAR|DONE|RESOLVED)\]/i;

function oracleLines(text: string): string[] {
  return text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function oracleRegionStart(lines: readonly string[]): number | null {
  let openAt: number | null = null;
  let lastClose: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines.at(i) ?? '';
    if (openAt === null) {
      if (line.includes(OPEN)) openAt = i;
      continue;
    }
    if (line.includes(CLOSE)) {
      lastClose = i;
      openAt = null;
    }
  }
  return lastClose;
}

function mayAdvance(text: string, relaxed: boolean): boolean {
  const lines = oracleLines(text);
  const regionStart = oracleRegionStart(lines);
  if (regionStart !== null) {
    let inFence = false;
    for (const line of lines.slice(regionStart)) {
      if (line.trim().startsWith('```')) {
        inFence = !inFence;
        continue;
      }
      if (ORACLE_TOKEN.test(line)) return true;
    }
    return false;
  }
  if (!relaxed) return false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines.at(i) ?? '';
    if (line.trim() === '') continue;
    return ORACLE_TOKEN.test(line);
  }
  return false;
}

function parseKind(text: string, shape: PolicyShape): { kind: string; entryPresent: boolean } {
  const audit = parseAuditLogBlock(text);
  const result = parseInvocation({
    stdout: text,
    stderr: '',
    exitCode: 0,
    rateLimit: { matched: false, cause: '' },
    auditEntry: audit.entry,
    auditWarnings: audit.warnings,
    region: audit.region,
    ...shape.inputs
  });
  return { kind: result.kind, entryPresent: audit.entry !== null };
}

describe('FR-R4-004 / S-05 -- the generator is bounded and exercises the hostile shapes (CI5)', () => {
  const documents = Array.from({ length: CASE_COUNT }, (_, index) => generateDocument(index));

  it(`generates ${CASE_COUNT} cases, each at most 256 KiB (seed ${SEED})`, () => {
    expect(documents).toHaveLength(CASE_COUNT);
    for (const document of documents) {
      expect(Buffer.byteLength(document.text, 'utf8'), document.description).toBeLessThanOrEqual(MAX_CASE_BYTES);
    }
  });

  it('is non-vacuous: the oracle accepts and refuses a spread of cases under both policy kinds', () => {
    const counts = { strictYes: 0, strictNo: 0, relaxedYes: 0, relaxedNo: 0, crlf: 0, long: 0 };
    for (const document of documents) {
      if (mayAdvance(document.text, false)) counts.strictYes += 1;
      else counts.strictNo += 1;
      if (mayAdvance(document.text, true)) counts.relaxedYes += 1;
      else counts.relaxedNo += 1;
      if (document.text.includes('\r\n')) counts.crlf += 1;
      if (document.text.length > MAX_CASE_BYTES / 2) counts.long += 1;
    }

    expect(counts.strictYes, `seed ${SEED}: ${JSON.stringify(counts)}`).toBeGreaterThan(20);
    expect(counts.strictNo, `seed ${SEED}: ${JSON.stringify(counts)}`).toBeGreaterThan(20);
    expect(counts.relaxedYes, `seed ${SEED}: ${JSON.stringify(counts)}`).toBeGreaterThan(counts.strictYes);
    expect(counts.relaxedNo, `seed ${SEED}: ${JSON.stringify(counts)}`).toBeGreaterThan(20);
    expect(counts.crlf, `seed ${SEED}: ${JSON.stringify(counts)}`).toBeGreaterThan(50);
    expect(counts.long, `seed ${SEED}: ${JSON.stringify(counts)}`).toBeGreaterThan(5);
  });

  describe.each(SHAPES)('FR-R4-004 / S-05 -- policy shape: $name', (shape) => {
    it(`classifies clean exactly when the oracle says a token may count (seed ${SEED})`, () => {
      const mismatches: string[] = [];
      for (const document of documents) {
        const parsed = parseKind(document.text, shape);
        const oracle = mayAdvance(document.text, shape.relaxed);
        const expectClean = shape.authoredRequired ? oracle && parsed.entryPresent : oracle;
        const gotClean = parsed.kind === 'clean';
        if (gotClean !== expectClean) {
          mismatches.push(
            `${document.description}: parser ${parsed.kind}, oracle expects clean=${String(expectClean)}`
          );
        }
      }

      expect(mismatches, `seed ${SEED}, base index 0`).toEqual([]);
    });
  });
});
