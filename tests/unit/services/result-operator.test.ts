// FR-R5-F24 (SPEC-02, D2, F24-T05) — Unit tests for DecisionField, ResultContract,
// TypedCondition, AttemptOutcome, bounded JSON parser, worker deadline enforcement,
// three-tier outcome precedence, and 3-valued TypedCondition routing.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_DECISION_FIELDS,
  MAX_DIAGNOSTIC_RECORD_BYTES,
  MAX_EVIDENCE_REF_BYTES,
  MAX_IN_VALUES,
  MAX_JSON_DEPTH,
  MAX_JSON_VALUE_NODES,
  MAX_RESULT_SOURCE_BYTES,
  MAX_RESULT_STRING_BYTES,
  MAX_SELECTOR_SEGMENTS,
  MAX_TYPED_LEAVES,
  RESULT_OPERATOR_DEADLINE_MS,
  freezeResultContract,
  freezeTypedCondition,
  validateAttemptOutcome,
  validateLeafAgainstField,
  validateResultContract,
  validateTypedCondition,
  type DecisionField,
  type ResultContract,
  type TypedCondition
} from '../../../src/contracts/decision-results';
import {
  evaluateAttemptOutcome,
  evaluateAttemptWithPrecedence,
  ResultOperator
} from '../../../src/services/result-operator';
import { workerEvaluateMain } from '../../../src/services/result-operator-worker';
import { buildConditionContext } from '../../../src/services/workflow-execution/condition-context';
import { evaluateTypedCondition } from '../../../src/services/workflow-execution/condition-evaluator';
import {
  buildRoutingDecisionObservation,
  selectNextTransition
} from '../../../src/services/workflow-execution/next-node-selector';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';

const BASE_CONTRACT: ResultContract = freezeResultContract({
  version: 1,
  operator: 'structured-result',
  operatorVersion: 1,
  fields: [
    {
      fieldId: 'verdict',
      type: 'string',
      required: true,
      selector: ['summary', 'verdict']
    },
    {
      fieldId: 'open_issues',
      type: 'number',
      required: true,
      selector: ['metrics', 'openIssues']
    },
    {
      fieldId: 'coverage',
      type: 'number',
      required: false,
      selector: ['metrics', 'coverage']
    },
    {
      fieldId: 'clean',
      type: 'boolean',
      required: false,
      selector: ['summary', 'clean']
    },
    {
      fieldId: 'note',
      type: 'string',
      required: false,
      selector: ['summary', 'note']
    }
  ],
  source: {
    kind: 'declared-output',
    outputKey: '.schegent/results/verify.json'
  },
  completion: {
    version: 1,
    kind: 'typed',
    test: {
      all: [
        {
          left: { source: 'result-field', fieldId: 'verdict' },
          operator: 'equals',
          right: 'pass'
        },
        {
          left: { source: 'result-field', fieldId: 'open_issues' },
          operator: 'equals',
          right: 0
        }
      ]
    }
  }
});

