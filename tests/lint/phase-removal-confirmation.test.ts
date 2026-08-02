import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Phase removal confirmation boundary', () => {
  const source = readFileSync(resolve('webview-ui/src/components/PipelineBuilder.svelte'), 'utf8');

  it('awaits the shared catalog removal confirmation before drafting removal', () => {
    const body = source.slice(
      source.indexOf('async function removePhase'),
      source.indexOf('function movePhaseListUp')
    );
    const confirmation = body.indexOf("await useConfirm('catalog.remove-phase'");
    const draft = body.indexOf("kind: 'remove'");
    const submit = body.indexOf('submitPhaseMutation(phaseMutation');
    expect(confirmation).toBeGreaterThan(-1);
    expect(draft).toBeGreaterThan(confirmation);
    expect(submit).toBeGreaterThan(draft);
  });
});
