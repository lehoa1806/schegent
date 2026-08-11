// Feature 088 (T012) — the eight operators, and the two rules that cover
// everything they do not.
//
// A condition is structured data compared field-wise; there is no expression
// language, so there is nothing to sandbox. The scan at the bottom is what keeps
// it that way: it fails the build if a string condition form, a parser, or an
// `eval`-shaped call appears on the evaluation side, mirroring the scan
// `tests/unit/config/workflow-graph-validator.test.ts` already runs on the
// definition side (plan D3).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildConditionContext } from '../../../src/services/workflow-execution/condition-context';
import {
  compareValues,
  evaluateCondition
} from '../../../src/services/workflow-execution/condition-evaluator';
import {
  WORKFLOW_CONDITION_OPERATORS,
  type WorkflowCondition,
  type WorkflowConditionLiteral,
  type WorkflowConditionOperator
} from '../../../src/contracts/workflow-definitions';

const SOURCE_PATH = join(
  __dirname,
  '../../../src/services/workflow-execution/condition-evaluator.ts'
);

/** One completed node with a numeric-looking and a plain output, plus a failed one. */
const CONTEXT = buildConditionContext([
  {
    nodeId: 'n-a',
    status: 'completed',
    outputs: [
      { name: 'report', status: 'resolved', reference: 'docs/report.md' },
      { name: 'missing', status: 'unresolved' }
    ]
  },
  { nodeId: 'n-b', status: 'failed', outputs: [] }
]);

function condition(
  operator: WorkflowConditionOperator,
  right?: WorkflowConditionLiteral | readonly WorkflowConditionLiteral[],
  field = 'report'
): WorkflowCondition {
  return { left: { source: 'node-output', nodeId: 'n-a', field }, operator, right };
}

function matched(c: WorkflowCondition): boolean {
  return evaluateCondition(c, CONTEXT).matched;
}

describe('the eight operators', () => {
  it('covers every operator the definition side can author', () => {
    // A ninth operator must land here before it can ship.
    expect(WORKFLOW_CONDITION_OPERATORS).toHaveLength(8);
    for (const operator of WORKFLOW_CONDITION_OPERATORS) {
      expect(() => evaluateCondition(condition(operator, 'docs/report.md'), CONTEXT)).not.toThrow();
    }
  });

  it('equals answers true only on a same-type equal value', () => {
    expect(matched(condition('equals', 'docs/report.md'))).toBe(true);
    expect(matched(condition('equals', 'docs/other.md'))).toBe(false);
  });

  it('notEquals answers true on a resolved, same-type, different value', () => {
    expect(matched(condition('notEquals', 'docs/other.md'))).toBe(true);
    expect(matched(condition('notEquals', 'docs/report.md'))).toBe(false);
  });

  it('in answers true when the array holds a same-type equal value', () => {
    expect(matched(condition('in', ['a', 'docs/report.md']))).toBe(true);
    expect(matched(condition('in', ['a', 'b']))).toBe(false);
    expect(matched(condition('in', 'docs/report.md'))).toBe(false);
  });

  it('exists answers true for any resolved value, whatever it is', () => {
    expect(matched(condition('exists'))).toBe(true);
    expect(
      evaluateCondition(
        { left: { source: 'node-status', nodeId: 'n-b' }, operator: 'exists' },
        CONTEXT
      ).matched
    ).toBe(true);
  });

  it('answers the four ordering operators when both sides are numbers', () => {
    // Tested through the comparator directly: in v1 every resolvable operand is
    // text (a location reference or a terminal status), so no context can
    // produce a numeric left. The comparator is still total over literals, and
    // this is the path a numeric-valued output would take the day one exists.
    const cases: ReadonlyArray<readonly [WorkflowConditionOperator, number, number, boolean]> = [
      ['greaterThan', 5, 1, true],
      ['greaterThan', 5, 5, false],
      ['greaterThanOrEqual', 5, 5, true],
      ['greaterThanOrEqual', 4, 5, false],
      ['lessThan', 1, 5, true],
      ['lessThan', 5, 5, false],
      ['lessThanOrEqual', 5, 5, true],
      ['lessThanOrEqual', 6, 5, false]
    ];
    for (const [operator, left, right, expected] of cases) {
      expect(compareValues(left, operator, right), `${String(left)} ${operator} ${String(right)}`).toBe(
        expected
      );
    }
  });

  it('treats an ordering operator against a location reference as a mismatch, not a parse', () => {
    const numeric = buildConditionContext([
      { nodeId: 'n', status: 'completed', outputs: [{ name: 'out', status: 'resolved', reference: '7' }] }
    ]);
    for (const operator of [
      'greaterThan',
      'greaterThanOrEqual',
      'lessThan',
      'lessThanOrEqual'
    ] as const) {
      expect(
        evaluateCondition(
          { left: { source: 'node-output', nodeId: 'n', field: 'out' }, operator, right: 3 },
          numeric
        ).matched
      ).toBe(false);
    }
  });
});