describe('decision-results contract bounds and validators (F24-T01)', () => {
  it('exports the pinned D2 bounds constants', () => {
    expect(MAX_RESULT_SOURCE_BYTES).toBe(262_144);
    expect(MAX_DIAGNOSTIC_RECORD_BYTES).toBe(65_536);
    expect(RESULT_OPERATOR_DEADLINE_MS).toBe(2_000);
    expect(MAX_JSON_DEPTH).toBe(16);
    expect(MAX_JSON_VALUE_NODES).toBe(8_192);
    expect(MAX_DECISION_FIELDS).toBe(32);
    expect(MAX_RESULT_STRING_BYTES).toBe(1_024);
    expect(MAX_SELECTOR_SEGMENTS).toBe(5);
    expect(MAX_TYPED_LEAVES).toBe(16);
    expect(MAX_IN_VALUES).toBe(32);
    expect(MAX_EVIDENCE_REF_BYTES).toBe(128);
  });

  it('validates and deep-freezes a valid ResultContract and TypedCondition', () => {
    const validated = validateResultContract(BASE_CONTRACT);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(Object.isFrozen(validated.value)).toBe(true);
    expect(Object.isFrozen(validated.value.fields)).toBe(true);
    expect(Object.isFrozen(validated.value.fields[0])).toBe(true);
    expect(Object.isFrozen(validated.value.completion)).toBe(true);
  });

  it('rejects duplicate DecisionField fieldIds, duplicate selectors, > 32 fields, forbidden selectors, and undeclared completion fields', () => {
    const dupFields = validateResultContract({
      version: 1,
      operator: 'structured-result',
      operatorVersion: 1,
      fields: [
        { fieldId: 'verdict', type: 'string', required: true, selector: ['a'] },
        { fieldId: 'verdict', type: 'string', required: true, selector: ['b'] }
      ],
      source: { kind: 'declared-output', outputKey: 'out/result.json' },
      completion: {
        version: 1,
        kind: 'typed',
        test: { left: { source: 'result-field', fieldId: 'verdict' }, operator: 'exists' }
      }
    });
    expect(dupFields.ok).toBe(false);
    if (!dupFields.ok) {
      expect(dupFields.errors.map((e) => e.code)).toContain('duplicate-field-id');
    }

    const dupSelectors = validateResultContract({
      version: 1,
      operator: 'structured-result',
      operatorVersion: 1,
      fields: [
        { fieldId: 'verdict_a', type: 'string', required: true, selector: ['summary', 'verdict'] },
        { fieldId: 'verdict_b', type: 'string', required: true, selector: ['summary', 'verdict'] }
      ],
      source: { kind: 'declared-output', outputKey: 'out/result.json' },
      completion: {
        version: 1,
        kind: 'typed',
        test: { left: { source: 'result-field', fieldId: 'verdict_a' }, operator: 'exists' }
      }
    });
    expect(dupSelectors.ok).toBe(false);
    if (!dupSelectors.ok) {
      expect(dupSelectors.errors.map((e) => e.code)).toContain('duplicate-selector');
    }

    const tooManyFields = validateResultContract({
      version: 1,
      operator: 'structured-result',
      operatorVersion: 1,
      fields: Array.from({ length: MAX_DECISION_FIELDS + 1 }, (_, i) => ({
        fieldId: `field_${i}`,
        type: 'boolean',
        required: false,
        selector: [`f${i}`]
      })),
      source: { kind: 'declared-output', outputKey: 'out/result.json' },
      completion: {
        version: 1,
        kind: 'typed',
        test: { left: { source: 'result-field', fieldId: 'field_0' }, operator: 'exists' }
      }
    });
    expect(tooManyFields.ok).toBe(false);
    if (!tooManyFields.ok) {
      expect(tooManyFields.errors.map((e) => e.code)).toContain('invalid-length');
    }

    const badSelector = validateResultContract({
      version: 1,
      operator: 'structured-result',
      operatorVersion: 1,
      fields: [
        {
          fieldId: 'verdict',
          type: 'string',
          required: true,
          selector: ['a', '__proto__', 'b']
        }
      ],
      source: { kind: 'declared-output', outputKey: 'out/result.json' },
      completion: {
        version: 1,
        kind: 'typed',
        test: { left: { source: 'result-field', fieldId: 'verdict' }, operator: 'exists' }
      }
    });
    expect(badSelector.ok).toBe(false);
    if (!badSelector.ok) {
      expect(badSelector.errors.map((e) => e.code)).toContain('forbidden-selector-segment');
    }

    const deepSelector = validateResultContract({
      version: 1,
      operator: 'structured-result',
      operatorVersion: 1,
      fields: [
        {
          fieldId: 'verdict',
          type: 'string',
          required: true,
          selector: ['a', 'b', 'c', 'd', 'e', 'f']
        }
      ],
      source: { kind: 'declared-output', outputKey: 'out/result.json' },
      completion: {
        version: 1,
        kind: 'typed',
        test: { left: { source: 'result-field', fieldId: 'verdict' }, operator: 'exists' }
      }
    });
    expect(deepSelector.ok).toBe(false);

    const undeclaredCompletion = validateResultContract({
      version: 1,
      operator: 'structured-result',
      operatorVersion: 1,
      fields: [{ fieldId: 'verdict', type: 'string', required: true, selector: ['verdict'] }],
      source: { kind: 'declared-output', outputKey: 'out/result.json' },
      completion: {
        version: 1,
        kind: 'typed',
        test: {
          left: { source: 'result-field', fieldId: 'missing_field' },
          operator: 'equals',
          right: 'ok'
        }
      }
    });
    expect(undeclaredCompletion.ok).toBe(false);
    if (!undeclaredCompletion.ok) {
      expect(undeclaredCompletion.errors.map((e) => e.code)).toContain('condition-field-undeclared');
    }
  });

  it('enforces MAX_TYPED_LEAVES (16), MAX_IN_VALUES (32), and operator-to-field type compatibility', () => {
    const seventeenLeaves: TypedCondition = {
      version: 1,
      kind: 'typed',
      test: {
        all: Array.from({ length: MAX_TYPED_LEAVES + 1 }, () => ({
          left: { source: 'node-result' as const, nodeId: 'step-a', fieldId: 'verdict' },
          operator: 'equals' as const,
          right: 'done'
        }))
      }
    };
    const overLeaves = validateTypedCondition(seventeenLeaves, 'condition', {
      scope: 'workflow-connection'
    });
    expect(overLeaves.ok).toBe(false);
    if (!overLeaves.ok) {
      expect(overLeaves.errors.map((e) => e.code)).toContain('too-many-leaves');
    }

    const overInValues = validateTypedCondition(
      {
        version: 1,
        kind: 'typed',
        test: {
          left: { source: 'node-result', nodeId: 'step-a', fieldId: 'verdict' },
          operator: 'in',
          right: Array.from({ length: MAX_IN_VALUES + 1 }, (_, i) => `v-${i}`)
        }
      },
      'condition',
      { scope: 'workflow-connection' }
    );
    expect(overInValues.ok).toBe(false);
    if (!overInValues.ok) {
      expect(overInValues.errors.map((e) => e.code)).toContain('condition-right-invalid');
    }

    const stringField: DecisionField = {
      fieldId: 'verdict',
      type: 'string',
      required: true,
      selector: ['verdict']
    };
    const orderingOnString = validateLeafAgainstField(
      {
        left: { source: 'node-result', nodeId: 'step-a', fieldId: 'verdict' },
        operator: 'greaterThan',
        right: 1
      },
      stringField,
      'condition.test'
    );
    expect(orderingOnString.map((e) => e.code)).toContain('condition-comparison-unsupported');

    const typeMismatchOnString = validateLeafAgainstField(
      {
        left: { source: 'node-result', nodeId: 'step-a', fieldId: 'verdict' },
        operator: 'equals',
        right: 42
      },
      stringField,
      'condition.test'
    );
    expect(typeMismatchOnString.map((e) => e.code)).toContain('condition-right-invalid');
  });

  it('enforces AttemptOutcome closed shape and value bounds', () => {
    const valid = validateAttemptOutcome({
      version: 1,
      attemptId: 'att-1',
      status: 'done',
      reason: 'completed',
      recovery: 'none',
      values: { verdict: 'pass', open_issues: 0 },
      provenance: {
        operator: 'structured-result',
        operatorVersion: 1,
        source: 'declared-output',
        evidenceRef: 'ev-declared-output-1234',
        evaluatedAt: 1_700_000_000_000
      }
    });
    expect(valid.ok).toBe(true);

    const invalidEvidence = validateAttemptOutcome({
      version: 1,
      attemptId: 'att-1',
      status: 'done',
      reason: 'completed',
      recovery: 'none',
      values: {},
      provenance: {
        operator: 'structured-result',
        operatorVersion: 1,
        source: 'declared-output',
        evidenceRef: '../escape.json',
        evaluatedAt: 1_700_000_000_000
      }
    });
    expect(invalidEvidence.ok).toBe(false);
  });
});

