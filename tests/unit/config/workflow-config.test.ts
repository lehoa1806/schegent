import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_WORKFLOWS,
  WORKFLOW_CONFIG_KEY,
  equalsBuiltInWorkflows,
  readWorkflowLayers,
  writeWorkflowLayer,
  type WorkflowConfigReader
} from '../../../src/config/workflow-config';

const reader = (
  layers: Partial<Record<'user' | 'workspace', unknown>>
): WorkflowConfigReader => ({
  getWorkflows: (scope) => layers[scope] as readonly unknown[] | undefined
});

const ROW = {
  id: 'design-then-implement',
  name: 'Design then implement',
  version: 1,
  nodes: [{ nodeId: 'design', pipelineId: 'standard' }],
  connections: [],
  startNodeIds: ['design']
};

describe('readWorkflowLayers', () => {
  it('reads the Global layer as the user scope and the Workspace layer as the workspace scope', () => {
    const layers = readWorkflowLayers(
      reader({ user: [ROW], workspace: [{ ...ROW, id: 'workspace-copy' }] })
    );

    expect(layers.user).toEqual([ROW]);
    expect(layers.workspace).toEqual([{ ...ROW, id: 'workspace-copy' }]);
  });

  it('reports an empty layer for a scope the configuration does not define', () => {
    expect(readWorkflowLayers(reader({ user: [ROW] }))).toEqual({ user: [ROW], workspace: [] });
  });

  it('reports empty layers when no reader is supplied', () => {
    expect(readWorkflowLayers()).toEqual({ user: [], workspace: [] });
  });

  it('treats a non-array configuration value as an empty layer rather than trusting it', () => {
    expect(readWorkflowLayers(reader({ user: 'not-an-array', workspace: { id: 'x' } }))).toEqual({
      user: [],
      workspace: []
    });
  });
});

describe('BUILT_IN_WORKFLOWS', () => {
  it('is an empty, frozen layer — no Workflow ships with the extension', () => {
    expect(BUILT_IN_WORKFLOWS).toEqual([]);
    expect(Object.isFrozen(BUILT_IN_WORKFLOWS)).toBe(true);
  });
});

describe('equalsBuiltInWorkflows', () => {
  it('matches the reset payload, which is the empty layer', () => {
    expect(equalsBuiltInWorkflows([])).toBe(true);
  });

  it('does not match a payload that carries any row', () => {
    expect(equalsBuiltInWorkflows([ROW])).toBe(false);
    expect(equalsBuiltInWorkflows([{}])).toBe(false);
  });
});

describe('writeWorkflowLayer', () => {
  it('writes the rows once under the single key literal, to the requested scope', async () => {
    const calls: { key: string; value: unknown; scope: string }[] = [];

    await writeWorkflowLayer(
      async (key, value, scope) => {
        calls.push({ key, value, scope });
      },
      [ROW],
      'user'
    );

    expect(calls).toEqual([{ key: WORKFLOW_CONFIG_KEY, value: [ROW], scope: 'user' }]);
    expect(WORKFLOW_CONFIG_KEY).toBe('workflows');
  });

  it('writes the empty layer verbatim so a reset clears the scope', async () => {
    const calls: unknown[] = [];

    await writeWorkflowLayer(
      async (_key, value) => {
        calls.push(value);
      },
      [],
      'workspace'
    );

    expect(calls).toEqual([[]]);
  });
});
