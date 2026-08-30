// Feature 184 (FR-R3-141) — fixtures for the canvas components.
//
// One builder for `PipelineFlowView`, shared by the node, canvas and builder
// tests, so a change to the view contract breaks compilation in one place rather
// than being patched independently in four files until they disagree.

import { vi } from 'vitest';
import type { PipelineDraftError } from '../PipelineBuilderEditors/pipeline-catalog-state';
import type { PipelineFlowView } from '../PipelineBuilderEditors/pipeline-flow-view';
import type { MutablePhase, MutablePipeline } from '../PipelineBuilderEditors/types';
import { GOLDEN_PHASES } from './pipeline-authoring-script';

export const FLOW_PHASES: readonly MutablePhase[] = GOLDEN_PHASES;

/** A persisted row naming two Phases the catalog holds. */
export function flowPipelineRow(overrides: Partial<MutablePipeline> = {}): MutablePipeline {
  return {
    id: 'release-flow',
    name: 'Release Flow',
    version: 1,
    phases: ['speckit-specify', 'done'],
    inputs: [],
    outputs: [],
    bindings: [],
    recommendedNext: [],
    sourceKey: 'user::release-flow',
    sourceStatus: 'effective',
    sourceErrors: [],
    persisted: true,
    ...overrides
  } as MutablePipeline;
}

export interface FlowViewHandles {
  readonly view: PipelineFlowView;
  readonly onselect: ReturnType<typeof vi.fn>;
  readonly onmoveup: ReturnType<typeof vi.fn>;
  readonly onmovedown: ReturnType<typeof vi.fn>;
  readonly onremove: ReturnType<typeof vi.fn>;
}

/**
 * A view over `phases`, with every callback a spy the caller can assert on.
 *
 * `phaseDefects` defaults to one empty list per position, which is what
 * `pipelineErrorsAt` returns for a clean row — the node indexes into it, so a
 * short array would be a fixture artefact rather than a state the surface can
 * actually be in.
 */
export function makeFlowView(
  overrides: Partial<Omit<PipelineFlowView, 'phases'>> & { phases?: readonly string[] } = {}
): FlowViewHandles {
  const { phases = ['speckit-specify', 'done'], ...rest } = overrides;
  const onselect = vi.fn();
  const onmoveup = vi.fn();
  const onmovedown = vi.fn();
  const onremove = vi.fn();
  const view: PipelineFlowView = {
    phases,
    catalog: FLOW_PHASES,
    phaseDefects: phases.map<readonly PipelineDraftError[]>(() => []),
    getPhaseTooltip: (phaseId: string) => `tooltip:${phaseId}`,
    readonly: false,
    selection: null,
    onselect,
    onmoveup,
    onmovedown,
    onremove,
    ...rest
  };
  return { view, onselect, onmoveup, onmovedown, onremove };
}

export function draftError(field: string, message: string): PipelineDraftError {
  return { field, code: 'invalid', message };
}
