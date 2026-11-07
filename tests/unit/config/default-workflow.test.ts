// Feature 285 (OD-2, FR-005, SC-003): the default Workflow resolves from `schegent.defaultWorkflowId`,
// with the deprecated `schegent.defaultPipelineId` as a read-only fallback that counts only when
// it names an effective Workflow. A stored Pipeline ID is ignored.

import { describe, expect, it } from 'vitest';

import {
  resolveDefaultWorkflowId,
  type DefaultWorkflowReader
} from '../../../src/config/default-workflow';

type Scope = 'user' | 'workspace';
type ScopedValues = Partial<Record<Scope, unknown>>;

function readerOf(current: ScopedValues, deprecated: ScopedValues = {}): DefaultWorkflowReader {
  return {
    getDefaultWorkflowId: (scope) => current[scope],
    getDeprecatedDefaultPipelineId: (scope) => deprecated[scope]
  };
}

const EFFECTIVE = [{ workflowId: 'wf-review' }, { workflowId: 'wf-ship' }] as const;
// A Pipeline ID: it names no effective Workflow, so it never gives a default.
const PIPELINE_ID = 'speckit-default';

describe('resolveDefaultWorkflowId (SC-003)', () => {
  it('1. the new key naming an effective Workflow is the default', () => {
    expect(resolveDefaultWorkflowId(readerOf({ user: 'wf-review' }), EFFECTIVE)).toBe('wf-review');
  });

  it('2. the new key naming a Pipeline gives no default', () => {
    expect(resolveDefaultWorkflowId(readerOf({ user: PIPELINE_ID }), EFFECTIVE)).toBe('');
  });

  it('3. the new key unset, the deprecated key naming a Workflow: the deprecated value is used', () => {
    expect(resolveDefaultWorkflowId(readerOf({}, { workspace: 'wf-ship' }), EFFECTIVE)).toBe('wf-ship');
  });

  it('4. the new key unset, the deprecated key naming a Pipeline: ignored, no default', () => {
    expect(resolveDefaultWorkflowId(readerOf({}, { user: PIPELINE_ID }), EFFECTIVE)).toBe('');
  });

  it('5. both keys unset gives no default', () => {
    expect(resolveDefaultWorkflowId(readerOf({}), EFFECTIVE)).toBe('');
  });

  it('6. both keys set: the new key wins, even when it names nothing effective', () => {
    expect(
      resolveDefaultWorkflowId(readerOf({ user: 'wf-review' }, { user: 'wf-ship' }), EFFECTIVE)
    ).toBe('wf-review');
    expect(
      resolveDefaultWorkflowId(readerOf({ user: 'wf-gone' }, { user: 'wf-ship' }), EFFECTIVE)
    ).toBe('');
  });

  it('6b. the new key set at user scope wins over the deprecated key set at workspace scope', () => {
    expect(
      resolveDefaultWorkflowId(readerOf({ user: 'wf-review' }, { workspace: 'wf-ship' }), EFFECTIVE)
    ).toBe('wf-review');
  });

  it('7. a malformed deprecated value gives no default', () => {
    for (const malformed of [42, true, ['wf-ship'], { id: 'wf-ship' }, null]) {
      expect(resolveDefaultWorkflowId(readerOf({}, { user: malformed }), EFFECTIVE)).toBe('');
    }
  });

  it('7b. a malformed new value is a set value: no default, and the deprecated key is not read', () => {
    expect(resolveDefaultWorkflowId(readerOf({ user: 42 }, { user: 'wf-ship' }), EFFECTIVE)).toBe('');
  });

  it('8. workspace scope beats user scope within each key', () => {
    expect(
      resolveDefaultWorkflowId(readerOf({ user: 'wf-review', workspace: 'wf-ship' }), EFFECTIVE)
    ).toBe('wf-ship');
    expect(
      resolveDefaultWorkflowId(readerOf({}, { user: 'wf-review', workspace: 'wf-ship' }), EFFECTIVE)
    ).toBe('wf-ship');
  });

  it('an explicit empty new value is a chosen "no default": the deprecated key is not read', () => {
    expect(resolveDefaultWorkflowId(readerOf({ user: '' }, { user: 'wf-ship' }), EFFECTIVE)).toBe('');
    expect(
      resolveDefaultWorkflowId(readerOf({ workspace: '' }, { workspace: 'wf-ship' }), EFFECTIVE)
    ).toBe('');
  });

  it('no reader and no effective Workflows give no default', () => {
    expect(resolveDefaultWorkflowId(undefined, EFFECTIVE)).toBe('');
    expect(resolveDefaultWorkflowId(readerOf({ user: 'wf-review' }), [])).toBe('');
  });
});
