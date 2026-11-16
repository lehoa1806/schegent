// The words the inspector shows for contract values, and for a step in a select.
//
// Each select keeps the contract value as its option value, so what a Workflow saves
// is the string it always was; only the text a person reads is worded. The words for
// a text comparison and for a failed item are the mockup's.

import type {
  ForEachCollectionSource,
  ForEachItemErrorPolicy,
  RepeatExhaustedPolicy,
  WorkflowConditionOperator,
  WorkflowNode,
  WorkflowSelectionRule
} from '../../lib/snapshot-types';
import { nodeTitle } from './workflow-flow-view';

/** A comparison, read after the field it tests: "verdict is equal to". */
export const OPERATOR_WORDS: Readonly<Record<WorkflowConditionOperator, string>> = {
  equals: 'equal to',
  notEquals: 'not equal to',
  in: 'one of',
  exists: 'present',
  greaterThan: 'greater than',
  greaterThanOrEqual: 'at least',
  lessThan: 'less than',
  lessThanOrEqual: 'at most'
};

/** What the host does when a Repeat reaches its cap without the condition holding. */
export const ON_EXHAUSTED_WORDS: Readonly<Record<RepeatExhaustedPolicy, string>> = {
  pause: 'Pause the run',
  fail: 'Fail the run'
};

export const ON_ITEM_ERROR_WORDS: Readonly<Record<ForEachItemErrorPolicy, string>> = {
  stop: 'Stop the loop',
  continue: 'Skip the item and continue'
};

export const COLLECTION_SOURCE_WORDS: Readonly<Record<ForEachCollectionSource['source'], string>> = {
  'workflow-input': 'Workflow input',
  'node-output': 'Output of a step'
};

/** Which item of a collection output a branch hands to a single input. */
export const SELECTION_WORDS: Readonly<Record<WorkflowSelectionRule, string>> = {
  first: 'The first item',
  last: 'The last item',
  exactlyOne: 'Exactly one item'
};

/** A step as a select offers it: its title, then its identifier when the two differ. */
export function stepOptionWords(node: WorkflowNode): string {
  const title = nodeTitle(node);
  return title === node.nodeId ? title : `${title} (${node.nodeId})`;
}
