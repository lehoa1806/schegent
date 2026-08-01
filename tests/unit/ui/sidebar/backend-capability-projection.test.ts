import { describe, expect, it, vi } from 'vitest';
import { StateProjector } from '../../../../src/ui/sidebar/state-projector';

describe('StateProjector backend capability projection', () => {
  it('uses authoritative capability getters and preserves unavailable model emptiness', () => {
    const getAvailableBackends = vi.fn(() => ['claude', 'agy'] as const);
    const getAvailableModels = vi.fn(() => ({
      claude: Object.freeze(['claude-sonnet-5']),
      codex: Object.freeze([]),
      agy: Object.freeze(['model-a', 'model-b'])
    }));
    const projector = new StateProjector({
      getAvailableBackends,
      getAvailableModels
    });

    const snapshot = projector.getCurrentSnapshot();

    expect(snapshot.availableBackends).toEqual(['claude', 'agy']);
    expect(snapshot.availableModels).toEqual({
      claude: ['claude-sonnet-5'],
      codex: [],
      agy: ['model-a', 'model-b']
    });
    expect(getAvailableBackends).toHaveBeenCalled();
    expect(getAvailableModels).toHaveBeenCalled();
    projector.dispose();
  });
});
