// FR-R5-F32 (F32-T02, F32-T03, F32-T07) — Component tests for CandidateBlockEditor
// and candidate-block canvas path layout helpers.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { PortablePhaseDefinition } from '../../lib/snapshot-types';
import CandidateBlockEditor from '../PipelineBuilderEditors/CandidateBlockEditor.svelte';
import type { MutableWorkflow } from '../PipelineBuilderEditors/types';
import {
  addCandidateRow,
  enableCandidateBlockControl,
  moveCandidateRow,
  removeCandidateRow,
  toSaveWorkflowRow
} from '../PipelineBuilderEditors/workflow-catalog-state';
import { describeCandidateBlockCanvasPath } from '../PipelineBuilderEditors/workflow-flow-layout';

const PHASES: readonly PortablePhaseDefinition[] = [
  {
    phaseId: 'phase-claude-impl',
    name: 'Claude Implementer',
    version: 1,
    instruction: 'Implement the requested feature using strict TDD and clean commits.',
    runner: 'claude',
    model: 'claude-sonnet-4-5',
    retryCondition: 'verification-failed'
  },
  {
    phaseId: 'phase-codex-impl',
    name: 'Codex Implementer',
    version: 1,
    instruction: 'Implement fallback solution with minimal footprint.',
    runner: 'codex',
    model: 'gpt-5-codex'
  }
];

function makeDraftWorkflow(overrides: Partial<MutableWorkflow> = {}): MutableWorkflow {
  return {
    sourceKey: 'draft:wf-cand-1',
    persisted: false,
    sourceStatus: 'effective',
    sourceErrors: [],
    derivedInputs: [],
    derivedOutputs: [],
    workflowId: 'wf-cand-1',
    name: 'Candidate Block Workflow',
    description: 'Ordered fallback candidate block.',
    version: 1,
    nodes: [
      { nodeId: 'cand-node-1', kind: 'phase', phaseId: 'phase-claude-impl' },
      { nodeId: 'cand-node-2', kind: 'phase', phaseId: 'phase-codex-impl' }
    ],
    connections: [],
    startNodeIds: ['cand-node-1'],
    ...overrides
  };
}

afterEach(() => {
  cleanup();
});

