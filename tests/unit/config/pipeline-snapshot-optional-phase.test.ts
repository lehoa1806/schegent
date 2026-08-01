import { describe, expect, it } from 'vitest';
import { snapshotPhaseDef } from '../../../src/config/pipeline-snapshot';

describe('snapshotPhaseDef optional phase policy (076)', () => {
  it('copies and freezes isRequired so later catalog edits cannot retarget a run', () => {
    const source = {
      id: 'optional-audit',
      name: 'Optional Audit',
      instruction: 'Audit without blocking.',
      isRequired: false
    };

    const snapshot = snapshotPhaseDef(source, 'agy');
    source.isRequired = true;

    expect(snapshot.isRequired).toBe(false);
    expect(snapshot.runner).toBe('agy');
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('preserves absence for legacy definitions, which means required', () => {
    const snapshot = snapshotPhaseDef({
      id: 'legacy-phase',
      name: 'Legacy Phase',
      instruction: 'Run as required.'
    });

    expect(snapshot.isRequired).toBeUndefined();
  });
});
