// Feature 184 (FR-R3-141, T049) — replay the authoring script on the NEW surface.
//
// This is the acceptance boundary. FR-031 says the rework changes where an
// operator clicks and nothing about what gets saved, and the only proof of that
// is a body recorded from the old form *before* it was deleted (T005a) and
// matched byte for byte by the canvas afterwards. The golden JSON and the script
// are shared with that recording; `pipeline-save-body.golden.test.ts` itself is
// gone, because the form it drove is gone.
//
// The store is real, not a spy: the claim is about what the *store* is driven
// to, and a callback spy would only prove which callbacks fired.
//
// Where the interactions differ from T005a's, they differ because the control
// moved, never because the body did:
//
//   * name / id / description — the same three inspector fields, same test ids.
//     T005a drove them through the form card; the card is gone and the inspector
//     holds them now, and the ids came across unchanged.
//   * append — one palette click per Phase, replacing a `<select>` change plus an
//     "Add Phase" click. The pending `newPhaseId` the pair needed between them is
//     what `appendPhaseId(phaseId)` removed.
//   * move up / remove — the same two buttons at the same positions, now beside
//     the card instead of on the sequence row.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PipelineFlowBuilder from '../PipelineBuilderEditors/PipelineFlowBuilder.svelte';
import { PipelineCatalogStore } from '../PipelineBuilderEditors/pipeline-catalog-store.svelte';
import GOLDEN_BODY from './pipeline-save-body.golden.json';
import {
  AUTHORED,
  EXPECTED_PHASES,
  GOLDEN_PHASES,
  GOLDEN_SNAPSHOT,
  goldenSeedRow,
  serializeBody
} from './pipeline-authoring-script';

vi.mock('../../lib/process-yaml-ipc', () => ({ exportPipelineYaml: vi.fn() }));

afterEach(cleanup);

function mountCanvas(store: PipelineCatalogStore) {
  return render(PipelineFlowBuilder, {
    props: {
      snapshot: GOLDEN_SNAPSHOT,
      pipelines: store.pipelines,
      phases: GOLDEN_PHASES,
      selectedIndex: store.selectedIndex,
      historyIndex: 0,
      historyLength: 1,
      trusted: true,
      savePending: false,
      mutationActive: true,
      editableSourceKey: store.mutationSourceKey,
      getPhaseTooltip: (phaseId: string) => phaseId,
      onselect: vi.fn(),
      onadd: vi.fn(),
      onremove: vi.fn(),
      onreset: vi.fn(),
      onduplicate: vi.fn(),
      onpipelinechange: (index: number, patch: Record<string, unknown>) =>
        store.update(index, patch),
      onphasechange: (index: number, position: number, phaseId: string) =>
        store.setPhase(index, position, phaseId),
      onundo: vi.fn(),
      onredo: vi.fn(),
      onsave: vi.fn(),
      onaddphase: (phaseId: string) => store.appendPhaseId(phaseId),
      onremovephase: (position: number) => store.removePhase(position),
      onmovephaseup: (position: number) => store.movePhaseUp(position),
      onmovephasedown: (position: number) => store.movePhaseDown(position)
    }
  });
}

function seededStore(): PipelineCatalogStore {
  const store = new PipelineCatalogStore({
    getSnapshot: () => GOLDEN_SNAPSHOT,
    onSaveError: vi.fn(),
    onSaveAccepted: vi.fn()
  });
  store.pipelines = [goldenSeedRow()];
  store.selectedIndex = 0;
  // What `store.add()` declares. Set directly so the replay starts from the same
  // seed row the recording did, rather than from whatever `makeNewPipelineDraft`
  // names today.
  store.mutation = { kind: 'create', pipelineId: 'new-pipeline' };
  store.mutationSourceKey = 'draft::new-pipeline';
  return store;
}

/**
 * Runs `AUTHORED` through the canvas and returns the store it drove.
 *
 * `overrides` exists for the falsification below: the body has to be reachable
 * by changing exactly one authored value, or the test would be proving that a
 * fixture equals itself.
 */
async function authorOnCanvas(
  // `string`, not `typeof AUTHORED['name']`: `AUTHORED` is `as const`, so that
  // type is the literal `'Golden Flow'` — the one value this parameter exists to
  // replace.
  overrides: { name?: string } = {}
): Promise<PipelineCatalogStore> {
  const store = seededStore();
  const { container, rerender } = mountCanvas(store);
  // The builder is controlled: it renders the props it was given, so each
  // interaction is followed by a re-render carrying the store's new rows.
  const sync = async () =>
    await rerender({
      pipelines: store.pipelines,
      selectedIndex: store.selectedIndex,
      editableSourceKey: store.mutationSourceKey
    } as never);
  const at = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);
  const rowId = () => store.pipelines[0].id;

  await fireEvent.input(at(`pipelines-name-field-${rowId()}`) as HTMLInputElement, {
    target: { value: overrides.name ?? AUTHORED.name }
  });
  await sync();
  await fireEvent.input(at(`pipelines-id-field-${rowId()}`) as HTMLInputElement, {
    target: { value: AUTHORED.id }
  });
  await sync();
  await fireEvent.input(at(`pipelines-description-${rowId()}`) as HTMLTextAreaElement, {
    target: { value: AUTHORED.description }
  });
  await sync();

  for (const phaseId of AUTHORED.appends) {
    await fireEvent.click(at(`pipelines-palette-phase-${phaseId}`) as HTMLButtonElement);
    await sync();
  }

  await fireEvent.click(at(`pipelines-move-phase-up-${AUTHORED.moveUpFrom}`) as HTMLButtonElement);
  await sync();
  await fireEvent.click(at(`pipelines-remove-phase-${AUTHORED.removeAt}`) as HTMLButtonElement);
  await sync();

  return store;
}

describe('FR-031 golden body, replayed on the canvas (T049)', () => {
  it('drives the authoring script through the canvas and matches the recorded body', async () => {
    const store = await authorOnCanvas();

    expect(store.pipelines[0].phases).toEqual(EXPECTED_PHASES);
    expect(serializeBody(store.pipelines[0])).toBe(JSON.stringify(GOLDEN_BODY, null, 2));
  });

  it('fails when one authored field differs, so the match above is not vacuous', async () => {
    // The golden is committed JSON and the comparison is a string equality, both
    // of which are true of a test that never runs its subject. This is the only
    // assertion that distinguishes "the canvas produced the recorded body" from
    // "two constants agree".
    const store = await authorOnCanvas({ name: 'Golden Flow (perturbed)' });

    expect(store.pipelines[0].phases).toEqual(EXPECTED_PHASES);
    expect(serializeBody(store.pipelines[0])).not.toBe(JSON.stringify(GOLDEN_BODY, null, 2));
  });
});