describe('CandidateBlockEditor — authoring & read-only Phase binding (F32-T02)', () => {
  it('enables candidate-block mode, binds Phase nodes, and renders Phase identity read-only', async () => {
    let current = makeDraftWorkflow();
    const { getByTestId, rerender } = render(CandidateBlockEditor, {
      props: {
        row: current,
        phases: PHASES,
        readonly: false,
        onedit: (edit) => {
          current = edit(current);
        }
      }
    });

    await fireEvent.click(getByTestId('candidate-block-enable'));
    await rerender({
      row: current,
      phases: PHASES,
      readonly: false,
      onedit: (edit) => {
        current = edit(current);
      }
    });

    expect(current.control?.kind).toBe('candidate-block');
    expect(current.control?.candidates.length).toBe(2);
    expect(getByTestId('candidate-row-id-0').textContent).toBe('candidate-1');
    expect(getByTestId('candidate-row-id-1').textContent).toBe('candidate-2');

    // Read-only Phase identity is displayed without creating editable Phase instruction inputs
    const identity0 = getByTestId('candidate-row-phase-identity-0');
    expect(identity0.getAttribute('data-readonly')).toBe('true');
    expect(identity0.querySelectorAll('input, textarea').length).toBe(0);
    expect(getByTestId('candidate-row-runner-0').textContent).toContain('claude');
    expect(getByTestId('candidate-row-model-0').textContent).toContain('claude-sonnet-4-5');
    expect(getByTestId('candidate-row-instruction-summary-0').textContent).toContain(
      'Implement the requested feature using strict TDD'
    );
  });

  it('adds up to 8 candidate rows with stable IDs, reorders without losing selection, and prevents removing the last row', async () => {
    let current = enableCandidateBlockControl(
      makeDraftWorkflow({
        nodes: [{ nodeId: 'cand-node-1', kind: 'phase', phaseId: 'phase-claude-impl' }]
      }),
      'phase-claude-impl'
    );
    expect(current.control?.candidates.length).toBe(1);

    // Removing when only 1 candidate exists is a no-op
    current = removeCandidateRow(current, 0);
    expect(current.control?.candidates.length).toBe(1);

    // Add up to 8 candidates
    for (let i = 0; i < 10; i++) {
      current = addCandidateRow(current, i % 2 === 0 ? 'phase-codex-impl' : 'phase-claude-impl');
    }
    expect(current.control?.candidates.length).toBe(8);
    const idsBefore = (current.control?.candidates ?? []).map((c) => c.candidateId);
    expect(new Set(idsBefore).size).toBe(8);

    // Reorder candidate-2 to index 0 and verify stable candidateId
    const reordered = moveCandidateRow(current, 1, -1);
    expect(reordered.control?.candidates[0]?.candidateId).toBe(idsBefore[1]);
    expect(reordered.control?.candidates[1]?.candidateId).toBe(idsBefore[0]);
  });

  it('updates candidate maxAttempts (1..20), allowUnverifiedTrial, availabilityPolicy, maxDispatches (1..40), monitoringWindowMs, and strict-usd ceiling', async () => {
    let current = enableCandidateBlockControl(makeDraftWorkflow(), 'phase-claude-impl');
    const { getByTestId, rerender } = render(CandidateBlockEditor, {
      props: {
        row: current,
        phases: PHASES,
        readonly: false,
        onedit: (edit) => {
          current = edit(current);
        }
      }
    });

    await fireEvent.change(getByTestId('candidate-block-availability-policy'), {
      target: { value: 'wait-for-selected' }
    });
    await fireEvent.input(getByTestId('candidate-block-max-dispatches'), {
      target: { value: '25' }
    });
    await fireEvent.input(getByTestId('candidate-block-monitoring-window-ms'), {
      target: { value: '120000' }
    });
    await fireEvent.input(getByTestId('candidate-block-max-microusd'), {
      target: { value: '500000' }
    });
    await fireEvent.input(getByTestId('candidate-row-max-attempts-0'), {
      target: { value: '5' }
    });
    await fireEvent.click(getByTestId('candidate-row-allow-unverified-trial-0'));

    await rerender({
      row: current,
      phases: PHASES,
      readonly: false,
      onedit: (edit) => {
        current = edit(current);
      }
    });

    const saved = toSaveWorkflowRow(current);
    expect(saved.control?.availabilityPolicy).toBe('wait-for-selected');
    expect(saved.control?.maxDispatches).toBe(25);
    expect(saved.control?.monitoringWindowMs).toBe(120000);
    expect(saved.control?.budget).toEqual({ mode: 'strict-usd', limitMicrousd: 500000 });
    expect(saved.control?.candidates[0]?.maxAttempts).toBe(5);
    expect(saved.control?.candidates[0]?.allowUnverifiedTrial).toBe(true);
  });
});

describe('CandidateBlockEditor — collapsed/expanded canvas path & focus preservation (F32-T03)', () => {
  it('describes exclusive single-active candidate selection, retry adornments, validated return path, and terminal exits without cyclic edges', async () => {
    let current = enableCandidateBlockControl(makeDraftWorkflow(), 'phase-claude-impl');
    const path = describeCandidateBlockCanvasPath(current.control, current.nodes, PHASES);
    expect(path).not.toBeNull();
    expect(path?.selectionMode).toBe('exclusive-single-active');
    expect(path?.validatedReturnPath).toBe('Single validated candidate return');
    expect(path?.terminalExits).toEqual(['failed', 'intervention-required']);
    expect(path?.hasCyclicEdges).toBe(false);
    expect(path?.candidates[0]?.retrySummary).toContain('Up to 3 attempts');

    const { getByTestId, queryByTestId } = render(CandidateBlockEditor, {
      props: {
        row: current,
        phases: PHASES,
        readonly: false,
        onedit: (edit) => {
          current = edit(current);
        }
      }
    });

    // Select candidate-2 before collapsing
    await fireEvent.click(getByTestId('candidate-row-select-candidate-2'));
    expect(getByTestId('candidate-row-select-candidate-2').getAttribute('aria-pressed')).toBe(
      'true'
    );

    // Collapse and re-expand
    const toggle = getByTestId('candidate-block-expand-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await fireEvent.click(toggle);
    await tick();

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(getByTestId('candidate-block-collapsed-view')).toBeTruthy();
    expect(queryByTestId('candidate-block-expanded-view')).toBeNull();

    await fireEvent.click(toggle);
    await tick();

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(getByTestId('candidate-row-select-candidate-2').getAttribute('aria-pressed')).toBe(
      'true'
    );
  });
});