describe('workerEvaluateMain — bounded JSON parser, attribution, selectors, and field validation (F24-T02)', () => {
  it('extracts and validates fields when attemptId matches and completion predicate is true', () => {
    const output = workerEvaluateMain({
      contract: BASE_CONTRACT,
      currentAttemptId: 'att-42',
      rawText: JSON.stringify({
        attemptId: 'att-42',
        summary: { verdict: 'pass', clean: true, note: 'All green' },
        metrics: { openIssues: 0, coverage: 94.5 }
      })
    });
    expect(output.status).toBe('done');
    expect(output.reason).toBe('completed');
    expect(output.recovery).toBe('none');
    expect(output.values).toEqual({
      verdict: 'pass',
      open_issues: 0,
      coverage: 94.5,
      clean: true,
      note: 'All green'
    });
  });

  it('rejects duplicate JSON keys at root and nested levels', () => {
    const rootDup = workerEvaluateMain({
      contract: BASE_CONTRACT,
      currentAttemptId: 'att-1',
      rawText: '{"attemptId":"att-1","attemptId":"att-2","summary":{"verdict":"pass"},"metrics":{"openIssues":0}}'
    });
    expect(rootDup.status).toBe('invalid-result');
    expect(rootDup.reason).toBe('malformed-evidence');

    const nestedDup = workerEvaluateMain({
      contract: BASE_CONTRACT,
      currentAttemptId: 'att-1',
      rawText: '{"attemptId":"att-1","summary":{"verdict":"pass","verdict":"fail"},"metrics":{"openIssues":0}}'
    });
    expect(nestedDup.status).toBe('invalid-result');
    expect(nestedDup.reason).toBe('malformed-evidence');
  });

  it('rejects JSON exceeding MAX_JSON_DEPTH (16) or MAX_JSON_VALUE_NODES (8,192)', () => {
    let deepJson = '"leaf"';
    for (let i = 0; i < MAX_JSON_DEPTH + 2; i += 1) {
      deepJson = `{"a":${deepJson}}`;
    }
    const deepOut = workerEvaluateMain({
      contract: BASE_CONTRACT,
      currentAttemptId: 'att-1',
      rawText: deepJson
    });
    expect(deepOut.status).toBe('invalid-result');
    expect(deepOut.reason).toBe('malformed-evidence');

    const manyArrayItems = Array.from({ length: MAX_JSON_VALUE_NODES + 5 }, () => '1').join(',');
    const manyNodesOut = workerEvaluateMain({
      contract: BASE_CONTRACT,
      currentAttemptId: 'att-1',
      rawText: `{"attemptId":"att-1","items":[${manyArrayItems}]}`
    });
    expect(manyNodesOut.status).toBe('invalid-result');
    expect(manyNodesOut.reason).toBe('malformed-evidence');
  });

  it('enforces attemptId attribution (unattributed-evidence)', () => {
    const missingId = workerEvaluateMain({
      contract: BASE_CONTRACT,
      currentAttemptId: 'att-2',
      rawText: JSON.stringify({
        summary: { verdict: 'pass' },
        metrics: { openIssues: 0 }
      })
    });
    expect(missingId.status).toBe('invalid-result');
    expect(missingId.reason).toBe('unattributed-evidence');

    const staleId = workerEvaluateMain({
      contract: BASE_CONTRACT,
      currentAttemptId: 'att-2',
      rawText: JSON.stringify({
        attemptId: 'att-1',
        summary: { verdict: 'pass' },
        metrics: { openIssues: 0 }
      })
    });
    expect(staleId.status).toBe('invalid-result');
    expect(staleId.reason).toBe('unattributed-evidence');
    expect(staleId.values).toEqual({});
  });

  it('rejects missing required fields, type mismatches, and overlong strings (> 1,024 UTF-8 bytes)', () => {
    const missingRequired = workerEvaluateMain({
      contract: BASE_CONTRACT,
      currentAttemptId: 'att-1',
      rawText: JSON.stringify({
        attemptId: 'att-1',
        summary: { verdict: 'pass' },
        metrics: {}
      })
    });
    expect(missingRequired.status).toBe('invalid-result');
    expect(missingRequired.reason).toBe('missing-evidence');

    const typeMismatch = workerEvaluateMain({
      contract: BASE_CONTRACT,
      currentAttemptId: 'att-1',
      rawText: JSON.stringify({
        attemptId: 'att-1',
        summary: { verdict: 'pass' },
        metrics: { openIssues: '0' }
      })
    });
    expect(typeMismatch.status).toBe('invalid-result');
    expect(typeMismatch.reason).toBe('malformed-evidence');

    const tooLong = workerEvaluateMain({
      contract: BASE_CONTRACT,
      currentAttemptId: 'att-1',
      rawText: JSON.stringify({
        attemptId: 'att-1',
        summary: { verdict: 'pass', note: 'x'.repeat(MAX_RESULT_STRING_BYTES + 10) },
        metrics: { openIssues: 0 }
      })
    });
    expect(tooLong.status).toBe('invalid-result');
    expect(tooLong.reason).toBe('malformed-evidence');
  });

  it('returns incomplete/work-remaining when completion evaluates to false and unresolved-condition when unresolved', () => {
    const predFalse = workerEvaluateMain({
      contract: BASE_CONTRACT,
      currentAttemptId: 'att-1',
      rawText: JSON.stringify({
        attemptId: 'att-1',
        summary: { verdict: 'pass' },
        metrics: { openIssues: 3 }
      })
    });
    expect(predFalse.status).toBe('incomplete');
    expect(predFalse.reason).toBe('work-remaining');
    expect(predFalse.recovery).toBe('retry-current');

    const contractWithOptionalInCompletion: ResultContract = freezeResultContract({
      ...BASE_CONTRACT,
      completion: {
        version: 1,
        kind: 'typed',
        test: {
          left: { source: 'result-field', fieldId: 'coverage' },
          operator: 'greaterThanOrEqual',
          right: 80
        }
      }
    });
    const unresolvedCompletion = workerEvaluateMain({
      contract: contractWithOptionalInCompletion,
      currentAttemptId: 'att-1',
      rawText: JSON.stringify({
        attemptId: 'att-1',
        summary: { verdict: 'pass' },
        metrics: { openIssues: 0 }
      })
    });
    expect(unresolvedCompletion.status).toBe('invalid-result');
    expect(unresolvedCompletion.reason).toBe('unresolved-condition');
  });
});

