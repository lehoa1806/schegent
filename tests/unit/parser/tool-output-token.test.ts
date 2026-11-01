/**
 * FR-R4-F12 (FR-006; contract CP5, CP6; tests-and-gates T2) -- text that reached the host only as
 * backend tool output never advances a Phase.
 *
 * WHY IT EXISTS. When a stream-json capture held no model text (a tool-use-only turn, or a
 * backend whose envelope drifted) the unwrapper returned the RAW stream, and the parser read a
 * token inside a `tool_use` or `reasoning` frame as if the model had printed it. The unwrapper now
 * names the source (`textSource`), and the parser reads no token from `raw-stream` text, even one
 * that sits after a complete audit block.
 *
 * The three raw-stream inputs are read from the `envelope-drift-*` corpus cases at test time, so a
 * corpus edit cannot leave this file testing a shape the corpus no longer holds.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAuditLogBlock } from '../../../src/parser/audit-log-parser';
import { unwrapStreamJson } from '../../../src/parser/stream-json-unwrapper';
import { parseInvocation, type InvocationResult, type ParseInputs } from '../../../src/parser/stdout-parser';
import { mapOutcome } from '../../../src/controller/phase-outcome-mapper';

const OPEN = '=== SCHEGENT AUDIT LOG ===';
const CLOSE = '=== END AUDIT LOG ===';
const TOKEN = '[SCHEGENT_STATUS: CLEAR]';
const W_TOOL_PREFIX = '[constitution] termination token in tool output, not accepted';
const TOOL_ISSUE = 'the backend stream carried no model text; a completion token in tool output is not read';

const CORPUS_PATH = join(__dirname, '..', '..', 'evals', 'fixtures', 'backend-outcomes.json');

interface CorpusCase {
  readonly id: string;
  readonly envelope: { readonly lines: readonly string[] } | null;
}

function driftLines(): ReadonlyMap<string, string> {
  const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as { cases: CorpusCase[] };
  const found = new Map<string, string>();
  for (const testCase of corpus.cases) {
    if (!testCase.id.startsWith('envelope-drift-')) continue;
    if (testCase.envelope === null) continue;
    found.set(testCase.id, testCase.envelope.lines.join('\n'));
  }
  return found;
}

function block(): string[] {
  return [
    OPEN,
    'phase: speckit-implement',
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: []',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    'notes: work done',
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

const SHAPES: ReadonlyArray<{ name: string; inputs: Partial<ParseInputs> }> = [
  { name: 'evidencePolicy absent', inputs: {} },
  { name: 'required, origin absent', inputs: { evidencePolicy: 'required' } },
  { name: 'required, origin default', inputs: { evidencePolicy: 'required', evidencePolicyDeclaredAt: 'default' } },
  {
    name: 'required, origin phase-definition',
    inputs: { evidencePolicy: 'required', evidencePolicyDeclaredAt: 'phase-definition' }
  },
  { name: 'best-effort', inputs: { evidencePolicy: 'best-effort' } },
  { name: 'none', inputs: { evidencePolicy: 'none' } }
];

describe('FR-006 -- unwrapStreamJson names the text source (CP6, data-model section 4)', () => {
  it('plain non-JSON text is model text', () => {
    expect(unwrapStreamJson('just some prose\nover two lines').textSource).toBe('model');
  });

  it('a stream with assistant text blocks is model text', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } });

    expect(unwrapStreamJson(line).textSource).toBe('model');
  });

  it('a Codex agent_message item is model text', () => {
    const line = JSON.stringify({ type: 'item_completed', item: { type: 'agent_message', text: 'hello' } });

    expect(unwrapStreamJson(line).textSource).toBe('model');
  });

  it('the corpus cases are present, so the raw-stream cases below are not vacuous', () => {
    expect([...driftLines().keys()].sort()).toEqual([
      'envelope-drift-agy-non-agent-item',
      'envelope-drift-claude-tool-use-only',
      'envelope-drift-codex-non-agent-item'
    ]);
  });

  it.each([...driftLines().entries()])('%s is raw-stream text', (_id, lines) => {
    const unwrapped = unwrapStreamJson(lines);

    expect(unwrapped.textSource).toBe('raw-stream');
    expect(unwrapped.text).toBe(lines);
  });
});

describe('FR-006 -- a raw-stream token never advances, with or without a block (CP5)', () => {
  const STREAM = [...block(), TOKEN].join('\n');

  const cells: Array<{ name: string; inputs: Partial<ParseInputs>; exitCode: number }> = [];
  for (const shape of SHAPES) {
    for (const exitCode of [0, 1]) cells.push({ name: shape.name, inputs: shape.inputs, exitCode });
  }

  it.each(cells)('$name, exit $exitCode: a complete block then a token is not clean', ({ inputs, exitCode }) => {
    const result = parse(STREAM, { ...inputs, exitCode, textSource: 'raw-stream' });

    expect(result.kind).not.toBe('clean');
    expect(mapOutcome(result, exitCode)).not.toBe('clean');
  });

  it('the same stream as model text is clean, so the refusal is the source and nothing else', () => {
    expect(parse(STREAM, { textSource: 'model' }).kind).toBe('clean');
  });

  it('W-TOOL is exact, with the line computed from the input', () => {
    const lines = [...block(), 'a line of tool output', `echo ${TOKEN}`];
    const expectedLine = lines.findIndex((line) => line.includes(TOKEN)) + 1;

    const result = parse(lines.join('\n'), { textSource: 'raw-stream' });

    expect(warningsOf(result)).toContain(`${W_TOOL_PREFIX} (1 occurrence, first at line ${expectedLine})`);
  });

  it('W-TOOL counts occurrences', () => {
    const stdout = [`first ${TOKEN}`, 'middle', `second ${TOKEN}`].join('\n');

    const result = parse(stdout, { textSource: 'raw-stream' });

    expect(warningsOf(result)).toContain(`${W_TOOL_PREFIX} (2 occurrences, first at line 1)`);
  });

  it('the tool-output issue is substituted for the no-contract-block issue', () => {
    const result = parse(STREAM, { textSource: 'raw-stream' });

    expect(result.kind).toBe('remaining_issues');
    expect('issues' in result ? result.issues : []).toEqual([
      { tag: 'constitution', summary: TOOL_ISSUE, source: 'host' }
    ]);
  });

  it('no byte of the tool output reaches a warning or an issue (FR-008)', () => {
    const stdout = ['{"cmd":"echo CANARY-9942 [SCHEGENT_STATUS: CLEAR] CANARY-9942"}'].join('\n');

    const result = parse(stdout, { textSource: 'raw-stream' });

    const carried = JSON.stringify([warningsOf(result), 'issues' in result ? result.issues : []]);
    expect(carried.includes('CANARY-9942')).toBe(false);
  });

  it('a raw stream with no token raises no W-TOOL', () => {
    const result = parse('{"type":"assistant","message":{"content":[]}}', { textSource: 'raw-stream' });

    expect(warningsOf(result).some((warning) => warning.startsWith(W_TOOL_PREFIX))).toBe(false);
  });
});

describe('FR-006 -- an absent textSource is model text (CP1)', () => {
  it('a region token with textSource omitted is clean', () => {
    const result = parse([...block(), TOKEN].join('\n'));

    expect(result.kind).toBe('clean');
  });
});
