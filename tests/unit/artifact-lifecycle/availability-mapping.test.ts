import { describe, expect, it } from 'vitest';
import {
  mapF04Availability,
  resolveAvailability
} from '../../../src/services/artifact-lifecycle/availability-mapping';

describe('FR-R6-F05 fixed F04 availability mapping (clarification 2)', () => {
  it('maps the four F04 values', () => {
    expect(mapF04Availability('available')).toEqual({ availability: 'present', forcedStoreKind: null });
    expect(mapF04Availability('evicted')).toEqual({ availability: 'expired', forcedStoreKind: null });
    expect(mapF04Availability('missing')).toEqual({ availability: 'missing', forcedStoreKind: null });
    expect(mapF04Availability('quarantined')).toEqual({ availability: 'present', forcedStoreKind: 'quarantine' });
  });

  it('maps any other value to unverified, never to present', () => {
    for (const value of ['', 'AVAILABLE', 'deleted', 'present', 'unknown-future-state']) {
      expect(mapF04Availability(value), value).toEqual({ availability: 'unverified', forcedStoreKind: null });
    }
  });

  it('lets an artifact_lifecycle availability win over the mapping', () => {
    expect(resolveAvailability({ availability: 'corrupt' }, { state: 'available' })).toEqual({
      availability: 'corrupt',
      forcedStoreKind: null
    });
    expect(resolveAvailability({ availability: 'deleted' }, undefined).availability).toBe('deleted');
  });

  it('falls back to the mapping without a lifecycle row, and to missing without either row', () => {
    expect(resolveAvailability(undefined, { state: 'quarantined' })).toEqual({
      availability: 'present',
      forcedStoreKind: 'quarantine'
    });
    expect(resolveAvailability(undefined, undefined)).toEqual({ availability: 'missing', forcedStoreKind: null });
  });

  it('treats an unknown lifecycle value as unverified', () => {
    expect(resolveAvailability({ availability: 'bogus' }, { state: 'available' }).availability).toBe('unverified');
  });
});