describe('evaluateAttemptOutcome — worker deadline and 3-tier outcome precedence (F24-T02, F24-T03)', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'schegent-f24-unit-'));
    mkdirSync(join(workspaceDir, '.schegent', 'results'), { recursive: true });
    writeFileSync(
      join(workspaceDir, '.schegent', 'results', 'verify.json'),
      JSON.stringify({
        attemptId: 'att-ok',
        summary: { verdict: 'pass' },
        metrics: { openIssues: 0 }
      }),
      'utf8'
    );
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('enforces Tier 1 host control precedence over backend diagnostics and valid result files', async () => {
    const cancelled = await evaluateAttemptWithPrecedence({
      attemptId: 'att-ok',
      workspaceRoot: workspaceDir,
      hostControl: 'cancelled',
      backendDiagnostic: { kind: 'credits' },
      resultContract: BASE_CONTRACT
    });
    expect(cancelled.kind).toBe('host-control');
    if (cancelled.kind === 'host-control') {
      expect(cancelled.hostControl).toBe('cancelled');
    }

    const spendLimit = await evaluateAttemptWithPrecedence({
      attemptId: 'att-ok',
      workspaceRoot: workspaceDir,
      hostControl: 'spend-limit',
      resultContract: BASE_CONTRACT
    });
    expect(spendLimit.kind).toBe('host-control');
    if (spendLimit.kind === 'host-control') {
      expect(spendLimit.hostControl).toBe('spend-limit');
    }
  });

  it('enforces Tier 2 canonical backend diagnostic precedence over valid result files', async () => {
    const creditsExhausted = await evaluateAttemptOutcome({
      attemptId: 'att-ok',
      workspaceRoot: workspaceDir,
      backendDiagnostic: { kind: 'credits', detail: 'Quota reached' },
      resultContract: BASE_CONTRACT
    });
    expect(creditsExhausted.status).toBe('temporarily-unavailable');
    expect(creditsExhausted.reason).toBe('credits');
    expect(creditsExhausted.recovery).toBe('reselect');
    expect(creditsExhausted.values).toEqual({});

    const rateLimited = await evaluateAttemptOutcome({
      attemptId: 'att-ok',
      workspaceRoot: workspaceDir,
      backendDiagnostic: { kind: 'rate-limit' },
      resultContract: BASE_CONTRACT
    });
    expect(rateLimited.status).toBe('temporarily-unavailable');
    expect(rateLimited.reason).toBe('rate-limit');
    expect(rateLimited.recovery).toBe('reselect');

    const authFailed = await evaluateAttemptOutcome({
      attemptId: 'att-ok',
      workspaceRoot: workspaceDir,
      backendDiagnostic: { kind: 'authentication' },
      resultContract: BASE_CONTRACT
    });
    expect(authFailed.status).toBe('failed');
    expect(authFailed.reason).toBe('authentication');
    expect(authFailed.recovery).toBe('candidate-intervention');

    const processFailed = await evaluateAttemptOutcome({
      attemptId: 'att-ok',
      workspaceRoot: workspaceDir,
      backendDiagnostic: { kind: 'process-failure', retryable: true },
      resultContract: BASE_CONTRACT
    });
    expect(processFailed.status).toBe('failed');
    expect(processFailed.reason).toBe('process-failure');
    expect(processFailed.recovery).toBe('retry-current');
  });

  it('terminates a hung worker thread exceeding the deadline and returns operator-timeout', async () => {
    const operator = new ResultOperator();
    const timedOut = await operator.evaluate({
      attemptId: 'att-ok',
      workspaceRoot: workspaceDir,
      resultContract: BASE_CONTRACT,
      deadlineMs: 120,
      simulateWorkerHangMs: 1_500
    });
    expect(timedOut.status).toBe('invalid-result');
    expect(timedOut.reason).toBe('operator-timeout');
    expect(timedOut.recovery).toBe('block-intervention');
    expect(timedOut.values).toEqual({});
  });

  it('supports diagnostic-result contracts bounded by MAX_DIAGNOSTIC_RECORD_BYTES (65,536)', async () => {
    const diagContract: ResultContract = freezeResultContract({
      version: 1,
      operator: 'diagnostic-result',
      operatorVersion: 1,
      fields: [
        {
          fieldId: 'verdict',
          type: 'string',
          required: true,
          selector: ['verdict']
        }
      ],
      source: {
        kind: 'diagnostic-records',
        recordType: 'phase-verdict'
      },
      completion: {
        version: 1,
        kind: 'typed',
        test: {
          left: { source: 'result-field', fieldId: 'verdict' },
          operator: 'equals',
          right: 'pass'
        }
      }
    });
    const okOutcome = await evaluateAttemptOutcome({
      attemptId: 'att-diag',
      workspaceRoot: workspaceDir,
      resultContract: diagContract,
      diagnosticRecordsText: JSON.stringify({
        attemptId: 'att-diag',
        recordType: 'phase-verdict',
        verdict: 'pass'
      })
    });
    expect(okOutcome.status).toBe('done');
    expect(okOutcome.values).toEqual({ verdict: 'pass' });

    const oversizeOutcome = await evaluateAttemptOutcome({
      attemptId: 'att-diag',
      workspaceRoot: workspaceDir,
      resultContract: diagContract,
      diagnosticRecordsText: 'x'.repeat(MAX_DIAGNOSTIC_RECORD_BYTES + 10)
    });
    expect(oversizeOutcome.status).toBe('invalid-result');
    expect(oversizeOutcome.reason).toBe('evidence-too-large');
  });
});

