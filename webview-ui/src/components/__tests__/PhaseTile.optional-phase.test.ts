import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import PhaseTile from '../PhaseTile.svelte';
import type { PhaseTile as PhaseTileProjection } from '../../lib/snapshot-types';

afterEach(() => cleanup());

function tile(lastResult: 'failed' | 'timed-out'): PhaseTileProjection {
  return {
    name: 'optional-audit',
    displayName: 'Optional Audit',
    isRequired: false,
    order: 1,
    state: 'completed',
    iteration: 1,
    lastResult,
    elapsedMs: 25,
    subProgress: null
  };
}

describe('PhaseTile optional failure evidence (076)', () => {
  it.each(['failed', 'timed-out'] as const)(
    'renders the continued %s result instead of presenting it as clean',
    (lastResult) => {
      const { container } = render(PhaseTile, {
        props: { tile: tile(lastResult) }
      });

      const badge = container.querySelector(`.result-${lastResult}`);
      expect(badge?.textContent).toBe(lastResult);
    }
  );
});