describe('an unresolved operand answers false for every operator (FR-024)', () => {
  for (const operator of WORKFLOW_CONDITION_OPERATORS) {
    it(`${operator} against an output the run did not produce`, () => {
      expect(matched(condition(operator, 'anything', 'missing'))).toBe(false);
    });
  }

  it('including notEquals, which reads as true for a missing value but is not', () => {
    expect(matched(condition('notEquals', 'docs/report.md', 'missing'))).toBe(false);
    expect(matched(condition('notEquals', 'anything-else', 'missing'))).toBe(false);
  });

  it('including exists, and including an unknown node', () => {
    expect(matched(condition('exists', undefined, 'missing'))).toBe(false);
    expect(
      evaluateCondition(
        { left: { source: 'node-output', nodeId: 'n-unknown', field: 'report' }, operator: 'exists' },
        CONTEXT
      ).matched
    ).toBe(false);
  });

  it('leaves the other connections of the node evaluable — nothing raises', () => {
    expect(() => matched(condition('greaterThan', 3, 'missing'))).not.toThrow();
    expect(() => matched(condition('in', undefined, 'missing'))).not.toThrow();
  });
});

describe('a type mismatch answers false, without coercion (FR-025)', () => {
  it('does not read "3" as 3', () => {
    const numeric = buildConditionContext([
      { nodeId: 'n', status: 'completed', outputs: [{ name: 'out', status: 'resolved', reference: '3' }] }
    ]);
    const left = { source: 'node-output', nodeId: 'n', field: 'out' } as const;
    expect(evaluateCondition({ left, operator: 'equals', right: 3 }, numeric).matched).toBe(false);
    expect(evaluateCondition({ left, operator: 'equals', right: '3' }, numeric).matched).toBe(true);
    expect(evaluateCondition({ left, operator: 'in', right: [3] }, numeric).matched).toBe(false);
    expect(evaluateCondition({ left, operator: 'notEquals', right: 3 }, numeric).matched).toBe(false);
  });

  it('does not read a status as a boolean or a number', () => {
    const left = { source: 'node-status', nodeId: 'n-b' } as const;
    expect(evaluateCondition({ left, operator: 'equals', right: 'failed' }, CONTEXT).matched).toBe(
      true
    );
    expect(evaluateCondition({ left, operator: 'equals', right: true }, CONTEXT).matched).toBe(
      false
    );
    expect(
      evaluateCondition({ left, operator: 'greaterThan', right: 0 }, CONTEXT).matched
    ).toBe(false);
  });

  it('treats a missing or wrongly-shaped right as no match rather than an error', () => {
    expect(matched(condition('equals', undefined))).toBe(false);
    expect(matched(condition('in', 'docs/report.md'))).toBe(false);
    expect(matched(condition('greaterThan', 'docs/report.md'))).toBe(false);
  });
});

describe('what the evaluation records', () => {
  it('records one resolution per referenced operand, with the compared form', () => {
    expect(evaluateCondition(condition('equals', 'docs/report.md'), CONTEXT).operands).toEqual([
      {
        source: 'node-output',
        nodeId: 'n-a',
        field: 'report',
        resolved: true,
        compared: 'docs/report.md'
      }
    ]);
  });

  it('omits field on a node-status operand and compared on an unresolved one', () => {
    expect(
      evaluateCondition(
        { left: { source: 'node-status', nodeId: 'n-b' }, operator: 'exists' },
        CONTEXT
      ).operands
    ).toEqual([{ source: 'node-status', nodeId: 'n-b', resolved: true, compared: 'failed' }]);
    expect(evaluateCondition(condition('exists', undefined, 'missing'), CONTEXT).operands).toEqual([
      { source: 'node-output', nodeId: 'n-a', field: 'missing', resolved: false }
    ]);
  });

  it('elides a compared value longer than the cap rather than truncating it', () => {
    const long = `docs/${'a'.repeat(80)}.md`;
    const built = buildConditionContext([
      { nodeId: 'n', status: 'completed', outputs: [{ name: 'out', status: 'resolved', reference: long }] }
    ]);
    const [resolution] = evaluateCondition(
      { left: { source: 'node-output', nodeId: 'n', field: 'out' }, operator: 'exists' },
      built
    ).operands;
    expect(resolution).toEqual({
      source: 'node-output',
      nodeId: 'n',
      field: 'out',
      resolved: true
    });
  });
});

describe('forbidden constructs (plan D3)', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8');

  it('has no expression parser, evaluator, or string condition form', () => {
    for (const forbidden of [
      /\beval\(/,
      /new Function\(/,
      // Call-shaped on purpose: a scan that fires on the English word in a
      // comment is a scan the next contributor deletes instead of obeying.
      /\bparse(Condition|Expression)\s*\(/i,
      /\bcompile\w*\s*\(/i,
      /\btokeni[sz]e\w*\s*\(/i,
      /\bexpression\s*[:=]/i,
      /condition\.split\(/,
      /vm\./,
      /require\(/
    ]) {
      expect(source, `condition-evaluator.ts must not match ${String(forbidden)}`).not.toMatch(
        forbidden
      );
    }
  });

  it('refuses a condition whose operator is not in the closed set', () => {
    const rogue = { ...condition('equals', 'docs/report.md'), operator: 'matchesRegex' };
    expect(evaluateCondition(rogue as unknown as WorkflowCondition, CONTEXT).matched).toBe(false);
  });

  it('never treats a string as something to execute', () => {
    const injected = buildConditionContext([
      {
        nodeId: 'n',
        status: 'completed',
        outputs: [
          { name: 'out', status: 'resolved', reference: '${process.exit(1)}' }
        ]
      }
    ]);
    expect(
      evaluateCondition(
        {
          left: { source: 'node-output', nodeId: 'n', field: 'out' },
          operator: 'equals',
          right: '${process.exit(1)}'
        },
        injected
      ).matched
    ).toBe(true);
  });
});
