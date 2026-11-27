// How a step runs (FR-R5-F33 / FR-R5-F34): once, repeated until a result field
// matches, or once per item of a bounded collection.
//
// The inspector's Control tab offers the three as one choice. The two default
// controls moved here from `WorkflowNodeControlEditor.svelte` unchanged, so a step
// switched on from the choice saves what the old checkboxes saved.

import {
  DEFAULT_FOR_EACH_MAX_ITEMS,
  DEFAULT_FOR_EACH_ON_ITEM_ERROR,
  DEFAULT_REPEAT_ON_EXHAUSTED,
  type ForEachControl,
  type PortableWorkflowDefinition,
  type RepeatControl,
  type WorkflowNode,
  type WorkflowNodeControl
} from '../../lib/snapshot-types';

/** The choices, in the order the Control tab lists them. */
export const NODE_CONTROL_KINDS = ['once', 'repeat', 'for-each'] as const;
export type NodeControlKind = (typeof NODE_CONTROL_KINDS)[number];

export interface NodeControlChoice {
  readonly kind: NodeControlKind;
  readonly title: string;
  readonly description: string;
}

export const NODE_CONTROL_CHOICES: readonly NodeControlChoice[] = [
  { kind: 'once', title: 'Once', description: 'Run the step a single time.' },
  { kind: 'repeat', title: 'Repeat until…', description: 'Rerun until a result field matches, up to a cap.' },
  { kind: 'for-each', title: 'For each…', description: 'Run once per item of a collection, in order.' }
];

const CONTROL_WORDS: Record<WorkflowNodeControl['kind'], string> = {
  repeat: 'Repeat',
  'for-each': 'For each'
};

const DEFAULT_REPEAT_ITERATIONS = 3;
const FALLBACK_RESULT_FIELD = 'approved';
const DEFAULT_COLLECTION_PORT = 'itemsFile';
const FALLBACK_ITEM_PORT = 'item';

export function controlKindOf(node: Pick<WorkflowNode, 'control'>): NodeControlKind {
  return node.control?.kind ?? 'once';
}

/** The name of a looping control, as the warning before discarding it says it. */
export function controlKindWord(kind: WorkflowNodeControl['kind']): string {
  return CONTROL_WORDS[kind];
}

/** Repeat until the child's first decision result field is true, three passes at most. */
export function defaultRepeatControl(child: PortableWorkflowDefinition | null): RepeatControl {
  const firstField = child?.decisionResults?.fields.at(0)?.fieldId ?? FALLBACK_RESULT_FIELD;
  return {
    version: 1,
    kind: 'repeat',
    maxIterations: DEFAULT_REPEAT_ITERATIONS,
    until: {
      version: 1,
      kind: 'typed',
      test: {
        left: { source: 'result-field', fieldId: firstField },
        operator: 'equals',
        right: true
      }
    },
    carry: [],
    onExhausted: DEFAULT_REPEAT_ON_EXHAUSTED
  };
}

/** Feed each item of a Workflow input file to the child's first input port. */
export function defaultForEachControl(child: PortableWorkflowDefinition | null): ForEachControl {
  const firstInputPort = child?.inputs?.at(0)?.portId ?? FALLBACK_ITEM_PORT;
  return {
    version: 1,
    kind: 'for-each',
    collection: { source: 'workflow-input', portId: DEFAULT_COLLECTION_PORT },
    itemInputPortId: firstInputPort,
    maxItems: DEFAULT_FOR_EACH_MAX_ITEMS,
    onItemError: DEFAULT_FOR_EACH_ON_ITEM_ERROR
  };
}

/** The control a step carries once this kind is chosen; none for a step that runs once. */
export function controlForKind(
  kind: NodeControlKind,
  child: PortableWorkflowDefinition | null
): WorkflowNodeControl | undefined {
  if (kind === 'repeat') return defaultRepeatControl(child);
  if (kind === 'for-each') return defaultForEachControl(child);
  return undefined;
}
