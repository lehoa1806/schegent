// The words the inspector shows for contract values.
//
// Each select keeps the contract value as its option value, so a saved Workflow and
// a test that sets a value read the same strings as before. Only the text a person
// reads is new, and for a comparison and a failed item it is the mockup's.

import { describe, expect, it } from 'vitest';
import {
  FOR_EACH_COLLECTION_SOURCES,
  FOR_EACH_ON_ITEM_ERROR_POLICIES,
  REPEAT_ON_EXHAUSTED_POLICIES,
  TYPED_CONDITION_OPERATORS,
  WORKFLOW_SELECTION_RULES
} from '../../lib/snapshot-types';
import {
  COLLECTION_SOURCE_WORDS,
  ON_EXHAUSTED_WORDS,
  ON_ITEM_ERROR_WORDS,
  OPERATOR_WORDS,
  SELECTION_WORDS,
  stepOptionWords
} from '../PipelineBuilderEditors/workflow-field-words';

describe('the words for contract values', () => {
  it('reads a text comparison the way the mockup does', () => {
    expect([OPERATOR_WORDS.equals, OPERATOR_WORDS.notEquals, OPERATOR_WORDS.in, OPERATOR_WORDS.exists]).toEqual([
      'equal to',
      'not equal to',
      'one of',
      'present'
    ]);
  });

  it('says what a For each does when an item fails', () => {
    expect(FOR_EACH_ON_ITEM_ERROR_POLICIES.map((policy) => ON_ITEM_ERROR_WORDS[policy])).toEqual([
      'Stop the loop',
      'Skip the item and continue'
    ]);
  });

  it('says what a Repeat does when its iterations run out', () => {
    expect(REPEAT_ON_EXHAUSTED_POLICIES.map((policy) => ON_EXHAUSTED_WORDS[policy])).toEqual([
      'Pause the run',
      'Fail the run'
    ]);
  });

  it('words every value a select offers, each differently', () => {
    const lists: readonly (readonly string[])[] = [
      TYPED_CONDITION_OPERATORS.map((operator) => OPERATOR_WORDS[operator]),
      FOR_EACH_COLLECTION_SOURCES.map((source) => COLLECTION_SOURCE_WORDS[source]),
      WORKFLOW_SELECTION_RULES.map((rule) => SELECTION_WORDS[rule])
    ];
    for (const words of lists) {
      expect(new Set(words).size).toBe(words.length);
      for (const word of words) expect(word.trim().length).toBeGreaterThan(0);
    }
  });

  it('says which item of a collection a single input receives', () => {
    expect(WORKFLOW_SELECTION_RULES.map((rule) => SELECTION_WORDS[rule])).toEqual([
      'The first item',
      'The last item',
      'Exactly one item'
    ]);
  });

  it('offers a step by its title, with its identifier when the two differ', () => {
    expect(stepOptionWords({ nodeId: 'plan', label: 'Plan the work' } as never)).toBe('Plan the work (plan)');
    expect(stepOptionWords({ nodeId: 'ship' } as never)).toBe('ship');
    expect(stepOptionWords({ nodeId: 'ship', label: '  ' } as never)).toBe('ship');
    expect(stepOptionWords({ nodeId: 'ship', label: 'ship' } as never)).toBe('ship');
  });
});
