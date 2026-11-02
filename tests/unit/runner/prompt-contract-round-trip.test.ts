/**
 * FR-R4-F12 (contract TC3; FR-014; US3 scenarios 2 and 3; tests-and-gates T7) -- the prompt tells the
 * model how to finish, and the parser reads what a model that did exactly that prints.
 *
 * WHY IT EXISTS. The completion contract lives in four places that must agree: the constitution, the
 * threat model, the prompt and the parser. The documents are gated textually (L1, W1). This test is
 * the behavioural half for the prompt: it composes a real prompt, builds the output a model would
 * print by following that prompt literally, and parses it. It imports only `PromptBuilder`, the
 * exported markers and the parser, and no private constant, so a prompt edit that stops asking for
 * the block or the token fails here, and so does a parser edit that stops reading what the prompt asks.
 *
 * "Following the prompt" includes the fence. The prompt asks for "a fenced audit log block" and the
 * constitution (Audit Log Format) requires one, so a model that does what both say prints the block
 * inside a code fence, and the output the cases below build has that shape as well as the bare one.
 *
 * A PROOF, green on arrival, for the bare shape: the spelling and region cases passed before this
 * feature, and the no-block and tool-output cases pass because of the placement rule. Its controls
 * are mutations M1 (restore the pre-feature no-region branch) and M4 (ignore `textSource`),
 * recorded in `specs/259-phase-completion-evidence/measurements.md` section 7. The fenced-block
 * cases are not a proof of that kind: they were written red, against a parser that read the block's
 * own closing fence as the start of one around the token and warned about every conforming report,
 * and the parser changed to make them pass. Their controls are in the `describe` that holds them.
 */
import { describe, it, expect } from 'vitest';
import {
  AUDIT_LOG_CLOSE_MARKER,
  AUDIT_LOG_OPEN_MARKER,
  TERMINATION_TOKEN
} from '../../../src/contracts/phase-output-contract';
import { parseAuditLogBlock } from '../../../src/parser/audit-log-parser';
import { parseInvocation, type InvocationResult, type ParseInputs } from '../../../src/parser/stdout-parser';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import type { PhaseDef } from '../../../src/config/pipeline-config';

const PROMPT = new PromptBuilder().build({
  phase: 'speckit-specify',
  phaseDef: { id: 'speckit-specify', name: 'Specify', version: 1, instruction: 'Write the specification.' } as PhaseDef,
  iteration: 1,
  iterationCap: 10,
  featureDescription: 'a feature',
  featureDir: 'specs/001-a'
});

/**
 * The audit block a model writes by following the prompt's template: the lines between the two
 * markers as the prompt prints them, with each placeholder filled the way the prompt describes.
 */
function auditBlockFromPrompt(notes = 'work done'): string {
  const start = PROMPT.indexOf(AUDIT_LOG_OPEN_MARKER);
  const end = PROMPT.indexOf(AUDIT_LOG_CLOSE_MARKER, start);
  expect(start, 'the prompt must show the audit block template').toBeGreaterThanOrEqual(0);
  expect(end, 'the prompt must close the audit block template').toBeGreaterThan(start);
  const template = PROMPT.slice(start, end + AUDIT_LOG_CLOSE_MARKER.length);
  return template
    .replace('<phase-name>', 'speckit-specify')
    .replace('files_created: [<path>, ...]', 'files_created: []')
    .replace('files_modified: [<path>, ...]', 'files_modified: []')
    .replace('files_deleted: [<path>, ...]', 'files_deleted: []')
    .replace('commands_executed: [<one-line summary>, ...]', 'commands_executed: []')
    .replace('network_calls: [<endpoint or "none">]', 'network_calls: ["none"]')
    .replace('ruleset_switches: [<path or "none">]', 'ruleset_switches: ["none"]')
    .replace('<freeform; <= 240 chars>', notes);
}

/** The token as the prompt names it: the one bracketed status string in the prompt text. */
function tokenFromPrompt(): string {
  const match = /\[SCHEGENT_STATUS:[^\]]*\]/.exec(PROMPT);
  expect(match, 'the prompt must name a completion token').not.toBeNull();
  return (match as RegExpExecArray)[0];
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

describe('FR-014 -- the composed prompt asks for the canonical token and the block', () => {
  it('names the canonical token and no other spelling', () => {
    expect(tokenFromPrompt()).toBe(TERMINATION_TOKEN);
    expect(PROMPT).toContain(TERMINATION_TOKEN);
    expect(PROMPT).not.toMatch(/\bDONE\b/);
    expect(PROMPT).not.toMatch(/\bRESOLVED\b/);
  });

  it('asks for the token after the block, as the last non-empty line', () => {
    expect(PROMPT).toMatch(/AFTER the audit log block/);
    expect(PROMPT).toMatch(/last non-empty line/);
    expect(PROMPT.indexOf(AUDIT_LOG_OPEN_MARKER)).toBeGreaterThan(0);
  });

  it('prints a block template the parser reads as a complete entry', () => {
    const result = parse(`${auditBlockFromPrompt()}\n${tokenFromPrompt()}`);

    expect(result.kind).toBe('clean');
    expect('auditEntry' in result && result.auditEntry !== null).toBe(true);
    expect(warningsOf(result)).toEqual([]);
  });
});

