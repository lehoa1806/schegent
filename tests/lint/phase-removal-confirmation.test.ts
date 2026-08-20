import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Feature 100 (T509b, FR-049) — this guarded `removePhase` in
// PipelineBuilder.svelte, where the prompt used to be raised and the removal
// drafted after it. The prompt moved into `deactivateDefinition`, which is the
// only function that can post the command it authorises, so that is where the
// ordering now has to hold. Guarding the Builder instead would pass on a file
// that no longer asks anything.
//
// The property is unchanged and is what a removal turns on: the confirmation is
// awaited, a decline returns before anything is posted, and the command is
// dispatched only after both.
describe('Definition removal confirmation boundary', () => {
  const source = readFileSync(resolve('webview-ui/src/lib/catalog-lifecycle.ts'), 'utf8');

  const bodyOf = (name: string, next: string): string =>
    source.slice(source.indexOf(`export async function ${name}`), source.indexOf(next));

  it.each([
    [
      'deactivateDefinition',
      'export interface DiscardDraftConfirmOptions',
      'catalog.deactivate-definition',
      'CMD_DEACTIVATE_DEFINITION'
    ],
    [
      'discardDefinitionDraft',
      'function uuidv4',
      'catalog.discard-draft',
      'CMD_DISCARD_DEFINITION_DRAFT'
    ]
  ])('awaits the %s confirmation before dispatching', (name, next, promptKey, command) => {
    const body = bodyOf(name, next);
    const confirmation = body.indexOf(`await useConfirm('${promptKey}'`);
    const decline = body.indexOf('if (!confirmed) return DECLINED;');
    const dispatched = body.indexOf(`dispatch(${command}`);
    expect(confirmation).toBeGreaterThan(-1);
    expect(decline).toBeGreaterThan(confirmation);
    expect(dispatched).toBeGreaterThan(decline);
  });

  it('leaves the Builder with no removal prompt of its own', () => {
    // Two prompts for one removal is the defect the move could introduce.
    const builder = readFileSync(resolve('webview-ui/src/components/PipelineBuilder.svelte'), 'utf8');
    expect(builder.includes('useConfirm(')).toBe(false);
  });
});
