import { describe, expect, it } from 'vitest';
import { SUPPORTED_BACKENDS } from '../../../src/contracts/backend-kinds';
import { nativeReviewRetryCondition } from '../../../src/contracts/process-definitions';
import { extractOpenQuestions, extractRemainingIssues } from '../../../src/parser/stdout-parser';
import { instructionOf, loadExample, phaseOf } from '../../fixtures/speckit-new-feature-example';

const example = loadExample();

describe('the shipped review phases use native dispatch', () => {
  for (const backend of SUPPORTED_BACKENDS) {
    it.each(['code', 'security'] as const)('%s review takes its scope and report from the host', (kind) => {
      const id = `${backend}-${kind}-review`;
      const phase = phaseOf(example, id);
      expect(phase.spec).toMatchObject({
        runner: backend,
        nativeReview: kind,
        retryCondition: nativeReviewRetryCondition(kind),
        onRetryCap: 'fail',
        hostVerification: 'exit-code'
      });
      const instruction = instructionOf(phase);
      expect(instruction).toContain('Review scope:');
      expect(instruction).toContain('Fix confirmed');
      expect(instruction).not.toContain('## Implementation repositories');
      expect(instruction).not.toMatch(/^\/(?:code-review|security-review)|\bcodex(?:-security scan| exec review)/m);
    });
  }

  it('defaults to two independent selected reviews and finishes at Finalize', () => {
    expect(example.phaseIds.filter((id) => id.endsWith('-review'))).toEqual([
      'claude-code-review',
      'claude-security-review'
    ]);
    expect(example.phaseIds.at(-1)).toBe('claude-finalize');
  });

  it('reports unresolved scope separately from the list of reviewed repositories', () => {
    const report = [
      'Review scope:',
      '- alpha: develop, 2 tracked changes',
      '- shop: unresolved, missing base',
      '',
      'Remaining issues:',
      '- [needs-decision] shop: declare a local base',
      '- [regression] alpha/src/a.ts:42 drops the cursor'
    ].join('\n');
    expect(extractRemainingIssues(report).map(({ tag }) => tag)).toEqual(['needs-decision', 'regression']);
    expect(extractOpenQuestions(report)).toEqual([]);
    expect(extractRemainingIssues('Review scope:\n- x')).toEqual([]);
  });
});
