// An invalid row's authored lists have to cross the projection boundary too.
//
// WHY THIS EXISTS. `recognizedAuthoredDisplay` now keeps a row's authored lists on
// `display` — a Phase's `capabilities`, a Pipeline's `phases`, a Workflow's
// `startNodeIds`. Three `projectDisplay` functions then dropped them again: the
// Pipeline's and the Workflow's were byte-identical, and all three carried scalars
// only. The host-side fix was inert for the Builder until this boundary carried them
// too, so the two halves are pinned separately.
//
// The bound is asserted with the behaviour, not left implicit. `display` is built
// from raw unvalidated input — it is what a row that FAILED validation shows the
// operator — so a hand-edited record can hold a list of any length, and this is the
// only pass between that file and a webview.
import { describe, expect, it } from 'vitest';

import { resolvePhaseCatalog } from '../../../../src/config/process-catalog';
import { resolvePipelineCatalog } from '../../../../src/config/pipeline-catalog';
import { resolveWorkflowCatalog } from '../../../../src/config/workflow-catalog';
import { composePhaseCatalogProjection } from '../../../../src/ui/sidebar/phase-catalog-projection';
import { projectPipelineCatalog } from '../../../../src/ui/sidebar/pipeline-catalog-projection';
import { projectWorkflowCatalog } from '../../../../src/ui/sidebar/workflow-catalog-projector';
import { ENTRIES_PER_DISPLAY_LIST_MAX } from '../../../../src/ui/sidebar/display-projection';

const identity = (value: string): string => value;
const MODELS = { claude: ['claude-opus-5'], codex: [], agy: [] } as const;
const REVISION = 'r1';
const NO_PIPELINES = { effective: [], records: [] } as const;

/** An empty name fails `invalid-length` in all three, leaving the rest of the row. */
const BREAKS_THE_ROW = { name: '' };

/** The one record the fixture projects, or a thrown assertion. */
function onlyRecord(records: readonly { readonly display: Readonly<Record<string, unknown>> }[]) {
  expect(records.length, 'the fixture must project exactly one record').toBe(1);
  // `.at` rather than `[0]`: it is typed `| undefined` on its own, so the guard is
  // necessary to eslint as well as to `noUncheckedIndexedAccess`.
  const record = records.at(0);
  if (record === undefined) throw new Error('the fixture projected no record');
  return record;
}

function phaseDisplay(row: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const projection = composePhaseCatalogProjection(
    resolvePhaseCatalog({ rows: [{ ...BREAKS_THE_ROW, ...row }], revision: REVISION }),
    { sanitize: identity, availableModels: MODELS, defaultRunnerKind: 'claude' }
  );
  if (projection === undefined) throw new Error('the Phase catalog projected nothing');
  return onlyRecord(projection.records).display;
}

function pipelineDisplay(
  row: Record<string, unknown>,
  sanitize: (value: string) => string = identity
): Readonly<Record<string, unknown>> {
  const projection = projectPipelineCatalog(
    resolvePipelineCatalog({
      rows: [{ ...BREAKS_THE_ROW, ...row }],
      revision: REVISION,
      phaseCatalog: []
    }),
    { sanitize, availableModels: MODELS, defaultRunnerKind: 'claude' }
  );
  return onlyRecord(projection.records).display;
}

function workflowDisplay(row: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const projection = projectWorkflowCatalog(
    resolveWorkflowCatalog({
      rows: [{ ...BREAKS_THE_ROW, ...row }],
      revision: REVISION,
      pipelineCatalog: NO_PIPELINES
    }),
    { sanitize: identity, effectivePipelines: [] }
  );
  return onlyRecord(projection.records).display;
}

describe('the projection carries an invalid row`s authored lists', () => {
  it('carries a Phase`s narrowed capabilities', () => {
    // The field the whole defect turned on: omission means EVERY capability, so a
    // narrowed Phase whose list is dropped arrives in the Builder claiming full
    // authority.
    const display = phaseDisplay({
      phaseId: 'narrowed',
      version: 1,
      instruction: 'Read only.',
      capabilities: ['workspace-write', 'network']
    });
    expect(display.capabilities).toEqual(['workspace-write', 'network']);
  });

  it('carries a Pipeline`s authored phase list', () => {
    const display = pipelineDisplay({ pipelineId: 'broken', version: 1, phases: ['plan', 'build'] });
    expect(display.phases).toEqual(['plan', 'build']);
  });

  it('carries a Workflow`s start node ids', () => {
    const display = workflowDisplay({
      workflowId: 'broken',
      version: 1,
      nodes: [],
      connections: [],
      startNodeIds: ['entry']
    });
    expect(display.startNodeIds).toEqual(['entry']);
  });

  it('freezes a carried list, projected state never being a live handle', () => {
    const display = phaseDisplay({
      phaseId: 'narrowed',
      version: 1,
      instruction: 'Read only.',
      capabilities: ['workspace-write']
    });
    // Asserted to BE a list first: `Object.isFrozen(undefined)` is `true`, so a
    // dropped field would satisfy the freeze check vacuously.
    expect(Array.isArray(display.capabilities)).toBe(true);
    expect(Object.isFrozen(display.capabilities)).toBe(true);
  });

  it('bounds the length of a list nobody validated', () => {
    const overlong = Array.from(
      { length: ENTRIES_PER_DISPLAY_LIST_MAX + 25 },
      (_, index) => `phase-${index}`
    );
    const display = pipelineDisplay({ pipelineId: 'broken', version: 1, phases: overlong });
    expect((display.phases as readonly string[]).length).toBe(ENTRIES_PER_DISPLAY_LIST_MAX);
  });

  it('sanitizes every string entry, not just the field`s own text', () => {
    const display = pipelineDisplay(
      { pipelineId: 'broken', version: 1, phases: ['<script>plan'] },
      (value) => value.replace(/</g, '')
    );
    // An entry inside a list is operator-typed text on the same footing as a field
    // value, and it reaches the same webview. The stand-in sanitizer strips `<` and
    // nothing else, so the assertion is that it ran — not what the real one does.
    expect(display.phases).toEqual(['script>plan']);
  });
});
