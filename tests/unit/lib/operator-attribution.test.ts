import { describe, it, expect } from 'vitest';
import { UNKNOWN_OPERATOR, getOperatorActor } from '../../../src/lib/operator-attribution';

describe('operator-attribution (017, T034a)', () => {
  it('returns a non-empty string', () => {
    const actor = getOperatorActor();
    expect(typeof actor).toBe('string');
    expect(actor.length).toBeGreaterThan(0);
  });

  it('exports the unknown-operator literal', () => {
    expect(UNKNOWN_OPERATOR).toBe('unknown-operator');
  });

  it('returns either a real username or the fallback', () => {
    const actor = getOperatorActor();
    // We can't assert the exact name without coupling to the host, but it
    // must either be the explicit fallback or a normal username string.
    if (actor === UNKNOWN_OPERATOR) {
      expect(actor).toBe('unknown-operator');
    } else {
      expect(actor.length).toBeGreaterThan(0);
      expect(actor).not.toContain('\0');
    }
  });
});