describe('3-valued TypedCondition evaluation and default-branch non-masking (F24-T04)', () => {
  const passCond: TypedCondition = freezeTypedCondition({
    version: 1,
    kind: 'typed',
    test: {
      all: [
        {
          left: { source: 'node-result', nodeId: 'verify', fieldId: 'verdict' },
          operator: 'equals',
          right: 'pass'
        },
        {
          left: { source: 'node-result', nodeId: 'verify', fieldId: 'open_issues' },
          operator: 'lessThanOrEqual',
          right: 0
        }
      ]
    }
  });

  const graph: WorkflowDefinition = {
    workflowId: 'wf-typed-routing',
    name: 'Typed Routing',
    version: 1,
    nodes: [
      { nodeId: 'verify', kind: 'phase', phaseId: 'phase-verify' },
      { nodeId: 'ship', kind: 'phase', phaseId: 'phase-ship' },
      { nodeId: 'rework', kind: 'phase', phaseId: 'phase-rework' }
    ],
    connections: [
      {
        from: { nodeId: 'verify' },
        to: { kind: 'node', nodeId: 'ship' },
        priority: 1,
        condition: passCond
      },
      {
        from: { nodeId: 'verify' },
        to: { kind: 'node', nodeId: 'rework' },
        isDefault: true
      }
    ],
    startNodeIds: ['verify']
  };

  it('evaluates 3-valued truth tables for all, any, and exists', () => {
    const doneCtx = buildConditionContext([
      {
        nodeId: 'verify',
        status: 'completed',
        outcomeStatus: 'done',
        outputs: [],
        results: { verdict: 'pass', open_issues: 0 }
      }
    ]);
    expect(evaluateTypedCondition(passCond, doneCtx).result).toBe(true);

    const failCtx = buildConditionContext([
      {
        nodeId: 'verify',
        status: 'completed',
        outcomeStatus: 'done',
        outputs: [],
        results: { verdict: 'pass', open_issues: 2 }
      }
    ]);
    expect(evaluateTypedCondition(passCond, failCtx).result).toBe(false);

    const missingFieldCtx = buildConditionContext([
      {
        nodeId: 'verify',
        status: 'completed',
        outcomeStatus: 'done',
        outputs: [],
        results: { verdict: 'pass' }
      }
    ]);
    expect(evaluateTypedCondition(passCond, missingFieldCtx).result).toBe('unresolved');

    const existsCond: TypedCondition = freezeTypedCondition({
      version: 1,
      kind: 'typed',
      test: {
        left: { source: 'node-result', nodeId: 'verify', fieldId: 'open_issues' },
        operator: 'exists'
      }
    });
    expect(evaluateTypedCondition(existsCond, doneCtx).result).toBe(true);
    expect(evaluateTypedCondition(existsCond, missingFieldCtx).result).toBe(false);
  });

  it('activates isDefault when explicit TypedCondition evaluates to false, but never masks unresolved', () => {
    const falseCtx = buildConditionContext([
      {
        nodeId: 'verify',
        status: 'completed',
        outcomeStatus: 'done',
        outputs: [],
        results: { verdict: 'fail', open_issues: 3 }
      }
    ]);
    const falseTransition = selectNextTransition({
      graph,
      nodeId: 'verify',
      attemptIndex: 0,
      decidedAt: 1_700_000_000_000,
      context: falseCtx
    });
    expect(falseTransition.outcome).toBe('transition');
    if (falseTransition.outcome === 'transition') {
      expect(falseTransition.target).toEqual({ kind: 'node', nodeId: 'rework' });
      expect(falseTransition.decision.defaultApplied).toBe(true);
    }

    const unresolvedCtx = buildConditionContext([
      {
        nodeId: 'verify',
        status: 'completed',
        outcomeStatus: 'invalid-result',
        outputs: []
      }
    ]);
    const unresolvedTransition = selectNextTransition({
      graph,
      nodeId: 'verify',
      attemptIndex: 0,
      decidedAt: 1_700_000_001_000,
      context: unresolvedCtx
    });
    expect(unresolvedTransition.outcome).toBe('unresolved-condition');
    expect(unresolvedTransition.decision.defaultApplied).toBe(false);
    expect(unresolvedTransition.decision.eligible).toEqual([]);

    const obs = buildRoutingDecisionObservation(
      {
        runId: 'run-typed-1',
        graph,
        nodeId: 'verify',
        attemptIndex: 0,
        decidedAt: 1_700_000_001_000,
        context: unresolvedCtx
      },
      unresolvedTransition.decision
    );
    expect(obs.branches[0]?.disposition).toBe('unresolved');
    expect(obs.branches[1]?.disposition).toBe('condition-false');
  });
});