describe('FR-014 -- output that follows the prompt advances, in every accepted spelling', () => {
  const canonical = tokenFromPrompt();
  const SPELLINGS: ReadonlyArray<[string, string]> = [
    ['CLEAR', canonical],
    ['DONE', canonical.replace('CLEAR', 'DONE')],
    ['RESOLVED', canonical.replace('CLEAR', 'RESOLVED')],
    ['lowercase', canonical.toLowerCase()],
    ['no space after the colon', canonical.replace(': ', ':')]
  ];

  it.each(SPELLINGS)('%s', (_name, token) => {
    const result = parse(`${auditBlockFromPrompt()}\n${token}`);

    expect(result.kind).toBe('clean');
  });

  it('a fenced token in the region warns and still advances', () => {
    const result = parse(`${auditBlockFromPrompt()}\n\`\`\`\n${canonical}\n\`\`\``);

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toContainEqual(expect.stringContaining('termination token inside a code fence'));
  });
});

// The constitution (Audit Log Format) requires the audit log "fenced as a code block" and the
// prompt asks for "a fenced audit log block", so the output that follows both has the block's own
// closing fence between the close marker and the token. The region starts at the close-marker line,
// which puts that fence in it: before the parser read the fence as the block's, every such report
// drew "termination token inside a code fence" about a token that stood on its own line.
describe('FR-014 -- a block fenced the way the constitution and the prompt ask', () => {
  const token = tokenFromPrompt();
  const FENCE = '```';
  const FENCE_NOTICE = 'termination token inside a code fence';

  function fencedBlock(openingFence = FENCE): string {
    return `${openingFence}\n${auditBlockFromPrompt()}\n${FENCE}`;
  }

  it('advances with no warning when the token follows the closing fence after a blank line', () => {
    const result = parse(`${fencedBlock()}\n\n${token}`);

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toEqual([]);
  });

  it('advances with no warning when the token follows the closing fence directly', () => {
    const result = parse(`${fencedBlock()}\n${token}`);

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toEqual([]);
  });

  it('advances with no warning when the opening fence names a language', () => {
    const result = parse(`${fencedBlock('```text')}\n\n${token}`);

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toEqual([]);
  });

  it('advances with no warning with Windows line endings', () => {
    const result = parse(`${fencedBlock()}\n\n${token}`.replace(/\n/g, '\r\n'));

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toEqual([]);
  });

  it('reads the entry out of the fenced block as it does out of a bare one', () => {
    const bare = parse(`${auditBlockFromPrompt()}\n${token}`);
    const fenced = parse(`${fencedBlock()}\n\n${token}`);

    expect(fenced).toEqual(bare);
  });

  // Controls: the allowance is for the block's own closing fence and nothing else.
  it('still warns about a token the model fenced itself after a fenced block', () => {
    const result = parse(`${fencedBlock()}\n${FENCE}\n${token}\n${FENCE}`);

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toContainEqual(expect.stringContaining(FENCE_NOTICE));
  });

  it('still warns about a fenced token after a block that was not fenced', () => {
    const result = parse(`${auditBlockFromPrompt()}\n${FENCE}\n${token}\n${FENCE}`);

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toContainEqual(expect.stringContaining(FENCE_NOTICE));
  });

  it('does not let a fence higher up in the output excuse a fence after an unfenced block', () => {
    // Only the line directly above the block counts: fence state is not carried in from the head.
    const head = `${FENCE}\nquoted output\n${FENCE}\nthe block follows`;
    const result = parse(`${head}\n${auditBlockFromPrompt()}\n${FENCE}\n${token}\n${FENCE}`);

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toContainEqual(expect.stringContaining(FENCE_NOTICE));
  });
});

describe('FR-014 -- a token the prompt forbids does not advance', () => {
  const token = tokenFromPrompt();

  it('a token before the block', () => {
    const result = parse(`${token}\n${auditBlockFromPrompt()}`);

    expect(result.kind).not.toBe('clean');
    expect(warningsOf(result)).toContainEqual(expect.stringContaining('termination token outside audit region'));
  });

  it('a token inside the block body', () => {
    const result = parse(auditBlockFromPrompt(`done ${token}`));

    expect(result.kind).not.toBe('clean');
  });

  it('a token after an earlier block only', () => {
    const result = parse(`${auditBlockFromPrompt('first')}\n${token}\n${auditBlockFromPrompt('second')}`);

    expect(result.kind).not.toBe('clean');
  });

  it('a token with no block, under a policy nobody relaxed', () => {
    for (const overrides of [
      {},
      { evidencePolicy: 'required' as const },
      { evidencePolicy: 'required' as const, evidencePolicyDeclaredAt: 'default' as const },
      { evidencePolicy: 'required' as const, evidencePolicyDeclaredAt: 'phase-definition' as const }
    ]) {
      const result = parse(`Everything is finished.\n${token}`, overrides);

      expect(result.kind).not.toBe('clean');
    }
  });

  it('a token split across two lines', () => {
    const [head, tail] = [token.slice(0, token.indexOf(':') + 1), token.slice(token.indexOf(':') + 1)];

    const result = parse(`${auditBlockFromPrompt()}\n${head}\n${tail}`);

    expect(result.kind).not.toBe('clean');
  });

  it('a token that reached the host only as tool output', () => {
    const result = parse(`${auditBlockFromPrompt()}\n${token}`, { textSource: 'raw-stream' });

    expect(result.kind).not.toBe('clean');
    expect(warningsOf(result)).toContainEqual(expect.stringContaining('termination token in tool output'));
  });

  it('the same output as model text advances, so the refusal above is the source and nothing else', () => {
    expect(parse(`${auditBlockFromPrompt()}\n${token}`, { textSource: 'model' }).kind).toBe('clean');
  });
});
